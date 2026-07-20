export interface ReloadableSession {
  isRunning(): boolean;
}

export type ReloadDecision = { ok: true } | { ok: false; reason: "active-runs" | "not-prepared" };

/**
 * Coordinates a secret-free daemon reload handshake.
 * Preparation reserves the daemon while Rust persists validated native config,
 * preventing a new run from racing between the idle check and process reload.
 */
export class AppSidecarReloadCoordinator {
  #prepared = false;
  #reloading = false;

  prepare(sessions: Iterable<ReloadableSession>): ReloadDecision {
    if (hasActiveRun(sessions)) return { ok: false, reason: "active-runs" };
    this.#prepared = true;
    return { ok: true };
  }

  cancel(): void {
    this.#prepared = false;
  }

  begin(sessions: Iterable<ReloadableSession>): ReloadDecision {
    if (!this.#prepared) {
      if (hasActiveRun(sessions)) return { ok: false, reason: "active-runs" };
      return { ok: false, reason: "not-prepared" };
    }
    this.#prepared = false;
    this.#reloading = true;
    return { ok: true };
  }

  shouldBlockSessionMutation(method: string): boolean {
    return (this.#prepared || this.#reloading) && method !== "GET" && method !== "OPTIONS";
  }
}

function hasActiveRun(sessions: Iterable<ReloadableSession>): boolean {
  for (const session of sessions) {
    if (session.isRunning()) return true;
  }
  return false;
}
