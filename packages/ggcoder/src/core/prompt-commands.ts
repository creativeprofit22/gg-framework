/**
 * Prompt-template commands — slash commands that inject detailed prompts
 * into the agent loop. Each command maps to a full prompt the agent executes.
 */

import { isGgApp } from "./runtime-mode.js";

export interface PromptCommand {
  name: string;
  aliases: string[];
  description: string;
  prompt: string;
}

const IS_GG_APP = isGgApp();

const TASKS_ADDED_NOTICE = IS_GG_APP
  ? 'Tasks added. Click the "Tasks" button to open the task list and run them.'
  : "Tasks added. Press Ctrl+T to open the task list and run them.";

// The context file is whichever name won CONTEXT_FILES priority for this repo
// (AGENTS.override.md > AGENTS.md > CLAUDE.md > …), so the notice stays
// filename-agnostic — /init picks the winner at run time.
const CLAUDE_MD_RESTART_NOTICE = IS_GG_APP
  ? '> ⚠️ The project context file was created/updated. GG App loads it fresh per session, so start a **New Session** (click "+ New") before continuing. Without a new session, I won\'t see the new context.'
  : "> ⚠️ The project context file was created/updated. ggcoder loads it at startup, so **exit and restart ggcoder** (`/quit` then run `ggcoder` again) before continuing. Without a restart, I won't see the new context.";

/**
 * Shared sub-agent fan-out phrasing. One home so the "call the tool N times
 * in a single response" wording can't drift between command prompts.
 */
const spawnParallel = (count: string | number): string =>
  `in parallel using the subagent tool (call the subagent tool ${count} times in a single response)`;

/**
 * Kencode-search ships behind deferred MCP loading (`deferredMcpTools` defaults
 * to true), so its tools sit in the `tool_search` catalog until promoted. Any
 * command that names an `mcp__kencode-search__*` tool must say how to unlock it,
 * or the call fails on a default install.
 */
const KENCODE_UNLOCK_NOTE =
  'If the `mcp__kencode-search__*` tools aren\'t active yet, call `tool_search` (e.g. "search public code") first to unlock them.';

export const PROMPT_COMMANDS: PromptCommand[] = [
  {
    name: "expand",
    aliases: [],
    description: "Find exciting new features to add",
    prompt: `# Expand: Exciting Feature Discovery

Find the most exciting new features this project should add by comparing it to similar, adjacent, and best-in-class repositories/tools/products/services. This command is project-agnostic: infer what THIS project is before choosing comparisons. This command is report-first and feature-first — the only deliverable is a single ranked table of exciting, user-facing features. Do not edit, install, or implement anything until the user chooses an option at the end.

Focus on what users actually get excited about: the new, killer, user-facing capabilities that make a product stand out. Security audits, refactors, code-quality cleanups, tests, CI, and ops/DX hygiene are OUT OF SCOPE here — exclude them unless a specific item is itself an exciting user-facing feature.

## Phase 0: Profile this project first

Before external research, inspect the local project and write a private working profile:

- What the project does, who its users are, and how they use it.
- Core user-facing surfaces, workflows, commands/routes/screens, and the features that already exist.
- The feature categories most relevant to THIS project. Do not assume a stack or product type.

Use this profile to decide which features are relevant and genuinely missing. If the user passed arguments to /expand, treat them as a focus area and prioritize that lens while still validating relevance.

## Phase 1: Parallel feature research

Spawn exactly 5 sub-agents ${spawnParallel(5)}. Give each sub-agent the project profile and a different feature-hunting lens:

**Agent 1 - Direct competitor killer features**: The standout, most-loved user-facing features in the closest peer projects/tools/products that this project lacks.

**Agent 2 - Adjacent & emerging tools**: Exciting user-facing features from adjacent products that would translate well to this project.

**Agent 3 - User demand signals**: Highly requested or trending features — top-voted issues, roadmap items, community asks, reviews, discussions — that point at what users want next.

**Agent 4 - Platform & ecosystem trends**: New user-facing capabilities unlocked by recent framework/API/model/platform releases that this project has not adopted yet.

**Agent 5 - Differentiators & wow-factor**: Novel or innovative features that would make this project stand out, even if no single peer has shipped them yet.

Each sub-agent must:

1. Use current sources: prefer repos/releases/changelogs/docs/articles updated within the last 6 months. Drop old or stale sources unless they are canonical and still actively maintained.
2. Return only user-facing FEATURES that appear absent in this project — not refactors, hardening, tooling, tests, or internal cleanup.
3. Include source names/URLs, freshness date (commit/release/article/doc date), and the local search anchors they used or recommend to verify the feature is absent.
4. Rank its own candidates by how exciting and valuable they would be to users, and state why each is exciting.
5. Avoid generic wishlist items. Every feature must be grounded in an external comparison or a real user-demand signal and relevant to this project profile.

## Phase 2: Main-agent validation against this repo

For every candidate from the sub-agents, validate it yourself before reporting:

1. Confirm the external source is relevant to this project and fresh enough (normally within 6 months).
2. Search this repo with grep/find and language-aware anchors to confirm the feature is not already present under another name.
3. Check routes, CLI commands, UI surfaces, package exports, config, docs, and examples before calling a feature missing.
4. Use mcp__kencode-search__searchCode when a code-level look clarifies how peers actually ship the feature. Use literal imports, functions, config keys, CLI flags, route names, or package names — not conceptual phrases. ${KENCODE_UNLOCK_NOTE}
5. Drop anything already present, irrelevant, too vague, too stale, or that is not a real user-facing feature.
6. Merge duplicates and keep only the most exciting 5–10 features.

## Final output

Output ONLY a single table, ranked most exciting (rank 1) to least exciting. No prose before or after the table except the options below. Include 5–10 rows. The table must have exactly 3 columns:

| Rank | Feature | Why it's exciting + evidence |
|---|---|---|
| 1 | concise feature name + what it does | why users would love it, which peers/tools have it, source + fresh date, and local proof it is missing |

Rules:

- 5–10 rows, ordered most exciting first (rank 1 = most exciting).
- Only user-facing features. No security, refactor, ops, tooling, or test rows.
- The table must have exactly 3 columns. Put source URL/date/evidence and local absence proof inside the cells, not extra columns.
- Keep each cell concise but specific enough to be actionable.
- If no exciting validated features are found, output one row saying no fresh validated features were found.

After the table, ask exactly:

What should I do?
A) Build all of these features in plan mode
B) Build only the top priority ones in plan mode
C) Other

Do not start implementing until the user chooses.

If the user chooses A or B, do not implement directly. First call the enter_plan tool, then research and design an implementation plan for the selected features (all of them for A; the top 3 most exciting — ranks 1-3 — for B). The plan must cover, per feature: the user-facing behavior, the local files/anchors it touches, the implementation approach (compared against real-world examples via kencode search using literal code tokens), and how it will be verified. Write the plan to .gg/plans/<name>.md, then call exit_plan with the plan path so the user can review and approve it. Do not begin implementing until the user approves the plan.

If the user chooses C, ask what they would like — pick specific features by rank, refine or re-scope the list, or skip — and do not implement anything until they say so.`,
  },
  {
    name: "init",
    aliases: [],
    description: "Generate or update CLAUDE.md for this project",
    prompt: `Generate or update the project context file with project-specific context only: what this project is, the non-obvious knowledge needed to change it safely, and the workflows that are unique to it.

This file is injected verbatim into the **cached prefix of every request in every future session**, alongside the system prompt. Every line costs tokens forever. A line that repeats something the agent already has is worse than absent: it dilutes the lines that matter. So the bar is not "is this true?" — it is **"would a competent agent get this wrong without being told?"**

## What is already in the agent's context — never restate any of it

Read this list once and apply it to every step below. These are already supplied by the system prompt, so writing them into the context file is pure duplication:

1. **Agent behavior** — Do NOT add generic agent behavior already covered by the system prompt: read before edit/write, re-read after formatters, ask before destructive actions, no fake verification, generic code-quality advice, how to use tools, or how to talk to the user.
2. **Language conventions** — a Language Style Packs section is auto-injected for every language detected in this repo. Do not duplicate language style packs, generic verification rules, or boilerplate quality gates such as "After editing ANY file" / "Code Quality — Zero Tolerance".
3. **Verify commands** — a Verification section is auto-generated from package scripts / manifests (lint, typecheck, format, test) with the correct runner already resolved from the lockfile. Only write a command down if it is NOT discoverable that way: an undocumented multi-step sequence, a required ordering, a non-obvious flag, or a command that lives outside the manifest. Never add guidance that requires running checks, builds, or the full quality suite after every edit or every file change, and never turn discovered commands into mandatory after-every-edit requirements unless local CI explicitly enforces that sequence.
4. **The file tree** — the agent can list and grep the repo in one call. Do NOT embed generated symbol maps, exhaustive file indexes, auto-generated directory listings, or large trees. Do not add symbol indexes or auto-generated project inventories; the context file must remain durable, agent-focused project context.

Include only project-specific overrides, stricter local requirements, or knowledge that cannot be derived by reading the code.

## Step 1: Pick the target filename

Context files are loaded **one per directory, first match wins**, in this priority order: \`AGENTS.override.md\` > \`AGENTS.md\` > \`CLAUDE.md\` > \`.cursorrules\` > \`CONVENTIONS.md\`.

List the repo root and write to **whichever of those already exists with the highest priority**. If the repo already has an \`AGENTS.md\`, update that file — creating a new CLAUDE.md next to it produces a file the agent will never load. If none exists, create \`CLAUDE.md\`. State which file you chose and why in one line.

## Step 2: Set up the regenerated block

\`/init\` is re-run over the project's lifetime, so the generated content must be **replaceable, not appendable** — otherwise each run grows the file forever.

All content you generate goes inside these exact fence markers:

\`\`\`
<!-- gg:init:start -->
…generated content…
<!-- gg:init:end -->
\`\`\`

- If the file exists and already has the fence: **replace everything between the markers wholesale**. Text outside the fence is user-owned — do not touch it, do not reformat it, do not move it.
- If the file exists without the fence: read it, decide which content is hand-written knowledge worth keeping, move that above the fence untouched, and put your generated content inside a new fence. Remove generic guidance that is already covered by the system prompt (see the list above) unless it is a deliberate project-specific override.
- If the file does not exist: create it with the fence.

## Step 3: Analyze the project (sub-agents in parallel)

Derive every fact from the actual project — source code, entry points, manifests, config, and history. Treat README, docs, and code comments as unverified hints that are frequently stale: never copy claims from them, and only state things you can confirm from the code and config themselves.

Spawn 3 sub-agents ${spawnParallel(3)}:

1. **Purpose & Shape Agent**: What does this project actually do, and what are its top-level parts? Read entry points, main modules, exported/public APIs, CLI commands, routes, and manifests. Return: a one-sentence purpose, and for each package/app/module a one-line statement of what it *owns*. Do not rely on the README's description. Do not return a directory listing.
2. **Gotchas & Invariants Agent**: Find the knowledge that is expensive to rediscover. Mine \`git log\` (especially revert/fix/hotfix commits), CI and release workflows, \`NOTE\`/\`HACK\`/\`IMPORTANT\`/\`WARNING\`/\`XXX\` comments, test names asserting surprising behavior, generated-file and build-order constraints, and any config with a non-default value. Return only: rules that are non-obvious from reading the code, ordering/sequencing constraints, things that silently break, and the *reason* each exists. Skip anything a careful reader would infer in 30 seconds.
3. **Workflow & Stack Agent**: How is this project run, built, released, and deployed, from authoritative sources only — package scripts, manifests, Makefiles, CI config, deploy config. Return the workflows and any command that is NOT a plain single manifest script (multi-step sequences, required order, env vars, non-obvious flags, commands living outside the manifest). Do not return commands the auto-generated Verification section already covers (see item 3 above). Do not invent commands from convention, and do not trust README/doc command snippets unless a script or manifest confirms they still exist.

Wait for all sub-agents to complete, then synthesize.

## Step 4: Write the generated block

Inside the fence, write only sections that add project-specific value. Prefer this order — drop any section that would be empty or obvious:

- Project name and one-sentence purpose
- Key packages/apps/modules and what each owns (one line each, no tree)
- Architecture or data-flow notes an agent could not infer quickly from the code
- **Gotchas / invariants** — the highest-value section. Each entry states the rule *and* why it exists.
- Project-specific commands and workflows that survived the Step 3 filter (required publish order, generated-file workflow, dev-server startup, deployment caveats, auth/secrets storage)

Avoid generic sections named "Code Quality", "Organization Rules", or "How to Work" unless every bullet is specific to this project.

## Step 5: Budget and verify

The combined budget for all project context files is 32KB, shared with any parent-directory context files. **Target 6KB or less for the generated block** — a tight 4KB file that gets read every time beats a 25KB file the agent skims.

After writing:

1. Run \`wc -c\` on the file and report the byte size. If the generated block exceeds ~6KB, cut the weakest sections (the ones closest to "derivable by reading the code") and rewrite.
2. Re-read the file and confirm every remaining line passes the bar: **project-specific, supported by a local file you actually read, and not already in the agent's context per the list above.**
3. Report in one line: which file, how many bytes, and how many lines you removed as redundant.

## Step 6: Restart Notice

End your reply with this exact notice so the user doesn't miss it:

${CLAUDE_MD_RESTART_NOTICE}`,
  },
  {
    name: "setup-commit",
    aliases: [],
    description: "Generate a /commit command",
    prompt: `Detect the project type and generate a /commit command that enforces quality checks and an agent code review before committing.

## Step 1: Detect Project and Extract Commands

Check for config files and extract the lint/typecheck commands:
- package.json -> Extract lint, typecheck scripts
- pyproject.toml -> Use configured mypy, pylint/ruff commands
- go.mod -> Use configured go vet/gofmt/staticcheck commands
- Cargo.toml -> Use configured cargo clippy/fmt commands

Prefer existing project scripts. If you must synthesize a command from tool conventions, verify the current CLI flags against official docs first.

## Step 2: Generate /commit Command

Create the directory \`.gg/commands/\` if it doesn't exist, then write \`.gg/commands/commit.md\`:

\`\`\`markdown
---
name: commit
description: Group changes by intent, verify, commit in order, and push once
---

Clicking \`/commit\` authorizes this entire workflow. Execute directly: never enter plan mode, create a plan, pause for confirmation, or ask how to group changes.

1. Inspect status, staged/unstaged diffs, and untracked files. Review the full diff for bugs, regressions, debug leftovers, and unintended changes.
2. Group obvious changes by purpose, splitting exact hunks only when a file spans independent purposes. Keep uncertain or coupled changes together and order foundations before dependents.
3. Run [PROJECT-SPECIFIC QUALITY COMMANDS] once. If a required check fails, stop and report it; do not clean up unrelated failures or rerun passing checks without file changes.
4. For each group, stage exact paths or hunks, never \`git add -A\`; inspect its staged diff before committing.
5. Create ordered commits with concise Add/Update/Fix/Remove/Refactor messages, then push exactly once after all commits.

Finish with the created commits, passed checks, and push result.
\`\`\`

Replace [PROJECT-SPECIFIC QUALITY COMMANDS] with the actual commands.

Keep the command file under 30 lines.

## Step 3: Confirm

Report that /commit now automatically groups changes into ordered commits, verifies them, and pushes once; mention which local scripts/docs verified the commands.`,
  },
  {
    name: "setup-tauri-package",
    aliases: [],
    description: "Set up safe Tauri packaging",
    prompt: `# Set Up a Project-Scoped Tauri Packaging Harness

Audit this repository from its actual root, identify exactly one evidence-backed desktop Tauri application, and generate a deterministic packaging harness plus a thin project command. This is setup work, not a package-manager install, Tauri migration, release, or cleanup task.

Execute the audit and setup directly in the current turn. Do not enter or use plan mode, call \`enter_plan\` or \`exit_plan\`, create or update any file below \`.gg/plans/\`, or pause for plan approval. A plan file is outside the six-file boundary and is a setup failure.

## 1. Audit before writing

Perform a bounded inspection of repository and workspace manifests, lockfiles, package scripts, existing build/package scripts, Cargo.toml files, .cargo/config files, Tauri v1/v2 configuration (tauri.conf.json, JSON5/TOML variants, and platform overlays), referenced resources, sidecars, icons, CI workflows, and release target matrices. Follow workspace membership and nested manifests; do not infer a Tauri root from a directory name.

A candidate is proven only by corroborating local evidence from its Cargo crate, Tauri configuration, and frontend Tauri CLI/build entry point. Determine:

- the repository-relative Tauri root and frontend directory;
- the installed package manager from its lockfile and the exact existing argv-safe Tauri build entry point;
- the locally installed Tauri CLI version and its current \`build --help\` output before choosing flags;
- desktop target IDs, host compatibility, bundle formats, Cargo target placement, output roots, directly runnable artifacts, and required resources/sidecars/icons;
- existing CI/release target evidence and any configured beforeBuild/beforeBundle behavior.

Tauri desktop builds run configured pre-build/pre-bundle commands and platform overlays merge with base configuration, so persist observed local semantics rather than assuming a standard Tauri 2 directory or output layout.

Stop before any write if no candidate is proven, packaging is mobile-only/unsupported, or multiple candidates remain ambiguous. Name the one app-selection decision or unsupported condition needed to continue. Never choose arbitrarily.

Normalize every persisted path to a repository-relative path using \`/\` separators. Reject absolute paths, traversal, unsafe symlink resolution, dynamic or unreadable configuration, deletion-rule globs, and commands requiring shell interpolation. Persist commands as executable-plus-argument arrays, never shell strings.

## 2. Exact setup-owned file boundary

Setup may create or regenerate only these six support files:

1. \`scripts/package-tauri.mjs\` — dependency-free build, stage, gate, manifest, and promotion orchestrator.
2. \`scripts/package-tauri.test.mjs\` — deterministic node:test fixtures for the orchestrator.
3. \`scripts/smoke-tauri-package.mjs\` — dependency-free bounded final-package launcher/validator.
4. \`scripts/smoke-tauri-package.test.mjs\` — deterministic node:test smoke fixtures.
5. \`scripts/package-tauri.config.json\` — normalized evidence, argv, targets, required files, prune rules, baseline inventory, and size gates.
6. \`.gg/commands/package-tauri.md\` — a thin target-selecting project command.

Do not install dependencies; edit package manifests or their scripts; rewrite Tauri/Cargo configuration; publish, upload, or run a release; or perform unrelated cleanup. Do not independently sign or notarize: an existing audited build entry point may perform only its already-configured build-time signing, and setup must never create or change signing configuration, credentials, or release settings.

The setup agent may create or regenerate only the six support files above. Runtime calibration, packaging, and verification may additionally write only below literal repository-relative work/staging/output roots declared in the config and pre-existing generated build-output paths proven by the audited project configuration; they must never modify source or configuration files.

The generated \`/package-tauri\` command must select one audited target, invoke exactly \`node scripts/package-tauri.mjs --target <id>\`, never bypass a failed build, gate, manifest, or smoke result, and report final artifact, evidence report, and manifest paths only after success.

## 3. Ownership, digests, and deterministic rendering

Every support file must carry the exact marker \`Generated by GG Coder /setup-tauri-package tauri-package v1\`, a shared evidence SHA-256, and a content SHA-256. JSON stores these in one reserved top-level metadata object; JavaScript and Markdown use comments. Document and implement one canonical payload algorithm that removes only the content-digest field before hashing, so the stored content digest can be independently recomputed.

Before writing anything, read all six destinations and validate them as one transaction:

- absent destinations may be created;
- an owned file may be regenerated only when its marker, canonical content hash, and shared evidence hash validate;
- an unmarked file, modified generated body, mixed marker/generation/evidence IDs, or partial foreign set is user-owned/manual work;
- any conflict must preserve all six destinations byte-for-byte and prevent partial writes.

After validating all six destinations as one owned set, compare their single shared evidence digest with the freshly audited evidence before rendering any support bytes. If all six owned files validate and their shared evidence digest matches, return successfully immediately: do not render, regenerate, or write any support file. This early no-op is the only same-evidence path.

For an initial absent set, build all six bytes in memory. Only when freshly audited evidence differs may setup regenerate support files, and it must render and replace all six transactionally with rollback-safe temporary files. Validate the complete rendered set before commit. Use stable key ordering, stable path ordering, LF endings, no timestamps, no absolute machine paths, and no shell command strings. Changed evidence triggers one complete rerender; changed generated bytes trigger a conflict, never overwrite.

The evidence digest must cover the normalized local facts that selected the app, commands, configs, resources, host/targets, and gate inputs. Re-read evidence immediately before commit and abort the whole write if it changed during setup.

## 4. Generated runtime contract

Generate standard-library-only ESM. The orchestrator must export testable pure helpers and have a narrow CLI accepting only help, \`--target <id>\`, \`--calibrate --target <id>\`, and \`--verify --target <id>\`. Unknown, duplicate, missing, bypass, skip-gate, skip-smoke, arbitrary-command, or arbitrary-path arguments fail closed. Use \`execFile\` or \`spawn\` with \`shell: false\`; inherit the current environment for toolchain/signing secrets but never serialize or log secret values.

The normalized config must have a schema/version and the shared metadata. Record repository-relative literal roots, evidence inputs and hashes, executable/argument arrays, host and target definitions, bundle/artifact roles, required paths and cardinalities, directly runnable smoke adapter details, literal prune entries, calibrated baseline inventory, and concrete size/file-count gates. Sort targets, roles, paths, and object keys deterministically. Reject unknown schema versions and malformed or duplicate entries.

For a normal package run, perform these stages in this exact order:

1. **Validate before mutation.** Recompute config/support evidence and content hashes; validate target/host compatibility, normalized paths, source evidence, commands, required inputs, roots, sentinels, baseline calibration, and ownership. Work, staging, and output roots must be setup-owned, repository-relative, mutually safe, and outside source/Tauri inputs and the project's ordinary Cargo target. Refuse links or escapes in any mutable ancestor.
2. **Build into owned workspace.** Invoke the audited existing Tauri build entry point with argv and \`shell: false\`, directing Cargo/output only to a setup-owned target workspace using locally verified CLI/environment semantics. Clear only the exact marker-owned selected target bundle directory. Never clean the project's ordinary Cargo target, source tree, Tauri inputs, resources, or an unowned directory. Record run start before spawning.
3. **Prove fresh output.** Require a successful build exit and accepted artifacts beneath the selected owned target root. The selected bundle root was empty after the pre-build clear; every artifact must be newly discovered there and have creation/change evidence after run start. Reject stale pre-existing artifacts, missing or ambiguous cardinality, path escapes, target mismatches, links where regular files are required, and relevant build output found outside the expected target root.
4. **Inventory, stage, and prune.** Capture a lexically sorted pre-prune baseline inventory by role, repository-relative path, byte size, and file/link type. Copy it to a fresh sibling candidate staging directory without following links. Apply only target-specific literal prune entries from config, each carrying target, local evidence, and reason. Pruning is staging-only. Reject glob/regex deletion, path traversal, links, required-file collisions, denylisted roots, target mismatches, and entries not present in the captured baseline. An empty prune list is correct when no safe project evidence proves an item is a non-target duplicate. Never infer that debug symbols, updater data, licenses, resources, sidecars, or platform binaries are disposable from a name or extension.
5. **Gate the candidate.** Enforce required-file existence, type, role, and exact/min/max cardinality. Compare the inventory with a calibrated target baseline and enforce concrete total bytes, per-role/artifact bytes, regular-file count, and allowed absolute plus percentage growth. Every limit must be finite and derived from the recorded baseline policy; no missing/zero/unbounded or runtime-relaxed gate. An uncalibrated target fails a normal package run closed.
6. **Manifest, smoke, and promote.** Emit stable JSON evidence and a lexically sorted SHA-256 manifest covering every regular distributable file. Validate contained symlinks separately without following escapes. Write and immediately verify the manifest, run packaged smoke from the candidate tree, then verify every hash again to detect smoke mutation. Only after all checks pass, promote the sibling candidate with a rollback-safe two-rename swap: rename a marker-owned previous final output to a sibling backup, rename the candidate to the final path, restore the backup if the second rename fails, and remove the backup only after success. Do not claim this directory replacement is atomic across platforms. On failure preserve or restore the previous final output and diagnostics, and never publish the candidate.

The evidence report must include target, normalized command argv, input/evidence hashes, run result, fresh artifact inventory, pre/post-prune inventories, exact prune evidence, gate calculations and limits, manifest hash, smoke result, and final paths. Keep deterministic evidence stable where possible; represent volatile run diagnostics separately from canonical support/config bytes and never place timestamps in the six support files.

### Calibration and verification

Calibration may run the real audited build and measure a bounded baseline inventory, then deterministically write target baseline and gate policy back through the same six-file ownership transaction. It may not publish/promote output, relax an existing gate merely to pass, guess at unavailable targets, or mark ready without successful build, required-file validation, and packaged smoke. If the required host toolchain, configured build-time signing, build, or smoke cannot run, leave the target explicitly uncalibrated, report the single blocker, and do not claim \`/package-tauri\` is ready.

\`--calibrate\` must fail closed and exit nonzero unless that invocation completes the calibration build and required-file validation, packaged smoke satisfies its configured readiness criterion, the calibrated baseline and finite gate policy are persisted through the complete six-file ownership transaction, and the persisted state is reloaded and validates the target as calibrated. A successful build or discovered artifact alone must never return exit code zero. Any smoke/readiness, persistence, reload, digest, or calibrated-state validation failure must preserve the prior support set or leave the target explicitly uncalibrated and exit nonzero.

Verification mode must be read-only and recompute ownership, schema, required paths, gate math, manifest, and final-output hashes for an already promoted target. It cannot build, calibrate, prune, smoke an installer, or repair files.

### Packaged smoke contract

Smoke a directly runnable artifact from the candidate package, never a source-tree binary and never an installer that modifies the machine. Supported adapters may launch a staged Windows executable, a macOS \`.app\` inner executable, or a Linux AppImage/direct binary only when local target evidence identifies it. MSI/NSIS installers, DMGs, DEB/RPM packages, and other install-only outputs need a separately evidenced non-installing validator; otherwise refuse them.

Launch with argv and \`shell: false\` using isolated temporary HOME/user/config/cache directories. Capture bounded stdout/stderr diagnostics without secrets. Require configured readiness evidence or healthy survival for a bounded interval; treat early exit, crash, spawn error, or timeout without the configured criterion as failure. Track the exact child process/tree created by smoke and terminate only that child tree in a finally path. Never use broad process-name killing. Snapshot and re-hash the candidate before and after smoke; any package mutation fails.

## 5. Generated fixture and terminal verification contract

Both generated test files must use only \`node:test\`, Node standard-library modules, and temporary directories. They must never need the real project build, network, signing tools, user home, ordinary Cargo target, or previously generated output. Export/inject filesystem, clock, spawn, and builder boundaries where necessary so every failure is deterministic.

The fixture suite must cover all of these behaviors:

- stable config/object/path ordering; Windows and POSIX separator normalization; rejection of absolute/traversal paths; stable rendering; same-input reruns; marker, content-hash, and evidence-hash tampering; mixed/partial/manual destination conflicts; all-or-nothing preservation; changed-evidence complete rerender; and no shell invocation;
- a fake builder producing fresh artifacts, stale artifacts, failed exits, output outside the target root, path escapes, symlinks, host/target mismatches, missing/duplicate required files, cardinality failures, and oversized outputs;
- sorted baseline inventories; calibrated total/per-role/per-artifact/file-count growth gates with absolute and percentage limits; uncalibrated refusal; exact target-only staging prune; empty prune lists; missing prune evidence; required/prune collisions; denylisted roots; and proof that source/build output is untouched;
- deterministic SHA-256 manifests for every regular file, separate safe-link validation, immediate and post-smoke verification, mutation detection, failed-candidate non-promotion, and rollback-safe two-rename replacement of a marker-owned prior final output;
- fake packaged apps for healthy bounded survival, explicit readiness, early crash, timeout, spawn failure, child-only cleanup, attempted package mutation, artifact path mismatch, and refusal to execute install-only artifacts;
- source guards that fail if generated production scripts contain broad or unscoped recursive deletion, \`shell: true\`, shell interpreters/interpolation, gate/manifest/smoke bypass flags, installer execution, broad process killing, writes outside owned work/staging/output roots, or cleanup of source/Tauri/ordinary Cargo target paths.

Tests must assert both success results and unchanged filesystem state after every refusal. They must prove that secrets inherited by child processes are absent from config, reports, manifests, stdout/stderr summaries, and thrown errors.

## 6. Generate, validate, and prove the real setup

Follow this order and do not claim readiness from fixture tests alone:

1. Finish the evidence audit, render all six support files in memory, revalidate evidence and destination ownership, and commit the six-file set without touching any other file.
2. Run \`node --test scripts/package-tauri.test.mjs scripts/smoke-tauri-package.test.mjs\`. Fix every failure within the six-file boundary and rerun from the start.
3. For the detected host target, run calibration when the audited toolchain permits it. Calibration may update the complete owned support set only through the digest/transaction rules. If a real build, required toolchain or configured build-time signing, or packaged smoke is unavailable, keep that target explicitly uncalibrated and report the blocker; do not fake, skip, publish, or say the generated package command is ready.
4. When calibration succeeds, run one real \`/package-tauri\`-equivalent invocation with \`node scripts/package-tauri.mjs --target <id>\`. Require the real build, gates, packaged smoke, rollback-safe promotion, and immediate manifest verification to pass. Only after promotion succeeds, invoke \`node scripts/package-tauri.mjs --verify --target <id>\` to check the promoted manifest a second time.
5. Re-read every support file and final report/manifest, validate markers and both digests, rerun both fixture suites, rerender setup from unchanged evidence, and prove all six bytes are identical. Compare \`git status --short\` before and after that second render; it must gain no changes. Exercise manual-edit conflict handling in a temporary fixture and prove all six fixture destinations remain byte-for-byte unchanged.

If any support file changes after a check, repeat all terminal checks affected by that change. Finish by reporting: selected app/root and evidence, generated files, target/calibration state, exact fixture and real commands run, artifact/report/manifest paths only if promoted, and any blocker. Never report a successful package, smoke, manifest, calibration, idempotency, or clean status unless the corresponding command and byte/hash checks actually passed.

Do not modify repository files outside the six support destinations. Runtime commands may create or update only the audited generated build outputs and declared owned work/staging/output roots described above.`,
  },
  {
    name: "setup-ci",
    aliases: [],
    description: "Set up or harden CI for any stack",
    prompt: `# /setup-ci — set up CI from scratch OR harden what exists, any stack

You configure CI for THIS project. Completely stack-agnostic: manifests on disk decide
everything — never assume a stack, never copy GitHub's starter workflows (they are stale
and unhardened: no permissions, no concurrency, no timeouts, naive matrices).

## Step 0: Preconditions

- Not a git repository? STOP: tell the user to initialize git first (GG App's Initialize
  Git button, or \`git init\` + a remote).
- Look at \`git remote\`. Not GitHub? Adapt: GitLab -> \`.gitlab-ci.yml\` equivalents of the
  same rules and skip the ruleset step. Other CI providers already configured -> leave
  them alone and say so.

## Step 1: Detect the stack (manifests only)

- \`package.json\` -> Node; the lockfile picks the package manager (pnpm-lock.yaml ->
  pnpm, yarn.lock -> yarn, package-lock.json -> npm, bun.lock/b -> bun).
- \`pyproject.toml\` / \`requirements.txt\` / \`uv.lock\` / \`poetry.lock\` -> Python.
- \`go.mod\` -> Go. \`Cargo.toml\` -> Rust. \`composer.json\` -> PHP. \`Gemfile\` -> Ruby.
- \`*.csproj\`/\`*.sln\` -> .NET. \`pubspec.yaml\` -> Flutter/Dart. \`mix.exs\` -> Elixir.
- \`Dockerfile\` and none of the above -> container build check.
- Nothing detected -> static site: generate CI only if a build/lint tool exists;
  otherwise say honestly that CI adds nothing and skip generation.

## Step 2: Pick the mode

- \`.github/workflows/\` empty (or no real CI) -> **Mode A: generate.**
- Workflows exist -> **Mode B: audit + harden** (still add missing extras below).

## Mode A — generate

Write \`.github/workflows/ci.yml\`. EVERY rule is required:

- \`on:\` push + pull_request targeting the default branch (detect it, don't assume main).
- \`permissions:\n  contents: read\` at workflow level (least privilege).
- ONE job on \`ubuntu-latest\` — never macOS (10x billing) or Windows (2x) unless the
  project has OS-specific native code.
- \`concurrency\` group \`\${{ github.workflow }}-\${{ github.head_ref || github.run_id }}\`
  with \`cancel-in-progress: true\`.
- \`timeout-minutes: 15\` on the job.
- Install + build + test using ONLY commands that exist in the project's
  manifest/scripts; no test command -> build only, and say so in the report.
- Stack setup actions (verify the CURRENT major version against official docs before
  writing): pnpm -> \`pnpm/action-setup\` + \`actions/setup-node\` with \`cache: pnpm\`;
  npm/yarn/bun -> \`actions/setup-node\`/\`actions/setup-bun\` with cache for the lockfile;
  Python -> \`astral-sh/setup-uv\` + \`uv sync\` (fall back to pip when there is no uv
  lockfile); Go -> \`actions/setup-go\` (cache on by default); Rust -> minimal stable
  toolchain + \`Swatinem/rust-cache\`; PHP / Ruby / .NET / Flutter -> the canonical setup
  action for that stack, verified the same way.
- \`paths-ignore\` for \`**/*.md\` and docs folders if the repo has them.
- No artifact uploads.

## Mode B — audit + harden existing workflows

For EVERY file in \`.github/workflows/\`, apply and report one line per change:

1. Add top-level \`permissions: contents: read\` if missing. A job that legitimately
   needs more keeps its own narrower block — note why, never widen globally.
2. Add \`concurrency\` + \`cancel-in-progress: true\` if missing — EXCEPT on
   publish/deploy/release workflows, where cancelling mid-publish is worse than waiting.
3. Add \`timeout-minutes\` if missing (15 for test jobs; more for release jobs).
4. macOS/Windows matrix legs: keep ONLY if the project genuinely tests OS-specific
   behavior (native modules, installers, cross-platform bugs). Otherwise collapse to
   \`ubuntu-latest\` and state the minutes saved (macOS bills 10x, Windows 2x).
5. Ensure the package manager's dependency cache is enabled.
6. Bump actions to the current major version (verify against official docs). Do not
   SHA-pin unless asked — Dependabot keeps majors fresh once added.
7. NEVER weaken a check to make it pass. If an existing workflow is already stricter
   than these rules (e.g. a release job needing \`contents: write\`), leave it and say so.

## Both modes — extras

- \`.github/dependabot.yml\` if missing: version updates for \`github-actions\` plus the
  ecosystem from Step 1 (npm, pip, cargo, go, ...), weekly cadence.
- Branch protection (GitHub repos only): if no ruleset protects the default branch, run
  \`gh api -X POST /repos/{owner}/{repo}/rulesets\` with \`enforcement: active\`,
  \`conditions.ref_name.include: ["~DEFAULT_BRANCH"]\`, and rules \`deletion\` +
  \`non_fast_forward\`. Do NOT require pull requests. On failure (no admin, or private
  repo on a free plan): one line, continue — not an error.
- \`AGENTS.md\` at the repo root if missing: build/test/lint commands for this stack,
  a pointer that CI lives in \`.github/workflows/\` and must stay green, and a rule to
  never commit with \`--no-verify\`. If \`CLAUDE.md\` exists, keep AGENTS.md short and
  point to it.

## Finish

- Do NOT commit anything — the user reviews the diff first. Point them at /commit.
- Report bottom line first: mode chosen + stack detected, files written/changed, what CI
  now runs, rough minutes impact, and anything skipped with the reason.`,
  },
  {
    name: "compare",
    aliases: [],
    description: "Compare real-world code",
    prompt: `Compare the code you just created or modified in this conversation against real-world implementations using the \`mcp__kencode-search__searchCode\` tool.

${KENCODE_UNLOCK_NOTE}

You already know what you just built. For each file you created or modified, use \`mcp__kencode-search__searchCode\` to search for how real projects implement the same patterns. Look at the specific APIs, hooks, functions, and architecture you used.

If you find something consistently done differently across real codebases, or something commonly included that you left out, report it:

\`\`\`
[MISSING/DIVERGENT/INCOMPLETE] file:line - What it is
Wrote: What was implemented
Real-world: What real projects do instead/additionally
Evidence: kencode-search - pattern seen in X out of Y repos searched
\`\`\`

Style preferences and subjective improvements are not valid findings. Only report things backed by clear kencode-search evidence across multiple repos.

After reporting, automatically add every validated finding to the project task list using the \`tasks\` tool. Do not wait for user confirmation.

1. Call the \`tasks\` tool with \`action=list\` before adding anything.
2. Compare each finding against every existing task by meaning, affected code, and intended correction—not title alone. Do not add a semantic duplicate, including a duplicate of a done or in-progress task.
3. For each non-duplicate finding, call the \`tasks\` tool with \`action=add\`. Add exactly one task per finding and use a concise title.
4. Make each task prompt standalone: include the finding type (MISSING, DIVERGENT, or INCOMPLETE), exact file and line, the local implementation, the multi-repo kencode-search evidence, and the concrete correction. The task must be actionable by an agent with no conversation context.
5. After all task calls, if at least one task was added, output exactly: ${TASKS_ADDED_NOTICE}

If the code aligns well with real-world patterns, say so and do not add tasks. That's a good outcome.`,
  },
  {
    name: "setup-skills",
    aliases: [],
    description: "Recommend useful skills",
    prompt: `# Skills Audit: Find useful skills for this project

Analyze this project and recommend skills from the open ecosystem that would make **working on this project more efficient, easier, and safer**. That is the goal, full stop. Every recommendation must pass the test: does this skill save real time, lower real cognitive load, or prevent real mistakes for someone working on THIS project, repeatedly?

Ranked by real impact, not volume.

This project could be anything — a web app, a CLI, a mobile app, a game, firmware, a data pipeline, a library, a scientific tool. Do not assume a stack. Let the codebase tell you what it is, then decide what to look for.

## Phase 1: Understand what this project is

Read just enough to know what kind of project this is. Look at whichever signals actually apply:

- Build / manifest files: \`package.json\`, \`pyproject.toml\`, \`Cargo.toml\`, \`go.mod\`, \`pubspec.yaml\`, \`Podfile\`, Xcode project, Gradle build, \`*.csproj\`, \`CMakeLists.txt\`, Unity/Unreal project files, Makefile — whatever exists.
- Any README, CLAUDE.md, or AGENTS.md.
- Top-level directory layout and obvious entry points.
- Any CI config, lockfile, or config directory that hints at workflow.

**Do NOT read source code yet.** You need only a coarse answer to: what kind of project is this, what platform/stack/language, what stage (greenfield vs mature), and what does the surrounding workflow look like (build, test, release, distribute, deploy — whatever applies for THIS project type).

## Phase 2: Decide which domains to investigate

Based on Phase 1, pick 4–6 domain slices that represent the **recurring work someone actually does on this project** — not abstract "areas of the codebase," but the real activities that eat time, attention, or trust. Do not use a fixed template. The right domains for a Rust CLI are different from an iOS app, a Unity game, a Django backend, a Kubernetes operator, or an ML notebook.

Illustrative only (not prescriptive):

- Web app → shipping features, API changes, handling data safely, deploys
- Mobile app → building screens, store releases, platform quirks, crash & accessibility triage
- CLI tool → adding commands, packaging & distribution, user-facing UX, error handling
- Game → adding content, platform ports, perf passes, build pipeline
- Library → designing public APIs, cutting releases, downstream compatibility, docs/examples
- Data / ML → running experiments, pipeline orchestration, reproducibility, serving models
- Embedded → adding peripherals, size/memory passes, flashing, hardware bring-up

**Announce your chosen domains to the user in one line before spawning agents**, so they can see what you're looking at (e.g. \`Domains: adding content, platform ports, perf passes, build pipeline\`).

## Phase 3: Parallel sweep

Spawn one sub-agent per domain you chose, ${spawnParallel("N")} — one task per domain. Each explores its assigned domain and returns skill-worthy opportunities.

**Skill-worthy means**: a recurring activity someone will do on THIS project — shipping, reviewing, migrating, debugging, onboarding, whatever applies — where a reusable instruction set would make it **faster** (efficient), **lower-effort** (easier), or **less likely to break something** (safer). The test is: will this skill save real time, reduce real cognitive load, or prevent real mistakes, repeatedly, on this project? If no, drop it. A domain returning zero candidates is a valid outcome.

Each sub-agent must return candidates in this exact shape, nothing else:

\`\`\`
[domain] — candidate title
Why: one sentence on the real friction observed in THIS project
Search terms: 2–3 keywords the parent should feed to find-skills
\`\`\`

Don't invent. Don't pad.

## Phase 4: Ecosystem search

After all sub-agents complete, use the **skill** tool to invoke the \`find-skills\` skill. Feed it the aggregated candidate list with search terms. Let find-skills drive discovery across skills.sh, vercel-labs/agent-skills, and anthropics/skills.

For each candidate, record the best 0–1 ecosystem match: skill name, source repo URL, and enough evidence from the skill README/source to prove it fits this project. If no fit exists, record "no match". **Do NOT install anything yet.**

## Phase 5: Prioritized recommendation

Rank every candidate that returned a real match by **crucial factor** — a 0–100% score combining:

- **Frequency** — how often someone will do this work on this project
- **Lift** — how much the skill makes it faster (efficient), lower-effort (easier), or safer (fewer mistakes, broken builds, bad releases) per hit
- **Fit** — how well the ecosystem match actually matches this project

Present highest first, in this exact format:

\`\`\`
# Skills Audit

1. <skill-name> — 92%
   Benefit: <one sentence on what it does for this project>
   Source: <repo URL>
   Scope: project

2. <skill-name> — 78%
   Benefit: …
   Source: …
   Scope: project
\`\`\`

Cap the list at 8. If you'd list more, you're padding. Default scope is \`project\` per find-skills' rules; only mark \`global\` when the skill is genuinely cross-cutting.

If strong candidates had no ecosystem match, list them at the bottom:

\`\`\`
## Gaps worth authoring

- <candidate title> — <why it matters for this project> — consider scaffolding a custom SKILL.md
\`\`\`

## Phase 6: Wait for the user

After presenting the list, ask which (if any) to install. Install nothing without explicit confirmation. Once confirmed, hand off to find-skills to perform the actual install.`,
  },
];

/** Look up a prompt command by name or alias */
export function getPromptCommand(name: string): PromptCommand | undefined {
  return PROMPT_COMMANDS.find((cmd) => cmd.name === name || cmd.aliases.includes(name));
}
