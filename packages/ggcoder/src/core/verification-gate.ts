/**
 * Verification gate — the turn cannot claim "done" while a promised check is
 * still owed.
 *
 * When a run mutated code files and no test / typecheck / lint / build command
 * completed after the last mutation, the pre-stop hook injects a follow-up
 * demanding the project's verification be run. Exactly one such follow-up per
 * run: a gate that keeps prompting after the model has decided it is done buys
 * nothing but extra full-length final answers, so the demand carries its own
 * fallback ("say which changes went unverified") and the gate then goes silent.
 * Prompt-only "verify before finishing" instructions can be ignored; this gate
 * is harness-owned bookkeeping on what actually executed.
 *
 * Simplification: verification is recognised by a conservative runner-shape
 * classifier (package-manager/runner + test/lint/check keyword) applied to each
 * segment of a compound command. Both error directions are safe — a missed
 * recognition leaves the gate silent (today's behavior), a false positive merely
 * skips one continuation.
 */
import type { Message } from "@kenkaiiii/gg-ai";

/** Follow-ups per run. After this the gate is silent for the rest of the run. */
export const MAX_VERIFICATION_INJECTIONS = 1;

/** Words that may precede the real command without changing its shape. */
const SHELL_WRAPPERS = new Set([
  "env",
  "nohup",
  "nice",
  "time",
  "sudo",
  "stdbuf",
  "command",
  "exec",
]);

/** Leading words that mark a command as a build/test-tool invocation. Anything
 *  else (git, grep, ./script.sh, bash …) is conservatively not verification. */
const RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "nr",
  "deno",
  "python",
  "python3",
  "py",
  "uv",
  "go",
  "cargo",
  "rustc",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "dotnet",
  "sbt",
  "swift",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "unittest",
  "eslint",
  "biome",
  "ruff",
  "mypy",
  "pylint",
]);

/** Shells whose `-c <script>` operand is itself a command to classify. */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Nested `sh -c` unwraps allowed before the classifier gives up. */
const MAX_SHELL_DEPTH = 3;

/** A non-flag word after the runner that makes the command a verification. */
const VERIFY_KEYWORDS = [
  "test",
  "tests",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "unittest",
  "tsc",
  "typecheck",
  "type-check",
  "eslint",
  "biome",
  "ruff",
  "mypy",
  "pylint",
  "lint",
  "clippy",
  "vet",
  "check",
  "build",
  "compile",
  "verify",
];

function isVerifyWord(word: string): boolean {
  // Exact keyword, or a script name built on one (npm run test:unit).
  return VERIFY_KEYWORDS.some((keyword) => word === keyword || word.startsWith(`${keyword}:`));
}

/**
 * Split a command on shell control operators (`&&`, `||`, `;`, `|`, newline),
 * ignoring operators inside quotes, and strip subshell/group punctuation from
 * each piece. `cd pkg && npm test` must classify on its `npm test` half — the
 * whole-string read saw `cd` as the runner and left the gate owed forever.
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') current += command[++i] ?? "";
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (command[++i] ?? "");
      continue;
    }
    // Bare `&` is deliberately not an operator: it would split `2>&1`.
    const operator = ["&&", "||", ";", "|", "\n"].find((op) => command.startsWith(op, i));
    if (operator) {
      segments.push(current);
      current = "";
      i += operator.length - 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments
    .map((segment) =>
      segment
        .trim()
        .replace(/^[({!\s]+/, "")
        .replace(/[)}\s]+$/, ""),
    )
    .filter((segment) => segment.length > 0);
}

/** Split a segment into words, honouring quotes and dropping the quote marks. */
function tokenize(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (quote) {
      if (char === "\\" && quote === '"') current += segment[++i] ?? "";
      else if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) words.push(current);
      current = "";
      started = false;
      continue;
    }
    if (char === "\\") {
      current += segment[++i] ?? "";
      continue;
    }
    current += char;
  }
  if (started || current.length > 0) words.push(current);
  return words;
}

/**
 * True when the command looks like a test/typecheck/lint/build invocation:
 * compound segments considered independently, wrappers stripped, a known runner
 * leading, and a verification keyword among its operands. Deliberately strict —
 * `grep test x`, `git commit -m test` and `./run_tests.sh` all read as NOT
 * verification.
 */
export function isVerificationCommand(command: string): boolean {
  return splitCommandSegments(command).some((segment) => isVerificationSegment(segment, 0));
}

/** Classify one operator-free segment. `depth` bounds `sh -c` unwrapping. */
function isVerificationSegment(segment: string, depth: number): boolean {
  const words = tokenize(segment);
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (SHELL_WRAPPERS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i += 1;
      continue;
    }
    // `timeout <duration> runner …` — skip the duration argument too.
    if (word === "timeout") {
      i += 2;
      continue;
    }
    break;
  }
  const runner = words[i] ?? "";
  // `sh -c "cd pkg && npm test"` — classify the script the shell will run.
  if (SHELL_INTERPRETERS.has(runner)) {
    if (depth >= MAX_SHELL_DEPTH) return false;
    const flagIndex = words.indexOf("-c", i + 1);
    const script = flagIndex === -1 ? undefined : words[flagIndex + 1];
    if (!script) return false;
    return splitCommandSegments(script).some((inner) => isVerificationSegment(inner, depth + 1));
  }
  if (!RUNNERS.has(runner)) return false;
  if (isVerifyWord(runner)) return true; // bare vitest / jest / tsc / eslint …
  return words
    .slice(i + 1)
    .filter((word) => !word.startsWith("-"))
    .some(isVerifyWord);
}

/** Source-file extensions whose edits count as code mutations. */
const CODE_EXT_RE =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|h|cpp|cc|hpp|cs|php|vue|svelte|scala|sh|sql|m|mm|zig|ex|exs|erl|dart|lua|pl|r|jl|hs|clj)$/;

/** True for paths that look like source code (not docs, config or assets). */
export function isCodeFilePath(filePath: string): boolean {
  return CODE_EXT_RE.test(filePath);
}

export function buildVerificationFollowUpMessage(files: readonly string[]): Message {
  return {
    role: "user",
    provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
    content:
      "Verification gate: you changed code in this run, but no test, typecheck, lint or build " +
      "command has completed since the last edit:\n" +
      files.map((filePath) => `- ${filePath}`).join("\n") +
      "\nRun the project's verification now (its test command, or the closest equivalent) and " +
      "address any failures. Do not describe the change as tested or working without having run it. " +
      "This is the only time you will be asked: if you cannot run it, say plainly in your final " +
      "response which of these changes went unverified and why, so the user can check them.",
  };
}

/**
 * Bookkeeping for "code was edited, nothing proved it since". Callers record
 * successful edit/write mutations on code files and completed foreground
 * verification commands, in occurrence order; the gate is owed whenever the
 * newest recorded event is a mutation.
 */
export class VerificationGate {
  private seq = 0;
  private lastMutationSeq = 0;
  private lastVerificationSeq = 0;
  private injections = 0;
  /** Code files mutated since the last verification — the gate's file list. */
  private mutatedFiles = new Set<string>();

  recordMutation(filePath: string): void {
    this.lastMutationSeq = ++this.seq;
    this.mutatedFiles.add(filePath);
  }

  recordVerification(): void {
    this.lastVerificationSeq = ++this.seq;
    this.mutatedFiles.clear();
  }

  isOwed(): boolean {
    return this.lastMutationSeq > this.lastVerificationSeq;
  }

  /**
   * Would a stop right now inject? Lets the session arm clients BEFORE the
   * candidate final answer streams, so the draft the injection replaces is held
   * rather than painted and then superseded.
   */
  willInject(): boolean {
    return this.isOwed() && this.injections < MAX_VERIFICATION_INJECTIONS;
  }

  /**
   * The blocking message for the pre-stop hook, or null when nothing is owed
   * or the single injection is spent. Still-owed on a later stop is deliberately
   * silent: the demand already told the model to disclose what went unverified,
   * and one more injection only costs the user another restated final answer.
   */
  followUp(): Message[] | null {
    if (!this.willInject()) return null;
    this.injections += 1;
    return [buildVerificationFollowUpMessage([...this.mutatedFiles].sort())];
  }

  reset(): void {
    this.seq = 0;
    this.lastMutationSeq = 0;
    this.lastVerificationSeq = 0;
    this.injections = 0;
    this.mutatedFiles.clear();
  }
}
