import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  FileTooLargeError,
  MAX_READ_BYTES,
  NotRegularFileError,
  SymlinkRefusedError,
  localOperations,
  readFileBounded,
} from "./operations.js";

describe("readFileBounded", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-read-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a normal file unchanged", async () => {
    const filePath = path.join(tmpDir, "small.txt");
    await fs.writeFile(filePath, "alpha\nbeta");

    expect((await readFileBounded(filePath)).toString("utf-8")).toBe("alpha\nbeta");
  });

  it("reads a file exactly at the limit", async () => {
    const filePath = path.join(tmpDir, "exact.bin");
    await fs.writeFile(filePath, Buffer.alloc(64, 1));

    expect((await readFileBounded(filePath, 64)).length).toBe(64);
  });

  it("refuses a file one byte over the limit instead of loading it", async () => {
    const filePath = path.join(tmpDir, "big.bin");
    await fs.writeFile(filePath, Buffer.alloc(65, 1));

    await expect(readFileBounded(filePath, 64)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it("reports the real size and limit so the message can steer the model", async () => {
    const filePath = path.join(tmpDir, "big.bin");
    await fs.writeFile(filePath, Buffer.alloc(128, 1));

    const err = await readFileBounded(filePath, 64).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileTooLargeError);
    expect((err as FileTooLargeError).size).toBe(128);
    expect((err as FileTooLargeError).limit).toBe(64);
  });

  it("refuses a directory rather than throwing an opaque EISDIR later", async () => {
    await expect(readFileBounded(tmpDir)).rejects.toBeInstanceOf(NotRegularFileError);
  });

  // A fifo reports size 0, so a size check alone would wave it through and the
  // read would then park forever with no timeout. POSIX only: Windows has no
  // mkfifo and no path-reachable fifo here.
  it.runIf(process.platform !== "win32")(
    "refuses a fifo instead of hanging on it",
    async () => {
      const fifoPath = path.join(tmpDir, "pipe.png");
      execFileSync("mkfifo", [fifoPath]);

      await expect(readFileBounded(fifoPath)).rejects.toBeInstanceOf(NotRegularFileError);
    },
    5000,
  );

  // O_NOFOLLOW only exists on POSIX; on Windows the flag degrades to 0 and
  // containment is left to resolvePath and the sandbox.
  describe.runIf(process.platform !== "win32")("symlinks", () => {
    it("refuses a symlink instead of reading what it points at", async () => {
      const secret = path.join(tmpDir, "secret.txt");
      await fs.writeFile(secret, "SECRET");
      const link = path.join(tmpDir, "link.txt");
      await fs.symlink(secret, link);

      const err = await readFileBounded(link).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SymlinkRefusedError);
      expect(String((err as Error).message)).not.toContain("SECRET");
    });

    it("refuses a symlink swapped in after the path was checked", async () => {
      // The TOCTOU shape: a caller validates the path, then reads it. Between
      // those two steps the name is repointed at a file it never approved.
      const secret = path.join(tmpDir, "secret.txt");
      await fs.writeFile(secret, "SECRET");
      const target = path.join(tmpDir, "target.txt");
      await fs.writeFile(target, "benign");

      // Check: a plain regular file, exactly what a pre-check would approve.
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);

      // Swap: the attacker wins the race and repoints the name.
      await fs.rm(target);
      await fs.symlink(secret, target);

      // Use: the open itself must refuse, not hand back the secret.
      await expect(readFileBounded(target)).rejects.toBeInstanceOf(SymlinkRefusedError);
    });

    it("reads a normal file in a directory reached through a symlink", async () => {
      // Only the final component is refused. A symlinked parent is how many
      // real workspaces are laid out (/tmp on macOS is itself a symlink), so
      // rejecting those would break ordinary reads.
      const realDir = path.join(tmpDir, "real");
      await fs.mkdir(realDir);
      await fs.writeFile(path.join(realDir, "file.txt"), "content");
      const linkedDir = path.join(tmpDir, "linked");
      await fs.symlink(realDir, linkedDir);

      const text = (await readFileBounded(path.join(linkedDir, "file.txt"))).toString("utf-8");
      expect(text).toBe("content");
    });
  });

  it("still surfaces ENOENT for a missing file", async () => {
    const err = await readFileBounded(path.join(tmpDir, "nope.txt")).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("bounds the default local readFile every file tool goes through", async () => {
    const filePath = path.join(tmpDir, "huge.txt");
    // Sparse: gives a real oversized file without writing 20 MiB of bytes.
    const handle = await fs.open(filePath, "w");
    await handle.truncate(MAX_READ_BYTES + 1);
    await handle.close();

    await expect(localOperations.readFile(filePath)).rejects.toBeInstanceOf(FileTooLargeError);
  });
});
