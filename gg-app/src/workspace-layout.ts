import { PRIMARY_PANE_ID } from "./pane-routing";

export const WORKSPACE_LAYOUT_VERSION = 8;
export const DEFAULT_SPLIT_RATIO = 50;
export const MIN_SPLIT_RATIO = 10;
export const MAX_SPLIT_RATIO = 90;
export const DEFAULT_TERMINAL_DOCK_HEIGHT_PX = 260;
export const MIN_TERMINAL_DOCK_HEIGHT_PX = 140;
export const MAX_TERMINAL_DOCK_HEIGHT_PX = 2_000;
export const MAX_WORKSPACE_PANES = 4;
/** Temporary terminal-creation policy retained until Phase 1 removes the small product limit. */
export const MAX_WORKSPACE_LEAVES = MAX_WORKSPACE_PANES * 2;
/** Persisted-input and reducer-output corruption/resource guard, separate from creation policy. */
export const MAX_WORKSPACE_LAYOUT_LEAVES = 64;
/** A 64-leaf comb reaches depth 64 when the root is counted as depth 1. */
export const MAX_WORKSPACE_LAYOUT_DEPTH = MAX_WORKSPACE_LAYOUT_LEAVES;
const MAX_V6_WORKSPACE_LAYOUT_DEPTH = 4;
const MAX_WORKSPACE_PANE_ID_BYTES = 64;

export type WorkspacePaneId = string;
export type SplitDirection = "horizontal" | "vertical";
export type DefaultTerminalBootstrap = "pending" | "complete";
export type TerminalPanePlacement = "left" | "right" | "up" | "down";
export interface TerminalPaneMoveRequest {
  terminalPaneId: WorkspacePaneId;
  targetPaneId: WorkspacePaneId;
  placement: TerminalPanePlacement;
}
export interface LeafNode {
  type: "leaf";
  paneId: WorkspacePaneId;
}
export interface RatioSplitSize {
  type: "ratio";
  value: number;
}
export interface FixedSecondSplitSize {
  type: "fixed-second";
  pixels: number;
}
export type WorkspaceSplitSize = RatioSplitSize | FixedSecondSplitSize;
export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  /** Compatibility projection used by the current renderer until it consumes `size`. */
  ratio: number;
  size: WorkspaceSplitSize;
  first: WorkspaceLayoutNode;
  second: WorkspaceLayoutNode;
}
export type WorkspaceLayoutNode = LeafNode | SplitNode;

export interface WorkspacePaneTarget {
  cwd: string;
  sessionPath: string | null;
}
/**
 * `kind` is optional in memory so the existing UI can keep supplying its v6 target shape during
 * the schema-only migration. Canonical v8 storage always writes and requires it.
 */
export interface AgentPaneDescriptor extends WorkspacePaneTarget {
  kind?: "agent";
}
export interface TerminalPaneDescriptor extends WorkspacePaneTarget {
  kind: "terminal";
  stopped: true;
}
export type WorkspacePaneDescriptor = AgentPaneDescriptor | TerminalPaneDescriptor;
export type WorkspacePaneValue = WorkspacePaneDescriptor | null;

/** Legacy single-dock projection retained until the renderer moves to typed terminal leaves. */
export interface WorkspaceTerminalLayout {
  open: boolean;
  ownerPaneId: WorkspacePaneId | null;
  dockHeightPx: number;
}

export interface WorkspaceLayout {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  root: WorkspaceLayoutNode;
  focusedPaneId: WorkspacePaneId;
  panes: Record<WorkspacePaneId, WorkspacePaneValue>;
  defaultTerminalBootstrap: DefaultTerminalBootstrap;
  terminal: WorkspaceTerminalLayout;
  splitRatio: number;
  secondaryOpen: boolean;
}

export interface FixedWorkspaceLayoutInput {
  version: number;
  splitRatio: number;
  secondaryOpen: boolean;
  focusedPaneId: WorkspacePaneId;
  panes: Record<WorkspacePaneId, WorkspacePaneValue>;
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
  terminalRecovery?: { ownerPaneId: unknown; reason: "missing" | "unbound" };
}
export interface WorkspaceTargetStatus {
  projectExists: boolean;
  sessionExists: boolean;
}
interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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

export function isTerminalPanePlacement(value: unknown): value is TerminalPanePlacement {
  return value === "left" || value === "right" || value === "up" || value === "down";
}

export function isTerminalPaneMoveRequest(value: unknown): value is TerminalPaneMoveRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 3 &&
    keys.every((key) => ["terminalPaneId", "targetPaneId", "placement"].includes(key)) &&
    isValidWorkspacePaneId(record.terminalPaneId) &&
    isValidWorkspacePaneId(record.targetPaneId) &&
    isTerminalPanePlacement(record.placement)
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

function descriptorKind(value: WorkspacePaneValue | undefined): "agent" | "terminal" | null {
  if (!value) return null;
  return value.kind === "terminal" ? "terminal" : "agent";
}
function agentTarget(value: WorkspacePaneValue | undefined): WorkspacePaneTarget | null {
  return value && descriptorKind(value) === "agent"
    ? { cwd: value.cwd, sessionPath: value.sessionPath }
    : null;
}
function compatibility(root: WorkspaceLayoutNode): { splitRatio: number; secondaryOpen: boolean } {
  const secondaryOpen = workspaceLayoutLeafIds(root).includes("secondary");
  const ratio = root.type === "split" && root.size.type === "ratio" ? root.size.value : null;
  const fixed =
    ratio !== null &&
    root.type === "split" &&
    root.direction === "horizontal" &&
    root.first.type === "leaf" &&
    root.first.paneId === "primary" &&
    root.second.type === "leaf" &&
    root.second.paneId === "secondary";
  return { splitRatio: fixed ? ratio : DEFAULT_SPLIT_RATIO, secondaryOpen };
}
function ratioNode(
  direction: SplitDirection,
  ratio: number,
  first: WorkspaceLayoutNode,
  second: WorkspaceLayoutNode,
): SplitNode {
  const value = clampStoredSplitRatio(ratio);
  return { type: "split", direction, ratio: value, size: { type: "ratio", value }, first, second };
}
function fixedNode(
  pixels: number,
  first: WorkspaceLayoutNode,
  second: WorkspaceLayoutNode,
): SplitNode {
  return {
    type: "split",
    direction: "vertical",
    ratio: DEFAULT_SPLIT_RATIO,
    size: { type: "fixed-second", pixels },
    first,
    second,
  };
}
function legacyTerminalProjection(
  root: WorkspaceLayoutNode,
  panes: Record<string, WorkspacePaneValue>,
): WorkspaceTerminalLayout {
  let projection: WorkspaceTerminalLayout = {
    open: false,
    ownerPaneId: null,
    dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX,
  };
  const visit = (node: WorkspaceLayoutNode): void => {
    if (node.type === "leaf") return;
    if (
      node.direction === "vertical" &&
      node.size.type === "fixed-second" &&
      node.second.type === "leaf" &&
      descriptorKind(panes[node.second.paneId]) === "terminal" &&
      node.first.type === "leaf" &&
      descriptorKind(panes[node.first.paneId]) === "agent"
    ) {
      projection = {
        open: true,
        ownerPaneId: node.first.paneId,
        dockHeightPx: node.size.pixels,
      };
    }
    visit(node.first);
    visit(node.second);
  };
  visit(root);
  return projection;
}
function normalizeLayout(layout: {
  root: WorkspaceLayoutNode;
  focusedPaneId: WorkspacePaneId;
  panes: Record<WorkspacePaneId, WorkspacePaneValue>;
  defaultTerminalBootstrap: DefaultTerminalBootstrap;
}): WorkspaceLayout {
  const visible = workspaceLayoutLeafIds(layout.root);
  const firstAgent =
    visible.find((id) => descriptorKind(layout.panes[id]) === "agent") ?? visible[0];
  const focusedPaneId = visible.includes(layout.focusedPaneId) ? layout.focusedPaneId : firstAgent;
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    root: layout.root,
    focusedPaneId,
    panes: layout.panes,
    defaultTerminalBootstrap: layout.defaultTerminalBootstrap,
    terminal: legacyTerminalProjection(layout.root, layout.panes),
    ...compatibility(layout.root),
  };
}

function freshWorkspaceLayout(): WorkspaceLayout {
  return normalizeLayout({
    root: { type: "leaf", paneId: "primary" },
    focusedPaneId: "primary",
    panes: { primary: null },
    defaultTerminalBootstrap: "pending",
  });
}

export function defaultWorkspaceLayout(): WorkspaceLayout {
  return normalizeLayout({
    root: ratioNode(
      "horizontal",
      50,
      { type: "leaf", paneId: "primary" },
      { type: "leaf", paneId: "secondary" },
    ),
    focusedPaneId: "primary",
    panes: { primary: null, secondary: null },
    defaultTerminalBootstrap: "complete",
  });
}

export function terminalOnlyWorkspaceLayout(target: WorkspacePaneTarget): WorkspaceLayout | null {
  const parsedTarget = parseTarget(target);
  if (!parsedTarget) return null;
  return normalizeLayout({
    root: { type: "leaf", paneId: "terminal-1" },
    focusedPaneId: "terminal-1",
    panes: {
      "terminal-1": { kind: "terminal", stopped: true, ...parsedTarget },
    },
    defaultTerminalBootstrap: "complete",
  });
}

export function allocateWorkspacePaneId(layout: WorkspaceLayout): WorkspacePaneId | null {
  if (
    workspaceLayoutLeafIds(layout.root).filter(
      (paneId) => descriptorKind(layout.panes[paneId]) !== "terminal",
    ).length >= MAX_WORKSPACE_PANES
  )
    return null;
  let highestOrdinal = 0;
  for (const paneId of [...workspaceLayoutLeafIds(layout.root), ...Object.keys(layout.panes)]) {
    const match = /^pane-(\d+)$/.exec(paneId);
    if (match) highestOrdinal = Math.max(highestOrdinal, Number(match[1]));
  }
  return `pane-${highestOrdinal + 1}`;
}
function allocateTerminalId(
  root: WorkspaceLayoutNode,
  panes: Record<string, WorkspacePaneValue>,
): string {
  const used = new Set([...workspaceLayoutLeafIds(root), ...Object.keys(panes)]);
  let ordinal = 1;
  while (used.has(`terminal-${ordinal}`)) ordinal += 1;
  return `terminal-${ordinal}`;
}

export function addTerminalWorkspacePane(
  layout: WorkspaceLayout,
  agentPaneId: WorkspacePaneId,
  dockHeightPx = DEFAULT_TERMINAL_DOCK_HEIGHT_PX,
): WorkspaceLayout {
  const leafIds = workspaceLayoutLeafIds(layout.root);
  const target = agentTarget(layout.panes[agentPaneId]);
  if (!target || !leafIds.includes(agentPaneId) || leafIds.length >= MAX_WORKSPACE_LEAVES)
    return layout;
  const terminalPaneId = allocateTerminalId(layout.root, layout.panes);
  let changed = false;
  const addSibling = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === "leaf") {
      if (node.paneId !== agentPaneId) return node;
      changed = true;
      return fixedNode(dockHeightPx, node, { type: "leaf", paneId: terminalPaneId });
    }
    return { ...node, first: addSibling(node.first), second: addSibling(node.second) };
  };
  const root = addSibling(layout.root);
  return changed
    ? normalizeLayout({
        root,
        focusedPaneId: terminalPaneId,
        panes: {
          ...layout.panes,
          [terminalPaneId]: { kind: "terminal", stopped: true, ...target },
        },
        defaultTerminalBootstrap: layout.defaultTerminalBootstrap,
      })
    : layout;
}
export function bootstrapDefaultTerminalWorkspacePane(layout: WorkspaceLayout): WorkspaceLayout {
  const visible = workspaceLayoutLeafIds(layout.root);
  const paneKeys = Object.keys(layout.panes);
  const primaryTarget = agentTarget(layout.panes[PRIMARY_PANE_ID]);
  if (
    layout.defaultTerminalBootstrap !== "pending" ||
    layout.root.type !== "leaf" ||
    layout.root.paneId !== PRIMARY_PANE_ID ||
    visible.length !== 1 ||
    paneKeys.length !== 1 ||
    paneKeys[0] !== PRIMARY_PANE_ID ||
    !primaryTarget ||
    !primaryTarget.cwd.trim()
  )
    return layout;

  const inserted = addTerminalWorkspacePane(layout, PRIMARY_PANE_ID);
  return inserted === layout
    ? layout
    : normalizeLayout({
        root: inserted.root,
        focusedPaneId: inserted.focusedPaneId,
        panes: inserted.panes,
        defaultTerminalBootstrap: "complete",
      });
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
export function splitWorkspacePane(
  layout: WorkspaceLayout,
  paneId: WorkspacePaneId,
  direction: SplitDirection,
  requestedPaneId?: WorkspacePaneId,
): WorkspaceLayout {
  const source = layout.panes[paneId];
  if (!workspaceLayoutLeafIds(layout.root).includes(paneId)) return layout;
  const sourceKind = descriptorKind(source) === "terminal" ? "terminal" : "agent";

  const terminalTarget = sourceKind === "terminal" ? parseTarget(source) : null;
  if (
    sourceKind === "terminal" &&
    (!terminalTarget || source?.kind !== "terminal" || source.stopped !== true)
  )
    return layout;

  const newPaneId =
    sourceKind === "terminal"
      ? allocateTerminalId(layout.root, layout.panes)
      : (requestedPaneId ?? allocateWorkspacePaneId(layout));
  if (
    !newPaneId ||
    !isValidWorkspacePaneId(newPaneId) ||
    (sourceKind === "agent" &&
      workspaceLayoutLeafIds(layout.root).filter(
        (id) => descriptorKind(layout.panes[id]) !== "terminal",
      ).length >= MAX_WORKSPACE_PANES) ||
    (sourceKind === "terminal" &&
      workspaceLayoutLeafIds(layout.root).length >= MAX_WORKSPACE_LEAVES) ||
    workspaceLayoutLeafIds(layout.root).includes(newPaneId)
  )
    return layout;
  let changed = false;
  const splitLeaf = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === "leaf") {
      if (node.paneId !== paneId) return node;
      changed = true;
      return ratioNode(direction, DEFAULT_SPLIT_RATIO, node, { type: "leaf", paneId: newPaneId });
    }
    return { ...node, first: splitLeaf(node.first), second: splitLeaf(node.second) };
  };
  const root = splitLeaf(layout.root);
  const newDescriptor: WorkspacePaneValue = terminalTarget
    ? { kind: "terminal", stopped: true, ...terminalTarget }
    : null;
  return changed
    ? normalizeLayout({
        root,
        focusedPaneId: newPaneId,
        panes: { ...layout.panes, [newPaneId]: newDescriptor },
        defaultTerminalBootstrap: layout.defaultTerminalBootstrap,
      })
    : layout;
}
export function updateWorkspaceSplitRatio(
  layout: WorkspaceLayout,
  path: WorkspaceLayoutPath,
  ratio: number,
): WorkspaceLayout {
  let changed = false;
  const root = updateNodeAtPath(layout.root, path, (node) => {
    if (node.type !== "split" || node.size.type !== "ratio") return node;
    changed = true;
    const value = clampStoredSplitRatio(ratio);
    return { ...node, ratio: value, size: { type: "ratio", value } };
  });
  return changed && root
    ? normalizeLayout({
        root,
        focusedPaneId: layout.focusedPaneId,
        panes: layout.panes,
        defaultTerminalBootstrap: layout.defaultTerminalBootstrap,
      })
    : layout;
}
export function removeWorkspacePane(
  layout: WorkspaceLayout,
  paneId: WorkspacePaneId,
): WorkspaceLayout {
  if (paneId === PRIMARY_PANE_ID || !workspaceLayoutLeafIds(layout.root).includes(paneId))
    return layout;
  const removeIds = new Set([paneId]);
  const remove = (node: WorkspaceLayoutNode): WorkspaceLayoutNode | null => {
    if (node.type === "leaf") return removeIds.has(node.paneId) ? null : node;
    const first = remove(node.first);
    const second = remove(node.second);
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  };
  const root = remove(layout.root);
  if (!root) return layout;
  const panes = { ...layout.panes };
  for (const id of removeIds) delete panes[id];
  const visible = workspaceLayoutLeafIds(root);
  const ownerFallback =
    descriptorKind(layout.panes[paneId]) === "terminal"
      ? visible.find(
          (id) =>
            descriptorKind(panes[id]) === "agent" &&
            panes[id]?.cwd === layout.panes[paneId]?.cwd &&
            panes[id]?.sessionPath === layout.panes[paneId]?.sessionPath,
        )
      : undefined;
  return normalizeLayout({
    root,
    focusedPaneId:
      layout.focusedPaneId === paneId || removeIds.has(layout.focusedPaneId)
        ? (ownerFallback ??
          visible.find((id) => descriptorKind(panes[id]) === "agent") ??
          visible[0])
        : layout.focusedPaneId,
    panes,
    defaultTerminalBootstrap: layout.defaultTerminalBootstrap,
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
function isDefaultTerminalBootstrap(value: unknown): value is DefaultTerminalBootstrap {
  return value === "pending" || value === "complete";
}

function parseWorkspacePaneDescriptor(value: unknown): WorkspacePaneValue | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "agent" || record.kind === undefined) {
    const allowedKeys =
      record.kind === "agent" ? ["kind", "cwd", "sessionPath"] : ["cwd", "sessionPath"];
    if (Object.keys(record).some((key) => !allowedKeys.includes(key))) return undefined;
    const target = parseTarget(record);
    return target ? { kind: "agent", ...target } : undefined;
  }
  if (record.kind === "terminal") {
    if (Object.keys(record).some((key) => !["kind", "cwd", "sessionPath", "stopped"].includes(key)))
      return undefined;
    if (record.stopped !== true) return undefined;
    const target = parseTarget(record);
    return target ? { kind: "terminal", stopped: true, ...target } : undefined;
  }
  return undefined;
}
function parseNode(
  value: unknown,
  depth: number,
  ids: Set<string>,
  version: 6 | 7 | typeof WORKSPACE_LAYOUT_VERSION,
): WorkspaceLayoutNode | null {
  const maximumDepth = version === 6 ? MAX_V6_WORKSPACE_LAYOUT_DEPTH : MAX_WORKSPACE_LAYOUT_DEPTH;
  if (depth > maximumDepth || typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "leaf") {
    if (!isValidWorkspacePaneId(record.paneId) || ids.has(record.paneId)) return null;
    ids.add(record.paneId);
    const maximumLeaves = version === 6 ? MAX_WORKSPACE_PANES : MAX_WORKSPACE_LAYOUT_LEAVES;
    if (ids.size > maximumLeaves) return null;
    return { type: "leaf", paneId: record.paneId };
  }
  if (
    record.type !== "split" ||
    (record.direction !== "horizontal" && record.direction !== "vertical")
  )
    return null;
  let node: SplitNode;
  if (version === 6) {
    if (typeof record.ratio !== "number" || !Number.isFinite(record.ratio)) return null;
    node = ratioNode(record.direction, record.ratio, null!, null!);
  } else {
    if (typeof record.size !== "object" || record.size === null) return null;
    const size = record.size as Record<string, unknown>;
    if (size.type === "ratio" && typeof size.value === "number" && Number.isFinite(size.value)) {
      node = ratioNode(record.direction, size.value, null!, null!);
    } else if (
      size.type === "fixed-second" &&
      record.direction === "vertical" &&
      typeof size.pixels === "number" &&
      Number.isFinite(size.pixels)
    ) {
      node = fixedNode(clampStoredTerminalDockHeightPx(size.pixels).value, null!, null!);
    } else return null;
  }
  const first = parseNode(record.first, depth + 1, ids, version);
  const second = parseNode(record.second, depth + 1, ids, version);
  return first && second ? { ...node, first, second } : null;
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
function parseFixed(record: Record<string, unknown>): FixedLayout | null {
  if (typeof record.panes !== "object" || record.panes === null) return null;
  const panes = record.panes as Record<string, unknown>;
  const primary = parseTarget(panes.primary),
    secondary = parseTarget(panes.secondary);
  if (primary === undefined || secondary === undefined) return null;
  const secondaryOpen = record.version === 0 || record.version === 1 ? true : record.secondaryOpen;
  if (typeof secondaryOpen !== "boolean") return null;
  let terminal: WorkspaceTerminalLayout = {
    open: false,
    ownerPaneId: null,
    dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX,
  };
  let terminalDockHeightRecovery: FixedLayout["terminalDockHeightRecovery"];
  if (record.version === 4) {
    const raw = record.terminal as Record<string, unknown> | null;
    if (
      !raw ||
      Object.keys(raw).some((key) => !["open", "ownerPaneId"].includes(key)) ||
      typeof raw.open !== "boolean" ||
      (raw.open
        ? raw.ownerPaneId !== "primary" && raw.ownerPaneId !== "secondary"
        : raw.ownerPaneId !== null)
    )
      return null;
    terminal = { open: raw.open, ownerPaneId: raw.ownerPaneId as string | null, dockHeightPx: 260 };
  } else if (record.version === 5) {
    const parsed = parseTerminal(record.terminal);
    if (!parsed) return null;
    terminal = parsed.terminal;
    terminalDockHeightRecovery = parsed.recovery;
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
function fixedToV6(fixed: FixedLayout): {
  root: WorkspaceLayoutNode;
  focusedPaneId: string;
  panes: Record<string, WorkspacePaneTarget | null>;
  terminal: WorkspaceTerminalLayout;
} {
  return {
    root: fixed.secondaryOpen
      ? ratioNode(
          "horizontal",
          fixed.splitRatio,
          { type: "leaf", paneId: "primary" },
          { type: "leaf", paneId: "secondary" },
        )
      : { type: "leaf", paneId: "primary" },
    focusedPaneId: fixed.focusedPaneId,
    panes: { primary: fixed.panes.primary, secondary: fixed.panes.secondary },
    terminal: fixed.terminal,
  };
}
function migrateV6(
  root: WorkspaceLayoutNode,
  focusedPaneId: string,
  targets: Record<string, WorkspacePaneTarget | null>,
  terminal: WorkspaceTerminalLayout,
): Pick<WorkspaceLayoutLoadResult, "layout" | "terminalRecovery"> {
  const visible = workspaceLayoutLeafIds(root);
  const panes: Record<string, WorkspacePaneValue> = {};
  for (const id of visible) {
    const target = targets[id] ?? null;
    panes[id] = target ? { kind: "agent", ...target } : null;
  }
  if (!terminal.open)
    return {
      layout: normalizeLayout({
        root,
        focusedPaneId,
        panes,
        defaultTerminalBootstrap: "complete",
      }),
    };
  const owner = terminal.ownerPaneId;
  const target = owner ? agentTarget(panes[owner]) : null;
  if (!owner || !visible.includes(owner) || !target) {
    return {
      layout: normalizeLayout({
        root,
        focusedPaneId,
        panes,
        defaultTerminalBootstrap: "complete",
      }),
      terminalRecovery: {
        ownerPaneId: owner,
        reason: owner && visible.includes(owner) ? "unbound" : "missing",
      },
    };
  }
  const terminalId = allocateTerminalId(root, panes);
  const replace = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === "leaf")
      return node.paneId === owner
        ? fixedNode(terminal.dockHeightPx, node, { type: "leaf", paneId: terminalId })
        : node;
    return { ...node, first: replace(node.first), second: replace(node.second) };
  };
  panes[terminalId] = { kind: "terminal", stopped: true, ...target };
  return {
    layout: normalizeLayout({
      root: replace(root),
      focusedPaneId,
      panes,
      defaultTerminalBootstrap: "complete",
    }),
  };
}
function parseV6(record: Record<string, unknown>): WorkspaceLayoutLoadResult | null {
  const ids = new Set<string>();
  const root = parseNode(record.root, 1, ids, 6);
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
    keys.length !== ids.size ||
    keys.length > MAX_WORKSPACE_PANES ||
    keys.some((key) => !isValidWorkspacePaneId(key) || !ids.has(key))
  )
    return null;
  const targets: Record<string, WorkspacePaneTarget | null> = {};
  for (const id of ids) {
    const target = parseTarget(rawPanes[id]);
    if (target === undefined) return null;
    targets[id] = target;
  }
  const parsedTerminal = parseTerminal(record.terminal);
  if (!parsedTerminal) return null;
  const migrated = migrateV6(
    root,
    typeof record.focusedPaneId === "string" ? record.focusedPaneId : "",
    targets,
    parsedTerminal.terminal,
  );
  return {
    ...migrated,
    status: "migrated",
    ...(parsedTerminal.recovery ? { terminalDockHeightRecovery: parsedTerminal.recovery } : {}),
  };
}
function containsOnlyTerminalLeaves(
  node: WorkspaceLayoutNode,
  panes: Record<string, WorkspacePaneValue>,
): boolean {
  return node.type === "leaf"
    ? descriptorKind(panes[node.paneId]) === "terminal"
    : containsOnlyTerminalLeaves(node.first, panes) &&
        containsOnlyTerminalLeaves(node.second, panes);
}

function validFixedSplitTopology(
  node: WorkspaceLayoutNode,
  panes: Record<string, WorkspacePaneValue>,
): boolean {
  if (node.type === "leaf") return true;
  if (
    node.size.type === "fixed-second" &&
    (node.direction !== "vertical" || !containsOnlyTerminalLeaves(node.second, panes))
  )
    return false;
  return validFixedSplitTopology(node.first, panes) && validFixedSplitTopology(node.second, panes);
}
export function validateWorkspaceLayoutCandidate(candidate: unknown): WorkspaceLayout | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (
    record.version !== WORKSPACE_LAYOUT_VERSION ||
    !isDefaultTerminalBootstrap(record.defaultTerminalBootstrap)
  )
    return null;
  const ids = new Set<string>();
  const root = parseNode(record.root, 1, ids, WORKSPACE_LAYOUT_VERSION);
  if (!root || typeof record.panes !== "object" || record.panes === null) return null;
  const rawPanes = record.panes as Record<string, unknown>;
  const keys = Object.keys(rawPanes);
  if (keys.length !== ids.size || keys.some((key) => !ids.has(key))) return null;
  const panes: Record<string, WorkspacePaneValue> = {};
  for (const key of keys) {
    const descriptor = parseWorkspacePaneDescriptor(rawPanes[key]);
    if (descriptor === undefined) return null;
    panes[key] = descriptor;
  }
  const focusedPaneId = typeof record.focusedPaneId === "string" ? record.focusedPaneId : "";
  const terminalOnly =
    root.type === "leaf" &&
    root.paneId === "terminal-1" &&
    focusedPaneId === "terminal-1" &&
    keys.length === 1 &&
    descriptorKind(panes["terminal-1"]) === "terminal";
  if (
    !terminalOnly &&
    (!ids.has(PRIMARY_PANE_ID) ||
      descriptorKind(panes.primary) !== "agent" ||
      !validFixedSplitTopology(root, panes))
  )
    return null;
  return normalizeLayout({
    root,
    focusedPaneId,
    panes,
    defaultTerminalBootstrap: record.defaultTerminalBootstrap,
  });
}

function hasCanonicalPaneDescriptorKinds(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(
      (descriptor) =>
        descriptor === null ||
        (typeof descriptor === "object" &&
          descriptor !== null &&
          (descriptor as Record<string, unknown>).kind !== undefined),
    )
  );
}

function parseV7(record: Record<string, unknown>): WorkspaceLayoutLoadResult | null {
  if (!hasCanonicalPaneDescriptorKinds(record.panes)) return null;
  const layout = validateWorkspaceLayoutCandidate({
    ...record,
    version: WORKSPACE_LAYOUT_VERSION,
    defaultTerminalBootstrap: "complete",
  });
  return layout ? { layout, status: "migrated" } : null;
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
  if (record.version === WORKSPACE_LAYOUT_VERSION) {
    if (!hasCanonicalPaneDescriptorKinds(record.panes))
      return { layout: defaultWorkspaceLayout(), status: "corrupt" };
    const layout = validateWorkspaceLayoutCandidate(record);
    return layout
      ? { layout, status: "valid" }
      : { layout: defaultWorkspaceLayout(), status: "corrupt" };
  }
  if (record.version === 7)
    return parseV7(record) ?? { layout: defaultWorkspaceLayout(), status: "corrupt" };
  if (record.version === 6)
    return parseV6(record) ?? { layout: defaultWorkspaceLayout(), status: "corrupt" };
  if (![0, 1, 2, 3, 4, 5].includes(record.version as number))
    return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  let fixed: FixedLayout | null;
  if (record.version === 0) {
    const primary = parseTarget(record.primary ?? null, true);
    const secondary = parseTarget(record.secondary ?? null, true);
    fixed =
      primary === undefined || secondary === undefined
        ? null
        : {
            splitRatio: clampStoredSplitRatio(record.ratio),
            secondaryOpen: true,
            focusedPaneId: "primary",
            panes: { primary, secondary },
            terminal: { open: false, ownerPaneId: null, dockHeightPx: 260 },
          };
  } else fixed = parseFixed(record);
  if (!fixed) return { layout: defaultWorkspaceLayout(), status: "corrupt" };
  const v6 = fixedToV6(fixed);
  const migrated = migrateV6(v6.root, v6.focusedPaneId, v6.panes, v6.terminal);
  return {
    ...migrated,
    status: "migrated",
    ...(fixed.terminalDockHeightRecovery
      ? { terminalDockHeightRecovery: fixed.terminalDockHeightRecovery }
      : {}),
  };
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
        // Rejected-byte preservation is best-effort; the safe fallback still applies.
      }
      return { ...result, rejectedRaw: recursiveRaw, rejectedSource: "recursive" };
    }
    const raw = storage.getItem(workspaceLayoutKey(windowLabel));
    if (raw === null) return { layout: freshWorkspaceLayout(), status: "missing" };
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
function canonicalRecord(layout: WorkspaceLayout): Record<string, unknown> {
  const panes = Object.fromEntries(
    Object.entries(layout.panes).map(([id, descriptor]) => [
      id,
      descriptor
        ? descriptorKind(descriptor) === "terminal"
          ? {
              kind: "terminal",
              cwd: descriptor.cwd,
              sessionPath: descriptor.sessionPath,
              stopped: true,
            }
          : { kind: "agent", cwd: descriptor.cwd, sessionPath: descriptor.sessionPath }
        : null,
    ]),
  );
  const stripNode = (node: WorkspaceLayoutNode): Record<string, unknown> =>
    node.type === "leaf"
      ? { type: "leaf", paneId: node.paneId }
      : {
          type: "split",
          direction: node.direction,
          size: node.size,
          first: stripNode(node.first),
          second: stripNode(node.second),
        };
  return {
    version: WORKSPACE_LAYOUT_VERSION,
    root: stripNode(layout.root),
    focusedPaneId: layout.focusedPaneId,
    panes,
    defaultTerminalBootstrap: layout.defaultTerminalBootstrap,
  };
}
function canonicalizeInput(input: WorkspaceLayoutSaveInput): WorkspaceLayout | null {
  if (input.version === WORKSPACE_LAYOUT_VERSION) return validateWorkspaceLayoutCandidate(input);
  const fixed = input as FixedWorkspaceLayoutInput;
  const primary = parseTarget(fixed.panes.primary),
    secondary = parseTarget(fixed.panes.secondary);
  if (primary === undefined || secondary === undefined) return null;
  const v6 = fixedToV6({
    splitRatio: fixed.splitRatio,
    secondaryOpen: fixed.secondaryOpen === true,
    focusedPaneId: fixed.focusedPaneId,
    panes: { primary, secondary },
    terminal: fixed.terminal,
  });
  return migrateV6(v6.root, v6.focusedPaneId, v6.panes, v6.terminal).layout;
}
function rollbackProjection(layout: WorkspaceLayout): Record<string, unknown> | null {
  let terminal: WorkspaceTerminalLayout = {
    open: false,
    ownerPaneId: null,
    dockHeightPx: DEFAULT_TERMINAL_DOCK_HEIGHT_PX,
  };
  let terminalCount = 0;
  const removeTerminal = (node: WorkspaceLayoutNode): WorkspaceLayoutNode | null => {
    if (node.type === "leaf") {
      if (descriptorKind(layout.panes[node.paneId]) === "terminal") {
        terminalCount += 1;
        return null;
      }
      return node;
    }
    if (
      node.direction === "vertical" &&
      node.size.type === "fixed-second" &&
      node.first.type === "leaf" &&
      node.second.type === "leaf" &&
      descriptorKind(layout.panes[node.first.paneId]) === "agent" &&
      descriptorKind(layout.panes[node.second.paneId]) === "terminal"
    ) {
      terminalCount += 1;
      terminal = {
        open: true,
        ownerPaneId: node.first.paneId,
        dockHeightPx: node.size.pixels,
      };
      return node.first;
    }
    if (node.size.type !== "ratio") return null;
    const first = removeTerminal(node.first);
    const second = removeTerminal(node.second);
    return first && second ? { ...node, first, second } : null;
  };
  const root = removeTerminal(layout.root);
  if (!root || terminalCount > 1) return null;
  const fixed =
    (root.type === "leaf" && root.paneId === "primary") ||
    (root.type === "split" &&
      root.direction === "horizontal" &&
      root.size.type === "ratio" &&
      root.first.type === "leaf" &&
      root.first.paneId === "primary" &&
      root.second.type === "leaf" &&
      root.second.paneId === "secondary");
  if (!fixed) return null;
  const splitRatio =
    root.type === "split" && root.size.type === "ratio" ? root.size.value : DEFAULT_SPLIT_RATIO;
  return {
    version: 5,
    splitRatio,
    secondaryOpen: root.type === "split",
    focusedPaneId:
      layout.focusedPaneId === "secondary" && root.type === "split" ? "secondary" : "primary",
    panes: {
      primary: agentTarget(layout.panes.primary),
      secondary: root.type === "split" ? agentTarget(layout.panes.secondary) : null,
    },
    terminal,
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
    storage.setItem(
      recursiveWorkspaceLayoutKey(windowLabel),
      JSON.stringify(canonicalRecord(layout)),
    );
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
  const panes = { ...layout.panes };
  const invalidTerminals = new Set<string>();
  for (const [id, descriptor] of Object.entries(layout.panes)) {
    if (!descriptor) continue;
    try {
      const status = await validate({ cwd: descriptor.cwd, sessionPath: descriptor.sessionPath });
      if (!status.projectExists) {
        if (descriptorKind(descriptor) === "terminal") invalidTerminals.add(id);
        else panes[id] = null;
      } else if (descriptor.sessionPath && !status.sessionExists) {
        panes[id] = { ...descriptor, sessionPath: null };
      }
    } catch {
      if (descriptorKind(descriptor) === "terminal") invalidTerminals.add(id);
      else panes[id] = null;
    }
  }
  if (invalidTerminals.size === 0)
    return normalizeLayout({
      root: layout.root,
      focusedPaneId: layout.focusedPaneId,
      panes,
      defaultTerminalBootstrap: layout.defaultTerminalBootstrap,
    });
  const prune = (node: WorkspaceLayoutNode): WorkspaceLayoutNode | null => {
    if (node.type === "leaf") return invalidTerminals.has(node.paneId) ? null : node;
    const first = prune(node.first);
    const second = prune(node.second);
    if (!first) return second;
    if (!second) return first;
    return { ...node, first, second };
  };
  const root = prune(layout.root);
  if (!root) return defaultWorkspaceLayout();
  for (const id of invalidTerminals) delete panes[id];
  return normalizeLayout({
    root,
    focusedPaneId: layout.focusedPaneId,
    panes,
    defaultTerminalBootstrap: layout.defaultTerminalBootstrap,
  });
}
