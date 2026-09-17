import type { ProgrammaticAssessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import { sha256 } from "../tauri-package/paths.js";
import type { ProgrammaticAssessmentOutcome } from "./assessment.js";
import { loadApprovedProgrammaticProfile } from "./profile.js";
import {
  recommendationCommitUnknown, requireRecommendationHistoryPolicy, updateRecommendationHistory,
  type RecommendationHistoryOptions,
} from "./recommendation-history.js";
import { reconcileRecommendations } from "./recommendations.js";

interface AssessmentHistoryPolicy {
  profileDigest?: string;
  configurationSha256?: string;
  unavailable: boolean;
}

/** Snapshot consent before provider execution. Setup and legacy profiles never authorize a save. */
export async function captureAssessmentHistoryPolicy(cwd: string, mode: "setup" | "configured"): Promise<AssessmentHistoryPolicy> {
  if (mode === "setup") return { unavailable: false };
  try {
    const stored = await loadApprovedProgrammaticProfile(cwd);
    if (stored?.envelope.version === 3 && stored.envelope.historyPolicy.enabled) return {
      profileDigest: sha256(stored.bytes), configurationSha256: stored.envelope.configurationFingerprint.sha256,
      unavailable: false,
    };
    return { unavailable: false };
  } catch { return { unavailable: true }; }
}

/** Host-only completion I/O, shared by session and terminal adapters. Never a model tool.
 * The writer holds profile then history locks and calls assertCurrent synchronously at rename.
 * A save refusal cannot alter scan/assessment status and never repeats assessment work.
 */
export async function saveAssessmentHistory(cwd: string, outcome: ProgrammaticAssessmentOutcome,
  host: { id: string }, policy: AssessmentHistoryPolicy,
  options: Pick<RecommendationHistoryOptions, "signal" | "onFileMutated"> & {
    assertCurrent: () => void;
    validateBeforeSave?: () => Promise<void>;
  },
): Promise<NonNullable<ProgrammaticAssessment["history"]>> {
  if (outcome.assessment.mode === "setup") return { status: "setup-not-saved" };
  if (!policy.profileDigest && !policy.unavailable) return { status: "disabled" };
  try {
    const digest = policy.profileDigest, captured = outcome.captured;
    if (!digest || !captured) throw new Error("History save unavailable.");
    const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent(); };
    assertCurrent();
    const authorize = async (root: string) => {
      assertCurrent();
      await options.validateBeforeSave?.();
      assertCurrent();
      await requireRecommendationHistoryPolicy(root, digest);
    };
    captured.assessment.configurationSha256 = policy.configurationSha256;
    const saved = await updateRecommendationHistory(cwd, authorize,
      (history) => reconcileRecommendations(history, captured).history, {
        signal: options.signal, assertCurrent, onFileMutated: options.onFileMutated,
      });
    return { status: "saved", assessmentId: host.id, historyRevision: saved.history.revision };
  } catch (error) {
    return { status: recommendationCommitUnknown(error) ? "acknowledgement-unknown" : "unsaved",
      assessmentId: host.id, reason: "History saving was not acknowledged. Read saved history before retrying; the assessment and scanner were not retried." };
  }
}
