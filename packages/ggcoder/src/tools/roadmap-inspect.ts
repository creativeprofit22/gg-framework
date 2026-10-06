import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { RoadmapInspectionOutcome } from "@kenkaiiii/gg-core/roadmap-workflow";

type JsonSchema = Record<string, unknown>;

export const ROADMAP_INSPECT_SCOPES = ["active-phase", "roadmap"] as const;
export type RoadmapInspectScope = (typeof ROADMAP_INSPECT_SCOPES)[number];

const roadmapInspectInputSchema: JsonSchema = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: [...ROADMAP_INSPECT_SCOPES],
      description:
        'Inside a bound Roadmap phase session the default is "active-phase" (only that phase plus the current revision). ' +
        'Use "roadmap" only when the user asks about other phases or before roadmap_phase_draft. Outside a phase session every phase is returned.',
    },
  },
  required: [],
  additionalProperties: false,
};

export const RoadmapInspectParams = z
  .object({ scope: z.enum(ROADMAP_INSPECT_SCOPES).optional() })
  .strict();

export type RoadmapInspectInput = z.infer<typeof RoadmapInspectParams>;

export function createRoadmapInspectTool(
  inspect: (input: RoadmapInspectInput) => Promise<RoadmapInspectionOutcome>,
): AgentTool<typeof RoadmapInspectParams> {
  return {
    name: "roadmap_inspect",
    description:
      "Inspect the current bounded Project Notes v3 Roadmap projection before drafting phases or assessing existing-phase status. " +
      "Always inspect with the full roadmap scope immediately before roadmap_phase_draft so the revision and existing phases are current. " +
      "Verification evidence and provenance describe historical reports, not proof of current criteria or authorization for automatic Done. " +
      "Assess the matching verification progress separately from latestProgress; legacy summaries may lack evidence and provenance. " +
      "This read-only tool returns only the bounded Roadmap projection, never the full Notes document.",
    parameters: RoadmapInspectParams,
    rawInputSchema: roadmapInspectInputSchema,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await inspect(input));
    },
  };
}
