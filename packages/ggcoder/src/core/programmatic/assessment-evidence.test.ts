import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as inventory from "./inventory.js";
import { ASSESSMENT_EVIDENCE_LIMITS as limits, collectProgrammaticAssessmentEvidence as collect } from "./assessment-evidence.js";

const roots: string[] = [];
async function fixture(files: Record<string, string | Buffer> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-assessment-evidence-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), contents);
  }
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("bounded assessment evidence", () => {
  it("reads manifest-free extensionless and unfamiliar text without manufacturing inventory authority", async () => {
    const root = await fixture({ WORKFLOW: "Operators reconcile handwritten stock counts.", "dispatch.unfamiliar": "route orders\n" });
    const result = await collect(root);
    expect(result.paths).toHaveLength(2);
    expect(result.paths.every((item) => item.coverage === "inspected")).toBe(true);
    expect(result.excerpts).toEqual(expect.arrayContaining([
      { path: "WORKFLOW", text: "Operators reconcile handwritten stock counts.", truncated: false },
      { path: "dispatch.unfamiliar", text: "route orders\n", truncated: false },
    ]));
    expect(result.diagnostics).toEqual([]);
    expect(result).not.toHaveProperty("configurationFingerprint");
    expect(result).not.toHaveProperty("configurationSnapshot");
    expect((await fs.readdir(root)).sort()).toEqual(["WORKFLOW", "dispatch.unfamiliar"]);
  });

  it("authorizes traversal and every content read, including ignore policy, before filesystem content access", async () => {
    const root = await fixture({ ".gitignore": "private", private: "SECRET", WORKFLOW: "safe" });
    const reads = vi.spyOn(inventory, "validateProgrammaticFile");
    const authorize = vi.fn(async (request: { name: string }) => request.name === "find");
    const result = await collect(root, { authorization: { authorize, isAllowed: () => true } });
    expect(authorize.mock.calls.map(([request]) => request)).toEqual([
      { name: "find", args: { pattern: "**/*" } },
      { name: "read", args: { file_path: ".gitignore", limit: 16385 } },
    ]);
    expect(reads).not.toHaveBeenCalled();
    expect(result.excerpts).toEqual([]);
    expect(result.diagnostics).toContainEqual({ code: "permission-denied", count: 1 });
  });

  it("keeps permitted evidence when another read is denied and rechecks after containment awaits", async () => {
    const root = await fixture({ a: "SECRET", b: "permitted" });
    let allowed = true;
    const original = inventory.validateProgrammaticFile;
    vi.spyOn(inventory, "validateProgrammaticFile").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === "a") allowed = false;
      return result;
    });
    const result = await collect(root, { authorization: {
      authorize: async () => true,
      isAllowed: (request) => request.name !== "read" || request.args.file_path !== "a" || allowed,
    } });
    expect(result.excerpts).toEqual([{ path: "b", text: "permitted", truncated: false }]);
    expect(result.paths).toContainEqual({ path: "a", coverage: "uninspected" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("shares strict exclusions and root ignore policy across a mixed monorepo", async () => {
    const root = await fixture({
      ".gitignore": "ignored/\n*.generated\n!keep.generated\n",
      ".env": "SECRET", ".env.local": "SECRET", "cert.key": "SECRET", ".npmrc": "SECRET",
      "node_modules/a/index": "SECRET", "nested/vendor/a": "SECRET", "dist/output": "SECRET",
      ".git/config": "SECRET", "ignored/private": "SECRET", "drop.generated": "SECRET",
      ".gg/programmatic/state.json": "SECRET", "keep.generated": "retained",
      "apps/web/package.json": "{}", "crates/lib/Cargo.toml": "[package]", "ops/RUNBOOK": "manual workflow",
    });
    const result = await collect(root);
    const strict = await inventory.buildProgrammaticInventory(root);
    expect(result.paths.map((item) => item.path).sort()).toEqual(strict.inventory.entries.map((item) => item.path));
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result.excerpts).toHaveLength(5);
  });

  it("bounds paths and read attempts while leaving strict count failure intact", async () => {
    const root = await fixture(Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`file-${i}`, "text"])));
    const reads = vi.spyOn(inventory, "validateProgrammaticFile");
    const result = await collect(root);
    expect(result.paths).toHaveLength(limits.maxPaths);
    expect(result.excerpts).toHaveLength(limits.maxExcerpts);
    expect(reads).toHaveBeenCalledTimes(24); // Before/after each of twelve prefix reads.
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      { code: "path-limit", count: 1 }, { code: "excerpt-limit", count: 188 },
    ]));
    expect(result.paths.filter((item) => item.coverage === "budget-limited")).toHaveLength(188);
    await expect(inventory.buildProgrammaticInventory(root, { limits: { maxFiles: 200 } })).rejects.toThrow("Inventory file count limit exceeded (200)");
  });

  it.each(["é😀", "\"\\\t\n"])("caps serialized delivery including escaping and UTF-8: %j", async (unit) => {
    const root = await fixture(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`text-${i}`, unit.repeat(20_000)])));
    const result = await collect(root);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(limits.maxDeliveredBytes);
    expect(result.excerpts.length).toBeLessThanOrEqual(limits.maxExcerpts);
    expect(result.excerpts.every((item) => Buffer.byteLength(item.text) <= limits.maxExcerptBytes)).toBe(true);
    expect(result.excerpts.every((item) => item.truncated)).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["delivery-limit", "excerpt-truncated"]));
    expect(JSON.stringify(result)).not.toContain("�");
    const bounded = await inventory.buildProgrammaticInventory(root, { limits: { maxFileBytes: limits.maxExcerptBytes } });
    expect(bounded.inventory.entries).toHaveLength(12);
    expect(bounded.inventory.entries.every((entry) => "bytes" in entry && entry.bytes > limits.maxExcerptBytes)).toBe(true);
  });

  it("labels only actual prefix truncation at the exact byte boundary", async () => {
    const root = await fixture({ exact: "a".repeat(limits.maxExcerptBytes), over: "a".repeat(limits.maxExcerptBytes + 1) });
    const result = await collect(root);
    expect(result.excerpts.map(({ path, text, truncated }) => ({ path, bytes: Buffer.byteLength(text), truncated }))).toEqual([
      { path: "exact", bytes: limits.maxExcerptBytes, truncated: false },
      { path: "over", bytes: limits.maxExcerptBytes, truncated: true },
    ]);
    expect(result.diagnostics).toEqual([{ code: "excerpt-truncated", count: 1 }]);
  });

  it("refuses a junction used as the ignore policy without reading outside content", async () => {
    const root = await fixture({ WORKFLOW: "safe" });
    const outside = await fixture({ private: "OUTSIDE SECRET" });
    await fs.symlink(outside, path.join(root, ".gitignore"), process.platform === "win32" ? "junction" : "dir");
    const result = await collect(root);
    expect(result.paths).toEqual([]);
    expect(result.excerpts).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["unreadable-or-unsafe", "walk-failed"]);
  });

  it("distinguishes non-text from empty text and an empty project", async () => {
    const root = await fixture({ binary: Buffer.from([0, 1, 2]), invalid: Buffer.from([255, 254]), EMPTY: "" });
    const result = await collect(root);
    expect(result.excerpts).toEqual([{ path: "EMPTY", text: "", truncated: false }]);
    expect(result.paths.filter((item) => item.coverage === "nonmatching")).toHaveLength(2);
    expect(result.diagnostics).toEqual([{ code: "non-text", count: 2 }]);
    expect((await collect(await fixture())).paths).toEqual([]);
  });

  it("keeps safely available evidence but never follows a directory junction", async () => {
    const root = await fixture({ WORKFLOW: "safe" });
    const outside = await fixture({ private: "OUTSIDE SECRET" });
    await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const result = await collect(root);
    expect(result.paths).toContainEqual({ path: "escape", coverage: "unreadable-or-unsafe" });
    expect(result.excerpts).toEqual([{ path: "WORKFLOW", text: "safe", truncated: false }]);
    expect(JSON.stringify(result)).not.toContain("OUTSIDE SECRET");
    await expect(inventory.buildProgrammaticInventory(root)).rejects.toThrow("Symbolic links are not supported");
  });

  it("fails discovery closed under unreadable, non-text or oversized ignore policy", async () => {
    for (const contents of ["ignored\n".repeat(3000), Buffer.from([0])]) {
      const result = await collect(await fixture({ ".gitignore": contents, private: "SECRET" }));
      expect(result.paths).toEqual([]);
      expect(result.diagnostics.map((item) => item.code)).toEqual(["unreadable-or-unsafe", "walk-failed"]);
    }
    const root = await fixture({ ".gitignore": "private", private: "SECRET" });
    vi.spyOn(inventory, "validateProgrammaticFile").mockRejectedValue(new Error("PRIVATE OS DETAIL"));
    const result = await collect(root);
    expect(result.paths).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE OS DETAIL");
  });

  it("retains typed diagnostics and safe files after ordinary read and walk failures", async () => {
    const root = await fixture({ a: "unreadable", b: "safe" });
    const original = inventory.validateProgrammaticFile;
    vi.spyOn(inventory, "validateProgrammaticFile").mockImplementation((root, name, ...args) => {
      if (name === "a") throw new Error("PRIVATE OS DETAIL");
      return original(root, name, ...args);
    });
    vi.spyOn(inventory, "walkProgrammaticPaths").mockImplementation(async function* () {
      yield { path: "a", kind: "file" };
      yield { path: "b", kind: "file" };
      throw new Error("PRIVATE OS DETAIL");
    });
    const result = await collect(root);
    expect(result.paths).toContainEqual({ path: "a", coverage: "unreadable-or-unsafe" });
    expect(result.excerpts).toEqual([{ path: "b", text: "safe", truncated: false }]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["walk-failed", "unreadable-or-unsafe"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE OS DETAIL");
  });

  it("rejects cancellation before work, during discovery, and during reads without delivering partial evidence", async () => {
    const root = await fixture({ a: "safe", b: "safe" });
    const early = AbortSignal.abort(new Error("stop early"));
    await expect(collect(root, { signal: early })).rejects.toThrow("stop early");
    const walking = new AbortController();
    const walk = vi.spyOn(inventory, "walkProgrammaticPaths").mockImplementation(async function* () {
      yield { path: "a", kind: "file" };
      walking.abort(new Error("stop walk"));
      yield { path: "b", kind: "file" };
    });
    await expect(collect(root, { signal: walking.signal })).rejects.toThrow("stop walk");
    walk.mockRestore();
    const reading = new AbortController();
    const original = inventory.validateProgrammaticFile;
    const reads = vi.spyOn(inventory, "validateProgrammaticFile").mockImplementation(async (...args) => {
      const value = await original(...args);
      reading.abort(new Error("stop read"));
      return value;
    });
    await expect(collect(root, { signal: reading.signal })).rejects.toThrow("stop read");
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    const afterRead = new AbortController();
    let checks = 0;
    vi.spyOn(inventory, "validateProgrammaticFile").mockImplementation(async (...args) => {
      const value = await original(...args);
      if (++checks === 2) afterRead.abort(new Error("stop after read"));
      return value;
    });
    await expect(collect(root, { signal: afterRead.signal })).rejects.toThrow("stop after read");
    expect(checks).toBe(2);
  });
});
