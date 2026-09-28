---
name: sound-design
description: Make a video come alive with music and sound effects locked to the beat — a bundled licensed recorded track with its beat map (default for upbeat/launch videos), real CC0 sound effects, a synthesized license-free score built offline from a tempo map (GG's score synth), or the user's own song with its measured beat grid; then cut, animate and place every hit on that grid and mix it properly. Use for every video with sound, before building scenes, whenever the user mentions music, beat, rhythm, SFX, sound design, "make it pop/come alive", or supplies a song.
---

# Sound design

Sound is half the video. The difference between "an animation" and "a launch
film" is almost always that the cuts land on the beat and every on-screen
action has a sound. Decide the grid **first**; build the picture on it.

**This is Motion's one sound system, shared by every kind of video** — launch
films, explainers, repo and PR videos, long-form, brag, loops. The music
library, SFX library, beat maps and score synth below work the same whatever
workflow builds the picture; § 6b hands them to the HyperFrames workflows.

Tools (exact paths are in the Motion system prompt: the music and SFX folders
under "Shared audio", `score-synth.mjs` under "HyperFrames in GG"):

- `score-synth` — renders `music.wav`, `sfx.wav` and `tempo-map.json` from a
  small JSON score. Offline, deterministic, license-free.
- **brag's music library** (`brag` → `assets/music/`): 5 real recorded
  upbeat tracks ("Happy Beats / Business Moves" by Sascha Ende, ~110 BPM),
  each with a precomputed beat/cue map in `assets/music/cues/`. CC BY 4.0,
  commercial use allowed, credit optional ("Music by Sascha Ende at
  ende.app"); never register it with YouTube Content ID.
- **brag's SFX library** (`brag` → `assets/sfx/`, ~260 CC0 sounds: impact,
  interface, ui, casino, keyboard) with `sfx-analysis.md` rating each for
  harshness — prefer these over synthesized SFX for realism.
- `hf beats` — measures the beat grid of any song. It can report double
  time (e.g. 220 for a 110 BPM track): check against the cue map or halve
  it, and use every other beat, or the whole edit runs twice too fast.
- The HyperFrames SFX library (`media-use` → `audio/assets/sfx/`, 21 files)
  and HeyGen retrieval when signed in.
- `hyperframes-audio` skill — mixing, ducking, automation lanes.
- `music-to-video` workflow — when the **song itself is the product** (lyric
  video, music promo). Route there instead of this skill's flow.

## 1. Pick the music source (ask once, in the brief)

| Situation | Music |
|---|---|
| No music given, upbeat / launch / playful (default) | A brag track with its cue map; add brag SFX on the beat grid. |
| No music given, needs a custom tempo, key, energy arc or exact length | Synthesize with `score-synth`. Say it is original and license-free. |
| User supplies a song they have rights to | Use it; measure its grid with `hf beats`; place brag SFX on that grid, or synth the hits (`"music": false` + `beatTimes`). |
| User wants a named commercial song | Explain you can't use it without a license; offer a synthesized bed "in the spirit of" its tempo and mood. |
| Narrated explainer | Quiet synthesized bed (`style: "minimal"` or low-energy `pulse`), ducked under the voice. |
| Silent-autoplay social cut | Still design sound (people unmute), but the picture must work muted. |

## 2. Choose tempo and style from the edit, not the other way round

| Video | BPM | Style | Scene length |
|---|---|---|---|
| 15s social teaser / hype | 124–132 | `pulse` | 2–4 beats |
| 30–60s launch film | 110–122 | `pulse` or `cinematic` | 4–8 beats |
| Premium / Apple-style reveal | 84–100 | `cinematic` | 1–2 bars |
| Explainer with narration | 90–104 | `minimal` | follows the voice |
| Long-form (2–5 min) | 88–110, may change per chapter | per chapter | phrases of 4–8 bars |

Beat length = 60 / BPM (120 BPM → 0.5s beat, 2s bar). **Make the total
length a whole number of bars** so the end card lands on a downbeat. A
bundled track fixes the tempo (~110 BPM, ~0.55s beat); pick BPM only when
synthesizing, and use the table's scene lengths in beats either way.

## 3a. Use a bundled track (default for upbeat videos)

1. Read the tracks' cue summaries (`brag` →
   `assets/music/cues/<track>.music-cues.md`): tempo, beat grid, strong cues
   and reveal candidates for the first ~25s. Pick the track whose energy fits.
2. Copy the chosen `.mp3` into the project's `audio/` (the composition only
   serves its own files).
3. Your beat grid is the cue map's `beats[].time` list (from the `.json`).
   Land the reveal on a strong cue; if the best section starts later, offset
   the track with `data-media-start="<seconds>"` and subtract that offset
   from every cue time.
4. SFX: copy the chosen brag sounds (see `sfx-analysis.md` for the gentle
   ones) into `audio/sfx/` and give each its own `<audio>` at its beat time,
   or synthesize the hits instead with `score-synth` using `"music": false`
   and `"beatTimes"` set to the cue map's beats.
5. Credit if there's room (optional): "Music by Sascha Ende at ende.app".

## 3b. Write a synthesized score (custom tempo, arc or length)

`score.json` in the project (`audio/score.json`):

```json
{
  "bpm": 120, "duration": 30, "seed": 1, "style": "pulse",
  "chords": ["Am", "F", "C", "G"],
  "sections": [
    { "name": "hook",  "from": 0,  "energy": 0.5 },
    { "name": "build", "from": 4,  "energy": 0.7 },
    { "name": "break", "from": 16, "energy": 0.1 },
    { "name": "drop",  "from": 18, "energy": 1.0 },
    { "name": "end",   "from": 26, "energy": 0.3 }
  ],
  "hits": [
    { "t": 0,  "sfx": "impact" },
    { "beat": 8, "sfx": "whoosh" },
    { "bar": 9, "sfx": "riser" },
    { "t": 26, "sfx": "sting" }
  ]
}
```

- **Sections = energy arc.** Match the story: hook (0.5) → build (0.6–0.8)
  → short break (≤ 0.2, 1–2 beats of air before the reveal) → drop (1.0) on
  the product reveal → resolve (0.3) under the end card.
- An energy jump of ≥ 0.35 automatically gets a riser into it and an impact
  on it. Don't also hand-place those.
- `chords`: minor progressions feel tense/premium, major feel bright. Omit to
  derive from `key` + `scale`.
- `hits` accept `t` (seconds), `beat` (0-based beat index) or `bar` (0-based).
  A `riser`/`swell` *arrives* at its time.
- SFX vocabulary: `whoosh`, `whoosh-short`, `riser`, `impact`, `sub-drop`,
  `pop`, `click`, `tick`, `snap`, `glitch`, `shimmer`, `sting`, `swell`,
  `typing`. Optional `gain` (0–2) and `pan` (−1..1).

Render: `<node> "<motion bin>/score-synth.mjs" audio/score.json audio/`

For a supplied song: put it in the composition as music and run `hf beats`.
Place brag SFX on its beat times (as in 3a step 4), or synthesize the hits:
copy the `time` values from `beats/<file>.json` into `"beatTimes"` and set
`"music": false`.

## 4. Map every on-screen action to a sound

Write this table into `STORYBOARD.md` before building, one row per event:

| On screen | Sound | Timing |
|---|---|---|
| Scene cut | nothing, or `whoosh-short` on fast pushes | on a beat (downbeat for big cuts) |
| Product / logo reveal | `impact` (+ the drop) | downbeat |
| UI element appears | `pop` (soft) | on the beat or the "and" |
| Button press / cursor click | `click` | the exact frame of contact |
| Number counts up | `tick`s, then `snap` on the final value | final value on a beat |
| Text types on | `typing` | spans the typing |
| Error / chaos beat | `glitch` | on the beat |
| Sparkle / success | `shimmer` | just after the action |
| Final CTA / end card | `sting` | last downbeat, then hold |

Restraint: at most one prominent SFX per beat; leave some beats silent. A
sound on literally everything is noise.

## 5. Build the picture on the grid

- Time every scene start and key animation from the beat grid, never
  hand-typed seconds: the cue map's `beats[].time` for a bundled track,
  `hf beats` for a supplied song, or `tempo-map.json` (`beats` / `bars`)
  for a synthesized score.
- Cuts on beats; big moments on bar downbeats; micro-motions (pops, ticks)
  on beats or eighths. Motion that *lands* (the end of an ease) should hit the
  beat — start the tween `duration` earlier.
- The break before the drop is a held, near-still frame. The drop is the
  single biggest visual change in the video.

## 6. Wire the audio into the composition

```html
<!-- synthesized score -->
<audio id="music" data-timeline-role="music" src="audio/music.wav"
       data-start="0" data-track-index="20" data-volume="0.55"></audio>
<audio id="sfx" src="audio/sfx.wav"
       data-start="0" data-track-index="21" data-volume="0.9"></audio>

<!-- bundled track + individual SFX -->
<audio id="music" data-timeline-role="music" src="audio/<track>.mp3"
       data-start="0" data-media-start="0" data-duration="20"
       data-track-index="20" data-volume="0.55"></audio>
<audio id="sfx-reveal" src="audio/sfx/impactSoft_medium_001.ogg"
       data-start="8.73" data-duration="0.5" data-track-index="21"></audio>
```

Fade a bundled track out over the last 1–2s (a `data-automation` volume
lane) so it doesn't stop mid-phrase.

Every `<audio>` needs an `id` or it is silently dropped. With narration,
duck the music under speech with a `data-automation` volume lane
(`hyperframes-audio` → "Voiceover carve"): music ~0.55 → ~0.2 while the
voice speaks, back up in gaps.

## 6b. Hand the music to a HyperFrames workflow

`product-launch-video`, `faceless-explainer` and `pr-to-video` have their own
audio step (`scripts/audio.mjs`). It only fetches music from HeyGen's library
when the user is signed in to HeyGen; otherwise their videos get no music.
They all assemble from `audio_meta.json`, so give them the shared track:

1. Let their audio steps run as written (narration, `fetch-sfx`) — both
   **rewrite** `audio_meta.json`.
2. Then, right before their `assemble-index.mjs` step, copy the chosen track
   into the project (`assets/bgm/<track>.mp3`) and set
   `"bgm": { "path": "assets/bgm/<track>.mp3" }` in `audio_meta.json`,
   keeping its `voices`. Leave `volume` out: assembly then uses the
   workflow's own levels (0.12 under narration, 0.9 without).
3. SFX there are cued per frame: add entries to `"sfx"` as
   `{ "frame": <n>, "file": "assets/sfx/<name>.ogg", "offset_s": <seconds into
   that frame>, "duration_s": 1, "volume": 0.35 }` after copying the files in.
4. Their frame durations come from the storyboard, so set scene lengths in
   beats of the chosen track (§ 2) when writing `STORYBOARD.md`.

If the user is signed in to HeyGen and prefers its catalog, let the workflow's
own BGM stand. For hand-built compositions (brag, `general-video`,
`motion-graphics`, long-form chapters) wire `<audio>` directly as in § 6.

## 7. Mix check

`video-qa` Gate 4 measures the mix (loudness, peaks, voice over music).
Fix levels with `data-volume`, not by editing audio files. Re-run
`score-synth` only when the arrangement itself changes.
