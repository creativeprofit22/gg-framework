export interface DisposablePhaseCandidate {
  session: {
    clearActivePhaseContext?: (reason: "binding-compensation") => Promise<void>;
    dispose: () => void | Promise<void>;
  };
}

/** Owns initialized phase candidates until promotion or terminal disposal. */
export class AppSidecarPhaseCandidateStore<TCandidate extends DisposablePhaseCandidate> {
  readonly #candidates = new Map<string, TCandidate>();
  #disposed = false;

  get(phaseId: string): TCandidate | undefined {
    return this.#candidates.get(phaseId);
  }

  has(phaseId: string): boolean {
    return this.#candidates.has(phaseId);
  }

  async add(phaseId: string, candidate: TCandidate): Promise<void> {
    if (this.#disposed || this.#candidates.has(phaseId)) {
      await disposeCandidateSession(candidate);
      throw new Error(
        this.#disposed
          ? "Cannot retain a phase candidate after its logical session was disposed."
          : `A phase candidate is already retained for ${phaseId}.`,
      );
    }
    this.#candidates.set(phaseId, candidate);
  }

  /** Removes a promoted candidate without disposing the now-active session. */
  take(phaseId: string): TCandidate | undefined {
    const candidate = this.#candidates.get(phaseId);
    if (candidate) this.#candidates.delete(phaseId);
    return candidate;
  }

  async disposeCandidate(phaseId: string): Promise<boolean> {
    const candidate = this.take(phaseId);
    if (!candidate) return false;
    await disposeCandidateSession(candidate);
    return true;
  }

  /** Clears stale retry candidates while keeping this logical owner reusable. */
  async clear(): Promise<void> {
    const candidates = [...this.#candidates.values()];
    this.#candidates.clear();
    await Promise.allSettled(candidates.map((candidate) => disposeCandidateSession(candidate)));
  }

  /** Permanently closes the owner and disposes every candidate still retained. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.clear();
  }
}

async function disposeCandidateSession(candidate: DisposablePhaseCandidate): Promise<void> {
  await candidate.session.clearActivePhaseContext?.("binding-compensation");
  await candidate.session.dispose();
}
