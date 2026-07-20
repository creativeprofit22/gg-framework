import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, logError } = vi.hoisted(() => ({ invoke: vi.fn(), logError: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn(),
    listen: vi.fn(async () => vi.fn()),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: logError, info: vi.fn() }));

import { killTask } from "./agent";

describe("killTask", () => {
  beforeEach(() => {
    invoke.mockReset();
    logError.mockReset();
  });

  it("preserves a successful sidecar status", async () => {
    invoke.mockResolvedValue({ ok: true, message: "Process task-1 stopped" });

    await expect(killTask("task-1")).resolves.toEqual({
      ok: true,
      message: "Process task-1 stopped",
    });
    expect(invoke).toHaveBeenCalledWith("agent_kill_task", {
      paneId: "primary",
      id: "task-1",
    });
  });

  it("preserves backend failure responses, including legacy message-only responses", async () => {
    invoke.mockResolvedValue({ message: 'No background process with id "stale"' });

    await expect(killTask("stale")).resolves.toEqual({
      ok: false,
      message: 'No background process with id "stale"',
    });
  });

  it("normalizes IPC rejection details into a visible failure", async () => {
    invoke.mockRejectedValue(new Error("daemon not ready"));

    await expect(killTask("task-1")).resolves.toEqual({
      ok: false,
      message: "daemon not ready",
    });
    expect(logError).toHaveBeenCalled();
  });
});
