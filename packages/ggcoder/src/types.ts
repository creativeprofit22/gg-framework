import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";

// ── CLI Config ─────────────────────────────────────────────

export interface CliConfig {
  provider: Provider;
  model: string;
  baseUrl?: string;
  cwd: string;
  sessionId?: string;
  continueRecent?: boolean;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  printMessage?: string;
  outputFormat?: "text" | "json";
}

// ── Foreground Execution ────────────────────────────────────

export type ForegroundExecutionReason =
  | "completed"
  | "nonZeroExit"
  | "timedOut"
  | "aborted"
  | "spawnError";

export interface ForegroundExecutionOutcome {
  reason: ForegroundExecutionReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  elapsedMs: number;
  pid: number | null;
  error: Error | null;
}

// ── Session Persistence ────────────────────────────────────

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  timestamp: string;
  cwd: string;
  provider: Provider;
  model: string;
}

export interface SessionMessageEntry {
  type: "message";
  timestamp: string;
  message: Message;
}

export type SessionEntry = SessionHeader | SessionMessageEntry;

export interface SessionInfo {
  id: string;
  path: string;
  timestamp: string;
  /** Timestamp of the most recent message (falls back to creation timestamp). */
  lastActivity: string;
  cwd: string;
  messageCount: number;
}
