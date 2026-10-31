import {
  classifyVerificationCommand,
  extractStandaloneCheck,
} from "../core/verification-evidence.js";

/** Literal (no quoting or expansion) stdout redirect targets, in order. */
const LITERAL_REDIRECT_TARGET = /(?:^|[^0-9&<>])>>?\s*([^\s;&|<>()$`'"]+)/g;

function redirectTargets(command: string): string[] {
  return [...command.matchAll(LITERAL_REDIRECT_TARGET)].map((match) => match[1]!);
}

/** Any stdout redirect, literal or not; `2>&1` and `2>/dev/null` are not output files. */
function redirectsStdout(command: string): boolean {
  return /(?:^|[^0-9&<>])>>?\s*[^&\s]/.test(command);
}

/** A check that was refused only because its output went to a file. */
export function redirectHint(command: string, logPath: string, posixShell: boolean): string {
  if (!redirectsStdout(command)) return "";
  const verdict = classifyVerificationCommand(command, { posixShell });
  // Counted directly, or by the host's unchanged-inputs snapshot.
  if (verdict.accepted || verdict.snapshotEligible) return "";
  const standalone = extractStandaloneCheck(command);
  if (!standalone) return "";
  return (
    `[Not counted as a check: output went to a file. Run \`${standalone}\` on its own; ` +
    `this run's full output is kept at ${logPath}.]\n`
  );
}

/** A check writing to a fixed log path another run may already have filled. */
export function sharedLogWarning(command: string, logPath: string, posixShell: boolean): string {
  const target = redirectTargets(command).find(
    (path) => path !== "/dev/null" && (path.startsWith("/tmp/") || path.endsWith(".log")),
  );
  if (!target) return "";
  const verdict = classifyVerificationCommand(command, { posixShell });
  if (!verdict.candidate && extractStandaloneCheck(command) === null) return "";
  return (
    `[Warning: ${target} is reused across runs and may hold an older run's output; ` +
    `read this run's log at ${logPath} instead.]\n`
  );
}

const TIMEOUT_FAILURE_LINES: readonly RegExp[] = [
  /Test timed out in \d+\s*ms/, // vitest
  /Exceeded timeout of \d+\s*ms/, // jest
  /test timed out after \d+\s*ms|'testTimeoutFailure'/, // node:test
  /Failed: Timeout >\s*[\d.]+s/, // pytest-timeout
];

/** Failure markers that are not timeouts; any of these means real failures too. */
const OTHER_FAILURE_LINE =
  /AssertionError|\bassert(?:ion)? failed\b|\bexpected\b.*\b(?:to|but)\b|panicked at|\bE\s+assert\b/i;

const FAILED_SUMMARY = [/\b(\d+) failed\b/g, /^\s*(?:#|ℹ)\s*fail (\d+)\s*$/gm];

const MIN_TIMEOUT_FAILURES = 3;

function countTimeoutFailures(lines: readonly string[], output: string): number {
  let count = lines.filter((line) => TIMEOUT_FAILURE_LINES.some((re) => re.test(line))).length;
  // cargo only warns about slow tests; count the ones that then failed.
  for (const match of output.matchAll(/^test (\S+) has been running for over \d+ seconds$/gm)) {
    const name = match[1]!;
    if (lines.some((line) => line.startsWith(`test ${name} ... FAILED`))) count += 1;
  }
  return count;
}

/** Advice when every failure is a timeout: the machine was likely overloaded. */
export function overloadHint(output: string): string {
  const lines = output.split(/\r?\n/);
  const timeouts = countTimeoutFailures(lines, output);
  if (timeouts < MIN_TIMEOUT_FAILURES) return "";
  if (lines.some((line) => OTHER_FAILURE_LINE.test(line))) return "";
  const failed = FAILED_SUMMARY.flatMap((re) =>
    [...output.matchAll(re)].map((match) => Number(match[1])),
  );
  if (failed.length > 0 && Math.max(...failed) > timeouts) return "";
  return (
    "[Many tests failed only by timing out; the machine may have been overloaded. " +
    "Run fewer checks at once or see the machine-profile defaults in docs/harness-checks.md " +
    "before raising timeouts.]\n"
  );
}
