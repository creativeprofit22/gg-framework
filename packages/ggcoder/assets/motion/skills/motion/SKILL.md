---
name: motion
description: GG Motion's entry point. Read first for EVERY request in Motion mode — new video, edit, resume, render, or "make something from this". Routes the request to the right skills and workflow, and lists the GG rules that override bundled HyperFrames and brag skills.
---

# GG Motion — start here

The system prompt has the pipeline, the ask_user checkpoints, the exact `hf`
command and the shared audio paths. This skill adds what it doesn't: where to
start, which skill builds each kind of video, and how bundled third-party
skills behave inside GG.

## 1. Resume or start

In the Motion workspace, look for existing video projects
(`*/hyperframes.json`, `*/BRIEF.md`, `*/STORYBOARD.md`).

- **Edit to an existing video:** `cd` into it, apply the change as Director
  Notes (`motion-direction` § 9), then `video-qa`.
- **Long-form film in progress:** read its `PRODUCTION.md` first and continue
  from "Next".
- **New video:** create a folder named with a short kebab-case slug of the
  subject, then follow the system prompt's pipeline.

## 2. Route by video type

| Request | Plan with | Build with |
|---|---|---|
| Launch, promo, product/feature video, teaser, UI loop, stat card, launch kit | `launch-video` | `product-launch-video` (loops/stat cards: `motion-graphics`) |
| Longer than ~90s, chapters, documentary, lesson, YouTube explainer | `long-form` | `general-video` or `faceless-explainer` |
| A code repo (URL, `owner/repo`, local folder): OSS launch, README explainer, architecture, release | `repo-video` | `general-video` / `faceless-explainer` with code-editorial blocks |
| A single pull request | — | `pr-to-video` |
| "/brag", "brag about this", or a quick 15–25s share trailer for something they built | — | `brag` (on Opus 5.5 it hands off to `brag-slim`) |
| Short explainer from a doc/PDF/topic (< 90s) | — | `faceless-explainer` |
| Song-driven (lyric video, music promo) | — | `music-to-video` |
| Anything else / unclear | — | `hyperframes` router |

Whatever builds the video, finish with `video-qa` (load it) before
delivering. Bundled workflows' own validate/deliver steps do not measure
loudness or check the phone view.

Every workflow also gets the craft layer while it plans and builds: load
`style-library` (inspect candidates; reuse, adapt or derive within one resolved
visual system), `visual-toolkit` (catalog, signature moments, motion physics)
and `type-system` (unresolved type roles) before the storyboard, including inside brag and the HyperFrames
workflows. Load `motion-3d` when a shot is built in 3D,
and `component-import` when the user shares a component.

Load `reference-style` whenever the user names or shares a style to match.
Feed the build workflow the brief you already wrote — do not re-ask what it
answers. HyperFrames workflows end their interview with `BRIEF.md`; merge
your facts in.

## Design authority across every workflow

The system prompt's design priority order applies regardless of which skills
were loaded last. `frame.md` is the resolved design contract; `style-library`
owns its format and the scene-level reuse / adapt / derive records. Approve
them at the existing storyboard checkpoint. Read them on resume and send both
to every scene worker, including workflows that generate frame packets.

Workflow skills own production steps, not a second art direction. If a preset
step (such as `build-frame.mjs`) would replace an approved `frame.md`, skip
that regeneration and preserve the required design-spec schema. Caption skins,
frame packets and other supporting artifacts must inherit the same contract;
if a workflow requires one, produce or adapt it without replacing the design.
Resolve accepted STYLE.md references into the contract rather than keeping two
competing visual authorities. `video-qa` checks implementation against the
contract and scene records; it may not introduce a new style to raise a score.

## 3. GG rules for bundled HyperFrames skills

HyperFrames skills were written for many hosts. The system prompt's rules
(the `hf` command, brand kit first, shared audio) win over anything they say.
In addition:

1. **Installed and pinned:** skip every step that installs, refreshes,
   updates or upgrades skills or the CLI (`skills update`, `skills add`,
   "Keep the project's CLI current", `upgrade`). To use another workflow,
   load it with the `skill` tool. HyperFrames runs as a release-managed
   plugin (`hyperframes` → `references/plugin-installation.md`).
2. **Scaffolding:** `hf init <name> --non-interactive --example blank`,
   unless a template fits. `init` writes `index.html`; read it before
   replacing it (the write tool refuses unread files). Its placeholder
   Inter font is not an approved choice: apply the resolved `frame.md` font
   roles, using `type-system` only for unresolved roles. Keep Inter when it
   is the required brand font.
3. **Catalog:** `hf catalog` / `hf add` are installed and offline; use them
   (`visual-toolkit` § 1). `hf add` never touches the user's clipboard.
4. **Fonts:** approved `frame.md` roles and required brand fonts win.
   `type-system` fills unresolved roles before approval, preferring the chosen
   look's type. It replaces unapproved defaults from workflow presets and
   `hyperframes-creative` → `references/typography.md`; pairing guidance
   applies only when compatible with the contract.

## 4. GG rules for brag

`brag` / `brag-slim` (latent-spaces/brag) are one-shot by design. In Motion:

- **Checkpoints still apply:** confirm angle + tone (offer brag's tone
  presets as options) and approve the stills before the full render. Skip to
  the render only if the user said "just brag it" or "no questions".
- **Output** goes in the video project folder in the Motion workspace, not
  in the user's own repo, unless they ask.
- **Timing:** brag's fast-trailer reading rule (~0.3s per word) replaces
  `motion-direction`'s general one for brag videos only.
- **Cue analysis:** `analyze_music_cues.py` needs Python + uv. Ask before
  installing; otherwise use the bundled cue maps or `hf beats`.

## Project layout (per video)

```
<video-slug>/
  hyperframes.json, index.html, compositions/   (HyperFrames project)
  brief.md, BRIEF.md, STORYBOARD.md, frame.md, STYLE.md, REVIEW.md
  DIRECTOR.md, FACTS.md, ANIMATION_GUIDE.md, PRODUCTION.md   (long-form)
  audio/  sources/  assets/  snapshots/  renders/
```

Brand kits live at the workspace root in `brand-kits/<kit-slug>/`.
