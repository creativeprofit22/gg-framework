# gg-framework

A pnpm workspace for reusable LLM/agent libraries and products: the `ggcoder` coding-agent CLI, the React/Tauri GG App desktop product, multi-project orchestration, realtime voice, and video-editor integrations. CI uses Node 22, pnpm 10, and Rust stable.

## Stable structure

- `packages/gg-ai` (`@kenkaiiii/gg-ai`): provider transports, unified streaming/events, request transforms, and provider error formatting.
- `packages/gg-agent` (`@kenkaiiii/gg-agent`): provider-independent agent loop, tool execution, and agent events.
- `packages/gg-core` (`@kenkaiiii/gg-core`): UI-free shared model registry, paths, auth/OAuth, logging, Telegram, transcription, usage, and updater services.
- `packages/ggcoder` (`@kenkaiiii/ggcoder`): `ggcoder` CLI, coding tools, sessions, Ink UI, MCP, project discovery, and `src/app-sidecar.ts` for GG App.
- `packages/gg-boss`: `ggboss` multi-project orchestrator.
- `packages/gg-voice`: realtime voice sessions and ggcoder/ggboss bridges.
- `packages/gg-editor`: Resolve/Premiere editing-agent CLI; its build generates skills and copies Python helpers.
- `packages/gg-editor-premiere-panel`: Premiere UXP/legacy CEP panel and installer CLI.
- `packages/ggcoder-eyes`: project-agnostic screenshot, runtime-log, API, and capture-sink probes.
- `gg-app`: primary desktop product; React/Vite frontend in `src`, Tauri/Rust host in `src-tauri`.
- `Matey`: separate Electron chat UI prototype.
- `benchmarks`, `bench`: repository-level benchmark/audit harnesses, not product runtime; `experiments/*` contains pnpm-managed experimental projects.

Workspace dependency spine: `gg-ai` → `gg-agent`; `gg-core` also depends on `gg-ai`; applications consume these shared packages. Provider/model/auth behavior belongs in `gg-ai` or `gg-core`, not app-local copies.

## GG App architecture

GG App starts one shared bundled Node daemon and creates isolated daemon sessions per native window and workspace pane. React calls typed wrappers in `gg-app/src/agent.ts`; those invoke registered Tauri commands in `gg-app/src-tauri/src/lib.rs`; Rust proxies to `packages/ggcoder/src/app-sidecar.ts` and emits pane/window-scoped events.

- Keep provider and agent behavior in the shared package spine; GG App owns desktop UI, native windows, IPC, workspace layout, and PTYs.
- New webview/backend calls require a registered Rust `#[tauri::command]` plus a typed `agent.ts` wrapper. The webview does not fetch the sidecar directly.
- Sidecar-backed calls must pass through the existing readiness gate because the daemon can start or respawn asynchronously.
- Provider errors reach GG App through the sidecar's `broadcastError`/`formatError` path; do not introduce bare provider-message SSE payloads.
- Workspace targets, daemon sessions, and events are pane/window scoped; never route state or output across workspace boundaries.
- Interactive terminals are Rust-owned PTYs in `src-tauri/src/terminal.rs`; they are separate from ggcoder's agent `bash` persistent shell. Restored terminal descriptors stay stopped and require an explicit restart before creating a PTY.
- Packaged terminal-interaction smoke is currently deferred; do not run or extend `smoke-tauri-windows.mjs` until it is explicitly re-enabled.
- CLI logs: `~/.gg/debug.log`. GG App sidecar logs: `~/.gg/gg-app-sidecar.log`. App settings: `~/.gg/gg-app.json`.

## Commands

```bash
pnpm install
pnpm build                  # recursive workspace builds
pnpm check                  # recursive workspace typechecks
pnpm test                   # recursive workspace tests
pnpm lint
pnpm format:check

pnpm --filter @kenkaiiii/ggcoder build
pnpm --filter @kenkaiiii/ggcoder test

pnpm --filter gg-app tauri dev
pnpm --filter gg-app build
pnpm --filter gg-app check
pnpm --filter gg-app test
pnpm --filter gg-app lint
pnpm --filter gg-app format:check
cargo test --manifest-path gg-app/src-tauri/Cargo.toml
cargo fmt --manifest-path gg-app/src-tauri/Cargo.toml -- --check
```

After changing `app-sidecar.ts` for local desktop development, rebuild `@kenkaiiii/ggcoder` and restart Tauri; Vite hot-reloads frontend-only changes. Distribution assembly additionally runs `pnpm --filter gg-app stage:node`, `bundle:sidecar`, then `node gg-app/scripts/smoke-sidecar.mjs`.

`gg-editor` has generated inputs in every main workflow:

```bash
pnpm --filter @kenkaiiii/gg-editor build   # build-skills → tsc → copy-python
pnpm --filter @kenkaiiii/gg-editor check   # build-skills → tsc --noEmit
pnpm --filter @kenkaiiii/gg-editor test    # build-skills → vitest
```

## Release workflows

Framework npm packages use Changesets. `gg-ai`, `gg-agent`, `gg-core`, `ggcoder`, and `gg-boss` are a fixed-version group in `.changeset/config.json`; do not hand-edit their versions. Run `pnpm changeset`, then `pnpm changeset version`; commit the version result before `pnpm changeset publish` so generated npm tags point at the version commit.

GG App is private and released independently from `v*` tags through `.github/workflows/release.yml` for Windows and macOS ARM. Its version must remain synchronized through the helper, not manual edits:

```bash
pnpm --filter gg-app bump <patch|minor|major|x.y.z>
```

The desktop release builds `gg-ai`, `gg-agent`, `gg-core`, and `ggcoder` from the workspace, stages Node, and bundles the sidecar; it does not consume published npm artifacts.
