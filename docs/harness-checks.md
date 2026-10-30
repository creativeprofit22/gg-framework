# Harness checks

How the harness learns which checks a project wants, which files each check covers, and what counts as a pass. The harness owns the contract and the evidence; each project owns its own rules and gate scripts. The harness never imports project code and never depends on one particular project.

## Module map

One owner per concern. "Later" means a following Roadmap phase adds it; nothing here changes behaviour yet.

| Concern         | Owner                                                                                          | Interface                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract        | `packages/gg-core/src/verify-plan.ts`, subpath `@kenkaiiii/gg-core/verify-plan`                | Types `VerifyPlan`, `VerifyGate`, `VerifyPlanAdvice`, `VerifyPlanDescriptor`; pure `parseVerifyPlan`, `parseVerifyPlanJson`, `adaptSupaPlanV1`, `parseVerifyPlanDescriptor`, `decideVerifyPlanSource`, `interpretVerifyPlanOutput`; limits. |
| Plan loader     | ggcoder (later)                                                                                | Reads `.gg/verify-plan.json`, checks project trust, runs the descriptor command through the existing sandboxed launch with `VERIFY_PLAN_COMMAND_LIMITS`, and passes stdout to `interpretVerifyPlanOutput`. Falls back to heuristics.        |
| Check coverage  | ggcoder, built from `core/verification-evidence.ts` and upstream-shaped `mutatedFiles` (later) | Matches changed files against each gate's `covers` and records the harness's own observed passes. Project advice is never evidence.                                                                                                         |
| Machine profile | ggcoder (later)                                                                                | Per-machine budgets (quiet and hard limits) that a gate's `quietBudgetSeconds` can only narrow.                                                                                                                                             |
| Changed files   | ggcoder: git via `utils/git.ts` plus `core/verification-snapshot.ts`                           | Repo-relative changed paths, in the same `/`-separated form the contract uses.                                                                                                                                                              |
| CI state        | ggcoder: `utils/github-ci.ts`                                                                  | `getGitHubCI` / `startGitHubCIPoll`; reports remote CI separately from local evidence.                                                                                                                                                      |

Later ggcoder and gg-app code imports plan types only from `@kenkaiiii/gg-core/verify-plan`. Don't add parallel types.

## Contract (version 1)

A plan is `{ version: 1, mode: "changed" | "full", gates, advice? }`. Each gate is `{ id, argv, cwd?, covers?, fingerprint?, quietBudgetSeconds?, protectedPaths? }`; missing optional fields become `"."`, `[]` or `null`.

- Unknown keys are rejected. Any version other than `1` (including a missing one) is rejected with `unsupported verify-plan version <v>; expected 1`.
- `id`: `^[a-z0-9][a-z0-9._-]{0,63}$`, unique, at most 64 gates.
- `argv`: an array of 1-64 strings, each 1-1024 chars with no NUL or newline. A plain string is rejected (no shell strings). A shell as the program (`sh`, `bash`, `zsh`, `dash`, `ksh`, `cmd`, `powershell`, `pwsh`, with or without a path or `.exe`) is rejected.
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

- `decideVerifyPlanSource` runs nothing. It returns `run` only for a trusted project with a valid descriptor; otherwise heuristics, with a fixed reason (untrusted project, no descriptor, bad descriptor).
- The loader runs the command with a 30 s timeout and a 256 KiB output cap (`VERIFY_PLAN_COMMAND_LIMITS`).
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
