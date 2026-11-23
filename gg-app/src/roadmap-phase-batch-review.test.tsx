// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RoadmapPhaseEditBatchDraft,
  RoadmapPhaseMoveBatchDraft,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { RoadmapPhaseDraftReviewModal } from "./RoadmapPhaseDraftReviewModal";
import {
  describeRoadmapDraft,
  initialRoadmapPhaseDraftState,
  normalizeRoadmapPhaseDraft,
  reduceRoadmapPhaseDraftState,
} from "./roadmap-phase-draft-state";

vi.mock("./notes-open-source", () => ({ openReferenceUrl: vi.fn(async () => undefined) }));

afterEach(cleanup);

const orderEntries = (ids: string[]) => ids.map((id) => ({ phaseId: id, title: `Phase ${id}` }));

const editBatch: RoadmapPhaseEditBatchDraft = {
  kind: "edit-batch",
  id: "batch-1",
  projectKey: "/work",
  basedOnRevision: 9,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  summary: "Tighten the first and third phases.",
  edits: [
    {
      phaseId: "a",
      phaseTitle: "Phase a",
      basedOnUpdatedAt: "2026-08-05T11:00:00.000Z",
      changes: [{ field: "title", before: "Phase a", after: "Phase A" }],
    },
    {
      phaseId: "c",
      phaseTitle: "Phase c",
      basedOnUpdatedAt: "2026-08-05T11:00:00.000Z",
      changes: [
        { field: "goal", before: "Old goal", after: "Sharper goal" },
        { field: "doneWhen", before: ["Tests pass"], after: ["Tests pass", "Docs updated"] },
      ],
    },
  ],
  status: "pending",
};

const moveBatch: RoadmapPhaseMoveBatchDraft = {
  kind: "move-batch",
  id: "moves-1",
  projectKey: "/work",
  basedOnRevision: 9,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  summary: "Do d and c first.",
  moves: [
    {
      phaseId: "d",
      phaseTitle: "Phase d",
      position: "before",
      targetPhaseId: "a",
      targetPhaseTitle: "Phase a",
    },
    {
      phaseId: "c",
      phaseTitle: "Phase c",
      position: "after",
      targetPhaseId: "d",
      targetPhaseTitle: "Phase d",
    },
  ],
  orderPreview: {
    before: orderEntries(["a", "b", "c", "d"]),
    after: orderEntries(["d", "c", "a", "b"]),
  },
  status: "pending",
};

function renderModal(draft: RoadmapPhaseEditBatchDraft | RoadmapPhaseMoveBatchDraft) {
  const props = {
    draft,
    open: true,
    decision: "idle" as const,
    error: null,
    announcement: "",
    onApprove: vi.fn(),
    onReject: vi.fn(),
  };
  render(<RoadmapPhaseDraftReviewModal {...props} />);
  return props;
}

function listedTitles(region: HTMLElement, label: "Before" | "After"): string[] {
  const box = within(region).getByText(label).parentElement;
  if (!box) throw new Error(`missing ${label} list`);
  return within(box)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("span")?.textContent ?? "");
}

describe("Roadmap edit batch review", () => {
  it("shows every phase's changed fields with one apply and one reject", () => {
    const props = renderModal(editBatch);
    const review = screen.getByRole("region", { name: "Review Roadmap phase edits" });
    expect(within(review).getByText(/Edits proposed from Project Notes revision 9/)).toBeTruthy();
    expect(within(review).getByText(/2 phases · 3 changed fields/)).toBeTruthy();
    expect(within(review).getByText(/Applied together or not at all/)).toBeTruthy();
    expect(within(review).getByRole("heading", { name: "Phase a" })).toBeTruthy();
    expect(within(review).getByRole("heading", { name: "Phase c" })).toBeTruthy();
    const third = within(review).getByRole("list", { name: "Changed fields in Phase c" });
    expect(within(third).getByText("Sharper goal")).toBeTruthy();
    expect(within(third).getByText("Added")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply 2 edits" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject edits" }));
    expect(props.onApprove).toHaveBeenCalledOnce();
    expect(props.onReject).toHaveBeenCalledOnce();
  });

  it("keeps a stale batch reviewable and rejectable but not applicable", () => {
    renderModal({ ...editBatch, status: "stale" });
    expect(screen.getByRole("alert").textContent).toContain("These edits are out of date.");
    expect(
      (screen.getByRole("button", { name: "Apply 2 edits" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject edits" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("Roadmap move batch review", () => {
  it("lists the steps in order above one before/after order tagging every moved phase", () => {
    const props = renderModal(moveBatch);
    const review = screen.getByRole("region", { name: "Review Roadmap phase moves" });
    const steps = within(review)
      .getByRole("heading", { name: "Moves, in order" })
      .parentElement!.querySelectorAll(".roadmap-move-steps li");
    expect([...steps].map((step) => step.textContent)).toEqual([
      "Phase d moves before Phase a",
      "Phase c moves after Phase d",
    ]);
    const order = within(review).getByRole("region", { name: "Roadmap order" });
    expect(listedTitles(order, "Before")).toEqual(["Phase a", "Phase b", "Phase c", "Phase d"]);
    expect(listedTitles(order, "After")).toEqual(["Phase d", "Phase c", "Phase a", "Phase b"]);
    expect(within(order).getAllByText("Moved")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Move 2 phases" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject moves" }));
    expect(props.onApprove).toHaveBeenCalledOnce();
    expect(props.onReject).toHaveBeenCalledOnce();
  });

  it("disables moving a stale batch", () => {
    renderModal({ ...moveBatch, status: "stale" });
    expect(screen.getByRole("alert").textContent).toContain("These moves are out of date.");
    expect(
      (screen.getByRole("button", { name: "Move 2 phases" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("Roadmap batch draft state", () => {
  it("passes valid batches through, rejects malformed ones, and describes them", () => {
    expect(normalizeRoadmapPhaseDraft(editBatch)).toEqual(editBatch);
    expect(normalizeRoadmapPhaseDraft(moveBatch)).toEqual(moveBatch);
    expect(normalizeRoadmapPhaseDraft({ ...editBatch, edits: [editBatch.edits[0]] })).toBeNull();
    expect(normalizeRoadmapPhaseDraft({ ...moveBatch, kind: "moves" })).toBeNull();
    expect(describeRoadmapDraft(editBatch)).toEqual({
      label: "Roadmap phase edits",
      summary: "2 phases · 3 changed fields · Approval required",
      triggerLabel: "Review Roadmap edits to 2 phases",
      count: 2,
    });
    expect(describeRoadmapDraft({ ...moveBatch, status: "stale" })).toEqual({
      label: "Roadmap phase moves",
      summary: "Move 2 phases · Out of date",
      triggerLabel: "Review Roadmap moves for 2 phases",
      count: 2,
    });
  });

  it("announces ready, applied, stale and rejected batches in plural words", () => {
    const edits = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft: editBatch,
    });
    expect(edits.announcement).toBe("Roadmap edits to 2 phases are ready for review.");
    expect(
      reduceRoadmapPhaseDraftState(edits, {
        type: "approval-result",
        result: { status: "edited", revision: 10, phaseId: "a", phaseIds: ["a", "c"] },
      }),
    ).toMatchObject({ draft: null, open: false, announcement: "Updated 2 Roadmap phases." });
    const changed = reduceRoadmapPhaseDraftState(edits, {
      type: "approval-result",
      result: { status: "phase-changed", phaseId: "c" },
    });
    expect(changed).toMatchObject({ draft: { kind: "edit-batch", status: "stale" } });
    expect(changed.announcement).toBe(
      "Phase c changed after these edits were proposed. Nothing was saved. Ask GG Coder for fresh edits.",
    );
    expect(
      reduceRoadmapPhaseDraftState(edits, {
        type: "approval-result",
        result: { status: "phase-not-editable", phaseId: "a", reason: "done" },
      }).announcement,
    ).toBe("Phase a is now Done, so these edits cannot be applied. Nothing was saved.");
    expect(
      reduceRoadmapPhaseDraftState(edits, {
        type: "rejection-result",
        result: { status: "rejected" },
      }).announcement,
    ).toBe("Roadmap phase edits rejected.");

    const moves = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft: moveBatch,
    });
    expect(moves.announcement).toBe("Roadmap moves for 2 phases are ready for review.");
    expect(
      reduceRoadmapPhaseDraftState(moves, {
        type: "approval-result",
        result: { status: "moved", revision: 10, phaseId: "d", phaseIds: ["d", "c"] },
      }).announcement,
    ).toBe("Moved 2 Roadmap phases.");
    expect(
      reduceRoadmapPhaseDraftState(moves, {
        type: "approval-result",
        result: { status: "stale-revision", expectedRevision: 9, currentRevision: 11 },
      }).announcement,
    ).toBe(
      "These moves are based on revision 9; Project Notes is now revision 11. Nothing was saved. Ask GG Coder for fresh moves.",
    );
    expect(
      reduceRoadmapPhaseDraftState(moves, {
        type: "rejection-result",
        result: { status: "already-decided", decision: "approved" },
      }).announcement,
    ).toBe("These Roadmap phase moves were already applied.");
  });
});
