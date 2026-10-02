import { randomUUID } from "node:crypto";
import { projectDiscovery, type DiscoveryRecord } from "./discovery-projection.js";
import { sha256, stableJson } from "../tauri-package/paths.js";
import { captureRecommendationAssessment, type CapturedRecommendationAssessment } from "./recommendations.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProgrammaticAssessment, ProgrammaticAssessmentDeterministicOutcome } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import { ProgrammaticAdvisoryTools, type ProgrammaticAdvisoryContext } from "./advisory-tools.js";
import { deliveredExternalReceipt, renderAdvisoryResult, type ProgrammaticAdvisoryPolicy } from "./advisory.js";

const text = (value: string) => Array.from(value).filter((character) => {
  const code = character.charCodeAt(0);
  return code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159));
}).join("").slice(0, 4_000).trim() || "Unspecified limitation.";
export interface ProgrammaticAssessmentTurnCompletion {
  status?: "incomplete" | "unavailable";
  /** Supplied only by the deterministic owner, never parsed from advice. */
  scanCounts?: { enabledCount: number; applicableCount: number };
}
export interface ProgrammaticAssessmentOutcome {
  assessment: ProgrammaticAssessment;
  /** Detailed accepted advice belongs in the transcript, not scanner history or approval payloads. */
  advice?: string;
  /** Captured before receipt retirement; never included in the display/event projection. */
  captured?: CapturedRecommendationAssessment;
  /** Session-local accepted records; never serialized as part of assessment events. */
  discoveryRecords?: DiscoveryRecord[];
}

/** One host-selected operation around an existing session turn. No provider, loop,
 * scan implementation, persistence, settings authority or session lifecycle here.
 * Callers prepare context with buildProgrammaticAssessmentContext, install these
 * tools under their existing permission boundary, and restore it in their finally. */
export class ProgrammaticAssessmentCoordinator {
  readonly scope: ProgrammaticAdvisoryTools;
  private started = false;
  private scanCounts: ProgrammaticAssessmentTurnCompletion["scanCounts"];
  /** Deterministic owner records success independently of later turn cancellation. */
  recordScanCounts(counts: ProgrammaticAssessmentTurnCompletion["scanCounts"]): void {
    this.scanCounts = counts && { ...counts };
  }
  constructor(cwd: string, readonly context: ProgrammaticAdvisoryContext, getTools: () => AgentTool[], policy: ProgrammaticAdvisoryPolicy) {
    this.scope = new ProgrammaticAdvisoryTools(cwd, context, getTools, policy);
  }
  async run(
    signal: AbortSignal,
    runTurn?: (scope: ProgrammaticAdvisoryTools, context: ProgrammaticAdvisoryContext) => Promise<ProgrammaticAssessmentTurnCompletion | void>,
    host: { id: string; startedAt: string } = { id: randomUUID(), startedAt: new Date().toISOString() },
  ): Promise<ProgrammaticAssessmentOutcome> {
    if (this.started) throw new Error("Assessment operation is once-only.");
    this.started = true;
    let completion: ProgrammaticAssessmentTurnCompletion = {};
    try {
      signal.throwIfAborted();
      if (runTurn) completion = await runTurn(this.scope, this.context) ?? {};
      else completion.status = "unavailable";
    } catch {
      // Raw provider/OS errors can include credentials or absolute paths.
      completion.status = "incomplete";
      this.scope.turn.limitations.add("The session assessment did not finish; no retry was attempted.");
    } finally {
      this.scope.turn.close();
    }
    const turn = this.scope.turn;
    const accepted = turn.acceptedResult;
    const status = signal.aborted || turn.deterministicState === "cancelled" ? "cancelled"
      : completion.status ?? (accepted ? "completed" : "incomplete");
    const deterministic = this.deterministic(this.scanCounts ?? completion.scanCounts);
    const observations: ProgrammaticAssessment["observations"] = [];
    if (accepted) for (const recommendation of accepted.recommendations) {
      for (const item of recommendation.evidence.items) {
        if (item.basis === "assumed") continue;
        const source = "kind" in item ? deliveredExternalReceipt(turn.evidence.list(), item)?.id : item.source;
        if (!source || source.length > 100) continue;
        observations.push({ basis: item.basis, message: text("kind" in item ? item.claim : item.message), evidenceSources: [source] });
      }
    }
    const coverage: ProgrammaticAssessment["coverage"] = [{ scope: "project", status: "uninspected", summary: "The initial sample does not show that the whole project was checked." }];
    if (turn.evidence.list().some((receipt) => receipt.status === "retrieved" && (receipt.location || receipt.locations?.length)))
      coverage.push({ scope: "project", status: "inspected", summary: "Some local source files were inspected, not the whole project." });
    for (const diagnostic of this.context.evidence?.diagnostics ?? []) coverage.push({
      scope: "project", status: diagnostic.code === "permission-denied" ? "uninspected" : diagnostic.code === "non-text" ? "nonmatching" : diagnostic.code === "unreadable-or-unsafe" || diagnostic.code === "walk-failed" ? "unreadable" : "budget-limited",
      summary: `${{
        "path-limit": "The file list reached its limit",
        "excerpt-limit": "The source sample reached its file limit",
        "excerpt-truncated": "Some source samples were shortened",
        "delivery-limit": "The source sample reached its size limit",
        "unreadable-or-unsafe": "Some files could not be read safely",
        "walk-failed": "Some folders could not be listed",
        "non-text": "Non-text files were skipped",
        "permission-denied": "Permission to inspect some content was denied",
      }[diagnostic.code]} (${diagnostic.count}). This was a sample, not a complete inspection.`,
    });
    coverage.push({ scope: "catalog", status: accepted?.coverage.status === "complete" ? "inspected" : "uninspected", summary: text(accepted?.coverage.status === "limited" ? accepted.coverage.reason : "Checking the command list does not mean the project was fully checked.") });
    const assessment: ProgrammaticAssessment = {
      version: 1, mode: turn.mode, ...(this.context.assessment.focus ? { focus: this.context.assessment.focus } : {}), status,
      summary: {
        completed: "Assessment finished. These are suggestions, not a complete project check. No recommended task has been started.",
        cancelled: "Assessment cancelled. Any saved check results and settings are unchanged by cancellation.",
        incomplete: "Assessment did not finish. Saved check results and settings are separate from these suggestions.",
        unavailable: "Assessment is unavailable. Saved check results and settings are separate from these suggestions.",
      }[status],
      limitations: [...(this.context.evidence?.diagnostics.some((item) => item.code === "permission-denied") ? ["Permission was denied for the initial inspection. The omitted content was not checked."] : []), ...turn.limitations, ...(accepted?.coverage.status === "limited" ? [accepted.coverage.reason] : [])].slice(0, 50).map(text),
      coverage: coverage.slice(0, 50), observations: observations.slice(0, 50), deterministic,
    };
    let discoveryRecords: DiscoveryRecord[] | undefined;
    if (accepted && status === "completed") {
      try {
        const projected = projectDiscovery(host.id, accepted);
        assessment.discovery = projected.projection;
        discoveryRecords = projected.records;
      } catch {
        // Display failure must not discard accepted advice or the independent history capture below.
        assessment.limitations = ["There is too much detail to show for review. Review cannot be opened. Discover opportunities again with a narrower focus.", ...assessment.limitations].slice(0, 50);
      }
    }
    const advice = accepted && status !== "cancelled" ? renderAdvisoryResult(accepted) : undefined;
    let captured: CapturedRecommendationAssessment | undefined;
    try {
      captured = captureRecommendationAssessment(host, assessment, accepted, turn.evidence.list());
      captured.assessment.catalogSha256 = sha256(stableJson(this.context.commands));
    }
    catch { /* Capture/save refusal must not change assessment or scanner success. */ }
    this.scope.close();
    return { assessment, ...(advice ? { advice } : {}), ...(captured ? { captured } : {}), ...(discoveryRecords ? { discoveryRecords } : {}) };
  }
  private deterministic(counts?: ProgrammaticAssessmentTurnCompletion["scanCounts"]): ProgrammaticAssessmentDeterministicOutcome {
    const turn = this.scope.turn;
    if (turn.mode === "setup") return { status: "not-run", reason: "setup" };
    const state = turn.deterministicState;
    if (state === "succeeded" && counts && Number.isSafeInteger(counts.enabledCount) && Number.isSafeInteger(counts.applicableCount) && counts.enabledCount >= 0 && counts.enabledCount <= 64 && counts.applicableCount >= 0 && counts.applicableCount <= counts.enabledCount)
      return { status: "succeeded", ...counts };
    if (state === "failed" || state === "denied" || state === "cancelled") return { status: state, reason: {
      failed: "Saved checks failed. No retry was attempted.",
      denied: "Permission to run saved checks was denied. No retry was attempted.",
      cancelled: "Saved checks were cancelled. No retry was attempted.",
    }[state] };
    return { status: "unavailable", reason: state === "succeeded" ? "Saved checks finished, but their result counts are missing. A success count cannot be shown." : "No saved check result is available. Suggestions do not prove that checks passed." };
  }
}
