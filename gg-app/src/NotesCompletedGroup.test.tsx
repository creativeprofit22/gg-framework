// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotesCompletedGroup } from "./NotesCompletedGroup";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

function renderGroup(props: { count?: number; storageKey?: string | null; forceOpen?: boolean }) {
  return render(
    <NotesCompletedGroup
      id="completed-region"
      count={props.count ?? 2}
      storageKey={props.storageKey === undefined ? "project:completed" : props.storageKey}
      forceOpen={props.forceOpen}
    >
      <p>Finished item</p>
    </NotesCompletedGroup>,
  );
}

describe("NotesCompletedGroup", () => {
  it("renders nothing when there is nothing completed", () => {
    const { container } = renderGroup({ count: 0 });
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: /Completed/ })).toBeNull();
  });

  it("starts collapsed and wires disclosure semantics to its region", () => {
    renderGroup({});
    const toggle = screen.getByRole("button", { name: "Completed (2)" });
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("completed-region");
    expect(toggle.getAttribute("data-state")).toBe("closed");
    const region = document.getElementById("completed-region");
    expect(region).not.toBeNull();
    expect(region?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("data-state")).toBe("open");
    expect(region?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByText("Finished item").closest("[hidden]")).toBeNull();
  });

  it("remembers the choice for the session across remounts", () => {
    const first = renderGroup({});
    fireEvent.click(screen.getByRole("button", { name: "Completed (2)" }));
    first.unmount();

    renderGroup({});
    expect(
      screen.getByRole("button", { name: "Completed (2)" }).getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Completed (2)" }));
    cleanup();
    renderGroup({});
    expect(
      screen.getByRole("button", { name: "Completed (2)" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps memory-only state when the storage key is unknown", () => {
    renderGroup({ storageKey: null });
    fireEvent.click(screen.getByRole("button", { name: "Completed (2)" }));
    expect(
      screen.getByRole("button", { name: "Completed (2)" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(sessionStorage.length).toBe(0);
  });

  it("reveals content when forced open without overwriting the remembered choice", () => {
    const view = renderGroup({});
    const toggle = screen.getByRole("button", { name: "Completed (2)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    view.rerender(
      <NotesCompletedGroup id="completed-region" count={2} storageKey="project:completed" forceOpen>
        <p>Finished item</p>
      </NotesCompletedGroup>,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(sessionStorage.length).toBe(0);

    // The reveal holds once the selection clears, so focus can return to a shown row.
    view.rerender(
      <NotesCompletedGroup id="completed-region" count={2} storageKey="project:completed">
        <p>Finished item</p>
      </NotesCompletedGroup>,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(sessionStorage.length).toBe(0);

    cleanup();
    renderGroup({});
    expect(
      screen.getByRole("button", { name: "Completed (2)" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("lets the user collapse a forced-open group", () => {
    renderGroup({ forceOpen: true });
    const toggle = screen.getByRole("button", { name: "Completed (2)" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
