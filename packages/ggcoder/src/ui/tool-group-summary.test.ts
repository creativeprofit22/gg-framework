import { describe, expect, it } from "vitest";
import { buildToolGroupSummary, segmentsToPlainText } from "./tool-group-summary.js";

describe("buildToolGroupSummary", () => {
  it("adds capped file details to grouped reads", () => {
    const text = segmentsToPlainText(
      buildToolGroupSummary(
        [
          {
            name: "read",
            args: { file_path: "packages/ggcoder/src/ui/App.tsx" },
            status: "done",
          },
          {
            name: "read",
            args: { file_path: "packages/ggcoder/src/ui/terminal-history.ts" },
            status: "done",
          },
          {
            name: "read",
            args: { file_path: "packages/ggcoder/src/ui/tool-group-summary.ts" },
            status: "done",
          },
        ],
        true,
      ),
    );

    expect(text).toBe("Read 3 files: App.tsx, terminal-history.ts, +1");
  });

  it("adds capped query details to grouped steroids calls", () => {
    const text = segmentsToPlainText(
      buildToolGroupSummary(
        [
          {
            name: "steroids",
            args: { action: "search", pattern: "serializeCompletedItemToTerminalHistory" },
            status: "done",
          },
          {
            name: "steroids",
            args: { action: "define", symbol: "TerminalHistoryPrinter" },
            status: "done",
          },
          {
            name: "steroids",
            args: { action: "search", pattern: "currentItem?.type === reasoning" },
            status: "done",
          },
        ],
        true,
      ),
    );

    expect(text).toBe('Read real code with 3 queries: "serialize…History", "Terminal…Printer", +1');
  });

  it("deduplicates grouped details before applying the cap", () => {
    const text = segmentsToPlainText(
      buildToolGroupSummary(
        [
          { name: "grep", args: { pattern: "tool_start" }, status: "done" },
          { name: "grep", args: { pattern: "tool_start" }, status: "done" },
          { name: "grep", args: { pattern: "server_tool_start" }, status: "done" },
        ],
        true,
      ),
    );

    expect(text).toBe('Searched for 3 patterns: "tool_start", "server_tool_start"');
  });
});
