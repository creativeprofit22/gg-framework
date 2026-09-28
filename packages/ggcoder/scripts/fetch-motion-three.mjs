#!/usr/bin/env node
// Maintainer tool: (re)vendor a pinned Three.js build and addon set into
// assets/motion/vendor/three/ so Motion's 3D scenes render offline and
// identically every time. Not run at build or install time; the files are
// checked in. Run: node scripts/fetch-motion-three.mjs
//
// The version matches the one HyperFrames' own three adapter docs pin, so
// its examples and ours agree. Addons are copied with every relative module
// they import, so the importmap never points at a missing file.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.181.2";
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "motion",
  "vendor",
  "three",
);

/** Addon entry points (relative to examples/jsm), grouped by what they enable. */
const ADDONS = [
  // Studio lighting and reflections without an HDRI file.
  "environments/RoomEnvironment.js",
  "lights/RectAreaLightUniformsLib.js",
  "loaders/HDRLoader.js",
  // Geometry: bevelled product shapes, logos extruded from SVG, 3D text.
  "geometries/RoundedBoxGeometry.js",
  "loaders/SVGLoader.js",
  "geometries/TextGeometry.js",
  "loaders/FontLoader.js",
  "utils/BufferGeometryUtils.js",
  "math/SimplexNoise.js",
  // Models the user supplies.
  "loaders/GLTFLoader.js",
  // Film look: bloom, depth of field, grain, correct output transform.
  "postprocessing/EffectComposer.js",
  "postprocessing/RenderPass.js",
  "postprocessing/ShaderPass.js",
  "postprocessing/UnrealBloomPass.js",
  "postprocessing/BokehPass.js",
  "postprocessing/FilmPass.js",
  "postprocessing/OutputPass.js",
  // Reflective floors, and real HTML UI placed in the 3D scene.
  "objects/Reflector.js",
  "renderers/CSS3DRenderer.js",
];

const work = await mkdtemp(join(tmpdir(), "gg-three-"));
try {
  execFileSync("npm", ["pack", `three@${VERSION}`, "--silent"], { cwd: work, stdio: "ignore" });
  execFileSync("tar", ["xzf", `three-${VERSION}.tgz`], { cwd: work });
  const pkg = join(work, "package");

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "build"), { recursive: true });
  for (const file of ["three.module.min.js", "three.core.min.js"]) {
    await copyFile(join(pkg, "build", file), join(OUT, "build", file));
  }
  await copyFile(join(pkg, "LICENSE"), join(OUT, "LICENSE"));

  // Copy each addon plus the closure of its relative imports.
  const jsm = join(pkg, "examples", "jsm");
  const queue = [...ADDONS];
  const copied = new Set();
  while (queue.length > 0) {
    const rel = queue.shift();
    if (!rel || copied.has(rel)) continue;
    copied.add(rel);
    const source = await readFile(join(jsm, rel), "utf8");
    await mkdir(join(OUT, "addons", dirname(rel)), { recursive: true });
    await writeFile(join(OUT, "addons", rel), source);
    for (const match of source.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec) queue.push(posix.normalize(posix.join(posix.dirname(rel), spec)));
    }
  }

  const addons = [...copied].sort();
  await writeFile(
    join(OUT, "three.json"),
    `${JSON.stringify({ version: VERSION, license: "MIT", entries: ADDONS, addons }, null, 2)}\n`,
  );
  process.stdout.write(`three ${VERSION}: core + ${addons.length} addon files\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
