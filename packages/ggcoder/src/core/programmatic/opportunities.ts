import type {
  DiscoveredOpportunityV1,
  InventoryV1,
  OpportunityDiscoveryResultV1,
  OpportunityIdentityV1,
} from "./contracts.js";
import {
  discoveredOpportunityV1Schema,
  inventoryV1Schema,
  opportunityDiscoveryResultV1Schema,
  PROGRAMMATIC_CONTRACT_VERSION,
} from "./contracts.js";
import { compareText, GENERATED_PATHS, sha256, stableJson } from "../tauri-package/paths.js";

type OpportunityDraft = Omit<DiscoveredOpportunityV1, "identity"> & {
  identity: Omit<OpportunityIdentityV1, "id">;
};
type PathFactDetector = (paths: ReadonlySet<string>) => readonly OpportunityDraft[];

const UNSUPPORTED_TAURI_CONFIGS = [
  "src-tauri/Tauri.toml",
  "src-tauri/tauri.conf.json5",
  "src-tauri/tauri.conf.toml",
] as const;

function scopedPath(root: string, relativePath: string): string {
  return root ? `${root}/${relativePath}` : relativePath;
}

function packageRoots(paths: ReadonlySet<string>): string[] {
  return [...paths]
    .filter((path) => path === "package.json" || path.endsWith("/package.json"))
    .map((path) => (path === "package.json" ? "" : path.slice(0, -"/package.json".length)));
}

function observedEvidence(
  source: string,
  code: string,
  message: string,
  path: string,
): DiscoveredOpportunityV1["evidence"]["items"][number] {
  return { basis: "observed", source, code, severity: "info", message, location: { path } };
}

function detectCanonicalTauri(paths: ReadonlySet<string>): OpportunityDraft[] {
  const detectorId = "tauri-package-shape";
  return packageRoots(paths).flatMap((root) => {
    const packageManifest = scopedPath(root, "package.json");
    const cargoManifest = scopedPath(root, "src-tauri/Cargo.toml");
    const tauriConfig = scopedPath(root, "src-tauri/tauri.conf.json");
    const inputPaths = [packageManifest, cargoManifest, tauriConfig].sort();
    if (!inputPaths.every((path) => paths.has(path))) return [];

    const repositoryMutationPaths = [...GENERATED_PATHS];
    const appMutationPaths = GENERATED_PATHS.map((path) => scopedPath(root, path));
    const repositoryOwned = repositoryMutationPaths.some((path) => paths.has(path));
    const appOwned = root !== "" && appMutationPaths.some((path) => paths.has(path));
    const ownershipCollision = repositoryOwned && appOwned;
    const mutationPaths = ownershipCollision
      ? [...repositoryMutationPaths, ...appMutationPaths].sort()
      : [...(appOwned ? appMutationPaths : repositoryMutationPaths)].sort();
    return [
      {
        version: PROGRAMMATIC_CONTRACT_VERSION,
        identity: {
          version: PROGRAMMATIC_CONTRACT_VERSION,
          detectorId,
          key: "canonical-tauri-package",
          path: packageManifest,
        },
        representativeCase: tauriConfig,
        repeatableTrigger:
          "A package root contains package.json, src-tauri/Cargo.toml, and src-tauri/tauri.conf.json.",
        inputPaths,
        currentProcess: "Tauri packaging support must otherwise be maintained manually.",
        expectedOutput: "Deterministic host-native Tauri packaging support for this app root.",
        verification: "Verify the generated packaging support against the detected Tauri app.",
        risks: [
          "Generated support could conflict with existing manually maintained packaging files.",
        ],
        confidence: "medium",
        mutationPaths,
        evidence: {
          version: PROGRAMMATIC_CONTRACT_VERSION,
          items: [
            observedEvidence(
              detectorId,
              "package-manifest",
              "A sibling package manifest is present.",
              packageManifest,
            ),
            observedEvidence(
              detectorId,
              "cargo-manifest",
              "A sibling Tauri Cargo manifest is present.",
              cargoManifest,
            ),
            observedEvidence(
              detectorId,
              "tauri-json-config",
              "A canonical Tauri JSON configuration is present.",
              tauriConfig,
            ),
          ],
        },
        route: ownershipCollision
          ? { status: "unroutable" }
          : { status: "routable", specialistCommand: "setup-tauri-package" },
      },
    ];
  });
}

function detectUnsupportedTauriConfig(paths: ReadonlySet<string>): OpportunityDraft[] {
  const detectorId = "unsupported-tauri-config-shape";
  return packageRoots(paths).flatMap((root) => {
    const packageManifest = scopedPath(root, "package.json");
    const cargoManifest = scopedPath(root, "src-tauri/Cargo.toml");
    const canonicalConfig = scopedPath(root, "src-tauri/tauri.conf.json");
    const unsupportedConfigs = UNSUPPORTED_TAURI_CONFIGS.map((path) => scopedPath(root, path))
      .filter((path) => paths.has(path))
      .sort();
    if (
      !paths.has(packageManifest) ||
      !paths.has(cargoManifest) ||
      paths.has(canonicalConfig) ||
      unsupportedConfigs.length === 0
    ) {
      return [];
    }

    const inputPaths = [packageManifest, cargoManifest, ...unsupportedConfigs].sort();
    return [
      {
        version: PROGRAMMATIC_CONTRACT_VERSION,
        identity: {
          version: PROGRAMMATIC_CONTRACT_VERSION,
          detectorId,
          key: "unsupported-tauri-config",
          path: packageManifest,
        },
        representativeCase: unsupportedConfigs[0]!,
        repeatableTrigger:
          "A package root contains package.json and src-tauri/Cargo.toml with only a known non-JSON Tauri configuration.",
        inputPaths,
        currentProcess: "The unsupported configuration format requires manual normalization.",
        expectedOutput:
          "A canonical Tauri JSON configuration suitable for supported packaging setup.",
        verification:
          "Confirm a canonical src-tauri/tauri.conf.json before routing packaging setup.",
        risks: [
          "Configuration normalization could lose format-specific comments or unsupported values.",
        ],
        confidence: "low",
        mutationPaths: [canonicalConfig, ...unsupportedConfigs].sort(),
        evidence: {
          version: PROGRAMMATIC_CONTRACT_VERSION,
          items: [
            observedEvidence(
              detectorId,
              "package-manifest",
              "A sibling package manifest is present.",
              packageManifest,
            ),
            observedEvidence(
              detectorId,
              "cargo-manifest",
              "A sibling Tauri Cargo manifest is present.",
              cargoManifest,
            ),
            ...unsupportedConfigs.map((path) =>
              observedEvidence(
                detectorId,
                "unsupported-tauri-config",
                "A known unsupported Tauri configuration is present.",
                path,
              ),
            ),
          ],
        },
        route: { status: "unroutable" },
      },
    ];
  });
}

const PATH_FACT_DETECTORS = [
  detectCanonicalTauri,
  detectUnsupportedTauriConfig,
] as const satisfies readonly PathFactDetector[];

function stableIdentity(identity: OpportunityDraft["identity"]): OpportunityIdentityV1 {
  return {
    ...identity,
    id: sha256(
      stableJson({
        version: identity.version,
        detectorId: identity.detectorId,
        key: identity.key,
        path: identity.path,
      }),
    ),
  };
}

function validatedCandidate(
  draft: OpportunityDraft,
  inventoryPaths: ReadonlySet<string>,
): DiscoveredOpportunityV1 | undefined {
  const parsed = discoveredOpportunityV1Schema.safeParse({
    ...draft,
    identity: stableIdentity(draft.identity),
  });
  if (!parsed.success) return undefined;

  const opportunity = parsed.data;
  const referencedPaths = [
    opportunity.representativeCase,
    ...opportunity.inputPaths,
    ...opportunity.evidence.items.flatMap(({ location }) =>
      location === undefined ? [] : [location.path],
    ),
  ];
  if (
    (opportunity.identity.path !== undefined && !inventoryPaths.has(opportunity.identity.path)) ||
    referencedPaths.some((path) => !inventoryPaths.has(path))
  ) {
    return undefined;
  }
  return opportunity;
}

export function discoverProgrammaticOpportunities(
  inventory: InventoryV1,
): OpportunityDiscoveryResultV1 {
  const validatedInventory = inventoryV1Schema.parse(inventory);
  const inventoryPaths = new Set(validatedInventory.entries.map(({ path }) => path));
  const opportunities = new Map<string, DiscoveredOpportunityV1>();

  for (const draft of PATH_FACT_DETECTORS.flatMap((detector) => detector(inventoryPaths))) {
    const candidate = validatedCandidate(draft, inventoryPaths);
    if (!candidate) continue;
    const existing = opportunities.get(candidate.identity.id);
    if (!existing || stableJson(candidate) < stableJson(existing)) {
      opportunities.set(candidate.identity.id, candidate);
    }
  }

  return opportunityDiscoveryResultV1Schema.parse({
    version: PROGRAMMATIC_CONTRACT_VERSION,
    opportunities: [...opportunities.values()].sort((left, right) =>
      compareText(left.identity.id, right.identity.id),
    ),
  });
}
