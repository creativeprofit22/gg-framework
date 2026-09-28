---
name: reference-style
description: Turn a reference the user likes — a video file, screenshots, a website, a brand's launch film, a painting or mood images — into a concrete STYLE.md (pacing, cut rhythm, type scale, palette logic, camera and transition grammar, texture, sound feel) the video is built and checked against. Use whenever the user says "like this", "in the style of", names a brand or video to match, or shares reference material.
---

# Reference style

A named, analysed reference is the strongest single input to a video. "Match
the cut rhythm and type scale of this" beats any list of adjectives. Take the
**grammar** of a reference, never its content.

## 1. Get the reference as material

| Reference | How |
|---|---|
| Video file the user provides | Extract frames: `ffmpeg -i ref.mp4 -vf "fps=2,scale=640:-2" sources/ref/f-%04d.png` (1 frame / 0.5s). Also detect cuts: `ffmpeg -i ref.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null - 2>&1 \| grep pts_time` |
| Link to a video on a platform (YouTube, X, Vimeo) | Ask the user for the file or a few screenshots; don't download platform videos yourself. |
| Website | `hf capture <url> -o sources/ref-site` (or `screenshot`) |
| Images / paintings / mood board | Copy into `sources/ref/` |
| Only a name ("like Linear's launch video") | Describe what that style is known for from your knowledge, say it is from memory, and ask for a file or link to confirm before relying on details. |

Then make **one** contact sheet to study (one image read, not dozens):
`<node> "<motion bin>/contact-sheet.mjs" sources/ref sources/ref-sheet.jpg --cols 6`

## 2. Analyse — write `STYLE.md`

Measure, don't guess, wherever the material allows:

```markdown
# Style — <reference name>

Source: <file/url>, analysed <date>. Take: grammar. Never copy: content, characters, logos, footage.

## Pacing
- Average shot length: 1.4s (N cuts in M seconds); fastest 0.5s, longest hold 3s (end card)
- Cuts land on: beats / phrase ends / action
- Energy arc: hook 0–2s, build, one big reveal at ~60%, calm end card

## Composition
- Grid / framing: centered hero vs asymmetric; margins; negative space %
- Depth: flat / layered parallax / 3D

## Type
- Families (closest open-license match if proprietary), weights, scale ratio
- Line length, case, tracking; how text enters (mask, per-word, per-line)

## Color
- Palette logic: dark ground + one accent / duotone / full brand color fields
- How color changes across the film

## Motion & camera
- Easing feel (snappy / soft / springy), typical durations
- Camera: push-ins, whip pans, match cuts, zoom-throughs
- Transition grammar: which transitions, how often

## Texture & finish
- Grain, blur, glow, shadows, glass, noise — or clean

## Sound feel
- Tempo range, genre feel, SFX density, silence use

## Signature moves (to adapt, not copy)
1. …
```

## 3. Use it

- Feed `STYLE.md` into `frame.md` (brand kit still wins on colors/fonts —
  the reference supplies rhythm and grammar, the brand supplies identity).
- Cite `STYLE.md` in the storyboard ("match: average shot 1.4s, per-word
  type reveals").
- In `video-qa`, score **reference match** as one of the critique
  dimensions. When the user provided a reference video, compare directly:
  `hf snapshot --at <times> --against sources/ref.mp4` saves render/reference
  pair sheets.

## Rules

- Never trace or reuse the reference's footage, characters, logos, music or
  exact copy. Adapt structure and feel only.
- Proprietary fonts in the reference → closest open-license font, noted in
  `STYLE.md`.
- If the reference and the brand kit conflict (e.g. reference is neon, brand
  is muted), follow the brand and tell the user which parts of the reference
  you adapted.
