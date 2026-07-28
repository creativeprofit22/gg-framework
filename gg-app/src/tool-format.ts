// Port of packages/ggcoder/src/ui/tool-line-summary.ts + tool-presentation.ts.
// Builds the same styled tool line the TUI shows:
//   ● Read App.tsx · 42 lines      (done)
//   ● Running pnpm check…          (running)
import type { TaskOutputDetails, TaskOutputToolResultDetails } from "./agent";
import { theme } from "./theme";

const MAX_DETAIL = 44;

export type ToolTone =
  | "read"
  | "search"
  | "write"
  | "run"
  | "web"
  | "agent"
  | "state"
  | "source"
  | "default";

export interface ToolLinePart {
  text: string;
  bold?: boolean;
  tone?: ToolTone;
  dim?: boolean;
}

interface VerbPair {
  running: string;
  done: string;
}

const VERBS: Record<string, VerbPair> = {
  read: { running: "Reading", done: "Read" },
  ls: { running: "Listing", done: "Listed" },
  grep: { running: "Searching", done: "Searched" },
  find: { running: "Finding", done: "Found" },
  write: { running: "Writing", done: "Wrote" },
  edit: { running: "Updating", done: "Updated" },
  bash: { running: "Running", done: "Ran" },
  task_output: { running: "Reading output", done: "Read output" },
  web_fetch: { running: "Fetching", done: "Fetched" },
  web_search: { running: "Searching web", done: "Searched web" },
  subagent: { running: "Delegating", done: "Delegated" },
  skill: { running: "Loading skill", done: "Loaded skill" },
  source_path: { running: "Resolving", done: "Resolved" },
  tasks: { running: "Updating tasks", done: "Updated tasks" },
  screenshot: { running: "Capturing", done: "Captured" },
  enter_plan: { running: "Entering plan", done: "Entered plan" },
  exit_plan: { running: "Submitting plan", done: "Submitted plan" },
  roadmap_status: { running: "Updating roadmap", done: "Updated roadmap" },
  "mcp__kencode-search__searchCode": { running: "Searching code", done: "Searched code" },
  "mcp__kencode-search__referenceSources": {
    running: "Finding references",
    done: "Found references",
  },
  "mcp__kencode-search__discoverRepos": { running: "Discovering repos", done: "Discovered repos" },
};

function humanizeName(name: string): VerbPair {
  const clean = name
    .replace(/^mcp__/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  const titled = clean.charAt(0).toUpperCase() + clean.slice(1);
  return { running: titled, done: titled };
}

export function getToolTone(name: string): ToolTone {
  if (["read", "ls"].includes(name)) return "read";
  if (["grep", "find", "mcp__kencode-search__searchCode"].includes(name)) return "search";
  if (["write", "edit"].includes(name)) return "write";
  if (["bash", "task_output", "task_stop"].includes(name)) return "run";
  if (
    [
      "web_fetch",
      "web_search",
      "mcp__kencode-search__referenceSources",
      "mcp__kencode-search__discoverRepos",
    ].includes(name)
  )
    return "web";
  if (["subagent", "skill"].includes(name)) return "agent";
  if (["tasks", "roadmap_status"].includes(name)) return "state";
  if (["source_path"].includes(name)) return "source";
  if (name.startsWith("mcp__")) return "web";
  return "default";
}

/** Resolve a tone to the bold verb color (mirrors toolTonePalette `.primary`). */
export function toneColor(tone: ToolTone): string {
  switch (tone) {
    case "read":
      return theme.primary;
    case "search":
      return theme.secondary; // violet
    case "write":
      return theme.success;
    case "run":
      return theme.code; // amber
    case "web":
      return theme.language; // teal
    case "agent":
      return theme.primary;
    case "state":
      return theme.secondary;
    case "source":
      return theme.info;
    default:
      return theme.textSecondary;
  }
}

function shorten(value: string, max = MAX_DETAIL): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Terminal output can contain styling, hyperlinks, cursor controls, and other
// non-printing bytes. Keep CR/LF/tab semantics for progress while making the
// text safe to select and shorten as plain DOM content.
const TERMINAL_SEQUENCE_PATTERN = new RegExp(
  [
    String.raw`\u001B\][\s\S]*?(?:\u0007|\u001B\\|$)`, // OSC
    String.raw`\u001B[PX^_][\s\S]*?(?:\u001B\\|$)`, // DCS/SOS/PM/APC
    String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, // CSI
    String.raw`\u009B[0-?]*[ -/]*[@-~]`, // 8-bit CSI
    String.raw`\u001B[ -/]*[@-~]`, // Other two-byte ESC sequences
  ].join("|"),
  "g",
);
const NON_TEXT_CONTROL_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`,
  "g",
);

function sanitizeTerminalText(value: string): string {
  return value.replace(TERMINAL_SEQUENCE_PATTERN, "").replace(NON_TEXT_CONTROL_PATTERN, "");
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return shorten(url);
  }
}

function firstLine(text: string): string {
  return shorten(text.split("\n")[0] ?? "");
}

function latestProgressLine(output: string): string {
  const lines = sanitizeTerminalText(output).split(/[\r\n]+/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) return shorten(line);
  }
  return "";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function toolDetail(name: string, args: Record<string, unknown>): { text: string; quote: boolean } {
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return { text: basename(String(args.file_path ?? "")), quote: false };
    case "ls":
      return { text: shorten(String(args.path ?? ".")), quote: false };
    case "grep":
    case "find":
      return { text: shorten(String(args.pattern ?? "")), quote: true };
    case "bash":
      return { text: firstLine(String(args.command ?? "")), quote: false };
    case "task_output":
      return { text: shorten(String(args.id ?? "")), quote: false };
    case "web_fetch":
      return { text: hostOf(String(args.url ?? "")), quote: false };
    case "web_search":
    case "mcp__kencode-search__searchCode":
      return { text: shorten(String(args.query ?? "")), quote: true };
    case "subagent":
      return { text: shorten(String(args.agent ?? "")), quote: false };
    case "skill":
      return { text: shorten(String(args.skill ?? "")), quote: false };
    case "source_path":
      return { text: shorten(String(args.package ?? "")), quote: false };
    case "roadmap_status":
      return { text: shorten(String(args.phase_id ?? "")), quote: false };
    default:
      return { text: "", quote: false };
  }
}

function countNonEmptyLines(result: string): number {
  return result.split("\n").filter((line) => line.length > 0).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function getTaskOutputDetails(details: unknown): TaskOutputDetails | null {
  if (!isRecord(details) || !isRecord(details.taskOutput)) return null;
  const value = details.taskOutput;
  if (
    typeof value.isRunning !== "boolean" ||
    (value.exitCode !== null && !isNonNegativeInteger(value.exitCode)) ||
    (typeof value.signal !== "string" && value.signal !== null) ||
    (value.completedAt !== null &&
      (typeof value.completedAt !== "number" ||
        !Number.isFinite(value.completedAt) ||
        Number.isNaN(new Date(value.completedAt).getTime()))) ||
    !isNonNegativeInteger(value.startOffset) ||
    !isNonNegativeInteger(value.endOffset) ||
    value.endOffset < value.startOffset ||
    !isNonNegativeInteger(value.skippedBytes) ||
    !isNonNegativeInteger(value.remainingBytes) ||
    (typeof value.logFile !== "string" && value.logFile !== null) ||
    typeof value.presentationCapped !== "boolean"
  ) {
    return null;
  }
  return (details as unknown as TaskOutputToolResultDetails).taskOutput;
}

function taskOutputSummary(details: unknown): string {
  const taskOutput = getTaskOutputDetails(details);
  if (!taskOutput) return "";
  const status = taskOutput.isRunning
    ? "running"
    : taskOutput.signal
      ? `signal ${taskOutput.signal}`
      : taskOutput.exitCode !== null
        ? `exit ${taskOutput.exitCode}`
        : "completed";
  const summary = [
    status,
    `bytes ${taskOutput.startOffset}-${taskOutput.endOffset}`,
    taskOutput.skippedBytes > 0 ? `${taskOutput.skippedBytes} skipped` : null,
    taskOutput.remainingBytes > 0 ? `${taskOutput.remainingBytes} unread` : null,
    taskOutput.presentationCapped ? "output capped" : null,
  ];
  return summary.filter((part): part is string => part !== null).join(" · ");
}

function inlineSummary(name: string, result: string, details: unknown): string {
  if (!result) return "";
  switch (name) {
    case "read":
    case "web_fetch": {
      if (result.startsWith("Error")) return "";
      const n = countNonEmptyLines(result);
      return `${n} ${plural(n, "line")}`;
    }
    case "write": {
      const m = result.match(/Wrote (\d+) lines?/);
      return m ? `${m[1]} ${plural(Number(m[1]), "line")}` : "";
    }
    case "edit": {
      const diff = (details as { diff?: string } | undefined)?.diff ?? result;
      const added = (diff.match(/^\+[^+]/gm) ?? []).length;
      const removed = (diff.match(/^-[^-]/gm) ?? []).length;
      return added > 0 || removed > 0 ? `+${added} \u2212${removed}` : "";
    }
    case "bash": {
      const exit = result.match(/Exit code: (\S+)/)?.[1];
      return exit ? `exit ${exit}` : "";
    }
    case "task_output":
      return taskOutputSummary(details);
    case "grep": {
      const matches = result
        .split("\n")
        .filter((line) => line.length > 0 && !/^\d+ match|^\[Truncated/.test(line)).length;
      return matches > 0 ? `${matches} ${plural(matches, "match", "matches")}` : "";
    }
    case "find": {
      const n = countNonEmptyLines(result);
      return `${n} ${plural(n, "file")}`;
    }
    case "ls": {
      const n = countNonEmptyLines(result);
      return `${n} ${plural(n, "item")}`;
    }
    default:
      return "";
  }
}

export function buildToolLineParts(
  name: string,
  args: Record<string, unknown>,
  input: {
    done: boolean;
    isError?: boolean;
    result?: string;
    progressOutput?: string;
    details?: unknown;
  },
): ToolLinePart[] {
  const verbs = VERBS[name] ?? humanizeName(name);
  const tone = getToolTone(name);
  const verb = input.done ? verbs.done : verbs.running;
  const { text: detail, quote } = toolDetail(name, args);

  const parts: ToolLinePart[] = [{ text: verb, bold: true, tone }];
  if (detail) {
    parts.push({ text: ` ${quote ? `"${detail}"` : detail}` });
  }
  if (input.done) {
    const summary = input.isError
      ? firstLine(input.result ?? "")
      : inlineSummary(name, input.result ?? "", input.details);
    if (summary) parts.push({ text: ` \u00b7 ${summary}`, dim: true });
  } else {
    const progress = name === "bash" ? latestProgressLine(input.progressOutput ?? "") : "";
    parts.push(progress ? { text: ` \u00b7 ${progress}`, dim: true } : { text: "\u2026" });
  }
  return parts;
}
