---
argument-hint: [capability, natural-language scope, path, or recent — optional]
description: Trace recent work or a scoped capability through every project layer. Finds dropped config, missing wiring, drifted duplicates, and shape mismatches — then creates task-pane tasks for concrete gaps.
allowed-tools: tasks, Bash, Read, Grep, Glob, steroids, ask_user
---

# Trace

Trace a capability end-to-end through every layer of the project. Default to recently implemented work; if the user provides a natural-language scope like `the onboarding stuff`, `calendar posting`, `auth sessions`, or an exact path, resolve that scope first. If concrete gaps are found, create one actionable task-pane task per gap. Do not edit project files.

## Step 1: Resolve what to trace

If `$ARGUMENTS` is empty or equals `recent`, infer the trace target from recent implementation context — in this order:

1. **Git diff** — run `git status --short` and `git diff --name-only HEAD~1 HEAD` to find recently changed files.
2. **Active plan** — check `.gg/plans/` for the most recently modified plan file and read it.
3. **Session context** — use what was discussed or implemented in the current conversation.

If `$ARGUMENTS` is provided and is not `recent`, treat it as either an exact path/symbol or a natural-language scope. Do not require the user to know exact paths.

Resolve natural-language scopes by:

1. extracting likely domain terms, feature names, entity names, route words, config keys, and synonyms from the phrase
2. searching filenames and paths for those terms
3. grepping imports, route names, handlers, component names, schema/entity names, env/config keys, tests, docs headings, and command names
4. expanding to direct callers/callees, entry points, schemas, validators, serializers, tests, docs, and config around primary matches

Build a scope map:

- **Primary files** — clearly part of the capability being traced.
- **Adjacent files** — callers, callees, wrappers, schemas, validators, routes, tests, docs, config, env handling, generated API/IPC boundaries.
- **Excluded/noisy matches** — same words but unrelated.

From that, extract:

- the capability being traced, e.g. `push notifications`, `auth flow`, `skin system`, `calendar posting`
- the starting file set and terms/symbols that define the scope
- scope confidence: **high**, **medium**, or **low**

If nothing can be inferred, multiple unrelated domains match, or confidence is low enough that tracing would be guesswork, ask a clarifying question. Do not proceed blind.

## Step 2: Collect safe trace evidence

Before deep tracing, collect mechanical evidence that helps avoid missed paths:

- changed files and touched symbols from git diff/status
- import/reference hits for the capability terms and primary symbols
- entry-point discovery: API routes, UI handlers, CLI commands, server actions, cron jobs, IPC channels, webhooks, event listeners
- config/env/schema references related to the capability
- existing relevant scripts or verification commands from project config, without running installs or mutating commands

Do not install tools, download ephemeral analyzers, run migrations, generate code, mutate lockfiles, or change git state.

Analyzer/search output is a lead, not a finding. Every reported gap must be confirmed by reading the actual files in the chain.

## Step 3: Map the architecture

Identify every layer this capability touches:

`Entry Points → Orchestration → Capability Modules → External (APIs, DB, browser, network, filesystem)`

Build a map of:

- **Entry points**: API routes, UI event handlers, CLI commands, cron triggers, server actions, webhooks, IPC channels
- **Orchestration**: middleware, service layers, shared helpers, context providers, queues, event buses, adapters
- **Modules**: functions/components/classes that implement the capability
- **External**: API calls, DB queries/schema, browser APIs, filesystem, network, third-party SDKs
- **Contracts**: types, validators, schemas, env definitions, docs, public exports involved in the path

Use Glob/Grep and real imports/function calls. Do not guess at the architecture.

## Step 4: Trace every path

Starting from each entry point, follow the capability through to where it is consumed. Read each file in the chain.

Track every layer boundary in a trace matrix:

```text
Path: <entry point → destination>
Source: file:line — field/config/data/event entering
Boundary: file:line — function/call/adapter/serializer/schema crossing
Destination: file:line — where it should be consumed
Arrives? yes/no/partial
Notes: what changed, defaulted, disappeared, or diverged
```

For each path, track:

- what data/config enters at each layer
- what gets passed to the next layer
- what shape/type/defaults are applied
- what actually arrives at the destination
- whether parallel entry points behave the same way
- whether errors, permissions, env/config, and events remain wired across the boundary

Follow real imports and function calls. Do not infer a chain from naming alone.

## Step 5: Ground unfamiliar external patterns only when needed

Search the curated Steroids corpus first if a trace depends on a third-party framework/library convention you are not certain about — routing magic, server-action behavior, React Query invalidation, Electron IPC, framework env loading, decorator metadata, plugin hooks, or ORM schema generation — or if external evidence would make a concrete fix task more precise.

Call Steroids with `action: "search"` using literal routing, server-action, cache, IPC, decorator, ORM, plugin, environment-loading, import, API, config-key, or call-signature tokens. Then call `action: "show"` for each selected source and relevant line range. Prefer active, real-world examples and skip stale results.

If Steroids reports a real corpus gap, automatically call `discover` with a short topic or language query. If discovery finds repositories, use `ask_user` for approval before `add`; never call `add` or `discover` with `add: true` before approval. After approval, add only the selected repositories, repeat `search`, and confirm accepted evidence with `show`.

Use external evidence only to avoid false positives around external conventions or to bake a concrete fix recipe into a task. Local imports, callers, types, configuration, and runtime wiring remain authoritative. External evidence cannot prove local reachability, local deadness, or business behavior.

## Step 6: Find gaps

At every layer boundary, check for:

- **Dropped config** — option or flag exists at entry but never reaches the function that needs it
- **Silent defaults** — value gets replaced with a default mid-pipeline instead of being passed through
- **Partial wiring** — feature works in path A but not path B, e.g. admin route wired, portal route missing
- **Stale wrappers** — adapter or wrapper exposes a subset of the underlying interface and has fallen behind
- **Missing gates** — decision point where a check, permission, validation, or prompt should exist but does not
- **Dead exports** — module exports a function or type that nothing imports, and this matters to the traced capability
- **Shape mismatches** — data enters as one shape, gets transformed, arrives missing fields or with wrong names/types
- **Missing env wiring** — feature requires an env var/config key that is not validated, documented, or passed through
- **Schema drift** — DB schema, validator, API DTO, docs, and language type describe the same thing differently
- **Event drift** — emitter, listener, payload type, and UI/subscriber disagree or one side is missing
- **Verification gaps** — no relevant test/check/manual path can prove the traced behavior, and the gap blocks safe fixing

For each gap, record:

- **WHERE**: `file:line` at both the source end and destination end of the boundary
- **WHAT**: what gets lost, broken, defaulted, skipped, or contradicted
- **WHY IT MATTERS**: what actually fails or silently degrades as a result
- **CONFIDENCE**: confirmed / likely / needs verification

Do NOT track:

- style issues, naming conventions, or generic code quality
- theoretical problems that cannot actually be triggered
- things that work correctly end-to-end
- analyzer-only suspicions that were not confirmed by reading the chain
- unrelated dead code outside the traced capability; use `/sweep` for broader code-health cleanup

## Step 7: Merge, dedupe, and classify severity

Before creating tasks, merge duplicate findings across paths.

Resolve conflicts:

- If the same missing wire appears from multiple entry points, create one task that lists all affected paths.
- If one path is broken and another works, classify as **Partial wiring** and include both paths as evidence.
- If a finding is suspicious but not proven, create a task only if it can be framed as **VERIFY-FIRST** with exact verification steps; otherwise list it as skipped.

Severity:

- **Critical** — feature is broken, data is lost, security/permission gate is bypassed, or public behavior is a flat lie
- **High** — silent degradation, wrong behaviour in a real scenario, partial wiring across real entry points
- **Medium** — edge case failure, works in the happy path only, schema/event drift that can mislead future fixes
- **Low** — latent risk, minor drift, dead export within the traced capability that could mislead maintainers

## Step 8: Create tasks

If one or more concrete gaps were found, add one task per accepted gap to the task pane using the `tasks` tool with `action: "add"`. Do not use the `goals` tool and do not ask for confirmation.

Each task must have:

- a short title for display, for example `Fix /trace: <specific gap>`
- a standalone prompt — a fix agent with no chat context should be able to execute it

Include in every task prompt:

- Severity label: Critical / High / Medium / Low
- Gap type: Dropped config / Silent default / Partial wiring / Stale wrapper / Missing gate / Dead export / Shape mismatch / Missing env wiring / Schema drift / Event drift / Verification gap
- Confidence: confirmed / likely / verify-first
- The capability being fixed
- Exact file paths and line numbers at both ends of the gap
- The affected path(s), e.g. `entry → orchestration → module → destination`
- A plain-English description of what is wrong and why it matters
- A concrete description of what the fix looks like: actual field names, function names, import paths, route names, schema names, event names, or config keys from this project
- Any related files the fix agent should read before editing
- Whether Steroids grounding affected classification and the exact external/framework pattern it confirmed, if applicable
- The targeted verification command or manual verification steps for this gap

Order tasks: Critical first, then High, Medium, Low. Within each severity, order by dependency: types/schemas/config → core logic → integrations/routes/events → UI/docs/tests.

Do not create vague tasks. If a gap is too ambiguous to write a concrete fix for, note it in the summary as Skipped with a reason.

## Step 9: Report

Reply inline with:

```text
Traced: <capability inferred or provided>
Scope source: <recent|argument|plan|session>
Scope confidence: <high|medium|low>
Files scanned: <N primary, N adjacent>
Paths traced: <N>
Gaps found: <N> (<N Critical, N High, N Medium, N Low>)
Tasks created: <N>
Skipped: <N>
```

Then one line per task created:

```text
[Critical] [Dropped config] file:line → file:line — one sentence description.
[High]     [Partial wiring] file:line → file:line — one sentence description.
...
```

Then any skipped gaps:

```text
Skipped: file:line — reason a concrete fix couldn't be written
```

If tasks were created, end with: `Tasks created. Press CTRL + T to open the task pane and run them.`

Keep the report tight. The detail lives in the tasks.
