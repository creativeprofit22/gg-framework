---
name: source-ingest
description: Turn whatever the user provides — a website URL, a PDF, slides, images, screen recordings, a doc, a GitHub repo or PR, or plain notes — into a clean brief.md plus an assets folder a video can be built from. Use at the start of every new video after the brand kit is resolved, and whenever the user adds new source material mid-project.
---

# Source ingest

Goal: every fact, number, quote and image in the video traces back to a
source the user gave you. Write down where each came from.

Output, inside the video project directory:

```
sources/                 raw captures (never edited)
assets/                  cleaned, video-ready images/clips/logos
brief.md                 the ingest result (template below)
```

## By source type

**Website URL** — use HyperFrames' capture (it screenshots, extracts design
tokens, fonts, assets and copy in one pass):

```bash
hf capture <url> -o sources/site
```

Then read `sources/site/` (screenshots, tokens, assets list). If capture
fails (bot wall, auth), fall back to `screenshot` at 1440×900 and 390×844
plus `web_fetch` for copy. Capture at most the pages the story needs
(usually home + 1–3 feature pages).

**PDF** (reports, decks, papers, brand guides):

```bash
<node> "<motion bin>/pdf-extract.mjs" <file.pdf> sources/pdf
```

This writes `text.md` (per-page text), `meta.json` and embedded images.
For pages listed in `pagesWithoutText` (scans, charts drawn as vectors),
screenshot the page instead: open the PDF with `screenshot`
(`file:///abs/path.pdf#page=N`) and `read` the PNG. Cite page numbers in
brief.md for every fact you use.

**Images / screenshots / recordings** — copy into `sources/`, `read` each
image to understand it. For video, `hf info <file>` for duration and
dimensions; pick timestamps to use and note them.

**Docs / notes / plain text** — read fully; extract the claim, the proof
points, and any numbers.

**GitHub repo** (URL, `owner/repo`, local folder) — use `repo-video`.
**GitHub pull request** — use the `pr-to-video` workflow (it has its own
ingest).

**Figma** — use the `figma` skill.

## Rules

- Never fabricate a number, quote, customer name or logo. If the story needs
  a fact the sources lack, ask the user or leave it out.
- Keep the user's wording for product names and taglines exactly.
- Prefer the user's real UI/product imagery over illustrations.
- Do not scrape pages behind login or paywalls the user has not shared.
- Private files stay local: never upload the user's documents to third-party
  services without asking.

## brief.md template

```markdown
# Brief — <working title>

Brand kit: <kit-slug | none>
Format: <16:9 1920x1080 | 9:16 1080x1920 | 1:1 1080x1080> @ <30|60>fps
Target length: <seconds>
Audience: <who is watching, where>
Goal: <what they should think/do after>
One-line takeaway: <the sentence they remember>

## Sources
- [S1] https://… (captured 2026-09-28) — home, pricing
- [S2] report.pdf — pages 3, 7, 12

## Key facts (cited)
- Revenue up 42% YoY [S2 p3]
- …

## Must-use assets
- assets/hero-dashboard.png [S1] — hero UI, crop to chart area
- …

## Voice & copy
- Tagline (verbatim): "…" [S1]

## Open questions
- …
```

Share a 3–5 line summary of brief.md with the user before storyboarding, and
resolve open questions in one `ask_user` call.
