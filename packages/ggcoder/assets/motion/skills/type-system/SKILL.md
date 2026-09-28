---
name: type-system
description: Choose and set the typography for a motion video — a headline font from GG's bundled library of 15 distinctive open-license fonts (variable width/weight/optical-size axes), pairings, type scale for 16:9 and 9:16, and kinetic-type moves (axis animation, weight ramps, masked line reveals). Use when writing frame.md or a storyboard, when a brand kit has no display font or only a UI font, when a video's type looks generic, or when a scene is type-led.
---

# Type system

Type is most of what a motion video looks like. A website's font is chosen for
16px UI text; a video headline is 120–300px and moving. Treat them as two
jobs.

## 1. Two roles

| Role | Job | Source |
|---|---|---|
| **UI font** | Real product UI, captured screens, small labels | The brand's own font (Motion.md `typography.body` / `ui`) |
| **Display font** | Headlines, big numbers, kinetic type | Motion.md `typography.display` if the brand has a real display face; otherwise pick from the library below |

Read `frame.md` first. Required brand fonts and approved type roles stay,
even when the display and UI family match or appear on the generic list in
§ 4. This skill fills unresolved roles; it does not reopen an approved choice.
For an unset display role, prefer the chosen look's display face before
proposing another from this library. Resolve the pick in `frame.md` before
storyboard approval; update the reusable brand kit only when the user approves
reusing it. If a required font is unavailable, resolve the substitute with
the user rather than silently swapping it.

## 2. The bundled library

All SIL OFL 1.1, offline, Latin, variable unless noted.
`<node> "<motion bin>/fonts.mjs" list` prints every family and the path of
a specimen sheet; `read` it once to see them before choosing.

| Family | Axes | Voice | Use for |
|---|---|---|---|
| **Mona Sans** | wdth 75–125, wght 200–900 | engineered, confident | dev tools, launches; wide-heavy headlines |
| **Hubot Sans** | wdth 75–125, wght 200–900 | technical, compact | stats, dense tech headlines; pairs with Mona |
| **Bricolage Grotesque** | opsz 12–96, wdth 75–100, wght 200–800 | warm, quirky, editorial | friendly products, creator tools |
| **Schibsted Grotesk** | wght 400–900 | newsroom, sturdy | data stories, reports |
| **Host Grotesk** | wght 300–800 | clean, contemporary | calm premium; a quiet Inter replacement |
| **Funnel Display** | wght 300–800 | soft, rounded display | consumer apps, playful launches |
| **Anybody** | wdth 50–150, wght 100–900 | elastic, loud | kinetic type, width morphs, hype |
| **Archivo** | wdth 62–125, wght 100–900 | grotesk workhorse | condensed-to-wide systems, sports energy |
| **Big Shoulders** | opsz 10–72, wght 100–900 | condensed, industrial | huge numbers, posters, countdowns |
| **Fraunces** | opsz 9–144, wght 100–900, SOFT, WONK; italic | "wonky" old-style | warm editorial, human stories |
| **Newsreader** | opsz 6–72, wght 200–800; italic | refined text serif | long-form, quotes, documentary |
| **Gloock** | static | high-contrast display serif | luxury, fashion, one-word hero frames |
| **Young Serif** | static | chunky, friendly serif | indie products, approachable brands |
| **Doto** | wght 100–900, ROND 0–100 | dot-matrix | terminals, retro-tech, data readouts (accent only) |
| **Martian Mono** | wdth 75–112.5, wght 100–800 | modern mono | code, tokens, metadata |

Install into the project (copies files + licenses, writes `assets/fonts/fonts.css`):

```bash
<node> "<motion bin>/fonts.mjs" add . "Mona Sans" "Newsreader"
```

Then link it first in `<head>`: `<link rel="stylesheet" href="assets/fonts/fonts.css" />`.
Each family registers its full weight and width range, so use
`font-weight: 820; font-stretch: 118%;` directly. For custom axes
(`SOFT`, `WONK`, `ROND`, `opsz` overrides), use `font-variation-settings`.

## 3. Pairing

Cross a boundary. Never two similar sans.

| Display | + Supporting | Feel |
|---|---|---|
| Mona Sans (wide, 800) | Martian Mono | dev-tool launch |
| Anybody (wide, 900) | Host Grotesk | loud, kinetic |
| Big Shoulders | Schibsted Grotesk | data, sport, poster |
| Fraunces (SOFT 100) | Host Grotesk | warm editorial |
| Gloock | Newsreader italic | luxury, quiet |
| Bricolage Grotesque | Newsreader | creator, friendly-smart |
| Hubot Sans (condensed) | Doto (numbers) | technical, retro-future |

One display family per video. The supporting face may be the brand's UI font.

## 4. Generic defaults to replace

These read as "AI-made" in 2026 when used as the headline face: Inter, Inter
Tight, Roboto, Open Sans, Poppins, Montserrat, Space Grotesk, Geist, Syne,
Sora, Outfit, DM Sans, Playfair Display. Keep them only for a brand's UI
text or when the user's brand kit requires them. Also avoid: italic
serif "accent word" in an otherwise sans headline, and all-mono layouts.

## 5. Scale (px at 1080p; scale with frame height)

| Element | 16:9 | 9:16 |
|---|---|---|
| Hero word / number | 220–360 | 180–300 |
| Headline | 110–170 | 96–140 |
| Subline | 44–60 | 48–64 |
| Label / UI caption | 26–34 | 30–38 |

Display tracking: −0.02 to −0.05em (tighter as size grows; wide cuts need
less). Line-height 0.9–1.0 for display, 1.2–1.35 for text. Max 2 sizes plus
one label size per frame.

## 6. Kinetic type (seek-safe)

- **Axis animation.** Tween CSS variables with GSAP and map them in
  `font-variation-settings`:
  `tl.fromTo("#h", {"--wdth":50,"--wght":100}, {"--wdth":150,"--wght":900, duration:1.2, ease:"expo.inOut"}, t)`
  with `font-variation-settings: "wdth" var(--wdth), "wght" var(--wght);`.
  Best on Anybody, Mona/Hubot, Archivo.
- **Weight ramp on the beat.** A word thickens 300→900 on the downbeat,
  settles to 700.
- **Masked line reveal.** Each line rises 100%→0 inside an `overflow:hidden`
  wrapper, 0.06–0.1s stagger, `expo.out`. Split with the catalog's split
  components or plain spans; never per-letter on body text.
- **Scale-through.** A hero word scales 1→14 and becomes the next scene's
  background color field.
- **Numbers.** Count up with tabular figures (`font-variant-numeric:
  tabular-nums`) so digits don't jitter.

Browse `hf catalog --tag text --json` and `hf catalog --query "kinetic type"
--json` for ready-made text blocks before hand-building one.
