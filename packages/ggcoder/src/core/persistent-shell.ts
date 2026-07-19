/**
 * Persistent bash session for the bash tool's opt-in `persist` mode.
 *
 * One long-lived bash per instance; commands are written to stdin and
 * delimited with a sentinel that carries the exit code. Benchmarked at ~0.3ms
 * per call vs ~6.4ms for spawn-per-call (see bash-spawn-benchmark.ts), and —
 * the real win — cd/env/shell state survive across calls.
 *
 * POSIX-only (needs a real bash). Callers must fall back to spawn-per-call
 * when bash is unavailable (Windows cmd.exe fallback path).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killProcessTreeAsync } from "../utils/process.js";
import { log } from "./logger.js";

export interface PersistentRunResult {
  exitCode: number | "TIMEOUT" | "ABORTED";
  output: string;
}

export class PersistentShell {
  private child: ChildProcess | null = null;
  private buffer = "";
  private busy = false;

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly maxOutputBytes: number,
    private readonly cleanupProcessTree: (pid: number) => Promise<void> = killProcessTreeAsync,
  ) {}

  private startCleanup(pid: number): void {
    void Promise.resolve()
      .then(() => this.cleanupProcessTree(pid))
      .catch((error: unknown) => {
        log("WARN", "bash", "Persistent process-tree cleanup failed", {
          pid: String(pid),
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** True while a previous persistent command is still running. */
  get isBusy(): boolean {
    return this.busy;
  }

  private ensureChild(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    // Fresh session: no rc files so startup is fast and deterministic.
    const child = spawn("bash", ["--norc", "--noprofile"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      detached: true,
    });
    // Don't let a lingering session shell keep the parent process alive.
    child.unref();
    this.child = child;
    this.buffer = "";
    return child;
  }

  /**
   * Run one command in the session shell. Serialized by the tool's sequential
   * execution mode; a concurrent call while busy is rejected defensively.
   * On timeout or abort the whole session is killed (state is gone — the next
   * call starts a fresh shell) because a wedged command cannot be safely
   * skipped within the same shell.
   */
  run(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (text: string) => void,
  ): Promise<PersistentRunResult> {
    if (this.busy) {
      return Promise.resolve({
        exitCode: 1,
        output: "persistent shell is busy with a previous command",
      });
    }
    this.busy = true;
    const child = this.ensureChild();
    const sentinel = `__GG_PSH_${randomUUID()}__`;
    // `</dev/null` keeps stdin-reading commands (cat, read) from eating the
    // next sentinel line instead of hanging the session.
    const wrapped = `{ ${command}\n} </dev/null; echo "${sentinel}$?"\n`;

    return new Promise<PersistentRunResult>((resolve) => {
      let out = "";
      let capped = false;
      let done = false;

      const finish = (result: PersistentRunResult): void => {
        if (done) return;
        done = true;
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.busy = false;
        resolve(result);
      };

      // When output is capped we stop growing `out` but MUST keep scanning for
      // the sentinel — otherwise an over-cap command hangs until timeout and
      // needlessly destroys the session. `scanTail` keeps a small rolling
      // window across chunk boundaries so a split sentinel is still found.
      let scanTail = "";
      const checkSentinel = (scan: string, fromCapped: boolean): void => {
        const idx = scan.indexOf(sentinel);
        if (idx === -1) return;
        const code = parseInt(scan.slice(idx + sentinel.length), 10);
        const body = fromCapped ? out : scan.slice(0, idx);
        finish({
          exitCode: Number.isNaN(code) ? 1 : code,
          output:
            body.replace(/\n$/, "") +
            (fromCapped ? `\n[Output capped at ${this.maxOutputBytes} bytes]` : ""),
        });
      };

      const onData = (d: Buffer): void => {
        const text = d.toString("utf-8");
        if (capped) {
          scanTail = (scanTail + text).slice(-(sentinel.length + 16));
          checkSentinel(scanTail, true);
          return;
        }
        out += text;
        if (out.length > this.maxOutputBytes) {
          capped = true;
          scanTail = out.slice(-(sentinel.length + 16));
          out = out.slice(0, this.maxOutputBytes);
        }
        onChunk?.(text);
        checkSentinel(capped ? scanTail : out, capped);
      };

      const interrupt = (result: PersistentRunResult): void => {
        if (done) return;
        if (this.child === child) this.child = null;
        if (child.pid !== undefined) this.startCleanup(child.pid);
        finish(result);
      };
      const onAbort = (): void => interrupt({ exitCode: "ABORTED", output: out });

      // `exit N` (or a crash) ends the session shell itself — the sentinel
      // never prints, so settle from the shell's own exit code. The next run()
      // starts a fresh session.
      const onExit = (code: number | null): void => {
        if (this.child === child) this.child = null;
        finish({ exitCode: code ?? 1, output: out.replace(/\n$/, "") });
      };
      const onError = (): void => {
        if (this.child === child) this.child = null;
        finish({ exitCode: 1, output: "failed to spawn session bash" });
      };

      const timer = setTimeout(() => {
        interrupt({ exitCode: "TIMEOUT", output: out });
      }, timeoutMs);

      child.on("exit", onExit);
      child.on("error", onError);
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      if (!done) child.stdin?.write(wrapped);
    });
  }

  /** Kill the session shell; the next run() starts a fresh one. */
  kill(): void {
    const childToKill = this.child;
    this.child = null;
    this.busy = false;
    if (childToKill?.pid) this.startCleanup(childToKill.pid);
  }
}
