# Terminal Phosphor

A phosphor CRT in a dark room. Near-black glass, green phosphor type with a
soft bloom, fine scanlines and a curved-glass vignette. Commands type out
character by character; results land as huge **Doto** dot-matrix readouts.
**Amber** is the one alert: the win, the warning, the number you want
remembered. Everything feels like it is being printed by a machine, live.

## Palette

- `--field` #050805 (green-black glass), `--field-2` #0a110b for a second
  "window" or a split pane.
- `--ink` #8dff9a phosphor green (16:1 on field). Commands, check marks and
  readouts are full ink; program output is `--muted` (56%).
- `--accent` #ffb338 amber, one line per scene (▲ improvement, ! warning).
  An amber-only variant is valid: set `--ink` to #ffb338 and `--accent` to
  #8dff9a, never both at full weight in equal amounts.
- Bloom: `text-shadow: 0 0 6px ink@55%, 0 0 22px ink@22%` on all type,
  `0 0 12px @70%, 0 0 60px @35%` on the Doto readout.

## Type

- Readouts: Doto 900, `"ROND" 100` (round dots), 300–380px, tracking −0.02em.
  Integers only (Doto's decimal point and punctuation look like crosses at
  display sizes): show 840 ms, not 0.84 s. Unit in Doto at 60% size, muted.
- Everything else: Martian Mono 400, 26–32px, line-height 1.8. The prompt
  line is full ink; output lines are muted with an ink ✓.
- Column-aligned output: pad values with spaces so numbers right-align, as
  a real CLI would.
- No proportional fonts anywhere. No uppercase except in real command
  output.

## Background and framing

- Center screen glow: a radial at 7% ink, 1300×900px.
- Scanlines: `repeating-linear-gradient(180deg, transparent 0 2px,
  rgba(0,0,0,.34) 2px 4px)` over everything, including type.
- Curved-glass vignette: radial to 85% black at the corners.
- Layout like a real terminal: text flush-left at x=140, top at y=128.
  Readouts bottom-left, supporting stats to their right on the same
  baseline region. No windows chrome, no fake macOS title bar.

## Motion

- Typing: width from `0ch` to `Nch` with `ease: "steps(N)"` — 30–40 chars
  per second for the human-typed prompt, a single fast 0.16s sweep per
  output line (machines print, humans type). Lines land 0.2–0.25s apart.
- Numbers: count with `steps(20)` so they tick, not glide.
- Readout lands with a CRT flicker: opacity 0.2 ↔ 1, 0.06s, `repeat: 4`,
  `yoyo` (even repeat count so it ends lit).
- Progress bars are block characters (█ ░) rebuilt from the tween's
  `onUpdate`, `steps(20)`.
- Cursor blink is a finite `repeat` on the timeline, never a CSS
  `infinite` animation.
- Transitions: a hard cut to black for 2 frames, or `clear` — all lines drop
  out at once and the prompt starts again at the top. No crossfades.

## Avoid

- Proportional fonts, rounded windows, macOS traffic lights.
- Matrix rain, glitch RGB split, heavy chromatic aberration.
- More than one amber line per scene; green and amber in equal amounts.
- Smooth `power` eases on type or numbers: everything steps.
- Decimal points in the Doto readout.

## Scene recipes

1. **Deploy run:** prompt types, four output lines print, the total time
   ticks up in a huge Doto readout, amber improvement line and a block
   progress bar beside it.
2. **Benchmark duel:** two Doto readouts stacked (ours ink, theirs muted),
   each with a block bar under it filling at their real ratio; the amber
   line "▲ 3.1× faster" prints last.
3. **Changelog scroll:** a `git log --oneline` list prints line by line,
   then the whole block scrolls up in `steps(12)` as new lines arrive; one
   line highlights in amber and its hash becomes the next scene's Doto
   readout.
