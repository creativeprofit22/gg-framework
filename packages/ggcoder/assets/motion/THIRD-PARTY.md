# Third-party content in GG Motion

Bundled verbatim; update by replacing the folders from the pinned upstream
commit and re-running the Motion tests.

| Component | Source | Pinned at | License |
|---|---|---|---|
| HyperFrames skills (`skills/hyperframes*`, workflows, `media-use`) | https://github.com/heygen-com/hyperframes | see `plugin.json` version | Apache-2.0 (`HYPERFRAMES-LICENSE`) |
| brag, brag-slim (`skills/brag`, `skills/brag-slim`) | https://github.com/latent-spaces/brag | `c893c5ed52aed84e3e2ee56787de869fccdae6b0` (2026-09-24) | MIT (`BRAG-LICENSE`) |
| Three.js (`vendor/three/`) | https://github.com/mrdoob/three.js (npm `three`) | `0.181.2`, fetched by `scripts/fetch-motion-three.mjs` | MIT (`vendor/three/LICENSE`) |
| Style-library pieces marked MIT (`library/pieces/<id>/`) | Magic UI, https://github.com/magicuidesign/magicui | converted 2026-09-28; upstream file URL in each `meta.json` | MIT (`LICENSE` beside each piece) |
| Fonts (`fonts/<family>/`) | Google Fonts / https://github.com/google/fonts | fetched 2026-09-28 by `scripts/fetch-motion-fonts.mjs` | SIL OFL 1.1 (`OFL.txt` beside each family) |

## Fonts

15 families, listed in `fonts/fonts.json`. Latin-subset variable woff2 as
served by Google Fonts, except Mona Sans and Hubot Sans: they carry OFL
Reserved Font Names, so they ship as the complete upstream font, only
recompressed to woff2. `fonts.mjs add` copies each family's `OFL.txt` into
the video project with the font files.

## Audio bundled with brag

- **Music** — `skills/brag/assets/music/*.mp3`: "Happy Beats / Business Moves"
  by Sascha Ende, https://ende.app. CC BY 4.0; commercial use allowed; the
  author has made attribution voluntary
  (https://ende.app/en/standard-license). Credit when there's room:
  "Music by Sascha Ende at ende.app". Condition: never register this music
  with YouTube Content ID or similar systems, and don't release it unchanged
  as your own track.
- **Sound effects** — `skills/brag/assets/sfx/`: Kenney (https://kenney.nl)
  and "Keyboard Soundpack #1" by unicae_games (OpenGameArt). CC0 / public
  domain.
