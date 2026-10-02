import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { motionPath, motionSourceHash, readMotionText } from "./motion-review.js";

let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "motion-state-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
describe("Motion artifact/source identity", () => {
  it("invalidates source and media edits, additions and deletions while ignoring QA output", async () => {
    await fs.writeFile(path.join(tmp, "index.html"), "first");
    const output = path.join(tmp, "video.mp4");
    const original = await motionSourceHash(tmp, output);
    await fs.mkdir(path.join(tmp, "qa"));
    await fs.writeFile(path.join(tmp, "qa", "report.json"), "report");
    await fs.writeFile(output, "render");
    expect(await motionSourceHash(tmp, output)).toBe(original);
    await fs.writeFile(path.join(tmp, "index.html"), "second");
    const changed = await motionSourceHash(tmp, output);
    expect(changed).not.toBe(original);
    await fs.writeFile(path.join(tmp, "audio.wav"), "audio");
    expect(await motionSourceHash(tmp, output)).not.toBe(changed);
    await fs.unlink(path.join(tmp, "audio.wav"));
    expect(await motionSourceHash(tmp, output)).toBe(changed);
  });
  it("rejects path escapes and oversized brief data", async () => {
    await expect(motionPath(tmp, "../")).rejects.toThrow("escapes");
    await fs.writeFile(path.join(tmp, "frame.md"), "x".repeat(100));
    await expect(readMotionText(tmp, "frame.md", 50)).rejects.toThrow("limit");
  });
  it("does not fingerprint symlinked external data", async () => {
    await fs.symlink(
      os.tmpdir(),
      path.join(tmp, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(motionSourceHash(tmp, path.join(tmp, "out.mp4"))).rejects.toThrow("symlinks");
  });
  it("cancels source hashing", async () => {
    const c = new AbortController();
    c.abort();
    await expect(motionSourceHash(tmp, path.join(tmp, "out.mp4"), c.signal)).rejects.toThrow();
  });
});
