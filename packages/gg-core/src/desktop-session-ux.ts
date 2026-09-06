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
