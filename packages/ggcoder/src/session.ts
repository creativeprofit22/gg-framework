import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import type { SessionHeader, SessionMessageEntry, SessionEntry, SessionInfo } from "./types.js";
import {
  SessionManager,
  type MessageEntry as ManagedMessageEntry,
  type SessionHeader as ManagedSessionHeader,
  type SessionSummary,
} from "./core/session-manager.js";

const SESSION_DIR = path.join(os.homedir(), ".gg", "sessions");
const sessionManager = new SessionManager(SESSION_DIR);

// ── Create Session ──────────────────────────────────────────

export interface Session {
  id: string;
  path: string;
  append(entry: SessionEntry): Promise<void>;
}

export async function createSession(
  cwd: string,
  provider: string,
  model: string,
  sessionsDir = SESSION_DIR,
): Promise<Session> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  const created = await manager.create(cwd, provider as Provider, model);
  return {
    id: created.id,
    path: created.path,
    async append(entry: SessionEntry) {
      if (entry.type !== "message") return;
      const managedEntry: ManagedMessageEntry = {
        type: "message",
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: entry.timestamp,
        message: entry.message,
      };
      await manager.appendEntry(created.path, managedEntry);
    },
  };
}

// ── Load Session ────────────────────────────────────────────

export async function loadSession(
  sessionPath: string,
  sessionsDir = SESSION_DIR,
): Promise<{ header: SessionHeader; messages: Message[] }> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  const loaded = await manager.load(sessionPath);
  const header: SessionHeader = {
    type: "session",
    version: 1,
    id: loaded.header.id,
    timestamp: loaded.header.timestamp,
    cwd: loaded.header.cwd,
    provider: loaded.header.provider,
    model: loaded.header.model,
  };
  return {
    header,
    messages: manager.getMessages(loaded.entries, loaded.header.leafId),
  };
}

/** Load every readable checkpoint generation for display replay, oldest first. */
export async function loadSessionCheckpointChain(
  sessionPath: string,
  sessionsDir = SESSION_DIR,
): Promise<Array<{ header: ManagedSessionHeader; messages: Message[] }>> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  const checkpoints = await manager.loadCheckpointChain(sessionPath);
  return checkpoints.map(({ header, entries }) => ({
    header,
    messages: manager.getMessages(entries, header.leafId),
  }));
}

// ── List Sessions ───────────────────────────────────────────

export async function listSessions(cwd: string, sessionsDir = SESSION_DIR): Promise<SessionInfo[]> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  return manager.list(cwd);
}

/**
 * One project's sessions, newest first, as lightweight summaries.
 *
 * Early-exit reads instead of full parses — the right call for list UIs and
 * remote clients, which need titles and recency rather than exact counts.
 */
export async function listSessionSummaries(
  cwd: string,
  sessionsDir = SESSION_DIR,
): Promise<SessionSummary[]> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  return manager.listSummaries(cwd);
}

/**
 * Every session on this machine, across every project, newest first.
 *
 * Returns lightweight {@link SessionSummary}s — early-exit reads, mtime for
 * activity — because this scans hundreds of transcripts and callers here
 * (remote clients) need titles and recency, not exact message counts.
 */
export async function listAllSessions(sessionsDir = SESSION_DIR): Promise<SessionSummary[]> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  return manager.listAllSummaries();
}

/**
 * Find a stored session anywhere on this machine by its id.
 *
 * `cwd` narrows the search to the likely directory first; a remote client that
 * listed sessions from one directory and reopens them from another still
 * resolves, which a cwd-scoped lookup cannot do.
 */
export async function findSessionById(
  sessionId: string,
  cwd?: string,
  sessionsDir = SESSION_DIR,
): Promise<string | null> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  return manager.findAnyById(sessionId, cwd);
}

// ── Get Most Recent Session ─────────────────────────────────

export async function getMostRecentSession(
  cwd: string,
  sessionsDir = SESSION_DIR,
): Promise<string | null> {
  const manager = sessionsDir === SESSION_DIR ? sessionManager : new SessionManager(sessionsDir);
  return manager.getMostRecent(cwd);
}

// ── Persist Messages ────────────────────────────────────────

export function persistMessage(session: Session, message: Message): Promise<void> {
  const entry: SessionMessageEntry = {
    type: "message",
    timestamp: new Date().toISOString(),
    message,
  };
  return session.append(entry);
}
