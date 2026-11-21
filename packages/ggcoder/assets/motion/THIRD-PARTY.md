# Third-party content in GG Motion

Motion exposes GG-authored skills and craft references. The old upstream
creative/workflow skills and guidance adapters have been removed. Retained
technical references are adapted for GG's pinned launcher and local-only safety
boundaries; do not restore entire upstream skill folders when updating the
runtime.

| Component | Source | Pinned at | License |
|---|---|---|---|
| Adapted HyperFrames technical references (`references/runtime/`) and launcher | https://github.com/heygen-com/hyperframes | see `plugin.json` version | Apache-2.0 (`HYPERFRAMES-LICENSE`) |
| Shared audio/metadata retained from brag (`assets/music/`, `assets/sfx/`) | https://github.com/latent-spaces/brag | `c893c5ed52aed84e3e2ee56787de869fccdae6b0` (2026-09-24) | MIT for upstream code/docs (`BRAG-LICENSE`); media terms below |
| Three.js (`vendor/three/`) | https://github.com/mrdoob/three.js (npm `three`) | `0.181.2`, fetched by `scripts/fetch-motion-three.mjs` | MIT (`vendor/three/LICENSE`) |
| Style-library pieces marked MIT (`library/pieces/<id>/`) | Magic UI, https://github.com/magicuidesign/magicui | converted 2026-09-28; upstream file URL in each `meta.json` | MIT (`LICENSE` beside each piece) |
| Fonts (`fonts/<family>/`) | Google Fonts / https://github.com/google/fonts | fetched 2026-09-28 by `scripts/fetch-motion-fonts.mjs` | SIL OFL 1.1 (`OFL.txt` beside each family) |

## Content boundaries

Motion ships no templates derived from third-party After Effects or other
motion projects. The earlier Mixkit, Mobile Notification and Kinetic Text
reconstructions were removed on 2026-09-29 and are not part of any release.

Existing `references/index.json`, signal sources and compact temporal JPEGs are
GG studies, not private user videos or a universal style. They remain optional
implementation/reference assets, not a mandatory research workflow. Previews are
rendered offline by `scripts/build-motion-references.mjs`; existing library/font
licenses remain with their sources.

The Motion-only preference reader and review tool do not load Coder instructions.
Review remains bounded and tied to current source/render evidence. It checks the
video's plan and approved inputs, not a competing art direction, and does not
claim full playback or aesthetic certification from model image critique.

## Fonts

19 families, listed in `fonts/fonts.json`. Latin-subset variable woff2 as served
by Google Fonts, except Mona Sans, Hubot Sans, Short Stack and Finger Paint: they
carry OFL Reserved Font Names and ship as complete upstream fonts, recompressed
to woff2. Unbounded, Sora, Short Stack and Finger Paint were added 2026-09-29. `fonts.mjs add`
copies each family's `OFL.txt` into the video project with its font files.

## Shared audio retained from brag

- **Music** — `assets/music/*.mp3`: "Happy Beats / Business Moves" by Sascha Ende,
  https://ende.app. CC BY 4.0; commercial use allowed; attribution made voluntary
  by the author (https://ende.app/en/standard-license). Credit when there's room:
  "Music by Sascha Ende at ende.app". Never register this music with YouTube
  Content ID or similar systems, or release it unchanged as your own track.
  Cue maps and source credits remain beside the tracks.
- **Sound effects** — `assets/sfx/`: Kenney (https://kenney.nl) and "Keyboard
  Soundpack #1" by unicae_games (OpenGameArt). CC0 / public domain. Analysis and
  rating metadata remain beside these assets.
