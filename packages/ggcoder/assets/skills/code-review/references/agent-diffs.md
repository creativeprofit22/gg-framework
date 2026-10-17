# Agent-Generated Diffs: Failure Modes and Checks

Run on any diff an agent wrote (including your own). Each row: what to look for → how to check → default severity.

| Failure mode                           | Check                                                                                                                                                                                                                                                      | Severity                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Hallucinated package**               | Every new dependency in a manifest: confirm it exists in the registry (`npm view <pkg>`, `pip index versions <pkg>`), is the intended project (not a look-alike name), and is actually imported. Install scripts → defer to bulletproof.                   | blocking                                          |
| **Hallucinated API / symbol**          | Every newly called function, method, option, or flag: `code_nav definition`, or read the installed source in `node_modules`/site-packages for the pinned version. Typecheck passing is evidence only for typed code.                                       | blocking                                          |
| **Weakened or deleted tests**          | `git diff --stat -- '*test*' '*spec*'`. For each test hunk: removed assertions, loosened matchers (`toEqual`→`toBeDefined`, exact→`toContain`), widened tolerances, added `.skip`/`.only`/`xit`/`@pytest.mark.skip`, snapshots re-recorded without reason. | blocking unless justified in the PR               |
| **Mocked-away assertions**             | Test mocks the very unit under test, or asserts only that a mock was called with whatever it was given.                                                                                                                                                    | blocking on critical paths                        |
| **Swallowed errors**                   | New `try/catch` / `except Exception` that returns a default, logs and continues, or wraps a whole function. Compare with the code's previous error contract.                                                                                               | blocking                                          |
| **Dead code / duplicate helpers**      | New function that duplicates an existing helper (`grep` the name's verbs, `code_search` the behaviour); unused exports, params, or branches left behind.                                                                                                   | non-blocking                                      |
| **Scope creep / unrequested refactor** | Map every changed file to a requirement. Files with no requirement → list them. Renames/reformatting mixed with behaviour change → ask for a split.                                                                                                        | non-blocking; blocking if it changes behaviour    |
| **Fake "done"**                        | Claims ledger (SKILL.md step 2): "tests pass" with no run; "handles X" with no hunk; TODO/placeholder/`throw new Error("not implemented")` left in.                                                                                                        | blocking                                          |
| **Config / lockfile drift**            | Lockfile changes without a manifest change (or vice versa); tsconfig/eslint/biome rules relaxed; CI steps removed or `continue-on-error` added; version bumps nobody asked for.                                                                            | blocking for relaxed checks; question otherwise   |
| **Suppressions**                       | New `any`, `!`, `@ts-ignore`, `eslint-disable`, `# type: ignore`, `noqa`. Each needs a reason at the line.                                                                                                                                                 | non-blocking (blocking if hiding a failing check) |
| **Generated / vendored edits**         | Hand edits in `dist/`, generated, or vendored files.                                                                                                                                                                                                       | blocking                                          |

## Quick commands

```bash
git diff --stat <base>...<head>                         # scope
git diff <base>...<head> -- '*.lock' '*lock.json' '*.toml' 'package.json'   # dependency drift
git diff <base>...<head> | grep -nE '^\+.*(\.skip|\.only|xit\(|@ts-ignore|eslint-disable|as any|catch *\()'
```

Grep hits are leads, not findings — open each at file:line before reporting.
