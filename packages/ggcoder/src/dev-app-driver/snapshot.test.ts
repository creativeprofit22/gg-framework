import { describe, expect, it } from "vitest";
import { appShellHtml, createFixturePage, type FixturePage } from "../test-support/dev-app-dom.js";
import { observeScript, parsePageState } from "./observe.js";
import {
  formatSnapshot,
  parseSnapshot,
  refLocatorScript,
  snapshotScript,
  SNAPSHOT_LIMITS,
  type UiSnapshot,
} from "./snapshot.js";

function snap(page: FixturePage, options: Parameters<typeof snapshotScript>[0] = {}): UiSnapshot {
  const parsed = parseSnapshot(page.evaluate(snapshotScript(options)));
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

function text(page: FixturePage): string {
  const state = parsePageState(page.evaluate(observeScript()));
  if (!state) throw new Error("no page state");
  return formatSnapshot(state, snap(page));
}

function locate(page: FixturePage, ref: string, generation: number): unknown {
  return page.evaluate(refLocatorScript(ref, generation));
}

const CONTROLS = `
  <a href="/notes" data-rect="10,10,60,20">Notes</a>
  <label for="name">Project name</label><input id="name" value="demo" data-rect="10,40,200,20">
  <input type="password" aria-label="API key" value="sk-secret-value-123" data-rect="10,70,200,20">
  <input type="checkbox" checked aria-label="Auto" data-rect="10,100,20,20">
  <button aria-expanded="true" data-rect="10,130,80,20">Model <span>▾</span></button>
  <div role="tab" aria-selected="true" data-rect="100,130,60,20">Chat</div>
  <span id="lbl">Search notes</span><div contenteditable="true" aria-labelledby="lbl" data-rect="10,160,200,20"></div>
  <select data-rect="10,190,100,20"><option>Fast</option><option selected>Deep</option></select>
  <div tabindex="0" data-rect="10,220,50,20">Card</div>
  <button disabled data-rect="10,250,50,20">Retry</button>
  <button data-rect="2000,10,50,20">Far away</button>
  <button hidden data-rect="10,280,50,20">Hidden</button>
  <button style="display: none" data-rect="10,280,50,20">Undisplayed</button>
  <button data-rect="10,280,0,0">No size</button>
  <button data-rect="300,10,80,20">Under</button>
  <div class="toast" data-z="5" data-rect="290,0,120,40"></div>
`;

describe("dev app snapshot", () => {
  it("lists visible interactive elements with roles, names and state", () => {
    const page = createFixturePage(appShellHtml({ pane: CONTROLS }));
    page.focus(page.find("textarea.input"));
    const view = text(page);
    const lines = view.split("\n");
    expect(lines[0]).toBe(
      'Snapshot 1 · pane pane-a: draft "", menu closed, status Ready, focus textarea "Message"',
    );
    expect(lines.slice(1)).toEqual([
      'e1 link "Notes"',
      'e2 textbox "Project name" value="demo"',
      'e3 textbox "API key"',
      'e4 checkbox "Auto" [checked]',
      'e5 button "Model ▾" [expanded]',
      'e6 tab "Chat" [selected]',
      'e7 textbox "Search notes"',
      'e8 combobox value="Deep"',
      'e9 div "Card"',
      'e10 button "Retry" [disabled]',
      'e11 button "Far away" [offscreen]',
      'e12 button "Under" [covered]',
      'e13 textbox "Message" value="" [focused]',
      'e14 button "Send"',
    ]);
    expect(view).not.toContain("sk-secret-value-123");
    expect(view).not.toMatch(/Hidden|Undisplayed|No size/);
  });

  it("shows the text selection of the focused field, so selection keys are visible", () => {
    const page = createFixturePage(appShellHtml());
    const input = page.find("textarea.input") as HTMLTextAreaElement;
    input.value = "hello";
    page.focus(input);
    const select = (start: number, end: number) => {
      Object.defineProperty(input, "selectionStart", { value: start, configurable: true });
      Object.defineProperty(input, "selectionEnd", { value: end, configurable: true });
    };
    select(5, 5);
    expect(text(page)).toContain('textbox "Message" value="hello" [focused]\n');
    select(0, 5);
    expect(text(page)).toContain('value="hello" [focused, all text selected]');
    select(1, 3);
    expect(text(page)).toContain('value="hello" [focused, 2 chars selected]');
  });

  it("lists only the open dialog's items and counts the hidden background", () => {
    const page = createFixturePage(
      appShellHtml({
        extra: `<div role="dialog" aria-modal="true" data-z="10" data-rect="100,100,400,300">
          <button data-rect="120,350,80,30">Cancel</button>
          <button data-rect="300,350,80,30">Delete</button>
        </div>`,
      }),
    );
    const snapshot = snap(page);
    expect(snapshot.modal).toBe(true);
    expect(snapshot.hiddenBackground).toBe(2);
    expect(snapshot.elements.map((element) => element.name)).toEqual(["Cancel", "Delete"]);
    const view = text(page);
    expect(view).toContain("dialog open");
    expect(view).toContain("Dialog open: listing only its items (2 background items hidden).");
  });

  it("caps elements, line length and total size, then says how many are not shown", () => {
    const long = "x".repeat(200);
    const buttons = Array.from(
      { length: 220 },
      (_, index) =>
        `<button data-rect="${index % 10},${index},5,1" aria-label="${long}${index}">b</button>`,
    ).join("");
    const page = createFixturePage(buttons);
    const snapshot = snap(page);
    expect(snapshot.total).toBe(220);
    expect(snapshot.elements).toHaveLength(SNAPSHOT_LIMITS.elements);
    expect(snapshot.elements[0]?.name.length).toBe(SNAPSHOT_LIMITS.nameChars);
    const state = parsePageState(page.evaluate(observeScript()));
    if (!state) throw new Error("no page state");
    const view = formatSnapshot(state, snapshot);
    const lines = view.split("\n");
    expect(Buffer.byteLength(view)).toBeLessThanOrEqual(SNAPSHOT_LIMITS.totalBytes);
    for (const line of lines.slice(1)) {
      expect(line.length).toBeLessThanOrEqual(SNAPSHOT_LIMITS.lineChars);
    }
    const shown = lines.filter((line) => /^e\d+ /.test(line)).length;
    expect(lines.at(-1)).toBe(`${220 - shown} more not shown.`);
  });

  it("keeps refs for elements that stay and refuses refs that went stale", () => {
    const page = createFixturePage(appShellHtml());
    const first = snap(page);
    expect(first.generation).toBe(1);
    expect(first.elements.map((element) => element.ref)).toEqual(["e1", "e2"]);
    const send = page.find("button.send");
    expect(locate(page, "e2", 1)).toBe(send);

    send.remove();
    expect(locate(page, "e2", 1)).toEqual({
      problem: "e2 is no longer on the page",
      block: "stale",
    });
    const second = snap(page);
    expect(second.generation).toBe(2);
    expect(second.elements.map((element) => element.ref)).toEqual(["e1"]);
    expect(locate(page, "e2", 2)).toEqual({
      problem: "e2 is not in the latest snapshot",
      block: "stale",
    });
    expect(locate(page, "e1", 1)).toEqual({
      problem: "e1 is from an older snapshot",
      block: "stale",
    });
    expect(locate(page, "e1", 2)).toBe(page.find("textarea.input"));

    const reloaded = createFixturePage(appShellHtml());
    expect(locate(reloaded, "e1", 2)).toEqual({
      problem: "e1 is from before the page reloaded",
      block: "stale",
    });
    expect(() => refLocatorScript("button.send", 1)).toThrow(RangeError);
  });

  it("does not touch refs when reading for change detection, and scopes to a pane", () => {
    const page = createFixturePage(
      `${appShellHtml()}<div data-pane-id="pane-b"><div class="agent-pane" data-rect="640,0,640,800"><button data-rect="700,10,50,20">Other</button></div></div>`,
    );
    const probe = snap(page, { register: false });
    expect(probe.generation).toBe(0);
    expect(probe.elements.every((element) => element.ref === null)).toBe(true);
    expect(snap(page, { pane: "pane-b" }).elements.map((element) => element.name)).toEqual([
      "Other",
    ]);
    expect(parseSnapshot(page.evaluate(snapshotScript({ pane: "pane-z" })))).toBe("pane not found");
    expect(parseSnapshot({ generation: "1" })).toBe("snapshot had an unexpected shape");
  });
});
