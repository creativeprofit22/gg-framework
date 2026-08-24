import type { Message } from "@kenkaiiii/gg-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppSidecarContinuationHandoffService,
  CONTINUATION_HANDOFF_SYNTHESIS_TIMEOUT_MS,
  CONTINUATION_HANDOFF_SYSTEM_PROMPT,
  type ContinuationSynthesisSession,
  type ContinuationSynthesisSessionOptions,
} from "./app-sidecar-continuation-handoff.js";

const contract = {
  currentObjective: "Implement the active-context handoff. It must keep version 1.",
  currentStatus: [],
  relevantDecisions: ["Implement the active-context handoff. It must keep version 1."],
  relevantFiles: [],
};

function sourceSession() {
  return {
    getMessages: (): Message[] => [
      { role: "user", content: "Earlier objective." },
      { role: "user", content: "Implement the active-context handoff. It must keep version 1." },
      { role: "assistant", content: "Core work is in progress." },
    ],
    getState: () => ({
      provider: "anthropic" as const,
      model: "claude-test",
      cwd: "/repo",
      sessionPath: "/sessions/source.jsonl",
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeSynthesisSession(options: {
  response?: string;
  initializeError?: Error;
  initializeDeferred?: ReturnType<typeof deferred<void>>;
  promptError?: Error;
  promptDeferred?: ReturnType<typeof deferred<void>>;
  disposeDeferred?: ReturnType<typeof deferred<void>>;
  disposeError?: Error;
  onInitializeSettled?: () => void;
  onPromptSettled?: () => void;
  onDispose?: () => void;
}) {
  const initialize = vi.fn(async () => {
    if (options.initializeError) throw options.initializeError;
    if (options.initializeDeferred) await options.initializeDeferred.promise;
    options.onInitializeSettled?.();
  });
  const prompt = vi.fn(
    async (
      _content: string,
      _provenance?: { source: "runtime"; kind: "automation"; visibility: "hidden" },
      _promptOptions?: { disableTools?: boolean },
    ) => {
      if (options.promptError) throw options.promptError;
      if (options.promptDeferred) await options.promptDeferred.promise;
      options.onPromptSettled?.();
    },
  );
  const dispose = vi.fn(async () => {
    options.onDispose?.();
    if (options.disposeError) throw options.disposeError;
    if (options.disposeDeferred) await options.disposeDeferred.promise;
  });
  const messages: Message[] =
    options.response === undefined ? [] : [{ role: "assistant", content: options.response }];
  const session: ContinuationSynthesisSession = {
    initialize,
    prompt,
    getMessages: () => messages,
    dispose,
  };
  return { session, initialize, prompt, dispose };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AppSidecarContinuationHandoffService", () => {
  it("runs focused transient synthesis and appends the exact next action", async () => {
    const fake = fakeSynthesisSession({ response: JSON.stringify(contract) });
    let creationOptions: ContinuationSynthesisSessionOptions | undefined;
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: (options) => {
        creationOptions = options;
        return fake.session;
      },
    });
    const instruction = "Continue exactly.\nKeep this spacing.  ";

    const result = await service.prepare(sourceSession(), instruction);

    expect(creationOptions).toMatchObject({
      provider: "anthropic",
      model: "claude-test",
      cwd: "/repo",
      systemPrompt: CONTINUATION_HANDOFF_SYSTEM_PROMPT,
      transient: true,
      allowedTools: [],
      projectCustomization: false,
      globalSubagents: false,
      coderSlashCommands: false,
      selfCorrectionHooks: false,
      loadExtensions: false,
      orchestrationPrompt: false,
      mcpEnabled: false,
      maxTurns: 1,
      maxTurnExtensions: 0,
    });
    expect(creationOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(fake.initialize).toHaveBeenCalledOnce();
    expect(fake.prompt).toHaveBeenCalledWith(
      expect.stringContaining(
        '"objectives":["Earlier objective.","Implement the active-context handoff.',
      ),
      { source: "runtime", kind: "automation", visibility: "hidden" },
      { disableTools: true },
    );
    expect(fake.prompt.mock.calls[0]?.[0]).not.toContain("/sessions/source.jsonl");
    expect(result).toMatchObject({ version: 1, handoff: contract });
    const marker = "## Immediate next action\n";
    expect(result.prompt.slice(result.prompt.indexOf(marker) + marker.length)).toBe(instruction);
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["initialization", { initializeError: new Error("initialization failed") }],
    ["provider", { promptError: new Error("provider unavailable") }],
  ])("returns fallback after %s failure", async (_label, failure) => {
    const fake = fakeSynthesisSession(failure);
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    const result = await service.prepare(sourceSession(), "Continue");

    expect(result.handoff.currentObjective).toBe(
      "Implement the active-context handoff. It must keep version 1.",
    );
    expect(result.prompt).toContain("## Immediate next action\nContinue");
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty", ""],
    ["malformed", "{not-json"],
    ["invalid", '{"currentObjective":"partial"}'],
    ["older objective", JSON.stringify({ ...contract, currentObjective: "Earlier objective." })],
  ])("returns fallback after %s synthesis output", async (_label, response) => {
    const fake = fakeSynthesisSession({ response });
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    const result = await service.prepare(sourceSession(), "Continue");

    expect(result.handoff.currentObjective).toBe(
      "Implement the active-context handoff. It must keep version 1.",
    );
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("aborts, waits for prompt settlement, then disposes", async () => {
    vi.useFakeTimers();
    const promptDeferred = deferred<void>();
    const events: string[] = [];
    const fake = fakeSynthesisSession({
      promptDeferred,
      onPromptSettled: () => events.push("prompt settled"),
      onDispose: () => events.push("dispose"),
    });
    let signal: AbortSignal | undefined;
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: (options) => {
        signal = options.signal;
        return fake.session;
      },
    });

    const preparation = service.prepare(sourceSession(), "Continue after timeout");
    await vi.advanceTimersByTimeAsync(CONTINUATION_HANDOFF_SYNTHESIS_TIMEOUT_MS);

    expect(signal?.aborted).toBe(true);
    expect(fake.dispose).not.toHaveBeenCalled();
    promptDeferred.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const result = await preparation;

    expect(events).toEqual(["prompt settled", "dispose"]);
    expect(result.handoff.currentObjective).toBe(
      "Implement the active-context handoff. It must keep version 1.",
    );
    expect(result.prompt).toContain("## Immediate next action\nContinue after timeout");
  });

  it("waits for deferred initialization before disposal and never starts prompting", async () => {
    vi.useFakeTimers();
    const initializeDeferred = deferred<void>();
    const events: string[] = [];
    const fake = fakeSynthesisSession({
      initializeDeferred,
      onInitializeSettled: () => events.push("initialize settled"),
      onDispose: () => events.push("dispose"),
    });
    let signal: AbortSignal | undefined;
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: (options) => {
        signal = options.signal;
        return fake.session;
      },
    });

    const preparation = service.prepare(sourceSession(), "Continue after initialization timeout");
    await vi.advanceTimersByTimeAsync(CONTINUATION_HANDOFF_SYNTHESIS_TIMEOUT_MS);

    expect(signal?.aborted).toBe(true);
    expect(fake.prompt).not.toHaveBeenCalled();
    expect(fake.dispose).not.toHaveBeenCalled();
    initializeDeferred.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await preparation;

    expect(events).toEqual(["initialize settled", "dispose"]);
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it("bounds prompt settlement cleanup without disposing an in-flight session", async () => {
    vi.useFakeTimers();
    const promptDeferred = deferred<void>();
    const fake = fakeSynthesisSession({ promptDeferred });
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    const preparation = service.prepare(sourceSession(), "Continue after bounded cleanup");
    await vi.runAllTimersAsync();
    const result = await preparation;

    expect(result.prompt).toContain("## Immediate next action\nContinue after bounded cleanup");
    expect(fake.dispose).not.toHaveBeenCalled();

    promptDeferred.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("bounds disposal cleanup", async () => {
    vi.useFakeTimers();
    const fake = fakeSynthesisSession({
      response: JSON.stringify(contract),
      disposeDeferred: deferred<void>(),
    });
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    const preparation = service.prepare(sourceSession(), "Continue after bounded disposal");
    await vi.runAllTimersAsync();
    const result = await preparation;

    expect(result.handoff).not.toEqual(contract);
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("returns fallback when disposal fails after valid synthesis", async () => {
    const fake = fakeSynthesisSession({
      response: JSON.stringify(contract),
      disposeError: new Error("dispose failed"),
    });
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    const result = await service.prepare(sourceSession(), "Continue");

    expect(result.handoff.currentObjective).toBe(
      "Implement the active-context handoff. It must keep version 1.",
    );
    expect(result.handoff).not.toEqual(contract);
    expect(fake.dispose).toHaveBeenCalledOnce();
  });
});
