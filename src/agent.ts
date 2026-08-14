import Anthropic from "@anthropic-ai/sdk";
import { AgentState, newState, renderState, coverage } from "./state.js";
import { toolDefinitions, webSearch, fetchPage } from "./tools.js";
import { FinalReport, FinalReportT } from "./schema.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { Trace, clip } from "./trace.js";

const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5";

export type AgentOptions = {
  /** Called when the agent uses the ask_user tool. Resolves with the user's answer. */
  askUser: (question: string) => Promise<string>;
  trace: Trace;
  maxIterations?: number;
  /** Extra iterations granted after the budget runs out, reserved for finalizing. */
  finalizeGrace?: number;
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
};

export type AgentResult = {
  report: FinalReportT;
  state: AgentState;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
};

/**
 * The agent control loop. Deliberately hand-rolled (no managed agent SDK):
 * state management, action selection, stopping behavior, and error handling
 * are all explicit in this function.
 */
export async function runAgent(goal: string, opts: AgentOptions): Promise<AgentResult> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const maxIterations = opts.maxIterations ?? 30;
  const finalizeGrace = opts.finalizeGrace ?? 5;
  const state = newState(goal);
  const trace = opts.trace;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  trace.log("run_start", { goal, model: MODEL, maxIterations });

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `${goal}\n\n${renderState(state, { maxIterations })}`,
    },
  ];

  let report: FinalReportT | null = null;

  while (report === null) {
    state.iteration++;
    if (state.iteration > maxIterations + finalizeGrace) {
      trace.log("error", { message: "Iteration budget (including finalize grace) exhausted without a valid report." });
      throw new Error(
        `Agent did not produce a valid report within ${maxIterations + finalizeGrace} iterations. See trace: ${trace.filePath}`
      );
    }

    // --- act: one model turn (streamed so long thinking turns don't time out)
    moveCacheBreakpoint(messages);
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: toolDefinitions,
      messages,
    });
    if (opts.onText) stream.on("text", opts.onText);
    const response = await stream.finalMessage();

    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

    const textBlocks = response.content.filter((b) => b.type === "text").map((b) => b.text);
    trace.log("turn", {
      iteration: state.iteration,
      stop_reason: response.stop_reason,
      text: clip(textBlocks.join("\n")),
      usage: response.usage,
    });

    if (response.stop_reason === "refusal") {
      trace.log("error", { message: "Model refused the request (safety classifiers).", stop_details: response.stop_details });
      throw new Error("The model declined this request. Rephrase the goal and try again.");
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      // The agent stopped talking without acting. Nudge it back into the loop.
      const nudge =
        response.stop_reason === "max_tokens"
          ? "Your previous turn was cut off at the output limit. Continue — prefer tool calls over long prose."
          : "You ended your turn without a tool call. Continue the loop: research, record findings, or call finalize_report if coverage is complete.";
      trace.log("nudge", { reason: response.stop_reason ?? "end_turn" });
      messages.push({ role: "user", content: `${nudge}\n\n${renderState(state, { maxIterations })}` });
      continue;
    }

    // --- observe: execute every requested tool, return all results in one user turn
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const tu of toolUses) {
      state.toolCalls++;
      opts.onToolCall?.(tu.name, tu.input);
      trace.log("tool_call", { iteration: state.iteration, name: tu.name, input: tu.input });
      const { content, isError, finalized } = await executeTool(tu.name, tu.input as any, state, opts);
      trace.log("tool_result", { name: tu.name, is_error: isError, content: clip(content) });
      results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: isError });
      if (finalized) report = finalized;
    }

    trace.log("state_snapshot", { state: JSON.parse(JSON.stringify(state)) });

    if (report) break;

    const overBudget = state.iteration >= maxIterations;
    const scratchpad = renderState(state, { maxIterations });
    const budgetWarning = overBudget
      ? "\n\nITERATION BUDGET EXHAUSTED. Do not make further research calls. Call finalize_report now with your current findings, marking unverified claims as assumptions/open questions."
      : "";
    messages.push({
      role: "user",
      content: [...results, { type: "text", text: scratchpad + budgetWarning }],
    });
  }

  trace.log("final_report", { report });
  trace.log("run_end", { iterations: state.iteration, usage, coverageGaps: coverage(state) });
  return { report, state, usage };
}

/**
 * Incremental prompt caching: on every request, place the message-level cache
 * breakpoint on the last block of the newest turn (and remove older markers so
 * we never exceed the 4-breakpoint limit). Earlier breakpoints remain valid
 * read points server-side, so the growing transcript is served from cache
 * instead of being re-processed at full price each iteration.
 */
function moveCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content as unknown as Array<Record<string, unknown>>) {
        if (block && typeof block === "object" && "cache_control" in block) delete block.cache_control;
      }
    }
  }
  const last = messages[messages.length - 1];
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content }];
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    (last.content[last.content.length - 1] as unknown as Record<string, unknown>).cache_control = {
      type: "ephemeral",
    };
  }
}

async function executeTool(
  name: string,
  input: Record<string, any>,
  state: AgentState,
  opts: AgentOptions
): Promise<{ content: string; isError: boolean; finalized?: FinalReportT }> {
  try {
    switch (name) {
      case "web_search": {
        state.searchesRun++;
        const limit = Math.min(Number(input.limit) || 6, 10);
        return { content: await webSearch(String(input.query), limit), isError: false };
      }
      case "fetch_page": {
        state.pagesFetched++;
        return { content: await fetchPage(String(input.url)), isError: false };
      }
      case "plan_tasks": {
        if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
          return { content: "plan_tasks requires a non-empty 'tasks' array.", isError: true };
        }
        state.tasks = input.tasks.map(String);
        return { content: `Task plan updated: ${state.tasks.length} task(s).`, isError: false };
      }
      case "record_finding": {
        const idx = Number(input.task_index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= state.tasks.length) {
          return { content: `Invalid task_index ${input.task_index}; plan has ${state.tasks.length} task(s).`, isError: true };
        }
        if (input.kind === "fact" && !input.source_url) {
          return { content: "A finding with kind='fact' requires source_url. Use kind='assumption' or provide the documentation URL you fetched.", isError: true };
        }
        if (input.supersedes_note) {
          const needle = String(input.supersedes_note);
          for (const f of state.findings) {
            if (!f.superseded && f.note.includes(needle)) f.superseded = true;
          }
        }
        state.findings.push({
          taskIndex: idx,
          apiName: String(input.api_name),
          kind: input.kind === "fact" ? "fact" : "assumption",
          note: String(input.note),
          sourceUrl: input.source_url ? String(input.source_url) : undefined,
        });
        return { content: "Finding recorded.", isError: false };
      }
      case "ask_user": {
        const answer = await opts.askUser(String(input.question));
        return { content: `User's answer: ${answer}`, isError: false };
      }
      case "finalize_report": {
        const parsed = FinalReport.safeParse(input);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n");
          return { content: `Report failed schema validation. Fix these and call finalize_report again:\n${issues}`, isError: true };
        }
        return { content: "Report accepted.", isError: false, finalized: parsed.data };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    // Tool failures are observations, not crashes — the agent decides how to adapt.
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Tool error: ${message}`, isError: true };
  }
}
