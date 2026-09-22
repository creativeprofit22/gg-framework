import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

test('built source sidecar boots and serves an isolated desktop session without credentials', { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gg-ui-sidecar-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(home); await mkdir(project);
  const child = spawn(process.execPath, [resolve('packages/ggcoder/dist/app-sidecar.js')], {
    cwd: project,
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, TMPDIR: root, GG_APP_PORT: '0', GG_APP_CWD: project },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const { port, token } = await new Promise((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`sidecar readiness timeout: ${stderr}`)), 30000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`sidecar exited ${code}: ${stderr}`)); });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const match = stdout.match(/GG_APP_LISTENING (\d+) (\S+)/);
        if (match) { clearTimeout(timeout); resolve({ port: Number(match[1]), token: match[2] }); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'content-type': 'application/json', 'x-gg-token': token };
    const response = await fetch(`${base}/session`, { method: 'POST', headers, body: JSON.stringify({ cwd: project }), signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const { sessionId } = await response.json();
    assert.ok(sessionId);
    const state = await fetch(`${base}/state`, { headers: { ...headers, 'x-gg-session': sessionId }, signal: AbortSignal.timeout(10000) });
    assert.equal(state.status, 200);
    assert.ok('ready' in await state.json());
    // This is boot/session routing evidence, not model generation or prompt/tool-event evidence.
  } finally {
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exit; clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  }
});
