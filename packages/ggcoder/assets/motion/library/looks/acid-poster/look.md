# Acid Poster

A fly-posted gig poster that won't sit still. Two colors only — acid lime
and black — and one typeface, **Anybody**, pushed to both ends of its width
axis: 150% wide slabs against 50% condensed columns. Type runs edge to edge,
black bands carry running tickers, and every beat lands with a hard
inverting cut. Loud on purpose; precise underneath.

## Palette

- `--field` #d4ff00 acid lime, `--ink` #0a0a0a (17:1). `--accent` equals
  ink: emphasis is made with size, width and inversion, never a third color.
- `--field-2` #0a0a0a: the inverted frame (lime type on black). Cut to it on
  a beat for 2–12 frames, or hold a whole scene inverted.
- `--line` is 90% ink: rules here are 8px thick, never hairlines. `--muted`
  is rarely used; this look doesn't whisper.
- Swap pair per brand only if both stay extreme: hot pink #ff2e88 / black,
  safety orange #ff5a00 / black. Never pastel, never gradients.

## Type

- Wide slab: Anybody 900, `font-stretch: 150%`, tracking −0.04em,
  line-height 0.78, 280–340px, one word per line, sized so the word spans
  the full width inside a 40px margin.
- Condensed column: Anybody 900, `font-stretch: 50%`, tracking 0 (never
  negative at 50%: counters close up), 360–440px.
- Pair the two in one frame: that width contrast is the look.
- Info type: Anybody 800 at 100%, 36–48px, uppercase for credits and URLs,
  sentence case for the one sentence of copy.
- Tickers: Anybody 900 at 62%, 72–80px, uppercase, separated by ✱.
- Martian Mono is not used in frame. No lowercase display words.

## Background and framing

- Flat lime. No texture, no light, no shadows, no rounded corners.
- Two 104px black bands (top and bottom) with tickers moving in opposite
  directions, linear, the whole scene long.
- A full-width 8px rule with a three-part credit line (left / center /
  right) sits above the bottom band.
- Information goes in solid black blocks (lime type inside), flush to the
  right margin, top-aligned to a display line.
- Arrows are thick (stroke ~14% of their box), square-capped, pointing down
  and right.

## Motion

- Fast and on the beat (plan 120 bpm = 0.5s beats). Words slam in with
  `expo.out` 0.4–0.5s from far off-frame (x ±1400 or xPercent −40).
- Width morph: the wide word opens from 50% to 150% width with
  `expo.inOut` 0.9s (tween a proxy, write `style.fontStretch` in
  `onUpdate`).
- Info blocks rise from below their own box (`yPercent` 110 → 0) `expo.out`
  0.45s. Rules wipe via `clip-path` inset, `expo.inOut` 0.5s.
- Punch: on a downbeat, one frame of `--field-2` (flash overlay at opacity 1
  for 0.01s → 0), and the hero word re-lands from scale 1.08 with
  `expo.out` 0.5s. Arrows pop with `back.out(2.5)` 0.35s.
- Tickers never stop; everything else holds still between beats. Holds are
  short (0.8–1.5s). Scenes change by hard cut or full inversion, never a
  fade.

## Avoid

- A third color, gradients, glow, grain, drop shadows.
- Soft eases (`sine`, `power1`), fades, slow reveals.
- Negative tracking on condensed widths; words clipped by the frame edge
  (bleed is fine for a ticker, not for the hero word).
- Pill buttons, rounded stickers, emoji.
- Small type floating in empty lime: every element is anchored to a margin,
  a rule or a band.

## Scene recipes

1. **Drop poster:** tickers top and bottom, wide word full-width, condensed
   line under it, black date block right, credit rule; the wide word morphs
   50 → 150% on the first beat, second line slams from the right on the
   second.
2. **Countdown:** inverted field. A single condensed 50% number at 900px
   fills the height; each beat hard-cuts to the next number (3, 2, 1) with a
   one-frame lime flash between them.
3. **Word stack:** four wide 150% words stacked edge to edge (≈210px each),
   each line entering from alternating sides on successive beats with
   `expo.out` 0.4s; the last line inverts (lime on a black bar).
