import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type {
  PhaseBindingOutcome,
  PhaseBindingRequest,
  PhaseLeaseOutcome,
  PhaseLeaseRequestV2,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import type { ProjectNotesStorageDiagnostics } from "@kenkaiiii/gg-core/project-notes-diagnostics";

const sessionLinkSchema = z
  .object({
    session_id: z.string().trim().min(1).max(256),
    session_path: z.string().trim().min(1).max(4_096).nullable(),
  })
  .strict();
const leaseTokenSchema = z
  .object({
    lease_id: z.string().trim().min(1).max(256),
    fence: z.number().int().positive(),
  })
  .strict();
const phaseIdSchema = z.string().trim().min(1).max(256);
const projectKeySchema = z.string().trim().min(1).max(4_096);
const revisionSchema = z.number().int().min(0);
const operationIdSchema = z.string().trim().min(1).max(256);
const planIdSchema = z.string().trim().min(1).max(256).nullable();

const inspectSchema = z.object({ action: z.literal("inspect") }).strict();
const bindSchema = z
  .object({
    action: z.literal("bind-current"),
    phase_id: phaseIdSchema,
    expected_project_key: projectKeySchema,
    expected_revision: revisionSchema,
    operation_id: operationIdSchema,
  })
  .strict();
const rebindSchema = z
  .object({
    action: z.literal("rebind-current"),
    phase_id: phaseIdSchema,
    expected_project_key: projectKeySchema,
    expected_revision: revisionSchema,
    expected_previous_session: sessionLinkSchema,
    operation_id: operationIdSchema,
    confirm_rebind: z.literal(true),
  })
  .strict();
const acquireSchema = z
  .object({
    action: z.literal("acquire"),
    phase_id: phaseIdSchema,
    expected_project_key: projectKeySchema,
    expected_revision: revisionSchema,
    plan_id: planIdSchema,
    operation_id: operationIdSchema,
  })
  .strict();
const renewSchema = z
  .object({
    action: z.literal("renew"),
    phase_id: phaseIdSchema,
    expected_project_key: projectKeySchema,
    expected_revision: revisionSchema,
    plan_id: planIdSchema,
    operation_id: operationIdSchema,
    lease: leaseTokenSchema,
  })
  .strict();
const takeoverSchema = renewSchema
  .extend({
    action: z.literal("takeover"),
    confirm_takeover: z.literal(true),
    takeover_reason: z.string().trim().min(1).max(1_024),
  })
  .strict();

export const RoadmapBindParams = z.discriminatedUnion("action", [
  inspectSchema,
  bindSchema,
  rebindSchema,
  acquireSchema,
  renewSchema,
  takeoverSchema,
]);

type RoadmapBindInput = z.infer<typeof RoadmapBindParams>;
export type RoadmapBindToolResult =
  | ProjectNotesStorageDiagnostics
  | PhaseBindingOutcome
  | PhaseLeaseOutcome;

const phaseLeaseProperties = {
  phase_id: { type: "string", maxLength: 256 },
  expected_project_key: { type: "string", maxLength: 4_096 },
  expected_revision: { type: "number", minimum: 0 },
  plan_id: { type: ["string", "null"], maxLength: 256 },
  operation_id: { type: "string", maxLength: 256 },
} as const;
const leaseProperty = {
  type: "object",
  properties: {
    lease_id: { type: "string", maxLength: 256 },
    fence: { type: "number", minimum: 1 },
  },
  required: ["lease_id", "fence"],
  additionalProperties: false,
} as const;
const phaseLeaseRequired = [
  "action",
  "phase_id",
  "expected_project_key",
  "expected_revision",
  "plan_id",
  "operation_id",
] as const;

const rawInputSchema = {
  oneOf: [
    {
      type: "object",
      properties: { action: { const: "inspect" } },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "bind-current" },
        phase_id: { type: "string", maxLength: 256 },
        expected_project_key: { type: "string", maxLength: 4_096 },
        expected_revision: { type: "number", minimum: 0 },
        operation_id: { type: "string", maxLength: 256 },
      },
      required: ["action", "phase_id", "expected_project_key", "expected_revision", "operation_id"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "rebind-current" },
        phase_id: { type: "string", maxLength: 256 },
        expected_project_key: { type: "string", maxLength: 4_096 },
        expected_revision: { type: "number", minimum: 0 },
        expected_previous_session: {
          type: "object",
          properties: {
            session_id: { type: "string", maxLength: 256 },
            session_path: { type: ["string", "null"], maxLength: 4_096 },
          },
          required: ["session_id", "session_path"],
          additionalProperties: false,
        },
        operation_id: { type: "string", maxLength: 256 },
        confirm_rebind: { const: true },
      },
      required: [
        "action",
        "phase_id",
        "expected_project_key",
        "expected_revision",
        "expected_previous_session",
        "operation_id",
        "confirm_rebind",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { const: "acquire" }, ...phaseLeaseProperties },
      required: phaseLeaseRequired,
      additionalProperties: false,
    },
    ...(["renew"] as const).map((action) => ({
      type: "object",
      properties: { action: { const: action }, ...phaseLeaseProperties, lease: leaseProperty },
      required: [...phaseLeaseRequired, "lease"],
      additionalProperties: false,
    })),
    {
      type: "object",
      properties: {
        action: { const: "takeover" },
        ...phaseLeaseProperties,
        lease: leaseProperty,
        confirm_takeover: { const: true },
        takeover_reason: { type: "string", maxLength: 1_024 },
      },
      required: [...phaseLeaseRequired, "lease", "confirm_takeover", "takeover_reason"],
      additionalProperties: false,
    },
  ],
} satisfies Record<string, unknown>;

export function createRoadmapBindTool(
  handle: (
    input: { action: "inspect" } | PhaseBindingRequest | PhaseLeaseRequestV2,
  ) => Promise<RoadmapBindToolResult>,
): AgentTool<typeof RoadmapBindParams> {
  return {
    name: "roadmap_bind",
    description:
      "Inspect Roadmap binding state; keep V1 session binding compatibility; or acquire, renew, and safely take over V2 phase leases for this authenticated session.",
    parameters: RoadmapBindParams,
    rawInputSchema,
    executionMode: "sequential",
    async execute(input: RoadmapBindInput) {
      if (input.action === "inspect") return JSON.stringify(await handle(input));
      if (input.action === "bind-current" || input.action === "rebind-current") {
        const request: PhaseBindingRequest = {
          version: 1,
          action: input.action,
          phaseId: input.phase_id,
          expectedProjectKey: input.expected_project_key,
          expectedRevision: input.expected_revision,
          expectedPreviousSession:
            input.action === "rebind-current"
              ? {
                  sessionId: input.expected_previous_session.session_id,
                  sessionPath: input.expected_previous_session.session_path,
                }
              : null,
          operationId: input.operation_id,
          confirmRebind: input.action === "rebind-current",
        };
        return JSON.stringify(await handle(request));
      }
      const request: PhaseLeaseRequestV2 = {
        version: 2,
        action: input.action,
        phaseId: input.phase_id,
        expectedProjectKey: input.expected_project_key,
        expectedRevision: input.expected_revision,
        planId: input.plan_id,
        operationId: input.operation_id,
        lease:
          input.action === "acquire"
            ? null
            : { leaseId: input.lease.lease_id, fence: input.lease.fence },
        confirmTakeover: input.action === "takeover",
        takeoverReason: input.action === "takeover" ? input.takeover_reason : null,
        predecessorProof: null,
      };
      return JSON.stringify(await handle(request));
    },
  };
}
