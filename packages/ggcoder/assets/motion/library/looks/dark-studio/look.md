# Dark Studio

A product photographed on a black set. One soft **key light** from above,
everything else falls off to near-black. The product (UI, device, card) is
the only lit object; type is calm, wide and quiet. One cool **accent** marks
the single number or state that matters. Think Apple and Linear dark
keynote launches: confidence through restraint.

## Palette

- `--field` #08090b is not pure black: it lets the light falloff and the
  shadows under the slab read. `--field-2` #121418 is the "lights up" set
  for a second scene (a brighter floor, same camera).
- `--ink` #f3f5f8 (18:1 on field). Headlines get a vertical ink → #9aa3ae
  gradient clip so they look lit from above; body text is flat ink.
- `--accent` #7cc7ff ice blue, used on **one thing per scene**: the live
  chart line, the active nav item, the status dots. Never on headlines, never
  as a background fill larger than a nav item.
- `--muted` for secondary UI text, `--line` (10% ink) for hairlines inside
  the UI. Swap the accent per brand (mint #6ff0c4, amber #ffb35c), but keep
  it cool-to-neutral and at most one.

## Type

- Display: Mona Sans 620, width 108%, tracking −0.045em. Headlines 104–128px
  centered, max two lines, max six words, sentence case with a full stop.
- Eyebrow above the headline: Mona Sans 560 at 110% width, 28–32px, in
  `--accent`. That is the only colored type.
- In-product numbers: Mona Sans 560, 112% width, 96–140px, tabular numerals,
  unit in `--muted` at 40% of the size.
- UI text 18–22px Mona Sans 500. Martian Mono only for timestamps and IDs
  inside the UI, 16–18px, never as a label on the frame.

## Background and framing

- Key light: a radial ellipse (≈900×620px) at 50% −8%, 20% cool white,
  falling to zero by 80%. A second faint accent-tinted ellipse under the
  floor line bounces light back up.
- A single hairline "floor" at y≈900 fading out at both ends.
- The product sits on a glass slab: `--radius` 28px, vertical 34→16 gray
  gradient, 1px inner top highlight (22% white) as the metal rim, a 7% inner
  outline, and a long 120px black drop shadow. Beneath it, an accent glow
  ellipse blurred 30px is the floor reflection.
- Camera: perspective 2200px, slab tilted rotateX 10–16° from its bottom
  edge, centered, occupying 60–70% of the frame width. No full-bleed
  screenshots, no device frames with notches.

## Motion

- Lights first: key light fades up 1.2–1.4s `power2.inOut` before anything
  else lands.
- Headline words: blur-rise (y 44 → 0, blur 16px → 0, opacity) `power3.out`
  1.1s, stagger 0.07s.
- Product: rises from y 260 and rotateX 42° → 14° with `expo.out` over
  1.8s. It settles; it never bounces.
- Inside the UI: data lines draw with `power2.inOut` 1.2–1.4s while the
  number counts toward its value on the same tween length. End dot pops with
  `back.out(2)` 0.5s — the only overshoot in the look.
- One specular sheen crosses the slab (`power1.inOut` 1.4s) after the data
  lands, as the "shine" beat.
- Holds: 1.5s minimum on a composed frame. Scene transitions are slow camera
  pushes (scale 1 → 1.06 over the whole scene) and fades through black
  (0.4s out, 0.4s in), never slides or wipes.

## Avoid

- Purple/blue gradient backgrounds, gradient orbs, neon glows on type.
- More than one accent color; accent on headlines.
- Bouncy eases on the product, spinning 3D, glassmorphism blur panels
  floating everywhere.
- Mono labels framing the shot; the frame is empty black.
- Pure #000 field (kills the light falloff) and pure white slabs.

## Scene recipes

1. **Reveal:** eyebrow + two-line headline at top center, product slab
   rises into the lower 60% with its reflection; the key metric counts up
   while its chart draws; sheen passes; hold.
2. **Detail push:** field-2 set. Camera pushes into one card of the UI
   (scale 1 → 2.2 on the slab, transform-origin on the card, `expo.inOut`
   1.6s); the card's accent state toggles; a 56px caption fades in bottom
   center.
3. **Spec line-up:** three large numbers in a row (Mona Sans 560, 120px), each
   with a 22px muted caption, lit by the same key light; they blur-rise with
   0.12s stagger and the key light slides left → right across them over 3s.
