# GG Coder Reliability and Notes Roadmap

## Purpose

Deliver two ordered outcomes:

1. close the still-valid hang-prevention and process-lifecycle work carried forward from the previous roadmap; and
2. add a compact, project-scoped Notes Roadmap that can start, resume, track, review, and remind users about agent work.

This file is an implementation plan, not a storage surface for user roadmap data. Product roadmap data must live in one versioned, project-scoped store behind the app-sidecar boundary.

## Current baseline

- **Implementation status:** Phases 00–15 are complete and verified.
- **Historical Phase 00 evidence:** CI run [`29904554147`](https://github.com/creativeprofit22/gg-framework/actions/runs/29904554147) is green across all three framework jobs and all three app jobs; each platform completed three supervised workspace runs with zero survivors.
- **2026-07-23 Phase 08 evidence:** The focused ProcessManager/foreground lifecycle run passed 65 tests with 2 platform skips across 67 tests. The ggcoder typecheck, targeted ESLint, and targeted Prettier checks passed.
- **2026-07-24 implementation audit:** Commit ancestry and source/test inspection confirm Phases 00–09 are implemented. A 190-test ggcoder lifecycle/background matrix reported 186 passed, 1 expected failure, and 3 platform skips; the nested-launcher probe exposed its full worker tree in this supervised run. The 41-test workspace suite, 34 focused app diagnostics/Notes tests, and 3 sidecar diagnostics/isolation tests also passed, for 264 passing targeted tests overall. The ggcoder and gg-app typechecks, targeted ESLint, targeted Prettier, and roadmap coverage check passed.
- **2026-07-24 Phase 10 evidence:** The focused background/foreground matrix passed 116 tests with 1 expected failure and 3 platform skips across 120 tests. Bounded allocation, byte offsets, UTF-8 paging, flush-gated completion, record expiry, stale-log sweeping, and hard-deadline foreground cleanup are covered; the ggcoder typecheck and targeted ESLint/Prettier checks pass.
- **2026-07-24 Phase 11 evidence:** The focused lifecycle and explicit command-mode matrix passed 112 tests with 1 expected failure and 3 platform skips across 116 tests. Its 11 owning rows cover six finite foreground classes and five long-lived/interactive background classes; the ggcoder typecheck, targeted ESLint/Prettier, roadmap coverage, and diff checks pass.
- **2026-07-25 Phase 12 evidence:** The refreshed focused lifecycle matrix passed 137 tests with 3 platform skips across 140 tests and no expected failures. EOF-capable shutdown exits cleanly with code 0, EOF-ignoring shutdown escalates once after 2,000 ms, stop output waits for flush-settled metadata and final unread output, and text/newline/EOF controls are independent. The ggcoder typecheck, targeted ESLint/Prettier, roadmap coverage, and diff checks pass.
- **2026-07-25 current-head audit:** Commit ancestry plus source, generated-bundle, test, and smoke inspection reconfirm Phases 00–12 as implemented. The expanded lifecycle/Phase 13 contract matrix passed 145 tests with 3 platform skips across 148 tests; all 336 gg-app tests, all 100 Rust tests, and the 42-test workspace suite passed. The ggcoder build, ggcoder and gg-app typechecks, gg-app lint, targeted Prettier, roadmap coverage, diff checks, sidecar bundle, and bundled-runtime `/state` smoke also passed.
- **Current-head Phase 00 evidence:** Commit `40692c2f` waits for the snapshot-driven workspace readiness signal before closing a pane with active work and dismisses the preceding lifecycle-error toast. Local verification passed the 41-test suite, three supervised Windows repeats, gg-app typecheck, targeted lint/format, and diff checks. CI run [`30145553034`](https://github.com/creativeprofit22/gg-framework/actions/runs/30145553034) is green across all six Windows, macOS, and Linux jobs; every platform completed three supervised workspace repeats with zero survivors.
- **2026-07-25 Phase 14 evidence:** Track A is frozen at verification commit `7c1d4a13`. CI run [`30161379020`](https://github.com/creativeprofit22/gg-framework/actions/runs/30161379020) passed all six framework/app jobs on Windows, macOS, and Linux on its first attempt. The owning Linux lifecycle suites passed 112 tests with 2 explicit Windows-only skips, the Windows matrix passed 103 tests with 11 explicit platform skips, and the cooperative POSIX timeout probe passed 20/20 stress repeats. Repository check/lint/format/build passed; 25 warm persistent commands measured `0.757 ms` p95 on Windows. All three workspace evidence artifacts passed three supervised runs with bounded gross memory and zero survivors.
- **2026-07-25 roadmap implementation audit (`0c6fe66b`):** Commit ancestry, source, generated-sidecar, IPC, schema, UI, and test inspection confirm Phases 00–14 are implemented and Phase 15 is the first unimplemented phase. The focused ggcoder lifecycle matrix passed 142 tests with 12 explicit platform skips across 154 tests; 20 focused sidecar tests, all 337 gg-app tests, and all 100 Rust tests passed. The ggcoder and gg-app typechecks, gg-app lint, roadmap coverage check, and diff checks also passed.
- **2026-07-25 Phase 15 evidence:** Notes authority now lives in the shared sidecar's revisioned project repository with create-if-absent migration, strict v1 envelope/v2 document validation, backup recovery, disk CAS, operation replay, and same-project `notes_change` fan-out. The focused sidecar matrix passed 24 tests, the focused app matrix passed 42 tests, all 1,954 ggcoder tests passed with 15 platform skips under a disposable test home, all 352 gg-app tests passed, and all 102 Rust tests passed. Typechecks, app lint/format, builds, sidecar bundling, and generated-output audits are green.
- **Next phase:** Phase 16 — Add phase, reference, and lifecycle schemas.
- **Track A freeze:** Complete at `7c1d4a13`; the three-OS matrix, workspace memory evidence, and two-window Windows desktop timeout smoke are green. The two later commits contain roadmap text and test synchronization only, so production behavior remains frozen; `0c6fe66b` has no separate Actions run because CI triggers only for `main` pushes and pull requests.
- **Later-track audit:** Phase 15 is complete; Phases 16–26 have not started. Phase 20 has only prerequisites already present—Ken prompt blocks can Send to GG Coder and `PaneAgentClient.newSession()` can create a fresh session—not its guarded fresh-send/save workflow.
- **Notes baseline:** Notes retains Now, Next, Handoff, Reference, and Done / Archive unchanged, while the sidecar now owns durable authority. Roadmap entities, reminder fields, agent-authored transitions, and lifecycle schemas remain intentionally absent until Phase 16 and later phases.
- **Planning rule:** no phase starts until the previous phase has passed its acceptance tests and its hard-stop evidence is recorded.
- **Change boundary:** each phase is a small review unit. Implementation may commit at a phase boundary, but this roadmap update changes documentation only.

## Global constraints

- Keep the existing 120-second default foreground deadline and explicit per-call overrides.
- Keep finite checks foreground; keep dev servers, watchers, REPLs, and input-waiting commands explicitly managed in background.
- Never rely on Vitest's in-worker timeout as the only deadline for a CPU-bound child.
- Kill process trees by PID/process group, never by image name.
- Persist diagnostics before waiting for process close; keep memory bounded.
- Preserve intentionally detached children after normal completion, but remove descendants on timeout, cancellation, or session shutdown.
- Keep provider/agent/process behavior in the existing agent spine and app-sidecar; do not fork it into `gg-app`.
- Keep Notes Roadmap additive: do not reinterpret or replace Now, Next, Handoff, Reference, or Archive.
- Use a compact list/detail Notes UI, not a Kanban board.
- Treat roadmap/reference text as untrusted working data, not system instructions.
- Manual phase and reference edits always remain possible and override automatic reconciliation until explicitly reset.
- Do not publish, tag, bump versions, or release as part of an implementation phase unless a later release task explicitly requests it.

## Reference register

All external references are evidence only. Copy behavior, not source text, unless its license and project policy permit reuse.

### Reliability references

- **REL-01 — Vitest runtime timeout:** [`packages/vitest/src/runtime/runner/context.ts`](https://github.com/vitest-dev/vitest/blob/3e3e85285fb1256ff49dd5f4ef1ca4ebffe60a17/packages/vitest/src/runtime/runner/context.ts#L32-L72)
- **REL-02 — Vitest 4 configuration:** [`packages/vitest/src/node/config/resolveConfig.ts`](https://github.com/vitest-dev/vitest/blob/3e3e85285fb1256ff49dd5f4ef1ca4ebffe60a17/packages/vitest/src/node/config/resolveConfig.ts#L242-L250)
- **REL-03 — Stable latest-handler ref:** [`features/editor/hooks/use-tauri-event.ts`](https://github.com/do-md/domd/blob/6cda2776d80fb12e80f1efe4544f44df99b5eb79/features/editor/hooks/use-tauri-event.ts#L7-L23)
- **REL-04 — Idempotent process settlement and cleanup:** [`src/main/git/runner.ts`](https://github.com/stablyai/orca/blob/e0edc8ef76d341f7ab8083a006f785322bcaeb23/src/main/git/runner.ts#L432-L506)
- **REL-05 — Windows tree termination:** [`packages/core/src/services/shellExecutionService.ts`](https://github.com/QwenLM/qwen-code/blob/88addbdf68f9a59dd3f1586ed6dfe31dfe98d681/packages/core/src/services/shellExecutionService.ts#L511-L585)
- **REL-06 — Windows argv test:** [`src/main/git/runner-command-exec.test.ts`](https://github.com/stablyai/orca/blob/e0edc8ef76d341f7ab8083a006f785322bcaeb23/src/main/git/runner-command-exec.test.ts#L77-L155)
- **REL-07 — POSIX process groups:** [`packages/core/src/utils/process-utils.ts`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/utils/process-utils.ts#L28-L53)
- **REL-08 — Execution logging:** [`packages/core/src/services/shellExecutionService.ts`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/services/shellExecutionService.ts#L305-L340)
- **REL-09 — Bounded process buffer:** [`packages/core/src/services/shellExecutionService.ts`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/services/shellExecutionService.ts#L49-L66)
- **REL-10 — Final-100-line tail:** [`devAndMaintenanceOrchestratorScript.ts`](https://github.com/manaflow-ai/manaflow/blob/23e83e46160a746c786b18be9883b6e512fe9974/apps/www/lib/routes/sandboxes/devAndMaintenanceOrchestratorScript.ts#L392-L404)
- **REL-11 — Late-reader snapshot:** [`packages/core/src/services/executionLifecycleService.ts`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/services/executionLifecycleService.ts#L62-L74)
- **REL-12 — EOF-first shutdown:** [`packages/opencode/test/lib/cli-process.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/opencode/test/lib/cli-process.ts#L393-L422)

### Notes Roadmap references

- **NOTE-01 — Compact roadmap rows and progress:** [`module-list-item.tsx`](https://github.com/makeplane/plane/blob/7cef741c29cf61d3bca18dc892e6af11a1e7becc/apps/web/core/components/modules/module-list-item.tsx)
- **NOTE-02 — Snooze state:** [`inbox.ts`](https://github.com/makeplane/plane/blob/7cef741c29cf61d3bca18dc892e6af11a1e7becc/packages/types/src/inbox.ts)
- **NOTE-03 — Empty reference tabs:** [`References.tsx`](https://github.com/outline/outline/blob/d57db81c6bb95db721141df61b465a3d1524596c/app/scenes/Document/components/References.tsx)
- **NOTE-04 — Lazy linked-document metadata:** [`embed-linked-doc-block.ts`](https://github.com/toeverything/AFFiNE/blob/81df4751a367f2795bc0d165586650dbe8db73d6/blocksuite/affine/blocks/embed-doc/src/embed-linked-doc-block/embed-linked-doc-block.ts)
- **NOTE-05 — Grouped linked references:** [`reference.cljs`](https://github.com/logseq/logseq/blob/a4963dca579f42817135d8473166a03fa7ea2409/deps/db/src/logseq/db/common/reference.cljs)
- **NOTE-06 — Typed context identity:** [`core/index.d.ts`](https://github.com/continuedev/continue/blob/d0a3c0b626b5bebc3bef4742eec05a0242be0bab/core/index.d.ts)
- **NOTE-07 — Structured GitHub context:** [`internal/types/task.go`](https://github.com/imran31415/agentlog/blob/68970960a32fda3dbe83b42c0f6c66c82f66ae80/internal/types/task.go)
- **NOTE-08 — Context-source validation:** [`internal/tasks/context.go`](https://github.com/imran31415/agentlog/blob/68970960a32fda3dbe83b42c0f6c66c82f66ae80/internal/tasks/context.go)
- **NOTE-09 — Compact active-plan injection:** [`lib/agent/plan/prompts.ts`](https://github.com/MaxQian888/cognia-next/blob/43abbe2cf1efddb9973489b8fb6aad33a110fc12/lib/agent/plan/prompts.ts)
- **NOTE-10 — Session-scoped plan injection:** [`lib/agent/plan/context-injector.ts`](https://github.com/MaxQian888/cognia-next/blob/43abbe2cf1efddb9973489b8fb6aad33a110fc12/lib/agent/plan/context-injector.ts)
- **NOTE-11 — Structured agent progress:** [`write-todos-tool.ts`](https://github.com/n8n-io/n8n/blob/d5d3da67c1447606a74645dcd35cbfd4d5ae45b0/packages/%40n8n/agents/src/runtime/tools/write-todos-tool.ts)
- **NOTE-12 — Derived completion state:** [`src/workbench/plan.ts`](https://github.com/companion-inc/feynman/blob/54d08a33dfe17abca118c093ad7f2c6b1a41421a/src/workbench/plan.ts)
- **NOTE-13 — Explicit approval state:** [`packages/core/src/scheduler/types.ts`](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/core/src/scheduler/types.ts)
- **NOTE-14 — Session links and manual overrides:** [`Link.swift`](https://github.com/langwatch/kanban-code/blob/1927029fcc044c170fcfa139035baf10e7afd7bf/Sources/KanbanCodeCore/Domain/Entities/Link.swift)
- **NOTE-15 — Protected reconciliation:** [`specs/sessions/linking.feature`](https://github.com/langwatch/kanban-code/blob/1927029fcc044c170fcfa139035baf10e7afd7bf/specs/sessions/linking.feature)
- **NOTE-16 — Guarded fresh session:** [`HomePage.tsx`](https://github.com/CherryHQ/cherry-studio/blob/61ac59406c76b577f07c18bacf3a330cbb67284c/src/renderer/pages/home/HomePage.tsx)
- **NOTE-17 — Prompt-save acceptance:** [`clientActions.ts`](https://github.com/Arize-ai/phoenix/blob/30fc981982eb0a192076addc57aec5f01da66c75/app/src/agent/tools/playgroundSavePrompt/clientActions.ts)
- **NOTE-18 — Explicit attention signals:** [`hooks/notification.py`](https://github.com/amirfish1/claude-command-center/blob/32468899b1f1f1065af7b24e6d85ca1e8775e02e/hooks/notification.py)
- **NOTE-19 — Reminder deduplication:** [`main.ts`](https://github.com/RayRayElite/Obsidian-DASH/blob/d7be3206edee3de53d4a89754c395f20fa707f43/main.ts)
- **NOTE-20 — Background-aware notifications:** [`desktopNotificationService.ts`](https://github.com/Stirling-Tools/Stirling-PDF/blob/8b179fbc55d7bb912c98bec5423ed268b042b9dc/frontend/editor/src/desktop/services/desktopNotificationService.ts)
- **NOTE-21 — Lazy permission request:** [`useTaskCompletionNotifier.ts`](https://github.com/sjyinzju/Galcode_island/blob/03f7b3dc26f1b3fe38fe8c8131042bb6a007a6c4/src/hooks/useTaskCompletionNotifier.ts)
- **NOTE-22 — First-class save action:** [`saveAsPromptFileActions.ts`](https://github.com/microsoft/vscode/blob/693614c9f239b49f6d13d55da7f1a851d5b82c36/src/vs/workbench/contrib/chat/browser/promptSyntax/saveAsPromptFileActions.ts)

---

# Track A — Close reliability debt

## Phase 00 — Close workspace-loop evidence

**Status:** Complete.

**Outcome:** The already-landed pane-loop fix has complete acceptance evidence.

**Scope**

- Re-run callback identity, equivalent-snapshot identity, and the complete workspace interaction suite.
- Capture supervised elapsed time, peak process-tree memory, PID, final output tail, and survivor count.
- Run lint and typecheck; exercise Linux and macOS CI.

**Non-goals**

- No new workspace behavior, styling, persistence schema, or callback implementation.

**Affected seams**

- `gg-app/src/WorkspaceNode.tsx`
- `gg-app/src/WorkspaceShell.tsx`
- `gg-app/src/WorkspaceShell.test.tsx`
- `.github/workflows/ci.yml`

**References:** [REL-01](#reference-register), [REL-03](#reference-register)

**Acceptance tests**

- `pnpm --filter gg-app exec vitest run src/WorkspaceShell.test.tsx` passes under an external 120-second supervisor.
- `pnpm --filter gg-app check && pnpm --filter gg-app lint` passes.
- The suite covers split, restore, copy/rollback/reuse, nested moves without remount/disposal, drag cancellation, focus, close/active-work confirmation, pointer/keyboard resize, native drop, and title routing.
- Linux and macOS CI pass; peak memory does not grow across repeated focused runs.

**Completion evidence**

- Historical green CI run: [`29904554147`](https://github.com/creativeprofit22/gg-framework/actions/runs/29904554147).
- Current-head green CI run: [`30145553034`](https://github.com/creativeprofit22/gg-framework/actions/runs/30145553034).
- Framework jobs: `windows-latest · node 22.x` passed; `macos-latest · node 22.x` passed; `ubuntu-latest · node 22.x` passed.
- App jobs: `app · windows-latest` passed; `app · macos-latest` passed; `app · ubuntu-latest` passed.
- Windows artifact: 3 runs; peak process-tree memory `[405884928, 393076736, 407207936]` bytes; growth `1323008` bytes; 0 survivors.
- macOS artifact: 3 runs; peak process-tree memory `[516456448, 508919808, 517488640]` bytes; growth `1032192` bytes; 0 survivors.
- Linux artifact: 3 runs; peak process-tree memory `[510341120, 508952576, 513036288]` bytes; growth `2695168` bytes; 0 survivors.

**Hard stop:** Satisfied — current-head CI passed all six jobs; each platform completed all three supervised workspace repeats with bounded memory and zero survivors.

## Phase 01 — Add bounded foreground hang fixtures

**Status:** Complete (`6c5ef6ad`).

**Outcome:** Deterministic CPU-spin, silent-sleep, and nested-launcher fixtures expose the current host-deadline behavior without hanging CI.

**Scope**

- Add `packages/ggcoder/src/tools/bash-timeout.test.ts` and dedicated fixtures.
- Expose root and descendant PIDs, elapsed time, timeout result, and final output tail.
- Quote/escape executable paths so the fixtures run through Git Bash on Windows.

**Non-goals**

- No timeout, termination, or output implementation changes.

**Affected seams**

- `packages/ggcoder/src/tools/bash-timeout.test.ts`
- `packages/ggcoder/src/tools/__fixtures__/`
- `packages/ggcoder/src/core/process-manager-dev-server-repro.test.ts`

**References:** [REL-01](#reference-register), [REL-02](#reference-register)

**Acceptance tests**

- CPU-bound, silent, and `shell → package-manager shim → node → worker` fixtures start on Windows, macOS, and Linux.
- Every fixture runs under an outer job/supervisor deadline and exposes all expected PIDs.
- `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts` terminates predictably.
- `pnpm --filter @kenkaiiii/ggcoder check` passes.

**Completion evidence**

- CPU-spin, silent-sleep, and nested-launcher probes remain externally supervised and expose PID, elapsed-time, timeout, and output-tail evidence.
- The 2026-07-23 Windows audit completed all three probes without firing the outer deadline.

**Hard stop:** Satisfied — baseline fixtures and supervisor evidence are preserved; production behavior changed only in later phases.

## Phase 02 — Model one foreground execution outcome

**Status:** Complete (`45618c8d`).

**Outcome:** Every foreground execution settles exactly once with an explicit reason.

**Scope**

- Represent `completed`, `nonZeroExit`, `timedOut`, `aborted`, and `spawnError` separately.
- Keep reason, exit code, signal, start time, elapsed time, and PID distinct.
- Use one idempotent finalizer.

**Non-goals**

- No descendant termination, persisted logs, or foreground/background storage merge.

**Affected seams**

- `packages/ggcoder/src/tools/bash.ts`
- `packages/ggcoder/src/types.ts`
- `packages/ggcoder/src/tools/bash-timeout.test.ts`

**References:** [REL-04](#reference-register)

**Acceptance tests**

- Zero exit, non-zero exit, spawn failure, abort, and timeout have distinct outcomes.
- Timeout/close, abort/close, and error/close races settle once.
- Abort and timeout render distinct user-facing results; spawn failure remains immediate.
- Outcome/race tests and the ggcoder package typecheck pass.

**Completion evidence**

- Focused tests cover all five reasons, preserve independent code/signal/timing/PID metadata, and prove first-settlement ownership across close/error/abort races.
- The 2026-07-23 focused lifecycle run and ggcoder typecheck passed.

**Hard stop:** Satisfied — race tests prove exactly one settlement and metadata fields remain distinct.

## Phase 03 — Enforce the host-owned foreground deadline

**Status:** Complete (`eb5f8309`).

**Outcome:** A foreground call returns `TIMEOUT` even when the child never yields or never emits `close`.

**Scope**

- Keep the 120-second default and existing explicit override contract.
- Mark timeout before cleanup, bound cleanup grace, and return after that bound.
- Keep the host responsive during child CPU saturation.

**Non-goals**

- No watch-command classification or automatic backgrounding.

**Affected seams**

- `packages/ggcoder/src/tools/bash.ts`
- `packages/ggcoder/src/core/persistent-shell.ts`
- `packages/ggcoder/src/tools/bash-timeout.test.ts`

**References:** [REL-01](#reference-register), [REL-04](#reference-register)

**Acceptance tests**

- CPU-spin and sleeping fixtures return within configured deadline plus bounded cleanup allowance.
- A shorter override is honored; the default remains exactly 120,000 ms.
- Timeout includes PID and elapsed time and resolves even if cleanup is only best-effort.
- CPU-spin/sleep deadline tests and the ggcoder package typecheck pass.

**Completion evidence**

- The host marks timeout at the configured deadline and settles after a fixed 1,000 ms cleanup grace even when cleanup or child `close` never resolves.
- Focused tests preserve the exact 120,000 ms default and explicit override behavior.

**Hard stop:** Satisfied — timeout settlement no longer depends on child `close`.

## Phase 04 — Make foreground finalization leak-free

**Status:** Complete (`6b11811e`).

**Outcome:** Every completion path releases timers and child, stream, and abort listeners.

**Scope**

- Centralize cleanup in the idempotent finalizer.
- Handle child `error`/`close` races and asynchronous cleanup-child errors.
- Log cleanup failures without replacing the original command outcome.

**Non-goals**

- No retention policy or ProcessManager redesign.

**Affected seams**

- `packages/ggcoder/src/tools/bash.ts`
- `packages/ggcoder/src/core/persistent-shell.ts`
- `packages/ggcoder/src/tools/bash-timeout.test.ts`

**References:** [REL-04](#reference-register)

**Acceptance tests**

- Listener counts return to baseline after success, timeout, abort, and spawn error.
- Cleanup-launch failure is logged and does not become an unhandled EventEmitter error.
- Timeout/abort races still settle once.
- Focused test, typecheck, and lint pass.

**Completion evidence**

- Listener/timer baseline tests cover success, timeout, abort, and spawn error; cleanup rejection is logged without replacing the selected result.
- The 2026-07-23 focused lifecycle run, ggcoder typecheck, and targeted ESLint passed.

**Hard stop:** Satisfied — foreground completion paths retain no tested listeners/timers and cleanup errors are handled.

## Phase 05 — Harden Windows process-tree termination

**Status:** Complete (`52ccbc81`, `51666497`).

**Outcome:** Windows cancellation removes the shell wrapper and descendants without targeting unrelated processes.

**Scope**

- Resolve `%SystemRoot%\System32\taskkill.exe` and invoke it with argv `/PID <pid> /T /F`.
- Kill the PID tree before waiting for the tracked shell wrapper to close.
- Treat an exited PID as success; log launch, access-denied, and non-zero failures.
- Check liveness where practical to reduce PID-reuse risk.

**Non-goals**

- No process-name kills, all-Node kills, POSIX changes, or normal-completion descendant kills.

**Affected seams**

- `packages/ggcoder/src/utils/process.ts`
- `packages/ggcoder/src/core/process-manager.ts`
- `packages/ggcoder/src/core/process-manager.test.ts`
- `packages/ggcoder/src/tools/bash-timeout.test.ts`

**References:** [REL-05](#reference-register), [REL-06](#reference-register)

**Acceptance tests**

- `cmd.exe → pnpm.cmd → node.exe → worker` leaves no descendant after timeout or abort.
- A dead PID is harmless; failed `taskkill` is observable and cannot crash the host.
- PID-tree termination is asserted before close waiting; no process-name kill is issued.
- Tests run on Windows CI and a local Windows desktop smoke.

**Completion evidence**

- Unit tests cover absolute `taskkill.exe` resolution, PID-only argv, dead-PID success, launch/access/non-zero failures, liveness checks, and direct-PID fallback.
- The 2026-07-23 Windows audit passed real timeout and abort probes and observed zero survivors across the `cmd.exe → pnpm.cmd → node.exe → worker` fixture tree.
- The current ProcessManager uses tracked child processes rather than a ConPTY host; its ordering contract is tree termination before close waiting.

**Hard stop:** Satisfied — a real Windows descendant-survival assertion passes for timeout and abort.

## Phase 06 — Add POSIX TERM/KILL escalation

**Status:** Complete (`68188bd7`, `b06223c0`).

**Outcome:** POSIX timeout/cancellation removes a dedicated process group after a bounded graceful window.

**Scope**

- Spawn supported foreground commands in a dedicated group.
- Signal negative PGID with `SIGTERM`, then `SIGKILL` only if still alive.
- Fall back to direct PID and descendant traversal when group signaling fails.

**Non-goals**

- No Windows changes or immediate force-kill after successful graceful exit.

**Affected seams**

- `packages/ggcoder/src/utils/process.ts`
- `packages/ggcoder/src/core/process-manager.ts`
- `packages/ggcoder/src/core/process-manager.test.ts`
- `packages/ggcoder/src/tools/bash-timeout.test.ts`

**References:** [REL-07](#reference-register)

**Acceptance tests**

- A cooperative group exits on TERM without KILL.
- A TERM-ignoring group escalates to KILL.
- Group failure uses a bounded direct/descendant fallback; an exited process is harmless.
- Linux group tests and macOS desktop smoke pass without signaling unrelated groups.

**Completion evidence**

- The landed Phase 06 commits add bounded descendant snapshots, cooperative TERM handling, forced KILL escalation, direct/descendant fallback, helper timeouts, and focused lifecycle coverage.
- The 2026-07-23 Phase 07 verification reran the Phase 06 utility and real process probes inside the 103-test focused matrix; the ggcoder typecheck and targeted ESLint passed.

**Hard stop:** Satisfied — graceful TERM, forced KILL, bounded fallback, and helper cleanup remain separately covered.

## Phase 07 — Separate cancellation from normal completion

**Status:** Complete (`d1771368`).

**Outcome:** Cancellation removes the full tree; normal completion preserves intentionally detached work.

**Scope**

- Full tree cleanup for timeout, user cancel, and session shutdown.
- Wrapper-only reap after normal completion when a shell/PTY wrapper remains.
- Liveness checks and late-abort protection.

**Non-goals**

- No survival guarantee during explicit shutdown and no process-name intent inference.

**Affected seams**

- `packages/ggcoder/src/tools/bash.ts`
- `packages/ggcoder/src/core/process-manager.ts`
- `packages/ggcoder/src/utils/process.ts`
- related focused tests

**References:** [REL-05](#reference-register), [REL-07](#reference-register)

**Acceptance tests**

- A deliberately detached child survives normal foreground completion.
- It does not survive timeout, cancellation, or session shutdown.
- A late abort cannot convert completed cleanup into a tree kill.
- Detectable PID reuse prevents cleanup against the new process.

**Completion evidence**

- The Windows host matrix proves a detached worker survives normal completion and is removed by timeout, AbortSignal cancellation, and `ProcessManager.shutdownAll()`; every survivor is force-cleaned in test `finally` blocks.
- Focused utility tests prove tree versus exact-PID scope, Windows `/T` versus wrapper-only argv, guard checks before destructive phases, TERM-to-KILL re-checks, and live-but-reused PID no-ops.
- Foreground race tests prove zero/non-zero completion can request only wrapper reap, interruption owns full-tree cleanup, and late abort dispatches no tree cleanup.
- Verification command: `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/utils/process.test.ts src/core/process-manager.test.ts src/core/process-manager-dev-server-repro.test.ts src/tools/bash-timeout.test.ts` — 106 passed, 1 expected failure, 3 skipped across 110 tests.
- `pnpm --filter @kenkaiiii/ggcoder check`, targeted ESLint, and targeted Prettier (including the detached fixtures and this roadmap) pass.

**Hard stop:** Satisfied — normal completion and cancellation have opposite, deterministic detached-descendant behavior, and detectable PID reuse receives no destructive call.

## Phase 08 — Persist a foreground log before spawn

**Status:** Complete (2026-07-23).

**Outcome:** Foreground output remains readable even when the child never closes.

**Scope**

- Create a per-execution log before spawn and stream stdout/stderr from process start.
- Retain stream origin internally.
- Record execution ID, PID, command, cwd, start time, timeout, and log path on every outcome.

**Non-goals**

- No retention policy, binary-as-text behavior, or removal of live progress.

**Affected seams**

- `packages/ggcoder/src/tools/bash.ts`
- `packages/ggcoder/src/core/process-manager.ts`
- `packages/ggcoder/src/tools/bash-timeout.test.ts`

**References:** [REL-08](#reference-register)

**Acceptance tests**

- Log exists before completion and partial output is readable while running.
- Success, failure, abort, and timeout include a readable log path.
- Stdout/stderr origin survives combination; the log stream closes on every path.
- Focused tests and typecheck pass.

**Completion evidence**

- `ProcessManager` tests prove unique foreground IDs/paths, pre-created files, safe stream-error handling, idempotent closure, and unchanged background stream ownership.
- Foreground lifecycle tests prove the log exists before spawn, partial stdout/stderr is readable with source labels while the child is alive, and completed, non-zero, emitted/synchronous spawn-error, aborted, timeout-with-close, and timeout-without-close paths close the log exactly once.
- Every fresh foreground rendering path includes execution ID, PID or `unavailable`, command, cwd, start time, timeout, reason, elapsed time, and readable log path while preserving existing status and live UTF-8 output behavior.
- Verification command: `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/process-manager.test.ts src/tools/bash-timeout.test.ts` — 65 passed and 2 platform tests skipped across 67 tests.
- `pnpm --filter @kenkaiiii/ggcoder check`, targeted ESLint, and targeted Prettier (including this roadmap) pass.

**Hard stop:** Satisfied — live partial-log visibility no longer depends on child `close`, and every terminal path has exactly-once closure coverage.

## Phase 09 — Bound output and report the final 100 lines

**Status:** Complete.

**Outcome:** Large/non-terminating output cannot exhaust memory, and timeout reports contain an exact final 100-line tail.

**Scope**

- Maintain a bounded in-memory tail while retaining the persisted log.
- Preserve partial final lines and safely mark/summarize binary output.
- Return reason, exit code/signal, elapsed time, PID, log path, and tail.

**Non-goals**

- No full-log load to compute the tail and no removal of existing compression behavior.

**Affected seams**

- `packages/ggcoder/src/tools/bash.ts`
- `packages/ggcoder/src/tools/truncate.ts`
- new bounded-tail utility under `packages/ggcoder/src/tools/`
- `packages/ggcoder/src/types.ts`
- `packages/ggcoder/src/tools/bash-timeout.test.ts`

**References:** [REL-09](#reference-register), [REL-10](#reference-register)

**Acceptance tests**

- Output beyond the cap keeps process-tree memory bounded.
- Timeout tail is exactly the final 100 text lines; a partial last line is preserved.
- Binary output cannot corrupt the result or text log.
- Existing truncation/compression tests and focused timeout tests pass.

**Completion evidence**

- The rolling-tail utility proves exact final-100-line retention, terminal-newline and partial-line semantics, UTF-8-safe oversized-line suffixes, direct retained-byte accounting at or below 10 MiB, and conservative text/binary classification.
- Foreground lifecycle coverage proves more than 10 MiB of text returns the latest output, timeout returns exactly 100 logical lines, partial final lines survive, binary streams produce byte-count summaries without raw NUL or replacement-character corruption, and the complete sanitized log remains source-labelled and backpressured.
- Structured and textual diagnostics now expose reason, exit code, signal, elapsed time, PID, log path, and a delimited final-tail section across success, non-zero exit, signal exit, abort, timeout with/without close, and spawn errors.
- Verification command: `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bounded-output-tail.test.ts src/tools/truncate.test.ts src/tools/truncate-utils.test.ts src/tools/compress-integration.test.ts src/tools/bash-timeout.test.ts` — 109 passed and 2 platform tests skipped across 111 tests.
- `pnpm --filter @kenkaiiii/ggcoder check`, targeted ESLint, and targeted Prettier (including this roadmap) pass.

**Hard stop:** Satisfied — exact rolling-tail, retained-byte-bound, binary-safe log, complete diagnostics, truncation/compression, and foreground lifecycle assertions are green.

## Phase 10 — Support late readers and explicit retention

**Status:** Complete — verified 2026-07-24.

**Implementation evidence**

- `readOutput()` keeps one shared byte cursor, returns a first late-reader tail snapshot, and pages replay/incremental reads through a 256 KiB allocation cap.
- Range metadata separates permanently skipped history from bytes still retrievable on the next call; raw offsets survive truncation and both UTF-8 range boundaries without paging-induced replacement characters.
- Completion publishes native nullable exit status, close signal, and completion time only after background log flush settlement; explicit `isRunning` snapshots keep liveness separate from terminal metadata.
- Completed records remain addressable for five minutes from `completedAt`; closed background and foreground logs become sweep-eligible after 48 hours while active/open paths remain protected.
- `task_output` is sequential, renders terminal/range metadata, and points capped or presentation-compressed output to the retained process log without writing duplicate overflow artifacts.

**Outcome:** A late `task_output` reader receives current output, and completed records/logs expire predictably.

**Scope**

- Return a current snapshot before incremental chunks.
- Preserve byte offsets and `from_start` behavior.
- Store final metadata, flush/close logs where possible, and define record/log expiry.

**Non-goals**

- No unlimited UI replay, permanent completed records, or transcript-storage changes.

**Affected seams**

- `packages/ggcoder/src/core/process-manager.ts`
- `packages/ggcoder/src/core/process-manager.test.ts`
- `packages/ggcoder/src/tools/task-output.ts`
- `packages/ggcoder/src/tools/task-output.test.ts`
- `packages/ggcoder/src/tools/task-stop.test.ts`

**References:** [REL-11](#reference-register)

**Acceptance tests**

- Late-reader coverage proves the current bounded tail arrives first and the next default read contains only newly appended bytes.
- `from_start=true` begins at byte zero, paginates through exact offsets, and leaves the shared cursor at the returned end offset.
- Allocation never exceeds 256 KiB; tests cover leading continuation alignment, trailing code-point retention across both paged and live appends, and safe truncation reset.
- Flush-gated tests prove normal and native nullable signal completion metadata, explicit snapshot liveness, five-minute scheduled/opportunistic record expiry, 48-hour log eligibility, one-minute sweep throttling, active/open protection, and best-effort cleanup failures.
- Verification command: `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/process-manager.test.ts src/tools/task-output.test.ts src/tools/task-send.test.ts src/tools/task-stop.test.ts src/core/process-manager-dev-server-repro.test.ts src/tools/bash-timeout.test.ts` — 116 passed, 1 expected failure, and 3 platform tests skipped across 120 tests.
- `pnpm --filter @kenkaiiii/ggcoder check`, targeted ESLint, and targeted Prettier (including this roadmap) pass.

**Hard stop:** Satisfied — five-minute completed-record retention, 48-hour closed-log retention, 256 KiB byte-range/UTF-8 correctness, retained-log recovery, flush settlement, and foreground hard-deadline evidence are green before Phase 11.

## Phase 11 — Enforce explicit foreground/background modes

**Status:** Complete — verified 2026-07-24.

**Implementation evidence**

- `createBashTool()` derives one explicit foreground/background mode from `run_in_background === true`; finite work remains foreground by default and `persist:true` remains foreground-only.
- The bash tool contract names finite build/test/lint/format/migration/one-shot work and long-lived dev/watch/REPL/scaffolder/input-waiting work without command-name classification.
- `bash-mode.test.ts` injects fake child processes through one lifecycle adapter, proving exact stdio, spawn/close settlement boundaries, managed metadata, writable background stdin, and later-turn output/completion reads without real framework processes.

**Outcome:** Finite commands return final status under a deadline; long-lived/interactive commands return managed background metadata immediately.

**Scope**

- Keep build, test, lint, format, migration, and one-shot scripts foreground.
- Keep dev servers, watchers, REPLs, and input-waiting commands explicit background work.
- Return execution ID, PID, log path, and control commands for background work.
- Ignore ordinary foreground stdin; pipe stdin only for explicit interactive/background control.

**Non-goals**

- No backgrounding by elapsed time or automatic backgrounding of every slow command.

**Affected seams**

- `packages/ggcoder/src/tools/bash.ts`
- `packages/ggcoder/src/tools/bash-mode.test.ts`
- `packages/ggcoder/src/core/process-manager.ts`
- `packages/ggcoder/src/tools/task-send.ts`

**References:** [REL-08](#reference-register), [REL-11](#reference-register)

**Acceptance tests**

- Six finite rows cover `vitest run`, build, lint, format, migration, and one-shot work; each stays pending until close, uses ignored stdin, returns final status, and records the 120,000 ms default or explicit override in structured diagnostics.
- Five explicit-background rows cover Vite, Next dev, watch, REPL, and input-waiting/scaffolder work; each resolves after `spawn` without `close` and returns an eight-character ID, PID, log path, and all three control commands.
- Every background row sends input through `task_send`, observes the exact stdin bytes, then reads output and terminal metadata through `task_output` after the initiating bash call has returned.
- Verification command: `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-mode.test.ts src/tools/task-send.test.ts src/core/process-manager.test.ts src/core/process-manager-dev-server-repro.test.ts src/tools/bash-timeout.test.ts` — 112 passed, 1 expected failure, and 3 platform tests skipped across 116 tests.
- `pnpm --filter @kenkaiiii/ggcoder check`, targeted ESLint, targeted Prettier, the exact roadmap coverage script, and `git diff --check` pass.

**Hard stop:** Satisfied — every finite and long-lived/interactive command class has an owning contract row, and lifecycle regressions remain green before Phase 12.

## Phase 12 — Add EOF-first interactive shutdown

**Status:** Complete — verified 2026-07-25.

**Implementation evidence**

- `ProcessManager.stop()` closes open writable background stdin first, waits a production 2,000 ms grace, delegates escalation to the existing lifecycle adapter, and applies a separate 5,000 ms flush-settlement bound.
- Managed completion resolves only after child close, background-log flush, terminal metadata publication, and wrapper reaping; successful stop output reuses the bounded shared output cursor.
- `task_send` preserves omitted text and controls text, newline, and EOF independently; `task_stop` is sequential and returns the final completion state plus unread output.
- The real Node HTTP-server fixture consumes stdin EOF, exits with code 0 on Windows, and no longer carries an expected-failure marker.

**Outcome:** EOF-capable protocols exit cleanly before tree termination escalates.

**Scope**

- End stdin first for tracked background processes with open writable piped stdin.
- Wait a bounded grace, then terminate the tree through the existing lifecycle adapter if still alive.
- Await close and flush-gated terminal settlement before reporting stopped.

**Non-goals**

- No EOF for ordinary foreground commands, children without writable stdin, or `shutdownAll()` cleanup; no command-name classification or platform cleanup retuning.

**Affected seams**

- `packages/ggcoder/src/core/process-manager.ts`
- `packages/ggcoder/src/core/process-manager.test.ts`
- `packages/ggcoder/src/core/process-manager-dev-server-repro.test.ts`
- `packages/ggcoder/src/tools/task-send.ts`
- `packages/ggcoder/src/tools/task-send.test.ts`
- `packages/ggcoder/src/tools/task-stop.ts`
- `packages/ggcoder/src/tools/task-stop.test.ts`

**References:** [REL-12](#reference-register)

**Acceptance tests**

- EOF-capable fixture exits with code 0 and no tree cleanup; EOF-ignoring fixture receives exactly one cleanup call after the 2,000 ms grace.
- `task_send` controls text, newline, and EOF independently, including EOF-only without a hidden newline.
- `task_stop` remains pending through close and log flush, returns bounded final state/output, and returns a retryable failure when terminal settlement never arrives.
- Verification command: `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/process-manager.test.ts src/tools/task-send.test.ts src/tools/task-stop.test.ts src/tools/task-output.test.ts src/core/process-manager-dev-server-repro.test.ts src/tools/bash-mode.test.ts src/tools/bash-timeout.test.ts` — 137 passed and 3 platform tests skipped across 140 tests, with no expected failures.
- `pnpm --filter @kenkaiiii/ggcoder check`, targeted ESLint, targeted Prettier, the exact roadmap coverage script, and `git diff --check` pass.

**Hard stop:** Satisfied — both graceful EOF and delayed escalation fixtures pass, and the real Windows dev-server path exits cleanly with code 0.

## Phase 13 — Verify desktop-sidecar timeout diagnostics

**Status:** Complete — verified 2026-07-25.

**Completion evidence**

- `createBashTool()` returns typed `bashDiagnostics` for fresh-shell, Windows fallback, and supported POSIX `persist:true` foreground runs; `app-sidecar.ts` forwards complete `tool_call_end` details without creating a second execution path.
- `PersistentShell.run()` preserves session state on normal completion while exposing per-invocation PID/outcome metadata, the shared bounded tail, and a distinct retained foreground log. Timeout and abort still reset the shell before the next call.
- The shared backend/frontend fixture covers every diagnostic field; `useAgentEvents.ts` retains persistent timeout details through `run_end`; `LiveToolPanel.tsx` renders the complete untruncated metadata and authoritative tail and copies the same payload. A compact-layout defect found by the smoke was fixed so the disclosure owns a full row and wraps safely.
- Sidecar session IDs, Rust's trusted `(window, pane, generation, session)` event envelope, and webview pane routing reject stale or mismatched traffic; the new successful-binding `INFO` record supplies an auditable native ownership correlation.
- Initial focused verification passed: ggcoder sidecar/error/bash tests `80 passed, 2 skipped`; gg-app event/pane tests `39 passed`; Rust `100 passed`; both package typechecks, ggcoder build, targeted ESLint/Prettier, and Rust formatting passed.
- Persistent parity regression verification passed: ggcoder sidecar/error/bash tests `95 passed, 2 skipped`; gg-app event/pane tests `40 passed`. Persistent completion, non-zero, timeout, abort, capped output, retained logs, spawn errors, state retention, reset behavior, and canonical 16-field details are covered.
- Windows desktop command: `node -e "for(let i=1;i<=150;i++) console.log('phase13-'+String(i).padStart(3,'0')); setInterval(()=>{},1000)"` with timeout `1500` ms.
- Owning route: `window_label=main`, `pane_id=primary`, generation `2`, session `8dc92c4f-63ef-4738-9f2a-d0922fd85a8c`. Idle peer: `window_label=project-1`, `pane_id=primary`, generation `3`, session `477d01b3-7738-40fc-ac97-00948f095bed`; its pinned tool panel remained empty before, during, and after the run.
- The owning disclosure and clipboard showed the exact command, PID `25292`, reason `timedOut`, timeout `1500ms`, elapsed `1652ms`, normalized log `<HOME>/.gg/foreground/34d788ae-d9f8-40c8-bf1d-eecf9eaa63d5.log`, capped `yes`, total `1800` bytes, retained `1200` bytes, dropped `600` bytes, and final lines `phase13-051` through `phase13-150`.
- The retained log contained all 150 lines (`phase13-001` through `phase13-150`), and the post-timeout process query reported survivor count `0`. Keyboard expansion/copy worked, clipboard text matched all visible fields, and the disclosure remained usable at compact width and 200% zoom.

**Outcome:** The desktop receives complete timeout diagnostics without raw, missing, or cross-window output.

**Scope**

- Build ggcoder and exercise timeout through app-sidecar on Windows.
- Map command, PID, reason, elapsed time, log path, and final 100 lines into the webview.
- Preserve per-window isolation and provider-error formatting.

**Non-goals**

- No agent-spine fork, direct webview-sidecar fetch, or transcript redesign.

**Affected seams**

- `packages/ggcoder/src/core/persistent-shell.ts`
- `packages/ggcoder/src/tools/bash.ts`
- `packages/ggcoder/src/tools/bash-timeout.test.ts`
- `packages/ggcoder/src/app-sidecar.ts`
- `packages/ggcoder/src/app-sidecar-session-router.test.ts`
- `gg-app/src/agent.ts`
- `gg-app/src/useAgentEvents.ts`
- related webview tests

**References:** [REL-08](#reference-register), [REL-11](#reference-register)

**Acceptance tests**

- Sidecar and webview event-shape tests include all required diagnostic fields for fresh and POSIX persistent foreground calls.
- Persistent completion and non-zero calls retain shell state; timeout and abort expose partial output, clean descendants, and reset that state.
- Multiple windows receive only their own process events.
- Provider errors still pass through the existing formatted error chokepoint.
- `pnpm --filter @kenkaiiii/ggcoder build`, gg-app tests/check/lint, and a Windows `pnpm tauri dev` smoke pass.

**Hard stop:** Satisfied — the Windows `tauri dev` smoke recorded the exact command, complete visible/copied diagnostics, owning and peer window/pane/generation/session identities, bounded elapsed time, normalized retained-log path, zero peer events, and survivor count `0`.

## Phase 14 — Complete the three-OS reliability gate

**Status:** Complete (`7c1d4a13`).

**Outcome:** Every carry-forward process-lifecycle scenario is deterministic on its owning platforms, and Track A is releasable.

**Scope**

- Cover fast foreground, CPU spin, silent sleep, nested launcher, stdin wait, dev/watch, stdin+EOF, large output, spawn error, timeout/close race, and session shutdown.
- Keep Windows descendant/ConPTY assertions on Windows and POSIX group assertions on Linux, with macOS smoke.
- Measure runtime and gross memory regression.
- Run all targeted suites, repository check/lint/format, required builds, and desktop smoke review.
- Confirm every Track A requirement has test or operational evidence.

**Non-goals**

- No privileged process inspection, end-to-end-only replacement for focused fixtures, publishing, tagging, version edits, or waived lifecycle failures.

**Affected seams**

- `.github/workflows/ci.yml`
- all tests introduced in Phases 01–13
- `packages/ggcoder/src/core/persistent-shell.test.ts`
- repository-wide verification

**References:** [REL-01](#reference-register) through [REL-12](#reference-register)

**Acceptance tests**

- Every listed scenario has an owning test and explicit platform skips elsewhere.
- Foreground timeout/tree cleanup passes on Windows and Linux CI; background stdin, offsets, EOF, and shutdown pass on all relevant platforms.
- Persistent-shell behavior, fast command latency, and workspace memory do not regress.
- `pnpm check && pnpm lint && pnpm format:check && pnpm build` passes.
- Three-OS CI links and desktop timeout smoke evidence are attached.

**Completion evidence**

- Frozen Track A verification commit: `7c1d4a13`.
- Green three-OS CI run: [`30161379020`](https://github.com/creativeprofit22/gg-framework/actions/runs/30161379020). Framework jobs: [Windows](https://github.com/creativeprofit22/gg-framework/actions/runs/30161379020/job/89687140560), [macOS](https://github.com/creativeprofit22/gg-framework/actions/runs/30161379020/job/89687140512), and [Linux](https://github.com/creativeprofit22/gg-framework/actions/runs/30161379020/job/89687140532). App jobs: [Windows](https://github.com/creativeprofit22/gg-framework/actions/runs/30161379020/job/89687140551), [macOS](https://github.com/creativeprofit22/gg-framework/actions/runs/30161379020/job/89687140569), and [Linux](https://github.com/creativeprofit22/gg-framework/actions/runs/30161379020/job/89687140562).
- Linux/WSL owning suites: PersistentShell `9/9`, ProcessManager `26/26`, bash-timeout `77/79` with the 2 Windows-only rows explicitly skipped; the cooperative POSIX timeout probe passed `20/20` supervised stress repeats. Windows owning matrix: `103/114` with 11 POSIX-only/PersistentShell rows explicitly skipped.
- The repository-wide `pnpm check && pnpm lint && pnpm format:check && pnpm build` chain passed. Twenty-five warm PersistentShell `true` commands measured `0.389 ms` p50, `0.757 ms` p95, and `0.795 ms` max on Windows.
- Current CI workspace artifacts passed three runs per OS with zero survivors. Peak tree RSS bytes were Windows `[392835072, 406347776, 403853312]`, Linux `[517533696, 518803456, 517189632]`, and macOS `[511508480, 510099456, 515325952]`.
- The Phase 13 two-window Windows `tauri dev` timeout smoke remains the desktop gate evidence: exact visible/copied diagnostics, owning and peer identities, bounded elapsed time, normalized retained-log path, zero peer events, and survivor count `0`.

**Hard stop:** Satisfied — Track A behavior is frozen at verification commit `7c1d4a13`; all six three-OS CI jobs, repository verification, focused lifecycle stress, workspace memory evidence, and desktop timeout smoke are green. Track B may begin at Phase 15.

---

# Track B — Build the Notes Roadmap

## Phase 15 — Move Notes authority behind the sidecar

**Status:** Complete — verified 2026-07-25.

**Outcome:** Every window reads and writes one durable project-scoped Notes document.

**Delivered**

- The sidecar stores one strict `StoredProjectNotesV1` envelope per canonical project and exposes pane-authenticated GET, create-if-absent migration, and compare-and-swap save routes through Rust IPC.
- `useProjectNotes.ts` subscribes before opening, migrates only safe browser states, keeps browser data untouched as fallback evidence, and serializes optimistic replayable operations with text-tail coalescing, conflict rebasing, monotonic events, and project epochs.
- Same-project sessions receive complete revisioned `notes_change` snapshots; project aliases converge on one SHA-256 file, while different projects remain isolated. The existing Notes document shape, modal, status badge, keyboard behavior, and neighboring Tasks control are unchanged.

**Scope**

- Define a versioned sidecar Notes repository and IPC/API contract.
- Migrate current webview Notes exactly once, atomically, with backup/recovery behavior.
- Make multiple windows observe one authoritative state.

**Non-goals**

- No Roadmap fields, UI redesign, agent updates, reminders, or second `roadmap.md`.

**Affected seams**

- `gg-app/src/useProjectNotes.ts`
- `gg-app/src/notes-storage.ts`
- `gg-app/src/agent.ts`
- `gg-app/src-tauri/src/lib.rs`
- `packages/ggcoder/src/app-sidecar.ts`
- new project-scoped Notes repository in ggcoder/sidecar

**References:** [NOTE-14](#reference-register), [NOTE-15](#reference-register)

**Acceptance tests**

- Existing v2 Notes migrate without losing Now, Next, Handoff, Reference, or Archive.
- Restart and webview-storage reset preserve migrated content.
- Two windows converge on one revision and reject/merge stale writes deterministically.
- Migration failure leaves the old document recoverable; sidecar, app, and type tests pass.

**Completion evidence**

- **Storage contract:** Primary `~/.gg/project-notes/<sha256(canonical-project-key)>.json`; backup `~/.gg/project-notes/<sha256(canonical-project-key)>.backup.json`; lock `<primary>.lock`. The envelope is store version 1 with the unhashed canonical key, non-negative integer revision, and unchanged document version 2.
- **Migration guard:** Valid v2, valid legacy fallback, and genuinely empty browser stores may create revision 1 exactly once under the file lock. Unreadable or malformed/unsupported v2-only stores are refused and preserved. Browser keys remain untouched and stop receiving writes after sidecar authority is acquired; transport/migration failure keeps run-local fallback edits recoverable.
- **Durability and recovery:** Writes use restrictive modes where supported, unique sibling temp files, atomic rename, and cleanup. Migration installs the imported backup before the primary. Saves refresh the backup from the valid old primary before publishing the next revision. A missing/corrupt primary is restored only from a fully validated matching backup; dual corruption is reported without zeroing either file.
- **Concurrency:** Disk compare-and-swap accepts one writer for an expected revision and returns the winner to stale writers. The client replays deterministic captured operations over that winner, drops newly invalid task operations, coalesces only unsent Reference/Current Focus/Handoff replacements, and ignores stale events or old-project callbacks.
- **Automated results:** 24 focused sidecar repository/route tests, 42 focused Notes/client/pane tests, 1,954 full ggcoder tests with 15 platform skips under a disposable test home, 352 full gg-app tests, and 102 locked Rust tests passed. Both TypeScript checks, gg-app lint, Prettier checks, production builds, sidecar bundling, sidecar dependency audit, and generated-output audit passed.
- **Desktop evidence:** Windows `tauri dev` launched against a disposable profile and bound the native pane to the shared daemon. The real daemon persisted CRLF, leading whitespace, UTF-8 emoji bytes (`f09f9880`), version 1/version 2 schema data, and a trailing newline at the hashed path; a native-shell restart reloaded revision 2. Two live same-project desktop daemon sessions produced one stale conflict, rebased unrelated Reference/Handoff edits, converged at revision 4, and received same-project revision 5 fan-out while a different-project session received no event. Corrupting the disposable primary restored revision 4 from its valid backup without webview storage.

**Hard stop:** Satisfied — the exact path, schema, guarded migration, recovery chain, CAS/rebase policy, automated gates, native-shell restart, same-project convergence, project isolation, and disposable-profile backup restore are recorded. Phase 16 may add schema fields; Phase 15 adds none.

## Phase 16 — Add phase, reference, and lifecycle schemas

**Status:** Next — not started.

**Outcome:** The authoritative document can store ordered phases, structured references, session links, reminders, overrides, and audit events.

**Scope**

- Add stable IDs and validators for phase and reference entities.
- Phase fields: title, goal, Done-when criteria, order, status, source prompt, reference IDs, session ID/path, reminder, attention reason, timestamps, overrides, and append-only lifecycle events.
- Reference fields: provider/tool, canonical URL, owner/repo, revision, path/range, issue/PR, query/anchor, relevance note, and captured time.
- Add schema migration and malformed-reference rejection.

**Non-goals**

- No UI, session launch, content fetching, or automatic status changes.

**Affected seams**

- `gg-app/src/notes-types.ts`
- sidecar Notes repository/types/validators
- `gg-app/src/notes-storage.test.ts`
- sidecar repository tests

**References:** [NOTE-06](#reference-register), [NOTE-07](#reference-register), [NOTE-08](#reference-register), [NOTE-14](#reference-register)

**Acceptance tests**

- Round-trip/migration tests preserve all existing Notes and new fields.
- IDs remain stable through reorder/edit/restart.
- Invalid URLs, missing repository identity, broken links, unknown status, and invalid transition records fail with actionable errors.
- Append-only events have source and timestamp; manual override markers survive reconciliation-shaped writes.

**Hard stop:** Publish the schema fixture and migration evidence. Do not build UI against an unstable document contract.

## Phase 17 — Build the compact Notes shell

**Status:** Not started.

**Outcome:** Notes uses a wide, nearly full-height tabbed workspace without changing existing content semantics.

**Scope**

- Add Overview, Roadmap, Reference, and Archive navigation.
- Keep tab bar fixed and scroll only active-tab content.
- Preserve Now/Next/Handoff in Overview, free-form Reference, and Done/Archive content.
- Show quiet counts for active phases/reminders and hide empty subsections when navigation stays stable.

**Non-goals**

- No phase editing, references CRUD, agent actions, Kanban, or product-wide restyle.

**Affected seams**

- `gg-app/src/NotesModal.tsx`
- `gg-app/src/ProjectNotes.tsx`
- existing Notes components and styles
- `gg-app/src/ProjectNotes.test.tsx`

**References:** [NOTE-03](#reference-register), [NOTE-01](#reference-register)

**Acceptance tests**

- Existing Notes sections render and edit exactly as before under their new tabs.
- Keyboard, focus trap, labels, reduced motion, and narrow-window overflow are accessible.
- Only active-tab content scrolls; tab state survives ordinary rerenders.
- Visual evidence covers empty, typical, long-content, and narrow-window states.

**Hard stop:** Approve desktop screenshots and accessibility checks. Do not add Roadmap controls until existing Notes regression tests pass.

## Phase 18 — Add ordered roadmap list and phase detail CRUD

**Status:** Not started.

**Outcome:** Users can create, inspect, edit, reorder, cancel, archive, and restore standalone roadmap phases.

**Scope**

- Use one-line rows with title, status, reference count, relevant reminder state, and one primary action.
- Show one selected phase in a detail pane with goal, Done when, metadata, and secondary controls.
- Keep existing Notes tasks unchanged as the lightweight Next list.

**Non-goals**

- No session launch, automatic status, reminder delivery, or inline reference bodies.

**Affected seams**

- new Roadmap list/detail components in `gg-app/src/`
- `gg-app/src/ProjectNotes.tsx`
- Notes repository wrappers and tests

**References:** [NOTE-01](#reference-register), [NOTE-03](#reference-register)

**Acceptance tests**

- CRUD, reorder, archive/restore, empty state, selection, and concurrent-window refresh tests pass.
- Rows stay one line at normal desktop width and expose Start/Resume/Review based on stored state.
- Settled detail stays collapsed until selected; status override is always available.
- Visual/accessibility tests cover 0, 1, and 50 phases.

**Hard stop:** Record list/detail interaction and density evidence. Do not connect agent sessions until CRUD and ordering survive restart.

## Phase 19 — Add the shared structured reference library

**Status:** Not started.

**Outcome:** References are stored once, grouped by source, linked to phases by ID, and inspected without eagerly loading bodies.

**Scope**

- Add structured-reference CRUD, validation, deduplication, open/inspect, and phase linking.
- Preserve repository ownership and canonical source identity across multi-repository phases.
- Show compact chips/rows and relevance notes; fetch current content only on demand.

**Non-goals**

- No full MCP transcript as the durable record, eager body injection, or automatic agent additions.

**Affected seams**

- Reference tab and new reference components
- phase detail components
- sidecar Notes repository/validators
- URL/file opening through existing Tauri seams

**References:** [NOTE-04](#reference-register), [NOTE-05](#reference-register), [NOTE-06](#reference-register), [NOTE-07](#reference-register), [NOTE-08](#reference-register)

**Acceptance tests**

- One reference links to multiple phases without duplication.
- GitHub owner/repo/revision/path/range/issue/PR/query metadata round-trips and malformed entries are rejected.
- Empty groups disappear; links open exact canonical sources; no body fetch occurs until inspect/start.
- Multi-repository grouping and unlink-without-delete behavior pass.

**Hard stop:** Show exact attached references before any phase can start. Do not add prompt saving until reference and phase destinations are unambiguous.

## Phase 20 — Add Ken prompt Send, Fresh send, and Save actions

**Status:** Not started.

**Outcome:** A Ken prompt can be sent now, sent in one guarded fresh session, or saved to Notes without losing the prompt.

**Scope**

- Keep Send primary; place New session + send and Save to Notes in an adjacent compact action.
- Use one typed app-level action boundary.
- Lock fresh-session creation, wait for authoritative activation/reset, then send once.
- Save into a named draft/phase with inline success; manual mode previews, explicit Autopilot policy may auto-accept.

**Non-goals**

- No direct session-state management in Markdown, implicit auto-save, or navigation away from Ken's response.

**Affected seams**

- `gg-app/src/Markdown.tsx`
- app-level prompt action/provider seam
- `gg-app/src/agent.ts`
- session and Notes repository wrappers
- focused Markdown/session tests

**References:** [NOTE-16](#reference-register), [NOTE-17](#reference-register), [NOTE-22](#reference-register)

**Acceptance tests**

- Send preserves current behavior.
- Double-click/overlap creates one fresh session and one send, only after the new session is authoritative.
- Creation failure retains the prompt and current session.
- Save confirms destination/title, remains in place, and obeys manual-preview versus explicit auto-accept policy.

**Hard stop:** Do not start phase-launch work until duplicate sends and stale-session sends are impossible in tests.

## Phase 21 — Launch one bound session with isolated phase context

**Status:** Not started.

**Outcome:** Start phase atomically creates one fresh bound Plan Mode session, sends only its compact phase package, and resumes that same session.

**Scope**

- Add a per-phase launch lock and transactional session binding.
- Activate the fresh session and persist the link before sending the phase package in Plan Mode.
- Include phase ID/title, goal, Done when, status, linked session, reference identities, and relevance notes.
- Delimit roadmap/reference text as untrusted and require fresh inspection of referenced repositories/files.
- Preserve the compact active-phase summary and retrieval metadata across compaction and resume.
- Show attachments before start; require manual or explicit policy acceptance for agent-discovered references.
- Replace Start with Resume immediately after binding.
- Keep existing manual and Autopilot approval flows; implementation continues in the bound session.

**Non-goals**

- No throwaway planning session, duplicate launch, new approval UI, full roadmap/Reference tab, historical MCP output, unrelated Notes tasks, archived phases, or reference bodies by default.

**Affected seams**

- Roadmap phase actions
- `gg-app/src/agent.ts`
- `PaneAgentClient.newSession()` flow
- `packages/ggcoder/src/app-sidecar-session-router.ts`
- ggcoder session/system-context composition and compaction metadata
- sidecar phase-context endpoint/event
- Plan Mode/session/context tests

**References:** [NOTE-05](#reference-register), [NOTE-06](#reference-register), [NOTE-09](#reference-register), [NOTE-10](#reference-register), [NOTE-12](#reference-register), [NOTE-13](#reference-register), [NOTE-14](#reference-register), [NOTE-16](#reference-register)

**Acceptance tests**

- Under double-click and cross-window races, Start creates one session, binds the phase before the first prompt, and sends one package.
- Manual approval waits; Autopilot uses the existing review/approve/start path; both implement and Resume in the bound session.
- A failed create, bind, or send leaves one recoverable phase with its prompt and a clear attention reason.
- A golden context snapshot contains only the active phase and linked reference metadata, explicitly delimited as untrusted working data.
- Reference IDs and retrieval metadata survive compaction; restart/Resume reconstructs the same package without unrelated or full MCP content.
- A token-counted snapshot and captured session/phase IDs prove context isolation through start, approval, implementation, restart, and resume.

**Hard stop:** Do not add automatic status until launch atomicity, context isolation, compaction, and resume pass as one end-to-end contract.

## Phase 22 — Derive lifecycle status from authoritative events

**Status:** Not started.

**Outcome:** Phase status follows explicit session/plan/tool events and carries a useful attention reason.

**Scope**

- Implement Not started, Planning, Waiting for approval, In progress, Review, Done, Needs attention, and Cancelled.
- Map start, approval, implementation, verification, question, provider/tool error, cancellation, and resume events.
- Record source/timestamp append-only; never infer attention from age or generic `run_end`.

**Non-goals**

- No agent-writable status tool, automatic Done gate, reminders, or polling rendered UI text.

**Affected seams**

- `packages/ggcoder/src/app-sidecar.ts`
- agent/session event bus
- sidecar Notes repository/reconciler
- Roadmap status UI and tests

**References:** [NOTE-11](#reference-register), [NOTE-13](#reference-register), [NOTE-18](#reference-register)

**Acceptance tests**

- Every transition has an authoritative event fixture and append-only audit record.
- Waiting for approval is distinct from In progress.
- Real question/approval/error/cannot-continue events set Needs attention with a short current reason.
- Generic run end and elapsed time cannot set Done or Needs attention.

**Hard stop:** Approve the event-to-status contract. Do not grant agent write access until transition provenance is deterministic.

## Phase 23 — Add the roadmap-status tool and protected reconciliation

**Status:** Not started.

**Outcome:** GG Coder/Ken can record progress, blockers, evidence, and discovered references without overwriting user changes.

**Scope**

- Add a structured status tool with validated phase ID, transition/progress, blocker, evidence, and proposed reference additions.
- Apply updates immediately, serialize reconciliation, and reject duplicate/concurrent launches or updates.
- Preserve manual status/reference overrides until the user resets them.

**Non-goals**

- No free-form document rewrite, silent override reset, or Done from one tool call.

**Affected seams**

- new ggcoder roadmap tool
- AgentSession tool registration
- sidecar Notes repository/reconciler
- Roadmap audit/detail UI

**References:** [NOTE-11](#reference-register), [NOTE-14](#reference-register), [NOTE-15](#reference-register), [NOTE-17](#reference-register)

**Acceptance tests**

- Pending/in-progress/blocked/review evidence updates are schema-validated and immediately visible.
- Unknown phase, malformed reference, stale revision, and concurrent reconciliation fail safely.
- Manual status/reference changes survive automatic updates until reset.
- Proposed reference additions preview in manual mode and auto-accept only under explicit policy.

**Hard stop:** Demonstrate conflict and override recovery. Do not enable automatic Done until user control is proven.

## Phase 24 — Gate automatic completion through verification and review

**Status:** Not started.

**Outcome:** A phase becomes Done automatically only after implementation, verification, and final Ken/Autopilot review all succeed.

**Scope**

- Derive implementation completion from plan-step state.
- Require targeted verification or an explicit accepted exception.
- Require no unresolved approval/question/error and an accepted final review.
- Route incomplete/failed review to Review or Needs attention with evidence; keep manual completion possible.

**Non-goals**

- No Done from generic run end, elapsed time, all tool calls ending, or agent assertion alone.

**Affected seams**

- plan lifecycle/events
- Ken/Autopilot review flow
- roadmap reconciler/tool
- phase detail evidence UI

**References:** [NOTE-11](#reference-register), [NOTE-12](#reference-register), [NOTE-13](#reference-register)

**Acceptance tests**

- Missing step, failed verification, unresolved approval/question/error, or rejected review prevents Done.
- Accepted exception is explicit, attributed, timestamped, and visible.
- Successful full path reaches Done once and archives only by separate user/policy action.
- Manual override remains available and is not reverted by reconciliation.

**Hard stop:** Record one positive and every negative gate fixture. Do not add reminder delivery until completion state is trustworthy.

## Phase 25 — Add deduplicated reminders and notifications

**Status:** Not started.

**Outcome:** A phase can remind once per occurrence through the correct focused/background channel and recover overdue reminders after restart.

**Scope**

- Support Later today, Tomorrow, and chosen date/time.
- Persist occurrence keys; offer Resume, Snooze, and Dismiss reminder.
- Focused app: in-app reminder and Notes badge. Background app: native notification and one sound.
- On startup, deliver overdue occurrences once after project state is ready.
- Request notification permission lazily on the first path that needs it; respect sound/reduced-interruption settings.

**Non-goals**

- No Done on dismiss, repeated render/restart sounds, startup permission prompt, or closed-app scheduling unless separately designed.

**Affected seams**

- phase/reminder repository fields
- Notes badge and Roadmap rows/detail
- Tauri notification/focus APIs
- app startup hydration and sound settings

**References:** [NOTE-02](#reference-register), [NOTE-19](#reference-register), [NOTE-20](#reference-register), [NOTE-21](#reference-register)

**Acceptance tests**

- Each occurrence delivers once across rerender, window refresh, and restart.
- Focused/background routing, permission denied, concurrent windows, snooze, dismiss, and overdue startup paths pass.
- Dismiss leaves phase status unchanged; Resume opens the bound session.
- One sound plays only for a newly delivered occurrence and obeys settings.

**Hard stop:** Record focused, background, denied-permission, restart, and multi-window evidence. Resolve closed-app scheduling as startup-only or a separately approved design before release.

## Phase 26 — Run the Notes Roadmap release gate

**Status:** Not started.

**Outcome:** The complete Notes Roadmap is accessible, durable, context-efficient, race-safe, and releasable.

**Scope**

- Run all Track B focused tests, migration/recovery tests, multi-window tests, full checks/builds, and desktop smoke.
- Verify old Notes content, phase lifecycle, context package, manual overrides, and reminders end to end.
- Confirm no product code stores project roadmap data in this `roadmap.md`.

**Non-goals**

- No publishing, tagging, version bump, or scope expansion.

**Affected seams**

- All Track B seams; repository-wide verification.

**References:** [NOTE-01](#reference-register) through [NOTE-22](#reference-register)

**Acceptance tests**

- The repository-wide check, lint, format, and build commands remain green after all Track B changes.
- Three-OS CI and Windows/macOS desktop smoke pass.
- Existing Notes data survives migration and every existing Notes behavior remains available.
- One end-to-end fixture covers save Ken prompt → attach references → start → approve → implement → verify → review → Done → restart/resume/history.
- Negative fixtures cover duplicate launch, failed creation, stale write, manual override, rejected review, notification denial, and reminder deduplication.
- Token snapshot proves only active-phase metadata enters the linked session.

**Hard stop:** Produce a signed-off requirement matrix and smoke-test evidence. Release remains a separate explicit task.

---

# Old-to-new requirement coverage

The IDs below make coverage mechanically checkable. “Old” refers to the roadmap replaced by this revision.

| Old ID  | Still-valid old requirement                                                                                                                               | New phase(s) | Verification owner                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------- |
| OLD-0A  | Bounded React-loop regression; callback churn and equivalent snapshot identity; external 120-second supervisor with PID/tail/survivor evidence            | 00           | `WorkspaceShell.test.tsx` + supervisor        |
| OLD-0B  | CPU-spin, silent-sleep, nested-launcher fixtures; observable root/descendant PIDs; outer CI bound                                                         | 01           | `bash-timeout.test.ts`                        |
| OLD-1A  | Stable lifecycle callback using current pane/handler without removing correct effect dependencies                                                         | 00           | `WorkspaceShell.test.tsx`                     |
| OLD-1B  | Equivalent snapshots preserve state identity; meaningful title/active-work/target changes persist                                                         | 00           | `WorkspaceShell.test.tsx`                     |
| OLD-1C  | Split/restore/copy/move/drag/close/focus/resize/native behavior unchanged; no remount/disposal; stable runtime/memory                                     | 00           | `WorkspaceShell.test.tsx` + three-OS CI       |
| OLD-2A  | Typed completion reasons, separate code/signal/timing/PID, idempotent settlement, race coverage                                                           | 02           | `bash-timeout.test.ts`                        |
| OLD-2B  | Host-owned 120-second deadline and overrides; timeout independent of child event loop/close; bounded grace                                                | 03           | `bash-timeout.test.ts`                        |
| OLD-2C  | Remove timers/listeners on every path; cleanup failures logged; no unhandled event error                                                                  | 04           | listener/race tests                           |
| OLD-3A  | Trusted absolute Windows `taskkill`, argv tree kill, ConPTY ordering, liveness checks, observable failures, no image-name kill                            | 05           | Windows process-manager tests + smoke         |
| OLD-3B  | POSIX dedicated group, TERM then KILL, direct/descendant fallback, harmless missing process                                                               | 06           | Linux group tests + macOS smoke               |
| OLD-3C  | Tree kill only for cancellation/timeout/shutdown; detached work survives normal completion; late-abort/PID-reuse safety                                   | 07           | process-manager/timeout tests                 |
| OLD-4A  | Create foreground log before spawn; stream both outputs with origin; metadata/log path on every outcome                                                   | 08           | foreground log tests                          |
| OLD-4B  | Bounded memory; persisted full output; exact final 100 lines; partial/binary safety; completion metadata                                                  | 09           | timeout + truncation tests                    |
| OLD-4C  | Late-reader snapshot, incremental offsets, `from_start`, final metadata, flush, bounded log/record retention                                              | 10           | `task-output.test.ts` + process-manager tests |
| OLD-5A  | Finite foreground deadlines; explicit managed background for dev/watch/REPL/input; metadata/control commands; stdin contract                              | 11           | command-mode matrix                           |
| OLD-5B  | EOF-first graceful interactive stop, bounded escalation, final state/output                                                                               | 12           | task-send/process-manager tests               |
| OLD-6A  | Windows/macOS/Linux scenario matrix, platform-owned assertions, runtime/memory checks, persistent-shell regression                                        | 14           | CI matrix                                     |
| OLD-6B  | Sidecar/webview timeout diagnostics, per-window isolation, formatted provider errors, no app agent fork                                                   | 13           | sidecar/app tests + Windows smoke             |
| OLD-6C  | Targeted and full check/lint/format/build gate; no publish/tag/version hand edit                                                                          | 14           | repository release gate                       |
| OLD-G1  | Vitest timeout alone is insufficient; removed `poolOptions` is not reintroduced                                                                           | 01, 03, 14   | fixture and config review                     |
| OLD-G2  | Never kill only a wrapper or kill by process/image name                                                                                                   | 05–07, 14    | process-tree assertions                       |
| OLD-G3  | Never save diagnostics only after close or accumulate output without bounds                                                                               | 08–10        | log/tail/retention tests                      |
| OLD-G4  | Never background every slow finite command                                                                                                                | 11           | command-mode matrix                           |
| OLD-G5  | Never use unstable inline effect callbacks for pane lifecycle                                                                                             | 00           | identity regression                           |
| OLD-G6  | Never duplicate agent execution in `gg-app`; desktop uses sidecar                                                                                         | 13           | architecture and isolation tests              |
| OLD-DOD | Repeated snapshots cannot loop; CPU-bound children time out, are cleaned up, and report PID, command, elapsed time, reason, log path, and final 100 lines | 00–14        | Track A gate                                  |

# Research requirement coverage

| Research requirement                                         | New phase(s)  |
| ------------------------------------------------------------ | ------------- |
| Roadmap is additive; existing Notes remain intact            | 15–18, 26     |
| Compact tabs and list/detail; reduce scrolling; avoid Kanban | 17–18         |
| Structured shared references linked by stable ID             | 16, 19        |
| Small active-phase context and fresh retrieval               | 21            |
| Save Ken prompts; current or guarded fresh send              | 20            |
| One bound phase session; plan then implement; resume         | 21            |
| Explicit lifecycle and attention states                      | 22            |
| Structured agent updates and protected manual overrides      | 23            |
| Verification plus Ken/Autopilot review gates Done            | 24            |
| Deduplicated focused/background/restart reminders and sound  | 25            |
| One authoritative project-scoped versioned store             | 15–16         |
| Multi-window consistency and duplicate-start prevention      | 15, 20–21, 25 |

# Link and coverage check

Run after any roadmap edit:

```bash
node - <<'NODE'
const fs = require('node:fs');
const text = fs.readFileSync('roadmap.md', 'utf8');
const refs = [...text.matchAll(/^- \*\*((?:REL|NOTE)-\d+) —/gm)].map(m => m[1]);
const duplicates = refs.filter((id, i) => refs.indexOf(id) !== i);
const linked = new Set([...text.matchAll(/\[((?:REL|NOTE)-\d+)\]/g)].map(m => m[1]));
const missingRef = [...linked].filter(id => !refs.includes(id));
const unusedRef = refs.filter(id => !linked.has(id));
const oldIds = [...text.matchAll(/^\|\s+(OLD-[^ |]+)\s+\|/gm)].map(m => m[1]);
const requiredOld = ['OLD-0A','OLD-0B','OLD-1A','OLD-1B','OLD-1C','OLD-2A','OLD-2B','OLD-2C','OLD-3A','OLD-3B','OLD-3C','OLD-4A','OLD-4B','OLD-4C','OLD-5A','OLD-5B','OLD-6A','OLD-6B','OLD-6C','OLD-G1','OLD-G2','OLD-G3','OLD-G4','OLD-G5','OLD-G6','OLD-DOD'];
const missingOld = requiredOld.filter(id => !oldIds.includes(id));
const phases = [...text.matchAll(/^## Phase (\d+) —/gm)].map(m => Number(m[1]));
const ordered = phases.every((n, i) => n === i);
const phaseBlocks = text.split(/^## Phase \d+ —/m).slice(1);
const fields = ['**Scope**','**Non-goals**','**Affected seams**','**References:**','**Acceptance tests**','**Hard stop:**'];
const incompletePhases = phaseBlocks.flatMap((block, i) => fields.filter(f => !block.includes(f)).map(f => `Phase ${String(i).padStart(2,'0')} missing ${f}`));
const urls = [...text.matchAll(/https:\/\/github\.com\/[^)\s]+/g)].map(m => m[0]);
const unpinned = urls.filter(url => /github\.com\/[^/]+\/[^/]+\/(blob|tree)\/(main|master)\//.test(url));
const failures = { duplicates, missingRef, unusedRef, missingOld, ordered: ordered ? [] : phases, incompletePhases, unpinned };
if (Object.values(failures).some(value => value.length)) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log(`coverage ok: ${phases.length} phases, ${refs.length} references, ${oldIds.length} old requirement groups, ${urls.length} exact source links`);
NODE
```

For network validation, extract the URLs from the reference register and issue redirect-following HTTP requests. A transient GitHub rate limit may be recorded as external evidence, but malformed, repository-home-only, branch-floating, or missing source links must be fixed before a phase uses them.

## Definition of done

Track A is done when pane snapshots are convergent and every foreground/background process lifecycle is externally bounded, tree-safe, leak-free, diagnosable, retained by policy, cross-platform, and correctly surfaced through the desktop sidecar.

Track B is done when existing Notes remain intact and a user can save a Ken prompt, attach structured references, start one fresh bound Plan Mode session, implement after approval, resume it, observe authoritative progress and attention state, preserve manual overrides, complete only through verification/review, and receive one reminder per occurrence without bloating agent context.
