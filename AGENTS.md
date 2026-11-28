<!-- gg:init:start -->

# GG Framework

pnpm monorepo for GG Coder: a multi-provider coding agent shipped as the `ggcoder` CLI and a Tauri desktop app driven by that CLI's Node daemon. This checkout is the **Local Fork** of upstream.

- User-facing work must work in `gg-app`; a CLI/Ink-only change is incomplete.
- Read `CONTEXT.md` before naming anything.
- `gg-app` reaches the engine over HTTP only. `gg-core` depends only on `gg-ai` and owns model and auth logic.
- Retired, never re-add to builds or releases: Realtime Voice, Boss, Editor, Premiere Panel, Eyes.

- `packages/gg-ai`: provider adapters behind one streaming API.
- `packages/gg-agent`: agent loop and tool execution only (exposes a `transformContext` hook). Compaction and subagents live in `ggcoder/src/core/`.
- `packages/gg-core`: auth/config/path storage and the cross-process contracts (Project Notes, Roadmap, slash commands, programmatic execution, `verify-plan`) exported as subpaths. Harness check module map: [docs/harness-checks.md](docs/harness-checks.md).
- `packages/ggcoder`: CLI, tools, compaction, subagent manager, desktop daemon (`app-sidecar.ts` + `app-sidecar-*.ts` routes), slash-command installers in `scripts/`.
- `gg-boss`, `gg-editor*`, `gg-voice`, `ggcoder-eyes`, `experiments/`, `stranger/` are empty.
- `gg-app`: React UI; Rust `src-tauri` owns native access and spawns/proxies the daemon.
- `Matey`: unrelated Electron app; imports no framework packages but is in the workspace and root lint/format.

## Architecture

- The webview never calls the daemon's loopback HTTP (secure Tauri origin → mixed-content failure). Go through Rust `invoke`; Rust forwards daemon SSE as `agent-event`.
- One daemon serves all windows; each pane is a logical session. Rust adds the per-launch `x-gg-token` and `x-gg-session`; neither may reach webview code.
- Rust emits with `emit_to` per window. The frontend must listen via `getCurrentWebviewWindow().listen`, otherwise secondary project windows silently miss events.
- Frontend imports response types from `@kenkaiiii/gg-core` subpaths; don't add parallel types.

## Gotchas / Invariants

- `auth.json` is shared by every process. Mutations lock, re-read inside the lock, then atomically replace (`gg-core/src/auth-storage.ts`); writing a cached snapshot erases another process's login. A waiter can break the lock during a slow refresh, so never write back a snapshot taken before a network call. A failed refresh removes only that provider, never the whole file.
- Forced OAuth refresh must pass the rejected token: if disk already holds a different one, a sibling rotated it, so reuse it. Refreshing again revokes it → cross-process logout loops.
- Provider HTTP goes through `gg-ai/src/utils/provider-fetch.ts` (undici's 300s header/body caps killed long requests). The stall watchdog counts SSE pings as activity because silent thinking can last many minutes.
- Windows file locks (`gg-core/src/file-lock.ts`): a released lock dir may still be pending delete (EPERM, not EEXIST); never break a live holder's lock before its contents are written. Flaky-test fixes here use injected clocks/polling, not sleeps.
- `.gitattributes` forces LF (CRLF only for `.bat/.cmd/.ps1`): ggcoder's seeded agent fixtures are SHA-256 hashed, so CRLF breaks Windows tests.
- `script-src` in `tauri.conf.json` needs both `tauri://localhost` and `http://tauri.localhost`; release builds broke twice without it, and dev runs don't catch it.
- Identities: base `tauri.conf.json` stays upstream (`com.ggcoder.app`, updater on). Local Fork (`com.ggcoder.local-fork`) lives in `tauri.local.conf.json` + the `build-local-hotfix.mjs` overlay with updater off. `tauri.installed-smoke.conf.json` adds `com.ggcoder.local-fork.installed-smoke`. `assertIsolatedIdentities` fails the build if they leak (keeps local builds off the official install).
- Rust `reqwest` is `rustls-no-provider` (updater feature unification): building a client before `install_rustls_provider` panics. Use `http_client_builder()`, including in tests.
- `// Local Fork:` comments (`daemon.rs`, `commands/agent.rs`, `auth.rs`, `commands/files.rs`) mark fork replacements of upstream tests/behavior; keep them through upstream syncs.
- Multi-line workflow steps need `shell: bash`: Windows PowerShell reports only the last command's status.
- `.github/ci/size-gate.mjs` honors only `--only <artifact>` (`dist:ggcoder`, `sidecar`, `frontend:initial`); positional args are ignored and every artifact gets checked. `--update` rewrites the baseline; don't use it casually.
- Project-reported reuse (`reused-pass`, supa `skip` with `lastRun`) is advice, never verification evidence.
- A `.gg/verify-plan.json` command runs only after per-descriptor approval (`verifyPlanApprovals`, sha256 of the exact text); project MCP trust never approves it, and any edit needs approval again.
- Machine-profile defaults pass `VITEST_MAX_WORKERS`/Jest worker vars through but never set them (that would override a project's `maxWorkers`/`fileParallelism: false`).

## Build and test

- Packages resolve each other through `dist`: run `pnpm build` before `pnpm check`, `pnpm test` or `pnpm --filter gg-app tauri dev`. After engine or Rust edits, rebuild and restart the app.
- One test file: `pnpm --filter <pkg> test <name>`. Adding `--` runs the whole suite, and the repo root has no vitest config.
- pnpm settings live in `pnpm-workspace.yaml`, not package.json. A new native dep must be added to `onlyBuiltDependencies` or its install script silently doesn't run.
- `patches/ink@6.8.0.patch` is not applied; ggcoder uses the fork `@kenkaiiii/ink`.
- After bumping `@anthropic-ai/claude-agent-sdk`, run `node .github/ci/claude-code-manifest.mjs`; CI fails on a stale manifest.
- Windows CI fails with EBUSY/EPERM when a test removes files a live child still holds: wait for exit first, or reuse `retryWindowsReplace` / `removeWhenReleased`.

## App and sidecar

- A new sidecar feature needs four parts: sidecar handler, Rust `#[tauri::command]` proxy that attaches the session, its `generate_handler!` entry, and a typed `agent.ts` wrapper that awaits `waitForReady()`.
- `~/.gg/gg-app.json` is written by Rust and the sidecar: change its schema on both sides, and merge your own key under the lock instead of overwriting the file.
- App-visible agent errors go through `broadcastError` in `app-sidecar.ts`, never a raw provider string.
- Passing `skills` to `AgentSession` disables skill discovery; Motion relies on this, so keep `assets/motion/skills` out of `assets/skills`.
- Rust: resolve `~/.gg` paths with `paths::home_dir()` and spawn children through `hide_console`; anything else breaks only on Windows.
- The packaged sidecar runs Node 24.22.3, not your dev Node. A new native, WASM, lazily loaded or spawned package must be externalized in `bundle-sidecar.mjs` (peers in `RUNTIME_PEERS`). Both fail only in installed builds.
- App logs are in `~/.gg/gg-app-sidecar.log`, not `debug.log`.

## Prompt cache

- The tool array is append-only: `tool_search` promotion must `push` onto `this.tools`; reordering invalidates the prefix cache.
- Mid-session env changes go in as an appended env-delta message (`core/env-delta.ts`); never re-render the cached system prompt.

## Release and packaging

- Every npm release also needs a desktop release: `pnpm --filter gg-app bump …`, a `gg-app/src/changelog.ts` entry, and the `v<version>` tag pushed last, on `origin/main`.
- Packaging: follow `gg-app/DISTRIBUTION.md`; `tauri build` does not stage Node or bundle the sidecar.

- Build order: `gg-ai` → `gg-agent` → `gg-core` → `ggcoder`, then `pnpm --filter gg-app stage:node` → `bundle:sidecar` → `node gg-app/scripts/smoke-sidecar.mjs` → Tauri build. Root `build` (`pnpm -r`) doesn't enforce this; CI does. Sidecar bundles hold a staged Node + native addons, so they are per-OS.
- Generated-output audit: `node --test scripts/audit-generated.test.mjs`, then `node scripts/audit-generated.mjs --inspect` (`--inspect` must be the only arg).
- Upstream sync: `pnpm app:update:local-fixes` (`gg-app/scripts/update-with-local-fixes.mjs`). Default is `--check`; it never pushes without `--push`, which forbids `--no-build`/`--no-check`. Local installer: `app:build:local-patched`. Native dev with fork identity: `pnpm --filter gg-app dev:native`.
- Dev smoke windows: `GG_APP_DEV_SMOKE_WINDOW` = `minimized|visible`. Launchers default to minimized; `--visual` only when visible UI/focus matters. `programmatic-execution-dev-smoke.mjs` (Windows-only, exact argv order) asserts minimization unless `--allow-normal-window`. Roadmap-reliability is always visible; `completed-verification-dev-smoke.mjs` requires `--visual`. Roadmap-reliability, cross-pane-isolation and `qwen-connection-dev-smoke.mjs` require `--identity com.ggcoder.local-fork`. Native smokes share port 1420 (Vite `strictPort`), so run them one at a time.
- Drive the running dev app with the `dev_app` tool, never sleeps or log watchers ([docs/dev-app-tool.md](docs/dev-app-tool.md)).
- Release: push tag `vX.Y.Z[-pre]` whose commit is in `origin/main` and has green CI (`scripts/verify-release-ci.mjs`). Ships Windows + Apple Silicon macOS only; Linux is deliberately left out of the release matrix. Nested macOS Node/native binaries are signed (`sign-nested-macos.sh`) before tauri-action. Windows CI builds and launches the MSI.

<!-- gg:init:end -->

## Check scope

- Per commit / while working: run `pnpm --filter gg-app check`, `lint`, `format:check`, plus only the tests covering the files changed. Run each standalone and unpiped (no `| tail`, `| head`, `| grep`; piped output can look idle and get killed). Don't re-run a check that already passed unless a file changed since.
- Change only inside one `packages/<name>`: run `pnpm --filter @kenkaiiii/<name> check`, `pnpm exec eslint <changed files>`, `pnpm exec prettier --check <changed files>`, and `pnpm --filter @kenkaiiii/<name> exec vitest run <test files>` for `src/**` tests. `scripts/*.test.mjs` files are node:test, not vitest: run `node --test <file>` or the matching root `pnpm test:<name>` script. Skip root `lint`/`check`.
- Cross-area changes (gg-core contracts, Rust/Tauri, the daemon, auth, build/packaging/sidecar scripts) run the affected packages' `test` scripts; gg-core contract changes also run the ggcoder and gg-app tests.
- Full `pnpm test` only before a release or after an upstream sync, and only if no full run has passed since the last code change. A Local Fork rebuild alone (installer or `dev:native`) needs no full run; the installer build (`build:local-patched`) also runs its own Roadmap safety tests. Before a full run, check that no other window is running a heavy build or test: overlapping runs on this machine's hard drive cause false timeouts.
- After a timeout-only or timing failure, rerun just that one file once; never rerun the full suite to confirm it. Local vitest runs don't retry `alone` tests (ggcoder's `alone` tests retry twice on CI via `scripts/test-support/retry-policy.mjs`; gg-app's never retry).
- When skipping the full run, say so in the report and name the scoped tests that were run instead.
- Test runs get their own temp folder (`ggt-*`, via `scripts/test-support/run-temp.mjs` in every vitest `globalSetup` and `with-run-temp.mjs` for root `node --test` scripts), so `os.tmpdir()` in tests is not the system temp. `node scripts/test-support/clean-legacy-temp.mjs` only lists leftovers; `--apply` deletes and needs the user's approval.
- Vitest's prepared-file cache (`experimental.fsModuleCache`, via `scripts/test-support/module-cache.mjs`) is off by default for ggcoder and gg-app: measured 2026-11, warm runs were not faster than the uncached baseline. Opt in with `GG_VITEST_MODULE_CACHE=on`; it then lives in `%LOCALAPPDATA%\gg-vitest-cache\<package>` (about 55 MB each; `GG_VITEST_MODULE_CACHE_DIR` overrides the base, never `node_modules`). Clear it with `vitest --clearCache` in that package (with the variable on) or delete the folder.

## Verification status handoff

- Before discussing Local Fork `/ship`, release blockers, Roadmap regression or historical daemon verification, read `.gg/verification/current-status.md` and the relevant linked evidence. This applies to status questions as well as execution work; ordinary unrelated coding does not require it.
- Dated reports and their “other gates remain open” wording are historical snapshots, not a current task inventory. Check later results and completion records before carrying a blocker forward. Distinguish completed fixes, verification not yet exercised, historical unknowns and confirmed current defects. Same HEAD does not establish the same dirty-tree source.
- Maintain that handoff when new evidence changes a listed status: update the relevant entry with scope, provenance and evidence, preserving original logs/verdicts and recorded failures/skips. Do not reopen completed work or claim overall release approval from a scoped pass. Missing handoff/evidence means status is unverified, not permission to guess or rerun work.

## Local Fork release-note upkeep

- Perform release-note upkeep only when explicitly rebuilding the distributable Local Fork app or syncing with upstream. Ordinary feature/fix work, dev-server runs, and verification builds do not trigger upkeep. At that checkpoint, apply all requirements below to accumulated user-facing changes without a separate reminder. Skip internal-only refactors, tests, tooling, and documentation changes unless they change something users experience.
- Use the existing content mechanism: `gg-app/src/local-release-notes.json` for current notes, `gg-app/src/local-changelog.ts` for history, and the existing Decisions summaries. Rewrite relevant entries instead of appending duplicate reports. Preserve shipped history IDs and dates; do not redesign the UI or introduce another feed.
- Before writing, read upstream’s actual entries in `gg-app/src/changelog.ts` (at the upstream revision being integrated when applicable). Match their user-first voice, length, structure, and inline highlights. Explain what changed, how it behaves, and why it helps where useful—not terse slogans or an integration report. Verify control names against the UI.
- Keep rendered copy free of file paths, test counts, internal jargon, and unverified claims. Describe completed, verified changes; keep proposals and pending work clearly separate in the review or plan, never presented as shipped updates. Updating source notes does not mean the installed app has updated.
- Update Decisions only for confirmed integration outcomes. Use the existing verified record’s `summary` field under `.gg/local-fixes/backups/*/decisions.json`; preserve its classification, merge, verification, and installer evidence. Never invent a verified record or edit evidence to support a summary. Ordinary feature work does not need a new integration decision.
- After content changes, run the relevant existing What's New/Decisions tests and `pnpm --filter gg-app check` as standalone commands. Exact-copy expectations may follow intentional wording or highlight changes, but retain exact rendered-content, history, and validation assertions; never weaken checks to get a pass.
- Inspect both rendered Local Fork and Decisions tabs using the existing preview/native tooling, including the normal 600×640 window and a narrower viewport. Check readability, wrapping, scrolling, and visible controls. Clearly report unavailable checks or mocked native boundaries; do not claim an installer was verified by a browser preview.
- Keep this upkeep scoped: preserve unrelated work and Local Fork customizations. Do not rebuild installers, install, commit, or push merely to update notes; those actions require their own explicit authorization.

## Polish

- **Hard rule: UImaxxxing is mandatory for all UI/UX work in this project, no exceptions.** UI/UX means anything users see or do in `gg-app`: layout, CSS, components, copy and microcopy, accessibility, motion, assets, UI performance, source-backed or reference components, design specs, and user journeys. It applies in every mode, not just `/polish`: normal conversation, plan mode, reviews, delegated child agents, and Roadmap work.
  - Plan mode: read the methodology shards below before researching. The plan names the UImaxxxing route (`polish.md`, `ref-ui.md`, `asset.md`, `perf-ui.md` or `ingest-spec.md`), the journey or surfaces affected, and the trigger-table probes that will verify it.
  - Roadmap: every drafted or edited phase that touches UI/UX says in `sourcePrompt` to follow `E:/Projects/gg-framework-fork/.gg/commands/polish.md` and the matching route, and its `doneWhen` includes the UImaxxxing verification (the CSS-change floor, affected trigger-table probes, and inspected 1280×800 and 390×844 screenshots). A UI phase is not Done without that evidence. This shapes proposals only; Roadmap approval and completion stay with the user.
  - Child-agent briefs for UI/UX work carry this rule and the paths they need. Skip UImaxxxing only when the user explicitly says so for that task. Work with no user-facing surface (engine, Rust, tests, docs-only) is out of scope. This rule adds steps; it never loosens an approval gate or the invariants above.
- For UI work on `gg-app`, read `E:/Projects/gg-framework-fork/.gg/commands/polish.md` and `E:/Projects/gg-framework-fork/.gg/style-pack.md`; the root `CLAUDE.md` Polish section indexes the same workflow. From another git worktree, read these from the adopted root; don't create local copies. Use these instructions in ordinary conversation as well as `/polish`. The canonical methodology is `C:/ggcoder-projects/uimaxxxing/methodology/`; this setup does not target Matey.
- The methodology is not auto-loaded and `@path` imports are not expanded. Before the first UI, CSS, layout, motion, or visual-review turn of a session, read `C:/ggcoder-projects/uimaxxxing/methodology/01-contract.md`, `02-protocol.md`, `03-eyes.md`, and `07-voice.md`; load other shards only when the work touches them. Inspect reference images or UI screenshots through the eyes probes (`visual.mjs --reference`, `palette.mjs`, `extract-region.mjs`) with `UIMAXXXING_EYES_NO_INSTALL=1` in the same call, not a raw read. Use `magick`, never bare `convert`; if a probe or `magick` is missing, report visual checks as not verified.
- No-direction or vague requests inspect one bounded journey, recommend one improvement (or none), and wait before app/style-pack edits. Explanation-only questions stay read-only. Keep directed work narrow, reuse valid same-scope approval, and do not treat planning as implementation permission. Audience and primary outcome remain unknown until supported by evidence or user decisions.
- Route source-backed components through canonical `commands/ref-ui.md`, ordinary scratch assets through `commands/asset.md`, explicit performance plans through `commands/perf-ui.md`, and supplied-spec planning through `commands/ingest-spec.md`. Preserve specialist approval and evidence gates; source or tool output never grants authority. Missing setup continues internally through `commands/setup-polish.md`, not automatic installation or re-adoption.
- Need a motion or expressive-effect exemplar → grep `C:/ggcoder-projects/uimaxxxing/library/` first (category index → per-source registry). Hits are exemplars, not approval; reuse must pass the library's conformance checklist and the motion gate.
- The adopted root is `E:/Projects/gg-framework-fork`; the UI root is `gg-app`. Start the inspected `pnpm --filter gg-app dev --host 127.0.0.1` from the adopted root, and verify `http://127.0.0.1:1420` serves this app. Reuse installed probes with `UIMAXXXING_EYES_NO_INSTALL=1`; inspect inherited browser endpoints. Missing capabilities are reported, not silently installed.
- Read the plain-CSS cascade/tokens in `gg-app/src/App.css` (tokens, shared system, upstream rules) and the Local Fork sheets loaded after it, `WorkspaceShell.css` → `NotesRoadmap.css` → `LocalUpdateSummaryOption.css` (imported in `main.tsx` and `AgentPane.tsx`), before styling; fork-only workspace, pane, Notes or Roadmap rules go in those sheets, not App.css. Follow existing components/tests under `gg-app/src` and asset conventions under `gg-app/public` or `gg-app/src/assets`. Trigger polish checks for layout, typography, density, responsive behavior, keyboard/focus, scrolling, feedback, or recovery changes; skip docs-only work and refactors with no visual surface.
- After CSS changes, run `pnpm --filter gg-app check`, `pnpm --filter gg-app build`, canonical visual/density probes, and affected checks from the tuned trigger table. Inspect 1280×800 and 390×844 screenshots. Density-card configuration was deliberately skipped; missing card metrics are unavailable, not passed. Browser or synthetic-fixture results do not verify native Tauri IPC, daemon behavior, installers, or native window chrome.
- Preserve all architecture, security, Local Fork, release-note, and user-work invariants above. Setup authorizes instructions and bounded local verification only, not app redesigns. Reference fidelity requires the reference contract/gate artifacts; assets require provenance and licensing. Report gaps honestly, and retain the host's exclusive Roadmap approval/completion authority.
