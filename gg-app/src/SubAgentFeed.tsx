import { useMemo } from "react";
import { theme } from "./theme";
import { formatTokenCount } from "./ActivityBar";
import { hashKey, pickCritter, renderCritterFrame, type CritterDef } from "./critter-sprites";

/** One delegated sub-agent, mirrored from the sidecar's subagent tool stream. */
export interface SubAgentLine {
  toolCallId: string;
  /** Named agent (e.g. "researcher") when supplied, else a positional label. */
  agentName?: string;
  status: "starting" | "running" | "idle" | "done" | "error" | "interrupted";
  async?: boolean;
  /** Rolling feed of tool activities the agent has run (already humanized). */
  activities: string[];
  toolUseCount: number;
  /** Cumulative token usage for this agent (live during the run). */
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  durationMs?: number;
}

interface Props {
  agents: readonly SubAgentLine[];
  aborted?: boolean;
}

export function displayName(agent: SubAgentLine, index: number): string {
  return agent.agentName && agent.agentName !== "default" ? agent.agentName : `Agent ${index + 1}`;
}

/** Codex-style fresh-input + cached-input + output readout. */
export function formatSubAgentTokens(usage: SubAgentLine["tokenUsage"]): string | null {
  if (!usage) return null;
  // Anthropic reports newly cacheable input under cacheWrite, while OpenAI
  // reports it as ordinary non-cached input. Add writes back so the two rows
  // compare the same quantity instead of making Claude look artificially tiny.
  const freshInput = usage.input + (usage.cacheWrite ?? 0);
  const cacheRead = usage.cacheRead ?? 0;
  if (freshInput + cacheRead + usage.output === 0) return null;
  return [
    `\u2191 ${formatTokenCount(freshInput)}`,
    ...(cacheRead > 0 ? [`\u21BB ${formatTokenCount(cacheRead)} cached`] : []),
    `\u2193 ${formatTokenCount(usage.output)}`,
  ].join(" \u00b7 ");
}

/** The one-line chat summary of a delegation group, and how to colour it. */
export interface CritterSummary {
  text: string;
  tone: "working" | "done" | "failed";
}

type CritterLines = Readonly<{ one: readonly string[]; many: readonly string[] }>;

/**
 * Five ways to say each outcome, so the chat doesn't repeat itself. `{n}` is
 * the number of critters the line is about. Short and plain on purpose: the
 * details live on the critters themselves.
 */
export const CRITTER_LINES = {
  launched: {
    one: [
      "Sent a critter off to help…",
      "A critter is on the case…",
      "Summoned a critter to dig in…",
      "One critter, reporting for duty…",
      "A critter scurried off to work…",
    ],
    many: [
      "Launched {n} critters to dig in…",
      "{n} critters are on the case…",
      "Summoned {n} critters to help…",
      "Sent {n} critters off to work…",
      "{n} critters scurried off to dig in…",
    ],
  },
  succeeded: {
    one: [
      "The critter is back with the goods",
      "The critter finished the job",
      "Mission complete, the critter is home",
      "The critter wrapped things up",
      "The critter came back successful",
    ],
    many: [
      "The critters are back with the goods",
      "All {n} critters finished the job",
      "Mission complete, the critters are home",
      "The critters wrapped things up",
      "Every critter came back successful",
    ],
  },
  failed: {
    one: [
      "The critter failed…",
      "The critter ran into trouble",
      "The critter tripped up",
      "The critter didn't make it back",
      "The critter couldn't finish",
    ],
    many: [
      "{n} critters failed…",
      "{n} critters ran into trouble",
      "{n} critters tripped up",
      "{n} critters didn't make it back",
      "{n} critters couldn't finish",
    ],
  },
  /** Some came back, some didn't: `{n}` is how many failed. */
  someFailed: {
    one: [
      "One critter failed…",
      "One critter ran into trouble",
      "One critter tripped up",
      "One critter didn't make it back",
      "One critter couldn't finish",
    ],
    many: [
      "{n} critters failed…",
      "{n} critters ran into trouble",
      "{n} critters tripped up",
      "{n} critters didn't make it back",
      "{n} critters couldn't finish",
    ],
  },
  calledBack: {
    one: [
      "The critter was called back",
      "The critter was sent home early",
      "The critter stopped early",
      "Recalled the critter",
      "The critter packed up early",
    ],
    many: [
      "The critters were called back",
      "The critters were sent home early",
      "The critters stopped early",
      "Recalled {n} critters",
      "The critters packed up early",
    ],
  },
} as const satisfies Record<string, CritterLines>;

const isWorking = (agent: SubAgentLine): boolean =>
  agent.status === "running" || agent.status === "starting";

/**
 * Plain-words summary of a sub-agent group. The agents themselves live on the
 * activity bar as walking critters (see CritterFloor), so the transcript only
 * keeps a short note of what was launched and whether it worked. The wording
 * is picked from the group's first call id, so a given row keeps the same
 * phrasing on every render and after a reload, while different groups vary.
 */
export function summarizeCritters(
  agents: readonly SubAgentLine[],
  aborted = false,
): CritterSummary {
  const variant = hashKey(agents[0]?.toolCallId ?? "");
  const say = (lines: CritterLines, n: number): string => {
    const list = n === 1 ? lines.one : lines.many;
    return (list[variant % list.length] ?? "").replace("{n}", String(n));
  };
  const total = agents.length;
  if (aborted) return { text: say(CRITTER_LINES.calledBack, total), tone: "failed" };
  if (agents.some(isWorking)) {
    return { text: say(CRITTER_LINES.launched, total), tone: "working" };
  }
  // An idle background agent has finished its work (it just stays available
  // for a follow-up), so it counts as a success here, as it does on the floor.
  const failed = agents.filter((a) => a.status === "error" || a.status === "interrupted").length;
  if (failed === 0) return { text: say(CRITTER_LINES.succeeded, total), tone: "done" };
  const lines = failed === total ? CRITTER_LINES.failed : CRITTER_LINES.someFailed;
  return { text: say(lines, failed), tone: "failed" };
}

/**
 * The critter standing in for the row's status dot. A named agent shows its own
 * critter (a `bee` shows the Bee); anything else gets one picked from the
 * group's first call id, so the row keeps the same critter across renders and
 * reloads while different groups vary.
 */
function rowCritter(agents: readonly SubAgentLine[]): CritterDef {
  const first = agents[0];
  return pickCritter(first?.agentName, first?.toolCallId ?? "", new Set());
}

/**
 * In-transcript record of the sub-agents spawned in a turn: one short, plain
 * line ("Launched 3 critters to dig in…") led by a little critter in the
 * assistant-dot gutter. It hops while the agents work, stands when they
 * succeed and tips over when they fail. The live view (who is running, their
 * tokens and current tool) is the critters on the activity bar.
 */
export function SubAgentFeed({ agents, aborted = false }: Props): React.ReactElement | null {
  const critter = rowCritter(agents);
  // The sprite only depends on which critter it is; the transcript re-renders
  // on every streamed token, so don't rebuild the SVG each time.
  const sprite = useMemo(() => renderCritterFrame(critter, 0), [critter]);
  if (agents.length === 0) return null;
  const summary = summarizeCritters(agents, aborted);
  return (
    <div className="subagents subagents-compact" data-swap-row="">
      <span className="subagents-critter" aria-hidden="true">
        <img
          className={`subagents-critter-img subagents-critter-${summary.tone}`}
          src={sprite}
          alt=""
          draggable={false}
        />
      </span>
      <span className="subagents-compact-text" style={{ color: theme.textSecondary }}>
        {summary.text}
      </span>
    </div>
  );
}
