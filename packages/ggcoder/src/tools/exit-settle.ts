/**
 * Settle a foreground command on process exit even when a leftover helper
 * still holds its output pipes.
 *
 * Node emits `'close'` only after every stdio stream closes, while `'exit'`
 * fires when the process itself ends. A detached grandchild that inherited
 * stdout (a dev server, a report server) keeps `'close'` from ever firing.
 * After `'exit'`, wait `settleMs` for trailing output; if `'close'` still has
 * not arrived, destroy our pipe ends and report `pipesHeld: true`.
 */
import type { ChildProcess } from "node:child_process";

export interface ExitSettleResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  pipesHeld: boolean;
}

export interface WatchExitSettleOptions {
  child: ChildProcess;
  settleMs: number;
  onSettled: (result: ExitSettleResult) => void;
}

export function watchExitSettle(options: WatchExitSettleOptions): () => void {
  const { child, settleMs, onSettled } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    child.off("exit", onExit);
    child.off("close", onClose);
  };

  function onClose(code: number | null, signal: NodeJS.Signals | null): void {
    // The normal path: every pipe closed before the grace period ended.
    if (disposed) return;
    dispose();
    onSettled({ code, signal, pipesHeld: false });
  }

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (disposed) return;
    child.off("exit", onExit);
    timer = setTimeout(
      () => {
        if (disposed) return;
        dispose();
        child.stdout?.destroy();
        child.stderr?.destroy();
        onSettled({ code, signal, pipesHeld: true });
      },
      Math.max(0, settleMs),
    );
  }

  child.on("exit", onExit);
  child.on("close", onClose);
  return dispose;
}
