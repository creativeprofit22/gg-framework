// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  sourcesNotCited: null,
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

  it("shows why the drafter cited none of the sources it researched", () => {
    renderModal({
      draft: {
        ...draft,
        sourcesNotCited: "Corpus results only confirmed the local design.",
      },
    });

    expect(screen.getByText(/2 peer phases · 0 references/)).toBeTruthy();
    const reason = screen.getByText("Corpus results only confirmed the local design.", {
      exact: false,
    });
    expect(reason.textContent).toBe(
      "No sources cited: Corpus results only confirmed the local design.",
    );
  });

  it("shows no uncited-sources note when the drafter gave no reason", () => {
    renderModal();
    expect(screen.queryByText(/No sources cited/)).toBeNull();
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

const editDraft = {
  kind: "edit" as const,
  id: "draft-edit-1",
  projectKey: "/work",
  basedOnRevision: 14,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  summary: "Tighten the approval phase criteria.",
  phaseId: "phase-approval",
  phaseTitle: "Approval UI",
  basedOnUpdatedAt: "2026-08-04T12:00:00.000Z",
  changes: [
    { field: "goal" as const, before: "", after: "Require an explicit decision." },
    {
      field: "doneWhen" as const,
      before: ["Reject leaves Notes unchanged", "Looks fine"],
      after: ["Reject leaves Notes unchanged", "Stale edits cannot apply"],
    },
  ],
  status: "pending" as const,
};

describe("RoadmapPhaseDraftReviewModal phase edits", () => {
  it("shows only the changed fields as labelled before and after values", () => {
    renderModal({ draft: editDraft, announcement: "A Roadmap phase edit is ready for review." });

    expect(screen.getByRole("region", { name: "Review Roadmap phase edit" })).toBeTruthy();
    expect(screen.getByText("Edit proposed from Project Notes revision 14")).toBeTruthy();
    expect(
      screen.getByText(/1 phase · 2 changed fields · Nothing changes until you approve/),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Approval UI" })).toBeTruthy();

    const fields = within(screen.getByRole("list", { name: "Changed fields" }))
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(fields).toEqual(["Goal", "Done when"]);
    expect(screen.queryByRole("heading", { name: "Title" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Saved phase prompt" })).toBeNull();

    expect(screen.getAllByText("Before")).toHaveLength(2);
    expect(screen.getAllByText("After")).toHaveLength(2);
    expect(screen.getByText("Empty")).toBeTruthy();
    expect(screen.getByText("Require an explicit decision.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
  });

  it("tags removed and added completion criteria in text, not only colour", () => {
    renderModal({ draft: editDraft });

    const removed = screen.getByText("Looks fine").closest("li");
    const added = screen.getByText("Stale edits cannot apply").closest("li");
    expect(removed?.textContent).toContain("Removed");
    expect(added?.textContent).toContain("Added");
    for (const kept of screen.getAllByText("Reject leaves Notes unchanged")) {
      const item = kept.closest("li");
      expect(item?.textContent).not.toContain("Removed");
      expect(item?.textContent).not.toContain("Added");
    }
  });

  it("offers explicit apply and reject handlers", () => {
    const props = renderModal({ draft: editDraft });

    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject edit" }));

    expect(props.onApprove).toHaveBeenCalledOnce();
    expect(props.onReject).toHaveBeenCalledOnce();
  });

  it("disables applying a stale edit but keeps it reviewable and rejectable", () => {
    renderModal({ draft: { ...editDraft, status: "stale" } });

    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("This edit is out of date.");
    expect(alert).toContain("Nothing was saved.");
    expect((screen.getByRole("button", { name: "Apply edit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Reject edit" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByText("Stale edits cannot apply")).toBeTruthy();
  });

  it("disables both decisions while one native call is pending", () => {
    renderModal({ draft: editDraft, decision: "approving" });

    expect(
      (screen.getByRole("button", { name: "Applying edit…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reject edit" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
