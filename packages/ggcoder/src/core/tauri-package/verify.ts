import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverTauriPackages } from "./discover.js";
import { inspectSupportSet } from "./ownership.js";
import { GENERATED_PATHS, canonicalJson, stableJson } from "./paths.js";
import { renderTauriSupport } from "./render.js";
import {
  GENERATED_CONFIG_SCHEMA_VERSION,
  TEMPLATE_VERSION,
  type CalibrationBounds,
  type GeneratedTauriConfig,
  type VerificationResult,
} from "./types.js";

export async function verifyTauriPackage(repositoryRoot: string): Promise<VerificationResult> {
  const errors: string[] = [];
  let parsed: GeneratedTauriConfig | null = null;
  try {
    const content = await readFile(
      path.join(repositoryRoot, ...GENERATED_PATHS[4].split("/")),
      "utf8",
    );
    const value = JSON.parse(content) as unknown;
    parsed = validateConfig(value);
    if (canonicalJson(parsed) !== content)
      errors.push(`${GENERATED_PATHS[4]}: configuration is not canonical JSON`);
  } catch (error) {
    errors.push(`${GENERATED_PATHS[4]}: ${errorMessage(error)}`);
  }

  let targetId: string | undefined;
  let evidenceSha256: string | undefined;
  if (parsed) {
    targetId = parsed.target.target_id;
    evidenceSha256 = parsed.evidence_sha256;
    try {
      const discovery = await discoverTauriPackages(repositoryRoot, parsed.target.host);
      if (discovery.evidence_sha256 !== parsed.evidence_sha256) {
        errors.push("Repository evidence digest is stale");
      }
      const target = discovery.targets.find(
        (candidate) => candidate.target_id === parsed!.target.target_id,
      );
      if (!target)
        errors.push(`Configured target is no longer discoverable: ${parsed.target.target_id}`);
      else if (stableJson(target) !== stableJson(parsed.target))
        errors.push("Configured target differs from deterministic discovery");
      if (stableJson(discovery.evidence.sources) !== stableJson(parsed.sources)) {
        errors.push("Configured source provenance differs from deterministic discovery");
      }
      if (parsed.calibration && parsed.calibration.evidence_sha256 !== discovery.evidence_sha256) {
        errors.push("Calibration is stale for current repository evidence");
      }
      if (target && errors.length === 0) {
        const expected = renderTauriSupport(discovery, target, parsed.calibration);
        const inspection = await inspectSupportSet(repositoryRoot, expected);
        if (inspection.state !== "owned") errors.push(...inspection.conflicts);
      } else {
        const inspection = await inspectSupportSet(repositoryRoot);
        if (inspection.state !== "owned") errors.push(...inspection.conflicts);
      }
    } catch (error) {
      errors.push(`Discovery verification failed: ${errorMessage(error)}`);
    }
  } else {
    try {
      const inspection = await inspectSupportSet(repositoryRoot);
      if (inspection.state !== "owned") errors.push(...inspection.conflicts);
    } catch (error) {
      errors.push(`Support-set verification failed: ${errorMessage(error)}`);
    }
  }

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    target_id: targetId,
    evidence_sha256: evidenceSha256,
    errors: uniqueErrors,
    summary: uniqueErrors.length
      ? `Tauri package verification failed with ${uniqueErrors.length} error${uniqueErrors.length === 1 ? "" : "s"}.`
      : `Verified generated Tauri package support for ${targetId}.`,
  };
}

function validateConfig(value: unknown): GeneratedTauriConfig {
  if (!isObject(value)) throw new Error("configuration must be an object");
  exactKeys(value, [
    "calibration",
    "evidence_sha256",
    "ownership",
    "schema_version",
    "sources",
    "target",
    "template_version",
  ]);
  if (value.schema_version !== GENERATED_CONFIG_SCHEMA_VERSION)
    throw new Error("unsupported configuration schema");
  if (value.template_version !== TEMPLATE_VERSION) throw new Error("unsupported template version");
  if (typeof value.ownership !== "string") throw new Error("missing ownership marker");
  if (typeof value.evidence_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.evidence_sha256)) {
    throw new Error("invalid evidence digest");
  }
  if (!Array.isArray(value.sources) || !isObject(value.target))
    throw new Error("invalid source or target data");
  if (value.calibration !== null) validateCalibration(value.calibration, value.evidence_sha256);
  return value as unknown as GeneratedTauriConfig;
}

function validateCalibration(
  value: unknown,
  evidenceSha256: string,
): asserts value is CalibrationBounds {
  if (!isObject(value)) throw new Error("calibration must be an object or null");
  exactKeys(value, [
    "absolute_growth_bytes",
    "baseline_total_bytes",
    "evidence_sha256",
    "maximum_file_bytes",
    "maximum_total_bytes",
    "percentage_growth",
    "required_paths",
    "role_counts",
    "role_maximum_bytes",
  ]);
  if (value.evidence_sha256 !== evidenceSha256)
    throw new Error("calibration evidence digest is stale");
  for (const field of [
    "absolute_growth_bytes",
    "baseline_total_bytes",
    "maximum_file_bytes",
    "maximum_total_bytes",
    "percentage_growth",
  ]) {
    const item = value[field];
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
      throw new Error(`calibration.${field} must be finite and non-negative`);
    }
  }
  if (
    !Array.isArray(value.required_paths) ||
    value.required_paths.some((item) => typeof item !== "string")
  ) {
    throw new Error("calibration.required_paths must be strings");
  }
  for (const field of ["role_counts", "role_maximum_bytes"]) {
    const roles = value[field];
    if (!isObject(roles)) throw new Error(`calibration.${field} must be an object`);
    exactKeys(roles, ["app", "bundle"]);
    for (const role of ["app", "bundle"]) {
      const item = roles[role];
      if (field === "role_counts" && !Number.isSafeInteger(item)) {
        throw new Error(`calibration.${field}.${role} must be a non-negative safe integer`);
      }
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
        throw new Error(`calibration.${field}.${role} must be finite and non-negative`);
      }
    }
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("configuration has unexpected or missing fields");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
