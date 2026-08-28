import type http from "node:http";
import {
  AppSidecarJsonBodyError,
  isExactRecord,
  readJsonBody,
  requestPathname,
} from "./app-sidecar-http-json.js";
import {
  isManualCompletionApprovalCommitRequest,
  isManualCompletionApprovalPreviewRequest,
  type ManualCompletionApprovalCommitOutcome,
  type ManualCompletionApprovalPreviewOutcome,
} from "@kenkaiiii/gg-core/manual-completion-approval-protocol";
import type { ProjectNotesStorageDiagnostics } from "@kenkaiiii/gg-core/project-notes-diagnostics";
import type { ManualCompletionApprovalService } from "./app-sidecar-manual-completion-approval.js";
import type { StorageDiagnosticsSessionContext } from "./app-sidecar-storage-diagnostics.js";
import {
  type NotesValidationError,
  type ProjectNotesLoadOutcome,
  type ProjectNotesMigrationOutcome,
  type ProjectNotesRepository,
  type ProjectNotesRoadmapBlockerResolutionOutcome,
  type ProjectNotesRoadmapBlockerResolutionRequest,
  type ProjectNotesSaveOutcome,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";

export const NOTES_REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;

export interface AppSidecarNotesHandlerOptions {
  repository: Pick<ProjectNotesRepository, "load" | "migrate" | "save" | "resolveRoadmapBlocker">;
  diagnostics: {
    inspect(context: StorageDiagnosticsSessionContext): Promise<ProjectNotesStorageDiagnostics>;
  };
  manualCompletionApproval: ManualCompletionApprovalService;
  onCommittedSnapshot(snapshot: ProjectNotesSnapshot): void;
  onError?: (error: unknown) => void;
}

export interface AppSidecarNotesHandler {
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: StorageDiagnosticsSessionContext,
    requestUrl: string,
    method: string,
  ): boolean;
}

type InvalidResponse = { status: "invalid"; error: NotesValidationError };
type ErrorResponse = { status: "error"; message: "notes request failed" };

export function createAppSidecarNotesHandler(
  options: AppSidecarNotesHandlerOptions,
): AppSidecarNotesHandler {
  const { repository, diagnostics, manualCompletionApproval, onCommittedSnapshot, onError } =
    options;

  return {
    handle(req, res, context, requestUrl, method) {
      const pathname = requestPathname(requestUrl);
      const isNotesRoute =
        pathname === "/notes" ||
        pathname === "/notes/diagnostics" ||
        pathname === "/notes/roadmap/completion-approval/preview" ||
        pathname === "/notes/roadmap/completion-approval/commit" ||
        pathname === "/notes/migrate" ||
        pathname === "/notes/roadmap/blocker-resolution";
      if (!isNotesRoute) return false;

      if (method === "POST" && pathname === "/notes/roadmap/completion-approval/preview") {
        void readJsonBody(req, NOTES_REQUEST_BODY_MAX_BYTES)
          .then((body) => {
            if (!isManualCompletionApprovalPreviewRequest(body)) {
              sendJson(res, 400, { status: "invalid-request" });
              return;
            }
            return manualCompletionApproval
              .preview(body, {
                getState: () => ({ cwd: context.cwd, ...context.currentSession }),
              })
              .then((outcome) => sendJson(res, manualApprovalStatus(outcome), outcome));
          })
          .catch((error) => sendUnexpectedError(res, error, onError));
        return true;
      }

      if (method === "POST" && pathname === "/notes/roadmap/completion-approval/commit") {
        void readJsonBody(req, NOTES_REQUEST_BODY_MAX_BYTES)
          .then((body) => {
            if (!isManualCompletionApprovalCommitRequest(body)) {
              sendJson(res, 400, { status: "invalid-request" });
              return;
            }
            return manualCompletionApproval
              .commit(body)
              .then((outcome) => sendJson(res, manualApprovalStatus(outcome), outcome));
          })
          .catch((error) => sendUnexpectedError(res, error, onError));
        return true;
      }

      if (method === "GET" && pathname === "/notes/diagnostics") {
        void diagnostics
          .inspect(context)
          .then((outcome) => sendJson(res, 200, outcome))
          .catch((error) => sendUnexpectedError(res, error, onError));
        return true;
      }

      if (method === "GET" && pathname === "/notes") {
        void repository
          .load(context.cwd)
          .then((outcome) => sendLoadOutcome(res, outcome))
          .catch((error) => sendUnexpectedError(res, error, onError));
        return true;
      }

      if (method === "POST" && pathname === "/notes/migrate") {
        void readJsonBody(req, NOTES_REQUEST_BODY_MAX_BYTES)
          .then(async (body) => {
            if (!isMigrationBody(body)) {
              sendJson(res, 400, invalidBody());
              return;
            }
            const outcome = await repository.migrate(context.cwd, body.document);
            if (outcome.status === "ok" && outcome.migrated) {
              onCommittedSnapshot(outcome.snapshot);
            }
            sendMigrationOutcome(res, outcome);
          })
          .catch((error) => sendBodyReadError(res, error, onError));
        return true;
      }

      if (method === "POST" && pathname === "/notes/roadmap/blocker-resolution") {
        void readJsonBody(req, NOTES_REQUEST_BODY_MAX_BYTES)
          .then(async (body) => {
            if (!isBlockerResolutionBody(body)) {
              sendJson(res, 400, invalidBody());
              return;
            }
            const outcome = await repository.resolveRoadmapBlocker(context.cwd, body);
            if (outcome.status === "committed") onCommittedSnapshot(outcome.snapshot);
            sendBlockerResolutionOutcome(res, outcome);
          })
          .catch((error) => sendBodyReadError(res, error, onError));
        return true;
      }

      if (method === "PUT" && pathname === "/notes") {
        void readJsonBody(req, NOTES_REQUEST_BODY_MAX_BYTES)
          .then(async (body) => {
            if (!isSaveBody(body)) {
              sendJson(res, 400, invalidBody());
              return;
            }
            const outcome = await repository.save(
              context.cwd,
              body.expectedRevision,
              body.document,
            );
            if (outcome.status === "ok") {
              onCommittedSnapshot(outcome.snapshot);
            }
            sendSaveOutcome(res, outcome);
          })
          .catch((error) => sendBodyReadError(res, error, onError));
        return true;
      }

      sendJson(res, 405, { status: "invalid", reason: "method-not-allowed" });
      return true;
    },
  };
}

function sendLoadOutcome(res: http.ServerResponse, outcome: ProjectNotesLoadOutcome): void {
  sendJson(res, outcome.status === "corrupt" ? 409 : 200, outcome);
}

function sendMigrationOutcome(
  res: http.ServerResponse,
  outcome: ProjectNotesMigrationOutcome,
): void {
  const status = outcome.status === "invalid" ? 400 : outcome.status === "corrupt" ? 409 : 200;
  sendJson(res, status, outcome);
}

function sendBlockerResolutionOutcome(
  res: http.ServerResponse,
  outcome: ProjectNotesRoadmapBlockerResolutionOutcome,
): void {
  const status =
    outcome.status === "missing" || outcome.status === "phase-not-found"
      ? 404
      : outcome.status === "stale-revision" ||
          outcome.status === "stale-session" ||
          outcome.status === "duplicate-id-conflict" ||
          outcome.status === "corrupt"
        ? 409
        : 200;
  sendJson(res, status, outcome);
}

function sendSaveOutcome(res: http.ServerResponse, outcome: ProjectNotesSaveOutcome): void {
  const status =
    outcome.status === "invalid"
      ? 400
      : outcome.status === "missing"
        ? 404
        : outcome.status === "conflict" || outcome.status === "corrupt"
          ? 409
          : 200;
  sendJson(res, status, outcome);
}

function isMigrationBody(value: unknown): value is { document: unknown } {
  return isExactRecord(value, ["document"]);
}

function isBlockerResolutionBody(
  value: unknown,
): value is ProjectNotesRoadmapBlockerResolutionRequest {
  if (
    !isExactRecord(value, [
      "resolutionId",
      "phaseId",
      "blockerUpdateId",
      "expectedRevision",
      "expectedSession",
      "resolver",
      "timestamp",
    ])
  ) {
    return false;
  }
  const session = value.expectedSession;
  return (
    typeof value.resolutionId === "string" &&
    value.resolutionId.length > 0 &&
    typeof value.phaseId === "string" &&
    value.phaseId.length > 0 &&
    typeof value.blockerUpdateId === "string" &&
    value.blockerUpdateId.length > 0 &&
    Number.isInteger(value.expectedRevision) &&
    (value.expectedRevision as number) >= 0 &&
    (session === null ||
      (isExactRecord(session, ["sessionId", "sessionPath"]) &&
        typeof session.sessionId === "string" &&
        session.sessionId.length > 0 &&
        (session.sessionPath === null ||
          (typeof session.sessionPath === "string" && session.sessionPath.length > 0)))) &&
    value.resolver === "user" &&
    typeof value.timestamp === "string" &&
    Number.isFinite(Date.parse(value.timestamp))
  );
}

function isSaveBody(value: unknown): value is { expectedRevision: number; document: unknown } {
  return (
    isExactRecord(value, ["expectedRevision", "document"]) &&
    Number.isInteger(value.expectedRevision) &&
    (value.expectedRevision as number) >= 0
  );
}

function invalidBody(): InvalidResponse {
  return { status: "invalid", error: { path: "$", message: "invalid request body" } };
}

function malformedJson(): InvalidResponse {
  return { status: "invalid", error: { path: "$", message: "malformed JSON request body" } };
}

function requestBodyTooLarge(): InvalidResponse {
  return {
    status: "invalid",
    error: {
      path: "$",
      message: `notes request body exceeds ${NOTES_REQUEST_BODY_MAX_BYTES} bytes`,
    },
  };
}

function sendBodyReadError(
  res: http.ServerResponse,
  error: unknown,
  onError: ((error: unknown) => void) | undefined,
): void {
  if (error instanceof AppSidecarJsonBodyError && error.kind === "malformed") {
    sendJson(res, 400, malformedJson());
  } else if (error instanceof AppSidecarJsonBodyError && error.kind === "too-large") {
    sendJson(res, 413, requestBodyTooLarge());
  } else {
    sendUnexpectedError(res, error, onError);
  }
}

function manualApprovalStatus(
  outcome: ManualCompletionApprovalPreviewOutcome | ManualCompletionApprovalCommitOutcome,
): number {
  switch (outcome.status) {
    case "ready":
    case "committed":
    case "duplicate":
      return 200;
    case "missing":
    case "nonce-not-found":
      return 404;
    case "nonce-expired":
      return 410;
    case "corrupt":
      return 500;
    default:
      return 409;
  }
}

function sendUnexpectedError(
  res: http.ServerResponse,
  error: unknown,
  onError: ((error: unknown) => void) | undefined,
): void {
  onError?.(error);
  const body: ErrorResponse = { status: "error", message: "notes request failed" };
  sendJson(res, 500, body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}
