// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPreview } from "../../src/dev/chat-design-preview/controller";
import { requireReady } from "./measurements.mjs";

const ids = ["primary", "preview-2", "preview-3", "preview-4", "preview-5", "preview-6"];
const content = '<div class="assistant-text"><div class="markdown"><p>One</p><p>Two</p><p>Three</p></div></div>';
let cleanup: (() => void) | undefined;
function mount(count = 6, state = "completed", missing = false) {
  vi.useFakeTimers();
  history.replaceState(null, "", `/__chat-design-preview?state=${state}`);
  Object.assign(window, { __chatPreview: { options: { state }, errors: [], paneIds: () => ids.slice(0, count) } });
  document.body.innerHTML = `<div id="root">${ids.slice(0, count).map((id, i) => `<div class="workspace-pane-slot" data-pane-id="${id}"><textarea></textarea><div class="transcript">${missing && i === count - 1 ? "" : state === "empty" ? '<div class="wake-screen" aria-label="Ready to start"></div>' : content}</div></div>`).join("")}</div>`;
  cleanup = startPreview();
}
async function harnessReady(count = 6, state = "completed") {
  let result = false;
  await requireReady({
    waitForFunction: async (predicate: (args: unknown) => boolean, args: unknown) => {
      result = Boolean(predicate(args));
      throw new Error("predicate sampled");
    },
  }, count, state).catch((error: Error) => { if (error.message !== "predicate sampled") throw error; });
  return result;
}
const controllerReady = () => document.getElementById("root")?.dataset.eyesReady === "true";
afterEach(() => { cleanup?.(); vi.useRealTimers(); history.replaceState(null, "", "/"); document.body.innerHTML = ""; });

describe("per-pane preview readiness", () => {
  it("does not let many paragraphs in five panes stand in for the sixth history", async () => {
    mount(6, "completed", true);
    expect(controllerReady()).toBe(false);
    // Even a stale flag must not make the harness accept missing content.
    document.getElementById("root")!.dataset.eyesReady = "true";
    expect(await harnessReady()).toBe(false);
    delete document.getElementById("root")!.dataset.eyesReady;
    document.querySelector('[data-pane-id="preview-6"] .transcript')!.innerHTML = content;
    vi.advanceTimersByTime(100);
    expect(controllerReady()).toBe(true);
    expect(await harnessReady()).toBe(true);
  });
  it("stops polling without declaring a never-resolving pane ready", async () => {
    mount(6, "completed", true);
    vi.advanceTimersByTime(31000);
    expect(controllerReady()).toBe(false);
    expect(await harnessReady()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("requires affirmative empty-pane initialization, not a composer alone", async () => {
    mount(6, "empty", true);
    expect(controllerReady()).toBe(false);
    expect(await harnessReady(6, "empty")).toBe(false);
    document.querySelector('[data-pane-id="preview-6"] .transcript')!.innerHTML = '<div class="wake-screen" aria-label="Ready to start"></div>';
    vi.advanceTimersByTime(100);
    expect(controllerReady()).toBe(true);
    expect(await harnessReady(6, "empty")).toBe(true);
  });
  it("waits for lazy Markdown to replace its busy fallback", async () => {
    mount(6, "completed", true);
    const transcript = document.querySelector('[data-pane-id="preview-6"] .transcript')!;
    transcript.innerHTML = '<div class="assistant-text"><div class="markdown" aria-busy="true">Pending text</div></div>';
    vi.advanceTimersByTime(100);
    expect(controllerReady()).toBe(false);
    expect(await harnessReady()).toBe(false);
    transcript.innerHTML = content;
    vi.advanceTimersByTime(100);
    expect(controllerReady()).toBe(true);
    expect(await harnessReady()).toBe(true);
  });
  it.each([1, 6])("accepts %i populated panes", async (count) => {
    mount(count);
    expect(controllerReady()).toBe(true);
    expect(await harnessReady(count)).toBe(true);
  });
  it("checks live pane identities, not just matching counts", async () => {
    mount(6, "completed", true);
    const last = document.querySelector('[data-pane-id="preview-6"]')!;
    last.setAttribute("data-pane-id", "unrelated");
    last.querySelector(".transcript")!.innerHTML = content;
    vi.advanceTimersByTime(100);
    expect(controllerReady()).toBe(false);
    expect(await harnessReady()).toBe(false);
  });
});
