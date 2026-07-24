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
  completedAt: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  lastReadOffset: number | null;
}

/** Serializable process state shared by orchestration and task-status surfaces. */
export interface BackgroundTaskSnapshot extends Omit<BackgroundProcess, "lastReadOffset"> {
  isRunning: boolean;
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
  signal: NodeJS.Signals | null;
  completedAt: number | null;
  output: string;
  startOffset: number;
  endOffset: number;
  skippedBytes: number;
  remainingBytes: number;
  logFile: string | null;
}

const BG_DIR = path.join(os.homedir(), ".gg", "bg");
const FOREGROUND_DIR = path.join(os.homedir(), ".gg", "foreground");
const DEFAULT_READ_CAP_BYTES = 256 * 1024;
const DEFAULT_RECORD_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
const LOG_SWEEP_INTERVAL_MS = 60 * 1000;

export interface ForegroundLogHandle {
  executionId: string;
  logPath: string;
  readonly error: Error | null;
  /** Returns false when producers must pause until waitForDrain() resolves. */
  write(record: string | Buffer): boolean;
  waitForDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface ProcessManagerOptions {
  backgroundLogRoot?: string;
  foregroundLogRoot?: string;
  createForegroundLogStream?: (logPath: string) => Writable;
  createExecutionId?: () => string;
  now?: () => number;
  readCapBytes?: number;
  completedRecordRetentionMs?: number;
  logRetentionMs?: number;
}

function processTarget(pid: number, child: ChildProcess): ProcessTarget {
  return {
    pid,
    isExited: () => child.exitCode !== null || child.signalCode !== null,
  };
}

export class ProcessManager {
  private processes = new Map<string, BackgroundProcess>();
  private children = new Map<string, ChildProcess>();
  private recordExpiryTimers = new Map<string, NodeJS.Timeout>();
  private activeBackgroundLogs = new Set<string>();
  private openForegroundLogs = new Set<string>();
  private logSweepPromise: Promise<void> | null = null;
  private lastLogSweepAt: number | null = null;

  constructor(
    private readonly lifecycle: ProcessLifecycleAdapter = localProcessLifecycle,
    private readonly createLogStream: (logFile: string) => Writable = (logFile) =>
      createWriteStream(logFile, { flags: "w" }),
    private readonly options: ProcessManagerOptions = {},
  ) {}

  async allocateForegroundLog(): Promise<ForegroundLogHandle> {
    this.pruneExpiredRecords();
    await this.sweepStaleLogs();
    const foregroundLogRoot = this.options.foregroundLogRoot ?? FOREGROUND_DIR;
    await fsp.mkdir(foregroundLogRoot, { recursive: true });

    const allocateFile = async (): Promise<{ executionId: string; logPath: string }> => {
      for (;;) {
        const executionId = (this.options.createExecutionId ?? crypto.randomUUID)();
        const logPath = path.join(foregroundLogRoot, `${executionId}.log`);
        try {
          const file = await fsp.open(logPath, "wx");
          await file.close();
          return { executionId, logPath };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
      }
    };
    const { executionId, logPath } = await allocateFile();

    const streamFactory =
      this.options.createForegroundLogStream ??
      ((foregroundLogPath: string) => createWriteStream(foregroundLogPath, { flags: "a" }));
    this.openForegroundLogs.add(logPath);
    let stream: Writable;
    try {
      stream = streamFactory(logPath);
    } catch (error) {
      this.openForegroundLogs.delete(logPath);
      throw error;
    }
    let streamError: Error | null = null;
    let ended = false;
    let settleClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      settleClose = () => {
        this.openForegroundLogs.delete(logPath);
        resolve();
      };
    });
    stream.on("error", (error: Error) => {
      streamError = error;
      settleClose();
    });
    stream.once("finish", settleClose);
    stream.once("close", settleClose);

    if ((stream as Writable & { readonly pending?: boolean }).pending === true) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onOpen = (): void => {
            stream.removeListener("error", onOpenError);
            resolve();
          };
          const onOpenError = (error: Error): void => {
            stream.removeListener("open", onOpen);
            reject(error);
          };
          stream.once("open", onOpen);
          stream.once("error", onOpenError);
        });
      } catch (error) {
        this.openForegroundLogs.delete(logPath);
        stream.destroy();
        throw error;
      }
    }

    return {
      executionId,
      logPath,
      get error() {
        return streamError;
      },
      write(record) {
        if (ended || streamError) return true;
        try {
          return stream.write(record);
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error));
          return true;
        }
      },
      waitForDrain() {
        if (ended || streamError || stream.destroyed) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const settle = (): void => {
            stream.removeListener("drain", settle);
            stream.removeListener("error", settle);
            stream.removeListener("finish", settle);
            stream.removeListener("close", settle);
            resolve();
          };
          stream.once("drain", settle);
          stream.once("error", settle);
          stream.once("finish", settle);
          stream.once("close", settle);
        });
      },
      close() {
        if (ended) return closed;
        ended = true;
        try {
          stream.end();
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error));
          settleClose();
        }
        return closed;
      },
    };
  }

  async start(command: string, cwd: string): Promise<StartResult> {
    this.pruneExpiredRecords();
    await this.sweepStaleLogs();
    const backgroundLogRoot = this.options.backgroundLogRoot ?? BG_DIR;
    await fsp.mkdir(backgroundLogRoot, { recursive: true });

    const id = crypto.randomUUID().slice(0, 8);
    const logFile = path.join(backgroundLogRoot, `${id}.log`);
    this.activeBackgroundLogs.add(logFile);
    let logStream: Writable;
    try {
      logStream = this.createLogStream(logFile);
    } catch (error) {
      this.activeBackgroundLogs.delete(logFile);
      throw error;
    }
    const markLogClosed = (): void => {
      this.activeBackgroundLogs.delete(logFile);
    };
    // A local logging failure must not crash the host or bypass target execution.
    logStream.on("error", () => {});
    logStream.once("finish", markLogClosed);
    logStream.once("close", markLogClosed);
    logStream.once("error", markLogClosed);

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

      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
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
        this.children.delete(id);
        void logFlushed.then(() => {
          // Preserve native child semantics: signal exits have no numeric code.
          // Consumers use the explicit snapshot isRunning field for liveness.
          completedProcess.exitCode = code;
          completedProcess.signal = signal;
          completedProcess.completedAt = this.now();
          this.scheduleRecordExpiry(id, completedProcess.completedAt);
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
          startedAt: this.now(),
          completedAt: null,
          exitCode: null,
          signal: null,
          lastReadOffset: null,
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

  async readOutput(id: string, fromStart = false): Promise<ReadOutputResult> {
    this.pruneExpiredRecords();
    await this.sweepStaleLogs();
    const proc = this.processes.get(id);
    if (!proc) {
      return {
        id,
        isRunning: false,
        exitCode: null,
        signal: null,
        completedAt: null,
        output: `No background process with id "${id}"`,
        startOffset: 0,
        endOffset: 0,
        skippedBytes: 0,
        remainingBytes: 0,
        logFile: null,
      };
    }

    const configuredReadCap = Math.floor(this.options.readCapBytes ?? DEFAULT_READ_CAP_BYTES);
    const readCap = Number.isFinite(configuredReadCap)
      ? Math.max(4, configuredReadCap)
      : DEFAULT_READ_CAP_BYTES;
    const isLateSnapshot = !fromStart && proc.lastReadOffset === null;
    const isRunning = this.children.has(id);
    let output = "";
    let startOffset: number;
    let endOffset: number;
    let skippedBytes = 0;
    let remainingBytes = 0;

    try {
      // Freeze range selection at this size. Bytes appended after this stat are
      // intentionally left for the next incremental read.
      const snapshotSize = (await fsp.stat(proc.logFile)).size;
      const previousOffset = proc.lastReadOffset ?? 0;
      const requestedStart = fromStart
        ? 0
        : isLateSnapshot
          ? Math.max(0, snapshotSize - readCap)
          : previousOffset > snapshotSize
            ? 0
            : previousOffset;
      const requestedLength = Math.min(readCap, Math.max(0, snapshotSize - requestedStart));

      if (requestedLength > 0) {
        const buffer = Buffer.alloc(requestedLength);
        const file = await fsp.open(proc.logFile, "r");
        let bytesRead = 0;
        try {
          ({ bytesRead } = await file.read(buffer, 0, buffer.length, requestedStart));
        } finally {
          await file.close();
        }

        let leadingBytes = 0;
        if (isLateSnapshot && requestedStart > 0) {
          while (leadingBytes < bytesRead && (buffer[leadingBytes]! & 0xc0) === 0x80) {
            leadingBytes += 1;
          }
        }

        const completePrefixLength = this.completeUtf8PrefixLength(
          buffer.subarray(leadingBytes, bytesRead),
        );
        const reachedSnapshotEnd = requestedStart + bytesRead >= snapshotSize;
        const consumedLength =
          !isRunning && reachedSnapshotEnd ? bytesRead - leadingBytes : completePrefixLength;
        startOffset = requestedStart + leadingBytes;
        endOffset = startOffset + consumedLength;
        output = buffer
          .subarray(leadingBytes, leadingBytes + completePrefixLength)
          .toString("utf-8");
        proc.lastReadOffset = endOffset;
      } else {
        startOffset = requestedStart;
        endOffset = requestedStart;
        proc.lastReadOffset = requestedStart;
      }

      skippedBytes = isLateSnapshot ? startOffset : 0;
      remainingBytes = Math.max(0, snapshotSize - endOffset);
    } catch {
      output = "(failed to read log file)";
      const cursor = proc.lastReadOffset ?? 0;
      startOffset = cursor;
      endOffset = cursor;
    }

    return {
      id,
      isRunning,
      exitCode: proc.exitCode,
      signal: proc.signal,
      completedAt: proc.completedAt,
      output,
      startOffset,
      endOffset,
      skippedBytes,
      remainingBytes,
      logFile: proc.logFile,
    };
  }

  private completeUtf8PrefixLength(buffer: Buffer): number {
    if (buffer.length === 0) return 0;

    let continuationBytes = 0;
    for (
      let index = buffer.length - 1;
      index >= 0 && (buffer[index]! & 0xc0) === 0x80;
      index -= 1
    ) {
      continuationBytes += 1;
    }

    const leadIndex = buffer.length - continuationBytes - 1;
    if (leadIndex < 0) return buffer.length;
    const lead = buffer[leadIndex]!;
    const expectedBytes =
      (lead & 0x80) === 0 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
    const availableBytes = continuationBytes + 1;
    return availableBytes < expectedBytes ? leadIndex : buffer.length;
  }

  async sendInput(
    id: string,
    input: string,
    opts: { enter?: boolean; eof?: boolean } = {},
  ): Promise<string> {
    this.pruneExpiredRecords();
    await this.sweepStaleLogs();
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child) {
      return `Process ${id} already exited (${this.formatTerminalStatus(proc)})`;
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
    this.pruneExpiredRecords();
    void this.sweepStaleLogs();
    const proc = this.processes.get(id);
    if (!proc) return `No background process with id "${id}"`;

    const child = this.children.get(id);
    if (!child) {
      return `Process ${id} already exited (${this.formatTerminalStatus(proc)})`;
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

  list(): BackgroundTaskSnapshot[] {
    this.pruneExpiredRecords();
    void this.sweepStaleLogs();
    return Array.from(this.processes.values(), (proc) => ({
      id: proc.id,
      pid: proc.pid,
      command: proc.command,
      logFile: proc.logFile,
      startedAt: proc.startedAt,
      completedAt: proc.completedAt,
      exitCode: proc.exitCode,
      signal: proc.signal,
      isRunning: this.children.has(proc.id),
    }));
  }

  shutdownAll(): void {
    this.pruneExpiredRecords();
    void this.sweepStaleLogs();
    for (const proc of this.processes.values()) {
      const child = this.children.get(proc.id);
      if (child) {
        this.lifecycle.killProcessTree(processTarget(proc.pid, child));
      }
    }
  }

  private formatTerminalStatus(proc: BackgroundProcess): string {
    if (proc.signal) return `signal ${proc.signal}`;
    if (proc.exitCode !== null) return `code ${proc.exitCode}`;
    return "completion pending";
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sweepStaleLogs(): Promise<void> {
    if (this.logSweepPromise) return this.logSweepPromise;

    const now = this.now();
    if (this.lastLogSweepAt !== null && now - this.lastLogSweepAt < LOG_SWEEP_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.lastLogSweepAt = now;

    this.logSweepPromise = this.removeStaleLogFiles(now)
      .catch(() => {})
      .finally(() => {
        this.logSweepPromise = null;
      });
    return this.logSweepPromise;
  }

  private async removeStaleLogFiles(now: number): Promise<void> {
    const retentionMs = Math.max(0, this.options.logRetentionMs ?? DEFAULT_LOG_RETENTION_MS);
    const cutoff = now - retentionMs;
    const roots = new Set([
      this.options.backgroundLogRoot ?? BG_DIR,
      this.options.foregroundLogRoot ?? FOREGROUND_DIR,
    ]);
    const protectedPaths = new Set([...this.activeBackgroundLogs, ...this.openForegroundLogs]);

    await Promise.all(
      Array.from(roots, async (root) => {
        let entries;
        try {
          entries = await fsp.readdir(root, { withFileTypes: true });
        } catch {
          return;
        }

        await Promise.all(
          entries.map(async (entry) => {
            if (!entry.isFile()) return;
            const logPath = path.join(root, entry.name);
            if (protectedPaths.has(logPath)) return;
            try {
              const stat = await fsp.stat(logPath);
              if (stat.mtimeMs < cutoff) await fsp.unlink(logPath);
            } catch {
              // Log retention is best-effort and must never break process lifecycle methods.
            }
          }),
        );
      }),
    );
  }

  private pruneExpiredRecords(): void {
    const retentionMs = Math.max(
      0,
      this.options.completedRecordRetentionMs ?? DEFAULT_RECORD_RETENTION_MS,
    );
    const cutoff = this.now() - retentionMs;
    for (const [id, proc] of this.processes) {
      if (proc.completedAt !== null && !this.children.has(id) && proc.completedAt <= cutoff) {
        this.processes.delete(id);
        const timer = this.recordExpiryTimers.get(id);
        if (timer) clearTimeout(timer);
        this.recordExpiryTimers.delete(id);
      }
    }
  }

  private scheduleRecordExpiry(id: string, completedAt: number): void {
    const existingTimer = this.recordExpiryTimers.get(id);
    if (existingTimer) clearTimeout(existingTimer);

    const retentionMs = Math.max(
      0,
      this.options.completedRecordRetentionMs ?? DEFAULT_RECORD_RETENTION_MS,
    );
    const delay = Math.max(0, completedAt + retentionMs - this.now());
    const timer = setTimeout(() => {
      this.recordExpiryTimers.delete(id);
      this.pruneExpiredRecords();
    }, delay);
    timer.unref();
    this.recordExpiryTimers.set(id, timer);
  }
}
