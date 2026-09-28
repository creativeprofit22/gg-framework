---
name: video-qa
description: Verify and improve a HyperFrames video before calling it done — stills-first approval, lint, browser check, contact sheets and phone-size strips viewed with your own eyes, a scored critique loop that fixes the worst issues, brand and audio checks, and a final render probe. Use after every build or edit and before every final render or delivery. Never report a video as finished without it.
---

# Video QA

A render that exits 0 is not a finished video. You have **eyes**: look at the
frames. Every claim you make about the video ("the logo appears", "text is
readable") must come from a frame you actually viewed.

All commands run through GG's bundled launcher — see the Motion system prompt
for the exact `hf` command. Run them from the video project directory.

## Design-contract check (before stills and after every design edit)

Read `frame.md` and the storyboard's reuse / adapt / derive records. Compare
both the actual scene source and rendered frames, not just the agent's plan.
Record PASS/FAIL with file/timestamp evidence in `REVIEW.md` for:

- **Authority:** the contract records genuine approval; frontmatter, look CSS
  and prose agree. No preset or later skill silently replaced its decisions.
- **Selection:** each scene names its decision, inspected source/candidates,
  reason and inherited rules. Reused/adapted code is actually present;
  custom work explains why it fits better rather than ignoring a suitable piece.
- **Consistency:** derived elements inherit the specified spacing, type,
  borders, radius, materials, icons and motion. Check declared exceptions.
- **Fidelity:** real product UI stays accurate; sample brands, numbers and
  testimonials are replaced with verified content; copied code keeps notices.
- **Exclusions:** no prohibited grain, depth, fonts or effects were added to
  satisfy generic craft advice. A deliberately flat look is not a QA defect.

Missing evidence is unverified, not PASS. Fix drift before the final render.
If correcting it requires a new design decision, return to the applicable
checkpoint; do not silently rewrite `frame.md` to match an accidental result.
For an existing approved project without this record, backfill only from known
files/user decisions and check the changed scenes without forcing a redesign.

## Gate 0 — stills first (before animating anything)

For new videos, build each scene's hero frame as a still before motion, then
show the user **one** contact sheet and get a yes. If the stills don't look
like their product and brand, motion won't fix it. Skip only for edits to an
already-approved video.

## Gate 1 — structure (fast, every edit)

```bash
hf lint --json
```

Fix every `error`. Fix `warning`s unless you can state why one is intended.

## Gate 2 — browser check (every edit that changes layout or timing)

```bash
hf check --json --at-transitions
```

Covers runtime errors, text/container overflow, motion verification and WCAG
AA contrast. Fix every error. Re-run until clean.

## Gate 3 — look at the frames (every scene)

Pick timestamps from the storyboard, not evenly spaced guesses:

- each scene's **hero frame** (when its main idea is fully on screen),
- the **midpoint of each transition** (catches overlaps and pops),
- the **last frame** (end card / CTA must be readable and still).

```bash
hf snapshot --at 1.2,4.8,6.0,9.5,14.0 -o snapshots/qa
<node> "<motion bin>/contact-sheet.mjs" snapshots/qa snapshots/qa/phone-strip.jpg --phone
```

`snapshot` writes the frames plus `contact-sheet.jpg`; the helper adds a
phone-size strip (the size most viewers see). **Read the two sheets, not
every PNG** — each image you read re-sends the whole conversation, so one
sheet is far cheaper than ten frames. Open a single frame (or `--zoom`) only
to inspect a problem the sheet shows. For every frame, check and note
PASS/FAIL:

1. **Message** — the frame says what the storyboard says it should.
2. **Hierarchy** — one clear focal point; eye lands on it first.
3. **Legibility** — text large enough for the target (≥ 3.5% of frame height
   for body on 16:9; ≥ 4.5% on 9:16), not clipped, not under the platform UI
   safe zone on vertical video (top 12%, bottom 20%).
4. **Brand** — only Motion.md / frame.md colors and fonts; logo is the real
   file, correct variant for the background, not stretched, respecting
   clear-space.
5. **Craft** — nothing half-entered or overlapping at a hero frame; no stray
   debug text, lorem ipsum, broken images or missing-glyph boxes.

Use `--zoom <selector>` to inspect small text or logos at high density.

Your own viewing is the review. The `hf` launcher keeps Gemini frame
descriptions off (`--describe false`); turn them on only if the user
explicitly agrees to send frames to Google.

## Critique loop (after the first full build, and after big changes)

Score the video 1–10 on each dimension from the contact sheet, phone strip
and (for timing) the tempo map:

| Dimension | 10 looks like |
|---|---|
| Hook | the first 1.5s alone would stop a scroll |
| Readability | every line readable on the phone strip |
| Motion quality | purposeful easing, no dead frames, no generic fade-ups |
| Craft | Purposeful signature moments, composition, type and timing within `frame.md`; depth and texture only when the contract calls for them |
| Variety & rhythm | shot lengths vary with the music; one clear drop |
| Brand & reference | Matches the resolved `frame.md`, including required brand fidelity and accepted references; STYLE.md cannot independently override it |
| Truth | every number and claim traces to FACTS.md / brief.md |
| Sound sync | cuts and hits on the beat; mix balanced |

Then: fix the **three worst** issues (not everything), re-render only the
affected scenes' frames, re-score. Stop when every score is ≥ 8, or after
**3 rounds** — then show the user the scores and the sheet and ask whether
to keep polishing. Write each round's scores to `REVIEW.md` so progress is
visible and resumable.

When the user gives feedback, turn it into **Director Notes** (see
`motion-direction` § 9) and apply them the same way.

## Gate 4 — audio (when the video has sound)

- Voiceover is intelligible over music: music ducks under speech.
- Beat-synced cuts land on the beat (check 2–3 cut points against the beat
  grid the video was built on — see `sound-design` § 5).
- The drop is audibly bigger than the build; no SFX louder than the impact.
- Every `<audio>` has an `id` (otherwise it is silently not mixed).

Balance the mix with `data-volume`, not by editing the audio files.
Renders come out quiet (often around −23 LUFS), so set the final loudness on
the rendered file. Video is copied untouched. 320k AAC matters: ffmpeg's
AAC at lower bitrates can overshoot peaks by several dB.

```bash
ffmpeg -y -i renders/<file>.mp4 -map 0 -c:v copy \
  -af "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000" \
  -c:a aac -b:a 320k -movflags +faststart renders/<file>.loud.mp4 \
  && mv renders/<file>.loud.mp4 renders/<file>.mp4
ffmpeg -i renders/<file>.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -12
```

Pass: integrated −14 ± 1 LUFS and true peak ≤ −1 dBTP, measured on the file
you deliver. If the peak is over, rerun with `TP=-2.5`.

## Gate 5 — final render

```bash
hf render --quality delivery -o renders/<slug>-<WxH>.mp4
```

Apply Gate 4's loudness step to this render. Then probe the file you are
about to hand over (`ffprobe` when available, or `hf info`), and confirm: duration matches the storyboard (±0.2s),
resolution and fps are what was promised, the file is not zero-length.

## Deliverables (every short video; adapted from brag)

1. **Poster frame.** Pick the strongest *settled* moment (text fully in, not
   mid-transition — the storyboard says when) and extract it:
   `ffmpeg -ss <t> -i renders/<file>.mp4 -frames:v 1 -q:v 2 renders/<slug>-poster.jpg`.
   Look at it; nudge `<t>` if it caught motion.
2. **Bake it as frame 0.** Social platforms and chat apps use frame 0 as the
   thumbnail, so replace only that frame (duration, frame count and audio
   stay identical):
   ```bash
   ffmpeg -y -i renders/<file>.mp4 -i renders/<slug>-poster.jpg \
     -filter_complex "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]" \
     -map "[v]" -map 0:a? -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
     -c:a copy -movflags +faststart renders/<file>.poster.mp4 \
     && mv renders/<file>.poster.mp4 renders/<file>.mp4
   ```
   Re-probe: frame count and duration must match the pre-bake file. Skip for
   long-form films shown in a player with its own poster.
3. **`share-copy.txt`** beside the render: 1–3 postable sentences in the
   video's tone, using the product's real claims. No "excited to share", no
   hashtag walls.
4. **Show it.** Last, after every check passes, open the user's file
   manager at the delivered video (every video, including edits and
   re-renders): `<node> "<motion bin>/reveal.mjs" renders/<file>.mp4`.
   If it prints `"ok":false`, say so and give the path instead.

## Reporting

Report to the user:

- the output file path, duration, resolution and fps, plus the poster and
  share-copy paths,
- what you verified (gates run, frames viewed),
- anything you could not verify and why.

If any gate fails and you cannot fix it after two attempts, stop, show the
failing frame, and ask the user how to proceed.
