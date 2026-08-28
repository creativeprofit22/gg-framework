import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn(async () => vi.fn()),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import { createPaneAgentClient } from "./agent";

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

  it("parses typed manual completion domain outcomes", async () => {
    invoke
      .mockResolvedValueOnce({ status: "unmet-gate", revision: 2, code: "stale-verification" })
      .mockResolvedValueOnce({ status: "nonce-expired" });
    const client = createPaneAgentClient("pane-a");

    await expect(client.previewManualCompletionApproval("phase-1", 1)).resolves.toEqual({
      status: "unmet-gate",
      revision: 2,
      code: "stale-verification",
    });
    await expect(client.commitManualCompletionApproval("nonce-1")).resolves.toEqual({
      status: "nonce-expired",
    });
  });

  it("keeps manual completion parsers as the final shape gate", async () => {
    invoke.mockResolvedValue({ status: "nonce-expired", detail: "unexpected" });

    await expect(
      createPaneAgentClient("pane-a").commitManualCompletionApproval("nonce-1"),
    ).rejects.toThrow("invalid manual completion approval commit response");
  });

  it("rejects responses with unknown fields", async () => {
    invoke.mockResolvedValue({ ...diagnostics, token: "must-not-cross" });

    await expect(createPaneAgentClient("pane-a").getNotesDiagnostics()).rejects.toThrow(
      "invalid Notes diagnostics response",
    );
  });
});
