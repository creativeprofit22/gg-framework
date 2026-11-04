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

Manifests are often nested. Also check workspace members and one or two directory levels below the root (e.g. `packages/*/`, `apps/*/`, `*/src-tauri/Cargo.toml`, `services/*/pyproject.toml`) so a secondary stack is not missed.

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
  - generated/build/vendor folders to exclude, including per-package copies (`**/dist`, `**/node_modules`, `**/target`)
  - tool state, backups, or snapshot folders that contain copies of source (e.g. `.gg/`), which would otherwise surface as fake duplicates or drift
- Tracked files that need a reading tier other than source:
  - generated or vendored files committed to git (codegen output, lockfile-like snapshots, bundled third-party code, minified assets)
  - data folders: JSON/YAML/CSV fixtures, i18n strings, schema or seed data
- Cross-area pairs, i.e. two places that must agree:
  - Rust and TypeScript sharing types or commands (e.g. `src-tauri` + a frontend: serde structs vs TS types, `generate_handler!` vs `invoke` names)
  - lists that must match: mirrored enums, registries, status values, event names
  - docs that describe code: command/flag/config references, examples

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

Prompt: "Read project package/config files only. Identify existing dead-code, dependency, duplication, import-graph, lint, typecheck, test, build, and schema/codegen tools already available. Suggest optional ephemeral/dev tools only when appropriate for this stack. Never propose fix, format-write, or codegen commands as analyzers. Do not edit or install. Return exact commands, whether each is safe/non-mutating, and whether each runs on given files, one package, or the whole repo."

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
- Dead code: `dead_code`/`unused_*` warnings from `cargo check`/`cargo clippy` are leads; trace callers with `git grep` on `use crate::<path>`, `mod <name>`, and the symbol name. For Tauri, also check `generate_handler!` registrations and frontend `invoke("...")` names.
- Always pass `--manifest-path` when `Cargo.toml` is not at the repo root.
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
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/target/**",
      "**/.next/**",
      "**/.nuxt/**",
      "**/.venv/**",
      "**/vendor/**",
      ".gg/**",
      "<detected tool-state, snapshot, or generated folders>"
    ],
    "sourceGlobs": ["<actual source globs for this project>"],
    "testGlobs": ["<actual test globs for this project>"],
    "routeGlobs": ["<actual route globs if applicable>"],
    "configGlobs": ["<actual config and data globs>"],
    "docsGlobs": ["<actual docs globs>"],
    "generatedGlobs": ["<tracked generated or vendored globs>"]
  },
  "readingTiers": {
    "source": "full",
    "test": "light",
    "docs": "light",
    "config": "light",
    "generated": "automated"
  },
  "readingDepth": {
    "full": "Open every assigned line range with the read tool and check it for all three lanes: Prune, Refactor (with the refactoring skill's thresholds) and Drift.",
    "light": "Open every assigned line range with the read tool, but check only this list: references to files, symbols, commands or config keys that no longer exist; tests, fixtures or data for removed behavior; docs, examples or data that disagree with the code; values that must match code (enums, event names, defaults). Skip the Refactor smell review.",
    "automated": "Not opened by helpers. Covered only by the configured analyzers and the planner's file hashes; reported as automated checks only, never as read."
  },
  "crossArea": {
    "pairs": [
      {
        "kind": "rust-ts-types|must-match-list|docs-vs-code",
        "a": "<path or glob>",
        "b": "<path or glob>",
        "note": "<what must agree>"
      }
    ]
  },
  "analyzers": {
    "safe": [
      {
        "id": "<stable id>",
        "lane": "prune|refactor|drift|verify|scope",
        "command": "<exact command>",
        "coverage": "files|package|repo",
        "purpose": "<what evidence it produces>",
        "requiresConfirmation": false
      }
    ],
    "optional": [
      {
        "id": "<stable id>",
        "lane": "prune|refactor|drift",
        "command": "<exact ephemeral command>",
        "coverage": "files|package|repo",
        "purpose": "<what evidence it produces>",
        "requiresConfirmation": true
      }
    ]
  },
  "skip": [],
  "verification": {
    "commands": ["<existing lint/typecheck/test/build commands that are safe and relevant>"],
    "notes": "<project-specific caveats, if any>"
  }
}
```

Omit empty arrays only if the generated `/sweep` does not depend on them; otherwise use empty arrays explicitly.

Field rules:

- `coverage` says what a command checks: `files` (accepts file paths), `package` (one workspace package), or `repo` (whole repository). Prefer a `files` or `package` variant whenever the tool supports one.
- Commands that take runtime input use curly placeholders that `/sweep` fills in: `{files}` for scoped paths and `{name}` for a module or symbol name. Never use angle brackets in generated commands.
- `skip` starts empty. The user adds `{ "path": "<file>", "symbol": "<optional name>", "reason": "<why>" }` entries for findings they have accepted or rejected, so later sweeps do not re-raise them.
- Tier globs decide how each file is read. The planner checks them in this order and the first match wins: `generatedGlobs` → `testGlobs` → any `commands/*.md` (always source) → `configGlobs` → `docsGlobs` → `sourceGlobs`/`routeGlobs`. Data files (fixtures, i18n, schema or seed data) go in `configGlobs`. Tracked generated or vendored files go in `generatedGlobs`; build output that is not tracked stays in `excludeGlobs`.
- `readingTiers` maps each planner tier (`source`, `test`, `docs`, `config`, `generated`) to `full`, `light` or `automated`. Keep the defaults above unless the user asks otherwise: source and command files are read in full; tests, docs and data are read lightly; generated files get automated checks only.
- `readingDepth` holds the exact text helpers follow for each depth. Copy it unchanged: "light" still opens every assigned line, so read counts stay honest.
- `crossArea.pairs` lists the detected pairs that must agree. Use an empty array when there are none.

## Step 4.5: Check every file has a tier

Run the sweep planner against the new config:

```bash
node "${GG_AGENT_DIR:-$HOME/.gg}/scripts/sweep-plan.mjs" --out .gg/sweep/setup-check.json
```

- Exit 0: every tracked file has a tier or is excluded. Continue.
- Exit 2: **stop.** The planner lists files that match no pattern. Group them by folder and extension, then use `ask_user` once per group: source, test, docs, config/data, generated, or exclude, with your recommended pick marked. Add the answers to the matching globs in `.gg/sweep.config.json` and run the planner again until it exits 0. Never guess a tier.
- Exit 1 because the script is missing or the folder is not a git repository: do not guess. Note in the Step 7 report that `/sweep --all` will not be available until it is fixed (reinstalling GG Coder's `/setup-sweep` installs the scripts into `~/.gg/scripts/`).
- Exit 1 or 3 for any other reason: show the error and fix the config before continuing.

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
- Whole-repo `--all` runs: plan, shared notes, waves of helpers, the read ledger with one retry, and one cross-area pass.
- Honest counts: in scope, read (receipt-backed, by tier), automated checks only, unread with causes.
- `--resume` from `.gg/sweep/plan.json` and `ledger.json` in a fresh session.

### Project-local `/sweep` template

````markdown
---
argument-hint: [natural-language scope | recent | --all | --resume | --map [focus] | --merge]
description: Sweep this project for dead code, refactor opportunities, and duplicate/drifted implementations; creates concrete task-pane tasks.
allowed-tools: tasks, Bash, Read, Grep, Glob, LS, subagent, steroids, ask_user, spawn_agent, wait_agent, Write
---

# Sweep

Run a scoped code-health sweep for this project. Accept natural-language scopes like `the onboarding flow`, `calendar posting`, `whatever we just changed`, or exact paths. Do not edit project files; the only files a sweep writes are run-state files under `.gg/sweep/` for `--all` and `--resume`.

Configured project: <detected project summary>.
Config file: `.gg/sweep.config.json`.

## Step 0: Load configuration

Read `.gg/sweep.config.json`. If it is missing or malformed, stop and tell the user to run `/setup-sweep`.

Use the configured analyzer commands exactly as written. Do not install, download, or run optional commands unless the config marks them optional and the user explicitly confirms.

## Modes: `--map` and `--merge`

These modes replace Steps 1–6. Both are read-only for project files; they only add or remove task-pane tasks.

Whole-codebase workflow: commit → `/sweep --map` → run every `Sweep:` task (read-only, safe back to back) → `/sweep --merge` → run `Fix /sweep:` tasks one at a time, committing after each.

### `--map [optional focus]`

Split the codebase into sweep areas so the user never has to pick scopes. If text follows `--map`, map only that part of the codebase.

1. If `git status --short` shows uncommitted changes, say sweeps should start from committed work and suggest `/commit`; continue anyway.
2. List candidate areas along package, workspace, and top-level folder boundaries, using the configured source globs and `excludeGlobs` when a config exists. Count source files per area with `git ls-files`. Split any area over ~80 source files; fold areas under ~5 files into a neighbor.
3. Give every source file exactly one owning area, so shared code is swept once.
4. Add one `cross-area contracts` area: types, schemas, API/IPC shapes, events, and constants imported by two or more areas. Its sweep focuses on Drift.
5. Create one task per area with `tasks` action `add`. Title: `Sweep: <area>`. Prompt: `/sweep <plain description of the area> — folders: <globs>. Create tasks only for files this area owns; list findings in other areas' files in the report instead.` Add shared foundations first, then core logic, then app/UI areas, then `cross-area contracts`.
6. Report a table (area, folders, source files, recent changes from the hotspot count) and the workflow line above. End with: `Next: run the Sweep: tasks (CTRL + T opens the task pane). When the last one finishes, run /sweep --merge.`

### `--merge`

Run once after all area sweeps finish and before fixing anything.

1. `tasks` action `list`. Consider only pending tasks titled `Fix /sweep:`; never touch other tasks. If fewer than two, report and stop.
2. Group tasks that cite the same files or symbols. Within a group: remove exact duplicates, keeping the most concrete; replace overlapping changes to the same code with one combined task that keeps all evidence and verification commands; turn conflicting directions (e.g. DELETE vs EXTRACT) into one VERIFY-FIRST or DECIDE task. Re-read cited lines and drop tasks whose code no longer exists.
3. Order survivors by severity, then dependency order, with Prune before Refactor on the same files. The task pane keeps creation order, so if the order changed, remove and re-add the survivors in the final order with their prompts unchanged.
4. Report before/after counts, each merge with its reason, and the final order. End with: `Run the tasks one at a time and commit after each. Press CTRL + T to open the task pane.`

## Whole-repo run: `--all` and `--resume`

These replace Steps 1–3; the run then continues with Steps 4–6. Every in-scope file is read once, in chunks, and the run keeps its state in `.gg/sweep/` so a fresh session can finish it.

- Planner: `node "${GG_AGENT_DIR:-$HOME/.gg}/scripts/sweep-plan.mjs"`. Ledger (checks which planned lines helpers really read): `node "${GG_AGENT_DIR:-$HOME/.gg}/scripts/sweep-ledger.mjs"`. If either is missing, stop and tell the user to re-run `/setup-sweep`.
- State files, the only files this run writes:
  - `.gg/sweep/plan.json`, `.gg/sweep/ledger.json`: written by the scripts.
  - `.gg/sweep/helpers.json`: `[{ agentId, chunk, state, error, receipt, transcript }]`, one record per finished helper, the fields `wait_agent` returned plus the chunk id.
  - `.gg/sweep/run.json`: `{ "stage": "plan|waves|ledger|retry|cross-area|tasks|done", "wave": 0, "updated": "ISO time" }`.
  - `.gg/sweep/notes.md`, `.gg/sweep/analyzers.md`.
  - `.gg/sweep/findings/{chunk}--{agentId}.json`: one file per helper reply, so a retry or a later plan that reuses a chunk id never replaces earlier findings. Never overwrite a findings file.
  - `.gg/sweep/findings.prev/`: findings from earlier plans of this run, moved there by **Resume rules** step 2.

### W1. Start or resume

1. If `git status --short` shows uncommitted changes, say sweeps should start from committed work and suggest `/commit`; continue anyway. For `--all`, confirm with `ask_user` that a whole-repo sweep is wanted (it is broad and creates more tasks).
2. `--resume` with no unfinished run (`.gg/sweep/run.json` missing or its stage `done`): say so and stop.
3. If `.gg/sweep/run.json` exists and its stage is not `done`, use `ask_user`: resume that run (recommended) or start fresh. Resuming: apply **Resume rules** below, then continue at the stage `run.json` names.
4. Start fresh when the user chose it, or for `--all` when `run.json` is missing or its stage is `done`: before W2, move any existing `plan.json`, `ledger.json`, `helpers.json`, `run.json`, `notes.md`, `analyzers.md`, `*.prev.json`, `findings/` and `findings.prev/` from `.gg/sweep/` into `.gg/sweep/old-{YYYYMMDDHHMMSS}/`. Leave `setup-check.json` in place. A finished run's helper records, findings and ledger belong to its plan, and chunk ids repeat between plans, so keeping them would skip new chunks and fail the ledger.

### W2. Plan

Run the planner. It reads `.gg/sweep.config.json` and writes `.gg/sweep/plan.json`.

- Exit 2: stop. List the files it prints, grouped by folder, and tell the user to add them to a tier glob or `excludeGlobs` in `.gg/sweep.config.json`, or re-run `/setup-sweep`. Never guess a tier.
- Exit 1 or 3: stop and show the error.
- Exit 0: continue. `plan.counts` holds the in-scope counts (`byTier`, `binary`). On a fresh run, write `[]` to `.gg/sweep/helpers.json` and set `run.json` stage to `plan`, so the ledger always has a helpers file, even when a session dies during the first wave or W4 starts no helpers because every tier is `automated`.
- Chunks are sized by lines and by characters as `read` shows them (`chunkChars`, default 180,000), so a helper that opens all its ranges in one turn stays under the engine's per-turn tool-result cap of 240,000 characters. Models with smaller context windows get a lower cap, as low as 100,000; for them, set `sweepPlan.chunkChars` in `.gg/sweep.config.json` under that cap. Report the planner's `largest chunk` line with the plan counts.

### W3. Analyzers and shared notes

Run the safe analyzers once over the repo (Step 2 rules) and save each command, exit code and the concise leads per file to `.gg/sweep/analyzers.md`. Load the `refactoring` skill, then write `.gg/sweep/notes.md`, which every helper gets: the project summary; the `readingDepth` text for each tier from the config; the Lane A–C checklists and classifications from Step 3; the refactoring skill's thresholds; the `skip` list; the Steroids rules; the findings format below.

### W4. Waves

A chunk is **pending** only when all of these hold: its tier is not marked `automated` in `readingTiers`; it has no record in `helpers.json`; and, when `ledger.json` exists for the current `plan.json`, at least one of its ranges there (ranges whose `chunk` is its id) has a status other than `read` or `automated`. So a chunk whose ranges the ledger already marks read, such as reads carried over by **Resume rules** step 2, is not sent again. Unread ranges of chunks that already have a `helpers.json` record go only through W6's single retry, never back through W4. Hand them out in waves of up to 8 helpers, the engine's `ACTIVE_LIMIT`: one `spawn_agent` call per wave, one task per chunk. If the engine refuses a task (for example a per-model cap), move that chunk to the next wave; never resend a refused wave unchanged.

Each task gets `context_files: [".gg/sweep/notes.md"]` and a prompt with:

- the chunk id and its depth from `readingTiers` (`full` or `light`)
- the exact entries; open each with `read`, using `offset` = start and `limit` = end − start + 1
- the analyzer leads for those files from `analyzers.md`
- these rules: cover Prune, Refactor and Drift for these files only (read other files only to confirm a lead); do not edit files, spawn helpers, or run commands that change anything; only the `read` tool counts as reading, so never use shell or search output in place of reading an assigned range.

Findings format, the helper's whole reply: one fenced `json` block, then a final line `END-SWEEP-FINDINGS`.

```json
{
  "chunk": "source-001",
  "findings": [
    {
      "lane": "prune|refactor|drift",
      "classification": "DELETE",
      "severity": "High",
      "file": "src/a.ts",
      "line": 42,
      "evidence": "what the lines show",
      "fix": "concrete fix direction",
      "verify": "command or manual check"
    }
  ],
  "crossArea": [
    {
      "kind": "rust-ts-types|must-match-list|docs-vs-code",
      "here": "src/a.ts:10",
      "other": "src-tauri/src/x.rs",
      "note": "what must agree"
    }
  ],
  "checked": ["src/a.ts"]
}
```

At most 25 findings (keep the strongest), each text field at most 300 characters, and the whole reply under 30,000 characters, because the engine cuts longer helper output.

### W5. Collect

Wait with `wait_agent` for one `agent_id` at a time: one call caps its total output at 60,000 characters, so waiting on several helpers at once cuts the later ones short. A chunk is **partial** when its output contains `[output truncated at`, lacks the `END-SWEEP-FINDINGS` line, or its JSON does not parse; keep whatever findings do parse. After each wave, append one record per helper to `helpers.json`, save its reply to `findings/{chunk}--{agentId}.json` (with `"partial": true` when partial), and update `run.json`. Retries reuse chunk ids, so the agent id keeps every attempt's file; never overwrite or merge into an existing findings file.

### W6. Ledger and one retry

Run the ledger with `--plan .gg/sweep/plan.json --helpers .gg/sweep/helpers.json`, plus `--previous .gg/sweep/ledger.json` when that file exists (`--previous` applies only to a ledger written for the current `plan.json`; W1 moves older ledgers away), plus one `--automated-tier {tier}` for each tier `readingTiers` marks `automated`.

- Exit 0: every planned range was read or has automated checks only.
- Exit 4: hand out the chunks in `ledger.retry`, plus partial chunks with a request for compact output (at most 10 findings), **once**, in waves as in W4–W5. Then run the ledger again with the same flags plus `--final`. Do not retry again; whatever stays unread is reported with its cause.
- Exit 1: stop and show the error.

### W7. Cross-area pass

Spawn one more helper. It is not a plan chunk, so it gets no `helpers.json` record. Give it `crossArea.pairs` from the config plus the helpers' `crossArea` leads (deduplicated, at most 40), and have it check things that compare two places:

- Rust vs TypeScript types: serde structs and enums vs the TypeScript types they cross into (field names after `rename_all`, optional vs required), `generate_handler!` registrations vs frontend `invoke("...")` names, emitted event names vs listeners.
- Lists that must match: mirrored enums, registries, status values, event names, config keys.
- Docs vs code: commands, flags, config keys and paths in docs that no longer match the code.

It uses the same findings format and limits with `"chunk": "cross-area"`; save its reply to `findings/cross-area--{agentId}.json`.

### W8. Tasks and report

Set `run.json` stage to `tasks`. Run Steps 4–5 over every file in `findings/` and `findings.prev/`, one findings file at a time to keep context small. A chunk can have several files (a partial first attempt and its retry, or an earlier plan's chunk with the same id); Step 4's dedupe merges their repeated findings, so read all of them rather than only the newest; the pending `Fix /sweep:` check in Step 4 stops a resumed run from adding tasks twice. Set the stage to `done`, then report with Step 6, taking counts from `plan.json` and the final `ledger.json` (`counts.byTier` for files; the Unread causes per file as Step 6 says, since `counts.byCause` counts line ranges).

### Resume rules

Never trust an old read of a changed file.

1. Read `run.json`, `plan.json` and `ledger.json`. If `helpers.json` is missing, write `[]` to it first. Compare `git rev-parse HEAD` with `plan.gitCommit`, and run the ledger as in W6 (without `--final`); it re-hashes every planned file and marks changed ranges `changed-since-plan`. Exit 4 is expected here (ranges are still unread): continue. Exit 1: stop and show the error.
2. If HEAD differs or `counts.byCause` shows any `changed-since-plan`: move `plan.json` to `plan.prev.json`, `ledger.json` to `ledger.prev.json` and `helpers.json` to `helpers.prev.json`; re-run the planner (handle its exit codes as in W2); write `[]` to `helpers.json`; then run the ledger with `--helpers .gg/sweep/helpers.json --previous .gg/sweep/ledger.prev.json --previous-plan .gg/sweep/plan.prev.json --final` plus the `--automated-tier` flags. This `--final` run normally exits 4, because the new plan's unread ranges wait for W4; continue. Exit 1: stop and show the error. Only reads of unchanged files carry over. Move every file in `findings/` into `findings.prev/` (names include the agent id, so they never collide with files already there), then remove from those moved files the `findings` and `crossArea` entries whose file changed (`changed-since-plan`). New chunk and retry ids restart from 001 and reuse old names, so findings for unchanged files must not stay in `findings/`; their reads carried over and they will not be read again.
3. Continue at W4 with the chunks that are **pending** under W4's rule (no `helpers.json` record and, in the current `ledger.json`, at least one range not `read` or `automated`), or at the stage `run.json` names if it is later.

## Step 1: Resolve scope

If `$ARGUMENTS` is empty or equals `recent`, resolve scope from:

1. `git status --short`
2. `git diff --name-only HEAD~1 HEAD` (skip if the repo has only one commit)
3. the most recently modified `.gg/plans/*.md`
4. current conversation context

Drop files matching the configured `excludeGlobs`.

If `$ARGUMENTS` is `--all` or `--resume`, follow **Whole-repo run** above instead of Steps 1–3.

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

Record whether any scoped file has uncommitted changes (`git status --short -- {files}`); Step 6 uses it.

Give every scoped file a tier with the config's globs, in the planner's order (first match wins): `generatedGlobs` → `testGlobs` → any `commands/*.md` (source) → `configGlobs` → `docsGlobs` → `sourceGlobs`/`routeGlobs`. Binary files and files in a tier `readingTiers` marks `automated` get automated checks only. Lanes read the rest at their tier's `readingDepth`.

Rank hotspots: count recent changes per scoped file with `git log --since=90.days --format= --name-only -- {files} | sort | uniq -c | sort -rn`. Files that change often and are complex are reviewed first and break severity ties.

## Step 2: Run safe programmatic evidence collection

Run only safe configured analyzers relevant to the resolved scope. Always capture command, exit code, and concise evidence. Fill `{files}` with the scoped files the tool accepts and `{name}` with the module or symbol being traced.

Use these project-configured commands when present:

<insert safe analyzer command list with purpose>

Optional commands configured for this project:

<insert optional analyzer command list with requires-confirmation notes>

Rules:

- Do not let analyzer output become findings by itself. Treat it as leads.
- For a scoped sweep, prefer `coverage: files` or `package` commands. Run `coverage: repo` commands only for `--all` or when no narrower variant exists, and keep only output that touches the resolved scope; otherwise note why it was skipped.
- An empty result from a tracing command is not proof of absence; confirm the pattern matches a known-used symbol before relying on it.
- If a command fails because the project is already broken, read enough output to understand whether sweep can continue. Do not claim checks passed.

## Step 3: Dispatch three audit lanes

Use subagents when available. If subagents are unavailable, perform the lanes sequentially yourself using the same instructions.

Each lane receives:

- the scope map
- relevant analyzer evidence
- exact files to read
- configured framework/language notes
- the task creation rules below
- each file's reading depth from `readingDepth`, and the rule that only the `read` tool counts as reading

Each lane returns one finding per entry: classification, suggested severity, `file:line` evidence, what is wrong, fix direction, and verification command. It also lists what it checked when it has no findings.

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
- silent failure handling: empty or log-only catch blocks, swallowed promise rejections, and fallbacks that hide a broken state

Use the `refactoring` skill's smell catalog and thresholds as the yardstick: load the skill before dispatching lanes and pass its thresholds to this lane. Thresholds mark where to look; a finding still needs a concrete payoff. Name the transformation each finding needs (e.g. Extract Function, Introduce Parameter Object).

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

Verify before accepting: re-read the cited lines yourself and confirm the claim holds. Lane output is evidence, not truth. Assign severity from the scale below, not from the lane's suggestion.

Reject findings that are:

- style-only
- theoretical with no trigger path
- analyzer-only with no manual confirmation
- missing exact file/line evidence
- impossible to fix without a product decision, unless classified as DECIDE with concrete options
- duplicates of a higher-quality finding from another lane
- matching a `skip` entry in `.gg/sweep.config.json`
- already covered by a pending `Fix /sweep:` task (check with `tasks` action `list`)

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
- For every task, this line: `Before starting, commit any uncommitted changes with /commit; commit this fix before starting the next task.`
- For Refactor-lane tasks: the named transformation, plus this line: `Follow the refactoring skill: green baseline first, one named transformation per step, revert on red, never edit tests to get green.`
- Whether any Steroids grounding was used and what pattern/evidence it found
- Targeted verification command(s) from this project config, or manual verification steps if no command exists

Order tasks by severity, then by dependency order: types/schemas/config → core logic → integrations/routes → UI/docs/tests → cleanup. When tasks touch the same files, Prune tasks come before Refactor tasks so nothing is restructured just before it is deleted.

## Step 6: Report

Reply with:

```text
Sweep scope: <resolved natural-language scope>
Scope confidence: <high|medium|low>
In scope: <N> files (<source N, test N, docs N, config N, generated N, binary N>; <N primary, N adjacent> for narrow scopes)
Read (receipt-backed): <N> files — full: <N>; light: <N> (<basis: ledger line ranges | lane receipts, file-level>)
Automated checks only: <N> files (<generated N, binary N>)
Unread: <N> files not fully read (<cause N, ...>)
Partial chunks: <N> (--all and --resume only)
Analyzers run: <N> (<list short ids>)
Findings accepted: <N> (<N Critical, N High, N Medium, N Low>)
Tasks created: <N>
Skipped/rejected: <N>
```

Counts must come from evidence, never from the file list alone:

- `--all` and `--resume`: from `plan.json` and the final `ledger.json`. A file counts as read only when the ledger marks it `read`; `partial` and `unread` files count as unread, with the ledger's causes.
- Unread causes are per file, so they add up to the Unread file count: count each `ledger.files[]` entry whose `status` is `unread` or `partial` once, under the cause of its unread ranges that comes first in this order: `changed-since-plan`, `never-assigned`, `evidence-unreadable`, `helper-failed`, `helper-timed-out`, `helper-skipped`. `counts.byCause` counts unread line ranges, not files; show it only as optional range-level detail (for example `ranges: never-assigned 5`).
- Narrow scopes: in scope comes from the scope map and tier globs. A file counts as read only when a lane's receipt shows an `ok` `read` of it. If a receipt is cut short (`+N more`), files it does not name count as unread with cause `receipt cut short`; a lane that failed or timed out makes its unread files `helper-failed` or `helper-timed-out`. Counts are file-level, so say `lane receipts, file-level`.

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

To stop a rejected finding from returning, the user can add it to `skip` in `.gg/sweep.config.json`.

If tasks were created and any scoped file has uncommitted changes, add: `Commit first: run /commit (the commit button in the desktop app) to group uncommitted changes into atomic commits, then run the tasks. The refactoring skill pauses on a dirty tree.` The sweep itself never commits.

Always end with one `Next:` line, chosen by `tasks` action `list`:

- Other `Sweep:` tasks still pending (ignore the one running now): `Next: <N> area sweeps left. Run /sweep --merge after the last one.`
- This sweep came from a `Sweep:` task and none remain: `Next: all area sweeps are done. Run /sweep --merge, then run the fixes one at a time.`
- Otherwise, if this was a `recent` or empty-argument sweep: `Next: run the fixes one at a time, committing after each. For a whole-codebase pass, run /sweep --map.`
- Otherwise: `Next: run the fixes one at a time, committing after each.`

If tasks were created, end with: `Tasks created. Press CTRL + T to open the task pane and run them.`
````

## Step 6: Verify generated files

After writing the files:

- Re-read `.gg/sweep.config.json` and `.gg/commands/sweep.md`.
- Confirm there are no unreplaced placeholders such as `<detected...>` or `<insert...>`. Runtime `{files}`/`{name}` placeholders are allowed.
- Run each safe analyzer once (fill runtime placeholders with a known-used file or symbol) and confirm it exits and produces meaningful output. A tracing command must find at least one known importer. Fix or drop any command that fails or silently matches nothing.
- Confirm optional commands are marked `requiresConfirmation: true`.
- Confirm `readingTiers` has all five tiers (`source`, `test`, `docs`, `config`, `generated`), each set to `full`, `light` or `automated`, and that the Step 4.5 planner check exited 0.
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
Reading tiers: <source full, test light, docs light, config light, generated automated>
Planner check: <passed: N files in N chunks | unavailable: reason>
```

Then tell the user they can run examples like:

```text
/sweep
/sweep whatever we just changed
/sweep the onboarding flow
/sweep --all
/sweep --resume
```
