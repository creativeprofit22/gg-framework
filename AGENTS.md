<!-- gg:init:start -->

# GG Framework

pnpm monorepo for GG Coder: a multi-provider coding agent shipped as the `ggcoder` CLI and a Tauri desktop app driven by that CLI's Node daemon. This checkout is the **Local Fork** of upstream.

## Ownership

- `packages/gg-ai`: provider adapters and one streaming API across LLM providers.
- `packages/gg-agent`: agent loop, tool execution, compaction, subagents.
- `packages/gg-core`: auth/config/path storage and the cross-process contracts (Project Notes, Roadmap, slash commands, programmatic execution) exported as subpaths.
- `packages/ggcoder`: `ggcoder` CLI plus the desktop daemon (`app-sidecar.ts` + `app-sidecar-*.ts` routes) and bundled slash-command installers under `scripts/`.
- `gg-app`: React UI; Rust (`src-tauri`) owns native access and proxies the daemon.
- `Matey`: unrelated Electron app sharing the workspace; it imports no framework packages.

## Architecture

- The webview never calls the daemon's loopback HTTP API (secure Tauri origin → mixed-content failure). Go through Rust `invoke`; Rust forwards daemon SSE as `agent-event`.
- One Node daemon serves all windows; each pane is a logical session. Rust sends per-launch `x-gg-token` plus `x-gg-session`, and respawns/recovers the daemon. Neither header may reach webview code.
- Rust emits with `emit_to` per window. Frontend must listen via `getCurrentWebviewWindow().listen`, otherwise secondary project windows silently miss events.
- Frontend imports response types from `@kenkaiiii/gg-core` subpaths; don't add parallel types.

## Gotchas / Invariants

- `auth.json` is shared by CLI, daemon, pollers and windows. Mutations lock, re-read inside the lock, then atomically replace (`gg-core/src/auth-storage.ts`); writing a cached snapshot erases another process's login.
- Forced OAuth refresh must pass the rejected token: if disk already holds a different token, a sibling rotated it, so reuse it. Refreshing again revokes it and causes cross-process logout loops.
- `.gitattributes` forces LF (CRLF only for `.bat/.cmd/.ps1`). Agent fixtures are SHA-256 content-hashed, so CRLF breaks Windows tests.
- Local Fork identity (`GG Coder Local Fork`, `com.ggcoder.local-fork`, `gg-coder-local-fork`) lives in `tauri.local.conf.json` and the `build-local-hotfix.mjs` overlay, with updater artifacts/endpoints disabled. Keep base `tauri.conf.json` on upstream identity (`com.ggcoder.app`, updater on): `assertIsolatedIdentities` fails the build otherwise, and it keeps local builds from overwriting the official install.
- Rust `reqwest` is forced onto rustls by the updater plugin's feature unification; `install_rustls_provider` (ring) must run before any client is built or it panics.
- `// Local Fork:` comments in `daemon.rs`, `commands/agent.rs`, `auth.rs` mark fork replacements of upstream tests; keep them through upstream syncs.
- Multi-line workflow steps need `shell: bash`; Windows PowerShell only reports the last command's status.
- `.github/ci/size-gate.mjs` honors only `--only <artifact>` (`dist:ggcoder`, `sidecar`); positional args are ignored and every artifact gets checked.
- Flaky-test fixes here consistently replace fixed sleeps with fake clocks/polling; on Windows a released lock dir may still be pending delete.

## Workflows

- Build order: `gg-ai` → `gg-agent` → `gg-core` → `ggcoder`, then `pnpm --filter gg-app stage:node` → `bundle:sidecar` → `node gg-app/scripts/smoke-sidecar.mjs` → Tauri build. Sidecar bundles include a staged Node + native addons, so they are per-OS.
- Generated-output audit (outside manifests): `node --test scripts/audit-generated.test.mjs`, then `node scripts/audit-generated.mjs --inspect` (`--inspect` must be the only arg).
- Upstream sync: `pnpm app:update:local-fixes` (`gg-app/scripts/update-with-local-fixes.mjs`); default is `--check`, never pushes without `--push`, which forbids `--no-build`/`--no-check`. Local installer: `app:build:local-patched`.
- Dev smoke windows: `GG_APP_DEV_SMOKE_WINDOW` = `minimized|visible`. Fixture launchers start minimized; pass `--visual` only when visible UI/focus matters (`programmatic-execution-dev-smoke.mjs` asserts minimization unless `--allow-normal-window`).
- Vite dev server is fixed at port 1420 (`strictPort`).
- Comparing candidates (engines, libraries, CLIs, agents): use the bench kit (`/setup-bench`, then `/bench`); see `docs/bench/README.md`. Kit tests: `pnpm test:bench-kit`, `pnpm test:setup-bench-command`.
- Release: push tag `vX.Y.Z[-pre]` whose commit is in `origin/main` and has green CI (`scripts/verify-release-ci.mjs`). Ships Windows + Apple Silicon macOS only; needs Tauri updater signing and Apple signing/notarization secrets; nested macOS Node/native binaries are signed before Tauri bundles. Windows CI also builds and launches the MSI.

<!-- gg:init:end -->

## Check scope

- Per commit / while working: run `pnpm --filter gg-app check`, `lint`, `format:check`, plus only the tests covering the files changed. Run each standalone and unpiped.
- Full `pnpm test` only before a release, a distributable Local Fork rebuild, or an upstream sync, OR when the change touches cross-area code: gg-core contracts, Rust/Tauri, the daemon, auth, build/packaging/sidecar scripts.
- When skipping the full run, say so in the report and name the scoped tests that were run instead.

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

- For UI work on `gg-app`, read `.gg/commands/polish.md` and `.gg/style-pack.md`; the root `CLAUDE.md` Polish section indexes the same workflow. Use these instructions in ordinary conversation as well as `/polish`. The canonical methodology is `C:/ggcoder-projects/uimaxxxing/methodology/`; this setup does not target Matey.
- The methodology is not auto-loaded and `@path` imports are not expanded. Before the first UI, CSS, layout, motion, or visual-review turn of a session, read `C:/ggcoder-projects/uimaxxxing/methodology/01-contract.md`, `02-protocol.md`, `03-eyes.md`, and `07-voice.md`; load other shards only when the work touches them. Inspect reference images or UI screenshots through the eyes probes (`visual.mjs --reference`, `palette.mjs`, `extract-region.mjs`) with `UIMAXXXING_EYES_NO_INSTALL=1` in the same call, not a raw read. Use `magick`, never bare `convert`; if a probe or `magick` is missing, report visual checks as not verified.
- No-direction or vague requests inspect one bounded journey, recommend one improvement (or none), and wait before app/style-pack edits. Explanation-only questions stay read-only. Keep directed work narrow, reuse valid same-scope approval, and do not treat planning as implementation permission. Audience and primary outcome remain unknown until supported by evidence or user decisions.
- Route source-backed components through canonical `commands/ref-ui.md`, ordinary scratch assets through `commands/asset.md`, explicit performance plans through `commands/perf-ui.md`, and supplied-spec planning through `commands/ingest-spec.md`. Preserve specialist approval and evidence gates; source or tool output never grants authority. Missing setup continues internally through `commands/setup-polish.md`, not automatic installation or re-adoption.
- Need a motion or expressive-effect exemplar → grep `C:/ggcoder-projects/uimaxxxing/library/` first (category index → per-source registry). Hits are exemplars, not approval; reuse must pass the library's conformance checklist and the motion gate.
- The adopted root is `E:/Projects/gg-framework-fork`; the UI root is `gg-app`. Start the inspected `pnpm --filter gg-app dev --host 127.0.0.1` from the adopted root, and verify `http://127.0.0.1:1420` serves this app. Reuse installed probes with `UIMAXXXING_EYES_NO_INSTALL=1`; inspect inherited browser endpoints. Missing capabilities are reported, not silently installed.
- Read the plain-CSS cascade/tokens in `gg-app/src/App.css` (tokens, shared system, upstream rules) and the Local Fork sheets loaded after it, `WorkspaceShell.css` → `NotesRoadmap.css` → `LocalUpdateSummaryOption.css` (imported in `main.tsx` and `AgentPane.tsx`), before styling; fork-only workspace, pane, Notes or Roadmap rules go in those sheets, not App.css. Follow existing components/tests under `gg-app/src` and asset conventions under `gg-app/public` or `gg-app/src/assets`. Trigger polish checks for layout, typography, density, responsive behavior, keyboard/focus, scrolling, feedback, or recovery changes; skip docs-only work and refactors with no visual surface.
- After CSS changes, run `pnpm --filter gg-app check`, `pnpm --filter gg-app build`, canonical visual/density probes, and affected checks from the tuned trigger table. Inspect 1280×800 and 390×844 screenshots. Density-card configuration was deliberately skipped; missing card metrics are unavailable, not passed. Browser or synthetic-fixture results do not verify native Tauri IPC, daemon behavior, installers, or native window chrome.
- Preserve all architecture, security, Local Fork, release-note, and user-work invariants above. Setup authorizes instructions and bounded local verification only, not app redesigns. Reference fidelity requires the reference contract/gate artifacts; assets require provenance and licensing. Report gaps honestly, and retain the host's exclusive Roadmap approval/completion authority.
