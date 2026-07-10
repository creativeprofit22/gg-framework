import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const unlisteners: Array<ReturnType<typeof vi.fn>> = [];
  const invoke = vi.fn();
  const listen = vi.fn(
    async (event: string, listener: (event: { payload: unknown }) => void): Promise<() => void> => {
      listeners.set(event, listener);
      const unlisten = vi.fn(() => listeners.delete(event));
      unlisteners.push(unlisten);
      return unlisten;
    },
  );
  return { invoke, listen, listeners, unlisteners };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: mocks.listen,
    setTitle: vi.fn(async () => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn(async () => {}),
  info: vi.fn(async () => {}),
}));

import { waitForPaneReady } from "./agent";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForListeners(): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.listeners.has("agent-pane-ready")).toBe(true);
    expect(mocks.listeners.has("agent-pane-error")).toBe(true);
    expect(mocks.listeners.has("sidecar-error")).toBe(true);
  });
}

describe("waitForPaneReady", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockClear();
    mocks.listeners.clear();
    mocks.unlisteners.length = 0;
  });

  it("rejects immediately with an already-recorded pane error", async () => {
    mocks.invoke.mockResolvedValue({ ready: false, error: "Node runtime is missing" });

    await expect(waitForPaneReady("primary")).rejects.toThrow("Node runtime is missing");

    expect(mocks.invoke).toHaveBeenCalledWith("agent_pane_status", { paneId: "primary" });
    expect(mocks.unlisteners).toHaveLength(3);
    expect(mocks.unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });

  it("ignores another pane's session error and resolves its own readiness", async () => {
    const status = deferred<{ ready: boolean; error: string | null }>();
    mocks.invoke.mockReturnValue(status.promise);
    const waiting = waitForPaneReady("pane-b");
    await waitForListeners();

    mocks.listeners.get("agent-pane-error")?.({
      payload: { paneId: "pane-a", message: "pane A failed" },
    });
    status.resolve({ ready: true, error: null });

    await expect(waiting).resolves.toBeUndefined();
  });

  it("rejects every pending pane wait on a daemon-global failure", async () => {
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    const waiting = waitForPaneReady("pane-b");
    await waitForListeners();

    mocks.listeners.get("sidecar-error")?.({ payload: "failed to spawn daemon: node missing" });

    await expect(waiting).rejects.toThrow("failed to spawn daemon: node missing");
    expect(mocks.unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });

  it("cleans up all listeners after pane-specific failure", async () => {
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    const waiting = waitForPaneReady("pane-b");
    await waitForListeners();

    mocks.listeners.get("agent-pane-error")?.({
      payload: { paneId: "pane-b", message: "session creation failed" },
    });

    await expect(waiting).rejects.toThrow("session creation failed");
    expect(mocks.unlisteners).toHaveLength(3);
    expect(mocks.listeners.size).toBe(0);
  });

  it("resolves and cleans up when persistent status is already ready", async () => {
    mocks.invoke.mockResolvedValue({ ready: true, error: null });

    await expect(waitForPaneReady("primary")).resolves.toBeUndefined();

    expect(mocks.unlisteners).toHaveLength(3);
    expect(mocks.unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
  });
});
