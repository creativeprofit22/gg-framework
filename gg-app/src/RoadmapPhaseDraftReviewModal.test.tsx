// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { RoadmapPhaseDraftReviewModal } from "./RoadmapPhaseDraftReviewModal";
import { openReferenceUrl } from "./notes-open-source";

vi.mock("./notes-open-source", () => ({ openReferenceUrl: vi.fn(async () => undefined) }));

const draft = {
  id: "draft-1",
  projectKey: "/work",
  basedOnRevision: 12,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  summary: "Split this work into two flat delivery phases.",
  references: [],
  phases: [
    {
      phaseId: "phase-1",
      title: "Atomic backend creation",
      goal: "Append approved phases once without rebasing stale work.",
      doneWhen: ["Stale revisions do not write", "Duplicate approval creates once"],
      sourcePrompt: "Implement the revision-safe repository transaction.",
      referenceIds: [],
    },
    {
      phaseId: "phase-2",
      title: "Explicit review surface",
      goal: "Show every approved field before the user decides.",
      doneWhen: ["Titles and goals are readable", "Reject leaves Notes unchanged"],
      sourcePrompt: "Implement the explicit draft review modal.",
      referenceIds: [],
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

    expect(screen.getByRole("region", { name: "Review Roadmap draft" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".modal-backdrop, [aria-modal]")).toBeNull();
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
    const scroller = screen.getByRole("region", { name: "Roadmap draft content" });
    expect(scroller.tabIndex).toBe(0);
    expect(
      scroller.contains(screen.getByRole("heading", { name: "Atomic backend creation" })),
    ).toBe(true);
    expect(scroller.contains(screen.getByRole("button", { name: "Create phases" }))).toBe(false);
    expect(scroller.contains(screen.getByRole("button", { name: "Reject draft" }))).toBe(false);
  });

  it("shows linked reference details and opens the reviewed canonical source", () => {
    const reference = {
      id: "reference-1",
      provider: "github",
      tool: "searchCode",
      canonicalUrl: "https://github.com/KenKaiiii/gg-framework",
      owner: "KenKaiiii",
      repo: "gg-framework",
      revision: "main",
      path: "packages/gg-core/src/roadmap-workflow.ts",
      range: { startLine: 12, endLine: 24 },
      issue: null,
      pullRequest: null,
      query: null,
      anchor: null,
      relevance: "Defines the shared draft contract.",
    };
    renderModal({
      draft: {
        ...draft,
        references: [reference],
        phases: [
          { ...draft.phases[0], referenceIds: [reference.id] },
          { ...draft.phases[1], referenceIds: [] },
        ],
      },
    });

    expect(screen.getByText(/2 peer phases · 1 reference/)).toBeTruthy();
    expect(screen.getByText("KenKaiiii/gg-framework")).toBeTruthy();
    expect(screen.getByText("packages/gg-core/src/roadmap-workflow.ts:12-24")).toBeTruthy();
    expect(screen.getByText("Defines the shared draft contract.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(openReferenceUrl).toHaveBeenCalledWith(reference.canonicalUrl);
    expect(screen.getByRole("button", { name: "Create phases with references" })).toBeTruthy();
  });

  it("disables approval when a phase points to an unavailable source", () => {
    renderModal({
      draft: {
        ...draft,
        phases: [{ ...draft.phases[0], referenceIds: ["missing"] }, draft.phases[1]],
      },
    });
    expect(screen.getByRole("alert").textContent).toContain("sources are unavailable");
    expect(screen.getByText("Source details unavailable")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Create phases" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("offers explicit create/reject handlers and leaves collapse to the dock", () => {
    const props = renderModal();

    fireEvent.click(screen.getByRole("button", { name: "Create phases" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    expect(props.onApprove).toHaveBeenCalledOnce();
    expect(props.onReject).toHaveBeenCalledOnce();
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
