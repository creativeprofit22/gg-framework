# Motion language

Use this for every video you design. The user's brand kit, references or a
chosen library look override any default below. These are principles, not a
house look. Choose the concept, palette and type fresh for every video; never
copy an earlier video's.

## The bar

Make a showcase piece, as if the best motion designers will judge it frame by
frame. Ambition means deliberate craft, not length or effect count. Every
colour, word, cut and ease needs a reason. Cut generic defaults: plain fades,
slowly drifting gradients, text that slides up and sits there. Judge it as the
kind of video it is: an explainer by how clearly it teaches, a tribute by how
it honours its subject, a launch by how it makes people want the product.

## Plan first

Before writing code, decide these and record them in the `Concept` and
`Language` lines of `frame.md`. A few lines is enough; nobody approves them.

- **Concept**: the idea the video demonstrates, in one sentence. Show it; don't
  just state it.
- **Motif**: one shape or element that recurs and links every scene.
- **Register**: the tone (calm, playful, urgent, tender, precise…) and what it
  means for size, speed, easing and colour. Take it from the brief, the brand
  and the viewing context.
- **Palette**: each colour's role.
- **Type**: each family's role.
- **Beat**: tempo, arc and frame rate.

## Principles

**Register.** Map the tone to motion before choosing anything else. Quiet,
steady motion carries information and reading; expressive motion is saved for
the moments that matter, because it only reads as special against calm. These
pairings are illustrative, not presets: calm is long, soft moves and few of
them; playful is springy overshoot, squash and stretch; luxurious is slow and
precise with generous space; urgent is fast moves and hard cuts; tender is
warm, slow and held; technical is precise and snapping.

**Continuity.** Each scene hands something to the next: a shape, a word, a
colour field or a camera move. Prefer match cuts and shape handoffs to
cross-fades. The `type-as-spatial-handoff` study in [README.md](README.md) shows
type becoming the next scene.

**Palette.** A few colours, each with a role, derived from the brand, subject or
references. How many, how saturated and how often the frame changes colour
follow the register: full-frame colour blocks that change on most cuts suit a
loud, kinetic piece; a calm, tender or documentary piece holds a steadier field
and lets one accent carry attention. Gradients and glows are seasoning, not the
base. Keep text readable.

**No harmful flashing.** Anything flashing over more than about 3% of the frame
counts. Keep light/dark swaps, and swaps to and from saturated red, to at most
six in any one second (three flashes): faster flashing can trigger seizures,
and `motion_check` fails it. A swap on every beat at 120 BPM is fine; a white
flash frame on every half-beat is not.

**Type.** Choose faces for the register and the reading job. Size follows the
viewing context and how much there is to read: a kinetic poster can set one to
three huge words per shot; an explainer, documentary or lyric video sets whole
lines at a comfortable reading size. Size type against the frame's shorter side
(in vertical video, the width inside the safe margins) and check that the
longest word fits. Animate weight and width axes as motion, not only position
and opacity. Use one display family, at most one contrasting voice, such as an
italic serif, and small uppercase tracked mono for labels and UI where the
subject calls for it. Bundled axes (see `fonts.mjs list` and its specimen):
weight and width in Mona Sans, Hubot Sans, Anybody, Archivo, Bricolage
Grotesque and Martian Mono; italics in Fraunces and Newsreader. Brand fonts win.

**Motion.** Smooth by default, bounce by choice. Entrances settle on the
critically damped spring or `power3.out` / `expo.out`; exits `power3.in`; moves
`power3.inOut` or `expo.inOut`. Overshoot (`back.out`, `elastic.out` or an
underdamped spring) is a register chosen for playful or physical work, never
the default; see [easing](runtime/gsap-easing-and-stagger.md). Durations follow
the register: roughly 0.15–0.5 s for snappy, energetic or technical motion, and
0.6–1.5 s or longer for calm, luxurious or tender work. Staggers run 0.012–0.06 s
for type and longer for larger elements. Use real animation principles where
they help: anticipation before big moves, squash and stretch on impact, arcs
instead of straight paths, overlapping action, follow-through and smears on fast
moves. Lead with one movement at a time, with smaller overlapping motion under
it. Every move starts, travels and lands on purpose; nothing drifts without a
reason.

**Pace.** Keep time on a grid: the track's beats (`hf beats`) when there is
music, otherwise a tempo chosen for the register. Cut by how much there is to
take in, not by the grid alone: a simple image can last one beat; a line to
read or an idea to grasp holds for several. Meaningful text stays still and
readable for at least the longer of 0.8 s and one second per 15 characters,
longer for the key line; repeated or decorative words can go faster. Vary the
density (build, release, rest) so the video is neither always fast nor always
slow. Shape the whole to its form, with a beginning, development, peak and
resolution even in five seconds. Illustratively: a launch builds to its
product, an explainer steps through its idea, a lyric video follows the song's
sections, a tribute lets each moment breathe. End on a composed frame held long
enough to read, and declare that hold in the hold plan before checking.

**3D, when the subject earns it.** One hero object whose material, light and
camera come from the concept and register, not a stock tech look; add
supporting elements only when they mean something. Resolve 3D back to flat 2D to
hand off to the next scene. Use the bundled Three.js (`three.mjs`); no 3D by
default.

**Chrome, when it suits.** A small persistent mono layer (labels, timecode,
chapter name, a progress bar with markers) makes a tech subject feel like a pro
tool. Leave it out elsewhere.

**Frame rate.** 30 fps suits most work. Use 60 fps when fast, dense motion or
scrolling UI must read smoothly; it doubles render time. Renders carry no
motion blur, so fast moves stutter at 24 fps: keep 24 fps for slow, filmic or
handmade work.

**Truth.** Show only real product UI, numbers and claims from the user's
sources.

## Building blocks

Library looks (`library.mjs list looks`) are complete palette, type and rhythm
systems; when one fits the concept, it replaces the palette and type choices
above. Library pieces are optional building blocks.

## Check against the plan

When `motion_check` returns frames, compare them with the plan in `frame.md` as
well as the technical results. A lost motif, an off-palette colour, a generic
transition or unreadable type is a concrete defect: fix it and check the new
render.
