import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgrammaticInventory, normalizeInventoryPath } from "./inventory.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix = "gg-programmatic-inventory-"): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeFixture(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [repositoryPath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, ...repositoryPath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("buildProgrammaticInventory", () => {
  it("orders a mixed-stack monorepo and respects repository exclusions", async () => {
    const root = await temporaryDirectory();
    await writeFixture(root, {
      ".gitignore": "ignored/\n*.generated.ts\n!kept.generated.ts\n",
      ".env": "TOKEN=must-not-leak\n",
      "package.json": "{\"private\":true}\n",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/web/package.json": "{\"name\":\"web\"}\n",
      "packages/web/src/index.ts": "export const web = true;\n",
      "crates/core/Cargo.toml": "[package]\nname = \"core\"\n",
      "crates/core/src/lib.rs": "pub fn core() {}\n",
      "python/pyproject.toml": "[project]\nname = \"worker\"\n",
      "python/worker.py": "print('worker')\n",
      "ignored/private.ts": "ignored\n",
      "kept.generated.ts": "kept\n",
      "other.generated.ts": "ignored\n",
      "node_modules/dependency/index.js": "excluded\n",
      "vendor/copied.go": "excluded\n",
      "build/output.js": "excluded\n",
    });

    const first = await buildProgrammaticInventory(root);
    const second = await buildProgrammaticInventory(root);
    const paths = first.inventory.entries.map((entry) => entry.path);

    expect(first).toEqual(second);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual([
      ".gitignore",
      "crates/core/Cargo.toml",
      "crates/core/src/lib.rs",
      "kept.generated.ts",
      "package.json",
      "packages/web/package.json",
      "packages/web/src/index.ts",
      "pnpm-workspace.yaml",
      "python/pyproject.toml",
      "python/worker.py",
    ]);
    expect(first.configurationInputs.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "crates/core/Cargo.toml",
      "package.json",
      "packages/web/package.json",
      "pnpm-workspace.yaml",
      "python/pyproject.toml",
    ]);
    expect(first.summary).toEqual({
      version: 1,
      fileCount: paths.length,
      totalBytes: expect.any(Number),
      configurationFileCount: 6,
    });
    expect(paths.every((entry) => !entry.includes("\\") && !path.isAbsolute(entry))).toBe(true);
  });

  it("refuses a symbolic-link escape", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("gg-programmatic-outside-");
    await writeFixture(root, { "package.json": "{}\n" });
    await writeFixture(outside, { "outside.txt": "outside\n" });
    await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(buildProgrammaticInventory(root)).rejects.toThrow(
      "Symbolic links are not supported: escape",
    );
  });

  it("fails closed with a relative evidence location when a file is unreadable", async () => {
    const root = await temporaryDirectory();
    await writeFixture(root, {
      "package.json": "{}\n",
      "src/blocked.ts": "export const blocked = true;\n",
    });

    await expect(
      buildProgrammaticInventory(root, {
        operations: {
          readFile: async (filePath) => {
            if (filePath.endsWith(`${path.sep}blocked.ts`)) throw new Error("private OS detail");
            return fs.readFile(filePath);
          },
        },
      }),
    ).rejects.toThrow("Inventory file is unreadable or unsafe: src/blocked.ts");
  });

  it("enforces file-count, per-file, and total-byte limits", async () => {
    const root = await temporaryDirectory();
    await writeFixture(root, { "a.txt": "aaa", "b.txt": "bbb" });

    await expect(buildProgrammaticInventory(root, { limits: { maxFiles: 1 } })).rejects.toThrow(
      "Inventory file count limit exceeded (1)",
    );
    await expect(
      buildProgrammaticInventory(root, { limits: { maxFileBytes: 2 } }),
    ).rejects.toThrow("Inventory file size limit exceeded (2)");
    await expect(
      buildProgrammaticInventory(root, { limits: { maxFileBytes: 3, maxTotalBytes: 5 } }),
    ).rejects.toThrow("Inventory total bytes limit exceeded (5)");
  });

  it("normalizes Windows-shaped glob paths without accepting traversal", () => {
    expect(normalizeInventoryPath("packages\\web\\package.json", "\\")).toBe(
      "packages/web/package.json",
    );
    expect(() => normalizeInventoryPath("..\\outside.txt", "\\")).toThrow(
      "Path escapes or is not normalized",
    );
  });

});
