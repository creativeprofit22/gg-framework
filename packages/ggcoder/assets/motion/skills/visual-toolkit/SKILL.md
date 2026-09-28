---
name: visual-toolkit
description: The 9/10 craft layer for every Motion video — the HyperFrames catalog (387 installed blocks and components: liquid glass, 3D devices, WebGL/shader transitions, depth-of-field, motion blur, kinetic type, cursor rigs, counters, textures), how to pick 2–3 signature moments per video, a continuous hero element, sub-frame motion blur, spring motion, and Opus 5.5's named visual defaults to avoid. Use when storyboarding any video, choosing effects or transitions, when a draft looks plain, flat or "AI-made", or when the user asks for more impressive, cinematic or 3D visuals.
---

# Visual toolkit

A 5/10 video is correct: clean type, fades, one layout per scene. A 9/10
video has **2–3 signature moments** built from real craft, one continuous
visual thread, and texture and motion physics that make it feel filmed rather
than slid. Plan them in the storyboard; don't bolt them on at the end.

## Scope: implement the approved design

Read `frame.md` and the scene's reuse / adapt / derive record first. This
skill supplies techniques, not a competing style. All aesthetic prescriptions
below (depth, texture, springs, signature effects) are conditional on the
approved contract. A flat two-colour scene does not need grain or 3D to earn
craft; precise typography, composition and timing can be its signature.
Search before inventing, then reuse, adapt or derive as `style-library`
describes. Record the source and inherited rules rather than rebuilding a
suitable piece from memory. Never add an effect merely to satisfy this list.

## 1. Shop before building anything

Two sources, in this order:

1. **GG's style library** (`style-library`): a small set of complete looks
   (art directions) and render-verified pieces, each with a preview image
   and all styled by the look's tokens. Pick the look first; it decides
   palette, type, background and motion rhythm for the whole video.
2. **The HyperFrames catalog** for everything else:

HyperFrames ships 387 blocks (full scenes/transitions) and components
(effects you attach), installed offline. Search it while storyboarding:

```bash
hf catalog --query "liquid glass" --json      # search
hf catalog --tag transition --json            # browse by tag
hf add <name>                                 # installs into compositions/
```

Read the installed file's header comment: it documents parameters and how to
mount it. Blocks are sub-compositions (`data-composition-src`); components
are snippets you paste and attach. Restyle every item with the brand kit's
colors and fonts — a stock-looking block is worse than none.

Starting points by job (verified names; search for more):

| Job | Catalog items |
|---|---|
| Product UI as hero | `browser-device-stage`, `device-frame-stage`, `multi-device-splay`, `parallax-device-dive`, `vfx-iphone-device`, `macos-tahoe-liquid-glass`, `ios26-liquid-glass`, `app-showcase` |
| UI choreography | `simulated-cursor`, `press-ripple`, `modal-morph`, `notification-cascade`, `ai-chat-reveal`, `claude-exchange`, `spotlight-card` |
| Camera and depth | `camera-rig-depth-stack`, `rack-focus`, `focus-rack`, `camera-dolly-zoom`, `scroll-camera-story`, `parallax-zoom`, `gallery-tunnel` |
| Materials | `liquid-glass-widgets`, `liquid-glass-notification`, `vfx-liquid-glass`, `glass-shard-title`, `vfx-liquid-background` |
| Transitions | `light-leak`, `domain-warp-dissolve`, `cross-warp-morph`, `chromatic-radial-split`, `cinematic-zoom`, `flash-through-white`, `beat-freeze-cut`, `glitch`, `vfx-shatter`, `vfx-portal` |
| Type | `variable-axis-type`, `headline-slam`, `char-slam-explode`, `particle-text-dissolve`, `code-slice-hero` (see `type-system`) |
| Numbers and data | `number-wheel`, `count-up`, `apple-money-count`, `bar-chart-race`, `data-chart`, `chart-story` |
| Code | `code-3d-extrude`, `code-morph`, `code-diff`, `code-typing`, `code-terminal-run`, `code-snippet-dark-2026` |
| Texture and light | `grain-overlay`, `grain-field`, `light-sweep-pass`, `aurora-drift`, `mesh-gradient-bg`, `ordered-dither-pass`, `halftone-field` |
| Physics of motion | `motion-blur`, `shutter-slam`, `stop-motion-cadence`, `arc-motion-path`, `focus-blur-resolve` |
| Logo and end | `logo-sting`, `logo-brand-close`, `logo-outro`, `trust-strip` |

For hand-built 3D shots (studio-lit products, the real UI on a 3D device,
extruded logos, procedural scenes), load `motion-3d`. For custom 2D shaders
and HTML pushed through WebGL, load `hyperframes-animation` →
`adapters/html-in-canvas-patterns.md`.

## 2. Signature moments (2–3 per video)

In the storyboard, mark 2–3 scenes as **signature** and name the technique.
Each must serve the story beat it's on, not decorate it:

| Beat | Signature technique that fits |
|---|---|
| Hook | real UI arriving in a 3D device with a camera push; a hero word slamming in with a width morph |
| Problem → solution | shader dissolve or domain warp from the "before" to the "after" UI |
| Feature reveal | cursor-driven UI with a modal morph and rack focus onto the result |
| Proof / numbers | a number wheel landing on the downbeat, in a condensed display face |
| Technical depth | code on a lit 3D slab (`code-3d-extrude`) or a camera dive into the stack |
| End | logo sting on the final downbeat, held still |

Everything else stays calm so the signature moments land. More than three
reads as a demo reel. Check at the stills gate that each signature frame
looks like a still from a real launch film.

## 3. One continuous hero element

The strongest 2026 launch films keep **one element on screen that never
cuts**: the product window, a shape, or a device that morphs through every
state while the camera moves around it. Prefer this over a slideshow of
scenes. Scene changes become: the hero moves, re-shapes or is revealed from
a new angle (`modal-morph`, `camera-rig-depth-stack`, `parallax-device-dive`).
When scenes must cut, match-cut on shape, color or position.

## 4. Motion physics

- **Motion blur on fast moves.** `hf add motion-blur`, then
  `data-hf-motion-blur` on the element that moves (not its container).
  Transform-driven moves only. Use on whip moves, slams, device flights,
  big type moves; skip on slow drifts.
- **Springs, not tweens, for UI.** A closed-form spring is a pure function of
  time, so it stays seek-safe. Critically damped or 1 small overshoot
  (`back.out(1.2)` is the GSAP stand-in). Moving panels: give the leading and
  trailing edge slightly different timing so the element stretches ahead.
- **Arrive fast, settle long.** Cover ~80% of the move in the first 20–30% of
  its duration, then ease in to the final position (`expo.out`,
  `power4.out`). Exit along the arrival direction.
- **Depth, when the contract calls for it.** Use three layers on dimensional hero scenes (background, subject,
  foreground). Foreground moves 1.2–1.5× the background on camera moves;
  background slightly defocused.
- **Texture, only when approved.** A light `grain-overlay` (and optionally a slow
  `light-sweep-pass`) unifies flat UI into one filmed image. Keep it subtle:
  visible on a pause, invisible in motion.
- **Frame 0 is already good.** No logo intro, no empty fade from black: the
  first frame shows the product or the hook.
- **Never `will-change` on elements the camera scales** — it rasterizes and
  blurs text.

## 5. Opus 5.5's own defaults — avoid unless a look calls for them

Anthropic's guidance for Opus 5.5 names its default visual choices; generic
instructions just swap one default for another, so avoid these by name:

- cream / off-white backgrounds
- an italic serif accent word inside a sans headline
- numbered "01 / 02 / 03" section labels sprinkled in as decoration
- monospace labels on everything
- pill-shaped buttons and tags

The same elements are fine as a deliberate, consistent system chosen for
the whole video. A broadcast look *is* mono corner labels, a counter and a
timecode on every frame (`duotone-broadcast` in the style library). The
test: does the element belong to the video's chosen look (`style-library`)
and appear consistently, or was it sprinkled in because it looks "designed"?

Also treat as 2026 clichés when used as decoration: dithering, halftone,
chrome, particle fields, gradient orbs. Use them only when the brand, story
or look motivates them (dithering for a retro dev tool is fine; on a bank is
not). The rest of the anti-slop list lives in `motion-direction` § 7.

## 6. Components the user brings

If the user pastes a component or links one (uiverse, 21st.dev, Magic UI,
shadcn, CodePen…), load `component-import`.
