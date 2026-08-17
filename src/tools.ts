import type Anthropic from "@anthropic-ai/sdk";
import { finalReportJsonSchema } from "./schema.js";

/**
 * Tool definitions for the agent. Research tools (web_search, fetch_page) are
 * backed by the Firecrawl API. plan_tasks / record_finding / raise_question
 * mutate the agent's scratchpad. ask_user pauses for human input.
 * finalize_report is the terminal action.
 */

const FIRECRAWL_BASE = "https://api.firecrawl.dev";

function firecrawlKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set (see .env.example)");
  return key;
}

async function firecrawl(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${FIRECRAWL_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${firecrawlKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // A hung scrape must not stall the agent loop; fail and let the agent adapt.
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Firecrawl ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

export async function webSearch(query: string, limit = 6): Promise<string> {
  const json = await firecrawl("/v2/search", { query, limit });
  // v2 shape: { data: { web: [...] } }; v1 shape: { data: [...] } — handle both.
  const results: any[] = Array.isArray(json?.data) ? json.data : json?.data?.web ?? [];
  if (!results.length) return "No results.";
  return results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title ?? "(no title)"}\n   URL: ${r.url}\n   ${r.description ?? ""}`
    )
    .join("\n");
}

const MAX_PAGE_CHARS = 18_000;

export async function fetchPage(url: string): Promise<string> {
  const json = await firecrawl("/v2/scrape", {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
  });
  const md: string = json?.data?.markdown ?? json?.markdown ?? "";
  if (!md.trim()) return "Page fetched but no readable content was extracted.";
  if (md.length > MAX_PAGE_CHARS) {
    return (
      md.slice(0, MAX_PAGE_CHARS) +
      `\n\n[TRUNCATED at ${MAX_PAGE_CHARS} chars of ${md.length}. If the section you need is missing, fetch a more specific documentation URL.]`
    );
  }
  return md;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "web_search",
    description:
      "Search the web. Use to find candidate APIs for a task, official documentation pages, pricing pages, and comparisons. Prefer queries naming concrete capabilities (e.g. 'restaurant search API official docs') over vague ones. Results are titles, URLs, and snippets — snippets are leads, not evidence; follow up with fetch_page before recording facts.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: { type: "integer", description: "Max results (default 6, max 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_page",
    description:
      "Fetch a web page and return its content as markdown. Use on official documentation, endpoint references, authentication guides, and pricing pages. This is how you turn search leads into documented facts. Long pages are truncated — fetch specific doc sub-pages when you need detail. Call this before recording any finding with kind='fact'.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to fetch." },
      },
      required: ["url"],
    },
  },
  {
    name: "plan_tasks",
    description:
      "Set or revise the list of distinct tasks the user's workflow decomposes into. Call this once early (before researching), and again if research reveals the decomposition was wrong. Replaces the whole task list; existing findings keep their task indices, so keep ordering stable when revising.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "One entry per distinct task, e.g. 'Find restaurants in a requested geographic area.'",
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "record_finding",
    description:
      "Record one piece of evidence about a candidate API into your scratchpad. kind='fact' requires a source_url of a documentation page you actually fetched; kind='assumption' is for inferred or unverified claims. Use supersedes_note to mark an earlier finding wrong when new evidence contradicts it (quote a distinctive substring of the old note). Record findings as you go — the scratchpad, not the transcript, is what you reason from.",
    input_schema: {
      type: "object",
      properties: {
        task_index: { type: "integer", description: "Index into the planned task list." },
        api_name: { type: "string" },
        kind: { type: "string", enum: ["fact", "assumption"] },
        note: {
          type: "string",
          description: "One concrete claim: an endpoint, auth requirement, pricing detail, limitation, etc.",
        },
        source_url: { type: "string", description: "Documentation URL supporting the claim (required for facts)." },
        supersedes_note: {
          type: "string",
          description: "Optional: substring of a previous finding's note that this finding invalidates.",
        },
      },
      required: ["task_index", "api_name", "kind", "note"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question. Use ONLY when ambiguity would materially change your recommendations (e.g. budget constraints, expected scale, region, whether official-API-only is required). Do not ask questions you can resolve by research. Provide 2-5 short answer options whenever the plausible answers are enumerable — the UI renders them as an arrow-key picker and always appends an 'Other (type my own answer)' choice, so options make answering much faster for the user. Set multi_select=true when several options can apply at once (e.g. notification channels). Ask one question per call. The loop pauses until the user answers.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "2-5 concise answer choices (a few words each). Omit only for fully open-ended questions.",
        },
        multi_select: {
          type: "boolean",
          description: "Allow the user to select multiple options (default false).",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "finalize_report",
    description:
      "Submit the final research report as structured JSON. Call this only when every task has at least two compared candidate APIs (or you have recorded why alternatives don't exist), documented facts with source URLs, and an MCP design recommendation. The payload is validated against a schema; if validation fails you will receive the errors and must retry.",
    input_schema: finalReportJsonSchema as Anthropic.Tool.InputSchema,
  },
];
