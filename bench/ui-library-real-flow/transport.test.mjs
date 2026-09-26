import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTransport } from './transport.mjs';
import { workerProfile } from './worker-isolation.mjs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('loopback rejects unauthenticated requests and defaults to no paid transport', async () => {
  let calls = 0;
  const server = await startTransport({ transport: () => { calls++; } });
  try {
    assert.equal((await fetch(server.url, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(server.url, { method: 'POST', headers: { authorization: `Bearer ${server.token}` }, body: '{}' })).status, 503);
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('worker profile refuses roots encompassing private data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-isolation-'));
  const privateRoot = join(root, 'private');
  await mkdir(privateRoot);
  try {
    assert.throws(() => workerProfile({ workspace: root, home: root, readRoots: [], brokerPort: 1234, forbiddenRoots: [privateRoot] }), /private/);
    assert.throws(() => workerProfile({ workspace: privateRoot, home: privateRoot, readRoots: [], brokerPort: 0, forbiddenRoots: [] }), /port/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
