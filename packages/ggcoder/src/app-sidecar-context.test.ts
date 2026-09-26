import type { DesktopContextSnapshot } from "@kenkaiiii/gg-core";
import type { DesktopSessionUXState } from "@kenkaiiii/gg-core/desktop-session-ux";
import { describe, expect, it, vi } from "vitest";
import {
  getAgentSessionContextSnapshot,
  getAgentSessionContextWindow,
} from "./app-sidecar-context.js";

describe("app sidecar context snapshot", () => {
  it("uses one authoritative active-usage snapshot", () => {
    const getContextUsage = vi.fn(() => ({ used: 300_000, size: 872_000 }));
    const snapshot = getAgentSessionContextSnapshot({
      getState: () => ({
        accountId: "account-1",
        openAICodexContextProfile: "experimental",
        openAICodexFast: true,
        openAICodexContextProfileEligibility: {
          canChange: false,
          reason:
            "Context mode is fixed after this session starts. Start a new session to change it.",
        },
      }),
      getContextUsage,
    });

    expect(snapshot).toEqual({
      accountId: "account-1",
      openAICodexContextProfile: "experimental",
      openAICodexFast: true,
      openAICodexContextProfileEligibility: {
        canChange: false,
        reason:
          "Context mode is fixed after this session starts. Start a new session to change it.",
      },
      contextTokens: 300_000,
      contextWindow: 872_000,
    });
    expect(getContextUsage).toHaveBeenCalledOnce();
  });

  it("matches the shared desktop context snapshot shape", () => {
    const snapshot: DesktopContextSnapshot & DesktopSessionUXState = getAgentSessionContextSnapshot(
      {
        getState: () => ({
          accountId: undefined,
          openAICodexContextProfile: "stable",
          openAICodexFast: false,
          openAICodexContextProfileEligibility: { canChange: true },
        }),
        getContextUsage: () => ({ used: 0, size: 272_000 }),
      },
    );

    expect(snapshot).toEqual({
      accountId: null,
      openAICodexContextProfile: "stable",
      openAICodexFast: false,
      openAICodexContextProfileEligibility: { canChange: true },
      contextTokens: 0,
      contextWindow: 272_000,
    });
  });

  it("keeps context-window resolution available for state-only callers", () => {
    expect(
      getAgentSessionContextWindow({
        provider: "openai",
        model: "gpt-6-astra",
        accountId: "account-1",
        openAICodexContextProfile: "stable",
      }),
    ).toBe(272_000);
  });
});
