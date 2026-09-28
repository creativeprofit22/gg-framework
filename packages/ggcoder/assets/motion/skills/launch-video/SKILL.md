---
name: launch-video
description: Plan product launch and marketing videos that look like real product teams made them — 15s teasers, 30–60s launch films, feature launches, UI morph loops, stat cards, and a full multi-format launch kit from one timeline. Gathers the inputs that decide quality (reference style, real screenshots, sourced facts, CTA), locks a stills-first plan, then builds via product-launch-video. Use for any launch, promo, product, feature, SaaS, app or "make a video for my product/site" request.
---

# Launch videos

The model is never the variable; the brief is. A launch video made from a
URL alone looks like a template. The same model with a named reference, the
real UI, four sourced facts and a beat grid looks like a studio made it.

Build pipeline: after this skill locks the plan, load `product-launch-video`
(or `motion-graphics` for loops/stat cards) and follow it, feeding it
everything below so it does not re-ask.

## 1. Pick the deliverable

| Variant | Length / format | Structure | Notes |
|---|---|---|---|
| **Teaser** | 12–15s, 9:16 | Hook (0–2s) → turn → one proof → logo + date/CTA | One idea. Big type, one UI moment. |
| **Launch film** (default for "launch video") | 30–45s, 16:9 | Hook → problem (≤ 1 scene) → product reveal on the drop → 3 features as real-UI moments → proof number → end card | Hero of the landing page and the launch post. |
| **Feature launch** | 20–30s, 16:9 or 1:1 | Before (old way, slow) → after (new feature, fast) → how (2 steps) → CTA | The contrast is the story. |
| **UI morph loop** | 6–8s, 1:1, loops | One shape morphs through 8–12 UI states on the beat; last frame = first frame | Landing-page hero loop. |
| **Stat card** | 5–6s, 1:1 or 4:5 | One sourced number counts up, one line of context, logo | For the announcement post. |
| **Launch kit** | all of the above from one design | See § 5 | Offer after the launch film is approved. |

If the user just says "a launch video", make the **launch film** and offer
the kit at delivery. For a fast, fun 15–25s share trailer of something they
just built ("/brag", "brag about this"), use the bundled `brag` skill: its
seven tones (default, polished, yc-parody, chaotic, deadpan, cinematic,
app-store) plus freeform direction make good concept options, and its
bundled music and SFX are licensed for commercial use.

## 2. Gather the inputs (one `ask_user` round, only what is missing)

Collect before any storyboard. Pull what you can from the site yourself
(`source-ingest`), then ask only for the gaps:

1. **Product + URL**, and the one-line value in the user's own words.
2. **Audience + where it runs** (landing page, X/LinkedIn, Product Hunt, App
   Store, YouTube) → decides format and length.
3. **Reference style** — a video, site or brand whose *feel* to match
   (e.g. "Linear's launch videos", "Apple keynote bumper", "Stripe Sessions").
   Offer 3 fitting options with `ask_user` if they have none. Load
   `reference-style` when they give a file or link.
4. **Real UI**: 3–5 screenshots or a screen recording of the actual product.
   Captured site screenshots count. Never redraw the product from scratch.
5. **Facts**: 3–6 on-screen claims or numbers, each with a source (their
   site, docs, changelog). Unsourced numbers don't go on screen.
6. **CTA**: the one action (URL, "Available today", price, date).
7. **Brand kit** — via `brand-kit`.
8. **Sound**: decided with `sound-design` (a bundled licensed track by
   default for launch videos).

## 3. Direction (write into BRIEF.md)

- **Named reference, not adjectives.** "Match the pacing and type scale of
  Linear's launch film" beats "modern, sleek, punchy".
- **Real UI is the hero.** Animate the captured screenshots: crop to the part
  that matters, push in, mask-reveal, spotlight, cursor-guided.
- **One accent color** from the brand kit, used for the one thing to notice.
- **Copy**: ≤ 6 words per line, ≤ 2 lines per scene, verbs over adjectives,
  no banned phrases (`motion-direction` § 7).
- **Beat grid first** (`sound-design`): scene starts on beats, the product
  reveal on the drop, the end card on the last downbeat and held ≥ 2s.

## 4. Stills-first gate (always, before animating)

1. Present the scene list **on the beat grid** — scene · beats · on screen ·
   sound — and get approval (the HyperFrames storyboard review).
2. Build each scene's **hero frame as a still** (the sketch pass), snapshot
   them, and show **one contact sheet** (`video-qa` → stills gate). Fix
   anything that does not look like *their* product before any motion.
   "If the stills look like your product, the video will."
3. Only then animate, check (`video-qa` critique loop) and render.

## 5. Launch kit (one timeline, many cuts)

After the launch film is approved, offer these as separate renders that reuse
the same design system, assets and score:

| Cut | Format | Length | Change from the film |
|---|---|---|---|
| Landing hero | 16:9 | 30–45s | the film itself |
| LinkedIn / X | 1:1 or 4:5 | 20–30s | re-layout; strong first frame; silent-first captions |
| Reels / Shorts / TikTok | 9:16 | 12–20s | hook + one proof + CTA; UI safe zones (top 12%, bottom 20%) |
| UI loop | 1:1 | 6–8s | loop section of the reveal |
| Stat card | 1:1 | 5–6s | the strongest number |
| Poster / thumbnail | PNG | — | the end card or reveal frame, readable as a static image |

Re-layout each format; never letterbox or just crop the 16:9. Name renders
`renders/<slug>-<cut>-<WxH>.mp4`.

## 6. UI morph loop specifics

- Ask for the 8–12 UI states (button → loader → player → slider → …) and
  show the state list **on the beat grid** before code.
- One continuous shape; text inside it gets its own enter/exit timing so it
  never overlaps during a morph.
- The last frame must equal the first — position, scale, cursor and
  velocity — or the loop stutters. Verify by rendering the loop twice
  back-to-back and checking the seam.
- Never `will-change` on anything the camera scales (text goes blurry).

## Cost and effort

Keep the first pass tight: a 15–30s piece with a locked brief is minutes
and a few dollars of model time. Open-ended "make it better" loops are what
get expensive — cap critique rounds (`video-qa`) and ask before a second
full rebuild.
