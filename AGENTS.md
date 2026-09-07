<!-- gg:init:start -->

# GG Framework

GG Framework is a pnpm monorepo for GG Coder: a multi-provider coding-agent runtime, CLI, and Tauri desktop application with persistent sessions, tools/MCP, and Project Notes workflows.

## Ownership

- `packages/gg-ai`: provider-neutral model/message/tool schemas, provider adapters, streaming, and model metadata.
- `packages/gg-agent`: the reusable agent loop, tool execution, compaction, subagents, and transport-independent session orchestration.
- `packages/gg-core`: shared auth/config/path storage plus Project Notes and Roadmap contracts used across processes.
- `packages/ggcoder`: the `ggcoder` CLI and desktop Node daemon; owns prompts, sessions, skills, MCP, tools, and app HTTP/SSE endpoints.
- `packages/gg-boss`: the `ggboss` CLI for higher-level multi-agent orchestration.
- `gg-app`: React/Tauri desktop shell; TypeScript owns UI state, Rust owns native OS access and proxies the Node daemon.
- `packages/gg-editor` and `packages/gg-editor-premiere-panel`: Premiere automation runtime and its CEP panel.
- `packages/gg-voice` and `packages/ggcoder-eyes`: speech tooling and the vision/screen-observation service.
- `Matey`: a separate MCP-enabled local agent application in the same workspace.

## Architecture

- The desktop webview never calls the daemon's loopback HTTP API directly: its secure Tauri origin would trigger mixed-content failures. Route commands through Rust `invoke`; Rust forwards SSE as `agent-event`.
- Desktop windows share one Node daemon process. Each pane is a logical daemon session addressed by session ID; Rust maps pane/window state and recovers sessions after daemon respawn.
- Desktop events are window-targeted with `emit_to`. Listen through the current webview window, not Tauri's global listener, or secondary project windows silently miss events.
- The daemon bootstrap credential remains native-only. Rust mints logical sessions and sends both per-launch `x-gg-token` and logical `x-gg-session` headers; never expose either to webview code.
- Cross-package behavioral contracts belong in `gg-core`; the desktop frontend imports those contracts rather than maintaining parallel response types.

## Gotchas / Invariants

- `auth.json` is shared by CLI, daemon, usage pollers, and multiple app windows. Credential mutation must lock, re-read the latest file, and atomically replace it; writing a cached snapshot erases another process's login.
- Forced OAuth refreshes must carry the rejected access token. A sibling may already have rotated the shared grant; refreshing again can revoke the new token and create a cross-process logout loop.
- Preserve repository-wide LF checkout rules. Seeded agent fixtures are content-hashed, so CRLF conversion makes Windows fail despite unchanged text.
- Framework build outputs are dependency-ordered: `gg-ai` → `gg-agent` → `gg-core` → `ggcoder`; build the sidecar only after those outputs exist.
- A packaged sidecar is target-specific because it includes a staged Node runtime and native addons. Stage Node, bundle the sidecar, then smoke it on each target OS; do not reuse another OS's bundle.
- Multi-line GitHub Actions steps must declare `shell: bash`. PowerShell otherwise reports only the final command's status on Windows and can hide earlier test/build failures.
- Keep the Local Fork identity (`GG Coder Local Fork`, `com.ggcoder.local-fork`, `gg-coder-local-fork`) synchronized across Tauri config, Cargo, Node paths, and Rust. The isolated identity prevents local builds overwriting official app data/installations.
- Local Fork updater artifacts and endpoints remain disabled. Upstream integration uses the guarded local-update workflow on `custom/local-customizations`; it creates recovery evidence, restores dirty files byte-for-byte, verifies identity, and never pushes unless explicitly requested.
- `bench/size-gate.mjs` accepts filters only through `--only`; a positional target is ignored and accidentally checks every artifact, including an unbuilt sidecar.

## Unique Workflows

- Generated-output auditing is outside package scripts: run `node --test scripts/audit-generated.test.mjs`, then `node scripts/audit-generated.mjs --inspect`. It protects `.gg`, secrets/config, dependencies, and bundled binaries from generated cleanup.
- Windows Phase 25 developer smoke windows start minimized. Pass `--visual` to the fixture launcher only when visible UI or focus behavior is required.
- Desktop distribution sequence is framework builds → Node staging → sidecar bundling → bundled-runtime smoke → Tauri packaging. Windows CI additionally extracts and launches the MSI to verify the installed executable, visible window, runtime, and sidecar.
- Public releases are tag-driven and ship Windows plus Apple Silicon macOS only. The tag must match `v<semver>`, point into `origin/main`, and have successful CI for that exact SHA.
- Release preflight requires updater signing credentials on every platform and Apple signing/notarization credentials for macOS. macOS nested Node/native-addon binaries must be signed before Tauri assembles and notarizes the app.
<!-- gg:init:end -->

## Local Fork release-note upkeep

- Perform release-note upkeep only when explicitly rebuilding the distributable Local Fork app or syncing with upstream. Ordinary feature/fix work, dev-server runs, and verification builds do not trigger upkeep. At that checkpoint, apply all requirements below to accumulated user-facing changes without a separate reminder. Skip internal-only refactors, tests, tooling, and documentation changes unless they change something users experience.
- Use the existing content mechanism: `gg-app/src/local-release-notes.json` for current notes, `gg-app/src/local-changelog.ts` for history, and the existing Decisions summaries. Rewrite relevant entries instead of appending duplicate reports. Preserve shipped history IDs and dates; do not redesign the UI or introduce another feed.
- Before writing, read upstream’s actual entries in `gg-app/src/changelog.ts` (at the upstream revision being integrated when applicable). Match their user-first voice, length, structure, and inline highlights. Explain what changed, how it behaves, and why it helps where useful—not terse slogans or an integration report. Verify control names against the UI.
- Keep rendered copy free of file paths, test counts, internal jargon, and unverified claims. Describe completed, verified changes; keep proposals and pending work clearly separate in the review or plan, never presented as shipped updates. Updating source notes does not mean the installed app has updated.
- Update Decisions only for confirmed integration outcomes. Use the existing verified record’s `summary` field under `.gg/local-fixes/backups/*/decisions.json`; preserve its classification, merge, verification, and installer evidence. Never invent a verified record or edit evidence to support a summary. Ordinary feature work does not need a new integration decision.
- After content changes, run the relevant existing What's New/Decisions tests and `pnpm --filter gg-app check` as standalone commands. Exact-copy expectations may follow intentional wording or highlight changes, but retain exact rendered-content, history, and validation assertions; never weaken checks to get a pass.
- Inspect both rendered Local Fork and Decisions tabs using the existing preview/native tooling, including the normal 600×640 window and a narrower viewport. Check readability, wrapping, scrolling, and visible controls. Clearly report unavailable checks or mocked native boundaries; do not claim an installer was verified by a browser preview.
- Keep this upkeep scoped: preserve unrelated work and Local Fork customizations. Do not rebuild installers, install, commit, or push merely to update notes; those actions require their own explicit authorization.
