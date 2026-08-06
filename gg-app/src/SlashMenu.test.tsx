// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SlashMenu } from "./SlashMenu";
import type { SlashCommand } from "./agent";

// jsdom has no layout engine, so scrollIntoView is undefined. The component
// calls it to keep the active row visible; stub it rather than guard the call.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const COMMANDS: SlashCommand[] = [
  {
    name: "schedule",
    aliases: ["sched"],
    description: "Run a prompt on a repeating schedule",
    source: "built-in",
  },
  { name: "plan", aliases: [], description: "Plan before building", source: "built-in" },
];

describe("SlashMenu", () => {
  it("is titled 'plays'", () => {
    render(<SlashMenu commands={COMMANDS} activeIndex={0} onSelect={vi.fn()} onHover={vi.fn()} />);
    expect(screen.getByText("plays")).toBeTruthy();
  });

  it("lists each command with its name and description", () => {
    render(<SlashMenu commands={COMMANDS} activeIndex={0} onSelect={vi.fn()} onHover={vi.fn()} />);
    expect(screen.getByText("/schedule")).toBeTruthy();
    expect(screen.getByText("Run a prompt on a repeating schedule")).toBeTruthy();
  });

  it("selects a command on click", () => {
    const onSelect = vi.fn();
    render(<SlashMenu commands={COMMANDS} activeIndex={0} onSelect={onSelect} onHover={vi.fn()} />);
    fireEvent.click(screen.getByText("/schedule"));
    expect(onSelect).toHaveBeenCalledWith(COMMANDS[0]);
  });

  it("marks the active row", () => {
    render(<SlashMenu commands={COMMANDS} activeIndex={1} onSelect={vi.fn()} onHover={vi.fn()} />);
    const active = document.querySelectorAll(".slash-item")[1];
    expect(active?.className).toContain("active");
  });
});
