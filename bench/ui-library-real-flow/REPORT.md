# Production UI-library integration: offline verification + first live GLM 5.3 batch

Snapshot: 22 September 2026. Base revision `ec29187fabda3767663e0ff815423307ed3420a6` plus uncommitted working-tree changes.

## First live batch (GLM 5.3, 22 Sep 2026)

Authorization: explicit human ceiling selected 22 Sep — 6 runs / 120 requests / 2,000,000 tokens (`live-approval.json`).

**Ceiling overrun (harness defect, disclosed): actual spend was 6 runs / 121 requests / 3,310,005 reported tokens — 65% over the token ceiling.** Each case constructed its own budget from the approval file, so the global cap never spanned the batch; the between-case guard only counted requests, not tokens. Fixed after the run: one shared budget across all case brokers, plus a pre-case guard on both requests and tokens.

Per-case results (all on fresh Vite+React+TS+Tailwind4 fixtures, isolated HOME, brokered GLM 5.3):

| Case | Time | Reqs | Tokens | Build | Typecheck | Hosted-source provenance |
| --- | --- | --- | --- | --- | --- | --- |
| bklit-shimmer (named) | 435s | 36 | 920,368 | pass | pass | 0.980 vs hosted `shimmering-text.json` |
| kokonut-cardflip (named) | 240s | 18 | 466,268 | pass | pass | 0.984 vs hosted `card-flip.json` |
| motion-outcome (outcome-led) | 124s | 9 | 141,345 | pass | pass | n/a — hand-built; `prefers-reduced-motion` honored, timers cleaned |
| pricing-outcome (outcome-led) | 66s | 6 | 88,778 | pass | pass | n/a — hand-built with Tailwind, no discovery attempt observed |
| kokonut-drawer (named) | 410s | 26 | 1,137,671 | pass | pass | 0.767 vs hosted `smooth-drawer.json` |
| bklit-shimmer repeat | 260s | 26 | 555,575 | pass | pass | 0.980 (matches first run) |

Findings:

- **Reliability of output: 6/6 fresh generations built and typechecked clean, with real adopted source in every named case** (77-98% line-overlap with the hosted payload; remainder is import relocation and small edits). The repeat run reproduced the first run's provenance.
- **Tool utilization by the agent: not proven.** The worker's transcript serializer dropped tool-call names and truncated the system prompt, so it cannot be shown whether `ui_registry`/`ui_adopt` were used. No `ui_registry`/`ui_adopt` result fingerprint (payload hashes, adoption-plan JSON, `bklit:`/`kokonut:` item IDs) appears in any recorded tool result, and the outcome-led cases show no discovery attempt at all — the pricing case hand-built despite the routing guidance. Named cases reached the correct hosted source by some other path. Serializer fixed (names/args kept, caps raised); utilization measurement needs a re-run.
- **Speed:** 66-435s per case (median ≈ 250s), 3-36 model requests per case. The heaviest case (drawer) burned 1.14M tokens across 26 requests.
- Three workers exited 1 after finishing: a result-serialization crash (`prompt()` returning undefined), not a generation failure — builds prove the work completed. Fixed.
- `sandbox-exec` aborts (SIGABRT) on this macOS build, so workers ran with environment isolation only (isolated HOME/cwd/env, loopback token broker, real API key confined to the supervisor). Process-level filesystem sandboxing is unverified on this machine.
- No browser/interaction/teardown checks ran in this batch; pass criteria above are build, typecheck and source provenance only.

## Implemented

- Production `ui_registry` and `ui_adopt` tools, built-in inventory, deferred search hints and normal-session promotion.
- Public Bklit/Kokonut registry inspection, supporting shadcn source, Motion API guidance, bounded network/cache/graph handling and separate hosted hashes versus inventory revisions.
- Project-aware adoption plans, TypeScript import relocation, prerequisite/conflict reports, exclusive new-file creation using the existing checkpoint/notification/diagnostic write pipeline. Remote-operation sessions do not expose the local adoption writer.
- Source-hash-gated Mouse Effect Card cleanup recipe with original/patched provenance. Unknown source versions are not silently patched.
- Bundled `evidence-led-ui` routing and `references/ui-libraries.md`. No personal/project skill overrides were edited.
- Disabled-by-default budget broker, offline authorization rejection tests and worker-isolation scaffolding. No approved live ledger was created.

## Executed checks

| Check | Result |
| --- | --- |
| `pnpm --filter @kenkaiiii/ggcoder test` | 266 files passed, 2 existing skipped; 3,212 tests passed, 17 existing skipped |
| `pnpm check` | Passed across workspace |
| `pnpm lint` | Passed, including desktop app |
| `pnpm build` | Passed in workspace dependency order, including gg-ai → gg-agent → ggcoder |
| `node --test bench/ui-library-real-flow/*.test.mjs` | 18 passed, zero skipped |
| Historical catalog source-schema compatibility | All 115 stored dependency/entry payloads accepted; no observations rewritten |
| Normal AgentSession discovery | Both tools advertised, promoted append-only; production Motion guidance executed offline |
| Built-source sidecar smoke | Isolated HOME/project, no credentials: boot, authenticated local `/session` and `/state`, clean shutdown |
| Mouse Effect Card production recipe | Exact equality with independently reviewed historical fix; notices, styling constants and entire consumer/callback body preserved; changed source hash rejected |

The first full test run found the deferred hint block exceeded its existing character budget. Hints were shortened; the limit was not raised. Lint found a type-import style error, corrected before the final runs. No existing assertions were removed, skipped or weakened.

## Authorization and fresh generation

**Human spending approval remains unconfirmed. Paid requests: 0. Reported paid tokens: 0. Fresh generated cases: 0.** Automated reviewer instructions and plan approval are not live spending permission. Proposed ceilings are not approved caps. Approval provenance must be recovered and independently verified, or a new explicit human budget exchange obtained, before any live transport is enabled.

No first-attempt success rate, repeat consistency, per-entry behavioral pass rate or fresh-generation reliability has been measured. None of the offline checks is counted as a fresh-generation pass.

## Remaining limitations

- The live end-to-end driver connecting isolated workers, metered provider transport and artifact/interaction collection is not complete. Broker scaffolding alone is not a verified live-run boundary.
- The desktop smoke checks boot/session routing, not `/prompt` model-driven UI tool events. Those remain unverified; normal-session tool promotion/execution was separately tested without a model request.
- No new browser teardown or reduced-motion run was performed here. Compatibility evidence establishes exact equivalence to the reviewed historical patch, not new browser-runtime coverage. The original 120 observations and existing harness results remain untouched.
- Catalog-wide project adoption, provider/style prerequisite resolution and fresh Vite/Next generation remain unverified. Unsupported project conventions may require explicit prerequisite preparation. This is not proof that every registry entry can be adopted without intervention.
- The compatibility harness reads the immutable historical catalog under ignored benchmark results; a clean checkout needs that evidence fixture to run this particular check.
- Executed on macOS only. Windows/Linux behavior and a packaged/installed app update are not verified by this run. No release, installation, commit or push occurred.
- Component/dependency rights need independent review; see `COMPLIANCE.md` (engineering guidance, not legal advice).
