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
    openExternalTerminal: vi.fn(),
    event: undefined as ((event: TerminalEvent) => void) | undefined,
    data: undefined as ((data: string) => void) | undefined,
    binary: undefined as ((data: string) => void) | undefined,
    resizeObservers: [] as Array<{ callback: () => void; target?: Element }>,
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
vi.mock("./agent", () => ({
  createTerminal: mocks.createTerminal,
  openExternalTerminal: mocks.openExternalTerminal,
}));

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
  mocks.resizeObservers = [];
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
  mocks.openExternalTerminal.mockResolvedValue(undefined);
  mocks.createTerminal.mockImplementation(
    (_paneId: string, _cols: number, _rows: number, onEvent: (event: TerminalEvent) => void) => {
      mocks.event = onEvent;
      return makeClient();
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private observer: { callback: () => void; target?: Element };

      constructor(callback: () => void) {
        this.observer = { callback };
        mocks.resizeObservers.push(this.observer);
      }
      observe(target: Element) {
        this.observer.target = target;
      }
      disconnect() {
        mocks.disconnect();
      }
    },
  );
});

describe("TerminalPane", () => {
  it("creates no PTY while restored stopped and creates exactly one for the owner on restart", async () => {
    const onRestart = vi.fn(() => Promise.resolve());
    const onRequestClose = vi.fn();
    render(
      <TerminalPane
        paneId="secondary"
        initiallyStopped
        onRestart={onRestart}
        onRequestClose={onRequestClose}
      />,
    );

    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));

    expect(onRestart).toHaveBeenCalledOnce();
    await screen.findByText("Running");
    expect(mocks.createTerminal).toHaveBeenCalledOnce();
    expect(mocks.createTerminal).toHaveBeenCalledWith("secondary", 80, 24, expect.any(Function));
    expect(screen.getByText("C:\\project · cmd.exe")).toBeTruthy();
  });

  it("waits for restart registration and stays stopped when registration fails", async () => {
    let rejectRegistration!: (cause: Error) => void;
    const onRestart = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRegistration = reject;
        }),
    );
    render(
      <TerminalPane
        paneId="secondary"
        initiallyStopped
        onRestart={onRestart}
        onRequestClose={vi.fn()}
      />,
    );

    const restart = screen.getByRole("button", { name: "Restart terminal" });
    fireEvent.click(restart);
    fireEvent.click(restart);
    expect(onRestart).toHaveBeenCalledOnce();
    expect(mocks.createTerminal).not.toHaveBeenCalled();

    await act(async () => rejectRegistration(new Error("target registration rejected")));
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("target registration rejected");
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it("applies controlled height and reports user resizing without recreating xterm", () => {
    const onHeightChange = vi.fn();
    const view = render(
      <TerminalPane
        paneId="primary"
        height={300}
        onHeightChange={onHeightChange}
        onRequestClose={vi.fn()}
      />,
    );
    const pane = screen.getByRole("region", { name: "Terminal for primary" });
    expect(pane.style.getPropertyValue("--terminal-dock-height")).toBe("300px");

    let renderedHeight = 300;
    vi.spyOn(pane, "getBoundingClientRect").mockImplementation(
      () => ({ height: renderedHeight }) as DOMRect,
    );
    const paneObserver = mocks.resizeObservers.find(({ target }) => target === pane);
    renderedHeight = 340;
    act(() => paneObserver?.callback());
    expect(onHeightChange).toHaveBeenCalledWith(340);

    view.rerender(
      <TerminalPane
        paneId="primary"
        height={340}
        onHeightChange={onHeightChange}
        onRequestClose={vi.fn()}
      />,
    );
    expect(pane.style.getPropertyValue("--terminal-dock-height")).toBe("340px");
    expect(mocks.createTerminal).toHaveBeenCalledOnce();
  });

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

  it("does not replay input or resize the PTY during mount", async () => {
    const terminalClient = makeClient();
    mocks.createTerminal.mockReturnValue(terminalClient);

    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);
    await screen.findByText("Running");

    const hostObserver = mocks.resizeObservers.find(({ target }) =>
      target?.classList.contains("terminal-pane-xterm"),
    );
    act(() => hostObserver?.callback());
    expect(terminalClient.input).not.toHaveBeenCalled();
    expect(terminalClient.resize).not.toHaveBeenCalled();
  });

  it("sends one catch-up resize before buffered input when size changes during create", async () => {
    let resolveReady!: (value: TerminalInfo) => void;
    const ready = new Promise<TerminalInfo>((resolve) => {
      resolveReady = resolve;
    });
    const calls: string[] = [];
    const terminalClient = makeClient(ready);
    vi.mocked(terminalClient.resize).mockImplementation(async () => {
      calls.push("resize");
    });
    vi.mocked(terminalClient.input).mockImplementation(async () => {
      calls.push("input");
    });
    mocks.createTerminal.mockReturnValue(terminalClient);
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);

    mocks.terminal.cols = 100;
    mocks.terminal.rows = 30;
    const hostObserver = mocks.resizeObservers.find(({ target }) =>
      target?.classList.contains("terminal-pane-xterm"),
    );
    act(() => {
      hostObserver?.callback();
      mocks.data?.("buffered");
    });
    await act(async () => Promise.resolve());
    expect(terminalClient.resize).not.toHaveBeenCalled();
    expect(terminalClient.input).not.toHaveBeenCalled();

    await act(async () => {
      resolveReady(info);
      await ready;
    });
    await screen.findByText("Running");
    await waitFor(() => expect(terminalClient.input).toHaveBeenCalledOnce());
    expect(terminalClient.resize).toHaveBeenCalledOnce();
    expect(terminalClient.resize).toHaveBeenCalledWith(100, 30);
    expect(calls).toEqual(["resize", "input"]);
  });

  it("sends no catch-up resize when pending fitted dimensions are unchanged", async () => {
    let resolveReady!: (value: TerminalInfo) => void;
    const ready = new Promise<TerminalInfo>((resolve) => {
      resolveReady = resolve;
    });
    const terminalClient = makeClient(ready);
    mocks.createTerminal.mockReturnValue(terminalClient);
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);

    const hostObserver = mocks.resizeObservers.find(({ target }) =>
      target?.classList.contains("terminal-pane-xterm"),
    );
    act(() => hostObserver?.callback());
    await act(async () => {
      resolveReady(info);
      await ready;
    });

    await screen.findByText("Running");
    expect(terminalClient.resize).not.toHaveBeenCalled();
  });

  it("uses only the latest dimensions after multiple pending size changes", async () => {
    let resolveReady!: (value: TerminalInfo) => void;
    const ready = new Promise<TerminalInfo>((resolve) => {
      resolveReady = resolve;
    });
    const terminalClient = makeClient(ready);
    mocks.createTerminal.mockReturnValue(terminalClient);
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);

    const hostObserver = mocks.resizeObservers.find(({ target }) =>
      target?.classList.contains("terminal-pane-xterm"),
    );
    act(() => {
      mocks.terminal.cols = 90;
      mocks.terminal.rows = 25;
      hostObserver?.callback();
      mocks.terminal.cols = 120;
      mocks.terminal.rows = 40;
      hostObserver?.callback();
    });
    await act(async () => {
      resolveReady(info);
      await ready;
    });

    await screen.findByText("Running");
    expect(terminalClient.resize).toHaveBeenCalledOnce();
    expect(terminalClient.resize).toHaveBeenCalledWith(120, 40);
  });

  it("sends no resize or buffered input when create fails", async () => {
    let rejectReady!: (cause: Error) => void;
    const ready = new Promise<TerminalInfo>((_resolve, reject) => {
      rejectReady = reject;
    });
    const terminalClient = makeClient(ready);
    mocks.createTerminal.mockReturnValue(terminalClient);
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);

    mocks.terminal.cols = 100;
    mocks.terminal.rows = 30;
    const hostObserver = mocks.resizeObservers.find(({ target }) =>
      target?.classList.contains("terminal-pane-xterm"),
    );
    act(() => {
      hostObserver?.callback();
      mocks.data?.("buffered");
    });
    await act(async () => Promise.resolve());
    await act(async () => rejectReady(new Error("spawn failed")));

    expect((await screen.findByRole("alert")).textContent).toContain("spawn failed");
    expect(terminalClient.resize).not.toHaveBeenCalled();
    expect(terminalClient.input).not.toHaveBeenCalled();
  });

  it("resizes only an existing PTY when its fitted dimensions change", async () => {
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
    const hostObserver = mocks.resizeObservers.find(({ target }) =>
      target?.classList.contains("terminal-pane-xterm"),
    );
    act(() => hostObserver?.callback());
    await act(async () => vi.advanceTimersByTimeAsync(40));
    expect(terminalClient.resize).toHaveBeenCalledWith(100, 30);
    expect(terminalClient.resize).toHaveBeenCalledTimes(1);
    act(() => hostObserver?.callback());
    await act(async () => vi.advanceTimersByTimeAsync(40));
    expect(terminalClient.resize).toHaveBeenCalledTimes(1);
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
    const onStartupFailure = vi.fn();
    mocks.createTerminal.mockImplementation((_paneId, _cols, _rows, onEvent) => {
      mocks.event = onEvent;
      return makeClient(ready);
    });

    render(
      <TerminalPane
        paneId="primary"
        onRequestClose={vi.fn()}
        onRunningChange={onRunningChange}
        onStartupFailure={onStartupFailure}
      />,
    );
    act(() => {
      mocks.event?.({
        type: "error",
        paneId: "primary",
        terminalId: "terminal-1",
        message: "shell failed immediately",
      });
      mocks.event?.({
        type: "error",
        paneId: "primary",
        terminalId: "terminal-1",
        message: "duplicate startup error",
      });
    });
    expect((await screen.findByRole("alert")).textContent).toContain("shell failed immediately");

    resolveReady(info);
    await act(async () => ready);
    expect(screen.queryByText("Running")).toBeNull();
    expect(onRunningChange).toHaveBeenCalledTimes(1);
    expect(onRunningChange).toHaveBeenCalledWith(false);
    expect(onStartupFailure).toHaveBeenCalledOnce();
  });

  it("reports stopped when the initial fitted dimensions are invalid", () => {
    mocks.terminal.cols = 1;
    const onRunningChange = vi.fn();
    const onStartupFailure = vi.fn();

    render(
      <TerminalPane
        paneId="primary"
        onRequestClose={vi.fn()}
        onRunningChange={onRunningChange}
        onStartupFailure={onStartupFailure}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("too small");
    expect(screen.queryByText("Running")).toBeNull();
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(onRunningChange).toHaveBeenCalledTimes(1);
    expect(onRunningChange).toHaveBeenCalledWith(false);
    expect(onStartupFailure).toHaveBeenCalledOnce();
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

  it("opens the failed pane cwd externally and reports success", async () => {
    const failed = Promise.reject(new Error("spawn failed"));
    const onStartupFailure = vi.fn();
    mocks.createTerminal.mockReturnValue(makeClient(failed));
    render(
      <TerminalPane
        paneId="secondary"
        onRequestClose={vi.fn()}
        onStartupFailure={onStartupFailure}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open in external terminal" }));

    await waitFor(() => expect(mocks.openExternalTerminal).toHaveBeenCalledWith("secondary"));
    expect(onStartupFailure).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole("button", { name: "Opened in external terminal" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps startup recovery available and displays an external launch failure", async () => {
    mocks.createTerminal.mockReturnValue(makeClient(Promise.reject(new Error("spawn failed"))));
    mocks.openExternalTerminal.mockRejectedValueOnce(new Error("terminal app unavailable"));
    render(<TerminalPane paneId="primary" onRequestClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open in external terminal" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("terminal app unavailable"),
    );
    expect(
      (screen.getByRole("button", { name: "Open in external terminal" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("does not report startup failure after a running terminal later exits or errors", async () => {
    const onStartupFailure = vi.fn();
    const view = render(
      <TerminalPane
        paneId="primary"
        onRequestClose={vi.fn()}
        onStartupFailure={onStartupFailure}
      />,
    );
    await screen.findByText("Running");
    act(() => {
      mocks.event?.({
        type: "exit",
        paneId: "primary",
        terminalId: "terminal-1",
        exitCode: 1,
      });
    });
    expect(screen.queryByRole("button", { name: "Open in external terminal" })).toBeNull();
    expect(onStartupFailure).not.toHaveBeenCalled();

    view.unmount();
    render(
      <TerminalPane
        paneId="primary"
        onRequestClose={vi.fn()}
        onStartupFailure={onStartupFailure}
      />,
    );
    await screen.findByText("Running");
    act(() => {
      mocks.event?.({
        type: "error",
        paneId: "primary",
        terminalId: "terminal-1",
        message: "later transport failure",
      });
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in external terminal" })).toBeNull();
    expect(onStartupFailure).not.toHaveBeenCalled();
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
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);
    expect(mocks.terminal.dispose).toHaveBeenCalledOnce();
  });
});
