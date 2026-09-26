// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { bootstrapPreview, fixtureResponses } from "./fixtures.mjs";
import { createLayout } from "./layouts.mjs";
import { WORKSPACE_LAYOUT_VERSION } from "../../src/workspace-layout";
import { contrastRatio } from "./measurements.mjs";
import { initScript } from "../capture-screenshots.mjs";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createSafeTauriUnlisten } from "../../src/tauri-listener";

const nativeBridge = () => (window as unknown as { __TAURI_INTERNALS__: {
  transformCallback: (callback: (...args: unknown[]) => void) => number;
  unregisterCallback: (id: number) => void;
} }).__TAURI_INTERNALS__;

it("cleans up real SDK window/event listeners through the synthetic bridge", async () => {
  const payload = { responses: fixtureResponses(), layout: createLayout("one", WORKSPACE_LAYOUT_VERSION), options: { state: "completed" } };
  initScript(payload);
  bootstrapPreview(payload);
  const bridge = window as unknown as {
    __ggEmit: (type: string) => number;
    __ggListenerStats: () => unknown;
    __chatPreview: { emit: (pane: string, type: string) => void; listenerStats: () => unknown };
  };
  const baseline = () => [bridge.__ggListenerStats(), bridge.__chatPreview.listenerStats()];
  const initial = baseline();
  const removed = vi.fn();
  const unlisten = await getCurrentWebviewWindow().listen("agent-event", removed);
  await expect(unlisten()).resolves.toBeUndefined();
  await expect(unlisten()).resolves.toBeUndefined();
  bridge.__ggEmit("run_start");
  bridge.__chatPreview.emit("primary", "run_start");
  expect(removed).not.toHaveBeenCalled();
  expect(baseline()).toEqual(initial);
  const start = baseline();
  const survivor = vi.fn();
  const stopSurvivor = await listen("agent-event", survivor);
  const unrelated = vi.fn();
  const callbackId = nativeBridge().transformCallback(unrelated);
  const active = baseline();
  const reportError = vi.fn();
  for (let i = 0; i < 10; i++) {
    for (const event of ["agent-event", "agent-pane-ready", "agent-pane-error", "agent-pane-exited"]) {
      // Dispose before the SDK registration promise resolves, as on an early unmount.
      const pending = getCurrentWebviewWindow().listen(event, removed);
      const disposed = true;
      await pending.then(async (stop) => {
        const cleanup = createSafeTauriUnlisten(stop, event, { reportError });
        if (disposed) await Promise.all([cleanup(), cleanup()]);
      });
    }
    expect(baseline()).toEqual(active);
  }
  bridge.__ggEmit("run_start");
  bridge.__chatPreview.emit("primary", "run_start");
  expect(survivor).toHaveBeenCalledTimes(2);
  expect(removed).not.toHaveBeenCalled();
  expect(reportError).not.toHaveBeenCalled();
  await stopSurvivor();
  nativeBridge().unregisterCallback(callbackId);
  expect(baseline()).toEqual(start);
});

it("supports shared screenshot cleanup without the preview adapter", async () => {
  initScript({ responses: fixtureResponses() });
  const bridge = window as unknown as { __ggEmit: (type: string) => number; __ggListenerStats: () => unknown };
  const start = bridge.__ggListenerStats();
  const listener = vi.fn();
  const transform = vi.spyOn(nativeBridge(), "transformCallback");
  const stop = await listen("agent-event", listener);
  bridge.__ggEmit("run_start");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener.mock.calls[0][0].id).not.toBe(transform.mock.results[0].value);
  await stop();
  await stop();
  expect(bridge.__ggEmit("run_start")).toBe(0);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(bridge.__ggListenerStats()).toEqual(start);
  transform.mockRestore();
});

it("surfaces native cleanup error logs in preview diagnostics", async () => {
  initScript({ responses: fixtureResponses() });
  bootstrapPreview({ responses: fixtureResponses(), layout: createLayout("one", WORKSPACE_LAYOUT_VERSION), options: { state: "completed" } });
  await createSafeTauriUnlisten(() => { throw new Error("synthetic cleanup failure"); }, "fixture")();
  expect((window as unknown as { __chatPreview: { errors: string[] } }).__chatPreview.errors)
    .toEqual(["Tauri listener cleanup failed (fixture): Error: synthetic cleanup failure"]);
});

it("confirms synthetic Autopilot without falling through to an external boundary", async () => {
  const fallback = vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => 1);
  const native = { invoke: fallback, transformCallback: vi.fn((_callback: (event: unknown) => void) => 1), unregisterCallback: vi.fn() };
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: native, configurable: true });
  bootstrapPreview({ responses: fixtureResponses(), layout: createLayout("one", WORKSPACE_LAYOUT_VERSION), options: { state: "completed" } });
  const listener = vi.fn();
  const id = native.transformCallback(listener);
  await native.invoke("plugin:event|listen", { event: "agent-event", handler: id });
  fallback.mockClear();
  expect(await native.invoke("agent_autopilot_set", { enabled: true })).toEqual({ autopilot: true });
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ type: "autopilot", data: { autopilot: true } }) }));
  expect(await native.invoke("agent_state")).toMatchObject({ autopilot: true });
  await expect(native.invoke("agent_autopilot_set", { enabled: "true" })).rejects.toThrow("Invalid synthetic Autopilot");
  expect(await native.invoke("agent_state")).toMatchObject({ autopilot: true });
  expect(await native.invoke("agent_autopilot_set", { enabled: false })).toEqual({ autopilot: false });
  expect(fallback).not.toHaveBeenCalled();
});

it("masks SharedWorker only in the preview and preserves network restrictions", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "SharedWorker");
  const worker = vi.fn();
  Object.defineProperty(window, "SharedWorker", { value: worker, configurable: true });
  try {
    const payload = { responses: fixtureResponses(), layout: createLayout("one", WORKSPACE_LAYOUT_VERSION), options: { state: "completed" } };
    initScript(payload);
    // The shared screenshot bootstrap must not mask ordinary pages' capability.
    expect(window.SharedWorker).toBe(worker);
    const socket = window.WebSocket;
    bootstrapPreview(payload);
    expect(typeof window.SharedWorker).toBe("undefined");
    expect(Object.getOwnPropertyDescriptor(window, "SharedWorker")?.value).toBeUndefined();
    expect(worker).not.toHaveBeenCalled();
    expect(window.WebSocket).toBe(socket);
    for (const url of ["/api", "http://127.0.0.1:1/api", "https://example.invalid/"]) {
      await expect(window.fetch(url)).rejects.toThrow("Network fetch disabled in chat preview");
      expect(() => new window.EventSource(url)).toThrow("EventSource disabled in chat preview");
    }
  } finally {
    if (original) Object.defineProperty(window, "SharedWorker", original);
    else Reflect.deleteProperty(window, "SharedWorker");
  }
});

it("measures the shared opaque-colour contrast samples", () => {
  expect(contrastRatio("#ffffff", "rgb(0, 0, 0)")).toBe(21);
  expect(contrastRatio("#454ca0", "#454ca0")).toBe(1);
  expect(() => contrastRatio("rgba(0, 0, 0, 0)", "#ffffff")).toThrow("opaque RGB");
  expect(() => contrastRatio("oklab(0.5 0.1 0.1)", "#ffffff")).toThrow("opaque RGB");
});
