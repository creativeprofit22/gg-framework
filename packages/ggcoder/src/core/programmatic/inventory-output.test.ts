import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProgrammaticInventory, PROGRAMMATIC_INVENTORY_EXCLUSIONS } from "./inventory.js";

let root: string;
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

it("returns only bounded summaries, hashes, and repository-relative evidence locations", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-output-"));
  const secret = "inventory-secret-value";
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, ".env"), `TOKEN=${secret}\n`);
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.writeFile(path.join(root, "src", "product.ts"), `export const value = '${secret}';\n`);

  const result = await buildProgrammaticInventory(root);
  const output = JSON.stringify(result);

  expect(output).not.toContain(root);
  expect(output).not.toContain(secret);
  expect(output).not.toContain("TOKEN=");
  // Fixed exclusion policy names are now retained; secret files must still never become evidence.
  const { configurationSnapshot, ...inventoryOutput } = result;
  expect(JSON.stringify(inventoryOutput)).not.toContain(".env");
  expect(JSON.stringify(configurationSnapshot.inputs)).not.toContain(".env");
  expect(configurationSnapshot.exclusions).toEqual([...PROGRAMMATIC_INVENTORY_EXCLUSIONS].sort());
  expect(Object.keys(configurationSnapshot)).toEqual(["policyRevision", "scannerProfileSchemaRevision", "exclusions", "inputs"]);
  expect(Object.keys(result)).toEqual(["inventory", "summary", "configurationInputs", "configurationSnapshot"]);
  expect(result.inventory.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
});
