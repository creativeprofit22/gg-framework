import type { AgentSession } from "../core/agent-session.js";
import type { AuthStorage } from "../core/auth-storage.js";
import type { GoalRecord } from "../core/goals-store.js";
import type { RunClaim } from "../core/run-claim.js";
import type { AppPaths } from "../config.js";
import type { TrophyManager } from "./trophy-manager.js";

/**
 * Local Fork adapter: the narrow slice of upstream's SessionRouteContext that
 * upstream route modules ported onto the monolithic app-sidecar.ts read.
 * app-sidecar.ts builds this from its closure state inside createSession.
 */
export interface SessionRouteContext {
  readonly paths: AppPaths;
  readonly session: AgentSession;
  readonly running: boolean;
  readonly autopilotActive: boolean;
  readonly runClaim: RunClaim;
  readonly auth: AuthStorage;
  readonly trophies: TrophyManager;
  readonly sessionId: string;
  readonly sessionIdsAt: (cwd: string) => string[];
  readonly busyAt: (cwd: string) => boolean;
  /** Set when this session's cwd is a Goal folder; null for every other session. */
  goal: { dir: string; record: GoalRecord } | null;
  readonly broadcast: (type: string, data: unknown) => void;
  readonly runAgent: (
    label: string,
    run: () => Promise<void>,
    reviewPending?: () => boolean,
  ) => Promise<void>;
}
