# Installer art

Branded installer chrome for the macOS DMG and Windows NSIS setup, drawn from
the app's own art so it always matches: the "GG CODER" ASCII banner
(`src/AsciiLogo.tsx`), the critters (`src/critter-sprites.ts`), the meadow
terrain (`src/critter-terrain.ts`), and the theme's dark surface, white ink and
critter pink.

## Files

`build-pages.mjs` draws all three pages; there are no hand-edited sources.

| Page         | Rendered PNG                    | Final asset (`out/`)                     | Used by                     |
| ------------ | ------------------------------- | ---------------------------------------- | --------------------------- |
| DMG window   | `dmg-background.png` (1320×800) | `out/dmg-background.png`                 | macOS DMG window background |
| NSIS sidebar | `nsis-sidebar.png` (328×628)    | `out/nsis-sidebar.bmp` (164×314, 24-bit) | NSIS Welcome/Finish page    |
| NSIS header  | `nsis-header.png` (300×114)     | `out/nsis-header.bmp` (150×57, 24-bit)   | NSIS page header strip      |

`logo.png` is a copy of `src-tauri/icons/128x128@2x.png`, written by
`scripts/build-icons.mjs`.

The DMG is dark, but Finder always draws the icon labels in black (nothing can
recolour them), so `build-pages.mjs` paints a light name plate where each label
lands: Finder's 128pt icons sit centred at the `appPosition` /
`applicationFolderPosition` points, with 16pt labels just below.

The `out/` assets are committed and referenced from `src-tauri/tauri.conf.json`
(`bundle.macOS.dmg` + `bundle.windows.nsis`). The build does **not** regenerate
them — edit + regenerate only when the branding changes.

> Note: the repo's root `.gitignore` ignores `out/` globally, so these three
> files are tracked via `git add -f`. They stay tracked once committed, but if
> you ever re-create them from scratch, force-add again.

## Regenerating (two steps)

1. **Render the pages → PNG** (needs Playwright's Chromium). From the repo root:
   ```bash
   node_modules/.bin/tsx gg-app/installer/build-pages.mjs
   ```
   (`tsx` lets the script import the app's TypeScript art modules.)
2. **Convert PNG → final assets:**
   ```bash
   pnpm --filter gg-app installer:art
   ```
   `build-art.mjs` resizes each PNG to the exact dimensions and writes the DMG
   PNG + the two 24-bit BMPs (hand-packed, since neither sharp nor sips emits
   BMP). NSIS requires uncompressed 24-bit BMP.

## Why these formats

- **DMG** — `create-dmg` (what Tauri shells out to) takes a PNG background; we
  ship it at 2× (1320×800) so it stays crisp on retina. Icon drop-zones in the
  art line up with the `appPosition` (180,170) / `applicationFolderPosition`
  (480,170) macOS draws in the 660×400 window.
- **NSIS** — the Modern UI `MUI_WELCOMEFINISHPAGE_BITMAP` /
  `MUI_HEADERIMAGE_BITMAP` macros only accept uncompressed BMP.
