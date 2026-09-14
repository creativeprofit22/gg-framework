import path from "node:path";
import { z } from "zod";
import {
  isValidProgrammaticFocus,
  PROGRAMMATIC_FOCUS_GUIDANCE,
} from "@kenkaiiii/gg-core/slash-command-contract";

export const PROGRAMMATIC_CONTRACT_VERSION = 1 as const;
export const PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT = 1_000;

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
  routeArguments: 32,
  routeArgumentValueChars: 500,
  routeTextChars: 4_000,
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
export const specialistCommandSchema = z.enum(["research", "setup-sweep", "setup-tauri-package"]);
const lifecycleStateSchema = z.enum(["discovered", "queued", "running", "completed", "dismissed"]);
const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "must be a safe integer");
const positiveSafeIntegerSchema = nonnegativeSafeIntegerSchema.positive();
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

export const programmaticProfileEnvelopeV1Schema = z.strictObject({
  version: versionSchema,
  configurationFingerprint: configurationFingerprintV1Schema,
  profile: programmaticProfileV1Schema,
});

export const inventoryEntryV1Schema = z.strictObject({
  path: repositoryRelativePathSchema,
  sha256: sha256Schema,
});

function isSafeConfigurationSnapshotPath(value: string): boolean {
  return (
    !value.includes(":") &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

// Stored setup evolves independently of opportunity identity and lifecycle contracts.
const PROGRAMMATIC_PROFILE_ENVELOPE_VERSION = 2 as const;
export const PROGRAMMATIC_CONFIGURATION_INPUT_LIMIT = LIMITS.inventoryEntries;
export const configurationSnapshotSchema = z.strictObject({
  policyRevision: positiveSafeIntegerSchema,
  scannerProfileSchemaRevision: positiveSafeIntegerSchema,
  exclusions: z
    .array(
      repositoryRelativePathSchema.refine(isSafeConfigurationSnapshotPath, "unsafe exclusion path"),
    )
    .max(LIMITS.inventoryEntries)
    .refine(isStrictlyAscending, "exclusions must be unique and sorted ascending"),
  inputs: z
    .array(
      inventoryEntryV1Schema.refine(
        (input) => isSafeConfigurationSnapshotPath(input.path),
        "unsafe configuration path",
      ),
    )
    .max(LIMITS.inventoryEntries)
    .refine(
      (inputs) => isStrictlyAscending(inputs.map((input) => input.path)),
      "configuration input paths must be unique and sorted ascending",
    ),
});

export const programmaticProfileEnvelopeV2Schema = z.strictObject({
  version: z.literal(PROGRAMMATIC_PROFILE_ENVELOPE_VERSION),
  configurationFingerprint: configurationFingerprintV1Schema,
  profile: programmaticProfileV1Schema,
  configurationSnapshot: configurationSnapshotSchema,
});

export type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;
export type ProgrammaticProfileEnvelopeV2 = z.infer<typeof programmaticProfileEnvelopeV2Schema>;

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

// Extension contracts are ephemeral advice/review data, never scanner or lifecycle input.
const extensionTextSchema = boundedString(LIMITS.opportunityTextChars).refine(
  (value) =>
    value.trim().length > 0 &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return (
        (code >= 32 && (code < 127 || code > 159)) ||
        character === "\n" ||
        character === "\r" ||
        character === "\t"
      );
    }),
  "must contain text without control characters",
);
const extensionPathSchema = repositoryRelativePathSchema.refine(isSafeConfigurationSnapshotPath);
const extensionTextsSchema = z.array(extensionTextSchema).min(1).max(50);

export const programmaticAssessmentInputV1Schema = z.strictObject({
  version: z.literal(1),
  focus: z.string().refine(isValidProgrammaticFocus, PROGRAMMATIC_FOCUS_GUIDANCE).optional(),
});

// Reference-only subset of slash tokens: preserve case and punctuation, never normalize.
// ASCII alphanumeric start, then letters/digits/dot/underscore/hyphen; 100 chars max.
// The absolute-end assertion also rejects a final newline (unlike `$`).
const commandNameTokenSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/);

export const programmaticCommandReferenceV1Schema = z
  .strictObject({
    version: z.literal(1),
    name: commandNameTokenSchema,
    source: z.enum(["built-in", "project-custom", "global-custom"]),
    invocationKind: z.enum(["prompt", "workspace-action"]),
  })
  .refine(
    (value) => value.invocationKind !== "workspace-action" || value.source === "built-in",
    "workspace actions are host-owned",
  );

const capabilityKindSchema = z.enum(["prompt-only", "script-backed", "app-backed"]);
const helperSnapshotSchema = z.strictObject({ path: extensionPathSchema, sha256: sha256Schema });
export const programmaticCommandSnapshotV1Schema = z
  .strictObject({
    version: z.literal(1),
    command: programmaticCommandReferenceV1Schema,
    capabilityKind: capabilityKindSchema,
    // Digest the private resolved owner identity; never expose its absolute path.
    ownerSha256: sha256Schema,
    bodySha256: sha256Schema,
    helpers: z.array(helperSnapshotSchema).max(32),
  })
  .refine(
    (value) =>
      isStrictlyAscending(value.helpers.map((helper) => helper.path)) &&
      new Set(value.helpers.map((helper) => helper.path.toLowerCase())).size ===
        value.helpers.length,
    "helpers must be unique and sorted ascending",
  )
  .refine(
    (value) =>
      value.capabilityKind === "script-backed"
        ? value.helpers.length > 0
        : value.helpers.length === 0,
    "only script-backed commands declare helpers and must declare at least one",
  )
  .refine(
    (value) =>
      (value.command.invocationKind === "workspace-action") ===
      (value.capabilityKind === "app-backed"),
    "workspace actions require app-backed capabilities",
  );

export const programmaticCommandAvailabilityV1Schema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), snapshot: programmaticCommandSnapshotV1Schema }),
  z.strictObject({
    status: z.literal("unavailable"),
    command: programmaticCommandReferenceV1Schema,
    reason: extensionTextSchema,
  }),
]);

const externalReferenceSchema = z.strictObject({
  kind: z.literal("external-reference"),
  basis: z.enum(["observed", "inferred", "assumed"]),
  inspectedUrl: z
    .string()
    .min(1)
    .max(4_000)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          /^https?:\/\//.test(value) &&
          !/\s/.test(value) &&
          !value.includes("\\") &&
          (url.protocol === "https:" || url.protocol === "http:") &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "must be an HTTP(S) attribution URL without credentials, query or fragment"),
  revision: z.string().min(1).max(100).optional(),
  location: evidenceLocationV1Schema
    .refine((value) => extensionPathSchema.safeParse(value.path).success)
    .optional(),
  claim: extensionTextSchema,
});
const advisoryEvidenceSchema = z.strictObject({
  version: z.literal(1),
  items: z
    .array(
      z.union([
        evidenceItemV1Schema.refine(
          (value) => !value.location || extensionPathSchema.safeParse(value.location.path).success,
        ),
        externalReferenceSchema,
      ]),
    )
    .max(50),
});

export const programmaticMissingCapabilityV1Schema = z.strictObject({
  version: z.literal(1),
  desiredOutcome: extensionTextSchema,
  capabilityKind: capabilityKindSchema,
  inputs: extensionTextsSchema,
  outputs: extensionTextsSchema,
  prerequisites: extensionTextsSchema,
  risks: extensionTextsSchema,
  verificationExpectations: extensionTextsSchema,
});
export const programmaticRecommendationV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("advisory"),
  outcome: extensionTextSchema,
  rationale: extensionTextSchema,
  uncertainty: extensionTextSchema,
  evidence: advisoryEvidenceSchema,
  choice: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("reuse-command"),
      availability: programmaticCommandAvailabilityV1Schema,
    }),
    z.strictObject({
      kind: z.literal("missing-capability"),
      proposal: programmaticMissingCapabilityV1Schema,
    }),
    z.strictObject({ kind: z.literal("manual"), steps: extensionTextsSchema }),
  ]),
});
export const programmaticAssessmentResultV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("advisory"),
  recommendations: z.array(programmaticRecommendationV1Schema).max(50),
  coverage: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("complete"), scope: extensionTextSchema }),
    z.strictObject({
      status: z.literal("limited"),
      scope: extensionTextSchema,
      reason: extensionTextSchema,
    }),
  ]),
});

export const programmaticCreationProposalV1Schema = z
  .strictObject({
    version: z.literal(1),
    proposalId: z.string().uuid(),
    purpose: z.literal("creation"),
    scope: z.literal("project"),
    requirement: programmaticMissingCapabilityV1Schema,
    snapshot: programmaticCommandSnapshotV1Schema,
    commandPath: extensionPathSchema,
    files: z
      .array(
        z.strictObject({
          path: extensionPathSchema,
          proposedSha256: sha256Schema,
          prior: z.discriminatedUnion("status", [
            z.strictObject({ status: z.literal("absent") }),
            z.strictObject({ status: z.literal("present"), sha256: sha256Schema }),
          ]),
        }),
      )
      .min(1)
      .max(33),
  })
  .refine(
    (value) =>
      value.snapshot.command.source === "project-custom" &&
      value.snapshot.capabilityKind !== "app-backed" &&
      value.requirement.capabilityKind === value.snapshot.capabilityKind,
    "creation supports only project prompt/script commands",
  )
  .refine(
    (value) => /^\.gg\/commands\/[^/]+\.md$/.test(value.commandPath),
    "command destination must use the existing project Markdown loader",
  )
  .refine(
    (value) =>
      isStrictlyAscending(value.files.map((file) => file.path)) &&
      new Set(value.files.map((file) => file.path.toLowerCase())).size === value.files.length,
    "files must be unique and sorted ascending",
  )
  .refine((value) => {
    const expected = [
      { path: value.commandPath, sha256: value.snapshot.bodySha256 },
      ...value.snapshot.helpers,
    ];
    return (
      new Set(expected.map((file) => file.path)).size === expected.length &&
      expected.length === value.files.length &&
      expected.every((file) =>
        value.files.some(
          (candidate) => candidate.path === file.path && candidate.proposedSha256 === file.sha256,
        ),
      )
    );
  }, "files must exactly bind command and helper content");

const verificationCaseSchema = z.strictObject({
  category: z.enum(["loads", "behavior", "side-effects"]),
  scenario: z.enum(["normal", "incomplete", "out-of-scope"]),
  method: z.enum(["deterministic", "model-judgment"]),
  input: extensionTextSchema,
  result: z.enum(["passed", "failed", "unavailable"]),
  evidence: advisoryEvidenceSchema.refine(
    (value) => value.items.length > 0,
    "case evidence is required",
  ),
});
export const programmaticVerificationV1Schema = z
  .strictObject({
    version: z.literal(1),
    snapshot: programmaticCommandSnapshotV1Schema,
    result: z.enum(["passed", "failed", "unavailable"]),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    environment: extensionTextSchema,
    limits: extensionTextsSchema,
    cases: z.array(verificationCaseSchema).min(1).max(50),
  })
  .refine((value) => {
    if (value.result !== "passed") return true;
    if (
      value.snapshot.capabilityKind === "app-backed" ||
      value.cases.some((item) => item.result !== "passed")
    )
      return false;
    const categories =
      value.snapshot.capabilityKind === "script-backed"
        ? ["loads", "behavior", "side-effects"]
        : ["loads", "behavior"];
    return categories.every((category) =>
      (category === "loads" ? ["normal"] : ["normal", "incomplete", "out-of-scope"]).every(
        (scenario) =>
          value.cases.some(
            (item) =>
              item.category === category &&
              item.scenario === scenario &&
              item.method === "deterministic",
          ),
      ),
    );
  }, "passed verification requires deterministic loading and behavioral coverage, plus script side-effect/error coverage");

export const programmaticExecutionSettingsV1Schema = z.strictObject({
  version: z.literal(1),
  policyId: stableIdSchema,
  policyRevision: positiveSafeIntegerSchema,
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  maxTurns: positiveSafeIntegerSchema.max(1_000),
  deadlineMs: positiveSafeIntegerSchema.max(86_400_000),
  capabilityProfile: z.enum(["research-read-only", "reviewed-mutation"]),
});
export const programmaticExecutionReviewV1Schema = z
  .strictObject({
    version: z.literal(1),
    purpose: z.literal("execution"),
    proposalId: z.string().uuid(),
    snapshot: programmaticCommandSnapshotV1Schema,
    arguments: z
      .string()
      .max(4_000)
      .refine((value) => value === "" || extensionTextSchema.safeParse(value).success),
    configurationFingerprint: configurationFingerprintV1Schema,
    successCondition: extensionTextSchema,
    settings: programmaticExecutionSettingsV1Schema,
  })
  .refine(
    (value) => value.snapshot.capabilityKind !== "app-backed",
    "app-backed execution is unsupported",
  )
  .refine(
    (value) =>
      value.snapshot.capabilityKind !== "script-backed" ||
      value.settings.capabilityProfile === "reviewed-mutation",
    "read-only research cannot execute scripts",
  );

// Host-only context: never deserialize this from model output. Matching is not approval
// consumption; the existing callback owner must consume once and re-resolve at dispatch.
export interface ProgrammaticApprovalContext {
  pendingProposalId: string;
  purpose: "creation" | "execution";
  decision?: "accepted" | "rejected";
}
export function isProgrammaticReviewCurrent(
  reviewed: unknown,
  current: unknown,
  expectedPurpose: "creation" | "execution",
  approval: ProgrammaticApprovalContext | undefined,
): boolean {
  if (!approval || approval.decision !== "accepted" || approval.purpose !== expectedPurpose)
    return false;
  const schema =
    expectedPurpose === "creation"
      ? programmaticCreationProposalV1Schema
      : expectedPurpose === "execution"
        ? programmaticExecutionReviewV1Schema
        : undefined;
  if (!schema) return false;
  const before = schema.safeParse(reviewed);
  const now = schema.safeParse(current);
  return (
    before.success &&
    now.success &&
    before.data.proposalId === approval.pendingProposalId &&
    JSON.stringify(before.data) === JSON.stringify(now.data)
  );
}

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

const unroutableOpportunityRouteV1Schema = z.strictObject({
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

export const opportunityLifecycleV1Schema = z
  .strictObject({
    version: versionSchema,
    opportunity: opportunityIdentityV1Schema,
    state: lifecycleStateSchema,
    runId: z.string().uuid().optional(),
  })
  .refine((value) => value.runId === undefined || value.state === "running", {
    message: "Only a running lifecycle may hold execution ownership",
  });

export const programmaticLifecycleRecordV1Schema = z
  .strictObject({
    version: versionSchema,
    opportunity: discoveredOpportunityV1Schema,
    lifecycle: opportunityLifecycleV1Schema,
    presence: z.enum(["present", "disappeared"]),
  })
  .refine(
    (value) =>
      value.opportunity.identity.id === value.lifecycle.opportunity.id &&
      value.opportunity.identity.detectorId === value.lifecycle.opportunity.detectorId &&
      value.opportunity.identity.key === value.lifecycle.opportunity.key &&
      value.opportunity.identity.path === value.lifecycle.opportunity.path,
    {
      path: ["lifecycle", "opportunity"],
      message: "lifecycle identity must match opportunity identity",
    },
  );

export const programmaticLifecycleStateV1Schema = z
  .strictObject({
    version: versionSchema,
    configurationFingerprint: configurationFingerprintV1Schema,
    configurationRefreshRequired: z.literal(true).optional(),
    records: z.array(programmaticLifecycleRecordV1Schema).max(PROGRAMMATIC_LIFECYCLE_RECORD_LIMIT),
  })
  .refine(
    (value) => isStrictlyAscending(value.records.map(({ opportunity }) => opportunity.identity.id)),
    {
      path: ["records"],
      message: "opportunity IDs must be unique and sorted ascending",
    },
  );

export const programmaticScanSummaryV1Schema = z.strictObject({
  new: nonnegativeSafeIntegerSchema,
  unchanged: nonnegativeSafeIntegerSchema,
  active: nonnegativeSafeIntegerSchema,
  completed: nonnegativeSafeIntegerSchema,
  dismissed: nonnegativeSafeIntegerSchema,
  disappeared: nonnegativeSafeIntegerSchema,
  failed: nonnegativeSafeIntegerSchema,
  unverified: nonnegativeSafeIntegerSchema,
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

const routeArgumentV1Schema = z.strictObject({
  name: stableIdSchema,
  value: boundedString(LIMITS.routeArgumentValueChars),
});

export const PROGRAMMATIC_MACHINE_LOCAL_WARNING =
  "Availability may differ on another machine." as const;

const commandSourceSchema = z.enum(["built-in", "global-custom"]);
const commandPortabilitySchema = z.enum(["bundled", "machine-local"]);
const unavailableReasonSchema = z.enum(["missing", "wrong-owner", "ambiguous", "unsupported"]);

const availableCommandV1Schema = z.discriminatedUnion("portability", [
  z.strictObject({
    status: z.literal("available"),
    source: z.literal("built-in"),
    portability: z.literal("bundled"),
  }),
  z.strictObject({
    status: z.literal("available"),
    source: z.literal("global-custom"),
    portability: z.literal("machine-local"),
    portabilityWarning: z.literal(PROGRAMMATIC_MACHINE_LOCAL_WARNING),
  }),
]);

const unavailableCommandV1Schema = z
  .strictObject({
    status: z.literal("unavailable"),
    reason: unavailableReasonSchema,
    source: commandSourceSchema.optional(),
    portability: commandPortabilitySchema.optional(),
    portabilityWarning: z.literal(PROGRAMMATIC_MACHINE_LOCAL_WARNING).optional(),
  })
  .superRefine((value, context) => {
    const needsWarning = value.portability === "machine-local";
    if (needsWarning !== (value.portabilityWarning !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["portabilityWarning"],
        message: "machine-local availability requires its portability warning",
      });
    }
  });

const routeArgumentArraySchema = z
  .array(routeArgumentV1Schema)
  .max(LIMITS.routeArguments)
  .refine(
    (values) => isStrictlyAscending(values.map(({ name }) => name)),
    "argument names must be unique and sorted ascending",
  );

export const routeEnvelopeV1Schema = z.strictObject({
  version: versionSchema,
  status: z.literal("routable"),
  opportunityId: sha256Schema,
  configurationFingerprint: configurationFingerprintV1Schema,
  specialistCommand: specialistCommandSchema,
  arguments: routeArgumentArraySchema,
  evidencePaths: repositoryPathArraySchema,
  scopePaths: repositoryPathArraySchema,
  successCondition: boundedString(LIMITS.routeTextChars),
  mutates: z.boolean(),
  reason: boundedString(LIMITS.routeTextChars),
  availability: availableCommandV1Schema,
});

const unroutableResolutionV1Schema = z.strictObject({
  version: versionSchema,
  status: z.literal("unroutable"),
  opportunityId: sha256Schema,
  candidateCommand: specialistCommandSchema.optional(),
  availability: unavailableCommandV1Schema,
  reason: boundedString(LIMITS.routeTextChars),
});

export const routeResolutionV1Schema = z.discriminatedUnion("status", [
  routeEnvelopeV1Schema,
  unroutableResolutionV1Schema,
]);

export const executionResultV1Schema = z.strictObject({
  version: versionSchema,
  route: routeEnvelopeV1Schema,
  status: z.enum(["succeeded", "failed", "cancelled", "blocked"]),
  summary: boundedString(LIMITS.executionSummaryChars),
  evidence: evidenceV1Schema,
});

export type ConfigurationFingerprintV1 = z.infer<typeof configurationFingerprintV1Schema>;
export type ProgrammaticProfileV1 = z.infer<typeof programmaticProfileV1Schema>;
export type ProgrammaticProfileEnvelopeV1 = z.infer<typeof programmaticProfileEnvelopeV1Schema>;
export type InventoryEntryV1 = z.infer<typeof inventoryEntryV1Schema>;
export type InventoryV1 = z.infer<typeof inventoryV1Schema>;
export type OpportunityIdentityV1 = z.infer<typeof opportunityIdentityV1Schema>;
export type DiscoveredOpportunityV1 = z.infer<typeof discoveredOpportunityV1Schema>;
export type OpportunityDiscoveryResultV1 = z.infer<typeof opportunityDiscoveryResultV1Schema>;
export type ProgrammaticLifecycleRecordV1 = z.infer<typeof programmaticLifecycleRecordV1Schema>;
export type ProgrammaticLifecycleStateV1 = z.infer<typeof programmaticLifecycleStateV1Schema>;
export type ProgrammaticScanSummaryV1 = z.infer<typeof programmaticScanSummaryV1Schema>;
export type RouteArgumentV1 = z.infer<typeof routeArgumentV1Schema>;
export type AvailableCommandV1 = z.infer<typeof availableCommandV1Schema>;
export type UnavailableCommandV1 = z.infer<typeof unavailableCommandV1Schema>;
export type RouteResolutionV1 = z.infer<typeof routeResolutionV1Schema>;
export type SpecialistCommand = z.infer<typeof specialistCommandSchema>;
