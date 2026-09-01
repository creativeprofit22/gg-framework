// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotesPhase, PhaseLeaseOutcome, ProjectNotesStorageDiagnostics } from "../notes-types";
import { ManualCompletionApprovalControl, PhaseRebindControl } from "./NotesPhaseOverviewView";

const previousSession = { sessionId: "session-a", sessionPath: "C:\\sessions\\a.jsonl" };
const phase: NotesPhase = {
  id: "phase-1",
  title: "Transfer phase",
  goal: "Move authority",
  doneWhen: ["Session B owns the phase"],
  order: 0,
  status: "in-progress",
  sourcePrompt: "",
  referenceIds: [],
  session: previousSession,
  reminder: null,
  attentionReason: null,
  createdAt: "2026-07-25T12:34:00.000Z",
  updatedAt: "2026-07-25T12:34:00.000Z",
  completedAt: null,
  archivedAt: null,
  overrides: { status: null, referenceIds: null },
  pendingAutomaticLifecycleTransition: null,
  lifecycleEvents: [],
  roadmapEvents: [],
};
const diagnostics: ProjectNotesStorageDiagnostics = {
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
  logicalSessionId: "logical-b",
  currentSession: { sessionId: "session-b", sessionPath: "C:\\sessions\\b.jsonl" },
  activePhaseContext: null,
  persistedPhaseBinding: {
    phaseId: "phase-1",
    projectKey: "c:/work/project",
    session: previousSession,
  },
  consistency: "bound-to-other-session",
};

afterEach(cleanup);

describe("manual completion approval", () => {
  const reviewPhase = { ...phase, status: "review" as const };
  const checkpoint = {
    nonce: "nonce-1",
    projectKey: "c:/work/project",
    phaseId: "phase-1",
    revision: 7,
    session: previousSession,
    implementationCheckpointId: "implementation-1",
    verificationStatusUpdateId: "verification-1",
    expiresAt: "2026-08-27T21:30:00.000Z",
  };

  it("shows current evidence for active phases before explicit confirmation", async () => {
    const onCommit = vi.fn(async () => ({
      status: "committed" as const,
      revision: 8,
      phaseId: "phase-1",
      approvalId: "approval-1",
    }));
    const onSuccess = vi.fn();
    render(
      <ManualCompletionApprovalControl
        phase={phase}
        expectedRevision={7}
        onPreview={async () => ({ status: "ready", checkpoint })}
        onCommit={onCommit}
        onSuccess={onSuccess}
      />,
    );

    expect(
      screen.getByText(
        "Current passed verification or an explicit current exception request may be approved after successful implementation.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review completion evidence" }));
    expect(await screen.findByText("implementation-1")).toBeTruthy();
    expect(screen.getByText("verification-1")).toBeTruthy();
    expect(
      screen.getByText(
        "Confirming marks this phase Done. Any Notes change requires a fresh preview.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm completion" }));

    expect(onCommit).toHaveBeenCalledWith("nonce-1");
    expect(await screen.findByText("Completion approved from current evidence.")).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("moves focus into the confirmation and restores it when cancelled", async () => {
    render(
      <ManualCompletionApprovalControl
        phase={reviewPhase}
        expectedRevision={7}
        onPreview={async () => ({ status: "ready", checkpoint })}
        onCommit={async () => ({ status: "nonce-not-found" })}
        onSuccess={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Review completion evidence" });
    trigger.focus();
    fireEvent.click(trigger);

    const confirm = await screen.findByRole("button", { name: "Confirm completion" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Review completion evidence" }),
    );
  });

  it("refreshes typed stale results and explains non-current gates", async () => {
    const onStale = vi.fn();
    render(
      <ManualCompletionApprovalControl
        phase={reviewPhase}
        expectedRevision={7}
        onPreview={async () => ({ status: "stale-revision", revision: 8 })}
        onCommit={async () => ({ status: "nonce-not-found" })}
        onSuccess={onStale}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review completion evidence" }));
    expect(
      await screen.findByText("Notes changed. Refresh and review the current evidence again."),
    ).toBeTruthy();
    expect(onStale).toHaveBeenCalledOnce();

    cleanup();
    render(
      <ManualCompletionApprovalControl
        phase={reviewPhase}
        expectedRevision={8}
        onPreview={async () => ({
          status: "unmet-gate",
          revision: 8,
          code: "verification-exception",
        })}
        onCommit={async () => ({ status: "nonce-not-found" })}
        onSuccess={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review completion evidence" }));
    expect(
      await screen.findByText("The verification exception request is no longer current."),
    ).toBeTruthy();

    cleanup();
    render(
      <ManualCompletionApprovalControl
        phase={reviewPhase}
        expectedRevision={8}
        onPreview={async () => ({ status: "unmet-gate", revision: 8, code: "inactive-phase" })}
        onCommit={async () => ({ status: "nonce-not-found" })}
        onSuccess={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review completion evidence" }));
    expect(
      await screen.findByText("The phase must be active before completion can be approved."),
    ).toBeTruthy();
  });

  it("shows typed nonce expiry and refreshes a stale commit", async () => {
    const onSuccess = vi.fn();
    const onCommit = vi
      .fn()
      .mockResolvedValueOnce({ status: "nonce-expired" })
      .mockResolvedValueOnce({ status: "stale-revision", revision: 8 });
    const renderControl = () =>
      render(
        <ManualCompletionApprovalControl
          phase={reviewPhase}
          expectedRevision={7}
          onPreview={async () => ({ status: "ready", checkpoint })}
          onCommit={onCommit}
          onSuccess={onSuccess}
        />,
      );

    renderControl();
    fireEvent.click(screen.getByRole("button", { name: "Review completion evidence" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm completion" }));
    expect(
      await screen.findByText("The approval preview expired. Review the current evidence again."),
    ).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();

    cleanup();
    renderControl();
    fireEvent.click(screen.getByRole("button", { name: "Review completion evidence" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm completion" }));
    expect(
      await screen.findByText("Notes changed. Refresh and review the current evidence again."),
    ).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});

describe("phase rebind confirmation", () => {
  it("acquires an unheld writer lease using the inspected destination", async () => {
    const onMutateLease = vi
      .fn()
      .mockResolvedValueOnce({
        status: "inspected",
        roadmapRevision: 7,
        leaseRevision: 0,
        phaseId: phase.id,
        lease: null,
      })
      .mockResolvedValueOnce({
        status: "acquired",
        roadmapRevision: 7,
        leaseRevision: 1,
        phaseId: phase.id,
        lease: null,
      })
      .mockResolvedValueOnce({
        status: "inspected",
        roadmapRevision: 7,
        leaseRevision: 1,
        phaseId: phase.id,
        lease: null,
      });
    const onSuccess = vi.fn();
    render(
      <PhaseRebindControl
        phase={phase}
        expectedRevision={7}
        onInspect={async () => diagnostics}
        onRebind={async () => ({ status: "missing" })}
        onMutateLease={onMutateLease}
        onSuccess={onSuccess}
        idFactory={() => "operation-1"}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase writer" }));
    expect(await screen.findByText("session-a")).toBeTruthy();
    expect(screen.getByText("session-b")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm safe takeover" }));

    expect(onMutateLease).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "acquire",
        expectedProjectKey: diagnostics.projectKey,
        confirmTakeover: false,
      }),
    );
    expect(await screen.findByText("Phase writer lease moved to this session.")).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("shows lease holder expiry and requires explicit safe takeover", async () => {
    const lease = {
      version: 1 as const,
      projectKey: diagnostics.projectKey,
      phaseId: phase.id,
      planId: null,
      leaseId: "lease-1",
      fence: 4,
      holder: {
        daemonInstanceId: "daemon-a",
        sessionId: "session-a",
        sessionPath: previousSession.sessionPath,
        processId: 42,
      },
      runState: "idle" as const,
      acquiredAt: "2026-08-30T10:00:00.000Z",
      renewedAt: "2026-08-30T10:00:30.000Z",
      expiresAt: "2026-08-30T10:02:30.000Z",
      operationId: "acquire-1",
    };
    const acquiredLease = {
      ...lease,
      fence: 5,
      holder: {
        ...lease.holder,
        daemonInstanceId: "daemon-b",
        sessionId: "session-b",
        sessionPath: diagnostics.currentSession.sessionPath,
      },
      expiresAt: "2027-08-30T10:02:30.000Z",
    };
    const onMutateLease = vi
      .fn()
      .mockResolvedValueOnce({
        status: "inspected",
        roadmapRevision: 7,
        leaseRevision: 1,
        phaseId: phase.id,
        lease,
      })
      .mockResolvedValueOnce({
        status: "acquired",
        roadmapRevision: 7,
        leaseRevision: 2,
        phaseId: phase.id,
        lease: acquiredLease,
      });
    render(
      <PhaseRebindControl
        phase={phase}
        expectedRevision={7}
        onInspect={async () => diagnostics}
        onRebind={async () => ({ status: "missing" })}
        onMutateLease={onMutateLease}
        onSuccess={vi.fn()}
        idFactory={() => "operation-lease"}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase writer" }));
    expect(await screen.findByText(/Current writer: session-a.*state idle/)).toBeTruthy();
    const takeoverButton = screen.getByRole("button", { name: "Confirm safe takeover" });
    expect(takeoverButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(takeoverButton);

    expect(onMutateLease.mock.calls[1]![0]).toMatchObject({
      action: "takeover",
      lease: { leaseId: "lease-1", fence: 4 },
      confirmTakeover: true,
    });
    expect(await screen.findByText("Phase writer lease moved to this session.")).toBeTruthy();
    expect(
      screen.getByText(/Current writer: session-b · fence 5 · state idle · expires .*2027/),
    ).toBeTruthy();
    expect(screen.queryByText(/Current writer: session-a/)).toBeNull();
  });

  it("re-inspects a nullable duplicate before showing the successful lease", async () => {
    const oldLease = {
      version: 1 as const,
      projectKey: diagnostics.projectKey,
      phaseId: phase.id,
      planId: null,
      leaseId: "lease-1",
      fence: 4,
      holder: {
        daemonInstanceId: "daemon-a",
        sessionId: "session-a",
        sessionPath: previousSession.sessionPath,
        processId: 42,
      },
      runState: "idle" as const,
      acquiredAt: "2026-08-30T10:00:00.000Z",
      renewedAt: "2026-08-30T10:00:30.000Z",
      expiresAt: "2026-08-30T10:02:30.000Z",
      operationId: "acquire-1",
    };
    const currentLease = {
      ...oldLease,
      fence: 6,
      holder: {
        ...oldLease.holder,
        daemonInstanceId: "daemon-b",
        sessionId: "session-b",
        sessionPath: diagnostics.currentSession.sessionPath,
      },
      expiresAt: "2027-08-30T10:04:30.000Z",
    };
    const onSuccess = vi.fn();
    const onMutateLease = vi
      .fn()
      .mockResolvedValueOnce({
        status: "inspected",
        roadmapRevision: 7,
        leaseRevision: 1,
        phaseId: phase.id,
        lease: oldLease,
      })
      .mockResolvedValueOnce({
        status: "duplicate",
        roadmapRevision: 7,
        leaseRevision: 2,
        phaseId: phase.id,
        lease: null,
      })
      .mockResolvedValueOnce({
        status: "inspected",
        roadmapRevision: 7,
        leaseRevision: 2,
        phaseId: phase.id,
        lease: currentLease,
      });
    render(
      <PhaseRebindControl
        phase={phase}
        expectedRevision={7}
        onInspect={async () => diagnostics}
        onRebind={async () => ({ status: "missing" })}
        onMutateLease={onMutateLease}
        onSuccess={onSuccess}
        idFactory={() => "operation-lease"}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase writer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm safe takeover" }));

    expect(
      await screen.findByText(/Current writer: session-b · fence 6 · state idle · expires .*2027/),
    ).toBeTruthy();
    expect(onMutateLease).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ action: "inspect", lease: null, confirmTakeover: false }),
    );
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("disables takeover while the current writer is running", async () => {
    const onMutateLease = vi.fn(
      async (): Promise<PhaseLeaseOutcome> => ({
        status: "inspected",
        roadmapRevision: 7,
        leaseRevision: 1,
        phaseId: phase.id,
        lease: {
          version: 1,
          projectKey: diagnostics.projectKey,
          phaseId: phase.id,
          planId: null,
          leaseId: "lease-1",
          fence: 4,
          holder: {
            daemonInstanceId: "daemon-a",
            sessionId: "session-a",
            sessionPath: previousSession.sessionPath,
            processId: 42,
          },
          runState: "running",
          acquiredAt: "2026-08-30T10:00:00.000Z",
          renewedAt: "2026-08-30T10:00:30.000Z",
          expiresAt: "2026-08-30T10:02:30.000Z",
          operationId: "acquire-1",
        },
      }),
    );
    render(
      <PhaseRebindControl
        phase={phase}
        expectedRevision={7}
        onInspect={async () => diagnostics}
        onRebind={async () => ({ status: "missing" })}
        onMutateLease={onMutateLease}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase writer" }));

    expect(await screen.findByText(/Current writer: session-a.*state running/)).toBeTruthy();
    expect(
      screen.getByText("Stop the current run and wait for it to settle before taking over."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm safe takeover" }));
    expect(onMutateLease).toHaveBeenCalledOnce();
  });

  it.each<[PhaseLeaseOutcome, string]>([
    [{ status: "phase-not-found" }, "This phase no longer exists. Refresh Notes."],
    [
      { status: "project-mismatch", roadmapRevision: 7, currentProjectKey: "other-project" },
      "This pane is using a different project store. Reopen the correct project.",
    ],
    [
      { status: "operation-conflict", roadmapRevision: 7, leaseRevision: 1 },
      "This writer operation conflicts with an earlier request. Refresh and inspect again.",
    ],
    [
      { status: "corrupt", primary: "malformed-json", backup: null },
      "Project Notes are corrupt. Restore a valid Notes file before retrying.",
    ],
    [{ status: "missing" }, "Project Notes are missing. Restore or recreate them before retrying."],
  ])("maps $status to a safe action", async (outcome, expectedMessage) => {
    render(
      <PhaseRebindControl
        phase={phase}
        expectedRevision={7}
        onInspect={async () => diagnostics}
        onRebind={async () => ({ status: "missing" })}
        onMutateLease={async () => outcome}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase writer" }));

    expect(await screen.findByText(expectedMessage)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm safe takeover" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm rebind" })).toBeNull();
  });

  it("requires refresh after a typed stale revision", async () => {
    const onMutateLease = vi
      .fn()
      .mockResolvedValueOnce({
        status: "inspected",
        roadmapRevision: 7,
        leaseRevision: 0,
        phaseId: phase.id,
        lease: null,
      })
      .mockResolvedValueOnce({
        status: "stale-revision",
        roadmapRevision: 8,
        leaseRevision: 1,
      });
    render(
      <PhaseRebindControl
        phase={phase}
        expectedRevision={7}
        onInspect={async () => diagnostics}
        onRebind={async () => ({ status: "missing" })}
        onMutateLease={onMutateLease}
        onSuccess={vi.fn()}
        idFactory={() => "operation-1"}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect phase writer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm safe takeover" }));

    expect(
      await screen.findByText("Notes changed. Refresh the phase before retrying."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Inspect phase writer" })).toBeTruthy();
  });
});
