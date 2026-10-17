# App motion

## Purpose

Preserve GG Coder's existing dense workspace and visual language. Motion should explain a change without competing with reading, scrolling, or the next interaction. These rules concern app interaction motion, not GG Motion video choreography.

- One action has one geometry owner. Keep existing duration/easing tokens in `src/App.css`; JavaScript equivalents are checked by `scripts/motion-tokens.test.mjs`.
- Existing conversation content does not enter again on Checklist return. New visible messages and streamed words use opacity, not blurred or vertically moving text.
- A reversal starts from the currently displayed geometry. Cancel the previous animation before measuring its replacement's natural destination.
- Use layout CSS pixels for keyframes. Convert viewport snapshots under CSS zoom; never mix scaled DOMRects with unscaled layout sizes.
- Reduced motion and missing animation APIs must leave the correct final geometry and working controls without a waiting interval.
- Exiting content is noninteractive immediately. Visual retention must not retain keyboard or accessibility access.
- Own and release animations, observers, and timers. No persistent animation frame loop, unbounded message-ID cache, or stale geometry snapshot.

## Motion roles and reuse map

| Role                           | Owner                                                                             | Usage and boundaries                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-time message entrance      | `transcript-motion.ts`: `createEntranceLifetime`, `enterTranscriptRow`; `App.tsx` | Session-local high-water mark consumes eligibility before playback. Hidden arrivals settle on return. Paging and explicit question jumps retain their separate contracts.                                                                                                                                  |
| Streamed word feedback         | `useSmoothText.ts`, `StreamingMarkdown.tsx`, `Markdown.tsx`                       | Hidden/deactivated content returns fully revealed. Fresh visible growth may fade in; reading text is not blurred or scaled.                                                                                                                                                                                |
| Send/tool layout transaction   | `chat-layout-motion.ts`: `createChatLayoutMotion`; `App.tsx`                      | Capture before the update, commit final layout and scroll position before paint, then translate existing visible rows/surfaces back from their prior positions. Bounds capture to 80 visible rows. One expiry frame releases a capture that never commits; there is no persistent frame loop.              |
| Scroll intent                  | `transcript-pin.ts`; transcript effects in `App.tsx`                              | These remain the authority. Explicit sends repin; an upward user scroll releases following during replies. Unpinned layout changes preserve row/offset. Do not separately animate `scrollTop`.                                                                                                             |
| Composer sizing                | `composer-autosize.ts`                                                            | Empty-on-send commits the final textarea size immediately. Do not restore an independent shrink animation that competes with the chat transaction. Preserve scheduled `keepInput` and newly typed drafts.                                                                                                  |
| In-flow expansion              | `animated-height.ts`: `useAnimatedHeight`                                         | Capture displayed height before a toggle. Cancel before measuring natural height; own one reversible WAAPI animation. Pass content changes for retargeting. Used by Markdown code/output, error Details, and the queue list.                                                                               |
| Retained disclosure/list exits | `usePresenceList.ts`; `ChatErrorNotice.tsx`, `QueuedBar.tsx`                      | Stable measured shell, padding inside that shell, distinct opacity entry/exit, immediate expanded-state updates. Retained exits are inert and hidden from accessibility navigation. Do not introduce guessed maximum heights.                                                                              |
| Floating exit snapshots        | `FloatingSurface.tsx`, `view-transition.ts`, `Dropdown.tsx`                       | Keep the boundary mounted while its child becomes absent. Retain inert content only until local snapshot capture, not an arbitrary delay. Selection callbacks run once without waiting for animation. Local exits exclude the root conversation snapshot; nested updates share an existing transition.     |
| Equivalent dialog dismissal    | `Modal.tsx`, `modal-embed.tsx`: `ModalDismissButton`                              | Footer Close/Cancel shares the dismissal path with ×/Escape. Preserve focus origin/restoration, nested-dialog semantics, and embedded-page hiding. Async elicitation cancellation sends immediately and animates actual removal when it settles. Save/Confirm/navigation handoffs remain distinct actions. |
| Zoom-aware settings navigation | `SettingsTabBar.tsx`, `motion-geometry.ts`: `viewportScale`                       | Pill snapshots and label deltas use one coordinate system. Retarget/cancel pill and labels together; resize, zoom, fonts-ready placement, and cleanup remain owned. The helper measures fractional border-box width rather than relying on rounded layout width.                                           |

## Goal world (the one frame loop)

A started Goal's **Workers** view is a top-down pixel farm (`GoalWorld.tsx`, `goal-farm-*.ts`, art in `goal-map-*.ts`) that fills the window edge to edge, under a frosted, see-through header; the header's Chat | Workers switch flips to the conversation. It is the one deliberate exception to "no persistent animation frame loop", bounded like this:

- It loads on demand (`lazy`), so none of it is in the start-up bundle; it stays mounted while hidden (`Activity`), so switching views never rebuilds it.
- The static map (ground, buildings, trees, beds) is composed once per size into an offscreen canvas (~0.15s). A resize waits for the window to settle, and only rebuilds when the map's tile size or scale changes. A frame redraws only what moves: the critters, the fire, steam, koi, falling petals, the cat, chickens, butterflies and dragonfly.
- About 30fps while someone walks, arrives or leaves; about 10fps while the farm only idles.
- Window motion level decides the rest: `full` animates; `still` (unfocused) runs the farm exactly as `full` does (same frame rate, fire, water and animals all moving), since it's meant to be glanced at beside other work; `off` (hidden) draws nothing. Only reduced motion is a still picture with everyone placed where they're working. Unmounting releases the loop, the interval and the resize observer.
- Critters move like animals, not cursors: on foot along the paths at an easy walk (a jog for long trips), easing in and slowing to a stop, feet in step with the pace, never more than a couple of pixels a frame. Once at a station they work there at least `MIN_WORK_MS` (4s) before following the agent to its next tool, since agents switch tools every second or two. No vehicles, flying or teleporting.
- Nobody walks through anything. `Farm.walk` marks the ground each standing thing covers, worked out from its own pixels: a box (a desk, a building, the stove, the well) covers as many rows up from its foot as its top shows, a tree only its trunk's foot, plus the water and the pond's ring of stones. Walking behind something tall (under a canopy, past a roof) is fine; walking through its base isn't. The router moves walkway points that sit inside something to clear ground, and re-plans any stretch of a route that would cross something round it on a 3px grid, pulled taut so it doesn't zigzag.
- What a critter holds at work is drawn for the high camera in `goal-farm-held.ts`, outlined like the critters and kept off their faces: an open book held below the face, a page turning over; a bamboo rod over the pond, its float bobbing and dipping on a nibble, rings spreading; a mallet raised over the shoulder and struck flat, chips flying; a red-sun paper fan (uchiwa) swept face-on then edge-on at the stove, sparks rising off the fire; the laptop's glow flickering on the face; a writing board under the arm, line after line written by a pencil; a sealed letter held out; a porcelain teacup with steam curling off it, lifted to sip now and then.
- New workers are summoned in at the gate, a quieter, in-world take on the home screen's summon (`drawSummon`): a soft column of sunlight pours down, a ring of petals spreads on the ground, the critter's white silhouette grows out of the light with a small squash and stretch, then warms into its colours. Leaving plays it backwards after a moment at the gate. Newcomers say hello only about a third of the time, never within 6s of another greeting, and only once they've landed; finished workers only sometimes say goodbye (a failure always says so).
- `prefers-reduced-motion` behaves like `still`. The canvas is `aria-hidden`; a visually hidden live summary says who is doing what.
- One camera angle throughout: 3/4 from above, so for anything standing up its _top_ is the biggest thing you see (a roof is mostly roof; a tub is mostly its rim and water). New art follows `goal-map-topdown.ts`.
- One high viewing angle for every prop, as the kennel shows: surfaces facing up (roofs, the veranda floor, tabletops, the stove top) are drawn deep and make up most of the sprite; walls and other faces toward the viewer are short bands, about half their true height, shaded under the eave. Nothing is drawn front-on. Every building and piece of furniture is placed through `lean()` (`goal-map-props.ts`): widest at its eave or tabletop, its walls, posts and legs leaning in toward the ground, its roof narrowing toward the back. Draw props upright and let `lean` add the angle. Run boards and courses across a roof, not down it, so they stay clean when leaned.
- Shadows assume the sun is overhead. Standing props get a tight contact shadow: their own outline, nudged a few pixels down, so only a rim shows under them. Trees (`shadow.canopy`) get a single flat, lumpy pool centred on the trunk's foot. Stepping stones and fields are pressed into the ground and cast no shadow.
- Nothing is pasted over anything else. Grass and flowers are placed as filler (`F` in `goal-farm-map.ts`) and dropped wherever they would touch another drawn thing; a sprig may grow only against its own building's foot. The map is painted under everything that moves, so animals can't pass behind a prop: they wander loops planned once against a mask of every standing thing (`goal-farm-roam.ts`), never through a bush, tree or building, and an animal with nowhere clear to stand isn't placed at all.
- No two of a kind alike: bushes, shade trees, grass clumps, dirt patches and stones take their shape, size, texture and any flowers or fruit from their seed. Animals animate their legs only while they walk.
- Critters on the farm are their own roster (`goal-farm-critters.ts`), drawn for the high camera like the buildings: a big lit crown, the face low and squat under it, a short body. They're 14×15 and only the farm uses them; the app's floors keep their front-on critters. The roster is countryside animals (fox, bee, cat, owl, frog, mushroom, tanuki, rabbit, hedgehog, duck, red panda, squirrel, fawn, chick); no robots, ghosts or knights.
- Nobody stands on anybody. Station slots are planned once against what's drawn (`planSlots`): each clear of footprints and of anything that would stand in front of a critter, and far enough from every other slot that no two bodies overlap. A busy station's extras borrow the nearest free slots elsewhere. Anything standing that someone walks behind is redrawn over them (`occluders`), so critters and animals pass behind trees and buildings, never over them.
- Dev builds show preview controls in the Workers view: a "Preview crowd" toggle (GG Goals plus 18 sample workers changing jobs; the header's counts follow it), a "Preview question" toggle (GG Goals' notice with a sample question), and Time and Weather pickers. They never ship.
- Just right of the level badge, on the header's left, a started goal counts its workers in plain words: "2 working · 5 done · 1 failed" (failed only once any have). Working is who's on a task now; done and failed count tasks as they finish (`goal-progress.ts`), so a worker handed a follow-up keeps its finished task counted. The working count breathes while it's above zero. A `role="status"` carries the same words.
- The goal list marks each goal worth a glance with the shared `Badge`: "Running now" in the success tint, breathing, while it works; a neutral "Paused" when the user paused it. Goals still briefing or idle carry no pill, so a pill always means something. The list refreshes the status every 4 seconds while it's open. The pill and the header's working count share one animation (`live-breathe`, `--dur-breathe`).
- When GG Goals is blocked on a question (an open, not-yet-deferred `ask_user`), a wooden sign hangs from the header over the farm (`GoalAskNotice.tsx`): the farm's wood, paper and ink, GG Goals' fox hopping beside the question (two lines at most), and "Answer in Chat". It swings down when it appears, sways now and then, and stays up until the user has been to the chat while the question waited; after that only the Chat tab's dot remains until it's answered. It's a `role="alert"` and never takes focus; reduced motion fades it in and holds the fox still.
- Clicking something on the farm takes its hover glow off while it reacts (the glow traces it at rest), and back once it settles. A thing redrawn by a poke (a tree shaking) is drawn at its own depth with anything standing in front of it redrawn over it, like a critter passing behind.
- A poked tree or bush sways smoothly: it leans, swings back past upright once or twice and settles over about a second and a half (no per-row flicker). A tree's crown moves as one piece and its trunk bends from the root; a bush leans more at the top. While it sways, its spot is repainted from a copy of the map painted without the trees and bushes (`paintSwayBase`, made just after the farm appears), so its still self never shows behind the moving one.
- Time of day follows the local clock (`goal-farm-sky.ts`): dawn, morning, lunch, afternoon, evening, dusk and night, blended smoothly. Each has its own grade, baked into the map and every prop: shadows lean to one colour and highlights to another, with haze and saturation. Dawn's lavender is the farm's signature, so every daytime shadow keeps a little of it; morning is soft and dewy, lunch crisp and vivid, afternoon honey-gold, evening amber-rose. After dark the lanterns, the house's paper windows, the campfire and the stove light pools around them (dithered in pixel steps), and fireflies come out. Weather changes every four hours, the same for everyone: mostly clear, sometimes cloudy (cloud shadows drift over), rain, early-morning fog, snow only December to February.
- Weather lands on the world, not the screen (`goal-farm-weather.ts`). Every map pixel is classed as ground, a sky-facing top (roofs, canopies, caps), a side (walls, trunks), water or flat. Each raindrop falls a short way onto its own spot and splashes to suit what it hit: a ring on the pond or a puddle, spray on the ground, nothing on a wall. Snowflakes sway down, settle and fade. Snow builds up over about four hours as the lightest dusting: a few soft clumps on roofs and tops, a sprinkle of flecks on the grass, never a blanket. Each clump is a smooth mound, so it grows from its middle and melts from its edges in, never vanishing pixel by pixel. Falling snow and splashes are drawn on the ground under critters and props; only drops still in the air are drawn over them. Rain darkens what it wets, puts a sheen on roofs and stones, and fills small rounded puddles in the dirt, then dries. Cover is baked into the map in 24 steps, so it costs nothing per frame.
- Nothing changes abruptly. When the hour's light, the weather or the ground cover changes, the old look fades out over about 3 seconds while the new one fades in; the two night overlays are blended exactly, so the dark never pulses. A new spell of live weather eases in over its first 15 minutes (snow thinning as fog rolls in).
- Light respects what's around it, in three dimensions (`goal-farm-sky.ts`). From the high camera every map pixel shows open ground, the sky-facing top of something standing, or its side turned toward the camera; `lightRelief` works out once per farm where each pixel's surface really stands, how high, and which way it faces, plus a height field of everything standing. Each lamp stands somewhere on the ground with its flame at a height (`FarmLamp.z`; a stone lantern's firebox, a window set in its wall, a lantern on its pole), and lights a surface by its 3D distance, how squarely the surface faces it, and whether anything taller stands on the line between them. So a lamp behind a tree lights the ground round the tree but never the tree's near side; a lantern beside the house throws the house's shadow; a stone lantern's own body glows round its flame while its cap above catches only spill. Critters are lit as figures standing where they are (`LitBody`): the face turned to a lamp is lit, the far side isn't, and something in front of them hides them from it. The light falls off in five clean bands, dithered only at each band's edge.
- After dark every critter carries a paper lantern (chōchin) on a short bamboo pole held out in front, swinging with the stride, set down on the ground beside it while it works. Its light is the same as every fixed lamp's: each frame the dark round each lantern, and round each critter near a light, is recomputed with the same model (`litPatch`, `overlayPixel`), never painted over the dark as a halo. Boxes are sized to what stands within reach and cached on the prepared light while nothing in them moves; about 1.5ms a frame with 12 lanterns out.
- Things on the farm can be poked (`goal-farm-interact.ts`): click one, or Tab to its button and press Enter. Lights (stone lanterns, the house's windows, the side house, the campfire) switch on and off, and their light leaves the night overlay. Animals have three or four reactions each that they cycle through (the hen startles, flaps, pecks, lays an egg; the cat hisses, grooms, rolls, pounces; the shiba yawns, wags, rolls over, woofs; the koi splash, dart, rise for food), and freeze in place while reacting, then carry on from where they stopped. Critters wave (saying what they're doing), hop, show a heart or spin, without leaving their work; GG Goals sums up the crew. Props, trees and bushes rattle, shake, drop petals or fruit, or let a bird out; open ground puffs dust, grass, snow, or splashes a puddle. It's only play: nothing changes what the agents do, and switched lights last only for the session.
- Pokes play out on the terrain, not the screen. Leaves, petals, fruit, feathers and shavings fall from where they start to a real spot on the ground in front of what was poked (open ground, never under something standing), lie there for 15-40s each, each going at its own time, at most 160 at once; on the pond they float and ring the water. Ripples are clipped to the water, and a click on the pond's stones flicks a pebble into the nearest open water. The blossom's own drifting petals land and linger the same way.
- What's under the pointer gets a warm outline in its own shape and a hand cursor. The outline is depth-aware: it's drawn at the thing's own depth and masked wherever something nearer stands (`solids.front`), so it passes behind lanterns, critters and trees in front instead of crossing them; the canvas title names it. Every reaction is announced in a polite live region. The keyboard buttons are visually hidden until focused, then show as a small chip.
- Preview pickers are native selects, so the OS draws their menus and they're never clipped by the canvas.
- Cheap by design: the light is one overlay image rebuilt about every six minutes, cloud and mist are one small tile drifted across the map, and rain or snow are stateless 1px particles (each drop's place comes from the time), capped at 900. Falling weather raises the idle frame rate to about 20fps; everything else stays at 10fps. Speech bubbles draw above the light, so they stay readable at night.
- Water moves: the bamboo spout reaches out over open water (`pondSpout`), and the live view draws its water flowing down from the pipe, a splash, and rings spreading where it lands. Rings fade by thinning out, not by transparency, and are lit on the far side and dark on the near side so they read on any water.
- The whole farmstead is always in view: `farmScale` is the exact scale at which it fills the space below the header, so the farm shrinks and grows smoothly with the window. It is deliberately not a whole number (a whole-number scale jumped from 2× to 1× just below full screen, halving the farm); nearest-neighbour scaling keeps it crisp. Countryside fills any extra space. Speech bubbles use the 3x5 pixel font (`goal-world-font.ts`), never canvas text.

## Extending an interaction

1. Identify its existing geometry owner before adding animation.
2. Capture the visible starting state before the state update; measure the natural destination only after cancelling an old override.
3. Keep callbacks, focus, and accessibility state independent of visual completion.
4. Cover reversal, content change, hidden/reactivated views, unmount, reduced motion, and missing APIs in the existing tests.
5. Verify intermediate rendered geometry, not only final DOM state or screenshots.

Do not replace genuine in-flow expansion with scaled text merely to avoid animating height. Unrelated decorative effects and established paging/jump effects are not implicitly removed by these rules.

## Verification and evidence

`scripts/check-motion-continuity.mjs` bundles the real App and isolated production components once, with production CSS and a fictional local Tauri bridge. Unknown consequential bridge calls fail visibly. It needs the existing Playwright Chromium and WebKit installations; no provider or terminal task is required.

Run the acceptance check without `--record`:

```sh
pnpm --filter gg-app exec node scripts/check-motion-continuity.mjs
```

The runner samples intermediate geometry, uses controlled animation times for reversals, and saves normal-playback recordings and screenshots. Coverage includes 1280px/640px, Checklist states and hidden streaming, send/pinning, disclosures, tool-panel changes, menu/dialog dismissal, fallback modes, and CSS zoom at 50%, 95%, 100%, 125%, 150%, and 200%. `--record` only records a baseline; it is not acceptance.

Dated evidence and finding status live in the ignored `.gg/reports/app-motion-review-2026-10-07.md` and its adjacent artifact directory. Automated passes do not override an unresolved screenshot anomaly. Browser Chromium/WebKit is not native Tauri verification: native macOS smoke, Windows WebView2, and blocking cross-platform CI remain separate release gates.

# GG App Interface Design

## Native appearance and reading preferences (2026-09-21)

**Surface/job:** preserve the dense native coding workspace and its one-to-six-pane/unequal-split workflow while allowing independent theme/readability choices. The established user workflow is supported; broader audience/access needs and long-term comfort remain unestablished. This is not a redesign or eye-strain treatment claim.

**Direction:** optional source-inspired Light with a pale control/composer surface, soft workspace wash, light code, pearl rank badge, light scorecard and contained Autopilot switch. Preserve Geist, the existing icon system, ranks, humor and effects. The coding wake screen stays intentionally dark. Default Dark/current reading is retained; the shared modal close glyph received a measured contrast correction.

**Defaults:** Dark; 15px prose; current letter and paragraph spacing; no wide-pane cap; current identity treatment; current streamed-word reveal. Six reading choices remain independent of theme. Reset affects only appearance. No persisted Original/Reading comparison mode or charcoal-code experiment.

**Reuse map:** `appearance.ts` owns validated origin-local preferences and root application; `appearance.css` owns theme/reading roles; existing `theme.ts` exports resolve semantic aliases with valid alpha composition. `AppearanceSettings` uses labeled native selects and the existing modal focus/scroll model. `usePaneSwapViewState` captures/restores reading anchors and selections across preference reflow without remounting panes. `ActionMetal` uses its installed library's Light palette. `appearance-native.ts` serializes the existing window API setters; portals and What's New inherit root roles.

| State                            | Contract / current evidence                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| Dark/default                     | Existing compact reading retained; scoped native checks passed                                      |
| Light/default or changed reading | Independent saved fields, same pane/session hosts; scoped native smoke passed                       |
| Corrupt/denied storage           | Validated defaults or session-only choice with visible warning; unit tests                          |
| Other native window / What's New | Saved initialization and live same-origin updates; native review                                    |
| Reflow / unequal panes           | Existing glyph/composer/selection restoration; native fixture tests                                 |
| Narrow / 200% / keyboard         | Stacked new controls, modal scroll/focus retained; component and native evidence separately labeled |
| Reduced motion / forced colors   | Existing effect fallback and scoped controls checked; exhaustive coverage unverified                |
| OS cold start / install / macOS  | Unverified; no flash-free or release claim                                                          |

Implementation details, launch commands, measured contrast, retained test failures, state coverage and remaining acceptance gaps are in [native appearance](../docs/design/chat-workspace/native-appearance.md). The full accessibility/native acceptance matrix is not certified complete. Existing historical sections below remain scoped to their original work.

## Phase 17: Compact Notes Shell

### Design read

- **Surface:** A dense developer-tool workspace inside the existing Notes modal.
- **Audience:** Keyboard-heavy GG Coder users managing project notes in resizable Tauri windows, including split-screen, zoomed, reduced-motion, and Windows high-contrast use.
- **Single job:** Let the user reach and edit the relevant Notes section without scrolling through unrelated sections.
- **Task and risk:** Notes are edited frequently and saved optimistically. Draft loss, hidden-control focus, and obscured save diagnostics are higher risks than visual novelty.
- **Content:** Short current-focus text, variable task lists and actions, multiline Handoff and Reference text, archived tasks, and passive phase/reminder counts.
- **Platform:** React in a Tauri webview with keyboard and pointer input across resizable desktop windows.
- **Constraints:** Preserve the current Geist typography, dark tokens, modal, section, button, form, focus-ring, persistence-status, and task-lifecycle language. Add no design dependency, icon family, Roadmap controls, structured-reference rows, or product-wide style changes.

### Design thesis

Use one stable workspace frame: title and storage status first, a fixed plain-text tab rail second, and exactly one independently scrolling panel below it.

The selected tab uses stronger text and an underline rather than a pill, icon, glow, or elevated surface. All four panels stay mounted so drafts, edit mode, archive disclosure, and panel scroll positions survive navigation. The modal uses one shared inner content rail across every panel.

Only color and border feedback transition. There is no spatial tab animation, hover lift, glass, gradient, decorative emoji, or ambient motion.

### Local reuse map

| Need                                   | Existing source                                      | Phase 17 use                                                                                  |
| -------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Dialog semantics, Escape, focus return | `src/Modal.tsx`                                      | Retain and harden its shared focusable-element filter.                                        |
| Tabs and roving keyboard behavior      | `src/MemoryModal.tsx`                                | Reuse the tablist/tab/tabpanel pattern, automatic activation, and focus movement conventions. |
| Notes editors and task lifecycle       | `NotesCurrentFocus`, `NotesTaskList`, `NotesHandoff` | Move unchanged beneath destination panels and preserve callbacks.                             |
| Persistence diagnostics                | `NotesPersistenceStatus` in `src/ProjectNotes.tsx`   | Keep fixed above the tab rail with existing live-region wording.                              |
| Visual language                        | `src/App.css` and `src/theme.ts`                     | Reuse surfaces, borders, radii, form controls, button anatomy, and focus treatment.           |
| Typography and icons                   | Existing Geist and Lucide setup                      | Keep existing type roles; add no navigation icons.                                            |

### Content and count contract

- **Overview:** Now, Next, and Handoff in that order. Show an inline Roadmap summary only when an active phase or active reminder exists.
- **Roadmap:** Show passive active-phase and active-reminder totals, or an honest empty state. Do not expose phase titles or create, edit, reorder, status, selection, or session actions.
- **Reference:** Keep the existing free-form `Reference notes` textarea. Structured references remain undisplayed until Phase 19.
- **Archive:** Keep the existing Done / Archive disclosure, archived rows, empty state, and Restore actions. Settled phases remain undisplayed until Phase 18.
- **Stable navigation:** Overview, Roadmap, Reference, and Archive are always present. Empty count fragments disappear without shifting tab positions.
- **Active phase:** Any phase whose status is neither `done` nor `cancelled`.
- **Active reminder:** A non-null reminder attached to an active phase. Settled-phase reminder data does not count.
- **Titlebar status:** Existing unfinished-task and Handoff badge semantics remain unchanged.

### Interaction and accessibility contract

- Use one labeled horizontal `tablist` with four `tab` buttons and four matching `tabpanel` elements.
- Every tab has a stable `id`, `aria-controls`, `aria-selected`, and roving `tabIndex`; every panel has matching `aria-labelledby`.
- Activate tabs automatically. Left and Right arrows wrap; Home and End select the first and last tabs.
- Initial modal focus lands on Overview. Tab then enters only Overview content.
- Keep inactive panels mounted with the native `hidden` attribute.
- Modal initial focus and containment exclude negative-tab-index controls and descendants of `hidden`, `aria-hidden="true"`, or `inert` ancestors.
- Preserve Escape close, trigger focus return, semantic labels, live save/task status, visible `:focus-visible`, and minimum 24 CSS-pixel pointer targets.
- Pointer activation must not masquerade as keyboard focus. Selected state remains visibly independent from focus state.
- Keep title, persistence status, and tab rail fixed. Only the active panel scrolls vertically.
- Use text plus structure rather than color alone for selection, counts, warnings, errors, and empty states.

### Responsive behavior

- Size the Notes workspace relative to the viewport with a small outer gutter and bounded shared panel rail.
- At narrow widths, keep a single vertical reading flow and let only the tab rail scroll horizontally.
- Keep the modal and active panel within the viewport; do not introduce page-level horizontal scrolling.
- Wrap task actions and edit controls without changing DOM or focus order.
- Preserve reachable controls and readable unbroken content at 320 CSS pixels and 200% text zoom.
- Keep target sizes and focus outlines intact for pointer, keyboard, no-hover, and Windows desktop input.
- Under `prefers-reduced-motion: reduce`, remove tab color/border transitions while preserving immediate state feedback.
- Under forced colors, retain visible dialog, tab, panel, control, selected, and focus boundaries.

### State matrix

| State                      | Required result                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Initial open               | Overview is selected and focused; exactly one panel is visible.                              |
| Populated Overview         | Existing edits and task actions remain available; non-zero Roadmap summary fragments appear. |
| Empty Overview summary     | Zero phase/reminder fragments are absent; all tabs remain stable.                            |
| Empty Roadmap              | Honest no-active-roadmap-work message with no CRUD or session action.                        |
| Populated Roadmap          | Correct singular/plural passive counts only.                                                 |
| Reference editing          | Existing textarea value and sidecar persistence flow remain intact across tab switches.      |
| Archive collapsed/expanded | Disclosure and Restore behavior remain intact across tab switches.                           |
| Authoritative rerender     | Selected tab and mounted local editor/disclosure state survive.                              |
| Project switch             | Old modal closes; prior project tab and content cannot leak into the new project.            |
| Save warning/error         | Existing live diagnostic stays fixed and visible above navigation.                           |
| Long content               | Only the selected panel scrolls; shell title, status, and tabs remain fixed.                 |
| Narrow/zoomed              | Tab rail scrolls horizontally, actions wrap, and no page-level horizontal overflow appears.  |
| Reduced motion             | State feedback is immediate with no tab transition.                                          |
| Forced colors              | Selected tab, controls, focus, and boundaries remain distinguishable.                        |

### Release evidence contract

Phase 17 is complete only after all of the following are reviewed and pass:

1. Focused Notes/modal/storage tests, gg-app typecheck, lint, and format check.
2. Full gg-app test suite and production build.
3. Controlled browser captures with synthetic non-sensitive v3 fixtures for empty desktop, typical Overview, long content, and a 320–420 CSS-pixel narrow window.
4. One native Tauri smoke at typical and narrow window sizes.
5. Keyboard-only tab selection plus every existing edit and restore flow; visible, unobscured focus; no hidden-panel focus; Escape; and trigger focus return.
6. Semantic role/name/control inspection and live-status wording review. Automated accessibility scans are defect detection, not full conformance proof.
7. 200% text and 320 CSS-pixel reflow, long unbroken content, and long-label/localization stress.
8. Pointer focus, reduced-motion, and Windows forced-colors/high-contrast checks.
9. One rendered critique-and-revision cycle scoring at least 20/24 on the evidence-led UI rubric, with no zero in accessibility, consistency and flow, responsive behavior, state completeness, or content authenticity.
10. Honest recording of unavailable performance or accessibility tooling rather than substituting semantic tests for missing evidence.

## Phase 19: Shared Structured Reference Library

### Design read

- **Surface:** A dense library/detail workspace inside the existing Tauri Notes modal.
- **Audience:** Keyboard-heavy developers managing implementation evidence across one or more repositories in resizable, zoomed, reduced-motion, and Windows forced-colors environments.
- **Single job:** Save one exact source once, understand why it matters, and attach it to the right roadmap phases.
- **Task and risk:** Reference capture and reuse are frequent, while a wrong repository identity, hidden attachment, duplicate source, or accidental deletion can silently corrupt later context.
- **Content:** Long canonical URLs, owner/repository identities, revisions, deep paths, line ranges, issue or pull-request numbers, queries, anchors, relevance notes, capture times, 0 to 50+ references, and active, settled, or archived phases.
- **Platform:** React 19 in a Tauri 2 webview with keyboard and pointer input. The installed opener plugin hands an explicit persisted HTTP(S) URL to the system browser.
- **Constraints:** Preserve Geist typography, the four mounted Notes panels, the existing free-form Reference notes editor, sidecar CAS persistence, Phase 18 lifecycle behavior, and one scrolling active panel. Add no dependency, icon family, body cache, source preview, session behavior, or product-wide restyle.

### Evidence and thesis

Local Phase 18 Roadmap list/detail behavior is the primary evidence: it already establishes compact rows, a selected-edge treatment, stable focus return, and narrow one-surface-at-a-time recomposition. The existing Notes form, button, field, border, focus, and live-status primitives remain authoritative over external patterns.

Use a quiet repository-owned library/detail composition. Repository headings establish ownership, compact rows establish exact source identity, and one selected detail owns metadata, phase attachments, edit, open, and guarded delete actions. First glance is repository ownership, second glance is source coordinate and relevance, and the primary action is `New reference` until a row is selected. The memorable device is repository identity as the visual organizer, expressed through text and shared key lines rather than badges or decoration.

Use flat canvas and bordered containment only where list/detail hierarchy requires it. Selected state uses the existing inset edge and stronger text. Named color and border transitions may provide feedback; no spatial animation, hover lift, glass, gradient, semantic tint-on-tint treatment, decorative card, pill system, emoji, icon medallion, or body preview belongs in this workspace.

### Reuse map

| Need                                      | Existing source                              | Phase 19 use                                                                                         |
| ----------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Notes shell and mounted tabs              | `src/NotesModal.tsx`                         | Keep the Reference panel mounted and let the modal activate it from an empty phase attachment state. |
| Compact list/detail and focus restoration | `src/NotesRoadmap.tsx`                       | Match row selection, selected edge, narrow detail recomposition, and return-focus behavior.          |
| Forms and controls                        | `src/App.css` Notes fields/buttons/selects   | Reuse label, input, textarea, button, focus, wrapping, and logical spacing anatomy.                  |
| Persistence and live status               | `src/useProjectNotes.ts`, `ProjectNotes.tsx` | Route typed ID-based mutations through the optimistic CAS queue and announce results politely.       |
| External URL opening                      | `@tauri-apps/plugin-opener`                  | Wrap verified `openUrl(url)` behind one injectable boundary; call it only from `Open source`.        |

### Component and state contract

- Keep `Reference notes` first and unchanged. Add `Structured references` beneath it with a deterministic count and `New reference` action.
- Group only saved references by normalized `provider + owner/repo`; hide empty groups and sort groups and rows deterministically without changing IDs.
- A compact row shows source label, optional path/range or issue/PR identity, relevance, and linked-phase count. The row button alone owns selection, so rows contain no nested interactive controls.
- Selection reads stored metadata only and survives authoritative snapshots while the ID exists. Detail exposes exact repository, canonical URL, optional coordinates, relevance, capture time, phase links, edit, `Open source`, and delete.
- One labeled create/edit form covers provider/tool, canonical URL, owner, repository, optional retrieval metadata, relevance, and create-time phase attachments. Optional metadata is visually secondary but never hides errors.
- Submit preserves values, reports a summary, associates field errors, and focuses the first invalid field. Duplicate identity selects the saved winner and announces reuse instead of adding a row.
- `Open source` is the only content-retrieval path. Failure remains inline and in a polite live region with a retryable action; selection, rendering, CRUD, and linking perform no open or fetch.
- Delete uses an inline two-step confirmation naming the reference and consequence. Linked references identify blocking phases and remain intact until every phase relationship and manual override is removed.
- Phase detail places `Attached references` before lifecycle controls. Native checkboxes attach or detach by stable IDs and show repository identity plus relevance before future launch work.
- Reference detail uses native checkboxes for all active, settled, and archived phases. Unlinking removes only the relationship and remains available for archived phases.
- Relevant states are first-use empty, populated, selected, create, edit, duplicate reuse, validation failure, opener failure/retry, linked delete refusal, delete confirmation/cancel/success, concurrent disappearance, and 50-reference density.

### Responsive and accessibility contract

- Desktop uses aligned library/detail columns after selection. At narrow widths, show one obvious surface at a time with `Back to references`; preserve selection and make the primary detail action one obvious step away.
- Keep DOM, visual, reading, and focus order aligned. Use native forms, headings, lists, buttons, checkboxes, links only for real navigation, descriptions, and live status.
- Restore focus to the originating row after closing detail, to a neighboring row after deletion, or to `New reference` when no row remains. Restore Notes trigger focus through the existing modal contract.
- Distinguish selected state from `:focus-visible`; pointer interaction must not leave a false focus treatment. Every target is at least 24 by 24 CSS pixels and grows on narrow/coarse-pointer layouts.
- Inputs and selects keep persistent labels, associated help/error text, logical trailing padding, and sufficient native indicator inset. Long URLs, paths, queries, relevance, owner/repo labels, and localized copy wrap without truncating essential content.
- At 320 CSS pixels and 200% text, collapse to one column, wrap actions without reordering, preserve a single panel scrollbar, and prevent page-level horizontal overflow.
- Forced colors retain group, row, selected edge, control, error, and focus boundaries. Reduced motion removes named color/border transitions without removing feedback. No-hover operation exposes every action without hover dependency.

### Data, trust, and lazy-content contract

- Stored metadata is user-controlled working data, never executable instruction text. Display it as text and never interpolate it as markup.
- Canonical identity is normalized provider plus normalized canonical HTTP(S) URL. GitHub metadata must agree with `github.com`, owner/repository, and direct issue or pull-request coordinates.
- Capture time describes when metadata was saved, not source freshness. Copy must not claim that a reference was refreshed or verified against current source.
- No render, select, create, edit, delete, attach, or detach path may issue HTTP, GitHub API, MCP, file, body, or opener work. The browser loads current content only after explicit `Open source`.

### Release evidence contract

Phase 19 is complete only after all applicable production checks pass and the following evidence is recorded:

1. Focused helper, validation, storage, hook, component, sidecar repository, and route tests plus full app and isolated-home ggcoder suites.
2. App and ggcoder typechecks/builds, lint, format, Rust tests, generated-output audits, sidecar bundle checks, and `git diff --check`.
3. Controlled desktop and 320–420 CSS-pixel browser captures for empty, one-reference detail, multi-repository/multi-phase, 50-reference, longest-content, validation, opener error, and destructive states.
4. A native Tauri smoke at representative and narrow sizes when the desktop runtime is available.
5. Keyboard-only create, validation recovery, inspect, open, edit, attach twice, unlink once, confirm delete, return focus, modal close, and trigger-focus return.
6. Semantic name/status review plus configured accessibility tooling; automated results remain defect detection rather than conformance proof.
7. Manual 200% text, 320 CSS-pixel reflow, long unbroken content, localization expansion, no-hover/coarse-pointer, reduced-motion, and forced-colors checks.
8. Instrumented proof that pre-open reference interactions produce zero app-side fetch/body/open calls and explicit open produces exactly one persisted-URL call.
9. One rendered critique/revision cycle scoring at least 20/24 with no zero in accessibility, consistency and flow, responsive behavior, state completeness, or content authenticity.
10. Field performance remains explicitly unverified without real telemetry; local render and interaction checks are regression evidence only. Unavailable native or assistive-technology tooling is recorded honestly.
