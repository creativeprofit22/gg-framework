# Supah Coder cosmetic rebrand plan

## Goal

Rebrand **visible gg-app UI copy** and **app chat-facing model copy** to **Supah Coder**.

Keep this **cosmetic-only**: no package renames, no bundle identifiers, no binary names, no app data directories, no session/custom-entry names, no sidecar filenames, no updater endpoints/plumbing, no IPC route/event names.

## Audit findings

### Visible app/UI copy to change

- `gg-app/src/HomeScreen.tsx`
  - Home banner byline says `By Ken Kai`.
  - Promo links point to `https://skool.com/kenkai` and `https://youtube.com/@kenkaidoesai` with labels `Skool` and `YouTube`.
  - Plan: remove the Skool/YouTube promo link row and replace the byline with neutral Supah Coder copy.

- `gg-app/src/AsciiLogo.tsx`
  - ASCII logo and `aria-label` are `GG Coder`.
  - Plan: replace the visible ASCII wordmark with `SUPAH CODER` and `aria-label="Supah Coder"`.

- `gg-app/src/App.tsx`
  - Default window/title fallback uses `GG Coder`.
  - Header fallback shows `GG Coder`.
  - Input placeholders advertise `@Ken`.
  - Mentor routing visibly uses `@Ken`.
  - Footer model menu labels/tooltips say `GG Coder`, `GG`, `Ken`, and `Ken's model`.
  - Update banner says `Ken just pushed a new update`.
  - Transcript labels say `Sent to GG Coder`, `Sending GG Coder back in`, and similar.
  - Plan: change visible product copy to `Supah Coder`, short label to `SC`, and mentor/reviewer display copy to `Supah` / `@Supah` while preserving the internal `ken_*` event family and `/ken/*` routes.

- `gg-app/src/Markdown.tsx`
  - Prompt button/title says `Send to GG Coder` / `Sent to GG Coder`.
  - Plan: change to `Send to Supah Coder` / `Sent to Supah Coder`.

- `gg-app/src/ModelMenu.tsx`
  - Follow row says `Follow GG Coder`; tooltip says Ken adopts GG Coder's model.
  - Plan: change visible text to `Follow Supah Coder`; internal props stay unchanged.

- `gg-app/src/AutopilotReviewBar.tsx`, `gg-app/src/KenActivityBar.tsx`, `gg-app/src/PlanReviewModal.tsx`, `gg-app/src/useKenMentor.ts`, `gg-app/src/useAutopilot.ts`
  - Visible status/error copy says `Ken reviewing…`, `Ken is thinking…`, `Ken: ...`, and `Ken is reviewing this plan…`.
  - Plan: change visible labels/prefixes to `Supah ...`; keep component/hook names and `ken_*` event handling unchanged.

- `gg-app/src/KenPowerBanner.tsx`
  - Visible ASCII overlay says `KEN IS ON` / `KEN IS OFF`.
  - Plan: change ASCII overlay to `SUPAH ON` / `SUPAH OFF` or `SUPAH IS ON` / `SUPAH IS OFF` without renaming the component/file.

- `gg-app/src/Badge.tsx`
  - Source badge label for `ggcoder` is `gg-coder`; mentor source badge label is `Ken Kai`.
  - Plan: change labels to `Supah Coder` and `Supah` while keeping source keys `ggcoder` and `ken` unchanged.

- `gg-app/src/WhatsNewWindow.tsx` and `gg-app/src/changelog.ts`
  - What's New title says `GG Coder`.
  - Recent changelog bullets contain many visible `GG Coder`, `Ken`, `@Ken`, `KEN IS ON`, `Kencode search`, and first-person Ken references.
  - Plan: update visible changelog strings to `Supah Coder`, `Supah`, `@Supah`, `SUPAH IS ON/OFF`, and generic `code search`; keep versions/dates unchanged.

- `gg-app/src/build-info.ts`, `gg-app/vite.config.ts`, `gg-app/src/ProjectPicker.tsx`, `gg-app/src/SettingsModal.tsx`
  - `GG Coder Local Fork` appears as a Vite-injected custom build label shown in the picker/settings/version row.
  - Plan: change only the display label to `Supah Coder Local Fork`; keep package name, Tauri productName, binary name, identifier, and updater config unchanged.

- `gg-app/src-tauri/src/lib.rs`
  - Initial window title is `.title("GG Coder")`; comments mention Ken/GG Coder.
  - Plan: change only the visible window title to `Supah Coder`; leave IPC command names like `agent_ken_prompt`, `/ken/prompt`, and tests for process paths/binaries unchanged.

- `gg-app/installer/dmg.html`
  - DMG background source contains `GG Coder` ASCII/footer copy.
  - Plan: update the source copy to `Supah Coder`; do not touch `tauri.conf.json` binary/app identity fields.

### Chat-facing model/system copy to change

- `packages/ggcoder/src/system-prompt.ts`
  - Default non-Anthropic identity is `GG Coder by Ken Kai`.
  - Plan: add an optional display-brand parameter to `buildSystemPrompt` / `AgentSessionOptions`, pass `Supah Coder` from `app-sidecar`, and preserve the CLI default as `GG Coder by Ken Kai`.
  - Anthropic stays `Claude Code` for the existing provider compatibility rule.

- `packages/ggcoder/src/core/agent-session.ts`
  - Rebuilds system prompts on initialize/new session/plan mode/approved plan.
  - Plan: thread the optional `productDisplayName` through every rebuild path so gg-app gets `Supah Coder` without using a static custom prompt that would break plan-mode prompt rebuilds.

- `packages/ggcoder/src/app-sidecar.ts`
  - Main app session currently constructs `AgentSession` without a display brand.
  - History restore pushes persisted mentor turns as `@Ken ...`.
  - 409 error says `Ken is already thinking — wait for his reply.`
  - Plan: pass `productDisplayName: "Supah Coder"`; render persisted mentor questions as `@Supah ...`; change visible error text to `Supah is already thinking...`; leave `/ken/*`, `ken_*`, `kenModels`, session payload keys, and persisted custom kinds untouched.

- `packages/ggcoder/src/core/ken-prompt.ts`
  - The mentor/autopilot persona says `Ken Kai`, `@Ken`, and `GG Coder`; prompt button contract says `Send to GG Coder`.
  - Plan: change only generated prompt prose to `Supah`, `@Supah`, and `Supah Coder`; leave function/module/constant names like `buildKenSystemPrompt`, `KEN_PROMPT_FENCE`, and filenames unchanged.

- `packages/ggcoder/src/core/ken-context.ts`
  - Digest labels and fixed review instructions say `GG Coder` and `Ken autopilot (injected)`.
  - Plan: change model-facing labels to `Supah Coder` and `Supah autopilot (injected)`; leave exported symbol names like `INJECTED_PROMPT_LABEL` unchanged.

### Explicitly out of scope / must not change

- `gg-app/package.json` `name`.
- `packages/ggcoder/package.json` `name`, bin name `ggcoder`, repository URLs, npm scope.
- `gg-app/src-tauri/tauri.conf.json` `productName`, `mainBinaryName`, `identifier`, updater `endpoints`, updater `pubkey`, `externalBin`, resource paths.
- `gg-app/src-tauri/Cargo.toml` package/lib names.
- Sidecar filenames and bundled paths: `app-sidecar`, `sidecar/`, `ggnode`.
- App data dirs and settings/session/log paths: `~/.gg`, `gg-app.json`, `gg-app-sidecar.log`, session custom kinds.
- IPC/protocol names: `agent_ken_prompt`, `agent_switch_ken_model`, `/ken/prompt`, `/ken/model`, `ken_*`, `autopilot_*`, `kenModel`, `kenModelOverride`.
- Provider/API/support links that are not promo branding: Telegram BotFather/userinfobot setup links, MCP placeholder docs, provider endpoints, CDN/model URLs, Tauri/Vite docs, updater plumbing.

## Risk controls

- Keep internal `ken` names as implementation details to avoid session/protocol migrations.
- Support `@Supah` visibly and keep `@Ken` as a hidden legacy alias for existing user muscle memory; render all new/resumed visible chat as `@Supah`.
- Avoid custom static system prompts because they bypass `AgentSession` plan-mode/approved-plan rebuilds.
- Do not regenerate or rename installer/bundle artifacts unless a later release task explicitly asks for asset generation.

## Verification

- Run `pnpm --filter gg-app check`.
- Run `pnpm --filter gg-app test -- src/useKenMentor.test.ts src/useAgentEvents.test.ts src/markdown-prompt.test.ts`.
- Run `pnpm --filter @kenkaiiii/ggcoder test -- src/system-prompt.test.ts src/core/ken-prompt.test.ts src/core/ken-context.test.ts`.
- Run targeted greps after implementation:
  - User-visible files should have no Skool/YouTube promo URLs.
  - User-visible string literals should prefer `Supah Coder` / `Supah` / `@Supah`.
  - Internal files may still contain `ken` identifiers and protocol names by design.

## Steps

1. Add `gg-app/src/brand.ts` with display-only constants for `Supah Coder`, `SC`, `Supah`, `@Supah`, and hidden legacy alias `@Ken`.
2. Update gg-app UI components (`HomeScreen.tsx`, `AsciiLogo.tsx`, `App.tsx`, `Markdown.tsx`, `ModelMenu.tsx`, `AutopilotReviewBar.tsx`, `KenActivityBar.tsx`, `KenPowerBanner.tsx`, `PlanReviewModal.tsx`, `Badge.tsx`, `WhatsNewWindow.tsx`) to use Supah Coder/Supah visible copy and remove Skool/YouTube links.
3. Update visible build/installer copy in `gg-app/vite.config.ts` and `gg-app/installer/dmg.html` while leaving `gg-app/src-tauri/tauri.conf.json`, package names, identifiers, binary names, and updater fields untouched.
4. Thread an optional app display brand through `packages/ggcoder/src/system-prompt.ts` and `packages/ggcoder/src/core/agent-session.ts`, preserving existing CLI defaults and Anthropic's `Claude Code` identity.
5. Pass `productDisplayName: "Supah Coder"` from `packages/ggcoder/src/app-sidecar.ts`, change visible sidecar mentor/history/error strings to Supah, and keep all `/ken/*`, `ken_*`, session payload, and persistence names unchanged.
6. Update chat-facing mentor/autopilot prompt prose in `packages/ggcoder/src/core/ken-prompt.ts` and `packages/ggcoder/src/core/ken-context.ts` to Supah/Supah Coder while preserving exported symbol names and file names.
7. Update affected tests in `gg-app/src/useKenMentor.test.ts`, `packages/ggcoder/src/system-prompt.test.ts`, `packages/ggcoder/src/core/ken-prompt.test.ts`, and `packages/ggcoder/src/core/ken-context.test.ts` to assert Supah visible/chat-facing copy and legacy-safe internals.
8. Run the targeted checks listed in Verification and fix any failures.
9. Run final greps for `Skool`, `youtube.com/@kenkaidoesai`, `GG Coder`, `GG Coder Local Fork`, `Ken Kai`, `@Ken`, and `Send to GG Coder`; classify remaining hits as either intentionally internal/protocol or update them if they are visible copy.