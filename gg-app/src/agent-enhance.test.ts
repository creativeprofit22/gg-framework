// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: vi.fn(async () => () => {}) }),
}));

import { enhancePrompt } from "./agent";

const valid = {
  enhanced: "Fix the layout",
  segments: [
    { kind: "text", text: "Fix the " },
    { kind: "term", text: "layout", original: "look", note: "More specific" },
  ],
};

describe("enhancePrompt bridge", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValueOnce({ paneId: "primary", generation: 1, ready: true });
  });

  it("preserves valid enhancement results", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(valid);
    await expect(enhancePrompt("Fix the look")).resolves.toEqual(valid);
    expect(invoke).toHaveBeenNthCalledWith(2, "agent_enhance_prompt", {
      paneId: "primary",
      text: "Fix the look",
    });
  });

  it.each([
    { error: "Unsupported reasoning effort" },
    null,
    {},
    { ...valid, enhanced: "" },
    { ...valid, enhanced: "   " },
    { ...valid, segments: null },
    { ...valid, segments: [null] },
    { ...valid, segments: [{ kind: "text", text: 42 }] },
    { ...valid, segments: [{ kind: "term", text: "layout" }] },
    { ...valid, segments: [{ kind: "term", text: "layout", original: "look", note: {} }] },
    { ...valid, segments: [{ kind: "unknown", text: "layout" }] },
  ])("rejects invalid results before they reach the animation: %j", async (response) => {
    vi.mocked(invoke).mockResolvedValueOnce(response);
    await expect(enhancePrompt("Fix the look")).rejects.toThrow();
  });

  it("preserves the sidecar's useful error instead of replacing it with a validation error", async () => {
    const error = "Prompt enhancement was cut short. Your original draft has been kept.";
    vi.mocked(invoke).mockResolvedValueOnce({ error });
    await expect(enhancePrompt("Fix the look")).rejects.toThrow(error);
  });

  it("propagates native failures to the existing draft-preserving error handler", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Enhancement failed"));
    await expect(enhancePrompt("Fix the look")).rejects.toThrow("Enhancement failed");
  });
});
