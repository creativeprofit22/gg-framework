# Tasks: actions, states and removal

Scope: the **executable project task list** shown by the workspace `Tasks` button — the same list the CLI task pane drives, stored per project by the daemon. This is not the Notes checklist and not the Roadmap: Notes tasks are free-text reminders inside Project Notes, and Roadmap phases have their own lifecycle and their own recoverable deletion policy (see `docs/notes-roadmap-deletion.md`, which is a **separate regime** and is not repeated here).

## Ownership

| Layer                     | Owns                                                                        | Where                                                                             |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Presentation              | List rows, detail panel, confirmation markup, wording                       | `gg-app/src/TasksModal.tsx`                                                       |
| Interaction state         | Selection, pending action, confirmation, inline error/notice, focus landing | `gg-app/src/useTasksController.ts`                                                |
| Eligibility predicates    | Which statuses may run, and which may be run manually                       | `packages/gg-core/src/project-task-contract.ts`                                   |
| Lifecycle and persistence | Admission, execution, status transitions, storage                           | `packages/ggcoder/src/app-sidecar.ts`, `packages/ggcoder/src/core/tasks-store.ts` |

`AgentPane` stays a transport seam: it calls the pane client, toasts failures, closes the modal on a successful run, and returns the promise so the controller can keep an action pending. No task policy lives in it or in the modal.

## States and actions

Status comes from the daemon and is pushed live over the `tasks_list` SSE event. Unknown future statuses render as `unknown` and offer no run control.

| Status        | Shown as | Run control   | Why                                                                                                                  |
| ------------- | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pending`     | pending  | **Run**       | Never started.                                                                                                       |
| `blocked`     | blocked  | **Retry**     | Ran and stopped; running again is a retry.                                                                           |
| `in-progress` | running  | **Run again** | The backend genuinely admits a manual run, so the control stays; only the wording changes to say it is another pass. |
| `done`        | done     | —             | Not runnable.                                                                                                        |
| unknown       | unknown  | —             | Fail closed for statuses this build does not know.                                                                   |

### Why a task is blocked

`blocked` covers several different endings. The daemon records which one in the optional `lastOutcome: { reason, at }` field of `ProjectTask` (`gg-core`) when it finalizes a run, and clears it when a later run succeeds. It is informational only: it never changes `status` or run eligibility. The detail panel (not the list row) shows one muted sentence for it; records without the field, or with a reason this build does not know, show nothing.

| Reason            | Recorded when (first match wins)                                         | Detail panel says                                                                          |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `cancelled`       | The run was cancelled                                                    | Last run stopped: it was cancelled.                                                        |
| `plan-mode`       | The session was in plan mode at the end of the run                       | …the session was in plan mode, so the task was not carried out. Leave plan mode…            |
| `plan-checkpoint` | A submitted plan awaits approval or revision                             | …a plan is waiting for your approval or revision… Resolve the plan before retrying.         |
| `run-failed`      | The agent turn errored before review                                     | …the agent’s turn ended with an error.                                                     |
| `review-failed`   | Autopilot review ended without clearing the work (HUMAN, capped, failed) | …Autopilot review did not clear the work.                                                  |
| `queued-messages` | Review cleared, but user messages were queued during the run             | …messages were queued during the run. Send or cancel them before retrying.                 |

Every run — first, retry or repeat — opens a **fresh session** and streams into the transcript. `Run all (n)` counts and launches only `pending` and `blocked` tasks, sequentially, unchanged from before.

## Refusals are visible

Admission is decided **before** the run is accepted. `/tasks/run` answers `409` with a code and a plain message whenever the daemon would refuse the run, so the Tasks modal toasts the reason and keeps the modal open instead of closing on a run that never starts:

| Refusal                                                 | Code                      | Shown as                                                                                                        |
| ------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Queued messages are waiting                             | `queued_messages_pending` | "Cannot run this task while queued messages are waiting. Send or cancel them first." (Run all says "run tasks") |
| Plan mode is active                                     | `plan_mode_active`        | "Cannot run tasks while plan mode is active. Leave plan mode first."                                            |
| Task missing, or not in a manually runnable status      | `task_not_runnable`       | "That task no longer exists." / "That task is `<status>` and cannot be run." / "No task is ready to run."       |
| Session busy, mutation owner, plan gate, config refresh | existing bodies           | unchanged                                                                                                       |

The run loop keeps the same checks as a last line of defence: if the state flips between acceptance and execution, the sweep broadcasts an error ("Task run did not start" / "Run All did not start") carrying the same reason rather than ending silently.

One action is in flight at a time. While it is pending the control shows a progress label and every other run/delete control is disabled, so a second click cannot dispatch a duplicate. Failures surface twice: as the existing toast, and inline inside the modal next to the task, so the context survives the failure.

## Inspecting a task

The task title is a button (`Inspect task: <title>`), reachable by keyboard and touch — the full prompt is no longer hover-only text. It opens a detail panel with the full title, the complete prompt (wrapping, selectable, scrolling inside the panel), status, creation date and the same Run/Delete actions. `Back to tasks` restores the list, its scroll position and focus on the row that opened it.

If the inspected task disappears from a live list update, the panel returns to the list with a short notice rather than a blank pane. An empty list shows an explanatory empty state.

## Removal

Deletion is guarded by an inline `role="alertdialog"` confirmation inside the Tasks dialog — no nested modal, so focus stays in one dialog. **Keep task** takes focus first, following W3C dialog guidance for hard-to-reverse operations.

- Cancel changes nothing and returns focus to the delete control that opened it.
- Failure keeps the task, keeps the confirmation open, and shows the reason inline.
- Success closes the confirmation and moves focus to a surviving task, or to the empty state.

**A running task can still be deleted, and the confirmation says so.** Deletion stays available for every status — including `in-progress` — but for an `in-progress` task the confirmation adds a second sentence: the task is running now, and deleting it does not stop the run in progress. The agent keeps working in its session and the finished run has nowhere to record its result. The wording is derived from the task's status alone; the `gg-core` eligibility predicates stay the single source for _run_ eligibility and are not reused here.

**There is no undo.** The task store rewrites `tasks.json` on delete and has no restore path, and the app has no add-task endpoint, so a deleted task cannot be brought back with its identity. The confirmation copy says so plainly; no recovery is promised. If durable recovery is ever added to the store, this is the place to revisit that promise.

The delete control carries an accessible name (`Delete task: <title>`) and a comfortable hit area — 32px square at fine pointers, 44px at coarse ones.

## Verification checklist

- `pnpm --filter gg-app exec vitest run src/TasksModal.test.tsx` — detail open/back with focus return, long prompt, per-status run wording, eligibility, busy/pending, duplicate activation blocked, cancel, delete failure, delete success and focus landing, empty list, task removed externally, running-task delete warning present for `in-progress` and absent for `pending`, last-outcome sentence in the detail panel only and absent without a known `lastOutcome`.
- `pnpm --filter gg-app exec vitest run src/AgentPane.test.tsx` — run/run-all/list/delete failures across the real transport seam, including the confirmation step.
- `pnpm --filter ggcoder exec vitest run src/app-sidecar-task-admission.test.ts` — `/tasks/run` admission: 409 with a descriptive body for queued messages, plan mode and a non-runnable status; 202 when idle; the post-acceptance refusal broadcast.
- `pnpm --filter ggcoder exec vitest run src/app-sidecar-task-runner.test.ts` — recorded `lastOutcome` reason per blocking cause, and clearing on a later success.
- `pnpm --filter gg-app smoke:tasks-actions` (`gg-app/scripts/tasks-actions-dev-smoke.mjs`, runs in CI on every OS) — synthetic browser smoke of the real component and CSS at 1280×800 and 390×844: keyboard detail navigation, delete hit area (32px fine / 44px coarse pointer), two-line title wrapping, detail prompt scrolling with the actions row on screen, cancel, delete failure and success, no dialog overflow, zero page errors. Hosts its own Vite server; pass `--origin http://127.0.0.1:1420` to reuse a running dev server and `--evidence <dir>` for screenshots plus `report.json`. Uses in-memory handlers: **no task is run and nothing is deleted**.
- `pnpm --filter gg-app check`, `build`, `lint`, `format:check`, plus the polish probes (`visual.mjs`, `measure-density.mjs`, `affordance.mjs` including `--pointer coarse`, `a11y.mjs`, `states.mjs`).

Browser and synthetic-fixture results do not verify native Tauri IPC, daemon behaviour, or installers.
