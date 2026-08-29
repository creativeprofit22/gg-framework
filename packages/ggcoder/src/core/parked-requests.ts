/**
 * A registry of requests parked on the user.
 *
 * Both the MCP elicitation bridge and the `ask_user` tool need the same thing:
 * a tool call blocks, its promise is held here under a fresh id, a host UI is
 * told to render something, and the promise settles when the answer arrives
 * over a different transport entirely.
 *
 * Every parked request is guaranteed a terminal state — the caller settles it,
 * `cancelAll` releases it on abort/teardown, or the timeout fires. A request
 * that never resolves would hang the turn forever.
 */
export interface ParkedRequests<Req, Res> {
  /** Park a request: broadcasts it with a fresh id, resolves when settled. */
  park: (request: Req) => Promise<Res>;
  /** Resolve one parked request. False when the id is unknown (already settled). */
  settle: (id: string, result: Res) => boolean;
  /**
   * Cancel every parked request — for run abort and host teardown. Pass a
   * result to release them with something other than the default cancel value
   * (e.g. "superseded by a typed message").
   */
  cancelAll: (result?: Res) => void;
  /** How many requests are currently awaiting the user. */
  readonly pendingCount: number;
}

export interface ParkedRequestsOptions<Req, Res> {
  /** Prefix for generated ids, e.g. `elicit` → `elicit-1`. */
  idPrefix: string;
  /** Deliver the request to the UI. Must not throw. */
  broadcast: (prompt: Req & { id: string }) => void;
  /** The result used for timeouts and `cancelAll`. */
  cancelValue: () => Res;
  /** How long a request waits for the user before auto-cancelling. */
  timeoutMs: number;
  /** Called when a request auto-cancels on timeout, for logging. */
  onTimeout?: (prompt: Req & { id: string }) => void;
}

export function createParkedRequests<Req extends object, Res>(
  opts: ParkedRequestsOptions<Req, Res>,
): ParkedRequests<Req, Res> {
  const pending = new Map<
    string,
    { resolve: (result: Res) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let seq = 0;

  const settle = (id: string, result: Res): boolean => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  };

  return {
    park: (request) =>
      new Promise<Res>((resolve) => {
        const prompt = { ...request, id: `${opts.idPrefix}-${++seq}` };
        const timer = setTimeout(() => {
          opts.onTimeout?.(prompt);
          settle(prompt.id, opts.cancelValue());
        }, opts.timeoutMs);
        timer.unref?.();
        pending.set(prompt.id, { resolve, timer });
        opts.broadcast(prompt);
      }),
    settle,
    cancelAll: (result) => {
      for (const id of [...pending.keys()]) settle(id, result ?? opts.cancelValue());
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
