import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildProgrammaticInventory,
  compareConfigurationSnapshots,
  fingerprintConfigurationSnapshot,
  validateProfileConfigurationBaseline,
} from "./inventory.js";

it("validates the retained snapshot against the approved aggregate", () => {
  const configurationSnapshot = {
    policyRevision: 2,
    scannerProfileSchemaRevision: 1,
    exclusions: [],
    inputs: [{ path: "package.json", sha256: "a".repeat(64) }],
  };
  const envelope = {
    version: 2,
    profile: { version: 1, scanners: [] },
    configurationSnapshot,
    configurationFingerprint: fingerprintConfigurationSnapshot(configurationSnapshot),
  };
  expect(validateProfileConfigurationBaseline(envelope)).toEqual(envelope);
  expect(() =>
    validateProfileConfigurationBaseline({
      ...envelope,
      configurationSnapshot: { ...configurationSnapshot, inputs: [] },
    }),
  ).toThrow(/fingerprint/);
});

let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it("changes fingerprints for setup inputs but ignores source and managed output", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-fingerprint-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{}}\n');
  await fs.writeFile(path.join(root, ".gitignore"), ".gg/\n");
  await fs.writeFile(path.join(root, "src", "product.ts"), "export const product = 1;\n");

  const initial = await buildProgrammaticInventory(root);
  expect(fingerprintConfigurationSnapshot(initial.configurationSnapshot)).toEqual(
    initial.inventory.configurationFingerprint,
  );
  await fs.writeFile(path.join(root, "src", "product.ts"), "export const product = 2;\n");
  const sourceChanged = await buildProgrammaticInventory(root);
  expect(sourceChanged.inventory.configurationFingerprint).toEqual(
    initial.inventory.configurationFingerprint,
  );
  expect(sourceChanged.inventory.entries).toContainEqual({ path: "src/product.ts", bytes: 26 });

  await fs.mkdir(path.join(root, ".gg/programmatic"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".gg/programmatic/profile.json"),
    '{"version":1,"scanners":[]}\n',
  );
  const managedProfile = await buildProgrammaticInventory(root);
  expect(managedProfile.inventory.configurationFingerprint).toEqual(
    initial.inventory.configurationFingerprint,
  );
  expect(managedProfile.configurationInputs.map((entry) => entry.path)).not.toContain(
    ".gg/programmatic/profile.json",
  );

  await fs.writeFile(path.join(root, ".gg/programmatic/review.json"), "{}\n");
  const externalSetup = await buildProgrammaticInventory(root);
  expect(externalSetup.inventory.configurationFingerprint).not.toEqual(
    managedProfile.inventory.configurationFingerprint,
  );
  expect(externalSetup.configurationInputs.map((entry) => entry.path)).toContain(
    ".gg/programmatic/review.json",
  );

  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"check":"tsc"}}\n');
  const setupChanged = await buildProgrammaticInventory(root);
  expect(setupChanged.inventory.configurationFingerprint).not.toEqual(
    externalSetup.inventory.configurationFingerprint,
  );
});

it.each([
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "rust-toolchain.toml",
  ".gitignore",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".tool-versions",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.conf.json5",
  "src-tauri/tauri.conf.toml",
  "src-tauri/Tauri.toml",
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/Tauri.macos.toml",
])("retains exact added/modified/removed setup input: %s", async (input) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-drift-"));
  const initial = await buildProgrammaticInventory(root);
  const target = path.join(root, input);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "\n");
  const added = await buildProgrammaticInventory(root);
  const addedHash = added.configurationInputs[0]!.sha256;
  expect(
    compareConfigurationSnapshots(initial.configurationSnapshot, added.configurationSnapshot),
  ).toEqual({
    files: [{ path: input, kind: "added", before: null, after: addedHash }],
    policy: null,
    schema: null,
    exclusions: null,
  });
  await fs.writeFile(target, "\n\n");
  const modified = await buildProgrammaticInventory(root);
  const modifiedHash = modified.configurationInputs[0]!.sha256;
  expect(
    compareConfigurationSnapshots(added.configurationSnapshot, modified.configurationSnapshot)
      .files,
  ).toEqual([{ path: input, kind: "modified", before: addedHash, after: modifiedHash }]);
  await fs.unlink(target);
  const removed = await buildProgrammaticInventory(root);
  expect(
    compareConfigurationSnapshots(modified.configurationSnapshot, removed.configurationSnapshot)
      .files,
  ).toEqual([{ path: input, kind: "removed", before: modifiedHash, after: null }]);
  expect(removed.inventory.configurationFingerprint).toEqual(
    initial.inventory.configurationFingerprint,
  );
});

it("ignores docs, source and lifecycle writes across repeated inventories", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-irrelevant-"));
  await fs.mkdir(path.join(root, ".gg/programmatic"), { recursive: true });
  const initial = await buildProgrammaticInventory(root);
  for (const input of [
    "README.md",
    "product.ts",
    ".gg/programmatic/state.json",
    ".gg/programmatic/state.previous.json",
    ".gg/programmatic/.state.tmp",
  ]) {
    await fs.writeFile(path.join(root, input), "changed");
    for (let iteration = 0; iteration < 2; iteration++) {
      const result = await buildProgrammaticInventory(root);
      expect(result.configurationSnapshot).toEqual(initial.configurationSnapshot);
    }
  }
});

it("reports deterministic file ordering and explicit policy, schema and exclusion changes", () => {
  const previous = {
    policyRevision: 1,
    scannerProfileSchemaRevision: 1,
    exclusions: ["a"],
    inputs: [
      { path: "b.json", sha256: "a".repeat(64) },
      { path: "z.json", sha256: "a".repeat(64) },
    ],
  };
  const current = {
    policyRevision: 2,
    scannerProfileSchemaRevision: 2,
    exclusions: ["b"],
    inputs: [
      { path: "a.json", sha256: "b".repeat(64) },
      { path: "b.json", sha256: "b".repeat(64) },
    ],
  };
  const drift = compareConfigurationSnapshots(previous, current);
  expect(drift.files.map(({ path, kind }) => [path, kind])).toEqual([
    ["a.json", "added"],
    ["b.json", "modified"],
    ["z.json", "removed"],
  ]);
  expect(drift.policy).toEqual({ before: 1, after: 2 });
  expect(drift.schema).toEqual({ before: 1, after: 2 });
  expect(drift.exclusions).toEqual({ before: ["a"], after: ["b"] });
  expect(() =>
    compareConfigurationSnapshots(previous, { ...current, inputs: current.inputs.reverse() }),
  ).toThrow();
});
