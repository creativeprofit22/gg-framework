/** Canonical serializable fixture shared by backend and desktop parity tests. */
export const BASH_DIAGNOSTICS_FIXTURE = {
  executionId: "exec-123",
  pid: 4242,
  command: "pnpm check",
  cwd: "C:\\project",
  startedAt: 1_785_000_000_000,
  timeoutMs: 120_000,
  reason: "timedOut",
  exitCode: null,
  signal: "SIGKILL",
  elapsedMs: 2_003,
  logPath: "C:\\Users\\dev\\.gg\\foreground\\exec-123.log",
  tail: "Authoritative final output\nlast line\n",
  outputCapped: true,
  totalOutputBytes: 12_000_000,
  retainedOutputBytes: 10_000_000,
  droppedOutputBytes: 2_000_000,
} as const;
