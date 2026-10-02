import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getMsysTempDir, getTempRoots } from "../core/temp-paths.js";
import { resolveWriteGuard } from "../core/workspace-guard.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";

const context = { signal: new AbortController().signal, toolCallId: "temp-access" };

describe("file tools outside the workspace", () => {
  it("reads, writes and edits files in each actual temporary root", async () => {
    const cwd = process.cwd();
    for (const root of getTempRoots()) {
      const dir = await fs.mkdtemp(path.join(root, "gg-temp-access-"));
      try {
        const file = path.join(dir, "fixture.txt");
        // Exercise the virtual spelling on Windows too, using the real shell mount.
        const toolPath =
          process.platform === "win32" && root === getMsysTempDir()
            ? `/tmp/${path.basename(dir)}/fixture.txt`
            : file;
        const write = await createWriteTool(cwd).execute(
          { file_path: toolPath, content: "original\n" },
          context,
        );
        expect(write).toContain("Wrote");
        const realFile = await fs.realpath(file);
        expect(await createReadTool(cwd).execute({ file_path: realFile }, context)).toContain(
          "original",
        );
        await createEditTool(cwd).execute(
          { file_path: toolPath, edits: [{ old_text: "original", new_text: "edited" }] },
          context,
        );
        expect(await fs.readFile(file, "utf8")).toBe("edited\n");
        const link = path.join(dir, "escape");
        await fs.symlink(os.homedir(), link, "junction");
        expect(resolveWriteGuard(cwd, path.join(link, "outside.txt")).allowed).toBe(false);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });
});
