---
argument-hint: [feature area, natural-language scope, path, or recent — optional]
description: Audit user flows end-to-end through UI, IPC, backend, DB, and events. Find broken mechanics, disconnected features, missing agent/UI parity, dead-end journeys, and silent failures — then create one prioritised task per gap.
allowed-tools: tasks, Bash, Read, Grep, Glob, steroids, ask_user
---

# Flow

Trace every user journey through the full stack (UI → IPC → backend → DB → events → back to UI). Find where flows break, disconnect, go silent, or confuse users. This is a UX audit grounded in code, not opinions. Create one actionable task per gap. Do not edit any files.

## Audit family rules

This section is identical in `/trace`, `/parity`, `/contract`, `/flow`, and `/ship`. Change it in all five or none.

**Ownership.** Every finding has one owner command:

| Command     | Owns                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/trace`    | Internal wiring with no frontend ↔ backend boundary: config, options, adapters, schemas, and events between internal layers            |
| `/parity`   | Frontend ↔ backend agreement: routes, request/response shapes, validation, permissions, errors, cache, events, and surfaced capability |
| `/contract` | Public promises vs implementation: types, abstract classes, exports, CLI flags, documented APIs, config schemas, and error types       |
| `/flow`     | User journeys exercised with a live driver: feedback, dead ends, navigation, undo, and empty states                                    |
| `/ship`     | Release blockers from any lane above, plus build, runtime, config, CI, and regression risk                                             |

Outside `/ship`, when a confirmed finding belongs to another command, do not create a task for it here. List it under `Routed` in the report with the owner command and one line of evidence. `/ship` may task any release blocker but names the owner lane.

**Canonical type.** Keep this command's own gap label, and also tag every finding and task prompt with exactly one canonical type:

| Canonical type    | Covers                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `DROPPED-INPUT`   | Option, flag, field, config, or env value accepted but never consumed, or silently defaulted |
| `PARTIAL-WIRING`  | Works through one real path or entry point but not another                                   |
| `SHAPE-DRIFT`     | Two sides disagree on fields, names, types, optionality, or schema                           |
| `GATE-DRIFT`      | Validation, permission, or confirmation check missing or mismatched                          |
| `STALE-STATE`     | A successful change is not reflected in cache, UI, or subscribers                            |
| `EVENT-DRIFT`     | Emitter, listener, channel, or payload disagree, or one side is missing                      |
| `UNREACHABLE`     | Capability exists but no user, caller, or consumer can reach it                              |
| `UNIMPLEMENTED`   | Stub, facade, documented-only feature, or missing handler                                    |
| `DOC-DRIFT`       | Docs, help text, fixtures, tests, or generated clients describe old behavior                 |
| `JOURNEY-GAP`     | User is left without feedback, a next step, a way back, or an empty state                    |
| `RELEASE-BLOCKER` | Build, runtime, config, migration, CI, or regression failure                                 |
| `VERIFY-FIRST`    | Plausible and specific, but needs an exact check before fixing                               |

**Severity baseline.** A command's own severity section may add detail but must not contradict this baseline:

- **Critical** — broken core behavior, data loss, security or permission bypass, crash, or a public promise that is a flat lie.
- **High** — silent wrong behavior on a real path, partial wiring across real entry points, stale state after a successful change, or an unreachable capability users need.
- **Medium** — edge-case failure, validation or error drift, missing feedback, or drift that can mislead future fixes.
- **Low** — latent drift or minor cleanup.

**Low findings.** Create tasks for Low findings only when they are objective. Opinion calls — naming, wording, layout, empty-state design — go under `Needs decision`; after the report, use `ask_user` with kind `multi` to ask which ones to convert into tasks. Ask every question with `ask_user`, never as plain text. Put at most 6 items in one question; split more across up to 5 questions in one `ask_user` call, grouped by type. If there are more than 30, ask about the 30 highest-impact items and list the rest in the report.

**Task titles carry the dedupe key.** Every task title must end with ` [<CANONICAL-TYPE> <file>:<line>]`, where `<file>:<line>` is the source end of the finding — for example `Fix /trace: drop of timeout option [DROPPED-INPUT src/cli.ts:120]`. The `tasks` list output shows only titles, so this suffix is the only place other audit commands can see the canonical type and boundary.

**No duplicate tasks.** Before adding tasks, call `tasks` with `action: "list"`. An open task is the same finding when its bracketed `[<CANONICAL-TYPE> <file>:<line>]` title suffix matches the new finding exactly, ignoring the `Fix /<command>:` prefix, whichever audit command created it. Do not add a second task; list it under `Already tracked` with the existing task title.

**Scope.** Accept an empty argument, `recent`, a natural-language scope, or an exact path or symbol.

- **Empty (default): the whole chat.** Audit every piece of implementation work in this conversation, from its first message — not only the latest turn. Build the scope as the union of every feature, fix, and file created or edited during the chat, including work that survives only in a compaction summary. Then add uncommitted files from `git status --short` that belong to that work. When the chat touched several unrelated areas, audit each one as its own capability; do not ask which one to pick. Arguments like `all of this chat` mean this default.
- **`recent`: the latest unit of work only** — the most recent implementation in this chat.
- **Fallback.** If the chat contains no implementation work, infer scope from `git status --short` and `git diff --name-only HEAD~1 HEAD`, then the most recently modified `.gg/plans/*.md`.
- **Coverage.** List the chat work items covered in the report so the user can see nothing was dropped. Leave uncommitted changes unrelated to the chat out of scope and mention them in one line. Ask with `ask_user` only when a chat work item cannot be resolved to files, or a natural-language scope has low confidence or matches unrelated areas.

**Read-only.** Do not edit project files. Installs, code generation, migrations, starting servers, or any other project-changing command need explicit approval through `ask_user` first. The `allowed-tools` frontmatter is advisory: the command runtime does not enforce it, so this no-edit rule is enforced by instruction only.

**Report footer.** After the command's summary block, add `Routed: <N>` and `Already tracked: <N>`, with one line per entry when non-zero. If tasks were created, end with: `Tasks created. Open the task list (Ctrl+T in the terminal, or the Tasks button in the desktop app) and run them.`

## Step 0: Feasibility & driver gate

Before anything else, decide if `/flow` can actually run on this project. **Do not skip this step.** Without a real browser/app driver, `/flow` degrades into fuzzy grep that just duplicates `/trace`.

**0a. Classify the project.** Read `package.json`, framework files, and directory structure. Classify into ONE of:

| Class                  | Signals                                                                 | Driver                        |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| **Web SPA / SSR**      | React/Vue/Svelte/Solid/Next/Nuxt/Remix/Astro deps; `index.html`; routes | Playwright                    |
| **Electron**           | `electron` dep; `main.js` + renderer                                    | Playwright (with `_electron`) |
| **React Native**       | `react-native` dep; `ios/` `android/` dirs                              | Detox                         |
| **Server / CLI / lib** | No UI deps; only API/CLI/library code                                   | **Not applicable**            |
| **Unknown**            | Mixed signals or nothing matches                                        | **Ask user**                  |

**0b. Bail loud if not applicable.** If the project is server-only / CLI / lib, STOP and tell the user:

> This project has no UI surface — `/flow` isn't applicable. Use **`/trace`** for static data-flow auditing or **`/contract`** for interface-vs-implementation gaps.

Do not proceed. Do not install anything.

**0c. Check if the driver is already installed.** Look in `package.json` (deps + devDeps + lockfile) for:

- Playwright: `@playwright/test` or `playwright`
- Detox: `detox`

If found → skip to 0e.

**0d. Ask before installing.** Never auto-install. Use `ask_user` with kind `choice`, stating the detected project class, the recommended driver, the exact package and version to add as a devDependency, and that browser binaries are about 200MB. Options:

- **Install the driver** — install it, then continue.
- **Skip this audit** — bail with the same not-applicable message as 0b.
- **I'll install it myself** — stop and wait; the user reruns `/flow` afterwards.

Only proceed after the install option is chosen and the install succeeds.

**0e. Confirm dev server / app entry.** Flow tracing needs the app actually running. First look for an already-running app or a documented dev command. If none is confirmed, use `ask_user` for the dev server URL (web), the built app path or start command (Electron), or confirmation that a simulator/device and bundler are running (React Native).

Do not guess ports or start servers without explicit confirmation.

Only after 0a–0e succeed, continue to Step 1. There is no static-only mode: if no live driver can run, stop and point the user to `/trace`, `/parity`, or `/contract`.

## Step 1: Determine what to audit

If `$ARGUMENTS` is provided and is not `recent`, treat it as an exact path or a natural-language feature area such as `scheduling flow` or `draft creation`. Resolve it by searching routes, views, components, handlers, and event names for its terms. Do not require exact paths.

If `$ARGUMENTS` is empty, audit every user flow touched by implementation work in this chat, following the Scope rule above:

- **Session context** — every feature, fix, and file created or edited across the whole conversation, from the first message (including compaction summaries), not just the latest turn
- **Git diff** — `git status --short` to attach uncommitted UI/IPC/handler files that belong to that work
- **Active plan** — any `.gg/plans/` file the chat followed

If `$ARGUMENTS` equals `recent`, audit only the latest unit of work in this chat. If the chat has no implementation work, fall back to `git diff --name-only HEAD~1 HEAD`, `git status --short`, then the most recently modified `.gg/plans/*.md`.

From that, extract the feature area (e.g. "scheduling flow", "draft creation", "agent repurpose") and the entry points in scope.

If nothing can be inferred, ask the user with `ask_user`. Do not proceed blind.

## Step 2: Map the feature surface

Build a map of what exists in scope:

- **UI views / tabs / panels** — every distinct screen or section the user can see
- **User actions** — every button, form, link, drag target the user can interact with
- **Agent tools** — every tool the agent can invoke that affects user-visible state
- **IPC channels** — every channel connecting renderer to main (Electron) or client to server
- **Events** — every event flowing backend → UI and UI → backend
- **Data entities** — every DB table/type the user's actions create or modify

This map is the foundation. Every flow is traced against it.

## Step 3: Identify user flows

Extract every distinct user journey in scope. A flow has:

- **Entry point** — where the user starts (tab, button, agent command)
- **Steps** — each action and its expected result
- **Exit point** — where the user ends up (new state, confirmation, navigation)
- **Agent equivalent** — can the agent do the same thing? Does it reflect in the UI?

Categories to cover:

| Category               | What to trace                                                                |
| ---------------------- | ---------------------------------------------------------------------------- |
| **CRUD flows**         | Create / Read / Update / Delete for every entity                             |
| **Pipeline flows**     | Multi-step processes (discover → save → repurpose → draft → schedule → post) |
| **Agent → UI flows**   | Agent does work → event fires → UI updates                                   |
| **UI → Agent flows**   | User triggers something the agent could also do — both paths wired?          |
| **Navigation flows**   | Links/buttons that take the user between views                               |
| **Error flows**        | What happens when steps fail                                                 |
| **Empty → Full flows** | First-run experience — what does each view show with zero data?              |

## Step 4: Trace every flow

For each flow, follow it from entry to exit. Use the live driver to actually click through where useful — don't only read code. At every step, check:

- Does the next step exist? (button rendered, handler registered, event wired)
- Is there feedback? (loading state, progress, success/error)
- Is there a way back? (cancel, undo, navigate away)
- Does the result land where the user expects? (right tab, right panel, right time)

At the end of each flow:

- Is the user left somewhere useful, or stranded?
- Are related views updated? (calendar, lists, counters)
- Is there a clear "what's next"?

Follow real imports, real event subscriptions, real route handlers. Do not guess.

**Ground unfamiliar framework patterns with Steroids before classifying.** When a flow depends on a framework hook, IPC pattern, store API, router behaviour, or event-bus convention you're not certain about, use **Steroids** to look up how the pattern is wired in real public apps _before_ calling something BROKEN, STALE, or ASYMMETRIC. Two reasons:

1. **Avoid false positives.** What looks STALE ("the view doesn't refresh") may be wired through a standard invalidation pattern (query keys, store subscriptions, route revalidation) you didn't trace. Confirm against real-world usage of the same framework.
2. **Pre-bake the fix recipe.** Once you've seen how the wiring is normally done, write the canonical pattern into the task in Step 7 — actual hook call, invalidation key, IPC channel shape — so the fix agent executes instead of re-investigating from a cold chat.

Search the curated Steroids corpus first for the literal symbol (import line, hook name, IPC channel) using `action: "search"` and `perRepo: 1`, then inspect 2–3 real examples using `action: "show"`. Use `repos` to check indexed-repository activity; prefer repos active in 2026 and skip stale ones. If Steroids reports a real corpus gap, automatically call `discover` with a short topic query, present suitable repositories, and use `ask_user` for approval before `add`; never call `add` or `discover` with `add: true` before approval. After approval, add only the selected repositories, then repeat `search` and `show`. External examples cannot prove local deadness, reachability, correctness, or business intent. Skip this whole step for project-internal patterns where the local convention is obvious.

## Step 5: Classify findings

Use these finding types only:

| Type               | What it means                                                                    |
| ------------------ | -------------------------------------------------------------------------------- |
| **BROKEN**         | Mechanic doesn't work at all (e.g. `file.path` is undefined in renderer)         |
| **DISCONNECTED**   | Feature exists but no flow leads to/from it (orphan tab, dead route)             |
| **ASYMMETRIC**     | Agent can do it but UI can't, or vice versa                                      |
| **DEAD-END**       | Flow stops with no next step or feedback (succeeds but nowhere to see result)    |
| **SILENT**         | Action has no visible feedback (click → nothing for >200ms)                      |
| **STALE**          | Data not refreshed after state change (calendar doesn't update after scheduling) |
| **DUPLICATE-PATH** | Same thing via two paths with different behaviour                                |
| **ONE-WAY**        | Can enter a state but can't exit/undo (modal with no cancel)                     |
| **CONFUSING**      | Naming/layout/interaction unclear to users (developer jargon)                    |
| **EMPTY**          | No empty/zero-data state designed (blank white space)                            |

For each finding, record:

- **WHERE**: `file:line` for the UI element AND `file:line` for the handler/event/destination
- **WHAT**: what's broken or missing in the journey
- **WHY IT MATTERS**: what the user actually experiences

Do NOT report:

- Code style, "should be refactored", performance suggestions
- Theoretical problems that can't actually be triggered
- Missing features that were never started (only features that are half-wired)
- Accessibility — that's `/wcag-audit`'s job
- Wiring or shape gaps found only by reading code, with no journey symptom seen in the live driver; route them to `/trace` (internal) or `/parity` (frontend ↔ backend)
- Things that work correctly end-to-end

## Step 6: Severity

- **Critical** — BROKEN. Mechanic literally doesn't work.
- **High** — DISCONNECTED, ASYMMETRIC, DEAD-END, STALE, DUPLICATE-PATH. User gets stranded, a feature is unreachable, state is stale after a successful change, or real entry points behave differently.
- **Medium** — SILENT, ONE-WAY. Works but degrades or confuses in real use.
- **Low** — CONFUSING, EMPTY. Polish — usually opinion-laden.

## Step 7: Create tasks

For Critical / High / Medium findings, add one task to the task pane using the `tasks` tool (action: `add`). One task per gap.

Task title format: `Fix /flow: <specific finding> [<CANONICAL-TYPE> <file>:<line>]` (suffix required by the Audit family rules).

**For Low findings (CONFUSING / EMPTY): do NOT auto-create tasks.** These are opinion calls — "Cold Upload should be renamed" needs user buy-in before a task is burned on it. List them inline in the report (Step 8) under a `Needs decision` section. After reporting, ask the user which Low findings to convert into tasks.

Each task must be self-contained — a fix agent in a separate chat must execute it with no extra context. Include:

- Severity label (Critical / High / Medium)
- Finding type (BROKEN / DISCONNECTED / etc.)
- Canonical type from the Audit family rules
- The flow being fixed (e.g. "Schedule post → Calendar update")
- Exact `file:line` for both ends (UI element + handler/event/destination)
- A plain-english description of what's broken in the journey
- A concrete fix at the code level — actual component names, event names, IPC channels, store keys, store-invalidation calls (not pseudocode). If you grounded the flow against Steroids in Step 4, bake the canonical pattern you saw directly into the task (hook call, invalidation key, IPC channel shape, event signature). The fix agent should be able to execute, not re-investigate.
- Any related files the fix agent should read first
- **Fallback grounding clause**: if your Step 4 recipe is ambiguous or you couldn't verify the pattern (rare framework, no public examples), tell the fix agent to search the curated Steroids corpus for the specific literal symbol and inspect matches with `show` _before_ writing code. If Steroids reports a real corpus gap, tell it to `discover`, seek approval before `add`, then repeat `search` and `show`. Otherwise omit — don't pad every task with redundant lookup instructions.

Order: Critical → High → Medium.

If a gap is too ambiguous to write a concrete fix for, mark it Skipped with a reason. Do not silently drop it. Do not create vague tasks.

## Step 8: Report

Reply inline with:

```
Audited: <feature area in scope>
Driver: <Playwright / Detox>
Flows traced: <N>
Findings: <N> (<N> Critical, <N> High, <N> Medium, <N> Low)
Tasks created: <N> (Critical/High/Medium auto-tasked)
Needs decision: <N> (Low — CONFUSING / EMPTY, listed below)
Skipped: <N>
```

Then one line per task:

```
[Critical] [BROKEN]       file:line — one sentence description
[High]     [DISCONNECTED] file:line — one sentence description
[Medium]   [SILENT]       file:line — one sentence description
...
```

Then any Low findings awaiting decision:

```
Needs decision:
  [CONFUSING] file:line — current label / current behaviour → suggested
  [EMPTY]     file:line — view with no empty-state design
```

Then any skipped gaps:

```
Skipped: file:line — reason a concrete fix couldn't be written
```

Then the Audit family rules report footer.

If there are `Needs decision` items, use `ask_user` with kind `multi` to ask which ones to convert into tasks, following the Audit family rules limits.

Keep the report tight. The detail lives in the tasks.
