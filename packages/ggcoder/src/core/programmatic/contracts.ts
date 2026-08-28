import path from "node:path";
import { z } from "zod";

export const PROGRAMMATIC_CONTRACT_VERSION = 1 as const;

const LIMITS = {
  pathChars: 500,
  scannerIdChars: 100,
  opportunityKeyChars: 500,
  inventoryScanners: 64,
  inventoryEntries: 10_000,
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
const specialistCommandSchema = z.enum([
  "setup-ci",
  "setup-commit",
  "setup-skills",
  "setup-tauri-package",
]);
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

export const opportunityIdentityV1Schema = z.strictObject({
  version: versionSchema,
  scannerId: stableIdSchema,
  specialistCommand: specialistCommandSchema,
  key: boundedString(LIMITS.opportunityKeyChars),
  path: repositoryRelativePathSchema.optional(),
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
    opportunity: opportunityIdentityV1Schema,
    specialistCommand: specialistCommandSchema,
    configurationFingerprint: configurationFingerprintV1Schema,
  })
  .refine((value) => value.specialistCommand === value.opportunity.specialistCommand, {
    path: ["specialistCommand"],
    message: "route specialist must match opportunity specialist",
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
export type InventoryEntryV1 = z.infer<typeof inventoryEntryV1Schema>;
export type InventoryV1 = z.infer<typeof inventoryV1Schema>;
export type EvidenceLocationV1 = z.infer<typeof evidenceLocationV1Schema>;
export type EvidenceItemV1 = z.infer<typeof evidenceItemV1Schema>;
export type EvidenceV1 = z.infer<typeof evidenceV1Schema>;
export type OpportunityIdentityV1 = z.infer<typeof opportunityIdentityV1Schema>;
export type OpportunityLifecycleV1 = z.infer<typeof opportunityLifecycleV1Schema>;
export type OpportunityTransitionV1 = z.infer<typeof opportunityTransitionV1Schema>;
export type RouteEnvelopeV1 = z.infer<typeof routeEnvelopeV1Schema>;
export type ExecutionResultV1 = z.infer<typeof executionResultV1Schema>;
