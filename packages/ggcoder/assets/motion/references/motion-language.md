# Motion language

Use this for every video you design. The user's brand kit, references or a
chosen library look override any default below. These are principles, not a
house look. Choose the concept, palette and type fresh for every video; never
copy an earlier video's.

## The bar

Make a showcase piece, as if the best motion designers will judge it frame by
frame. Ambition means deliberate craft, not length or effect count. Every
colour, word, cut and ease needs a reason. Cut generic defaults: plain fades,
slowly drifting gradients, text that slides up and sits there.

## Plan first

Before writing code, decide these and record them in the `Concept` and
`Language` lines of `frame.md`. A few lines is enough; nobody approves them.

- **Concept**: the idea the video demonstrates, in one sentence. Show it; don't
  just state it.
- **Motif**: one shape or element that recurs and links every scene.
- **Palette**: each colour's role.
- **Type**: each family's role.
- **Beat**: tempo, arc and frame rate.

## Principles

**Continuity.** Each scene hands something to the next: a shape, a word, a
colour field or a camera move. Prefer match cuts and shape handoffs to
cross-fades. The `type-as-spatial-handoff` study in [README.md](README.md) shows
type becoming the next scene.

**Palette.** At most four flat colours: a dark neutral, a light neutral, one
saturated hero colour and one bright accent used sparingly. Derive them from
the brand or subject. Full-frame colour blocks that change on most cuts carry
energy; gradients and glows are seasoning, not the base. Keep text readable.

**Type.** One heavy display family, set huge: hero words around 250–360 px at
1080p, one to three words per shot. Keep any explanatory line short. Animate
weight and width axes as motion, not only position and opacity. Add at most one
contrasting voice, such as an italic serif, plus small uppercase tracked mono
for labels and UI. Bundled axes (see `fonts.mjs list` and its specimen): weight
and width in Mona Sans, Hubot Sans, Anybody, Archivo, Bricolage Grotesque and
Martian Mono; italics in Fraunces and Newsreader. Brand fonts win.

**Motion.** Entrances `expo.out`; exits `power3.in`; moves `expo.inOut` or
`power3.inOut`; pops `back.out`; settles `elastic.out`, sparingly. Most
durations 0.12–0.7 s; staggers 0.012–0.06 s. Use real animation principles
where they help: anticipation before big moves, squash and stretch on impact,
arcs instead of straight paths, overlapping action, follow-through and smears on
fast moves. Every move starts, travels and lands on purpose; nothing drifts. For
calm or luxury subjects, lengthen durations and soften eases, and stay just as
deliberate.

**Pace.** Cut on a beat grid even without music: 0.5 s at 120 BPM by default,
or the track's beats (`hf beats`) when there is music. For a short promo: a slow
opening, a fast-cut middle, one showpiece moment, a climax such as a
convergence or particle burst, then an end card held about 2 s. Declare that
hold in the hold plan before checking.

**3D, when the subject earns it.** One hero object with a physical material
(clearcoat or iridescent) and environment lighting; a few supporting elements
such as orbiting rings, trails or sparse debris; a soft coloured glow; a
cinematic camera move such as an orbit or dolly zoom. Resolve 3D back to flat 2D
to hand off to the next scene. Use the bundled Three.js (`three.mjs`); no 3D by
default.

**Chrome, when it suits.** A small persistent mono layer (labels, timecode,
chapter name, a progress bar with markers) makes a tech subject feel like a pro
tool. Leave it out elsewhere.

**Frame rate.** 60 fps for fast, dense motion, where smears and quick cuts read
cleaner; 30 fps for calmer pieces. 60 fps doubles render time.

**Truth.** Show only real product UI, numbers and claims from the user's
sources.

## Building blocks

Library looks (`library.mjs list looks`) are complete palette, type and rhythm
systems; when one fits the concept, it replaces the palette and type defaults
above. Library pieces are optional building blocks.

## Check against the plan

When `motion_check` returns frames, compare them with the plan in `frame.md` as
well as the technical results. A lost motif, an off-palette colour, a generic
transition or unreadable type is a concrete defect: fix it and check the new
render.
