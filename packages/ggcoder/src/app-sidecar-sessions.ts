import fs from "node:fs/promises";

import {
  CHAT_AGENT_IDS,
  chatAgentSessionsDir,
  sessionsDirForChatAgent,
  type ChatAgentId,
} from "./chat-agents/index.js";
import {
  listForeignSessions,
  listRecentSessions,
  type RecentSession,
  type SessionReadCache,
} from "./core/project-discovery.js";
import { sameSessionFile } from "./core/session-storage.js";
import { MOTION_SESSIONS_QUERY, motionSessionsDir } from "./motion-agent/motion-agent.js";

/** Keep deep coding histories visible in the project picker without an unbounded scan. */
const CODING_SESSION_LIMIT = 100;
const CHAT_SESSION_LIMIT = 30;
const MOTION_SESSION_LIMIT = 30;
/** Foreign rows are additive, so keep them a short tail under the native list. */
const FOREIGN_SESSION_LIMIT = 5;

export type SidecarSession = RecentSession & { chatAgent?: ChatAgentId };

export interface ListSidecarSessionsOptions {
  /**
   * Only exists so tests can point the Claude Code / Codex lookup at a fixture
   * home; production always uses the real one.
   */
  homeDir?: string;
  /** The daemon's per-file read cache, so a refresh re-reads only changed sessions. */
  cache?: SessionReadCache;
}

/** List coding or chat sessions using the documented 100/30 caps exposed by the gg-app sidecar. */
export async function listSidecarSessions(
  cwd: string,
  requestedAgent: string | null,
  coderSessionsDir: string,
  options: ListSidecarSessionsOptions = {},
): Promise<SidecarSession[]> {
  const { homeDir, cache } = options;
  if (requestedAgent === MOTION_SESSIONS_QUERY) {
    return listRecentSessions(
      cwd,
      MOTION_SESSION_LIMIT,
      motionSessionsDir(coderSessionsDir),
      cache,
    );
  }
  if (requestedAgent !== "all") {
    // Chat agents have their own private stores; only the coding list (no
    // requested agent) shares a cwd with Claude Code and Codex.
    if (requestedAgent) {
      return listRecentSessions(
        cwd,
        CHAT_SESSION_LIMIT,
        sessionsDirForChatAgent(coderSessionsDir, requestedAgent),
        cache,
      );
    }
    return listCodingSessions(cwd, coderSessionsDir, homeDir, cache);
  }

  const groups = await Promise.all(
    CHAT_AGENT_IDS.map(async (agentId) => {
      const sessions = await listRecentSessions(
        cwd,
        CHAT_SESSION_LIMIT,
        chatAgentSessionsDir(coderSessionsDir, agentId),
        cache,
      );
      return sessions.map((session) => ({ ...session, chatAgent: agentId }));
    }),
  );
  const dated = await Promise.all(
    groups.flat().map(async (session) => ({
      session,
      mtime: await fs
        .stat(session.path)
        .then((stat) => stat.mtimeMs)
        .catch(() => 0),
    })),
  );
  return dated
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, CHAT_SESSION_LIMIT)
    .map(({ session }) => session);
}

/** Longest saved session name; listings and resume read labels up to this length. */
export const SESSION_TITLE_MAX_LENGTH = 80;

/**
 * A session name as the user typed it, or null when it is empty or too long.
 * Line breaks, tabs and other control characters collapse to single spaces,
 * because the name is shown on one line everywhere it appears.
 */
export function normalizeSessionTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (!title || title.length > SESSION_TITLE_MAX_LENGTH) return null;
  return title;
}

export interface RenameSidecarSessionInput {
  cwd: string;
  /** The same listing selector as `listSidecarSessions`. */
  requestedAgent: string | null;
  sessionPath: string;
  title: unknown;
  coderSessionsDir: string;
  options?: ListSidecarSessionsOptions;
  /**
   * Rename the session in every live pane persisting to `sessionPath`, saving
   * it once. False when no pane has it open, so the caller saves the file.
   */
  renameLive: (sessionPath: string, title: string) => Promise<boolean>;
  /** Save the name to an idle session file. */
  saveLabel: (sessionPath: string, title: string) => Promise<void>;
}

export type RenameSidecarSessionResult =
  { ok: true; title: string } | { ok: false; status: 400 | 404; error: string };

/**
 * Rename one GG Coder session. The webview only names a path, so the path is
 * accepted only when it is a native row of this very listing: anything else
 * (another project's file, a Claude Code or Codex transcript, an arbitrary
 * path) is refused before any write.
 */
export async function renameSidecarSession(
  input: RenameSidecarSessionInput,
): Promise<RenameSidecarSessionResult> {
  const title = normalizeSessionTitle(input.title);
  if (!title) {
    return {
      ok: false,
      status: 400,
      error: `Session names need 1 to ${SESSION_TITLE_MAX_LENGTH} characters.`,
    };
  }
  const rows = await listSidecarSessions(
    input.cwd,
    input.requestedAgent,
    input.coderSessionsDir,
    input.options,
  );
  const row = rows.find(
    (session) =>
      (session.source === undefined || session.source === "ggcoder") &&
      sameSessionFile(session.path, input.sessionPath),
  );
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "That session is no longer in this project's list.",
    };
  }
  if (!(await input.renameLive(row.path, title))) await input.saveLabel(row.path, title);
  return { ok: true, title };
}

/**
 * GG Coder's own sessions for this project plus any Claude Code / Codex
 * transcripts recorded against the same cwd.
 *
 * The project picker already surfaces those stores, so a project can appear
 * *because* it has Claude Code history and then show an empty session list.
 * Foreign rows close that gap; the app imports one on click and opens it.
 *
 * A foreign store being slow or unreadable must never empty the native list,
 * so its failure degrades to "no foreign rows".
 */
async function listCodingSessions(
  cwd: string,
  coderSessionsDir: string,
  homeDir: string | undefined,
  cache: SessionReadCache | undefined,
): Promise<SidecarSession[]> {
  const [native, foreign] = await Promise.all([
    listRecentSessions(cwd, CODING_SESSION_LIMIT, coderSessionsDir, cache),
    listForeignSessions(cwd, FOREIGN_SESSION_LIMIT, homeDir).catch(() => []),
  ]);
  // Native first: a session already resumable here beats one that needs an
  // import, even when the foreign transcript is a little newer.
  return [...native, ...foreign];
}
