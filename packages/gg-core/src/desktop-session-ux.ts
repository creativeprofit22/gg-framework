/** Preserve saved-image warnings verbatim in both live and restored transcripts. */
export function extractImageWarnings(text: string): string {
  if (/^Partial completion: saved \d+ of \d+ requested images\./.test(text)) return text;
  return text.split("\n").filter((line) => line.startsWith("WARNING: Image saved,")).join("\n");
}

/** Definite pre-execution rejection; all other prompt failures remain unknown. */
export interface PromptSubmissionRejection {
  category: "rejected";
  code: "invalid_programmatic_selection" | "programmatic_execution_busy" | "programmatic_execution_plan_mode";
  message: string;
}

export function isPromptSubmissionRejection(value: unknown): value is PromptSubmissionRejection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  return failure.category === "rejected" && typeof failure.code === "string" &&
    ["invalid_programmatic_selection", "programmatic_execution_busy", "programmatic_execution_plan_mode"].includes(failure.code) &&
    typeof failure.message === "string" && failure.message.trim().length > 0 &&
    failure.message.length <= 256 &&
    Array.from(failure.message).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

/** Display-only prompt hints. Never put these fields in model messages. */
export type PromptSegment =
  | { kind: "text"; text: string }
  | { kind: "term"; text: string; original: string; note?: string };

export interface PromptMeta {
  kenSent?: boolean;
  enhancements?: PromptSegment[];
}

/** Copy only supported fields at the desktop boundary; malformed highlights are ignored. */
export function normalizePromptMeta(value: unknown): PromptMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const meta: PromptMeta = {};
  if (input.kenSent === true) meta.kenSent = true;
  if (Array.isArray(input.enhancements)) {
    const segments: PromptSegment[] = [];
    for (const value of input.enhancements) {
      if (!value || typeof value !== "object" || typeof value.text !== "string") break;
      if (value.kind === "text") segments.push({ kind: "text", text: value.text });
      else if (value.kind === "term" && typeof value.original === "string" &&
        (value.note === undefined || typeof value.note === "string")) {
        segments.push({ kind: "term", text: value.text, original: value.original,
          ...(value.note !== undefined ? { note: value.note } : {}) });
      } else break;
    }
    if (segments.length === input.enhancements.length) meta.enhancements = segments;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** Durable run-journal vocabulary, shared by terminal transports. */
export type RunOutcome = "completed" | "failed" | "aborted" | "unverified";
export type RunEndOutcome = Exclude<RunOutcome, "aborted"> | "cancelled";

export interface RunEndPayload {
  outcome: RunEndOutcome;
  runState: "idle" | "running" | "cancelling";
  cancelled?: true;
  unverified?: true;
}

/** Keep old clients compatible without labelling provider failures Unverified. */
export function createRunEndPayload(
  outcome: RunOutcome,
  runState: RunEndPayload["runState"],
): RunEndPayload {
  return {
    outcome: outcome === "aborted" ? "cancelled" : outcome,
    ...(outcome === "aborted" ? { cancelled: true as const } : {}),
    ...(outcome === "unverified" ? { unverified: true as const } : {}),
    runState,
  };
}

/** Explicit outcomes win; only absent outcomes use the legacy flags. */
export function resolveRunEndOutcome(data: Record<string, unknown>): RunEndOutcome {
  switch (data.outcome) {
    case "completed":
    case "failed":
    case "cancelled":
    case "unverified":
      return data.outcome;
    case undefined:
      return data.cancelled === true ? "cancelled" : data.unverified === true ? "unverified" : "completed";
    default:
      return "failed";
  }
}

/** Host settlement of one question, independent of parent run boundaries. */
export interface AskUserSettledEvent {
  id: string;
  action: "answer" | "cancel";
}

export function isAskUserSettledEvent(value: unknown): value is AskUserSettledEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === "string" && event.id.length > 0 &&
    (event.action === "answer" || event.action === "cancel");
}

/** Successful /ask acknowledgement; absence of this is never authorization. */
export interface AskUserAcknowledgement {
  ok: true;
}

export function requireAskUserAcknowledgement(value: unknown): AskUserAcknowledgement {
  if (value && typeof value === "object" && "ok" in value && value.ok === true && !("error" in value)) {
    return { ok: true };
  }
  throw new Error("The question answer was not acknowledged.");
}

/** Interactive mentor authority; never inferred from drafts, models or run events. */
export interface KenTarget {
  conversationId: string;
  activationEpoch: string;
}
export interface KenRunIdentity extends KenTarget {
  runId: string;
}
/** Ordered authoritative state, carried by initial/ready/extras/reset payloads. */
export interface KenState extends KenTarget {
  activeRunId: string | null;
}
export interface KenEventMetadata {
  ken: KenRunIdentity;
}

/** Authoritative permission to change context mode before a conversation starts. */
export type OpenAICodexContextProfileEligibility =
  | { canChange: true }
  | { canChange: false; reason: string };

/** Session UX authority carried by initial state and context extras. */
export interface DesktopSessionUXState {
  openAICodexContextProfileEligibility: OpenAICodexContextProfileEligibility;
  /** Last completed explicit reset; recovery must match both operation and current identity. */
  lastNewSessionReset?: {
    operationId: string;
    conversationId: string;
    sessionId: string;
  };
}

export interface ContinuationSourceRevision {
  conversationId: string;
  sessionId: string;
  leafId: string | null;
  fingerprint: string;
}

/** Raw JavaScript string length (UTF-16 code units), not bytes or code points. */
export const CONTINUATION_NEXT_INSTRUCTION_MAX_CHARS = 8_000;

/** Validate without changing the instruction that will be submitted. */
export function continuationInstructionError(instruction: string): string | null {
  const length = instruction.length;
  const limit = CONTINUATION_NEXT_INSTRUCTION_MAX_CHARS;
  if (!instruction.trim()) {
    return `Enter a nonblank continuation instruction (current length: ${length} UTF-16 units; maximum: ${limit}).`;
  }
  if (length > limit) {
    return `Shorten the continuation instruction from ${length} to at most ${limit} UTF-16 units (remove at least ${length - limit}). Nothing has been truncated.`;
  }
  return null;
}

export interface ContinuationPrepareResponse {
  version: 1;
  preparedId: string;
  source: ContinuationSourceRevision;
  expiresAt: number;
  /** Display/recovery only. Commit never accepts this text from the client. */
  prompt: string;
}

export interface ContinuationCommitRequest {
  preparedId: string;
  operationId: string;
  profile?: "stable" | "experimental";
}

export interface ContinuationDestination {
  conversationId: string;
  sessionId: string;
  profile: "stable" | "experimental";
}

export interface ContinuationAcceptedEvent {
  operationId: string;
  preparedId: string;
  destination: ContinuationDestination;
  acceptedMessageId: string;
  prompt: string;
  kenSent: true;
}

interface ContinuationCommitResponseBase {
  operationId: string;
  preparedId: string;
  selectedProfile?: "stable" | "experimental";
  recoveryPrompt?: string;
  error?: string;
  message?: string;
}

export type ContinuationCommitResponse = ContinuationCommitResponseBase & (
  | { outcome: "accepted"; accepted: true; resetAttempted: true;
      destination: ContinuationDestination; acceptedMessageId: string }
  | { outcome: "rejected"; accepted: false; resetAttempted: false;
      destination?: never; acceptedMessageId?: never }
  | { outcome: "partial"; accepted: false | null; resetAttempted: true;
      destination?: ContinuationDestination; acceptedMessageId?: never }
  | { outcome: "outcome-unknown"; accepted: null; resetAttempted: boolean;
      destination?: ContinuationDestination; acceptedMessageId?: never }
);
