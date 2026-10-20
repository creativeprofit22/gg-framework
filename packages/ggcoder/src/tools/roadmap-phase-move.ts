import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type {
  ProjectNotesCorruption,
  ProjectNotesUnsupportedFormat,
} from "@kenkaiiii/gg-core/project-notes";
import {
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  validateRoadmapPhaseMoveRequest,
  type RoadmapPhaseMoveDraft,
  type RoadmapPhaseMoveRequest,
  type RoadmapPhaseNotEditableReason,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { PHASE_ID_MAX_LENGTH, boundedText } from "./roadmap-phase-draft.js";

const phaseIdSchema = { type: "string", minLength: 1, maxLength: PHASE_ID_MAX_LENGTH };

const roadmapPhaseMoveInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    expected_revision: { type: "number", minimum: 0 },
    phase_id: phaseIdSchema,
    before_phase_id: {
      ...phaseIdSchema,
      description: "Move the phase directly before this phase. Use exactly one of before/after.",
    },
    after_phase_id: {
      ...phaseIdSchema,
      description: "Move the phase directly after this phase. Use exactly one of before/after.",
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    },
  },
  required: ["expected_revision", "phase_id", "summary"],
  additionalProperties: false,
};

const RoadmapPhaseMoveParamsBase = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    phase_id: boundedText(PHASE_ID_MAX_LENGTH, "phase_id"),
    before_phase_id: boundedText(PHASE_ID_MAX_LENGTH, "before_phase_id").optional(),
    after_phase_id: boundedText(PHASE_ID_MAX_LENGTH, "after_phase_id").optional(),
    summary: boundedText(ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH, "summary"),
  })
  .strict();

export const RoadmapPhaseMoveParams = RoadmapPhaseMoveParamsBase.superRefine((input, context) => {
  const validation = validateRoadmapPhaseMoveRequest(toRoadmapPhaseMoveRequest(input));
  if (!validation.ok) {
    context.addIssue({
      code: "custom",
      path: [],
      message: `${validation.error.path}: ${validation.error.message}`,
    });
  }
});

export type RoadmapPhaseMoveInput = z.infer<typeof RoadmapPhaseMoveParams>;

function toRoadmapPhaseMoveRequest(
  input: z.infer<typeof RoadmapPhaseMoveParamsBase>,
): RoadmapPhaseMoveRequest {
  return {
    expectedRevision: input.expected_revision,
    summary: input.summary,
    phaseId: input.phase_id,
    ...(input.before_phase_id === undefined ? {} : { beforePhaseId: input.before_phase_id }),
    ...(input.after_phase_id === undefined ? {} : { afterPhaseId: input.after_phase_id }),
  };
}

export type RoadmapPhaseMoveToolResult =
  | ProjectNotesUnsupportedFormat
  | { status: "drafted"; draft: RoadmapPhaseMoveDraft }
  | { status: "proposal-pending"; draftId: string }
  | { status: "inspection-required"; message: string }
  | {
      status: "inspection-revision-mismatch";
      inspectedRevision: number;
      requestedRevision: number;
    }
  | { status: "stale-revision"; expectedRevision: number; currentRevision: number }
  | { status: "notes-missing" }
  | ({ status: "notes-corrupt" } & ProjectNotesCorruption)
  | { status: "phase-not-movable"; phaseId: string; reason: RoadmapPhaseNotEditableReason }
  | { status: "target-unavailable"; phaseId: string }
  | { status: "ahead-of-done-phase"; phaseId: string; donePhaseId: string }
  | { status: "no-changes"; phaseId: string }
  | { status: "invalid-proposal"; path: string; message: string };

export function createRoadmapPhaseMoveTool(
  move: (request: RoadmapPhaseMoveRequest) => Promise<RoadmapPhaseMoveToolResult>,
): AgentTool<typeof RoadmapPhaseMoveParams> {
  return {
    name: "roadmap_phase_move",
    description:
      "Propose moving one existing Roadmap phase directly before or after another phase for user approval; never write Project Notes or files. " +
      'Call roadmap_inspect with scope "roadmap" immediately first and pass its revision as expected_revision. ' +
      "Set phase_id and exactly one of before_phase_id or after_phase_id. Done, archived, and deleted phases cannot be moved, and nothing can be moved ahead of a Done phase. " +
      "To change the order of phases, use this tool; never delete and redraft a phase. " +
      "Nothing is saved until the user approves. After submitting, stop because the move is pending user approval.",
    parameters: RoadmapPhaseMoveParams,
    rawInputSchema: roadmapPhaseMoveInputSchema,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await move(toRoadmapPhaseMoveRequest(input)));
    },
  };
}
