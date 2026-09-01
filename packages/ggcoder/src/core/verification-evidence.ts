import { createHash } from "node:crypto";
import type { ContentPart, Message, ToolResult } from "@kenkaiiii/gg-ai";
import {
  NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH,
  type NotesVerificationEvidenceV1,
  type NotesWorkspaceSnapshotV1,
} from "@kenkaiiii/gg-core/project-notes";
import { hasUnsafeShellSyntax, splitShellCommandSegments } from "../tools/read-only-bash.js";

export interface VerificationCommandClassification {
  accepted: boolean;
  /** False for ordinary shell work that was never plausibly a verification attempt. */
  candidate: boolean;
  reason: string;
}

export const ROADMAP_VERIFICATION_CLASSIFIER_VERSION = "roadmap-verification-v1";

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

export interface RoadmapVerificationCriterionCoverage {
  criterionIndex: number;
  criterion: string;
  evidence: string;
  command: string;
}

export type RoadmapVerificationEvidenceEvaluation =
  | {
      ready: false;
      unmetEvidenceCodes: RoadmapVerificationEvidenceUnmetCode[];
    }
  | {
      ready: true;
      unmetEvidenceCodes: [];
      criterionCoverage: RoadmapVerificationCriterionCoverage[];
    };

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

export function roadmapCriterionId(index: number, criterion: string): string {
  return createHash("sha256").update(`${index}\0${criterion.trim().replace(/\s+/g, " ")}`).digest("hex");
}

const GENERIC_VERIFICATION_COMMAND_DISPLAY = "Approved verification command";
const REDACTED_COMMAND_VALUE = "[REDACTED]";
const SENSITIVE_COMMAND_NAME =
  /(?:^|[-_])(?:auth(?:orization)?|token|password|passwd|passphrase|secret|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|key|user(?:name)?|cookie)(?:$|[-_])/i;

interface VerificationDisplayToken {
  value: string;
  quoted: boolean;
}

function tokenizeVerificationDisplay(command: string): VerificationDisplayToken[] | null {
  if (!command || /[^\x20-\x7e]/.test(command)) return null;
  const tokens: VerificationDisplayToken[] = [];
  let value = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let quoted = false;
  let started = false;
  const flush = () => {
    if (!started) return;
    tokens.push({ value, quoted });
    value = "";
    quoted = false;
    started = false;
  };

  for (const character of command) {
    if (escaped) {
      value += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"') escaped = true;
      else value += character;
      started = true;
      quoted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
      started = true;
    } else if (character === "\\") {
      escaped = true;
      started = true;
    } else if (/\s/.test(character)) {
      flush();
    } else {
      value += character;
      started = true;
    }
  }
  if (quote || escaped) return null;
  flush();
  return tokens.length > 0 ? tokens : null;
}

function isSensitiveCommandName(value: string): boolean {
  const name = value.replace(/^--?/, "");
  return SENSITIVE_COMMAND_NAME.test(name) || /(?:Auth|Token|Password|Secret|Credential|Key)$/.test(name);
}

function renderVerificationDisplayToken(token: VerificationDisplayToken): string {
  return token.quoted || /\s/.test(token.value) ? JSON.stringify(token.value) : token.value;
}

/** Format untrusted verifier commands for durable Notes without exposing credential arguments. */
export function formatVerificationCommandDisplay(command: string): string {
  const tokens = tokenizeVerificationDisplay(command);
  if (!tokens) return GENERIC_VERIFICATION_COMMAND_DISPLAY;
  const display: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const assignmentIndex = token.value.indexOf("=");
    if (assignmentIndex > 0) {
      display.push(`${token.value.slice(0, assignmentIndex)}=${REDACTED_COMMAND_VALUE}`);
      continue;
    }

    const headerName = /^([^:]+):/.exec(token.value)?.[1];
    if (headerName && isSensitiveCommandName(headerName)) {
      display.push(`${headerName}: ${REDACTED_COMMAND_VALUE}`);
      continue;
    }

    const isHeaderFlag = token.value === "-H" || token.value.toLowerCase() === "--header";
    const isSensitiveShortFlag = /^-[pPktu]$/.test(token.value);
    if (isHeaderFlag || isSensitiveShortFlag || isSensitiveCommandName(token.value)) {
      const next = tokens[index + 1];
      if (next?.value === "=" || next?.value === ":") {
        return GENERIC_VERIFICATION_COMMAND_DISPLAY;
      }
      display.push(renderVerificationDisplayToken(token));
      if (next) {
        display.push(REDACTED_COMMAND_VALUE);
        index += 1;
      }
      continue;
    }

    if (/^(?:bearer|basic)$/i.test(token.value)) {
      display.push(token.value, REDACTED_COMMAND_VALUE);
      if (tokens[index + 1]) index += 1;
      continue;
    }
    if (token.quoted || /:\/\/[^/\s@]+@/.test(token.value)) {
      return GENERIC_VERIFICATION_COMMAND_DISPLAY;
    }
    display.push(renderVerificationDisplayToken(token));
  }

  const formatted = display.join(" ").slice(0, NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH);
  return formatted || GENERIC_VERIFICATION_COMMAND_DISPLAY;
}
export function createDurableVerificationEvidence(input: {
  coverage: readonly RoadmapVerificationCriterionCoverage[];
  workspace: NotesWorkspaceSnapshotV1;
  observedAt: string;
}): NotesVerificationEvidenceV1[] {
  return input.coverage.map((coverage) => ({
    commandHash: createHash("sha256").update(coverage.command).digest("hex"),
    commandDisplay: formatVerificationCommandDisplay(coverage.command),
    exitCode: 0,
    classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
    verdict: "approved",
    criterionId: roadmapCriterionId(coverage.criterionIndex, coverage.criterion),
    observedAt: input.observedAt,
    workspace: structuredClone(input.workspace),
  }));
}

export interface DurableVerificationEvidenceEvaluation {
  ready: boolean;
  staleCriterionIds: string[];
  missingCriterionIds: string[];
  criterionCoverage: RoadmapVerificationCriterionCoverage[];
}

export function evaluateDurableVerificationEvidence(input: {
  doneWhen: readonly string[];
  evidence: readonly NotesVerificationEvidenceV1[];
  workspace: NotesWorkspaceSnapshotV1;
  classifierVersion?: string;
}): DurableVerificationEvidenceEvaluation {
  const classifierVersion = input.classifierVersion ?? ROADMAP_VERIFICATION_CLASSIFIER_VERSION;
  const staleCriterionIds: string[] = [];
  const missingCriterionIds: string[] = [];
  const criterionCoverage: RoadmapVerificationCriterionCoverage[] = [];
  const commandHashes = new Set<string>();
  for (let offset = 0; offset < input.doneWhen.length; offset += 1) {
    const criterion = input.doneWhen[offset] ?? "";
    const criterionId = roadmapCriterionId(offset + 1, criterion);
    const candidates = input.evidence.filter((item) => item.criterionId === criterionId);
    const current = [...candidates].reverse().find((item) =>
      item.exitCode === 0 &&
      item.verdict === "approved" &&
      item.classifierVersion === classifierVersion &&
      workspaceEvidenceMatches(item.workspace, input.workspace),
    );
    if (!current) {
      (candidates.length > 0 ? staleCriterionIds : missingCriterionIds).push(criterionId);
      continue;
    }
    if (commandHashes.has(current.commandHash)) {
      missingCriterionIds.push(criterionId);
      continue;
    }
    commandHashes.add(current.commandHash);
    criterionCoverage.push({
      criterionIndex: offset + 1,
      criterion,
      evidence: current.commandDisplay,
      command: current.commandDisplay,
    });
  }
  return {
    ready: criterionCoverage.length === input.doneWhen.length,
    staleCriterionIds,
    missingCriterionIds,
    criterionCoverage,
  };
}

function workspaceEvidenceMatches(
  left: NotesWorkspaceSnapshotV1,
  right: NotesWorkspaceSnapshotV1,
): boolean {
  return left.version === right.version &&
    left.repository.projectKey === right.repository.projectKey &&
    left.repository.identityHash === right.repository.identityHash &&
    left.repository.rootCommit === right.repository.rootCommit &&
    left.headCommit === right.headCommit &&
    left.worktreeDigest === right.worktreeDigest &&
    left.clean === right.clean;
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

export type RoadmapShellEvidence = Omit<VerificationEvidence, "status"> & {
  status: VerificationEvidence["status"] | "unclassified";
  workspace?: NotesWorkspaceSnapshotV1;
  classifierVersion?: string;
};

function collectShellEvidence(messages: readonly Message[]): RoadmapShellEvidence[] {
  const calls = new Map<
    string,
    { command: string; classification: VerificationCommandClassification; background: boolean }
  >();
  const evidence: RoadmapShellEvidence[] = [];

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

const READ_ONLY_OR_METADATA_TOOLS = new Set([
  "code_nav",
  "code_search",
  "find",
  "grep",
  "ls",
  "read",
  "roadmap_inspect",
  "roadmap_phase_draft",
  "roadmap_status",
  "skill",
  "task_output",
  "tasks",
  "tool_search",
  "web_fetch",
  "web_search",
]);

function isWorkspaceMutation(call: { name: string; args: Record<string, unknown> }): boolean {
  if (call.name === "bash") {
    const command = typeof call.args.command === "string" ? call.args.command.trim() : "";
    return !classifyVerificationCommand(command).accepted;
  }
  return !READ_ONLY_OR_METADATA_TOOLS.has(call.name);
}

export interface SessionVerificationEvidenceLedgerSnapshot {
  currentEvidence: RoadmapShellEvidence[];
  staleEvidence: RoadmapShellEvidence[];
}

interface BashExecutionDiagnostics {
  executionId?: unknown;
  command?: unknown;
  reason?: unknown;
  exitCode?: unknown;
}

// simplification: Retain 100 executions; persist per-phase evidence if deeper history is required.
const SESSION_VERIFICATION_LEDGER_MAX_ENTRIES = 100;
const SESSION_VERIFICATION_EXECUTION_ID_MAX_LENGTH = 128;

/** Session-owned harness evidence; transcript compaction cannot rewrite this ledger. */
export class SessionVerificationEvidenceLedger {
  private generation = 0;
  private readonly entries = new Map<
    string,
    { generation: number; evidence: RoadmapShellEvidence }
  >();

  recordToolResult(input: {
    name: string;
    args: Record<string, unknown>;
    isError: boolean;
    details?: unknown;
    workspace?: NotesWorkspaceSnapshotV1;
  }): void {
    if (isWorkspaceMutation(input)) this.generation += 1;
    if (input.name !== "bash") return;

    const details = input.details as { bashDiagnostics?: BashExecutionDiagnostics } | undefined;
    const diagnostics = details?.bashDiagnostics;
    const executionId =
      typeof diagnostics?.executionId === "string" ? diagnostics.executionId.trim() : "";
    const command = typeof diagnostics?.command === "string" ? diagnostics.command.trim() : "";
    const requestedCommand =
      typeof input.args.command === "string" ? input.args.command.trim() : "";
    if (
      !executionId ||
      executionId.length > SESSION_VERIFICATION_EXECUTION_ID_MAX_LENGTH ||
      !command ||
      command.length > NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH ||
      command !== requestedCommand
    ) {
      return;
    }

    const classification = classifyVerificationCommand(command);
    const background = input.args.run_in_background === true || input.args.persist === true;
    let evidence: RoadmapShellEvidence;
    if (background) {
      evidence = {
        command,
        status: "rejected",
        reason: "background or persistent commands are not bounded evidence",
      };
    } else if (!classification.candidate) {
      evidence = { command, status: "unclassified", reason: classification.reason };
    } else if (!classification.accepted) {
      evidence = { command, status: "rejected", reason: classification.reason };
    } else {
      const passed =
        !input.isError && diagnostics?.reason === "completed" && diagnostics.exitCode === 0;
      evidence = {
        command,
        status: passed ? "passed" : "failed",
        reason: passed ? classification.reason : "bounded check did not exit successfully",
      };
    }
    if (input.workspace) {
      evidence.workspace = structuredClone(input.workspace);
      evidence.classifierVersion = ROADMAP_VERIFICATION_CLASSIFIER_VERSION;
    }
    this.entries.delete(executionId);
    this.entries.set(executionId, { generation: this.generation, evidence });
    while (this.entries.size > SESSION_VERIFICATION_LEDGER_MAX_ENTRIES) {
      const oldestExecutionId = this.entries.keys().next().value;
      if (oldestExecutionId === undefined) break;
      this.entries.delete(oldestExecutionId);
    }
  }

  snapshot(): SessionVerificationEvidenceLedgerSnapshot {
    const currentEvidence: RoadmapShellEvidence[] = [];
    const staleEvidence: RoadmapShellEvidence[] = [];
    for (const entry of this.entries.values()) {
      (entry.generation === this.generation ? currentEvidence : staleEvidence).push({
        ...entry.evidence,
      });
    }
    return { currentEvidence, staleEvidence };
  }

  clear(): void {
    this.generation = 0;
    this.entries.clear();
  }
}

/** Partition evidence after the latest conservative workspace-mutation boundary. */
export function partitionVerificationMessagesForWorkspaceMutation(messages: readonly Message[]): {
  currentMessages: Message[];
  staleMessages: Message[];
} {
  const calls = new Map<
    string,
    { name: string; args: Record<string, unknown>; messageIndex: number }
  >();
  let boundary = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as ContentPart[]) {
        if (part.type !== "tool_call") continue;
        calls.set(part.id, { name: part.name, args: part.args, messageIndex: index });
      }
    }
    if (message.role !== "tool") continue;
    for (const result of message.content as ToolResult[]) {
      const call = calls.get(result.toolCallId);
      if (call && isWorkspaceMutation(call)) boundary = Math.max(boundary, call.messageIndex);
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
 * Each Done When item must cite one distinct, current-workspace command verbatim.
 */
export function evaluateRoadmapVerificationEvidence(input: {
  doneWhen: readonly string[];
  evidence: readonly string[];
  expectedRevision: number | undefined;
  currentMessages: readonly Message[];
  staleMessages?: readonly Message[];
  currentLedgerEvidence?: readonly RoadmapShellEvidence[];
  staleLedgerEvidence?: readonly RoadmapShellEvidence[];
}): RoadmapVerificationEvidenceEvaluation {
  const unmet = new Set<RoadmapVerificationEvidenceUnmetCode>();
  if (input.expectedRevision === undefined) unmet.add("missing-expected-revision");
  if (input.evidence.length !== input.doneWhen.length) unmet.add("criterion-evidence-mismatch");

  const normalizedItems = input.evidence.map(normalizedEvidenceText);
  if (new Set(normalizedItems).size !== normalizedItems.length) unmet.add("duplicate-evidence");

  const current = [
    ...collectShellEvidence(input.currentMessages),
    ...(input.currentLedgerEvidence ?? []),
  ];
  const stale = [
    ...collectShellEvidence(input.staleMessages ?? []),
    ...(input.staleLedgerEvidence ?? []),
  ];
  const usedCommands = new Set<string>();
  const criterionCoverage: RoadmapVerificationCriterionCoverage[] = [];
  let approvedMatches = 0;

  for (const [criterionOffset, item] of input.evidence.entries()) {
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
        criterionCoverage.push({
          criterionIndex: criterionOffset + 1,
          criterion: input.doneWhen[criterionOffset] ?? "",
          evidence: item,
          command: passed.command,
        });
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
  if (unmet.size > 0) return { ready: false, unmetEvidenceCodes: [...unmet] };
  return { ready: true, unmetEvidenceCodes: [], criterionCoverage };
}
