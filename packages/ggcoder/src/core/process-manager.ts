import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { Writable } from "node:stream";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ProcessTarget } from "../utils/process.js";
import { localProcessLifecycle, type ProcessLifecycleAdapter } from "../tools/operations.js";
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

function processTarget(pid: number, child: ChildProcess): ProcessTarget {
  return {
    pid,
    isExited: () => child.exitCode !== null || child.signalCode !== null,
  };
}

export class ProcessManager {
  private processes = new Map<string, BackgroundProcess>();
  private children = new Map<string, ChildProcess>();

  constructor(
    private readonly lifecycle: ProcessLifecycleAdapter = localProcessLifecycle,
    private readonly createLogStream: (logFile: string) => Writable = (logFile) =>
      createWriteStream(logFile, { flags: "w" }),
  ) {}

  async start(command: string, cwd: string): Promise<StartResult> {
    await fsp.mkdir(BG_DIR, { recursive: true });

    const id = crypto.randomUUID().slice(0, 8);
    const logFile = path.join(BG_DIR, `${id}.log`);
    const logStream = this.createLogStream(logFile);
    // A local logging failure must not crash the host or bypass target execution.
    logStream.on("error", () => {});

    const shell = resolveShell(command);
    let child: ChildProcess;
    try {
      child = this.lifecycle.spawn(shell.file, shell.args, {
        cwd,
        detached: true,
        // Keep adapter-owned process I/O as pipes. Numeric descriptors would
        // bypass remote/SSH/Docker adapters and execute logging on their target.
        stdio: ["pipe", "pipe", "pipe"],
        env: getSafeToolEnv(),
      });
    } catch (error) {
      logStream.end();
      throw error;
    }

    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    child.stdin?.on("error", () => {});

    return new Promise<StartResult>((resolve, reject) => {
      let startupSettled = false;
      let proc: BackgroundProcess | undefined;
      let pid: number | undefined;
      let logEnded = false;
      let settleLogFlush!: () => void;
      const logFlushed = new Promise<void>((resolveFlush) => {
        settleLogFlush = resolveFlush;
      });
      logStream.once("finish", settleLogFlush);
      logStream.once("close", settleLogFlush);
      logStream.once("error", settleLogFlush);

      const endLog = (): void => {
        if (logEnded) return;
        logEnded = true;
        logStream.end();
      };

      const onError = (error: Error): void => {
        if (startupSettled) return;
        startupSettled = true;
        endLog();
        reject(error);
        // Keep this listener installed: ChildProcess may emit another error later,
        // and an unhandled error event must never crash the agent host.
      };

      const onClose = (code: number | null): void => {
        endLog();
        if (!proc || pid === undefined) {
          if (!startupSettled) {
            startupSettled = true;
            reject(new Error("Background process closed before startup completed"));
          }
          return;
        }

        const completedProcess = proc;
        const completedPid = pid;
        void logFlushed.then(() => {
          completedProcess.exitCode = code ?? 1;
          this.children.delete(id);
          try {
            this.lifecycle.reapProcessWrapper(processTarget(completedPid, child));
          } catch {
            // Completion is authoritative; wrapper reaping remains best-effort.
          }
        });
      };

      const onSpawn = (): void => {
        if (startupSettled) return;
        pid = child.pid;
        if (pid === undefined) {
          startupSettled = true;
          endLog();
          reject(new Error("Background process did not provide a PID"));
          return;
        }

        proc = {
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
        child.unref();
        startupSettled = true;
        resolve({ id, pid, logFile });
      };

      // Register all terminal handlers before awaiting startup so fast failures
      // and immediate exits cannot escape or be reported as false success.
      child.on("error", onError);
      child.on("close", onClose);
      child.once("spawn", onSpawn);
    });
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

    const target = processTarget(proc.pid, child);
    const exited = new Promise<boolean>((resolve) => {
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

    try {
      await this.lifecycle.cleanupProcessTree(target);
    } catch {
      // Cleanup is best-effort and must not replace the stop lifecycle result.
    }

    if (!(await exited)) {
      return `Failed to stop process ${id}: process did not exit within 5 seconds and may still be running.`;
    }

    return `Process ${id} stopped`;
  }

  list(): BackgroundProcess[] {
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
      const child = this.children.get(id);
      if (child) {
        this.lifecycle.killProcessTree(processTarget(proc.pid, child));
        proc.exitCode = proc.exitCode ?? 1;
        this.children.delete(id);
      }
    }
  }
}
