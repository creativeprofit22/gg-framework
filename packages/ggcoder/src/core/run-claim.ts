/**
 * Guards the gap between deciding to start a run and the run actually starting.
 *
 * ## The race this exists to close
 *
 * The sidecar's `/prompt` handler decides between "start a run" and "queue as
 * steering" by reading a `running` flag. But `running` only flips once
 * `runAgent` begins, and the handler awaits several things first (attachment
 * preparation, workflow-command specs). Node yields at every one of those
 * awaits, so a second prompt arriving mid-gap re-reads `running === false`,
 * passes the same check, and calls `session.prompt()` concurrently on a session
 * that is already prompting.
 *
 * A claim is taken synchronously — in the same tick as the check, with no await
 * between them — so the second caller sees the claim and queues instead.
 *
 * Scheduled prompts, Telegram, voice, and the webview all funnel through that
 * one handler, which is why this cannot live in any single caller.
 */
export class RunClaim {
  #claimed = false;

  /** True while a run is starting or in flight. */
  get active(): boolean {
    return this.#claimed;
  }

  /**
   * Try to claim the right to start a run.
   *
   * @returns true if this caller won and must start the run, false if a run is
   *   already starting or running and the caller should queue instead.
   */
  claim(): boolean {
    if (this.#claimed) return false;
    this.#claimed = true;
    return true;
  }

  /**
   * Release a claim. Safe to call when not held, so it can sit in a `finally`.
   * Only the caller whose {@link claim} returned true should call this.
   */
  release(): void {
    this.#claimed = false;
  }
}
