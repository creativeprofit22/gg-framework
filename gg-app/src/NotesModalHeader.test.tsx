// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Modal } from "./Modal";
import { notesModalDescription } from "./NotesModalHeader";
import type { NotesPhase, NotesPhaseStatus } from "./notes-types";

const NOW = "2026-10-18T12:00:00.000Z";

function phase(id: string, status: NotesPhaseStatus): NotesPhase {
  return {
    id,
    title: `Phase ${id}`,
    goal: "Header progress",
    doneWhen: ["Counted once"],
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
  };
}

function renderHeader(projectPath: string | null, phases: NotesPhase[]): HTMLElement {
  render(
    <Modal
      title="Your notes"
      description={notesModalDescription(projectPath, phases)}
      onClose={() => {}}
    >
      <p>Body</p>
    </Modal>,
  );
  return screen.getByRole("dialog", { name: "Your notes" });
}

function description(dialog: HTMLElement): string {
  const id = dialog.getAttribute("aria-describedby");
  if (!id) throw new Error("Dialog has no description");
  return document.getElementById(id)?.textContent ?? "";
}

afterEach(cleanup);

describe("notesModalDescription", () => {
  it("shows the project folder and shared Roadmap progress under the title", () => {
    const dialog = renderHeader("/work/gg-framework", [
      phase("a", "done"),
      phase("b", "in-progress"),
      phase("c", "cancelled"),
    ]);
    expect(description(dialog)).toBe("Project: gg-framework · 1 of 2 phases done");
    expect(screen.getByText("gg-framework").getAttribute("title")).toBe("/work/gg-framework");
    expect(screen.getByText("·", { exact: false }).getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("heading", { name: "Your notes" })).toBeTruthy();
  });

  it("omits progress when no phase counts toward it", () => {
    const dialog = renderHeader("/work/empty", []);
    expect(description(dialog)).toBe("Project: empty");
    expect(screen.queryByText("·", { exact: false })).toBeNull();
  });

  it("shows progress alone without a project and falls back to the plain header with neither", () => {
    const dialog = renderHeader(null, [phase("a", "done")]);
    expect(description(dialog)).toBe("1 of 1 phase done");
    cleanup();
    const bare = renderHeader(null, []);
    expect(bare.hasAttribute("aria-describedby")).toBe(false);
    expect(bare.querySelector(".modal-head-text")).toBeNull();
  });

  it("keeps a long unbroken project name whole in the text, description and tooltip", () => {
    const name = "an-extremely-long-project-folder-name-without-any-spaces-that-must-wrap-at-390";
    const path = `C:\\Users\\dev\\${name}`;
    const dialog = renderHeader(path, [phase("a", "not-started")]);
    const project = screen.getByText(name);
    expect(project.textContent).toBe(name);
    expect(project.children).toHaveLength(0);
    expect(project.getAttribute("title")).toBe(path);
    expect(description(dialog)).toContain(`Project: ${name}`);
  });

  it("takes the folder name from Windows paths", () => {
    const dialog = renderHeader("E:\\Projects\\gg-framework-fork", []);
    expect(description(dialog)).toBe("Project: gg-framework-fork");
  });
});
