import type { ContentPart, Message, ToolResult } from "@kenkaiiii/gg-ai";
import { hasUnsafeShellSyntax, splitShellCommandSegments } from "../tools/read-only-bash.js";

export interface VerificationCommandClassification {
  accepted: boolean;
  /** False for ordinary shell work that was never plausibly a verification attempt. */
  candidate: boolean;
  reason: string;
}

export interface VerificationEvidence {
  command: string;
  status: "passed" | "failed" | "rejected";
  reason: string;
}

export type RoadmapVerificationEvidenceUnmetCode =
  | "missing-expected-revision"
  | "missing-approved-evidence"
  | "rejected-evidence"
  | "unclassified-evidence"
  | "failed-evidence"
  | "stale-evidence"
  | "duplicate-evidence"
  | "criterion-evidence-mismatch"
  | "unmatched-evidence";

export interface RoadmapVerificationEvidenceEvaluation {
  ready: boolean;
  unmetEvidenceCodes: RoadmapVerificationEvidenceUnmetCode[];
}

const LONG_RUNNING_FLAGS = new Set([
  "--watch",
  "--watchall",
  "--watchall=false",
  "--ui",
  "--inspect",
  "--inspect-brk",
  "-w",
]);
const MUTATING_FLAGS = new Set([
  "--init",
  "--build",
  "-b",
  "--clean",
  "--fix",
  "--write",
  "--update",
  "-u",
  "--updatesnapshot",
  "--incremental",
  "--tsbuildinfofile",
  "--emitdeclarationonly",
]);
const AMBIGUOUS_FLAGS = new Set([
  "--nocheck",
  "--listfilesonly",
  "--showconfig",
  "--help",
  "-h",
  "--version",
  "--generatetrace",
  "--traceresolution",
  "--diagnostics",
  "--extendeddiagnostics",
  "--generatecpuprofile",
  "--collect-only",
  "--listtests",
]);
const SAFE_PACKAGE_SCRIPTS =
  /^(?:test(?::(?:unit|integration|e2e))?|check|typecheck|type-check|lint(?::check)?|format(?::check|-check)|prettier:check)$/i;
const UNSAFE_PACKAGE_SCRIPTS =
  /^(?:build|clean|dev|serve|start|watch|preview|prepare|install|format|lint:fix|test:watch)(?::|$)/i;
const VERIFIER_WORDS =
  /(?:^|\s|\/)(?:tsc|vitest|jest|pytest|eslint|prettier|pyright|mypy|ruff|cargo|go|shellcheck)(?:\s|$)/i;

function tokenize(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function lowerFlags(tokens: readonly string[]): Set<string> {
  return new Set(
    tokens.filter((token) => token.startsWith("-")).map((token) => token.toLowerCase()),
  );
}

function hasFlag(flags: ReadonlySet<string>, denied: ReadonlySet<string>): boolean {
  for (const flag of flags) {
    const name = flag.split("=")[0];
    if (denied.has(flag) || denied.has(name)) return true;
  }
  return false;
}

function rejected(candidate: boolean, reason: string): VerificationCommandClassification {
  return { accepted: false, candidate, reason };
}

function accepted(reason: string): VerificationCommandClassification {
  return { accepted: true, candidate: true, reason };
}

function classifyTsc(tokens: readonly string[]): VerificationCommandClassification {
  const flags = lowerFlags(tokens);
  if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running watch/debug mode");
  if (hasFlag(flags, MUTATING_FLAGS)) return rejected(true, "mutating or artifact-producing mode");
  if (hasFlag(flags, AMBIGUOUS_FLAGS) || flags.has("-v")) {
    return rejected(true, "does not prove type correctness");
  }
  if (!flags.has("--noemit")) return rejected(true, "tsc must explicitly use --noEmit");
  return accepted("bounded TypeScript no-emit check");
}

function classifyTestRunner(
  executable: string,
  tokens: readonly string[],
): VerificationCommandClassification {
  const flags = lowerFlags(tokens);
  if (hasFlag(flags, LONG_RUNNING_FLAGS) || flags.has("--watch=false")) {
    return rejected(true, "long-running or interactive test mode");
  }
  if (hasFlag(flags, MUTATING_FLAGS)) return rejected(true, "mutating test/update mode");
  if (hasFlag(flags, AMBIGUOUS_FLAGS)) return rejected(true, "does not execute the test suite");
  if (executable === "vitest") {
    const positional = tokens.slice(1).filter((token) => !token.startsWith("-"));
    if (!positional.includes("run") && !flags.has("--run")) {
      return rejected(true, "vitest must explicitly use one-shot run mode");
    }
  }
  return accepted("bounded one-shot test check");
}

function classifyDirect(tokens: readonly string[]): VerificationCommandClassification {
  const executable = tokens[0]?.replace(/^.*[\\/]/, "").toLowerCase();
  if (!executable) return rejected(false, "empty command");
  if (executable === "tsc") return classifyTsc(tokens);
  if (executable === "vitest" || executable === "jest" || executable === "pytest") {
    return classifyTestRunner(executable, tokens);
  }

  const flags = lowerFlags(tokens);
  if (["eslint", "prettier", "ruff"].includes(executable)) {
    if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running mode");
    if (hasFlag(flags, MUTATING_FLAGS)) return rejected(true, "mutating formatter/linter mode");
    if (hasFlag(flags, AMBIGUOUS_FLAGS)) return rejected(true, "does not execute a static check");
    if (executable === "prettier" && !flags.has("--check")) {
      return rejected(true, "prettier must explicitly use --check");
    }
    if (executable === "ruff" && tokens[1] === "format" && !flags.has("--check")) {
      return rejected(true, "ruff format must explicitly use --check");
    }
    return accepted("bounded static check");
  }
  if (["pyright", "mypy", "shellcheck"].includes(executable)) {
    if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running mode");
    if (hasFlag(flags, AMBIGUOUS_FLAGS)) return rejected(true, "does not execute a static check");
    return accepted("bounded static check");
  }
  if (executable === "cargo") {
    const subcommand = tokens[1]?.toLowerCase();
    if (subcommand === "build" || subcommand === "clean" || subcommand === "run") {
      return rejected(true, "artifact-producing Cargo command");
    }
    if (subcommand === "fmt" && !flags.has("--check")) {
      return rejected(true, "cargo fmt must explicitly use --check");
    }
    return ["check", "clippy", "test", "fmt"].includes(subcommand)
      ? accepted("bounded Cargo check")
      : rejected(false, "not a recognized verification command");
  }
  if (executable === "go") {
    const subcommand = tokens[1]?.toLowerCase();
    return subcommand === "test" || subcommand === "vet"
      ? accepted("bounded Go check")
      : rejected(subcommand === "build" || subcommand === "clean", "not a bounded Go check");
  }
  return rejected(VERIFIER_WORDS.test(tokens.join(" ")), "not a recognized verification command");
}

function classifyPackageRunner(tokens: readonly string[]): VerificationCommandClassification {
  const runner = tokens[0].toLowerCase();
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (["--filter", "-f", "--dir", "-c"].includes(token)) {
      index += 2;
      continue;
    }
    if (
      token === "--workspace-root" ||
      token === "-w" ||
      token.startsWith("--filter=") ||
      token.startsWith("--dir=")
    ) {
      index += 1;
      continue;
    }
    break;
  }

  const action = tokens[index]?.toLowerCase();
  if (!action) return rejected(false, "package runner has no command");
  if (["exec", "x", "dlx"].includes(action)) return classifyDirect(tokens.slice(index + 1));

  const scriptIndex = action === "run" ? index + 1 : index;
  const script = tokens[scriptIndex]?.toLowerCase();
  if (!script) return rejected(false, "package runner has no script");
  if (UNSAFE_PACKAGE_SCRIPTS.test(script)) {
    return rejected(true, "mutating, artifact-producing, or long-running package script");
  }
  if (!SAFE_PACKAGE_SCRIPTS.test(script)) {
    return rejected(false, "package script is not a recognized verification check");
  }

  const scriptArgs = tokens.slice(scriptIndex + 1).filter((token) => token !== "--");
  const flags = lowerFlags(scriptArgs);
  if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running package-script mode");
  if (hasFlag(flags, MUTATING_FLAGS)) return rejected(true, "mutating package-script mode");
  if (hasFlag(flags, AMBIGUOUS_FLAGS))
    return rejected(true, "package script does not prove correctness");
  return accepted(`bounded ${runner} verification script`);
}

function classifySegment(segment: string): VerificationCommandClassification {
  const candidate =
    VERIFIER_WORDS.test(segment) || /(?:^|\s)(?:pnpm|npm|yarn|bun)(?:\s|$)/i.test(segment);
  if (hasUnsafeShellSyntax(segment))
    return rejected(candidate, "unsafe shell syntax or redirection");
  const tokens = tokenize(segment);
  const first = tokens[0]?.toLowerCase();
  if (["pnpm", "npm", "yarn", "bun"].includes(first)) return classifyPackageRunner(tokens);
  if (["npx", "bunx"].includes(first)) return classifyDirect(tokens.slice(1));
  return classifyDirect(tokens);
}

/** Fail-closed semantic classifier: every shell segment must be a bounded check. */
export function classifyVerificationCommand(command: string): VerificationCommandClassification {
  const candidate =
    VERIFIER_WORDS.test(command) || /(?:^|\s)(?:pnpm|npm|yarn|bun)(?:\s|$)/i.test(command);
  // Only && preserves fail-closed evidence across a chain. Pipes, OR, semicolons,
  // and newlines can hide a failed check behind a later zero exit status.
  if (
    command.includes("||") ||
    command.includes(";") ||
    command.includes("\n") ||
    /(^|[^|])\|([^|]|$)/.test(command)
  ) {
    return rejected(candidate, "shell control operator can hide a failed check");
  }
  const segments = splitShellCommandSegments(command);
  if (segments.length === 0) return rejected(false, "empty command");
  const results = segments.map(classifySegment);
  const firstRejected = results.find((result) => !result.accepted);
  if (firstRejected) {
    return rejected(
      results.some((result) => result.candidate),
      firstRejected.reason,
    );
  }
  return accepted(segments.length === 1 ? results[0].reason : "bounded verification command chain");
}

function resultText(result: ToolResult): string {
  if (typeof result.content === "string") return result.content;
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Extract harness-owned evidence from completed bash calls in a transcript. */
export function collectVerificationEvidence(messages: readonly Message[]): VerificationEvidence[] {
  const calls = new Map<
    string,
    { command: string; classification: VerificationCommandClassification; background: boolean }
  >();
  const evidence: VerificationEvidence[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as ContentPart[]) {
        if (part.type !== "tool_call" || part.name !== "bash") continue;
        const command = typeof part.args.command === "string" ? part.args.command.trim() : "";
        const background = part.args.run_in_background === true || part.args.persist === true;
        calls.set(part.id, {
          command,
          classification: classifyVerificationCommand(command),
          background,
        });
      }
    }
    if (message.role !== "tool") continue;
    for (const result of message.content as ToolResult[]) {
      const call = calls.get(result.toolCallId);
      if (!call || !call.classification.candidate) continue;
      if (call.background) {
        evidence.push({
          command: call.command,
          status: "rejected",
          reason: "background or persistent commands are not bounded evidence",
        });
        continue;
      }
      if (!call.classification.accepted) {
        evidence.push({
          command: call.command,
          status: "rejected",
          reason: call.classification.reason,
        });
        continue;
      }
      const passed = !result.isError && /^Exit code:\s*0(?:\s|$)/i.test(resultText(result).trim());
      evidence.push({
        command: call.command,
        status: passed ? "passed" : "failed",
        reason: passed ? call.classification.reason : "bounded check did not exit successfully",
      });
    }
  }
  return evidence;
}

type ShellEvidence = Omit<VerificationEvidence, "status"> & {
  status: VerificationEvidence["status"] | "unclassified";
};

function collectShellEvidence(messages: readonly Message[]): ShellEvidence[] {
  const calls = new Map<
    string,
    { command: string; classification: VerificationCommandClassification; background: boolean }
  >();
  const evidence: ShellEvidence[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as ContentPart[]) {
        if (part.type !== "tool_call" || part.name !== "bash") continue;
        const command = typeof part.args.command === "string" ? part.args.command.trim() : "";
        calls.set(part.id, {
          command,
          classification: classifyVerificationCommand(command),
          background: part.args.run_in_background === true || part.args.persist === true,
        });
      }
    }
    if (message.role !== "tool") continue;
    for (const result of message.content as ToolResult[]) {
      const call = calls.get(result.toolCallId);
      if (!call) continue;
      if (call.background) {
        evidence.push({
          command: call.command,
          status: "rejected",
          reason: "background or persistent commands are not bounded evidence",
        });
      } else if (!call.classification.candidate) {
        evidence.push({
          command: call.command,
          status: "unclassified",
          reason: call.classification.reason,
        });
      } else if (!call.classification.accepted) {
        evidence.push({
          command: call.command,
          status: "rejected",
          reason: call.classification.reason,
        });
      } else {
        const passed =
          !result.isError && /^Exit code:\s*0(?:\s|$)/i.test(resultText(result).trim());
        evidence.push({
          command: call.command,
          status: passed ? "passed" : "failed",
          reason: passed ? call.classification.reason : "bounded check did not exit successfully",
        });
      }
    }
  }
  return evidence;
}

export function partitionVerificationMessagesForRevision(
  messages: readonly Message[],
  expectedRevision: number,
): { currentMessages: Message[]; staleMessages: Message[] } {
  const roadmapCalls = new Set<string>();
  let boundary = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as ContentPart[]) {
        if (part.type === "tool_call" && part.name === "roadmap_status") roadmapCalls.add(part.id);
      }
    }
    if (message.role !== "tool") continue;
    for (const result of message.content as ToolResult[]) {
      if (!roadmapCalls.has(result.toolCallId)) continue;
      try {
        const parsed = JSON.parse(resultText(result)) as { result?: unknown; revision?: unknown };
        if (
          typeof parsed.revision === "number" &&
          parsed.revision <= expectedRevision &&
          (parsed.result === "committed" || parsed.result === "completion-review-committed")
        ) {
          boundary = index + 1;
        }
      } catch {
        // A malformed/partial tool result is not a trustworthy revision boundary.
      }
    }
  }

  return {
    staleMessages: messages.slice(0, boundary),
    currentMessages: messages.slice(boundary),
  };
}

function normalizedEvidenceText(value: string): string {
  return value
    .replace(/[`'"\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function referencesCommand(evidence: string, command: string): boolean {
  const normalizedCommand = normalizedEvidenceText(command);
  return (
    normalizedCommand.length > 0 && normalizedEvidenceText(evidence).includes(normalizedCommand)
  );
}

/**
 * Bind a passed Roadmap review handoff to harness-owned shell evidence.
 * Each Done When item must cite one distinct, current-revision command verbatim.
 */
export function evaluateRoadmapVerificationEvidence(input: {
  doneWhen: readonly string[];
  evidence: readonly string[];
  expectedRevision: number | undefined;
  currentMessages: readonly Message[];
  staleMessages?: readonly Message[];
}): RoadmapVerificationEvidenceEvaluation {
  const unmet = new Set<RoadmapVerificationEvidenceUnmetCode>();
  if (input.expectedRevision === undefined) unmet.add("missing-expected-revision");
  if (input.evidence.length !== input.doneWhen.length) unmet.add("criterion-evidence-mismatch");

  const normalizedItems = input.evidence.map(normalizedEvidenceText);
  if (new Set(normalizedItems).size !== normalizedItems.length) unmet.add("duplicate-evidence");

  const current = collectShellEvidence(input.currentMessages);
  const stale = collectShellEvidence(input.staleMessages ?? []);
  const usedCommands = new Set<string>();
  let approvedMatches = 0;

  for (const item of input.evidence) {
    const matches = current.filter((candidate) => referencesCommand(item, candidate.command));
    if (new Set(matches.map((candidate) => normalizedEvidenceText(candidate.command))).size > 1) {
      unmet.add("unmatched-evidence");
      continue;
    }
    const passed = matches.at(-1);
    if (passed?.status === "passed") {
      const commandKey = normalizedEvidenceText(passed.command);
      if (usedCommands.has(commandKey)) unmet.add("duplicate-evidence");
      else {
        usedCommands.add(commandKey);
        approvedMatches += 1;
      }
      continue;
    }
    if (matches.some((candidate) => candidate.status === "rejected")) {
      unmet.add("rejected-evidence");
      continue;
    }
    if (matches.some((candidate) => candidate.status === "failed")) {
      unmet.add("failed-evidence");
      continue;
    }
    if (matches.some((candidate) => candidate.status === "unclassified")) {
      unmet.add("unclassified-evidence");
      continue;
    }
    if (stale.some((candidate) => referencesCommand(item, candidate.command))) {
      unmet.add("stale-evidence");
      continue;
    }
    unmet.add("unmatched-evidence");
  }

  if (approvedMatches !== input.doneWhen.length) unmet.add("missing-approved-evidence");
  return { ready: unmet.size === 0, unmetEvidenceCodes: [...unmet] };
}
