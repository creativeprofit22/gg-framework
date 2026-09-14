// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { parseCancelFailure } from "./agent";

describe("parseCancelFailure", () => {
  it("preserves typed cancellation timeout evidence", () => {
    expect(
      parseCancelFailure(
        JSON.stringify({ error: "cancel_failed", reason: "timeout", runState: "running" }),
      ),
    ).toEqual({ error: "cancel_failed", reason: "timeout", runState: "running" });
  });

  it("normalizes native transport failures", () => {
    expect(parseCancelFailure("sidecar disconnected")).toEqual({
      error: "cancel_failed",
      message: "sidecar disconnected",
    });
  });
});
