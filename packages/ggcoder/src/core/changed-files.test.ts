import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  captureChangedFilesState,
  changedAbsolutePaths,
  diffChangedFiles,
  formatChangedFilesNote,
  parsePorcelainZ,
  ToolWriteLog,
  type ChangedFilesHashCache,
  type ChangedFilesOptions,
  type ChangedFilesResult,
  type ChangedFilesRootCache,
  type ChangedFilesState,
  type DiffChangedFilesOptions,
} from "./changed-files.js";

let root: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

async function capture(options: ChangedFilesOptions = {}): Promise<ChangedFilesState> {
  const state = await captureChangedFilesState(root, options);
  if (state.status !== "captured") throw new Error(`capture skipped: ${state.reason}`);
  return state;
}

async function around(
  action: () => Promise<void> | void,
  options: DiffChangedFilesOptions = {},
): Promise<ChangedFilesResult> {
  const cache: ChangedFilesHashCache = new Map();
  const before = await capture({ cache });
  await action();
  const after = await capture({ cache, previous: before });
  return diffChangedFiles(before, after, options);
}

function summary(result: ChangedFilesResult): string[] {
  if (result.status !== "compared") throw new Error(`skipped: ${result.reason}`);
  return result.paths.map((change) =>
    change.from !== undefined
      ? `${change.kind}:${change.from}->${change.path}`
      : `${change.kind}:${change.path}`,
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-changed-files-"));
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  await write(".gitignore", "dist/\n");
  await write("tracked.ts", "one\n");
  await write("keep.ts", "keep\n");
  await write("docs/evidence/a.png", "png-bytes");
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("parsePorcelainZ", () => {
  it("keeps leading-space status columns and spaces in paths without trimming", () => {
    expect(parsePorcelainZ(" M src/a.ts\0??  two  spaces \0")).toEqual([
      { x: " ", y: "M", path: "src/a.ts" },
      { x: "?", y: "?", path: " two  spaces " },
    ]);
  });

  it("reads the original path of renames and copies as the next field", () => {
    expect(parsePorcelainZ("R  new.ts\0old.ts\0C  copy.ts\0base.ts\0 D gone.ts\0")).toEqual([
      { x: "R", y: " ", path: "new.ts", from: "old.ts" },
      { x: "C", y: " ", path: "copy.ts", from: "base.ts" },
      { x: " ", y: "D", path: "gone.ts" },
    ]);
  });

  it("throws on malformed records", () => {
    expect(() => parsePorcelainZ("M\0")).toThrow(/malformed/);
    expect(() => parsePorcelainZ("R  new.ts\0")).toThrow(/original path/);
    expect(parsePorcelainZ("")).toEqual([]);
  });
});

describe("changed files around a command", () => {
  it("reports created, modified and deleted files", async () => {
    const result = await around(async () => {
      await write("new.ts", "new");
      await write("tracked.ts", "two\n");
      await fs.unlink(path.join(root, "keep.ts"));
    });
    expect(summary(result)).toEqual(["deleted:keep.ts", "created:new.ts", "modified:tracked.ts"]);
  });

  it("reports a git mv as one rename", async () => {
    const result = await around(() => git("mv", "keep.ts", "moved.ts"));
    expect(summary(result)).toEqual(["renamed:keep.ts->moved.ts"]);
  });

  it("handles unicode and space paths", async () => {
    const result = await around(async () => {
      await write("dir with space/ünïcödé 文件.ts", "x");
      await write(" lead.ts", "y");
    });
    expect(summary(result)).toEqual(["created: lead.ts", "created:dir with space/ünïcödé 文件.ts"]);
  });

  it("ignores untouched dirty files and reports re-modified ones", async () => {
    await write("tracked.ts", "dirty\n");
    await write("untracked.ts", "u");
    await write("keep.ts", "dirty keep\n");
    const result = await around(() => write("keep.ts", "changed again\n"));
    expect(summary(result)).toEqual(["modified:keep.ts"]);
  });

  it("reports nothing for index-only commands", async () => {
    await write("tracked.ts", "dirty\n");
    await write("untracked.ts", "u");
    expect(summary(await around(() => git("add", "-A")))).toEqual([]);
    expect(summary(await around(() => git("commit", "--quiet", "-m", "two")))).toEqual([]);
    expect(summary(await around(() => git("rm", "--cached", "--quiet", "keep.ts")))).toEqual([]);
  });

  it("reports files a checkout changed on disk and a restore of a dirty file", async () => {
    git("checkout", "--quiet", "-b", "other");
    await write("tracked.ts", "other branch\n");
    await write("branch-only.ts", "b");
    git("add", ".");
    git("commit", "--quiet", "-m", "other");
    git("checkout", "--quiet", "-");
    const switched = await around(() => git("checkout", "--quiet", "other"));
    expect(switched.status === "compared" && switched.headMoved).toBe(true);
    expect(summary(switched)).toEqual(["created:branch-only.ts", "modified:tracked.ts"]);
    await write("keep.ts", "dirty\n");
    expect(summary(await around(() => git("checkout", "--", "keep.ts")))).toEqual([
      "modified:keep.ts",
    ]);
  });

  it("does not report gitignored output", async () => {
    expect(summary(await around(() => write("dist/app.js", "built")))).toEqual([]);
  });

  it("excludes paths written by edit/write tools, including Windows paths", async () => {
    const posix = await around(
      async () => {
        await write("tool.ts", "t");
        await write("bash.ts", "b");
      },
      { excludePaths: [path.join(root, "tool.ts")], sessionCwd: root },
    );
    expect(summary(posix)).toEqual(["created:bash.ts"]);

    const before: ChangedFilesState = {
      status: "captured",
      root: "C:\\Repo",
      head: "abc",
      entries: new Map(),
      files: new Map(),
      headDiff: null,
      headDiffComplete: true,
    };
    const after: ChangedFilesState = {
      ...before,
      entries: new Map([
        ["Src/Tool.ts", [{ x: "?", y: "?", path: "Src/Tool.ts" }]],
        ["src/bash.ts", [{ x: "?", y: "?", path: "src/bash.ts" }]],
      ]),
      files: new Map([
        ["Src/Tool.ts", { kind: "file", digest: "1" }],
        ["src/bash.ts", { kind: "file", digest: "2" }],
      ]),
    };
    const windows = diffChangedFiles(before, after, {
      excludePaths: ["c:\\repo\\src\\tool.ts"],
      sessionCwd: "C:\\Repo",
      pathApi: path.win32,
    });
    expect(summary(windows)).toEqual(["created:src/bash.ts"]);
  });

  it("returns absolute paths for the ledger only when the list is complete", async () => {
    const result = await around(() => git("mv", "keep.ts", "moved.ts"));
    expect(changedAbsolutePaths(result)?.sort()).toEqual(
      [
        path.join(result.status === "compared" ? result.root : "", "keep.ts"),
        path.join(result.status === "compared" ? result.root : "", "moved.ts"),
      ].sort(),
    );
    expect(
      changedAbsolutePaths(result.status === "compared" ? { ...result, complete: false } : result),
    ).toBeNull();
    expect(changedAbsolutePaths({ status: "skipped", reason: "x", limit: false })).toBeNull();
  });
});

describe("workspace root cache", () => {
  it("reuses the root and re-resolves after git init in a subfolder", async () => {
    const sub = path.join(root, "pkg");
    await fs.mkdir(sub);
    const rootCache: ChangedFilesRootCache = {};
    const first = await captureChangedFilesState(sub, { rootCache });
    expect(first.status === "captured" && first.root).toBe(await fs.realpath(root));
    expect(rootCache.value?.root).toBe(await fs.realpath(root));
    execFileSync("git", ["init", "--quiet"], { cwd: sub });
    const second = await captureChangedFilesState(sub, { rootCache });
    expect(second.status === "captured" && second.root).toBe(await fs.realpath(sub));
  });

  it("re-resolves after git init in a folder between cwd and the cached root", async () => {
    const outer = path.join(root, "a");
    const cwd = path.join(outer, "b");
    await fs.mkdir(cwd, { recursive: true });
    const rootCache: ChangedFilesRootCache = {};
    const first = await captureChangedFilesState(cwd, { rootCache });
    expect(first.status === "captured" && first.root).toBe(await fs.realpath(root));
    expect(rootCache.value?.between).toEqual([await fs.realpath(outer)]);
    execFileSync("git", ["init", "--quiet"], { cwd: outer });
    const second = await captureChangedFilesState(cwd, { rootCache });
    expect(second.status === "captured" && second.root).toBe(await fs.realpath(outer));
    expect(rootCache.value).toEqual({
      root: await fs.realpath(outer),
      cwdHasGit: false,
      between: [],
    });
  });
});

describe("caps and skips", () => {
  it("skips outside a git repository", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gg-changed-outside-"));
    try {
      expect(await captureChangedFilesState(outside)).toEqual({
        status: "skipped",
        reason: "not a git repository",
        limit: false,
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("skips over the entry, byte and time caps with a stated reason", async () => {
    await write("a.ts", "a");
    await write("b.ts", "b");
    await write("c.ts", "c");
    expect(await captureChangedFilesState(root, { maxEntries: 2 })).toEqual({
      status: "skipped",
      reason: "more than 2 changed paths",
      limit: true,
    });
    await write("big.bin", "x".repeat(4096));
    expect(await captureChangedFilesState(root, { maxBytes: 1024 * 1024 * 0.001 })).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/^dirty files over/),
      limit: true,
    });
    expect(await captureChangedFilesState(root, { maxMs: 1 })).toEqual({
      status: "skipped",
      reason: "timed out after 1 ms",
      limit: true,
    });
  });
});

describe("formatChangedFilesNote", () => {
  const compared = (paths: string[], complete = true): ChangedFilesResult => ({
    status: "compared",
    root: "/repo",
    paths: paths.map((file) => ({ path: file, kind: "modified" })),
    complete,
    headMoved: false,
  });

  it("lists protected paths first, marks them, and caps at 8 plus a count", () => {
    const files = Array.from({ length: 11 }, (_, index) => `src/f${index}.ts`);
    const note = formatChangedFilesNote(compared([...files, "docs/evidence/a.png"]), [
      "docs/evidence/**",
    ]);
    expect(note).toBe(
      "[This command changed 12 files (not via edit/write): docs/evidence/a.png (modified, protected), " +
        files
          .slice(0, 7)
          .map((file) => `${file} (modified)`)
          .join(", ") +
        ", +4 more. Check these changes were intended.]",
    );
  });

  it("shows renames, flattens control characters and notes an incomplete list", () => {
    const note = formatChangedFilesNote(
      {
        status: "compared",
        root: "/repo",
        paths: [{ path: "new\nname.ts", kind: "renamed", from: "old.ts" }],
        complete: false,
        headMoved: true,
      },
      [],
    );
    expect(note).toBe(
      "[This command changed 1 file (not via edit/write, list may be incomplete): old.ts → newname.ts (renamed). Check these changes were intended.]",
    );
  });

  it("is silent for no changes and routine skips but names limit skips", () => {
    expect(formatChangedFilesNote(compared([]))).toBeNull();
    expect(
      formatChangedFilesNote({ status: "skipped", reason: "not a git repository", limit: false }),
    ).toBeNull();
    expect(
      formatChangedFilesNote({ status: "skipped", reason: "timed out after 1500 ms", limit: true }),
    ).toBe("[Changed-files check skipped: timed out after 1500 ms.]");
  });
});

describe("ToolWriteLog", () => {
  it("returns only writes after a mark", () => {
    const log = new ToolWriteLog();
    log.record("/a");
    const mark = log.mark();
    log.record("/b");
    expect(log.writtenSince(mark)).toEqual(["/b"]);
    expect(log.writtenSince(log.mark())).toEqual([]);
  });
});
