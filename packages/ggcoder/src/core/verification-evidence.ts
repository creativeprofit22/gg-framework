import { createHash } from "node:crypto";
import type { ContentPart, Message, ToolResult } from "@kenkaiiii/gg-ai";
import {
  NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH,
  type NotesWorkspaceSnapshotV1,
} from "@kenkaiiii/gg-core/project-notes";
import {
  hasUnsafeShellSyntax,
  isReadOnlyCommand,
  splitShellCommandSegments,
} from "../tools/read-only-bash.js";
import { editTargetPaths } from "../tools/edit-targets.js";
import { getSafeToolEnv } from "../tools/safe-env.js";
import { resolveShell } from "./shell.js";
import { isCheckOwnFile, isCodeFilePath } from "./verification-paths.js";

export interface VerificationCommandClassification {
  accepted: boolean;
  /** False for ordinary shell work that was never plausibly a verification attempt. */
  candidate: boolean;
  /** True when the command can rewrite files (fixers, builders, emitters): the
   *  verification gate bumps its mutation revision when such a check STARTS,
   *  because earlier in-flight evidence cannot cover files it may change. A
   *  rejected-but-non-mutating check (an unrecognized runner like `make test`)
   * must NOT poison the revision — its green output is merely not evidence. */
  mayMutate: boolean;
  reason: string;
  /** Still rejected by transcript parsing; only the live host can prove unchanged inputs. */
  snapshotEligible?: boolean;
  /** Comparison may preserve earlier evidence, but must never certify this command. */
  snapshotPreserveOnly?: boolean;
  /** A non-zero exit may come from a non-check part (`grep` matching nothing),
   *  so it is not recorded as a failed check — only as missing evidence. */
  ambiguousFailure?: boolean;
}

export const ROADMAP_VERIFICATION_CLASSIFIER_VERSION = "roadmap-verification-v2";

export interface VerificationEvidence {
  command: string;
  status: "passed" | "failed" | "rejected" | "unavailable";
  reason: string;
}

/** Foreground reasons that are final outcomes (`backgrounded` is not: it is still running). */
const TERMINAL_SHELL_REASONS: readonly string[] = [
  "completed",
  "nonZeroExit",
  "spawnError",
  "timedOut",
  "inactive",
  "aborted",
];

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
  /^(?:build|clean|dev|serve|start|watch|preview|prepare|install|format(?!:check$)|lint:fix|test:watch)(?::|$)/i;
const VERIFIER_EXECUTABLES = new Set([
  "tsc",
  "vitest",
  "jest",
  "pytest",
  "eslint",
  "prettier",
  "pyright",
  "mypy",
  "ruff",
  "cargo",
  "go",
  "shellcheck",
]);

function tokenize(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function executableBasename(token: string | undefined): string {
  return (
    token
      ?.replace(/^.*[\\/]/, "")
      .replace(/\.exe$/i, "")
      .toLowerCase() ?? ""
  );
}

function hasVerifierExecutable(command: string): boolean {
  return tokenize(command).some((token) => VERIFIER_EXECUTABLES.has(executableBasename(token)));
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

function rejected(
  candidate: boolean,
  reason: string,
  mayMutate = false,
): VerificationCommandClassification {
  return { accepted: false, candidate, reason, mayMutate };
}

function accepted(reason: string): VerificationCommandClassification {
  return { accepted: true, candidate: true, reason, mayMutate: false };
}

function classifyTsc(tokens: readonly string[]): VerificationCommandClassification {
  const flags = lowerFlags(tokens);
  if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running watch/debug mode");
  if (hasFlag(flags, MUTATING_FLAGS))
    return rejected(true, "mutating or artifact-producing mode", true);
  if (hasFlag(flags, AMBIGUOUS_FLAGS) || flags.has("-v")) {
    return rejected(true, "does not prove type correctness");
  }
  if (!flags.has("--noemit"))
    // Without --noEmit tsc EMITS files, so it is both unproven and rewriting.
    return rejected(true, "tsc must explicitly use --noEmit", true);
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
  if (hasFlag(flags, MUTATING_FLAGS)) return rejected(true, "mutating test/update mode", true);
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
  const executable = executableBasename(tokens[0]);
  if (!executable) return rejected(false, "empty command");
  if (executable === "tsc") return classifyTsc(tokens);
  if ((executable === "node" || executable === "node.exe") && tokens.includes("--test")) {
    // simplification: require --test first; supporting preceding Node options
    // needs option-arity parsing so script arguments cannot masquerade as flags.
    if (tokens[1] !== "--test") return rejected(true, "--test must lead Node arguments");
    if (tokens.some((token) => ["-e", "--eval", "-p", "--print"].includes(token))) {
      return rejected(true, "inline evaluation is not verification");
    }
    return classifyTestRunner("node", tokens);
  }
  if (/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(executable) && tokens[1] === "-m") {
    if (["pytest", "unittest"].includes(tokens[2])) {
      return classifyTestRunner(tokens[2], tokens.slice(2));
    }
    // `python -m ruff check` is the same bounded check as `ruff check`.
    if (["ruff", "mypy", "pyright"].includes(tokens[2])) return classifyDirect(tokens.slice(2));
  }
  if (executable === "vitest" || executable === "jest" || executable === "pytest") {
    return classifyTestRunner(executable, tokens);
  }

  const flags = lowerFlags(tokens);
  if (["eslint", "prettier", "ruff"].includes(executable)) {
    if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running mode");
    if (hasFlag(flags, MUTATING_FLAGS))
      return rejected(true, "mutating formatter/linter mode", true);
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
      return rejected(true, "artifact-producing Cargo command", true);
    }
    if (subcommand === "fmt" && !flags.has("--check")) {
      return rejected(true, "cargo fmt must explicitly use --check", true);
    }
    return ["check", "clippy", "test", "fmt"].includes(subcommand)
      ? accepted("bounded Cargo check")
      : rejected(false, "not a recognized verification command");
  }
  if (executable === "go") {
    const subcommand = tokens[1]?.toLowerCase();
    return subcommand === "test" || subcommand === "vet"
      ? accepted("bounded Go check")
      : rejected(
          subcommand === "build" || subcommand === "clean",
          "not a bounded Go check",
          subcommand === "build", // go build writes artifacts; clean removes them
        );
  }
  return rejected(hasVerifierExecutable(tokens.join(" ")), "not a recognized verification command");
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
    const result = rejected(
      true,
      "mutating, artifact-producing, or long-running package script",
      true,
    );
    const flags = lowerFlags(tokens.slice(scriptIndex + 1));
    // Only ordinary builds qualify, and only with a host-owned before/after
    // snapshot. Never infer safety for fixers, watchers or another directory.
    if (
      script === "build" &&
      !tokens.some((token) =>
        /^(?:--dir|--prefix|--cwd|-C|-c|-w|--workspace-root)(?:=|$)/.test(token),
      ) &&
      !hasFlag(flags, LONG_RUNNING_FLAGS) &&
      !hasFlag(flags, MUTATING_FLAGS) &&
      !hasFlag(flags, AMBIGUOUS_FLAGS)
    )
      result.snapshotEligible = true;
    return result;
  }
  if (!SAFE_PACKAGE_SCRIPTS.test(script)) {
    // pnpm permits omitting exec for installed binaries, e.g. pnpm vitest run.
    if (runner === "pnpm" && action !== "run") return classifyDirect(tokens.slice(index));
    return rejected(false, "package script is not a recognized verification check");
  }

  const scriptArgs = tokens.slice(scriptIndex + 1).filter((token) => token !== "--");
  const flags = lowerFlags(scriptArgs);
  if (hasFlag(flags, LONG_RUNNING_FLAGS)) return rejected(true, "long-running package-script mode");
  if (hasFlag(flags, MUTATING_FLAGS)) return rejected(true, "mutating package-script mode", true);
  if (hasFlag(flags, AMBIGUOUS_FLAGS))
    return rejected(true, "package script does not prove correctness");
  return accepted(`bounded ${runner} verification script`);
}

/** Trailing stderr redirects that cannot change a check's exit status or write a
 * file: merging stderr into stdout, or discarding it. Anything else (`> file`,
 * `2> log`) still reaches the unsafe-syntax rejection. */
const HARMLESS_STDERR_SUFFIX = /\s+2>(?:&1|\/dev\/null)\s*$/;

function classifySegment(rawSegment: string): VerificationCommandClassification {
  const segment = rawSegment.replace(HARMLESS_STDERR_SUFFIX, "");
  const candidate =
    hasVerifierExecutable(segment) || /(?:^|\s)(?:pnpm|npm|yarn|bun)(?:\s|$)/i.test(segment);
  if (hasUnsafeShellSyntax(segment))
    return rejected(candidate, "unsafe shell syntax or redirection");
  const tokens = tokenize(segment);
  const first = tokens[0]?.toLowerCase();
  if (["pnpm", "npm", "yarn", "bun"].includes(first)) return classifyPackageRunner(tokens);
  if (["npx", "bunx"].includes(first)) return classifyDirect(tokens.slice(1));
  return classifyDirect(tokens);
}

/** tail/head with at most a line-count argument: pure output limiters. They
 * cannot rewrite, filter, or otherwise transform what the check proved — the
 * exit status (pipefail-protected) and the kept tail are the full evidence. */
const PIPE_LIMITER = /^(?:tail|head)(?:\s+(?:-[1-9]\d*|-n\s*\d+|--lines(?:=|\s+)\d+))?\s*$/;

/** Fail-closed classifier: bounded checks with narrowly allowed non-check preludes.
 *
 * `posixShell`: the command runs under bash with pipefail (GG's bash tool on
 * macOS/Linux, or Windows with Git Bash). Only then can read-only commands
 * around a check count: cmd.exe has no pipefail, and there `;` is not a
 * separator, so `cat a; npm test` would run only `cat`. Default off, so a
 * caller that does not know the shell fails closed. */
export function classifyVerificationCommand(
  command: string,
  { posixShell = false }: { posixShell?: boolean } = {},
): VerificationCommandClassification {
  const strict = classifyStrict(command);
  if (strict.accepted || !posixShell || !checkWithReadOnlyContext(command)) return strict;
  // Never certified from the transcript: the live host must also see the
  // workspace unchanged across the run (snapshotEligible), exactly as for an
  // ordinary build. Non-preserve-only, so a clean pass is fresh evidence.
  return {
    ...rejected(true, "check with read-only commands around it"),
    snapshotEligible: true,
    ambiguousFailure: true,
  };
}

type Separator = "&&" | "||" | ";" | null;

/** Stand-in for a `( … )` group already proven to contain only read-only commands. */
const READ_ONLY_GROUP = "\u0000read-only-group";

/** Index of the `)` closing the `(` at `open`, skipping quoted text. -1 when
 * unbalanced or when the inside holds anything this cannot account for. */
function closingParen(text: string, open: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(")
      return -1; // no nesting
    else if (ch === ")") return i;
  }
  return -1;
}

/** True when `inner` (a group or `$( … )` body) runs read-only commands only. */
function readOnlyInner(inner: string): boolean {
  const pipelines = parsePipelines(inner);
  return pipelines !== null && pipelines.every(({ stages }) => stages.every(isReadOnlyContext));
}

/** Quote- and operator-level parse of a command into pipelines and the
 * separator that follows each. Null for anything this cannot fully account
 * for: escapes, backticks, variable expansion (except `$?`), redirections
 * (beyond a check's stderr merge), background `&`, comments, negation, brace
 * groups. `$( … )` and `( … )` are allowed only around read-only commands. */
function parsePipelines(command: string): Array<{ stages: string[]; next: Separator }> | null {
  // A NUL could forge the vetted-group stand-in (and never reaches a shell).
  if (command.includes("\u0000")) return null;
  const text = command.replace(/\s2>(?:&1|\/dev\/null)(?=\s*(?:\||&&|;|\n|$))/g, "");
  const pipelines: Array<{ stages: string[]; next: Separator }> = [];
  let stages: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let afterGroup = false;
  const endStage = (): boolean => {
    const stage = current.trim();
    current = "";
    afterGroup = false;
    if (!stage || stage.startsWith("!")) return false;
    stages.push(stage);
    return true;
  };
  const endPipeline = (next: Separator): boolean => {
    if (!endStage()) return false;
    pipelines.push({ stages, next });
    stages = [];
    return true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const nextCh = text[i + 1] ?? "";
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (afterGroup && !/\s/.test(ch) && !"&|;\n".includes(ch)) return null;
    if (ch === "`" || ch === "\\") return null;
    if (ch === "$") {
      if (nextCh === "?") {
        // The previous exit status: a number, it cannot run anything.
        current += "0";
        i++;
        continue;
      }
      if (nextCh === "(") {
        const close = closingParen(text, i + 1);
        if (close === -1 || !readOnlyInner(text.slice(i + 2, close))) return null;
        current += "Q";
        i = close;
        continue;
      }
      // Any other expansion (`$VAR`, `${…}`, `$'\x2d'` ANSI-C quoting) can
      // produce text this cannot see. Only a bare `$` is literal.
      if (nextCh !== "" && !/\s/.test(nextCh)) return null;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" && current.trim() === "") {
      const close = closingParen(text, i);
      if (close === -1 || !readOnlyInner(text.slice(i + 1, close))) return null;
      current = READ_ONLY_GROUP;
      afterGroup = true;
      i = close;
      continue;
    }
    if ("(){}<>".includes(ch)) return null;
    if (ch === "#" && (current === "" || /\s$/.test(current))) return null;
    if (ch === "&") {
      if (nextCh !== "&" || !endPipeline("&&")) return null;
      i++;
      continue;
    }
    if (ch === "|") {
      if (nextCh === "|") {
        if (!endPipeline("||")) return null;
        i++;
        continue;
      }
      if (nextCh === "&" || !endStage()) return null;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      if (current.trim() === "" && stages.length === 0) continue; // blank line
      if (!endPipeline(";")) return null;
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  if (current.trim() === "" && stages.length === 0) {
    // Trailing separator: the last pipeline has no successor after all.
    const last = pipelines.at(-1);
    if (last) last.next = null;
  } else if (!endPipeline(null)) return null;
  return pipelines.length > 0 ? pipelines : null;
}

/** Pure stream filters allowed after a check. None exists in cmd.exe, so on a
 * shell without pipefail the pipeline cannot exit 0 through them. */
const PIPE_FILTERS = new Set(["tail", "head", "grep", "egrep", "fgrep", "rg", "wc", "cat"]);
/** Read-only git around a check: no `-c`/`-C` globals (they can run helpers). */
const CONTEXT_GIT = /^git\s+(?:status|diff|log|show)(?:\s|$)/;

/** Quoted text masked so read-only screening cannot be confused by `|`, `>`
 * or `;` inside patterns; a quoted flag (`"-o"`) stays visible to it. */
function maskQuotes(stage: string): string | null {
  let hiddenFlag = false;
  const masked = stage.replace(/'[^']*'|"[^"]*"/g, (quoted) => {
    if (/^.-/.test(quoted)) hiddenFlag = true;
    return "Q";
  });
  return hiddenFlag ? null : masked;
}

function isReadOnlyContext(stage: string): boolean {
  if (stage === READ_ONLY_GROUP) return true;
  const masked = maskQuotes(stage);
  if (masked === null || !isReadOnlyCommand(masked)) return false;
  const word = masked.split(/\s+/)[0];
  return word !== "git" || CONTEXT_GIT.test(masked);
}

function isPipeFilter(stage: string): boolean {
  const masked = maskQuotes(stage);
  if (masked === null) return false;
  const words = masked.split(/\s+/);
  if (!PIPE_FILTERS.has(words[0] ?? "")) return false;
  // A follow mode never ends; it could only time the check out.
  if (words.some((w) => /^(?:-f|-F|--follow(?:=.*)?|--retry)$/.test(w))) return false;
  return isReadOnlyCommand(masked);
}

/**
 * A real check with read-only commands around it, as models write them:
 * `cat a.js; npm test 2>&1 | grep -E "pass|fail"`, `npm test && git diff --stat`,
 * `(rg -n old || echo none) && npm test 2>&1 | tail -15`.
 *
 * Exit 0 still proves every check passed, because:
 * - every check pipeline is a recognised bounded check piped only through pure
 *   filters, and the agent shell runs with pipefail;
 * - a check is never reached through `||` (`cat a || npm test` exits 0 without
 *   testing), and from the first check on everything is joined by `&&`, so no
 *   later command's status can replace a failed check's;
 * - everything else is read-only; before the first check, `;` and `||` are
 *   fine because those statuses never become the command's;
 * - a leading `cd dir &&` may pick the directory, as for a bare check. If it
 *   fails, a later `;` runs the check in the project root, which is still the
 *   workspace the host compares.
 * The host additionally compares workspace inputs before and after the run
 * (snapshotEligible), so nothing in the chain can rewrite what was checked.
 */
function checkWithReadOnlyContext(command: string): boolean {
  const pipelines = parsePipelines(command);
  if (pipelines === null) return false;
  let seenCheck = false;
  let previous: Separator = null;
  for (const [index, { stages, next }] of pipelines.entries()) {
    const [head, ...rest] = stages as [string, ...string[]];
    const isCheck = classifySegment(head).accepted && rest.every(isPipeFilter);
    if (isCheck) {
      if (previous === "||") return false;
      seenCheck = true;
    } else if (index === 0 && rest.length === 0 && next === "&&" && /^cd\s+\S+$/.test(head)) {
      // working-directory prelude
    } else if (!stages.every(isReadOnlyContext)) return false;
    if (seenCheck && (next === ";" || next === "||")) return false;
    previous = next;
  }
  return seenCheck;
}

function classifyStrict(command: string): VerificationCommandClassification {
  const candidate =
    hasVerifierExecutable(command) || /(?:^|\s)(?:pnpm|npm|yarn|bun)(?:\s|$)/i.test(command);
  // Only && preserves fail-closed evidence across a chain. OR, semicolons, and
  // newlines can still hide a failed check behind a later zero exit status.
  if (command.includes("||") || command.includes(";") || command.includes("\n")) {
    return rejected(candidate, "shell control operator can hide a failed check");
  }
  // Pipes are evidence ONLY as `check | tail/head`: the agent shell runs with
  // pipefail, so the pipeline reports the check's own status, and a limiter
  // cannot transform results. Any other pipe stage can (grep, tee, wc…) — rejected.
  if (/(^|[^|])\|([^|]|$)/.test(command)) {
    const stages = command.split("|");
    const check = stages[0]!.replace(/\s*2>&1\s*$/, "").trim();
    const limitersOk = stages.slice(1).every((stage) => PIPE_LIMITER.test(stage.trim()));
    if (!limitersOk || !check) {
      return rejected(candidate, "pipe stage can transform check results");
    }
    const head = classifyVerificationCommand(check);
    return head.accepted
      ? accepted("piped check with output limiter (pipefail)")
      : rejected(head.candidate || candidate, head.reason, head.mayMutate);
  }
  const segments = splitShellCommandSegments(command);
  if (segments.length === 0) return rejected(false, "empty command");
  const results = segments.map((segment, index) => {
    const tokens = tokenize(segment);
    // A leading directory change is not itself evidence. && ensures it must
    // succeed, and a real bounded check must still follow it.
    if (
      index < segments.length - 1 &&
      tokens[0] === "cd" &&
      tokens.length === 2 &&
      !hasUnsafeShellSyntax(segment)
    )
      return accepted("working-directory prelude");
    // Status is not evidence itself; a real check must follow through &&.
    // simplification: only basic status flags; expand with vetted flags, not arbitrary Git commands.
    if (
      index < segments.length - 1 &&
      /^git\s+status(?:\s+(?:--short|-s|--branch|-b|--porcelain(?:=[12])?))*$/.test(segment.trim())
    )
      return accepted("git status prelude");
    return classifySegment(segment);
  });
  const firstRejected = results.find((result) => !result.accepted);
  if (firstRejected) {
    // Preludes are `accepted` only so a real check may follow them; they are
    // never checks themselves, so they must not make a chain a check candidate
    // or qualify it for snapshot comparison.
    const isPrelude = (entry: VerificationCommandClassification): boolean =>
      entry.reason === "git status prelude" || entry.reason === "working-directory prelude";
    const hasRealCheck = results.some((entry) => entry.accepted && !isPrelude(entry));
    const result = rejected(
      results.some((entry) => entry.candidate && !isPrelude(entry)),
      firstRejected.reason,
      results.some((entry) => entry.mayMutate),
    );
    if (
      results.every((entry) => entry.accepted || entry.snapshotEligible) &&
      !results.some((entry) => entry.reason === "working-directory prelude")
    ) {
      result.snapshotEligible = true;
    } else if (
      !result.mayMutate &&
      hasRealCheck &&
      !results.some((entry) => entry.reason === "working-directory prelude") &&
      segments.every((segment) => !hasUnsafeShellSyntax(segment))
    ) {
      // Mixed check/script chains remain rejected. A host-observed successful
      // exit plus unchanged inputs can only retain evidence from earlier checks.
      result.snapshotEligible = true;
      result.snapshotPreserveOnly = true;
    }
    return result;
  }
  return accepted(segments.length === 1 ? results[0].reason : "bounded verification command chain");
}

type TopLevelOperator = "&&" | "||" | "|" | ";" | "&" | "\n";

interface TopLevelSegment {
  text: string;
  /** Operator that ended the previous segment (null for the first). */
  before: TopLevelOperator | null;
  /** Operator that ends this segment (null for the last). */
  after: TopLevelOperator | null;
}

/** `name` of a heredoc introduced at `start` (just past `<<`/`<<-`), with the
 *  index after it. Quotes around the delimiter are removed. */
function readHeredocDelimiter(
  command: string,
  start: number,
): { word: string; end: number } | null {
  let i = start;
  while (command[i] === " " || command[i] === "\t") i++;
  const quote = command[i] === "'" || command[i] === '"' ? command[i] : null;
  if (quote) {
    const close = command.indexOf(quote, i + 1);
    if (close < 0) return null;
    return { word: command.slice(i + 1, close), end: close + 1 };
  }
  const match = /^[^\s;&|<>()]+/.exec(command.slice(i));
  return match ? { word: match[0].replace(/\\/g, ""), end: i + match[0].length } : null;
}

/**
 * The top-level segments of a shell command: split on `;`, `&&`, `||`, `|`,
 * `&` and newlines, but not inside quotes, `$( … )`, `( … )`, backticks or
 * heredoc bodies, and never on redirections (`2>&1`, `&>`). Comments are
 * dropped. Null when the text cannot be accounted for (an unterminated quote,
 * group or heredoc).
 *
 * Only {@link extractStandaloneCheck} uses this, and whatever it returns is
 * re-run and judged on its own exit status, so a misread here can at worst
 * re-run a real check; it can never turn into evidence by itself.
 */
function topLevelSegments(command: string): TopLevelSegment[] | null {
  const segments: TopLevelSegment[] = [];
  const heredocs: Array<{ word: string; stripTabs: boolean }> = [];
  let current = "";
  let before: TopLevelOperator | null = null;
  let depth = 0;
  const end = (op: TopLevelOperator | null): void => {
    const text = current.trim();
    if (text) segments.push({ text, before, after: op });
    current = "";
    if (text || op !== "\n") before = op;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (ch === "\\") {
      current += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === "`") {
      const close = command.indexOf(ch, i + 1);
      if (close < 0) return null;
      current += command.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') j += command[j] === "\\" ? 2 : 1;
      if (j >= command.length) return null;
      current += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "#" && (current === "" || /\s$/.test(current))) {
      const newline = command.indexOf("\n", i);
      i = newline < 0 ? command.length : newline;
      continue;
    }
    if (ch === "<" && next === "<" && command[i + 2] !== "<") {
      const stripTabs = command[i + 2] === "-";
      const delimiter = readHeredocDelimiter(command, i + (stripTabs ? 3 : 2));
      if (!delimiter) return null;
      heredocs.push({ word: delimiter.word, stripTabs });
      current += command.slice(i, delimiter.end);
      i = delimiter.end;
      continue;
    }
    if (ch === "\n" && heredocs.length > 0) {
      // Heredoc bodies start on the next line; skip each up to its delimiter.
      let lineStart = i + 1;
      for (const { word, stripTabs } of heredocs.splice(0)) {
        for (;;) {
          if (lineStart > command.length) return null;
          const lineEnd = command.indexOf("\n", lineStart);
          const line = command.slice(lineStart, lineEnd < 0 ? command.length : lineEnd);
          lineStart = lineEnd < 0 ? command.length + 1 : lineEnd + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === word) break;
        }
      }
      if (depth === 0) end("\n");
      i = lineStart - 1;
      continue;
    }
    if (ch === "(" || (ch === "$" && next === "(")) {
      depth++;
      current += ch === "$" ? "$(" : "(";
      i += ch === "$" ? 2 : 1;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) return null;
      depth--;
      current += ch;
      i++;
      continue;
    }
    if (depth === 0) {
      const pair = command.slice(i, i + 2);
      if (pair === "&&" || pair === "||") {
        end(pair);
        i += 2;
        continue;
      }
      if (ch === "|") {
        end("|");
        i += next === "&" ? 2 : 1;
        continue;
      }
      if (ch === ";" || ch === "\n") {
        end(ch);
        i++;
        continue;
      }
      // A lone & backgrounds; `>&`, `<&` and `&>` are redirections.
      if (ch === "&" && next !== ">" && !/[<>]$/.test(current)) {
        end("&");
        i++;
        continue;
      }
    }
    current += ch;
    i++;
  }
  if (depth !== 0 || heredocs.length > 0) return null;
  end(null);
  return segments;
}

/**
 * The bounded check a refused command ran, as a command that counts on its
 * own: `cd app && npm test` from `cd app && rg -n old . ; npm test 2>&1 |
 * tail -15; node -e '…'`. Null when the command already counts, holds no
 * check, or its working directory is ambiguous (a `cd` after the first
 * segment). With several checks, the last one wins.
 *
 * The host re-runs the result when a turn ends unverified (see
 * VerificationTracker.takeRefusedCheck), so the evidence is the re-run's own
 * exit status, never the original command's.
 */
export function extractStandaloneCheck(command: string): string | null {
  if (classifyStrict(command).accepted) return null;
  const segments = topLevelSegments(command);
  if (!segments) return null;
  let checkIndex = -1;
  let check = "";
  for (const [index, segment] of segments.entries()) {
    // A pipeline's later stages are filters, never the check itself.
    if (segment.before === "|") continue;
    const text = segment.text.replace(/\s+2>&1$/, "");
    const verdict = classifyStrict(text);
    if (verdict.accepted && !verdict.mayMutate) {
      checkIndex = index;
      check = text;
    }
  }
  if (checkIndex < 0) return null;
  const first = segments[0]!;
  const leadingCd =
    checkIndex > 0 && first.after === "&&" && /^cd\s+[^\s;&|<>()$`'"]+$/.test(first.text)
      ? first.text
      : null;
  const moves = segments
    .slice(leadingCd ? 1 : 0, checkIndex)
    .some((segment) => /^(?:cd|pushd|popd)(?:\s|$)/.test(segment.text));
  if (moves) return null;
  const standalone = leadingCd ? `${leadingCd} && ${check}` : check;
  const verdict = classifyStrict(standalone);
  return verdict.accepted && !verdict.mayMutate ? standalone : null;
}

function resultText(result: ToolResult): string {
  if (typeof result.content === "string") return result.content;
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
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
  return (
    SENSITIVE_COMMAND_NAME.test(name) || /(?:Auth|Token|Password|Secret|Credential|Key)$/.test(name)
  );
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
/** Extract harness-owned evidence from completed bash calls in a transcript. */
export function collectVerificationEvidence(
  messages: readonly Message[],
  includeMissingResults = false,
): VerificationEvidence[] {
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
      calls.delete(result.toolCallId);
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
      const exit = /^Exit code:\s*(-?\d+)(?:\s|$)/i.exec(resultText(result).trim());
      const passed = !result.isError && exit?.[1] === "0";
      evidence.push({
        command: call.command,
        status: passed ? "passed" : exit ? "failed" : "unavailable",
        reason: passed
          ? call.classification.reason
          : exit
            ? "bounded check did not exit successfully"
            : "execution outcome unavailable from retained transcript",
      });
    }
  }
  if (includeMissingResults) {
    for (const call of calls.values()) {
      if (!call.classification.candidate) continue;
      evidence.push({
        command: call.command,
        status: "unavailable",
        reason: "execution outcome unavailable from retained transcript",
      });
    }
  }
  return evidence;
}

export type RoadmapShellEvidence = Omit<VerificationEvidence, "status"> & {
  status: VerificationEvidence["status"] | "unclassified";
  executionId?: string;
  observedAt?: string;
  cwd?: string;
  safeToolEnvironmentDigest?: string;
  workspace?: NotesWorkspaceSnapshotV1;
  classifierVersion?: string;
  terminalReason?: string;
  exitCode?: number | null;
  signal?: string | null;
  elapsedMs?: number;
  timeoutMs?: number;
  logPath?: string;
};

export function safeToolEnvironmentDigest(
  environment: Readonly<Record<string, string>> = getSafeToolEnv(),
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    )
    .digest("hex");
}

const READ_ONLY_OR_METADATA_TOOLS = new Set([
  "code_nav",
  "code_search",
  "find",
  "grep",
  "ls",
  "read",
  "roadmap_bind",
  "roadmap_checkpoint",
  "roadmap_inspect",
  "roadmap_phase_draft",
  "roadmap_phase_edit",
  "roadmap_phase_move",
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

// Upstream 0.86.0 wording, so autopilot hand-backs read the same in both apps.
export const VERIFICATION_PROBLEM_FAILED =
  "Unverified: a check failed or did not confirm success. Rerun that check successfully before approval.";
export const VERIFICATION_PROBLEM_MISSING =
  "Unverified: no successful check covers the current changes. Run the project's verification before approval.";
export const VERIFICATION_PROBLEM_BACKGROUND =
  "Unverified: a background check is still running or its result has not been confirmed.";

/** Edits to code or check-owning files, or a shell command that may rewrite files. */
function isCodeMutation(call: { name: string; args: Record<string, unknown> }): boolean {
  if (call.name === "edit" || call.name === "write") {
    return editTargetPaths(call.args).some(
      (filePath) => isCodeFilePath(filePath) || isCheckOwnFile(filePath),
    );
  }
  if (call.name === "bash") {
    const command = typeof call.args.command === "string" ? call.args.command.trim() : "";
    return classifyVerificationCommand(command).mayMutate;
  }
  return false;
}

/** A check the model ran inside a command whose exit status could not count. */
export interface RefusedCheck {
  /** The check alone, in a form that counts on its own (`cd app && npm test`). */
  command: string;
  /** Ledger generation when the model's command finished. */
  generation: number;
  /** Ledger run that observed it. */
  run: number;
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
  cwd?: unknown;
  startedAt?: unknown;
  signal?: unknown;
  elapsedMs?: unknown;
  timeoutMs?: unknown;
  logPath?: unknown;
  backgroundTaskId?: unknown;
  sourceUnchanged?: unknown;
}

interface BackgroundTaskOutputDetails {
  id?: unknown;
  isRunning?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  completedAt?: unknown;
  stopReason?: unknown;
}

/** Map a finished background task onto the same outcome vocabulary as foreground bash. */
function backgroundTerminalOutcome(task: BackgroundTaskOutputDetails): {
  status: RoadmapShellEvidence["status"];
  reason: string;
  terminalReason?: string;
} {
  if (task.stopReason === "inactive") {
    return { status: "failed", reason: "stopped after no output", terminalReason: "inactive" };
  }
  if (task.stopReason === "timedOut") {
    return { status: "failed", reason: "timed out", terminalReason: "timedOut" };
  }
  if (task.stopReason === null && task.exitCode === 0) {
    return {
      status: "passed",
      reason: "command exited successfully; requirement coverage is not certified",
      terminalReason: "completed",
    };
  }
  if (typeof task.exitCode === "number" && Number.isInteger(task.exitCode) && task.exitCode !== 0) {
    return {
      status: "failed",
      reason: `failed (exit ${task.exitCode})`,
      terminalReason: "nonZeroExit",
    };
  }
  return { status: "unavailable", reason: "background task ended without an exit code" };
}

// simplification: Retain 100 executions; persist per-phase evidence if deeper history is required.
const SESSION_VERIFICATION_LEDGER_MAX_ENTRIES = 100;
const SESSION_VERIFICATION_EXECUTION_ID_MAX_LENGTH = 128;

/** Session-owned harness evidence; transcript compaction cannot rewrite this ledger. */
export class SessionVerificationEvidenceLedger {
  private generation = 0;
  private run = 0;
  private runChanged = false;
  private runChecked = false;
  /** Generation of the last code/check-file change; null = nothing owed. */
  private codeChangeGeneration: number | null = null;
  private readonly entries = new Map<
    string,
    { generation: number; run: number; evidence: RoadmapShellEvidence }
  >();
  /** Background task ID → the check handed off by the soft yield. */
  private readonly pendingBackground = new Map<
    string,
    { executionId: string; command: string; generation: number }
  >();
  /** Latest outcome of each check since the last code change. Kept apart from
   *  `entries`, so ordinary commands evicting old executions cannot drop the
   *  check that covers the current changes. */
  private readonly coverage = new Map<string, "passed" | "failed">();
  /** bash runs with pipefail (not the cmd.exe fallback): see classifyVerificationCommand. */
  private readonly posixShell: boolean;
  /** See {@link takeRefusedCheck}. */
  private refusedCheck: RefusedCheck | null = null;

  constructor({ posixShell = !resolveShell("").isCmdFallback }: { posixShell?: boolean } = {}) {
    this.posixShell = posixShell;
  }

  /** Classification as the live shell runs the command. */
  classify(command: string): VerificationCommandClassification {
    return classifyVerificationCommand(command, { posixShell: this.posixShell });
  }

  private covers(generation: number): boolean {
    return this.codeChangeGeneration === null || generation >= this.codeChangeGeneration;
  }

  private setCoverage(command: string, status: string): void {
    if (status !== "passed" && status !== "failed") return;
    this.coverage.delete(command);
    this.coverage.set(command, status);
    while (this.coverage.size > SESSION_VERIFICATION_LEDGER_MAX_ENTRIES) {
      // Drop the oldest pass first: dropping a failure would hide it.
      const oldest =
        [...this.coverage].find(([, outcome]) => outcome === "passed")?.[0] ??
        this.coverage.keys().next().value;
      if (oldest === undefined) break;
      this.coverage.delete(oldest);
    }
  }

  get runId(): number {
    return this.run;
  }

  beginRun(): void {
    this.run += 1;
    this.runChanged = false;
    this.runChecked = false;
    this.refusedCheck = null;
  }

  /**
   * Upstream 0.94's refused-check recovery, on this ledger: the last check the
   * model ran this run inside a command that could not count (`npm test 2>&1 |
   * tail; node -e '…'`), provided nothing was mutated since, no background
   * check is pending and the run is otherwise unverified. It recovers a check
   * the model already ran; it never adds one the model skipped. Returned once.
   */
  takeRefusedCheck(): RefusedCheck | null {
    const pending = this.refusedCheck;
    this.refusedCheck = null;
    if (!pending || pending.run !== this.run || pending.generation !== this.generation) {
      return null;
    }
    if (this.pendingBackground.size > 0) return null;
    return this.verificationProblem() !== null ? pending : null;
  }

  runActivity(): { changed: boolean; checked: boolean; evidence: VerificationEvidence[] } {
    return {
      changed: this.runChanged,
      checked: this.runChecked,
      evidence: this.activityEvidence(this.run),
    };
  }

  workspaceEvidence(): VerificationEvidence[] {
    return this.activityEvidence();
  }

  /**
   * Upstream 0.86.0's verification rule, computed from this ledger: code was
   * changed and no passing check covers it, or a covering check failed and the
   * same check has not passed since. Docs and plan files never count.
   */
  verificationProblem(): string | null {
    if (this.codeChangeGeneration !== null) {
      const statuses = [...this.coverage.values()];
      if (statuses.includes("failed")) return VERIFICATION_PROBLEM_FAILED;
      if (!statuses.includes("passed")) return VERIFICATION_PROBLEM_MISSING;
    }
    return this.pendingBackground.size > 0 ? VERIFICATION_PROBLEM_BACKGROUND : null;
  }

  private activityEvidence(run?: number): VerificationEvidence[] {
    const evidence = new Map<string, VerificationEvidence>();
    for (const entry of this.entries.values()) {
      if (run !== undefined && entry.run !== run) continue;
      const classification = classifyVerificationCommand(entry.evidence.command);
      if (!classification.candidate) continue;
      const current = entry.generation === this.generation;
      evidence.set(entry.evidence.command, {
        command: entry.evidence.command,
        status:
          entry.evidence.status === "failed" && classification.accepted
            ? "failed"
            : !current || !classification.accepted
              ? "rejected"
              : entry.evidence.status === "unclassified"
                ? "unavailable"
                : entry.evidence.status,
        reason: !current
          ? "Superseded by a later workspace mutation"
          : !classification.accepted
            ? classification.reason
            : entry.evidence.reason,
      });
    }
    return [...evidence.values()];
  }

  get revision(): number {
    return this.generation;
  }

  recordToolResult(input: {
    /** Captured by the host at tool start, never from model arguments. */
    evidenceRevision?: number;
    /** Host-owned run identity, captured alongside the source revision. */
    evidenceRun?: number;
    name: string;
    args: Record<string, unknown>;
    isError: boolean;
    details?: unknown;
    workspace?: NotesWorkspaceSnapshotV1;
    /** Plan mode refuses code edits with text, not an error (upstream 0.86.0). */
    planMode?: boolean;
  }): void {
    const run = input.evidenceRun ?? this.run;
    const diagnostics =
      input.name === "bash"
        ? (input.details as { bashDiagnostics?: BashExecutionDiagnostics } | undefined)
            ?.bashDiagnostics
        : undefined;
    const gateClassification =
      input.name === "bash" ? this.classify(String(input.args.command ?? "").trim()) : undefined;
    // The bash tool compares workspace inputs around builds and checks wrapped
    // in read-only commands (upstream's snapshot rule); absent = not compared.
    const inputsCompared =
      gateClassification?.snapshotEligible === true &&
      typeof diagnostics?.sourceUnchanged === "boolean";
    const inputsUnchanged = inputsCompared && diagnostics?.sourceUnchanged === true;
    if (isWorkspaceMutation(input)) {
      this.generation += 1;
      if (run === this.run) this.runChanged = true;
      const refusedPlanEdit = input.planMode === true && input.name !== "bash";
      const codeChanged = inputsCompared
        ? !inputsUnchanged
        : !input.isError && isCodeMutation(input);
      if (!refusedPlanEdit && codeChanged) {
        this.codeChangeGeneration = this.generation;
        this.coverage.clear();
      }
    }
    if (input.name === "task_output") {
      this.recordBackgroundCompletion(input.details);
      return;
    }
    if (input.name !== "bash") return;

    // Upstream 0.94 rerun rule: remember the last check the model ran inside a
    // command whose exit status could not count, so the session can re-run it
    // standalone if the turn would otherwise end unverified.
    if (gateClassification?.accepted) {
      this.refusedCheck = null;
    } else if (
      !input.isError &&
      input.args.persist !== true &&
      input.args.run_in_background !== true &&
      diagnostics?.reason !== "backgrounded"
    ) {
      const check = extractStandaloneCheck(String(input.args.command ?? "").trim());
      if (check) this.refusedCheck = { command: check, generation: this.generation, run };
    }

    // A handed-off check counts as run only once its terminal result is recorded.
    if (
      run === this.run &&
      diagnostics?.reason !== "backgrounded" &&
      classifyVerificationCommand(String(input.args.command ?? "")).candidate
    ) {
      this.runChecked = true;
    }
    const executionId =
      typeof diagnostics?.executionId === "string" ? diagnostics.executionId.trim() : "";
    const command = typeof diagnostics?.command === "string" ? diagnostics.command.trim() : "";
    const requestedCommand =
      typeof input.args.command === "string" ? input.args.command.trim() : "";
    const cwd = typeof diagnostics?.cwd === "string" ? diagnostics.cwd.trim() : "";
    const startedAt = typeof diagnostics?.startedAt === "number" ? diagnostics.startedAt : NaN;
    if (
      !executionId ||
      executionId.length > SESSION_VERIFICATION_EXECUTION_ID_MAX_LENGTH ||
      !command ||
      command.length > NOTES_ROADMAP_EVIDENCE_ITEM_MAX_LENGTH ||
      command !== requestedCommand ||
      !cwd ||
      !Number.isFinite(startedAt)
    ) {
      return;
    }

    const background = input.args.run_in_background === true || input.args.persist === true;
    let evidence: RoadmapShellEvidence;
    if (diagnostics?.reason === "backgrounded") {
      // Still running when the soft limit handed it to a background task: the
      // result in this response is not the command's outcome.
      evidence = {
        command,
        status: "unavailable",
        reason: "handed off to background; final outcome not in this response",
      };
    } else if (background) {
      evidence = {
        command,
        status: "unavailable",
        reason: "final outcome unavailable from this background or persistent command response",
      };
    } else {
      const passed =
        !input.isError && diagnostics?.reason === "completed" && diagnostics.exitCode === 0;
      evidence = {
        command,
        status: passed
          ? "passed"
          : TERMINAL_SHELL_REASONS.includes(String(diagnostics?.reason))
            ? "failed"
            : "unavailable",
        reason: passed
          ? "command exited successfully; requirement coverage is not certified"
          : diagnostics?.reason === "spawnError"
            ? "launch failed"
            : diagnostics?.reason === "timedOut"
              ? "timed out"
              : diagnostics?.reason === "inactive"
                ? "stopped after no output"
                : diagnostics?.reason === "aborted"
                  ? "cancelled"
                  : typeof diagnostics?.exitCode === "number" &&
                      Number.isInteger(diagnostics.exitCode) &&
                      diagnostics.exitCode !== 0
                    ? `failed (exit ${diagnostics.exitCode})`
                    : diagnostics?.reason === "nonZeroExit"
                      ? "failed (no numeric exit code)"
                      : diagnostics?.reason === "completed"
                        ? "inconsistent completion metadata"
                        : "execution outcome unavailable",
      };
    }
    Object.assign(evidence, {
      executionId,
      observedAt: new Date(startedAt).toISOString(),
      cwd,
      safeToolEnvironmentDigest: safeToolEnvironmentDigest(),
    });
    if (TERMINAL_SHELL_REASONS.includes(String(diagnostics?.reason))) {
      evidence.terminalReason = String(diagnostics?.reason);
    }
    if (
      diagnostics?.exitCode === null ||
      (typeof diagnostics?.exitCode === "number" && Number.isSafeInteger(diagnostics.exitCode))
    ) {
      evidence.exitCode = diagnostics.exitCode;
    }
    if (
      diagnostics?.signal === null ||
      (typeof diagnostics?.signal === "string" && /^SIG[A-Z0-9]{1,20}$/.test(diagnostics.signal))
    ) {
      evidence.signal = diagnostics.signal;
    }
    for (const key of ["elapsedMs", "timeoutMs"] as const) {
      const value = diagnostics?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) evidence[key] = value;
    }
    if (
      typeof diagnostics?.logPath === "string" &&
      diagnostics.logPath.length <= 2048 &&
      !Array.from(diagnostics.logPath).some((character) => character.charCodeAt(0) < 32)
    ) {
      evidence.logPath = diagnostics.logPath;
    }
    if (input.workspace) {
      evidence.workspace = structuredClone(input.workspace);
      evidence.classifierVersion = ROADMAP_VERIFICATION_CLASSIFIER_VERSION;
    }
    const existing = this.entries.get(executionId);
    if (existing) return;
    const generation = input.evidenceRevision ?? this.generation;
    this.entries.set(executionId, { generation, run, evidence });
    if (gateClassification && this.covers(generation)) {
      if (gateClassification.accepted) {
        this.setCoverage(command, evidence.status);
      } else if (
        inputsUnchanged &&
        !gateClassification.snapshotPreserveOnly &&
        // A read-only command around the check may own the non-zero exit.
        !(evidence.status === "failed" && gateClassification.ambiguousFailure)
      ) {
        this.setCoverage(command, evidence.status);
      }
    }
    const backgroundTaskId =
      typeof diagnostics?.backgroundTaskId === "string" ? diagnostics.backgroundTaskId : "";
    if (diagnostics?.reason === "backgrounded" && backgroundTaskId) {
      this.pendingBackground.set(backgroundTaskId, { executionId, command, generation });
    }
    while (this.entries.size > SESSION_VERIFICATION_LEDGER_MAX_ENTRIES) {
      const oldestExecutionId = this.entries.keys().next().value;
      if (oldestExecutionId === undefined) break;
      this.entries.delete(oldestExecutionId);
    }
    while (this.pendingBackground.size > SESSION_VERIFICATION_LEDGER_MAX_ENTRIES) {
      const oldestTaskId = this.pendingBackground.keys().next().value;
      if (oldestTaskId === undefined) break;
      this.pendingBackground.delete(oldestTaskId);
    }
  }

  /** Upgrade a handed-off check once task_output reports its terminal state. */
  private recordBackgroundCompletion(details: unknown): void {
    const task = (details as { taskOutput?: BackgroundTaskOutputDetails } | undefined)?.taskOutput;
    if (!task || typeof task.id !== "string" || task.isRunning !== false) return;
    const pending = this.pendingBackground.get(task.id);
    if (pending === undefined) return;
    this.pendingBackground.delete(task.id);
    const outcome = backgroundTerminalOutcome(task);
    // The gate needs only that no code changed since the check started; the
    // ordinary commands that stale Roadmap evidence below do not stale it.
    if (this.classify(pending.command).accepted && this.covers(pending.generation)) {
      this.setCoverage(pending.command, outcome.status);
    }
    const entry = this.entries.get(pending.executionId);
    // Evicted, or the workspace changed after the command started: leave it stale.
    if (!entry || entry.generation !== this.generation) return;

    const evidence: RoadmapShellEvidence = {
      ...entry.evidence,
      status: outcome.status,
      reason: outcome.reason,
    };
    if (outcome.terminalReason) evidence.terminalReason = outcome.terminalReason;
    if (
      task.exitCode === null ||
      (typeof task.exitCode === "number" && Number.isSafeInteger(task.exitCode))
    ) {
      evidence.exitCode = task.exitCode;
    }
    if (
      task.signal === null ||
      (typeof task.signal === "string" && /^SIG[A-Z0-9]{1,20}$/.test(task.signal))
    ) {
      evidence.signal = task.signal;
    }
    const startedAt = evidence.observedAt ? Date.parse(evidence.observedAt) : NaN;
    if (
      typeof task.completedAt === "number" &&
      Number.isFinite(startedAt) &&
      task.completedAt >= startedAt
    ) {
      evidence.elapsedMs = task.completedAt - startedAt;
    }
    entry.evidence = evidence;
    if (entry.run === this.run && classifyVerificationCommand(entry.evidence.command).candidate) {
      this.runChecked = true;
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
    this.codeChangeGeneration = null;
    this.beginRun();
    this.entries.clear();
    this.pendingBackground.clear();
    this.coverage.clear();
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
