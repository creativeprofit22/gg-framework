import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  NOTES_ROADMAP_PROPOSALS_MAX_ITEMS,
  type ProjectNotesCorruption,
} from "@kenkaiiii/gg-core/project-notes";
import {
  ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
  ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  ROADMAP_PHASE_GOAL_MAX_LENGTH,
  ROADMAP_DRAFT_REFERENCE_KEY_MAX_LENGTH,
  ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS,
  ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  ROADMAP_PHASE_TITLE_MAX_LENGTH,
  ROADMAP_PROPOSED_PHASES_MAX_ITEMS,
  normalizeRoadmapWorkflowText,
  validateRoadmapPhaseDraftRequest,
  type RoadmapPhaseDraft,
  type RoadmapPhaseDraftRequest,
} from "@kenkaiiii/gg-core/roadmap-workflow";

type JsonSchema = Record<string, unknown>;

const roadmapReferenceRangeInputSchema: JsonSchema = {
  type: "object",
  properties: {
    start_line: { type: "number", minimum: 1 },
    end_line: { type: "number", minimum: 1 },
  },
  required: ["start_line", "end_line"],
  additionalProperties: false,
};

const roadmapDraftReferenceInputSchema: JsonSchema = {
  type: "object",
  properties: {
    reference_key: {
      type: "string",
      minLength: 1,
      maxLength: ROADMAP_DRAFT_REFERENCE_KEY_MAX_LENGTH,
    },
    provider: { type: "string", maxLength: 4_096 },
    tool: { type: "string", maxLength: 4_096 },
    canonical_url: { type: "string", maxLength: 2_048 },
    owner: { type: "string", maxLength: 4_096 },
    repo: { type: "string", maxLength: 4_096 },
    revision: { type: "string", maxLength: 4_096 },
    path: { type: "string", maxLength: 4_096 },
    range: roadmapReferenceRangeInputSchema,
    issue: { type: "number", minimum: 1 },
    pull_request: { type: "number", minimum: 1 },
    query: { type: "string", maxLength: 4_096 },
    anchor: { type: "string", maxLength: 4_096 },
    relevance: { type: "string", maxLength: 4_096 },
  },
  required: ["reference_key", "provider", "canonical_url", "owner", "repo", "relevance"],
  additionalProperties: false,
};

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
    reference_keys: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: ROADMAP_DRAFT_REFERENCE_KEY_MAX_LENGTH },
      maxItems: ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS,
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
    proposed_references: {
      type: "array",
      items: roadmapDraftReferenceInputSchema,
      maxItems: NOTES_ROADMAP_PROPOSALS_MAX_ITEMS,
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

const referenceKey = boundedText(ROADMAP_DRAFT_REFERENCE_KEY_MAX_LENGTH, "reference key");
const optionalCoordinate = z
  .string()
  .max(4_096)
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "Expected a non-empty string")
  .optional()
  .transform((value) => value ?? null);

const RoadmapDraftReferenceParams = z
  .object({
    reference_key: referenceKey,
    provider: z
      .string()
      .max(4_096)
      .transform((value) => value.trim().toLowerCase()),
    tool: optionalCoordinate,
    canonical_url: z
      .string()
      .max(2_048)
      .transform((value) => value.trim()),
    owner: z
      .string()
      .max(4_096)
      .transform((value) => value.trim()),
    repo: z
      .string()
      .max(4_096)
      .transform((value) => value.trim()),
    revision: optionalCoordinate,
    path: optionalCoordinate,
    range: z
      .object({ start_line: z.number().int().positive(), end_line: z.number().int().positive() })
      .strict()
      .refine((range) => range.end_line >= range.start_line, {
        path: ["end_line"],
        message: "end_line must be at or after start_line",
      })
      .nullish()
      .transform((value) => value ?? null),
    issue: z
      .number()
      .int()
      .positive()
      .nullish()
      .transform((value) => value ?? null),
    pull_request: z
      .number()
      .int()
      .positive()
      .nullish()
      .transform((value) => value ?? null),
    query: optionalCoordinate,
    anchor: optionalCoordinate,
    relevance: z.string().max(4_096).transform(normalizeRoadmapWorkflowText),
  })
  .strict();

const RoadmapProposedPhaseParams = z
  .object({
    title: boundedText(ROADMAP_PHASE_TITLE_MAX_LENGTH, "title"),
    goal: boundedText(ROADMAP_PHASE_GOAL_MAX_LENGTH, "goal"),
    doneWhen: DoneWhen,
    sourcePrompt: boundedText(ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH, "sourcePrompt"),
    reference_keys: z.array(referenceKey).max(ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS).optional(),
  })
  .strict();

const RoadmapPhaseDraftParamsBase = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    summary: boundedText(ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH, "summary"),
    phases: z.array(RoadmapProposedPhaseParams).min(1).max(ROADMAP_PROPOSED_PHASES_MAX_ITEMS),
    proposed_references: z
      .array(RoadmapDraftReferenceParams)
      .max(NOTES_ROADMAP_PROPOSALS_MAX_ITEMS)
      .optional(),
  })
  .strict();

export const RoadmapPhaseDraftParams = RoadmapPhaseDraftParamsBase.superRefine((input, context) => {
  const validation = validateRoadmapPhaseDraftRequest(toRoadmapPhaseDraftRequest(input));
  if (!validation.ok) {
    context.addIssue({
      code: "custom",
      path: [],
      message: `${validation.error.path}: ${validation.error.message}`,
    });
  }
});

export type RoadmapPhaseDraftInput = z.infer<typeof RoadmapPhaseDraftParams>;

function toRoadmapPhaseDraftRequest(
  input: z.infer<typeof RoadmapPhaseDraftParamsBase>,
): RoadmapPhaseDraftRequest {
  return {
    expectedRevision: input.expected_revision,
    summary: input.summary,
    phases: input.phases.map(({ reference_keys, ...phase }) => ({
      ...phase,
      referenceKeys: reference_keys ?? [],
    })),
    proposedReferences: (input.proposed_references ?? []).map((reference) => ({
      referenceKey: reference.reference_key,
      provider: reference.provider,
      tool: reference.tool,
      canonicalUrl: reference.canonical_url,
      owner: reference.owner,
      repo: reference.repo,
      revision: reference.revision,
      path: reference.path,
      range:
        reference.range === null
          ? null
          : { startLine: reference.range.start_line, endLine: reference.range.end_line },
      issue: reference.issue,
      pullRequest: reference.pull_request,
      query: reference.query,
      anchor: reference.anchor,
      relevance: reference.relevance,
    })),
  };
}

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
    async execute(input) {
      return JSON.stringify(await draft(toRoadmapPhaseDraftRequest(input)));
    },
  };
}
