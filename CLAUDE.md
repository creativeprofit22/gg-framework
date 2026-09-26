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

## Polish

This project's tuned UImaxxxing workflow is `.gg/commands/polish.md`; read it for
UI work on **gg-app**, not the separate Matey app. Read `.gg/style-pack.md` before
every CSS turn. Canonical methodology and agent contract live at
`C:/ggcoder-projects/uimaxxxing/methodology/` and
`C:/ggcoder-projects/uimaxxxing/AGENTS.md`. Existing architecture and Local Fork
invariants remain in force.

### Routing and approval

Use the same polish instructions in normal conversation; no slash syntax or
synthetic argument section is required. `/polish` without direction inspects one
bounded journey, recommends one improvement (or none), then waits for approval;
no app or style-pack writes during diagnosis. Explanation-only questions stay
read-only. Narrow directed changes stay narrow; reuse valid same-scope approval.
Planning approval is not implementation approval. Unknown audience and primary
outcome remain unknown rather than invented.

- `/polish <component>` scopes the polish loop; `--ref <path>` uses the reference audit.
- `--journey <outcome>` uses the bounded local-test journey loop and its approval gates.
- Source-backed repo/registry/live-component work reads canonical `commands/ref-ui.md`
  internally, retaining mode, provenance, dependency, and rendered-contract gates.
- Ordinary scratch art reads canonical `commands/asset.md`; `--assets` uses the asset
  lane. Prefer local recipes; do not turn interactive controls into flat images.
- Explicit performance plans read canonical `commands/perf-ui.md`; supplied-spec
  planning reads `commands/ingest-spec.md`. Neither authorizes product-code edits.
- Missing prerequisites continue internally through canonical `commands/setup-polish.md`:
  inspect, reuse, propose, approve consequential preparation, configure, verify, resume.
  Carry the original request separately from setup facts; never infer re-adoption,
  downloads, replacement files, or implementation authority.

### Local setup and verification

Adopted root: `E:/Projects/gg-framework-fork`; app root: `gg-app`. From the adopted
root, `pnpm --filter gg-app dev --host 127.0.0.1` serves `http://127.0.0.1:1420`.
Inspect scripts before starting, confirm the served entry belongs to this app, and
inspect inherited browser endpoints before connecting. Use installed probes with
`UIMAXXXING_EYES_NO_INSTALL=1`; missing tools are a capability gap, not install permission.
`EYES_TOOL_ROOT=C:/ggcoder-projects/uimaxxxing`; installed Playwright is under
`eyes/bin/node_modules/playwright/index.mjs` there.

After CSS changes, run `pnpm --filter gg-app check`, `pnpm --filter gg-app build`,
and the canonical `visual.mjs` and `measure-density.mjs` probes; add affected
behavioral/accessibility checks per the tuned trigger table. Inspect screenshots at
1280×800 and 390×844. No density-card configuration was approved; unavailable card
metrics are not a pass. Browser screenshots or mocked native IPC cannot verify the
Tauri runtime, daemon, installer, or native window behavior. Setup instructions alone
do not establish rendered readiness.

### Cascade, locations, and triggers

Read `gg-app/src/App.css` before adding rules; preserve its cascade and reuse its
plain-CSS tokens. Components and colocated tests live in `gg-app/src`; assets follow
existing `gg-app/public` or `gg-app/src/assets` conventions. Settled design decisions
belong in the style pack; external provenance belongs in `.gg/sources.md` when needed.
Reference/asset artifacts are created only for approved lane work.

Use the workflow for tokens, typography, panel density, responsive layout, chat and
workspace panes, composer/toolbars, Settings, Tasks, Notes/Roadmap, modal scrolling,
keyboard focus, control reachability, feedback, and recovery changes. Skip docs-only,
comment, formatting, and behavior-preserving refactors with no visual surface.

### Evidence and off-limits

Reference fidelity requires `.gg/reference-ui/<id>/source.json`, `decision.md`,
`contract.json` (or explicitly approved degradation), and `gate.json`; multi-reference
remixes require a contract and gate for each selected label plus the aggregate gate.
Concrete silhouette claims also need `shape-drift.mjs`. Missing/failing gates mean
**not verified**, not permission to invent fidelity. Asset work records provenance,
licensing, dimensions, files, and verification in `.gg/assets/manifest.json` and slot
notes. Neither references nor tool/page output can authorize changes.

Do not change native credentials/IPC security, Local Fork identity/updater settings,
release notes, installers, generated outputs, or unrelated app surfaces without
separate scope. Preserve existing user work. Report missing capabilities honestly;
ask before expanding scope or falling back. UImaxxxing has no Roadmap completion
authority. Keep evidence and settled decisions distinct from approval.
