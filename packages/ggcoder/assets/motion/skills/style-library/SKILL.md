---
name: style-library
description: GG's curated, render-verified style library for Motion videos — complete LOOKS (art directions such as duotone broadcast, soft-light product ad, dark studio, swiss grid, editorial ink, terminal phosphor, acid poster, blueprint, data desk, sunlit consumer, mono luxe) and PIECES (seek-safe backgrounds, kinetic type, diagrams, data, UI, soft 3D, frames, transitions, textures) that all restyle from the look's design tokens, each with a preview image and contact sheets. Use at the start of every video to pick a look, and whenever a scene needs a background, type move, diagram, UI moment, 3D shot, transition or texture.
---

# Style library

A video looks designed when every frame follows one art direction. The
library gives you that direction (a **look**) plus building blocks
(**pieces**) that already obey it. Sources, fonts and preview images are
bundled locally; third-party pieces include their license notices. Pieces
read colors and fonts from the look's tokens, so they can be restyled
without rebuilding their animation. Verify contrast and fit after restyling.

Helper: `<node> "<motion bin>/library.mjs"` (below: `lib`). Every command
prints one JSON line.

## 1. Pick the look (storyboard step)

```bash
lib list looks          # every look + the path of a contact sheet of previews
lib show <look-id>      # its look.md, tokens, sample and preview paths
```

For a new, unresolved direction, `read` the looks contact sheet once and
shortlist 2–3 that fit the brief and brand. Show them at the concept checkpoint
(their preview images, named in plain words). If none fits, propose a custom
brand/reference-led direction instead; do not force a preset. If direction
is already approved, keep it and inspect only relevant pieces.
When using a library look, read its `look.md`: it is
the art direction for palette, type, background and framing, motion rhythm,
what to avoid, and scene recipes. Follow it.

Brand fit: keep the look's structure and swap its token values for the
brand kit's colors (keep the contrast pair: one field, one ink) and, if the
brand has a real display face, `--display`. Don't mix two looks in one
video.

```bash
lib look . <look-id>
```

Installs the look's tokens (`assets/looks/<id>.css`) and fonts. Link both in
`<head>`, add `class="look-<id>"` to the root composition element, and
override token values there for the brand.

## Design contract: resolve once in frame.md

Before the storyboard, merge the chosen look, required brand/product fidelity
and accepted reference direction into the existing `frame.md`. Preserve the
HyperFrames design-spec frontmatter/schema; put the following in prose under
`## Approved design contract` (mark **draft** until the user approves the
storyboard). Keep frontmatter tokens and installed look CSS consistent.

- **Status and evidence:** draft or approved, with the user decision that
  approved it; never infer approval from the file merely existing.
- **Sources:** look ID, brand-kit path and accepted reference/STYLE.md path.
- **Resolved system:** palette and paired ink/fills; display/body/UI/mono roles;
  type scale; spacing, safe area and alignment; borders, radius, shadows,
  materials and icon treatment. State brand overrides explicitly.
- **Motion:** easing, entrance/exit behaviour, timing range and transitions.
- **Exclusions:** what this video deliberately does not use (for example,
  no grain, no gradients, no 3D, no decorative labels). Generic craft advice
  does not override these exclusions.
- **Fidelity and exceptions:** real product UI/assets that must remain accurate,
  and any explicitly approved scene-specific exception.

Approve this with the existing storyboard checkpoint, not another interview.
Read it on resume. For an existing approved video, preserve its design and
backfill from its files/approved frames rather than forcing a library look.
A required brand face stays, even if a typography skill calls it generic.
A later skill supplies techniques, not a fresh art direction. Do not run a
workflow preset generator over an approved contract. Update tokens, contract
and affected scenes together only when the user's direction changes.

## 2. Build scenes from pieces

```bash
lib list pieces --kind background   # also: type, diagram, data, ui, 3d, frame, transition, texture
lib search "typing caption"         # ranked by name, tags and description
lib add . <piece-id> [<piece-id>...]
```

`list` returns a contact sheet per kind: `read` it to compare options in one
image. `add` copies each piece to `compositions/<id>.html` (never
overwriting one you already edited; `--force` to replace), installs fonts,
copies MIT license notices and appends credits to `CREDITS.md`. It prints
the `<div>` to mount each piece as a sub-composition. 3D pieces also print an
importmap for the bundled Three.js: put it in `index.html` `<head>`.

Each piece's header comment documents its parameters (CSS variables and
top-of-script constants) and marks editable copy with `<!-- edit -->`. Edit
the copy, data and timing for this video. Never edit colors or fonts inside
a piece: change the look's tokens instead. Library brands, prices, metrics,
quotes and attributions are illustrative sample content, not verified facts.
Replace them with user-supplied or verified material before publishing; never
present sample claims as evidence or testimonials.

Layering: background piece (track 0) → subject pieces (type, UI, diagram,
3D) → frame/texture overlays on top. Set each piece's `data-start` and
`data-duration` from the storyboard's beat grid.

### Record reuse / adapt / derive for every scene

Search our library first, then the HyperFrames catalog when needed. Read the
candidate source and preview before choosing; a familiar name is not evidence
of fit. Add this record inside each scene's existing storyboard block (do not
replace the workflow's scene schema or create a second storyboard):

- **Decision:** reuse / adapt / derive (per major element if mixed).
- **Source:** library/catalog ID and installed file, supplied component path,
  or `custom from frame.md` plus candidates inspected and why none fit.
- **Reason:** the scene's job and why this implementation serves it.
- **Keep / change:** inherited design rules and the deliberate modifications.
- **Verification:** hero/transition timestamps to inspect; after building,
  record actual source files and deviations so QA can compare plan to output.

**Reuse:** install the suitable piece; change its copy, data and timing.
**Adapt:** start from that code, retaining useful structure while changing
layout or behaviour to suit the scene and the approved contract.
**Derive:** build a new element from the approved design rules or a relevant
reference component. Derivation is appropriate when the needed element is
absent or adapting a candidate would discard its useful structure. Do not
rebuild a fitting piece just to make it original; do not force an unrelated
piece merely because it exists. For example, a search bar can inform a filter panel's
spacing, radius, border, type, icons, shadow and motion without copying its
search-specific markup. Record those inherited rules, not just "same vibe".
Copied code still needs its license/credits. Do not modify bundled originals;
work on installed project copies and preserve the user's edits.

Prefer a fitting reuse or adaptation over a redundant rebuild, but never
force a poor-fit piece or invent product UI in place of an accurate capture.
Custom diagrams, layouts and signature moments are welcome within `frame.md`.
Pass this scene record and the approved contract to every scene worker;
workers must not choose another look or alter the contract.

## 3. When the library doesn't have it

Search the HyperFrames catalog (`visual-toolkit` § 1), build it in 3D
(`motion-3d`), import a component the user brings (`component-import`), or
write it by hand. For hand-written scenes, follow the same contract: read
colors and fonts from the look's tokens, scope styles to the composition,
and keep everything a pure function of timeline time.

## 4. Rules

- One resolved visual system per video, chosen before the storyboard is locked.
  It may be a library look with explicit brand overrides or a custom system.
  For a custom system, define shared project tokens in `frame.md` and CSS;
  map installed pieces to those tokens rather than styling each independently.
- Library pieces are verified in isolation. Always check the composed scene
  with `hf snapshot` (layering and spacing between pieces are yours).
- A piece's preview shows its best frame; its motion is in the timeline,
  so scrub the snapshot times around its beats before judging it.
