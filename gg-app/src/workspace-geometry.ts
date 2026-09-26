import type { CSSProperties } from "react";
import {
  workspaceLayoutLeafIds,
  type SplitDirection,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutPath,
  type WorkspacePaneId,
} from "./workspace-layout";

export const DIVIDER_SIZE_PX = 7;

export interface LayoutLength {
  percent: number;
  pixels: number;
}
export interface LayoutRect {
  left: LayoutLength;
  top: LayoutLength;
  width: LayoutLength;
  height: LayoutLength;
}
export interface PaneGeometry {
  paneId: WorkspacePaneId;
  rect: LayoutRect;
}
export interface DividerGeometry {
  key: string;
  path: WorkspaceLayoutPath;
  direction: SplitDirection;
  ratio: number;
  controlledPaneIds: WorkspacePaneId[];
  rect: LayoutRect;
}

function addLengths(first: LayoutLength, second: LayoutLength): LayoutLength {
  return { percent: first.percent + second.percent, pixels: first.pixels + second.pixels };
}
function scaleLength(length: LayoutLength, factor: number): LayoutLength {
  return { percent: length.percent * factor, pixels: length.pixels * factor };
}
function formatLength({ percent, pixels }: LayoutLength): string {
  if (pixels === 0) return `${percent}%`;
  if (percent === 0) return `${pixels}px`;
  return `calc(${percent}% ${pixels < 0 ? "-" : "+"} ${Math.abs(pixels)}px)`;
}
export function rectStyle(rect: LayoutRect): CSSProperties {
  return {
    left: formatLength(rect.left),
    top: formatLength(rect.top),
    width: formatLength(rect.width),
    height: formatLength(rect.height),
  };
}
function collectGeometry(
  node: WorkspaceLayoutNode,
  rect: LayoutRect,
  path: WorkspaceLayoutPath,
  panes: Map<WorkspacePaneId, PaneGeometry>,
  dividers: DividerGeometry[],
): void {
  if (node.type === "leaf") {
    panes.set(node.paneId, { paneId: node.paneId, rect });
    return;
  }
  dividers.push({
    key: path.length === 0 ? "root" : path.join("/"),
    path,
    direction: node.direction,
    ratio: node.ratio,
    controlledPaneIds: workspaceLayoutLeafIds(node),
    rect,
  });
  const factor = node.ratio / 100;
  if (node.direction === "horizontal") {
    const usableWidth = { ...rect.width, pixels: rect.width.pixels - DIVIDER_SIZE_PX };
    const firstWidth = scaleLength(usableWidth, factor);
    const dividerLeft = addLengths(rect.left, firstWidth);
    const secondLeft = addLengths(dividerLeft, { percent: 0, pixels: DIVIDER_SIZE_PX });
    collectGeometry(
      node.first,
      { ...rect, width: firstWidth },
      [...path, "first"],
      panes,
      dividers,
    );
    collectGeometry(
      node.second,
      {
        ...rect,
        left: secondLeft,
        width: scaleLength(usableWidth, 1 - factor),
      },
      [...path, "second"],
      panes,
      dividers,
    );
    return;
  }
  const usableHeight = { ...rect.height, pixels: rect.height.pixels - DIVIDER_SIZE_PX };
  const firstHeight = scaleLength(usableHeight, factor);
  const dividerTop = addLengths(rect.top, firstHeight);
  const secondTop = addLengths(dividerTop, { percent: 0, pixels: DIVIDER_SIZE_PX });
  collectGeometry(
    node.first,
    { ...rect, height: firstHeight },
    [...path, "first"],
    panes,
    dividers,
  );
  collectGeometry(
    node.second,
    {
      ...rect,
      top: secondTop,
      height: scaleLength(usableHeight, 1 - factor),
    },
    [...path, "second"],
    panes,
    dividers,
  );
}
export function workspaceGeometry(node: WorkspaceLayoutNode, path: WorkspaceLayoutPath = []) {
  const paneGeometry = new Map<WorkspacePaneId, PaneGeometry>();
  const dividerGeometry: DividerGeometry[] = [];
  collectGeometry(
    node,
    {
      left: { percent: 0, pixels: 0 },
      top: { percent: 0, pixels: 0 },
      width: { percent: 100, pixels: 0 },
      height: { percent: 100, pixels: 0 },
    },
    path,
    paneGeometry,
    dividerGeometry,
  );
  return { paneGeometry, dividerGeometry };
}
export function dividerStyle(direction: SplitDirection, ratio: number): CSSProperties {
  const offset = (DIVIDER_SIZE_PX * ratio) / 100;
  return direction === "horizontal"
    ? { left: `calc(${ratio}% - ${offset}px)`, top: 0, bottom: 0, width: DIVIDER_SIZE_PX }
    : { top: `calc(${ratio}% - ${offset}px)`, left: 0, right: 0, height: DIVIDER_SIZE_PX };
}
