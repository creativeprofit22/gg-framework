/// <reference lib="es2022.array" />
// The real daemon renderer executes under Node and uses Array.at; this test imports its source.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderContinuationPrompt } from "../../packages/ggcoder/src/core/continuation-handoff";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn(async () => vi.fn()),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import {
  createPaneAgentClient,
  switchKenModel,
  cancelKen,
  sendKenPrompt,
  getState,
  requireContinuationCommitResponse,
  requireContinuationAcceptedEvent,
  requireContinuationHandoffResponse,
} from "./agent";

it.each(["primary", "auxiliary"])(
  "captures %s mentor cancellation identity before readiness and propagates HTTP rejection",
  async (paneId) => {
    let release!: (value: unknown) => void;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    invoke.mockImplementation(async (command) => {
      if (command === "agent_pane_status") return ready;
      if (command === "agent_ken_cancel") throw new Error("stale cancellation rejected");
      return {};
    });
    const ken = { conversationId: "conversation", activationEpoch: "epoch", runId: "captured" };
    const pending =
      paneId === "primary" ? cancelKen(ken) : createPaneAgentClient(paneId).cancelKen(ken);
    const rejected = expect(pending).rejects.toThrow("stale cancellation rejected");
    ken.runId = "later";
    release({ generation: 1, ready: true });
    await rejected;
    expect(invoke).toHaveBeenCalledWith("agent_ken_cancel", {
      paneId,
      ken: { ...ken, runId: "captured" },
    });
    invoke.mockReset();
  },
);

it.each(["primary", "auxiliary"])(
  "preserves authoritative active mentor run in %s initial state",
  async (paneId) => {
    const kenState = {
      conversationId: "conversation",
      activationEpoch: "epoch",
      activeRunId: "run",
    };
    invoke.mockResolvedValueOnce({ kenState });
    const state = await (paneId === "primary"
      ? getState()
      : createPaneAgentClient(paneId).getState());
    expect(state.kenState).toEqual(kenState);
  },
);

it.each(["primary", "auxiliary"])(
  "copies %s Ken prompt target before delayed readiness",
  async (paneId) => {
    let release!: (value: unknown) => void;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    invoke.mockImplementation(async (command) => (command === "agent_pane_status" ? ready : {}));
    const target = { conversationId: "OLD", activationEpoch: "old-epoch" };
    const pending =
      paneId === "primary"
        ? sendKenPrompt("question", target)
        : createPaneAgentClient(paneId).sendKenPrompt("question", target);
    target.conversationId = "NEW";
    target.activationEpoch = "new-epoch";
    release({ generation: 1, ready: true });
    await pending;
    expect(invoke).toHaveBeenCalledWith("agent_ken_prompt", {
      paneId,
      text: "question",
      target: { conversationId: "OLD", activationEpoch: "old-epoch" },
    });
    invoke.mockReset();
  },
);

describe("Ken model selection", () => {
  beforeEach(() => invoke.mockReset());

  it.each(["cannot switch Ken's model while running", "unknown model: missing"])(
    "rejects native HTTP errors: %s",
    async (message) => {
      invoke.mockRejectedValueOnce(message);
      await expect(switchKenModel("missing")).rejects.toEqual(message);
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    {},
    { error: "unknown model: missing" },
    { kenProvider: "openai", kenModel: "gpt", kenModelOverride: "true" },
    { kenProvider: "", kenModel: "gpt", kenModelOverride: true },
  ])("rejects malformed success bodies: %j", async (body) => {
    invoke.mockResolvedValueOnce(body);
    await expect(switchKenModel("gpt")).rejects.toThrow();
  });

  it.each(["gpt", null])("accepts pin/clear %s", async (model) => {
    const result = { kenProvider: "openai", kenModel: "gpt", kenModelOverride: model !== null };
    invoke.mockResolvedValueOnce(result);
    await expect(switchKenModel(model)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("agent_switch_ken_model", { paneId: "primary", model });
  });
});

const continuationRequest = { preparedId: "prepared-1", operationId: "operation-1" };
const continuationReceipt = {
  ...continuationRequest,
  outcome: "accepted",
  accepted: true,
  resetAttempted: true,
  destination: { conversationId: "conversation-2", sessionId: "session-2", profile: "stable" },
  acceptedMessageId: "message-1",
};

it("validates prepared authority and accepted continuation identities", () => {
  const prepared = {
    version: 1,
    preparedId: "prepared-1",
    expiresAt: 12345,
    prompt: "complete handoff",
    source: {
      conversationId: "conversation-1",
      sessionId: "session-1",
      leafId: null,
      fingerprint: "fingerprint",
    },
  };
  expect(requireContinuationHandoffResponse(prepared)).toEqual(prepared);
  expect(() =>
    requireContinuationHandoffResponse({ version: 1, prompt: "unbound text" }),
  ).toThrow();
  expect(requireContinuationCommitResponse(continuationReceipt, continuationRequest)).toEqual(
    continuationReceipt,
  );
  const event = {
    ...continuationRequest,
    destination: continuationReceipt.destination,
    acceptedMessageId: "message-1",
    prompt: prepared.prompt,
    kenSent: true,
  };
  expect(requireContinuationAcceptedEvent(event)).toEqual(event);
  expect(() => requireContinuationAcceptedEvent({ ...event, destination: {} })).toThrow();
});

it.each([
  { accepted: false },
  { accepted: null },
  { resetAttempted: false },
  { destination: undefined },
  { acceptedMessageId: undefined },
  { operationId: "wrong-operation" },
  { preparedId: "wrong-prepared" },
  { outcome: "rejected" },
  { outcome: "partial" },
  { outcome: "outcome-unknown" },
])("rejects inconsistent or mismatched continuation receipt %j", (override) => {
  expect(() =>
    requireContinuationCommitResponse({ ...continuationReceipt, ...override }, continuationRequest),
  ).toThrow();
});

it.each(["primary", "auxiliary"])("validates initial %s context eligibility", async (paneId) => {
  const readState = paneId === "primary" ? getState : createPaneAgentClient(paneId).getState;
  for (const value of [undefined, { canChange: "true" }, { canChange: false }]) {
    invoke.mockResolvedValueOnce({
      openAICodexContextProfile: "experimental",
      openAICodexContextProfileEligibility: value,
    });
    expect((await readState()).openAICodexContextProfileEligibility.canChange).toBe(false);
  }
  invoke.mockResolvedValueOnce({ openAICodexContextProfileEligibility: { canChange: true } });
  expect((await readState()).openAICodexContextProfileEligibility).toEqual({ canChange: true });
});

it("sends only the server-owned prepared ID, operation ID and selected profile to atomic commit", async () => {
  invoke.mockResolvedValueOnce(continuationReceipt);
  const request = {
    ...continuationRequest,
    prompt: "must not cross commit boundary",
    source: { fake: true },
  };
  await createPaneAgentClient("pane-atomic").commitContinuation(request);
  expect(invoke).toHaveBeenLastCalledWith("agent_commit_continuation", {
    paneId: "pane-atomic",
    request: continuationRequest,
  });
});

it.each(["x".repeat(8001), "🙂".repeat(4000) + "x", " \r\n\t "])(
  "rejects invalid raw instruction before IPC (%#. case)",
  async (instruction) => {
    const callsBefore = invoke.mock.calls.length;
    await expect(
      createPaneAgentClient("pane-boundary").prepareContinuationHandoff(instruction),
    ).rejects.toThrow(/8000/);
    expect(invoke.mock.calls).toHaveLength(callsBefore);
  },
);

it.each([
  { error: "next instruction is too long" },
  { error: "continuation_failed", message: "Session is busy. Retry preparation when idle." },
])("preserves native preparation error body %j", async (body) => {
  invoke.mockResolvedValueOnce(body);
  await expect(
    createPaneAgentClient("pane-error").prepareContinuationHandoff("Keep raw text"),
  ).rejects.toThrow(body.message ?? body.error);
});

it.each(["stable", "experimental"] as const)(
  "preserves the real rendered envelope over prepare IPC and commits only authority in %s mode",
  async (profile) => {
    const instruction =
      "  Keep café 日本語 🙂\\n literal and C:\\work\\file.ts\n\tindented line\r\n```ts\nconst value = `raw`;\n```\n  ".padEnd(
        8000,
        " ",
      );
    const prompt = renderContinuationPrompt(
      {
        currentObjective: "Continue exact-text work",
        currentStatus: ["Existing tests passed"],
        relevantDecisions: ["Keep literal escapes distinct from newlines"],
        relevantFiles: [{ path: "src/日本語.ts", relevance: "Destination code" }],
      },
      instruction,
    );
    const prepared = {
      version: 1,
      preparedId: "prepared-real",
      expiresAt: Date.now() + 60_000,
      prompt,
      source: {
        conversationId: "source-real",
        sessionId: "session-real",
        leafId: "leaf-real",
        fingerprint: "fingerprint-real",
      },
    };
    invoke.mockResolvedValueOnce(JSON.parse(JSON.stringify(prepared)));
    const pane = createPaneAgentClient("pane-real");
    const result = await pane.prepareContinuationHandoff(instruction);
    expect(invoke).toHaveBeenLastCalledWith("agent_continuation_handoff", {
      paneId: "pane-real",
      nextInstruction: instruction,
    });
    expect(result.prompt).toBe(prompt);
    expect(result.prompt.split("## Immediate next action\n")[1]).toBe(instruction);
    const request = { preparedId: result.preparedId, operationId: "operation-real", profile };
    invoke.mockResolvedValueOnce({
      ...continuationReceipt,
      ...request,
      destination: { ...continuationReceipt.destination, profile },
    });
    await pane.commitContinuation(request);
    expect(invoke).toHaveBeenLastCalledWith("agent_commit_continuation", {
      paneId: "pane-real",
      request,
    });
  },
);

it.each([
  { destination: { conversationId: "", sessionId: "session", profile: "stable" } },
  { destination: { conversationId: "conversation", sessionId: null, profile: "stable" } },
  { destination: { conversationId: "conversation", sessionId: "session", profile: "invalid" } },
  {
    destination: { conversationId: "conversation", sessionId: "session", profile: "experimental" },
  },
])(
  "rejects malformed or selected-mode-mismatched destination through commit IPC %j",
  async (override) => {
    invoke.mockResolvedValueOnce({ ...continuationReceipt, ...override });
    await expect(
      createPaneAgentClient("pane-invalid").commitContinuation({
        ...continuationRequest,
        profile: "stable",
      }),
    ).rejects.toThrow();
  },
);

const reconciliationRequest = {
  version: 3 as const,
  action: "reconcile-execution" as const,
  phaseId: "phase-1",
  expectedProjectKey: "c:/work/project",
  expectedRevision: 4,
  operationId: "reconcile-1",
  repository: {
    projectKey: "c:/work/project",
    identityHash: "a".repeat(64),
    rootCommit: "b".repeat(40),
  },
  plan: {
    planId: "plan-1",
    contentHash: "c".repeat(64),
    snapshotPath: ".gg/plans/plan-1.md",
    approvedAt: "2026-08-31T10:00:00.000Z",
    approvedRevision: 3,
    baseCommit: "b".repeat(40),
  },
  workspace: {
    version: 1 as const,
    repository: {
      projectKey: "c:/work/project",
      identityHash: "a".repeat(64),
      rootCommit: "b".repeat(40),
    },
    headCommit: "d".repeat(40),
    worktreeDigest: "e".repeat(64),
    clean: true,
  },
};

const diagnostics = {
  version: 1,
  applicationIdentity: "com.ggcoder.local-fork",
  daemonOwner: "node-sidecar",
  agentDataRoot: "C:\\agent",
  canonicalCwd: "c:/work/project",
  projectKey: "c:/work/project",
  projectNotesStore: {
    primaryPath: "C:\\agent\\project-notes\\project.json",
    backupPath: "C:\\agent\\project-notes\\project.backup.json",
  },
  logicalSessionId: "logical-current",
  currentSession: { sessionId: "session-current", sessionPath: null },
  activePhaseContext: null,
  persistedPhaseBinding: null,
  consistency: "unbound",
};

describe("pane Notes storage diagnostics", () => {
  beforeEach(() => invoke.mockReset());

  it("parses the shared daemon response through native IPC", async () => {
    invoke.mockResolvedValue(diagnostics);

    await expect(createPaneAgentClient("pane-a").getNotesDiagnostics()).resolves.toEqual(
      diagnostics,
    );
    expect(invoke).toHaveBeenCalledWith("agent_notes_diagnostics", { paneId: "pane-a" });
  });

  it("passes binding requests through native IPC and parses typed outcomes", async () => {
    const request = {
      version: 1 as const,
      action: "bind-current" as const,
      phaseId: "phase-1",
      expectedProjectKey: "c:/work/project",
      expectedRevision: 1,
      expectedPreviousSession: null,
      operationId: "operation-1",
      confirmRebind: false,
    };
    invoke.mockResolvedValue({ status: "stale-revision", revision: 2 });

    await expect(createPaneAgentClient("pane-a").bindRoadmapPhase(request)).resolves.toEqual({
      status: "stale-revision",
      revision: 2,
    });
    expect(invoke).toHaveBeenCalledWith("agent_notes_phase_binding", {
      paneId: "pane-a",
      request,
    });
  });

  it("propagates exact reconciliation success and typed denials", async () => {
    const reconciled = {
      status: "reconciled",
      revision: 5,
      phaseId: "phase-1",
      preservedStepIds: ["step-1"],
      revalidationStepIds: ["step-2"],
      revalidationEvidenceCount: 1,
      reconciledAt: "2026-08-31T10:05:00.000Z",
    };
    invoke
      .mockResolvedValueOnce(reconciled)
      .mockResolvedValueOnce({ status: "workspace-mismatch" });
    const client = createPaneAgentClient("pane-a");

    await expect(client.reconcileRoadmapPhaseExecution(reconciliationRequest)).resolves.toEqual(
      reconciled,
    );
    await expect(client.reconcileRoadmapPhaseExecution(reconciliationRequest)).resolves.toEqual({
      status: "workspace-mismatch",
    });
    expect(invoke).toHaveBeenCalledWith("agent_notes_phase_binding", {
      paneId: "pane-a",
      request: reconciliationRequest,
    });
  });
  it("rejects malformed reconciliation requests and responses", async () => {
    const client = createPaneAgentClient("pane-a");
    await expect(
      client.reconcileRoadmapPhaseExecution({
        ...reconciliationRequest,
        workspace: { ...reconciliationRequest.workspace, clean: "yes" },
      } as never),
    ).rejects.toThrow("invalid phase execution reconciliation request");
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue({ status: "workspace-mismatch", detail: "unexpected" });
    await expect(client.reconcileRoadmapPhaseExecution(reconciliationRequest)).rejects.toThrow(
      "invalid phase execution reconciliation response",
    );
  });
  it("does not expose obsolete evidence approval commands", () => {
    const client = createPaneAgentClient("pane-a");
    expect("previewManualCompletionApproval" in client).toBe(false);
    expect("commitManualCompletionApproval" in client).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects responses with unknown fields", async () => {
    invoke.mockResolvedValue({ ...diagnostics, token: "must-not-cross" });

    await expect(createPaneAgentClient("pane-a").getNotesDiagnostics()).rejects.toThrow(
      "invalid Notes diagnostics response",
    );
  });
});
