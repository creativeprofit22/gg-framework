import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProgrammaticInventory } from "./inventory.js";

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
  expect(output).not.toContain(".env");
  expect(Object.keys(result)).toEqual(["inventory", "summary", "configurationInputs"]);
  expect(result.inventory.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
});
