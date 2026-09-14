<!-- gg:init:start -->
# gg-framework

Provider-flexible AI-agent monorepo whose primary product is the `ggcoder` coding agent, with terminal and Tauri desktop surfaces.

## Ownership

- `packages/gg-ai` owns provider transports, unified streaming, message transforms, and raw provider errors.
- `packages/gg-agent` owns the provider-independent turn loop, tool execution, and agent events.
- `packages/gg-core` owns UI-free shared models, auth/OAuth, paths, usage, logging, transcription, Project Notes, and roadmap protocols.
- `packages/ggcoder` owns coding sessions, built-in/MCP/LSP tools, persistence, Ink UI, CLI modes, and the desktop app sidecar.
- `gg-app` is the production React/Tauri desktop workspace; `Matey` is a separate Electron UI prototype with renderer-local chat state.

Package layering is `gg-ai → gg-agent`/`gg-core → ggcoder`. Keep transports/raw provider failures in `gg-ai`, reusable UI-free state in `gg-core`, and native window/IPC behavior in `gg-app`.

## Desktop architecture

- Agent traffic flows `React → typed Tauri invoke (gg-app/src/agent.ts) → Rust localhost proxy → one shared Node daemon (packages/ggcoder/src/app-sidecar.ts) → pane-scoped logical session`; native settings, permissions, updater, file, and window operations terminate in Rust.
- Session UUIDs are capabilities minted with a bootstrap secret that never enters the webview. Rust adds session identity to proxied requests and forwards sidecar SSE as window-scoped Tauri events; do not make the `tauri://` webview call localhost directly.
- The desktop bundle is built from `packages/ggcoder/dist/app-sidecar.js`; `gg-app/scripts/bundle-sidecar.mjs` emits `src-tauri/sidecar/app-sidecar.mjs` and copies native/optional runtime dependencies that esbuild cannot inline.

## Gotchas / invariants

- This checkout is the isolated Local Fork on `custom/local-customizations`. Synchronize upstream only through `gg-app/scripts/update-with-local-fixes.mjs`: it creates recovery state, preserves dirty files byte-for-byte, performs a merge (not rebase), verifies identity/artifact freshness, and permits a non-force push only from the canonical branch. Manual pull/rebase/build/push bypasses those safeguards.
- Production (`com.ggcoder.app`) and Local Fork (`com.ggcoder.local-fork`) identities, binaries, data roots, sessions, auth, workspaces, and logs must remain isolated. Build unsigned Local Fork installers only through `gg-app/scripts/build-local-hotfix.mjs`; it enforces current-user installation, the local identity, disabled updater artifacts/endpoints, bundle validation, and fresh installer/payload checks. Startup migration must finish before the local daemon/windows start.
- Root `pnpm install` runs the `prepare` script and therefore recursively builds the workspace. Transactional/update flows use frozen install with `--ignore-scripts` before their explicit checks/build so generated output cannot mutate the protected worktree early.
- Auth storage is shared across windows/processes. Provider mutations and token refreshes must lock, re-read the complete latest `auth.json`, and modify only one provider; `resolveCredentials` intentionally does not call `ensureFresh`, because doing so loses evidence of a concurrent re-login and can overwrite new credentials.
- Keep repository text LF on every OS because seeded agent fixtures are content-hashed. Only `.bat`, `.cmd`, and `.ps1` use CRLF, as enforced by `.gitattributes`.
- Generated-output audits report presence/tracked/ignored state; they do not check freshness or clean artifacts. `gg-app/src-tauri/{binaries,sidecar,target,gen/schemas}` are generated.
- Changesets fixes `gg-ai`, `gg-agent`, `gg-core`, and `ggcoder` to one version. Desktop versioning is separate; its bump script must keep `package.json`, `tauri.conf.json`, `Cargo.toml`, and `Cargo.lock` aligned.

## Project-specific workflows

- Desktop development requires framework/sidecar dependencies built before starting Tauri: first build the `@kenkaiiii/ggcoder...` dependency closure, then run the `gg-app` Tauri dev command.
- Distribution order is load-bearing: build `gg-ai → gg-agent → gg-core → ggcoder`, stage the target-platform Node runtime, bundle and smoke that exact sidecar, then package. On macOS, sign the staged Node binary and native addons before Tauri assembles/notarizes the app.
- Multi-line CI/release steps must explicitly use Bash on Windows. PowerShell reports only the final command's status there, which previously hid intermediate package failures and allowed stale artifacts to ship.
- A pushed desktop `vX.Y.Z` tag must point to an `origin/main` ancestor. The protected `desktop-production` preflight requires updater-signing and all macOS signing/notarization secrets before either Windows or Apple-silicon macOS builds; Linux and Intel macOS are intentionally not released.
<!-- gg:init:end -->