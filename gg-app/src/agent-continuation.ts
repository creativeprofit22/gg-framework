import type {
  ContinuationAcceptedEvent,
  ContinuationCommitRequest,
  ContinuationCommitResponse,
  ContinuationDestination,
  ContinuationPrepareResponse,
} from "@kenkaiiii/gg-core/desktop-session-ux";
import type { ContinuationHandoffResponse } from "./agent";

const CONTINUATION_HANDOFF_PROMPT_MAX_CHARS = 24_000;

export function requireContinuationHandoffResponse(value: unknown): ContinuationHandoffResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid continuation-handoff response");
  }
  const response = value as Record<string, unknown>;
  // Native HTTP forwarding can return an error body instead of rejecting IPC.
  if (nonemptyString(response.error)) {
    throw new Error(nonemptyString(response.message) ? response.message : response.error);
  }
  if (
    !nonemptyString(response.preparedId) ||
    !recordValue(response.source) ||
    !nonemptyString(response.source.conversationId) ||
    !nonemptyString(response.source.sessionId) ||
    !(response.source.leafId === null || nonemptyString(response.source.leafId)) ||
    !nonemptyString(response.source.fingerprint) ||
    typeof response.expiresAt !== "number" ||
    !Number.isFinite(response.expiresAt) ||
    response.version !== 1 ||
    typeof response.prompt !== "string" ||
    !response.prompt.trim() ||
    response.prompt.length > CONTINUATION_HANDOFF_PROMPT_MAX_CHARS
  ) {
    throw new Error("invalid continuation-handoff response");
  }
  return response as unknown as ContinuationPrepareResponse;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function validDestination(value: unknown): value is ContinuationDestination {
  return (
    recordValue(value) &&
    nonemptyString(value.conversationId) &&
    nonemptyString(value.sessionId) &&
    (value.profile === "stable" || value.profile === "experimental")
  );
}
export function requireContinuationAcceptedEvent(value: unknown): ContinuationAcceptedEvent {
  if (
    !recordValue(value) ||
    !nonemptyString(value.operationId) ||
    !nonemptyString(value.preparedId) ||
    !validDestination(value.destination) ||
    !nonemptyString(value.acceptedMessageId) ||
    !nonemptyString(value.prompt) ||
    value.kenSent !== true
  )
    throw new Error("invalid continuation accepted event");
  return value as unknown as ContinuationAcceptedEvent;
}
export function requireContinuationCommitResponse(
  value: unknown,
  request: ContinuationCommitRequest,
): ContinuationCommitResponse {
  if (
    !recordValue(value) ||
    value.operationId !== request.operationId ||
    value.preparedId !== request.preparedId ||
    typeof value.resetAttempted !== "boolean" ||
    (value.destination !== undefined && !validDestination(value.destination)) ||
    (value.selectedProfile !== undefined &&
      value.selectedProfile !== "stable" &&
      value.selectedProfile !== "experimental") ||
    ["recoveryPrompt", "error", "message", "acceptedMessageId"].some(
      (key) => value[key] !== undefined && !nonemptyString(value[key]),
    )
  ) {
    throw new Error("invalid continuation commit response");
  }
  const accepted =
    value.outcome === "accepted" &&
    value.accepted === true &&
    value.resetAttempted === true &&
    validDestination(value.destination) &&
    (!request.profile || value.destination.profile === request.profile) &&
    nonemptyString(value.acceptedMessageId);
  const rejected =
    value.outcome === "rejected" &&
    value.accepted === false &&
    value.resetAttempted === false &&
    value.destination === undefined &&
    value.acceptedMessageId === undefined;
  const partial =
    value.outcome === "partial" &&
    (value.accepted === false || value.accepted === null) &&
    value.resetAttempted === true &&
    value.acceptedMessageId === undefined;
  const unknown =
    value.outcome === "outcome-unknown" &&
    value.accepted === null &&
    value.acceptedMessageId === undefined;
  if (!(accepted || rejected || partial || unknown))
    throw new Error("inconsistent continuation commit response");
  return value as unknown as ContinuationCommitResponse;
}
