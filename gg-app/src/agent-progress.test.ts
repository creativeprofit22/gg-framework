import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, listeners } = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: vi.fn(async (name, callback) => {
    listeners.set(name, callback);
    return vi.fn();
  }) }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
import { createPaneAgentClient, getProgress, subscribe } from "./agent";
import { buildSnapshot, MAX_LEVEL, xpForLevel } from "../../packages/ggcoder/src/core/progress/ranks";
import { createEmptyProgress } from "../../packages/ggcoder/src/core/progress/store";

let response: unknown;
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "agent_pane_status")
      return { ready: true, error: null, generation: 1, sessionId: "session" };
    if (command === "agent_progress") return response;
    throw new Error(`Unexpected command: ${command}`);
  });
});
it.each([-1, 0, 100, "legacy"] as const)("routes matching RPC/event cap metadata (%s) to its ready secondary without primary readiness", async (extra) => {
  const file = createEmptyProgress(new Date("2026-07-01T12:00:00Z"));
  file.xp = xpForLevel(MAX_LEVEL) + (extra === "legacy" ? 100 : extra);
  const snapshot = buildSnapshot(file);
  if (extra === "legacy") delete snapshot.maxLevel;
  invoke.mockImplementation(async (command: string, args: { paneId: string }) => {
    if (args.paneId === "primary") throw new Error("Primary unavailable");
    if (command === "agent_pane_status") return { ready: true, error: null, generation: 2, sessionId: "right-current" };
    if (command === "agent_progress") return snapshot;
    throw new Error(`Unexpected command: ${command}`);
  });
  const client = createPaneAgentClient("right");
  const receive = vi.fn();
  const legacy = vi.fn();
  const off = client.subscribe(receive);
  const offLegacy = subscribe(legacy);
  try {
    await expect(client.getProgress()).resolves.toEqual(snapshot);
    expect(invoke.mock.calls.every(([, args]) => args.paneId === "right")).toBe(true);
    const send = (paneId: string, sessionId: string, origin: boolean) => listeners.get("agent-event")!({
      payload: { paneId, sessionId, type: "progress", data: { ...snapshot, origin } },
    });
    send("primary", "primary-session", false);
    send("right", "right-stale", true);
    send("foreign", "right-current", true);
    await vi.waitFor(() => expect(legacy).toHaveBeenCalledTimes(1));
    expect(receive).not.toHaveBeenCalled();
    send("right", "right-current", true);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(receive).toHaveBeenLastCalledWith({ type: "progress", data: { ...snapshot, origin: true } });
    expect(legacy).toHaveBeenCalledTimes(1);
  } finally { off(); offLegacy(); }
});

describe.each([
  ["primary", getProgress],
  ["pane", () => createPaneAgentClient("right").getProgress()],
] as const)("%s progress RPC", (_name, fetch) => {
  it.each([
    { error: "unauthorized" },
    { error: "forbidden" },
    { error: "internal error" },
    null,
    {},
    [],
  ])("rejects malformed success data: %j", async (data) => {
    response = data;
    await expect(fetch()).rejects.toThrow("invalid progress snapshot");
  });
  it("accepts the real producer's snapshot and recovers after rejected data", async () => {
    response = { error: "unauthorized" };
    await expect(fetch()).rejects.toThrow("invalid progress snapshot");
    response = buildSnapshot(createEmptyProgress(new Date("2026-07-01T12:00:00Z")));
    await expect(fetch()).resolves.toEqual(response);
  });
  it("accepts a legacy payload without supplying a guessed cap", async () => {
    const { maxLevel: _maxLevel, ...legacy } = buildSnapshot(createEmptyProgress());
    response = legacy;
    await expect(fetch()).resolves.toEqual(legacy);
  });
  it.each([401, 403, 500])("propagates a native HTTP %i rejection", async (status) => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, ...args) =>
      command === "agent_progress"
        ? Promise.reject(`Progress request failed (HTTP ${status})`)
        : original(command, ...args),
    );
    await expect(fetch()).rejects.toBe(`Progress request failed (HTTP ${status})`);
  });
});
