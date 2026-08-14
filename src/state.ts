/**
 * The agent's working memory ("scratchpad").
 *
 * The conversation transcript is the raw record of what happened, but the
 * scratchpad is the *distilled* state: which tasks exist, what evidence has
 * been collected, and what is still open. It is updated by dedicated tools
 * (plan_tasks, record_finding) and rendered into the conversation on every
 * loop iteration, so the agent always reasons against its current beliefs
 * rather than re-deriving them from a long transcript.
 */

export type Finding = {
  taskIndex: number;
  apiName: string;
  kind: "fact" | "assumption";
  note: string;
  sourceUrl?: string;
  superseded?: boolean;
};

export type AgentState = {
  goal: string;
  tasks: string[];
  findings: Finding[];
  openQuestions: string[];
  iteration: number;
  toolCalls: number;
  searchesRun: number;
  pagesFetched: number;
};

export function newState(goal: string): AgentState {
  return {
    goal,
    tasks: [],
    findings: [],
    openQuestions: [],
    iteration: 0,
    toolCalls: 0,
    searchesRun: 0,
    pagesFetched: 0,
  };
}

/** Coverage check used by the stopping logic and rendered to the agent. */
export function coverage(state: AgentState): string[] {
  const gaps: string[] = [];
  if (state.tasks.length === 0) {
    gaps.push("No tasks planned yet — call plan_tasks first.");
    return gaps;
  }
  for (let i = 0; i < state.tasks.length; i++) {
    const apis = new Set(
      state.findings.filter((f) => f.taskIndex === i && !f.superseded).map((f) => f.apiName)
    );
    if (apis.size === 0) gaps.push(`Task ${i} ("${state.tasks[i]}"): no candidate APIs researched yet.`);
    else if (apis.size === 1)
      gaps.push(
        `Task ${i} ("${state.tasks[i]}"): only 1 candidate API (${[...apis][0]}) — compare at least one credible alternative.`
      );
    const documented = state.findings.some(
      (f) => f.taskIndex === i && !f.superseded && f.kind === "fact" && f.sourceUrl
    );
    if (apis.size > 0 && !documented)
      gaps.push(
        `Task ${i} ("${state.tasks[i]}"): no documented facts with a source URL yet — inspect actual documentation pages, not just search snippets.`
      );
  }
  return gaps;
}

/** Render the scratchpad as text injected into each loop iteration. */
export function renderState(state: AgentState, budget: { maxIterations: number }): string {
  const lines: string[] = [];
  lines.push(`<scratchpad iteration="${state.iteration}" max_iterations="${budget.maxIterations}">`);
  lines.push(`Goal: ${state.goal}`);
  if (state.tasks.length) {
    lines.push("Tasks:");
    state.tasks.forEach((t, i) => lines.push(`  [${i}] ${t}`));
  } else {
    lines.push("Tasks: (none planned yet)");
  }
  const active = state.findings.filter((f) => !f.superseded);
  if (active.length) {
    lines.push(`Findings (${active.length}):`);
    for (const f of active) {
      lines.push(
        `  [task ${f.taskIndex}] ${f.apiName} (${f.kind})${f.sourceUrl ? ` <${f.sourceUrl}>` : ""}: ${f.note}`
      );
    }
  }
  if (state.openQuestions.length) {
    lines.push("Open questions:");
    state.openQuestions.forEach((q) => lines.push(`  - ${q}`));
  }
  const gaps = coverage(state);
  if (gaps.length) {
    lines.push("Coverage gaps (resolve these before finalizing):");
    gaps.forEach((g) => lines.push(`  - ${g}`));
  } else {
    lines.push("Coverage: all tasks have >=2 candidate APIs and documented facts. You may finalize when confident.");
  }
  lines.push(`Budget used: ${state.searchesRun} searches, ${state.pagesFetched} pages fetched, ${state.toolCalls} tool calls.`);
  lines.push("</scratchpad>");
  return lines.join("\n");
}
