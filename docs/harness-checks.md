# Harness checks

How the harness learns which checks a project wants, which files each check covers, and what counts as a pass. The harness owns the contract and the evidence; each project owns its own rules and gate scripts. The harness never imports project code and never depends on one particular project.

## Module map

One owner per concern. "Later" means a following Roadmap phase adds it; nothing here changes behaviour yet.

| Concern         | Owner                                                                                             | Interface                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract        | `packages/gg-core/src/verify-plan.ts`, subpath `@kenkaiiii/gg-core/verify-plan`                   | Types `VerifyPlan`, `VerifyGate`, `VerifyPlanAdvice`, `VerifyPlanDescriptor`; pure `parseVerifyPlan`, `parseVerifyPlanJson`, `adaptSupaPlanV1`, `parseVerifyPlanDescriptor`, `decideVerifyPlanSource`, `interpretVerifyPlanOutput`; limits.        |
| Plan loader     | `ggcoder/src/core/verify-plan-loader.ts`, created per session by `core/agent-session.ts`          | Reads `.gg/verify-plan.json`, checks the per-descriptor approval, runs the descriptor command through the existing sandboxed launch with `VERIFY_PLAN_COMMAND_LIMITS`, and passes stdout to `interpretVerifyPlanOutput`. Falls back to heuristics. |
| Check coverage  | `ggcoder/src/core/check-coverage.ts`, used by `core/verification-evidence.ts` and `tools/bash.ts` | Fingerprints a check's inputs, matches changed files against each gate's `covers` (`scopeAffectedBy`) and remembers the harness's own observed passes (`CheckCoverageMemory`). Project advice is never evidence. See Reusing passes.               |
| Machine profile | ggcoder (later)                                                                                   | Per-machine concurrency defaults (`CARGO_BUILD_JOBS`, `RUST_TEST_THREADS`, pnpm workspace concurrency, test-runner workers), applied only when unset, plus a per-daemon limit on heavy background checks. Settings can override.                   |
| Command limits  | `ggcoder/src/tools/foreground-limits.ts`, `tools/quiet-budget.ts`, `core/command-watchdog.ts`     | Quiet and hard limits. A gate's `quietBudgetSeconds` overrides the default quiet budget for that command. After a move to the background, silence notifies instead of killing (settled decision 1); only the hard limit kills.                     |
| Changed files   | ggcoder: git via `utils/git.ts` plus `core/verification-snapshot.ts`                              | Repo-relative changed paths, in the same `/`-separated form the contract uses.                                                                                                                                                                     |
| CI state        | ggcoder: `utils/github-ci.ts`                                                                     | `getGitHubCI` / `startGitHubCIPoll`; reports remote CI separately from local evidence.                                                                                                                                                             |

Later ggcoder and gg-app code imports plan types only from `@kenkaiiii/gg-core/verify-plan`. Don't add parallel types.

## Contract (version 1)

A plan is `{ version: 1, mode: "changed" | "full", gates, advice? }`. Each gate is `{ id, argv, cwd?, covers?, fingerprint?, quietBudgetSeconds?, protectedPaths? }`; missing optional fields become `"."`, `[]` or `null`.

- Unknown keys are rejected. Any version other than `1` (including a missing one) is rejected with `unsupported verify-plan version <v>; expected 1`.
- `id`: `^[a-z0-9][a-z0-9._-]{0,63}$`, unique, at most 64 gates.
- `argv`: an array of 1-2048 strings, each 1-1024 chars with no NUL or newline, and at most 32,000 bytes in total when joined with spaces (under Windows' 32,767-char command line). File-expanded argv (one entry per changed file) fits. A plain string is rejected (no shell strings). A shell as the program (`sh`, `bash`, `zsh`, `dash`, `ksh`, `cmd`, `powershell`, `pwsh`, with or without a path or `.exe`) is rejected.
- Paths (`cwd`, `covers`, `protectedPaths`): repo-relative, `/` separators, at most 512 chars, no leading `/`, drive letter, `\`, `..` or empty segment, no control characters. `covers` and `protectedPaths` allow only `**`, `*`, `?` and `{a,b}`; `cwd` allows no globs. At most 2000 covers and 200 protected paths per gate.
- `fingerprint`: 64 lowercase hex chars or `null`. `quietBudgetSeconds`: integer 1-3600 or `null`.
- Plan text over 256 KiB (`VERIFY_PLAN_MAX_BYTES`) is rejected before `JSON.parse`.

A glob subset that turns out too narrow is handled by a version bump, not by loosening version 1.

### supa plan v1 adapter

`adaptSupaPlanV1` accepts supa's `verify --json` plan (`version: 1`): each `run[]` entry becomes a gate (`gate` → `id`, `files` → `covers`, plus `argv`, `cwd`, `fingerprint`). A `skip[]` entry with `lastRun` becomes `reused-pass` advice; other skips are dropped. The result goes through `parseVerifyPlan`, so supa plans get the same rules.

## Plan source

A project opts in with `.gg/verify-plan.json` (at most 8 KiB):

```json
{
  "version": 1,
  "command": { "argv": ["node", "scripts/verify-plan.mjs"], "cwd": "." },
  "format": "gg-verify-plan-v1"
}
```

`format` is `gg-verify-plan-v1` or `supa-plan-v1`. The command uses the same argv and cwd rules as gates.

- `decideVerifyPlanSource` runs nothing. It returns `run` only for a valid descriptor the user approved; `needs-approval` for a valid but unapproved one; otherwise heuristics, with a fixed reason (no descriptor, bad descriptor).
- **Approval** (`core/verify-plan-approval.ts`, `SettingsManager.isVerifyPlanApproved` / `approveVerifyPlan`). Consent is per descriptor: `verifyPlanApprovals` in settings holds `{ project, descriptorSha256 }` pairs (resolved session cwd, sha256 of the exact descriptor text). A changed descriptor, including one that arrives through `git pull`, needs approval again. It is **not** project MCP trust: `trustProjectMcpServers` and `trustedProjects` never approve a plan command. Saving re-reads settings under the file lock and replaces the file atomically; an unparseable settings file is left alone and the approval fails.
- **Desktop app.** `GET /verify-plan` returns the session's `VerifyPlanStatus` (`plan`, `heuristics` with its reason, or `needs-approval` with the exact argv, absolute cwd and descriptor hash). `POST /verify-plan/approve { descriptorSha256 }` re-reads the descriptor and approves it only if it still has that hash; otherwise it returns `ok: false` (`changed` or `missing`) and nothing runs. Rust proxies both (`agent_verify_plan_status`, `agent_approve_verify_plan`); the pane shows an Approve notice and, when a present plan was not used, the fallback reason. The terminal TUI has no approval prompt: it runs only descriptors already approved in its settings file.
- The loader runs the command with a 30 s timeout and a 256 KiB output cap (`VERIFY_PLAN_COMMAND_LIMITS`).
- **Loader** (`core/verify-plan-loader.ts`). Both the desktop agent session and the terminal TUI (`runInkTUI`) create one; the TUI uses no sandbox policy (mode off, like its bash). Reads the descriptor from the session cwd's git root (the cwd outside git), reading at most 8 KiB. An unapproved descriptor is read and validated (so its argv can be shown) but never run. The argv runs without a shell, through `prepareSandboxLaunch` with the session's sandbox policy and the safe tool env; a sandbox that can't start, a program that can't start, a timeout, oversize output or a bad plan all give heuristics with a fixed reason, and nothing throws.
- **Windows programs.** Node can't start npm-style shims (`pnpm`, `npx`, `supa`) by name, so the loader resolves `argv[0]` itself (`resolveWindowsProgram`): a bare name walks `PATH` × `PATHEXT`, a path resolves against the descriptor cwd, and only `.com`/`.exe`/`.bat`/`.cmd` count. `.exe`/`.com` run directly. `.cmd`/`.bat` programs run through `cmd.exe /d /s /c` only when every argument is shell-inert (`[A-Za-z0-9_@+=:,./\-]`); otherwise the fallback reason says they only take plain arguments, and nothing runs. An unresolved program gives `program "<name>" not found`. For anything else, use `node <script>`.
- **Caching.** One loader per session; the bash tool and the evidence ledger read the same getter. Each agent run waits at most 2 s for a refresh before its first turn (the command reruns only when the descriptor text or its approval changed); a slower command keeps running and its plan applies once it lands, with heuristics until then. Between runs, an edit/write to the descriptor, a changed descriptor stamp (size, mtime) or an approval change drops the plan to heuristics until a background reload finishes. A failed load is cached too, so a slow command costs at most 30 s per descriptor change.
- `interpretVerifyPlanOutput` turns the result into a plan, or into heuristics with a reason: timed out, non-zero exit, oversize output, or a bad plan. Output is always untrusted data.

## What stays in each project

- The rules for which checks matter and which files they cover.
- The gate scripts themselves and the plan command.
- Logs, caches and fingerprints. The harness only stores a fingerprint as reported.

## Settled decisions (2026-10-30)

1. When a foreground command moves to the background and its quiet budget runs out, the harness **notifies** the agent and keeps the command running. Only the hard limit kills it.
2. Plan shape: a **harness-owned** shape plus a **supa plan v1 adapter**.
3. A project-reported reused pass (supa `skip` with `lastRun`) is **advice only**, never evidence. The harness still needs its own observed pass.
4. CI-state fix: **fork first**, written in the upstream shape, with an upstream PR offered afterwards.

## Baseline (fork `24e62ce2`, upstream/main `e6076b8c`)

Recorded before any behaviour change. Later phases recheck upstream before touching these files.

| File                                        | Owner today                                                                                | vs upstream/main                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `ggcoder/src/tools/bash.ts`                 | `executeForegroundCommand`, `createBashTool`                                               | fork-heavy                                                             |
| `ggcoder/src/tools/foreground-limits.ts`    | defaults (yield 120 s, quiet 600 s, hard 60 min), `resolveForegroundLimits`                | fork-only                                                              |
| `ggcoder/src/core/command-watchdog.ts`      | `createCommandWatchdog` (yield, inactive, hard timeout)                                    | fork-only                                                              |
| `ggcoder/src/core/process-manager.ts`       | `ProcessManager`, `WakeRules`, stop reasons                                                | fork-heavy                                                             |
| `ggcoder/src/core/verification-evidence.ts` | `SAFE_PACKAGE_SCRIPTS`, `classifyVerificationCommand`, `SessionVerificationEvidenceLedger` | fork-heavy                                                             |
| `ggcoder/src/core/verification-snapshot.ts` | `captureVerificationSnapshot`                                                              | identical                                                              |
| `ggcoder/src/utils/github-ci.ts`            | `getGitHubCI`, `startGitHubCIPoll`                                                         | differs only by the fork's `withoutQwenRuntimeSecret` env              |
| `ggcoder/src/core/verification-gate.ts`     | removed in the fork at `5160dbb1`                                                          | upstream has `VerificationGate` with `mutatedFiles` and pass/fail maps |

`8f95137c` update: `tools/quiet-budget.ts` is new and fork-only (quiet budget choice, gate lookup, result hints). `command-watchdog.ts` is unchanged; after a move to the background `process-manager.ts` `adopt()` arms it with the hard limit only.

## Quiet commands after a move

Compared before editing (fork `8f95137c`, upstream/main `e6076b8c`).

- **Upstream.** `moveToBackground()` in `tools/bash.ts` calls a synchronous `processManager.adopt(child, command, startedAt, priorOutput)`, which goes through `track()`. There is no watchdog, no silence kill and no hard limit after the move; `armWakeWatcher(proc)` gets no rules. Quiet notices come only from the model-declared `wake.silence_seconds` (`WakeRules.silenceMs`).
- **Fork before this change.** `adopt()` re-armed `createCommandWatchdog` with the inactivity limit plus the remaining hard limit, so a quiet command was killed at about 120 s yield + 600 s silence (about 12 min).
- **Shape chosen (smallest future merge).**
  1. The fork-only silence kill after a move is gone. No new notify mechanism was added: moved commands reuse upstream's own `WakeRules.silenceMs` path, so moved and started commands share one quiet notice (one-shot; it names the task, total run time, log path and any hard limit).
  2. The only fork-only guard left after a move is the hard limit (`adopt()` runs the watchdog with `inactivityMs: null`). It stops the command with `stopReason: "timedOut"`.
  3. Policy (quiet budget choice, gate lookup by exact `argv.join(" ")` match, result hints) lives in `ggcoder/src/tools/quiet-budget.ts`. `bash.ts` and `process-manager.ts` only gained call-site hooks.
- **Started commands** (`run_in_background`) still get no default quiet notice and no hard limit, as upstream. A matching gate's `quietBudgetSeconds` becomes `wake.silence_seconds` when the model gave none.
- **Commands that never move.** An explicit `timeout` is now the hard limit and replaces the silence kill. `bashInactivitySeconds` still stops foreground commands that have not moved and have no explicit timeout (persist mode, and the time before the yield). The INACTIVE result names `run_in_background` with a wake, or an explicit timeout.
- **Plan source.** `createBashTool`'s `getVerifyPlan` comes from the session's plan loader (see Plan source; the desktop session and the terminal TUI both create one), so a gate's `quietBudgetSeconds` applies whenever an approved plan loaded; otherwise the default quiet budget applies.

## What counts as a check

Compared before editing (fork `8f95137c`, upstream/main `e6076b8c`).

- **Upstream.** `verification-evidence.ts` has the same classifier shape (`SAFE_PACKAGE_SCRIPTS`, harmless stderr suffixes, strict plus read-only context) and no ledger. Upstream `verification-gate.ts` moves its revision only on `recordMutation(filePath)` for code files or `requireFreshVerification(true)`; bash commands never move it.
- **Fork before this change.** The ledger treated every bash command the classifier did not accept as a workspace change, so `git status --short` after a passing `cargo test` made the pass stale (probe 2026-10-30).
- **Shape chosen.** Edits stay inside `isWorkspaceMutation`, `classifyPackageRunner` and `classifySegment`, plus a `verifyPlan` option on `classifyVerificationCommand`. There is still one classifier. Reusing passes across edits: see Reusing passes. Classifier version: `roadmap-verification-v3`.

Rules (all fail-closed: anything the classifier can't prove is not a check):

- **Read-only commands don't stale passes.** Commands accepted by `isReadOnlyCommand` (the plan-mode safety gate: `git status/diff/log/show`, `ls`, `cat`, `rg`, …) no longer advance the workspace version. Any other unclassified command (`rm x`, `node script.mjs`) still makes earlier passes stale.
- **Verify-plan gates.** A command counts when it is exactly a gate's `argv.join(" ")` (gate cwd `.`) or `cd <cwd> && <argv joined>`, and every argv token is shell-inert (`[A-Za-z0-9_@%+=:,./-]`). Watch, mutating and ambiguous flags still reject. Without a loaded plan (unapproved descriptor, no descriptor, or a fallback) only the name rule below applies.
- **Package-script name rule.** `npm|pnpm|yarn|bun [run] <script>` counts when the script is `test`, `verify`, `check`, `typecheck`, `type-check` or `lint`, with up to two `:segment` suffixes (`verify:full`, `test:native`), or `format:check`/`format-check`/`prettier:check`. A segment of `watch`, `dev`, `serve`, `start`, `ui` or `debug` rejects; `fix`, `write`, `update`, `snapshot` or `coverage` rejects as possibly mutating. `--dir <x>`, `--dir=<x>` and `-C <x>` before the script are skipped. Trust model: the same as the existing `pnpm test` rule; a project script with a check-like name that writes files would be wrongly counted.
- **Redirected output.** A check followed by exactly one `> T` / `>> T` (optionally `2>&1`), where `T` is `/dev/null` or a literal `/tmp/…` path without `..`, is counted only under a POSIX shell and only when the workspace snapshot shows the sources unchanged; such a pass satisfies the gate and is listed as current Roadmap evidence, while a failed redirected run is not recorded as the check's failure. Any other redirect is refused, and the result names the standalone command to run plus this run's own log path. A literal `/tmp/…` or `*.log` target also gets a warning that it may hold an older run's output.

## Reusing passes

Compared before editing (fork `8f95137c`). Before this change any code edit cleared all coverage, and coverage was keyed only by the command string.

- **Fingerprint** (`captureCheckInputs` in `core/check-coverage.ts`): sha256 over the gate argv (or the shell plus the command), the cwd relative to the git root, a digest of the tool env, git `HEAD` (`unborn` without a commit), the scope and a content hash of the covered files. Hashing reuses the `verification-snapshot.ts` helpers and their caps (10k files, 128 MiB, 5 s). Any error, cap or file list changing during the capture gives no fingerprint, so the check just runs and nothing is reused.
- **Scope.** A command that matches a verify-plan gate with non-empty `covers` is plan-scoped: only files matching `covers` are hashed, and an edit clears its coverage only when a changed path matches (case-insensitive). Otherwise the scope is the whole tracked and untracked tree, today's snapshot behaviour. Unknown changes (a mutating bash command) and paths outside the root clear every entry (fail-closed).
- **Stored results.** The fingerprint is taken before and after the run; a result is remembered only when it is a conclusive pass or failure and both fingerprints match. A handed-off check is settled when `task_output` reports it finished, by recomputing the inputs. Memory holds at most 100 fingerprints and 100 pending hand-offs, oldest first out, per session.
- **Failure rules kept.** A failed check stays failed across unrelated edits until it passes again. A retained plan-scoped pass stays current Roadmap evidence, but it never satisfies the check requirement for a newer edit: a new edit still needs a new pass.
- **Notice.** When an identical earlier pass exists, the bash result (and the hand-off result) adds one line with the run, time and execution id, saying whether that pass is still current evidence. The run is never blocked.
- **Evidence rule** (settled decision 3). A pass the harness observed itself counts only while the ledger keeps it current; a fingerprint match never turns stale evidence back into current evidence. Project-reported reuse (`reused-pass` advice, supa `skip` with `lastRun`) is shown in one line labelled `reported by the project, not harness evidence` and is never stored as coverage or Roadmap evidence.
- **Plan source.** Gate scopes come from the session's plan loader; without a loaded plan every check uses the whole-tree scope. Edits are placed against the canonical (realpath) git root; a path through a symlink, junction or Windows 8.3 alias is resolved via its nearest existing ancestor first, so new files resolve too. `agent-session-check-reuse.test.ts` covers a real `.gg/verify-plan.json`.

## Overload advice

When a failed run's output shows three or more test timeouts (vitest, jest, node:test, pytest-timeout, cargo) and no other failure kind, the bash result and the finished `task_output` add one line saying the machine may have been overloaded. It points to the machine-profile defaults below. Advice only: exit code and pass/fail are unchanged.

### Machine-profile defaults

Not built yet (Module map: "later"). Until then: run fewer heavy checks at once, and lower `CARGO_BUILD_JOBS`, `RUST_TEST_THREADS`, pnpm `--workspace-concurrency` or test-runner workers before raising test timeouts.
