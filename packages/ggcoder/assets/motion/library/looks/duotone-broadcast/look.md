# Duotone Broadcast

Two colors do everything: a saturated **field** and a dark **ink**. Every
element is ink on field (or field on ink after a flip). No third accent, no
gradients as decoration.

## Palette

- `--field` saturated mid-tone (terracotta, cobalt, acid green, signal red);
  `--ink` near-black navy or deep brown with enough contrast (≥ 7:1).
- Scene changes flip the whole frame: field ↔ ink (`--field-2` is the ink
  color used as a background). A flip is a hard cut or a fast wipe on the
  downbeat, never a crossfade.
- Swap the pair per brand: keep one saturated + one very dark.

## Type

- One huge display word per scene (Archivo 880 at 88% width, or Big
  Shoulders 900). 200–320px, tracking −0.035em, tight line-height.
- Everything else is Martian Mono labels, 20–24px, uppercase, +0.06em.
- Nothing in between: the contrast between huge and tiny is the look.

## Background and framing

- Faint dot grid (`dot-grid-field`) plus a soft top-left light falloff so the
  flat color reads as a lit surface.
- Broadcast frame (`broadcast-frame`): four corner labels (section, timecode,
  counter, spec), crop marks at the edges, one underline under the section
  label. The labels change per scene; the frame stays.
- The graphic *is* the content: a curve, a counter, a diagram that
  demonstrates the word. No decorative blobs.

## Motion

- Words: masked rise (100% → 0) with `expo.out` 0.8–0.9s, plus a width
  morph (62% → 88%) over 1.2s.
- Diagrams draw themselves linearly over 1.5–2s with a live readout.
- Labels update on cuts, not animated in.
- Hold each composed frame 1.2s+ before the next move.

## Avoid

- More than two colors. Glows, gradients, glass, 3D.
- Mono on the headline. Mixed-case display words.
- Moving the frame labels.

## Scene recipes

1. **Concept card:** word left, live diagram right, labels in corners.
2. **Stat slam:** one number fills the frame (Big Shoulders 900, 420px),
   counter label bottom-left, field flips to ink on the next beat.
3. **List beat:** three words stacked, each rising on successive beats,
   the current one full ink, previous ones at `--muted`.
