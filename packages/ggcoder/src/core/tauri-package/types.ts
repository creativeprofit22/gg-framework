export const DISCOVERY_SCHEMA_VERSION = 1;
export const GENERATED_CONFIG_SCHEMA_VERSION = 1;
export const TEMPLATE_VERSION = 1;

export type EvidenceRole =
  | "root-package"
  | "workspace-definition"
  | "workspace-package"
  | "lockfile"
  | "cargo-manifest"
  | "tauri-config"
  | "tauri-cli-package"
  | "tauri-cli-bin"
  | "resource"
  | "sidecar";

export interface EvidenceSource {
  path: string;
  role: EvidenceRole;
  sha256: string;
}

export interface HostTarget {
  platform: NodeJS.Platform;
  arch: string;
  id: string;
  rust_triple: string;
}

export interface TauriResource {
  source: string;
  target: string;
  kind: "file" | "directory";
}

export interface TauriSidecar {
  configured_source: string;
  source: string;
}

export type ArtifactRole = "app" | "bundle";

export interface RequiredArtifactRole {
  role: ArtifactRole;
  minimum: number;
  directly_runnable: boolean;
}

export interface TauriCandidate {
  target_id: string;
  package_root: string;
  package_manifest: string;
  cargo_manifest: string;
  tauri_config: string;
  cli_package: string;
  cli_bin: string;
  cli_version: string;
  product_name: string;
  identifier: string;
  host: HostTarget;
  artifact_root: string;
  resources: TauriResource[];
  sidecars: TauriSidecar[];
  prune: string[];
  required_roles: RequiredArtifactRole[];
  source_paths: string[];
}

export type DiscoveryIssueCode =
  | "unsupported-workspace"
  | "unsupported-config-format"
  | "unsupported-tauri-version"
  | "unsupported-cross-target"
  | "unsupported-glob"
  | "missing-proof"
  | "missing-cli"
  | "invalid-path"
  | "link-rejected"
  | "case-collision"
  | "invalid-manifest";

export interface DiscoveryIssue {
  code: DiscoveryIssueCode;
  path: string;
  message: string;
}

export interface TauriDiscoveryEvidence {
  schema_version: typeof DISCOVERY_SCHEMA_VERSION;
  host: HostTarget;
  candidates: TauriCandidate[];
  sources: EvidenceSource[];
  issues: DiscoveryIssue[];
}

export interface TauriDiscoveryResult {
  evidence: TauriDiscoveryEvidence;
  evidence_sha256: string;
  targets: TauriCandidate[];
  summary: string;
}

export interface CalibrationBounds {
  evidence_sha256: string;
  baseline_total_bytes: number;
  maximum_total_bytes: number;
  maximum_file_bytes: number;
  role_counts: Record<ArtifactRole, number>;
  role_maximum_bytes: Record<ArtifactRole, number>;
  required_paths: string[];
  absolute_growth_bytes: number;
  percentage_growth: number;
}

export interface GeneratedTauriConfig {
  schema_version: typeof GENERATED_CONFIG_SCHEMA_VERSION;
  template_version: typeof TEMPLATE_VERSION;
  ownership: string;
  evidence_sha256: string;
  target: TauriCandidate;
  sources: EvidenceSource[];
  calibration: CalibrationBounds | null;
}

export interface GeneratedFile {
  path: string;
  bytes: Buffer;
  template_sha256: string;
  content_sha256: string;
}

export type SupportSetState = "absent" | "owned" | "conflict";

export interface SupportSetInspection {
  state: SupportSetState;
  conflicts: string[];
  files: GeneratedFile[];
}

export interface ArtifactRecord {
  path: string;
  role: ArtifactRole;
  size: number;
  sha256: string;
}

export interface VerificationResult {
  ok: boolean;
  target_id?: string;
  evidence_sha256?: string;
  errors: string[];
  summary: string;
}
