/**
 * Bounded push queue for out-of-band events the agent should learn about
 * without spending a turn asking — a spawned child finishing, a background
 * build making progress or exiting.
 *
 * The queue is deliberately lossy. Only the LATEST entry per `(kind, id)`
 * survives, because a stale "build is 40% through" line is worthless next to
 * "build exited 1", and a parent that spawned five children needs five facts,
 * not fifty. Terminal entries supersede pending non-terminal ones for the same
 * id and cannot themselves be superseded by a later non-terminal update, so a
 * completion can never be overwritten by a straggling progress tick.
 *
 * Every bound here protects the same thing: injected bytes per drain. These
 * notifications ride the steering path into live context, so an unbounded
 * queue would silently eat the context window it is meant to save.
 */

/** Notification source. Extended as new push producers are added. */
export type NotificationKind = "subagent" | "process";

export interface AgentNotification {
  kind: NotificationKind;
  /** Producer-scoped identity (agent id, process id). Dedupe key with `kind`. */
  id: string;
  /** Bounded, human-readable one-liner. Never raw output. */
  text: string;
  /** True once the producer reached a final state (child done, process exited). */
  terminal: boolean;
  /** Unix epoch ms of the most recent update for this `(kind, id)`. */
  updatedAt: number;
}

/** Max characters retained for a single notification's text. */
export const NOTIFICATION_MAX_CHARS = 512;
/** Max characters returned by one `drain()`, across all notifications. */
export const NOTIFICATION_DRAIN_MAX_CHARS = 1024;

function truncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}\u2026`;
}

/**
 * FIFO with latest-only dedupe by `(kind, id)`. Insertion order is preserved
 * across updates: an entry that is updated keeps its original queue position,
 * so a chatty producer cannot starve an older, quieter one out of a drain.
 */
export class AgentNotificationQueue {
  private entries = new Map<string, AgentNotification>();

  private static key(kind: NotificationKind, id: string): string {
    return `${kind}:${id}`;
  }

  /**
   * Record the latest state for one producer. Returns false when the update
   * was dropped because a terminal entry for the same id already exists.
   */
  enqueue(
    kind: NotificationKind,
    id: string,
    text: string,
    options: { terminal?: boolean } = {},
  ): boolean {
    const terminal = options.terminal === true;
    const key = AgentNotificationQueue.key(kind, id);
    const existing = this.entries.get(key);
    // A completion is the last word — a late progress tick must not erase it.
    if (existing?.terminal && !terminal) return false;
    this.entries.set(key, {
      kind,
      id,
      text: truncate(text, NOTIFICATION_MAX_CHARS),
      terminal,
      updatedAt: Date.now(),
    });
    return true;
  }

  /** Number of notifications currently waiting. */
  get size(): number {
    return this.entries.size;
  }

  /** Discard any pending notification for one producer (e.g. on reap). */
  clear(kind: NotificationKind, id: string): void {
    this.entries.delete(AgentNotificationQueue.key(kind, id));
  }

  /** Discard everything (e.g. between runs). */
  clearAll(): void {
    this.entries.clear();
  }

  /**
   * Take pending notifications, oldest first, up to the per-drain char budget.
   * Taken entries are removed; entries that did not fit stay queued for the
   * next drain rather than being dropped.
   */
  drain(): AgentNotification[] {
    const taken: AgentNotification[] = [];
    let budget = NOTIFICATION_DRAIN_MAX_CHARS;
    for (const [key, entry] of this.entries) {
      if (entry.text.length > budget) {
        // Nothing taken yet and even one entry overflows: take it truncated
        // rather than deadlocking the queue on an oversized head.
        if (taken.length === 0) {
          taken.push({ ...entry, text: truncate(entry.text, budget) });
          this.entries.delete(key);
        }
        break;
      }
      budget -= entry.text.length;
      taken.push(entry);
      this.entries.delete(key);
    }
    return taken;
  }
}
