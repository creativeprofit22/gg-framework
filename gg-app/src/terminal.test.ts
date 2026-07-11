import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalClient } from "./agent";
import {
  TERMINAL_INPUT_MAX_CALL_BYTES,
  TerminalAdapter,
  TerminalWriteQueue,
  validTerminalSize,
} from "./terminal";

function client(): TerminalClient {
  return {
    ready: Promise.resolve({
      terminalId: "terminal-1",
      paneId: "primary",
      cwd: "C:/project",
      shell: "cmd.exe",
      cols: 80,
      rows: 24,
    }),
    input: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function xtermMock() {
  let onData: (data: string) => void = () => {};
  let onBinary: (data: string) => void = () => {};
  const dataDispose = vi.fn();
  const binaryDispose = vi.fn();
  return {
    terminal: {
      write: vi.fn((_data: Uint8Array, callback?: () => void) => callback?.()),
      onData: vi.fn((handler: (data: string) => void) => {
        onData = handler;
        return { dispose: dataDispose };
      }),
      onBinary: vi.fn((handler: (data: string) => void) => {
        onBinary = handler;
        return { dispose: binaryDispose };
      }),
    },
    emitData: (data: string) => onData(data),
    emitBinary: (data: string) => onBinary(data),
    dataDispose,
    binaryDispose,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal byte transport", () => {
  it("forwards split multibyte UTF-8 as the original raw chunks", () => {
    const xterm = xtermMock();
    const adapter = new TerminalAdapter(xterm.terminal, client(), {
      onError: vi.fn(),
      onOverflow: vi.fn(),
    });
    const bytes = new TextEncoder().encode("A🙂終");
    const first = bytes.slice(0, 3);
    const second = bytes.slice(3);

    adapter.write(first);
    adapter.write(second);

    expect(xterm.terminal.write).toHaveBeenNthCalledWith(1, first, expect.any(Function));
    expect(xterm.terminal.write).toHaveBeenNthCalledWith(2, second, expect.any(Function));
    expect(new TextDecoder().decode(new Uint8Array([...first, ...second]))).toBe("A🙂終");
    adapter.dispose();
  });

  it("forwards text and binary reports without UTF-8 corrupting binary", async () => {
    const xterm = xtermMock();
    const terminalClient = client();
    const adapter = new TerminalAdapter(xterm.terminal, terminalClient, {
      onError: vi.fn(),
      onOverflow: vi.fn(),
    });

    xterm.emitData("é");
    xterm.emitBinary(String.fromCharCode(0, 0xff, 0x1b));

    const input = terminalClient.input as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(2));
    expect(input.mock.calls[0][0]).toEqual(new TextEncoder().encode("é"));
    expect(input.mock.calls[1][0]).toEqual(new Uint8Array([0, 0xff, 0x1b]));
    adapter.dispose();
  });

  it("chunks a large text paste and preserves ordering with a following keystroke", async () => {
    const xterm = xtermMock();
    const terminalClient = client();
    const sent: Uint8Array[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(terminalClient.input)
      .mockImplementationOnce(async (data) => {
        sent.push(data);
        await firstPending;
      })
      .mockImplementation(async (data) => {
        sent.push(data);
      });
    const adapter = new TerminalAdapter(xterm.terminal, terminalClient, {
      onError: vi.fn(),
      onOverflow: vi.fn(),
    });
    const paste = "🙂".repeat(TERMINAL_INPUT_MAX_CALL_BYTES / 2 + 17);
    const expected = new TextEncoder().encode(`${paste}x`);

    xterm.emitData(paste);
    xterm.emitData("x");
    await vi.waitFor(() => expect(terminalClient.input).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await vi.waitFor(() => expect(terminalClient.input).toHaveBeenCalledTimes(4));

    expect(sent.every((chunk) => chunk.byteLength <= TERMINAL_INPUT_MAX_CALL_BYTES)).toBe(true);
    expect(new Uint8Array(sent.flatMap((chunk) => [...chunk]))).toEqual(expected);
    adapter.dispose();
  });

  it("chunks and exactly reassembles large binary input", async () => {
    const xterm = xtermMock();
    const terminalClient = client();
    const adapter = new TerminalAdapter(xterm.terminal, terminalClient, {
      onError: vi.fn(),
      onOverflow: vi.fn(),
    });
    const source = Uint8Array.from(
      { length: TERMINAL_INPUT_MAX_CALL_BYTES + 29 },
      (_, index) => index % 256,
    );
    xterm.emitBinary(Array.from(source, (byte) => String.fromCharCode(byte)).join(""));

    await vi.waitFor(() => expect(terminalClient.input).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(terminalClient.input).mock.calls.map(([chunk]) => chunk);
    expect(calls.every((chunk) => chunk.byteLength <= TERMINAL_INPUT_MAX_CALL_BYTES)).toBe(true);
    expect(new Uint8Array(calls.flatMap((chunk) => [...chunk]))).toEqual(source);
    adapter.dispose();
  });

  it("reports an input rejection and keeps the queue usable", async () => {
    const xterm = xtermMock();
    const terminalClient = client();
    vi.mocked(terminalClient.input)
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValue();
    const onError = vi.fn();
    const adapter = new TerminalAdapter(xterm.terminal, terminalClient, {
      onError,
      onOverflow: vi.fn(),
    });

    xterm.emitData("a");
    xterm.emitData("b");

    await vi.waitFor(() => expect(terminalClient.input).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("transport failed");
    expect(vi.mocked(terminalClient.input).mock.calls.map(([bytes]) => bytes[0])).toEqual([97, 98]);
    adapter.dispose();
  });
});

describe("TerminalWriteQueue", () => {
  it("writes chunks serially in arrival order", () => {
    const callbacks: Array<() => void> = [];
    const written: number[] = [];
    const queue = new TerminalWriteQueue(
      {
        write(data, callback) {
          written.push(data[0]);
          callbacks.push(callback ?? (() => {}));
        },
      },
      vi.fn(),
      10,
    );

    queue.enqueue(new Uint8Array([1]));
    queue.enqueue(new Uint8Array([2]));
    queue.enqueue(new Uint8Array([3]));
    expect(written).toEqual([1]);
    callbacks.shift()?.();
    callbacks.shift()?.();
    expect(written).toEqual([1, 2, 3]);
  });

  it("delivers queued output before completing an ordered exit", () => {
    const callbacks: Array<() => void> = [];
    const written: number[] = [];
    const finished = vi.fn();
    const queue = new TerminalWriteQueue(
      {
        write(data, callback) {
          written.push(data[0]);
          callbacks.push(callback ?? (() => {}));
        },
      },
      vi.fn(),
    );

    queue.enqueue(new Uint8Array([1]));
    queue.enqueue(new Uint8Array([2]));
    queue.finish(finished);

    expect(finished).not.toHaveBeenCalled();
    expect(queue.enqueue(new Uint8Array([3]))).toBe(false);
    callbacks.shift()?.();
    expect(written).toEqual([1, 2]);
    expect(finished).not.toHaveBeenCalled();
    callbacks.shift()?.();
    expect(finished).toHaveBeenCalledOnce();
  });

  it("closes on high-water overflow instead of dropping bytes", () => {
    const overflow = vi.fn();
    const queue = new TerminalWriteQueue({ write: vi.fn() }, overflow, 2);
    expect(queue.enqueue(new Uint8Array([1]))).toBe(true);
    expect(queue.enqueue(new Uint8Array([2, 3, 4]))).toBe(false);
    expect(overflow).toHaveBeenCalledOnce();
    expect(queue.enqueue(new Uint8Array([5]))).toBe(false);
  });
});

describe("TerminalAdapter resize and disposal", () => {
  it("validates, deduplicates, and debounces resize", async () => {
    vi.useFakeTimers();
    const xterm = xtermMock();
    const terminalClient = client();
    const adapter = new TerminalAdapter(xterm.terminal, terminalClient, {
      onError: vi.fn(),
      onOverflow: vi.fn(),
      resizeDelayMs: 20,
    });

    expect(adapter.resize(1, 24)).toBe(false);
    expect(adapter.resize(80, 24)).toBe(true);
    expect(adapter.resize(80, 24)).toBe(false);
    expect(adapter.resize(100, 30)).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(terminalClient.resize).toHaveBeenCalledTimes(1);
    expect(terminalClient.resize).toHaveBeenCalledWith(100, 30);
    expect(adapter.resize(100, 30)).toBe(false);
  });

  it("disposes listeners and pending work exactly once", () => {
    vi.useFakeTimers();
    const xterm = xtermMock();
    const terminalClient = client();
    const adapter = new TerminalAdapter(xterm.terminal, terminalClient, {
      onError: vi.fn(),
      onOverflow: vi.fn(),
    });
    adapter.resize(90, 25);
    adapter.dispose();
    adapter.dispose();
    vi.runAllTimers();
    expect(xterm.dataDispose).toHaveBeenCalledOnce();
    expect(xterm.binaryDispose).toHaveBeenCalledOnce();
    expect(terminalClient.resize).not.toHaveBeenCalled();
  });

  it("matches Rust terminal size bounds", () => {
    expect(validTerminalSize(2, 1)).toBe(true);
    expect(validTerminalSize(500, 300)).toBe(true);
    expect(validTerminalSize(501, 24)).toBe(false);
  });
});
