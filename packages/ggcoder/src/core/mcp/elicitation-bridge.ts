import type { ElicitResult } from "@modelcontextprotocol/client";
import type { MCPElicitHandler, MCPElicitation } from "./client.js";

/**
 * How long an elicitation waits for the user before auto-cancelling. Generous —
 * the user may be reading a consent prompt — but bounded, because the MCP tool
 * call, and therefore the whole turn, is blocked until it settles.
 */
export const MCP_ELICIT_TIMEOUT_MS = 5 * 60_000;

/** The frame a host broadcasts so its UI can render the form. */
export interface ElicitationPrompt extends MCPElicitation {
  id: string;
}

export interface ElicitationBridge {
  /** Pass to `AgentSessionOptions.onMcpElicit`. */
  onElicit: MCPElicitHandler;
  /** Resolve one parked request. False when the id is unknown (already settled). */
  settle: (id: string, result: ElicitResult) => boolean;
  /** Cancel every parked request — for run abort and host teardown. */
  cancelAll: () => void;
  /** How many requests are currently awaiting the user. */
  readonly pendingCount: number;
}

/**
 * Bridge between MCP servers asking for input and a host that renders a form
 * asynchronously (the gg-app sidecar: broadcast over SSE, answer over HTTP).
 *
 * Requests are keyed by id rather than held in a single slot, because two
 * servers can be mid-tool-call at once.
 *
 * Every parked request is guaranteed a terminal state: the caller settles it,
 * `cancelAll` releases it on abort/teardown, or the timeout fires. An
 * elicitation that never resolves would hang the turn forever.
 */
export function createElicitationBridge(opts: {
  /** Deliver the prompt to the UI. Must not throw. */
  broadcast: (prompt: ElicitationPrompt) => void;
  /** Called when a request auto-cancels on timeout, for logging. */
  onTimeout?: (prompt: ElicitationPrompt) => void;
  timeoutMs?: number;
}): ElicitationBridge {
  const timeoutMs = opts.timeoutMs ?? MCP_ELICIT_TIMEOUT_MS;
  const pending = new Map<
    string,
    { resolve: (result: ElicitResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let seq = 0;

  const settle = (id: string, result: ElicitResult): boolean => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  };

  return {
    onElicit: (request) =>
      new Promise<ElicitResult>((resolve) => {
        const prompt: ElicitationPrompt = { ...request, id: `elicit-${++seq}` };
        const timer = setTimeout(() => {
          opts.onTimeout?.(prompt);
          settle(prompt.id, { action: "cancel" });
        }, timeoutMs);
        timer.unref?.();
        pending.set(prompt.id, { resolve, timer });
        opts.broadcast(prompt);
      }),
    settle,
    cancelAll: () => {
      for (const id of [...pending.keys()]) settle(id, { action: "cancel" });
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
