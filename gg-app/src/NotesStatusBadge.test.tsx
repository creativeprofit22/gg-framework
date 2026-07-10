// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotesStatusBadge, notesStatusLabel } from "./NotesStatusBadge";

afterEach(cleanup);

function renderButton(unfinishedCount: number, handoffUnread: boolean): HTMLButtonElement {
  const status = { unfinishedCount, handoffUnread };
  render(
    <button type="button" aria-label={notesStatusLabel(status)} title={notesStatusLabel(status)}>
      <NotesStatusBadge {...status} />
    </button>,
  );
  return screen.getByRole("button") as HTMLButtonElement;
}

describe("NotesStatusBadge", () => {
  it("renders plain Notes without a dot", () => {
    const button = renderButton(0, false);

    expect(button.textContent).toBe("Notes");
    expect(button.getAttribute("aria-label")).toBe("Notes");
    expect(button.getAttribute("title")).toBe("Notes");
    expect(button.querySelector(".notes-status-dot")).toBeNull();
  });

  it("renders the unfinished count with a task-specific accessible label", () => {
    const button = renderButton(3, false);

    expect(button.textContent).toBe("Notes (3)");
    expect(button.getAttribute("aria-label")).toBe("Notes, 3 unfinished tasks");
    expect(button.querySelector(".notes-status-dot")).toBeNull();
  });

  it("renders an accessibility-hidden unread dot independently of the count", () => {
    const button = renderButton(0, true);
    const badge = button.querySelector(".notes-status-badge");

    expect(button.textContent).toBe("Notes");
    expect(button.getAttribute("aria-label")).toBe("Notes, unread Handoff");
    expect(button.querySelector(".notes-status-dot")).toBeTruthy();
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders count and unread Handoff as distinct combined status", () => {
    const button = renderButton(1, true);

    expect(button.textContent).toBe("Notes (1)");
    expect(button.getAttribute("aria-label")).toBe("Notes, 1 unfinished task, unread Handoff");
    expect(button.getAttribute("title")).toBe("Notes, 1 unfinished task, unread Handoff");
    expect(button.querySelector(".notes-status-dot")).toBeTruthy();
  });
});
