import type { IDisposable, Terminal } from "@xterm/xterm";
import type { TerminalClient } from "./agent";

export const TERMINAL_WRITE_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const TERMINAL_MIN_COLS = 2;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 300;

export function binaryStringToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

interface WriteTarget {
  write(data: Uint8Array, callback?: () => void): void;
}

/** Preserves PTY byte order while bounding bytes waiting behind xterm rendering. */
export class TerminalWriteQueue {
  private readonly pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private writing = false;
  private finishing = false;
  private disposed = false;
  private onFinished: (() => void) | undefined;

  constructor(
    private readonly target: WriteTarget,
    private readonly onOverflow: () => void,
    private readonly highWaterBytes = TERMINAL_WRITE_HIGH_WATER_BYTES,
  ) {}

  enqueue(data: Uint8Array): boolean {
    if (this.disposed || this.finishing) return false;
    if (this.pendingBytes + data.byteLength > this.highWaterBytes) {
      this.dispose();
      this.onOverflow();
      return false;
    }
    this.pending.push(data);
    this.pendingBytes += data.byteLength;
    this.drain();
    return true;
  }

  finish(onFinished: () => void): void {
    if (this.disposed || this.finishing) return;
    this.finishing = true;
    this.onFinished = onFinished;
    this.finishIfDrained();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onFinished = undefined;
    this.pending.length = 0;
    this.pendingBytes = 0;
  }

  private drain(): void {
    if (this.disposed || this.writing) return;
    const data = this.pending.shift();
    if (!data) {
      this.finishIfDrained();
      return;
    }
    this.pendingBytes -= data.byteLength;
    this.writing = true;
    this.target.write(data, () => {
      this.writing = false;
      this.drain();
    });
  }

  private finishIfDrained(): void {
    if (!this.finishing || this.writing || this.pending.length > 0) return;
    this.disposed = true;
    const onFinished = this.onFinished;
    this.onFinished = undefined;
    onFinished?.();
  }
}

export interface TerminalAdapterOptions {
  onError(message: string): void;
  onOverflow(): void;
  resizeDelayMs?: number;
  writeHighWaterBytes?: number;
}

/** Owns xterm byte transport and listeners; React owns only visual state. */
export class TerminalAdapter {
  private readonly disposables: IDisposable[] = [];
  private readonly writes: TerminalWriteQueue;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private requestedSize: { cols: number; rows: number } | undefined;
  private sentSize: { cols: number; rows: number } | undefined;
  private disposed = false;

  constructor(
    terminal: Pick<Terminal, "write" | "onData" | "onBinary">,
    private readonly client: TerminalClient,
    private readonly options: TerminalAdapterOptions,
  ) {
    this.writes = new TerminalWriteQueue(terminal, options.onOverflow, options.writeHighWaterBytes);
    this.disposables.push(
      terminal.onData((data) => {
        this.sendInput(new TextEncoder().encode(data));
      }),
      terminal.onBinary((data) => {
        this.sendInput(binaryStringToBytes(data));
      }),
    );
  }

  write(data: Uint8Array): boolean {
    if (this.disposed) return false;
    return this.writes.enqueue(data);
  }

  resize(cols: number, rows: number): boolean {
    if (this.disposed || !validTerminalSize(cols, rows)) return false;
    if (
      (this.requestedSize?.cols === cols && this.requestedSize.rows === rows) ||
      (this.sentSize?.cols === cols && this.sentSize.rows === rows)
    ) {
      return false;
    }
    this.requestedSize = { cols, rows };
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      const size = this.requestedSize;
      this.requestedSize = undefined;
      if (!size || this.disposed) return;
      this.sentSize = size;
      void this.client.resize(size.cols, size.rows).catch((error: unknown) => {
        this.options.onError(errorMessage(error));
      });
    }, this.options.resizeDelayMs ?? 40);
    return true;
  }

  finish(onFinished: () => void): void {
    if (this.disposed) return;
    this.stopInteraction();
    this.writes.finish(onFinished);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopInteraction();
    this.writes.dispose();
  }

  private stopInteraction(): void {
    this.disposed = true;
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private sendInput(bytes: Uint8Array): void {
    if (this.disposed) return;
    void this.client.input(bytes).catch((error: unknown) => {
      this.options.onError(errorMessage(error));
    });
  }
}

export function validTerminalSize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= TERMINAL_MIN_COLS &&
    cols <= TERMINAL_MAX_COLS &&
    rows >= TERMINAL_MIN_ROWS &&
    rows <= TERMINAL_MAX_ROWS
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
