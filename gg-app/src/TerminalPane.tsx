import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { X } from "lucide-react";
import { createTerminal, type TerminalInfo } from "./agent";
import { TerminalAdapter, validTerminalSize } from "./terminal";

type TerminalStatus = "starting" | "running" | "exited" | "error";

export interface TerminalPaneProps {
  paneId: string;
  onRequestClose(running: boolean): void;
  onRunningChange?(running: boolean): void;
}

export function TerminalPane({ paneId, onRequestClose, onRunningChange }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let terminalId: string | undefined;
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
      setStatus("error");
      setError("Terminal area is too small to start.");
      terminal.dispose();
      fitAddon.dispose();
      return;
    }

    let adapter: TerminalAdapter | null = null;
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
        finishAfterOutput(() => {
          setExitCode(event.exitCode);
          setStatus("exited");
          onRunningChange?.(false);
        });
      } else {
        finishAfterOutput(() => {
          setError(event.message);
          setStatus("error");
          onRunningChange?.(false);
        });
      }
    });

    adapter = new TerminalAdapter(terminal, client, {
      onError(message) {
        if (disposed) return;
        transportStopped = true;
        adapter?.dispose();
        setError(message);
        setStatus("error");
        onRunningChange?.(false);
        void client.close().catch(() => {});
      },
      onOverflow() {
        if (disposed) return;
        transportStopped = true;
        adapter?.dispose();
        setError("Terminal output exceeded the 4 MiB render queue. The terminal was closed.");
        setStatus("error");
        onRunningChange?.(false);
        void client.close().catch(() => {});
      },
    });
    for (const data of pendingOutput.splice(0)) adapter.write(data);
    (pendingFinish as (() => void) | null)?.();

    void client.ready
      .then((created) => {
        terminalId = created.terminalId;
        if (disposed) return;
        setInfo(created);
        if (!transportStopped) {
          setStatus("running");
          onRunningChange?.(true);
          terminal.focus();
        }
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
        onRunningChange?.(false);
      });

    const fitAndResize = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
        adapter?.resize(terminal.cols, terminal.rows);
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
      onRunningChange?.(false);
      void client.close().catch(() => {});
    };
  }, [onRunningChange, paneId]);

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
    <section className="terminal-pane" aria-label={`Terminal for ${paneId}`}>
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
          {error}
        </div>
      )}
      <div ref={hostRef} className="terminal-pane-xterm" />
    </section>
  );
}
