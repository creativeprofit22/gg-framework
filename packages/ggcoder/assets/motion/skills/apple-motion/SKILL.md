---
name: apple-motion
description: Apple-grade motion and visual restraint for videos — Human Interface Guidelines motion principles (purposeful, brief, physically plausible, interruptible feel), typography-led layouts, depth and Liquid Glass-style materials, and keynote-style product reveals, adapted from UI to video. Use when the user asks for an Apple-style, premium, minimal, keynote or product-reveal look, or when a video feels busy and needs restraint.
---

# Apple-grade motion for video

Apple's Human Interface Guidelines describe motion for interfaces. This skill
adapts those principles to rendered video. Combine it with `motion-direction`
(timing tables) and `hyperframes-animation` (implementation).

## Principles → video rules

| HIG principle | In a video |
|---|---|
| Motion is purposeful, never gratuitous | Every move reveals, connects or explains. If removing a move loses nothing, remove it. |
| Feedback is brief and precise | One primary motion per beat, 0.4–0.7s. No move longer than it needs to be. |
| Realistic, physical behaviour | Spring-like deceleration (`expo.out`, `cubic-bezier(0.16,1,0.3,1)`); objects keep momentum and leave the way they arrived. No bounce on serious content. |
| Don't rely on motion alone | The key message is also on screen as text or caption; the story works with the sound off. |
| Consistency | One easing family, one transition type, one type ramp across the video. |
| Respect the content | UI and product are the hero; chrome, backgrounds and effects stay quiet. |

## Visual language

- **Typography-led.** One idea per frame in a large, confident headline
  (SF Pro Display–like: tight tracking −0.02 to −0.04em on display sizes,
  weight 600–700). Use the brand's display font; if none, a restrained
  pick from `type-system` (Host Grotesk or Mona Sans at normal width).
- **Space.** Leave 40–60% of the frame empty. Center or strong left-align;
  nothing crammed to edges (≥ 6% safe margin).
- **Palette.** Near-black (`#000`–`#111`) or near-white (`#f5f5f7`)
  grounds, one accent. Gradients only as soft light, never as decoration.
- **Depth.** Layered planes: background → content → foreground glass. Soft,
  large, low-opacity shadows; subtle parallax (foreground moves 1.2–1.5×
  background) on camera moves.
- **Materials (Liquid Glass–style).** Translucent panels with backdrop blur
  (20–40px), a 1px inner highlight at ~20% white, faint refraction of what
  is behind. Use for overlays and callouts, not for everything.
- **Light.** A slow specular sweep across a product or glass edge
  (1.2–2s, once) sells material; never loop it.

## Signature moves

1. **The reveal.** Product enters from darkness or blur: opacity 0→1 with
   blur 20px→0 and scale 1.04→1 over 0.9–1.2s, `expo.out`.
2. **The push-in.** Slow camera dolly toward the hero (scale 1→1.06 over
   the whole scene) so still frames never feel static.
3. **Feature callout.** Real UI screenshot; the relevant region stays sharp
   while the rest dims to ~35% and blurs slightly; a short label fades in
   beside it.
4. **Word-by-word headline.** For the single most important line only: words
   rise 12–16px with opacity, 0.08s apart.
5. **Hard cut to black, then the logo.** End on the logo alone, centered,
   held ≥ 2s, no motion in the last second.

## Don'ts

- No bouncy, elastic or overshooting motion on premium brands.
- No spinning, flipping or 3D card flips.
- No more than two type sizes on a frame.
- No busy particle fields, lens flares, or glitch effects.
- No stock "tech" backgrounds (circuit lines, hex grids, floating code).
- Never imitate Apple's own trademarks, product imagery or SF Pro font files
  unless the user supplies them and has the right to use them.

## Accessibility carried into video

- Contrast: text ≥ 4.5:1 against its actual background at every frame
  (`hf check` measures this).
- Avoid full-frame flashes brighter than 3 per second.
- Captions for any spoken audio.
