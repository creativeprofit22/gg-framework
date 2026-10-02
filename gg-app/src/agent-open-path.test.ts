import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { invoke, toast } = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: vi.fn() }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("./toast", () => ({ toast }));

import { openProjectPath } from "./agent";

describe("openProjectPath", () => {
  beforeEach(() => vi.resetAllMocks());

  it("decodes escaped local paths before invoking the native opener", async () => {
    await openProjectPath("E:/Projects/my%20file.md#L12", "primary", "url");
    expect(invoke).toHaveBeenCalledWith("open_project_path", {
      paneId: "primary",
      path: "E:/Projects/my file.md",
    });
  });

  it.each(["primary", "pane-secondary"])("preserves originating pane %s", async (paneId) => {
    await openProjectPath("same%20file.md", paneId, "url");
    expect(invoke).toHaveBeenCalledWith("open_project_path", {
      paneId,
      path: "same file.md",
    });
  });

  it.each([
    "project%20copy",
    "report#Log.md",
    "report#L12",
    " leading space",
    " padded ",
    "file:12:3",
  ])("preserves raw filename %s", async (path) => {
    await openProjectPath(path);
    expect(invoke).toHaveBeenCalledWith("open_project_path", { paneId: "primary", path });
  });

  it.each([
    ["report%23Log.md", "report#Log.md"],
    ["report%23L12", "report#L12"],
    ["report%3A12%3A3", "report:12:3"],
    ["project%2520copy", "project%20copy"],
    ["README.md#section", "README.md"],
    ["README.md:12:3#L12", "README.md"],
    ["Dockerfile:12:3", "Dockerfile"],
    ["./Dockerfile:12:3", "./Dockerfile"],
    ["Dockerfile#L12", "Dockerfile"],
    ["file:///E:/my%20file.md?query#section", "E:/my file.md"],
    ["bad%escape.md#section", "bad%escape.md"],
  ])("normalizes URL %s once", async (url, path) => {
    await openProjectPath(url, "primary", "url");
    expect(invoke).toHaveBeenCalledWith("open_project_path", { paneId: "primary", path });
  });

  it("bridges URL and raw inputs to the actual temporary targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "gg-open-path-"));
    try {
      for (const name of ["report#Log.md", "my file.md", "README.md", "report#L12", "Dockerfile"]) {
        writeFileSync(join(root, name), name);
      }
      mkdirSync(join(root, "project%20copy"));
      const cases = [
        ["report%23Log.md", "url", "report#Log.md"],
        ["my%20file.md", "url", "my file.md"],
        ["README.md#section", "url", "README.md"],
        ["README.md#L12", "url", "README.md"],
        ["README.md:12:3", "url", "README.md"],
        ["Dockerfile:12:3", "url", "Dockerfile"],
        ["./Dockerfile:12:3", "url", "Dockerfile"],
        ["report%23L12", "url", "report#L12"],
        ["project%20copy", "path", "project%20copy"],
        ["report#Log.md", "path", "report#Log.md"],
      ] as const;
      for (const [input, kind, target] of cases) {
        invoke.mockImplementationOnce(async (_command, args: { path: string }) => {
          expect(realpathSync(join(root, args.path))).toBe(realpathSync(join(root, target)));
        });
        await openProjectPath(input, "primary", kind);
      }
      expect(toast).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(cases.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects network file URLs", async () => {
    await openProjectPath("file://server/share/file.md", "primary", "url");
    expect(invoke).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
  });

  it("shows native failures without rejecting fire-and-forget callers", async () => {
    invoke.mockRejectedValueOnce("file not found");
    await expect(openProjectPath("missing.md")).resolves.toBeUndefined();
    expect(toast).toHaveBeenCalledWith("Could not open file: file not found", "error");
  });
});
