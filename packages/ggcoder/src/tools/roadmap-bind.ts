import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type {
  PhaseBindingOutcome,
  PhaseBindingRequest,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import type { ProjectNotesStorageDiagnostics } from "@kenkaiiii/gg-core/project-notes-diagnostics";

const sessionLinkSchema = z
  .object({
    session_id: z.string().trim().min(1).max(256),
    session_path: z.string().trim().min(1).max(4_096).nullable(),
  })
  .strict();

const inspectSchema = z.object({ action: z.literal("inspect") }).strict();
const bindSchema = z
  .object({
    action: z.literal("bind-current"),
    phase_id: z.string().trim().min(1).max(256),
    expected_project_key: z.string().trim().min(1).max(4_096),
    expected_revision: z.number().int().min(0),
    operation_id: z.string().trim().min(1).max(256),
  })
  .strict();
const rebindSchema = z
  .object({
    action: z.literal("rebind-current"),
    phase_id: z.string().trim().min(1).max(256),
    expected_project_key: z.string().trim().min(1).max(4_096),
    expected_revision: z.number().int().min(0),
    expected_previous_session: sessionLinkSchema,
    operation_id: z.string().trim().min(1).max(256),
    confirm_rebind: z.literal(true),
  })
  .strict();

export const RoadmapBindParams = z.discriminatedUnion("action", [
  inspectSchema,
  bindSchema,
  rebindSchema,
]);

type RoadmapBindInput = z.infer<typeof RoadmapBindParams>;
export type RoadmapBindToolResult = ProjectNotesStorageDiagnostics | PhaseBindingOutcome;

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
      required: [
        "action",
        "phase_id",
        "expected_project_key",
        "expected_revision",
        "operation_id",
      ],
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
  ],
} satisfies Record<string, unknown>;

export function createRoadmapBindTool(
  handle: (input: { action: "inspect" } | PhaseBindingRequest) => Promise<RoadmapBindToolResult>,
): AgentTool<typeof RoadmapBindParams> {
  return {
    name: "roadmap_bind",
    description:
      "Inspect the current Roadmap store/session binding, bind an unbound phase to this authenticated coding session, or explicitly rebind a phase from an exact previous session. The destination is always the current authenticated session; it cannot be supplied.",
    parameters: RoadmapBindParams,
    rawInputSchema,
    executionMode: "sequential",
    async execute(input: RoadmapBindInput) {
      if (input.action === "inspect") return JSON.stringify(await handle(input));
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
    },
  };
}
