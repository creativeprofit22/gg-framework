// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn(async () => {}),
  info: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { cancelQueued } from "./agent";

describe("queued cancellation bridge", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it.each([true, false])("preserves the cancellation verdict: %s", async (cancelled) => {
    vi.mocked(invoke).mockResolvedValue({ cancelled, queued: [] });
    await expect(cancelQueued("a")).resolves.toBe(cancelled);
    expect(invoke).toHaveBeenCalledWith("agent_cancel_queued", { id: "a" });
  });

  it("does not expose a delayed snapshot as current queue state", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = cancelQueued("a");
    // A newer queue event can arrive before this old HTTP snapshot.
    resolve({ cancelled: true, queued: [{ id: "stale", text: "already consumed" }] });
    await expect(pending).resolves.toBe(true);
  });

  it("returns null on transport failure", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("unavailable"));
    await expect(cancelQueued("a")).resolves.toBeNull();
  });

  it("does not treat a missing verdict as successful cancellation", async () => {
    vi.mocked(invoke).mockResolvedValue({ queued: [] });
    await expect(cancelQueued("a")).resolves.toBe(false);
  });
});
