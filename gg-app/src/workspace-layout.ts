import { PRIMARY_PANE_ID } from "./pane-routing";

export const WORKSPACE_LAYOUT_VERSION = 6;
export const DEFAULT_SPLIT_RATIO = 50;
export const MIN_SPLIT_RATIO = 10;
export const MAX_SPLIT_RATIO = 90;
export const DEFAULT_TERMINAL_DOCK_HEIGHT_PX = 260;
export const MIN_TERMINAL_DOCK_HEIGHT_PX = 140;
export const MAX_TERMINAL_DOCK_HEIGHT_PX = 2_000;
export const MAX_WORKSPACE_PANES = 4;
export const MAX_WORKSPACE_LAYOUT_DEPTH = 4;
const MAX_WORKSPACE_PANE_ID_BYTES = 64;

export type WorkspacePaneId = string;
export type SplitDirection = "horizontal" | "vertical";
export interface LeafNode {
  type: "leaf";
  paneId: WorkspacePaneId;
}
export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  ratio: number;
  first: WorkspaceLayoutNode;
  second: WorkspaceLayoutNode;
}
export type WorkspaceLayoutNode = LeafNode | SplitNode;

export interface WorkspacePaneTarget {
  cwd: string;
  sessionPath: string | null;
}
export interface WorkspaceTerminalLayout {
  open: boolean;
  ownerPaneId: WorkspacePaneId | null;
  dockHeightPx: number;
}

/** Canonical v6 layout plus the fixed projection consumed by WorkspaceShell. */
export interface WorkspaceLayout {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  root: WorkspaceLayoutNode;
  focusedPaneId: WorkspacePaneId;
  panes: Record<WorkspacePaneId, WorkspacePaneTarget | null>;
  terminal: WorkspaceTerminalLayout;
  splitRatio: number;
  secondaryOpen: boolean;
}

export interface FixedWorkspaceLayoutInput {
  version: number;
  splitRatio: number;
  secondaryOpen: boolean;
  focusedPaneId: WorkspacePaneId;
  panes: Record<WorkspacePaneId, WorkspacePaneTarget | null>;
  terminal: WorkspaceTerminalLayout;
}
export type WorkspaceLayoutSaveInput = WorkspaceLayout | FixedWorkspaceLayoutInput;
export type WorkspaceLayoutLoadStatus = "missing" | "valid" | "migrated" | "corrupt" | "load-error";
export interface WorkspaceLayoutLoadResult {
  layout: WorkspaceLayout;
  status: WorkspaceLayoutLoadStatus;
  rejectedRaw?: string;
  rejectedSource?: "legacy" | "recursive";
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
interface FixedLayout {
  splitRatio: number;
  secondaryOpen: boolean;
  focusedPaneId: string;
  panes: { primary: WorkspacePaneTarget | null; secondary: WorkspacePaneTarget | null };
  terminal: WorkspaceTerminalLayout;
  terminalDockHeightRecovery?: { rejected: unknown; resolved: number };
}

export function isValidWorkspacePaneId(value: unknown): value is WorkspacePaneId {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_WORKSPACE_PANE_ID_BYTES &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function workspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout:${windowLabel}`;
}
export function recursiveWorkspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout-recursive:${windowLabel}`;
}
export function rejectedWorkspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout-rejected:${windowLabel}`;
}
export function rejectedRecursiveWorkspaceLayoutKey(windowLabel: string): string {
  return `gg-workspace-layout-recursive-rejected:${windowLabel}`;
}

export function clampStoredSplitRatio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value))
    : DEFAULT_SPLIT_RATIO;
}
export interface TerminalDockHeightClampResult {
  value: number;
  recovered: boolean;
}
export function clampStoredTerminalDockHeightPx(value: unknown): TerminalDockHeightClampResult {
  if (typeof value !== "number" || !Number.isFinite(value))
    return { value: DEFAULT_TERMINAL_DOCK_HEIGHT_PX, recovered: true };
  const result = Math.min(
    MAX_TERMINAL_DOCK_HEIGHT_PX,
    Math.max(MIN_TERMINAL_DOCK_HEIGHT_PX, value),
  );
  return { value: result, recovered: result !== value };
}

export function workspaceLayoutLeafIds(root: WorkspaceLayoutNode): WorkspacePaneId[] {
  return root.type === "leaf"
    ? [root.paneId]
    : [...workspaceLayoutLeafIds(root.first), ...workspaceLayoutLeafIds(root.second)];
}

export type WorkspaceLayoutPath = readonly ("first" | "second")[];

/** Allocates one greater than the highest generated pane ordinal retained by this layout. */
export function allocateWorkspacePaneId(layout: WorkspaceLayout): WorkspacePaneId | null {
  if (workspaceLayoutLeafIds(layout.root).length >= MAX_WORKSPACE_PANES) return null;
  let highestOrdinal = 0;
  for (const paneId of [...workspaceLayoutLeafIds(layout.root), ...Object.keys(layout.panes)]) {
    const match = /^pane-(\d+)$/.exec(paneId);
    if (match) highestOrdinal = Math.max(highestOrdinal, Number(match[1]));
  }
  return `pane-${highestOrdinal + 1}`;
}

function updateNodeAtPath(
  node: WorkspaceLayoutNode,
  path: WorkspaceLayoutPath,
  update: (node: WorkspaceLayoutNode) => WorkspaceLayoutNode | null,
  depth = 0,
): WorkspaceLayoutNode | null {
  if (depth === path.length) return update(node);
  if (node.type !== "split") return null;
  const side = path[depth];
  const child = updateNodeAtPath(node[side], path, update, depth + 1);
  return child ? { ...node, [side]: child } : null;
}

/** Splits a visible leaf, preserving the existing leaf as the first child. */
export function splitWorkspacePane(
  layout: WorkspaceLayout,
  paneId: WorkspacePaneId,
  direction: SplitDirection,
  requestedPaneId?: WorkspacePaneId,
): WorkspaceLayout {
  const newPaneId = requestedPaneId ?? allocateWorkspacePaneId(layout);
  if (
    !newPaneId ||
    !isValidWorkspacePaneId(newPaneId) ||
    workspaceLayoutLeafIds(layout.root).length >= MAX_WORKSPACE_PANES ||
    workspaceLayoutLeafIds(layout.root).includes(newPaneId)
  )
    return layout;
  let changed = false;
  const splitLeaf = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === "leaf") {
      if (node.paneId !== paneId) return node;
      changed = true;
      return {
        type: "split",
        direction,
        ratio: DEFAULT_SPLIT_RATIO,
        first: node,
        second: { type: "leaf", paneId: newPaneId },
      };
    }
    return { ...node, first: splitLeaf(node.first), second: splitLeaf(node.second) };
  };
  const root = splitLeaf(layout.root);
  return changed
    ? normalizeLayout({
        ...layout,
        root,
        focusedPaneId: newPaneId,
        panes: { ...layout.panes, [newPaneId]: null },
      })
    : layout;
}

/** Updates only the split at the supplied stable tree path. */
export function updateWorkspaceSplitRatio(
  layout: WorkspaceLayout,
  path: WorkspaceLayoutPath,
  ratio: number,
): WorkspaceLayout {
  let changed = false;
  const root = updateNodeAtPath(layout.root, path, (node) => {
    if (node.type !== "split") return node;
    changed = true;
    return { ...node, ratio: clampStoredSplitRatio(ratio) };
  });
  return changed && root ? normalizeLayout({ ...layout, root }) : layout;
}

/** Removes a leaf and collapses its parent; focus moves to the nearest sibling leaf. */
export function removeWorkspacePane(
  layout: WorkspaceLayout,
  paneId: WorkspacePaneId,
): WorkspaceLayout {
  if (workspaceLayoutLeafIds(layout.root).length === 1) return layout;
  let removed = false;
  let survivor: WorkspacePaneId | null = null;
  const remove = (node: WorkspaceLayoutNode): WorkspaceLayoutNode | null => {
    if (node.type === "leaf") {
      if (node.paneId !== paneId) return node;
      removed = true;
      return null;
    }
    const first = remove(node.first);
    if (!first) {
      survivor = workspaceLayoutLeafIds(node.second)[0];
      return node.second;
    }
    const second = remove(node.second);
    if (!second) {
      const firstLeafIds = workspaceLayoutLeafIds(node.first);
      survivor = firstLeafIds[firstLeafIds.length - 1];
      return node.first;
    }
    return { ...node, first, second };
  };
  const root = remove(layout.root);
  if (!removed || !root) return layout;
  const panes = { ...layout.panes };
  delete panes[paneId];
  return normalizeLayout({
    ...layout,
    root,
    focusedPaneId: layout.focusedPaneId === paneId ? survivor! : layout.focusedPaneId,
    panes,
  });
}

function compatibility(root: WorkspaceLayoutNode): { splitRatio: number; secondaryOpen: boolean } {
  const secondaryOpen = workspaceLayoutLeafIds(root).includes("secondary");
  const fixed =
    root.type === "split" &&
    root.direction === "horizontal" &&
    root.first.type === "leaf" &&
    root.first.paneId === "primary" &&
    root.second.type === "leaf" &&
    root.second.paneId === "secondary";
  return { splitRatio: fixed ? root.ratio : DEFAULT_SPLIT_RATIO, secondaryOpen };
}

export function defaultWorkspaceLayout(): WorkspaceLayout {
  return normalizeLayout({
    version: 6,
    root: {
      type: "split",
      direction: "horizontal",
      ratio: 50,
      first: { type: "leaf", paneId: "primary" },
      second: { type: "leaf", paneId: "secondary" },
    },
    focusedPaneId: "primary",
    panes: { primary: null, secondary: null },
    terminal: { open: false, ownerPaneId: null, dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX },
    splitRatio: 50,
    secondaryOpen: true,
  });
}

function parseTarget(
  value: unknown,
  allowMissingSessionPath = false,
): WorkspacePaneTarget | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.cwd !== "string" || !record.cwd.trim()) return undefined;
  if (
    record.sessionPath !== null &&
    record.sessionPath !== undefined &&
    typeof record.sessionPath !== "string"
  )
    return undefined;
  if (record.sessionPath === undefined && !allowMissingSessionPath) return undefined;
  return {
    cwd: record.cwd,
    sessionPath:
      typeof record.sessionPath === "string" && record.sessionPath ? record.sessionPath : null,
  };
}

function parseNode(value: unknown, depth: number, ids: Set<string>): WorkspaceLayoutNode | null {
  if (depth > MAX_WORKSPACE_LAYOUT_DEPTH || typeof value !== "object" || value === null)
    return null;
  const record = value as Record<string, unknown>;
  if (record.type === "leaf") {
    if (!isValidWorkspacePaneId(record.paneId) || ids.has(record.paneId)) return null;
    ids.add(record.paneId);
    if (ids.size > MAX_WORKSPACE_PANES) return null;
    return { type: "leaf", paneId: record.paneId };
  }
  if (
    record.type !== "split" ||
    (record.direction !== "horizontal" && record.direction !== "vertical") ||
    typeof record.ratio !== "number" ||
    !Number.isFinite(record.ratio)
  )
    return null;
  const first = parseNode(record.first, depth + 1, ids);
  const second = parseNode(record.second, depth + 1, ids);
  return first && second
    ? {
        type: "split",
        direction: record.direction,
        ratio: clampStoredSplitRatio(record.ratio),
        first,
        second,
      }
    : null;
}

function parseTerminal(value: unknown): {
  terminal: WorkspaceTerminalLayout;
  recovery?: { rejected: unknown; resolved: number };
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["open", "ownerPaneId", "dockHeightPx"].includes(key)) ||
    typeof record.open !== "boolean" ||
    typeof record.dockHeightPx !== "number" ||
    (record.ownerPaneId !== null && typeof record.ownerPaneId !== "string") ||
    (record.open ? typeof record.ownerPaneId !== "string" : record.ownerPaneId !== null)
  )
    return null;
  const height = clampStoredTerminalDockHeightPx(record.dockHeightPx);
  return {
    terminal: {
      open: record.open,
      ownerPaneId: record.ownerPaneId as string | null,
      dockHeightPx: height.value,
    },
    ...(height.recovered
      ? { recovery: { rejected: record.dockHeightPx, resolved: height.value } }
      : {}),
  };
}

function normalizeLayout(
  layout: Omit<WorkspaceLayout, "splitRatio" | "secondaryOpen"> &
    Partial<Pick<WorkspaceLayout, "splitRatio" | "secondaryOpen">>,
): WorkspaceLayout {
  const visible = workspaceLayoutLeafIds(layout.root);
  const focusedPaneId = visible.includes(layout.focusedPaneId) ? layout.focusedPaneId : visible[0];
  const ownerValid =
    layout.terminal.open &&
    layout.terminal.ownerPaneId !== null &&
    visible.includes(layout.terminal.ownerPaneId) &&
    layout.panes[layout.terminal.ownerPaneId] !== null;
  const terminal = {
    open: ownerValid,
    ownerPaneId: ownerValid ? layout.terminal.ownerPaneId : null,
    dockHeightPx: clampStoredTerminalDockHeightPx(layout.terminal.dockHeightPx).value,
  };
  return {
    version: 6,
    root: layout.root,
    focusedPaneId,
    panes: layout.panes,
    terminal,
    ...compatibility(layout.root),
  };
}

function fixedToRecursive(fixed: FixedLayout): WorkspaceLayout {
  const root: WorkspaceLayoutNode = fixed.secondaryOpen
    ? {
        type: "split",
        direction: "horizontal",
        ratio: clampStoredSplitRatio(fixed.splitRatio),
        first: { type: "leaf", paneId: "primary" },
        second: { type: "leaf", paneId: "secondary" },
      }
    : { type: "leaf", paneId: "primary" };
  return normalizeLayout({
    version: 6,
    root,
    focusedPaneId: fixed.focusedPaneId,
    panes: { primary: fixed.panes.primary, secondary: fixed.panes.secondary },
    terminal: fixed.terminal,
  });
}

function parseFixed(record: Record<string, unknown>): FixedLayout | null {
  if (typeof record.panes !== "object" || record.panes === null) return null;
  const panes = record.panes as Record<string, unknown>;
  const primary = parseTarget(panes.primary),
    secondary = parseTarget(panes.secondary);
  if (primary === undefined || secondary === undefined) return null;
  const secondaryOpen = record.version === 0 || record.version === 1 ? true : record.secondaryOpen;
  if (typeof secondaryOpen !== "boolean") return null;
  let terminal: WorkspaceTerminalLayout = { open: false, ownerPaneId: null, dockHeightPx: 260 };
  let terminalDockHeightRecovery: FixedLayout["terminalDockHeightRecovery"];
  if (record.version === 4) {
    if (typeof record.terminal !== "object" || record.terminal === null) return null;
    const t = record.terminal as Record<string, unknown>;
    if (
      Object.keys(t).some((key) => !["open", "ownerPaneId"].includes(key)) ||
      typeof t.open !== "boolean" ||
      (t.open
        ? t.ownerPaneId !== "primary" && t.ownerPaneId !== "secondary"
        : t.ownerPaneId !== null)
    )
      return null;
    terminal = { open: t.open, ownerPaneId: t.ownerPaneId as string | null, dockHeightPx: 260 };
  } else if (record.version === 5) {
    const parsed = parseTerminal(record.terminal);
    if (!parsed) return null;
    terminal = parsed.terminal;
    if (parsed.recovery) terminalDockHeightRecovery = parsed.recovery;
  }
  return {
    splitRatio: clampStoredSplitRatio(record.splitRatio),
    secondaryOpen,
    focusedPaneId:
      record.version === 2
        ? "primary"
        : typeof record.focusedPaneId === "string"
          ? record.focusedPaneId
          : "primary",
    panes: { primary, secondary },
    terminal,
    ...(terminalDockHeightRecovery ? { terminalDockHeightRecovery } : {}),
  };
}

function parseV6(record: Record<string, unknown>): WorkspaceLayoutLoadResult | null {
  const ids = new Set<string>();
  const root = parseNode(record.root, 1, ids);
  if (
    !root ||
    !ids.has(PRIMARY_PANE_ID) ||
    typeof record.panes !== "object" ||
    record.panes === null
  )
    return null;
  const rawPanes = record.panes as Record<string, unknown>;
  const keys = Object.keys(rawPanes);
  if (
    keys.length > MAX_WORKSPACE_PANES ||
    keys.some((key) => !isValidWorkspacePaneId(key)) ||
    [...ids].some((id) => !(id in rawPanes))
  )
    return null;
  const panes: Record<string, WorkspacePaneTarget | null> = {};
  for (const key of keys) {
    const target = parseTarget(rawPanes[key]);
    if (target === undefined) return null;
    panes[key] = target;
  }
  const terminal = parseTerminal(record.terminal);
  if (!terminal) return null;
  const layout = normalizeLayout({
    version: 6,
    root,
    focusedPaneId: typeof record.focusedPaneId === "string" ? record.focusedPaneId : "",
    panes,
    terminal: terminal.terminal,
  });
  return {
    layout,
    status: "valid",
    ...(terminal.recovery ? { terminalDockHeightRecovery: terminal.recovery } : {}),
  };
}

export function parseWorkspaceLayout(raw: string): WorkspaceLayoutLoadResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (typeof value !== "object" || value === null)
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  const record = value as Record<string, unknown>;
  if (record.version === 6)
    return parseV6(record) ?? { layout: defaultWorkspaceLayout(), status: "corrupt" };
  if (![0, 1, 2, 3, 4, 5].includes(record.version as number))
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  let fixed: FixedLayout | null;
  if (record.version === 0) {
    const legacy = record as unknown as LegacyWorkspaceLayout;
    const primary = parseTarget(legacy.primary ?? null, true),
      secondary = parseTarget(legacy.secondary ?? null, true);
    fixed =
      primary === undefined || secondary === undefined
        ? null
        : {
            splitRatio: clampStoredSplitRatio(legacy.ratio),
            secondaryOpen: true,
            focusedPaneId: "primary",
            panes: { primary, secondary },
            terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
          };
  } else fixed = parseFixed(record);
  return fixed
    ? {
        layout: fixedToRecursive(fixed),
        status: "migrated",
        ...(fixed.terminalDockHeightRecovery
          ? { terminalDockHeightRecovery: fixed.terminalDockHeightRecovery }
          : {}),
      }
    : { layout: defaultWorkspaceLayout(), status: "corrupt" };
}

export function loadWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
): WorkspaceLayoutLoadResult {
  try {
    const recursiveRaw = storage.getItem(recursiveWorkspaceLayoutKey(windowLabel));
    if (recursiveRaw !== null) {
      const result = parseWorkspaceLayout(recursiveRaw);
      if (result.status !== "corrupt") return result;
      try {
        storage.setItem(rejectedRecursiveWorkspaceLayoutKey(windowLabel), recursiveRaw);
      } catch {
        // Diagnostic preservation is best-effort; the safe corrupt fallback still applies.
      }
      return { ...result, rejectedRaw: recursiveRaw, rejectedSource: "recursive" };
    }
    const raw = storage.getItem(workspaceLayoutKey(windowLabel));
    if (raw === null) return { layout: defaultWorkspaceLayout(), status: "missing" };
    const result = parseWorkspaceLayout(raw);
    return result.status === "corrupt"
      ? { ...result, rejectedRaw: raw, rejectedSource: "legacy" }
      : result;
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
export function preserveRejectedRecursiveWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
  raw: string,
): boolean {
  try {
    storage.setItem(rejectedRecursiveWorkspaceLayoutKey(windowLabel), raw);
    return true;
  } catch {
    return false;
  }
}

function canonicalizeInput(input: WorkspaceLayoutSaveInput): WorkspaceLayout | null {
  if ("root" in input && input.version === 6) {
    const parsed = parseWorkspaceLayout(
      JSON.stringify({
        version: 6,
        root: input.root,
        focusedPaneId: input.focusedPaneId,
        panes: input.panes,
        terminal: input.terminal,
      }),
    );
    return parsed.status === "valid" ? parsed.layout : null;
  }
  const primary = parseTarget(input.panes.primary),
    secondary = parseTarget(input.panes.secondary);
  if (primary === undefined || secondary === undefined) return null;
  return fixedToRecursive({
    splitRatio: input.splitRatio,
    secondaryOpen: input.secondaryOpen === true,
    focusedPaneId: input.focusedPaneId,
    panes: { primary, secondary },
    terminal: input.terminal,
  });
}

function canonicalBytes(layout: WorkspaceLayout): string {
  return JSON.stringify({
    version: 6,
    root: layout.root,
    focusedPaneId: layout.focusedPaneId,
    panes: layout.panes,
    terminal: layout.terminal,
  });
}
function rollbackProjection(layout: WorkspaceLayout): Record<string, unknown> | null {
  const fixed =
    (layout.root.type === "leaf" && layout.root.paneId === "primary") ||
    (layout.root.type === "split" &&
      layout.root.direction === "horizontal" &&
      layout.root.first.type === "leaf" &&
      layout.root.first.paneId === "primary" &&
      layout.root.second.type === "leaf" &&
      layout.root.second.paneId === "secondary");
  if (!fixed || !("primary" in layout.panes)) return null;
  const owner =
    layout.terminal.open &&
    (layout.terminal.ownerPaneId === "primary" || layout.terminal.ownerPaneId === "secondary")
      ? layout.terminal.ownerPaneId
      : null;
  return {
    version: 5,
    splitRatio: layout.splitRatio,
    secondaryOpen: layout.secondaryOpen,
    focusedPaneId:
      layout.focusedPaneId === "secondary" && layout.secondaryOpen ? "secondary" : "primary",
    panes: { primary: layout.panes.primary, secondary: layout.panes.secondary ?? null },
    terminal: {
      open: owner !== null,
      ownerPaneId: owner,
      dockHeightPx: layout.terminal.dockHeightPx,
    },
  };
}

export function saveWorkspaceLayout(
  storage: LayoutStorage,
  windowLabel: string,
  input: WorkspaceLayoutSaveInput,
): boolean {
  try {
    const layout = canonicalizeInput(input);
    if (!layout) return false;
    storage.setItem(recursiveWorkspaceLayoutKey(windowLabel), canonicalBytes(layout));
    const rollback = rollbackProjection(layout);
    if (rollback) storage.setItem(workspaceLayoutKey(windowLabel), JSON.stringify(rollback));
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
    Object.entries(layout.panes).map(
      async ([paneId, target]): Promise<[string, WorkspacePaneTarget | null]> => {
        if (!target) return [paneId, null];
        try {
          const status = await validate(target);
          if (!status.projectExists) return [paneId, null];
          return [
            paneId,
            target.sessionPath && !status.sessionExists
              ? { cwd: target.cwd, sessionPath: null }
              : target,
          ];
        } catch {
          return [paneId, null];
        }
      },
    ),
  );
  return normalizeLayout({ ...layout, panes: Object.fromEntries(entries) });
}
