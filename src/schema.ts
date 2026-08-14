import { z } from "zod";

/**
 * The final report schema, mirroring the structure in the Caylex brief.
 * The agent must call the `finalize_report` tool with a payload that
 * validates against this. Validation errors are fed back to the agent
 * as a tool error so it can self-correct.
 */

export const RecommendedApi = z.object({
  api_name: z.string().min(1),
  rank: z.number().int().min(1),
  rationale: z
    .string()
    .min(1)
    .describe("Why this API is or is not appropriate for the task."),
  docs_links: z
    .array(z.url())
    .min(1)
    .describe("URLs of documentation pages that were actually inspected."),
  important_endpoints: z
    .string()
    .min(1)
    .describe("Natural-language description of the most relevant endpoints."),
  potential_challenges: z
    .string()
    .min(1)
    .describe(
      "Integration challenges: auth complexity, pricing/paid plans, access restrictions, approval requirements, documentation quality, missing capabilities."
    ),
  confidence: z
    .enum(["documented", "partially_documented", "assumed"])
    .describe(
      "documented = every claim above was seen in official docs; partially_documented = some claims are inferred; assumed = based on search snippets only."
    ),
  open_questions: z
    .array(z.string())
    .describe(
      "Unresolved questions or assumptions that a developer should verify before committing to this API. Empty array if none."
    ),
});

export const TaskReport = z.object({
  task_description: z.string().min(1),
  recommended_apis: z.array(RecommendedApi).min(1),
  mcp_design_recommendation: z
    .string()
    .min(1)
    .describe(
      "How an MCP server should expose the needed capabilities: which tools to define, which tools compose together, and which API capabilities should NOT be exposed."
    ),
});

export const FinalReport = z.object({
  workflow_summary: z
    .string()
    .min(1)
    .describe("One-paragraph restatement of the user's goal as understood by the agent."),
  tasks: z.array(TaskReport).min(1),
  cross_task_notes: z
    .string()
    .describe(
      "Notes that span tasks: shared auth, tools commonly used together across tasks, overall MCP server layout. Empty string if none."
    ),
});

export type FinalReportT = z.infer<typeof FinalReport>;

/** JSON Schema for the finalize_report tool, generated from the Zod schema. */
export const finalReportJsonSchema: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(FinalReport, { target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema; // tool input_schema doesn't need the meta-schema pointer
  return schema;
})();
