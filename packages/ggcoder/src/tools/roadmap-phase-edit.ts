import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type {
  ProjectNotesCorruption,
  ProjectNotesUnsupportedFormat,
} from "@kenkaiiii/gg-core/project-notes";
import {
  ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
  ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  ROADMAP_PHASE_GOAL_MAX_LENGTH,
  ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  ROADMAP_PHASE_TITLE_MAX_LENGTH,
  validateRoadmapPhaseEditRequest,
  type RoadmapPhaseEditDraft,
  type RoadmapPhaseEditRequest,
  type RoadmapPhaseNotEditableReason,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { DoneWhen, PHASE_ID_MAX_LENGTH, boundedText } from "./roadmap-phase-draft.js";

const roadmapPhaseEditInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    expected_revision: { type: "number", minimum: 0 },
    phase_id: { type: "string", minLength: 1, maxLength: PHASE_ID_MAX_LENGTH },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    },
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
  },
  required: ["expected_revision", "phase_id", "summary"],
  additionalProperties: false,
};

const RoadmapPhaseEditParamsBase = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    phase_id: boundedText(PHASE_ID_MAX_LENGTH, "phase_id"),
    summary: boundedText(ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH, "summary"),
    title: boundedText(ROADMAP_PHASE_TITLE_MAX_LENGTH, "Phase title").optional(),
    goal: boundedText(ROADMAP_PHASE_GOAL_MAX_LENGTH, "Phase goal").optional(),
    doneWhen: DoneWhen.optional(),
    sourcePrompt: boundedText(ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH, "Source prompt").optional(),
  })
  .strict();

export const RoadmapPhaseEditParams = RoadmapPhaseEditParamsBase.superRefine((input, context) => {
  const validation = validateRoadmapPhaseEditRequest(toRoadmapPhaseEditRequest(input));
  if (!validation.ok) {
    context.addIssue({
      code: "custom",
      path: [],
      message: `${validation.error.path}: ${validation.error.message}`,
    });
  }
});

export type RoadmapPhaseEditInput = z.infer<typeof RoadmapPhaseEditParams>;

function toRoadmapPhaseEditRequest(
  input: z.infer<typeof RoadmapPhaseEditParamsBase>,
): RoadmapPhaseEditRequest {
  return {
    expectedRevision: input.expected_revision,
    summary: input.summary,
    phaseId: input.phase_id,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.doneWhen === undefined ? {} : { doneWhen: input.doneWhen }),
    ...(input.sourcePrompt === undefined ? {} : { sourcePrompt: input.sourcePrompt }),
  };
}

export type RoadmapPhaseEditToolResult =
  | ProjectNotesUnsupportedFormat
  | { status: "drafted"; draft: RoadmapPhaseEditDraft }
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
  edit: (request: RoadmapPhaseEditRequest) => Promise<RoadmapPhaseEditToolResult>,
): AgentTool<typeof RoadmapPhaseEditParams> {
  return {
    name: "roadmap_phase_edit",
    description:
      "Propose changes to one existing Roadmap phase's title, goal, doneWhen, or sourcePrompt for user approval; never write Project Notes or files. " +
      "Call roadmap_inspect immediately first and pass its revision as expected_revision and the phase's id as phase_id. " +
      "To change sourcePrompt, first call roadmap_inspect with that phase_id to read the current prompt. " +
      "Include only the fields that change; doneWhen replaces the whole list. Done, archived, and deleted phases cannot be edited. " +
      "Never delete and redraft, or add a duplicate phase, to change an existing phase. Never loosen completion criteria to satisfy a Done transition. " +
      "Nothing is saved until the user approves. After submitting, stop because the edit is pending user approval. " +
      "To revise your own pending proposal (for example after reviewer feedback), call this again; it replaces that proposal in place, so never ask the user to reject it first.",
    parameters: RoadmapPhaseEditParams,
    rawInputSchema: roadmapPhaseEditInputSchema,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await edit(toRoadmapPhaseEditRequest(input)));
    },
  };
}
