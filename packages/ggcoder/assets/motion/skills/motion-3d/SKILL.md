---
name: motion-3d
description: Build cinematic, hand-made 3D shots for Motion videos with the bundled offline Three.js — studio lighting, metal/glass/clearcoat materials, bevelled product geometry, extruded logos, the real product UI placed in 3D, camera language, bloom and depth of field, seeded procedural detail, and a self-scoring loop that pushes each 3D shot to launch-film quality. Use when a storyboard calls for 3D, a hero or signature moment needs depth, the user asks for "3D", "cinematic", "like Apple/Linear launch", or when a catalog 3D block doesn't fit the brand.
---

# Motion 3D

The 3D shots people share from Opus 5.5 are written by hand in Three.js:
real lighting, real materials, one deliberate camera move, and several
rounds of the agent critiquing its own frames. This skill is that recipe.
Use it for 1–3 signature shots (`visual-toolkit` § 2), not the whole video.

Seek contract, `hf-seek`, `AnimationMixer` and heavy-setup holds are in
`hyperframes-animation` → `adapters/three.md`. Read it once. This skill is
about making the shot look good.

## 1. Set up (offline, pinned)

```bash
<node> "<motion bin>/three.mjs" add .
```

It copies Three.js 0.181.2 and its addons into `assets/vendor/three/` and
prints an importmap. Put the importmap in `<head>` before any module
script, then import normally:

```js
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
```

Bundled addons: `RoomEnvironment`, `RectAreaLightUniformsLib`, `HDRLoader`,
`RoundedBoxGeometry`, `SVGLoader`, `TextGeometry`, `FontLoader`,
`BufferGeometryUtils`, `SimplexNoise`, `GLTFLoader`, `EffectComposer`,
`RenderPass`, `ShaderPass`, `UnrealBloomPass`, `BokehPass`, `FilmPass`,
`OutputPass`, `Reflector`, `CSS3DRenderer`. Never import Three.js from a
CDN: the render then depends on the network and on whatever version loads.

A composition driven only by `hf-seek` (no GSAP timeline) needs
`data-no-timeline` and `data-duration` on its root, or lint fails and the
render waits 45 s for a timeline.

Catalog 3D blocks (`vfx-iphone-device` and similar) load older Three.js
from the internet. They're fine when online; for offline or brand-specific
3D, build the shot here.

Start from the style library before writing a scene from scratch:
`library.mjs list --kind 3d` has render-verified 3D pieces (`style-library`)
that already solve lighting, shadows and camera for common shots.

## 2. Pick one of two looks

| | **Dark studio** | **Soft light** |
|---|---|---|
| Feels like | Apple/Linear dark launch, hardware reveal | calm premium product ad, SaaS/consumer |
| Background | near-black or deep brand tone | cool near-white with a deep brand light pool at one edge |
| Subjects | metal, glass, devices, extruded logos | simple rounded clay/plastic forms, illustrative UI cards |
| Light | one key + emissive rim, bloom | big soft light, soft shadows, haze, no bloom |
| Tone mapping | `ACESFilmicToneMapping` | `NeutralToneMapping` (keeps brand colors saturated; ACES turns blues lavender) |

"Clear, not childish" 3D in either look comes from: simple forms with
rounded edges, one restrained palette, soft shadows that ground every
object, depth of field on back layers, fog that melts the horizon, and
slow, eased motion. Default spheres and boxes, hard shadows, rainbow
colors and floating objects with no shadow are what reads as amateur.

## 3. The look in detail

**Renderer.** `antialias: true`, `setPixelRatio(1)`, fixed size, the tone
mapping from the table. Finish post with `OutputPass`.

**Dark studio: light like a studio, not a scene.**
- Environment first: `scene.environment =
  new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture`.
  This alone makes metal and glass read correctly.
- One key light (spot or rect area) from above-front at 30–45°, and one
  thin emissive rim or edge strip behind the subject for bloom to catch.
- Background near-black or a deep brand tone, with `scene.fog` in the same
  color so the floor and horizon fall off instead of ending in a grey band.
  Keep the key light off the floor; a lit floor reads as cheap grey.

**Materials** (`MeshPhysicalMaterial`):

| Look | Settings |
|---|---|
| Anodized / brushed metal | `metalness 1, roughness 0.25–0.35, clearcoat 1, clearcoatRoughness 0.1` |
| Polished product plastic | `metalness 0, roughness 0.3, clearcoat 1` |
| Clear glass | `transmission 1, thickness 0.8–1.5, roughness 0–0.05, ior 1.45` (needs something bright or colorful behind it, or it reads as a dark ball) |
| Frosted glass | as clear glass with `roughness 0.25–0.4` |
| Iridescent accent | add `iridescence 0.4–0.8` |

Never ship default grey `MeshStandardMaterial` with a hemisphere light
only: that is the "AI 3D" look.

**Soft light.**
- `RoomEnvironment` at `environmentIntensity` 0.5–0.7, one
  `DirectionalLight` with `PCFSoftShadowMap` and a large `shadow.radius`
  (8–12), plus a `HemisphereLight(white, field)` fill.
- Clay/soft plastic: `MeshPhysicalMaterial` with `roughness 0.4, clearcoat
  0.3, clearcoatRoughness 0.35`, a touch of `sheen` (≤ 0.15).
- Ground every object: a floor or water plane with `receiveShadow`, or a
  blurred radial shadow under CSS subjects.
- Haze: `scene.fog` in `--field`, tight enough (near 7–8, far 16–18) that
  the far floor melts into the sky with no grey horizon band.
- Illustrative UI (windows, cards) is sharper and cheaper in CSS 3D than
  WebGL: see the library's `ui-stack-3d`.

**Transparency.** Post-processing (`EffectComposer`) drops canvas alpha,
so a transparent 3D canvas over a CSS sky turns black. Paint skies and
backdrops into `scene.background` (a `CanvasTexture`) instead.

**Reading brand colors.** In a sub-composition, find the root with
`document.querySelector('[data-composition-id="<id>"]')` (HyperFrames drops
the root element's `id` when mounting) and read tokens with
`getComputedStyle(root).getPropertyValue("--accent")`. `THREE.Color` accepts
hex and `rgb()` only, so keep 3D-facing tokens in hex.

**Geometry.** Nothing real has sharp edges: use `RoundedBoxGeometry` with a
bevel for devices, cards and slabs. Logos: `SVGLoader` →
`ExtrudeGeometry({ depth, bevelEnabled: true, bevelSize, bevelThickness,
bevelSegments: 6 })`, from the brand kit's SVG. Use the product's real
proportions (a laptop is 1.5:1, a phone about 2.1:1).

## 4. The real UI in 3D

The product UI must be the real thing (`source-ingest`), not an imitation.

- **`CSS3DRenderer`** (sharpest): put the real HTML UI on a `CSS3DObject`
  sized to the device screen, and render it with the same camera after the
  WebGL pass. Text stays crisp at any angle. Limits: it always draws on
  top of the WebGL canvas and gets no bloom, fog or depth of field. Keep 3D
  objects from passing in front of it.
- **Screenshot texture:** a real capture on the screen mesh
  (`TextureLoader` from `assets/`, `colorSpace = SRGBColorSpace`). Takes
  post-processing and occlusion; text softens at steep angles.
- **HTML-in-canvas** (`hyperframes-animation` →
  `adapters/html-in-canvas-patterns.md`): live HTML as a texture that
  shaders can bend, shatter or refract.

## 5. Camera language

- One motivated move per shot: dolly-in, slow orbit (15–40° total), crane
  down, or rack focus. Never spin the product in circles.
- Long lens: `fov` 22–35. Wide lenses distort products.
- Arrive fast, settle long: ease the camera path
  (`1 - (1 - p) ** 4`) over most of the shot, then hold the final framing
  for the last 0.5–1 s so the viewer can read the UI.
- Keep the subject on a rule-of-thirds point or dead center, and point
  `BokehPass`'s `focus` at the subject distance every frame
  (`camera.position.distanceTo(subject.position)`).
- Match-cut out: end on a framing the next scene's composition picks up.

## 6. Post

`EffectComposer`: `RenderPass` → `UnrealBloomPass(strength 0.4–0.8,
radius 0.4, threshold 0.8–0.9)` so only emissives glow → `BokehPass`
(small aperture, around 0.002) → optional `FilmPass` (very light grain) →
`OutputPass`. Every pass is stateless per frame, so it's seek-safe. Avoid
passes that accumulate across frames (motion trails, TAA).

## 7. Procedural richness

Detail is what separates 9/10 from 6/10: many small elements, not one
big one.
- `InstancedMesh` for hundreds of tiles, particles, keys or bars; positions
  from a seeded random (mulberry32 with a fixed seed) computed once.
- `SimplexNoise` for organic drift, evaluated at the seek time.
- Motion is always a pure function of `time`: no `Date.now()`, no
  `requestAnimationFrame`, no `Math.random()` per frame.

## 8. Score and fix (the loop that gets to 9/10)

For each 3D shot, before building the next:

1. `hf snapshot --at <3–4 times across the shot>` and `read` the frames.
2. Score each 1–10: **lighting** (form, rim, falloff), **materials**
   (read as real?), **composition** (subject, thirds, negative space),
   **detail** (does it look hand-made?), **legibility** (is the UI or
   text readable?), **brand** (colors and type from the kit).
3. Fix the lowest score first, re-snapshot, re-score. Stop when every
   score is 8 or more, or after 3 rounds; then say what's still weakest.

Show the best frame of each 3D shot on the stills contact sheet.

## 9. Performance

Renders use the GPU when present (a 3 s 1080p shot with bloom and depth
of field renders in about 5 s on an Apple Silicon Mac). Machines without
a GPU fall back to software rendering, which is much slower: keep geometry
modest, pixel ratio 1, and use at most one bloom and one depth-of-field
pass.
