// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NotesPhase,
  PhaseBindingOutcome,
  PhaseBindingRequest,
  ProjectNotesStorageDiagnostics,
} from "../notes-types";
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
    finalReviewId: "review-1",
    expiresAt: "2026-08-27T21:30:00.000Z",
  };

  it("shows current evidence before explicit confirmation", async () => {
    const onCommit = vi.fn(async () => ({
      status: "committed" as const,
      revision: 8,
      phaseId: "phase-1",
      approvalId: "approval-1",
    }));
    const onSuccess = vi.fn();
    render(
      <ManualCompletionApprovalControl
        phase={reviewPhase}
        expectedRevision={7}
        onPreview={async () => ({ status: "ready", checkpoint })}
        onCommit={onCommit}
        onSuccess={onSuccess}
      />,
    );

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

  it("refreshes typed stale results and offers no exception bypass", async () => {
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
      await screen.findByText("Manual approval cannot accept a verification exception."),
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
      await screen.findByText("The phase must be in Review before completion can be approved."),
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
  it("shows both session identities and derives the destination from diagnostics", async () => {
    const onRebind = vi.fn(
      async (_request: PhaseBindingRequest): Promise<PhaseBindingOutcome> => ({
        status: "committed",
        revision: 8,
        phaseId: "phase-1",
        previousSession,
        session: diagnostics.currentSession,
      }),
    );
    const onSuccess = vi.fn();
    render(
      <PhaseRebindControl
        phase={phase}
        expectedRevision={7}
        onInspect={async () => diagnostics}
        onRebind={onRebind}
        onSuccess={onSuccess}
        idFactory={() => "operation-1"}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rebind to this session" }));
    expect(await screen.findByText("session-a")).toBeTruthy();
    expect(screen.getByText("session-b")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm rebind" }));

    expect(onRebind).toHaveBeenCalledWith({
      version: 1,
      action: "rebind-current",
      phaseId: "phase-1",
      expectedProjectKey: "c:/work/project",
      expectedRevision: 7,
      expectedPreviousSession: previousSession,
      operationId: "operation-1",
      confirmRebind: true,
    });
    expect(JSON.stringify(onRebind.mock.calls[0]![0])).not.toContain("destination");
    expect(await screen.findByText("Phase authority moved to this session.")).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("requires refresh after a typed stale revision", async () => {
    render(
      <PhaseRebindControl
        phase={phase}
        expectedRevision={7}
        onInspect={async () => diagnostics}
        onRebind={async () => ({ status: "stale-revision", revision: 8 })}
        onSuccess={vi.fn()}
        idFactory={() => "operation-1"}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rebind to this session" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm rebind" }));

    expect(
      await screen.findByText(
        "Notes changed. Refresh diagnostics and confirm the current revision again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rebind to this session" })).toBeTruthy();
  });
});
