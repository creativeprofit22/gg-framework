import { goalNeedsKickoff, goalPhase, goalWasInterrupted } from "../core/goals-store.js";
import { goalRunningElsewhere } from "../core/goal-run-marker.js";
import { goalCritterPick } from "../goals-agent/goals-agent.js";
import type { SessionRouteContext } from "./route-context.js";

/**
 * The app needs to know a code window is a goal (title, back navigation,
 * automatic first reply). Null for every ordinary session. Shared by GET
 * /state and the events stream's "ready" frame, which the app swaps its
 * whole state for on every (re)connect.
 *
 * Upstream keeps this in its session-routes module; the Local Fork's
 * monolithic sidecar imports it from here instead.
 */
export function goalStatePayload(ctx: Pick<SessionRouteContext, "goal" | "session">) {
  const goal = ctx.goal;
  if (!goal) return null;
  return {
    id: goal.record.id,
    name: goal.record.name,
    needsKickoff: goalNeedsKickoff(goal.record, ctx.session.getMessages()),
    phase: goalPhase(goal.record),
    paused: Boolean(goal.record.pausedAt),
    // Started, not paused, and cut off mid-work: the app asks it to carry on.
    // Not while another process is running it: resuming would start a
    // second coordinator on the same goal.
    needsResume:
      goalWasInterrupted(goal.record, ctx.session.getMessages(), ctx.session.listSubAgents()) &&
      !goalRunningElsewhere(goal.dir),
    instructions: goal.record.instructions ?? "",
    context: goal.record.context,
    // The workers' pinned model; null: they follow GG Goals' model.
    critterModel: goalCritterPick(goal.record)?.model ?? null,
  };
}
