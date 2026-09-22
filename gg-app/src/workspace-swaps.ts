import { DIVIDER_SIZE_PX, workspaceGeometry, type LayoutLength } from "./workspace-geometry";
import {
  workspaceLayoutLeafIds,
  type WorkspaceLayout,
  type WorkspaceLayoutNode,
} from "./workspace-layout";

export interface WorkspaceSize {
  width: number;
  height: number;
}
export interface PaneRect {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}
export type SwapRow =
  { available: true; paneIds: string[]; middleId: string } | { available: false; reason: string };
const unavailable = (reason: string): SwapRow => ({ available: false, reason });
const tolerance = 1;

/** Resolve the renderer's exact, untransformed CSS geometry in CSS pixels. */
export function workspacePaneRects(root: WorkspaceLayoutNode, size: WorkspaceSize): PaneRect[] {
  const resolve = (length: LayoutLength, extent: number) =>
    (extent * length.percent) / 100 + length.pixels;
  return [...workspaceGeometry(root).paneGeometry.values()].map(({ paneId, rect }) => ({
    paneId,
    left: resolve(rect.left, size.width),
    top: resolve(rect.top, size.height),
    width: resolve(rect.width, size.width),
    height: resolve(rect.height, size.height),
  }));
}

export function findSwapRow(rects: readonly PaneRect[], paneId: string): SwapRow {
  const origin = rects.find((rect) => rect.paneId === paneId);
  if (!origin) return unavailable("This conversation is no longer in the workspace.");
  if (
    rects.some(
      (r) =>
        ![r.left, r.top, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0,
    )
  ) {
    return unavailable("Wait for the workspace layout to become visible.");
  }
  const bottom = (r: PaneRect) => r.top + r.height;
  const aligned = rects
    .filter(
      (r) =>
        Math.abs(r.top - origin.top) <= tolerance &&
        Math.abs(bottom(r) - bottom(origin)) <= tolerance,
    )
    .sort((a, b) => a.left - b.left);
  const index = aligned.indexOf(origin);
  const adjacent = (a: PaneRect, b: PaneRect) =>
    Math.abs(b.left - a.left - a.width - DIVIDER_SIZE_PX) <= tolerance;
  let first = index;
  let last = index;
  while (first > 0 && adjacent(aligned[first - 1], aligned[first])) first--;
  while (last + 1 < aligned.length && adjacent(aligned[last], aligned[last + 1])) last++;
  const row = aligned.slice(first, last + 1);
  // Pairwise boundary agreement, not a transitive chain of near-overlaps.
  if (
    Math.max(...row.map((r) => r.top)) - Math.min(...row.map((r) => r.top)) > tolerance ||
    Math.max(...row.map(bottom)) - Math.min(...row.map(bottom)) > tolerance
  ) {
    return unavailable("Swap needs an unambiguous aligned row.");
  }
  if (row.length < 3) return unavailable("Swap needs at least three aligned panes in one row.");
  const left = row[0].left;
  const right = row[row.length - 1].left + row[row.length - 1].width;
  if (
    rects.some(
      (r) =>
        !row.includes(r) &&
        r.left < right &&
        r.left + r.width > left &&
        r.top < bottom(origin) - tolerance &&
        bottom(r) > origin.top + tolerance,
    )
  ) {
    return unavailable("Swap needs an unambiguous aligned row.");
  }
  const midpoint = (left + right) / 2;
  let middle = row[0];
  for (const candidate of row.slice(1)) {
    if (
      Math.abs(candidate.left + candidate.width / 2 - midpoint) <
      Math.abs(middle.left + middle.width / 2 - midpoint) - 1e-7
    )
      middle = candidate;
  }
  return { available: true, paneIds: row.map((r) => r.paneId), middleId: middle.paneId };
}

export function swapWorkspacePanes(
  layout: WorkspaceLayout,
  sideId: string,
  expectedMiddleId: string,
  size: WorkspaceSize,
): WorkspaceLayout {
  if (
    sideId === expectedMiddleId ||
    !Object.prototype.hasOwnProperty.call(layout.panes, sideId) ||
    !Object.prototype.hasOwnProperty.call(layout.panes, expectedMiddleId)
  )
    return layout;
  const ids = workspaceLayoutLeafIds(layout.root);
  if (
    ids.filter((id) => id === sideId).length !== 1 ||
    ids.filter((id) => id === expectedMiddleId).length !== 1
  )
    return layout;
  const row = findSwapRow(workspacePaneRects(layout.root, size), sideId);
  if (!row.available || row.middleId !== expectedMiddleId) return layout;
  const exchange = (node: WorkspaceLayoutNode): WorkspaceLayoutNode => {
    if (node.type === "leaf") {
      if (node.paneId === sideId) return { ...node, paneId: expectedMiddleId };
      if (node.paneId === expectedMiddleId) return { ...node, paneId: sideId };
      return node;
    }
    const first = exchange(node.first);
    const second = exchange(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return { ...layout, root: exchange(layout.root) };
}
