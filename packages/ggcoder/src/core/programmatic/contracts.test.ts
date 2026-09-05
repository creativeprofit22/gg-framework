import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  configurationFingerprintV1Schema,
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
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol)
        referenced = true;
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
          ["node:path", "zod"].includes(node.moduleSpecifier.text)
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
        return node.name && ["isStrictlyAscending"].includes(node.name.text)
          ? []
          : ["unreviewed helper"];
      }
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
