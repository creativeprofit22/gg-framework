# Hang Prevention and Process Lifecycle Roadmap

## Current status

- **Completed:** The pane-loop implementation work for Phase 0A and Phase 1A–1C landed in commit `50a50535`; no sub-phase is marked complete because required supervisor/memory evidence and the listed lint verification were not all captured.
- **NEXT:** Sub-phase 0A — close the remaining acceptance gap by running a temporary external 120-second supervisor that reports the root PID and final output tail, and record elapsed/memory evidence where the harness exposes it.
- **Blockers:** `packages/ggcoder/src/tools/bash-timeout.test.ts`, `packages/ggcoder/src/core/process-manager.test.ts`, and `packages/ggcoder/src/tools/task-output.test.ts` do not exist. The current background baseline also fails on Windows because `process-manager-dev-server-repro.test.ts` passes an unquoted `process.execPath` through Git Bash (`E:nodejsnode.exe: command not found`).
- **First verification command:** `pnpm --filter gg-app exec vitest run src/WorkspaceShell.test.tsx` under a temporary external 120-second supervisor; after 0A is closed, start 0B with `pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts`.
- **Audit basis:** clean `custom/local-customizations` worktree at `50a50535`; source, tests, `.github/workflows/ci.yml`, package scripts, `git log`, and `git blame` inspected on 2026-07-16. Claims not exercised on macOS/Linux or in a desktop smoke are marked **Unverified**.

## Goal

Prevent CPU-bound test hangs from trapping GG Coder in a foreground tool call, preserve useful diagnostics, and make timeout/background behavior reliable across Windows, macOS, and Linux.

This roadmap is planning only. Every code block is a short **reference-only sample**, not implementation-ready code.

## Incident model

The observed hang is a React render/effect feedback loop:

1. `WorkspaceNode.tsx` creates a fresh `onLifecycleError` function during every render.
2. `WorkspaceShell.test.tsx` includes that function in `FakePane`'s effect dependencies.
3. The effect calls `onSnapshot`.
4. `WorkspaceShell.tsx` writes a new snapshots object.
5. React renders again and creates another callback identity.

The Vitest worker then consumes a full CPU core and grows to multiple gigabytes. Vitest's per-test timeout cannot reliably interrupt this failure because its timer runs inside the starved worker event loop.

**Current correction:** The five-step loop above describes the pre-fix incident, not current behavior. `WorkspaceAgentLeaf` in `gg-app/src/WorkspaceNode.tsx` now stabilizes the lifecycle callback, and `mergePaneSnapshot` in `gg-app/src/WorkspaceShell.tsx` now makes equivalent snapshot writes idempotent.

**Architecture/path correction:** Ordinary foreground execution currently lives in `packages/ggcoder/src/tools/bash.ts`; managed background execution and log offsets live in `packages/ggcoder/src/core/process-manager.ts`; process-group killing lives in `packages/ggcoder/src/utils/process.ts`; persistent foreground shells live in `packages/ggcoder/src/core/persistent-shell.ts`. The planned `bash-timeout.test.ts`, `process-manager.test.ts`, and `task-output.test.ts` paths are retained below as required target files, but they do not exist yet. Until they are added, use `process-manager-dev-server-repro.test.ts`, `persistent-shell.test.ts`, `task-send.test.ts`, `truncate.test.ts`, and `truncate-utils.test.ts` only as partial baseline coverage.

## Plan-unit contract

Each sub-phase below is independently reviewable and ends at a clean commit boundary. A sub-phase may begin only after the previous sub-phase's acceptance criteria and verification commands pass.

Every sub-phase contains:

- one behavioral outcome;
- explicit non-goals;
- required tests;
- verification commands;
- acceptance criteria;
- one commit boundary.

---

# Phase 0 — Pin the incident safely

## Sub-phase 0A — Add a bounded React-loop regression **(NEXT)**

**Status: Partial**

**Evidence:** `gg-app/src/WorkspaceShell.test.tsx` defines `MAX_LIFECYCLE_EFFECT_EXECUTIONS` and the bounded `FakePane` lifecycle guard, and tests `preserves the record for an equivalent workspace snapshot` plus `keeps pane lifecycle callbacks and effects stable across unrelated rerenders`. `gg-app/src/WorkspaceShell.tsx` exports `mergePaneSnapshot`. Commit: `50a50535` (`Update desktop branding, discovery, and workspace reliability`). Verification on 2026-07-16: 41/41 focused tests passed in 4.04s and `pnpm --filter gg-app check` passed. Memory metrics and the required external-supervisor timeout report containing root PID/final output tail are **Unverified**.

### Behavioral outcome

The pane lifecycle feedback loop is reproduced by a deterministic test that fails quickly instead of consuming a worker indefinitely.

### Scope

- Add a focused `WorkspaceShell` regression that counts pane lifecycle-effect executions.
- Fail after a small bounded number of executions.
- Assert callback identity across an unrelated parent rerender.
- Assert that repeating an unchanged pane snapshot preserves the previous state object.
- Capture baseline elapsed time and memory where the test harness exposes them.

### Non-goals

- Do not fix callback identity yet.
- Do not change process supervision yet.
- Do not increase Vitest timeouts to hide the failure.
- Do not change unrelated workspace interactions.

### Reference

**Repository:** [vitest-dev/vitest](https://github.com/vitest-dev/vitest)

**File:** [`packages/vitest/src/runtime/runner/context.ts`](https://github.com/vitest-dev/vitest/blob/3e3e85285fb1256ff49dd5f4ef1ca4ebffe60a17/packages/vitest/src/runtime/runner/context.ts#L32-L72)

**Reference-only sample — do not copy verbatim:**

```ts
const timer = setTimeout(rejectTimeoutError, timeout);
timer.unref?.();
```

Vitest's timer lives in the test runtime; a blocked runtime may never service it.

### Required tests

- New callback-identity regression in `gg-app/src/WorkspaceShell.test.tsx`.
- New bounded effect-execution regression in the same file.
- New unchanged-snapshot identity assertion.

### Verification commands

```bash
pnpm --filter gg-app exec vitest run src/WorkspaceShell.test.tsx
pnpm --filter gg-app check
```

Run the first command through a temporary external 120-second supervisor while this regression is being established.

### Acceptance criteria

- The regression fails quickly against the problematic callback/state cycle.
- The regression identifies callback churn rather than relying on a generic test timeout.
- The test process cannot occupy a worker beyond 120 seconds during development.
- The timeout report names the root PID and preserves the final output tail.

### Commit boundary

```text
test(gg-app): reproduce workspace pane lifecycle loop
```

---

## Sub-phase 0B — Add a CPU-bound foreground timeout fixture

**Status: Not started**

**Audit note:** The planned `packages/ggcoder/src/tools/bash-timeout.test.ts` and dedicated CPU-spin/sleep/nested fixtures do not exist. The nearest existing coverage is background-only `packages/ggcoder/src/core/process-manager-dev-server-repro.test.ts`, not a foreground host-deadline baseline.

### Behavioral outcome

A deterministic fixture can prove whether GG Coder's host-level timeout survives a child whose event loop never yields.

### Scope

- Add a fixture that spins forever without filesystem, network, or stdin activity.
- Add a silent sleeping fixture to distinguish CPU starvation from an idle wait.
- Add a nested launcher fixture shaped like `shell → package-manager shim → node → worker`.
- Define expected result fields for timeout, elapsed time, PID, and final output tail.

### Non-goals

- Do not change timeout implementation yet.
- Do not add platform-specific termination yet.
- Do not use a real project test suite as the fixture.

### Required tests

- CPU-bound child fixture test.
- Silent child fixture test.
- Nested descendant fixture test.
- Baseline assertion showing the existing behavior or gap.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- Fixtures start predictably on supported CI platforms.
- The CPU-bound fixture is externally observable by PID.
- The nested fixture exposes all descendant PIDs to the test harness.
- No fixture is allowed to run without an outer CI/job timeout.

### Commit boundary

```text
test(ggcoder): add foreground hang fixtures
```

---

# Phase 1 — Make pane updates convergent

## Sub-phase 1A — Stabilize pane lifecycle callback identity

**Status: Partial**

**Evidence:** `gg-app/src/WorkspaceNode.tsx` `WorkspaceAgentLeaf` stores `{ paneId, onLifecycleError }` in a ref and exposes stable `dispatchLifecycleError` via `useCallback([])`. `gg-app/src/AgentPane.tsx` documents the stable `AgentPaneProps.onLifecycleError` contract. Tests: `keeps pane lifecycle callbacks and effects stable across unrelated rerenders`, `routes lifecycle errors through the pane that reported them`, and `warns once for a stale pane restore target` in `WorkspaceShell.test.tsx`. Commit `50a50535`; focused suite and gg-app typecheck passed on 2026-07-16. The acceptance claim of stable memory is **Unverified** because no memory baseline was captured.

### Behavioral outcome

An unrelated parent rerender does not retrigger a pane's lifecycle effect.

### Scope

- Stabilize the pane-scoped `onLifecycleError` callback.
- Document callback identity expectations in `AgentPaneProps`.
- Keep the latest parent behavior available without remounting long-lived subscriptions.
- Keep consumer effects free to include callback props in dependency arrays.

### Non-goals

- Do not suppress snapshot writes in this sub-phase.
- Do not remove correct effect dependencies.
- Do not introduce a general hook library solely for one callback.
- Do not refactor unrelated workspace props.

### References

**Repository:** [alibaba/hooks](https://github.com/alibaba/hooks)

**File:** [`packages/hooks/src/useDrop/index.ts`](https://github.com/alibaba/hooks/blob/a323dcc86a90522aeb27689b49916e81cceefae7/packages/hooks/src/useDrop/index.ts#L15-L25)

**Reference-only sample — do not copy verbatim:**

```ts
const optionsRef = useLatest(options);
```

**Repository:** [Tencent/tdesign-react](https://github.com/Tencent/tdesign-react)

**File:** [`packages/components/hooks/useMouseEvent.ts`](https://github.com/Tencent/tdesign-react/blob/920b57c0232dd5d491fda08ab0c07242aa2bf4d8/packages/components/hooks/useMouseEvent.ts#L30-L40)

**Reference-only sample — do not copy verbatim:**

```ts
const optionsRef = useLatest(options);
```

**Repository:** [do-md/domd](https://github.com/do-md/domd)

**File:** [`features/editor/hooks/use-tauri-event.ts`](https://github.com/do-md/domd/blob/6cda2776d80fb12e80f1efe4544f44df99b5eb79/features/editor/hooks/use-tauri-event.ts#L7-L23)

**Reference-only sample — do not copy verbatim:**

```ts
const handlerRef = useLatest(handler);
return listen(event, (e) => handlerRef.current(e.payload));
```

### Required tests

- Parent rerender preserves `onLifecycleError` identity.
- Pane lifecycle effect does not rerun solely because the parent rendered.
- A changed `paneId` routes errors to the correct pane.
- The stale-restore warning remains emitted once.

### Verification commands

```bash
pnpm --filter gg-app exec vitest run src/WorkspaceShell.test.tsx
pnpm --filter gg-app check
pnpm --filter gg-app lint
```

### Acceptance criteria

- Rendering a pane does not retrigger its lifecycle effect solely because the parent rendered.
- The callback still sees the current pane ID and current parent handler.
- Existing restore and warning behavior remains intact.
- The focused regression completes in seconds with stable memory.

### Commit boundary

```text
fix(gg-app): stabilize pane lifecycle callbacks
```

---

## Sub-phase 1B — Make snapshot state updates idempotent

**Status: Partial**

**Evidence:** `gg-app/src/WorkspaceShell.tsx` `sameWorkspaceSnapshot`, `mergePaneSnapshot`, `sameSnapshotTarget`, and `ReadyWorkspaceShell.updateSnapshot` preserve state identity for equivalent snapshots and update layout only for meaningful targets. Tests: `preserves the record for an equivalent workspace snapshot`, `normalizes chat defaults and ignores code-mode chat-agent noise`, `updates the native title from a changed focused-pane snapshot`, `gates closure after active work changes in a pane snapshot`, and `persists changed pane target fields and project binding`. Commit `50a50535`; the focused suite and typecheck passed on 2026-07-16. The listed `pnpm --filter gg-app lint` verification is **Unverified**, so this sub-phase is not marked complete.

### Behavioral outcome

Reporting an equivalent pane snapshot causes no React state transition.

### Scope

- Define semantic equality for the pane snapshot fields used by the workspace.
- Return the existing snapshots state object when the incoming snapshot is equivalent.
- Allocate a new state object only for a meaningful pane change.
- Preserve the existing layout-target synchronization behavior.

### Non-goals

- Do not deep-compare unrelated transient objects.
- Do not debounce legitimate snapshot updates.
- Do not change persistence format or workspace layout version.

### Reference

**Repository:** [elizaOS/eliza](https://github.com/elizaOS/eliza)

**File:** [`packages/agent/src/api/chat-routes.ts`](https://github.com/elizaOS/eliza/blob/4f7ed04c571e798b2a836e2f4f2a1a4c4803f170/packages/agent/src/api/chat-routes.ts#L2467-L2480)

**Reference-only sample — do not copy verbatim:**

```ts
if (text === responseText) return;
responseText = text;
opts?.onSnapshot?.(text);
```

### Required tests

- Identical snapshots preserve state identity.
- Changed session title updates state and the native title.
- Changed `activeWork` updates close-confirmation behavior.
- Changed target/session fields continue to update the persisted layout.

### Verification commands

```bash
pnpm --filter gg-app exec vitest run src/WorkspaceShell.test.tsx
pnpm --filter gg-app check
pnpm --filter gg-app lint
```

### Acceptance criteria

- Repeating an identical snapshot causes no React state transition.
- Meaningful snapshot changes still render and persist.
- Native title routing remains correct.
- Active-work close confirmation remains correct.

### Commit boundary

```text
fix(gg-app): deduplicate pane snapshots
```

---

## Sub-phase 1C — Revalidate every workspace interaction

**Status: Partial**

**Evidence:** `gg-app/src/WorkspaceShell.test.tsx` covers split/restore/copy, rollback/reuse, nested cross-parent moves without remount/disposal, pointer/keyboard resize, native drag/title routing, active-work close confirmation, and auxiliary close/focus restore. Representative tests include `renders the agent-only workspace and splits right or down`, `preserves every pane host across a nested cross-parent move`, and `routes native drag feedback, drops, and titles through the focused pane`. Commit `50a50535`; all 41 focused tests passed in 4.04s on 2026-07-16. macOS/Linux runtime and memory stability are **Unverified**.

### Behavioral outcome

The loop fix ships without changing visible workspace behavior.

### Scope

- Re-run split, restore, drag, close, focus, resize, native-drop, and title tests.
- Confirm pane hosts are not remounted during moves.
- Confirm no session is disposed during copy or move.
- Confirm focused regressions remain fast and memory-stable.

### Non-goals

- Do not add new workspace features.
- Do not restyle workspace controls.
- Do not change persisted layout schema.

### Required tests

- Split right and split down.
- Restore targets and canonical focus.
- Copy success, rollback, and reused destination.
- Nested cross-parent move without remount.
- Drag cancellation paths.
- Close with and without active work.
- Pointer and keyboard resize.
- Native drop and native title routing.

### Verification commands

```bash
pnpm --filter gg-app exec vitest run src/WorkspaceShell.test.tsx
pnpm --filter gg-app check
pnpm --filter gg-app lint
```

### Acceptance criteria

- Existing split, restore, drag, close, and native-drop tests remain green.
- Pane mount/unmount counts remain unchanged for moves.
- The targeted suite finishes without elevated CPU or memory growth.
- No new warnings are emitted by React or Vitest.

### Commit boundary

```text
test(gg-app): lock workspace lifecycle behavior
```

---

# Phase 2 — Make foreground deadlines host-owned

## Sub-phase 2A — Introduce a single execution outcome model

**Status: Partial**

**Evidence:** `packages/ggcoder/src/tools/bash.ts` currently distinguishes rendered `TIMEOUT`, `KILLED`, numeric exit, and spawn failure strings and uses timer/abort cleanup in separate `close` and `error` handlers. `packages/ggcoder/src/core/persistent-shell.ts` has an idempotent local `finish`. Missing: one typed foreground outcome, elapsed/start metadata, PID, signal, and race tests. Foreground and background remain split between `tools/bash.ts` and `core/process-manager.ts`; this sequencing remains valid, but the model must be introduced at that seam. Existing behavior traces to `d26b3e61`; persistent-shell finalization to `af1b1af6`.

### Behavioral outcome

Every foreground execution settles once with an explicit completion reason.

### Scope

- Represent `completed`, `nonZeroExit`, `timedOut`, `aborted`, and `spawnError` distinctly.
- Keep exit code and signal separate from completion reason.
- Record start time and elapsed time.
- Use one idempotent finalizer for the foreground execution.

### Non-goals

- Do not terminate descendants yet.
- Do not change output persistence yet.
- Do not merge foreground and background storage yet.

### Reference

**Repository:** [stablyai/orca](https://github.com/stablyai/orca)

**File:** [`src/main/git/runner.ts`](https://github.com/stablyai/orca/blob/e0edc8ef76d341f7ab8083a006f785322bcaeb23/src/main/git/runner.ts#L432-L506)

**Reference-only sample — do not copy verbatim:**

```ts
if (settled) return;
settled = true;
cleanupListeners();
resolve(result);
```

### Required tests

- Normal zero exit.
- Ordinary non-zero exit.
- Spawn failure.
- User abort.
- Timeout.
- Timeout/close and abort/close races settle exactly once.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- The tool promise cannot settle twice during timeout/close races.
- Abort and timeout produce distinct user-facing results.
- Spawn failure remains immediate.
- Exit code, signal, reason, and elapsed time are not conflated.

### Commit boundary

```text
refactor(ggcoder): model foreground execution outcomes
```

---

## Sub-phase 2B — Enforce the 120-second host deadline

**Status: Partial**

**Evidence:** `packages/ggcoder/src/tools/bash.ts` defines `DEFAULT_TIMEOUT = 120_000`, accepts a per-call `timeout`, starts a host-process `setTimeout`, and requests `killProcessTree`; `PersistentShell.run` also owns a host timer. Missing: CPU/sleep fixtures, PID/elapsed output, and bounded settlement independent of child `close`—the normal foreground promise currently resolves only from child `close`/`error`. `packages/ggcoder/src/tools/bash-timeout.test.ts` does not exist.

### Behavioral outcome

A foreground tool call returns `TIMEOUT` even when the child event loop never yields.

### Scope

- Keep the existing default foreground timeout at 120 seconds.
- Own the timeout in the GG Coder host process.
- Mark timeout before beginning best-effort cleanup.
- Await closure only for a bounded grace period.
- Allow explicit per-call timeout overrides within the existing tool contract.

### Non-goals

- Do not rely on Vitest's `testTimeout` as the outer deadline.
- Do not background finite checks automatically.
- Do not classify watch commands in this sub-phase.

### Reference

**Repository:** [stablyai/orca](https://github.com/stablyai/orca)

**File:** [`src/main/git/runner.ts`](https://github.com/stablyai/orca/blob/e0edc8ef76d341f7ab8083a006f785322bcaeb23/src/main/git/runner.ts#L432-L506)

**Reference-only sample — do not copy verbatim:**

```ts
timer = setTimeout(() => {
  killSpawnedCommandTree(child);
  finish(new Error(`${command} timed out.`));
}, timeout);
```

### Required tests

- CPU-bound fixture returns timeout.
- Silent sleeping fixture returns timeout.
- Explicit shorter timeout is honored.
- Default timeout remains 120 seconds.
- Timeout result includes elapsed time and PID.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- A fixture that spins forever returns `TIMEOUT` within the configured deadline plus a small cleanup allowance.
- A sleeping child follows the same deadline.
- The host remains responsive while the child is CPU-bound.
- The result is returned even when cleanup remains best-effort.

### Commit boundary

```text
fix(ggcoder): enforce host-owned foreground deadlines
```

---

## Sub-phase 2C — Make finalization leak-free

**Status: Partial**

**Evidence:** `packages/ggcoder/src/tools/bash.ts` clears its timer and removes the abort listener on `close`/`error`; `packages/ggcoder/src/core/persistent-shell.ts` `finish` removes stdout, stderr, exit, error, timer, and abort handlers, with `does not leak error listeners across many runs` in `persistent-shell.test.ts`. Missing for ordinary foreground execution: a shared idempotent finalizer, stream-listener removal, explicit error/close race coverage, and cleanup-child error handling. Persistent-shell tests were skipped on this Windows environment on 2026-07-16, so that path is **Unverified** here.

### Behavioral outcome

Every foreground completion path releases timers, abort listeners, child listeners, and stream listeners.

### Scope

- Centralize listener and timer removal.
- Handle child `error` and `close` races.
- Log cleanup failures without throwing from an event handler.
- Ensure asynchronous cleanup children also have `error` listeners.

### Non-goals

- Do not add log retention policy yet.
- Do not redesign process-manager storage.
- Do not swallow the original command failure.

### Reference

**Repository:** [stablyai/orca](https://github.com/stablyai/orca)

**File:** [`src/main/git/runner.ts`](https://github.com/stablyai/orca/blob/e0edc8ef76d341f7ab8083a006f785322bcaeb23/src/main/git/runner.ts#L481-L503)

**Reference-only sample — do not copy verbatim:**

```ts
signal?.removeEventListener("abort", onAbort);
child.stdout?.off("data", onStdoutData);
child.stderr?.off("data", onStderrData);
child.off("error", onError);
child.off("close", onClose);
```

### Required tests

- Listener counts return to zero after success.
- Listener counts return to zero after timeout.
- Listener counts return to zero after abort and spawn error.
- Cleanup process launch failure does not crash the host.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts
pnpm --filter @kenkaiiii/ggcoder check
pnpm --filter @kenkaiiii/ggcoder lint
```

### Acceptance criteria

- Listener-count tests show no retained child, stream, timer, or abort listeners.
- Cleanup failures are logged and never become unhandled EventEmitter errors.
- Timeout/abort races still settle exactly once.

### Commit boundary

```text
fix(ggcoder): clean foreground execution listeners
```

---

# Phase 3 — Terminate the correct process tree

## Sub-phase 3A — Harden Windows tree termination

**Status: Partial**

**Evidence:** `packages/ggcoder/src/core/process-manager.ts` `stopProcessTree` invokes `taskkill /pid <pid> /T /F` with argv, and `process-manager-dev-server-repro.test.ts` test `uses taskkill for Windows process-tree shutdown fallback` passed on 2026-07-16. Missing: trusted `%SystemRoot%\\System32\\taskkill.exe`, async failure/non-zero logging, liveness/PID-reuse checks, ConPTY ordering, and foreground use—`tools/bash.ts` calls POSIX-oriented `utils/process.ts`, while the manager uses bare PATH-resolved `taskkill`. Existing fallback commit: `87576110`.

### Behavioral outcome

Timeout or cancellation removes the Windows shell wrapper and all descendants without targeting unrelated processes.

### Scope

- Resolve `taskkill.exe` from trusted `%SystemRoot%\System32`.
- Invoke with argv, not shell interpolation.
- Use `/PID <pid> /T /F` for timeout and cancellation.
- For ConPTY, enumerate/kill the tree before closing the pseudo-console host.
- Attach `error` and non-zero `exit` handlers to asynchronous cleanup processes.
- Treat already-exited as success; log launch, access-denied, and non-zero failures.
- Check liveness where practical to reduce PID-reuse risk.

### Non-goals

- Do not use `taskkill /IM node.exe` or any process-name kill.
- Do not kill all Node processes.
- Do not change POSIX behavior in this sub-phase.
- Do not kill intentionally detached children after normal completion.

### References

**Repository:** [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)

**File:** [`packages/core/src/services/shellExecutionService.ts`](https://github.com/QwenLM/qwen-code/blob/88addbdf68f9a59dd3f1586ed6dfe31dfe98d681/packages/core/src/services/shellExecutionService.ts#L511-L585)

**Reference-only sample — do not copy verbatim:**

```ts
const taskkill = `${systemRoot}\System32\taskkill.exe`;
const args = ["/f", "/t", "/pid", String(pid)];
```

Qwen's regression coverage pins the ordering: tree-kill first, then `ptyProcess.kill()`, so closing ConPTY cannot orphan PowerShell descendants.

**Repository:** [stablyai/orca](https://github.com/stablyai/orca)

**File:** [`src/main/git/runner-command-exec.test.ts`](https://github.com/stablyai/orca/blob/e0edc8ef76d341f7ab8083a006f785322bcaeb23/src/main/git/runner-command-exec.test.ts#L77-L155)

**Reference-only sample — do not copy verbatim:**

```ts
expect(spawn).toHaveBeenCalledWith(
  taskkill,
  ["/pid", "1234", "/t", "/f"],
  expect.objectContaining({ windowsHide: true }),
);
```

### Required tests

- `cmd.exe → pnpm.cmd → node.exe → worker` leaves no descendants after timeout.
- Abort follows the same tree-kill path.
- A dead PID is treated as already complete.
- A failed `taskkill` launch is logged and does not crash.
- ConPTY cleanup ordering is explicit.
- No process-name kill is issued.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/process-manager.test.ts src/tools/bash-timeout.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

Run the descendant assertion on Windows CI and on a local Windows desktop build.

### Acceptance criteria

- The nested Windows fixture leaves no descendants after timeout.
- Cleanup never targets a process by image name.
- The trusted executable path cannot resolve from the project cwd or user PATH.
- Cleanup failures are observable but do not crash the host.

### Commit boundary

```text
fix(ggcoder): terminate Windows command trees safely
```

---

## Sub-phase 3B — Add POSIX TERM/KILL escalation

**Status: Partial**

**Evidence:** Background `ProcessManager.stop` sends `SIGTERM` to the negative process-group ID, waits up to five seconds, then calls `stopProcessTree`; `utils/process.ts` sends immediate group `SIGKILL` with direct-PID fallback. `process-manager-dev-server-repro.test.ts` defines `kills the whole detached process group on POSIX/WSL shutdown`. Missing: verified TERM/KILL escalation and descendant fallback for foreground execution. The POSIX test was skipped on Windows; Linux/macOS behavior is **Unverified**.

### Behavioral outcome

Timeout or cancellation removes a POSIX process group after a bounded graceful shutdown window.

### Scope

- Spawn foreground commands in a dedicated process group where supported.
- Send `SIGTERM` to the negative PGID first.
- Wait a bounded grace period.
- Send `SIGKILL` if the group remains alive.
- Fall back to direct PID and descendant traversal when group signaling fails.

### Non-goals

- Do not modify Windows behavior.
- Do not force-kill immediately when graceful termination succeeds.
- Do not treat a missing process as an error.

### Reference

**Repository:** [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)

**File:** [`packages/core/src/utils/process-utils.ts`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/utils/process-utils.ts#L28-L53)

**Reference-only sample — do not copy verbatim:**

```ts
process.kill(-pid, "SIGTERM");
// Escalate to SIGKILL only if the group remains alive.
```

### Required tests

- Group exits on `SIGTERM` without escalation.
- Ignored `SIGTERM` escalates to `SIGKILL`.
- Group-kill failure falls back to direct PID/descendants.
- Already-exited process is harmless.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/process-manager.test.ts src/tools/bash-timeout.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

Run group-level assertions on Linux CI; run macOS smoke coverage in the desktop release matrix.

### Acceptance criteria

- Shell and nested descendants exit after TERM/KILL escalation.
- Graceful exit prevents unnecessary force kill.
- Failed group signaling uses a bounded fallback.
- No unrelated process group is signaled.

### Commit boundary

```text
fix(ggcoder): terminate POSIX command groups
```

---

## Sub-phase 3C — Separate cancellation from normal completion

**Status: Partial**

**Evidence:** `packages/ggcoder/src/tools/bash.ts` requests a tree kill only on timeout/abort and does not kill on ordinary close; `ProcessManager.shutdownAll` tree-kills tracked background processes. Missing: detached-child survival/removal tests, wrapper-only reap semantics, late-abort race protection, and PID-reuse liveness checks.

### Behavioral outcome

Cancellation removes the full tree, while normal completion preserves intentionally detached children.

### Scope

- Full tree kill for timeout, user cancel, and session shutdown.
- Wrapper-only reap after normal completion when a known shell/PTY wrapper remains alive.
- Preserve intentionally detached work after normal foreground completion.
- Check liveness before reaping to reduce PID-reuse risk.

### Non-goals

- Do not guarantee survival for children during explicit session shutdown.
- Do not infer intent from process names.
- Do not retain unmanaged children after timeout or cancellation.

### Reference

**Repository:** [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)

**File:** [`packages/core/src/services/shellExecutionService.ts`](https://github.com/QwenLM/qwen-code/blob/88addbdf68f9a59dd3f1586ed6dfe31dfe98d681/packages/core/src/services/shellExecutionService.ts#L1800-L1817)

**Reference-only sample — do not copy verbatim:**

```ts
windowsKillPid(pid, cancelKillDispatched);
```

### Required tests

- Detached child survives normal foreground completion.
- Detached child is removed on timeout.
- Detached child is removed on explicit session shutdown.
- Late abort after normal exit does not retroactively tree-kill.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/process-manager.test.ts src/tools/bash-timeout.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- A deliberately detached child survives normal foreground completion.
- That child does not survive timeout, cancellation, or session shutdown.
- Late abort cannot convert normal cleanup into a tree kill.
- Liveness checks avoid cleanup against an already-reused PID where detectable.

### Commit boundary

```text
fix(ggcoder): distinguish completion from cancellation cleanup
```

---

# Phase 4 — Persist diagnostics before the process exits

## Sub-phase 4A — Start a foreground execution log immediately

**Status: Partial**

**Evidence:** Background `ProcessManager.start` creates `~/.gg/bg/<id>.log` before spawn and directs stdout/stderr there; the background result includes ID, PID, and log path. Ordinary foreground `tools/bash.ts` still buffers combined streams in memory and only writes an overflow file after completion, so the required foreground-readable log and stream-origin metadata are absent. Background logging originated in `795dd0ffc`.

### Behavioral outcome

Foreground output remains readable even when the command never emits `close`.

### Scope

- Create a per-execution log before spawning the command.
- Stream stdout and stderr into the log from process start.
- Preserve stdout/stderr origin metadata internally.
- Include execution ID, PID, command, cwd, start time, and configured timeout in metadata.
- Include log path in success, error, abort, and timeout results.

### Non-goals

- Do not change log retention yet.
- Do not expose raw binary bytes as text.
- Do not remove live progress updates.

### Reference

**Repository:** [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)

**File:** [`packages/core/src/services/shellExecutionService.ts`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/services/shellExecutionService.ts#L305-L340)

**Reference-only sample — do not copy verbatim:**

```ts
const logPath = path.join(logDir, `background-${pid}.log`);
stream.write(stripAnsi(content));
```

### Required tests

- Log exists before child completion.
- Partial output is readable while the child runs.
- Timeout result includes a readable log path.
- stdout/stderr source metadata survives combination.
- Log stream closes on every completion path.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts src/core/process-manager.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- A timeout fixture exposes a readable log path.
- Output written before the hang is preserved.
- The log does not depend on the child `close` event to become visible.
- The user-facing default may remain combined while internal stream origin is retained.

### Commit boundary

```text
feat(ggcoder): persist foreground execution logs
```

---

## Sub-phase 4B — Keep memory bounded and report the final 100 lines

**Status: Partial**

**Evidence:** `packages/ggcoder/src/tools/bash.ts` caps foreground buffering at 10 MiB; `tools/truncate.ts`, `tools/truncate-utils.ts`, and `tools/compress.ts` bound/compress displayed output, with 23 truncation tests passing on 2026-07-16. Missing: exact final-100-line timeout contract, foreground persisted full output, binary detection, elapsed/PID/reason metadata, and tests in the nonexistent `bash-timeout.test.ts`. Compression behavior was added by `ca383513`.

### Behavioral outcome

Large or non-terminating output cannot exhaust host memory, and timeout reports contain the final 100 lines.

### Scope

- Maintain a bounded in-memory tail for immediate reporting.
- Preserve the full bounded/persisted log separately.
- Return the final 100 text lines on timeout.
- Detect binary output or represent it safely.
- Include completion reason, exit code/signal, and elapsed time in the result.

### Non-goals

- Do not load the complete log into memory to compute the tail.
- Do not silently decode arbitrary binary content.
- Do not remove existing output compression behavior.

### References

**Repository:** [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)

**File:** [`packages/core/src/services/shellExecutionService.ts`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/services/shellExecutionService.ts#L49-L66)

**Reference-only sample — do not copy verbatim:**

```ts
const MAX_CHILD_PROCESS_BUFFER_SIZE = 16 * 1024 * 1024;
```

**Repository:** [ulixee/hero](https://github.com/ulixee/hero)

**File:** [`agent/main/lib/BrowserProcess.ts`](https://github.com/ulixee/hero/blob/9f89f92c1f7ff2a10537e8a5ca03454d1c0f6689/agent/main/lib/BrowserProcess.ts#L137-L150)

**Reference-only sample — do not copy verbatim:**

```ts
lines.push(line);
if (lines.length > 100) lines = lines.slice(-100);
```

**Repository:** [manaflow-ai/manaflow](https://github.com/manaflow-ai/manaflow)

**File:** [`apps/www/lib/routes/sandboxes/devAndMaintenanceOrchestratorScript.ts`](https://github.com/manaflow-ai/manaflow/blob/23e83e46160a746c786b18be9883b6e512fe9974/apps/www/lib/routes/sandboxes/devAndMaintenanceOrchestratorScript.ts#L392-L404)

**Reference-only sample — do not copy verbatim:**

```ts
return content.trim().split("\n").slice(-100).join("\n");
```

### Suggested output contract

```text
Exit code: TIMEOUT (120000ms)
Execution: 81464ee4
PID: 10464
Log: ~/.gg/bg/81464ee4.log
Reason: foreground deadline exceeded; process tree cleanup requested

Last 100 lines:
...
```

### Required tests

- More than the in-memory cap does not cause unbounded memory growth.
- Final 100 lines are exact after timeout.
- Partial final line is preserved correctly.
- Binary output is marked or safely summarized.
- Completion metadata is present for success and timeout.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts src/tools/truncate.test.ts src/tools/truncate-utils.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- Large-output fixtures keep host memory bounded.
- Timeout fixtures expose the final 100 lines.
- Full persisted output remains accessible according to policy.
- Binary output cannot corrupt the text log or result.

### Commit boundary

```text
feat(ggcoder): retain bounded foreground output tails
```

---

## Sub-phase 4C — Support late readers and explicit retention

**Status: Partial**

**Evidence:** `ProcessManager.readOutput` reads the current background log, tracks incremental byte offsets, and supports `fromStart`; `ProcessManager.list` prunes completed in-memory records after five minutes. `process-manager-dev-server-repro.test.ts` exercises `fromStart`, but the focused run failed on Windows before that assertion because `process.execPath` was not Git-Bash-safe. Missing: `task-output.test.ts`, log-file expiry/deletion, finalized metadata, flush guarantees, and a defined retained-log policy.

### Behavioral outcome

A reader attaching after backgrounding receives current output, and old execution logs expire predictably.

### Scope

- Expose a current output snapshot before streaming new chunks.
- Preserve incremental `task_output` offsets.
- Record final completion metadata in the execution registry.
- Define rotation/expiry for old logs and completed process records.
- Flush and close log streams on timeout where possible.

### Non-goals

- Do not replay unlimited logs into the UI.
- Do not keep completed process records forever.
- Do not change session transcript persistence.

### Reference

**Repository:** [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)

**File:** [`packages/core/src/services/executionLifecycleService.ts`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/services/executionLifecycleService.ts#L62-L74)

**Reference-only sample — do not copy verbatim:**

```ts
getBackgroundOutput?: () => string
getSubscriptionSnapshot?: () => string | AnsiOutput
isActive?: () => boolean
```

### Required tests

- Late reader gets the current snapshot first.
- Subsequent read returns only new output by default.
- `from_start` still returns the full retained log.
- Completed records and logs expire under the defined policy.
- Stream flush is attempted before timeout result returns.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/process-manager.test.ts src/tools/task-output.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- Late `task_output` subscribers receive the current snapshot before new chunks.
- Incremental offsets remain correct.
- Rotation or expiry prevents unbounded disk and map growth.
- Completion remains observable after the initiating agent turn ends.

### Commit boundary

```text
feat(ggcoder): retain execution snapshots for late readers
```

---

# Phase 5 — Make execution mode explicit

## Sub-phase 5A — Enforce the foreground/background contract

**Status: Partial**

**Evidence:** `packages/ggcoder/src/tools/bash.ts` exposes explicit `run_in_background`, keeps ordinary foreground stdin ignored, returns background ID/PID/log/control commands, and documents dev/watch/interactive use; `ProcessManager.start` pipes background stdin. Tests `answers an interactive prompt and completes` and `drives a REPL across multiple inputs` in `task-send.test.ts` passed. The background dev-server test exists but failed on Windows on 2026-07-16 (`E:nodejsnode.exe: command not found`); no `vite`, `next dev`, watch-command, finite-build, or foreground-deadline contract matrix exists. Explicit background support originated in `795dd0ffc`; interactive send in `a317913a`.

### Behavioral outcome

Finite commands run with deadlines in foreground mode, while dev/watch processes return immediately as managed background work.

### Scope

- Keep builds, tests, formatting, linting, migrations, and one-shot scripts in foreground mode.
- Require a deadline for every foreground execution.
- Use background mode for dev servers, watchers, REPLs, and commands expected to await input.
- Return execution ID, PID, log path, and next control commands immediately for background work.
- Keep stdin ignored for non-interactive foreground commands.
- Keep stdin piped only for explicit interactive/background control.

### Non-goals

- Do not background every slow command.
- Do not infer watch mode solely from elapsed time.
- Do not make finite verification asynchronous by default.
- Do not open stdin for ordinary foreground checks.

### Required tests

- `vitest run` remains foreground with a 120-second outer deadline.
- `vite`, `next dev`, and representative watch commands return managed background metadata.
- Finite lint/build commands return final exit status directly.
- Non-interactive foreground stdin is ignored.
- Interactive background stdin is writable.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/process-manager-dev-server-repro.test.ts src/tools/task-send.test.ts src/tools/bash-timeout.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- `vitest run` is finite and foreground with a 120-second outer deadline.
- `vite`, `next dev`, and watch modes return immediately with ID, PID, and log path.
- Interactive prompts can be driven through `task_send` without blocking the host.
- Background completion remains observable after the initiating turn.

### Commit boundary

```text
feat(ggcoder): enforce explicit execution modes
```

---

## Sub-phase 5B — Add EOF-first interactive shutdown

**Status: Partial**

**Evidence:** `ProcessManager.sendInput` and `tools/task-send.ts` independently support input, newline suppression, and `eof`, and `task-send.test.ts` covers interactive prompt/REPL flows. Missing: EOF-first behavior in `ProcessManager.stop`, bounded EOF grace, EOF-ignoring fixture/escalation, and waiting for a bounded terminal state; current stop sends `SIGTERM` first.

### Behavioral outcome

Interactive protocols can exit cleanly on stdin EOF before process termination escalates.

### Scope

- Support EOF as the first graceful stop for protocols designed to exit when stdin closes.
- Wait a short bounded interval after EOF.
- Terminate the process tree if it remains alive.
- Await exit before marking the managed task stopped.

### Non-goals

- Do not send EOF to non-interactive foreground commands.
- Do not wait indefinitely after EOF.
- Do not replace explicit user cancellation with EOF where the protocol does not support it.

### Reference

**Repository:** [anomalyco/opencode](https://github.com/anomalyco/opencode)

**File:** [`packages/opencode/test/lib/cli-process.ts`](https://github.com/anomalyco/opencode/blob/17544802c38a4d35834275526ccf38be1cdcfbf4/packages/opencode/test/lib/cli-process.ts#L393-L422)

**Reference-only sample — do not copy verbatim:**

```ts
p.stdin.end();
await waitForExit(2_000).catch(() => p.kill());
await p.exited;
```

### Required tests

- EOF-capable fixture exits without kill.
- EOF-ignoring fixture escalates after the grace interval.
- `task_send` can send input, newline, and EOF independently.
- Stopped task reports final exit state and output.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/task-send.test.ts src/core/process-manager.test.ts
pnpm --filter @kenkaiiii/ggcoder check
```

### Acceptance criteria

- Background stdin + EOF delivers input and attempts graceful exit.
- A non-responsive process is terminated after the bounded grace period.
- Stop does not return before the process has exited or cleanup has reached its bounded terminal state.

### Commit boundary

```text
feat(ggcoder): stop interactive tasks with EOF first
```

---

# Phase 6 — Prove the complete lifecycle

## Sub-phase 6A — Complete the cross-platform verification matrix

**Status: Partial**

**Evidence:** `.github/workflows/ci.yml` runs framework and app jobs on `ubuntu-latest`, `macos-latest`, and `windows-latest`; existing tests cover fast persistent-shell commands, background stdin, one mocked Windows taskkill path, and a POSIX group-shutdown path. Missing roadmap test files and matrix rows prevent completion. Local 2026-07-16 baseline: 31 passed, 1 failed, 9 skipped across the nearest five suites; the failing Windows dev-server command mangled the unquoted executable path. CI results for the current commit are **Unverified**.

### Behavioral outcome

Every supported execution scenario has deterministic automated coverage on its relevant operating systems.

### Required matrix

| Scenario                             | Windows | macOS | Linux | Expected result                                    |
| ------------------------------------ | ------: | ----: | ----: | -------------------------------------------------- |
| Fast foreground command              |     Yes |   Yes |   Yes | Exit code and output returned                      |
| CPU-bound infinite worker            |     Yes |   Yes |   Yes | Outer timeout, tree removed, tail retained         |
| Silent sleeping command              |     Yes |   Yes |   Yes | Outer timeout with clear reason                    |
| Nested shell/package-manager process |     Yes |   Yes |   Yes | Descendants terminated on timeout                  |
| Command waiting on stdin             |     Yes |   Yes |   Yes | Classified or moved to interactive background mode |
| Dev/watch server                     |     Yes |   Yes |   Yes | Managed background ID/PID/log returned             |
| Background stdin + EOF               |     Yes |   Yes |   Yes | Input delivered, graceful exit attempted           |
| Large stdout/stderr                  |     Yes |   Yes |   Yes | Memory bounded, full log retained per policy       |
| Spawn error                          |     Yes |   Yes |   Yes | Immediate failure, no dangling listeners           |
| Timeout/close race                   |     Yes |   Yes |   Yes | Exactly one settlement                             |
| Session shutdown                     |     Yes |   Yes |   Yes | Every managed tree cleaned up                      |

### Scope

- Wire platform-specific fixtures into CI.
- Keep Windows descendant and ConPTY assertions on Windows.
- Keep POSIX process-group assertions on Linux, with macOS smoke coverage.
- Measure targeted runtime and detect gross memory regressions.

### Non-goals

- Do not make unsupported platform assumptions in unit tests.
- Do not require privileged process inspection.
- Do not replace targeted fixtures with flaky end-to-end-only coverage.

### Required tests

- Every row in the matrix has an owning test.
- Platform-only behavior is skipped explicitly elsewhere.
- Session shutdown invokes tree cleanup for all managed processes.
- Persistent shell behavior remains unchanged.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder exec vitest run src/tools/bash-timeout.test.ts src/core/process-manager.test.ts src/core/process-manager-dev-server-repro.test.ts src/core/persistent-shell.test.ts src/tools/task-send.test.ts src/tools/task-output.test.ts
pnpm --filter @kenkaiiii/ggcoder check
pnpm --filter @kenkaiiii/ggcoder lint
```

### Acceptance criteria

- Foreground timeout fixtures pass on Windows and Linux CI.
- Background process tests preserve stdin, output offsets, and shutdown behavior.
- Every managed tree is cleaned up on session shutdown.
- Fast foreground and persistent-shell commands do not regress.

### Commit boundary

```text
test(ggcoder): cover cross-platform process lifecycle
```

---

## Sub-phase 6B — Verify desktop-sidecar diagnostics

**Status: Partial**

**Evidence:** `packages/ggcoder/src/app-sidecar-session-router.test.ts` test `keeps prompt, ordered events, cancel, state, history, and disposal isolated` covers per-session SSE isolation, and `gg-app/src/useAgentEvents.test.ts` covers typed tool timing events; existing provider-error formatting remains centralized through `app-sidecar.ts` `broadcastError`. Missing: foreground timeout event shape, PID/reason/log/final-100 mapping into the webview, and a Windows desktop timeout smoke. The app continues to use the sidecar seam. Desktop timeout diagnostics are **Unverified**.

### Behavioral outcome

The shipped desktop app receives complete timeout diagnostics without raw, missing, or cross-window output.

### Scope

- Build the ggcoder sidecar after process-lifecycle changes.
- Exercise timeout reporting through the app-sidecar seam on Windows.
- Confirm the webview receives reason, PID, elapsed time, log path, and final 100 lines.
- Confirm each window receives only its own sidecar events.
- Confirm ordinary provider error formatting remains unchanged.

### Non-goals

- Do not fork agent execution logic into `gg-app`.
- Do not fetch the sidecar directly from the webview.
- Do not redesign transcript styling.

### Required tests

- Sidecar foreground timeout event shape.
- Timeout diagnostic mapping into the webview item model.
- Per-window event isolation.
- No raw provider-error regression.

### Verification commands

```bash
pnpm --filter @kenkaiiii/ggcoder build
pnpm --filter gg-app exec vitest run
pnpm --filter gg-app check
pnpm --filter gg-app lint
```

Then run a Windows desktop smoke test:

```bash
cd gg-app && pnpm tauri dev
```

### Acceptance criteria

- The desktop smoke test confirms timeout diagnostics reach the webview without raw or missing output.
- Diagnostics include PID, command, elapsed time, completion reason, log path, and final 100 lines.
- Multiple windows do not receive each other's process events.
- The sidecar remains the only agent-execution seam used by the app.

### Commit boundary

```text
test(gg-app): verify sidecar timeout diagnostics
```

---

## Sub-phase 6C — Run the release gate

**Status: Not started**

**Audit note:** The full gate cannot start until 0B–6B are complete. No release verification commit matching the planned boundary exists, and the nearest targeted lifecycle baseline currently has one failing Windows test.

### Behavioral outcome

The complete change set is releasable with all targeted and repository-wide checks passing.

### Scope

- Run targeted suites first.
- Run full typecheck, lint, and format verification.
- Build all required packages.
- Confirm roadmap requirements are represented by tests or documented operational checks.

### Non-goals

- Do not publish packages or tag a desktop release in this sub-phase.
- Do not waive a failing targeted lifecycle test.
- Do not hand-edit release versions.

### Required tests

- All prior sub-phase tests.
- Full repository verification.
- Required package builds.
- Desktop smoke test evidence from Sub-phase 6B.

### Verification commands

```bash
pnpm check
pnpm lint
pnpm format:check
pnpm build
```

### Acceptance criteria

- Targeted `WorkspaceShell` tests pass without elevated CPU or memory growth.
- Foreground timeout fixtures pass on Windows and Linux CI.
- Background process tests preserve stdin, output offsets, and shutdown behavior.
- `pnpm check`, `pnpm lint`, and `pnpm format:check` pass.
- Required package builds pass.
- Desktop-sidecar smoke verification passes.

### Commit boundary

```text
chore: verify hang prevention lifecycle
```

---

# Global rejected patterns and non-goals

These constraints apply to every sub-phase:

- **Vitest timeout alone:** insufficient for a blocked worker event loop.
- **Vitest 4 `poolOptions`:** removed; current settings belong at the top level, as documented in [`vitest-dev/vitest/packages/vitest/src/node/config/resolveConfig.ts`](https://github.com/vitest-dev/vitest/blob/3e3e85285fb1256ff49dd5f4ef1ca4ebffe60a17/packages/vitest/src/node/config/resolveConfig.ts#L242-L250).
- **Killing only the shell PID:** leaves `cmd.exe → pnpm.cmd → node.exe → worker` descendants alive.
- **Killing by image/process name:** risks terminating GG Coder and unrelated Node processes.
- **Bare `taskkill` through shell interpolation:** weaker than argv-based execution with a trusted absolute executable path.
- **Saving output only after process close:** loses diagnostics for the exact class of process that never closes.
- **Unbounded output accumulation:** turns a hang into host memory exhaustion.
- **Backgrounding every slow command:** hides finite test failures and complicates deterministic verification.
- **Inline callback props used by effects:** unstable identity can retrigger subscriptions and state feedback loops.
- **Agent-spine duplication in `gg-app`:** process behavior remains in ggcoder; the app consumes the sidecar contract.

# Dependency and commit sequence

**Recovery sequencing correction:** Preserve the original clean commit boundaries below. First close Sub-phase 0A's unverified supervisor/memory evidence, then implement 0B. The code for 1A–1C already landed together in `50a50535`, so do not reimplement it; retain the original boundaries as the intended review history and close only the documented acceptance-evidence gaps before Phase 2.

1. `test(gg-app): reproduce workspace pane lifecycle loop`
2. `test(ggcoder): add foreground hang fixtures`
3. `fix(gg-app): stabilize pane lifecycle callbacks`
4. `fix(gg-app): deduplicate pane snapshots`
5. `test(gg-app): lock workspace lifecycle behavior`
6. `refactor(ggcoder): model foreground execution outcomes`
7. `fix(ggcoder): enforce host-owned foreground deadlines`
8. `fix(ggcoder): clean foreground execution listeners`
9. `fix(ggcoder): terminate Windows command trees safely`
10. `fix(ggcoder): terminate POSIX command groups`
11. `fix(ggcoder): distinguish completion from cancellation cleanup`
12. `feat(ggcoder): persist foreground execution logs`
13. `feat(ggcoder): retain bounded foreground output tails`
14. `feat(ggcoder): retain execution snapshots for late readers`
15. `feat(ggcoder): enforce explicit execution modes`
16. `feat(ggcoder): stop interactive tasks with EOF first`
17. `test(ggcoder): cover cross-platform process lifecycle`
18. `test(gg-app): verify sidecar timeout diagnostics`
19. `chore: verify hang prevention lifecycle`

# Definition of done

The incident is resolved when a repeated pane snapshot cannot trigger an unbounded React loop, and any future CPU-bound child process is externally timed out, fully cleaned up, and reported with its PID, command, elapsed time, completion reason, log path, and final 100 output lines.
