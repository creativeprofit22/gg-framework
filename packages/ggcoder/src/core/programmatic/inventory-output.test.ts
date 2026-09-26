import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProgrammaticInventory, PROGRAMMATIC_INVENTORY_EXCLUSIONS } from "./inventory.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./profile.js";
import { readProgrammaticChatReport, readProgrammaticChatDetail, runProgrammaticScan } from "./lifecycle.js";

it("keeps repository script and source bodies out of generated routes and persisted chat reports", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-programmatic-report-"));
  const marker = "FIXTURE_PRIVATE_BODY_NOT_A_CREDENTIAL";
  await fs.mkdir(path.join(root, "src-tauri"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", description: marker, scripts: { scan: "FIXTURE_MUST_NOT_DISPATCH" } }));
  await fs.writeFile(path.join(root, "src-tauri/Cargo.toml"), "[package]\nname='fixture'\n");
  await fs.writeFile(path.join(root, "src-tauri/tauri.conf.json"), "{}\n");
  await fs.writeFile(path.join(root, "source.ts"), marker);
  const proposal = await buildProgrammaticProfileProposal(root);
  expect(proposal.profile.scanners.map((scanner) => scanner.specialistCommand)).toEqual(["setup-tauri-package"]);
  expect((await persistProgrammaticProfile(root, proposal.configurationFingerprint, proposal.profile, { expectedPriorProfileDigest: proposal.expectedPriorProfileDigest })).ok).toBe(true);
  expect((await runProgrammaticScan(root)).ok).toBe(true);
  const report = await readProgrammaticChatReport(root);
  expect(report.rows).toHaveLength(1);
  const persisted = JSON.parse(await fs.readFile(path.join(root, ".gg/programmatic/state.json"), "utf8"));
  const detail = await readProgrammaticChatDetail(root, persisted.records[0].opportunity.identity.id);
  const outputs = JSON.stringify({ proposal, report, detail, persisted });
  expect(outputs).not.toContain(marker);
  expect(outputs).not.toContain("FIXTURE_MUST_NOT_DISPATCH");
  expect(outputs).not.toContain(root);
  expect(persisted.records[0].lifecycle.state).toBe("discovered");
});

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
  expect(result.inventory.entries).toEqual([
    { path: "package.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    { path: "src/product.ts", bytes: expect.any(Number) },
  ]);
});
