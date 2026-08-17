import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadDotenv, requireEnv } from "./env.js";
import { fetchPage } from "./tools.js";
import { FinalReport, FinalReportT } from "./schema.js";

/**
 * Independent verification pass.
 *
 * Takes a finished research report, RE-FETCHES the documentation pages it
 * cites, and asks a fresh-context model to adversarially check the report's
 * factual claims (endpoints, auth, pricing, limits) against those pages.
 * The verifier never sees the researcher's conversation — only the report
 * and the live docs — so it cannot inherit the researcher's mistakes.
 *
 * Usage:
 *   npm run verify                       # newest report in reports/
 *   npm run verify -- examples/restaurant-menus.report.json
 */

const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5";
const MAX_PAGES_PER_API = 3;
const MAX_PAGE_CHARS = 14_000;

const ClaimCheck = z.object({
  claim: z.string().describe("The specific factual claim from the report being checked."),
  status: z
    .enum(["supported", "contradicted", "not_found"])
    .describe(
      "supported = the fetched docs confirm it; contradicted = the docs say otherwise; not_found = the docs fetched here neither confirm nor deny it."
    ),
  note: z.string().describe("One sentence of evidence or explanation."),
});

const ApiVerdict = z.object({
  verdict: z.enum(["supported", "partially_supported", "unsupported", "could_not_verify"]),
  checked_claims: z.array(ClaimCheck),
  summary: z.string().describe("Two or three sentences: overall reliability of this report entry."),
});
type ApiVerdictT = z.infer<typeof ApiVerdict>;

const verdictJsonSchema = (() => {
  const schema = z.toJSONSchema(ApiVerdict, { target: "draft-7" }) as Record<string, any>;
  delete schema.$schema;
  // Structured outputs require additionalProperties:false on every object.
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") node.additionalProperties = false;
    for (const v of Object.values(node)) walk(v);
  };
  walk(schema);
  return schema;
})();

const SYSTEM = `You are an adversarial documentation fact-checker. You receive one entry from an API research report and the current content of the documentation pages that entry cites. Your job is to find claims that are NOT supported by those pages.

Rules:
- Check the concrete, checkable claims: endpoint names/paths, HTTP methods, authentication requirements, pricing figures, rate limits, free-tier caps, field names, and stated restrictions. Skip pure opinions (e.g. "well documented").
- Do not assume the report is correct. Do not fill gaps with your own knowledge of the API — the fetched pages are the only admissible evidence. If a claim is plausible but absent from the fetched pages, its status is "not_found", not "supported".
- "contradicted" requires the page to actually state something incompatible with the claim.
- The report entry may itself label claims as assumptions or open questions — those are honest flags, not errors; skip claims the report already marks as assumed/unverified.
- Verdict guide: supported = all checked claims supported; partially_supported = most supported, some not_found; unsupported = at least one contradicted or the load-bearing claims are not_found; could_not_verify = the docs pages were unusable/unfetchable.`;

type PageCache = Map<string, string | null>;

async function fetchWithRetry(url: string, cache: PageCache): Promise<string | null> {
  if (cache.has(url)) return cache.get(url)!;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await fetchPage(url);
      cache.set(url, content);
      return content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && /429|rate/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 12_000));
        continue;
      }
      cache.set(url, null);
      return null;
    }
  }
  return null;
}

async function verifyApi(
  client: Anthropic,
  taskDescription: string,
  api: FinalReportT["tasks"][number]["recommended_apis"][number],
  cache: PageCache
): Promise<ApiVerdictT> {
  const pages: string[] = [];
  const failed: string[] = [];
  for (const url of api.docs_links.slice(0, MAX_PAGES_PER_API)) {
    const content = await fetchWithRetry(url, cache);
    if (content === null) failed.push(url);
    else pages.push(`<doc url="${url}">\n${content.slice(0, MAX_PAGE_CHARS)}\n</doc>`);
  }

  if (pages.length === 0) {
    return {
      verdict: "could_not_verify",
      checked_claims: [],
      summary: `None of the cited documentation pages could be fetched (${failed.join(", ")}).`,
    };
  }

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 6000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: verdictJsonSchema } } as any,
    messages: [
      {
        role: "user",
        content: `Report entry to check (task: "${taskDescription}"):\n${JSON.stringify(
          {
            api_name: api.api_name,
            rationale: api.rationale,
            important_endpoints: api.important_endpoints,
            potential_challenges: api.potential_challenges,
          },
          null,
          2
        )}\n\nFetched documentation (the only admissible evidence):\n${pages.join("\n\n")}${
          failed.length ? `\n\nNote: these cited pages could not be fetched: ${failed.join(", ")}` : ""
        }`,
      },
    ],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    return { verdict: "could_not_verify", checked_claims: [], summary: "Verifier declined this entry." };
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const parsed = ApiVerdict.safeParse(JSON.parse(text));
  if (!parsed.success) {
    return {
      verdict: "could_not_verify",
      checked_claims: [],
      summary: `Verifier output failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    };
  }
  return parsed.data;
}

async function main(): Promise<void> {
  loadDotenv();
  requireEnv(["ANTHROPIC_API_KEY", "FIRECRAWL_API_KEY"]);

  let reportPath = process.argv[2];
  if (!reportPath) {
    const newest = fs
      .readdirSync("reports")
      .filter((f) => f.endsWith(".json"))
      .sort()
      .pop();
    if (!newest) {
      console.error("No report found in reports/. Pass a path: npm run verify -- <report.json>");
      process.exit(1);
    }
    reportPath = path.join("reports", newest);
  }

  const report = FinalReport.parse(JSON.parse(fs.readFileSync(reportPath, "utf8")));
  console.log(`Verifying ${reportPath} against live documentation (model: ${MODEL})...\n`);

  const client = new Anthropic();
  const cache: PageCache = new Map();
  const results: Array<{ task_description: string; api_name: string; rank: number } & ApiVerdictT> = [];

  for (const task of report.tasks) {
    for (const api of task.recommended_apis) {
      process.stdout.write(`  ${api.api_name} ... `);
      const verdict = await verifyApi(client, task.task_description, api, cache);
      results.push({ task_description: task.task_description, api_name: api.api_name, rank: api.rank, ...verdict });
      const flags = verdict.checked_claims.filter((c) => c.status !== "supported").length;
      console.log(`${verdict.verdict} (${verdict.checked_claims.length} claims checked, ${flags} flagged)`);
    }
  }

  const outFile = reportPath.replace(/\.report\.json$|\.json$/, "") + ".verification.json";
  fs.writeFileSync(outFile, JSON.stringify({ verified_report: reportPath, model: MODEL, results }, null, 2), "utf8");

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nSummary: ${JSON.stringify(counts)}`);
  const problems = results.flatMap((r) =>
    r.checked_claims.filter((c) => c.status === "contradicted").map((c) => `  [${r.api_name}] ${c.claim} — ${c.note}`)
  );
  if (problems.length) {
    console.log(`\nContradicted claims:\n${problems.join("\n")}`);
  } else {
    console.log("No contradicted claims found.");
  }
  console.log(`\nSaved: ${outFile}`);
}

main();
