import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { runAgent } from "./agent.js";
import { Trace } from "./trace.js";

/** Minimal .env loader (no dependency): KEY=VALUE lines, # comments. */
function loadDotenv(file = ".env"): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadDotenv();
  for (const key of ["ANTHROPIC_API_KEY", "FIRECRAWL_API_KEY"]) {
    if (!process.env[key]) {
      console.error(`Missing ${key}. Copy .env.example to .env and fill it in.`);
      process.exit(1);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Goal from argv (quoted string) or interactive prompt.
  let goal = process.argv.slice(2).join(" ").trim();
  if (!goal) {
    console.log("Describe the agent workflow you want to build (one line):");
    goal = (await rl.question("> ")).trim();
  }
  if (!goal) {
    console.error("No goal provided.");
    process.exit(1);
  }

  const trace = new Trace();
  console.log(`\nTrace: ${trace.filePath}\n`);

  try {
    const { report, state, usage } = await runAgent(goal, {
      trace,
      askUser: async (question) => {
        console.log(`\n\n[agent asks] ${question}`);
        if (!process.stdin.isTTY) {
          // Non-interactive run (CI, piped): don't hang on stdin.
          return "(non-interactive run — no user available; use your best judgment and record the ambiguity as an open question)";
        }
        return (await rl.question("> ")).trim() || "(no answer — use your best judgment)";
      },
      onText: (delta) => process.stdout.write(delta),
      onToolCall: (name, input) => {
        const brief = JSON.stringify(input);
        console.log(`\n  → ${name} ${brief.length > 140 ? brief.slice(0, 140) + "…" : brief}`);
      },
    });

    fs.mkdirSync("reports", { recursive: true });
    const outFile = path.join(
      "reports",
      `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

    console.log("\n\n================ FINAL REPORT ================\n");
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nSaved to: ${outFile}`);
    console.log(
      `Run stats: ${state.iteration} iterations, ${state.searchesRun} searches, ${state.pagesFetched} pages, ` +
        `${usage.inputTokens} uncached input / ${usage.cacheReadTokens} cache-read / ${usage.cacheWriteTokens} cache-write / ${usage.outputTokens} output tokens.`
    );
  } catch (err) {
    console.error(`\nRun failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    trace.close();
    rl.close();
  }
}

main();
