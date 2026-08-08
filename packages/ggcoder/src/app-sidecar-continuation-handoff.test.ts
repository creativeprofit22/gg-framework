import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";
import {
  AppSidecarContinuationHandoffService,
  CONTINUATION_HANDOFF_SYSTEM_PROMPT,
  type ContinuationSynthesisSession,
  type ContinuationSynthesisSessionOptions,
} from "./app-sidecar-continuation-handoff.js";

const contract = {
  objective: "Finish the fresh-session handoff.",
  verifiedWork: ["Contract tests passed."],
  decisions: [],
  constraints: ["Do not alter Continue here."],
  repositoryCoordinates: [],
  artifactPaths: [],
  unresolvedIssues: [],
  nextAtomicStep: "Wire the route.",
};

function sourceSession() {
  return {
    getMessages: (): Message[] => [{ role: "user", content: "Implement the handoff" }],
    getState: () => ({
      provider: "anthropic" as const,
      model: "claude-test",
      cwd: "/repo",
      sessionPath: "/sessions/source.jsonl",
    }),
  };
}

function fakeSynthesisSession(options: {
  response?: string;
  promptError?: Error;
  disposeError?: Error;
}) {
  const initialize = vi.fn(async () => {});
  const prompt = vi.fn(async () => {
    if (options.promptError) throw options.promptError;
  });
  const dispose = vi.fn(async () => {
    if (options.disposeError) throw options.disposeError;
  });
  const messages: Message[] = options.response
    ? [{ role: "assistant", content: options.response }]
    : [];
  const session: ContinuationSynthesisSession = {
    initialize,
    prompt,
    getMessages: () => messages,
    dispose,
  };
  return { session, initialize, prompt, dispose };
}

describe("AppSidecarContinuationHandoffService", () => {
  it("runs one transient no-tool synthesis and appends the exact instruction", async () => {
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
      coderSlashCommands: false,
      selfCorrectionHooks: false,
      loadExtensions: false,
      orchestrationPrompt: false,
      mcpEnabled: false,
      maxTurns: 1,
      maxTurnExtensions: 0,
    });
    expect(fake.initialize).toHaveBeenCalledOnce();
    expect(fake.prompt).toHaveBeenCalledOnce();
    expect(fake.prompt).toHaveBeenCalledWith(
      expect.stringContaining('"sourceSessionPath":"/sessions/source.jsonl"'),
      { source: "runtime", kind: "automation", visibility: "hidden" },
      { disableTools: true },
    );
    expect(result.version).toBe(1);
    expect(result.handoff).toEqual(contract);
    expect(result.prompt.endsWith(`## Ken’s next instruction\n${instruction}`)).toBe(true);
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("fails closed on provider failure and always disposes", async () => {
    const fake = fakeSynthesisSession({ promptError: new Error("provider unavailable") });
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    await expect(service.prepare(sourceSession(), "Continue")).rejects.toThrow(
      "provider unavailable",
    );
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("preserves the primary synthesis failure when disposal also fails", async () => {
    const fake = fakeSynthesisSession({
      promptError: new Error("provider unavailable"),
      disposeError: new Error("dispose failed"),
    });
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    await expect(service.prepare(sourceSession(), "Continue")).rejects.toThrow(
      "provider unavailable",
    );
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces disposal failure after successful synthesis", async () => {
    const fake = fakeSynthesisSession({
      response: JSON.stringify(contract),
      disposeError: new Error("dispose failed"),
    });
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    await expect(service.prepare(sourceSession(), "Continue")).rejects.toThrow("dispose failed");
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("rejects invalid synthesis output and always disposes", async () => {
    const fake = fakeSynthesisSession({ response: '{"objective":"unsupported partial"}' });
    const service = new AppSidecarContinuationHandoffService({
      createSynthesisSession: () => fake.session,
    });

    await expect(service.prepare(sourceSession(), "Continue")).rejects.toThrow("invalid contract");
    expect(fake.dispose).toHaveBeenCalledOnce();
  });
});
