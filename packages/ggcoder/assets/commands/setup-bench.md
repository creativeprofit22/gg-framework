---
argument-hint: [optional: study kinds, e.g. "engine agent"]
description: Set up benchmark studies in this project - vendor the bench kit and generate a project-local /bench command that compares candidates and explains the verdict in plain words.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, LS, ask_user
---

# Setup Bench

Set up this project to compare 2 or more candidates for any decision (code approaches,
libraries, engines, CLI tools, services, coding agents and their prompts) and get a verdict
the user can defend. This command vendors the versioned, dependency-free **bench kit** into
`bench/kit/`, writes `.gg/bench.config.json`, and generates a thin project-local
`.gg/commands/bench.md` router.

This command is globally available; the generated `/bench` is project-local.

## Non-negotiables

- Do **not** install, download or update anything (packages, tools, docker images) without
  the user's explicit confirmation.
- Never edit product code. Write only `bench/kit/`, `bench/studies/`, `.gg/bench.config.json`
  and `.gg/commands/bench.md`, plus `.gitignore` only after the user approves the exact lines.
- Never run paid or live candidates here. Setup measures nothing.
- Never overwrite a locally modified kit or an existing `.gg/commands/bench.md` without asking.
- Plain language in every message: say what each step means for the user, not just what ran.
- The kit's CLI does all counting and statistics; this setup only installs and checks it.

## Step 1: Detect project shape

Read the project root and obvious config files only (one or two levels deep for workspaces).
Do not recurse through dependency, build or vendor folders. Detect:

- Runtimes: Node.js version (`node --version`; the kit needs Node 22 or newer), plus Python,
  Go, Rust or others when their manifests exist.
- Benchmark or measuring tools already in use, so studies call them instead of duplicating
  them: `vitest bench`, `tinybench`, `mitata`, `benchmark.js`, `hyperfine`, `criterion`,
  `pytest-benchmark`, `go test -bench`, `k6`, `ffmpeg`/`vmaf`, `docker`. Check scripts,
  dependencies and config first; confirm a binary with a version command only (for example
  `hyperfine --version`). Missing tools are recorded as missing, never installed.
- Git: is this a git repository (`git rev-parse --show-toplevel`)? Provenance checks use it.
- An existing `bench/` folder. The kit uses only `bench/kit/`, `bench/studies/`,
  `bench/glossary.json` and `bench/RESULTS.md`. If `bench/RESULTS.md` exists and was not
  written by the kit (it has no kit entry markers), tell the user the kit will add its
  entries between markers and keep their text. Other `bench/` contents are left alone.

If Node is older than 22, stop: the kit cannot run. Say how to upgrade; do not upgrade.

## Step 2: Locate the installed kit

The kit is installed next to this command, in the GG agent folder: `$GG_AGENT_DIR` when set,
otherwise `~/.gg`. Read `<agent dir>/bench-kit/current.json`:

```json
{ "schema": 1, "kitVersion": "1.0.0", "digest": "<sha256>", "dir": "1.0.0-<sha8>" }
```

The kit lives in `<agent dir>/bench-kit/<dir>/`. If the pointer or the folder is missing,
stop and tell the user to reinstall the command by re-running
`pnpm commands:install:setup-bench` from a GG Framework checkout. Do not search the disk for
another copy.

## Step 3: Ask which study kinds to expect

Use `$ARGUMENTS` as the answer when it names kinds. Otherwise ask one `ask_user` question
(kind `multi`) with these options and recommend the ones the detection supports:

- `code`: two ways to write the same code (functions, algorithms, queries)
- `library`: competing libraries for the same job
- `engine`: engines or heavy tools (video, database, search, rendering)
- `cli`: command-line tools
- `service`: running services or APIs
- `agent`: coding agents, models or prompts on the same tasks (may cost money per run)

The answer goes into the config and decides which examples the report at the end shows.

## Step 4: Vendor the kit into `bench/kit/`

Compare the installed kit with `bench/kit/` in the project:

- **No `bench/kit/` yet**: copy it.
- **`bench/kit/manifest.json` has the same `kitVersion` and the files match**
  (`node bench/kit/cli.mjs selftest` reports the `manifest` check as `pass`): keep it.
- **Same files but an older or newer version**: say which versions, and that studies frozen
  with the old kit get a new protocol version at their next `freeze` (results are never
  pooled across versions). Ask with `ask_user` before replacing (recommend replacing).
- **Locally modified kit** (selftest `manifest` check `fail`, or no manifest): never
  overwrite silently. Ask with `ask_user`: keep the local kit (recommended), replace it
  (local changes are lost), or cancel.

Copy through a temporary folder so a failed copy never leaves a half kit (no shell globbing,
works on every OS):

```bash
node -e "const fs=require('fs');fs.rmSync('bench/kit.new',{recursive:true,force:true});fs.cpSync(process.argv[1],'bench/kit.new',{recursive:true})" "<agent dir>/bench-kit/<dir>"
node bench/kit.new/cli.mjs selftest
node -e "const fs=require('fs');fs.rmSync('bench/kit',{recursive:true,force:true});fs.renameSync('bench/kit.new','bench/kit')"
```

If the selftest of `bench/kit.new` fails, delete `bench/kit.new`, keep the old kit and stop
with the failing checks. Create `bench/studies/` if it is missing.

## Step 5: Write the config and the `/bench` router

1. `.gg/bench.config.json`: start from `bench/kit/templates/bench.config.sample.json`. Fill
   `kitVersion`, `project` (one-line summary), `studyKinds` and `existingTools` (name and
   version command for each detected tool). Keep `services` and `prices` empty unless the
   user gives them. Never invent a price. If the file already exists, keep its `services`
   and `prices` and update the rest.
2. `.gg/commands/bench.md`: copy `bench/kit/templates/bench.md` and replace
   `<project summary>` and `<kit version>`. Change nothing else; the playbooks it loads ship
   with the kit, so they update with it. If the file exists and differs from the template
   (other than those two values), ask before replacing it.

## Step 6: Propose `.gitignore` lines (ask first)

Raw run data is large and machine-specific; everything needed to check a verdict is small.
Show the user the exact lines and ask with `ask_user` before editing `.gitignore`:

```gitignore
# bench kit: raw run data stays local; study definitions, protocols and verdicts are tracked
bench/studies/*/runs/
```

Tracked: `bench/kit/`, `study.json`, `workload/`, `protocol.json`, `report.md`,
`verdict.json`, `bench/RESULTS.md`, `bench/glossary.json`. Skip lines that are already
present (`git check-ignore -v bench/studies/x/runs/y` shows existing rules). Not a git
repository: skip this step and say so.

## Step 7: Selftest

```bash
node bench/kit/cli.mjs selftest
```

Every check must be `pass`, including `manifest` (the vendored kit matches its hashes). A
`warn` or `fail` is reported as is; do not hide it.

## Step 8: Re-read what was generated

- Re-read `.gg/bench.config.json` and `.gg/commands/bench.md`.
- Confirm no placeholders remain: no `<project summary>`, no `<kit version>`.
- Confirm `.gg/bench.config.json` parses and `node bench/kit/cli.mjs list` exits 0.

## Step 9: Report

```text
Configured /bench for: <project summary>
Kit: bench/kit (version <kit version>, selftest <N>/<N> passed)
Generated: .gg/bench.config.json, .gg/commands/bench.md
Study kinds: <list>
Existing tools used by studies: <list or none>
.gitignore: <updated | unchanged (user declined) | not a git repository>
```

Then, in plain words, one sentence on what a study is: a question, a frozen workload,
gates that rule candidates out, repeated measurements and a rule written down before any
result. Show two examples for the chosen kinds, for example:

```text
/bench new which of our three video engines exports fastest without losing quality?
/bench new does the new prompt make our coding agent resolve more tasks?
```

End with: `Next: /bench new <your question>`
