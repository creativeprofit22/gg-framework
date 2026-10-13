// Who is in a Goal's world and what each one is doing, derived from the
// window's live state: GG Goals itself (the coordinator) from the main run's
// tool feed, and every worker it brought in from the transcript's sub-agent
// groups. Pure, so the world view and its tests share one mapping.

import type { FloorAgent } from "./critter-floor";
import type { KenMark } from "./goal-ken-status";
import { toolKindOf } from "./critter-tool-kind";
import type { LiveToolEntry } from "./LiveToolPanel";

/** Every kind of work the world can act out; each has its own station. */
export const WORK_KINDS = [
  "read",
  "search",
  "edit",
  "run",
  "web",
  "think",
  "ask",
  "delegate",
  "wait",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export type WorldAgentStatus = "working" | "idle" | "done" | "error";

export interface WorldAgent {
  /** Stable identity: one critter per key for the world's lifetime. */
  readonly key: string;
  /** Named agent type ("researcher"…), which picks its critter. */
  readonly agentName: string | undefined;
  /** What the roster and announcements call it. */
  readonly name: string;
  readonly coordinator: boolean;
  readonly status: WorldAgentStatus;
  /** What it is doing now; null when it has nothing to do (it goes to the lounge). */
  readonly kind: WorkKind | null;
  /** The same in words, for the roster and screen readers. */
  readonly detail: string;
  /** GG Goals only: the thought mark over its head (see goal-ken-status). */
  readonly mark?: KenMark | null;
}

export const COORDINATOR_KEY = "gg-goals";

/** Coordinator tools that mean something other than their plain tool kind. */
const COORDINATOR_TOOLS: ReadonlyMap<string, WorkKind> = new Map<string, WorkKind>([
  ["ask_user", "ask"],
  ["spawn_agent", "delegate"],
  ["subagent", "delegate"],
  ["send_agent", "delegate"],
  ["wait_agent", "wait"],
  ["task_output", "wait"],
  ["tasks", "think"],
  ["checklist", "think"],
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function clip(value: string, max = 48): string {
  const single = value.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}\u2026` : single;
}

/**
 * Tools the shared tool-kind table doesn't know, that look like using a
 * browser or taking screenshots (most often MCP tools, named like
 * "mcp__playwright__browser_navigate" or "take_screenshot"). On the farm
 * they're web work, so the critter goes to the laptop desk.
 */
const BROWSER_TOOL = /browser|screenshot|playwright|puppeteer|chrome|navigate|web_?page|snapshot/i;

/** The tool name an activity line starts with ("mcp__x__browser_click: …" → "mcp__x__browser_click"). */
const LEADING_NAME = /^([A-Za-z_][\w.-]*)(?::|\s|$)/;

/**
 * The kind of work an activity line or tool name is, on the farm: the shared
 * table's answer, else web for browser and screenshot tools, else null.
 */
export function farmKindOf(activity: string | undefined): WorkKind | null {
  const known = toolKindOf(activity);
  if (known) return known;
  const name = LEADING_NAME.exec(activity?.trim() ?? "")?.[1];
  return name && BROWSER_TOOL.test(name) ? "web" : null;
}

/** What a coordinator tool call is, as a kind of work. */
export function coordinatorKind(toolName: string): WorkKind {
  return COORDINATOR_TOOLS.get(toolName) ?? farmKindOf(toolName) ?? "think";
}

/** One line saying what a coordinator tool call is doing. */
export function describeTool(name: string, args: Readonly<Record<string, unknown>>): string {
  const path = text(args.file_path) ?? text(args.path);
  switch (coordinatorKind(name)) {
    case "read":
      return path ? `Reading ${clip(baseName(path), 40)}` : "Reading";
    case "edit":
      return path ? `Editing ${clip(baseName(path), 40)}` : "Editing";
    case "search": {
      const query = text(args.pattern) ?? text(args.query);
      return query ? `Searching for \u201c${clip(query, 32)}\u201d` : "Searching";
    }
    case "run": {
      const command = text(args.command);
      return command ? `Running ${clip(command, 40)}` : "Running a command";
    }
    case "web": {
      const query = text(args.query) ?? text(args.url);
      return query ? `Browsing ${clip(query, 40)}` : "Browsing the web";
    }
    case "ask":
      return "Asking you a question";
    case "delegate":
      return "Bringing in critters";
    case "wait":
      return "Waiting on critters";
    case "think":
      return "Planning";
  }
}

function workerStatus(agent: FloorAgent): WorldAgentStatus {
  switch (agent.status) {
    case "running":
      return "working";
    // A worker reports "idle" when its task is finished (it's kept a while in
    // case GG Goals hands it a follow-up). Finished means it leaves the farm,
    // like the chat's critters do; a follow-up brings it back as a new arrival.
    case "idle":
    case "done":
      return "done";
    case "error":
    case "interrupted":
      return "error";
  }
}

/**
 * Which view a goal window shows. A goal still being briefed has no Workers
 * view (null: just the chat). Once started it opens on Workers by itself,
 * unless the user switched this goal back to the chat (`chatFor` is its id).
 */
export function goalViewFor(
  goal: { readonly id: string; readonly phase: "briefing" | "active" } | null | undefined,
  chatFor: string | null,
): { readonly activeGoalId: string | null; readonly view: "workers" | "chat" | null } {
  if (goal?.phase !== "active") return { activeGoalId: null, view: null };
  return { activeGoalId: goal.id, view: chatFor === goal.id ? "chat" : "workers" };
}

export interface WorldInput {
  /** The main run is in progress. */
  readonly running: boolean;
  /** The main run's recent tool calls, oldest first. */
  readonly liveTools: readonly LiveToolEntry[];
  /** GG Goals is waiting on an answer from the user. */
  readonly waitingOnUser: boolean;
  /** Every worker GG Goals brought in, as the critter floor sees them. */
  readonly workers: readonly FloorAgent[];
}

function coordinator(input: WorldInput): WorldAgent {
  const base = {
    key: COORDINATOR_KEY,
    agentName: undefined,
    name: "GG Goals",
    coordinator: true,
  };
  if (input.waitingOnUser) {
    return { ...base, status: "working", kind: "ask", detail: "Waiting for your answer" };
  }
  if (!input.running) {
    return { ...base, status: "idle", kind: null, detail: "Ready when you are" };
  }
  const current = [...input.liveTools].reverse().find((entry) => entry.status === "running");
  if (!current) {
    // Between tool calls GG Goals is thinking over what it just did, so Ken
    // stays where that work was. Sending him to the notes board each time
    // made him pace between the board and the same station over and over
    // (a read takes a moment; the thinking after it takes far longer). Only
    // before his first tool, or once a question is answered, is he planning.
    const last = input.liveTools[input.liveTools.length - 1];
    const lastKind = last ? coordinatorKind(last.name) : null;
    const kind = lastKind && lastKind !== "ask" ? lastKind : "think";
    return { ...base, status: "working", kind, detail: "Planning" };
  }
  return {
    ...base,
    status: "working",
    kind: coordinatorKind(current.name),
    detail: describeTool(current.name, current.args),
  };
}

/** Everyone in the world right now: GG Goals first, then its workers. */
export function collectWorldAgents(input: WorldInput): WorldAgent[] {
  const workers = input.workers.map((agent): WorldAgent => {
    const status = workerStatus(agent);
    const activity = agent.activity?.trim();
    const kind = status === "working" ? (farmKindOf(activity) ?? "think") : null;
    return {
      key: agent.key,
      agentName: agent.agentName,
      name: agent.label,
      coordinator: false,
      status,
      kind,
      detail:
        status === "done"
          ? "Finished"
          : status === "error"
            ? "Stopped"
            : activity
              ? clip(activity)
              : status === "working"
                ? "Thinking"
                : "Waiting for work",
    };
  });
  return [coordinator(input), ...workers];
}

/** How many sample workers the sample crowd brings in. */
export const PREVIEW_CROWD_SIZE = 18;
/** How long each sample worker stays on one job before moving to the next. */
const PREVIEW_JOB_MS = 16000;

/**
 * A crowd of sample workers, for the farm's simulation tests: GG Goals
 * plus PREVIEW_CROWD_SIZE workers, each moving on to a different kind of
 * work every few seconds (staggered, so someone is always travelling), now
 * and then idling at the lounge. Pure: the same `now` gives the same crowd.
 */
export function previewCrowd(now: number): WorldAgent[] {
  const coordinator: WorldAgent = {
    key: COORDINATOR_KEY,
    agentName: undefined,
    name: "GG Goals",
    coordinator: true,
    status: "working",
    kind: "delegate",
    detail: "Bringing in workers",
  };
  const workers = Array.from({ length: PREVIEW_CROWD_SIZE }, (_, i): WorldAgent => {
    const turn = Math.floor((now + i * 3700) / PREVIEW_JOB_MS);
    const pick = (turn * 7 + i * 3) % (WORK_KINDS.length + 1);
    const kind = pick === WORK_KINDS.length ? null : (WORK_KINDS[pick] ?? null);
    return {
      key: `preview-${i}`,
      agentName: undefined,
      name: `Preview ${i + 1}`,
      coordinator: false,
      status: kind ? "working" : "idle",
      kind,
      detail: kind ? `Sample ${kind} work` : "Waiting",
    };
  });
  return [coordinator, ...workers];
}
