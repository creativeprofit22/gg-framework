export interface RuntimeModeRefs {
  planModeRef?: { current: boolean };
}

/**
 * True when this process is the gg-app sidecar. Tauri always spawns it with
 * `GG_APP_PORT` set (even to "0"); the plain `ggcoder` CLI never sets it.
 *
 * Used to phrase user-facing notices in terms of the desktop app's UI instead
 * of TUI keybinds, and to hide TUI-only surfaces the app doesn't render.
 */
export function isGgApp(): boolean {
  return process.env.GG_APP_PORT !== undefined;
}

export function isPlanModeActive(planModeRef?: { current: boolean }): boolean {
  return planModeRef?.current === true;
}

export function planModeRestriction(toolName: string): string {
  return `Error: ${toolName} is restricted in plan mode. Use read-only tools to explore (read-only bash like git log, wc, grep is allowed), write the plan under .gg/plans/, then call exit_plan for review.`;
}
