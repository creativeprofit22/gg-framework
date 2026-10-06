import { describe, expect, it } from "vitest";
import { dividerStyle, rectStyle, workspaceGeometry } from "./workspace-geometry";
import type { WorkspaceLayoutNode } from "./workspace-layout";

const leaf = (paneId: string): WorkspaceLayoutNode => ({ type: "leaf", paneId });
describe("shared workspace geometry", () => {
  it("retains the full leaf rectangle", () => {
    const result = workspaceGeometry(leaf("primary"));
    expect(rectStyle(result.paneGeometry.get("primary")!.rect)).toEqual({
      left: "0%",
      top: "0%",
      width: "100%",
      height: "100%",
    });
    expect(result.dividerGeometry).toEqual([]);
  });
  it("retains nested pane positions, divider paths and controlled IDs", () => {
    const result = workspaceGeometry({
      type: "split",
      direction: "horizontal",
      ratio: 40,
      size: { type: "ratio", value: 40 },
      first: leaf("a"),
      second: {
        type: "split",
        direction: "vertical",
        ratio: 50,
        size: { type: "ratio", value: 50 },
        first: leaf("b"),
        second: leaf("c"),
      },
    });
    expect(rectStyle(result.paneGeometry.get("a")!.rect)).toEqual({
      left: "0%",
      top: "0%",
      width: "calc(40% - 2.8000000000000003px)",
      height: "100%",
    });
    expect(rectStyle(result.paneGeometry.get("c")!.rect)).toEqual({
      left: "calc(40% + 4.199999999999999px)",
      top: "calc(50% + 3.5px)",
      width: "calc(60% - 4.2px)",
      height: "calc(50% - 3.5px)",
    });
    expect(
      result.dividerGeometry.map(({ key, path, controlledPaneIds }) => ({
        key,
        path,
        controlledPaneIds,
      })),
    ).toEqual([
      { key: "root", path: [], controlledPaneIds: ["a", "b", "c"] },
      { key: "second", path: ["second"], controlledPaneIds: ["b", "c"] },
    ]);
    expect(rectStyle(result.dividerGeometry[1].rect)).toEqual({
      left: "calc(40% + 4.199999999999999px)",
      top: "0%",
      width: "calc(60% - 4.2px)",
      height: "100%",
    });
  });
  it("retains divider offsets in either direction and supplied paths", () => {
    expect(dividerStyle("horizontal", 40)).toEqual({
      left: "calc(40% - 2.8px)",
      top: 0,
      bottom: 0,
      width: 7,
    });
    expect(dividerStyle("vertical", 50)).toEqual({
      top: "calc(50% - 3.5px)",
      left: 0,
      right: 0,
      height: 7,
    });
    expect(
      workspaceGeometry(
        {
          type: "split",
          direction: "horizontal",
          ratio: 50,
          size: { type: "ratio", value: 50 },
          first: leaf("a"),
          second: leaf("b"),
        },
        ["first"],
      ).dividerGeometry[0].path,
    ).toEqual(["first"]);
  });
});
