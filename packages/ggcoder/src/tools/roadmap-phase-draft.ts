import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProjectNotesCorruption } from "@kenkaiiii/gg-core/project-notes";
import {
  ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
  ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  ROADMAP_PHASE_GOAL_MAX_LENGTH,
  ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  ROADMAP_PHASE_TITLE_MAX_LENGTH,
  ROADMAP_PROPOSED_PHASES_MAX_ITEMS,
  normalizeRoadmapWorkflowText,
  type RoadmapPhaseDraft,
  type RoadmapPhaseDraftRequest,
} from "@kenkaiiii/gg-core/roadmap-workflow";

type JsonSchema = Record<string, unknown>;

const roadmapProposedPhaseInputSchema: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: ROADMAP_PHASE_TITLE_MAX_LENGTH },
    goal: { type: "string", minLength: 1, maxLength: ROADMAP_PHASE_GOAL_MAX_LENGTH },
    doneWhen: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
      },
      minItems: 1,
      maxItems: ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
    },
    sourcePrompt: {
      type: "string",
      minLength: 1,
      maxLength: ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
    },
  },
  required: ["title", "goal", "doneWhen", "sourcePrompt"],
  additionalProperties: false,
};

const roadmapPhaseDraftInputSchema: JsonSchema = {
  type: "object",
  properties: {
    expected_revision: { type: "number", minimum: 0 },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    },
    phases: {
      type: "array",
      items: roadmapProposedPhaseInputSchema,
      minItems: 1,
      maxItems: ROADMAP_PROPOSED_PHASES_MAX_ITEMS,
    },
  },
  required: ["expected_revision", "summary", "phases"],
  additionalProperties: false,
};

function boundedText(maxLength: number, label: string) {
  return z
    .string()
    .transform(normalizeRoadmapWorkflowText)
    .refine((value) => Array.from(value).length > 0, `${label} is required`)
    .refine(
      (value) => Array.from(value).length <= maxLength,
      `${label} must contain at most ${maxLength} normalized characters`,
    );
}

const DoneWhen = z
  .array(boundedText(ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH, "Completion criterion"))
  .min(1)
  .max(ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS)
  .superRefine((criteria, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < criteria.length; index += 1) {
      const criterion = criteria[index]!;
      if (seen.has(criterion)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Completion criteria must be unique",
        });
      }
      seen.add(criterion);
    }
  });

const RoadmapProposedPhaseParams = z
  .object({
    title: boundedText(ROADMAP_PHASE_TITLE_MAX_LENGTH, "title"),
    goal: boundedText(ROADMAP_PHASE_GOAL_MAX_LENGTH, "goal"),
    doneWhen: DoneWhen,
    sourcePrompt: boundedText(ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH, "sourcePrompt"),
  })
  .strict();

export const RoadmapPhaseDraftParams = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    summary: boundedText(ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH, "summary"),
    phases: z.array(RoadmapProposedPhaseParams).min(1).max(ROADMAP_PROPOSED_PHASES_MAX_ITEMS),
  })
  .strict();

export type RoadmapPhaseDraftInput = z.infer<typeof RoadmapPhaseDraftParams>;

export type RoadmapPhaseDraftToolResult =
  | { status: "drafted"; draft: RoadmapPhaseDraft }
  | { status: "proposal-pending"; draftId: string }
  | { status: "inspection-required" }
  | {
      status: "inspection-revision-mismatch";
      inspectedRevision: number;
      requestedRevision: number;
    }
  | { status: "stale-revision"; expectedRevision: number; currentRevision: number }
  | { status: "notes-missing" }
  | ({ status: "notes-corrupt" } & ProjectNotesCorruption)
  | { status: "invalid-proposal"; path: string; message: string };

export function createRoadmapPhaseDraftTool(
  draft: (request: RoadmapPhaseDraftRequest) => Promise<RoadmapPhaseDraftToolResult>,
): AgentTool<typeof RoadmapPhaseDraftParams> {
  return {
    name: "roadmap_phase_draft",
    description:
      "Draft bounded Roadmap phases for approval; never write Project Notes or files while drafting. " +
      "Call roadmap_inspect immediately first and pass its revision as expected_revision. Draft only flat peer phases, never nested or parent/child phases. " +
      "After submitting the draft, stop because it is pending user approval; do not implement it. " +
      "Use roadmap_status for execution progress on approved phases. Ordinary coding requests need no Roadmap action.",
    parameters: RoadmapPhaseDraftParams,
    rawInputSchema: roadmapPhaseDraftInputSchema,
    executionMode: "sequential",
    async execute({ expected_revision, summary, phases }) {
      const request: RoadmapPhaseDraftRequest = {
        expectedRevision: expected_revision,
        summary,
        phases,
      };
      return JSON.stringify(await draft(request));
    },
  };
}
