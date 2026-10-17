import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXIT_TIMEOUT_MS,
  EXIT_TIMEOUT_ENV,
  exitCodeForSignal,
  installTerminationHandlers,
  resolveExitTimeoutMs,
  shutdownWithDeadline,
} from "./shutdown.js";

/** Stands in for `process.exit`: records the code and stops execution the way
 *  the real thing does, so code after it never runs in the test either. */
function fakeExit(): { codes: number[]; exit: (code: number) => never } {
  const codes: number[] = [];
  return {
    codes,
    exit: ((code: number) => {
      codes.push(code);
      throw new ExitSignal(code);
    }) as (code: number) => never,
  };
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

async function swallowExit(promise: Promise<unknown>): Promise<void> {
  await promise.catch((error) => {
    if (!(error instanceof ExitSignal)) throw error;
  });
}

describe("resolveExitTimeoutMs", () => {
  it("defaults when unset", () => {
    expect(resolveExitTimeoutMs({})).toBe(DEFAULT_EXIT_TIMEOUT_MS);
  });

  it("reads seconds from the environment", () => {
    expect(resolveExitTimeoutMs({ [EXIT_TIMEOUT_ENV]: "2" })).toBe(2000);
    expect(resolveExitTimeoutMs({ [EXIT_TIMEOUT_ENV]: "0.5" })).toBe(500);
  });

  it("treats an explicit zero as 'no deadline'", () => {
    expect(resolveExitTimeoutMs({ [EXIT_TIMEOUT_ENV]: "0" })).toBe(0);
  });

  it("falls back to the default on garbage rather than disabling the guard", () => {
    // A typo in a launcher script must not reintroduce an unbounded hang.
    expect(resolveExitTimeoutMs({ [EXIT_TIMEOUT_ENV]: "soon" })).toBe(DEFAULT_EXIT_TIMEOUT_MS);
    expect(resolveExitTimeoutMs({ [EXIT_TIMEOUT_ENV]: "-3" })).toBe(DEFAULT_EXIT_TIMEOUT_MS);
    expect(resolveExitTimeoutMs({ [EXIT_TIMEOUT_ENV]: "" })).toBe(DEFAULT_EXIT_TIMEOUT_MS);
  });

  it("clamps absurd overrides", () => {
    expect(resolveExitTimeoutMs({ [EXIT_TIMEOUT_ENV]: "99999" })).toBe(120_000);
  });
});

describe("exitCodeForSignal", () => {
  it("uses the conventional 128 + signal number", () => {
    expect(exitCodeForSignal("SIGHUP")).toBe(129);
    expect(exitCodeForSignal("SIGINT")).toBe(130);
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
  });
});

describe("shutdownWithDeadline", () => {
  it("exits as soon as teardown finishes", async () => {
    const { codes, exit } = fakeExit();
    await swallowExit(
      shutdownWithDeadline(0, { teardown: async () => {}, timeoutMs: 10_000, exit }),
    );
    expect(codes).toEqual([0]);
  });

  it("exits on the deadline when teardown never settles", async () => {
    vi.useFakeTimers();
    try {
      const { codes, exit } = fakeExit();
      const onTimeout = vi.fn();
      // A hung MCP server: the promise simply never resolves.
      void shutdownWithDeadline(129, {
        teardown: () => new Promise<void>(() => {}),
        timeoutMs: 2000,
        onTimeout,
        exit,
      }).catch(() => {});
      expect(codes).toEqual([]);
      vi.advanceTimersByTime(1999);
      expect(codes).toEqual([]);
      // The fake exit throws from inside the timer callback; the real one just
      // never returns.
      expect(() => vi.advanceTimersByTime(1)).toThrow(ExitSignal);
      expect(codes).toEqual([129]);
      expect(onTimeout).toHaveBeenCalledWith(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still exits when teardown throws", async () => {
    const { codes, exit } = fakeExit();
    const onError = vi.fn();
    await swallowExit(
      shutdownWithDeadline(0, {
        teardown: () => {
          throw new Error("extension deactivate blew up");
        },
        timeoutMs: 10_000,
        onError,
        exit,
      }),
    );
    expect(codes).toEqual([0]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not arm a timer when the deadline is disabled", async () => {
    vi.useFakeTimers();
    try {
      const { codes, exit } = fakeExit();
      void shutdownWithDeadline(0, {
        teardown: () => new Promise<void>(() => {}),
        timeoutMs: 0,
        exit,
      }).catch(() => {});
      vi.advanceTimersByTime(600_000);
      expect(codes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installTerminationHandlers", () => {
  it("tears down once no matter how many requests arrive", async () => {
    const { codes, exit } = fakeExit();
    const teardown = vi.fn(async () => {});
    const requestShutdown = installTerminationHandlers({ teardown, timeoutMs: 10_000, exit });
    requestShutdown(0);
    requestShutdown(0);
    await vi.waitFor(() => expect(codes).toEqual([0]));
    expect(teardown).toHaveBeenCalledOnce();
    removeInstalledHandlers();
  });

  it("exits immediately on a second signal instead of waiting out the deadline", async () => {
    const { codes, exit } = fakeExit();
    installTerminationHandlers({
      teardown: () => new Promise<void>(() => {}),
      timeoutMs: 10_000,
      exit,
    });
    // First Ctrl+C starts bounded teardown; the second says "stop waiting".
    expect(() => process.emit("SIGINT")).not.toThrow();
    expect(codes).toEqual([]);
    expect(() => process.emit("SIGINT")).toThrow(ExitSignal);
    expect(codes).toEqual([130]);
    removeInstalledHandlers();
  });

  it("handles SIGHUP, the signal a closed terminal sends exactly once", () => {
    const { codes, exit } = fakeExit();
    const teardown = vi.fn(() => new Promise<void>(() => {}));
    installTerminationHandlers({ teardown, timeoutMs: 10_000, exit });
    process.emit("SIGHUP");
    expect(teardown).toHaveBeenCalledOnce();
    expect(codes).toEqual([]);
    removeInstalledHandlers();
  });
});

/** Signal listeners are process-global; leaving them installed leaks across
 *  tests and eventually trips Node's max-listeners warning. */
function removeInstalledHandlers(): void {
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGHUP");
}
