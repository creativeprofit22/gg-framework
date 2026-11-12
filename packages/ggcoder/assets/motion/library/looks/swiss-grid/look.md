# Swiss Grid

International Typographic Style, moving. A white **field**, black **ink** and
one signal-red **accent** on a strict 12-column grid that stays faintly
visible. Numbers are the heroes and are set enormous; text is flush-left,
ragged-right and aligned to column edges to the pixel. Objectivity is the
aesthetic: no decoration that isn't structure.

## Palette

- `--field` pure #ffffff, `--ink` #0b0b0b (20:1). `--accent` #e8261c signal
  red, used on at most two things per frame: the unit/percent of the hero
  number and one bar/rule/block. Red is never used for body text below 40px.
- `--field-2` is the red itself: a scene can cut to a full red field with
  white type (white on #e8261c is 4.6:1, so only 120px+ display type there).
- `--line` (12% ink) draws the column edges; `--muted` (58%) for secondary
  header text and axis labels.

## Grid

- 1920×1080: 96px outer margins, 12 columns of 122px, 24px gutters. Column n
  starts at `96 + 146 × (n − 1)`. Every left edge of every element sits on a
  column start; nothing is centered.
- Top: a 3px ink rule across all 12 columns at y=96, with a header row under
  it (24px, two lines each) at columns 1, 5 and 9.
- Bottom baseline at y=984. The hero number and the last row of any chart
  share this baseline.
- Leave the column hairlines visible at 12% the whole video: the grid is
  part of the picture.

## Type

- Display: Schibsted Grotesk 800, tracking −0.055em. Hero numbers 600–780px
  with line-height 0.74 so they sit on the baseline; the unit (%, ×, k) in
  red at one third of the size, top-aligned to the cap height.
- Statements: Schibsted Grotesk 700, 56–68px, line-height 1.02, tracking
  −0.035em, 3–4 lines max, each line a deliberate break (no auto-wrap).
- Header and labels: Schibsted 500/700 at 22–26px, sentence case, never
  uppercase-tracked, never mono. Martian Mono is only for raw data tables.

## Background and framing

- Flat white. No texture, no light falloff, no shadow, no rounded corners.
- The only graphic devices: rules (3px ink, 18px red), solid bars, and the
  grid. Charts are horizontal bars with the year label in column 9 and bars
  starting on column 10.

## Motion

- Mechanical and exact. Grid columns grow in top → down (`scaleY`,
  `power4.inOut` 0.9s, stagger 0.04s) and the top rule wipes left → right
  (`power4.inOut` 0.8s) before content arrives.
- Numbers: count up with `power4.out` 1.4s while rising 18% into place.
- Text lines: masked line reveals (`yPercent` 105 → 0, `power4.out` 0.7s,
  stagger 0.08s). Bars grow from their left edge (`power4.inOut` 0.7s,
  stagger 0.1s), values snap on without fading.
- Hold 1.5s. Transitions are hard cuts on the beat, or a red block wiping the
  full frame on a column-by-column stagger (12 bars, `power4.inOut` 0.5s,
  stagger 0.03s) into the next scene.

## Avoid

- Centered compositions, drop shadows, rounded corners, gradients.
- More than one accent color; red body text; red and black bars of equal
  weight.
- Mono labels, uppercase letterspaced captions, "01/02/03" decorative
  numbering.
- Elements that sit between columns; ragged spacing between rows.
- Springy or elastic eases.

## Scene recipes

1. **Stat slam:** hero number in columns 1–7 on the baseline, red unit,
   statement in columns 9–12 under an 18px red block, bar chart below it
   ending on the baseline.
2. **Red cut:** field flips to `--field-2` red; one 3-line statement in white
   Schibsted 800 at 150px in columns 1–10, top-left aligned at y=240; the
   column hairlines stay (white at 20%).
3. **Comparison table:** four rows spanning columns 1–12, each row a 3px
   top rule, name in columns 1–4 (56px 700), value in columns 9–12 right
   of a bar; rows reveal on a 0.12s stagger, the winning row in red.
