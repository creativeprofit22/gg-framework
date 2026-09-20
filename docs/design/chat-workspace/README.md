# Chat workspace comparison

Status: browser-preview implementation, bounded verification and evidence handoff complete. **Accepted preview direction: Light, Light code, pearl rank badge, light scorecard and contained Autopilot switch. Production integration remains unapproved.** Light is explicitly source-inspired, not fidelity-verified, under the user's degraded-evidence decision. Accessibility/conformance limits remain documented. Nothing here changes the installed app.

## Goal

Compare the actual GG Coder workspace with independently selectable reading adjustments, optional small identity markers, and a Yaatuber-derived light surface. Preserve humor, ranks, effects, controls, and technical character. Six panes are the principal case, not a fixed layout requirement. No generated whole-app concept is an implementation target.

## Modules

- [Architecture and isolation](architecture.md)
- [Reference ledger](references.md)
- [Validation and comfort protocol](validation.md)
- [Decisions and pending choices](decisions.md)
- [Light-surface and code refinement](surface-refinement.md)
- [Latest rank badge, scorecard and Autopilot refinement](rank-controls.md)

These documents are not ignored by Git, but have not been committed. Local design memory, approved plan, reference extracts, screenshots, and raw probe evidence live under ignored `.gg/` and do not accompany a clone automatically. Do not force-add proprietary extracts or heavy evidence.

## Current execution boundary

The user separately approved restarting the existing server and fixing two unsupported button-query options in `ProgrammaticDiscovery.test.tsx`. The identified old Vite process was stopped; the preview server is running on port 1420. Other application changes were preserved. The approved local style-pack and historical design-context pointers were updated to this handoff.

The real UI, synthetic native boundary, layouts, transient reading controls, optional markers and light-surface candidate are implemented. The reference pixel gate does not pass: it compares an empty background reference with a populated workspace. That result is retained; the user authorized continuing experimentally without a fidelity claim, not marking the pixel gate passed. Accessibility/affordance probes also report baseline findings. See [validation](validation.md) before treating any candidate as accepted.

## Latest refinement

The rank badge is now pearl with deeper rank colours, its popup is a light scorecard, and Autopilot has a contained two-state switch. Click the badge or try the switch in the synthetic preview. Progress now comes from the real pure backend builder on deterministic synthetic data: 18,240 XP correctly shows level 25 / Netrunner / Vibe and 88%. Earlier Shipwright/Gold screenshots remain historical illustrative examples, not valid rank metadata. See rank-controls.md for corrected captures, canonical tier/cap scenarios, separately labelled style-only probes, focus/reflow checks and limits.

The earlier header/footer/composer refinement remains in place. Light code is the user's preference and default; **Code surface (Light only)** retains soft charcoal for comparison. Earlier screenshots below are historical evidence, not the latest badge/popup appearance.

## Preview command

From the repository root, when port 1420 is available (reuse the running instance during this session):

```bash
GG_CHAT_DESIGN_PREVIEW=1 pnpm --filter gg-app dev --host 127.0.0.1
```

Open http://127.0.0.1:1420/__chat-design-preview for six panes. The **Preview comparison** controls independently select size, tracking, paragraph spacing, wide-pane cap, identity markers and streamed-word treatment. Original ignores every experimental setting. Changes are transient.

Query options include `layout=one|two|three|five|six|six-rows|uneven`, `variant=original|reading|light`, `size=15|16`, `tracking=current|normal`, `paragraphs=current|roomy`, `cap=off|on`, `markers=off|on`, `streaming=current|crisp`, `code=light|charcoal`, and `state=completed|empty|activity|error|retry|variants`. `capture=1` hides the comparison controls without shifting the workspace.

Runner commands:

```bash
node gg-app/scripts/chat-design-preview/run.mjs six reading 2560 1400
node gg-app/scripts/chat-design-preview/matrix.mjs
node gg-app/scripts/chat-design-preview/probes.mjs
node gg-app/scripts/chat-design-preview/states.mjs
node gg-app/scripts/chat-design-preview/triage.mjs
```

The runner checks HTTP success, the synthetic-preview marker and a hashed canonical-checkout identity before launching its own browser. Only reuse a server belonging to this checkout. A missing or mismatched identity stops capture; the runner does not kill the existing server or switch away from port 1420. The identity prevents accidental wrong-checkout reuse, not impersonation or stale-source capture.

The capture runner's comparison profile is 16px, normal tracking, roomy paragraphs, cap/markers on, crisp streaming. These are proposals, not installed defaults. Canonical probes use the installed Windows uimaxxxing root; no packages are installed. The reference extractor is intentionally one-shot and refuses to overwrite existing reference extracts.

Ordinary app startup and production assets remain outside the preview. Neither a source change nor a browser screenshot updates the installed application.

## Review the comparisons

Start with **Original versus Reading**, then compare Light with the same reading settings. Use your usual room lighting, display scaling and app zoom. Begin briefly; continue longer only if comfortable. Markers, spacing and crisp streaming are independent proposals, not a bundle that must be accepted together. No claim is made about treating eye strain.

- [Open Original](http://127.0.0.1:1420/__chat-design-preview?layout=six&variant=original)
- [Open Reading comparison profile](http://127.0.0.1:1420/__chat-design-preview?layout=six&variant=reading&size=16&tracking=normal&paragraphs=roomy&cap=on&markers=on&streaming=crisp)
- [Open source-inspired Light with identical reading settings](http://127.0.0.1:1420/__chat-design-preview?layout=six&variant=light&size=16&tracking=normal&paragraphs=roomy&cap=on&markers=on&streaming=crisp)

Local six-pane screenshot evidence at 2560×1400, DPR 1, app zoom 1, after the same resize/streaming exercise:

- [Original PNG](../../../.gg/eyes/out/chat-workspace-preview/original-completed-six-2560x1400-1789785485047.png)
- [Reading PNG](../../../.gg/eyes/out/chat-workspace-preview/reading-completed-six-2560x1400-1789785491038.png)
- [Light PNG](../../../.gg/eyes/out/chat-workspace-preview/light-completed-six-2560x1400-1789785497728.png)
- [Desktop/narrow comparison sheet](../../../.gg/eyes/out/chat-workspace-preview/probes-1789785197399/contact-sheet.png)

These links require this local evidence directory. Random existing idle phrases/effect timing can differ; the representative reply and test sequence are the same. Images are not a replacement for the live comfort comparison.

Current preference: source-inspired Light with Light code. Continue reviewing the refinements in the browser; any native integration still requires a separate plan and approval.
