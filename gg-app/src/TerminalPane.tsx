import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { X } from "lucide-react";
import { createTerminal, openExternalTerminal, type TerminalInfo } from "./agent";
import { TerminalAdapter, validTerminalSize } from "./terminal";

type TerminalStatus = "starting" | "running" | "exited" | "error";

export interface TerminalPaneProps {
  paneId: string;
  height?: number;
  onHeightChange?(height: number): void;
  onRequestClose(running: boolean): void;
  onRunningChange?(running: boolean): void;
  onStartupFailure?(): void;
}

export function TerminalPane({
  paneId,
  height,
  onHeightChange,
  onRequestClose,
  onRunningChange,
  onStartupFailure,
}: TerminalPaneProps) {
  const paneRef = useRef<HTMLElement>(null);
  const heightChangeRef = useRef(onHeightChange);
  const controlledHeightRef = useRef(height ?? 260);
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startupFailed, setStartupFailed] = useState(false);
  const [externalTerminalState, setExternalTerminalState] = useState<"idle" | "opening" | "opened">(
    "idle",
  );

  useEffect(() => {
    heightChangeRef.current = onHeightChange;
    controlledHeightRef.current = height ?? 260;
  }, [height, onHeightChange]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    let previousHeight = pane.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const nextHeight = pane.getBoundingClientRect().height;
      if (Math.abs(nextHeight - previousHeight) < 1) return;
      previousHeight = nextHeight;
      if (Math.abs(nextHeight - controlledHeightRef.current) >= 1) {
        heightChangeRef.current?.(nextHeight);
      }
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let lifecycle: TerminalStatus = "starting";
    let lastReportedRunning: boolean | undefined;
    let startupFailureReported = false;
    let terminalId: string | undefined;
    const reportRunning = (running: boolean): void => {
      if (lastReportedRunning === running) return;
      lastReportedRunning = running;
      onRunningChange?.(running);
    };
    const reportStartupFailure = (): void => {
      if (startupFailureReported) return;
      startupFailureReported = true;
      onStartupFailure?.();
    };
    const finishLifecycle = (nextStatus: "exited" | "error"): boolean => {
      if (lifecycle === "exited" || lifecycle === "error") return false;
      lifecycle = nextStatus;
      reportRunning(false);
      return true;
    };
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "var(--mono)",
      fontSize: 13,
      scrollback: 5_000,
      theme: {
        background: "#0d0f12",
        foreground: "#d7dce2",
        cursor: "#7aa2f7",
        selectionBackground: "#334155",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    terminal.focus();

    const initialCols = terminal.cols;
    const initialRows = terminal.rows;
    if (!validTerminalSize(initialCols, initialRows)) {
      finishLifecycle("error");
      reportStartupFailure();
      setStatus("error");
      setStartupFailed(true);
      setError("Terminal area is too small to start.");
      terminal.dispose();
      fitAddon.dispose();
      return;
    }

    let adapter: TerminalAdapter | null = null;
    let ptyReady = false;
    let lastPtySize = { cols: initialCols, rows: initialRows };
    let transportStopped = false;
    let pendingFinish: (() => void) | null = null;
    const pendingOutput: Uint8Array[] = [];
    const finishAfterOutput = (finish: () => void): void => {
      transportStopped = true;
      const finishIfMounted = () => {
        if (!disposed) finish();
      };
      if (adapter) adapter.finish(finishIfMounted);
      else pendingFinish = () => adapter?.finish(finishIfMounted);
    };
    const client = createTerminal(paneId, initialCols, initialRows, (event) => {
      if (event instanceof ArrayBuffer) {
        if (transportStopped) return;
        const data = new Uint8Array(event);
        if (adapter) adapter.write(data);
        else pendingOutput.push(data);
        return;
      }
      if (event.paneId !== paneId || (terminalId && event.terminalId !== terminalId)) return;
      if (event.type === "exit") {
        if (!finishLifecycle("exited")) return;
        finishAfterOutput(() => {
          setExitCode(event.exitCode);
          setStatus("exited");
        });
      } else {
        const failedDuringStartup = lifecycle === "starting";
        if (!finishLifecycle("error")) return;
        if (failedDuringStartup) reportStartupFailure();
        finishAfterOutput(() => {
          setStartupFailed(failedDuringStartup);
          setError(event.message);
          setStatus("error");
        });
      }
    });

    adapter = new TerminalAdapter(terminal, client, {
      onError(message) {
        const failedDuringStartup = lifecycle === "starting";
        if (disposed || !finishLifecycle("error")) return;
        if (failedDuringStartup) reportStartupFailure();
        transportStopped = true;
        adapter?.dispose();
        setStartupFailed(failedDuringStartup);
        setError(message);
        setStatus("error");
        void client.close().catch(() => {});
      },
      onOverflow() {
        const failedDuringStartup = lifecycle === "starting";
        if (disposed || !finishLifecycle("error")) return;
        if (failedDuringStartup) reportStartupFailure();
        transportStopped = true;
        adapter?.dispose();
        setStartupFailed(failedDuringStartup);
        setError("Terminal output exceeded the 4 MiB render queue. The terminal was closed.");
        setStatus("error");
        void client.close().catch(() => {});
      },
    });
    for (const data of pendingOutput.splice(0)) adapter.write(data);
    (pendingFinish as (() => void) | null)?.();

    void client.ready
      .then((created) => {
        terminalId = created.terminalId;
        if (disposed) return;
        ptyReady = true;
        lastPtySize = { cols: created.cols, rows: created.rows };
        setInfo(created);
        if (lifecycle === "starting" && !transportStopped) {
          lifecycle = "running";
          setStatus("running");
          reportRunning(true);
          terminal.focus();
        }
      })
      .catch((cause: unknown) => {
        if (disposed || !finishLifecycle("error")) return;
        reportStartupFailure();
        setStartupFailed(true);
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      });

    const fitAndResize = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
        if (
          ptyReady &&
          validTerminalSize(terminal.cols, terminal.rows) &&
          (terminal.cols !== lastPtySize.cols || terminal.rows !== lastPtySize.rows)
        ) {
          lastPtySize = { cols: terminal.cols, rows: terminal.rows };
          adapter?.resize(terminal.cols, terminal.rows);
        }
      } catch {
        // A zero-sized host can occur briefly during a native window resize.
      }
    };
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      adapter?.dispose();
      fitAddon.dispose();
      terminal.dispose();
      reportRunning(false);
      void client.close().catch(() => {});
    };
  }, [onRunningChange, onStartupFailure, paneId]);

  const openInExternalTerminal = async (): Promise<void> => {
    setExternalTerminalState("opening");
    try {
      await openExternalTerminal(paneId);
      setExternalTerminalState("opened");
    } catch (cause: unknown) {
      setExternalTerminalState("idle");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const running = status === "starting" || status === "running";
  const stateLabel =
    status === "starting"
      ? "Starting…"
      : status === "running"
        ? "Running"
        : status === "exited"
          ? `Exited${exitCode === null ? "" : ` (${exitCode})`}`
          : "Error";

  return (
    <section
      ref={paneRef}
      className="terminal-pane"
      aria-label={`Terminal for ${paneId}`}
      style={{ "--terminal-dock-height": `${height ?? 260}px` } as React.CSSProperties}
    >
      <header className="terminal-pane-header">
        <div className="terminal-pane-title">
          <strong>Terminal</strong>
          <span className={`terminal-pane-status terminal-pane-status-${status}`}>
            {stateLabel}
          </span>
          {info && (
            <span className="terminal-pane-meta" title={`${info.cwd} — ${info.shell}`}>
              {info.cwd} · {info.shell}
            </span>
          )}
        </div>
        <button
          type="button"
          className="terminal-pane-close"
          aria-label={running ? "Close running terminal" : "Close terminal"}
          onClick={() => onRequestClose(running)}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>
      {error && (
        <div className="terminal-pane-message terminal-pane-error" role="alert">
          <span>{error}</span>
          {startupFailed && (
            <button
              type="button"
              disabled={externalTerminalState !== "idle"}
              onClick={() => void openInExternalTerminal()}
            >
              {externalTerminalState === "opened"
                ? "Opened in external terminal"
                : externalTerminalState === "opening"
                  ? "Opening…"
                  : "Open in external terminal"}
            </button>
          )}
        </div>
      )}
      <div ref={hostRef} className="terminal-pane-xterm" />
    </section>
  );
}
