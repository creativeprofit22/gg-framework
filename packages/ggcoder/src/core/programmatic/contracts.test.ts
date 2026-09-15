import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseSkillFile } from "../skills.js";
import { SlashCommandRegistry } from "../slash-commands.js";
import {
  programmaticCommandVerificationStateSchema,
  directCommandSelectionV1Schema,
  directExecutionPolicyV1Schema,
  directExecutionSnapshotV1Schema,
  directCommandResultV1Schema,
  isProgrammaticReviewCurrent,
  type ProgrammaticApprovalContext,
  programmaticAssessmentInputV1Schema,
  programmaticAssessmentResultV1Schema,
  programmaticRecommendationV1Schema,
  programmaticCommandReferenceV1Schema,
  programmaticCommandSnapshotV1Schema,
  programmaticCommandAvailabilityV1Schema,
  programmaticMissingCapabilityV1Schema,
  programmaticCreationProposalV1Schema,
  programmaticVerificationV1Schema,
  programmaticExecutionSettingsV1Schema,
  programmaticExecutionReviewV1Schema,
  configurationFingerprintV1Schema,
  configurationSnapshotSchema,
  programmaticProfileEnvelopeV2Schema,
  discoveredOpportunityV1Schema,
  evidenceItemV1Schema,
  evidenceLocationV1Schema,
  evidenceV1Schema,
  executionResultV1Schema,
  inventoryEntryV1Schema,
  inventoryV1Schema,
  PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT,
  programmaticLifecycleRecordV1Schema,
  programmaticLifecycleStateV1Schema,
  programmaticProfileEnvelopeV1Schema,
  programmaticProfileV1Schema,
  programmaticScanSummaryV1Schema,
  opportunityDiscoveryResultV1Schema,
  opportunityIdentityV1Schema,
  opportunityLifecycleV1Schema,
  opportunityRouteV1Schema,
  opportunityTransitionV1Schema,
  repositoryRelativePathSchema,
  routeEnvelopeV1Schema,
  routableOpportunityRouteV1Schema,
  scannerProfileV1Schema,
} from "./contracts.js";

const configurationFingerprint = { version: 1, sha256: "a".repeat(64) };
const scannerProfile = {
  version: 1,
  id: "ci-scanner",
  specialistCommand: "research",
};
const programmaticProfile = { version: 1, scanners: [scannerProfile] };
const programmaticProfileEnvelope = {
  version: 1,
  configurationFingerprint,
  profile: programmaticProfile,
};
const inventoryEntry = { path: "package.json", sha256: "b".repeat(64) };

describe("independent command verification state", () => {
  it("preserves unknown/false/true loading without granting behavior or execution", () => {
    for (const loads of [undefined, false, true]) {
      const value = { ...(loads === undefined ? {} : { loads }), reviewedContent: "unavailable", behavior: "unavailable", executionApproved: false };
      expect(programmaticCommandVerificationStateSchema.parse(value)).toEqual(value);
      expect(programmaticCommandVerificationStateSchema.safeParse({ ...value, executionApproved: true }).success).toBe(false);
      expect(programmaticCommandVerificationStateSchema.safeParse({ ...value, behavior: "passed" }).success).toBe(false);
    }
  });
});

describe("direct reviewed execution contracts", () => {
  const selection = {
    version: 1, command: { version: 1, name: "custom-check", source: "project-custom", invocationKind: "prompt" },
    arguments: "input", outcome: "Check input", successCondition: "Input is checked",
    helpers: ["scripts/check.mjs"], prerequisites: ["package.json"], requiredTools: ["bash"],
    mode: "general-work", containment: "agent-session",
  };
  const policy = {
    version: 1, revision: 1, mode: "general-work", tools: ["bash", "read"], actionApprovalTools: ["bash"],
    containment: "agent-session", disclosure: "Not an OS sandbox", maxTurns: 30, deadlineMs: 600_000,
    provider: "fixture", model: "fixture", runtimeSha256: "a".repeat(64),
  };
  const file = { path: "scripts/check.mjs", sha256: "b".repeat(64), identitySha256: "c".repeat(64), bytes: 100 };
  const snapshot = {
    version: 1, selection, policy,
    command: { version: 1, command: selection.command, capabilityKind: "script-backed", ownerSha256: "d".repeat(64), bodySha256: "e".repeat(64), helpers: [{ path: file.path, sha256: file.sha256 }] },
    repositorySha256: "f".repeat(64), rawMarkdownSha256: "a".repeat(64), sourceIdentitySha256: "b".repeat(64),
    helpers: [file], prerequisites: [{ ...file, path: "package.json" }],
  };
  it("accepts an existing custom command without a creation receipt or Opportunity", () => {
    expect(directCommandSelectionV1Schema.parse(selection)).toEqual(selection);
    expect(directExecutionSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(scannerProfileV1Schema.safeParse({ ...scannerProfile, specialistCommand: "custom-check" }).success).toBe(false);
  });
  it.each([
    { approval: true }, { helpers: ["../escape"] }, { helpers: ["C:/escape"] },
    { helpers: ["scripts/a", "scripts/A"] }, { prerequisites: selection.helpers },
    { requiredTools: ["bash", "bash"] }, { mode: "unrestricted" }, { arguments: "x".repeat(4001) },
  ])("rejects invalid or caller-authorized selection %j", (change) => {
    expect(directCommandSelectionV1Schema.safeParse({ ...selection, ...change }).success).toBe(false);
  });
  it("binds every declaration and rejects unsupported or over-budget host envelopes", () => {
    for (const change of [
      { selection: { ...selection, containment: "os-confined" } },
      { selection: { ...selection, requiredTools: ["steroids"] } },
      { helpers: [{ ...file, sha256: "a".repeat(64) }] },
      { prerequisites: [] }, { helpers: [{ ...file, bytes: 128 * 1024 + 1 }] },
      { policy: { ...policy, mode: "read-only" } },
      { command: { ...snapshot.command, command: { ...selection.command, name: "other" } } },
    ]) expect(directExecutionSnapshotV1Schema.safeParse({ ...snapshot, ...change }).success).toBe(false);
    expect(directExecutionPolicyV1Schema.safeParse({ ...policy, actionApprovalTools: ["write"] }).success).toBe(false);
    expect(directExecutionPolicyV1Schema.safeParse({ ...policy, maxTurns: 31 }).success).toBe(false);
  });
  it("requires bounded content-specific results without certifying behavior", () => {
    const result = {
      version: 1, runId: "00000000-0000-4000-8000-000000000000", status: "completed", summary: "Finished",
      snapshot, executionSha256: "a".repeat(64), evidence: [], behavior: "unverified", limitations: ["Tool completion does not prove correctness."],
    };
    expect(directCommandResultV1Schema.parse(result)).toEqual(result);
    expect(directCommandResultV1Schema.safeParse({ ...result, behavior: "passed" }).success).toBe(false);
    expect(directCommandResultV1Schema.safeParse({ ...result, snapshot: undefined }).success).toBe(false);
    expect(directCommandResultV1Schema.safeParse({ ...result, limitations: [] }).success).toBe(false);
    expect(directCommandResultV1Schema.safeParse({ ...result, conversation: [] }).success).toBe(false);
  });
});

describe("independent stored setup envelope", () => {
  const snapshot = {
    policyRevision: 2,
    scannerProfileSchemaRevision: 1,
    exclusions: ["**/node_modules/**"],
    inputs: [inventoryEntry],
  };
  const envelope = {
    version: 2,
    configurationFingerprint,
    profile: programmaticProfile,
    configurationSnapshot: snapshot,
  };

  it("retains known v1 and accepts v2 without changing identity or profile wire versions", () => {
    expect(programmaticProfileEnvelopeV1Schema.parse(programmaticProfileEnvelope).version).toBe(1);
    expect(programmaticProfileEnvelopeV2Schema.parse(envelope).profile.version).toBe(1);
    expect(programmaticProfileEnvelopeV2Schema.safeParse({ ...envelope, version: 3 }).success).toBe(
      false,
    );
  });

  it.each([
    ["colon", ":"],
    ["NUL", "\0"],
    ["LF", "\n"],
    ["U+001F", "\u001f"],
    ["DEL", "\u007f"],
  ])("rejects %s in both snapshot exclusions and input paths", (_label, character) => {
    const unsafePath = `src/bad${character}name.json`;
    const exclusion = configurationSnapshotSchema.safeParse({
      ...snapshot,
      exclusions: [unsafePath],
    });
    const input = configurationSnapshotSchema.safeParse({
      ...snapshot,
      inputs: [{ ...inventoryEntry, path: unsafePath }],
    });
    expect(exclusion.success).toBe(false);
    expect(input.success).toBe(false);
    expect(exclusion.error?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: "unsafe exclusion path" })]),
    );
    expect(input.error?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: "unsafe configuration path" })]),
    );
  });

  it("accepts valid repository input paths and glob exclusions", () => {
    const valid = {
      ...snapshot,
      exclusions: ["**/node_modules/**", "dist/**", "src/generated"],
      inputs: [inventoryEntry, { ...inventoryEntry, path: "src/config/settings.json" }],
    };
    expect(configurationSnapshotSchema.parse(valid)).toEqual(valid);
  });

  it("rejects unsafe, duplicate, unsorted, invalid and oversized configuration snapshots", () => {
    for (const inputs of [
      [{ ...inventoryEntry, path: "../outside" }],
      [{ ...inventoryEntry, path: "C:/outside" }],
      [{ ...inventoryEntry, sha256: "invalid" }],
      [inventoryEntry, inventoryEntry],
      [{ ...inventoryEntry, path: "z.json" }, inventoryEntry],
      Array.from({ length: 10_001 }, (_, i) => ({
        ...inventoryEntry,
        path: `${String(i).padStart(5, "0")}.json`,
      })),
    ])
      expect(configurationSnapshotSchema.safeParse({ ...snapshot, inputs }).success).toBe(false);
    expect(
      configurationSnapshotSchema.safeParse({ ...snapshot, contents: "not retained" }).success,
    ).toBe(false);
    expect(
      configurationSnapshotSchema.safeParse({ ...snapshot, exclusions: ["b", "a"] }).success,
    ).toBe(false);
    expect(configurationSnapshotSchema.safeParse({ ...snapshot, policyRevision: 0 }).success).toBe(
      false,
    );
  });
});
const inventory = {
  version: 1,
  configurationFingerprint,
  scanners: [scannerProfile, { version: 1, id: "sweep-scanner", specialistCommand: "setup-sweep" }],
  entries: [inventoryEntry, { path: "src/index.ts", sha256: "c".repeat(64) }],
};
const evidenceLocation = { path: "src/index.ts", startLine: 10, endLine: 12 };
const evidenceItem = {
  basis: "observed",
  source: "ci-scanner",
  code: "missing-ci",
  severity: "warning",
  message: "No continuous integration workflow was found.",
  location: evidenceLocation,
};
const evidence = { version: 1, items: [evidenceItem] };
const opportunity = {
  version: 1,
  id: "d".repeat(64),
  detectorId: "ci-scanner",
  key: "missing-ci",
  path: "src/index.ts",
};
const discoveredOpportunity = {
  version: 1,
  identity: opportunity,
  representativeCase: "src/index.ts",
  repeatableTrigger: "A source tree exists without continuous integration.",
  inputPaths: ["package.json", "src/index.ts"],
  currentProcess: "Continuous integration is configured manually.",
  expectedOutput: "A repeatable continuous integration workflow.",
  verification: "Run the repository checks in continuous integration.",
  risks: ["A generated workflow could omit a repository-specific check."],
  confidence: "medium",
  mutationPaths: [".github/workflows/ci.yml"],
  evidence,
  route: { status: "routable", specialistCommand: "research" },
};
const discoveryResult = { version: 1, opportunities: [discoveredOpportunity] };
const lifecycle = { version: 1, opportunity, state: "discovered" };
const lifecycleRecord = {
  version: 1,
  opportunity: discoveredOpportunity,
  lifecycle,
  presence: "present",
};
const lifecycleState = {
  version: 1,
  configurationFingerprint,
  records: [lifecycleRecord],
};
const scanSummary = {
  new: 1,
  unchanged: 0,
  active: 1,
  completed: 0,
  dismissed: 0,
  disappeared: 0,
  failed: 0,
  unverified: 0,
};
const transition = { version: 1, opportunity, from: "discovered", to: "queued" };
const route = {
  version: 1,
  status: "routable",
  opportunityId: opportunity.id,
  configurationFingerprint,
  specialistCommand: "research",
  arguments: [
    { name: "detector-id", value: "ci-scanner" },
    { name: "representative-case", value: "src/index.ts" },
  ],
  evidencePaths: ["src/index.ts"],
  scopePaths: [".github/workflows/ci.yml", "package.json", "src/index.ts"],
  successCondition: discoveredOpportunity.verification,
  mutates: false,
  reason: discoveredOpportunity.expectedOutput,
  availability: {
    status: "available",
    source: "global-custom",
    portability: "machine-local",
    portabilityWarning: "Availability may differ on another machine.",
  },
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
    ["programmatic profile", programmaticProfileV1Schema, programmaticProfile],
    [
      "programmatic profile envelope",
      programmaticProfileEnvelopeV1Schema,
      programmaticProfileEnvelope,
    ],
    ["inventory entry", inventoryEntryV1Schema, inventoryEntry],
    ["inventory", inventoryV1Schema, inventory],
    ["evidence location", evidenceLocationV1Schema, evidenceLocation],
    ["evidence item", evidenceItemV1Schema, evidenceItem],
    ["evidence", evidenceV1Schema, evidence],
    ["opportunity identity", opportunityIdentityV1Schema, opportunity],
    ["opportunity route", opportunityRouteV1Schema, discoveredOpportunity.route],
    ["discovered opportunity", discoveredOpportunityV1Schema, discoveredOpportunity],
    ["discovery result", opportunityDiscoveryResultV1Schema, discoveryResult],
    ["opportunity lifecycle", opportunityLifecycleV1Schema, lifecycle],
    ["programmatic lifecycle record", programmaticLifecycleRecordV1Schema, lifecycleRecord],
    ["programmatic lifecycle state", programmaticLifecycleStateV1Schema, lifecycleState],
    ["programmatic scan summary", programmaticScanSummaryV1Schema, scanSummary],
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
    [programmaticProfileV1Schema, { ...programmaticProfile, path: "profile.json" }],
    [programmaticProfileEnvelopeV1Schema, { ...programmaticProfileEnvelope, unexpected: true }],
    [inventoryEntryV1Schema, { ...inventoryEntry, unexpected: true }],
    [inventoryV1Schema, { ...inventory, unexpected: true }],
    [evidenceLocationV1Schema, { ...evidenceLocation, unexpected: true }],
    [evidenceItemV1Schema, { ...evidenceItem, unexpected: true }],
    [evidenceV1Schema, { ...evidence, rawOutput: "unbounded output" }],
    [opportunityIdentityV1Schema, { ...opportunity, unexpected: true }],
    [opportunityRouteV1Schema, { ...discoveredOpportunity.route, command: "arbitrary" }],
    [discoveredOpportunityV1Schema, { ...discoveredOpportunity, prompt: "implement this" }],
    [
      discoveredOpportunityV1Schema,
      { ...discoveredOpportunity, implementationPrompt: "implement this" },
    ],
    [opportunityDiscoveryResultV1Schema, { ...discoveryResult, unexpected: true }],
    [opportunityLifecycleV1Schema, { ...lifecycle, unexpected: true }],
    [programmaticLifecycleRecordV1Schema, { ...lifecycleRecord, unexpected: true }],
    [programmaticLifecycleStateV1Schema, { ...lifecycleState, unexpected: true }],
    [programmaticScanSummaryV1Schema, { ...scanSummary, unexpected: true }],
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
        routableOpportunityRouteV1Schema.safeParse({ status: "routable", specialistCommand })
          .success,
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
    expect(scannerProfileV1Schema.safeParse({ ...scannerProfile, specialistCommand }).success).toBe(
      false,
    );
    expect(
      routableOpportunityRouteV1Schema.safeParse({ status: "routable", specialistCommand }).success,
    ).toBe(false);
  });

  it("rejects unsupported contract versions", () => {
    expect(
      configurationFingerprintV1Schema.safeParse({ ...configurationFingerprint, version: 2 })
        .success,
    ).toBe(false);
  });
  it("keeps persisted profiles versioned, sorted, unique, allowlisted, and fingerprint-bound", () => {
    const second = { ...scannerProfile, id: "sweep-scanner", specialistCommand: "setup-sweep" };
    expect(
      programmaticProfileV1Schema.safeParse({ version: 2, scanners: [scannerProfile] }).success,
    ).toBe(false);
    expect(
      programmaticProfileV1Schema.safeParse({ version: 1, scanners: [second, scannerProfile] })
        .success,
    ).toBe(false);
    expect(
      programmaticProfileV1Schema.safeParse({
        version: 1,
        scanners: [scannerProfile, scannerProfile],
      }).success,
    ).toBe(false);
    expect(
      programmaticProfileV1Schema.safeParse({
        version: 1,
        scanners: [{ ...scannerProfile, specialistCommand: "setup-programmatic" }],
      }).success,
    ).toBe(false);
    expect(programmaticProfileEnvelopeV1Schema.safeParse(programmaticProfile).success).toBe(false);
    expect(
      programmaticProfileEnvelopeV1Schema.safeParse({
        ...programmaticProfileEnvelope,
        configurationFingerprint: { ...configurationFingerprint, sha256: "invalid" },
      }).success,
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
    { ...evidenceItem, basis: undefined },
    { ...evidenceItem, basis: "reported" },
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

describe("discovered opportunity boundaries", () => {
  it.each([
    "representativeCase",
    "repeatableTrigger",
    "inputPaths",
    "currentProcess",
    "expectedOutput",
    "verification",
    "risks",
    "confidence",
    "mutationPaths",
    "evidence",
    "identity",
    "route",
  ])("requires %s", (field) => {
    const incomplete = { ...discoveredOpportunity } as Record<string, unknown>;
    delete incomplete[field];
    expect(discoveredOpportunityV1Schema.safeParse(incomplete).success).toBe(false);
  });

  it("keeps evidence bases distinct with bounded normalized paths", () => {
    for (const basis of ["observed", "inferred", "assumed"]) {
      expect(evidenceItemV1Schema.safeParse({ ...evidenceItem, basis }).success).toBe(true);
    }
    expect(
      evidenceItemV1Schema.safeParse({ ...evidenceItem, message: "a".repeat(4_001) }).success,
    ).toBe(false);
    for (const path of ["../src/index.ts", "/src/index.ts", "C:\\src\\index.ts"]) {
      expect(
        evidenceItemV1Schema.safeParse({
          ...evidenceItem,
          location: { path },
        }).success,
      ).toBe(false);
    }
  });

  it("requires at least one located observed item", () => {
    expect(
      discoveredOpportunityV1Schema.safeParse({
        ...discoveredOpportunity,
        evidence: { version: 1, items: [{ ...evidenceItem, basis: "inferred" }] },
      }).success,
    ).toBe(false);
  });

  it("enforces exact route discrimination", () => {
    expect(opportunityRouteV1Schema.safeParse({ status: "unroutable" }).success).toBe(true);
    expect(
      opportunityRouteV1Schema.safeParse({
        status: "unroutable",
        specialistCommand: "research",
      }).success,
    ).toBe(false);
    expect(opportunityRouteV1Schema.safeParse({ status: "routable" }).success).toBe(false);
  });

  it("requires unique opportunity IDs in ascending order", () => {
    const later = {
      ...discoveredOpportunity,
      identity: { ...opportunity, id: "e".repeat(64) },
    };
    expect(
      opportunityDiscoveryResultV1Schema.safeParse({
        version: 1,
        opportunities: [discoveredOpportunity, later],
      }).success,
    ).toBe(true);
    for (const opportunities of [
      [later, discoveredOpportunity],
      [discoveredOpportunity, discoveredOpportunity],
    ]) {
      expect(
        opportunityDiscoveryResultV1Schema.safeParse({ version: 1, opportunities }).success,
      ).toBe(false);
    }
  });
});

describe("aggregate lifecycle contracts", () => {
  it("requires exact matching opportunity and lifecycle identities", () => {
    expect(
      programmaticLifecycleRecordV1Schema.safeParse({
        ...lifecycleRecord,
        lifecycle: {
          ...lifecycle,
          opportunity: { ...opportunity, detectorId: "other-scanner" },
        },
      }).success,
    ).toBe(false);
  });

  it("requires unique lifecycle IDs in ascending order", () => {
    const laterOpportunity = {
      ...discoveredOpportunity,
      identity: { ...opportunity, id: "e".repeat(64) },
    };
    const later = {
      ...lifecycleRecord,
      opportunity: laterOpportunity,
      lifecycle: { ...lifecycle, opportunity: laterOpportunity.identity },
    };
    expect(
      programmaticLifecycleStateV1Schema.safeParse({
        ...lifecycleState,
        records: [lifecycleRecord, later],
      }).success,
    ).toBe(true);
    expect(
      programmaticLifecycleStateV1Schema.safeParse({
        ...lifecycleState,
        records: [later, lifecycleRecord],
      }).success,
    ).toBe(false);
    expect(
      programmaticLifecycleStateV1Schema.safeParse({
        ...lifecycleState,
        records: [lifecycleRecord, lifecycleRecord],
      }).success,
    ).toBe(false);
  });

  it("caps lifecycle history at 1,000 records", () => {
    const records = Array.from({ length: PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT + 1 }, (_, index) => {
      const id = index.toString(16).padStart(64, "0");
      const identity = { ...opportunity, id };
      return {
        ...lifecycleRecord,
        opportunity: { ...discoveredOpportunity, identity },
        lifecycle: { ...lifecycle, opportunity: identity },
      };
    });
    expect(
      programmaticLifecycleStateV1Schema.safeParse({ ...lifecycleState, records }).success,
    ).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid scan summary count %j",
    (count) => {
      expect(
        programmaticScanSummaryV1Schema.safeParse({ ...scanSummary, failed: count }).success,
      ).toBe(false);
    },
  );
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
  it("rejects embedding a whole opportunity in an execution route", () => {
    expect(
      routeEnvelopeV1Schema.safeParse({ ...route, opportunity: discoveredOpportunity }).success,
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

describe("programmatic extension contracts", () => {
  const digest = "c".repeat(64);
  const command = {
    version: 1,
    name: "check-project",
    source: "project-custom",
    invocationKind: "prompt",
  };
  const snapshot = {
    version: 1,
    command,
    capabilityKind: "prompt-only",
    ownerSha256: digest,
    bodySha256: digest,
    helpers: [],
  };
  const helper = { path: "scripts/check.ts", sha256: digest };
  const script = { ...snapshot, capabilityKind: "script-backed", helpers: [helper] };
  const app = {
    ...snapshot,
    capabilityKind: "app-backed",
    command: { ...command, source: "built-in", invocationKind: "workspace-action" },
  };
  const requirement = {
    version: 1,
    desiredOutcome: "Check project",
    capabilityKind: "prompt-only",
    inputs: ["Project"],
    outputs: ["Report"],
    prerequisites: ["Readable project"],
    risks: ["Incomplete coverage"],
    verificationExpectations: ["Fixture assertions"],
  };
  const evidence = {
    version: 1,
    items: [
      {
        basis: "observed",
        source: "fixture",
        code: "assertion",
        severity: "info",
        message: "Assertion passed",
      },
    ],
  };
  const recommendation = {
    version: 1,
    kind: "advisory",
    outcome: "Check project",
    rationale: "Reuse existing work",
    uncertainty: "Not yet executed",
    evidence,
    choice: { kind: "manual", steps: ["Inspect project"] },
  };
  const settings = {
    version: 1,
    policyId: "reviewed-project",
    policyRevision: 1,
    provider: "fixture",
    model: "fixture-model",
    maxTurns: 10,
    deadlineMs: 60_000,
    capabilityProfile: "reviewed-mutation",
  };
  const review = {
    version: 1,
    purpose: "execution",
    proposalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    snapshot,
    arguments: "",
    configurationFingerprint,
    successCondition: "Report checked",
    settings,
  };
  const creation = {
    version: 1,
    purpose: "creation",
    proposalId: review.proposalId,
    scope: "project",
    requirement,
    snapshot,
    commandPath: ".gg/commands/check-project.md",
    files: [
      {
        path: ".gg/commands/check-project.md",
        proposedSha256: digest,
        prior: { status: "absent" },
      },
    ],
  };
  const approval: ProgrammaticApprovalContext = {
    pendingProposalId: review.proposalId,
    purpose: "execution",
    decision: "accepted",
  };
  const caseRecord = {
    category: "loads",
    scenario: "normal",
    method: "deterministic",
    input: "Fixture project",
    result: "passed",
    evidence,
  };
  const verification = {
    version: 1,
    snapshot,
    result: "unavailable",
    provider: "fixture",
    model: "fixture-model",
    environment: "Temporary fixture",
    limits: ["Not production"],
    cases: [caseRecord],
  };

  it("preserves raw focus limits and permitted characters at the domain boundary", () => {
    for (const focus of ["x".repeat(4_000), "😀".repeat(2_000), "检查 café\r\nnext\tstep"]) {
      expect(programmaticAssessmentInputV1Schema.parse({ version: 1, focus }).focus).toBe(focus);
    }
    for (const focus of [" " + "x".repeat(4_000), "😀".repeat(2_000) + "x"]) {
      expect(programmaticAssessmentInputV1Schema.safeParse({ version: 1, focus }).success).toBe(false);
    }
    for (let code = 0; code <= 159; code++) {
      const focus = `a${String.fromCharCode(code)}b`;
      const allowed = (code >= 32 && code < 127) || [9, 10, 13].includes(code);
      expect(programmaticAssessmentInputV1Schema.safeParse({ version: 1, focus }).success).toBe(allowed);
    }
  });

  it("accepts general/focused input without changing scanner identities", () => {
    expect(programmaticAssessmentInputV1Schema.parse({ version: 1 })).toEqual({ version: 1 });
    expect(
      programmaticAssessmentInputV1Schema.parse({ version: 1, focus: "Check\n tests\t please" })
        .focus,
    ).toBeDefined();
    for (const focus of ["", "   ", "x".repeat(4_001), "x\0", "x\u007f", "x\u0085", 42]) {
      expect(programmaticAssessmentInputV1Schema.safeParse({ version: 1, focus }).success).toBe(
        false,
      );
    }
    expect(
      programmaticAssessmentInputV1Schema.safeParse({ version: 1, approved: true }).success,
    ).toBe(false);
  });

  it("accepts every advisory choice, source, availability and capability kind", () => {
    for (const source of ["built-in", "project-custom", "global-custom"]) {
      expect(programmaticCommandReferenceV1Schema.safeParse({ ...command, source }).success).toBe(
        true,
      );
    }
    for (const content of [snapshot, script, app]) {
      expect(programmaticCommandSnapshotV1Schema.safeParse(content).success).toBe(true);
      const availability = { status: "available", snapshot: content };
      expect(programmaticCommandAvailabilityV1Schema.safeParse(availability).success).toBe(true);
      expect(
        programmaticRecommendationV1Schema.safeParse({
          ...recommendation,
          choice: { kind: "reuse-command", availability },
        }).success,
      ).toBe(true);
      const proposal = { ...requirement, capabilityKind: content.capabilityKind };
      expect(programmaticMissingCapabilityV1Schema.safeParse(proposal).success).toBe(true);
      expect(
        programmaticRecommendationV1Schema.safeParse({
          ...recommendation,
          choice: { kind: "missing-capability", proposal },
        }).success,
      ).toBe(true);
    }
    expect(
      programmaticCommandAvailabilityV1Schema.safeParse({
        status: "unavailable",
        command,
        reason: "Not installed",
      }).success,
    ).toBe(true);
    expect(programmaticRecommendationV1Schema.safeParse(recommendation).success).toBe(true);
    const result = {
      version: 1,
      kind: "advisory",
      recommendations: [recommendation],
      coverage: { status: "limited", scope: "Local commands", reason: "Catalog truncated" },
    };
    expect(programmaticAssessmentResultV1Schema.safeParse(result).success).toBe(true);
    expect(
      programmaticAssessmentResultV1Schema.safeParse({
        ...result,
        coverage: { status: "complete", scope: "Current bounded catalog" },
      }).success,
    ).toBe(true);
    expect(
      programmaticAssessmentResultV1Schema.safeParse({
        ...result,
        recommendations: Array(51).fill(recommendation),
      }).success,
    ).toBe(false);
    expect(
      programmaticAssessmentResultV1Schema.safeParse({
        ...result,
        coverage: { status: "limited", scope: "Local" },
      }).success,
    ).toBe(false);
    expect(discoveredOpportunityV1Schema.safeParse(recommendation).success).toBe(false);
    expect(opportunityDiscoveryResultV1Schema.safeParse(result).success).toBe(false);
    expect(programmaticLifecycleStateV1Schema.safeParse(result).success).toBe(false);
  });

  it.each(["check_project", "CheckProject", "check.project", "check-project", "x".repeat(100)])(
    "preserves loaded command identity %s through slash parsing and reuse records",
    (name) => {
      const loaded = parseSkillFile(`---\nname: ${name}\n---\nCheck the project.`, "project");
      expect(loaded.name).toBe(name);
      const parsed = new SlashCommandRegistry().parse(`/${loaded.name} project focus`);
      expect(parsed).toEqual({ name, args: "project focus" });
      for (const source of ["project-custom", "global-custom"]) {
        const reference = { ...command, name: parsed!.name, source };
        expect(programmaticCommandReferenceV1Schema.parse(reference)).toEqual(reference);
        for (const availability of [
          { status: "available", snapshot: { ...snapshot, command: reference } },
          { status: "unavailable", command: reference, reason: "Not executable" },
        ]) {
          expect(programmaticCommandAvailabilityV1Schema.parse(availability)).toEqual(availability);
          const reuse = {
            ...recommendation,
            choice: { kind: "reuse-command", availability },
          };
          expect(programmaticRecommendationV1Schema.parse(reuse)).toEqual(reuse);
        }
      }
      expect(scannerProfileV1Schema.safeParse({ ...scannerProfile, specialistCommand: name }).success)
        .toBe(false);
    },
  );

  it("rejects ambiguous identities, helper dependencies, unsafe paths and forged authority", () => {
    for (const name of [
      "", "/check", "check/part", "check\\part", "check now", " check", "check ",
      "check\targ", "check\n", "check\r", "check\0", "check\u007f", "check\u0085",
      "check;run", "check|run", "check&run", "$(check)", "`check`", "check>out",
      "check<in", "check\"arg", "check'arg", "check:run", "check%PATH%", "check*",
      "-check", "_check", ".check", "..", "chéck", "x".repeat(101),
    ]) {
      expect(programmaticCommandReferenceV1Schema.safeParse({ ...command, name }).success).toBe(
        false,
      );
    }
    for (const content of [
      { ...snapshot, helpers: [helper] },
      { ...script, helpers: [] },
      { ...script, helpers: [helper, helper] },
      { ...script, helpers: [{ ...helper, path: "scripts/Check.ts" }, helper] },
      { ...script, helpers: [{ ...helper, path: "z.ts" }, helper] },
      { ...script, helpers: Array(33).fill(helper) },
      { ...snapshot, bodySha256: "invalid" },
      { ...snapshot, approved: true },
      { ...snapshot, command: { ...command, source: "unknown" } },
      { ...snapshot, command: { ...command, invocationKind: "workspace-action" } },
    ])
      expect(programmaticCommandSnapshotV1Schema.safeParse(content).success).toBe(false);
    for (const path of ["../escape", "/tmp/x", "C:/x", "a\\b", "a:b", "a\n", "x".repeat(501)]) {
      expect(
        programmaticCommandSnapshotV1Schema.safeParse({ ...script, helpers: [{ ...helper, path }] })
          .success,
      ).toBe(false);
    }
    expect(
      programmaticRecommendationV1Schema.safeParse({
        ...recommendation,
        choice: { ...recommendation.choice, command },
      }).success,
    ).toBe(false);
    expect(
      programmaticRecommendationV1Schema.safeParse({
        ...recommendation,
        evidence: { version: 1, items: Array(51).fill(evidence.items[0]) },
      }).success,
    ).toBe(false);
    expect(
      programmaticRecommendationV1Schema.safeParse({
        ...recommendation,
        outcome: "x".repeat(4_001),
      }).success,
    ).toBe(false);
  });

  it("bounds external provenance and rejects credential URLs and invalid ranges", () => {
    const reference = {
      kind: "external-reference",
      basis: "observed",
      inspectedUrl: "https://example.com/repo",
      revision: "abc123",
      location: { path: "src/check.ts", startLine: 1, endLine: 3 },
      claim: "Inspected assertion",
    };
    const withReference = (item: unknown) => ({
      ...recommendation,
      evidence: { version: 1, items: [item] },
    });
    expect(programmaticRecommendationV1Schema.safeParse(withReference(reference)).success).toBe(
      true,
    );
    for (const inspectedUrl of [
      "file:///tmp/x",
      "https://user:password@example.com",
      "https://example.com?token=value",
      "https://example.com/#secret",
      "not a URL",
    ]) {
      expect(
        programmaticRecommendationV1Schema.safeParse(withReference({ ...reference, inspectedUrl }))
          .success,
      ).toBe(false);
    }
    for (const location of [
      { path: "/private/x" },
      { path: "src/x", endLine: 3 },
      { path: "src/x", startLine: 4, endLine: 2 },
    ]) {
      expect(
        programmaticRecommendationV1Schema.safeParse(withReference({ ...reference, location }))
          .success,
      ).toBe(false);
    }
    expect(
      programmaticRecommendationV1Schema.safeParse(
        withReference({ ...reference, body: "fetched source" }),
      ).success,
    ).toBe(false);
  });

  it("binds project-only creation to every exact proposed and prior file", () => {
    expect(programmaticCreationProposalV1Schema.safeParse(creation).success).toBe(true);
    const scriptCreation = {
      ...creation,
      requirement: { ...requirement, capabilityKind: "script-backed" },
      snapshot: script,
      files: [
        ...creation.files,
        {
          path: helper.path,
          proposedSha256: helper.sha256,
          prior: { status: "present", sha256: digest },
        },
      ],
    };
    expect(programmaticCreationProposalV1Schema.safeParse(scriptCreation).success).toBe(true);
    const frontmatterEdit = {
      ...creation,
      files: [{ ...creation.files[0], proposedSha256: "d".repeat(64) }],
    };
    expect(programmaticCreationProposalV1Schema.safeParse(frontmatterEdit).success).toBe(true);
    expect(isProgrammaticReviewCurrent(creation, frontmatterEdit, "creation", {
      ...approval, purpose: "creation",
    })).toBe(false);
    for (const value of [
      {
        ...creation,
        commandPath: "src/command.md",
        files: [{ ...creation.files[0], path: "src/command.md" }],
      },
      { ...creation, scope: "global" },
      { ...creation, snapshot: { ...snapshot, command: { ...command, source: "global-custom" } } },
      { ...creation, files: [] },
      { ...creation, files: [...creation.files, ...creation.files] },
      { ...creation, files: [{ ...creation.files[0], path: ".gg/commands/wrong.md" }] },
      { ...scriptCreation, files: [...creation.files, { ...scriptCreation.files[1], proposedSha256: "d".repeat(64) }] },
      { ...creation, files: [{ ...creation.files[0], prior: {} }] },
      { ...creation, snapshot: app },
      { ...scriptCreation, files: creation.files },
    ])
      expect(programmaticCreationProposalV1Schema.safeParse(value).success).toBe(false);
    expect(
      isProgrammaticReviewCurrent(creation, creation, "creation", {
        ...approval,
        purpose: "creation",
      }),
    ).toBe(true);
    expect(
      isProgrammaticReviewCurrent(
        creation,
        {
          ...creation,
          files: [{ ...creation.files[0], prior: { status: "present", sha256: digest } }],
        },
        "creation",
        { ...approval, purpose: "creation" },
      ),
    ).toBe(false);
    expect(isProgrammaticReviewCurrent(creation, creation, "execution", approval)).toBe(false);
  });

  it("requires behavior beyond loading and deterministic script error/side-effect coverage", () => {
    expect(programmaticVerificationV1Schema.safeParse(verification).success).toBe(true);
    expect(
      programmaticVerificationV1Schema.safeParse({ ...verification, result: "failed" }).success,
    ).toBe(true);
    expect(
      programmaticVerificationV1Schema.safeParse({ ...verification, result: "passed" }).success,
    ).toBe(false);
    const behaviorCases = ["normal", "incomplete", "out-of-scope"].map((scenario) => ({
      ...caseRecord,
      category: "behavior",
      scenario,
    }));
    const passed = { ...verification, result: "passed", cases: [caseRecord, ...behaviorCases] };
    expect(programmaticVerificationV1Schema.safeParse(passed).success).toBe(true);
    expect(
      programmaticVerificationV1Schema.safeParse({ ...passed, snapshot: script }).success,
    ).toBe(false);
    const scriptPassed = {
      ...passed,
      snapshot: script,
      cases: [
        ...passed.cases,
        ...behaviorCases.map((item) => ({ ...item, category: "side-effects" })),
      ],
    };
    expect(programmaticVerificationV1Schema.safeParse(scriptPassed).success).toBe(true);
    expect(
      programmaticVerificationV1Schema.safeParse({
        ...passed,
        cases: passed.cases.map((item) => ({ ...item, method: "model-judgment" })),
      }).success,
    ).toBe(false);
    expect(
      programmaticVerificationV1Schema.safeParse({
        ...passed,
        cases: [...passed.cases, { ...caseRecord, result: "failed" }],
      }).success,
    ).toBe(false);
    expect(programmaticVerificationV1Schema.safeParse({ ...passed, snapshot: app }).success).toBe(
      false,
    );
  });

  it("accepts bounded host settings but rejects unsupported grants and limits", () => {
    expect(programmaticExecutionSettingsV1Schema.safeParse(settings).success).toBe(true);
    expect(programmaticExecutionReviewV1Schema.safeParse(review).success).toBe(true);
    for (const maxTurns of [0, -1, 1.5, Infinity, NaN, 1_001]) {
      expect(
        programmaticExecutionSettingsV1Schema.safeParse({ ...settings, maxTurns }).success,
      ).toBe(false);
    }
    for (const deadlineMs of [0, Infinity, 86_400_001]) {
      expect(
        programmaticExecutionSettingsV1Schema.safeParse({ ...settings, deadlineMs }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { tools: ["bash"] },
      { apiKey: "forged" },
      { mcpServers: ["ambient"] },
      { capabilityProfile: "anything" },
    ]) {
      expect(
        programmaticExecutionSettingsV1Schema.safeParse({ ...settings, ...invalid }).success,
      ).toBe(false);
    }
    expect(
      programmaticExecutionReviewV1Schema.safeParse({ ...review, snapshot: app }).success,
    ).toBe(false);
    expect(
      programmaticExecutionReviewV1Schema.safeParse({ ...review, arguments: "x".repeat(4_001) })
        .success,
    ).toBe(false);
    expect(
      programmaticExecutionReviewV1Schema.safeParse({
        ...review,
        snapshot: script,
        settings: { ...settings, capabilityProfile: "research-read-only" },
      }).success,
    ).toBe(false);
  });

  it("fails closed on missing/denied/wrong-purpose approval and every reviewed field drift", () => {
    expect(isProgrammaticReviewCurrent(review, review, "execution", approval)).toBe(true);
    for (const context of [
      undefined,
      { ...approval, decision: undefined },
      { ...approval, decision: "rejected" as const },
      { ...approval, purpose: "creation" as const },
      { ...approval, pendingProposalId: "other" },
    ]) {
      expect(isProgrammaticReviewCurrent(review, review, "execution", context)).toBe(false);
    }
    const changed = [
      { arguments: "Other instructions" },
      { successCondition: "Different outcome" },
      { configurationFingerprint: { version: 1, sha256: digest } },
      { snapshot: { ...snapshot, bodySha256: "d".repeat(64) } },
      { snapshot: { ...snapshot, ownerSha256: "d".repeat(64) } },
      { snapshot: { ...snapshot, command: { ...command, source: "global-custom" } } },
      { snapshot: { ...snapshot, command: { ...command, name: "other" } } },
      ...Object.entries({
        policyId: "another-policy",
        policyRevision: 2,
        provider: "other",
        model: "other",
        maxTurns: 11,
        deadlineMs: 61_000,
        capabilityProfile: "research-read-only",
      }).map(([key, value]) => ({ settings: { ...settings, [key]: value } })),
      { proposalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { approved: true },
    ];
    for (const change of changed)
      expect(
        isProgrammaticReviewCurrent(review, { ...review, ...change }, "execution", approval),
      ).toBe(false);
    const scriptReview = { ...review, snapshot: script };
    expect(isProgrammaticReviewCurrent(scriptReview, scriptReview, "execution", approval)).toBe(
      true,
    );
    expect(
      isProgrammaticReviewCurrent(
        scriptReview,
        {
          ...scriptReview,
          snapshot: { ...script, helpers: [{ ...helper, sha256: "d".repeat(64) }] },
        },
        "execution",
        approval,
      ),
    ).toBe(false);
    // Parsing order, not incoming object property order, determines equality.
    expect(
      isProgrammaticReviewCurrent(
        review,
        Object.fromEntries(Object.entries(review).reverse()),
        "execution",
        approval,
      ),
    ).toBe(true);
  });
});

describe("Phase 1 structural bloat audit", () => {
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const subject = "packages/ggcoder/src/core/programmatic/contracts.ts";
  const git = (args: string[]) =>
    execFileSync("git", ["--no-pager", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
    });
  const read = (name: string) => {
    const absolute = realpathSync(path.resolve(root, name));
    const relative = path.relative(realpathSync(root), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Outside workspace");
    if (statSync(absolute).size > 2 * 1024 * 1024) throw new Error("Audit source exceeds 2 MiB");
    return readFileSync(absolute, "utf8");
  };
  const parse = (name: string, text: string) =>
    ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const isAuditGroup = (node: ts.Node) =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.arguments.some(
      (argument) =>
        ts.isStringLiteral(argument) && argument.text === "Phase 1 structural bloat audit",
    );
  const referencedOutsideAudit = (
    source: ts.SourceFile,
    binding: ts.Node,
    checker: ts.TypeChecker,
  ) => {
    const symbol = checker.getSymbolAtLocation(binding);
    if (!symbol) return false;
    let referenced = false;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) referenced = true;
      ts.forEachChild(node, visit);
    };
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !isAuditGroup(statement)) visit(statement);
    }
    return referenced;
  };
  const inferredSchema = (node: ts.TypeAliasDeclaration) => {
    const type = node.type;
    return ts.isTypeReferenceNode(type) &&
      ts.isQualifiedName(type.typeName) &&
      type.typeName.left.getText() === "z" &&
      type.typeName.right.text === "infer" &&
      type.typeArguments?.length === 1 &&
      ts.isTypeQueryNode(type.typeArguments[0]!)
      ? type.typeArguments[0]!.exprName.getText()
      : undefined;
  };
  const surfaceIssues = (source: ts.SourceFile) =>
    source.statements.flatMap((node): string[] => {
      if (ts.isImportDeclaration(node)) {
        return ts.isStringLiteral(node.moduleSpecifier) &&
          // Focus rules are shared with the browser, not copied into the domain.
          ["node:path", "zod", "@kenkaiiii/gg-core/slash-command-contract"].includes(node.moduleSpecifier.text)
          ? []
          : ["disallowed import"];
      }
      if (ts.isTypeAliasDeclaration(node)) return inferredSchema(node) ? [] : [node.name.text];
      if (ts.isVariableStatement(node)) {
        if (!(node.declarationList.flags & ts.NodeFlags.Const)) return ["mutable binding"];
        return node.declarationList.declarations.flatMap((declaration) =>
          declaration.initializer &&
          ts.isArrowFunction(declaration.initializer) &&
          !["boundedString", "boundedStringArray"].includes(declaration.name.getText(source))
            ? ["unreviewed helper"]
            : [],
        );
      }
      if (ts.isFunctionDeclaration(node)) {
        return node.name &&
          [
            "isStrictlyAscending",
            "isSafeConfigurationSnapshotPath",
            "isProgrammaticReviewCurrent",
          ].includes(node.name.text)
          ? []
          : ["unreviewed helper"];
      }
      if (ts.isInterfaceDeclaration(node) && node.name.text === "ProgrammaticApprovalContext")
        return [];
      return [ts.SyntaxKind[node.kind]];
    });
  const duplicateDeclarations = (source: ts.SourceFile, canonicalNames: Set<string>) =>
    source.statements
      .filter((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      .filter((node) => canonicalNames.has(node.name.text))
      .map((node) => node.name.text);
  const variants = (names: string[]) =>
    names.filter((name) =>
      /(?:^|\/)contracts(?:[._ -](?:fix(?:ed)?|v\d+|copy|backup|old)|\s*\(\d+\))/i.test(name),
    );
  const unused = (
    names: string[],
    used: Set<string>,
    fixtures: Set<string>,
    retained: Set<string>,
  ) => names.filter((name) => !used.has(name) && !(fixtures.has(name) && retained.has(name)));

  it("detects unused exports, competing declarations, variants, and disallowed imports in memory", () => {
    expect(
      unused(
        ["Live", "Dead", "Required"],
        new Set(["Live"]),
        new Set(["Required"]),
        new Set(["Required"]),
      ),
    ).toEqual(["Dead"]);
    expect(unused(["Required"], new Set(), new Set(), new Set(["Required"]))).toEqual(["Required"]);
    expect(
      duplicateDeclarations(
        parse("consumer.ts", "interface InventoryV1 { entries: string[] }"),
        new Set(["InventoryV1"]),
      ),
    ).toEqual(["InventoryV1"]);
    expect(
      variants([
        "contracts.ts",
        "contracts.test.ts",
        "contracts_fix.ts",
        "contracts.v2.ts",
        "contracts copy.ts",
        "contracts (1).ts",
        "routes.ts",
      ]),
    ).toEqual(["contracts_fix.ts", "contracts.v2.ts", "contracts copy.ts", "contracts (1).ts"]);
    expect(
      surfaceIssues(
        parse("contracts.ts", 'import fs from "node:fs"; export interface InventoryV1 {}'),
      ),
    ).toEqual(["disallowed import", "InterfaceDeclaration"]);
    expect(
      surfaceIssues(
        parse(
          "contracts.ts",
          'import { z } from "zod"; export type InventoryV1 = { entries: string[] };',
        ),
      ),
    ).toEqual(["InventoryV1"]);
    expect(surfaceIssues(parse("contracts.ts", "const execute = () => 1;"))).toEqual([
      "unreviewed helper",
    ]);
  });

  it("resolves consumers, checks canonical schema types, and reports lookalikes for manual comparison", () => {
    const config = ts.readConfigFile(
      path.join(root, "packages/ggcoder/tsconfig.json"),
      ts.sys.readFile,
    );
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      path.join(root, "packages/ggcoder"),
    );
    expect(parsed.errors).toEqual([]);
    const options = { ...parsed.options, noEmit: true };
    const resolutionCache = ts.createModuleResolutionCache(
      root,
      (name) => (ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase()),
      options,
    );
    const sourceNames = git([
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "packages",
      "gg-app/src",
    ])
      .split("\0")
      .filter((name) => /\/src\/.*\.(?:ts|tsx)$/.test(name) && !name.includes("/node_modules/"));
    expect(variants(sourceNames)).toEqual([]);
    const absoluteSubject = path.resolve(root, subject);
    const consumers = [...new Set(sourceNames)].filter((name) => {
      if (name === subject) return false;
      return ts.preProcessFile(read(name)).importedFiles.some(({ fileName }) => {
        const resolved = ts.resolveModuleName(
          fileName,
          path.resolve(root, name),
          options,
          ts.sys,
          resolutionCache,
        ).resolvedModule;
        return resolved && path.resolve(resolved.resolvedFileName) === absoluteSubject;
      });
    });
    const program = ts.createProgram(
      [absoluteSubject, ...consumers.map((name) => path.resolve(root, name))],
      options,
    );
    const source = program.getSourceFile(absoluteSubject)!;
    const checker = program.getTypeChecker();
    // Only contract semantics and consumer syntax are in scope, not consumer dependency typechecking.
    const diagnostics = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(source),
      ...[subject, ...consumers].flatMap((name) =>
        program.getSyntacticDiagnostics(program.getSourceFile(path.resolve(root, name))!),
      ),
    ];
    expect(
      diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")),
    ).toEqual([]);
    expect(surfaceIssues(source)).toEqual([]);
    const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
    const canonicalNames = new Set(exports.map((symbol) => symbol.name));
    for (const node of source.statements.filter(ts.isTypeAliasDeclaration)) {
      const schema = inferredSchema(node);
      expect(
        source.statements.some(
          (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
              (declaration) => declaration.name.getText(source) === schema,
            ),
        ),
        node.name.text,
      ).toBe(true);
    }
    const used = new Set<string>();
    const fixtureUses = new Set<string>();
    const lookalikes: string[] = [];
    for (const name of consumers) {
      // Inspect current fixtures with symbol identity; audit-only references do not count.
      const consumer = program.getSourceFile(path.resolve(root, name))!;
      const destination = /\.(?:test|spec)\.tsx?$/.test(name) ? fixtureUses : used;
      for (const node of consumer.statements) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const resolved = ts.resolveModuleName(
            node.moduleSpecifier.text,
            path.resolve(root, name),
            options,
            ts.sys,
            resolutionCache,
          ).resolvedModule;
          if (!resolved || path.resolve(resolved.resolvedFileName) !== absoluteSubject) continue;
          const bindings = ts.isImportDeclaration(node)
            ? node.importClause?.namedBindings
            : node.exportClause;
          // Fail closed on a new barrel/namespace shape until its actual uses are reviewed.
          expect(
            bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)),
            name,
          ).toBe(true);
          if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
            for (const binding of bindings.elements) {
              const exportedName = (binding.propertyName ?? binding.name).text;
              expect(canonicalNames.has(exportedName), `${name}: ${exportedName}`).toBe(true);
              const symbol = checker.getSymbolAtLocation(binding.name);
              expect(symbol, `${name}: ${exportedName}`).toBeDefined();
              if (symbol && symbol.flags & ts.SymbolFlags.Alias)
                expect(exports).toContain(checker.getAliasedSymbol(symbol));
              if (
                ts.isExportDeclaration(node) ||
                referencedOutsideAudit(consumer, binding.name, checker)
              )
                destination.add(exportedName);
            }
          }
        }
      }
      expect(duplicateDeclarations(consumer, canonicalNames), name).toEqual([]);
      if (destination === used) {
        for (const node of consumer.statements) {
          if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
            lookalikes.push(
              `${name}:${consumer.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.getText(consumer)}`,
            );
        }
      }
    }
    // Exact public-schema requirements justify fixture-only surfaces, not speculative type aliases.
    const requiredFixtures = {
      ProgrammaticApprovalContext: "host-only pending decision, not model data",
      isProgrammaticReviewCurrent: "pure content/settings and purpose freshness check",
      programmaticAssessmentInputV1Schema: "optional non-authorizing focus",
      programmaticAssessmentResultV1Schema: "bounded advice and explicit coverage",
      programmaticRecommendationV1Schema: "advisory choices separate from discovery",
      programmaticCommandReferenceV1Schema: "source-aware advisory identity",
      programmaticCommandSnapshotV1Schema: "body/helper content identity",
      programmaticCommandAvailabilityV1Schema: "availability without permission",
      programmaticMissingCapabilityV1Schema: "prompt/script/app requirements",
      programmaticCreationProposalV1Schema: "project-only exact content and prior versions",
      programmaticVerificationV1Schema: "content-specific deterministic evidence categories",
      programmaticExecutionSettingsV1Schema: "bounded host policy settings",
      programmaticExecutionReviewV1Schema: "separate execution review snapshot",
      repositoryRelativePathSchema: "normalized inventory/evidence/route path boundary",
      scannerProfileV1Schema: "versioned scanner ID and specialist allowlist",
      inventoryEntryV1Schema: "inventory path and content fingerprint",
      evidenceLocationV1Schema: "bounded located evidence",
      evidenceItemV1Schema: "evidence basis, severity and bounded message",
      evidenceV1Schema: "versioned bounded evidence collection",
      opportunityIdentityV1Schema: "stable opportunity identity",
      routableOpportunityRouteV1Schema: "later discovery routable branch",
      opportunityRouteV1Schema: "later discovery routable/unroutable union",
      opportunityLifecycleV1Schema: "versioned lifecycle state",
      programmaticLifecycleRecordV1Schema: "later lifecycle identity consistency",
      opportunityTransitionV1Schema: "allowed lifecycle transitions",
      routeEnvelopeV1Schema: "versioned bounded specialist route envelope",
      executionResultV1Schema: "versioned execution outcome and evidence",
    };
    expect(
      unused([...canonicalNames], used, fixtureUses, new Set(Object.keys(requiredFixtures))),
    ).toEqual([]);
    console.info(
      "Fixture-only contract requirements:",
      Object.entries(requiredFixtures).filter(([name]) => !used.has(name)),
    );
    // These bounded syntax/usage checks do not prove semantic uniqueness or overall design quality.
    console.info("Consumer declarations requiring manual semantic comparison:", lookalikes);
    const manifest = JSON.parse(read("packages/ggcoder/package.json")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports).some((name) => name.includes("programmatic"))).toBe(false);
    expect(
      ts
        .preProcessFile(read("packages/ggcoder/src/index.ts"))
        .importedFiles.filter(({ fileName }) => fileName.includes("programmatic")),
    ).toEqual([]);
  }, 60_000);

  it("counts real fixture references, not unused imports, shadowed names, or audit self-references", () => {
    const fileName = path.resolve(root, "consumer.test.ts");
    for (const [body, expected] of [
      ["it('valid fixture', () => schema.parse({}));", true],
      ["type Fixture = typeof schema;", true],
      ["", false],
      ["it('shadow', () => { const schema = { parse() {} }; schema.parse(); });", false],
      ["describe('Phase 1 structural bloat audit', () => schema.parse({}));", false],
      ["it('unrelated text', () => 'schema');", false],
    ] as const) {
      const source = parse(
        fileName,
        `import { exampleSchema as schema } from './contracts.js';\n${body}`,
      );
      const options = { noLib: true, noResolve: true };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (name) => (path.resolve(name) === fileName ? source : undefined);
      const checker = ts.createProgram([fileName], options, host).getTypeChecker();
      const declaration = source.statements.find(ts.isImportDeclaration)!;
      const bindings = declaration.importClause!.namedBindings!;
      expect(ts.isNamedImports(bindings)).toBe(true);
      if (!ts.isNamedImports(bindings)) throw new Error("Expected named fixture import");
      const referenced = referencedOutsideAudit(source, bindings.elements[0]!.name, checker);
      expect(referenced, body).toBe(expected);
      expect(
        unused(
          ["exampleSchema"],
          new Set(),
          new Set(referenced ? ["exampleSchema"] : []),
          new Set(["exampleSchema"]),
        ),
        body,
      ).toEqual(expected ? [] : ["exampleSchema"]);
    }
  });
});
