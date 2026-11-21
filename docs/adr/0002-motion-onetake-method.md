# ADR 0002: GG Motion adopts the onetake production method, rebuilt clean-room

**Status:** Accepted, 2026-10-03. The planning file, beat sheet, flow/look
reports and `motion_check` are superseded by
[ADR 0003](0003-motion-build-render-once.md); the clean-room rules below still
apply.

## Context

GG Motion's own designs were strong frame by frame, but too many read as
slideshows: scenes swapped instead of growing out of each other, every shot
lasted about as long as the last, and the frame never rested. The open-source
`onetake` skill (by feitangyuan) documents a production method that fixes
exactly this, with ten worked films as evidence: study a reference, pitch
ideas, write a beat sheet that names what carries each scene into the next,
rebuild the product's real screens, animate with a kit of tested moves and an
operated camera, render with motion blur, score sound from on-screen events
and check rhythm and flow before showing the user.

onetake is licensed under PolyForm Noncommercial 1.0.0. GG is a commercial
product, so its files (code, prose, tuned numbers, looks, sound packs and
films) cannot ship in GG. A method, the steps, rules and what to measure, is
not covered by copyright and is free to use.

## Decision

GG Motion runs the same method, rebuilt clean-room on GG's own engine
(HyperFrames, GSAP and Node with bundled ffmpeg), not ported from onetake's
Python and canvas stack:

- Six **job skills** (`launch-video`, `app-walkthrough`, `website-video`,
  `before-after`, `dev-tool-video`, `match-reference`) each run the method with
  that job's own questions, behind plain starter buttons.
- An **idea pitch** joins the single upfront question card; nothing adds a
  new stop for the user.
- `frame.md` gains a **beat sheet** (`Beats`, `Bursts`, `keepInFrame`); rests
  reuse the existing hold plan.
- A **move kit** (`library/kit/moves.js`) and new library pieces, written from
  scratch on GSAP and GG's own spring maths.
- A motion-blur render step, event-driven sound with one shared room, and a
  `reference-study.mjs` measuring tool, all using bundled ffmpeg.
- A **flow report** in `motion_check`: uneven rhythm, real rests, carried
  boundaries, blur on fast motion and subjects kept in frame.
- The same standard for **look and sound**, in GG's own values: sounds built
  from materials (damped partials and a contact transient), placed in the
  stereo field and room by the picture, camera air from the kit camera's
  speed, a balance report against the music, and a resolving ending. A
  **look report** (`bin/look-check.mjs`) beside `flow` measures accents,
  quiet ground, the family of frames and typefaces. onetake's own looks,
  palettes, font choices and sound tuning are not used. Its published films
  were measured only as a sanity comparison for the look report; the
  report's thresholds were set on GG's own looks and renders.

Nothing is copied or ported line by line. Thresholds are tuned on GG's own test
renders, not on onetake's films. Nothing under `assets/motion` names the
upstream project or its licence; a provenance test enforces this.

The flow and look reports return **craft findings** in separate `flow` and
`look` fields. They never change the technical pass/fail or the review gate.
The agent fixes each finding or records a deliberate exception in `frame.md`.
The check stays a technical check, not a creative score (see ADR 0001 and
`CONTEXT.md`).

## Rejected alternatives

- **Vendoring or porting onetake's code.** Not allowed for commercial use.
- **Keeping the method as prose only.** The upstream evidence shows rhythm and
  carry problems are invisible until measured; without the flow report the
  rules drift.
- **Making flow findings fail the check.** Good videos can break a rule on
  purpose. Findings with recorded exceptions keep the agent honest without
  nagging.
- **Motion blur from 60 fps pairs.** Averaging two 60 fps frames into one
  30 fps frame left a hard double image on fast moves, worse than no blur.
  The blur step (`bin/motion-blur.mjs`) instead renders at up to 240 fps, which
  HyperFrames supports natively (8 sub-frames per frame at 30 fps, 4 at 60), and
  averages them with ffmpeg `tmix` over a 180° shutter. A time-stretch
  variable was not needed: the composition renders unchanged. On an 8 s
  camera-whip test it took 34 s to render and 1.5 s to blend, against 6–8 s for
  a plain render.
- **Reading sound events from HyperFrames' keyframe listing.** `hf keyframes`
  misses tweens a helper function adds, which is how the move kit builds
  everything. The kit instead records `kit.cue(tl, at, sfx)` marks, maps them
  through nested timelines to root time, and `bin/cues.mjs` reads them from the
  page in HyperFrames' own Chrome for `score-synth`.
- **Mean picture change as the reference study's stillness test.** A
  talking-head inset moving in one corner averaged out to "still" (97% of a GG
  explainer). The study counts visibly changed pixels on the flow grid instead
  (56% on the same video).

## Open option

A commercial licence can be requested from the author. If granted, GG may
align its tuning with the upstream numbers; until then, GG's own renders set
them.
