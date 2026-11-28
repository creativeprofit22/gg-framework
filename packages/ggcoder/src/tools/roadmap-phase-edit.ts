import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type {
  ProjectNotesCorruption,
  ProjectNotesUnsupportedFormat,
} from "@kenkaiiii/gg-core/project-notes";
import {
  ROADMAP_PHASE_BATCH_MAX_ITEMS,
  ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
  ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  ROADMAP_PHASE_DEPENDS_ON_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  ROADMAP_PHASE_GOAL_MAX_LENGTH,
  ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  ROADMAP_PHASE_TITLE_MAX_LENGTH,
  validateRoadmapPhaseEditBatchRequest,
  validateRoadmapPhaseEditRequest,
  type RoadmapPhaseEditBatchDraft,
  type RoadmapPhaseEditBatchItemRequest,
  type RoadmapPhaseEditBatchRequest,
  type RoadmapPhaseEditDraft,
  type RoadmapPhaseEditRequest,
  type RoadmapPhaseNotEditableReason,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { DoneWhen, PHASE_ID_MAX_LENGTH, boundedText } from "./roadmap-phase-draft.js";

const phaseFieldSchemas: Record<string, unknown> = {
  title: { type: "string", minLength: 1, maxLength: ROADMAP_PHASE_TITLE_MAX_LENGTH },
  goal: { type: "string", minLength: 1, maxLength: ROADMAP_PHASE_GOAL_MAX_LENGTH },
  doneWhen: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH },
    minItems: 1,
    maxItems: ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  },
  sourcePrompt: {
    type: "string",
    minLength: 1,
    maxLength: ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  },
  depends_on: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: PHASE_ID_MAX_LENGTH },
    maxItems: ROADMAP_PHASE_DEPENDS_ON_MAX_ITEMS,
    description:
      "Ids of phases that must be Done before this one starts; replaces the whole list. [] removes all links.",
  },
};

const phaseIdSchema = { type: "string", minLength: 1, maxLength: PHASE_ID_MAX_LENGTH };

const roadmapPhaseEditInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    expected_revision: { type: "number", minimum: 0 },
    phase_id: phaseIdSchema,
    summary: {
      type: "string",
      minLength: 1,
      maxLength: ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    },
    ...phaseFieldSchemas,
    edits: {
      type: "array",
      minItems: 1,
      maxItems: ROADMAP_PHASE_BATCH_MAX_ITEMS,
      description:
        "Edit several phases in one proposal instead of phase_id and fields: one entry per phase, each with phase_id and only its changed fields.",
      items: {
        type: "object",
        properties: { phase_id: phaseIdSchema, ...phaseFieldSchemas },
        required: ["phase_id"],
        additionalProperties: false,
      },
    },
  },
  required: ["expected_revision", "summary"],
  additionalProperties: false,
};

const phaseFields = {
  title: boundedText(ROADMAP_PHASE_TITLE_MAX_LENGTH, "Phase title").optional(),
  goal: boundedText(ROADMAP_PHASE_GOAL_MAX_LENGTH, "Phase goal").optional(),
  doneWhen: DoneWhen.optional(),
  sourcePrompt: boundedText(ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH, "Source prompt").optional(),
  depends_on: z
    .array(boundedText(PHASE_ID_MAX_LENGTH, "depends_on item"))
    .max(ROADMAP_PHASE_DEPENDS_ON_MAX_ITEMS)
    .optional(),
};

const RoadmapPhaseEditItem = z
  .object({ phase_id: boundedText(PHASE_ID_MAX_LENGTH, "phase_id"), ...phaseFields })
  .strict();

const RoadmapPhaseEditParamsBase = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    phase_id: boundedText(PHASE_ID_MAX_LENGTH, "phase_id").optional(),
    summary: boundedText(ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH, "summary"),
    ...phaseFields,
    edits: z.array(RoadmapPhaseEditItem).min(1).max(ROADMAP_PHASE_BATCH_MAX_ITEMS).optional(),
  })
  .strict();

type RoadmapPhaseEditBaseInput = z.infer<typeof RoadmapPhaseEditParamsBase>;

const SINGLE_FORM_KEYS = [
  "phase_id",
  "title",
  "goal",
  "doneWhen",
  "sourcePrompt",
  "depends_on",
] as const;

export const RoadmapPhaseEditParams = RoadmapPhaseEditParamsBase.superRefine((input, context) => {
  if (input.edits !== undefined && SINGLE_FORM_KEYS.some((key) => input[key] !== undefined)) {
    context.addIssue({
      code: "custom",
      path: [],
      message:
        "use either phase_id with its changed fields, or edits with one entry per phase, not both",
    });
    return;
  }
  if (input.edits === undefined && input.phase_id === undefined) {
    context.addIssue({
      code: "custom",
      path: [],
      message: "expected phase_id with its changed fields, or edits with one entry per phase",
    });
    return;
  }
  const request = toRoadmapPhaseEditToolRequest(input);
  const validation =
    "edits" in request
      ? validateRoadmapPhaseEditBatchRequest(request)
      : validateRoadmapPhaseEditRequest(request);
  if (!validation.ok) {
    context.addIssue({
      code: "custom",
      path: [],
      message: `${validation.error.path}: ${validation.error.message}`,
    });
  }
});

export type RoadmapPhaseEditInput = z.infer<typeof RoadmapPhaseEditParams>;

/** A single-phase edit, or a batch when the agent used `edits`. */
export type RoadmapPhaseEditToolRequest = RoadmapPhaseEditRequest | RoadmapPhaseEditBatchRequest;

function toEditFields(
  input: z.infer<typeof RoadmapPhaseEditItem> | RoadmapPhaseEditBaseInput,
): Omit<RoadmapPhaseEditBatchItemRequest, "phaseId"> {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.doneWhen === undefined ? {} : { doneWhen: input.doneWhen }),
    ...(input.sourcePrompt === undefined ? {} : { sourcePrompt: input.sourcePrompt }),
    ...(input.depends_on === undefined ? {} : { dependsOn: input.depends_on }),
  };
}

function toRoadmapPhaseEditToolRequest(
  input: RoadmapPhaseEditBaseInput,
): RoadmapPhaseEditToolRequest {
  if (input.edits !== undefined) {
    return {
      expectedRevision: input.expected_revision,
      summary: input.summary,
      edits: input.edits.map((item) => ({ phaseId: item.phase_id, ...toEditFields(item) })),
    };
  }
  return {
    expectedRevision: input.expected_revision,
    summary: input.summary,
    phaseId: input.phase_id ?? "",
    ...toEditFields(input),
  };
}

export type RoadmapPhaseEditToolResult =
  | ProjectNotesUnsupportedFormat
  | { status: "drafted"; draft: RoadmapPhaseEditDraft | RoadmapPhaseEditBatchDraft }
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
  | { status: "phase-not-editable"; phaseId: string; reason: RoadmapPhaseNotEditableReason }
  | { status: "no-changes"; phaseId: string }
  | { status: "invalid-proposal"; path: string; message: string };

export function createRoadmapPhaseEditTool(
  edit: (request: RoadmapPhaseEditToolRequest) => Promise<RoadmapPhaseEditToolResult>,
): AgentTool<typeof RoadmapPhaseEditParams> {
  return {
    name: "roadmap_phase_edit",
    description:
      "Propose changes to existing Roadmap phases' title, goal, doneWhen, sourcePrompt, or depends_on for user approval; never write Project Notes or files. " +
      "Call roadmap_inspect immediately first and pass its revision as expected_revision and the phase's id as phase_id. " +
      "To change sourcePrompt, first call roadmap_inspect with that phase_id to read the current prompt. " +
      "Include only the fields that change; doneWhen and depends_on replace the whole list; depends_on: [] removes all dependency links, and missing, deleted, self or circular links are rejected. Done, archived, and deleted phases cannot be edited. " +
      'To change several phases, send one proposal with edits (one entry per phase: phase_id plus its changed fields) instead of phase_id and fields; it needs roadmap_inspect with scope "roadmap" last (read any phase whose sourcePrompt changes by phase_id before that), and the user approves or rejects it as a whole. ' +
      "Never delete and redraft, or add a duplicate phase, to change an existing phase. Never loosen completion criteria to satisfy a Done transition. " +
      "Nothing is saved until the user approves. After submitting, stop because the edit is pending user approval. " +
      "To revise your own pending proposal (for example after reviewer feedback), call this again; it replaces that proposal in place, so never ask the user to reject it first.",
    parameters: RoadmapPhaseEditParams,
    rawInputSchema: roadmapPhaseEditInputSchema,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await edit(toRoadmapPhaseEditToolRequest(input)));
    },
  };
}
