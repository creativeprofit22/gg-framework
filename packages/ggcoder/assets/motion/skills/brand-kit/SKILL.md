---
name: brand-kit
description: Create, load, update and apply a Motion.md brand kit — the user's colors, fonts, logo, voice and motion personality, saved once and reused across videos. Use at the start of every new video (before any design step), whenever the user shares brand guidelines, a logo, or a website to match, or asks to change the brand. Converts Motion.md into the video project's frame.md.
---

# Brand kit (Motion.md)

Motion.md is the user's **reusable brand kit**. A video project's `frame.md`
(HyperFrames' design spec) is **derived from it**, per video. Motion.md is the
thing the user owns and approves; `frame.md` is build output.

## Where kits live

- Saved kits: `brand-kits/<kit-slug>/Motion.md` in the Motion workspace root,
  with the kit's files beside it: `logo.svg` / `logo.png` (the main logo),
  `logo-dark.*` (dark version for light backgrounds, when there is one),
  `fonts/*.woff2`, `reference/*` (screenshots, PDFs the kit came from).
- A video uses exactly one kit, or none. Record the choice in the video
  project's `brief.md` as `Brand kit: <kit-slug>` (or `Brand kit: none`).
- Kit slugs are lowercase kebab-case from the brand name (`acme-labs`).

## Step 1 — resolve the kit (every new video)

1. If this conversation already picked a kit for this video, use it. Do not
   ask again.
2. Otherwise list `brand-kits/*/Motion.md`.
3. Ask **one** question with `ask_user` (single choice). Options, in order:
   - each existing kit by brand name ("Use Acme Labs brand") — mark the most
     recently modified one `recommended`;
   - "Build one from my website" (only offer when you do not already have a
     URL; if the user already gave one, say you will use it instead);
   - "Build one from a brand guide or PDF";
   - "Answer a few quick questions";
   - "No brand — pick a look for me".
4. If the user's first message already makes the answer obvious (they attached
   a brand PDF, gave their site, or said "no branding"), skip the question and
   proceed with that choice.

## Step 2 — build a kit (when needed)

Extract **real** values. Never invent a hex code or a font name.

**From a website** (`web_fetch` + `screenshot`):
- Screenshot the home page at 1440×900 and one key inner page.
- `web_fetch` with `format: "html"` to read CSS custom properties,
  `<link rel="icon">`, `og:image`, `<meta name="theme-color">`, and
  `font-family` / Google Fonts / `@font-face` declarations.
- Logo: prefer an inline or linked SVG in the header; else the highest-res
  PNG. Download it into the kit folder with `bash` (`curl -fsSL -o`). Verify
  the file opens (`read` it) before using it.
- Colors: collect declared colors, then rank by visible area in the
  screenshots. Keep ≤ 6 roles: `bg`, `surface`, `text`, `text-muted`,
  `primary`, `accent`.
- Voice: 3–5 adjectives drawn from the site's own headline copy, plus 2 real
  example lines quoted verbatim.

**From a brand guide / PDF** (`read` the file; for scanned pages, render and
view pages as images): take palette, type, logo rules, clear-space and
do/don't lists exactly as written. Page-cite anything you copy.

**From questions**: ask at most 4, in one `ask_user` call: brand name; the
feeling in three words; colors they already use (or "pick for me"); any
fonts they must use (or "pick for me").

**No brand**: choose a HyperFrames frame preset that fits the request (see
`hyperframes-creative` → `references/design-spec.md`) and skip Motion.md.

Fonts: a website's font is its **UI font** (`body`). Record it as found.
Fill `display` only with a real display face the brand uses for big
headlines (a different family, or a clearly display cut); otherwise leave
`display` unset and let `type-system` pick per video. Prefer the brand's own
font files if the user owns them; otherwise the closest open-license font.
Record the license in Motion.md.
Never download fonts, logos, music or imagery the user has not provided or
that are not clearly licensed for this use.

## Step 3 — write Motion.md

Use this exact shape. Frontmatter is normative (machine-read); prose is
judgment. Quote values verbatim.

```markdown
---
name: Acme Labs
kit: acme-labs
source: https://acme.example (captured 2026-09-28)
colors:
  bg: "#0b0b0f"
  surface: "#16161d"
  text: "#f5f5f7"
  text-muted: "#a1a1aa"
  primary: "#5b5bf7"
  accent: "#22d3ee"
typography:
  display: { family: "Mona Sans", weight: 800, width: "118%", tracking: "-0.03em", license: "OFL" }
  body: { family: "Inter", weight: 400, license: "OFL" } # the site's UI font
  mono: { family: "JetBrains Mono", weight: 500, license: "OFL" }
logo:
  primary: logo.svg
  on-light: logo-dark.svg
  min-height-px: 48
  clear-space: "0.5x logo height"
motion:
  personality: precise # calm | precise | bold | playful
  easing: "cubic-bezier(0.22, 1, 0.36, 1)"
  pace: medium # slow | medium | fast
voice: [confident, plain, technical]
---

## Overview
One paragraph: who the brand is for and how it should feel on screen.

## Voice
- Example line (verbatim from source): "..."
- Say: ... / Never say: ...

## Do
- ...

## Don't
- ...

## Music & sound
Mood, tempo range, and anything to avoid.
```

Then show the user a **one-screen preview** before using the kit: render a
single still title card with the kit's colors, fonts and logo
(`hf snapshot` of a 1-scene composition, or a `screenshot` of a
static HTML page), and ask with `ask_user`: "Use this brand kit?" — options
"Looks right" (recommended), "Colors are off", "Fonts are off", "Logo is
wrong". Fix and re-preview until approved.

## Step 4 — derive frame.md for the video

For each video project, write `frame.md` in the project root from Motion.md,
following `hyperframes-creative` → `references/design-spec.md`. This is the
initial draft, not permission to overwrite an approved design contract.
`style-library` resolves it with the chosen look and accepted references
before storyboard approval. On resume, read the existing `frame.md` first
and preserve its resolved decisions and workflow schema:


- Map `colors` 1:1 into frame.md `colors` (same names where they exist).
- Map `typography` roles to frame.md type ramp entries (display → h1/h2,
  body → body, mono → counter/tag), sized for the frame (`cqw` units).
- Copy logo files into the project's `assets/` and reference them.
- Copy Do / Don't into frame.md prose verbatim.
- Motion personality + easing go in frame.md prose under "Motion"; timing
  values themselves come from `motion-direction`.

Motion.md wins over any frame preset. A preset may supply layout ideas, never
colors or fonts that contradict the kit.

## Updating a kit

When the user changes a brand value ("make the blue darker", "we use Söhne
now"), distinguish a reusable kit update from a one-video override. Change
Motion.md only when the user requests or approves a reusable change. Otherwise
update this video's `frame.md` and tokens only. Merge the changed values without
regenerating unrelated approved decisions; update affected scenes and re-run
QA. State whether the change applies to this video or future videos too.
