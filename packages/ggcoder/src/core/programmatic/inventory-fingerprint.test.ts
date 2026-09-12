import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProgrammaticInventory } from "./inventory.js";

let root: string;
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

it("changes fingerprints for setup inputs but ignores source and managed output", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-fingerprint-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{}}\n');
  await fs.writeFile(path.join(root, ".gitignore"), ".gg/\n");
  await fs.writeFile(path.join(root, "src", "product.ts"), "export const product = 1;\n");

  const initial = await buildProgrammaticInventory(root);
  await fs.writeFile(path.join(root, "src", "product.ts"), "export const product = 2;\n");
  const sourceChanged = await buildProgrammaticInventory(root);
  expect(sourceChanged.inventory.configurationFingerprint).toEqual(
    initial.inventory.configurationFingerprint,
  );
  expect(sourceChanged.inventory.entries).not.toEqual(initial.inventory.entries);

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
