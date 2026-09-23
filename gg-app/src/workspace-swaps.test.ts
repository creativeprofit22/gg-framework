import { describe, expect, it } from "vitest";
import {
  findSwapRow,
  swapWorkspacePanes,
  workspacePaneRects,
  type PaneRect,
} from "./workspace-swaps";
import {
  WORKSPACE_LAYOUT_VERSION,
  workspaceLayoutLeafIds,
  type WorkspaceLayout,
  type WorkspaceLayoutNode,
} from "./workspace-layout";
const size = { width: 1600, height: 900 };
const leaf = (paneId: string): WorkspaceLayoutNode => ({ type: "leaf", paneId });
const split = (
  first: WorkspaceLayoutNode,
  second: WorkspaceLayoutNode,
  direction: "horizontal" | "vertical" = "horizontal",
  ratio = 50,
): WorkspaceLayoutNode => ({
  type: "split",
  direction,
  ratio,
  size: { type: "ratio", value: ratio },
  first,
  second,
});
const row = (ids: string[]): WorkspaceLayoutNode =>
  ids.length === 1
    ? leaf(ids[0])
    : split(leaf(ids[0]), row(ids.slice(1)), "horizontal", 100 / ids.length);
const layout = (root: WorkspaceLayoutNode): WorkspaceLayout => ({
  version: WORKSPACE_LAYOUT_VERSION,
  root,
  focusedPaneId: "primary",
  panes: Object.fromEntries(workspaceLayoutLeafIds(root).map((id) => [id, null])),
});
const rects = (widths: number[]): PaneRect[] => {
  let left = 0;
  return widths.map((width, i) => {
    const r = { paneId: `${i}`, left, top: 0, width, height: 100 };
    left += width + 7;
    return r;
  });
};
describe("physical same-row middle swaps", () => {
  it.each([3, 4, 5, 6])("targets %i aligned columns, including farther sides", (count) => {
    const rs = rects(Array(count).fill(100));
    for (const r of rs)
      expect(findSwapRow(rs, r.paneId)).toEqual({
        available: true,
        paneIds: rs.map((p) => p.paneId),
        middleId: `${Math.floor((count - 1) / 2)}`,
      });
  });
  it("uses physical centres rather than index for unequal widths", () => {
    expect(findSwapRow(rects([100, 100, 600, 100, 100]), "0")).toMatchObject({ middleId: "2" });
    expect(findSwapRow(rects([700, 50, 50, 50, 50]), "4")).toMatchObject({ middleId: "0" });
  });
  it.each([0, 1, 2])("rejects %i-pane rows and stale identities", (count) => {
    expect(findSwapRow(rects(Array(count).fill(100)), "0").available).toBe(false);
    expect(findSwapRow(rects([100, 100, 100]), "stale").available).toBe(false);
  });
  it("never crosses a spanning pane, and permits an unambiguous partial row", () => {
    const rs = rects([100, 100, 100, 100]);
    rs[0].height = 207;
    expect(findSwapRow(rs, "0").available).toBe(false);
    expect(findSwapRow(rs, "1")).toMatchObject({ paneIds: ["1", "2", "3"] });
    rs[2].height = 207;
    expect(findSwapRow(rs, "1").available).toBe(false);
  });
  it("rejects transitive boundary chains and hidden geometry", () => {
    const rs = rects([100, 100, 100]);
    rs[0].top = -4;
    rs[2].top = 4;
    expect(findSwapRow(rs, "1").available).toBe(false);
    expect(findSwapRow(rects([100, 0, 100]), "0").available).toBe(false);
  });
  it("treats rows offset by less than a divider as aligned, but not larger offsets", () => {
    const rs = rects([100, 100, 100]);
    rs[0].top = 3.85;
    rs[0].height = 100 - 3.85;
    expect(findSwapRow(rs, "1")).toMatchObject({ available: true, middleId: "1" });
    rs[0].top = 7;
    rs[0].height = 93;
    expect(findSwapRow(rs, "1").available).toBe(false);
  });
  it.each([600, 800, 1000, 1300])(
    "offers swaps in a 3x2 grid whose first column divider was dragged slightly (%ipx tall)",
    (height) => {
      // Saved desktop layout: the first column's row divider sits at 50.3%, the others at 50%.
      const grid = split(
        split(leaf("a"), leaf("d"), "vertical", 50.29761904761905),
        split(
          split(leaf("b"), leaf("e"), "vertical", 50),
          split(leaf("c"), leaf("f"), "vertical", 50),
          "horizontal",
          49.83890597220655,
        ),
        "horizontal",
        32.34375,
      );
      const all = workspacePaneRects(grid, { width: 1900, height });
      expect(findSwapRow(all, "b")).toEqual({
        available: true,
        paneIds: ["a", "b", "c"],
        middleId: "b",
      });
      expect(findSwapRow(all, "e")).toEqual({
        available: true,
        paneIds: ["d", "e", "f"],
        middleId: "e",
      });
      const swapped = swapWorkspacePanes(layout(grid), "a", "b", { width: 1900, height });
      expect(workspaceLayoutLeafIds(swapped.root)).toEqual(["b", "d", "a", "e", "c", "f"]);
    },
  );
  it.each(["a", "c", "d", "f"])(
    "exchanges %s in either row, preserving everything else",
    (side) => {
      const original = layout(split(row(["a", "b", "c"]), row(["d", "e", "f"]), "vertical", 43));
      const middle = ["a", "c"].includes(side) ? "b" : "e";
      const changed = swapWorkspacePanes(original, side, middle, size);
      expect(changed).not.toBe(original);
      expect(changed.panes).toBe(original.panes);
      expect(changed.focusedPaneId).toBe(original.focusedPaneId);
      expect(workspaceLayoutLeafIds(changed.root)).toEqual(
        workspaceLayoutLeafIds(original.root).map((id) =>
          id === side ? middle : id === middle ? side : id,
        ),
      );
      if (changed.root.type === "split" && original.root.type === "split") {
        expect(changed.root.ratio).toBe(43);
        expect(changed.root.size).toBe(original.root.size);
        expect(middle === "b" ? changed.root.second : changed.root.first).toBe(
          middle === "b" ? original.root.second : original.root.first,
        );
      }
      expect(swapWorkspacePanes(changed, middle, side, size)).toEqual(original);
      expect(JSON.parse(JSON.stringify(changed))).toEqual(changed);
    },
  );
  it("guards stale middle targets, closing/splitting and primary identity", () => {
    const original = layout(row(["primary", "b", "c"]));
    expect(swapWorkspacePanes(original, "primary", "c", size)).toBe(original);
    expect(swapWorkspacePanes(original, "gone", "b", size)).toBe(original);
    expect(swapWorkspacePanes(original, "b", "b", size)).toBe(original);
    const changed = swapWorkspacePanes(original, "primary", "b", size);
    expect(changed.focusedPaneId).toBe("primary");
    expect(changed.panes).toBe(original.panes);
    const closed = layout(row(["primary", "c"]));
    expect(swapWorkspacePanes(closed, "primary", "b", size)).toBe(closed);
    const reshaped = layout(split(leaf("primary"), split(leaf("b"), leaf("c"), "vertical")));
    expect(swapWorkspacePanes(reshaped, "primary", "b", size)).toBe(reshaped);
    expect(workspacePaneRects(original.root, size)).toHaveLength(3);
  });
});
