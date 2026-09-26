import { afterEach, describe, expect, it, vi } from "vitest";
import { dependencies } from "../../package.json";
import { createMediaPipeTracker } from "./mediapipe-tracker";

const { forVisionTasks } = vi.hoisted(() => ({ forVisionTasks: vi.fn() }));

vi.mock("@mediapipe/tasks-vision", () => ({
  FaceLandmarker: { createFromOptions: vi.fn() },
  FilesetResolver: { forVisionTasks },
}));

describe("MediaPipe runtime version", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads WASM from the exact SDK release, not an independently pinned runtime", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const version = dependencies["@mediapipe/tasks-vision"];
    // A range could install a newer SDK while the CDN serves another runtime.
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const unavailable = new Error("runtime unavailable");
    forVisionTasks.mockRejectedValueOnce(unavailable);

    await expect(createMediaPipeTracker().start(vi.fn())).rejects.toThrow(unavailable);

    expect(forVisionTasks).toHaveBeenCalledExactlyOnceWith(
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/wasm`,
    );
  });
});
