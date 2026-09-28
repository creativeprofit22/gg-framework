---
name: motion-direction
description: Direct a motion video like a senior motion designer — story beats, pacing by format and length, timing and easing tables, choreography, transitions, an anti-AI-slop banned list, and Director Notes for precise revisions. Use when writing a storyboard, choosing timing/easing, choreographing a scene, turning user feedback into edits, or reviewing why motion feels generic, busy or off.
---

# Motion direction

Decide **why** something moves before deciding **how**. HyperFrames skills own
the mechanics (GSAP, keyframes, transitions, audio); this skill owns taste.
Load `hyperframes-animation` for implementation.

## 1. Story first

Every video is a short argument. Before any scene exists, write the one
sentence the viewer should remember. Then pick a structure:

| Structure | Beats | Use for |
|---|---|---|
| Hook → Problem → Solution → Proof → CTA | 5 | product promos, ads |
| Question → Answer → How → Takeaway | 4 | explainers from docs/PDFs |
| Before → After → How | 3 | feature launches, redesigns |
| Stat → Context → Meaning | 3 | data stories, reports |
| Tease → Reveal → Sign-off | 3 | logo stings, teasers |

One idea per scene. If a scene needs two sentences of narration to explain,
it is two scenes.

## 2. Pacing by format

| Format | Length | Scene length | Hook must land by |
|---|---|---|---|
| Vertical social (9:16) | 6–30s | 1.5–3s | 1.5s |
| Square feed (1:1) | 10–30s | 2–4s | 2s |
| Landscape promo (16:9) | 20–60s | 3–6s | 3s |
| Explainer (16:9) | 45–120s | 4–8s | 5s |
| Logo sting | 3–6s | one continuous | — |

Text must stay on screen long enough to read twice: **~0.35s per word +
1s**, minimum 1.5s. Hold the final frame (CTA / logo) at least 2s, still.

## 3. Timing

| Move | Duration at 30fps |
|---|---|
| Micro accent (tick, underline, dot) | 0.15–0.3s |
| Element enter / exit | 0.4–0.7s |
| Headline reveal (per line) | 0.5–0.9s |
| Scene transition | 0.4–0.8s |
| Camera move / big spatial move | 0.8–1.6s |
| Number count-up | 0.8–1.5s |

Exits are ~70% of the matching entrance. Faster is almost always better than
slower; a video that feels slow is abandoned.

## 4. Easing

Pick **one** family per video and use it everywhere (brand-kit
`motion.easing` wins when set).

| Personality | Enter | Exit | Move |
|---|---|---|---|
| Calm / premium | `expo.out` / `cubic-bezier(0.16,1,0.3,1)` | `power2.in` | `power3.inOut` |
| Precise / technical | `power3.out` / `cubic-bezier(0.22,1,0.36,1)` | `power2.in` | `power2.inOut` |
| Bold / energetic | `back.out(1.4)` sparingly, `power4.out` | `power3.in` | `power4.inOut` |
| Playful | spring-like `elastic.out(1,0.6)` on 1–2 hero elements only | `back.in(1.2)` | `power2.inOut` |

Never `linear` except for constant motion (tickers, rotation, progress bars).
Never the bare default `ease`.

## 5. Choreography

- **Lead with the hero.** The most important element moves first; supporting
  elements follow 0.06–0.12s apart. Stagger ≤ 6 items; group the rest.
- **Shared direction.** Elements in one beat move the same way. Direction
  encodes meaning: forward/next = left→right or bottom→top.
- **Continuity across cuts.** Carry one element (a shape, color field, the
  product) from scene to scene — match cuts beat hard cuts beat crossfades.
- **Overlap beats.** Start the next scene's entrance before the current exit
  fully ends (0.1–0.2s overlap) so the video never "breathes out" to empty.
- **Rest.** After a big move, give the eye 0.3–0.6s of stillness.

## 6. Transitions

Choose by meaning, not variety. One primary transition type per video, plus at
most one accent type.

| Meaning | Transition |
|---|---|
| Same topic, next point | push / slide in the reading direction |
| Zoom into detail | scale-through / mask expand from the detail |
| New chapter | color-field wipe in brand primary |
| Time passing / contrast | hard cut on a beat |
| Ending | slow settle into the logo, no transition after it |

Never plain-crossfade two busy layouts: it makes a muddy double exposure.
Stagger it (old content out, then new content in) or dip through the
background. When the source is the user's own code, reuse its real
components, CSS, fonts and images in the composition instead of screenshots.

## 7. Anti-AI-slop checklist

Reject and fix any of these before QA:

- Everything fades up from 20px below with the same duration.
- Stagger on every list, including 2-item lists.
- Elements pop from `scale: 0` (start from 0.85–0.95 with opacity instead).
- Bouncy easing on serious or premium brands.
- Constant pulsing glows, floating blobs, or gradient orbs with no meaning.
- Text that animates letter-by-letter for body copy (headlines only, rarely).
- Gratuitous 3D tilts on flat UI screenshots.
- A different transition between every scene.
- Stock phrases on screen: "Unlock", "Seamless", "Revolutionize", "Elevate".
- Emoji as icons; generic line icons that do not match the brand.
- Music that starts at full volume under a voiceover.
- Ending on a transition instead of a held, readable frame.
- The default "AI video": centered headline on a gradient, everything fading
  in, logo at the end. If a frame could belong to any product, redo it.
- Particle bursts, lens flares, light leaks or glows used as decoration.
- Numbered scene labels ("01 / 02 / 03"), corner labels or fake UI chrome
  sprinkled in as decoration, or "scroll to explore" text that means
  nothing in a video. (As a consistent framing system from the chosen look,
  like a broadcast frame, they are fine.)
- Opus 5.5's named defaults: cream/off-white backgrounds, an italic serif
  accent word in a sans headline, monospace labels everywhere, pill-shaped
  buttons and tags (`visual-toolkit` § 5), unless the chosen look uses
  them on purpose.
- A generic headline font (Inter, Space Grotesk, Geist, Montserrat…) because
  the website used it (`type-system` § 4).
- A whole video with no signature moment: every scene is type + fade on a
  flat background (`visual-toolkit` § 2).
- Dead time: any stretch > 0.8s where nothing moves and nothing is being
  read (holds for reading and the end card are fine).
- Redrawn or illustrated versions of a product whose real UI you have.
- Cuts that ignore the music grid; SFX on every single event.
- Three or more type sizes, or more than one accent color, in one frame.

## 8. Using real product imagery

When the source is a website or app, **show the real thing**: captured
screenshots or recordings, cropped to the part that matters, with a
highlight (mask, spotlight, cursor) guiding the eye. A zoom into the real UI
beats any illustration of it.

## 9. Director Notes (how revisions are given and applied)

Translate every piece of feedback — the user's, or your own critique — into
notes that are **scoped, measurable and reversible**, one scene at a time:

| Vague | Director Note |
|---|---|
| "feels slow" | "Scene 3: cut from 6 to 4 beats; every zoom 0.7× duration" |
| "make it pop" | "Reveal: add impact on the downbeat at 12.0s; scale 0.92→1 with expo.out 0.6s" |
| "text is hard to read" | "All scenes: body ≥ 4.5% frame height; hold each line ≥ 0.35s/word + 1s" |
| "ending is weak" | "End card: land on bar 15 downbeat, sting, hold 2s still" |
| "too busy" | "Scene 2: remove the background orbs; one moving element at a time" |

Apply notes by editing only the named scene(s), re-snapshot only those frames,
and show a before/after pair from the same timestamps. Keep a running list in
`REVIEW.md` so no note is lost between rounds.
