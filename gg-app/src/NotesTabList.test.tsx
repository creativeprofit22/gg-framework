// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NotesTabList, revealTabHorizontally } from "./NotesTabList";

afterEach(cleanup);

const TABS = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Harness({ initial = "one" }: { initial?: TabId }) {
  const [active, setActive] = useState<TabId>(initial);
  return (
    <>
      <NotesTabList<TabId>
        label="Sections"
        tabs={TABS}
        activeId={active}
        onSelect={setActive}
        tabId={(id) => `tab-${id}`}
        panelId={(id) => `panel-${id}`}
        className="list"
        scrollClassName="scroller"
      />
      {TABS.map((tab) => (
        <div key={tab.id} id={`panel-${tab.id}`} role="tabpanel" hidden={tab.id !== active} />
      ))}
    </>
  );
}

function tabs(): HTMLElement[] {
  return screen.getAllByRole("tab");
}

function expectActive(index: number): void {
  tabs().forEach((tab, position) => {
    expect(tab.getAttribute("aria-selected")).toBe(String(position === index));
    expect(tab.tabIndex).toBe(position === index ? 0 : -1);
  });
  expect(document.activeElement).toBe(tabs()[index]);
}

describe("NotesTabList", () => {
  it("exposes a labelled horizontal tablist wired to its panels", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Sections" });
    expect(list.getAttribute("aria-orientation")).toBe("horizontal");
    expect(list.parentElement?.className).toBe("scroller");
    for (const tab of tabs()) {
      expect(tab.getAttribute("type")).toBe("button");
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      expect(panel?.getAttribute("role")).toBe("tabpanel");
    }
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves selection and focus with looping arrows and Home/End", () => {
    render(<Harness />);
    tabs()[0]?.focus();
    fireEvent.keyDown(tabs()[0]!, { key: "ArrowRight" });
    expectActive(1);
    fireEvent.keyDown(tabs()[1]!, { key: "ArrowRight" });
    expectActive(2);
    fireEvent.keyDown(tabs()[2]!, { key: "ArrowRight" });
    expectActive(0);
    fireEvent.keyDown(tabs()[0]!, { key: "ArrowLeft" });
    expectActive(2);
    fireEvent.keyDown(tabs()[2]!, { key: "Home" });
    expectActive(0);
    fireEvent.keyDown(tabs()[0]!, { key: "End" });
    expectActive(2);
  });

  it("ignores vertical arrows and modified keys", () => {
    render(<Harness />);
    tabs()[0]?.focus();
    fireEvent.keyDown(tabs()[0]!, { key: "ArrowDown" });
    fireEvent.keyDown(tabs()[0]!, { key: "ArrowUp" });
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      fireEvent.keyDown(tabs()[0]!, { key: "ArrowRight", [modifier]: true });
      fireEvent.keyDown(tabs()[0]!, { key: "End", [modifier]: true });
    }
    expectActive(0);
  });

  it("selects and focuses a clicked tab", () => {
    render(<Harness />);
    fireEvent.click(tabs()[1]!);
    expectActive(1);
    expect(document.getElementById("panel-two")?.hidden).toBe(false);
    expect(document.getElementById("panel-one")?.hidden).toBe(true);
  });
});

function rect(left: number, right: number): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: 10,
    width: right - left,
    height: 10,
    x: left,
    y: 0,
  } as DOMRect;
}

function stubbed(scrollLeft: number, outer: [number, number], inner: [number, number]) {
  const scroller = document.createElement("div");
  const tab = document.createElement("button");
  scroller.scrollLeft = scrollLeft;
  scroller.scrollTop = 40;
  scroller.getBoundingClientRect = () => rect(...outer);
  tab.getBoundingClientRect = () => rect(...inner);
  return { scroller, tab };
}

describe("revealTabHorizontally", () => {
  it("scrolls right just enough to show a clipped trailing tab", () => {
    const { scroller, tab } = stubbed(0, [0, 100], [80, 130]);
    revealTabHorizontally(scroller, tab);
    expect(scroller.scrollLeft).toBe(30);
    expect(scroller.scrollTop).toBe(40);
  });

  it("scrolls left to show a clipped leading tab", () => {
    const { scroller, tab } = stubbed(50, [0, 100], [-20, 30]);
    revealTabHorizontally(scroller, tab);
    expect(scroller.scrollLeft).toBe(30);
  });

  it("keeps the leading edge visible for a tab wider than the scroller", () => {
    const { scroller, tab } = stubbed(0, [0, 100], [20, 180]);
    revealTabHorizontally(scroller, tab);
    expect(scroller.scrollLeft).toBe(20);
  });

  it("snaps the first and last tabs to the scroll edges so list padding shows", () => {
    const { scroller, tab } = stubbed(8, [0, 100], [0, 40]);
    Object.defineProperty(scroller, "scrollWidth", { value: 260 });
    Object.defineProperty(scroller, "clientWidth", { value: 100 });
    revealTabHorizontally(scroller, tab, "start");
    expect(scroller.scrollLeft).toBe(0);
    revealTabHorizontally(scroller, tab, "end");
    expect(scroller.scrollLeft).toBe(160);
    expect(scroller.scrollTop).toBe(40);
  });

  it("leaves a fully visible tab alone", () => {
    const { scroller, tab } = stubbed(10, [0, 100], [20, 60]);
    revealTabHorizontally(scroller, tab);
    expect(scroller.scrollLeft).toBe(10);
  });
});
