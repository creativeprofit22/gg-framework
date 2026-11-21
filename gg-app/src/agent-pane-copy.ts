import { invoke } from "@tauri-apps/api/core";
import { error as logError } from "@tauri-apps/plugin-log";
import type { RestoreTarget } from "./agent";

export interface PaneCopyResult {
  windowLabel: string;
  reusedWindow: boolean;
}

interface PreparedPaneCopy extends PaneCopyResult {
  copyId: string;
}

export class PaneCopyError extends Error {
  constructor(
    message: string,
    /** null when preparation failed before there was anything to roll back. */
    readonly rollbackSucceeded: boolean | null,
  ) {
    super(message);
    this.name = "PaneCopyError";
  }
}

/**
 * Copy one pane into a new native window without changing its source ownership.
 * Rust derives the source owner from this webview, reserves the destination,
 * starts a separate daemon session, and rolls the reservation back on failure.
 */
export async function copyPaneToNewWindow(paneId: string): Promise<PaneCopyResult> {
  const copyId =
    globalThis.crypto?.randomUUID?.() ??
    `copy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let prepared: PreparedPaneCopy | null = null;
  try {
    prepared = await invoke<PreparedPaneCopy>("agent_pane_copy", { paneId, copyId });
    return await invoke<PaneCopyResult>("agent_pane_copy_startup", { copyId });
  } catch (error) {
    let rollbackSucceeded: boolean | null = null;
    if (prepared) {
      try {
        await invoke("agent_pane_copy_rollback", { copyId });
        rollbackSucceeded = true;
      } catch (rollbackError) {
        await logError(`agent_pane_copy_rollback failed: ${String(rollbackError)}`);
      }
    }
    const suffix = rollbackSucceeded ? "" : " (rollback also failed)";
    throw new PaneCopyError(`${String(error)}${suffix}`, rollbackSucceeded);
  }
}

/** Consume the startup target only when this is an extracted-pane window. */
export async function copiedPaneRestoreTarget(): Promise<RestoreTarget | null> {
  try {
    return await invoke<RestoreTarget | null>("agent_pane_copy_restore");
  } catch (error) {
    await logError(`agent_pane_copy_restore failed: ${String(error)}`);
    return null;
  }
}
