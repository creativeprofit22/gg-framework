# Editorial Ink

A documentary title sequence printed in ink. A deep bottle-green **field**
(or oxblood on `--field-2`) with grain and a heavy vignette, **bone** type,
and one lamplight **ochre accent**. Titles are Fraunces with its soft,
slightly wonky display cut; people speak in Newsreader italic. The pace is
patient: the look earns trust by not hurrying.

## Palette

- `--field` #0f2a24 bottle green; `--field-2` #3a1318 oxblood for a second
  chapter or a darker, more intimate beat. Never cream, never paper white:
  the page is dark.
- `--ink` #ece4d4 bone (11.7:1 on the green, 12:1 on oxblood). Titles,
  quotes and line illustrations are all bone.
- `--accent` #e3a857 ochre = lamplight. One use per scene: the chapter
  marker, a short rule, a single glowing point (a lamp, a window, a pin on a
  map). Never on a title.
- `--muted` (64% bone) for attributions and captions; `--line` (20%) for
  frames and horizon lines.

## Type

- Titles: Fraunces 300–360, `font-variation-settings: "opsz" 144, "SOFT"
  100, "WONK" 1`, 130–170px, line-height 0.98, tracking −0.025em. Sentence
  case, no full stop, two lines with a meaningful break. The whole title is
  serif; never mix it into a sans headline.
- Voices: Newsreader italic 340–380, opsz 48, 44–56px, line-height 1.16, in
  real curly quotes, broken by hand into 2–3 lines. Attribution Newsreader
  roman 24–28px: name at 560 in ink, role in `--muted`.
- Chapter markers: Newsreader all-small-caps, 28–32px, +0.08em, in accent.
- Martian Mono only for archival data (dates on a map, coordinates), 18px,
  never as frame decoration.

## Background and framing

- Two stacked radials: a warm ochre spill (10%) from the upper-left, and a
  vignette to 55% black at the corners. Over everything, SVG
  `feTurbulence` grain (fractalNoise, baseFrequency 0.9, fixed `seed`) at
  14–18% opacity with `mix-blend-mode: overlay`.
- Generous margins: 150px left, text column max 960px. Images and
  illustrations sit in a porthole (circle) or a 4:5 plate with a 2px bone
  rule at 55%, placed on the right third.
- Illustrations are single-weight 2px bone line drawings that draw
  themselves; the one light source in them is the accent.

## Motion

- Slow and continuous. Title lines rise out of line masks (`yPercent` 100 →
  0, `power3.out` 1.4s, stagger 0.18s). Chapter markers and captions only
  fade (`sine.inOut` 1.0s).
- Quotes breathe in: opacity + y 16 + blur 6px → 0, `power2.out` 1.4s.
- Line illustrations draw with `sine.inOut` 1.8s, stagger 0.12s. Ambient
  movement (a sweeping beam, drifting water lines) runs the whole scene on
  `sine.inOut` so the frame is never fully still.
- Holds: 2.5s+ after the last element lands; the viewer reads a quote twice.
- Transitions: dissolve through the field (0.8s), or a 1.2s cross-dissolve
  between green and oxblood for a chapter change. No wipes, no slides, no
  scale punches.

## Avoid

- Cream, beige or paper-white backgrounds (the banned AI default).
- Italic serif accent words inside sans headlines.
- Bright saturated accents, more than one accent, glowing text.
- Fast eases (`expo`, `back`), bouncy type, kinetic typography.
- Mono labels in the corners, timecodes, "01/02/03" markers.

## Scene recipes

1. **Title card:** chapter marker in accent, two-line Fraunces title left,
   a 96px ochre rule, then the voice quote and attribution; line-drawn
   porthole illustration on the right third with one moving light.
2. **The voice:** oxblood field, only a quote, Newsreader italic at 72px,
   centered vertically on the left two-thirds, attribution fading in 1s
   after; a 2px bone rule grows left → right under it over the whole hold.
3. **Place and date:** a line-drawn coastline or street map in bone draws
   over 2.5s; one ochre point pulses once (scale 1 → 1.6 → 1, `sine.inOut`
   1.2s); Fraunces 96px place name bottom-left, Martian Mono 18px coordinates
   under it in `--muted`.
