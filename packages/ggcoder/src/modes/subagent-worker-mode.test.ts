import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../core/agent-session.js";
import { recoverTimedOutTurn } from "./subagent-worker-mode.js";

type RecoverySession = Pick<AgentSession, "prompt" | "setSignal">;

afterEach(() => {
  vi.useRealTimers();
});

describe("subagent timeout recovery", () => {
  it("runs exactly one tools-disabled salvage turn and keeps its summary", async () => {
    let output = "research gathered before timeout\n";
    const setSignal = vi.fn();
    const prompt = vi.fn(async () => {
      output += "best available summary";
    });
    const session = { prompt, setSignal } as unknown as RecoverySession;
    let controller: AbortController | undefined;

    await expect(
      recoverTimedOutTurn(
        session,
        () => output,
        (next) => {
          controller = next;
        },
      ),
    ).resolves.toBe(true);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(
      expect.stringContaining("one final 60-second recovery turn"),
      { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      { disableTools: true },
    );
    expect(setSignal).toHaveBeenCalledOnce();
    expect(setSignal).toHaveBeenCalledWith(controller?.signal);
    expect(controller?.signal.aborted).toBe(false);
  });

  it("aborts the single salvage turn at exactly 60 seconds", async () => {
    vi.useFakeTimers();
    let activeSignal: AbortSignal | undefined;
    const setSignal = vi.fn((signal: AbortSignal) => {
      activeSignal = signal;
    });
    const prompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          activeSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const session = { prompt, setSignal } as unknown as RecoverySession;
    let settled = false;
    const recovery = recoverTimedOutTurn(
      session,
      () => "research",
      () => undefined,
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    expect(activeSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(recovery).resolves.toBe(false);
    expect(activeSignal?.aborted).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      disableTools: true,
    });
  });
});
