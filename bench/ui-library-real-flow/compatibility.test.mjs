import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixMouseCardCleanup } from '../ui-library-eval/mouse-card-fix.mjs';

// Offline regression against immutable historical source, not a fresh-generation pass.
const require = createRequire(new URL('../../packages/ggcoder/package.json', import.meta.url));
const { build } = createRequire(require.resolve('tsup'))('esbuild');
const bundled = await build({ entryPoints: ['packages/ggcoder/src/core/ui-compatibility.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { patchMouseCard, compatibilityPatch } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('production recipe exactly matches independently reviewed animation-ownership fix', async () => {
  const catalog = JSON.parse(await readFile(new URL('../ui-library-eval/results/eval-20260922-reader-v2/catalog.json', import.meta.url), 'utf8'));
  const source = catalog.nodes['kokonut:mouse-effect-card'].item.files.find((f) => f.path.endsWith('mouse-effect-card.tsx')).content;
  const patched = patchMouseCard(source);
  assert.equal(patched, fixMouseCardCleanup(source));
  assert.match(patched, /return \(\) => pulse\.stop\(\)/);
  assert.match(patched, /@license: MIT/);
  assert.equal(patched.slice(patched.indexOf('export default function')), source.slice(source.indexOf('export default function')));
  for (const line of source.split('\n').filter((line) => /^const (SPRING_|OPACITY_|MIN_OPACITY_|MAX_OPACITY_|PROXIMITY_)/.test(line))) assert.ok(patched.includes(line));
  assert.throws(() => patchMouseCard(source + '\n'), /differs/);
  const result = compatibilityPatch('kokonut:mouse-effect-card', 'components/mouse-effect-card.tsx', source);
  assert.equal(result.content, patched);
  assert.match(result.notice, /original SHA256.*patched SHA256/);
  const unknown = compatibilityPatch('kokonut:mouse-effect-card', 'components/mouse-effect-card.tsx', source + '\n');
  assert.equal(unknown.content, source + '\n');
  assert.match(unknown.notice, /not applied/);
});
