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