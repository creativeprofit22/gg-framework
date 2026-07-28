import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

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
      .max(4_096)
      .transform(normalizedText)
      .refine((value) => value.length > 0, "Evidence items must not be empty"),
  )
  .max(20)
  .default([]);
const ProposedReferences = z.array(RoadmapReferenceProposalParams).max(20).default([]);

const commonFields = {
  update_id: StableId,
  phase_id: PhaseId,
  expected_revision: z.number().int().nonnegative().optional(),
  progress: Progress,
  evidence: Evidence,
  proposed_references: ProposedReferences,
};

export const RoadmapStatusParams = z.discriminatedUnion("transition", [
  z
    .object({
      ...commonFields,
      transition: z.literal("pending"),
      blocker: z.never().optional(),
    })
    .strict(),
  z
    .object({
      ...commonFields,
      transition: z.literal("in-progress"),
      blocker: z.never().optional(),
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
    })
    .strict(),
  z
    .object({
      ...commonFields,
      transition: z.literal("review"),
      blocker: z.never().optional(),
      evidence: Evidence.refine((items) => items.length > 0, {
        message: "review reports require at least one evidence item",
      }),
    })
    .strict(),
]);

export type RoadmapStatusInput = z.infer<typeof RoadmapStatusParams>;
export type RoadmapReferenceProposalInput = z.infer<typeof RoadmapReferenceProposalParams>;

export type RoadmapStatusActor = "gg-coder" | "ken" | "ken-autopilot";

export interface RoadmapStatusToolContext {
  actor: RoadmapStatusActor;
  input: RoadmapStatusInput;
}

export type RoadmapStatusToolResult = Record<string, unknown> & {
  result: string;
  phaseId: string;
};

export function createRoadmapStatusTool(
  actor: RoadmapStatusActor,
  record: (context: RoadmapStatusToolContext) => Promise<RoadmapStatusToolResult>,
): AgentTool<typeof RoadmapStatusParams> {
  return {
    name: "roadmap_status",
    description:
      "Append one bounded Roadmap progress, blocker, evidence, and structured-reference report. " +
      "Report meaningful milestones promptly, one call at a time. Cite actual verification in evidence, " +
      "reuse update_id only when retrying the same report, and avoid repeating an unchanged report. " +
      "This tool cannot mark a phase Done or clear a user override.",
    parameters: RoadmapStatusParams,
    executionMode: "sequential",
    async execute(input) {
      return JSON.stringify(await record({ actor, input }));
    },
  };
}
