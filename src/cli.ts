import fs from "node:fs";
import path from "node:path";
import { input, select, checkbox } from "@inquirer/prompts";
import { runAgent } from "./agent.js";
import { Trace } from "./trace.js";
import { loadDotenv, requireEnv } from "./env.js";

const OTHER = "__other__";
const NO_ANSWER = "(no answer — use your best judgment)";

/**
 * Claude-style clarifying questions: when the agent supplies answer options,
 * render an arrow-key picker (checkbox for multi-select) with an "Other"
 * escape hatch for typing a longer free-form answer.
 */
async function askInteractive(question: string, options: string[], multiSelect: boolean): Promise<string> {
  console.log("");
  if (options.length === 0) {
    return (await input({ message: question })).trim() || NO_ANSWER;
  }
  if (multiSelect) {
    const picked = await checkbox<string>({
      message: `${question} (space to toggle, enter to confirm)`,
      choices: [
        ...options.map((o) => ({ name: o, value: o })),
        { name: "Other / add details (type it)", value: OTHER },
      ],
    });
    const extra = picked.includes(OTHER)
      ? (await input({ message: "Your answer / extra details:" })).trim()
      : "";
    const parts = [...picked.filter((p) => p !== OTHER), extra].filter(Boolean);
    return parts.length ? parts.join("; ") : NO_ANSWER;
  }
  const picked = await select<string>({
    message: question,
    choices: [
      ...options.map((o) => ({ name: o, value: o })),
      { name: "Other (type my own answer)", value: OTHER },
    ],
  });
  if (picked === OTHER) {
    return (await input({ message: "Your answer:" })).trim() || NO_ANSWER;
  }
  return picked;
}

async function main(): Promise<void> {
  loadDotenv();
  requireEnv(["ANTHROPIC_API_KEY", "FIRECRAWL_API_KEY"]);

  // Goal from argv (quoted string) or interactive prompt.
  let goal = process.argv.slice(2).join(" ").trim();
  if (!goal && !process.stdin.isTTY) {
    console.error('No goal provided. Non-interactive usage: npm start -- "<goal>"');
    process.exit(1);
  }
  if (!goal) {
    goal = (await input({ message: "Describe the agent workflow you want to build:" })).trim();
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
      askUser: async (question, options, multiSelect) => {
        if (!process.stdin.isTTY) {
          // Non-interactive run (CI, piped): don't hang on stdin.
          console.log(`\n[agent asks] ${question}`);
          return "(non-interactive run — no user available; use your best judgment and record the ambiguity as an open question)";
        }
        return askInteractive(question, options, multiSelect);
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
    if (err instanceof Error && err.name === "ExitPromptError") {
      console.error("\nCancelled.");
    } else {
      console.error(`\nRun failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exitCode = 1;
  } finally {
    trace.close();
  }
}

main();
