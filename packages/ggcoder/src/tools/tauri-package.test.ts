import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessManager } from "../core/process-manager.js";
import { discoverTauriPackages } from "../core/tauri-package/discover.js";
import { commitSupportSet } from "../core/tauri-package/ownership.js";
import { detectHostTarget, GENERATED_PATHS } from "../core/tauri-package/paths.js";
import { renderTauriSupport } from "../core/tauri-package/render.js";
import type { CalibrationBounds } from "../core/tauri-package/types.js";
import { createTauriPackageTool } from "./tauri-package.js";
import { localOperations } from "./operations.js";

const fixture = path.join(
  import.meta.dirname,
  "..",
  "core",
  "tauri-package",
  "__fixtures__",
  "valid",
);
const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gg-tauri-tool-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  const cli = path.join(root, "apps/desktop/node_modules/@tauri-apps/cli");
  await mkdir(cli, { recursive: true });
  await writeFile(
    path.join(cli, "package.json"),
    `${JSON.stringify({ version: "2.11.2", bin: { tauri: "./tauri.js" } }, null, 2)}\n`,
  );
  await writeFile(path.join(cli, "tauri.js"), "module.exports = {};\n");
  const host = detectHostTarget();
  const binaries = path.join(root, "apps/desktop/src-tauri/binaries");
  await mkdir(binaries, { recursive: true });
  await writeFile(
    path.join(binaries, `helper-${host.rust_triple}${host.platform === "win32" ? ".exe" : ""}`),
    "sidecar\n",
  );
  return root;
}

function manager(): ProcessManager {
  return new ProcessManager(localOperations.process);
}

async function execute(
  tool: ReturnType<typeof createTauriPackageTool>,
  input: {
    action: "inspect" | "setup" | "calibrate" | "package" | "verify";
    target_id?: string;
    evidence_sha256?: string;
  },
): Promise<Record<string, unknown> | string> {
  const output = await tool.execute(input, {
    signal: new AbortController().signal,
    toolCallId: "tauri-package-test",
  });
  if (typeof output !== "string") throw new Error("Expected string tool output");
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    return output;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tauri_package tool", () => {
  it("inspects, sets up, verifies, and records six-file mutation callbacks", async () => {
    const root = await repository();
    const before: string[] = [];
    const after: string[] = [];
    const tool = createTauriPackageTool(root, manager(), {
      onPreFileMutation: (file) => {
        before.push(file);
      },
      onFileMutated: (file) => {
        after.push(file);
      },
    });
    const inspected = (await execute(tool, { action: "inspect" })) as Record<string, unknown>;
    const target = (inspected.targets as Array<{ target_id: string }>)[0]!;
    const setup = (await execute(tool, {
      action: "setup",
      target_id: target.target_id,
      evidence_sha256: inspected.evidence_sha256 as string,
    })) as Record<string, unknown>;

    expect(setup).toMatchObject({ action: "setup", changed: true, target_id: target.target_id });
    expect(before.map((file) => path.relative(root, file).split(path.sep).join("/"))).toEqual(
      GENERATED_PATHS,
    );
    expect(after.map((file) => path.relative(root, file).split(path.sep).join("/"))).toEqual(
      GENERATED_PATHS,
    );
    await expect(
      execute(tool, { action: "verify", target_id: target.target_id }),
    ).resolves.toMatchObject({ ok: true });

    const discovery = await discoverTauriPackages(root);
    const calibration: CalibrationBounds = {
      evidence_sha256: discovery.evidence_sha256,
      baseline_total_bytes: 1,
      maximum_total_bytes: 1,
      maximum_file_bytes: 1,
      role_counts: { app: 1, bundle: 0 },
      role_maximum_bytes: { app: 1, bundle: 0 },
      required_paths: [],
      absolute_growth_bytes: 0,
      percentage_growth: 0,
    };
    await commitSupportSet(root, renderTauriSupport(discovery, discovery.targets[0]!, calibration));
    const repeated = await execute(tool, {
      action: "setup",
      target_id: target.target_id,
      evidence_sha256: inspected.evidence_sha256 as string,
    });
    expect(repeated).toMatchObject({ action: "setup", changed: false });
    expect(
      JSON.parse(await readFile(path.join(root, "scripts/package-tauri.config.json"), "utf8")),
    ).toMatchObject({ calibration });
    expect(before).toHaveLength(GENERATED_PATHS.length);
    expect(after).toHaveLength(GENERATED_PATHS.length);
  });

  it("rejects stale inspect evidence without writes", async () => {
    const root = await repository();
    const tool = createTauriPackageTool(root, manager());
    const inspected = (await execute(tool, { action: "inspect" })) as Record<string, unknown>;
    const target = (inspected.targets as Array<{ target_id: string }>)[0]!;
    await writeFile(path.join(root, "apps/desktop/src-tauri/resources/data.txt"), "changed\n");

    const setup = await execute(tool, {
      action: "setup",
      target_id: target.target_id,
      evidence_sha256: inspected.evidence_sha256 as string,
    });

    expect(setup).toMatchObject({ error: "stale-evidence", changed: false });
  });

  it("rejects mutating actions in plan mode", async () => {
    const root = await repository();
    const tool = createTauriPackageTool(root, manager(), { planModeRef: { current: true } });
    const result = await execute(tool, {
      action: "setup",
      target_id: "tauri-fixture",
      evidence_sha256: "0".repeat(64),
    });
    expect(result).toContain("tauri_package is restricted in plan mode");
  });

  it("fails closed for non-local operations", async () => {
    const root = await repository();
    const tool = createTauriPackageTool(root, manager(), { operations: { ...localOperations } });
    expect(await execute(tool, { action: "inspect" })).toBe(
      "Error: tauri_package supports only local ToolOperations in this version.",
    );
  });
});
