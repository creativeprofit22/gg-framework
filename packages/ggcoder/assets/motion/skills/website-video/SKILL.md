---
name: website-video
description: Job skill for a video about a website or landing page, built from the real site. Adds website questions, capture and rebuild steps, moves and pitfalls. Load once, before asking, when the user names a site or URL.
---

# Website video

A website video makes people want to visit, using the real site.
Build it as the `motion` skill describes; this page adds what is specific to
sites.

## Ask (on the motion skill's single card)

- "What should people do after watching?" Visit, sign up, buy, book. Offer the
  site's own call to action as recommended.
- "Where will people mostly watch this?" (from the `motion` skill).
- "Should it have music?" (from the `motion` skill).
- "Which idea should we go with?" Pitches below, plus "Let GG Motion choose".

Without a URL, end with one plain line asking for the address.

## Gather the site

Capture the page once (`hf capture <url> -o sources/site`) and read its
headline, sections, colours, fonts and images; they are the brand. Look at only
the images you will use. Rebuild the parts that move (the hero, a menu, a
form) as HTML. Never invent sections, prices or testimonials.

## Ideas that suit websites

- **The site tells its own story.** The headline types, the hero builds, the
  key section opens out of the hero, the button is pressed and becomes the end
  card.
- **Mechanisms, not pages.** Show three or four of the site's working parts as
  close-up components, each poked by the cursor, rather than whole pages.
- **One scroll, operated.** A single continuous camera move down the page with
  real stops on the parts that matter.

## Beats that work

- A short, punchy setup (a few words or the problem), then the site.
- Pages only full-frame and only with the cursor visible; otherwise close-ups.
- One burst where the energy peaks (a few pages flying through, each held
  under a second), never at the start.
- A still hold on the site's best frame, then the URL.

## Moves

`kit.typewrite` for the headline; `kit.cursorPath` for clicks; `kit.diveThrough`
into a card or section; `kit.reshape` from button to end card;
`kit.handheld` during the scroll. Pieces: `browser-window`, `zoom-into-card`,
`request-to-result`, `cursor-click`, `camera-rig`.

## Pitfalls

- A gallery of page thumbnails with a slow dolly: a slideshow.
- Every page at the same length.
- Page after page replacing each other with no handoff.
- Text from the site shown too small to read.
