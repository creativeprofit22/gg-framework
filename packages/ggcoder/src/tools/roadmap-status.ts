import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH,
  NOTES_ROADMAP_EVIDENCE_MAX_ITEMS,
  NOTES_ROADMAP_PROPOSALS_MAX_ITEMS,
  NOTES_ROADMAP_REASON_MAX_LENGTH,
  type NotesRoadmapStatusOutcome,
} from "@kenkaiiii/gg-core/project-notes";
import type { ProjectNotesRoadmapProposalOutcome } from "../project-notes-repository.js";
import type { RoadmapVerificationEvidenceUnmetCode } from "../core/verification-evidence.js";

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

const roadmapReferenceProposalInputSchema: JsonSchema = {
  type: "object",
  properties: {
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
  required: ["provider", "canonical_url", "owner", "repo", "relevance"],
  additionalProperties: false,
};

const roadmapStatusInputSchema: JsonSchema = {
  type: "object",
  properties: {
    update_id: { type: "string", maxLength: 128 },
    phase_id: { type: "string", maxLength: 256 },
    expected_revision: { type: "number", minimum: 0 },
    progress: { type: "string", maxLength: 4_096 },
    evidence: {
      type: "array",
      items: { type: "string", maxLength: NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH },
      maxItems: NOTES_ROADMAP_EVIDENCE_MAX_ITEMS,
    },
    verification: {
      type: "object",
      properties: {
        result: { enum: ["passed", "failed", "exception-requested"] },
        reason: { type: "string", maxLength: NOTES_ROADMAP_REASON_MAX_LENGTH },
      },
      required: ["result"],
      additionalProperties: false,
    },
    verification_bindings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion_id: { type: "string", pattern: "^[a-f0-9]{64}$" },
          execution_id: { type: "string", minLength: 1, maxLength: 128 },
        },
        required: ["criterion_id", "execution_id"],
        additionalProperties: false,
      },
      maxItems: 20,
    },
    proposed_references: {
      type: "array",
      items: roadmapReferenceProposalInputSchema,
      maxItems: NOTES_ROADMAP_PROPOSALS_MAX_ITEMS,
    },
    transition: { enum: ["pending", "in-progress", "blocked", "done"] },
    blocker: {
      type: "string",
      maxLength: 1_024,
      description:
        "Required only for a blocked transition. State only the concrete reason work cannot continue. Do not report recoverable or transient tool failures as blockers.",
    },
    required_external_action: {
      type: "string",
      maxLength: 1_024,
      description:
        "Required only for a blocked transition. State the exact decision or action required from a person or external actor before work can continue.",
    },
  },
  required: ["update_id", "phase_id", "expected_revision", "progress", "transition"],
  additionalProperties: false,
};
const normalizedText = (value: string): string => value.replace(/\r\n?/g, "\n").trim();
const normalizedCoordinate = (value: string): string => value.trim();
const optionalCoordinate = z
  .string()
  .max(4_096)
  .transform(normalizedCoordinate)
  .refine((value) => value.length > 0, "Expected a non-empty string")
  .optional()
  .transform((value) => value ?? null);

const RoadmapReferenceRange = z
  .object({
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.end_line >= range.start_line, {
    path: ["end_line"],
    message: "end_line must be at or after start_line",
  });

export const RoadmapReferenceProposalParams = z
  .object({
    provider: z
      .string()
      .max(4_096)
      .transform((value) => value.trim().toLowerCase())
      .refine((value) => value.length > 0, "Provider is required"),
    tool: optionalCoordinate,
    canonical_url: z
      .string()
      .max(2_048)
      .transform(normalizedCoordinate)
      .refine((value) => value.length > 0, "Canonical URL is required"),
    owner: z
      .string()
      .max(4_096)
      .transform(normalizedCoordinate)
      .refine((value) => value.length > 0, "Repository owner is required"),
    repo: z
      .string()
      .max(4_096)
      .transform(normalizedCoordinate)
      .refine((value) => value.length > 0, "Repository name is required"),
    revision: optionalCoordinate,
    path: optionalCoordinate,
    range: RoadmapReferenceRange.nullish().transform((value) => value ?? null),
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
    relevance: z.string().max(4_096).transform(normalizedText),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.range !== null && reference.path === null) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "path is required when range is present",
      });
    }
    if (reference.issue !== null && reference.pull_request !== null) {
      context.addIssue({
        code: "custom",
        path: ["pull_request"],
        message: "A reference cannot target both an issue and a pull request",
      });
    }
  });

const StableId = z
  .string()
  .max(128)
  .transform(normalizedCoordinate)
  .refine((value) => value.length > 0, "update_id is required");
const PhaseId = z
  .string()
  .max(256)
  .transform(normalizedCoordinate)
  .refine((value) => value.length > 0, "phase_id is required");
const Progress = z
  .string()
  .max(4_096)
  .transform(normalizedText)
  .refine((value) => value.length > 0, "progress is required");
const Evidence = z
  .array(
    z
      .string()
      .max(NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH)
      .transform(normalizedText)
      .refine((value) => value.length > 0, "Evidence items must not be empty"),
  )
  .max(NOTES_ROADMAP_EVIDENCE_MAX_ITEMS)
  .default([]);
const VerificationBinding = z
  .object({
    criterion_id: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/),
    execution_id: z.string().trim().min(1).max(128),
  })
  .strict();
const VerificationBindings = z.array(VerificationBinding).max(20).default([]);
const ProposedReferences = z
  .array(RoadmapReferenceProposalParams)
  .max(NOTES_ROADMAP_PROPOSALS_MAX_ITEMS)
  .default([]);
const ReviewReason = z
  .string()
  .max(NOTES_ROADMAP_REASON_MAX_LENGTH)
  .transform(normalizedText)
  .refine((value) => value.length > 0, "reason is required");
const Verification = z
  .discriminatedUnion("result", [
    z.object({ result: z.literal("passed") }).strict(),
    z.object({ result: z.literal("failed"), reason: ReviewReason }).strict(),
    z.object({ result: z.literal("exception-requested"), reason: ReviewReason }).strict(),
  ])
  .nullish()
  .transform((value) => value ?? null);

const PassedVerification = z.object({ result: z.literal("passed") }).strict();

const commonFields = {
  update_id: StableId,
  phase_id: PhaseId,
  expected_revision: z.number().int().nonnegative(),
  progress: Progress,
  evidence: Evidence,
  verification_bindings: VerificationBindings,
  verification: Verification,
  proposed_references: ProposedReferences,
};

export const RoadmapStatusParams = z
  .discriminatedUnion("transition", [
    z
      .object({
        ...commonFields,
        transition: z.literal("pending"),
        blocker: z.never().optional(),
        required_external_action: z.never().optional(),
      })
      .strict(),
    z
      .object({
        ...commonFields,
        transition: z.literal("in-progress"),
        blocker: z.never().optional(),
        required_external_action: z.never().optional(),
      })
      .strict(),
    z
      .object({
        ...commonFields,
        transition: z.literal("blocked"),
        blocker: z
          .string()
          .max(1_024)
          .transform(normalizedText)
          .refine((value) => value.length > 0, "blocker is required for blocked reports"),
        required_external_action: z
          .string()
          .max(1_024)
          .transform(normalizedText)
          .refine(
            (value) => value.length > 0,
            "required_external_action is required for blocked reports",
          ),
      })
      .strict(),
    z
      .object({
        ...commonFields,
        transition: z.literal("done"),
        blocker: z.never().optional(),
        required_external_action: z.never().optional(),
        evidence: Evidence,
        verification_bindings: VerificationBindings.refine(
          (bindings) => bindings.length > 0,
          "Done reports require explicit criterion-to-execution bindings; rerun legacy checks once.",
        ),
        verification: PassedVerification,
      })
      .strict(),
  ])
  .superRefine((report, context) => {
    const criterionIds = report.verification_bindings.map((binding) => binding.criterion_id);
    const executionIds = report.verification_bindings.map((binding) => binding.execution_id);
    if (
      new Set(criterionIds).size !== criterionIds.length ||
      new Set(executionIds).size !== executionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["verification_bindings"],
        message: "Verification bindings require unique criterion and execution IDs",
      });
    }
  });

export type RoadmapStatusInput = z.infer<typeof RoadmapStatusParams>;
export type RoadmapReferenceProposalInput = z.infer<typeof RoadmapReferenceProposalParams>;

export interface RoadmapStatusToolContext {
  actor: "gg-coder";
  input: RoadmapStatusInput;
}

export type RoadmapStatusToolResult =
  | {
      result: "committed" | "duplicate";
      phaseId: string;
      revision: number;
      statusOutcome: NotesRoadmapStatusOutcome;
      phaseTransitionOutcome: NotesRoadmapStatusOutcome;
      completionIntentId?: string;
      proposals: ProjectNotesRoadmapProposalOutcome[];
      message?: string;
    }
  | {
      result:
        | "reconciliation-in-progress"
        | "phase-not-bound"
        | "notes-missing"
        | "notes-corrupt"
        | "duplicate-id-conflict"
        | "operation-conflict"
        | "stale-revision"
        | "phase-not-found"
        | "phase-archived"
        | "stale-session"
        | "phase-lease-lost"
        | "plan-not-approved"
        | "plan-snapshot-missing"
        | "plan-reconciliation-required"
        | "repository-unverifiable"
        | "invalid-reference"
        | "verification-incomplete"
        | "missing-plan-progress";
      phaseId: string;
      revision?: number;
      owner?: { operationId: string; kind: string } | null;
      path?: string;
      message?: string;
      unmetEvidenceCodes?: RoadmapVerificationEvidenceUnmetCode[];
      staleCriterionIds?: string[];
      missingCriterionIds?: string[];
    };

export function createRoadmapStatusTool(
  actor: "gg-coder",
  record: (context: RoadmapStatusToolContext) => Promise<RoadmapStatusToolResult>,
): AgentTool<typeof RoadmapStatusParams> {
  return {
    name: "roadmap_status",
    description:
      "Report bounded Roadmap progress or a real external blocker. Done requires passed verification and one current classifier-approved command per criterion; completion waits for owning run settlement.",
    parameters: RoadmapStatusParams,
    rawInputSchema: roadmapStatusInputSchema,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await record({ actor, input }));
    },
  };
}
