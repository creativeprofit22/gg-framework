# Model audit — 5 September 2026

**Implementation update:** the confirmed alignment fixes are implemented, and the catalog now has 32 hosted model entries. Live provider inference and account-specific Gemini availability remain unverified.

- Added opt-in Gemini 3.8 Flash, Gemini 3.5 Flash Lite, and experimental DeepSeek V4 Flash Vision. Existing models/defaults remain available; experimental vision does not replace DeepSeek's stable summary model. Gemini retains its existing policy: summaries use the selected model; default/fast routing still uses 3.1 Flash Lite.
- Wired the new Gemini IDs through request construction and actionable OAuth-unavailable errors. A public GA release is **not** a promise that a given Code Assist account can call it.
- Fixed DeepSeek Off and low/high/max settings, including saved medium/xhigh/ultra compatibility; preserved Fugu Ultra v1.1's real max effort.
- Aligned DeepSeek, GLM, and Moonshot output caps with their documented `max_tokens` field. DeepSeek V4 entries share a conservative 384,000-token application cap rather than mixed decimal/binary interpretations of 384K.
- Enabled Qwen image/video input with a 20 MiB practical inline-video cap. Cross-provider video history no longer forwards Moonshot-only upload handles to OpenRouter.
- Local context discovery now reads Ollama running allocations and LM Studio loaded instances (v1 with v0 fallback), validates positive integer limits, and reports a conservative 4K **unknown** fallback rather than the training maximum. LM Studio routing by model key uses the smallest known loaded allocation.
- Compaction summaries now respect the selected summary model's output ceiling, including small local models.
- Added real-SDK offline request regressions, local HTTP fixture tests, catalog/thinking checks, Gemini routing/error coverage, and a compaction output-cap regression.

### Verification after implementation

- Full workspace build, typecheck, and lint passed.
- Full workspace test run passed: **5,160 passed, 17 existing skips**. No tests were disabled or relaxed to hide failures.
- The new regressions reproduced the pre-fix wire/context/summary-cap mismatches before the fixes.
- Built catalog inspection confirmed all 32 entries, new model limits/capabilities, reasoning ladders, and preserved default/summary routing.
- Not run: paid/live model inference, account-specific Gemini entitlement checks, packaged desktop smoke, Linux/Windows CI. Local discovery was exercised against real local HTTP test fixtures, not users' running model servers.

Additional implementation sources: [GLM output schema](https://docs.z.ai/api-reference/llm/chat-completion), [OpenRouter video wire format](https://openrouter.ai/docs/guides/overview/multimodal/videos), [Ollama running models](https://docs.ollama.com/api/ps).

## Original audit (before implementation)

The findings and line references below describe the **pre-change** code. Original scope: 29 hosted models across 12 providers, local discovery, model switching, context/compaction consumers, and provider request construction. No credentials read or paid inference performed. This report does **not** certify account-specific access or live inference for every model.

## Spec findings — freshness and available capabilities

### S1. New Gemini releases are absent

- Location: `packages/gg-core/src/model-registry.ts:293–357`.
- The picker still offers Gemini 3.7 Flash and 3.1 Flash-Lite but omits **Gemini 3.8 Flash** (GA September 2) and **Gemini 3.5 Flash-Lite** (GA July 21).
- Both newer releases document **1,048,576 context / 65,536 output**, thinking, tool calls, and multimodal input.
- Fix: verify availability through the app's actual Gemini route before adding them. Public Vertex availability does **not** prove Code Assist OAuth entitlement. Preserve working older models until that check succeeds.
- Sources: [Gemini 3.8 Flash](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-8-flash), [Gemini 3.5 Flash-Lite](https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-5-flash-lite).

### S2. Fugu Ultra cannot reach its new maximum reasoning level

- Locations: `packages/gg-core/src/model-registry.ts:242–251`; `packages/gg-ai/src/providers/transform.ts:988–998`.
- The `fugu-ultra` alias now targets v1.1, which has a distinct **max** effort. The registry caps it at `xhigh`; the shared wire conversion also changes `max` to `xhigh`.
- An offline SDK request capture confirmed a requested `max` becomes `reasoning_effort: "xhigh"`.
- Fix: allow and preserve `max` specifically for current Fugu Ultra. Plain Fugu still has only high/xhigh as distinct levels.
- Source: [Sakana's official guide](https://console.sakana.ai/get-started).

### S3. Qwen3.6 Plus is incorrectly treated as text-only

- Location: `packages/gg-core/src/model-registry.ts:534–541`.
- Both image/video flags are false, but the live OpenRouter endpoint catalog advertises **text + image + video** input. Its registered **1,000,000 context / 65,536 output** matches the catalog.
- Impact: images are downgraded rather than delivered natively; video is blocked by capability checks.
- Fix: enable only after adding request-shape coverage for the OpenRouter media path; update the associated video limits/read-tool handling as needed, not just the flags.
- Source: [Live OpenRouter endpoint metadata](https://openrouter.ai/api/v1/models/qwen/qwen3.6-plus/endpoints).

## Standards findings — settings and transport alignment

### W1. DeepSeek's Off and maximum reasoning settings do not mean what the UI suggests

- Locations: `packages/gg-ai/src/providers/openai.ts:161–164, 208–210, 277–299`; `packages/gg-ai/src/providers/transform.ts:988–998`; `packages/gg-core/src/model-registry.ts:505–527`.
- DeepSeek enables thinking by default. Disabling it requires `thinking: { type: "disabled" }`, but DeepSeek is excluded from the provider toggle branch.
- DeepSeek supports distinct **low/high/max** efforts. It maps both medium and xhigh to high. The registry exposes xhigh as its ceiling, and the shared transformer converts even explicitly requested max to xhigh.
- Offline SDK request capture reproduced both mismatches: Off sends no disabling toggle; max sends xhigh.
- Impact: Off can still incur reasoning work, and the strongest reasoning mode is unreachable. Thinking-history replay also needs a regression check because DeepSeek requires reasoning content on subsequent tool-enabled requests.
- Fix: give DeepSeek its documented toggle and effort mapping, and align the selectable levels with those semantics.
- Source: [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode).

### W2. DeepSeek output caps use an undocumented field

- Location: `packages/gg-ai/src/providers/openai.ts:198–202`; routing: `packages/gg-ai/src/stream.ts:92–98`.
- All shared Chat Completions providers receive `max_completion_tokens`. DeepSeek's current public schema documents `max_tokens` instead.
- Offline SDK capture confirmed `max_completion_tokens: 1234` and no `max_tokens` when requesting a 1,234-token limit.
- **Confirmed:** request/schema mismatch. **Not verified:** whether the live service tolerates this alias, ignores it, or rejects it. Do not claim an observed outage or truncation.
- Fix: use each provider's documented cap field and test the outgoing body; verify aliases only where intentionally retained. Audit other compatible endpoints rather than assuming OpenAI parameter names are universal.
- Source: [DeepSeek Chat Completions schema](https://api-docs.deepseek.com/api/create-chat-completion). Real-code cross-check: [DeepSeek Harness's endpoint-specific output-field compatibility](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/llm/llm-pi-ai/src/catalog.ts#L359).

### W3. Local context discovery can overstate the usable window

- Locations: `packages/gg-core/src/local-models.ts:310–330, 353–358`.
- Ollama discovery reads the model architecture's maximum context; LM Studio reads `max_context_length`. Neither necessarily equals the currently allocated context.
- Ollama documents local defaults of 4K/32K/256K depending on VRAM. LM Studio's own example advertises a 262,144-token model but a loaded instance configured for only 4,096.
- Impact: the context meter and compaction threshold can assume substantially more space than the running server has. This affects local models when allocation is below the model maximum; no local installation was probed during this audit.
- Fix: prefer running-instance context metadata (Ollama running models, LM Studio loaded-instance configuration). Treat unknown allocation as unknown; do not silently allocate more memory.
- Sources: [Ollama context allocation](https://docs.ollama.com/context-length), [LM Studio loaded-instance metadata](https://lmstudio.ai/docs/developer/rest/list).

## Coverage and unresolved checks

| Provider | Active entries reviewed | Result / qualification |
| --- | ---: | --- |
| Anthropic | 4 | No additional confirmed catalog discrepancy found. |
| OpenAI | 4 | No additional confirmed catalog discrepancy found; Codex product limits remain distinct from public API limits. |
| Sakana | 2 | Fugu Ultra max reasoning gap; output ceiling not independently proven. |
| xAI | 2 | No additional confirmed catalog discrepancy found; subscription access not live-tested. |
| Gemini | 4 | New Flash and Flash-Lite releases missing; actual OAuth availability unverified. |
| Moonshot | 2 | Current K3/K2.7 entries present. Public K3 docs say always-reasoning, while code comments claim Off was empirically verified; reconcile before changing behavior. |
| GLM | 2 | GLM-5.3-Flash has documented video capability, deliberately disabled in code pending transport verification. |
| MiniMax | 1 | No additional confirmed discrepancy; output ceiling not independently proven. |
| Xiaomi | 3 | No additional confirmed catalog discrepancy found. |
| DeepSeek | 2 | Reasoning and cap-field gaps above. New `deepseek-v4-flash-vision-exp` is an optional experimental addition, not a mandatory replacement. |
| OpenRouter | 1 | Qwen modalities understated; context/output numbers match live metadata. |
| Hugging Face | 2 | Limits can vary by routed backend; a single fixed model limit is not sufficient proof for every backend. |

Additional cautions:

- **DeepSeek units:** both current models document 384K maximum output, but the registry stores **393,216** for Pro and **384,000** for Flash (`model-registry.ts:512,525`). The documentation's abbreviated units alone do not establish which exact integer is correct. Verify before normalizing upward. [Pricing/specifications](https://api-docs.deepseek.com/quick_start/pricing).
- **HF routing:** the live router catalog includes a GPT-OSS backend with **128,072** context versus the registry's **131,072**. Backend selection matters. [Router catalog](https://router.huggingface.co/v1/models).
- **Codex:** account-based requests intentionally use a separate transport and omit generic output-cap fields; do not force unsupported public-API fields into that route. The registry's product-specific 272K overrides were not independently revalidated against a current account catalog.
- **Kimi:** reconcile endpoint-specific Off behavior with [current K3 documentation](https://platform.kimi.ai/docs/pricing/chat-k3.md); documentation conflict is not proof that the currently working route fails.
- **Local summary budgeting:** summary output sizing follows context size rather than the selected model's output ceiling (`compactor.ts:993–997,1100`). Local runtime models can advertise smaller output budgets; add a cap-alignment test when addressing local limits.

## What is already wired correctly

- Hosted entries flow from the shared registry rather than separate desktop copies.
- `AgentSession.resolveMaxTokens()` clamps explicit overrides to the selected model's ceiling; model switching recomputes the output budget (`agent-session.ts:587–594,2317–2321`).
- Desktop model switching re-clamps supported thinking levels and broadcasts updated context-meter state (`app-sidecar.ts:4539–4545,4570–4572`).
- Compaction queries the active model and account-aware context helper. Its percentage-based policy is deliberate; this audit does not propose subtracting the entire theoretical output maximum from every context window.
- The built catalog's model IDs match the source catalog.

## Verification performed

**476 targeted tests passed:**

- gg-core registry, thinking levels, local models: **66**.
- gg-ai provider tests: **189**.
- ggcoder model switching, context limits, compactor, session compaction: **221**.

Three additional offline request captures exercised the actual built SDK transport with a stubbed fetch: DeepSeek Off, DeepSeek max, and Fugu Ultra max. No network inference occurred.

These tests validate current behavior, not vendor freshness; passing tests do not invalidate the documented discrepancies above. Full CI, desktop visual checks, account entitlement checks, and live generation were not run.

## Recommended order

1. Fix DeepSeek reasoning semantics and documented output-cap field; add wire-body regressions.
2. Correct effective local context discovery and summary output clamping.
3. Add Fugu Ultra's true max level and verify Qwen media transport.
4. Verify the new Gemini releases through the supported route, then add them without prematurely removing working models.
5. Resolve exact provider/output units and backend-specific ceilings before raising any limits.
