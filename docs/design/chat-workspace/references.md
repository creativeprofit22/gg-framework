# Reference ledger

This ledger carries forward the approved plan's source observations dated 2026-09-18. Those public sources were not fetched again during baseline setup. No external implementation code or assets have been copied. Recheck only sources actually reused during implementation; record license evidence before copying code. Default-branch freshness is a dated observation, not correctness evidence.

| Source | Immutable revision and inspected path | Intended principle; limits | Rights status |
| --- | --- | --- | --- |
| React Resizable Panels | [`152b1a8f856438c432b360a77a5afbdeb78782fb`, `lib/global/mountGroup.ts:30–100`](https://github.com/bvaughn/react-resizable-panels/blob/152b1a8f856438c432b360a77a5afbdeb78782fb/lib/global/mountGroup.ts#L30-L100) | Element dimensions and constraints; preserve GG's split architecture | No code copied; license not revalidated in execution |
| Readest | [`8eeb90026479cd8aa1504fc0b9186646af53dd77`, `apps/readest-app/src/components/settings/LayoutPanel.tsx`](https://github.com/readest/readest/blob/8eeb90026479cd8aa1504fc0b9186646af53dd77/apps/readest-app/src/components/settings/LayoutPanel.tsx) | Separate line/paragraph/letter spacing and reading dimensions; do not borrow UI or store | No code copied; license not revalidated in execution |
| Assistant UI | [`534e11fa22102cd7c1c94ff6850742796cd37fa1`, `examples/with-pi/components/assistant-ui/elements/thread.tsx`](https://github.com/assistant-ui/assistant-ui/blob/534e11fa22102cd7c1c94ff6850742796cd37fa1/examples/with-pi/components/assistant-ui/elements/thread.tsx) | Full width with a maximum reading width; no generic visual styling | No code copied; license not revalidated in execution |
| Nyaterm | [`f32fa823c020f4ad77fc9c542ea4c1bf0bb87f07`, `src/components/app/start-workspace/AssetView.tsx:165–218`](https://github.com/nyakang/nyaterm/blob/f32fa823c020f4ad77fc9c542ea4c1bf0bb87f07/src/components/app/start-workspace/AssetView.tsx#L165-L218) | Container-scoped work surface; asset view is not chat-behavior evidence | No code copied; license not revalidated in execution |
| Dockview | [`3b519454178f203d41acd49bd2733b5cdcd0f9be`, `packages/dockview-core/src/dockview/popoutWindowService.ts:143–188`](https://github.com/dockview/dockview/blob/3b519454178f203d41acd49bd2733b5cdcd0f9be/packages/dockview-core/src/dockview/popoutWindowService.ts#L143-L188) | Deduplicate dimensions, defer work, dispose observers; no Dockview dependency or popout feature | No code copied; license not revalidated in execution |

The approved plan reports Readest and Assistant UI newer than the indexed corpus snapshots. Do not substitute those older snapshots silently. rc-dock has a recorded freshness mismatch and is not a current primary reference.

## Standards

- [MDN container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Container_queries): component-relative sizing principle. Native support and containment effects require local verification.
- [W3C visual presentation](https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html): 80-character guidance is AAA, not a blanket AA failure.

These links are prior planning evidence, not new conformance testing.

## Yaatuber reference

The user identified their installed Yaatuber onboarding as the source for adaptation. Inspect only the allowlisted HTML/CSS members from its installed archive, revalidate archive/version/member hashes and render static content with application JS and network disabled. Installation does not establish redistribution rights.

Selected traits: layered near-white base, soft spectral perimeter light, lit edge and depth. Editable traits: gradient placement, strength and geometry. Excluded: logos, audio, authentication/application logic, third-party fonts/assets and fixed onboarding proportions.

Canonical source/decision/contract/gate/notes now live in ignored `.gg/reference-ui/yaatuber-chat-light/`. Installed version 2.28.2; archive SHA-256 `f82a3e28701e024bafda7c1a650333432a64e67826b580c65b9d329f15f3a4f4`. Onboarding CSS SHA-256 `da0816d5fdb1941db30c79b12de6b59e1d91a84ab87dbde5c4650fef171c9161`.

Five allowlisted members were bounded/read/hashed; no application JS ran and no profile was opened. The inspected onboarding CSS has no imports or URL resources. The local static reference links only that stylesheet, with script/network/font/image access denied by CSP. Canonical reference capture succeeded at 1280×800 and its background-only PNG was inspected.

The adaptation uses newly authored CSS gradients/shadows reflecting the selected traits, not distributed Yaatuber assets. The implementation gate currently fails its strict pixel comparison between the empty reference background and populated workspace (different size, content, controls and geometry). The user explicitly approved continuing the browser comparison with degraded evidence: source-inspired, not fidelity-verified. The failed gate is preserved, not converted into a pass. No implementation-fidelity or redistribution-rights claim is made. Historical captures remain separate from this current-source capture.
