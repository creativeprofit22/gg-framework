import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type {
  ProjectNotesCorruption,
  ProjectNotesUnsupportedFormat,
} from "@kenkaiiii/gg-core/project-notes";
import {
  ROADMAP_PHASE_BATCH_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  validateRoadmapPhaseMoveBatchRequest,
  validateRoadmapPhaseMoveRequest,
  type RoadmapPhaseMoveBatchDraft,
  type RoadmapPhaseMoveBatchRequest,
  type RoadmapPhaseMoveDraft,
  type RoadmapPhaseMoveRequest,
  type RoadmapPhaseNotEditableReason,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { PHASE_ID_MAX_LENGTH, boundedText } from "./roadmap-phase-draft.js";

const phaseIdSchema = { type: "string", minLength: 1, maxLength: PHASE_ID_MAX_LENGTH };

const placementSchemas = {
  before_phase_id: {
    ...phaseIdSchema,
    description: "Move the phase directly before this phase. Use exactly one of before/after.",
  },
  after_phase_id: {
    ...phaseIdSchema,
    description: "Move the phase directly after this phase. Use exactly one of before/after.",
  },
};

const roadmapPhaseMoveInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    expected_revision: { type: "number", minimum: 0 },
    phase_id: phaseIdSchema,
    ...placementSchemas,
    summary: {
      type: "string",
      minLength: 1,
      maxLength: ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    },
    moves: {
      type: "array",
      minItems: 1,
      maxItems: ROADMAP_PHASE_BATCH_MAX_ITEMS,
      description:
        "Move several phases in one proposal instead of phase_id and before/after: steps apply in order, each relative to the order left by the previous step; each phase moves at most once.",
      items: {
        type: "object",
        properties: { phase_id: phaseIdSchema, ...placementSchemas },
        required: ["phase_id"],
        additionalProperties: false,
      },
    },
  },
  required: ["expected_revision", "summary"],
  additionalProperties: false,
};

const placementFields = {
  before_phase_id: boundedText(PHASE_ID_MAX_LENGTH, "before_phase_id").optional(),
  after_phase_id: boundedText(PHASE_ID_MAX_LENGTH, "after_phase_id").optional(),
};

const RoadmapPhaseMoveStep = z
  .object({ phase_id: boundedText(PHASE_ID_MAX_LENGTH, "phase_id"), ...placementFields })
  .strict();

const RoadmapPhaseMoveParamsBase = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    phase_id: boundedText(PHASE_ID_MAX_LENGTH, "phase_id").optional(),
    ...placementFields,
    summary: boundedText(ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH, "summary"),
    moves: z.array(RoadmapPhaseMoveStep).min(1).max(ROADMAP_PHASE_BATCH_MAX_ITEMS).optional(),
  })
  .strict();

type RoadmapPhaseMoveBaseInput = z.infer<typeof RoadmapPhaseMoveParamsBase>;

const SINGLE_FORM_KEYS = ["phase_id", "before_phase_id", "after_phase_id"] as const;

export const RoadmapPhaseMoveParams = RoadmapPhaseMoveParamsBase.superRefine((input, context) => {
  if (input.moves !== undefined && SINGLE_FORM_KEYS.some((key) => input[key] !== undefined)) {
    context.addIssue({
      code: "custom",
      path: [],
      message:
        "use either phase_id with before_phase_id or after_phase_id, or moves with one entry per phase, not both",
    });
    return;
  }
  if (input.moves === undefined && input.phase_id === undefined) {
    context.addIssue({
      code: "custom",
      path: [],
      message:
        "expected phase_id with before_phase_id or after_phase_id, or moves with one entry per phase",
    });
    return;
  }
  const request = toRoadmapPhaseMoveToolRequest(input);
  const validation =
    "moves" in request
      ? validateRoadmapPhaseMoveBatchRequest(request)
      : validateRoadmapPhaseMoveRequest(request);
  if (!validation.ok) {
    context.addIssue({
      code: "custom",
      path: [],
      message: `${validation.error.path}: ${validation.error.message}`,
    });
  }
});

export type RoadmapPhaseMoveInput = z.infer<typeof RoadmapPhaseMoveParams>;

/** A single move, or a batch when the agent used `moves`. */
export type RoadmapPhaseMoveToolRequest = RoadmapPhaseMoveRequest | RoadmapPhaseMoveBatchRequest;

function toPlacement(input: {
  before_phase_id?: string | undefined;
  after_phase_id?: string | undefined;
}): Pick<RoadmapPhaseMoveRequest, "beforePhaseId" | "afterPhaseId"> {
  return {
    ...(input.before_phase_id === undefined ? {} : { beforePhaseId: input.before_phase_id }),
    ...(input.after_phase_id === undefined ? {} : { afterPhaseId: input.after_phase_id }),
  };
}

function toRoadmapPhaseMoveToolRequest(
  input: RoadmapPhaseMoveBaseInput,
): RoadmapPhaseMoveToolRequest {
  if (input.moves !== undefined) {
    return {
      expectedRevision: input.expected_revision,
      summary: input.summary,
      moves: input.moves.map((step) => ({ phaseId: step.phase_id, ...toPlacement(step) })),
    };
  }
  return {
    expectedRevision: input.expected_revision,
    summary: input.summary,
    phaseId: input.phase_id ?? "",
    ...toPlacement(input),
  };
}

/** Batch refusals add `moveIndex`, the 0-based step that was refused. */
export type RoadmapPhaseMoveToolResult =
  | ProjectNotesUnsupportedFormat
  | {
      status: "drafted";
      draft: RoadmapPhaseMoveDraft | RoadmapPhaseMoveBatchDraft;
      dependencyWarnings?: string[];
    }
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
  | {
      status: "phase-not-movable";
      phaseId: string;
      reason: RoadmapPhaseNotEditableReason;
      moveIndex?: number;
    }
  | { status: "target-unavailable"; phaseId: string; moveIndex?: number }
  | { status: "ahead-of-done-phase"; phaseId: string; donePhaseId: string; moveIndex?: number }
  | { status: "no-changes"; phaseId: string; moveIndex?: number }
  | { status: "invalid-proposal"; path: string; message: string };

export function createRoadmapPhaseMoveTool(
  move: (request: RoadmapPhaseMoveToolRequest) => Promise<RoadmapPhaseMoveToolResult>,
): AgentTool<typeof RoadmapPhaseMoveParams> {
  return {
    name: "roadmap_phase_move",
    description:
      "Propose moving existing Roadmap phases directly before or after other phases for user approval; never write Project Notes or files. " +
      'Call roadmap_inspect with scope "roadmap" immediately first and pass its revision as expected_revision. ' +
      "Set phase_id and exactly one of before_phase_id or after_phase_id. Done, archived, and deleted phases cannot be moved, and nothing can be moved ahead of a Done phase. " +
      "To reorder several phases, send one proposal with moves instead (one entry per phase, each with phase_id and exactly one of before_phase_id or after_phase_id); steps apply in order, each relative to the order left by the previous step, and the user approves or rejects them as a whole. " +
      "To change the order of phases, use this tool; never delete and redraft a phase. " +
      "If the move puts a phase above one of its prerequisites (or below a phase that depends on it), the result lists dependencyWarnings; the move is still drafted, so tell the user. " +
      "Nothing is saved until the user approves. After submitting, stop because the move is pending user approval. " +
      "To revise your own pending proposal (for example after reviewer feedback), call this again; it replaces that proposal in place, so never ask the user to reject it first.",
    parameters: RoadmapPhaseMoveParams,
    rawInputSchema: roadmapPhaseMoveInputSchema,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await move(toRoadmapPhaseMoveToolRequest(input)));
    },
  };
}
