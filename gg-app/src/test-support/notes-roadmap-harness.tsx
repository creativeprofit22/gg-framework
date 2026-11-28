import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { vi } from "vitest";
import { NotesRoadmap } from "../NotesRoadmap";
import type { NotesPhase, NotesPhaseStatus } from "../notes-types";

const NOW = "2026-07-15T12:00:00.000Z";

export function roadmapPhase(
  id: string,
  title: string,
  status: NotesPhaseStatus,
  extra: Partial<NotesPhase> = {},
): NotesPhase {
  return {
    id,
    title,
    goal: `Goal for ${title}`,
    doneWhen: ["It works"],
    order: 0,
    status,
    sourcePrompt: "",
    referenceIds: [],
    session: null,
    reminder: null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "done" || status === "cancelled" ? NOW : null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
    ...extra,
  };
}

type RoadmapProps = ComponentProps<typeof NotesRoadmap>;

export function roadmapProps(phases: NotesPhase[], overrides: Partial<RoadmapProps> = {}) {
  const committed = vi.fn().mockResolvedValue({ status: "committed" });
  const props: RoadmapProps = {
    phases: phases.map((phase, order) => ({ ...phase, order })),
    references: [],
    authorityReady: true,
    expectedRevision: 1,
    expectedProjectKey: "c:/work/project",
    onCreatePhase: vi.fn(),
    onEditPhase: vi.fn(),
    onMovePhase: vi.fn(),
    onChangePhaseStatus: vi.fn(),
    onSetPhaseStatusOverride: committed,
    onArchivePhase: vi.fn(),
    onLinkReferenceToPhase: committed,
    onUnlinkReferenceFromPhase: committed,
    onCreateReference: vi.fn(),
    onAcceptReferenceProposal: committed,
    onRejectReferenceProposal: committed,
    onResolveRoadmapBlocker: committed,
    onResumeAutomaticStatus: committed,
    onResumeAutomaticReferences: committed,
    onScheduleReminder: committed,
    onSnoozeReminder: committed,
    onDismissReminder: committed,
    onStartPhase: vi.fn().mockResolvedValue({
      status: "accepted",
      operationId: "operation-1",
      session: { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" },
      packageTokenCount: 10,
    }),
    onCancelPhase: vi.fn(),
    onResumePhase: vi.fn().mockResolvedValue(undefined),
    startUnavailableReason: null,
    actionDisabled: false,
    onActionSuccess: vi.fn(),
    onReconciliationSuccess: vi.fn(),
    ...overrides,
  };
  return props;
}

export function renderRoadmap(phases: NotesPhase[], overrides: Partial<RoadmapProps> = {}) {
  const props = roadmapProps(phases, overrides);
  const view = render(<NotesRoadmap {...props} />);
  return { props, ...view };
}
