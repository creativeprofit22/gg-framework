#!/usr/bin/env node
// GG Motion 3D: install the bundled, pinned Three.js build and addons into a
// video project so 3D scenes render offline and identically every time.
//
// Usage: node three.mjs add <project-dir>
//
// Copies the library to <project>/assets/vendor/three/ and prints the
// importmap to put in the composition <head>, before any module script.
// Prints one JSON line: {"ok":true,...} or {"ok":false,"error":...}.
import { cp, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "three");

function done(result, code = 0) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(code);
}
const fail = (error) => done({ ok: false, error }, 1);

const [command, projectArg, ...extra] = process.argv.slice(2);
if (command !== "add" || !projectArg || extra.length > 0) {
  fail("usage: three.mjs add <project-dir>");
}

const manifest = await readFile(join(LIBRARY, "three.json"), "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => fail(`Three.js library missing at ${LIBRARY}`));

const project = resolve(projectArg);
const info = await stat(project).catch(() => undefined);
if (!info?.isDirectory()) fail(`Project folder not found: ${project}`);

const target = join(project, "assets", "vendor", "three");
await cp(LIBRARY, target, { recursive: true, force: true });

const importmap = [
  '<script type="importmap">',
  "  {",
  '    "imports": {',
  '      "three": "./assets/vendor/three/build/three.module.min.js",',
  '      "three/addons/": "./assets/vendor/three/addons/"',
  "    }",
  "  }",
  "</script>",
].join("\n");

done({
  ok: true,
  version: manifest.version,
  installed: target,
  addons: manifest.addons,
  importmap,
});
