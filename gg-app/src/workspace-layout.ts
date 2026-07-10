export const WORKSPACE_LAYOUT_VERSION = 3;
export const DEFAULT_SPLIT_RATIO = 50;
export const MIN_SPLIT_RATIO = 10;
export const MAX_SPLIT_RATIO = 90;

export type WorkspacePaneId = "primary" | "secondary";

export interface WorkspacePaneTarget {
  cwd: string;
  sessionPath: string | null;
}

export interface WorkspaceLayout {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  splitRatio: number;
  secondaryOpen: boolean;
  focusedPaneId: WorkspacePaneId;
  panes: Record<WorkspacePaneId, WorkspacePaneTarget | null>;
}

export type WorkspaceLayoutLoadStatus = "missing" | "valid" | "migrated" | "corrupt";

export interface WorkspaceLayoutLoadResult {
  layout: WorkspaceLayout;
  status: WorkspaceLayoutLoadStatus;
  rejectedRaw?: string;
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
  };
}

export function clampStoredSplitRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
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

function parseCurrent(value: Record<string, unknown>): WorkspaceLayout | null {
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
  };
}

function migrateVersionTwo(value: Record<string, unknown>): WorkspaceLayout | null {
  const layout = parseCurrent(value);
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
    return layout
      ? { layout, status: "valid" }
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
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
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
    const normalizedLayout = {
      ...layout,
      focusedPaneId: normalizeFocusedPaneId(layout.focusedPaneId, layout.secondaryOpen),
    };
    storage.setItem(workspaceLayoutKey(windowLabel), JSON.stringify(normalizedLayout));
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
