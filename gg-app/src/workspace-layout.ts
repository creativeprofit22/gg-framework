export const WORKSPACE_LAYOUT_VERSION = 5;
export const DEFAULT_SPLIT_RATIO = 50;
export const MIN_SPLIT_RATIO = 10;
export const MAX_SPLIT_RATIO = 90;
export const DEFAULT_TERMINAL_DOCK_HEIGHT_PX = 260;
export const MIN_TERMINAL_DOCK_HEIGHT_PX = 140;
export const MAX_TERMINAL_DOCK_HEIGHT_PX = 2_000;

export type WorkspacePaneId = "primary" | "secondary";

export interface WorkspacePaneTarget {
  cwd: string;
  sessionPath: string | null;
}

export interface WorkspaceTerminalLayout {
  open: boolean;
  ownerPaneId: WorkspacePaneId | null;
  dockHeightPx: number;
}

export interface WorkspaceLayout {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  splitRatio: number;
  secondaryOpen: boolean;
  focusedPaneId: WorkspacePaneId;
  panes: Record<WorkspacePaneId, WorkspacePaneTarget | null>;
  terminal: WorkspaceTerminalLayout;
}

export type WorkspaceLayoutLoadStatus = "missing" | "valid" | "migrated" | "corrupt" | "load-error";

export interface WorkspaceLayoutLoadResult {
  layout: WorkspaceLayout;
  status: WorkspaceLayoutLoadStatus;
  rejectedRaw?: string;
  terminalDockHeightRecovery?: { rejected: unknown; resolved: number };
}

export interface WorkspaceTargetStatus {
  projectExists: boolean;
  sessionExists: boolean;
}

interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface LegacyWorkspaceLayout {
  version: 0;
  ratio?: unknown;
  primary?: unknown;
  secondary?: unknown;
}

const PANE_IDS: WorkspacePaneId[] = ["primary", "secondary"];

export function workspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout:${windowLabel}`;
}

export function rejectedWorkspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout-rejected:${windowLabel}`;
}

export function defaultWorkspaceLayout(): WorkspaceLayout {
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    splitRatio: DEFAULT_SPLIT_RATIO,
    secondaryOpen: true,
    focusedPaneId: "primary",
    panes: { primary: null, secondary: null },
    terminal: { open: false, ownerPaneId: null, dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX },
  };
}

export function clampStoredSplitRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

export interface TerminalDockHeightClampResult {
  value: number;
  recovered: boolean;
}

export function clampStoredTerminalDockHeightPx(value: unknown): TerminalDockHeightClampResult {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { value: DEFAULT_TERMINAL_DOCK_HEIGHT_PX, recovered: true };
  }
  const clamped = Math.min(
    MAX_TERMINAL_DOCK_HEIGHT_PX,
    Math.max(MIN_TERMINAL_DOCK_HEIGHT_PX, value),
  );
  return { value: clamped, recovered: clamped !== value };
}

function parseTarget(
  value: unknown,
  allowMissingSessionPath = false,
): WorkspacePaneTarget | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.cwd !== "string" || record.cwd.trim() === "") return undefined;
  if (
    record.sessionPath !== null &&
    record.sessionPath !== undefined &&
    typeof record.sessionPath !== "string"
  ) {
    return undefined;
  }
  if (record.sessionPath === undefined && !allowMissingSessionPath) return undefined;
  return {
    cwd: record.cwd,
    sessionPath:
      typeof record.sessionPath === "string" && record.sessionPath ? record.sessionPath : null,
  };
}

function normalizeFocusedPaneId(value: unknown, secondaryOpen: boolean): WorkspacePaneId {
  return value === "secondary" && secondaryOpen ? "secondary" : "primary";
}

function parseVersionThree(value: Record<string, unknown>): WorkspaceLayout | null {
  if (typeof value.panes !== "object" || value.panes === null) return null;
  if (typeof value.secondaryOpen !== "boolean") return null;
  const panes = value.panes as Record<string, unknown>;
  const primary = parseTarget(panes.primary);
  const secondary = parseTarget(panes.secondary);
  if (primary === undefined || secondary === undefined) return null;
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    splitRatio: clampStoredSplitRatio(value.splitRatio),
    secondaryOpen: value.secondaryOpen,
    focusedPaneId: normalizeFocusedPaneId(value.focusedPaneId, value.secondaryOpen),
    panes: { primary, secondary },
    terminal: { open: false, ownerPaneId: null, dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX },
  };
}

function parseVersionFour(value: Record<string, unknown>): WorkspaceLayout | null {
  const layout = parseVersionThree(value);
  if (!layout || typeof value.terminal !== "object" || value.terminal === null) return null;
  const terminal = value.terminal as Record<string, unknown>;
  if (Object.keys(terminal).some((key) => key !== "open" && key !== "ownerPaneId")) return null;
  if (typeof terminal.open !== "boolean") return null;
  if (!terminal.open) {
    if (terminal.ownerPaneId !== null) return null;
    return layout;
  }
  if (terminal.ownerPaneId !== "primary" && terminal.ownerPaneId !== "secondary") return null;
  if (terminal.ownerPaneId === "secondary" && !layout.secondaryOpen) return layout;
  return {
    ...layout,
    terminal: {
      open: true,
      ownerPaneId: terminal.ownerPaneId,
      dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX,
    },
  };
}

function parseCurrent(value: Record<string, unknown>): WorkspaceLayout | null {
  if (typeof value.terminal !== "object" || value.terminal === null) return null;
  const terminal = value.terminal as Record<string, unknown>;
  if (
    Object.keys(terminal).some(
      (key) => key !== "open" && key !== "ownerPaneId" && key !== "dockHeightPx",
    )
  )
    return null;
  if (typeof terminal.dockHeightPx !== "number") return null;
  const legacyValue = {
    ...value,
    terminal: { open: terminal.open, ownerPaneId: terminal.ownerPaneId },
  };
  const layout = parseVersionFour(legacyValue);
  if (!layout) return null;
  return {
    ...layout,
    terminal: {
      ...layout.terminal,
      dockHeightPx: clampStoredTerminalDockHeightPx(terminal.dockHeightPx).value,
    },
  };
}

function migrateVersionTwo(value: Record<string, unknown>): WorkspaceLayout | null {
  const layout = parseVersionThree(value);
  return layout ? { ...layout, focusedPaneId: "primary" } : null;
}

function migrateVersionOne(value: Record<string, unknown>): WorkspaceLayout | null {
  if (typeof value.panes !== "object" || value.panes === null) return null;
  const panes = value.panes as Record<string, unknown>;
  const primary = parseTarget(panes.primary);
  const secondary = parseTarget(panes.secondary);
  if (primary === undefined || secondary === undefined) return null;
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    splitRatio: clampStoredSplitRatio(value.splitRatio),
    secondaryOpen: true,
    focusedPaneId: "primary",
    panes: { primary, secondary },
    terminal: { open: false, ownerPaneId: null, dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX },
  };
}

function migrateLegacy(value: LegacyWorkspaceLayout): WorkspaceLayout | null {
  const primary = parseTarget(value.primary ?? null, true);
  const secondary = parseTarget(value.secondary ?? null, true);
  if (primary === undefined || secondary === undefined) return null;
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    splitRatio: clampStoredSplitRatio(value.ratio),
    secondaryOpen: true,
    focusedPaneId: "primary",
    panes: { primary, secondary },
    terminal: { open: false, ownerPaneId: null, dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX },
  };
}

export function parseWorkspaceLayout(raw: string): WorkspaceLayoutLoadResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (typeof value !== "object" || value === null) {
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }

  const record = value as Record<string, unknown>;
  if (record.version === WORKSPACE_LAYOUT_VERSION) {
    const layout = parseCurrent(record);
    if (!layout) return { layout: defaultWorkspaceLayout(), status: "corrupt" };
    const terminal = record.terminal as Record<string, unknown>;
    const height = clampStoredTerminalDockHeightPx(terminal.dockHeightPx);
    return {
      layout,
      status: "valid",
      ...(height.recovered
        ? {
            terminalDockHeightRecovery: {
              rejected: terminal.dockHeightPx,
              resolved: height.value,
            },
          }
        : {}),
    };
  }
  if (record.version === 4) {
    const layout = parseVersionFour(record);
    return layout
      ? { layout, status: "migrated" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (record.version === 3) {
    const layout = parseVersionThree(record);
    return layout
      ? { layout, status: "migrated" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (record.version === 2) {
    const layout = migrateVersionTwo(record);
    return layout
      ? { layout, status: "migrated" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (record.version === 1) {
    const layout = migrateVersionOne(record);
    return layout
      ? { layout, status: "migrated" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (record.version === 0) {
    const layout = migrateLegacy(record as unknown as LegacyWorkspaceLayout);
    return layout
      ? { layout, status: "migrated" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  return { layout: defaultWorkspaceLayout(), status: "corrupt" };
}

export function loadWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
): WorkspaceLayoutLoadResult {
  try {
    const raw = storage.getItem(workspaceLayoutKey(windowLabel));
    if (raw === null) return { layout: defaultWorkspaceLayout(), status: "missing" };
    const result = parseWorkspaceLayout(raw);
    return result.status === "corrupt" ? { ...result, rejectedRaw: raw } : result;
  } catch {
    return { layout: defaultWorkspaceLayout(), status: "load-error" };
  }
}

export function preserveRejectedWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
  raw: string,
): boolean {
  try {
    storage.setItem(rejectedWorkspaceLayoutKey(windowLabel), raw);
    return true;
  } catch {
    return false;
  }
}

export function saveWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
  layout: WorkspaceLayout,
): boolean {
  try {
    const secondaryOpen = layout.secondaryOpen === true;
    const terminalOpen = layout.terminal.open === true;
    const serializedLayout: WorkspaceLayout = {
      version: WORKSPACE_LAYOUT_VERSION,
      splitRatio: clampStoredSplitRatio(layout.splitRatio),
      secondaryOpen,
      focusedPaneId: normalizeFocusedPaneId(layout.focusedPaneId, secondaryOpen),
      panes: {
        primary: layout.panes.primary
          ? { cwd: layout.panes.primary.cwd, sessionPath: layout.panes.primary.sessionPath }
          : null,
        secondary: layout.panes.secondary
          ? { cwd: layout.panes.secondary.cwd, sessionPath: layout.panes.secondary.sessionPath }
          : null,
      },
      terminal: {
        open: terminalOpen,
        ownerPaneId: terminalOpen
          ? normalizeFocusedPaneId(layout.terminal.ownerPaneId, secondaryOpen)
          : null,
        dockHeightPx: clampStoredTerminalDockHeightPx(
          "dockHeightPx" in layout.terminal ? layout.terminal.dockHeightPx : undefined,
        ).value,
      },
    };
    storage.setItem(workspaceLayoutKey(windowLabel), JSON.stringify(serializedLayout));
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceLayoutTargets(
  layout: WorkspaceLayout,
  validate: (target: WorkspacePaneTarget) => Promise<WorkspaceTargetStatus>,
): Promise<WorkspaceLayout> {
  const entries = await Promise.all(
    PANE_IDS.map(async (paneId): Promise<[WorkspacePaneId, WorkspacePaneTarget | null]> => {
      const target = layout.panes[paneId];
      if (!target) return [paneId, null];
      try {
        const status = await validate(target);
        if (!status.projectExists) return [paneId, null];
        if (target.sessionPath && !status.sessionExists) {
          return [paneId, { cwd: target.cwd, sessionPath: null }];
        }
        return [paneId, target];
      } catch {
        return [paneId, null];
      }
    }),
  );

  return {
    ...layout,
    focusedPaneId: normalizeFocusedPaneId(layout.focusedPaneId, layout.secondaryOpen),
    panes: Object.fromEntries(entries) as WorkspaceLayout["panes"],
  };
}
