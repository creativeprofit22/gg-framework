import type http from "node:http";
import {
  canonicalProjectKey,
  type NotesValidationError,
  type ProjectNotesLoadOutcome,
  type ProjectNotesMigrationOutcome,
  type ProjectNotesRepository,
  type ProjectNotesSaveOutcome,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";

export const NOTES_REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;

export interface AppSidecarNotesSession {
  cwd: string;
  broadcastNotesChange(snapshot: ProjectNotesSnapshot): void;
}

export interface AppSidecarNotesSessions {
  values(): Iterable<AppSidecarNotesSession>;
}

export interface AppSidecarNotesHandlerOptions {
  repository: Pick<ProjectNotesRepository, "load" | "migrate" | "save">;
  sessions: AppSidecarNotesSessions;
  onError?: (error: unknown) => void;
}

export interface AppSidecarNotesHandler {
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: AppSidecarNotesSession,
    requestUrl: string,
    method: string,
  ): boolean;
}

type InvalidResponse = { status: "invalid"; error: NotesValidationError };
type ErrorResponse = { status: "error"; message: "notes request failed" };

export function createAppSidecarNotesHandler(
  options: AppSidecarNotesHandlerOptions,
): AppSidecarNotesHandler {
  const { repository, sessions, onError } = options;

  return {
    handle(req, res, context, requestUrl, method) {
      const pathname = requestPathname(requestUrl);
      const isNotesRoute = pathname === "/notes" || pathname === "/notes/migrate";
      if (!isNotesRoute) return false;

      if (method === "GET" && pathname === "/notes") {
        void repository
          .load(context.cwd)
          .then((outcome) => sendLoadOutcome(res, outcome))
          .catch((error) => sendUnexpectedError(res, error, onError));
        return true;
      }

      if (method === "POST" && pathname === "/notes/migrate") {
        void readJsonBody(req)
          .then(async (body) => {
            if (!isMigrationBody(body)) {
              sendJson(res, 400, invalidBody());
              return;
            }
            const outcome = await repository.migrate(context.cwd, body.document);
            if (outcome.status === "ok" && outcome.migrated) {
              broadcastSnapshot(sessions, outcome.snapshot);
            }
            sendMigrationOutcome(res, outcome);
          })
          .catch((error) => sendBodyReadError(res, error, onError));
        return true;
      }

      if (method === "PUT" && pathname === "/notes") {
        void readJsonBody(req)
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
            if (outcome.status === "ok") broadcastSnapshot(sessions, outcome.snapshot);
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

function broadcastSnapshot(
  sessions: AppSidecarNotesSessions,
  snapshot: ProjectNotesSnapshot,
): void {
  for (const session of sessions.values()) {
    if (canonicalProjectKey(session.cwd) === snapshot.projectKey) {
      session.broadcastNotesChange(snapshot);
    }
  }
}

function requestPathname(requestUrl: string): string {
  try {
    return new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    return requestUrl;
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  if (exceedsDeclaredContentLength(req.headers["content-length"])) {
    drainRequest(req);
    throw new NotesRequestBodyTooLargeError();
  }

  const chunks = await readRequestChunks(req);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new MalformedJsonError();
  }
}

function exceedsDeclaredContentLength(value: string | undefined): boolean {
  return typeof value === "string" && /^\d+$/.test(value)
    ? BigInt(value) > BigInt(NOTES_REQUEST_BODY_MAX_BYTES)
    : false;
}

function readRequestChunks(req: http.IncomingMessage): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += buffer.byteLength;
      if (byteCount > NOTES_REQUEST_BODY_MAX_BYTES) {
        chunks.length = 0;
        cleanup();
        settled = true;
        drainRequest(req);
        reject(new NotesRequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(chunks);
    };
    const onError = (error: Error): void => rejectOnce(error);
    const onAborted = (): void => rejectOnce(new Error("notes request aborted"));

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function drainRequest(req: http.IncomingMessage): void {
  const ignoreDrainError = (): void => {};
  req.on("error", ignoreDrainError);
  req.once("close", () => req.off("error", ignoreDrainError));
  req.resume();
}

function isMigrationBody(value: unknown): value is { document: unknown } {
  return isRecordWithExactKeys(value, ["document"]);
}

function isSaveBody(value: unknown): value is { expectedRevision: number; document: unknown } {
  return (
    isRecordWithExactKeys(value, ["expectedRevision", "document"]) &&
    Number.isInteger(value.expectedRevision) &&
    (value.expectedRevision as number) >= 0
  );
}

function isRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
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
  if (error instanceof MalformedJsonError) {
    sendJson(res, 400, malformedJson());
  } else if (error instanceof NotesRequestBodyTooLargeError) {
    sendJson(res, 413, requestBodyTooLarge());
  } else {
    sendUnexpectedError(res, error, onError);
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

class MalformedJsonError extends Error {}
class NotesRequestBodyTooLargeError extends Error {}
