# Harness checks

How the harness learns which checks a project wants, which files each check covers, and what counts as a pass. The harness owns the contract and the evidence; each project owns its own rules and gate scripts. The harness never imports project code and never depends on one particular project.

## Module map

One owner per concern. "Later" means a following Roadmap phase adds it.

| Concern         | Owner                                                                                                                   | Interface                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract        | `packages/gg-core/src/verify-plan.ts`, subpath `@kenkaiiii/gg-core/verify-plan`                                         | Types `VerifyPlan`, `VerifyGate`, `VerifyPlanAdvice`, `VerifyPlanDescriptor`; pure `parseVerifyPlan`, `parseVerifyPlanJson`, `adaptSupaPlanV1`, `parseVerifyPlanDescriptor`, `decideVerifyPlanSource`, `interpretVerifyPlanOutput`; limits.        |
| Plan loader     | `ggcoder/src/core/verify-plan-loader.ts`, created per session by `core/agent-session.ts`                                | Reads `.gg/verify-plan.json`, checks the per-descriptor approval, runs the descriptor command through the existing sandboxed launch with `VERIFY_PLAN_COMMAND_LIMITS`, and passes stdout to `interpretVerifyPlanOutput`. Falls back to heuristics. |
| Check coverage  | `ggcoder/src/core/check-coverage.ts`, used by `core/verification-evidence.ts` and `tools/bash.ts`                       | Fingerprints a check's inputs, matches changed files against each gate's `covers` (`scopeAffectedBy`) and remembers the harness's own observed passes (`CheckCoverageMemory`). Project advice is never evidence. See Reusing passes.               |
| Machine profile | `ggcoder/src/core/machine-profile.ts`; hooks in `tools/bash.ts` (spawn env) and `core/process-manager.ts` (heavy slots) | Per-machine concurrency defaults (`CARGO_BUILD_JOBS`, `RUST_TEST_THREADS`, pnpm workspace concurrency), applied only when no one else set them, plus one per-daemon limit on whole-workspace tests and builds. See Machine-profile defaults.       |
| Command limits  | `ggcoder/src/tools/foreground-limits.ts`, `tools/quiet-budget.ts`, `core/command-watchdog.ts`                           | Quiet and hard limits. A gate's `quietBudgetSeconds` overrides the default quiet budget for that command. After a move to the background, silence notifies instead of killing (settled decision 1); only the hard limit kills.                     |
| Changed files   | `ggcoder/src/core/changed-files.ts`, used by `tools/bash.ts` and `core/verification-evidence.ts`                        | Per-command list of repo-relative paths a bash command created, modified, deleted or renamed outside edit/write; one note in the result and narrower staleness in the ledger. See Changed files after a command.                                   |
| CI state        | ggcoder: `utils/github-ci.ts`; notice wired in `app-sidecar.ts`                                                         | `getGitHubCI` / `startGitHubCIPoll` / `getGitHubCIHistory`; `createCINotStartedNotify` sends one not-started notice per session. Reports remote CI separately from local evidence. See CI that never starts.                                       |

Later ggcoder and gg-app code imports plan types only from `@kenkaiiii/gg-core/verify-plan`. Don't add parallel types.

The `dev_app` agent tool, which drives the running desktop dev app for UI checks, and the Lightpanda ideas it borrows are described in [dev-app-tool.md](dev-app-tool.md).

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

**Refresh 2026-11-01 (upstream/main `7b6e2885`).** Upstream has not changed anything under `packages/ggcoder/src` since `e6076b8c`, and none of the files above since merge base `988f920e`. Fork side since this baseline: `verification-snapshot.ts` is no longer identical (shared hashing helpers for check coverage and changed files), `github-ci.ts` is now fork-heavy (not-started detection), and `core/check-coverage.ts`, `core/changed-files.ts`, `core/machine-profile.ts`, `core/verify-plan-loader.ts` and `core/verify-plan-approval.ts` are fork-only. Trial merge: see Upstream trial merge.

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
- **Scope.** A command that matches a verify-plan gate with non-empty `covers` is plan-scoped: only files matching `covers` are hashed, and an edit clears its coverage only when a changed path matches (case-insensitive). Otherwise the scope is the whole tracked and untracked tree, today's snapshot behaviour. Unknown changes (a mutating bash command without a complete changed-files list, see below) and paths outside the root clear every entry (fail-closed).
- **Stored results.** The fingerprint is taken before and after the run; a result is remembered only when it is a conclusive pass or failure and both fingerprints match. A handed-off check is settled when `task_output` reports it finished, by recomputing the inputs. Memory holds at most 100 fingerprints and 100 pending hand-offs, oldest first out, per session.
- **Failure rules kept.** A failed check stays failed across unrelated edits until it passes again. A retained plan-scoped pass stays current Roadmap evidence, but it never satisfies the check requirement for a newer edit: a new edit still needs a new pass.
- **Notice.** When an identical earlier pass exists, the bash result (and the hand-off result) adds one line with the run, time and execution id, saying whether that pass is still current evidence. The run is never blocked.
- **Evidence rule** (settled decision 3). A pass the harness observed itself counts only while the ledger keeps it current; a fingerprint match never turns stale evidence back into current evidence. Project-reported reuse (`reused-pass` advice, supa `skip` with `lastRun`) is shown in one line labelled `reported by the project, not harness evidence` and is never stored as coverage or Roadmap evidence.
- **Plan source.** Gate scopes come from the session's plan loader; without a loaded plan every check uses the whole-tree scope. Edits are placed against the canonical (realpath) git root; a path through a symlink, junction or Windows 8.3 alias is resolved via its nearest existing ancestor first, so new files resolve too. `agent-session-check-reuse.test.ts` covers a real `.gg/verify-plan.json`.

## Changed files after a command

Problem: a screenshot run overwrote committed evidence files of other phases and nothing noticed. Each local foreground bash command (spawn and `persist`) now compares the repository before and after the run.

- **Capture** (`captureChangedFilesState`): `git status --porcelain=v1 -z --untracked-files=all --ignore-submodules=dirty` plus `HEAD`, through the hardened `runBackgroundGit` (optional locks off, so nothing is written to the index). Records are split on NUL and never trimmed: columns 0-1 are `XY` (a leading space is the index column), the path starts at column 3, and a rename or copy carries the original path as the next field. Every dirty path is hashed with the shared `hashWorkspaceFile` from `verification-snapshot.ts`; a stat-keyed cache per bash tool skips re-reading unchanged dirty files. Symlinks and submodule directories are compared by lstat identity, not followed.
- **Diff** (`diffChangedFiles`): a path counts only when its existence or content differs, so `git add`, `git commit` and `git rm --cached` alone report nothing, and `git checkout -- f` on a dirty file reports `f`. When `HEAD` moved, `git diff --name-status -z --no-renames <old> <new>` adds files a checkout or reset changed on disk. A status rename whose original is gone is shown once as `old → new`. Paths written by edit/write since the before-capture (`ToolWriteLog`, fed by `onFileMutated` in `tools/index.ts`) are left out.
- **Caps.** 1.5 s per capture, 5,000 status entries, 64 MiB hashed, 4 MiB of status output. Over a cap the result is `skipped` with a fixed reason (`more than 5000 changed paths`, `timed out after 1500 ms`, `dirty files over 64 MiB`, `git status output over 4 MiB`) and the bash result says so in one line. Non-git folders (`not a git repository`), read-only commands found by `isReadOnlyCommand` (`read-only`), remote workspaces and hand-offs (`handed off before it finished`) skip silently; the reason is in `details.bashDiagnostics.changedFiles`. Background starts (`run_in_background`) are not compared and return no `details`, so no reason is recorded. Any capture error fails open: the command result is unchanged.
- **Note.** One line, at most 8 paths plus `+N more`, e.g. `[This command changed 3 files (not via edit/write): docs/evidence/a.png (modified, protected), src/x.ts (created), old.ts → new.ts (renamed). Check these changes were intended.]`. Paths matching any gate's `protectedPaths` in the verify plan are listed first and marked `protected`. Control characters are removed and each path is capped at 160 characters.
- **Ledger.** For a mutating bash command with a complete compared list, `changedPathsOf` returns those paths (both sides of a rename), so a plan-scoped pass goes stale only when a listed path matches its `covers`, the same rule edits use. A skipped, incomplete or malformed list, or a package install (`mayInstall`, which writes ignored `node_modules`), keeps today's fail-closed whole-tree behaviour. Whole-tree passes still go stale on any mutating command, and a mutating command still owes a fresh check.
- **Residual risks.** Writes only to gitignored files are not listed, and for plan-scoped passes the ledger cannot see them (installs excluded). Writes by other processes during the command (background tasks, subagent workers) are attributed to the command. A command that `cd`s into another repository is only observed for the tool cwd's repository. The stat cache misses a same-size rewrite with an identical mtime, ino and mode.

**Cost on Windows (2026-10-31/11-01, i7-8700, git 2.51.0.windows.2).** `.gg/verification/changed-files-cost-2026-10-31/bench.ts`: 3 warm-ups, then 40 iterations of before-capture, no-op, after-capture and diff, with the same per-tool caches bash keeps. Budget p95 ≤ 300 ms added per command.

| Repo              | Dirty paths | First version (median / p95) | Root cached, run 1 | Root cached, run 2 |
| ----------------- | ----------- | ---------------------------- | ------------------ | ------------------ |
| gg-framework-fork | 27          | 291 / 398.6 ms               | 261 / 296.9 ms     | 256.2 / 279.8 ms   |
| supa              | 1           | 249.6 / 450.8 ms             | 212.3 / 254 ms     | 216.6 / 256.8 ms   |

- The cost is git process spawns, not hashing (`breakdown.txt`): about 40 ms per spawn here, and hardened `status` takes about 100-130 ms because it first probes repo config for filter drivers.
- The first version missed the budget. The fix caches the workspace root per bash tool (`ChangedFilesRootCache`), saving one spawn per command. The cache is dropped when `.git` appears in or vanishes from the cwd, appears in any folder between the cwd and the cached root (`git init`, `git clone` or `git worktree add` there), or the cached root loses its `.git`. These checks are lstat calls only, no git spawn. Results: `results.json` (run 1), `results-run2.json`, `results-before-root-cache.json`.
- **Not applied: reusing the filter-driver probe across a command's two captures.** A sandboxed command can write `.git/config`, and GG's own git runs outside the sandbox, so a stale probe would let the command plant a filter that GG then runs. Every status keeps its own probe.
- **Headroom is small** in this repo (p95 280-297 ms), so a slower machine or a busier repo may go over. For checks, the before-capture overlaps `captureCheckInputs` and the after-capture overlaps the after fingerprint, so checks pay less than the bench shows. `core.untrackedCache` would not help: with optional locks off, git never writes the cache to the index.

## Overload advice

When a failed run's output shows three or more test timeouts (vitest, jest, node:test, pytest-timeout, cargo) and no other failure kind, the bash result and the finished `task_output` add one line saying the machine may have been overloaded. It points to the machine-profile defaults below. Advice only: exit code and pass/fail are unchanged.

### Machine-profile defaults

Before a local bash command starts, the harness gives build and test tools a per-machine concurrency budget. It only fills gaps: a value set by you, the command or the project always wins. Remote (non-local) tool operations get nothing.

**Budget.** Machine facts come from injected probes (`availableParallelism`, `cpus`, `totalmem`, `freemem`, `platform`, `arch`, and `/proc/cpuinfo` on Linux).

- Physical cores: on Linux, unique `(physical id, core id)` pairs ("reported"). Elsewhere it is an estimate: x64/ia32 with an even count of 4 or more threads is halved (assumes hyper-threading); anything else counts each thread as a core. The estimate is wrong on non-SMT x64 and hybrid P/E-core parts, so it is labelled "est.".
- `cpuBudget = max(1, physical cores)`. This is LibreChat's "half the cores" on SMT machines, without halving machines that have no SMT.
- `memBudget = max(1, floor(total memory / 2 GiB))`. This is LibreChat's per-worker memory cap. Total memory is used because free memory swings from run to run.
- **budget = min(cpuBudget, memBudget)**, or the `concurrencyBudget` setting when it is above 0.
- pnpm workspace concurrency = `clamp(floor(budget / 2), 1, 4)`. Tianshu's `min(4, cores)` is already pnpm's own default, and it still overloaded a 12-thread machine because every package's vitest adds its own `threads - 1` workers. The outer cap therefore assumes at least two busy workers per package.
- On the i7-8700 (12 threads, ~6 cores est., 24 GiB): budget 6, workspace concurrency 3, `CARGO_BUILD_JOBS=6` (cargo's default is 12), `RUST_TEST_THREADS=6`.

**Variables.** `CARGO_BUILD_JOBS` and `RUST_TEST_THREADS` get the budget. Workspace concurrency is set as both `npm_config_workspace_concurrency` (pnpm 10) and `pnpm_config_workspace_concurrency` (pnpm 11), treated as one setting. Checked in installed source:

- pnpm 10.17.1 and 10.34.5 default to `min(4, availableParallelism)` and read `npm_config_*` from the environment. pnpm 11.22.0 reads `pnpm_config_*`. The environment beats a project `.npmrc`, so the default is skipped when the project sets it.
- vitest 4.1.4, 4.1.7 and 5.0.5 read `VITEST_MAX_WORKERS`, but apply it after config resolution, so it would override `maxWorkers`, `--maxWorkers` and `fileParallelism: false` (supa's serial wall-clock tests rely on those). The harness **never sets** `VITEST_MAX_WORKERS`; a value you export is passed through.
- jest is not installed here or in supa and has no worker variable, so nothing is set.
- `CARGO_BUILD_JOBS` beats `[build] jobs` in `.cargo/config.toml` and also sizes cargo's jobserver (shared with nested `cc-rs` builds, the cc-rs jobserver idea). A project `[env]` entry does not beat the inherited environment, so the default is skipped when project config names it.

**Precedence.** Command flag > inline env in the command > your environment > project config > harness default.

- Your environment: kept and passed through (it was previously stripped from the spawn env). On Windows the lookup ignores case and keeps your spelling, so no duplicate keys appear.
- Project config: a text scan of `.cargo/config.toml` / `.cargo/config` in the cwd and its ancestors plus `$CARGO_HOME/config.toml` (`jobs =`, `RUST_TEST_THREADS`), `.npmrc` in the ancestors and home (`workspace-concurrency`) and `pnpm-workspace.yaml` (`workspaceConcurrency:`). The directories come from the tool cwd plus a leading literal `cd <path> &&`. A config the scan misses is overridden; turn the hook off or pass the flag if that happens.
- The result shows one line only when the command runs `cargo`, `pnpm`, `npm`, `npx`, `yarn`, `bun` or `tauri`, e.g. `[Concurrency defaults (budget 6): CARGO_BUILD_JOBS=6, pnpm workspace-concurrency=3; kept yours: RUST_TEST_THREADS=2.]`. The same data is in `details.bashDiagnostics.concurrency`. Passed-check fingerprints include the applied env, so they changed once when this shipped.

**Heavy-check limit.** One `HeavyCheckSlots` per daemon is shared by every window and session (the CLI gets its own per process). A whole-workspace test or build takes a slot: `pnpm|npm|yarn|bun [run] test|build` without `--filter`/`-F`/`--dir`/file arguments, `pnpm -r|--recursive … test|build`, `cargo test|build|nextest run` without `-p`/`--package`/a test filter, and `tauri build`. The match is conservative; a miss only means no queueing.

- Slot held by the same session: refused at once with guidance to wait with `task_output` or stop with `task_stop`. Nothing is run.
- Slot held by another window: queued first-in-first-out with a progress notice ("Waiting for another window's `pnpm test` …"). Stopping the call cancels the wait. After 15 minutes it refuses with guidance.
- A holder is never killed. A check moved to the background keeps its slot until its process exits.
- Subagents running as separate processes are not covered.

**Settings:**

| Setting               | Default | Meaning                                              |
| --------------------- | ------- | ---------------------------------------------------- |
| `concurrencyBudget`   | `0`     | 0 = derive from the machine; 1–256 fixes the budget. |
| `concurrencyDefaults` | `true`  | `false` turns the env defaults off.                  |
| `heavyCheckLimit`     | `1`     | Concurrent heavy checks per daemon (0–8; 0 = off).   |

**Overload advice.** When the timeout-only advice above fires, it now ends with the budget in use and a link here, e.g. "Concurrency budget here: budget 6 (12 threads, ~6 cores est., 24 GiB); see docs/harness-checks.md#machine-profile-defaults (setting `concurrencyBudget`)."

**A/B on this machine (2026-10-31, i7-8700).** Fixture: `pnpm -r --if-present test` in supa, the old all-at-once shape (14 packages, vitest 5.0.5). Three alternating runs per arm, with the defaults on (workspace concurrency 3) and off (pnpm's default of 4).

| Arm | Wall time (mean, range) | Avg CPU | Seconds at ≥95% CPU | Failed / timed out |
| --- | ----------------------- | ------- | ------------------- | ------------------ |
| off | 147.1 s (136–153)       | 68.0%   | 23.0                | 0 / 0              |
| on  | 141.8 s (134–148)       | 65.3%   | 22.0                | 0 / 0              |

- Every run passed all 5,318 tests, and both arms reached 100% CPU. The roughly 4% difference is within noise.
- One earlier, unmeasured off run hit 4 vitest "Failed to start forks worker" errors. It was cold and the machine was already busy, so it is not counted.
- The default is unchanged: the run showed no harm and no clear gain.

**Risk.** `CARGO_BUILD_JOBS=6` can slow a cargo build that runs alone (hyper-threading gain lost). The cargo arm was not measured. Evidence: `.gg/verification/machine-profile-ab-2026-10-31/`.

## CI that never starts

Problem: GitHub refused to start every CI run (account billing or spending limit), so CI-only checks silently never ran while the title bar looked like an ordinary failure.

- **Detection** (`getGitHubCI`). For the exact `HEAD`, a finished, unsuccessful run counts as not started only when every job is `completed` with no steps and no runner, and the first non-skipped job's check-run annotations say both "job was not started" and a billing phrase (`payments have failed`, `spending limit`, `billing`). Any real failure wins: `conclusion: "not_started"` only when no workflow actually ran. An unreadable annotation stays an ordinary failure.
- **History** (`getGitHubCIHistory`, only for a not-started `HEAD`, at most every 10 minutes). The default branch's last green run time (`lastSuccessAt`, `null` = never) and how many of its newest 10 finished runs were refused (`notStartedStreak`, `10+` at the cap). A lookup failure leaves history unknown, which never alarms.
- **Notice** (`createCINotStartedNotifier`). One short agent notice per session id once the default branch has had no green run for more than 3 days (`thresholdMs`), e.g. "…GitHub refused to start the last 4 runs, most likely an account billing or spending-limit problem. Checks that only run in CI have not run, so local checks are the only gate. Status notice only; not verification evidence." Silent while history is unknown or the state is stale. `app-sidecar.ts` re-checks it on poll changes and before every run (`createCINotStartedNotify`), so a new or loaded conversation still hears a steady refused state.
- **Status, not evidence.** The notice reaches the model through `session.notify`; it is never written to the verification ledger and never satisfies or blocks a check.
- **Cache limits.** `NotStartedCache` maps `runId.attempt` to the verdict (a finished attempt never changes), at most 100 entries, oldest first out, one cache per poll. Unreadable annotations are not cached, so they are retried.
- The title bar (`gg-app/src/CIIndicator.tsx`) shows the refused state and streak from the same `GitHubCI` fields.

## End-to-end proof

**Connected replay** (`ggcoder/src/core/agent-session-am-replay.test.ts`). A real `AgentSession` and agent loop against the scripted palsu provider, on a fixture git monorepo with an approved `.gg/verify-plan.json`: a TS gate covering `packages/app/**` and a Rust-like `cargo test` gate covering `crates/**` with `quietBudgetSeconds` and `protectedPaths: ["docs/evidence/**"]`. It replays the supa AM pattern:

1. Edit a TS file; the TS gate fails with three vitest timeouts and is flagged as possible overload; the re-run passes.
2. `git status --short`.
3. A silent `cargo test` moves to the background, outlives its quiet budget and exits 0 with no stop reason.
4. An identical re-run gets the "still current evidence, so this re-run is optional" notice.
5. A not-started CI notice is published twice and reaches the model once.
6. A screenshot script's change is reported as `docs/evidence/a.png (modified, protected)`.

It ends with no verification problem, current passes for both gates, exactly two cargo runs and no unscripted (nudge) turn.

- Scaled run (default): 18 s silent gate on Windows (the yield floor is 10 s); the whole file passes 5/5 in about 103 s.
- Real-time run (`GG_AM_REPLAY_REALTIME=1`, real limits: 120 s yield, 600 s quiet budget, 60 min hard limit): a 13-minute (780 s) silent gate survived; the test passed in 794 s on 2026-11-01. Evidence: `.gg/verification/am-replay-2026-11/realtime-run.log`.
- Limits: the CI state is injected through `createCINotStartedNotify`, not fetched with a real `gh`; the poller and detection are covered by `utils/github-ci.test.ts`. The provider is scripted, so the test shows what the harness reports, not how a real model reacts to it.

**Connected regressions** (same file):

- A failing `cargo test` after a pass is recorded after it, and the session stays unverified, also after an unrelated edit outside `covers`.
- An unapproved descriptor never runs its command, even with `trustProjectMcpServers` and `trustedProjects` set.
- Your `CARGO_BUILD_JOBS`, the project's `.cargo/config.toml` `RUST_TEST_THREADS` and an inline value all win over the defaults ("kept yours" / "kept project config").
- With `bashHardLimitMinutes: 1`, a runaway command that moved to the background is stopped with `stopReason: "timedOut"` after about 61 s.

**supa recorded replay, before and after** (2026-11-01, approved; no paid calls). The 24 gate commands of a local supa morning session (2026-10-30 10:39-11:47, the one with the most Rust gates) were replayed in order through a real `AgentSession` and palsu, on a scratch worktree of supa at `f680af95`. Each gate was preceded by a marker edit to the files the session edited, and the same warm-up ran before each arm. Before = fork `24e62ce2`; after = this working tree with an approved supa plan descriptor.

| Metric                                  | Before | After  |
| --------------------------------------- | ------ | ------ |
| Total wall time                         | 669 s  | 621 s  |
| Gate runs / reruns                      | 24 / 0 | 24 / 0 |
| Killed commands                         | 0      | 0      |
| CPU-overload failures                   | 0      | 0      |
| Agent turns                             | 43     | 43     |
| Failed gates (environmental, identical) | 6      | 6      |

- One run per arm on one machine: the 7% difference is within noise, not a measured gain.
- With a warm cache every gate took 3-85 s, under the 120 s yield, so the quiet-command fix, reuse notices and overload advice never engaged. The replay shows no regression on this workload; it does not reproduce the AM waste. That session's transcript is not on this machine, and the replayed session's own log has no harness stops.
- The 6 failures need gitignored media binaries absent from the scratch tree. Python edit scripts, new test files and the graphics-renderer gates (their bootstrap downloads FFmpeg) were not replayed. Token cost was not measured (palsu reports no usage). Evidence: `.gg/verification/am-replay-2026-11/supa-replay-summary.md`.

## Upstream trial merge

2026-11-01, upstream/main `7b6e2885`, in a scratch worktree. Both merges were aborted, the scratch branches deleted, nothing pushed. Before = `24e62ce2`; after = a snapshot commit of the working tree on `c60c6f75`, including the uncommitted phase 5-7 files. Evidence: `.gg/verification/am-replay-2026-11/merge-trial.txt`.

| File                                        | Before        | After                     |
| ------------------------------------------- | ------------- | ------------------------- |
| `ggcoder/src/tools/bash.ts`                 | auto-merged   | auto-merged               |
| `ggcoder/src/core/process-manager.ts`       | auto-merged   | auto-merged               |
| `ggcoder/src/core/verification-evidence.ts` | auto-merged   | auto-merged               |
| `ggcoder/src/utils/github-ci.ts`            | auto-merged   | auto-merged               |
| Other files                                 | 12 conflicted | same 12, same hunk counts |

Upstream has not touched the four harness files since merge base `988f920e`, so the harness work (+1076/−184 lines in them) adds no conflict today. The 12 conflicts (CI workflow, AGENTS.md, README, gg-app settings and activity bar, Claude Code version files) come from other fork work. A later upstream change to these four files would conflict; the small call-site hooks chosen above limit that.

## References

Reviewed 2026-10-30 (inspected or skimmed during research). Commits, line ranges and licences re-checked 2026-11-01 with `gh api`; the licence is read from the LICENSE file at the pinned commit. Ideas only; no code was copied. Check log: `.gg/verification/am-replay-2026-11/references-check.txt`.

| Source                                                                                                                                                                                                           | Lines    | Licence                           | Used for                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| [supa `docs/features/verification.md`](https://github.com/creativeprofit22/supa-video-produzah/blob/f680af95110af6387f9999a7a498347b0f9eaea0/docs/features/verification.md#L81-L120)                             | 81-120   | private, owner's repo, no licence | plan v1, `skip` with `lastRun`, summary.json (supa plan v1 adapter)                     |
| [Tianshu-harness `src/lsp/typecheck-cache.ts`](https://github.com/huiliyi37/Tianshu-harness/blob/7a13cf0c7de999b124faf3ea7a86a2795fb849a7/src/lsp/typecheck-cache.ts#L1-L678)                                    | 1-678    | Apache-2.0                        | fingerprint before and after, cache only conclusive results, fail open (Reusing passes) |
| [Tianshu-harness `scripts/test-runner-flags.ts`](https://github.com/huiliyi37/Tianshu-harness/blob/7a13cf0c7de999b124faf3ea7a86a2795fb849a7/scripts/test-runner-flags.ts#L8-L13)                                 | 8-13     | Apache-2.0                        | `min(4, cores)` test concurrency (Machine-profile defaults)                             |
| [Tianshu-harness `scripts/test-child-guard.ts`](https://github.com/huiliyi37/Tianshu-harness/blob/7a13cf0c7de999b124faf3ea7a86a2795fb849a7/scripts/test-child-guard.ts#L1-L60)                                   | 1-60     | Apache-2.0                        | counter-example: idle kill, leftovers without a hard cap (Quiet commands after a move)  |
| [Tianshu-harness `src/agent/verification-snapshot-manager.ts`](https://github.com/huiliyi37/Tianshu-harness/blob/7a13cf0c7de999b124faf3ea7a86a2795fb849a7/src/agent/verification-snapshot-manager.ts#L36-L48)    | 36-48    | Apache-2.0                        | dirty files outside the session's own writes (Changed files)                            |
| [Tianshu-harness `src/tools/run-tests-snapshot-result.ts`](https://github.com/huiliyi37/Tianshu-harness/blob/7a13cf0c7de999b124faf3ea7a86a2795fb849a7/src/tools/run-tests-snapshot-result.ts#L1-L10)             | 1-10     | Apache-2.0                        | note capped at 8 paths plus a count (Changed files)                                     |
| [gptme `gptme/tools/shell_background.py`](https://github.com/gptme/gptme/blob/d4ef1c357721b86a14fd4621454b4534667f73bc/gptme/tools/shell_background.py#L933-L1010)                                               | 933-1010 | MIT                               | end the wait, keep the job, report late completion (Quiet commands after a move)        |
| [kimi-code `bash/bashTool.ts`](https://github.com/MoonshotAI/kimi-code/blob/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts#L86-L102)                        | 86-102   | MIT                               | auto-background with a separate detach timeout; a peer with the same kill problem       |
| [kimi-code `bash/bash.ts`](https://github.com/MoonshotAI/kimi-code/blob/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55/packages/agent-core-v2/src/agent/tools/os/bash/bash.ts#L6-L11)                                  | 6-11     | MIT                               | counter-example: 10-minute background timeout                                           |
| [kimi-code `task/taskService.ts`](https://github.com/MoonshotAI/kimi-code/blob/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55/packages/agent-core-v2/src/agent/task/taskService.ts#L936-L946)                          | 936-946  | MIT                               | cap on concurrent background tasks with a clear error (Heavy-check limit)               |
| [LibreChat `config/jest.workers.cjs`](https://github.com/danny-avila/LibreChat/blob/8d3da9bbb220a0a96be9330a2e1cbd385fb786d5/config/jest.workers.cjs#L1-L39)                                                     | 1-39     | MIT                               | half the cores, CI floor, memory cap per worker (Machine-profile defaults)              |
| [turborepo `crates/turborepo-hash/src/lib.rs`](https://github.com/vercel/turborepo/blob/edace46216977186c109f26c9dd6137179d4a704/crates/turborepo-hash/src/lib.rs#L56-L77)                                       | 56-77    | MIT                               | task hash over files, env and argv (Reusing passes)                                     |
| [cc-rs `src/parallel/command_runner.rs`](https://github.com/rust-lang/cc-rs/blob/0b21008a9240dd77f0e217e624a22ddd05729b3c/src/parallel/command_runner.rs#L60-L75)                                                | 60-75    | MIT OR Apache-2.0                 | one jobserver pool shared through env (Machine-profile defaults)                        |
| [storybook `scripts/ci/common-jobs.ts`](https://github.com/storybookjs/storybook/blob/4e73b9de70e4928b06fe4b5d6e9ab04eeac28b9e/scripts/ci/common-jobs.ts#L718-L723)                                              | 718-723  | MIT                               | quiet budget per step, `no_output_timeout` (Contract: `quietBudgetSeconds`)             |
| [gg-framework `packages/ggcoder/src/tools/bash.ts`](https://github.com/KenKaiii/gg-framework/blob/e6076b8c54e857ea4f8f1df952f870ad24db3932/packages/ggcoder/src/tools/bash.ts#L460-L500)                         | 460-500  | MIT                               | upstream hand-off with no silence kill; the merge target (Quiet commands after a move)  |
| [gg-framework `packages/ggcoder/src/core/verification-gate.ts`](https://github.com/KenKaiii/gg-framework/blob/e6076b8c54e857ea4f8f1df952f870ad24db3932/packages/ggcoder/src/core/verification-gate.ts#L308-L335) | 308-335  | MIT                               | upstream `mutatedFiles` and pass/fail maps (What counts as a check)                     |

Earlier phases recorded the LibreChat, turborepo, cc-rs and storybook licences as unverified; the 2026-11-01 check found them as listed.
