# Qwen Cloud Token Plan — implementation and verification

Snapshot: 17 September 2026. Scope: the approved Token Plan integration in the current uncommitted working tree, not a release/installer approval. Existing unrelated Programmatic changes were retained. Engineering guidance, not legal advice.

## Implemented controls (code evidence)

- Eleven namespaced Token Plan LLMs; provider-local default, fast and summary models; source-backed conservative limits and real binary/effort/always-on thinking controls. See [capability sources](qwen-cloud-token-plan-capabilities.md).
- Only the fixed HTTPS POST chat-completions destination at `token-plan.ap-southeast-1.maas.aliyuncs.com`. No custom endpoint, PAYG route, legacy-host alias, redirects, automatic provider fallback or automatic inference health checks. Explicit TLS-disable configuration fails closed.
- Separate reasoning/tool round trips and final empty-choice usage chunks; actual token accounting, not invented remaining Credits or dollar estimates.
- A dedicated native OS-vault credential, write-only native IPC, bounded Token Plan key validation, secret-free status/error contracts and generic plaintext-auth write rejection. The daemon clears inherited Qwen credentials before vault injection.
- Serialized native mutation through the existing idle reservation/reload mechanism. Preparation failure reports an unchanged connection; post-mutation reload failure honestly reports that the vault change happened. The two failure states have distinct regression coverage.
- Dedicated runtime credential resolution; no OpenAI/DashScope/plaintext-auth fallback. External tool/MCP/helper children receive filtered environments; trusted interactive agent workers receive the dedicated runtime key intentionally.
- Explicit connection test with a fixed harmless prompt and small output limit. It consumes allowance only when invoked by the user. Saving alone does not claim remote verification.
- Matching native-only forms in both login surfaces, masked input, clearing, no saved-key readback, allowance/transfer notices, and no provider switch on connection. The Qwen modal scrolls within normal and narrow viewports.
- Qwen is excluded from startup fallback, unattended execution, Run All/autopilot and scheduled task execution; explicitly user-initiated interactive agent/tool work remains supported.

## Historical developer-native source prerequisite checkpoint (17 September 2026)

At this initial checkpoint, task `fe35d686` was **VERIFY-BEFORE-SHIP**; the later scoped PASS below supersedes that pending status. The approved dirty tree is preserved; prerequisite task IDs `ea289f3e` and `7c070847` are not treated as completed merely because their source is present.

Source inspection confirms `commands.rs::mutate_and_notify` emits secret-free Qwen auth invalidation only after successful reload. `QwenCloudConnectionForm` subscribes, rejects stale reads, and clears input/refetches metadata after a committed change with reload failure. `LoginScreen` refreshes the global provider hub on auth invalidation; AgentPane uses `useAgentEvents` to refresh models on `models_change`. The shared native reload lifecycle targets recovered windows with `agent-models-changed`.

Existing Rust cases distinguish unchanged preparation failure from committed save/remove with failed reload and check notification ordering. Existing component cases cover separately mounted hub/form refresh, stale reads, preparation failure and successful status refresh after reload failure. Inspection found no component case for a *failed* status refresh following reload failure. The user explicitly approved adding that narrow save/remove regression for both login surfaces; it requires the original committed-change warning, cleared input, disabled unavailable controls and no retry/key readback. That initial checkpoint was source-only; the new regression was subsequently exercised in the focused runs reported below. It does not establish native end-to-end recovery coverage.

## Opt-in two-window developer verification (implemented; scoped native PASS)

The follow-up launcher is `gg-app/scripts/qwen-connection-dev-smoke.mjs`; its scenario and independent checker are in `qwen-connection-smoke-scenario.mjs`. No CI job, dependency, production origin exception, Qwen endpoint override or release-visible credential command is added. Debug startup validates the fixture configuration before native logging/auth discovery/daemon startup. Only the derived service `com.ggcoder.local-fork.qwen-smoke.<32 lowercase hex digits>` and account `qwen-smoke-<same run ID>` may be used for this scenario. Missing/invalid fixture identity fails closed. Normal release compilation excludes this selection and cleanup module entirely.

The launcher provisions two split workspaces, each with a real project/model picker and a live login hub/form. It creates two saved sessions through the actual built `SessionManager` under the disposable profile and selects their paths before baseline observations, so restart checks require recovery of the same durable IDs and paths. Home login activation is scoped to the intended auth pane rather than whichever matching button appears first during startup. Initial layout provisioning may reload each WebView once, before observations begin. Subsequent save/replace/busy/remove assertions prohibit remounting the live forms/hubs. It uses normal Tauri IPC, a real built daemon, and only a synthetic Azure transport for one held/cancelled interactive run. No Qwen inference is requested. Daemon creation identities and exits, both-window notifications/UI refresh, input clearing, unchanged Azure selection, synthetic-key injection booleans, source/output hashes and cleanup are required by the checker.

### Exact execution approval boundary

**Separately approved and executed on 17 September 2026.** From the repository root, with `CARGO_NET_OFFLINE=true`, `COREPACK_ENABLE_NETWORK=0` and `COREPACK_DEFAULT_TO_LATEST=0` set for each process:

```sh
pnpm --filter @kenkaiiii/gg-ai build
pnpm --filter @kenkaiiii/gg-agent build
pnpm --filter @kenkaiiii/gg-core build
pnpm --filter @kenkaiiii/ggcoder build
pnpm --filter gg-app exec vitest run src/QwenCloudConnectionForm.test.tsx src/AgentPane.test.tsx src/LoginScreen.test.tsx scripts/qwen-connection-dev-smoke.test.mjs
cargo test --offline --locked --manifest-path gg-app/src-tauri/Cargo.toml qwen --lib
cargo test --offline --locked --manifest-path gg-app/src-tauri/Cargo.toml azure --lib
pnpm --filter gg-app check
node gg-app/scripts/qwen-connection-dev-smoke.mjs --identity com.ggcoder.local-fork
```

The final command's internal operations are also part of the approval, not hidden behind the launcher:

- `cargo build --offline --locked --manifest-path gg-app/src-tauri/Cargo.toml --bin gg-app` from the repository root. It forces `CARGO_PROFILE_DEV_DEBUG_ASSERTIONS=true` and `RUSTFLAGS=-C debug-assertions=yes`, removes inherited Cargo/Rust overrides, and checks the debug-only isolation markers before launching the binary. `TAURI_CONFIG` is the existing Local Fork JSON override plus `build.devUrl=http://localhost:1420`. Cached Cargo/Rustup/Corepack locations are pinned; no downloads are permitted. This can rebuild cached dependencies and overwrite the development executable, but does not bundle/install anything.
- `<current Node executable> <absolute gg-app/node_modules/vite/bin/vite.js> --host localhost --port 1420 --strictPort`, working directory `gg-app`. Both localhost address families are checked before launch; an occupied port is refused rather than cleared.
- `<absolute gg-app/src-tauri/target/debug/gg-app.exe>` with no arguments, working directory `gg-app`. Environment sets a fresh disposable profile/project/WebView cache, the fixed Local Fork identity, debug fixture CDP port, minimized-window mode and this script as `GG_SIDECAR_PATH`. The exact daemon argv is `<current Node executable> <absolute gg-app/scripts/qwen-connection-dev-smoke.mjs> --gg-app-identity=com.ggcoder.local-fork`; it runs once initially and again after each committed credential mutation. The wrapper imports the actual built `packages/ggcoder/dist/app-sidecar.js`. It never replaces reload handlers or session recovery.
- A second invocation of the **same hash-checked executable**, no arguments, with `GG_QWEN_SMOKE_ACTION=cleanup` and the same validated random run ID. This exits before app startup, deletes only that isolated entry, and verifies absence. Cleanup is armed only after initial isolated absence was observed; a preexisting collision is not deleted.
- Existing owned-process helpers run bounded `powershell.exe -NoProfile -NonInteractive -Command ...` process-table/creation-time queries and exact PID+creation-time termination. No process-name kills or unrelated server termination. The loopback synthetic provider is closed. The disposable profile/evidence directory is retained, not deleted.

The existing helpers' exact PowerShell command templates (the only substituted values are observed positive integer PID/creation-time pairs) are:

```powershell
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object {;   $started = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();   Write-Output ($_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() + '|' + $_.WorkingSetSize.ToString() + '|' + $started.ToString()); }"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $p=Get-Process -Id <owned-pid> -ErrorAction SilentlyContinue; if ($null -ne $p) { try { $handle=$p.Handle; if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -eq <observed-start-ms>) { $p.Kill() } } finally { $p.Dispose() } }"
```

These are argument-array strings passed by Node, not shell-interpolated instructions to paste into another shell. The snapshot includes IDs/timing/memory only, not other processes' command lines or environment.

Artifacts are retained under `%TEMP%/gg-qwen-native-*/audit` (outside the repository). They include hashes, effective nonsecret configuration, stage observations, exact process identities, cleanup and either a result or failure. Native/process output is checked for credential-bearing content; raw subprocess output is not retained, and detected credential-bearing native log bytes are suppressed with a failing verdict. Framework build outputs and ordinary test caches remain in their existing output locations. Missing tools/caches/runtime, unobserved boundaries or cleanup failures retain **VERIFY-BEFORE-SHIP**. Existing historical results below are unchanged.

## Current developer-native result — scoped PASS (17 September 2026)

The requested Windows developer-native lifecycle is verified. [Passing evidence and provenance](../.gg/evidence/qwen-cloud-native-lifecycle-pass-2026-09-17.md) supersede the earlier pending boundary without erasing any failed attempt. After the user requested continuation, default minimized execution `96553385-2861-4f0c-97c3-44f5f29e165a` passed, with evidence at `%TEMP%/gg-qwen-native-4M2zDP/audit`.

- Both distinct native windows remained minimized at `http://localhost:1420`. Both live forms, global hubs and model pickers reflected real window-targeted auth/model events; no remount or injected notification manufactured refresh.
- Real isolated-vault save, replacement, busy save/remove rejection, normal-IPC cancellation and removal passed. Actual daemon identities were `2476 → 3416 → 12400 → 19820`, each with creation-time and exit evidence. Synthetic-key equality was observed after save/replacement, and absence after removal despite the parent's inherited synthetic key.
- Both selected Azure models and both durable session IDs/paths survived restarts. The login stall was resolved by pane-scoped selection; the later recovery assertion required selecting durable fixture sessions rather than initially blank targets. The original identity assertion was retained and a path-preservation assertion added.
- Exactly one held local synthetic Azure request, no Qwen inference or unexpected/external request, no detected secret output. Final isolated-vault absence, owned-process cleanup and provider closure passed with no survivors/errors.
- Final focused suite: **390 passed / 4 files**, including **53 checker tests**, execution `3a358c1f-fac2-4aaa-b8ef-a35662cb1ed7`. Prior applicable checks remain **18 Rust Qwen passes / 1 existing opt-in test ignored**, **19 Azure passes**, desktop typecheck and four ordered framework builds.
- **3,148 named inputs** were unchanged within the native run and still matched after the final test suite; executable SHA-256 remained `cca75a6954b82d3fa34897225e65dc01d6b06989095cabcf89ac8cb2399f9b0e`. All twelve failed native attempt records and the successful thirteenth attempt are retained.

This closes the approved developer-native verification, not overall /ship approval. Standalone-entry and partial-mutation fault cases retain component/native-unit coverage. macOS, packaged/installed behavior, remote entitlement/allowance and paid inference remain outside scope. No installer, downloads, production credentials, commit or publishing.

## Earlier developer-native failure checkpoint — historical (17 September 2026)

At this earlier checkpoint, task `fe35d686` was **not Done**. [Detailed retained evidence](../.gg/evidence/qwen-cloud-native-lifecycle-2026-09-17.md) records all nine attempts, failed checks, exact hashes, two-window/daemon observations and cleanup. The dirty baseline and historical evidence below are preserved.

- Four ordered framework builds passed. Offline Rust checks: **18 Qwen tests passed / 1 opt-in vault test ignored**, **19 Azure tests passed**. Desktop typecheck passed.
- A complete four-file focused run passed **382 tests** before later fixture-only refinements. The final affected launcher/checker subset passed **50 tests**. Earlier failures are retained: an incorrect new source-tripwire expectation and intermittent existing AgentPane source-daemon startup timeouts. The AgentPane test/timeout was not changed, and no all-green repository claim is made.
- Minimized attempts stopped during initial UI provisioning. Two individually approved `--visual` attempts were made: the first failed because the launcher omitted the native-required visible-mode setting; that fixture bug was corrected. The final corrected visible attempt hit the **same Qwen-tile observation timeout**, so visibility alone is not the established cause. Default remains minimized; `--visual` explicitly sets `GG_APP_DEV_SMOKE_WINDOW=visible`. No further visible retries were performed or authorized by the final approval.
- Final attempt `%TEMP%/gg-qwen-native-3YX9y7/audit` observed distinct `main`/`project-1` WebViews at `http://localhost:1420`, isolated initial vault absence, a real daemon and absence of the parent's inherited synthetic Qwen key in that daemon. The native catalog included Qwen in both windows; the first Qwen tile appeared in **post-timeout diagnostics**, not as a completed scenario assertion. Neither save nor any subsequent credential mutation was reached.
- Final isolated-vault absence, owned-process cleanup and local-provider closure all passed, with no survivors or cleanup errors. Earlier failed cleanup verdicts remain in their original attempt records. **3,148 named inputs** were unchanged across the final attempt and matched the tree at reconciliation; executable SHA-256 was `cca75a6954b82d3fa34897225e65dc01d6b06989095cabcf89ac8cb2399f9b0e` before and after.

**Boundary outstanding at that historical checkpoint:** the two-live-form save/replace/busy/remove lifecycle, mutation-driven actual daemon restarts/recovery and replacement/removal injection observations have not been verified. The failure is a fixture/verification boundary with unresolved cause, not a confirmed Qwen runtime defect. Error-state regressions remain component/native-unit coverage. No production credentials, Qwen inference, installer, downloads or publishing were used.

## Historical runtime evidence (before the developer-native follow-up)

No real Qwen credential or inference request was used.

| Check | Result and boundary |
| --- | --- |
| Dependency-ordered builds | gg-ai → gg-agent → gg-core → ggcoder passed; affected outputs rebuilt after later changes. No installer built. |
| Type checks | gg-ai, gg-agent, gg-core, ggcoder and gg-app passed. Final affected core/CLI/app checks passed after the error-state correction. |
| Full gg-ai suite | 437 passed. Controlled-fetch adapter tests exercise actual SDK streaming, tools, reasoning, usage, safe failures, routing and redirect rejection. |
| Full gg-core suite | 620 passed; final Qwen contract suite separately rerun: 9 passed. |
| ggcoder parallel suite | After fixing Qwen-related test fixtures: 5,742 passed, 16 skipped, 1 failed. Remaining failure is the untouched pre-existing Programmatic adapter size assertion: 15,296 bytes versus a strict <15,000 limit. This is not an all-green repository result. |
| ggcoder Windows serial suite | 122 passed, 2 skipped. |
| Final image/GitHub/environment regression subset | 30 passed after closing inherited-key paths in all three promisified media subprocesses. |
| Frontend affected suite | 347 passed; after the final preparation-error correction, the Qwen form subset separately passed 13 tests. |
| Final Rust Qwen filter | 12 passed; isolated OS-vault smoke is ignored by default. Includes native auth-discovery and generic persistence guards. |
| Final Rust Azure filter | 19 passed, including shared mutation-lock coverage. |
| Windows OS-vault smoke | Explicit opt-in test passed once. Real Windows Credential Manager operations used a unique test-only service/account and fake keys. Initial absence, save, sanitized status, replacement, removal and final absence were checked. Reload orchestration was fake, not a real daemon restart. |
| Browser UI | Real components/CSS rendered with mocked Tauri at 600×640 and 360×640 through both login entry points. Keyboard opening/actions/dismissal, masked input, clearing, wrapping and scrolling checked. No horizontal overflow. |
| Scoped lint / formatting | ESLint: zero errors, six existing AgentPane hook warnings. New Qwen Rust modules pass rustfmt. Existing-file Prettier diagnostics were not eliminated by unrelated whole-file formatting. Two Qwen-introduced callback formatting problems were subsequently fixed and checked. `git diff --check` passed. |

Full-suite counts above describe the recorded broad runs. Later narrow fixes were checked with their affected tests/type checks; the entire repository was not repeatedly rerun after every formatting or test-only change.

Local browser evidence is under ignored `.gg/screenshots/qwen-*`; reproducible mocked-browser fixture: `.gg/qwen-ui.mjs`, results `.gg/qwen-ui-results.json`. The vault test is `qwen_windows_vault_smoke` and must be explicitly selected with `--ignored`; its namespace is isolated from production credentials.

## Scoped defensive review

A read-only source-to-sink review covered credential selection/storage, request routing, redirects/TLS settings, native command trust, mutation/reload status, subprocess inheritance, and unattended/fallback policy. One candidate was independently confirmed as a low-severity correctness defect: failed preparation was mislabeled as a completed connection change. It was fixed with separate native/shared/UI error codes and regression tests. No candidate was dropped as a false positive. This is not a claim of absence of vulnerabilities.

No Gitleaks, TruffleHog or Semgrep executable was available on PATH, and no matching scanner capability was found in the tool catalog. No scanner was installed and no code was uploaded. A narrow local literal check over 113 changed/new source/document files found five long Token Plan-shaped literals, all in deliberately synthetic test fixtures. This is not equivalent to a dedicated secret scan, dependency audit or full-history scan.

## Remaining verification gaps and exposure

- **Not exercised:** actual native WebView → save/remove → daemon restart → every window's auth/model refresh as one end-to-end flow. Browser IPC was mocked; the Windows vault test used fake reload plumbing. Native preflight tests use an injected sender, not a real TLS redirect server.
- **Not exercised:** macOS keyring/native UI, packaged/installed builds, real Qwen connection testing, subscription entitlement, paid inference or real quota exhaustion. These must not be inferred from passing unit tests.
- The user-operated Test connection action remains the only live connection check. No inference-key-only weekly allowance API was verified; the UI deliberately links to the console rather than estimating remaining Credits.
- Unavailable-IPC notice screenshots include programmatic scrolling; keyboard-only scrolling to that disabled-controls area was not established.
- The key exists transiently in the entry field, native IPC, process memory/environment and authorized TLS requests. JavaScript clearing is not guaranteed zeroization. Malware/admin access, memory inspection, compromised dependencies/provider, and compromised OS trust roots/network configuration remain outside these protections.
- Selected prompts, code/context and tool results intentionally leave the machine for Qwen Cloud. The displayed Singapore/Global cross-border-processing notice is not a vendor privacy guarantee. Source secrets deliberately included in context are not prevented by API-key storage controls.

No packages installed, real credentials requested, commits/pushes, publishing, installer rebuild/install, release-note updates or Roadmap changes were performed for this integration.
