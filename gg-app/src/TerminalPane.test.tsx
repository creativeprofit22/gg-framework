// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalClient, TerminalEvent, TerminalInfo } from "./agent";

const mocks = vi.hoisted(() => {
  const terminal = {
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn((_data: Uint8Array, callback?: () => void) => callback?.()),
    onData: vi.fn(),
    onBinary: vi.fn(),
  };
  const fitAddon = { fit: vi.fn(), dispose: vi.fn() };
  return {
    terminal,
    fitAddon,
    createTerminal: vi.fn(),
    event: undefined as ((event: TerminalEvent) => void) | undefined,
    data: undefined as ((data: string) => void) | undefined,
    binary: undefined as ((data: string) => void) | undefined,
    resizeObserver: undefined as (() => void) | undefined,
    disconnect: vi.fn(),
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      return mocks.terminal;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    constructor() {
      return mocks.fitAddon;
    }
  },
}));
vi.mock("./agent", () => ({ createTerminal: mocks.createTerminal }));

import { TerminalPane } from "./TerminalPane";

const info: TerminalInfo = {
  terminalId: "terminal-1",
  paneId: "primary",
  cwd: "C:\\project",
  shell: "cmd.exe",
  cols: 80,
  rows: 24,
};

function makeClient(ready: Promise<TerminalInfo> = Promise.resolve(info)): TerminalClient {
  return {
    ready,
    input: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.terminal.cols = 80;
  mocks.terminal.rows = 24;
  mocks.terminal.onData.mockImplementation((handler: (data: string) => void) => {
    mocks.data = handler;
    return { dispose: vi.fn() };
  });
  mocks.terminal.onBinary.mockImplementation((handler: (data: string) => void) => {
    mocks.binary = handler;
    return { dispose: vi.fn() };
  });
  mocks.createTerminal.mockImplementation(
    (_paneId: string, _cols: number, _rows: number, onEvent: (event: TerminalEvent) => void) => {
      mocks.event = onEvent;
      return makeClient();
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        mocks.resizeObserver = callback;
      }
      observe() {}
      disconnect() {
        mocks.disconnect();
      }
    },
  );
});

describe("TerminalPane", () => {
  it("fits before creating, then shows canonical metadata and focuses", async () => {
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);
    expect(mocks.fitAddon.fit).toHaveBeenCalled();
    expect(mocks.createTerminal).toHaveBeenCalledWith("primary", 80, 24, expect.any(Function));
    await screen.findByText("C:\\project · cmd.exe");
    expect(screen.getByText("Running")).toBeTruthy();
    expect(mocks.terminal.focus).toHaveBeenCalled();
  });

  it("preserves output and forwards text plus binary input", async () => {
    const terminalClient = makeClient();
    mocks.createTerminal.mockImplementation(
      (_paneId: string, _cols: number, _rows: number, onEvent: (event: TerminalEvent) => void) => {
        mocks.event = onEvent;
        return terminalClient;
      },
    );
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);
    await screen.findByText("Running");

    act(() => {
      mocks.event?.(new Uint8Array([111, 110, 101]).buffer);
      mocks.data?.("x");
      mocks.binary?.(String.fromCharCode(0xff));
    });
    await waitFor(() => expect(terminalClient.input).toHaveBeenCalledTimes(2));
    expect(mocks.terminal.write).toHaveBeenCalledWith(
      new Uint8Array([111, 110, 101]),
      expect.any(Function),
    );
  });

  it("fits and resizes the PTY when its container changes", async () => {
    vi.useFakeTimers();
    const terminalClient = makeClient();
    mocks.createTerminal.mockImplementation(
      (_paneId: string, _cols: number, _rows: number, onEvent: (event: TerminalEvent) => void) => {
        mocks.event = onEvent;
        return terminalClient;
      },
    );
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);
    await act(async () => Promise.resolve());
    mocks.terminal.cols = 100;
    mocks.terminal.rows = 30;
    act(() => mocks.resizeObserver?.());
    await act(async () => vi.advanceTimersByTimeAsync(40));
    expect(terminalClient.resize).toHaveBeenCalledWith(100, 30);
    vi.useRealTimers();
  });

  it("applies an exit received synchronously before the adapter is ready", async () => {
    const terminalClient = makeClient();
    mocks.createTerminal.mockImplementation(
      (_paneId: string, _cols: number, _rows: number, onEvent: (event: TerminalEvent) => void) => {
        onEvent({
          type: "exit",
          paneId: "primary",
          terminalId: "terminal-1",
          exitCode: 0,
        });
        return terminalClient;
      },
    );

    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);

    expect(await screen.findByText("Exited (0)")).toBeTruthy();
    expect(mocks.terminal.write).not.toHaveBeenCalled();
  });

  it("keeps an exit received before ready terminal and reports stopped once", async () => {
    let resolveReady!: (value: TerminalInfo) => void;
    const ready = new Promise<TerminalInfo>((resolve) => {
      resolveReady = resolve;
    });
    const onRunningChange = vi.fn();
    mocks.createTerminal.mockImplementation((_paneId, _cols, _rows, onEvent) => {
      mocks.event = onEvent;
      return makeClient(ready);
    });

    render(
      <TerminalPane paneId="primary" onRequestClose={vi.fn()} onRunningChange={onRunningChange} />,
    );
    act(() => {
      mocks.event?.({
        type: "exit",
        paneId: "primary",
        terminalId: "terminal-1",
        exitCode: 0,
      });
    });
    expect(await screen.findByText("Exited (0)")).toBeTruthy();

    resolveReady(info);
    await act(async () => ready);
    expect(screen.queryByText("Running")).toBeNull();
    expect(onRunningChange).toHaveBeenCalledTimes(1);
    expect(onRunningChange).toHaveBeenCalledWith(false);
  });

  it("keeps an error received before ready terminal and reports stopped once", async () => {
    let resolveReady!: (value: TerminalInfo) => void;
    const ready = new Promise<TerminalInfo>((resolve) => {
      resolveReady = resolve;
    });
    const onRunningChange = vi.fn();
    mocks.createTerminal.mockImplementation((_paneId, _cols, _rows, onEvent) => {
      mocks.event = onEvent;
      return makeClient(ready);
    });

    render(
      <TerminalPane paneId="primary" onRequestClose={vi.fn()} onRunningChange={onRunningChange} />,
    );
    act(() => {
      mocks.event?.({
        type: "error",
        paneId: "primary",
        terminalId: "terminal-1",
        message: "shell failed immediately",
      });
    });
    expect((await screen.findByRole("alert")).textContent).toContain("shell failed immediately");

    resolveReady(info);
    await act(async () => ready);
    expect(screen.queryByText("Running")).toBeNull();
    expect(onRunningChange).toHaveBeenCalledTimes(1);
    expect(onRunningChange).toHaveBeenCalledWith(false);
  });

  it("reports stopped when the initial fitted dimensions are invalid", () => {
    mocks.terminal.cols = 1;
    const onRunningChange = vi.fn();

    render(
      <TerminalPane paneId="primary" onRequestClose={vi.fn()} onRunningChange={onRunningChange} />,
    );

    expect(screen.getByRole("alert").textContent).toContain("too small");
    expect(screen.queryByText("Running")).toBeNull();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(onRunningChange).toHaveBeenCalledTimes(1);
    expect(onRunningChange).toHaveBeenCalledWith(false);
  });

  it("renders natural exit and requests an unguarded close", async () => {
    const requestClose = vi.fn();
    render(<TerminalPane paneId="primary" onRequestClose={requestClose} />);
    await screen.findByText("Running");
    act(() => {
      mocks.event?.({
        type: "exit",
        paneId: "primary",
        terminalId: "terminal-1",
        exitCode: 7,
      });
    });
    expect(screen.getByText("Exited (7)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(requestClose).toHaveBeenCalledWith(false);
  });

  it("shows startup errors", async () => {
    const failed = Promise.resolve().then(() => {
      throw new Error("spawn failed");
    });
    mocks.createTerminal.mockReturnValue(makeClient(failed));
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("spawn failed");
  });

  it("requests confirmation while running and closes on unmount during create", async () => {
    let resolve!: (value: TerminalInfo) => void;
    const pending = new Promise<TerminalInfo>((done) => {
      resolve = done;
    });
    const terminalClient = makeClient(pending);
    mocks.createTerminal.mockReturnValue(terminalClient);
    const requestClose = vi.fn();
    const view = render(<TerminalPane paneId="primary" onRequestClose={requestClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close running terminal" }));
    expect(requestClose).toHaveBeenCalledWith(true);
    view.unmount();
    expect(terminalClient.close).toHaveBeenCalledOnce();
    resolve(info);
    await act(async () => pending);
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.terminal.dispose).toHaveBeenCalledOnce();
  });
});
