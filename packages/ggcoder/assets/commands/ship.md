---
argument-hint: [recent, natural-language scope, path, or --all — optional]
description: Production-readiness gate for recent work or a scoped release. Runs safe local evidence collection, checks blast radius, trace/parity risks, config/build/runtime blockers, and creates task-pane tasks.
allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user
---

# Ship

Run a production-readiness gate for recent work or a scoped release. Default to recent implementation changes. Accept natural-language scopes like `the onboarding release`, `billing checkout`, `calendar posting`, or exact paths. Do not edit project files.

`/ship` is the boss gate: it combines deterministic project checks with agentic judgment about release risk. It should create one task-pane task per confirmed blocker or release-risk gap.

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

**Scope.** Accept an empty argument, `recent`, a natural-language scope, or an exact path or symbol. For empty or `recent`, infer scope from `git status --short` and `git diff --name-only HEAD~1 HEAD`, then the most recently modified `.gg/plans/*.md`, then conversation context. If confidence is low or unrelated areas match, ask with `ask_user` before proceeding.

**Read-only.** Do not edit project files. Installs, code generation, migrations, starting servers, or any other project-changing command need explicit approval through `ask_user` first. The `allowed-tools` frontmatter is advisory: the command runtime does not enforce it, so this no-edit rule is enforced by instruction only.

**Report footer.** After the command's summary block, add `Routed: <N>` and `Already tracked: <N>`, with one line per entry when non-zero. If tasks were created, end with: `Tasks created. Open the task list (Ctrl+T in the terminal, or the Tasks button in the desktop app) and run them.`

## Step 0: Safety model

If the project keeps a verification status handoff (for example `.gg/verification/current-status.md`) or its project instructions require reading one before a release gate, read it and the linked evidence first. Treat it as historical evidence to reconcile with current results, not as a current pass.

Do not mutate the project unless the user explicitly approves a specific command.

Allowed without extra confirmation when clearly relevant:

- read files
- `git status --short`
- `git diff --name-only HEAD~1 HEAD`
- `git diff --stat`
- safe existing scripts such as lint/typecheck/test/build/check when they do not install, migrate, generate, deploy, or rewrite files

Ask before running:

- installs or downloads, including `npm install`, `pnpm add`, `npx --yes`, `uvx`, `pipx`, `cargo install`
- migrations, seed scripts, codegen that writes files, formatters with write mode, autofixers
- destructive or deployment commands
- whole-repo expensive checks if scope is small and the command may be slow

If a command fails, read the failure and classify it. Do not claim it passed.

## Step 1: Resolve release scope

If `$ARGUMENTS` is empty or equals `recent`, infer release scope from recent changes:

1. `git status --short`
2. `git diff --name-only HEAD~1 HEAD`
3. the most recently modified `.gg/plans/*.md`
4. current conversation context

If `$ARGUMENTS` is `--all`, warn that this is a broad release gate and may be slower/noisier. Continue only after confirmation.

Otherwise treat `$ARGUMENTS` as natural language or exact paths. Resolve by:

1. extracting feature/domain/entity/route/config terms
2. searching filenames/paths
3. grepping handlers, components, API clients, schemas, env/config keys, migrations, tests, docs, jobs/events, and scripts
4. expanding to direct callers/callees, UI/API boundaries, DB/schema, config/env, tests, docs, and deployment/build files

Build a release scope map:

- **Changed/primary files** — directly in the release scope.
- **Runtime boundaries** — entry points, handlers, jobs, events, browser/API/DB/filesystem/network surfaces.
- **Contracts** — types, schemas, validators, generated clients, docs, env definitions.
- **Verification assets** — tests, scripts, CI workflows, build configs, e2e specs.
- **Adjacent risk files** — callers/callees and consumers likely affected.

If scope confidence is low or multiple unrelated release areas match, ask a clarifying question.

## Step 2: Detect project gates and production surfaces

Read root/config files to detect:

- language/framework/package manager
- scripts for lint, typecheck, test, coverage, build, start, e2e, check, ci
- CI workflows and deployment config
- env examples/validation/config loaders
- database/schema/migration tooling
- API/schema generation tooling
- error reporting/logging/observability config
- auth/permission middleware
- feature flags
- background jobs/queues/cron/webhooks/realtime events

Do not require a perfect app-wide inventory; focus on the release scope and adjacent risk.

## Step 3: Run safe programmatic gates

Run existing safe commands that are relevant to the scope. Prefer project-native commands already present in scripts/config.

Typical gates, if present and safe:

- lint/check
- typecheck/static analysis
- unit/integration tests relevant to the scope
- full tests if reasonable for project size
- build/compile
- schema/API client check if non-mutating
- e2e smoke tests only if configured and the app/driver is already available

For each command, record:

```text
Command: <exact command>
Exit: <code>
Relevant output: <short summary>
Release impact: pass/fail/blocked/skipped
```

Skipped gates must have reasons, e.g. missing script, requires service, mutating, needs install, too broad without confirmation.

Programmatic failures become ship blockers only after you read enough output to identify a concrete fix task.

## Step 4: Run release-risk lanes

Use subagents when useful. If unavailable, perform these lanes sequentially.

Each lane receives the release scope map, command output, and exact files to read.

### Lane A — Build and runtime readiness

Check:

- build/type/lint/test failures
- imports that only fail at runtime or production build
- client/server boundary mistakes
- environment variable validation/documentation/defaults
- config files not wired into runtime
- migrations/schema changes without matching code/tests/docs
- background jobs, cron, queues, webhooks, realtime events affected by the change
- deployment/CI scripts that do not run the relevant checks
- production-only branches, feature flags, or NODE_ENV/env-specific behavior

Classify findings:

- **BUILD-BLOCKER** — build/type/lint/test/check fails in a release-relevant way.
- **RUNTIME-BLOCKER** — production path can crash or misbehave.
- **CONFIG-BLOCKER** — env/config/migration/deployment requirement is missing or unwired.
- **CI-GAP** — release-relevant check exists locally but is absent from CI, or CI runs the wrong command.
- **VERIFY-FIRST** — exact production-risk suspicion needs a targeted manual/check step before fixing.

### Lane B — Trace-style wiring risk

Trace the release capability through its real layers, but only for release-risk gaps. Check:

- dropped config/options
- silent defaults
- missing gates/permissions/validation
- partial wiring across entry points
- stale wrappers/adapters
- shape/schema/event drift
- missing error handling in release paths

This lane overlaps with `/trace`, but `/ship` should stay release-focused: only create tasks for gaps that can block or degrade shipping.

Classify findings:

- **WIRING-BLOCKER** — capability is not connected end-to-end in a release path.
- **PARTIAL-SHIP** — works in one real entry point but not another.
- **DATA-SHAPE-RISK** — shape drift can break runtime or silently lose data.
- **GATE-RISK** — validation/auth/permission/prompt gate missing or mismatched.

### Lane C — Parity-style frontend/backend risk

If the release scope has both frontend and backend surfaces, check parity:

- UI sends fields backend accepts and consumes
- UI renders meaningful backend response fields
- backend returns what UI expects
- frontend/server validation agree
- permissions agree
- errors/loading/empty states are handled
- cache invalidation/realtime/event reflection is wired
- generated clients/docs/tests are current

This lane overlaps with `/parity`, but `/ship` should focus on release blockers, not every parity cleanup.

Classify findings:

- **PARITY-BLOCKER** — frontend/backend mismatch breaks or hides release behavior.
- **STALE-UI** — backend mutation succeeds but UI does not reflect it.
- **API-CLIENT-DRIFT** — generated/manual client contract is stale.
- **ERROR-UX-BLOCKER** — production failure path leaves users stranded or misled.

### Lane C2 — Contract and journey risk

For public surfaces in scope, check whether promises still hold: documented CLI flags, exported types, config schemas, and public APIs the release changes or depends on. If the release has a UI, a live driver is already available, and the change affects a user journey, smoke the primary journey end-to-end; otherwise record the journey check as skipped with a reason. Do not install drivers or start servers without approval.

This lane overlaps with `/contract` and `/flow`, but `/ship` only tasks gaps that affect shipping.

Classify findings:

- **CONTRACT-BLOCKER** — a public promise used by the release is ignored, stubbed, or documented-only.
- **JOURNEY-BLOCKER** — the primary release journey breaks, dead-ends, or gives no feedback.

### Lane D — Regression blast radius

Ask: what could the scoped change have broken elsewhere?

Check:

- changed exported symbols and all consumers
- changed schemas/types and serializers/forms/tests/docs using them
- changed routes/handlers and clients/tests/docs hitting them
- changed config/env and deploy/runtime consumers
- changed auth/permissions and affected screens/tools/API routes
- removed/renamed files and imports/scripts/docs/tests referencing them

Classify findings:

- **REGRESSION-RISK** — downstream consumer is likely broken by the change.
- **CONSUMER-DRIFT** — caller/test/doc still assumes old contract.
- **UNTESTED-BLAST-RADIUS** — no targeted check covers a high-risk changed path; use only when a concrete verification task can be written.

## Step 5: Ground unfamiliar external patterns only when needed

Search the curated Steroids corpus first when a release-risk decision depends on external framework conventions you are not certain about, such as:

- production build/server-client boundary rules
- framework routing/loaders/actions/cache invalidation
- generated API clients
- ORM migration/schema conventions
- auth middleware conventions
- deployment/runtime config conventions

Call Steroids with `action: "search"` using literal imports, build keys, route APIs, migration calls, middleware symbols, deployment settings, config keys, hook names, decorators, or call signatures. Then call `action: "show"` for each selected source and relevant line range.

If Steroids reports a real corpus gap, automatically call `discover` with a short topic or language query. If discovery finds repositories, use `ask_user` for approval before `add`; never call `add` or `discover` with `add: true` before approval. After approval, add only the selected repositories, repeat `search`, and confirm accepted evidence with `show`.

Bake verified external patterns into tasks only when they inform a concrete fix. Local build, test, runtime, repository, and configuration evidence remains authoritative for release behavior. External evidence cannot prove local release behavior, business rules, readiness, or safety.

## Step 6: Merge, dedupe, and classify release severity

Merge all lane findings before creating tasks.

Reject findings that are:

- style-only
- speculative with no trigger path
- analyzer-only with no file/line evidence
- unrelated to the release scope
- broad architecture wish-list items better suited for `/sweep`
- ordinary trace/parity findings that do not affect shipping safety

Resolve overlaps:

- If Build lane and Trace lane point to the same root cause, create one combined blocker task.
- If Parity lane and Regression lane point to stale client/consumer drift, create one combined task.
- If an open task from `/trace`, `/parity`, `/contract`, or `/flow` already covers the finding, do not duplicate it; list it under `Already tracked` and, if it blocks release, say so in the ship status.
- If a fix spans more than 3–4 files or multiple concerns, split into ordered tasks.

Severity:

- **Critical** — cannot ship: build/test/typecheck fails, crash/data loss, security/permission issue, broken migration/config/deploy path.
- **High** — likely production degradation: broken core flow, stale UI after successful mutation, API/client drift, missing release-critical validation/error handling.
- **Medium** — edge release risk, missing targeted verification for high-impact path, docs/tests/fixtures stale enough to mislead release fixes.
- **Low** — low-risk cleanup that should not block release but should be tracked.

Ship decision labels:

- **BLOCK** — should not ship until fixed.
- **FIX-BEFORE-SHIP** — important but may be scoped by user decision.
- **VERIFY-BEFORE-SHIP** — exact verification required before release.
- **TRACK** — non-blocking follow-up.

## Step 7: Create tasks automatically

For every accepted finding, add one task to the task pane using `tasks` action `add`. Do not ask for confirmation after the release blocker/risk is confirmed.

Task title format: `Fix /ship: <specific blocker> [<CANONICAL-TYPE> <file>:<line>]` (suffix required by the Audit family rules).

Every task prompt must be standalone and include:

- Ship decision: BLOCK / FIX-BEFORE-SHIP / VERIFY-BEFORE-SHIP / TRACK
- Severity: Critical / High / Medium / Low
- Lane: Build/runtime / Trace wiring / Parity / Contract & journey / Regression / Combined
- Classification: BUILD-BLOCKER / RUNTIME-BLOCKER / CONFIG-BLOCKER / CI-GAP / WIRING-BLOCKER / PARTIAL-SHIP / DATA-SHAPE-RISK / GATE-RISK / PARITY-BLOCKER / STALE-UI / API-CLIENT-DRIFT / ERROR-UX-BLOCKER / CONTRACT-BLOCKER / JOURNEY-BLOCKER / REGRESSION-RISK / CONSUMER-DRIFT / UNTESTED-BLAST-RADIUS / VERIFY-FIRST
- Canonical type from the Audit family rules, and the owner command (`/trace`, `/parity`, `/contract`, `/flow`, or `/ship`)
- Exact file paths and line numbers for the evidence
- Relevant command output if a programmatic gate failed
- What is wrong and why it affects release safety
- Concrete fix direction with actual symbols, route names, field names, imports, config keys, commands, or test names
- Files the fix agent should read before editing
- Whether Steroids grounding was used and what external pattern it informed
- Targeted verification command(s) or manual release verification steps

Order tasks:

1. Critical BLOCK tasks
2. High BLOCK/FIX-BEFORE-SHIP tasks
3. VERIFY-BEFORE-SHIP tasks
4. Medium/Low TRACK tasks

Within each group, order by dependency: config/env/migrations → contracts/types/schemas → backend/core → frontend/client/UI → tests/docs/CI.

Do not create vague tasks. If a release concern is too ambiguous to fix, list it as skipped with a reason and exact verification needed.

## Step 8: Report ship status

Reply with:

```text
Ship scope: <resolved scope>
Scope confidence: <high|medium|low>
Mode: <recent|argument|all>
Files scanned: <N primary, N adjacent>
Gates run: <N> passed, <N> failed, <N> skipped
Release findings: <N> (<N Critical, N High, N Medium, N Low>)
Tasks created: <N>
Ship status: <BLOCKED|VERIFY FIRST|TRACK ITEMS|CLEAR>
```

Then one line per task:

```text
[BLOCK] [Critical] [BUILD-BLOCKER] file:line — one sentence.
[FIX-BEFORE-SHIP] [High] [PARITY-BLOCKER] file:line — one sentence.
[VERIFY-BEFORE-SHIP] [Medium] [UNTESTED-BLAST-RADIUS] file:line — one sentence.
```

Then skipped items if useful:

```text
Skipped: file:line — reason and exact verification needed.
```

End with the report footer from the Audit family rules.

If no findings were found and all relevant gates passed, say `Ship status: CLEAR` but only for the scope checked; do not imply the entire project is production-safe unless `--all` was used and completed.
