import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Worker } from "./worker.js";
import type { WorkerTurnSummary } from "./types.js";

export interface BossToolDeps {
  workers: Map<string, Worker>;
  /** Most recent turn summary per project. Populated by the orchestrator on each worker_turn_complete event. */
  lastSummaries: Map<string, WorkerTurnSummary>;
}

/**
 * Hardcoded framing prepended to every prompt the boss dispatches to a worker.
 *
 * The boss already sees every tool a worker calls (via worker_turn_complete
 * events), so workers don't need to narrate or recap. This brief asks for a
 * tight structured summary instead — keeps `final_text` short and scannable
 * in the boss's context, and saves the boss from having to add this guidance
 * to every prompt itself.
 *
 * Lives here (not in the boss system prompt) because it's a worker-side
 * instruction — only seen by the worker, never by the boss.
 *
 * Exported so the orchestrator can wrap dispatches that bypass prompt_worker
 * (Tasks overlay direct dispatch, dispatch_pending tool) with the same brief.
 */
export const WORKER_PROMPT_BRIEF = `You're being driven by gg-boss, an orchestrator. Your tool usage is already visible to it — don't narrate which tools you ran or recap the request.

End your response with a tight structured summary. Omit any line that doesn't apply:

Changed: <files modified, comma-separated, with the specific change in parentheses where it adds clarity — e.g. "src/auth.ts (added retry guard)">
Skipped: <anything the prompt asked for that you didn't do, with a one-line reason each>
Verified: <what you ran or checked to confirm correctness — e.g. "pnpm test (15/15 pass)", "tsc --noEmit clean">
Notes: <ONE line; only if there's something gg-boss must know that the above doesn't capture>
Status: <one of: DONE | UNVERIFIED | PARTIAL | BLOCKED | INFO>

Status meanings (be honest — gg-boss routes off this):
- DONE: task complete AND you verified it (tests ran, types check, behaviour confirmed)
- UNVERIFIED: task complete but you didn't / couldn't validate it
- PARTIAL: did some of the task; the rest is in Skipped
- BLOCKED: couldn't make progress, needs gg-boss to unblock or re-prompt
- INFO: no work was performed — the prompt was a question and you answered it

If Status is INFO, answer the question in one or two lines and skip the rest of the summary.

No preamble. No apologies. Be factual.

Task:
`;

const listWorkersParams = z.object({});
const getWorkerStatusParams = z.object({
  project: z.string().describe("Project name as listed by list_workers."),
});
const promptWorkerParams = z.object({
  project: z.string().describe("Project name as listed by list_workers."),
  message: z
    .string()
    .describe(
      "The instruction to send to the worker. Be specific — the worker has full coding tools (read, write, edit, bash, grep, etc.).",
    ),
  fresh: z
    .boolean()
    .optional()
    .describe(
      "Set true when this prompt is a meaningful direction change from whatever this worker was doing — different feature, different area of the codebase, unrelated goal. The worker's prior conversation is wiped and a new session file is started. Default false (worker continues its existing context).",
    ),
});
const getWorkerSummaryParams = z.object({
  project: z.string().describe("Project name as listed by list_workers."),
});
const getWorkerActivityParams = z.object({
  project: z.string().describe("Project name as listed by list_workers."),
});
const cancelWorkerParams = z.object({
  project: z.string().describe("Project name as listed by list_workers."),
});
const resetWorkerParams = z.object({
  project: z.string().describe("Project name as listed by list_workers."),
});

export function createBossTools(deps: BossToolDeps): AgentTool[] {
  const { workers, lastSummaries } = deps;

  const listWorkers: AgentTool<typeof listWorkersParams> = {
    name: "list_workers",
    description: "List all projects under your control with their cwd and current status.",
    parameters: listWorkersParams,
    execute() {
      if (workers.size === 0) return "(no workers registered)";
      const lines: string[] = [];
      for (const [name, w] of workers) {
        lines.push(`- ${name} (${w.cwd}) — status: ${w.getStatus()}`);
      }
      return lines.join("\n");
    },
  };

  const getWorkerStatus: AgentTool<typeof getWorkerStatusParams> = {
    name: "get_worker_status",
    description: "Get the current status (idle/working/error) of a single project.",
    parameters: getWorkerStatusParams,
    execute(args) {
      const w = workers.get(args.project);
      if (!w) return `Unknown project: ${args.project}`;
      return `${args.project}: ${w.getStatus()}`;
    },
  };

  const promptWorker: AgentTool<typeof promptWorkerParams> = {
    name: "prompt_worker",
    description:
      "Send a prompt to a worker. Fire-and-forget — returns immediately. You will be notified via a worker_turn_complete event when the worker finishes. Do NOT call this on a worker whose status is 'working'. Use `fresh: true` when the prompt is unrelated to the worker's prior conversation (different feature, different file area) — wipes its context to keep things lean.",
    parameters: promptWorkerParams,
    async execute(args) {
      const w = workers.get(args.project);
      if (!w) return `Unknown project: ${args.project}`;
      if (w.getStatus() === "working") {
        return `Worker "${args.project}" is currently working — wait for its completion event before prompting again.`;
      }
      // Reset the worker's session BEFORE sending the prompt when the boss
      // flagged this as a direction change.
      if (args.fresh) {
        await w.newSession();
      }
      // Wrap the boss's intent with the structured-summary brief so workers
      // respond tersely. The boss only ever sees `args.message` — this happens
      // strictly worker-side.
      await w.prompt(WORKER_PROMPT_BRIEF + args.message);
      return args.fresh
        ? `Fresh session opened for "${args.project}". Prompt sent. Worker is now running.`
        : `Prompt sent to "${args.project}". Worker is now running.`;
    },
  };

  const getWorkerSummary: AgentTool<typeof getWorkerSummaryParams> = {
    name: "get_worker_summary",
    description:
      "Fetch the most recent turn summary from a worker — its final text and the list of tools it used. Use this to verify what a worker actually did.",
    parameters: getWorkerSummaryParams,
    execute(args) {
      const summary = lastSummaries.get(args.project);
      if (!summary) {
        return `No summary yet for "${args.project}" — it hasn't completed any turns.`;
      }
      const tools =
        summary.toolsUsed.length > 0
          ? summary.toolsUsed.map((t) => `${t.ok ? "✓" : "✗"}${t.name}`).join(", ")
          : "(no tools used)";
      return `Project: ${summary.project}
Turn: ${summary.turnIndex}
Status: ${summary.status}
Tools used: ${tools}
Timestamp: ${summary.timestamp}

Final text:
${summary.finalText || "(empty)"}`;
    },
  };

  const getWorkerActivity: AgentTool<typeof getWorkerActivityParams> = {
    name: "get_worker_activity",
    description:
      "Peek at what a worker is doing RIGHT NOW (mid-turn). Returns working/silent durations in seconds, currently-running tool names, completed tools so far, and the tail of its streamed text. Use this when a worker has been `working` for a long time to decide whether it's making progress, hung, or worth cancelling.",
    parameters: getWorkerActivityParams,
    execute(args) {
      const w = workers.get(args.project);
      if (!w) return `Unknown project: ${args.project}`;
      const a = w.getActivity();
      const lines = [
        `Project: ${args.project}`,
        `Status: ${a.status}`,
        `Working: ${a.workingSeconds}s (last event ${a.silentSeconds}s ago)`,
        `Active tools: ${a.activeTools.length > 0 ? a.activeTools.join(", ") : "(none)"}`,
        `Completed this turn: ${
          a.completedTools.length > 0
            ? a.completedTools.map((t) => `${t.ok ? "✓" : "✗"}${t.name}`).join(", ")
            : "(none)"
        }`,
        "",
        "Text tail:",
        a.textTail || "(no text yet)",
      ];
      return lines.join("\n");
    },
  };

  const cancelWorker: AgentTool<typeof cancelWorkerParams> = {
    name: "cancel_worker",
    description:
      "Abort a worker's current turn. Other workers are untouched. The cancelled worker emits a `worker_error` event with message 'Cancelled by boss.' so any in-flight task is cleared. After cancelling, you can re-prompt or reset the worker. No-op if the worker isn't `working`.",
    parameters: cancelWorkerParams,
    execute(args) {
      const w = workers.get(args.project);
      if (!w) return `Unknown project: ${args.project}`;
      const cancelled = w.cancel();
      return cancelled
        ? `Cancellation requested for "${args.project}". A worker_error event will arrive shortly.`
        : `Worker "${args.project}" is not working — nothing to cancel (status: ${w.getStatus()}).`;
    },
  };

  const resetWorker: AgentTool<typeof resetWorkerParams> = {
    name: "reset_worker",
    description:
      "Hard reset: cancel any in-flight turn, wipe conversation history, force status back to idle. Use as a last resort when a worker is wedged in `error` or its context is so polluted that re-prompting won't recover. Equivalent to `fresh: true` plus a forced unstuck. After reset, the worker is ready for a new prompt_worker call.",
    parameters: resetWorkerParams,
    async execute(args) {
      const w = workers.get(args.project);
      if (!w) return `Unknown project: ${args.project}`;
      await w.reset();
      return `Worker "${args.project}" reset — status is idle, history wiped.`;
    },
  };

  return [
    listWorkers,
    getWorkerStatus,
    promptWorker,
    getWorkerSummary,
    getWorkerActivity,
    cancelWorker,
    resetWorker,
  ];
}
