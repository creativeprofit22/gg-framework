import { invoke } from "@tauri-apps/api/core";
import type { SafeTauriUnlisten } from "./tauri-listener";
import { listenAppWindow } from "./agent-window-listener";

export interface LocalPatchedUpdateEvent {
  type: "started" | "line" | "completed" | "error";
  message?: string;
  line?: string;
  stream?: "stdout" | "stderr";
  exitCode?: number | null;
  /** Windows completed events report the validated installer handoff outcome. */
  disposition?: "install-scheduled" | "existing-and-verified";
  /** Non-Windows completed events supply installerPath/opened instead of disposition. */
  installerPath?: string | null;
  /** Non-Windows result: whether the installer, its folder, or neither was opened. */
  opened?: "installer" | "folder" | "none";
}

export type LocalPatchedUpdateStatusOrigin = "fresh" | "cached" | "unavailable";

export type DecisionOutcome = "kept-local" | "adopted-upstream" | "combined" | "unresolved";

export interface VerifiedDecisionRecord {
  id: string;
  date: string;
  summary: {
    text: string;
    source: "agent" | "fallback";
    generatedAt: string;
  };
  verification: { workflowVerified: true; checks?: "passed" | "not-recorded" };
  decisions: Array<{
    area: string;
    outcome: DecisionOutcome;
    files: Array<{ path: string }>;
  }>;
}

const DECISION_OUTCOMES: DecisionOutcome[] = [
  "kept-local",
  "adopted-upstream",
  "combined",
  "unresolved",
];

function isVerifiedDecisionRecord(value: unknown): value is VerifiedDecisionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<VerifiedDecisionRecord>;
  const summary = record.summary;
  const summaryCharacters = typeof summary?.text === "string" ? Array.from(summary.text) : [];
  const summaryLength = summaryCharacters.length;
  const validSummary =
    !!summary &&
    Object.keys(summary).length === 3 &&
    summaryLength >= 40 &&
    summaryLength <= 500 &&
    summary.text.trim() === summary.text &&
    !summaryCharacters.some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    !summary.text.includes("```") &&
    (summary.source === "agent" || summary.source === "fallback") &&
    typeof summary.generatedAt === "string" &&
    Number.isFinite(Date.parse(summary.generatedAt));
  return (
    typeof record.id === "string" &&
    validSummary &&
    /^\d{4}-\d{2}-\d{2}$/.test(record.date ?? "") &&
    record.verification?.workflowVerified === true &&
    (!Object.prototype.hasOwnProperty.call(record.verification, "checks") ||
      record.verification.checks === "passed" ||
      record.verification.checks === "not-recorded") &&
    Array.isArray(record.decisions) &&
    record.decisions.every(
      (decision) =>
        typeof decision?.area === "string" &&
        DECISION_OUTCOMES.includes(decision.outcome) &&
        Array.isArray(decision.files) &&
        decision.files.every((file) => typeof file?.path === "string"),
    )
  );
}

export async function getVerifiedDecisions(repoRoot: string): Promise<VerifiedDecisionRecord[]> {
  const records = await invoke<unknown>("app_verified_decisions", { repoRoot });
  if (!Array.isArray(records) || !records.every(isVerifiedDecisionRecord)) {
    throw new Error("invalid decisions response");
  }
  return records;
}

export interface LocalPatchedUpdateStatus {
  available: boolean;
  currentSourceSha: string;
  upstreamIntegrated: boolean;
  origin: LocalPatchedUpdateStatusOrigin;
}

export async function checkLocalPatchedUpdate(
  repoRoot: string,
  builtGitSha: string,
): Promise<LocalPatchedUpdateStatus> {
  const status = await invoke<LocalPatchedUpdateStatus>("app_local_patched_update_status", {
    repoRoot,
    builtGitSha,
  });
  if (
    !status ||
    typeof status.available !== "boolean" ||
    typeof status.currentSourceSha !== "string" ||
    typeof status.upstreamIntegrated !== "boolean" ||
    !["fresh", "cached", "unavailable"].includes(status.origin)
  ) {
    throw new Error("invalid local update response");
  }
  return status;
}

export async function startLocalPatchedUpdate(
  repoRoot: string,
  summarizeDecisions = false,
): Promise<void> {
  await invoke("app_local_patched_update_start", { repoRoot, summarizeDecisions });
}

export async function listenLocalPatchedUpdate(
  onEvent: (event: LocalPatchedUpdateEvent) => void,
): Promise<SafeTauriUnlisten> {
  return listenAppWindow<LocalPatchedUpdateEvent>("local-patched-update", (event) => {
    onEvent(event.payload);
  });
}
