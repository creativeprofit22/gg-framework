import type http from "node:http";
import {
  canonicalProjectKey,
  type ProjectNotesLoadOutcome,
  type ProjectNotesMigrationOutcome,
  type ProjectNotesRepository,
  type ProjectNotesSaveOutcome,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";

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

type InvalidResponse = { status: "invalid"; reason: "malformed-json" | "invalid-body" };
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
          .catch((error) => {
            if (error instanceof MalformedJsonError) {
              sendJson(res, 400, malformedJson());
            } else {
              sendUnexpectedError(res, error, onError);
            }
          });
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
          .catch((error) => {
            if (error instanceof MalformedJsonError) {
              sendJson(res, 400, malformedJson());
            } else {
              sendUnexpectedError(res, error, onError);
            }
          });
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new MalformedJsonError();
  }
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
  return { status: "invalid", reason: "invalid-body" };
}

function malformedJson(): InvalidResponse {
  return { status: "invalid", reason: "malformed-json" };
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
