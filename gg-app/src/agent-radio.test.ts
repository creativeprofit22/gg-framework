// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const logError = vi.fn();
let emitPaneReady: ((event: { payload: unknown }) => void) | undefined;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: (...args: unknown[]) => logError(...args) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
      // The Local Fork waits on per-pane readiness rather than upstream's
      // single "sidecar-ready" event.
      if (name === "agent-pane-ready") emitPaneReady = handler;
      return Promise.resolve(() => undefined);
    }),
  }),
}));

import { getRadioState } from "./agent";

const state = {
  stations: [{ id: "lofi", name: "Lofi", description: "", url: "" }],
  current: null,
  volume: 40,
};

describe("getRadioState", () => {
  beforeEach(() => {
    invoke.mockReset();
    logError.mockReset();
    emitPaneReady = undefined;
  });

  it("waits for the sidecar at launch instead of failing with daemon not ready", async () => {
    let ready = false;
    invoke.mockImplementation((command: string) => {
      if (command === "agent_pane_status") {
        return Promise.resolve({
          ready,
          error: null,
          generation: 1,
          sessionId: ready ? "session-1" : null,
        });
      }
      if (command === "agent_radio_state") {
        return ready ? Promise.resolve(state) : Promise.reject("daemon not ready");
      }
      return Promise.reject(new Error(`unexpected ${command}`));
    });

    const pending = getRadioState();
    await vi.waitFor(() => expect(emitPaneReady).toBeDefined());
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("agent_pane_status", { paneId: "primary" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("agent_radio_state", expect.anything());

    ready = true;
    emitPaneReady?.({ payload: { paneId: "primary", generation: 1 } });

    await expect(pending).resolves.toEqual(state);
    expect(logError).not.toHaveBeenCalled();
  });
});
