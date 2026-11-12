import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inventoryV1Schema } from "./contracts.js";
import { buildProgrammaticAreaMap, type AreaHistoryInput } from "./area-map.js";
import type { AreaPassOutcome } from "./area-search.js";
import type { AreaSearchCache } from "./area-progress.js";
import {
  AreaRetryUnavailableError,
  assertAreaRetryFresh,
  citedFileDigests,
  retryTarget,
  structuralAreaMapDigest,
} from "./area-retry.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "area-retry-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const paths = [
  "package.json",
  ...Array.from({ length: 30 }, (_, index) => `packages/core/src/f${index}.ts`),
  ...Array.from({ length: 30 }, (_, index) => `packages/cli/src/f${index}.ts`),
].sort();
const inventory = inventoryV1Schema.parse({
  version: 1,
  configurationFingerprint: { version: 1, sha256: "a".repeat(64) },
  scanners: [],
  entries: paths.map((entry) =>
    entry.endsWith("package.json")
      ? { path: entry, sha256: "b".repeat(64) }
      : { path: entry, bytes: entry.length },
  ),
});
const history = (commits: number): AreaHistoryInput => ({
  status: "ok",
  sinceDays: 90,
  depth: 2,
  commitsRead: commits,
  truncated: false,
  entries: [{ path: "packages/core", commits }],
});

const searched = (file: string): AreaPassOutcome => ({
  status: "searched",
  needs: [],
  receipts: [
    {
      id: "r1",
      toolCallId: "t1",
      tool: "read",
      status: "retrieved",
      locations: [{ path: file, startLine: 1, endLine: 1 }],
    },
  ],
  sample: { listed: 1, excerpted: 1 },
});

it("compares the observed-path structure, not commit history", () => {
  const quiet = buildProgrammaticAreaMap({ inventory });
  const busy = buildProgrammaticAreaMap({ inventory, history: history(9) });
  expect(structuralAreaMapDigest(busy)).toBe(structuralAreaMapDigest(quiet));
  const grown = buildProgrammaticAreaMap({
    inventory: inventoryV1Schema.parse({
      ...inventory,
      entries: [...inventory.entries, { path: "packages/cli/src/new.ts", bytes: 1 }].sort(
        (left, right) => (left.path < right.path ? -1 : 1),
      ),
    }),
  });
  expect(structuralAreaMapDigest(grown)).not.toBe(structuralAreaMapDigest(quiet));
});

it("offers retry only for failed, timed-out and no-result areas", () => {
  const map = buildProgrammaticAreaMap({ inventory });
  const [area] = map.areas;
  if (!area) throw new Error("Fixture needs an area.");
  const [first, second, third, fourth] = ["a", "b", "c", "d"].map((id) => ({ ...area, id }));
  if (!first || !second || !third || !fourth) throw new Error("Fixture needs four areas.");
  const cache: AreaSearchCache = {
    owner: "s",
    sequence: 1,
    areaMapDigest: structuralAreaMapDigest(map),
    passes: [
      { area: first, outcome: { status: "incomplete", reason: "failed" } },
      { area: second, outcome: { status: "incomplete", reason: "cancelled" } },
      { area: third, outcome: searched("a.ts") },
      { area: fourth, outcome: { status: "incomplete", reason: "no-result" } },
    ],
    skipped: [],
    citedFiles: {},
  };
  expect(retryTarget(cache, first.id)).toBe(first);
  expect(retryTarget(cache, second.id)).toBeNull();
  expect(retryTarget(cache, third.id)).toBeNull();
  expect(retryTarget(cache, fourth.id)).toBe(fourth);
  expect(retryTarget(cache, "unknown")).toBeNull();
});

it("refuses when a cited file changes, disappears or leaves the project", async () => {
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  const signal = new AbortController().signal;
  const map = buildProgrammaticAreaMap({ inventory });
  const [area] = map.areas;
  if (!area) throw new Error("Fixture needs an area.");
  const passes = [{ area, outcome: searched("a.ts") }];
  const cache: AreaSearchCache = {
    owner: "s",
    sequence: 1,
    areaMapDigest: structuralAreaMapDigest(map),
    passes,
    skipped: [],
    citedFiles: await citedFileDigests(root, passes, signal),
  };
  await expect(assertAreaRetryFresh(root, cache, map, signal)).resolves.toBeUndefined();

  await fs.writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
  await expect(assertAreaRetryFresh(root, cache, map, signal)).rejects.toBeInstanceOf(
    AreaRetryUnavailableError,
  );
  await fs.rm(path.join(root, "a.ts"));
  await expect(assertAreaRetryFresh(root, cache, map, signal)).rejects.toBeInstanceOf(
    AreaRetryUnavailableError,
  );
  expect(await citedFileDigests(root, [{ outcome: searched("../outside.ts") }], signal)).toBeNull();
  const regrouped = buildProgrammaticAreaMap({ inventory: { ...inventory, entries: [] } });
  await expect(
    assertAreaRetryFresh(root, { ...cache, citedFiles: {} }, regrouped, signal),
  ).rejects.toBeInstanceOf(AreaRetryUnavailableError);
});
