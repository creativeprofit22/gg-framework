---
name: video-qa
description: One output-checking pass for a rendered Motion video. Use motion_check for technical checks and rendered images, inspect them in this session, fix concrete defects and deliver. No independent AI reviewer or creative approval ceremony.
---

# Check the actual output once

Judge the render against the plan in `frame.md` (its `Concept` and `Language`) and the approved inputs, not an alternative creative direction. The check finds defects; it is not an invitation to add effects, retime the motion or redesign the layout.

## 1. Check the current export

Call `motion_check` with:

- `project`: the current HyperFrames project folder.
- `output`: the actual rendered MP4, inside the workspace.
- `windows`: representative motion/transition windows, each with `label`, `start` and `end` in seconds. Use the video's own timings; each window spans at least two frames and at most ten seconds, up to twelve windows.
- `holds`: only when the video has a deliberate static section (an end card, reading hold or pause you designed), the path to its render-bound hold plan (format below). Write it before this first call; an undeclared deliberate hold is flagged as frozen and costs a second full check.
- `slideshowRequested`: true only when the user actually requested a slideshow; never use it to hide broken motion.
- `range`: only for an export longer than 180 seconds or a targeted diagnostic, a start/end range of at most 180 seconds. Report the inspected range honestly; do not claim full-video visual coverage.
- `spot`: true for a quick check of a targeted fix or small edit. Put short `windows` around the moments you changed, at most 240 rendered frames in total (4 s at 60 fps). The layout check then covers every rendered frame inside them, far faster than the full check, while the pixel, hold and audio checks still cover the whole export. A spot result is never delivery verification: once it is clean, run the full check (without `spot`) once on the export you deliver.

The tool runs HyperFrames `check` (which already includes lint), decoded-pixel analysis with `motion-check.mjs` including canvas/WebGL, a flash check of the whole export against the WCAG 2.3.1 limits, and audio analysis only when audio exists. It returns technical results and actual rendered overview, phone-size and consecutive-frame images **to you**, the working agent.

Do not precede or follow it with another lint/check/audio/frame-extraction checklist. Diagnosing a specific failure it reported, or looking at a few frames while building, is part of the work, not a second check. Do not call the legacy `motion_review` prepare/submit workflow. No subagent, separate model critique, approval score or chapter registration is needed.

## 2. Inspect what was returned

Check the attached images for:

- Correct user text, images, branding and permitted substitutions.
- Missing media, overflow, clipping and unreadable text.
- The planned motion and timing, including intended holds.
- Representative entrance, active and exit frames for each scene.
- The plan: the motif carries through, colours stay on palette, transitions are deliberate and type stays readable.

Still images do not prove pacing at normal speed or that audio was heard. Use actual playback/listening only when needed and available; state the limit otherwise. Technical success is not proof of visual quality. Missing evidence is unverified, not PASS.

If the tool fails, its check details list each problem with where and when it occurs, plus renderer notes such as undeclared fonts. Use them to diagnose the concrete problem; do not rerun the check by hand to see them. Runtime command details live in [technical diagnostics](../../references/runtime/lint-validate-inspect.md); they are troubleshooting references, not an extra mandatory pass. Never introduce generic drift, extra effects or layout changes just to satisfy a heuristic. If a real accessibility requirement conflicts with the plan, fix the accessibility problem.

## 3. Fix only a concrete defect

A failed check or visibly wrong output warrants a targeted fix, a new versioned render and a spot check of the fixed moments, then one full check once they are clean. An unchanged export does not need checking again unless you corrected its hold plan; that re-check reuses the passing source audit, so it is quick. Do not iterate toward subjective perfection or route the result to another reviewer. Report an unresolved blocker as draft/unverified rather than looping indefinitely or declaring success.

The tool measures audio, reports its integrated loudness and true peak, and rejects non-finite levels or clipping; it does not normalize the file. Follow the user's delivery loudness target when they give one. Do not add audio to silent work or force every supplied animation through a generic -14 LUFS mix.

A flash failure names when it happens and how fast. Retime or soften that moment: at most three light/dark or red swaps in any second, a smaller flashing area, or a smaller brightness difference. Never ship it, and never mark it as a hold to get past it.

### Intentional holds

Declare only deliberate static intervals: an end card, a reading hold or another still section you designed on purpose. The hold plan binds to the current video, so an old plan cannot excuse freezes in a changed export:

```json
{
  "version": 1,
  "videoSha256": "<SHA-256 of this exact export>",
  "holds": [{ "start": 13, "end": 15, "reason": "End card hold" }]
}
```

When a hold is stale, the check lists where the pixels actually freeze; correct the plan from those times instead of guessing. Do not mark the whole video as a hold to suppress broken animation. Retain any existing meaningful motion assertions; do not invent a new assertion sidecar for every video.

## 4. Deliver

Deliver the actual versioned MP4 in this order. The written message is what the user reads to understand what they got, so it is your final message: no `ask_user` card at delivery, which would come before the message and hide it.

1. Reveal the file:

   ```bash
   <node> "<motion bin>/reveal.mjs" renders/<file>.mp4
   ```

2. Write the delivery message as your final message, in plain words:
   - One bold line on what they got, in their words: length, shape, where it fits, how it ends.
   - One line on anything you assumed, so a wrong guess is easy to spot.
   - What the checks mean for their viewers, never the standard or tool names; those stay in `frame.md`. Mention only checks that actually ran and passed.
   - What couldn't be checked, plainly. Do not claim full playback or audio listening from sampled images.
   - After a new video, one closing sentence naming the two or three changes they're most likely to want. Don't make them unasked.

Illustrative delivery message, to adapt rather than copy:

> **A 15-second tall video for Instagram, with upbeat music, ending on your logo.** I assumed it's for people who don't know the shop yet, so it leads with the bread rather than the name.
>
> It's safe for people sensitive to flashing lights, all the text fits on screen with enough contrast to read, and the sound stays clean at its loudest moments. I checked it frame by frame, but I can't watch it the way you will, so play it once on your phone before you share it.
>
> If you'd like, I can add your address and opening hours, use your real logo, or make a wide version for your website.

If they gave a loudness target, say whether it was met. Report what you designed for but no check measures, such as keeping text clear of Instagram's or TikTok's buttons, as your choice ("I kept the text clear of Instagram's buttons"), never as a check result. If something couldn't be checked: "I couldn't listen to the sound, so play it once on your phone first."

No automatic posters, share copy, extra formats or launch packages.
