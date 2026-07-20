import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { killProcessTree } from "../utils/process.js";
import { getSafeToolEnv } from "../tools/safe-env.js";
import { resolveShell } from "./shell.js";

export interface BackgroundProcess {
  id: string;
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  exitCode: number | null;
  lastReadOffset: number;
}

export interface StartResult {
  id: string;
  pid: number;
  logFile: string;
}

export interface ReadOutputResult {
  id: string;
  isRunning: boolean;
  exitCode: number | null;
  output: string;
}

const BG_DIR = path.join(os.homedir(), ".gg", "bg");

export interface ProcessManagerOps {
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  killProcessTree?: (pid: number) => void;
}

function stopProcessTree(pid: number, ops: ProcessManagerOps = {}): void {
  if (ops.killProcessTree) {
    ops.killProcessTree(pid);
    return;
  }
  killProcessTree(pid, { platform: ops.platform, kill: ops.kill });
}

export class ProcessManager {
  private processes = new Map<string, BackgroundProcess>();
  private children = new Map<string, ChildProcess>();

  constructor(private readonly ops: ProcessManagerOps = {}) {}

  async start(command: string, cwd: string): Promise<StartResult> {
    await fsp.mkdir(BG_DIR, { recursive: true });

    const id = crypto.randomUUID().slice(0, 8);
    const logFile = path.join(BG_DIR, `${id}.log`);
    const fd = fs.openSync(logFile, "w");

    // Cross-platform shell (see core/shell.ts): bash on POSIX, Git Bash on
    // Windows, cmd.exe fallback. Same resolution as the foreground bash tool.
    const shell = resolveShell(command);
    const child = spawn(shell.file, shell.args, {
      cwd,
      detached: true,
      // stdin is a pipe so callers can drive interactive processes (REPLs,
      // scaffolders, [Y/n] prompts) via sendInput(); stdout/stderr go to the log.
      stdio: ["pipe", fd, fd],
      env: getSafeToolEnv(),
    });

    fs.closeSync(fd);

    // Swallow EPIPE: writing to a process that has already exited would
    // otherwise emit an unhandled 'error' and crash the host.
    child.stdin?.on("error", () => {});

    const pid = child.pid!;
    child.unref();

    const proc: BackgroundProcess = {
      id,
      pid,
      command,
      logFile,
      startedAt: Date.now(),
      exitCode: null,
      lastReadOffset: 0,
    };

    this.processes.set(id, proc);
    this.children.set(id, child);

    child.on("close", (code) => {
      proc.exitCode = code ?? 1;
      this.children.delete(id);
    });

    return { id, pid, logFile };
  }

  async readOutput(id: string, fromStart?: boolean): Promise<ReadOutputResult> {
    const proc = this.processes.get(id);
    if (!proc) {
      return {
        id,
        isRunning: false,
        exitCode: null,
        output: `No background process with id "${id}"`,
      };
    }

    const offset = fromStart ? 0 : proc.lastReadOffset;
    let output = "";

    try {
      const stat = await fsp.stat(proc.logFile);
      if (stat.size > offset) {
        const buf = Buffer.alloc(stat.size - offset);
        const fh = await fsp.open(proc.logFile, "r");
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        await fh.close();
        output = buf.subarray(0, bytesRead).toString("utf-8");
        proc.lastReadOffset = offset + bytesRead;
      }
    } catch {
      output = "(failed to read log file)";
    }

    const isRunning = this.children.has(id);
    return { id, isRunning, exitCode: proc.exitCode, output };
  }

  /**
   * Write input to a running background process's stdin, enabling interactive
   * control (answer prompts, drive a REPL, feed a scaffolder). By default a
   * newline is appended (as if the user pressed Enter). Set `eof` to close
   * stdin afterwards, signalling end-of-input (Ctrl-D) to the program.
   */
  async sendInput(
    id: string,
    input: string,
    opts: { enter?: boolean; eof?: boolean } = {},
  ): Promise<string> {
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child || proc.exitCode !== null) {
      return `Process ${id} already exited (code ${proc.exitCode})`;
    }

    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return `Process ${id} is not accepting input (stdin is closed).`;
    }

    const enter = opts.enter ?? true;
    const text = input + (enter ? "\n" : "");

    try {
      if (text.length > 0) {
        await new Promise<void>((resolve, reject) => {
          stdin.write(text, (err) => (err ? reject(err) : resolve()));
        });
      }
      if (opts.eof) stdin.end();
    } catch (err) {
      return `Failed to send input to ${id}: ${(err as Error).message}`;
    }

    const summary = opts.eof
      ? text.length > 0
        ? `Sent input and closed stdin (EOF) for ${id}.`
        : `Closed stdin (EOF) for ${id}.`
      : `Sent input to ${id}.`;
    return `${summary} Use task_output with id="${id}" to read the response.`;
  }

  async stop(id: string): Promise<string> {
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child || proc.exitCode !== null) {
      return `Process ${id} already exited (code ${proc.exitCode})`;
    }

    const isWindows = (this.ops.platform ?? process.platform) === "win32";
    if (isWindows) {
      // Kill the PID tree before the wrapper can exit and orphan descendants.
      stopProcessTree(proc.pid, this.ops);
    } else {
      // Give POSIX process groups a graceful stop before the hard tree kill.
      try {
        (this.ops.kill ?? process.kill)(-proc.pid, "SIGTERM");
      } catch {
        try {
          (this.ops.kill ?? process.kill)(proc.pid, "SIGTERM");
        } catch {
          return `Process ${id} already exited`;
        }
      }
    }

    // Wait up to 5s for close, then hard-kill a surviving POSIX tree.
    const exited = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (didExit: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeListener("close", onClose);
        resolve(didExit);
      };
      const onClose = (): void => settle(true);
      const timeout = setTimeout(() => settle(false), 5000);

      child.once("close", onClose);
    });

    if (!exited) {
      if (isWindows) {
        return `Failed to stop process ${id}: process did not exit within 5 seconds and may still be running.`;
      }
      stopProcessTree(proc.pid, this.ops);
    }

    return `Process ${id} stopped`;
  }

  list(): BackgroundProcess[] {
    // Prune completed processes older than 5 minutes to prevent Map growth
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, proc] of this.processes) {
      if (proc.exitCode !== null && !this.children.has(id) && proc.startedAt < cutoff) {
        this.processes.delete(id);
      }
    }
    return Array.from(this.processes.values());
  }

  shutdownAll(): void {
    for (const [id, proc] of this.processes) {
      if (this.children.has(id)) {
        stopProcessTree(proc.pid, this.ops);
        proc.exitCode = proc.exitCode ?? 1;
        this.children.delete(id);
      }
    }
  }
}
