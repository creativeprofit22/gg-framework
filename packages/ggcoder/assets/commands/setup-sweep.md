---
argument-hint: [optional: --existing-only | --allow-ephemeral | --recommend-dev-tools]
description: Analyze the current project and generate a project-local /sweep command for scoped dead-code, refactor, and drift audits.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, LS, subagent, steroids, ask_user
---

# Setup Sweep

Analyze the current project, choose safe project-specific analyzers, then generate a local `.gg/commands/sweep.md` and `.gg/sweep.config.json`. The generated `/sweep` must accept natural-language scopes and orchestrate three audit lanes: **Prune**, **Refactor**, and **Drift**.

This command is globally available; the generated `/sweep` is project-local and tailored to the repo currently open.

## Non-negotiables

- Do **not** install dependencies, download ephemeral tools, or modify package files without explicit user confirmation.
- Prefer existing project-native tooling over new tools.
- If the project is tiny or analyzer setup would be overkill, still generate `/sweep` with the no-install baseline.
- The generated `/sweep` must not edit product code directly. It only investigates, creates task-pane tasks for concrete fixes, and reports.
- Do not create vague sweep tasks. Every generated task must be standalone, file-pinned, evidence-backed, and verifiable.
- Keep setup cheap for straightforward repos; use setup scouts only when repo shape is large, ambiguous, monorepo, or multi-stack.

## Step 1: Detect project shape

Read only the project root and obvious config files first. Do not recurse through dependency/build/vendor folders.

Detect:

- Languages and frameworks:
  - JS/TS: `package.json`, `tsconfig*.json`, `vite.config.*`, `next.config.*`, `astro.config.*`, `remix.config.*`, `svelte.config.*`, `nuxt.config.*`
  - Python: `pyproject.toml`, `requirements*.txt`, `setup.py`, `tox.ini`, `ruff.toml`, `mypy.ini`, `pyrightconfig.json`
  - Go: `go.mod`, `go.work`
  - Rust: `Cargo.toml`, `rust-toolchain.toml`
  - Ruby: `Gemfile`, `.ruby-version`
  - PHP: `composer.json`
- Package manager / runner:
  - JS/TS: `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `bun.lockb`
  - Python: `uv.lock`, `poetry.lock`, `Pipfile.lock`, `requirements*.txt`
  - Go/Rust/Ruby/PHP native commands
- Existing scripts and quality gates:
  - lint, typecheck, check, format:check, test, coverage, build, ci
- Existing analyzers already present in dependencies, scripts, config, or lockfiles.
- Repo scale:
  - approximate source file count by language
  - monorepo/workspace markers
  - generated/build/vendor folders to exclude

If no meaningful project files exist, stop and report that there is nothing to configure.

## Step 1.5: Use setup scouts only when they add value

Most projects do **not** need setup subagents. For normal single-stack repos, continue with the single-agent/programmatic setup path.

Spawn setup scouts only if one or more signals are present:

- monorepo/workspace markers: `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, Bazel files, multiple package roots, multiple app/service folders
- multiple active stacks, e.g. JS frontend + Python API + Go workers, or Electron + web + server packages
- ambiguous package managers or competing lockfiles
- more than roughly 300 source files or more than 4 likely source roots
- unclear verification strategy, e.g. several test/build scripts with no obvious canonical command
- framework magic likely affects analyzer selection, e.g. generated routes, generated API clients, codegen-heavy schemas

When scouts are warranted, spawn up to three focused subagents in parallel:

### Scout A — Stack and source roots

Prompt: "Read the project root and obvious workspace/config files only. Identify languages, frameworks, package/workspace boundaries, source roots, test roots, route/API roots, generated/vendor/build folders to exclude, and monorepo shape. Do not edit files. Return concise JSON-like findings with confidence and exact files read."

### Scout B — Analyzer and dependency tooling

Prompt: "Read project package/config files only. Identify existing dead-code, dependency, duplication, import-graph, lint, typecheck, test, build, and schema/codegen tools already available. Suggest optional ephemeral/dev tools only when appropriate for this stack. Do not edit or install. Return exact commands and whether each is safe/non-mutating."

### Scout C — Verification and CI gates

Prompt: "Read CI, scripts, Makefile/justfile, package manager config, and test/build config only. Identify canonical verification commands, release/build gates, commands that mutate or require services, and commands to avoid. Do not edit files. Return exact commands, safety notes, and confidence."

Merge scout findings with your own detection before building analyzer inventory. If scouts disagree, prefer directly observed project files over inference and record the uncertainty in `.gg/sweep.config.json` verification notes.

Do not spawn more than three setup scouts. Do not use setup scouts to audit product code quality; that happens in `/sweep`, not `/setup-sweep`.

## Step 2: Build analyzer inventory

Create a table of analyzers split into four buckets:

| Bucket                      | Meaning                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Existing local**          | Already in project dependencies/scripts/config; safe to run through package manager.                                                      |
| **Native built-in**         | Available through the language toolchain already implied by the project, e.g. `go list`, `cargo check`, `tsc` if TypeScript is installed. |
| **Ephemeral optional**      | Can run via `npx --yes`, `uvx`, `pipx run`, etc.; must ask before use/download.                                                           |
| **Dev-tool recommendation** | Worth adding as a project dev dependency, but only after explicit user approval.                                                          |

Suggested analyzer map:

### JS / TS

- Dead code / exports: `knip`, `ts-prune`, `unimported`, `tsc --noEmit` diagnostics.
- Dependencies: `knip`, `depcheck` or package-manager audit of imports/scripts/config usage.
- Duplication: `jscpd` if present or optional.
- Import graph / circulars / fan-in: `madge`, `dependency-cruiser` if present.
- Verification: existing `lint`, `typecheck`, `test`, `build` scripts.

### Python

- Dead code: `vulture` if present/approved.
- Lint/type: `ruff`, `pyright`, `mypy` if present.
- Tests: `pytest` or project-specific runner.
- Dependency usage: existing tooling only unless user approves optional tools.

### Go

- Dead/unreachable-ish signals: `go list`, `go test`, `go vet`; `staticcheck` if present/approved.
- Dependency usage: `go mod tidy -diff` if supported or non-mutating equivalent; do not run mutating `go mod tidy` without asking.
- Verification: `go test ./...`, `go vet ./...`, `golangci-lint` if present.

### Rust

- Checks: `cargo check`, `cargo test`, `cargo clippy` if present/available.
- Dependency usage: `cargo machete` or `cargo udeps` only if present/approved.
- Verification: existing cargo commands.

### Ruby / PHP / other

- Use existing project scripts/config only unless the user approves optional tooling.
- Never invent a toolchain command that is not grounded in project files.

## Step 3: Recommend setup mode

Before writing files, show the user a concise setup recommendation and ask which mode to generate:

```text
Detected: <languages/frameworks/package manager>
Setup scouts: <not needed | used Stack/Analyzer/Verification scouts with one-line reason>
Existing safe commands: <list>
Useful optional ephemeral tools: <list or none>
Useful dev-tool additions: <list or none>

Choose /sweep setup mode:
A) Existing tools only — no installs/downloads; generate /sweep now.
B) Existing tools + ask-before-ephemeral — /sweep may ask before npx/uvx/pipx one-offs.
C) Recommend dev-tool additions first — show exact package changes, wait for approval before editing.
D) Cancel.
```

Rules:

- On **A**, generate config and command using only existing/native/no-install commands.
- On **B**, include optional ephemeral commands in config with `requiresConfirmation: true`; generated `/sweep` must ask before each download/run.
- On **C**, present exact dependency additions and package-manager commands first. Do not edit or install until user approves. After approval, apply the package changes using the project’s package manager, then generate config/command.
- On **D**, stop without writing files.

If the user supplied `$ARGUMENTS`:

- `--existing-only` means choose A.
- `--allow-ephemeral` means choose B.
- `--recommend-dev-tools` means choose C, but still ask before actual package edits/installs.

## Step 4: Generate `.gg/sweep.config.json`

Create `.gg/` if needed. Write `.gg/sweep.config.json` with project-specific values, not placeholders.

Use this shape:

```json
{
  "version": 1,
  "generatedBy": "/setup-sweep",
  "project": {
    "rootName": "<directory name>",
    "languages": ["<detected languages>"],
    "frameworks": ["<detected frameworks>"],
    "packageManager": "<npm|pnpm|yarn|bun|uv|poetry|pip|go|cargo|composer|bundler|mixed|none>",
    "monorepo": false
  },
  "setup": {
    "scoutsUsed": false,
    "scoutReason": "<not needed, or why Stack/Analyzer/Verification scouts were used>",
    "confidence": "<high|medium|low>",
    "notes": ["<important setup caveats or disagreements, if any>"]
  },
  "scopeResolution": {
    "defaultMode": "recent",
    "excludeGlobs": [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "target/**",
      ".next/**",
      ".nuxt/**",
      ".venv/**",
      "vendor/**"
    ],
    "sourceGlobs": ["<actual source globs for this project>"],
    "testGlobs": ["<actual test globs for this project>"],
    "routeGlobs": ["<actual route globs if applicable>"],
    "configGlobs": ["<actual config globs>"],
    "docsGlobs": ["<actual docs globs>"]
  },
  "analyzers": {
    "safe": [
      {
        "id": "<stable id>",
        "lane": "prune|refactor|drift|verify|scope",
        "command": "<exact command>",
        "purpose": "<what evidence it produces>",
        "requiresConfirmation": false
      }
    ],
    "optional": [
      {
        "id": "<stable id>",
        "lane": "prune|refactor|drift",
        "command": "<exact ephemeral command>",
        "purpose": "<what evidence it produces>",
        "requiresConfirmation": true
      }
    ]
  },
  "verification": {
    "commands": ["<existing lint/typecheck/test/build commands that are safe and relevant>"],
    "notes": "<project-specific caveats, if any>"
  }
}
```

Omit empty arrays only if the generated `/sweep` does not depend on them; otherwise use empty arrays explicitly.

## Step 5: Generate `.gg/commands/sweep.md`

Create `.gg/commands/` if needed. Write a project-local `.gg/commands/sweep.md` using the template below, but replace bracketed placeholders with the detected project values and exact analyzer commands from `.gg/sweep.config.json`.

The generated command must include:

- Natural-language scope resolution.
- Programmatic analyzer phase.
- Three independent audit lanes: Prune, Refactor, Drift.
- Steroids rule: use curated public code only to ground unfamiliar external/framework patterns or concrete refactor recipes; never use external evidence to prove local deadness or business behavior.
- Merge/dedupe/conflict pass.
- Task creation rules with exact files and verification commands.
- Tight report format.

### Project-local `/sweep` template

````markdown
---
argument-hint: [natural-language scope | recent | --all]
description: Sweep this project for dead code, refactor opportunities, and duplicate/drifted implementations; creates concrete task-pane tasks.
allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user
---

# Sweep

Run a scoped code-health sweep for this project. Accept natural-language scopes like `the onboarding flow`, `calendar posting`, `whatever we just changed`, or exact paths. Do not edit project files.

Configured project: <detected project summary>.
Config file: `.gg/sweep.config.json`.

## Step 0: Load configuration

Read `.gg/sweep.config.json`. If it is missing or malformed, stop and tell the user to run `/setup-sweep`.

Use the configured analyzer commands exactly as written. Do not install, download, or run optional commands unless the config marks them optional and the user explicitly confirms.

## Step 1: Resolve scope

If `$ARGUMENTS` is empty or equals `recent`, resolve scope from:

1. `git status --short`
2. `git diff --name-only HEAD~1 HEAD`
3. the most recently modified `.gg/plans/*.md`
4. current conversation context

If `$ARGUMENTS` is `--all`, use the configured source, route, config, docs, and test globs for a whole-repo sweep. Warn that this is broader and may produce more findings; continue only if the user confirms.

Otherwise treat `$ARGUMENTS` as natural language. Resolve it by:

1. extracting likely domain terms, feature names, entity names, route words, and synonyms from the phrase
2. searching filenames and paths for those terms
3. grepping imports, route names, component names, schema/entity names, test names, docs headings, and config keys
4. expanding to direct callers/callees, tests, schemas, forms, routes, docs, and config around primary matches

Build a scope map:

- **Primary files** — clearly part of the requested feature/domain/path.
- **Adjacent files** — callers, callees, schemas, tests, docs, config, generated route/API boundaries.
- **Excluded/noisy matches** — same words but unrelated.

If confidence is low, multiple unrelated domains match, or the scope exceeds roughly 80 source files without `--all`, ask a clarifying question before continuing.

## Step 2: Run safe programmatic evidence collection

Run only safe configured analyzers relevant to the resolved scope. Always capture command, exit code, and concise evidence.

Use these project-configured commands when present:

<insert safe analyzer command list with purpose>

Optional commands configured for this project:

<insert optional analyzer command list with requires-confirmation notes>

Rules:

- Do not let analyzer output become findings by itself. Treat it as leads.
- If a command is whole-project only, run it only when it is safe and relevant; otherwise note why it was skipped.
- If a command fails because the project is already broken, read enough output to understand whether sweep can continue. Do not claim checks passed.

## Step 3: Dispatch three audit lanes

Use subagents when available. If subagents are unavailable, perform the lanes sequentially yourself using the same instructions.

Each lane receives:

- the scope map
- relevant analyzer evidence
- exact files to read
- configured framework/language notes
- the task creation rules below

### Lane A — Prune

Find code that can likely be removed or retired:

- unreachable files
- unused exports/functions/classes/components
- orphaned routes/pages/API handlers
- obsolete feature flags
- unused env vars/config keys
- unused deps/devDeps/scripts
- stale tests/fixtures/docs tied only to removed behavior
- dead CSS/tokens/assets when project structure supports tracing them

Classify each finding:

- **DELETE** — local evidence proves it is unused and safe to remove.
- **DEPRECATE** — public/API-facing or risky removal; needs staged migration.
- **KEEP-MAGIC** — appears unused but framework/config/runtime convention likely uses it.
- **VERIFY-FIRST** — plausible dead code but needs runtime or owner confirmation.

Do not use external evidence to prove deadness. Deadness is local to this repo.

### Lane B — Refactor

Find structural improvements with concrete payoff, not style preferences:

- duplicated logic that should be extracted or centralized
- oversized modules mixing unrelated responsibilities
- business logic living in UI/route/config layers when this project has a better local pattern
- fragile conditional trees or repeated switch/case dispatches
- repeated API clients, serializers, validators, query keys, permission checks, error mapping
- circular or high-fan-in modules that create real maintenance risk

Classify each finding:

- **EXTRACT** — pull repeated behavior into an existing or new helper/module.
- **MOVE** — relocate behavior to the layer already used elsewhere in this project.
- **SPLIT** — separate mixed responsibilities into focused modules.
- **MERGE** — collapse needless parallel implementations.
- **SIMPLIFY** — reduce branching/indirection while preserving behavior.
- **NO-TASK** — subjective style or not worth changing.

Use Steroids only when the proposed refactor depends on unfamiliar external/framework conventions. Search the curated corpus first with `action: "search"` using literal imports, APIs, or recognizable implementation anchors, then verify selected files with `action: "show"`. If Steroids reports a real corpus gap, automatically call `discover`, use `ask_user` for approval before `add`, and never call `add` or `discover` with `add: true` before approval. After approval, add only the selected repositories, repeat `search`, and use `show` on the chosen evidence. External evidence cannot establish local business behavior or prove local deadness.

### Lane C — Drift

Find duplicate concepts that disagree:

- DB schema vs validator vs TS/Python/Go/Rust type
- API DTO vs UI form model vs serializer
- duplicate defaults or feature flags
- permission checks implemented differently across routes/tools/UI
- duplicated constants, enums, status values, event names, route names, query keys
- docs/examples/tests describing old shapes

Classify each finding:

- **CONSOLIDATE** — one source of truth should replace duplicates.
- **WIRE** — a correct value/type exists but is not connected everywhere.
- **TRIM** — remove speculative or obsolete duplicate surface.
- **DOCUMENT** — useful runtime behavior exists but docs/types do not describe it.
- **DECIDE** — both versions may be valid; task must ask for a product/API decision with concrete options.

Use Steroids only to avoid false positives around standard external/framework split patterns. Search literal pattern anchors, then verify selected files with `show`; external evidence cannot establish local business rules or behavior.

## Step 4: Merge, dedupe, and reject weak findings

Combine the three lanes before creating tasks.

Reject findings that are:

- style-only
- theoretical with no trigger path
- analyzer-only with no manual confirmation
- missing exact file/line evidence
- impossible to fix without a product decision, unless classified as DECIDE with concrete options
- duplicates of a higher-quality finding from another lane

Resolve conflicts:

- If Prune says DELETE and Refactor says EXTRACT/MOVE for the same code, prefer **VERIFY-FIRST** or **DECIDE** unless deadness is proven.
- If Drift says CONSOLIDATE and Refactor says MERGE, create one combined task.
- If a fix spans more than 3–4 files or multiple concerns, split it into ordered tasks.

Severity:

- **Critical** — broken public behavior, data loss, dangerous permission/security drift.
- **High** — silent wrong behavior, real duplicated business logic drift, risky dead public surface.
- **Medium** — maintainability risk with clear trigger, stale tests/docs that mislead fixes.
- **Low** — safe cleanup, latent drift, clearly dead private code.

## Step 5: Create tasks

For every accepted finding, add one task to the task pane with `tasks` action `add`. Do not ask for confirmation after the sweep has accepted the finding.

Each task title should start with `Fix /sweep:`.

Each standalone task prompt must include:

- Lane: Prune / Refactor / Drift / Combined
- Severity: Critical / High / Medium / Low
- Classification: DELETE / DEPRECATE / VERIFY-FIRST / EXTRACT / MOVE / SPLIT / MERGE / SIMPLIFY / CONSOLIDATE / WIRE / TRIM / DOCUMENT / DECIDE
- Exact file paths and line numbers for evidence
- What is wrong and why it matters
- Concrete code-level fix direction with actual symbols, filenames, imports, commands, or config keys
- Files to read before editing
- Whether any Steroids grounding was used and what pattern/evidence it found
- Targeted verification command(s) from this project config, or manual verification steps if no command exists

Order tasks by severity, then by dependency order: types/schemas/config → core logic → integrations/routes → UI/docs/tests → cleanup.

## Step 6: Report

Reply with:

```text
Sweep scope: <resolved natural-language scope>
Scope confidence: <high|medium|low>
Files scanned: <N primary, N adjacent>
Analyzers run: <N> (<list short ids>)
Findings accepted: <N> (<N Critical, N High, N Medium, N Low>)
Tasks created: <N>
Skipped/rejected: <N>
```

Then one line per task:

```text
[High] [Drift: CONSOLIDATE] file:line — one sentence.
[Medium] [Refactor: EXTRACT] file:line — one sentence.
[Low] [Prune: DELETE] file:line — one sentence.
```

Then skipped/rejected items only if useful:

```text
Skipped: file:line — reason.
```

If tasks were created, end with: `Tasks created. Press CTRL + T to open the task pane and run them.`
````

## Step 6: Verify generated files

After writing the files:

- Re-read `.gg/sweep.config.json` and `.gg/commands/sweep.md`.
- Confirm there are no unreplaced placeholders such as `<detected...>` or `<insert...>`.
- Confirm optional commands are marked `requiresConfirmation: true`.
- Confirm no command mutates source, dependencies, lockfiles, DB, or git state without explicit confirmation.

## Step 7: Report

Reply with:

```text
Configured /sweep for: <project summary>
Generated: .gg/sweep.config.json, .gg/commands/sweep.md
Mode: <existing-only | ask-before-ephemeral | dev-tools-added>
Setup scouts: <not needed | used: Stack, Analyzer, Verification>
Safe analyzers: <N>
Optional analyzers: <N>
Verification commands: <list or none>
```

Then tell the user they can run examples like:

```text
/sweep
/sweep whatever we just changed
/sweep the onboarding flow
/sweep --all
```
