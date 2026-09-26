// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { bootstrapPreview, fixtureResponses } from "./fixtures.mjs";
import { createLayout, stateNames } from "./layouts.mjs";
import { WORKSPACE_LAYOUT_VERSION } from "../../src/workspace-layout";

type Identity = { generation: number; sessionId: string };
const target = { mode: "code", cwd: "/synthetic/chat-preview", sessionPath: null };
function setup(state = "completed") {
  const fallback = vi.fn(async (): Promise<unknown> => null);
  let callbackId = 0;
  const native = { invoke: fallback, transformCallback: (_callback: (event: unknown) => void) => ++callbackId, unregisterCallback: vi.fn() };
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: native, configurable: true });
  bootstrapPreview({ responses: fixtureResponses(state), layout: createLayout("six", WORKSPACE_LAYOUT_VERSION), options: { state } });
  return { invoke: native.invoke as <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>, native, fallback };
}

it.each(stateNames)("preserves preseeded restore and state identity for %s", async (state) => {
  const { invoke } = setup(state);
  for (const paneId of ["primary", "preview-2", "preview-3", "preview-4", "preview-5", "preview-6"]) {
    const before = await invoke<Identity>("agent_pane_status", { paneId });
    expect(await invoke("agent_pane_restore", { paneId, ...target })).toBe(before.generation);
    expect(await invoke("agent_pane_restore", { paneId, ...target })).toBe(before.generation);
    expect(await invoke("agent_state", { paneId })).toMatchObject({ ...target, sessionId: before.sessionId });
  }
});

it("creates, rebinds and disposes live identities without stale dispatch or fallback RPCs", async () => {
  const { invoke, native, fallback } = setup();
  const listener = vi.fn();
  await invoke("plugin:event|listen", { event: "agent-event", handler: native.transformCallback(listener) });
  fallback.mockClear();
  const paneId = "pane-1";
  await expect(invoke("agent_pane_status", { paneId })).rejects.toThrow("does not exist");
  const generation = await invoke<number>("agent_pane_create", { paneId, ...target });
  expect(await invoke("agent_pane_status", { paneId })).toMatchObject({ generation, ready: true });
  const oldState = await invoke<Identity>("agent_state", { paneId });
  const next = await invoke<number>("select_project", { paneId, ...target, expectedGeneration: generation });
  expect(next).toBeGreaterThan(generation);
  const state = await invoke<Identity>("agent_state", { paneId });
  expect(state.sessionId).not.toBe(oldState.sessionId);
  expect(await invoke("agent_pane_status", { paneId })).toMatchObject({ generation: next, sessionId: state.sessionId });
  await expect(invoke("select_project", { paneId, ...target, expectedGeneration: generation })).rejects.toThrow("superseded");
  await expect(invoke("agent_pane_dispose", { paneId, generation })).rejects.toThrow("superseded");
  await invoke("agent_autopilot_set", { paneId, enabled: true });
  expect(listener).toHaveBeenCalledTimes(7);
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ payload: { paneId, sessionId: state.sessionId, type: "autopilot", data: { autopilot: true } } }));
  await invoke("agent_pane_dispose", { paneId, generation: next });
  await expect(invoke("agent_state", { paneId })).rejects.toThrow("does not exist");
  listener.mockClear();
  await invoke("agent_autopilot_set", { enabled: false });
  expect(listener).toHaveBeenCalledTimes(6);
  const recreated = await invoke("agent_pane_create", { paneId, ...target });
  expect(recreated).toBeGreaterThan(next);
  expect((await invoke<Identity>("agent_state", { paneId })).sessionId).not.toBe(state.sessionId);
  expect(fallback).not.toHaveBeenCalled();
});

it("bounds the registry and rejects non-synthetic targets without creating panes", async () => {
  const { invoke, fallback } = setup();
  await expect(invoke("agent_pane_create", { paneId: "invalid", ...target, cwd: "/real/project" })).rejects.toThrow("Unsupported synthetic");
  await expect(invoke("agent_pane_create", { paneId: "invalid", ...target, sessionPath: "/real/session" })).rejects.toThrow("Unsupported synthetic");
  await expect(invoke("agent_pane_create", { paneId: "x".repeat(65), ...target })).rejects.toThrow("Invalid synthetic pane ID");
  for (let i = 0; i < 6; i++) await invoke("agent_pane_create", { paneId: `pane-${i}`, ...target });
  await expect(invoke("agent_pane_create", { paneId: "overflow", ...target })).rejects.toThrow("limit");
  await expect(invoke("agent_pane_status", { paneId: "overflow" })).rejects.toThrow("does not exist");
  await invoke("agent_pane_dispose", { paneId: "pane-0" });
  await invoke("agent_pane_create", { paneId: "replacement", ...target });
  expect(fallback).not.toHaveBeenCalled();
});
