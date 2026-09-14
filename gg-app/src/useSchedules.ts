import { useCallback, useEffect, useRef, useState } from "react";
import type { ActiveSchedule } from "./RunningSchedulesButton";
import type { ParsedSchedule } from "./scheduleCommand";

/**
 * Runtime for `/schedule`: owns the active schedules and fires their prompts.
 *
 * ## Why one ticker rather than a timer per schedule
 *
 * A single 1s interval compares every schedule's `nextRunAt` against the clock.
 * Per-schedule `setTimeout`s would drift, need individual cleanup, and — the
 * real problem — silently die if the machine sleeps through their deadline. A
 * polled comparison recovers from sleep on its own, because it re-reads the
 * clock rather than trusting a timer that was never scheduled to survive.
 *
 * ## Missed occurrences are skipped, never replayed
 *
 * If several intervals elapsed while the app was busy or asleep, `nextRunAt`
 * advances to the next FUTURE boundary instead of firing once per missed slot.
 * A monitoring prompt that fell four occurrences behind should check the logs
 * once, now — not launch four agents against a repo that has moved on.
 *
 * ## Firing mid-run queues, it does not drop
 *
 * A due schedule whose turn arrives while the agent is working still fires. The
 * send path queues it as steering, so the agent picks it up at the next turn
 * boundary instead of the work being silently lost.
 *
 * The one guard is duplicate suppression: a schedule with an instance ALREADY
 * waiting in the queue does not add another. Without it a 15-minute schedule
 * against a two-hour run would stack eight identical copies, and the agent
 * would work through all of them back to back. `runsCompleted` only advances
 * when a prompt is actually sent.
 *
 * ## Lifetime
 *
 * Schedules live in memory for the life of the window. Closing the window (or
 * quitting the app) drops them — there is no persistence and no background
 * service, so a schedule only fires while GG Coder is open. The footer pill
 * states this so the guarantee is visible where the schedules are.
 */

/** How often the ticker re-checks for due schedules. */
export const TICK_MS = 1000;

/**
 * How long an optimistic "already sent" marker survives without the prompt
 * appearing in the real queue.
 *
 * A fired prompt only shows up in `queuedPrompts` after a full async round trip
 * (webview -> Rust -> HTTP -> sidecar -> SSE -> back), and if the agent was idle
 * it runs immediately and never queues at all. The marker covers that gap; the
 * expiry stops a prompt that never queued from suppressing its schedule forever.
 */
export const FIRE_GRACE_MS = 15_000;

export interface Schedules {
  schedules: readonly ActiveSchedule[];
  /** Register a parsed `/schedule` command. Returns the new schedule's id. */
  addSchedule: (parsed: ParsedSchedule) => string;
  /** Cancel a schedule by id. */
  stopSchedule: (id: string) => void;
}

/**
 * Next boundary strictly in the future, skipping any occurrences missed while
 * the app was busy or asleep.
 */
function advanceNextRun(nextRunAt: number, intervalMs: number, now: number): number {
  if (now < nextRunAt) return nextRunAt;
  const missed = Math.floor((now - nextRunAt) / intervalMs) + 1;
  return nextRunAt + missed * intervalMs;
}

let idCounter = 0;

export function useSchedules(opts: {
  /**
   * Prompts already waiting in the agent's steering queue. A schedule whose
   * prompt is present does not fire again, so one schedule can never stack
   * duplicate copies of itself behind a long run.
   */
  queuedPrompts: readonly string[];
  /** Sends one scheduled prompt through the normal send path (queues if busy). */
  onFire: (prompt: string) => void;
}): Schedules {
  const { queuedPrompts, onFire } = opts;
  const [schedules, setSchedules] = useState<readonly ActiveSchedule[]>([]);

  // The ref is authoritative for the ticker; `schedules` mirrors it for render.
  // Deriving fires from a `setState` updater instead would run side effects
  // during the render phase, and double-fire under StrictMode's double
  // invocation.
  const schedulesRef = useRef<readonly ActiveSchedule[]>([]);
  const onFireRef = useRef(onFire);
  // Prompts we have sent but not yet seen echoed back in `queuedPrompts`.
  // The queue depth arrives over SSE, so between firing and that event landing
  // the dedupe check would otherwise read stale and fire the same prompt again.
  const inFlightRef = useRef<Map<string, number>>(new Map());
  const queuedRef = useRef<readonly string[]>(queuedPrompts);

  useEffect(() => {
    queuedRef.current = queuedPrompts;
    // Anything now visible in the real queue no longer needs its optimistic
    // in-flight marker.
    for (const prompt of queuedPrompts) inFlightRef.current.delete(prompt);
  }, [queuedPrompts]);
  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);

  const commit = useCallback((next: readonly ActiveSchedule[]) => {
    schedulesRef.current = next;
    setSchedules(next);
  }, []);

  const addSchedule = useCallback(
    (parsed: ParsedSchedule): string => {
      idCounter += 1;
      const id = `sch-${idCounter}`;
      // The first run lands one full interval out. Firing instantly on submit
      // would start an agent the moment the user pressed Enter, which is not
      // what "every 15m" asks for and is a surprising thing for a command that
      // reads as future-tense.
      const schedule: ActiveSchedule = {
        ...parsed,
        id,
        nextRunAt: Date.now() + parsed.intervalMs,
        runsCompleted: 0,
      };
      commit([...schedulesRef.current, schedule]);
      return id;
    },
    [commit],
  );

  const stopSchedule = useCallback(
    (id: string) => {
      commit(schedulesRef.current.filter((s) => s.id !== id));
    },
    [commit],
  );

  useEffect(() => {
    const tick = (): void => {
      const current = schedulesRef.current;
      if (current.length === 0) return;

      const now = Date.now();
      const next: ActiveSchedule[] = [];
      const toFire: string[] = [];
      let changed = false;

      // Expire optimistic in-flight markers whose prompt never showed up in the
      // queue (it ran immediately because the agent was idle, or the send was
      // dropped). Without this a schedule would suppress itself forever.
      for (const [prompt, at] of inFlightRef.current) {
        if (now - at >= FIRE_GRACE_MS) inFlightRef.current.delete(prompt);
      }

      const pending = new Set([...queuedRef.current, ...inFlightRef.current.keys()]);

      // At most ONE prompt is sent per tick. The sidecar only sets its `running`
      // flag after an await inside the /prompt handler, so two sends issued in
      // the same tick can both clear its concurrency guard and end up calling
      // `session.prompt()` against the same session at once.
      let firedThisTick = false;

      for (const schedule of current) {
        if (now < schedule.nextRunAt) {
          next.push(schedule);
          continue;
        }

        // This schedule already has a copy waiting for the agent. Skip the
        // occurrence rather than queueing a duplicate, and re-aim at the next
        // boundary. runsCompleted is untouched because nothing was sent.
        if (pending.has(schedule.prompt)) {
          changed = true;
          next.push({
            ...schedule,
            nextRunAt: advanceNextRun(schedule.nextRunAt, schedule.intervalMs, now),
          });
          continue;
        }

        // Another schedule claimed this tick. Keep the past-due `nextRunAt` so
        // this one goes out on the very next tick instead of losing its turn --
        // advancing it here would starve a schedule that always comes due
        // alongside an earlier one.
        if (firedThisTick) {
          next.push(schedule);
          continue;
        }

        changed = true;
        firedThisTick = true;
        toFire.push(schedule.prompt);
        pending.add(schedule.prompt);
        const runsCompleted = schedule.runsCompleted + 1;
        // Bounded schedule that has run its course drops off the list; a null
        // runCount runs until stopped.
        if (schedule.runCount !== null && runsCompleted >= schedule.runCount) continue;
        next.push({
          ...schedule,
          runsCompleted,
          nextRunAt: advanceNextRun(schedule.nextRunAt, schedule.intervalMs, now),
        });
      }

      if (changed) commit(next);
      // Fire AFTER committing, so a prompt that synchronously flips state sees
      // the already-updated schedule list.
      for (const prompt of toFire) {
        // Mark optimistically BEFORE sending: the queue echo is async, and until
        // it arrives this is the only thing preventing a duplicate.
        inFlightRef.current.set(prompt, Date.now());
        onFireRef.current(prompt);
      }
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [commit]);

  return { schedules, addSchedule, stopSchedule };
}
