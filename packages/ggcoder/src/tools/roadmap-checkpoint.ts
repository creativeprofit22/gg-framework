import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

const roadmapCheckpointInputSchema = {
  type: "object",
  properties: {
    phase_id: { type: "string", maxLength: 256 },
    plan_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    step_id: { type: "string", pattern: "^[a-f0-9]{64}$" },
    expected_revision: { type: "number", minimum: 0 },
  },
  required: ["phase_id", "plan_hash", "step_id", "expected_revision"],
  additionalProperties: false,
} as const;

const HexHash = z.string().regex(/^[a-f0-9]{64}$/);

export const RoadmapCheckpointParams = z
  .object({
    phase_id: z.string().trim().min(1).max(256),
    plan_hash: HexHash,
    step_id: HexHash,
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();

export type RoadmapCheckpointInput = z.infer<typeof RoadmapCheckpointParams>;

export interface RoadmapCheckpointToolContext {
  actor: "gg-coder";
  input: RoadmapCheckpointInput;
}

export interface RoadmapCheckpointToolResult {
  result: string;
  phaseId: string;
  stepId: string;
  revision?: number;
  message?: string;
}

export function createRoadmapCheckpointTool(
  actor: "gg-coder",
  checkpoint: (context: RoadmapCheckpointToolContext) => Promise<RoadmapCheckpointToolResult>,
): AgentTool<typeof RoadmapCheckpointParams> {
  return {
    name: "roadmap_checkpoint",
    description:
      "Persist one completed canonical Roadmap plan step. Use the exact phase, plan hash, step ID, and current Notes revision; retries are idempotent.",
    parameters: RoadmapCheckpointParams,
    rawInputSchema: roadmapCheckpointInputSchema,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await checkpoint({ actor, input }));
    },
  };
}
