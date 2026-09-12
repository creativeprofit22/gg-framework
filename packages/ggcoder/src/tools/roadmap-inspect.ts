import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { RoadmapInspectionOutcome } from "@kenkaiiii/gg-core/roadmap-workflow";

type JsonSchema = Record<string, unknown>;

const roadmapInspectInputSchema: JsonSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

export const RoadmapInspectParams = z.object({}).strict();

export type RoadmapInspectInput = z.infer<typeof RoadmapInspectParams>;

export function createRoadmapInspectTool(
  inspect: () => Promise<RoadmapInspectionOutcome>,
): AgentTool<typeof RoadmapInspectParams> {
  return {
    name: "roadmap_inspect",
    description:
      "Inspect the current bounded Project Notes v3 Roadmap projection before drafting phases or assessing existing-phase status. " +
      "Always inspect immediately before roadmap_phase_draft so the revision and existing phases are current. " +
      "Verification evidence and provenance describe historical reports, not proof of current criteria or authorization for automatic Done. " +
      "Assess the matching verification progress separately from latestProgress; legacy summaries may lack evidence and provenance. " +
      "This read-only tool returns only the bounded Roadmap projection, never the full Notes document.",
    parameters: RoadmapInspectParams,
    rawInputSchema: roadmapInspectInputSchema,
    executionMode: "sequential",
    async execute() {
      return JSON.stringify(await inspect());
    },
  };
}
