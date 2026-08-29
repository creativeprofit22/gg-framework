import { describe, expect, it } from "vitest";
import {
  configurationFingerprintV1Schema,
  evidenceItemV1Schema,
  evidenceLocationV1Schema,
  evidenceV1Schema,
  executionResultV1Schema,
  inventoryEntryV1Schema,
  inventoryV1Schema,
  opportunityIdentityV1Schema,
  opportunityLifecycleV1Schema,
  opportunityTransitionV1Schema,
  repositoryRelativePathSchema,
  routeEnvelopeV1Schema,
  scannerProfileV1Schema,
} from "./contracts.js";

const configurationFingerprint = { version: 1, sha256: "a".repeat(64) };
const scannerProfile = {
  version: 1,
  id: "ci-scanner",
  specialistCommand: "research",
};
const inventoryEntry = { path: "package.json", sha256: "b".repeat(64) };
const inventory = {
  version: 1,
  configurationFingerprint,
  scanners: [
    scannerProfile,
    { version: 1, id: "sweep-scanner", specialistCommand: "setup-sweep" },
  ],
  entries: [inventoryEntry, { path: "src/index.ts", sha256: "c".repeat(64) }],
};
const evidenceLocation = { path: "src/index.ts", startLine: 10, endLine: 12 };
const evidenceItem = {
  source: "ci-scanner",
  code: "missing-ci",
  severity: "warning",
  message: "No continuous integration workflow was found.",
  location: evidenceLocation,
};
const evidence = { version: 1, items: [evidenceItem] };
const opportunity = {
  version: 1,
  scannerId: "ci-scanner",
  specialistCommand: "research",
  key: "missing-ci",
  path: ".github/workflows/ci.yml",
};
const lifecycle = { version: 1, opportunity, state: "discovered" };
const transition = { version: 1, opportunity, from: "discovered", to: "queued" };
const route = {
  version: 1,
  opportunity,
  specialistCommand: "research",
  configurationFingerprint,
};
const executionResult = {
  version: 1,
  route,
  status: "succeeded",
  summary: "CI setup completed.",
  evidence,
};

describe("programmatic contract fixtures", () => {
  const fixtures = [
    ["repository path", repositoryRelativePathSchema, "src/index.ts"],
    ["configuration fingerprint", configurationFingerprintV1Schema, configurationFingerprint],
    ["scanner profile", scannerProfileV1Schema, scannerProfile],
    ["inventory entry", inventoryEntryV1Schema, inventoryEntry],
    ["inventory", inventoryV1Schema, inventory],
    ["evidence location", evidenceLocationV1Schema, evidenceLocation],
    ["evidence item", evidenceItemV1Schema, evidenceItem],
    ["evidence", evidenceV1Schema, evidence],
    ["opportunity identity", opportunityIdentityV1Schema, opportunity],
    ["opportunity lifecycle", opportunityLifecycleV1Schema, lifecycle],
    ["opportunity transition", opportunityTransitionV1Schema, transition],
    ["route envelope", routeEnvelopeV1Schema, route],
    ["execution result", executionResultV1Schema, executionResult],
  ] as const;

  it.each(fixtures)("parses the valid %s fixture unchanged", (_name, schema, fixture) => {
    expect(schema.parse(fixture)).toEqual(fixture);
  });
});

describe("strict records", () => {
  const cases = [
    [configurationFingerprintV1Schema, { ...configurationFingerprint, unexpected: true }],
    [scannerProfileV1Schema, { ...scannerProfile, unexpected: true }],
    [inventoryEntryV1Schema, { ...inventoryEntry, unexpected: true }],
    [inventoryV1Schema, { ...inventory, unexpected: true }],
    [evidenceLocationV1Schema, { ...evidenceLocation, unexpected: true }],
    [evidenceItemV1Schema, { ...evidenceItem, unexpected: true }],
    [evidenceV1Schema, { ...evidence, rawOutput: "unbounded output" }],
    [opportunityIdentityV1Schema, { ...opportunity, unexpected: true }],
    [opportunityLifecycleV1Schema, { ...lifecycle, unexpected: true }],
    [opportunityTransitionV1Schema, { ...transition, unexpected: true }],
    [routeEnvelopeV1Schema, { ...route, command: "arbitrary command" }],
    [executionResultV1Schema, { ...executionResult, unexpected: true }],
  ] as const;

  it.each(cases)("rejects unknown fields at a contract boundary", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("rejects unknown fields in nested records", () => {
    expect(
      executionResultV1Schema.safeParse({
        ...executionResult,
        route: { ...route, configurationFingerprint: { ...configurationFingerprint, extra: true } },
      }).success,
    ).toBe(false);
  });
});

describe("repository-relative paths", () => {
  const invalidPaths = [
    "",
    ".",
    "..",
    "../src/index.ts",
    "src/../index.ts",
    "src/./index.ts",
    "./src/index.ts",
    "src//index.ts",
    "src/index.ts/",
    "/src/index.ts",
    "//server/share/index.ts",
    "C:/repo/src/index.ts",
    "C:\\repo\\src\\index.ts",
    "\\\\server\\share\\index.ts",
    "src\\index.ts",
    "src/\0index.ts",
    "a".repeat(501),
  ];

  it.each(invalidPaths)("rejects %j", (value) => {
    expect(repositoryRelativePathSchema.safeParse(value).success).toBe(false);
  });
});

describe("fingerprints and scanner profiles", () => {
  it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)])(
    "rejects malformed SHA-256 digest %j",
    (sha256) => {
      expect(configurationFingerprintV1Schema.safeParse({ version: 1, sha256 }).success).toBe(
        false,
      );
    },
  );

  it.each([
    "",
    "CI-scanner",
    "ci_scanner",
    "-ci",
    "ci-",
    "ci--scanner",
    "ci scanner",
    "a".repeat(101),
  ])("rejects malformed scanner ID %j", (id) => {
    expect(scannerProfileV1Schema.safeParse({ ...scannerProfile, id }).success).toBe(false);
  });

  it.each(["research", "setup-sweep", "setup-tauri-package"])(
    "accepts supported specialist %j",
    (specialistCommand) => {
      expect(
        scannerProfileV1Schema.safeParse({ ...scannerProfile, specialistCommand }).success,
      ).toBe(true);
      expect(
        opportunityIdentityV1Schema.safeParse({ ...opportunity, specialistCommand }).success,
      ).toBe(true);
    },
  );

  it.each([
    "setup-ci",
    "setup-commit",
    "setup-skills",
    "setup-programmatic",
    "package-tauri",
    "research --force",
  ])("rejects unsupported specialist %j", (specialistCommand) => {
    expect(
      scannerProfileV1Schema.safeParse({ ...scannerProfile, specialistCommand }).success,
    ).toBe(false);
    expect(
      opportunityIdentityV1Schema.safeParse({ ...opportunity, specialistCommand }).success,
    ).toBe(false);
  });

  it("rejects unsupported contract versions", () => {
    expect(
      configurationFingerprintV1Schema.safeParse({ ...configurationFingerprint, version: 2 })
        .success,
    ).toBe(false);
  });
});

describe("canonical inventory", () => {
  it.each([
    { ...inventory, scanners: [inventory.scanners[1], inventory.scanners[0]] },
    { ...inventory, scanners: [scannerProfile, scannerProfile] },
    { ...inventory, entries: [inventory.entries[1], inventory.entries[0]] },
    { ...inventory, entries: [inventoryEntry, inventoryEntry] },
  ])("rejects duplicate or unsorted members", (value) => {
    expect(inventoryV1Schema.safeParse(value).success).toBe(false);
  });

  it("rejects oversized scanner and entry arrays", () => {
    const scanners = Array.from({ length: 65 }, (_, index) => ({
      version: 1,
      id: `scanner-${index.toString().padStart(2, "0")}`,
      specialistCommand: "setup-ci",
    }));
    const entries = Array.from({ length: 10_001 }, (_, index) => ({
      path: `files/${index.toString().padStart(5, "0")}.txt`,
      sha256: "d".repeat(64),
    }));

    expect(inventoryV1Schema.safeParse({ ...inventory, scanners }).success).toBe(false);
    expect(inventoryV1Schema.safeParse({ ...inventory, entries }).success).toBe(false);
  });
});

describe("bounded structured evidence", () => {
  it.each([
    { ...evidenceItem, source: "a".repeat(101) },
    { ...evidenceItem, code: "a".repeat(101) },
    { ...evidenceItem, message: "a".repeat(4_001) },
    { ...evidenceItem, severity: "critical" },
  ])("rejects invalid evidence fields", (value) => {
    expect(evidenceItemV1Schema.safeParse(value).success).toBe(false);
  });

  it("rejects oversized evidence arrays", () => {
    expect(
      evidenceV1Schema.safeParse({ version: 1, items: Array(201).fill(evidenceItem) }).success,
    ).toBe(false);
  });

  it.each([
    { path: "src/index.ts", endLine: 2 },
    { path: "src/index.ts", startLine: 3, endLine: 2 },
    { path: "src/index.ts", startLine: 0 },
    { path: "src/index.ts", startLine: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid evidence line ranges", (location) => {
    expect(evidenceLocationV1Schema.safeParse(location).success).toBe(false);
  });
});

describe("opportunity lifecycle transitions", () => {
  const states = ["discovered", "queued", "running", "completed", "dismissed"] as const;
  const allowed = [
    ["discovered", "queued"],
    ["discovered", "dismissed"],
    ["queued", "discovered"],
    ["queued", "running"],
    ["queued", "dismissed"],
    ["running", "queued"],
    ["running", "completed"],
  ] as const;
  const allowedKeys = new Set(allowed.map(([from, to]) => `${from}->${to}`));
  const disallowed = states.flatMap((from) =>
    states.filter((to) => !allowedKeys.has(`${from}->${to}`)).map((to) => [from, to] as const),
  );

  it.each(allowed)("accepts %s -> %s", (from, to) => {
    expect(
      opportunityTransitionV1Schema.safeParse({ version: 1, opportunity, from, to }).success,
    ).toBe(true);
  });

  it.each(disallowed)("rejects %s -> %s", (from, to) => {
    expect(
      opportunityTransitionV1Schema.safeParse({ version: 1, opportunity, from, to }).success,
    ).toBe(false);
  });

  it.each([
    { version: 1, opportunity, state: "unknown" },
    { version: 1, opportunity, from: "unknown", to: "queued" },
    { version: 1, opportunity, from: "queued", to: "unknown" },
  ])("rejects invalid lifecycle states", (value) => {
    const schema = "state" in value ? opportunityLifecycleV1Schema : opportunityTransitionV1Schema;
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe("route and execution boundaries", () => {
  it("rejects a route/opportunity specialist mismatch", () => {
    expect(
      routeEnvelopeV1Schema.safeParse({ ...route, specialistCommand: "setup-sweep" }).success,
    ).toBe(false);
  });

  it.each(["succeeded", "failed", "cancelled", "blocked"])(
    "accepts execution status %s",
    (status) => {
      expect(executionResultV1Schema.safeParse({ ...executionResult, status }).success).toBe(true);
    },
  );

  it.each(["", "a".repeat(4_001)])("rejects bounded execution summary %j", (summary) => {
    expect(executionResultV1Schema.safeParse({ ...executionResult, summary }).success).toBe(false);
  });

  it("rejects unsupported execution statuses", () => {
    expect(
      executionResultV1Schema.safeParse({ ...executionResult, status: "unknown" }).success,
    ).toBe(false);
  });
});
