---
argument-hint: [frontend/backend feature, natural-language scope, path, or recent — optional]
description: Audit frontend ↔ backend parity for all work from this chat (or only the latest with `recent`, or a scoped feature). Finds UI/API shape, permission, cache, event, error, and surfaced-capability mismatches — then creates task-pane tasks.
allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user
---

# Parity

Audit whether the frontend and backend agree for a scoped capability. Default to all implementation work in this chat, not just the latest turn; `recent` narrows to the latest unit of work. If the user provides a natural-language scope like `calendar posting`, `auth sessions`, `billing checkout`, or `the onboarding stuff`, resolve that scope first. Do not edit project files.

`/parity` is not a general end-to-end trace. It asks a narrower question: **does one side expose, send, return, validate, authorize, cache, render, and react to the same truth as the other side?**

If concrete mismatches are found, create one task-pane task per gap automatically. Do not ask for confirmation after the finding is confirmed.

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

## Step 1: Resolve scope

If `$ARGUMENTS` is empty, audit everything implemented in this chat, following the Scope rule above:

1. every feature, fix, and file created or edited across the whole conversation, from the first message (including compaction summaries); check each frontend ↔ backend boundary they touch
2. `git status --short` to attach uncommitted files that belong to that work
3. any `.gg/plans/*.md` file the chat followed

If `$ARGUMENTS` equals `recent`, audit only the latest unit of work in this chat. If the chat has no implementation work, fall back to `git status --short`, `git diff --name-only HEAD~1 HEAD`, then the most recently modified `.gg/plans/*.md`.

If `$ARGUMENTS` is provided and is not `recent`, treat it as either an exact path/symbol or a natural-language scope. Do not require exact paths.

Resolve natural-language scopes by:

1. extracting domain terms, entity names, route words, form names, API names, event names, and synonyms
2. searching filenames/paths for those terms
3. grepping route handlers, API clients, fetch calls, server actions, schemas, validators, form fields, hooks, query keys, stores, event names, permissions, tests, and docs
4. expanding to adjacent UI, API, schema, validation, auth, cache, event, and test files

Build a scope map:

- **Frontend files** — pages/routes, components, forms, hooks, stores, API clients, query keys, UI tests.
- **Backend files** — routes/controllers/server actions/resolvers, services, validators, serializers, auth gates, DB/schema, events/jobs.
- **Shared files** — generated clients, shared types, schemas, constants, fixtures, docs.
- **Noisy/excluded matches** — same words but unrelated.

If no frontend/backend boundary exists in the project, stop and say `/parity` is not applicable; use `/trace` for non-UI wiring or `/contract` for interface-vs-implementation gaps.

If confidence is low or multiple unrelated features match, ask a clarifying question before proceeding.

## Step 2: Collect safe programmatic evidence

Use safe local evidence first:

- changed files and changed exported symbols from git diff/status
- package scripts/config that identify build, lint, typecheck, test, codegen, API client generation, schema validation, and e2e commands
- route/API inventory from project files
- frontend API calls: `fetch`, generated clients, RPC hooks, server actions, query/mutation hooks, SDK calls
- backend handlers: routes/controllers/resolvers/server actions/IPC channels/webhooks
- schemas/types: validators, DTOs, OpenAPI/tRPC/GraphQL schemas, DB models, shared types
- cache/state: query keys, invalidations, stores, event subscriptions, realtime channels
- permission/error/loading paths: guards, status codes, error mappers, UI error/loading/empty states

Run existing safe verification commands only if clearly relevant and non-mutating. Examples: `typecheck`, `lint`, schema/codegen check, API client check, relevant tests. Do not install, download, migrate, generate, or mutate lockfiles without explicit user confirmation.

Programmatic output is a lead, not a finding. Every mismatch must be confirmed by reading the actual files.

## Step 3: Build a parity matrix

For each frontend ↔ backend boundary in scope, record:

```text
Boundary: <UI action/screen/client call> ↔ <backend handler/service>
Frontend source: file:line — what UI sends/assumes/renders
Backend source: file:line — what backend accepts/returns/enforces/emits
Shared contract: file:line or none
Parity: yes/no/partial/unknown
Evidence: exact field, route, status, permission, event, cache key, or state involved
```

Cover these dimensions where applicable:

| Dimension       | Frontend question                              | Backend question                                   |
| --------------- | ---------------------------------------------- | -------------------------------------------------- |
| Route/method    | Calls the right URL/action/channel?            | Handler exists and expects that method/channel?    |
| Request shape   | Sends fields/types/defaults backend expects?   | Validates/consumes those fields?                   |
| Response shape  | Renders all meaningful fields returned?        | Returns what UI expects?                           |
| Validation      | UI validation mirrors server constraints?      | Server rejects the same invalid states?            |
| Permissions     | UI hides/disables unavailable actions?         | Backend enforces the same permissions?             |
| Errors          | UI handles status/errors/messages?             | Backend returns actionable errors?                 |
| Loading/empty   | UI reflects pending/empty states?              | Backend distinguishes empty vs error?              |
| Cache/state     | UI invalidates/refetches/subscribes correctly? | Backend emits/updates what UI listens to?          |
| Realtime/events | UI listens to the right event/payload?         | Backend emits the right event/payload?             |
| Surfacing       | UI exposes useful backend capability?          | Backend capability is actually reachable by users? |
| Docs/tests      | Fixtures/docs match current behavior?          | Contract tests or examples match actual API?       |

## Step 4: Classify parity gaps

Gap types:

- **UI-MISSING** — backend capability/field/action exists but UI never exposes or renders it.
- **BACKEND-MISSING** — UI sends/calls/expects something backend does not implement.
- **SHAPE-MISMATCH** — request/response/event fields, names, types, optionality, or defaults differ.
- **VALIDATION-DRIFT** — frontend and backend allow/reject different states.
- **PERMISSION-DRIFT** — UI availability and backend authorization disagree.
- **ERROR-DRIFT** — backend returns errors/statuses UI does not handle, or UI expects errors backend never sends.
- **CACHE-DRIFT** — mutation succeeds but UI cache/state/revalidation/realtime reflection is stale or wrong.
- **EVENT-DRIFT** — emitter/listener/payload/channel disagree.
- **DOC-TEST-DRIFT** — docs, fixtures, tests, or generated clients describe old behavior.
- **VERIFY-FIRST** — plausible mismatch with exact verification path, but not proven enough to fix directly.

Do NOT track:

- subjective UI improvements
- styling/layout issues unless they hide or misrepresent backend truth
- purely backend wiring with no frontend/backend contract; use `/trace`
- public interface promises outside UI/backend parity; use `/contract`
- broad dead code/refactor cleanup; use `/sweep`
- journey feedback, dead ends, and navigation gaps found by clicking through the app; route them to `/flow`

For each gap, record:

- **WHERE**: exact frontend `file:line` and backend/shared `file:line`
- **WHAT**: precise field/action/route/event/cache/permission mismatch
- **WHY IT MATTERS**: the real user-visible or data-integrity failure
- **CONFIDENCE**: confirmed / likely / verify-first

## Step 5: Ground unfamiliar framework patterns only when needed

Use Steroids only when a parity decision depends on external/framework conventions you are not certain about, such as:

- Next/Remix/Nuxt/SvelteKit routing or server actions
- React Query/SWR/tRPC/Apollo invalidation or cache keys
- GraphQL/OpenAPI generated clients
- Electron IPC or realtime/event-bus conventions
- framework env/config exposure rules

Search the curated Steroids corpus first for literal imports, APIs, config keys, hook names, decorators, or call signatures using `action: "search"`, then inspect the selected implementation using `action: "show"`. If Steroids reports a real corpus gap, automatically call `discover` with a short topic query, present suitable repositories, and use `ask_user` for approval before `add`; never call `add` or `discover` with `add: true` before approval. After approval, add only the selected repositories, then repeat `search` and `show`. Bake any verified canonical pattern into the task. External code cannot establish local business requirements, behavior, or feature parity.

## Step 6: Merge, dedupe, and assign severity

Merge duplicate findings before task creation.

Severity:

- **Critical** — permission/security mismatch, data loss, destructive action mismatch, or frontend can trigger a broken backend path in production.
- **High** — silent wrong behavior, stale UI after successful backend mutation, backend capability unavailable to users, or real request/response shape mismatch.
- **Medium** — validation/error drift, partial UI reflection, docs/tests/generated client drift that can mislead fixes.
- **Low** — minor stale field, low-risk missing display, latent parity drift.

If the same root cause appears across multiple UI screens or handlers, create one combined task listing every affected path.

## Step 7: Create tasks automatically

For every accepted gap, add one task to the task pane with `tasks` action `add`. Do not ask for confirmation after the finding is confirmed.

Task title format: `Fix /parity: <specific mismatch> [<CANONICAL-TYPE> <file>:<line>]` (suffix required by the Audit family rules).

Every task prompt must be standalone and include:

- Severity: Critical / High / Medium / Low
- Gap type: UI-MISSING / BACKEND-MISSING / SHAPE-MISMATCH / VALIDATION-DRIFT / PERMISSION-DRIFT / ERROR-DRIFT / CACHE-DRIFT / EVENT-DRIFT / DOC-TEST-DRIFT / VERIFY-FIRST
- Canonical type from the Audit family rules
- Confidence: confirmed / likely / verify-first
- Scope/capability being fixed
- Exact frontend and backend/shared file paths + line numbers
- Parity matrix row: frontend source, backend source, shared contract, parity status
- Plain-English mismatch and why it matters
- Concrete fix direction with actual route names, field names, types, hooks, handlers, query keys, events, validators, or permission gates
- Files the fix agent should read before editing
- Whether Steroids grounding was used and which actions and external pattern supplied evidence
- Targeted verification command(s) or manual steps

Order tasks by severity, then dependency: shared contract/schema → backend handler/service → frontend client/hook → UI rendering/state → tests/docs.

Do not create vague tasks. If a mismatch is too ambiguous to fix, list it as skipped with the reason.

## Step 8: Report

Reply with:

```text
Parity scope: <resolved scope>
Chat work covered: <one short item per area, or n/a>
Scope confidence: <high|medium|low>
Boundaries checked: <N>
Files scanned: <N frontend, N backend, N shared>
Parity gaps: <N> (<N Critical, N High, N Medium, N Low>)
Tasks created: <N>
Skipped: <N>
```

Then one line per task:

```text
[High] [CACHE-DRIFT] frontend file:line ↔ backend file:line — one sentence.
[Medium] [SHAPE-MISMATCH] frontend file:line ↔ backend file:line — one sentence.
```

Then skipped items if useful:

```text
Skipped: file:line ↔ file:line — reason.
```

End with the report footer from the Audit family rules.
