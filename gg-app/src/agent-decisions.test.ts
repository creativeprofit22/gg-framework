import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: vi.fn(async () => vi.fn()) }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import { getVerifiedDecisions, startLocalPatchedUpdate } from "./agent";

beforeEach(() => invoke.mockReset());

describe("decisions IPC bridge", () => {
  it("loads verified decision records from the requested source checkout", async () => {
    const records = [
      {
        id: "decision-abc",
        date: "2026-08-24",
        summary: {
          text: "Your local behavior remains available after the protected update.",
          source: "agent",
          generatedAt: "2026-08-24T10:00:15.000Z",
        },
        verification: { workflowVerified: true },
        decisions: [
          {
            area: "gg-app/src/WhatsNewWindow",
            outcome: "combined",
            files: [{ path: "gg-app/src/WhatsNewWindow.tsx" }],
          },
        ],
      },
    ];
    invoke.mockResolvedValue(records);

    await expect(getVerifiedDecisions("C:/source")).resolves.toEqual(records);
    expect(invoke).toHaveBeenCalledWith("app_verified_decisions", {
      repoRoot: "C:/source",
    });
  });

  it("passes explicit summary consent through native IPC", async () => {
    invoke.mockResolvedValue({ started: true });
    await startLocalPatchedUpdate("C:/source", true);
    expect(invoke).toHaveBeenCalledWith("app_local_patched_update_start", {
      repoRoot: "C:/source",
      summarizeDecisions: true,
    });
  });

  it.each([
    undefined,
    { text: "short", source: "agent", generatedAt: "2026-08-24T10:00:15.000Z" },
    {
      text: "Your local behavior remains available after the protected update.",
      source: "provider",
      generatedAt: "2026-08-24T10:00:15.000Z",
    },
    {
      text: "Your local behavior remains available after the protected update.",
      source: "fallback",
      generatedAt: "bad-date",
    },
  ])("rejects a malformed summary object", async (summary) => {
    invoke.mockResolvedValue([
      {
        id: "decision-abc",
        date: "2026-08-24",
        summary,
        verification: { workflowVerified: true },
        decisions: [],
      },
    ]);
    await expect(getVerifiedDecisions("C:/source")).rejects.toThrow("invalid decisions response");
  });

  it("rejects unverified or malformed native responses", async () => {
    invoke.mockResolvedValue([
      {
        id: "decision-abc",
        date: "not-a-date",
        verification: { workflowVerified: false },
        decisions: [],
      },
    ]);

    await expect(getVerifiedDecisions("C:/source")).rejects.toThrow("invalid decisions response");
  });
});
