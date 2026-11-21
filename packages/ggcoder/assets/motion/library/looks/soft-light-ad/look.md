# Soft Light Ad

A calm, premium product ad. Light, air and one brand blue. Every frame has
one soft 3D subject, one short lowercase sentence, and a lot of space.

## Palette

- `--field` cool near-white (#eef1f7-ish), never pure white and never cream.
- `--field-2` a deep saturated brand color used only as the light pool at
  one edge of the frame (and for the far haze in 3D scenes).
- `--accent` the same brand hue, brighter: the 3D object, title bars, the
  one highlighted word in each caption.
- `--ink` a soft slate (#3a4150), not black. Everything else is white UI
  with soft grey skeleton lines.
- A single warm note is allowed in 3D skies (a peach haze at the top) and
  one small yellow detail per scene (a dot, a tile) as a spark.

## Type

- Captions are one short lowercase sentence, Host Grotesk 500, 54–64px,
  tracking −0.02em, centred above the subject, with one or two words in
  `--accent`. Typed on (`typewriter-caption`), never slammed.
- No headlines, no uppercase, no mono labels on screen. The product name
  appears once, on the end card.

## Background and framing

- `soft-light-field`: white hotspot behind the subject, the deep pool
  rolling in from one edge. Alternate the pool's side between scenes.
- 3D scenes (`clay-drop-3d`) use a hazy horizon with blurred mountains:
  the same airy palette in depth.
- Subjects sit slightly below centre with a soft floor shadow. Back layers
  are blurred (depth of field), never sharp.

## Motion

- Everything is smooth and continuous: `expo.out` arrivals over 1.2–1.4s,
  `power2.out` camera drifts across the whole scene, holds of 1.5s+.
- One gentle hero beat per scene (a card lifting toward the camera, an
  object dropping into water), never more.
- Scene changes: the camera keeps moving through the cut, or the subject
  morphs into the next (windows collapse into the laptop screen, the clay
  object becomes the app icon). No hard cuts, no flashes, no wipes.
- Captions start typing ~0.3s into a scene and finish before the hero
  beat.

## Avoid

- Dark backgrounds, neon, glows, gradients as decoration.
- Detailed or realistic 3D. Keep forms simple, rounded, soft-shadowed.
- Real screenshots at full sharpness in this look: use the illustrative
  `ui-stack-3d` windows, or put the real UI inside them.
- More than one accent word per caption.

## Scene recipes

1. **Promise:** `soft-light-field` + `typewriter-caption` ("a good *deal*
   should not take all day") + `ui-stack-3d` fanning out below.
2. **Moment:** `clay-drop-3d` alone, no caption, 3–4s: the pause that makes
   the ad feel expensive.
3. **Together:** `soft-light-field` (pool on the other side) + caption
   ("flights and hotels, *together*") + `ui-stack-3d` with the inner card
   lifting on the beat, then the end card.
