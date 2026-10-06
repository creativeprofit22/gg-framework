# Slop Tells and Replacement Moves

## Contents

1. How to use this list
2. Composition tells
3. Colour, type, and surface tells
4. Content and copy tells
5. Motion and interaction tells
6. Craft regressions
7. Calibration: the default clusters
8. Final slop review

## 1. How to use this list

A tell is not a ban. It is a choice that appears whatever the subject, so it signals "nobody decided this". Where the user's brief or the existing product pins down a direction, follow it exactly, even if it matches a tell. Where an axis is free, do not spend it on a tell.

For each tell found in a plan or render, apply the replacement move, or keep it only if the "Keep when" condition holds and you write one sentence: **"This belongs because…"** naming the product, audience, or content reason. "Modern", "premium", "clean", "engaging", or "on brand" is not a reason.

Run the list twice: on the written design thesis before code, and on desktop + mobile screenshots after.

## 2. Composition tells

| Tell                                                                                                       | Replacement move                                                                                                                                                                                  | Keep when                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Centered gradient hero: oversized centered headline, violet/blue glow, two CTAs, floating screenshot below | Open with the most characteristic thing in the subject's world: real product state, real data, a working demo, a strong photograph, or a plain typographic claim. Choose alignment after content. | The brand owns the gradient/light, the page has one conversion job, and the centered pause serves the narrative. |
| Three equal icon-title-copy feature cards                                                                  | Rank the content; give the main point more space; show the feature working; use a list or table for true peers.                                                                                   | Exactly three peer choices exist and comparison is the task.                                                     |
| Bento grid by default                                                                                      | Map module size to priority and reading order; use a sequence or list otherwise.                                                                                                                  | A genuine overview of heterogeneous modules that users scan or rearrange.                                        |
| SaaS card kit: everything in identical rounded cards, one radius, same soft grey shadow                    | Group with whitespace and alignment. Containers only for real objects (selectable, draggable, separate records). Radius varies by role.                                                           | The items really are separate records.                                                                           |
| Decorative eyebrow: tracked ALL-CAPS or mono label above every heading                                     | Delete it.                                                                                                                                                                                        | It names real taxonomy, step, status, or technical context.                                                      |
| Numbered markers (01 / 02 / 03) on non-sequential content                                                  | Remove numbers.                                                                                                                                                                                   | The content is a real sequence: steps, timeline, ranking.                                                        |
| Big-number stat strip ("10x faster", "99.9%", "50k+")                                                      | Show a sourced metric with unit, time frame, and consequence, or remove it.                                                                                                                       | The metric is auditable and central to the screen's decision.                                                    |
| Floating tilted screenshot or fake dashboard mockup                                                        | Real UI at readable scale, cropped to the part that proves the adjacent claim.                                                                                                                    | Spatial overview matters, the image is current, perspective hides nothing.                                       |
| Fake terminal or code theatre                                                                              | Real, copyable, versioned commands and output, or ordinary product evidence.                                                                                                                      | The user's task is genuinely code/CLI.                                                                           |
| Pills everywhere: nav, buttons, filters, badges, inputs                                                    | Pills for toggles/tags only; a small radius vocabulary elsewhere.                                                                                                                                 | The product already uses a capsule motif deliberately.                                                           |
| Icon medallion: line icon in the same tinted square above every section                                    | Remove icons that repeat the heading.                                                                                                                                                             | Icons speed navigation, status scanning, or a real category system.                                              |
| Logo wall of invented or unlicensed customers                                                              | Real, permitted logos, or no social proof.                                                                                                                                                        | Supplied and approved.                                                                                           |

## 3. Colour, type, and surface tells

| Tell                                                                                                                       | Replacement move                                                                                                                                   | Keep when                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Purple/indigo/violet gradient as the default brand; Tailwind `indigo-500`/`violet-600` primary                             | Derive the hue from the subject, materials, or existing brand; build an OKLCH ramp (`references/direction.md` § Colour).                           | The existing brand is that hue.                                                                               |
| Out-of-box shadcn/Tailwind look: `slate`/`zinc` greys, `rounded-lg` everywhere, `ring-2 ring-offset-2`, default button set | Keep primitives for behaviour; restyle tokens: neutrals tinted toward the brand hue, a deliberate radius scale, the project's own focus treatment. | The project already ships that look; then preserve it.                                                        |
| Inter, Geist, or bare `system-ui` as the whole aesthetic; Arial/Helvetica by neglect                                       | Choose a family or pairing for this subject (`references/direction.md` § Type).                                                                    | The existing system uses it, native fidelity is the goal, webfonts are prohibited, or it is dense app chrome. |
| One headline word accented in gradient, italic, or colour                                                                  | Let the whole headline carry the treatment, or make emphasis carry meaning (a value, a name).                                                      | The accented word is data.                                                                                    |
| Glass cards: blurred translucent panels over colour blobs                                                                  | One clear material model (flat, tonal, bordered, or measured elevation), one reason per layer.                                                     | Content sits over live media/map/video, or translucency is the local platform material.                       |
| Dark equals premium; near-black `#0B0B0B`/`#111` with one acid-green or vermilion accent                                   | Choose theme from environment, task duration, and media. If dark, tune OKLCH neutrals and measure contrast in both themes.                         | Media needs darkness, low-light use, or a tested dark-first brand.                                            |
| Warm cream (~~`#F4F1EA`) + high-contrast serif + terracotta (~~`#D97757`)                                                  | Anthropic names this its own Claude-interaction look; on a user's brief it reads as a tell. Choose another direction.                              | The brief asks for it.                                                                                        |
| Broadsheet pastiche: hairline rules, zero radius, dense columns                                                            | Editorial structure only for editorial content.                                                                                                    | The surface is editorial.                                                                                     |
| Soft semantic tint-on-tint (low-opacity hue bg + same-hue text/icon/border)                                                | `references/craft-rulings.md` § No soft semantic tint-on-tint. This one is a binding default, not a style preference.                              | The user requests it or scope requires reusing an existing variant.                                           |
| Huge type (96–160px) as the only idea                                                                                      | Build contrast from wording, measure, weight, width, and placement before size.                                                                    | Campaign/editorial, short phrase, localization tested, type is the signature.                                 |
| Monospace for small data labels by reflex                                                                                  | Mono only for code and IDs; tabular numerals of the body face for figures.                                                                         | Technical context the user reads as code.                                                                     |

## 4. Content and copy tells

| Tell                                                                                                   | Replacement move                                                                                                     | Keep when                                                                           |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Lorem ipsum or "Feature one / Feature two" in review                                                   | Write real copy first (content-first rule in SKILL.md).                                                              | Never in review; label fixtures as fixtures.                                        |
| Fake metrics, testimonials, ratings, avatars, customer names, precise business data                    | Real content, or plainly labelled example data, or omit.                                                             | The user supplies approved fixtures or asks for a clearly marked prototype dataset. |
| Generic CTAs: "Get started", "Learn more", "Submit", "Unlock the power of…"                            | Name the outcome ("Create invoice", "Book a table"). Keep the verb through the flow ("Publish" → toast "Published"). | Never as a default.                                                                 |
| Hype voice: "seamless", "effortless", "supercharge", "next-level", "revolutionize"                     | Say what it does in the user's own words.                                                                            | Supplied brand copy.                                                                |
| Middle-dot meta strings, `WORD — fragment` labels, `→` on every link                                   | Plain sentence-case labels; arrows only where direction is literal.                                                  | Supplied copy.                                                                      |
| Emoji as icons, bullets, status, empty-state art                                                       | One coherent icon family (`references/craft-rulings.md` § 1).                                                        | Requested, or emoji is the content itself.                                          |
| Placeholder illustration: blob people, abstract 3D shapes, generic stock, unrelated generated hero art | Real product imagery, photography, data, or no image.                                                                | Requested and appropriate to the subject.                                           |
| Subtitle under every heading restating it                                                              | `references/craft-rulings.md` § Copy must earn its space.                                                            | It adds information needed here.                                                    |
| Em dashes in UI copy                                                                                   | Full stop, comma, colon, parentheses, or two sentences.                                                              | Requested, or exact supplied/quoted/legal copy.                                     |
| Apologetic or vague errors ("Oops! Something went wrong")                                              | Say what happened and how to fix it; no apology.                                                                     | Never.                                                                              |

## 5. Motion and interaction tells

| Tell                                                                               | Replacement move                                                                                            | Keep when                                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Fade-and-slide-up on every section as it scrolls in                                | At most one orchestrated moment; content readable with motion off.                                          | A single deliberate narrative beat.                                  |
| Hover lift, bob, or scale on every card/button                                     | Colour, border, underline, icon-fill, opacity, or restrained shadow; stable geometry.                       | Movement communicates real drag, depth, or direct manipulation.      |
| Ambient perpetual motion: particles, gradient drift, marquees, auto-rotating cards | Still resting screen; animate state change only. Pause control if > 5 s.                                    | Motion is the content (audio, time, live activity) and works paused. |
| `transition: all`                                                                  | Name properties; shared duration/easing tokens.                                                             | Never.                                                               |
| Abrupt state swaps; layout shift on load                                           | Short transitions on interpolable properties; skeletons matching final geometry; focus visible immediately. | Reduced motion or urgent feedback needs an instant change.           |
| Whole card clickable with nested buttons                                           | One link target per card, or explicit buttons; never nested interactive elements.                           | Never.                                                               |

## 6. Craft regressions

Treat each as a tell when found in a render; fixes live in `references/craft-rulings.md`:

- accidental misalignment and drifting content rails;
- a local button, modal, card, status colour, or focus ring duplicating an existing primitive with slightly different values;
- mixed icon families (package icons, hand-drawn SVG, text glyphs together);
- sticky pointer focus, stacked focus rings, edge-hugging dropdown chevrons.

## 7. Calibration: the default clusters

Generated UI clusters into a few looks that appear whatever the subject (SNAPSHOT/DEDUCED; sources in `references/provenance.md` § Slop-tell sources). Recognise them in your own plan:

1. Purple-to-blue SaaS: centered hero, glow, Inter, three feature cards, logo wall, three-tier pricing.
2. shadcn default: zinc greys, `rounded-lg` cards, outline buttons, four KPI cards over a line chart.
3. Dark "premium": near-black, one neon accent, glass cards, grid-line background, mono labels.
4. Warm editorial: cream, serif display, terracotta accent, hairline rules.
5. Template chrome: ALL-CAPS eyebrows, middle-dot meta, `→` on links, emoji section markers.

Ask: "Would I produce this same plan for a neighbouring product?" If yes, change the most transferable axis (usually colour, type, or hero composition) and state what changed and why.

## 8. Final slop review

On the rendered desktop and mobile screenshots:

1. Cover the logo and accent colour. Can you still name the product and task?
2. Does any tell from §§ 2–5 remain without a "This belongs because…" sentence?
3. Is every number, quote, and logo traceable to real content or labelled as a fixture?
4. Is there exactly one memorable device, with everything around it quiet, and does it survive mobile without clutter?
5. Remove one decorative element. If the screen did not get worse, leave it removed.
