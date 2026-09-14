import { describe, expect, it, vi } from "vitest";
import {
  parseOpenAICodexFastBody,
  runOpenAICodexFastMutation,
  runOpenAICodexFastRequest,
} from "./app-sidecar-fast.js";
import { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";

const eligibleState = {
  provider: "openai",
  model: "gpt-6-astra",
  accountId: "account-1",
};

function run(
  enabled: boolean,
  options: {
    state?: typeof eligibleState;
    running?: boolean;
    mutations?: AppSidecarSessionMutationCoordinator;
    switchFast?: (enabled: boolean) => Promise<void>;
  } = {},
) {
  return runOpenAICodexFastMutation({
    enabled,
    state: options.state ?? eligibleState,
    running: options.running ?? false,
    mutations: options.mutations ?? new AppSidecarSessionMutationCoordinator(),
    switchFast: options.switchFast ?? vi.fn(async () => {}),
  });
}

describe("app sidecar OpenAI Codex Fast route", () => {
  it("accepts only boolean bodies", async () => {
    expect(parseOpenAICodexFastBody({ enabled: true })).toBe(true);
    expect(parseOpenAICodexFastBody({ enabled: false })).toBe(false);
    expect(parseOpenAICodexFastBody({ enabled: "true" })).toBeNull();
    await expect(
      runOpenAICodexFastRequest({
        body: {},
        state: eligibleState,
        running: false,
        mutations: new AppSidecarSessionMutationCoordinator(),
        switchFast: vi.fn(async () => {}),
      }),
    ).resolves.toEqual({ status: 400, body: { error: "enabled must be a boolean" } });
  });

  it("persists an eligible setting before returning it", async () => {
    let persisted = false;
    await expect(
      run(true, { switchFast: vi.fn(async (enabled) => void (persisted = enabled)) }),
    ).resolves.toEqual({ status: 200, body: { openAICodexFast: true } });
    expect(persisted).toBe(true);
  });

  it.each([
    { provider: "anthropic", model: "gpt-6-astra", accountId: "account-1" },
    { provider: "openai", model: "gpt-5.6-sol", accountId: "account-1" },
    { provider: "openai", model: "gpt-6-astra", accountId: undefined },
  ])("rejects unsupported session state %#", async (state) => {
    const switchFast = vi.fn(async () => {});
    const result = await run(true, { state: state as typeof eligibleState, switchFast });
    expect(result.status).toBe(409);
    expect(switchFast).not.toHaveBeenCalled();
  });

  it("rejects busy and conflicting mutations", async () => {
    expect((await run(true, { running: true })).status).toBe(409);
    const mutations = new AppSidecarSessionMutationCoordinator(() => "operation-1");
    const lease = mutations.tryAcquire("context-profile");
    expect(await run(true, { mutations })).toEqual({
      status: 409,
      body: {
        error: "session_mutation_in_progress",
        owner: { operationId: "operation-1", kind: "context-profile" },
      },
    });
    lease?.release();
  });

  it("leaves state unchanged and releases its lease after persistence failure", async () => {
    const mutations = new AppSidecarSessionMutationCoordinator(() => "operation-2");
    const result = await run(true, {
      mutations,
      switchFast: vi.fn(async () => {
        throw new Error("session file is read-only");
      }),
    });
    expect(result).toEqual({
      status: 500,
      body: { error: "Could not save Fast: session file is read-only" },
    });
    expect(mutations.owner).toBeNull();
  });
});
