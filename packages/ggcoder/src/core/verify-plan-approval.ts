// Per-descriptor consent to run a project's verify-plan command; see docs/harness-checks.md "Plan source".
import { createHash } from "node:crypto";
import path from "node:path";

export interface VerifyPlanApproval {
  /** Resolved absolute session cwd the approval was given in. */
  project: string;
  /** sha256 hex of the exact descriptor text that was shown and approved. */
  descriptorSha256: string;
}

export function verifyPlanDescriptorSha256(descriptorText: string): string {
  return createHash("sha256").update(descriptorText, "utf8").digest("hex");
}

export function verifyPlanApproval(cwd: string, descriptorText: string): VerifyPlanApproval {
  return {
    project: path.resolve(cwd),
    descriptorSha256: verifyPlanDescriptorSha256(descriptorText),
  };
}

/** Never consults MCP trust: only an approval of this exact text counts. */
export function isVerifyPlanApprovedIn(
  approvals: readonly VerifyPlanApproval[],
  cwd: string,
  descriptorText: string,
): boolean {
  const wanted = verifyPlanApproval(cwd, descriptorText);
  return approvals.some(
    (entry) =>
      entry.project === wanted.project && entry.descriptorSha256 === wanted.descriptorSha256,
  );
}

/** Keeps the first of each project/hash pair, in order. */
export function mergeVerifyPlanApprovals(
  approvals: readonly VerifyPlanApproval[],
  added: VerifyPlanApproval,
): VerifyPlanApproval[] {
  const merged: VerifyPlanApproval[] = [];
  for (const entry of [...approvals, added]) {
    if (
      !merged.some(
        (kept) =>
          kept.project === entry.project && kept.descriptorSha256 === entry.descriptorSha256,
      )
    )
      merged.push({ project: entry.project, descriptorSha256: entry.descriptorSha256 });
  }
  return merged;
}

const SHA256 = /^[a-f0-9]{64}$/;

/** Read approvals from untrusted settings JSON, dropping malformed entries. */
export function parseVerifyPlanApprovals(value: unknown): VerifyPlanApproval[] {
  if (!Array.isArray(value)) return [];
  const approvals: VerifyPlanApproval[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const { project, descriptorSha256 } = entry as Record<string, unknown>;
    if (typeof project !== "string" || project.length === 0) continue;
    if (typeof descriptorSha256 !== "string" || !SHA256.test(descriptorSha256)) continue;
    approvals.push({ project, descriptorSha256 });
  }
  return approvals;
}
