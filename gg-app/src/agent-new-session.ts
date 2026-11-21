/** Successful fresh-session creation, correlated with its reset event. */
export interface NewSessionResult {
  operationId: string;
}

export type NewSessionFailureKind = "creation-rejected" | "outcome-unknown";

/** Typed distinction between an HTTP rejection and an indeterminate transport outcome. */
export class NewSessionError extends Error {
  constructor(
    readonly kind: NewSessionFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NewSessionError";
  }
}

export function asNewSessionError(error: unknown): NewSessionError {
  let candidate: unknown = error;
  if (typeof error === "string") {
    try {
      candidate = JSON.parse(error);
    } catch {
      candidate = null;
    }
  }
  if (typeof candidate === "object" && candidate !== null) {
    const value = candidate as { kind?: unknown; message?: unknown; status?: unknown };
    if (
      (value.kind === "creation-rejected" || value.kind === "outcome-unknown") &&
      typeof value.message === "string"
    ) {
      return new NewSessionError(
        value.kind,
        value.message,
        typeof value.status === "number" ? value.status : undefined,
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new NewSessionError("outcome-unknown", message);
}

export function requireNewSessionResult(value: unknown): NewSessionResult {
  const operationId =
    typeof value === "object" && value !== null
      ? (value as { operationId?: unknown }).operationId
      : undefined;
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new Error("invalid new-session response: missing operationId");
  }
  return { operationId };
}
