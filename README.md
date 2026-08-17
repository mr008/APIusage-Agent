# API Research & MCP Design Agent

An AI agent that helps developers determine which external APIs to use for an
agent workflow, and how those APIs could be exposed through an MCP server.
Built for the Caylex take-home (Option #1).

You describe a workflow ("an agent that finds restaurants and collects menu
info from their websites"); the agent decomposes it into tasks, researches
candidate APIs on the live web, reads their documentation, compares options,
and emits a schema-validated JSON report with ranked APIs, integration
challenges, and an MCP tool-surface design per task.

## Setup

Requirements: Node.js 20+.

```sh
npm install
copy .env.example .env   # then fill in both keys
```

You need two API keys in `.env`:

- `ANTHROPIC_API_KEY` — powers the agent (Claude Opus 5 by default).
- `FIRECRAWL_API_KEY` — powers web search and documentation fetching.

## Run

```sh
npm start -- "I want to build an agent that finds restaurants in a given area and collects menu information from their public websites."
```

Or run `npm start` with no arguments for an interactive prompt. The agent may
pause mid-run to ask a clarifying question — when the plausible answers are
enumerable it presents them as an arrow-key picker (space toggles choices on
multi-select questions), always with an "Other" choice that lets you type a
free-form answer instead. In non-interactive contexts (piped stdin, CI) it
skips the prompt and records the ambiguity as open questions in the report.

Outputs:

- **Final report** — printed to stdout and saved to `reports/report-<timestamp>.json`.
- **Execution trace** — `traces/run-<timestamp>.jsonl`, one JSON line per event:
  every model turn, tool call, tool result, and a scratchpad snapshot after
  each iteration. This is the full record of the agent's evolving conclusions.

## Verify a report (independent fact-check)

```sh
npm run verify -- examples/restaurant-menus.report.json   # or no arg = newest in reports/
```

The verifier is a second, fresh-context model pass that never sees the
researcher's conversation. It **re-fetches the documentation pages the report
cites** and adversarially checks the concrete claims (endpoints, auth,
pricing, rate limits) against them — claims the docs don't confirm are marked
`not_found`, incompatible ones `contradicted`, and each API entry gets a
verdict. Results are saved next to the report as `*.verification.json`.
A committed example: `examples/restaurant-menus.verification.json`.

## Example runs (committed under `examples/`)

Five substantially different queries, each with its full execution trace and
final report (plus one verification audit):

| Example | Query shape | Model | Notable behavior |
|---|---|---|---|
| `restaurant-menus.*` | places search + web scraping (the brief's own example) | Opus 5 | Read 17 doc pages incl. Google's *policies* page, then asked a policy-driven clarifying question (store data vs. fetch live — materially changes provider viability); six-tool MCP pipeline design |
| `github-slack-digest.*` | event polling + LLM step + messaging | Sonnet 5 | Ranked "agent-native summarization (no API)" above external LLM APIs; compared polling vs. webhooks |
| `trip-planner.*` | flights + weather + visa | Opus 5 | Independently added a 4th task (city-name → IATA/geo identifier resolution) that the query never mentioned |
| `order-updates.*` | deliberately ambiguous one-liner | Opus 5 | Paused to ask a clarifying question **with proposed answer options** (rendered as an arrow-key picker in interactive runs); run was non-interactive, so it proceeded on stated assumptions, added carrier-tracking and deliverability tasks on its own, and recorded the ambiguity as open questions |
| `brand-mentions.*` | social monitoring + **write actions** (auto-replies) | Opus 5 | A stale-information stress test: the web is full of outdated "Twitter API is free" content, but the agent skipped snippet-beliefs entirely (4 searches vs. 23 doc pages read) and reported current paid tiers with exact prices, ToS/compliance risks of scraped-data vendors, and an upcoming 2026 API policy change |

Reproduce with, e.g.:

```sh
npm start -- "An agent that plans multi-city trips: flight options, weather at each stop, and visa requirements."
```

## Architecture

```
src/
  cli.ts     entry point: reads the goal, renders ask_user option pickers, prints/saves output
  agent.ts   the control loop (observe → reason → act), stopping logic, error handling,
             incremental prompt caching (breakpoint moves to the newest turn each request)
  state.ts   the scratchpad: tasks, findings (fact vs assumption), coverage checks
  tools.ts   tool definitions + executors (Firecrawl search/scrape, scratchpad ops)
  schema.ts  Zod schema for the final report + generated JSON Schema for the tool
  prompt.ts  system prompt
  trace.ts   JSONL trace writer
  verify.ts  independent verification pass (npm run verify)
  env.ts     .env loading + required-key checks
scripts/
  check-key.ts    sanity-check the Anthropic key/billing (npx tsx scripts/check-key.ts)
  smoke-tools.ts  sanity-check the Firecrawl search/scrape tools
```

### The control loop (`agent.ts`)

Hand-rolled — no managed agent SDK. Each iteration:

1. Send the conversation + tool definitions to Claude (streamed; the prompt-cache
   breakpoint is moved to the newest turn each request, so steady-state iterations
   pay full price for only tens of input tokens).
2. If the model requested tools, execute all of them and return the results in
   a single user turn, followed by a freshly rendered **scratchpad**.
3. Repeat until `finalize_report` validates, or the budget forces a stop.

**State.** The transcript is the raw record; the scratchpad
(`state.ts`) is the distilled working memory. The agent maintains it through
dedicated tools: `plan_tasks` sets the task decomposition, `record_finding`
appends evidence (each finding is a `fact` — requires a fetched documentation
URL — or an `assumption`), and `supersedes_note` lets new evidence invalidate
earlier findings, which is how "revise conclusions" is implemented concretely.
The rendered scratchpad also includes computed **coverage gaps** (tasks with
fewer than two candidate APIs, or no documented facts), so the agent always
sees what still blocks finalization.

**Action selection.** The model chooses freely among six tools:
`web_search`, `fetch_page`, `plan_tasks`, `record_finding`, `ask_user`,
`finalize_report`. Tool descriptions carry the policy (snippets are leads,
not evidence; facts need fetched docs; ask the user only for material
ambiguity).

**Stopping.** Two mechanisms. Soft: coverage gaps in the scratchpad tell the
agent when finalizing is premature. Hard: an iteration budget (default 30);
when exhausted, every subsequent turn carries an instruction to finalize
immediately, with a small grace window — if no valid report appears, the run
fails loudly rather than looping forever.

**Structured output & uncertainty.** `finalize_report` is a tool whose input
schema is generated from the Zod schema in `schema.ts`. Invalid payloads are
returned to the agent as tool errors with the exact validation issues, and it
retries. The schema forces uncertainty to be explicit: each recommended API
carries a `confidence` level (`documented` / `partially_documented` /
`assumed`) and an `open_questions` list, so unverified claims are labeled
rather than laundered into the report.

**Error handling.** Tool failures (network errors, scrape failures, bad
inputs) are returned as `is_error` tool results — observations the agent
adapts to, not crashes. API-level retries (429/5xx) are handled by the
Anthropic SDK's built-in backoff. A model turn that ends without a tool call
gets a nudge back into the loop; a safety refusal aborts with a clear message.

## Trade-offs (time-boxed)

- **Full transcript + scratchpad, no compaction.** Runs are bounded (~30
  iterations), so context fits comfortably; prompt caching keeps cost down.
  For much longer runs I would prune old fetched-page tool results, since the
  scratchpad already preserves their distilled content.
- **Firecrawl for both search and scrape** — one key, handles JS-rendered doc
  sites. The trade-off is an external dependency; swapping in another
  search/fetch backend only touches `tools.ts`.
- **Coverage heuristic is simple** (≥2 candidates + ≥1 documented fact per
  task). It's advisory — the model can finalize with one candidate if it has
  recorded why alternatives don't exist — but it reliably prevents
  first-result-syndrome.
- **No parallel research.** Tasks are researched in whatever order the model
  chooses within one loop. Sub-agents per task would speed things up but make
  the control flow harder to inspect, which cuts against the brief's goal.

## What I'd build with more time

- Prune stale page-fetch results from the transcript once distilled into findings.
- A link-frontier tool ("list links on this docs page") for deeper doc navigation.
- Feed verification results back into the research loop (auto-repair: contradicted claims trigger re-research instead of just being flagged).
- An eval harness comparing reports across runs for stability.
