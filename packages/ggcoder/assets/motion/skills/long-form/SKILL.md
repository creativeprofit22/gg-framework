---
name: long-form
description: Produce long-form motion films (roughly 90 seconds to 10 minutes) — narrated explainers, documentaries, company or history stories, course lessons, YouTube videos — as a real production: director's brief, researched and fact-logged script, style bible, chapter plan, low-res animatic, chapters built in parallel by sub-agents on a shared animation guide, critique passes, a per-chapter score, and a resumable PRODUCTION.md. Use when the requested video is longer than ~90s or has chapters.
---

# Long-form production

Long films are not long prompts. The best public ones (4–5 minute history
films, documentaries, 2-minute music videos) all ran on a **director's
brief** and a crew: shared rules every chapter follows, an animatic before
polish, and repeated review of stills. Plan like a studio, then fan out.

Build mechanics come from HyperFrames: `general-video` (multi-scene
planning, sub-compositions, dispatch rules) or `faceless-explainer` (when
there is no product/site to capture). This skill owns the production layer
on top.

## 0. Scope and cost gate (before any work)

State the plan in one message: length, chapters, narration yes/no, style,
what you'll research, and a rough effort level ("~2 hours of agent time;
the animatic comes first so you can steer early"). Ask to proceed with
`ask_user` (options: full film, a 30-second pilot chapter first
[recommended for > 3 min], change the plan).

## 1. Director's brief — `DIRECTOR.md`

Write it, show a summary, get approval. Sections:

1. **Logline** — the film in one sentence; every decision is checked
   against it.
2. **Audience & runtime** — who, where (YouTube, course, site), target
   length, aspect ratio.
3. **References** — videos, paintings, sites, prior work. For each: what to
   keep (grammar: pacing, framing, palette logic), what to push, what never
   to copy (content, characters, logos). Load `reference-style` for files.
4. **Tools & budget** — narration voice/provider, music source
   (`sound-design`), any paid APIs the user approved. "Spend economically."
5. **Style bible** — palette, type, texture, camera language, transition
   grammar, and a **character/identity lock** if there is a recurring
   character or product (proportions, colors, silhouette that must survive
   every scene).
6. **Beat sheet** — acts → chapters with timestamps and the one idea each
   chapter lands.

## 2. Research and fact log — `FACTS.md`

For factual films (history, science, company stories) research first. Every
name, date, number and quote on screen or in narration gets a line:
`claim — source URL or file:page — confidence`. Nothing unlogged goes in.
Re-verify the chronology before the animatic.

## 3. Script — `SCRIPT.md`

- Write for the ear: short sentences, one idea per sentence, ~150 words per
  minute of narration (≈ 2.5 words/s); leave music-only breaths between
  chapters.
- Mark chapter boundaries and on-screen text separately from narration.
- Generate narration per chapter (`media-use` → TTS). Offline Kokoro via
  `hf tts` needs no account but needs Python with `kokoro-onnx` (see
  `media-use` → `audio/references/requirements.md`); ask before installing
  anything. Transcribe for word timings (`hf transcribe`) — the words drive
  animation timing.

## 4. Shared animation guide — `ANIMATION_GUIDE.md`

The single most important file for consistency. Every chapter worker reads
it first. Contents:

- canvas size, safe areas, caption band (keep key action above it);
- the style bible in build terms (CSS variables, fonts, texture layers);
- shared helpers and components (lower thirds, date stamps, map frames,
  character rig) with how to call them;
- motion rules: easing family, transition grammar, camera moves, hold times;
- determinism rules: every frame a pure function of time, seeded
  randomness only, no timers;
- **ownership**: a worker edits only its own chapter files; missing shared
  helpers are written privately inside the chapter; bugs in shared files are
  reported, not fixed.

## 5. Shot list — `STORYBOARD.md`

One `## Chapter N` section per chapter, each with timed shots: time range,
narration line, visual, motion, sound cue. Chapters map to sub-compositions
`compositions/ch-NN-<slug>.html` hosted by `index.html`.

## 6. Animatic (fix pacing before polish)

Build every shot as a rough still or simple move — real timing, real
narration and score, placeholder art — and render at low cost:

```bash
hf render --quality draft -o renders/animatic.mp4
```

Show it to the user. Pacing, order and length change here, cheaply. Get
approval before full production.

## 7. Production — chapters in parallel

- Follow HyperFrames' dispatch rules (`general-video` → Dispatch): inline
  for ≤ ~6 short scenes; otherwise sub-agents with **2–3 chapters each, all
  launched in one wave**.
- Each worker brief is standalone: the chapter's STORYBOARD section, the
  paths to `DIRECTOR.md`, `ANIMATION_GUIDE.md`, `frame.md`, `FACTS.md`,
  its assets and audio timings, the exact `hf` command, and the SKILL.md
  paths it must read (`motion-direction`, `hyperframes-core`,
  `hyperframes-animation`). It returns: files changed, a contact sheet path,
  and open issues.
- Workers render and review their own chapter stills (`video-qa` critique
  loop) before returning.

## 8. Assembly, critique, finish

1. Assemble all chapters; run `video-qa` gates on the whole film.
2. Critique pass over the **whole** film: one contact sheet per chapter
   (frame per shot) plus a phone strip; score each chapter; fix the three
   worst issues film-wide; repeat (max 3 rounds unless the user asks for
   more).
3. Continuity pass: identity lock, palette drift, type consistency across
   chapters; chronology and names against `FACTS.md`.
4. Audio pass: narration intelligible, music ducked, chapter transitions
   musical (score per chapter, `sound-design`), loudness −14 LUFS.
5. Final render at delivery quality.

## 9. Resumable production — `PRODUCTION.md`

Long films span sessions. Keep a checklist at the project root and update it
after every step:

```markdown
# Production — <title>
- [x] DIRECTOR.md approved (2026-09-28)
- [x] FACTS.md (42 claims, all sourced)
- [ ] Animatic approved
- Chapters: ch-01 ✅ reviewed · ch-02 🔨 building · ch-03 ⏳
- Open issues: ch-02 map labels overlap at 1:12
- Next: finish ch-02, then critique round 1
```

On resume, read `PRODUCTION.md` first and continue from "Next".

## Deliverables

Final MP4, poster frame (PNG), chapter contact sheets, captions file
(`.srt` or `.vtt`) when narrated, and a short credits/sources note built
from `FACTS.md`.
