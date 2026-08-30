import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ConfigurationFingerprintV1,
  ProgrammaticProfileV1,
} from "../core/programmatic/contracts.js";
import {
  configurationFingerprintV1Schema,
  programmaticLifecycleStateV1Schema,
} from "../core/programmatic/contracts.js";
import {
  PROGRAMMATIC_STATE_PATH,
  runProgrammaticScan,
} from "../core/programmatic/lifecycle.js";
import { PROGRAMMATIC_PROFILE_PATH } from "../core/programmatic/inventory.js";
import { createProgrammaticProfileTool } from "./programmatic-profile.js";
import { createProgrammaticScanTool } from "./programmatic-scan.js";

const roots: string[] = [];
const context = {
  signal: new AbortController().signal,
  toolCallId: "programmatic-scan-test",
};

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-scan-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src-tauri"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), ".gg/\n");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  await fs.writeFile(path.join(root, "src-tauri/Cargo.toml"), '[package]\nname="fixture"\n');
  await fs.writeFile(
    path.join(root, "src-tauri/tauri.conf.json"),
    '{"identifier":"dev.fixture"}\n',
  );
  return root;
}

async function generateProfile(root: string): Promise<void> {
  const tool = createProgrammaticProfileTool(root);
  const inspected = JSON.parse((await tool.execute({ action: "inspect" }, context)) as string) as {
    configuration_fingerprint: ConfigurationFingerprintV1;
    profile: ProgrammaticProfileV1;
  };
  const generated = JSON.parse(
    (await tool.execute(
      {
        action: "generate",
        configuration_fingerprint: inspected.configuration_fingerprint,
        profile: inspected.profile,
      },
      context,
    )) as string,
  ) as { ok: boolean };
  expect(generated.ok).toBe(true);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("`/programmatic` validates the stored profile and configuration fingerprint before running a read-only scan", () => {
  it("fails before inventory for an invalid profile and persists only a validated fingerprint", async () => {
    const root = await repository();
    await generateProfile(root);
    const profilePath = path.join(root, PROGRAMMATIC_PROFILE_PATH);
    const validProfile = await fs.readFile(profilePath);
    await fs.writeFile(profilePath, '{"version":1,"scanners":[],"unexpected":true}\n');
    let inventoryReads = 0;

    const invalid = await runProgrammaticScan(root, {
      inventoryOperations: {
        readFile: async () => {
          inventoryReads += 1;
          throw new Error("inventory must not run");
        },
      },
    });

    expect(invalid).toMatchObject({ ok: false, error: "profile-invalid", changed: false });
    expect(inventoryReads).toBe(0);
    await expect(fs.access(path.join(root, PROGRAMMATIC_STATE_PATH))).rejects.toThrow();

    await fs.writeFile(profilePath, validProfile);
    const output = await createProgrammaticScanTool(root).execute({}, context);
    if (typeof output !== "string") throw new Error("Expected string tool output");
    const result = JSON.parse(output) as Record<string, unknown>;
    const fingerprint = configurationFingerprintV1Schema.parse(result.configuration_fingerprint);
    const state = programmaticLifecycleStateV1Schema.parse(
      JSON.parse(await fs.readFile(path.join(root, PROGRAMMATIC_STATE_PATH), "utf8")) as unknown,
    );

    expect(result).toMatchObject({ ok: true, changed: true, recovered: false });
    expect(result).not.toHaveProperty("inventory");
    expect(state.configurationFingerprint).toEqual(fingerprint);
  });
});
