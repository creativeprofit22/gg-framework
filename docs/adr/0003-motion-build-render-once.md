# ADR 0003: GG Motion builds straight from the subject and renders once

**Status:** Accepted, 2026-10-04. Supersedes the planning and checking parts of
ADR 0002 (beat sheet in `frame.md`, flow/look/sound reports, `motion_check`).

## Context

Raced on the same brief (a 15–22 s tall promo for a real product site, same
model and thinking level), plain Claude Code with no configuration finished in
7.1 min with 34 tool calls and a video the user judged clearly better. GG
Motion took 15.9–19.9 min with 61–75 tool calls, 2–5 renders and a weaker
video.

Measuring both runs call by call showed the tools were not the cost (99 s of
tool time against 80 s). The model was: 716 s of model time against 345 s. GG
read about 67 KB of method guides, wrote a planning file, planned against a
beat sheet, holds and bursts, then rendered drafts and ran a checking tool
whose craft findings sent it back to fix and re-render. Turning the checks off
alone saved only 2 minutes; the reading and planning were the rest. The
guides' "quiet ground" and "one accent" rules also pushed frames toward small
type and empty space.

## Decision

- The agent works **ask → build → look at a few stills → render once →
  deliver**. No planning file, beat sheet, hold plan, draft renders or
  checking passes; re-render only for something visibly broken.
- Instructions are short: the system prompt, the `motion` skill and at most one
  job skill (about 11 KB). The long method guides, the checking tool and its
  craft-report scripts are removed, not just unused, so the agent cannot
  wander into them.
- Kept: all job and support skills, the move kit and pieces, fonts, music and
  sound, scores, 3D, capture, reference study and the motion-blur render.
- The final render (`bin/motion-blur.mjs`) now does the two things that matter
  for every feed video without a separate step: audio at feed loudness
  (-14 LUFS, a 4x-oversampled limiter at -2 dBFS, AAC 320k) and a WCAG 2.3.1
  flash screen of the finished file (`bin/flash-check.mjs`, under a second). A
  file that fails the flash screen reports `ok: false` and is never delivered.
- Tall video: words stay out of the bands Instagram, TikTok and YouTube Shorts
  cover on an ordinary post (top 138 px, bottom 422 px, right 179 px from
  y 840 down on 1080x1920). The stricter ad templates shrank everything.

Result on the same brief: 6.8 and 7.4 min, 35–36 tool calls, one render,
-14.2 LUFS, a video on par with plain Claude Code's.

## Rejected alternatives

- **Keep the checks, cut only the reading.** Measured: the checks cost about
  2 minutes per video and were mostly worked around (marking elements as
  allowed to overlap), without a better video.
- **Remove every check.** Nothing would catch harmful flashing, which a viewer
  with photosensitive epilepsy cannot opt out of. The flash screen is cheap and
  never loops back into the build.
- **Strict ad-template safe zones.** They left a box of about 36% of the frame
  and made every video small.
