import path from "node:path";
import { z } from "zod";

export const PROGRAMMATIC_CONTRACT_VERSION = 1 as const;

const LIMITS = {
  pathChars: 500,
  scannerIdChars: 100,
  opportunityKeyChars: 500,
  opportunityTextChars: 4_000,
  inventoryScanners: 64,
  inventoryEntries: 10_000,
  discoveryOpportunities: 1_000,
  opportunityPaths: 200,
  opportunityRisks: 50,
  evidenceItems: 200,
  evidenceSourceChars: 100,
  evidenceCodeChars: 100,
  evidenceMessageChars: 4_000,
  executionSummaryChars: 4_000,
} as const;

const versionSchema = z.literal(PROGRAMMATIC_CONTRACT_VERSION);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const stableIdSchema = z
  .string()
  .min(1)
  .max(LIMITS.scannerIdChars)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const boundedString = (max: number) => z.string().min(1).max(max);
const specialistCommandSchema = z.enum(["research", "setup-sweep", "setup-tauri-package"]);
const lifecycleStateSchema = z.enum(["discovered", "queued", "running", "completed", "dismissed"]);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "must be a safe integer");
const allowedTransitions = {
  discovered: new Set(["queued", "dismissed"]),
  queued: new Set(["discovered", "running", "dismissed"]),
  running: new Set(["queued", "completed"]),
  completed: new Set<string>(),
  dismissed: new Set<string>(),
} satisfies Record<z.infer<typeof lifecycleStateSchema>, ReadonlySet<string>>;

function isStrictlyAscending(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(LIMITS.pathChars)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\\") &&
      !path.posix.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
      path.posix.normalize(value) === value,
    "must be a normalized repository-relative POSIX path",
  );

export const configurationFingerprintV1Schema = z.strictObject({
  version: versionSchema,
  sha256: sha256Schema,
});

export const scannerProfileV1Schema = z.strictObject({
  version: versionSchema,
  id: stableIdSchema,
  specialistCommand: specialistCommandSchema,
});

export const programmaticProfileV1Schema = z
  .strictObject({
    version: versionSchema,
    scanners: z.array(scannerProfileV1Schema).max(LIMITS.inventoryScanners),
  })
  .refine((value) => isStrictlyAscending(value.scanners.map((scanner) => scanner.id)), {
    path: ["scanners"],
    message: "scanner IDs must be unique and sorted ascending",
  });

export const inventoryEntryV1Schema = z.strictObject({
  path: repositoryRelativePathSchema,
  sha256: sha256Schema,
});

export const inventoryV1Schema = z
  .strictObject({
    version: versionSchema,
    configurationFingerprint: configurationFingerprintV1Schema,
    scanners: z.array(scannerProfileV1Schema).max(LIMITS.inventoryScanners),
    entries: z.array(inventoryEntryV1Schema).max(LIMITS.inventoryEntries),
  })
  .superRefine((value, context) => {
    if (!isStrictlyAscending(value.scanners.map((scanner) => scanner.id))) {
      context.addIssue({
        code: "custom",
        path: ["scanners"],
        message: "scanner IDs must be unique and sorted ascending",
      });
    }
    if (!isStrictlyAscending(value.entries.map((entry) => entry.path))) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "entry paths must be unique and sorted ascending",
      });
    }
  });

export const evidenceLocationV1Schema = z
  .strictObject({
    path: repositoryRelativePathSchema,
    startLine: positiveSafeIntegerSchema.optional(),
    endLine: positiveSafeIntegerSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.endLine !== undefined && value.startLine === undefined) {
      context.addIssue({ code: "custom", message: "endLine requires startLine" });
    }
    if (
      value.startLine !== undefined &&
      value.endLine !== undefined &&
      value.endLine < value.startLine
    ) {
      context.addIssue({ code: "custom", message: "endLine must be at or after startLine" });
    }
  });

export const evidenceItemV1Schema = z.strictObject({
  basis: z.enum(["observed", "inferred", "assumed"]),
  source: boundedString(LIMITS.evidenceSourceChars),
  code: boundedString(LIMITS.evidenceCodeChars),
  severity: z.enum(["info", "warning", "error"]),
  message: boundedString(LIMITS.evidenceMessageChars),
  location: evidenceLocationV1Schema.optional(),
});

export const evidenceV1Schema = z.strictObject({
  version: versionSchema,
  items: z.array(evidenceItemV1Schema).max(LIMITS.evidenceItems),
});

const repositoryPathArraySchema = z
  .array(repositoryRelativePathSchema)
  .min(1)
  .max(LIMITS.opportunityPaths)
  .refine(isStrictlyAscending, "paths must be unique and sorted ascending");
const boundedStringArray = (maxItems: number) =>
  z.array(boundedString(LIMITS.opportunityTextChars)).min(1).max(maxItems);

export const opportunityIdentityV1Schema = z.strictObject({
  version: versionSchema,
  id: sha256Schema,
  detectorId: stableIdSchema,
  key: boundedString(LIMITS.opportunityKeyChars),
  path: repositoryRelativePathSchema.optional(),
});

export const routableOpportunityRouteV1Schema = z.strictObject({
  status: z.literal("routable"),
  specialistCommand: specialistCommandSchema,
});

export const unroutableOpportunityRouteV1Schema = z.strictObject({
  status: z.literal("unroutable"),
});

export const opportunityRouteV1Schema = z.discriminatedUnion("status", [
  routableOpportunityRouteV1Schema,
  unroutableOpportunityRouteV1Schema,
]);

export const discoveredOpportunityV1Schema = z
  .strictObject({
    version: versionSchema,
    identity: opportunityIdentityV1Schema,
    representativeCase: repositoryRelativePathSchema,
    repeatableTrigger: boundedString(LIMITS.opportunityTextChars),
    inputPaths: repositoryPathArraySchema,
    currentProcess: boundedString(LIMITS.opportunityTextChars),
    expectedOutput: boundedString(LIMITS.opportunityTextChars),
    verification: boundedString(LIMITS.opportunityTextChars),
    risks: boundedStringArray(LIMITS.opportunityRisks),
    confidence: z.enum(["low", "medium", "high"]),
    mutationPaths: repositoryPathArraySchema,
    evidence: evidenceV1Schema,
    route: opportunityRouteV1Schema,
  })
  .refine(
    (value) =>
      value.evidence.items.some((item) => item.basis === "observed" && item.location !== undefined),
    { path: ["evidence", "items"], message: "a located observed evidence item is required" },
  );

export const opportunityDiscoveryResultV1Schema = z
  .strictObject({
    version: versionSchema,
    opportunities: z.array(discoveredOpportunityV1Schema).max(LIMITS.discoveryOpportunities),
  })
  .refine((value) => isStrictlyAscending(value.opportunities.map(({ identity }) => identity.id)), {
    path: ["opportunities"],
    message: "opportunity IDs must be unique and sorted ascending",
  });

export const opportunityLifecycleV1Schema = z.strictObject({
  version: versionSchema,
  opportunity: opportunityIdentityV1Schema,
  state: lifecycleStateSchema,
});

export const opportunityTransitionV1Schema = z
  .strictObject({
    version: versionSchema,
    opportunity: opportunityIdentityV1Schema,
    from: lifecycleStateSchema,
    to: lifecycleStateSchema,
  })
  .refine((value) => allowedTransitions[value.from].has(value.to), {
    message: "lifecycle transition is not allowed",
  });

export const routeEnvelopeV1Schema = z
  .strictObject({
    version: versionSchema,
    opportunity: discoveredOpportunityV1Schema,
    configurationFingerprint: configurationFingerprintV1Schema,
  })
  .refine((value) => value.opportunity.route.status === "routable", {
    path: ["opportunity", "route"],
    message: "only routable opportunities can form execution routes",
  });

export const executionResultV1Schema = z.strictObject({
  version: versionSchema,
  route: routeEnvelopeV1Schema,
  status: z.enum(["succeeded", "failed", "cancelled", "blocked"]),
  summary: boundedString(LIMITS.executionSummaryChars),
  evidence: evidenceV1Schema,
});

export type ConfigurationFingerprintV1 = z.infer<typeof configurationFingerprintV1Schema>;
export type ScannerProfileV1 = z.infer<typeof scannerProfileV1Schema>;
export type ProgrammaticProfileV1 = z.infer<typeof programmaticProfileV1Schema>;
export type InventoryEntryV1 = z.infer<typeof inventoryEntryV1Schema>;
export type InventoryV1 = z.infer<typeof inventoryV1Schema>;
export type EvidenceLocationV1 = z.infer<typeof evidenceLocationV1Schema>;
export type EvidenceItemV1 = z.infer<typeof evidenceItemV1Schema>;
export type EvidenceV1 = z.infer<typeof evidenceV1Schema>;
export type OpportunityIdentityV1 = z.infer<typeof opportunityIdentityV1Schema>;
export type OpportunityRouteV1 = z.infer<typeof opportunityRouteV1Schema>;
export type DiscoveredOpportunityV1 = z.infer<typeof discoveredOpportunityV1Schema>;
export type OpportunityDiscoveryResultV1 = z.infer<typeof opportunityDiscoveryResultV1Schema>;
export type OpportunityLifecycleV1 = z.infer<typeof opportunityLifecycleV1Schema>;
export type OpportunityTransitionV1 = z.infer<typeof opportunityTransitionV1Schema>;
export type RouteEnvelopeV1 = z.infer<typeof routeEnvelopeV1Schema>;
export type ExecutionResultV1 = z.infer<typeof executionResultV1Schema>;
