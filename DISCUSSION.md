# Discussion: API Research & MCP Design Agent

This document is the "discussion / short presentation" deliverable. It explains
the implementation, the agent's architecture and control loop, how it selects
and uses tools, how it accumulates and validates information, the approach to
structured output and uncertainty, and the trade-offs made under the 8–12 hour
time box.

## 1. The problem, restated

Given a natural-language description of an agent workflow, produce a research
report that (a) decomposes the workflow into tasks, (b) recommends and ranks
real external APIs per task with evidence from their actual documentation,
(c) surfaces integration challenges (auth, pricing, access restrictions,
doc quality, missing capabilities), and (d) proposes how an MCP server should
expose the needed capabilities. The agent must be a single tool-using loop —
not a fixed pipeline — and must not invent facts.

## 2. Architecture and control loop

```
        ┌────────────────────────────────────────────────┐
        │                 agent.ts (loop)                │
        │                                                │
 goal ──►  messages ──► Claude Opus 5 (streamed turn)    │
        │      ▲               │                         │
        │      │               ▼ tool_use blocks         │
        │      │        execute all tools                │
        │      │        (tools.ts)                       │
        │      │               │                         │
        │      │               ▼                         │
        │  tool_results + re-rendered scratchpad ────────┘
        │      (state.ts: tasks / findings / gaps)
        │
        └── exit: finalize_report validates (schema.ts)
                  or budget exhausted → forced finalize → hard fail
```

The loop is ~150 lines of visible TypeScript (`src/agent.ts`). No managed
agent SDK: state management, action selection, stopping behavior, and error
handling are all explicit and inspectable.

**Why a scratchpad and not just the transcript.** The transcript alone has two
problems for research work: conclusions get buried under pages of fetched
markdown, and "current belief" is implicit (the model must re-derive it every
turn). The scratchpad (`state.ts`) is the distilled state — task list,
findings, open questions — and it is *re-rendered into every iteration*, so
the model always reasons against its up-to-date beliefs. Crucially, the model
maintains this state through tools (`plan_tasks`, `record_finding`), which
makes belief updates observable events in the trace rather than hidden text.

**Revision is a first-class operation.** `record_finding` accepts
`supersedes_note`: when documentation contradicts an earlier conclusion, the
old finding is marked superseded and drops out of the rendered scratchpad.
"The agent revises its conclusions when it discovers new information" is thus
a mechanical feature you can point to in the trace, not an emergent hope.
In the committed example runs revision shows up in softer forms — claims
downgraded to assumptions after doc reading, and search-snippet beliefs
replaced by documented facts (e.g. the restaurant run's Foursquare
website-field investigation) — because no run happened to hit an outright
contradiction; when one occurs, `supersedes_note` is the path it takes and
the superseded finding remains visible in the trace's state snapshots.

## 3. Tool selection and use

Six tools, chosen so that each brief requirement maps to a visible action:

| Tool | Role |
|---|---|
| `web_search` | Find candidate APIs, doc pages, pricing pages (Firecrawl search) |
| `fetch_page` | Read a docs page as markdown (Firecrawl scrape; handles JS-rendered sites) |
| `plan_tasks` | Set / revise the task decomposition |
| `record_finding` | Append evidence: `fact` (requires fetched source URL) or `assumption` |
| `ask_user` | Clarifying question; loop pauses for terminal input |
| `finalize_report` | Terminal action; schema-validated JSON |

Policy lives in the tool descriptions rather than in loop code: search
snippets are "leads, not evidence"; a `fact` without a `source_url` is
rejected by the executor (a hard check, not a prompt suggestion); `ask_user`
is reserved for ambiguity that would materially change recommendations. The
model chooses freely among tools each turn — there is no scripted order — but
the coverage gaps in the scratchpad (see below) create pressure toward
breadth-then-depth research.

## 4. Accumulating and validating information

Three layers keep the report honest:

1. **At recording time** — the executor enforces that facts carry a
   documentation URL; the prompt directs that only fetched pages (not
   snippets) support facts. Everything else must be recorded as an assumption.
2. **During the loop** — `coverage()` computes gaps per task: fewer than two
   candidate APIs, or zero documented facts. Gaps are printed in the
   scratchpad every turn ("resolve these before finalizing"), which is the
   soft stopping criterion and the main defense against
   first-search-result syndrome.
3. **At finalization** — the report schema forces each recommended API to
   declare a `confidence` level (`documented` / `partially_documented` /
   `assumed`) and an `open_questions` list. Uncertainty is surfaced in the
   output contract itself, so an unverified claim can't silently look like a
   verified one.
4. **After the fact** — an independent verification pass (`npm run verify`,
   `src/verify.ts`). A fresh-context model that never saw the researcher's
   conversation re-fetches the documentation pages the report cites and
   adversarially checks each concrete claim (endpoints, auth, pricing, rate
   limits) against them, with the fetched pages as the *only* admissible
   evidence. Claims the report already labels as assumptions are skipped —
   honest flags aren't errors. Output is a per-API verdict
   (`supported` / `partially_supported` / `unsupported` /
   `could_not_verify`) with per-claim statuses, saved as
   `*.verification.json`. Because evidence is re-fetched live, this pass
   also catches documentation drift after the research ran.

## 5. Structured output

`finalize_report` is a tool whose `input_schema` is *generated from* the Zod
schema (single source of truth in `schema.ts`). Two enforcement passes:

- The API constrains the model's tool input toward the JSON Schema.
- The executor re-validates with Zod; on failure the exact issues
  (`path: message`) go back as an `is_error` tool result and the model
  retries. In effect the schema validator participates in the loop.

The schema mirrors the structure in the brief (tasks → ranked APIs →
rationale / docs links / endpoints / challenges → MCP recommendation) and
adds `workflow_summary`, per-API `confidence` + `open_questions`, and
`cross_task_notes` for shared auth and cross-task tool composition — fields
that improve information quality, which the brief explicitly permits.

## 6. Stopping behavior and error handling

- **Soft stop:** the model finalizes when coverage gaps are clear and it is
  confident. Coverage is advisory by design — one candidate can be enough *if*
  the agent has recorded why alternatives don't exist.
- **Hard stop:** an iteration budget (default 30, visible to the model in the
  scratchpad so it can pace itself). Once exhausted, every subsequent turn
  carries a "finalize now with what you have" instruction; after a small grace
  window the run fails loudly with a pointer to the trace. No infinite loops.
- **Tool errors are observations.** Network failures, blocked scrapes, and
  invalid tool inputs come back as `is_error` tool results; the agent adapts
  (retry, different URL, mark as open question). API-level 429/5xx retries are
  the SDK's built-in backoff. A turn that ends with prose instead of a tool
  call gets nudged back into the loop; a safety refusal aborts cleanly.

## 7. Observability

`traces/run-*.jsonl` records every model turn (text + stop reason + token
usage), every tool call and result, and a full scratchpad snapshot per
iteration. You can replay the agent's evolving conclusions by reading the
snapshots alone — including the moment a finding gets superseded.

## 8. Trade-offs under the time box

- **One loop, no sub-agents.** Parallel per-task researchers would be faster,
  but a single visible loop is easier to inspect and debug — aligned with what
  the brief is evaluating. The task-indexed scratchpad would port directly to
  a fan-out design later.
- **Full transcript, no compaction.** Bounded iterations keep context
  manageable, and prompt caching (a `cache_control` breakpoint on the system
  prompt) keeps cost down. The first scaling lever would be pruning old
  `fetch_page` results once distilled into findings — the scratchpad already
  preserves their substance.
- **Firecrawl as the single research backend.** One key covers search and
  JS-rendered scraping. The dependency is isolated in `tools.ts` behind two
  small functions, so swapping backends is a local change.
- **Simple coverage heuristic.** ≥2 candidates + ≥1 documented fact per task
  is crude but effective. The fresh-context verification pass (§4, layer 4)
  now provides the smarter critic post-hoc; the next step would be feeding
  its contradicted claims back into the loop for automatic re-research.
- **Truncated page fetches (18K chars).** Keeps any single observation from
  flooding context; the truncation note tells the model to fetch a more
  specific sub-page, which mirrors how a human reads docs anyway.
