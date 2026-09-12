---
argument-hint: [frontend/backend feature, natural-language scope, path, or recent — optional]
description: Audit frontend ↔ backend parity for recent work or a scoped feature. Finds UI/API shape, permission, cache, event, error, and surfaced-capability mismatches — then creates task-pane tasks.
allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user
---

# Parity

Audit whether the frontend and backend agree for a scoped capability. Default to recent work; if the user provides a natural-language scope like `calendar posting`, `auth sessions`, `billing checkout`, or `the onboarding stuff`, resolve that scope first. Do not edit project files.

`/parity` is not a general end-to-end trace. It asks a narrower question: **does one side expose, send, return, validate, authorize, cache, render, and react to the same truth as the other side?**

If concrete mismatches are found, create one task-pane task per gap automatically. Do not ask for confirmation after the finding is confirmed.

## Step 1: Resolve scope

If `$ARGUMENTS` is empty or equals `recent`, infer the feature from recent work:

1. `git status --short`
2. `git diff --name-only HEAD~1 HEAD`
3. the most recently modified `.gg/plans/*.md`
4. current conversation context

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

Task title format: `Fix /parity: <specific mismatch>`.

Every task prompt must be standalone and include:

- Severity: Critical / High / Medium / Low
- Gap type: UI-MISSING / BACKEND-MISSING / SHAPE-MISMATCH / VALIDATION-DRIFT / PERMISSION-DRIFT / ERROR-DRIFT / CACHE-DRIFT / EVENT-DRIFT / DOC-TEST-DRIFT / VERIFY-FIRST
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

If tasks were created, end with: `Tasks created. Press CTRL + T to open the task pane and run them.`
