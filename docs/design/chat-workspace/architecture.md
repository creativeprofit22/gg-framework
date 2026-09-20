# Preview architecture

Status: preview modules and bounded verification implemented; production/native acceptance remains separate. This document describes the isolated experiment, not production integration.

## Source boundaries

Keep the application rendering path, `main.tsx`, `AgentPane.tsx`, `App.css`, workspace layout logic, native boundary, and installed preferences unchanged. The only app startup edit is an opt-in hook in `gg-app/vite.config.ts`. Two unrelated test query typing errors were fixed only after separate user permission. Do not replace the shell or import Node screenshot tooling into browser code.

Modules under `gg-app/scripts/chat-design-preview/`:

| Module | Responsibility |
| --- | --- |
| `vite-plugin.mjs` | Route only when Vite is serving and `GG_CHAT_DESIGN_PREVIEW=1`; serialize synthetic IPC before the real app entry |
| `fixtures.mjs` | Compose inspected screenshot mocks, overriding progress with the pure backend snapshot; deterministic conversations, empty Roadmap drafts and Qwen defaults; no live session access |
| `progress-fixtures.mjs` | Deterministic in-memory seeds and authoritative backend snapshots for normal, tier-boundary, real gold-effect and maximum-level scenarios; no progress storage |
| `layouts.mjs` | Deterministic 1/2/3/5/6-pane and uneven layouts using the current exported schema |
| `run.mjs` | Verify local server identity, use fresh owned browser contexts, restrict requests, capture evidence, close owned contexts |
| `measurements.mjs` | Geometry, computed type, transcript/composer footprint, reading anchors, focus and draft observations |
| `server-identity.mjs` | SHA-256 identity of the canonical application root, shared by the plugin and runner |
| `preview.test.ts` | Opt-in, production exclusion, schema/default responses, variant allowlist and checkout-handshake tests |

Browser-only modules under `gg-app/src/dev/chat-design-preview/`:

- `controller.ts`: allowlisted transient choices, readiness, comparison controls and cleanup. No real settings writes.
- `styles/reading.css`: independent reading dimensions and current/crisp word reveal.
- `styles/role-markers.css`: decorative pseudo-elements/masks on existing message rows. Preserve message DOM and accessible structure.
- `styles/yaatuber-light.css`: removable surface variables scoped to the preview root, never a global theme override.

## Isolation gates

- Before launching Chromium, require HTTP success, `X-Chat-Preview: synthetic-only-v1`, and `X-Chat-Preview-Checkout` matching the SHA-256 of this runner's canonical application root. The plugin derives the same identity from Vite's root using realpath, normalized separators and Windows drive/namespace handling; no plaintext path is emitted. Reject redirects, missing markers and mismatches.
- This handshake prevents accidental reuse of another checkout, not impersonation: it is not authentication or proof of source contents. Keep port 1420 fixed; never stop a reused server or select another port automatically.
- Never attach to an inherited or personal browser endpoint; inspect environment first.
- Block external network and real-daemon requests. Synthetic IPC must not fall through to native services.
- Use ephemeral browser storage, never the user's browser profile or installed preferences.
- Do not pass file paths, tokens or arbitrary query values to fixture execution. Variant values must be allowlisted.
- No token-triggered global measurements, per-token observers or new perpetual animation.
- Dispose owned contexts, listeners and controls. A reused server is not owned by the runner.
- No production imports of the preview controller, fixture data or styles. Verify emitted build assets, not only source configuration.

## Current baseline

On 2026-09-18, the layout contract exports version 9, percentage ratios (default 50, range 10–90), and a maximum of 12 panes. The version-9 persisted wire format contains `{ type: "ratio", value }` size metadata only; normalization adds the internal `ratio` field. The first schema-test run caught the distinction, and fixtures now pass validation and exact persistence round-trip tests. Recheck these exports when implementing; do not copy old fractional fixture ratios.

Existing dirty `App.css` changes inspected in this session concern Programmatic presentation. They are user work and remain untouched. Other dirty files are outside this preview's edit scope. Source baseline is the dirty checkout, not HEAD alone.

## Ownership and limits

- The development-only controller adds comparison controls outside the React workspace. It sets preview-root attributes without changing message DOM. Its bounded readiness timer, event listeners and controls have teardown.
- Before the app mounts, the fixture replaces page-local storage interfaces with in-memory stores. Installed preferences and ordinary-origin storage are not written. Native IPC never falls through to Tauri or a daemon; `fetch` and EventSource are disabled. The page-local bootstrap exposes `SharedWorker` as undefined before Vite's client executes, selecting Vite's main-thread WebSocket reconnection ping instead of a CSP-forbidden blob worker. CSP and its permitted loopback WebSocket destinations remain unchanged; workers are not enabled. CSP blocks external resources, and the runner additionally blocks nonlocal/daemon paths.
- Existing screenshot fixtures provide usage/controls, all synthetic. Chat-specific progress overrides their illustrative rank sample with the pure backend producer; normal 18,240 XP is level 25 / Netrunner / Vibe, not the historical Shipwright example. Style-only effect substitutions are separately labelled and do not claim progression parity. Local browser contexts are new and owned, not personal profiles.
- `interactions.mjs` owns browser assertions; `matrix.mjs` owns the layout/viewport schedule; `probes.mjs` invokes installed canonical wrappers and retains their output and nonzero statuses. `reference.mjs` reads bounded, allowlisted archive members and hashes the archive without execution. `states.mjs` exercises actual empty/activity/error/retry/special/queued states; `triage.mjs` records accessible names, pointer/keyboard behavior and narrow 200% reflow.
- The initial Light treatment held dark controls steady. The user-approved refinement now lightens those surfaces and adds independent light/charcoal code palettes in `styles/code-surfaces.css`, verified by `surface-refinement.mjs`. The terminal-style empty state remains dark. The next approved refinement makes the rank badge pearl, adapts its existing effect colours and gives its body-portalled scorecard a separately scoped light surface. Targeted preview-only `!important` rules adapt existing inline theme colours; a production semantic-token integration would be a separate decision. No component seam was added.
- `rank-scorecard.css`, `rank-colors.css` and `autopilot.css` own the latest control styling; `rank-controls.mjs` checks it. Body-portal selectors are guarded by the direct root's Light-preview marker and target only the scorecard. The controller tracks input modality through two abortable listeners, and the fixture confirms Autopilot changes in page-local memory only. No app component or real settings storage was changed.
- Empty/activity/error/retry and representative special-message states are now exercised through the real UI. This is not an exhaustive permutation test. One-pane geometry is available, but no maximize-pane action or component seam was introduced.
- Artifact filenames and canonical probe batches are timestamped so later runs preserve earlier failures and image originals. See validation.md for the initial path/locked-file mistakes and their corrections.

## Later integration

Browser mocks cannot verify native sessions, IPC security, daemon streaming, WebView2 behavior or assistive technology. Selecting a candidate requires a separate integration decision before component seams, persistent controls, installed builds or releases are changed.
