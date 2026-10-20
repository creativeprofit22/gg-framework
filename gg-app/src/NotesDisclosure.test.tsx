// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NotesDisclosure } from "./NotesDisclosure";

afterEach(cleanup);

function Harness({ focusFallback }: { focusFallback?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <NotesDisclosure
      id="region"
      className="group"
      regionClassName="list"
      label="Deleted phases (1)"
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      focusFallback={focusFallback}
    >
      <button type="button">Recover</button>
    </NotesDisclosure>
  );
}

describe("NotesDisclosure", () => {
  it("is a native button wired to its region and collapsed by default", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Deleted phases (1)" });
    // A native <button type="button"> gives Enter/Space activation and focus for free.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("region");
    expect(toggle.getAttribute("data-state")).toBe("closed");
    expect(toggle.hasAttribute("data-phase-focus-fallback")).toBe(false);
    expect(toggle.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const region = document.getElementById("region");
    expect(region?.className).toBe("notes-disclosure-region list");
    expect(region?.hidden).toBe(true);
    expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
  });

  it("toggles expansion, state and region visibility", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Deleted phases (1)" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("data-state")).toBe("open");
    expect(document.getElementById("region")?.hidden).toBe(false);
    expect(screen.getByRole("button", { name: "Recover" })).toBeTruthy();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("region")?.hidden).toBe(true);
  });

  it("marks the toggle as the phase focus fallback on request", () => {
    render(<Harness focusFallback />);
    expect(
      screen
        .getByRole("button", { name: "Deleted phases (1)" })
        .hasAttribute("data-phase-focus-fallback"),
    ).toBe(true);
  });
});
