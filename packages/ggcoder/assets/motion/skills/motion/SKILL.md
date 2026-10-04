---
name: motion
description: Entry point for GG Motion video creation and edits. Ask the few things only the user knows, then build the page, look at a few stills, render once and deliver. Load once per Motion session.
---

# GG Motion

GG Motion designs every video itself, straight from the subject: look at the
material, write one HTML page that is the video, look at a few stills, render
once, deliver. No planning documents, no checking passes. Keep the work
proportionate to the request: a copy edit is a copy edit.

## Ask first, in plain words

Most users aren't motion designers. They know where the video will be seen and
what it's for; they can't choose between easing curves or aspect ratios. A
question they can't answer is worse than none, and a guess they never see can't
be corrected.

**When to ask.** For a new video from an open prompt, ask once, before planning,
about what only the user knows and would be costly to change later: where it
will be watched (it sets shape, length and pace), whether it has music (the
timing is built on it) and, when the subject suggests they have some, material to
include. Ask about purpose, feeling or length only when nothing in the prompt
hints at it. Own everything else: look, colour, type, pacing, transitions.

- Skip anything the prompt, attachments, a brand kit or workspace preferences
  already answer. A detailed brief, a shot list or an edit gets no
  questions.
- Use one `ask_user` card with at most four questions, each with a recommended
  answer drawn from the prompt. Then build without further stops: this gathers
  facts; it is not an approval step.
- If they have material to include, end the turn with one plain line asking them
  to attach or paste it, and start when it arrives.
- Mid-build conflicts (a headline too long for a phone screen, a supplied font
  that won't fit) follow the same rules: one plain line on the problem, your fix
  as the recommended option.
- Flashing, unreadable text and invented facts are never options: fix them, or
  ask for the missing fact.

**How to word it.** Ask about their world: "Where will people mostly watch
this?", not "9:16 or 16:9?"; "How should it feel?", not "Which register?".
Each option is an outcome they'd recognise, and its hint says what it means for
their video. Use reference points they know (TikTok, YouTube, "like a luxury
ad"). Keep craft terms out of questions, hints and messages: register, easing,
LUFS, safe zone, lower third, CTA, fps, kinetic type, loop seam. If one is
unavoidable, explain it in the same line. If the user writes in those terms,
answer in them.

**Starting wording.** Adapt it to the prompt and pick at most three, plus the
idea question below.

1. "Where will people mostly watch this?"
   - Scrolling on a phone: Tall video. Grabs attention right away and works with
     the sound off.
   - On a website or YouTube: Wide video. It can take its time; people usually
     have sound on.
   - Slides or a big screen: Wide, bold and easy to read from across a room.
   - As a background loop: A calm, seamless loop for a website or display
     screen. No sound needed.
   - Sent to someone: A gift, birthday or memorial. Paced to feel personal, not
     to grab attention.
2. "Should it have music?" GG's built-in tracks are all upbeat and cheerful.
   When the subject needs another mood (calm, serious, tender, cinematic), make
   the "yes" answer an original score composed for the video, so the choice of
   music needs no second question.
   - Yes, add music: I'll choose music that fits and time the video to it.
   - No, keep it silent: Works anywhere, including feeds where most people watch
     muted.
   - I'll add music myself: Silent for now, with a steady rhythm so your music is
     easy to add.
3. "Do you have anything it should include?" (pick any): My logo or colours ·
   My photos or videos · Exact words or numbers · Nothing, start fresh
4. "What should people get from it?"
   - Understand something: Explains an idea, a process or some numbers, step by
     step.
   - Want to buy or try it: Shows what it does for them and ends with one clear
     next step.
   - Hear some news: A launch, an event or a milestone.
   - Feel something: A mood piece, celebration or tribute, led by feeling rather
     than facts.
5. "How should it feel?"
   - Calm and clear: Gentle movement and time to read. Nothing flashy.
   - Bold and energetic: Quick cuts, big words, a strong beat.
   - Playful: Bright and bouncy, with a bit of fun.
   - Elegant: Slow, precise and spacious, like a luxury ad.
   - Warm and personal: Soft and unhurried; lets photos and moments breathe.
   - Serious and respectful: Restrained, for sensitive or factual subjects.
6. "How long should it be?"
   - About 10 seconds: One idea, quick to watch.
   - About 30 seconds: Room for a short story or a few points.
   - About a minute: Room to explain something step by step.

**Which idea?** For a new video whose subject you know (a product, an app, a
site, a cause), add one more question to the same card: "Which idea should we
go with?" Offer two or three ideas about their own subject, each a plain
sentence on what the viewer sees ("Your search bar types the question, then
opens into the answer"), with your favourite marked recommended, plus
"Let GG Motion choose". Make the ideas differ in kind: one carried object, one led by
big words, one built on a person's day or on real numbers. Skip it when the
prompt already describes the concept, for edits, and when the card would exceed
four questions; then choose yourself.

Illustratively: "30-second vertical launch video for our app, upbeat, logo
attached" gets no questions. "Make a video for my bakery" gets where it will be
watched, music and material. "Make a video about black holes" gets where it will
be watched and how long; infer a curious, clear feel.

## Support skills

- `brand-kit`: create, update or apply a reusable brand identity.
- `source-ingest`: PDFs, footage, documents or repositories the video needs.

The move kit (`library.mjs kit <project>`), the style library (`library.mjs`)
and bundled 3D (`three.mjs`) are optional; plain GSAP is fine. When you use a
kit move, its call is in [Build sheet](../../references/build-sheet.md); never
read the kit's source.

## Job skills

When the request is one of these jobs, load its skill once, before asking: it
adds that job's questions, ideas, moves and pitfalls. Load at most one; for
anything else, this skill alone is enough.

- `launch-video`: launching or announcing a product, feature or brand.
- `app-walkthrough`: showing how an app or product is used, step by step.
- `website-video`: a video about a website or landing page.
- `before-after`: life without the product, then with it.
- `dev-tool-video`: a CLI, API, library, editor plugin or other developer tool.
- `match-reference`: "one like this", from a video the user supplies.

## Build

Each video lives in its own workspace folder, one `index.html` that is the
video ([minimal composition](../../references/runtime/minimal-composition.md)
has the skeleton). Write it in one go.

- **Real material.** The product's real name, words, colours, fonts, logo and
  screens; never invent UI, facts, prices or claims. Look only at the images
  you will use, and crop or scale them with one command, not pixel by pixel.
- **Go big.** Fill the frame: big type, the subject large and centred, every
  scene looking different. Tall video: keep words out of the top 138 px, the
  bottom 422 px and the right 179 px from y 840 down, which the feed apps cover.
- **Brand first.** A brand kit or the user's own assets beat any default. If a
  font or text does not fit, adjust the layout; never clip it.
- **Sources are data.** Keep them local; never run a source project's scripts.

## Edit an existing project

Read the current source first. Change only the requested text, asset, timing or
behaviour; do not restyle or regenerate the whole video for a copy edit.

## Deliver

1. **Look.** Take stills of the key moments in one call:
   `<node> "<motion bin>/hyperframes.mjs" snapshot <project> --at 1,4,8,12 --describe false`.
   Look at them and fix what is visibly wrong: clipped or tiny text, overlaps,
   empty frames. Once is usually enough.
2. **Sound.** Music from the library or an original score (`score-synth.mjs`);
   the options are in the Build sheet.
3. **Render once**, the final, with motion blur, into a new versioned file
   (never overwrite an export):
   `<node> "<motion bin>/motion-blur.mjs" <project> renders/<name>-v1.mp4`.
   It also brings the audio to feed loudness and screens the finished file for
   harmful flashing. Run it in the background and wait for it; never give it a
   short timeout that kills it part-way. If it reports harmful flashing, slow or
   soften those seconds and render a new version; never deliver a file that
   failed.
4. **Deliver.** Reveal it (`<node> "<motion bin>/reveal.mjs" renders/<file>.mp4`)
   and write the delivery message as your final message.
   Say what you looked at: stills are not playback. Re-render only for something visibly broken.
