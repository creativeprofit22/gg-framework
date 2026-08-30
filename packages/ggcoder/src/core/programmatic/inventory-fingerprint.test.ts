import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProgrammaticInventory } from "./inventory.js";

let root: string;
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

it("changes fingerprints for setup changes but not product-source changes", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-fingerprint-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "package.json"), "{\"scripts\":{}}\n");
  await fs.writeFile(path.join(root, "src", "product.ts"), "export const product = 1;\n");

  const initial = await buildProgrammaticInventory(root);
  await fs.writeFile(path.join(root, "src", "product.ts"), "export const product = 2;\n");
  const sourceChanged = await buildProgrammaticInventory(root);
  await fs.writeFile(path.join(root, "package.json"), "{\"scripts\":{\"check\":\"tsc\"}}\n");
  const setupChanged = await buildProgrammaticInventory(root);

  expect(sourceChanged.inventory.configurationFingerprint).toEqual(
    initial.inventory.configurationFingerprint,
  );
  expect(sourceChanged.inventory.entries).not.toEqual(initial.inventory.entries);
  expect(setupChanged.inventory.configurationFingerprint).not.toEqual(
    sourceChanged.inventory.configurationFingerprint,
  );
});
