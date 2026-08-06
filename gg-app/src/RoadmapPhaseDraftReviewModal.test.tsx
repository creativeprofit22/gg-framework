// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { RoadmapPhaseDraftReviewModal } from "./RoadmapPhaseDraftReviewModal";

const draft = {
  id: "draft-1",
  projectKey: "/work",
  basedOnRevision: 12,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  summary: "Split this work into two flat delivery phases.",
  phases: [
    {
      phaseId: "phase-1",
      title: "Atomic backend creation",
      goal: "Append approved phases once without rebasing stale work.",
      doneWhen: ["Stale revisions do not write", "Duplicate approval creates once"],
      sourcePrompt: "Implement the revision-safe repository transaction.",
    },
    {
      phaseId: "phase-2",
      title: "Explicit review surface",
      goal: "Show every approved field before the user decides.",
      doneWhen: ["Titles and goals are readable", "Reject leaves Notes unchanged"],
      sourcePrompt: "Implement the explicit draft review modal.",
    },
  ],
  status: "pending" as const,
};

afterEach(cleanup);

function renderModal(overrides: Partial<Parameters<typeof RoadmapPhaseDraftReviewModal>[0]> = {}) {
  const props = {
    draft,
    open: true,
    decision: "idle" as const,
    error: null,
    announcement: "A Roadmap draft is ready for review.",
    onClose: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
  render(<RoadmapPhaseDraftReviewModal {...props} />);
  return props;
}

describe("RoadmapPhaseDraftReviewModal", () => {
  it("shows revision, titles, goals, and completion criteria before any decision", () => {
    renderModal();

    expect(screen.getByRole("dialog", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.getByText("Proposed from Project Notes revision 12")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Atomic backend creation" })).toBeTruthy();
    expect(
      screen.getByText("Append approved phases once without rebasing stale work."),
    ).toBeTruthy();
    expect(screen.getByText("Stale revisions do not write")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Explicit review surface" })).toBeTruthy();
    expect(screen.getByText("Reject leaves Notes unchanged")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create phases" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject draft" })).toBeTruthy();
  });

  it("offers exactly explicit create/reject handlers while close remains a non-decision", () => {
    const props = renderModal();

    fireEvent.click(screen.getByRole("button", { name: "Create phases" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(props.onApprove).toHaveBeenCalledOnce();
    expect(props.onReject).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("disables creation for stale proposals but keeps their content reviewable", () => {
    renderModal({ draft: { ...draft, status: "stale" } });

    expect(screen.getByRole("alert").textContent).toContain("out of date");
    expect(
      (screen.getByRole("button", { name: "Create phases" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject draft" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByText("Duplicate approval creates once")).toBeTruthy();
  });

  it("disables both decisions while one native call is pending", () => {
    renderModal({ decision: "approving" });

    expect(
      (screen.getByRole("button", { name: "Creating phases…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject draft" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
