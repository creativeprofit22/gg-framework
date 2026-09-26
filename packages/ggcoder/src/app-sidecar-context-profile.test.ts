import { describe, expect, it, vi } from "vitest";
import {
  parseContextProfileBody,
  runContextProfileMutation,
  runContextProfileRequest,
} from "./app-sidecar-context-profile.js";
import { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";

const state = {
  provider: "openai", model: "gpt-6-astra", accountId: "account-1",
  openAICodexContextProfileEligibility: { canChange: true as const },
};

function run(
  profile: "stable" | "experimental",
  options: {
    running?: boolean;
    activeUsage?: number;
    switchProfile?: (profile: "stable" | "experimental") => Promise<void>;
  } = {},
) {
  return runContextProfileMutation({
    profile,
    state,
    running: options.running ?? false,
    activeUsage: options.activeUsage ?? 0,
    mutations: new AppSidecarSessionMutationCoordinator(),
    switchProfile: options.switchProfile ?? vi.fn(async () => {}),
  });
}

describe("app sidecar context profile route", () => {
  it("accepts only stable and experimental profile bodies", async () => {
    expect(parseContextProfileBody({ profile: "stable" })).toBe("stable");
    expect(parseContextProfileBody({ profile: "experimental" })).toBe("experimental");
    expect(parseContextProfileBody({})).toBeNull();
    await expect(
      runContextProfileRequest({
        body: { profile: "preview" },
        state,
        running: false,
        activeUsage: 0,
        mutations: new AppSidecarSessionMutationCoordinator(),
        switchProfile: vi.fn(async () => {}),
      }),
    ).resolves.toEqual({
      status: 400,
      body: { error: 'profile must be "stable" or "experimental"' },
    });
  });

  it("selects the experimental profile and returns its context window", async () => {
    const switchProfile = vi.fn(async () => {});
    await expect(run("experimental", { switchProfile })).resolves.toEqual({
      status: 200,
      body: {
        openAICodexContextProfile: "experimental",
        contextWindow: 872_000,
      },
    });
    expect(switchProfile).toHaveBeenCalledWith("experimental");
  });

  it("leaves public API-key Astra sessions on their existing context behavior", async () => {
    await expect(
      runContextProfileMutation({
        profile: "experimental",
        state: { provider: "openai", model: "gpt-6-astra" },
        running: false,
        activeUsage: 0,
        mutations: new AppSidecarSessionMutationCoordinator(),
        switchProfile: vi.fn(async () => {}),
      }),
    ).resolves.toEqual({
      status: 409,
      body: {
        error: "Context profiles are available only for GPT-6 Astra through OpenAI Codex OAuth.",
      },
    });
  });

  it("refuses changes while the agent is running", async () => {
    const switchProfile = vi.fn(async () => {});
    await expect(run("experimental", { running: true, switchProfile })).resolves.toEqual({
      status: 409,
      body: { error: "Cannot change context profile while the agent is running." },
    });
    expect(switchProfile).not.toHaveBeenCalled();
  });

  it("refuses lowering below active usage", async () => {
    const switchProfile = vi.fn(async () => {});
    const result = await run("stable", { activeUsage: 300_000, switchProfile });
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("Compact or start a new session first.");
    expect(switchProfile).not.toHaveBeenCalled();
  });

  it("returns typed history locks, fails closed without eligibility, and keeps same-profile requests idempotent", async () => {
    for (const eligibility of [undefined, { canChange: false as const, reason: "history started" }]) {
      const mutations = new AppSidecarSessionMutationCoordinator();
      const switchProfile = vi.fn(async () => {});
      const options = {
        state: { ...state, openAICodexContextProfile: "stable" as const, openAICodexContextProfileEligibility: eligibility },
        running: false, activeUsage: 0, mutations, switchProfile,
      };
      expect(await runContextProfileRequest({ ...options, body: { profile: "experimental" } }))
        .toMatchObject({ status: 409, body: { error: "context_profile_locked" } });
      expect(switchProfile).not.toHaveBeenCalled();
      expect(mutations.owner).toBeNull();
      expect((await runContextProfileRequest({ ...options, body: { profile: "stable" } })).status).toBe(200);
    }
  });

  it("reports persistence failures without changing the response state", async () => {
    const result = await run("experimental", {
      switchProfile: vi.fn(async () => {
        throw new Error("session file is read-only");
      }),
    });
    expect(result).toEqual({
      status: 500,
      body: { error: "Could not save the context profile: session file is read-only" },
    });
  });
});
