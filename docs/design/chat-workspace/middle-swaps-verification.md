# Middle swaps: verification handoff

Recorded 2026-09-20. **Current reading-anchor correction passes its focused tests, app typecheck and Windows developer-app reflow checks.** The passing full root test command and workspace typechecks below are earlier snapshots, not exact-source verification of this follow-up. This is not release or universal platform/accessibility certification. No installation, release, commit, push, dependency addition, or Light/message-alignment integration was performed.

## Center-control native CI gate (2026-09-21 UTC)

Task `07b8806e`: the existing pane-swap developer runner now activates center-left and center-right in **both rows**, at **1280×800 and 390×844**. All eight cases exercise trusted CDP pointer down/up, target geometry before/after focus, same-position pointer reversal, trusted Tab entry, Enter and Space immediate reversal without a refocus/animation wait, same-center-direction handoff, and a computed visible outline after animation completion. Existing side/shortcut, project/session identity and held-work checks remain. Six-pane checks also retain keyed hosts, drafts and selections and reject swap-time session creation/disposal.

The Windows app job now invokes the runner serially after cross-pane isolation and before programmatic execution, with `shell: bash`, a 15-minute step limit, offline Cargo/Corepack settings, fixed-port ownership and the existing developer target/cache. It remains blocking. A small optional shared-fixture cleanup callback reports observed process count and survivors; original termination and failure propagation remain. Failure uploads allow only the sanitized result and named credential-free fixture screenshots, never temporary profiles, auth files or raw developer logs. `verify-release-ci.test.mjs` requires these contracts without relaxing existing assertions.

Verification on the restored dirty-tree source:

- Release-CI assertions: **18 passed, zero skipped**; both runner syntax checks passed. Execution `faa49bac-ef1d-43e5-b4e5-e565e404a277`.
- First isolated native run: **passed**, execution `e228bb34-dfe1-46eb-ab6a-042297acaa7c`; evidence `.gg/eyes/out/pane-swaps-native/1789958962571/`.
- Deliberate negative control: temporarily removed the first center-left DOM action immediately before its pointer check. Native run **failed with exit 1** at `1280-row-0-left-pointer`, while all existing side checks had passed. Cleanup reported **20 observed processes, no survivors**. Execution `0822d990-3972-4658-8502-cc3071af84c7`; original failure verdict and screenshot remain at `.gg/eyes/out/pane-swaps-native/1789959285214/`. The temporary mutation was then removed; no production UI source was changed.
- Final isolated native run after restoration: **passed**, execution `86df0030-e6ab-47ae-b0fb-7c44fbe094b4`, using `CARGO_NET_OFFLINE=true COREPACK_ENABLE_NETWORK=0`. The CI evidence-directory override was exercised. Final evidence: `.gg/eyes/out/pane-swaps-native/ci-gate-final-20260921/`, including `result.json`, `native-workspace.png`, `native-center-1280.png`, and `native-center-390.png`. **8/8 cases, 192 trusted input events, 20 observed fixture processes, no cleanup survivors**; port 1420 was independently confirmed released.
- Source hashes for the workflow, CI test, both runners and relevant production control/CSS files are retained in execution `ebb6b1f0-1aae-4b51-b854-b930c280e48f`, manifest SHA-256 `3f0be4f8961b4fcb8b266d81f1461d7338bdca8f3e1ef5f0e4851ad4a80dc630`. This identifies the scoped dirty-tree source rather than claiming HEAD alone is sufficient.

Both final viewport screenshots were inspected: all four center actions are visible, with the final lower-right action retaining its outline. The narrow six-pane workspace remains cramped/scrollable; existing incomplete-fixture usage metadata is visible at desktop size. This is **real developer WebView2 input and Rust IPC with a controlled, credential-free daemon**, not a synthetic React pane mock. Viewport emulation is not native window resizing, physical touch, OS-level keyboard injection, real-provider streaming, spoken-screen-reader, or installed-distributable evidence. **Hosted CI has not run for these changes.** No dependencies were installed and no distributable was rebuilt/installed, committed, pushed or released. Existing user changes were preserved with explicit approval; the pre-existing Vite listener was stopped with explicit approval so each smoke could own port 1420.

## Transcript reading-anchor correction (latest)

The confirmed gap is fixed: Ken/Autopilot and the other rendered transcript branches now mark existing content hosts, including command, tool-failure, execution-evidence, subagent-group, error, plan, question, image and compaction content. No layout wrappers or streaming scans were introduced. Capture ignores hidden/offscreen rows and text, and keeps a visible character Range. Missing, detached, collapsed or no-longer-visible anchors recover to the clamped saved offset. Image-only fallback uses the same element box at capture and restore. Keyed hosts, swap coordination, geometry, focus/selection, bottom-pin intent and cancellation behavior remain intact.

**Regression evidence:** the new Ken/Autopilot tests failed before the fix with unchanged numeric scroll offsets; hidden/offscreen-row tests also reproduced inappropriate anchoring. Both mentor variants now exercise narrow→wide and wide→narrow geometry among tool/message rows, followed by removed-anchor recovery. These tests use mocked rectangles and do **not** prove real reflow.

- Requested command `pnpm --filter gg-app exec vitest run src/usePaneSwapViewState.test.tsx src/WorkspaceShell.test.tsx src/AgentPane.test.tsx`: **379 passed**, execution `8c605606-8ba9-40a4-a2b8-fffc121ca4fb`.
- `pnpm --filter gg-app check`: **passed**, execution `83dc18d4-4c57-448c-a8d3-3c40ca4dffdd`.
- Affected AskBand/SubAgentFeed suites: **44 passed**, execution `2abe2157-fe90-4aec-bc38-cdd88384ff80`. That log also records the post-verification SHA-256 manifest of the relevant source/tests/fixture files: `6be72cb3975119f06c06aa93be74f5b2a5591c877d4131be4b799b9ae11a8da4`. No production edits intervened between those checks and the manifest capture.

**Native reflow:** `UIMAXXXING_EYES_NO_INSTALL=1 node gg-app/scripts/pane-reading-anchor-dev-smoke.mjs` passed, execution `46b88549-9cb0-4e36-8da0-5e007ab4c641`. It uses an isolated developer Tauri WebView2 with real React Markdown, Range geometry and Rust session IPC, and controlled daemon history. It verified the existing Vite source against this checkout before reuse. All **24 exchanges** passed: long Ken, Autopilot and error paragraphs; center-left/center-right actions and side reversals; unequal widths at 1280×800 and 390×844. Both exchanged panes stayed unpinned, with maximum saved-character vertical drift **0.5 CSS px**. DOM hosts, native session IDs and project roots remained unchanged; no swap-time session creation/disposal occurred. Fixture-owned processes were cleaned up; the pre-existing Vite server was not stopped.

Raw first-visible character indices/excerpts before and after every exchange are retained in `.gg/eyes/out/pane-reading-native/1789943453117/result.json`. Example, Ken center-left at 1280: primary width **318.25→568.640625**, first character **1126 `w`→1126 `w`**, saved character top **−1.1875→−0.9375**; center width **568.640625→318.25**, first character **2250 `a`→2244 `w`**, saved character top **−1.1875→−1.6875**. Rewrapping can move the start of the first visible line backward; the original reading character remains on that visible line at the preserved vertical position. This is not a claim that line-start indices are invariant at different widths.

Both native screenshots (`native-1280.png`, `native-390.png` in that evidence directory) were inspected. The narrow three-column fixture remains cramped and scrollable; existing incomplete-fixture metadata/roadmap diagnostics are visible. This is scoped reading-position evidence, not a visual redesign or clean-app verdict. The initial native attempt failed on Windows shell quoting before app launch (`d96cd593-b2d2-4e40-93c9-b363550f89d9`, evidence `1789943120130`); the reuse path now launches the installed Tauri CLI with argument arrays. Original failed evidence remains retained.

No distributable rebuild, installation or full-suite rerun was performed. Native swaps in this new fixture are DOM-button activations, not fresh trusted-keyboard/OS-input checks. Real-provider streaming, installed builds, spoken screen readers, physical touch and density-card metrics are not newly verified. Earlier keyboard/focus evidence below retains its own dated scope.

## Center-pane ergonomics correction (latest)

The user clarified that reaching to side panes is not sufficient: both center panes need their own left/right controls. The implementation now includes **always-visible center arrows**, retains the side actions, and hands focus to the same direction on the incoming center conversation. Repeated activation exchanges the pair back. Shortcuts invoked while a center button is focused also preserve the center action. Current geometry is revalidated at execution; absent neighbours do not expose an action.

Verification on this correction: **80 focused tests passed** including new left/right center reversal, mount/session preservation and center-button shortcut tests; app typecheck passed (`6c64767b-a0ac-4920-b67d-c16cf7ae8d61`). Frontend build passed (`47ec5480-9777-4e3e-a067-d25b11c0075e`). The previously passing full root suite below predates this follow-up and was not rerun as part of this small UI change.

Per the user's direction, rendered verification used the **developer app with the real local daemon**, not the synthetic browser preview. Native WebView trusted Enter checks passed for both directions in both rows, including reversal and center focus continuity. All four center controls were checked visible and unclipped at 1280×800 and 390×844; screenshots were inspected. Evidence: background execution `b84d2b97-8e11-467a-8b68-5b5f578ab575`, retained profile `C:/Users/SPARTA~1/AppData/Local/Temp/gg-manual-six-rg3lK6`, captures `center-1280x800.png` and `center-390x844.png`. Viewport sizing was emulated inside the native developer WebView; no provider prompts were sent. The six-pane developer window was left running for manual use. Existing chats/profile were not edited. The controlled fixture and browser helper selectors were updated for the new center actions, but those separate runners were not rerun; no synthetic-browser or density-card pass is claimed for this follow-up.

This supersedes earlier statements that the center has no controls or that only two named swap actions exist in a three-pane row. The current six-pane workspace has eight actions: four side buttons and four center arrows. Density-card metrics remain unavailable under the adopted setup; physical touch and spoken-screen-reader checks remain unverified.

## Broader test gate resolved (latest)

The user's subsequent **“go all”** authorized fixing the outstanding broader failures. **`pnpm test` completed with exit code 0**, execution `718abee5-21e6-4154-9b24-0f0bb973f0f0`, 2026-09-20 18:28:29 UTC, elapsed 1,172.502 seconds. **`pnpm check` passed across the workspace**, execution `057a75ae-7272-4a51-b847-08b01b3bea74`. Both used this checkout's current dirty source; HEAD alone is not the tested source identity. Complete sanitized command logs are retained under the local GG foreground-log directory by these execution IDs.

Resolved causes and changes:

- **Reminder timezone:** setting `process.env.TZ` inside a Windows worker thread did not change `Date`'s timezone. The test configuration now sets New York in the parent before workers start. The test asserts actual winter/summer offsets as well as its original DST-gap rejection. Windows frontend runs use one thread worker rather than the observed failing fork fan-out. This is a test-only execution choice, not an application timezone change or proof of a universal fork defect.
- **Bundle fixture:** bounded batches of 16 asynchronous writes preserve the full installed-package layout, retained bytes and all pruning assertions. Every batch settles before errors propagate, preventing cleanup races. Isolated test time moved from 2,747 ms to 1,789 ms in the measured runs; the original five-second test limit remains unchanged.
- **Release contract:** the test now verifies explicit assessment-message accounting and both final transcript checks, instead of an obsolete zero-growth assertion. Parent provider/model/session identity and before/after evidence assertions remain exact.
- **Further assessment failures:** after the root run passed its earlier blocker, it exposed stale expectations that user-facing summaries were JSON or recited raw receipt IDs. Tests now observe the real renderer and retain exact accepted structured-data, workflow, evidence, permission and provenance assertions alongside the current display text. No production presentation was reverted to satisfy stale tests.
- **Size guards:** extracted the pure setup display projection from the transport adapter and deduplicated next-step records. Original size ceilings remain unchanged; the extracted module has an additional bounded, no-I/O guard. Behavioral suites passed before and after extraction.

The final root run passed release/script checks, AI **554**, agent **161**, core **620**, CLI parallel **5,898** and Windows-serial **122**, frontend normal-profile **2,481**, and its separate serialized suites (**25**, **62**, **31**, **8**). Existing CLI skips remain visible (**16** parallel and **2** Windows-serial); no skips were added. The root command also passed its narrow-workspace and What's New loading checks. These counts describe each reported suite, not a fabricated single aggregate or external CI result.

Earlier failures below remain historical evidence, **not current failing test gates**. This does not convert mocked/native fixture boundaries into real-provider, OS-input, accessibility or release approval. Mac testing is explicitly out of the user's current scope.

## Windows developer-app verification

Per the user's instruction, subsequent application testing used an isolated **developer Tauri app**, not the browser preview or an installed distributable. `gg-app/scripts/pane-swaps-dev-smoke.mjs` reuses the existing isolated cross-pane launcher and cleanup lifecycle through an optional verification callback. It uses a controlled credential-free daemon fixture and real Rust IPC; no provider request, normal profile mutation, distribution build or installation is involved.

**Passed:** trusted WebView Enter and the exact Windows shortcut; forward/reverse focus handoff and keyboard feedback; all three native session IDs and project roots unchanged; held primary activity still running after swaps; all drafts and textarea selection preserved; stable DOM hosts; no session creation/disposal during exchanges; exactly two named side swap actions in the native accessibility tree. Owned processes were cleaned up successfully. The captured native screenshot was inspected. These results do not certify spoken screen-reader output, OS-level drag/drop or real-provider streaming.

Evidence: `.gg/eyes/out/pane-swaps-native/1789926003880/result.json` and `native-workspace.png`; execution `d83697fe-6586-4fe2-86d8-cf835d27ffa6`. The first attempt (`38ca3824-f363-41de-bf04-83b0cb886cb4`) failed because the new test sent Enter as `rawKeyDown` without its character event. The test now uses the existing native-input runner's `keyDown`/text convention; production code was not changed for that test-driver issue. The first failed evidence remains at `E:/Projects/.gg/eyes/out/pane-swaps-native/1789925683766`; subsequent output is correctly contained under this checkout.

Reproduce without fetching dependencies:

```bash
CARGO_NET_OFFLINE=true COREPACK_ENABLE_NETWORK=0 node gg-app/scripts/pane-swaps-dev-smoke.mjs
```

**Historical broader failures (resolved by the root run above):**

- `pnpm test` stopped in `scripts/verify-release-ci.test.mjs:214`, a source-contract assertion about final parent state in the programmatic-execution fixture. Package suites later in that root chain did not execute. Execution `a3d52556-8307-4fef-bfc7-fc5381b3fa8d`.
- The complete frontend run (`pnpm --filter gg-app exec vitest run --pool=threads --maxWorkers=1`) completed: **150 files / 2,605 tests passed; two files / two tests failed**. Failures: installed-layout copy/prune fixture timed out at its unchanged five-second limit; the Roadmap reminder DST-gap assertion returned a UTC value instead of null under this thread-worker run. Execution `9264deff-021b-484c-83f8-a8504d6a0770`. These are not pane-swap assertions. No skips, weakened assertions, or global timeout changes were introduced.

**Still unavailable/unverified:** macOS hardware/OS shortcut conflicts, physical touch, spoken screen readers, OS file/folder dragging, actual provider streaming through native swaps, installed-build behavior, and overall accessibility/release approval. The controlled developer fixture also emits known incomplete-fixture metadata/roadmap-response diagnostics; this is scoped pane identity/input evidence, not a clean-app or whole-daemon verdict.

## Previous continuation verification

The real Chromium mouse-drag reproduction now **passes**, including `dragstart → pointercancel → drop` and the expected pane relocation. The source pane's supposedly inert drop zones had `pointer-events: auto`: inserting them over the source handle aborted native drag initiation. Setting only those inert zones to `pointer-events: none` fixed the reproduction. An injected-style differential experiment passed first (`8037d9b6-21ab-485d-853f-42fde86e8f61`), followed by the normal source runner (`e86ad084-136c-4a9a-afe4-ac34746a8c91`). Native Tauri remains a separate, unverified boundary. The bounded runner remains as a guard against future stalls.

Additional completed work:

- Component checks now cover missing destination buttons/hosts, workspace/region fallback, independently acquired focus, modal supersession, shortcuts whose originating button disappears, resize, window hiding and unmount cleanup.
- Browser checks now include held Space (one activation on keyup), both directional shortcuts, pointer activation and forced-colors focus feedback. Chromium dropped `:focus-visible` during the disappearing-button handoff; the coordinator now preserves a keyboard-only focus marker and clears it on independent focus or pointer input. Pointer clicks do not retain the marker.
- Real pointer activation exposed another defect: revealing the focused toolbar moved the swap button between pointer-down and pointer-up. Its position is now reserved independently of the other controls. The DOM action order follows its visual order, and narrow headers retain space for the wrapped controls.
- The expanded nine-suite run passed **455 tests**, including AgentPane's previously timed-out real-sidecar test, with `--pool=threads --maxWorkers=1` (`f602ea0b-814d-4b70-a034-97b141cf2a7d`). This was before the final keyboard-ring and pointer-position adjustments. After those adjustments, all **138 tests across the eight workspace/swap suites passed** (`5e0acb60-bfe6-46b7-887a-7269702a1e05`). No project pool setting, assertion, or timeout was weakened; the command-line worker choice avoids the observed fork startup issue.
- Final expanded browser checks passed at 1280×800 (activity fixture) and 390×844 (completed fixture), with no page errors (`fd738e5b-8b17-4c82-88cb-039afd731b26`). Captures: `original-light-activity-six-1280x800-1789924194200.*` and `original-light-completed-six-390x844-1789924201410.*` under the existing preview evidence directory.
- Final typecheck passed (`66776633-81f0-4f54-8dd7-20983f6a52c9`) and final frontend build passed (`8323ebfd-e818-4ef8-8146-e12ad54639f2`). The real browser drag reproduction passed again on the final source (`c478cd2d-1ea9-4943-af32-001f501e1012`); script syntax and diff whitespace checks also passed.
- Canonical visual probes reran at both sizes (`15d5c080-de68-408b-abbb-dd82dfdfb996`); final default and forced-colors interactive screenshots were inspected. Density remains unavailable because the adopted setup has no density-card configuration (`8630b191-72a3-4080-874e-eee521a14dae`). Earlier failed runs below are retained as history, not current pane-drag or affected-test blockers.

## What changed

- Shared renderer geometry now supplies row membership and middle targeting. Rows require matching vertical bounds and contiguous horizontal positions, with a one-CSS-pixel tolerance. Nearest physical centre wins; ties select the left pane. Fewer than three aligned panes and ambiguous rows have no swap.
- One validated transaction exchanges two leaf identities. Registry objects, ratios, primary identity and unrelated branches survive. Existing flat keyed hosts remain mounted.
- Side panes have a labelled swap button independently of Rearrange mode. Ctrl+Alt+Shift+Left/Right targets the immediate neighbour of the middle in the focused row; macOS uses Cmd+Option+Shift. Farther panes use their buttons.
- Button activation hands focus to the displaced conversation's side action before paint. Composer/content focus remains with conversation identity. Existing composer autofocus no longer takes focus from a swap button before activation. Distinct presses work during movement; held key repeats are ignored.
- Only the two existing hosts translate for 160 ms. Reduced motion snaps; resize, other geometry changes, preference changes and hidden windows cancel stale effects. Animation completion never focuses or commits.
- Pane-local capture preserves draft selection, first-visible text-character anchors through unequal-width reflow, and bottom-pin intent. Missing anchors use a clamped offset. Restoration never moves focus.
- Narrow action rows reserve header space rather than covering transcript content. Six columns/rows of existing chat UI remain highly constrained at a 390px viewport; this was not a responsive workspace redesign.

## Initial implementation checks (historical; see continuation above)

| Check | Result and boundary |
| --- | --- |
| Pre-edit workspace baseline | 99 tests passed. This predates implementation. |
| Final focused suites | **131 passed across eight files**, including geometry, swaps, WorkspaceShell, PaneDropOverlay, native-button event guards, view state, and coordinator. Command: `pnpm --filter gg-app exec vitest run --maxWorkers=2 src/WorkspaceShell.test.tsx src/PaneDropOverlay.test.tsx src/workspace-layout.test.ts src/workspace-geometry.test.ts src/workspace-swaps.test.ts src/PaneSwapButton.test.tsx src/usePaneSwapViewState.test.tsx src/useWorkspacePaneSwaps.test.tsx`. Execution `e439a9d5-3887-412a-b1e4-b2ea2368498e`. |
| Typecheck | `pnpm --filter gg-app check` passed; execution `df7cd640-5bd2-4cd8-b170-c0cdfb50cb96`. |
| Frontend verification build | `pnpm --filter gg-app build` passed; execution `0094a460-9b86-4bdc-b3bd-1a0b0d848c20`. Existing config-loader, ineffective dynamic import and large-chunk warnings remain. This was not a distributable build. |
| Real-component synthetic browser | Desktop 1280×800 and narrow 390×844 passed: native Enter/Space, held Enter, rapid distinct activation, Tab/Shift+Tab, two-row targeting, both drafts and selection, stable DOM hosts, reduced-motion snap. Desktop also checks first-visible text-character anchors in both conversations through unequal-width reflow. Completed and activity fixtures exercised; no page errors. Final execution `8539f2f2-f8f5-46d5-a3d1-73b5dad44eb2`. |
| General rearrangement regression | Real WorkspaceShell test failed on `dragstart → pointercancel` before the fix and passes after removing only its HTML pane-drag pointercancel listener. Escape, dragend, blur, outside drop, valid edge drop and separate divider resize behavior remain covered. |
| Canonical visual probes | 1280×800 and 390×844 captures succeeded. Interactive before/midpoint/after captures also retained. Midpoints are explicitly paused at 80 ms for inspection, not timing measurements. |
| Canonical density | **Unavailable**, exit 2: the project's deliberately absent density-card configuration. No invented card metrics. |
| Canonical accessibility | **Not a clean pass**, exit 1: six unlabelled existing `button.btn` candidates and 35 contrast candidates in surrounding UI (including decorative separators and gradient-text false-positive candidates). No positive tabindex or out-of-DOM-order tab sequence reported. This is not WCAG/ADA certification. |

## Browser-drag hang: initial investigation (resolved by continuation above)

The real-component HTML drag runner blocked in Playwright 1.63's `mouse.move()` during drag initiation. Debug API output reached that move; the page still answered evaluation requests. It emitted `dragstart → dragend`, kept the source DOM node connected, and never supplied the browser interception event Playwright was waiting for. Isolating the application drag handler made the protocol move return, but did not verify an application drop.

This is **not proof that pointercancel caused the browser stall**. The component pointercancel regression and browser initiation failure are separate evidence. Removing the incorrect pointercancel listener fixes the component sequence, but the browser's real drag path still has not passed. At this point in the investigation the exact cause of its early drag termination was unresolved. The subsequent inert-overlay fix above resolved this browser failure without a broad drag rewrite.

The runner now bounds initiation at 10 seconds, saves event/source diagnostics, and imposes a 25-second verification deadline that closes its owned browser context. This releases an outstanding protocol wait rather than merely racing a rejected promise. Earlier interrupted runs are retained as unknown; later bounded failures are retained as failures, not passes.

Reproduce with the inspected preview server running:

```bash
UIMAXXXING_EYES_NO_INSTALL=1 node gg-app/scripts/chat-design-preview/pane-swaps.mjs drag
UIMAXXXING_EYES_NO_INSTALL=1 node gg-app/scripts/chat-design-preview/pane-swaps.mjs swaps 1280 800 activity
UIMAXXXING_EYES_NO_INSTALL=1 node gg-app/scripts/chat-design-preview/pane-swaps.mjs swaps 390 844
```

The runner retains the existing checkout-identity and loopback route checks. It never installs a browser or package.

## Retained failures and remaining verification

- The unrestricted `pnpm --filter gg-app test` run did **not** pass: worker-start timeouts and four timeouts in sidecar/roadmap-related suites. Execution `074e82f4-564f-443f-b4af-7d80f753ebd2`.
- A two-worker affected-suite run, including AgentPane, passed **448 tests** and failed one real-sidecar multi-image-history test with `Source sidecar startup timed out`. Execution `81a06da4-54ac-4891-bff8-4c6991a430cd`. No assertion, timeout or test was weakened. The final focused pass is narrower and does not supersede those failures.
- A browser run initially found composer autofocus stealing swap-button focus before Enter. That implementation defect was fixed, and the browser sequence now passes. A reading test initially tracked an arbitrary later character on the first visible line; it was corrected to track the specified first-visible character, which stays anchored through reflow. Earlier diagnostic output remains available.
- Native Tauri IPC, installed app behavior, native HTML dragging, actual daemon streaming continuity, attachment file/folder drops, macOS shortcut conflicts, touch-device operation, forced-colors manual inspection, screen-reader announcements and representative-user validation remain **unverified**. Activity screenshots contain synthetic running/pending state; they do not establish native ongoing-work continuity.
- Focus fallback and modal/independent-focus supersession now have component-test coverage. The full native close/reset/modal matrix is not browser-verified. Forced-colors feedback now has browser emulation and screenshot evidence, not native assistive-technology certification. No full accessibility or release approval is claimed.

## Local evidence

Ignored local evidence is not automatically included in a clone:

- `.gg/eyes/out/chat-pane-swaps/`: bounded drag failure JSON; focus traces; canonical screenshots; before/midpoint/after swap captures.
- Final desktop activity series: `swaps-1280x800-1789922153740*`.
- Final narrow series: `swaps-390x844-1789922162323*`.
- `.gg/eyes/out/chat-workspace-preview/original-light-activity-six-1280x800-1789922159378.*` and `original-light-completed-six-390x844-1789922165041.*`: final browser metrics, assertions and captures. Despite the filename's code-surface parameter, these use the **Original** UI variant; they do not integrate the Light design.
- Foreground command logs are retained by execution ID under the local GG foreground log directory. Historical failures are not overwritten.

The design thesis remains the approved bounded interaction: reuse the existing pane toolbar, keep all conversations usable peers, preserve identity and reading location, and provide one reversible exchange rather than a new navigation system. The work is implemented, not fully native-verified or shipped.
