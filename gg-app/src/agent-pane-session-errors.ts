import type { NotesPromptSaveResult, NotesValidationError } from "./notes-types";
import type { KenPromptActionResult, KenPromptSavePreview } from "./ken-prompt-actions";

export const SESSION_RESET_TIMEOUT_MS = 8_000;
export const AUTOPILOT_NEW_SESSION_RETRY_MESSAGE =
  "Ken is reviewing this session. Wait for the review to finish or cancel it, then try again.";
export const AMBIGUOUS_NEW_SESSION_MESSAGE =
  "Couldn’t confirm which session is active. Reopen this project before sending the prompt.";

export class SessionResetConfirmationTimeoutError extends Error {
  constructor(readonly operationId: string) {
    super("Timed out waiting for the matching new-session confirmation.");
    this.name = "SessionResetConfirmationTimeoutError";
  }
}

export class LocalSessionMutationBusyError extends Error {
  constructor() {
    super("A session change is already in progress.");
    this.name = "LocalSessionMutationBusyError";
  }
}

function isNotesRequestBodyTooLarge(error: NotesValidationError | undefined): boolean {
  return error?.path === "$" && /^notes request body exceeds \d+ bytes$/.test(error.message.trim());
}

export function taskErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function notesPromptActionResult(
  result: NotesPromptSaveResult,
  latestPreview?: KenPromptSavePreview,
): KenPromptActionResult {
  if (result.status === "committed") {
    return { status: "saved", phaseId: result.phaseId, title: result.title };
  }
  if (result.status === "replacement-conflict") {
    return {
      status: "failed",
      action: "commit-save",
      message: `${result.title} changed in another window. Review the latest destination before replacing it.`,
      preview: latestPreview,
    };
  }
  if (result.status === "missing-phase") {
    return {
      status: "failed",
      action: "commit-save",
      message: "That phase was removed in another window. Choose another destination.",
      preview: latestPreview,
    };
  }
  if (result.status === "archived-phase") {
    return {
      status: "failed",
      action: "commit-save",
      message: `${result.title} was archived in another window. Restore it or choose another destination.`,
      preview: latestPreview,
    };
  }
  if (result.reason === "invalid") {
    const message = isNotesRequestBodyTooLarge(result.error)
      ? "Project Notes is too large to save. Shorten the saved prompt or Notes document, then try again."
      : result.error
        ? `Project Notes rejected this save (${result.error.path}: ${result.error.message}). Review the Notes content and try again.`
        : "Project Notes rejected this prompt. Review the title and try again.";
    return { status: "failed", action: "commit-save", message, preview: latestPreview };
  }
  const messages = {
    missing: "Project Notes storage is missing. Reopen the project and try again.",
    corrupt: "Project Notes are unreadable. Repair or restore project storage first.",
    unavailable: "Project Notes are unavailable. Check the sidecar and try again.",
    storage: "Local Notes storage failed. Free space and try again.",
  } as const;
  return {
    status: "failed",
    action: "commit-save",
    message: messages[result.reason],
    preview: latestPreview,
  };
}
