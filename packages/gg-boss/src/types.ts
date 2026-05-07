export type WorkerStatus = "idle" | "working" | "error";

export interface ProjectSpec {
  name: string;
  cwd: string;
}

export interface ToolUseSummary {
  name: string;
  ok: boolean;
}

export interface WorkerTurnSummary {
  project: string;
  cwd: string;
  status: WorkerStatus;
  finalText: string;
  toolsUsed: ToolUseSummary[];
  turnIndex: number;
  timestamp: string;
}

export interface WorkerStuckSnapshot {
  workingSeconds: number;
  silentSeconds: number;
  activeTools: string[];
  completedTools: ToolUseSummary[];
  textTail: string;
}

export type BossEvent =
  | { kind: "user_message"; text: string; timestamp: string }
  | { kind: "worker_turn_complete"; summary: WorkerTurnSummary }
  | { kind: "worker_error"; project: string; message: string; timestamp: string }
  | {
      kind: "worker_stuck";
      project: string;
      reason: "silent" | "long_running";
      snapshot: WorkerStuckSnapshot;
      timestamp: string;
    };
