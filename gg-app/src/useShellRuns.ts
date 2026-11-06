import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  cancelShellCommand,
  getShellTrust,
  runShellCommand,
  setShellTrust,
  type HistoryEntry,
  type PaneAgentClient,
  type SidecarEvent,
} from "./agent";
import type { LiveTextStore } from "./live-text";
import type { Item, ShellItem } from "./transcript-item";

/**
 * Commands the user runs from the input with a leading `!` (`!git status`).
 *
 * Each one is a transcript row that never starts an agent turn. The command
 * runs only after the user approves it in that row, unless they chose "Always
 * allow in this project". Output streams into the row through the live-text
 * store and, once finished, reaches the agent with the user's next message.
 */
export type ShellChoice = "once" | "always" | "cancel";

export interface ShellActions {
  confirm: (itemId: number, choice: ShellChoice) => void;
  stop: (itemId: number) => void;
}

export interface ShellRuns extends ShellActions {
  shellTrusted: boolean;
  /** Re-read this project's trust setting (window opened or project switched). */
  refreshShellTrust: () => Promise<void>;
  /** Stop running the user's commands without asking in this project. */
  revokeShellTrust: () => Promise<void>;
  submitShell: (command: string, cwd: string) => void;
  /** The user sent a message: finished output now went to the agent with it. */
  markShellShared: () => void;
  handleShellEvent: (e: SidecarEvent) => boolean;
}

/** The command typed after `!`, or null when the input isn't a command. */
export function shellCommandFromInput(input: string): string | null {
  if (!input.startsWith("!")) return null;
  return input.slice(1).trim();
}

export function newShellRunId(): string {
  return `sh-${crypto.randomUUID()}`;
}

/** Any transcript row list that can hold command rows (Local Fork: panes keep their own union). */
type RowHost = { kind: string; id: number };

function isShellRow(it: RowHost): it is ShellItem {
  return it.kind === "shell";
}

function isUnsharedRow(it: RowHost): it is ShellItem {
  return isShellRow(it) && it.status === "done" && !it.shared;
}

/** Finished rows now read "Shared with GG". Same array when nothing changes. */
export function withShellShared<I extends RowHost = Item>(
  items: (I | ShellItem)[],
): (I | ShellItem)[] {
  if (!items.some(isUnsharedRow)) return items;
  return items.map((it) => (isUnsharedRow(it) ? { ...it, shared: true } : it));
}

/** A saved command row, as a reopened window shows it. */
export function shellItemFromHistory(
  shell: NonNullable<HistoryEntry["shell"]>,
  id: number,
  pendingRunIds: readonly string[],
): ShellItem {
  return {
    kind: "shell",
    id,
    runId: shell.runId,
    command: shell.command,
    cwd: shell.cwd,
    status: "done",
    output: shell.output,
    exitCode: shell.exitCode,
    durationMs: shell.durationMs,
    cancelled: shell.cancelled,
    truncated: shell.truncated,
    restored: true,
    ...(shell.error ? { error: shell.error } : {}),
    shared: !pendingRunIds.includes(shell.runId),
  };
}

function patchShell<I extends RowHost>(
  items: (I | ShellItem)[],
  itemId: number,
  patch: (it: ShellItem) => Partial<ShellItem>,
): (I | ShellItem)[] {
  return items.map((it) => (isShellRow(it) && it.id === itemId ? { ...it, ...patch(it) } : it));
}

/** The daemon calls a pane makes for its commands. */
export type ShellApi = Pick<
  PaneAgentClient,
  "runShellCommand" | "cancelShellCommand" | "getShellTrust" | "setShellTrust"
>;

const WINDOW_SHELL_API: ShellApi = {
  runShellCommand: (id, command, confirmed) => runShellCommand(id, command, confirmed),
  cancelShellCommand: (id) => cancelShellCommand(id),
  getShellTrust: () => getShellTrust(),
  setShellTrust: (trusted) => setShellTrust(trusted),
};

export function useShellRuns<I extends RowHost = Item>(deps: {
  setItems: Dispatch<SetStateAction<(I | ShellItem)[]>>;
  nextId: () => number;
  liveText: LiveTextStore;
  /** Put the caret back in the input once a confirmation is answered. */
  focusComposer: () => void;
  toast: (message: string, kind?: "error" | "warning") => void;
  /** Local Fork: a pane's own client, so its commands run in that pane's project. */
  api?: ShellApi;
}): ShellRuns {
  const { setItems, nextId, liveText, focusComposer, toast } = deps;
  const api = deps.api ?? WINDOW_SHELL_API;
  const [shellTrusted, setTrusted] = useState(false);
  const trustedRef = useRef(false);
  // runId → row, and row → what to run once it is approved.
  const rowsByRunRef = useRef(new Map<string, number>());
  const runsByRowRef = useRef(new Map<number, { runId: string; command: string }>());

  const applyTrust = useCallback((trusted: boolean) => {
    trustedRef.current = trusted;
    setTrusted(trusted);
  }, []);

  const start = useCallback(
    (itemId: number, confirmed: boolean) => {
      const run = runsByRowRef.current.get(itemId);
      if (!run) return;
      liveText.begin(itemId, "");
      setItems((prev) =>
        patchShell(prev, itemId, () => ({ status: "running", startedAt: Date.now() })),
      );
      void api.runShellCommand(run.runId, run.command, confirmed).then((res) => {
        if (res.ok) return;
        liveText.release(itemId);
        if (res.error === "confirmation_required") {
          // Trust was turned off elsewhere: ask in this row instead.
          applyTrust(false);
          setItems((prev) => patchShell(prev, itemId, () => ({ status: "confirm" })));
          return;
        }
        rowsByRunRef.current.delete(run.runId);
        setItems((prev) =>
          patchShell(prev, itemId, () => ({ status: "failed", error: res.error })),
        );
      });
    },
    [api, applyTrust, liveText, setItems],
  );

  const submitShell = useCallback(
    (command: string, cwd: string) => {
      const id = nextId();
      const runId = newShellRunId();
      rowsByRunRef.current.set(runId, id);
      runsByRowRef.current.set(id, { runId, command });
      const trusted = trustedRef.current;
      setItems((prev) => [
        ...prev,
        {
          kind: "shell",
          id,
          runId,
          command,
          cwd,
          status: trusted ? "running" : "confirm",
          output: "",
        },
      ]);
      if (trusted) start(id, false);
    },
    [nextId, setItems, start],
  );

  const confirm = useCallback(
    (itemId: number, choice: ShellChoice) => {
      focusComposer();
      if (choice === "cancel") {
        const run = runsByRowRef.current.get(itemId);
        if (run) rowsByRunRef.current.delete(run.runId);
        runsByRowRef.current.delete(itemId);
        setItems((prev) => patchShell(prev, itemId, () => ({ status: "declined" })));
        return;
      }
      start(itemId, true);
      if (choice === "always") {
        applyTrust(true);
        void api.setShellTrust(true).catch(() => {
          applyTrust(false);
          toast("Couldn't save that setting. Commands will still ask first.", "error");
        });
      }
    },
    [api, applyTrust, focusComposer, setItems, start, toast],
  );

  const stop = useCallback(
    (itemId: number) => {
      const run = runsByRowRef.current.get(itemId);
      if (run) void api.cancelShellCommand(run.runId);
    },
    [api],
  );

  const refreshShellTrust = useCallback(async () => {
    applyTrust(await api.getShellTrust());
  }, [api, applyTrust]);

  const revokeShellTrust = useCallback(async () => {
    applyTrust(false);
    try {
      applyTrust(await api.setShellTrust(false));
    } catch {
      toast("Couldn't save that setting. Try again.", "error");
      await refreshShellTrust();
    }
  }, [api, applyTrust, refreshShellTrust, toast]);

  const markShellShared = useCallback(
    () => setItems((prev) => withShellShared<I>(prev)),
    [setItems],
  );

  const handleShellEvent = useCallback(
    (e: SidecarEvent): boolean => {
      if (e.type !== "shell_output" && e.type !== "shell_end") return false;
      const d = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<
        string,
        unknown
      >;
      const runId = typeof d.id === "string" ? d.id : "";
      const itemId = rowsByRunRef.current.get(runId);
      // Another window's command, or one started before this window reloaded.
      if (itemId === undefined) return true;
      if (e.type === "shell_output") {
        if (typeof d.chunk === "string") liveText.append(itemId, d.chunk);
        return true;
      }
      const output = liveText.get(itemId) ?? "";
      rowsByRunRef.current.delete(runId);
      runsByRowRef.current.delete(itemId);
      setItems((prev) =>
        patchShell(prev, itemId, (it) => ({
          status: "done",
          output: output || it.output,
          exitCode: typeof d.exitCode === "number" ? d.exitCode : null,
          durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined,
          cancelled: d.cancelled === true,
          truncated: d.displayTruncated === true,
          ...(typeof d.error === "string" ? { error: d.error } : {}),
          shared: false,
        })),
      );
      liveText.release(itemId);
      return true;
    },
    [liveText, setItems],
  );

  return {
    shellTrusted,
    refreshShellTrust,
    revokeShellTrust,
    submitShell,
    confirm,
    stop,
    markShellShared,
    handleShellEvent,
  };
}
