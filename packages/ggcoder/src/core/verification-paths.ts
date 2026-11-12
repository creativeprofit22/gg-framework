// Ported from upstream 0.86.0 (core/verification-gate.ts), which the Local Fork
// does not ship: the fork tracks evidence in SessionVerificationEvidenceLedger.

/** Source-file extensions whose edits count as code mutations. */
const CODE_EXT_RE =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|h|cpp|cc|hpp|cs|php|vue|svelte|scala|sh|sql|m|mm|zig|ex|exs|erl|dart|lua|pl|r|jl|hs|clj)$/;

/** True for paths that look like source code (not docs, config or assets). */
export function isCodeFilePath(filePath: string): boolean {
  return CODE_EXT_RE.test(filePath);
}

/**
 * Files that define what a check ASSERTS rather than what it tests: test files
 * and test directories, test-runner configs, and the type/lint configs whose
 * strictness the checks inherit. Editing one of these can turn a failing check
 * green without touching the behaviour under test. Matched on path shape only.
 */
export function isCheckOwnFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  // A test/spec file, by suffix (foo.test.ts, foo_test.go, test_foo.py).
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/_test\.(?:go|py|rb|rs)$/.test(base) || /^test_.+\.py$/.test(base)) return true;
  if (/(?:^|\.)spec\.[cm]?[jt]sx?$/.test(base)) return true;
  // Anything under a tests directory.
  if (/(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|testdata|fixtures)\//.test(normalized)) {
    return true;
  }
  // Test-runner and check configuration.
  if (
    /^(?:vitest|jest|playwright|cypress|karma|mocha|ava|nightwatch|wdio)\.config\.[cm]?[jt]s$/.test(
      base,
    )
  ) {
    return true;
  }
  if (/^(?:jest|vitest|mocha|ava|nyc|c8)\.(?:config|setup)\./.test(base)) return true;
  // Type / lint configuration whose strictness the checks inherit.
  if (/^tsconfig(?:\.[\w-]+)?\.json$/.test(base)) return true;
  if (/^(?:\.eslintrc(?:\.[\w-]+)?|eslint\.config\.[cm]?[jt]s)$/.test(base)) return true;
  if (/^(?:biome|\.golangci|\.rubocop|phpstan|psalm)\.(?:jsonc?|ya?ml|neon|xml|toml)$/.test(base)) {
    return true;
  }
  if (/^(?:pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|mypy\.ini|\.flake8)$/.test(base)) {
    return true;
  }
  if (/^conftest\.py$/.test(base)) return true;
  return false;
}
