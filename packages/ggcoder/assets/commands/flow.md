---
argument-hint: [feature area or scope — optional]
description: Audit user flows end-to-end through UI, IPC, backend, DB, and events. Find broken mechanics, disconnected features, missing agent/UI parity, dead-end journeys, and silent failures — then create one prioritised task per gap.
allowed-tools: tasks, Bash, Read, Write, Edit, Grep, Glob, steroids, ask_user
---

# Flow

Trace every user journey through the full stack (UI → IPC → backend → DB → events → back to UI). Find where flows break, disconnect, go silent, or confuse users. This is a UX audit grounded in code, not opinions. Create one actionable task per gap. Do not edit any files.

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

**0d. Ask before installing.** Never auto-install. Show the user:

> Project class: **[detected class]**
> Recommended driver: **[Playwright / Detox]** — not currently installed.
> Install **[exact package + version]** as a devDependency? Browser binaries are ~200MB.
> [y] install [n] skip and bail [m] I'll install manually, retry after

Only proceed on `y`. On `n`, bail with the same not-applicable message as 0b. On `m`, stop and wait.

**0e. Confirm dev server / app entry.** Most flow tracing needs the app actually running. Ask:

> Driver ready. To trace flows I need the app running.
>
> - Web: dev server URL (e.g. http://localhost:3000) — start it now or paste URL
> - Electron: path to built app or `npm start` command
> - RN: simulator/device + bundler running

Do not guess ports or start servers without explicit confirmation.

Only after 0a–0e succeed, continue to Step 1.

## Step 1: Determine what to audit

If `$ARGUMENTS` is provided, use it as the feature area or scope.

If `$ARGUMENTS` is empty, infer scope from context — in this order:

- **Git diff** — `git diff --name-only HEAD~1 HEAD` and `git status --short` to find recently changed UI/IPC/handler files
- **Active plan** — most recently modified file in `.gg/plans/`
- **Session context** — what was just discussed or implemented

From that, extract the feature area (e.g. "scheduling flow", "draft creation", "agent repurpose") and the entry points in scope.

If nothing can be inferred, ask the user. Do not proceed blind.

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
- Things that work correctly end-to-end

## Step 6: Severity

- **Critical** — BROKEN. Mechanic literally doesn't work.
- **High** — DISCONNECTED, ASYMMETRIC, DEAD-END. User gets stranded or a feature is unreachable.
- **Medium** — SILENT, STALE, DUPLICATE-PATH, ONE-WAY. Works but degrades or confuses in real use.
- **Low** — CONFUSING, EMPTY. Polish — usually opinion-laden.

## Step 7: Create tasks

For Critical / High / Medium findings, add one task to the task pane using the `tasks` tool (action: `add`). One task per gap.

**For Low findings (CONFUSING / EMPTY): do NOT auto-create tasks.** These are opinion calls — "Cold Upload should be renamed" needs user buy-in before a task is burned on it. List them inline in the report (Step 8) under a `Needs decision` section. After reporting, ask the user which Low findings to convert into tasks.

Each task must be self-contained — a fix agent in a separate chat must execute it with no extra context. Include:

- Severity label (Critical / High / Medium)
- Finding type (BROKEN / DISCONNECTED / etc.)
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
Driver: <Playwright / Detox / static-only>
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

After the report, ask:

> Convert any of the `Needs decision` items into tasks? List the IDs or say `none`.

Keep the report tight. The detail lives in the tasks.
