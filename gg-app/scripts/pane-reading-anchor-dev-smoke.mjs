import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCrossPaneProjectIsolationSmoke } from "./cross-pane-project-isolation-dev-smoke.mjs";

const out = resolve(fileURLToPath(new URL("../..", import.meta.url)), ".gg/eyes/out/pane-reading-native", String(Date.now()));
await mkdir(out, { recursive: true });
const evidence = { boundary: "Windows developer Tauri WebView2; real React transcript, Range geometry, Rust session IPC; controlled daemon history. Not installed-app or real-provider verification.", exchanges: [], status: "running" };
async function waitFor(client, expression, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await new Promise(done => setTimeout(done, 75));
  }
  throw new Error(`Timed out: ${label}`);
}
async function verifyWorkspace({ client, projectA, projectB, projectC, readAudit }) {
  const ids = ["primary", "reading-center", "reading-right"];
  const leaf = paneId => ({ type: "leaf", paneId });
  const split = (first, second, value) => ({ type: "split", direction: "horizontal", size: { type: "ratio", value }, first, second });
  const layout = { version: 9, focusedPaneId: "primary", root: split(leaf(ids[0]), split(leaf(ids[1]), leaf(ids[2]), 60), 25),
    panes: Object.fromEntries(ids.map((id, i) => [id, { kind: "agent", mode: "code", cwd: [projectA, projectB, projectC][i], sessionPath: null }])) };
  await client.evaluate(`localStorage.setItem('gg-workspace-layout-recursive:main', ${JSON.stringify(JSON.stringify(layout))}); location.reload(); true`);
  await waitFor(client, `document.querySelectorAll('[data-pane-swap]').length === 4 && document.querySelectorAll('.ken-msg p').length === 6`, "hydrated mentor and autopilot paragraphs");
  const states = () => client.evaluate(`Promise.all(${JSON.stringify(ids)}.map(paneId => window.__TAURI_INTERNALS__.invoke('agent_state', { paneId })))`);
  const before = await states();
  const auditStart = readAudit().length;
  // Independent probe: inspect individual glyphs, not the hook's row eligibility selector.
  await client.evaluate(`(() => {
    window.__readingHosts = [...document.querySelectorAll('[data-pane-id]')];
    window.__firstVisible = (node, scroll) => {
      const top = scroll.getBoundingClientRect().top + scroll.clientTop;
      const bottom = top + scroll.clientHeight;
      for (let index = 0; index < node.length; index++) {
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width && rect.height && rect.bottom > top && rect.top < bottom) return { index, character: node.data[index], excerpt: node.data.slice(index, index + 80), top: rect.top - top };
      }
      throw new Error('No visible character');
    };
    return true;
  })()`);
  for (const width of [1280, 390]) {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height: width === 1280 ? 800 : 844, deviceScaleFactor: 1, mobile: false });
    for (const kind of ["ken", "autopilot", "error"]) {
      await client.evaluate(`(() => {
        window.__readingSamples = ${JSON.stringify(ids)}.map(id => {
          const host = document.querySelector('[data-pane-id="' + id + '"]');
          const scroll = host.querySelector('.transcript');
          const paragraph = ${JSON.stringify(kind)} === 'error' ? host.querySelector('.line.error:not([role="status"]) > div:nth-child(2)') : host.querySelectorAll('.ken-msg p')[${kind === "ken" ? 0 : 1}];
          const node = paragraph.firstChild;
          scroll.scrollTop += paragraph.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 700;
          scroll.dispatchEvent(new Event('scroll'));
          return { id, host, scroll, node };
        });
        return true;
      })()`);
      for (const direction of ["left", "right"]) {
        // Center chooses its neighbour; the same side position reverses the exchange.
        for (const reverse of [false, true]) {
          const samples = await client.evaluate(`window.__readingSamples.map(sample => {
            const first = window.__firstVisible(sample.node, sample.scroll);
            sample.range = document.createRange(); sample.range.setStart(sample.node, first.index); sample.range.setEnd(sample.node, first.index + 1);
            return { id: sample.id, first, width: sample.host.getBoundingClientRect().width, scrollTop: sample.scroll.scrollTop };
          })`);
          const selector = reverse
            ? '[data-pane-swap="reading-center"]:not([data-pane-swap-direction])'
            : `[data-pane-swap="reading-center"][data-pane-swap-direction="${direction}"]`;
          await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
          await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
          const after = await client.evaluate(`window.__readingSamples.map(sample => ({ id: sample.id, first: window.__firstVisible(sample.node, sample.scroll), width: sample.host.getBoundingClientRect().width, scrollTop: sample.scroll.scrollTop, savedCharacterTop: sample.range.getBoundingClientRect().top - sample.scroll.getBoundingClientRect().top - sample.scroll.clientTop, pinned: sample.scroll.scrollHeight - sample.scroll.scrollTop - sample.scroll.clientHeight < 2 }))`);
          evidence.exchanges.push({ width, kind, direction, reverse, before: samples, after });
          const peer = direction === "left" ? ids[0] : ids[2];
          for (const id of ["reading-center", peer]) {
            const old = samples.find(sample => sample.id === id);
            const next = after.find(sample => sample.id === id);
            assert.ok(Math.abs(old.width - next.width) > 5, `Unequal widths required: ${id}`);
            assert.ok(Math.abs(old.first.top - next.savedCharacterTop) <= 1, `Reading character drifted: ${kind}/${id}/${width}: ${old.first.top} -> ${next.savedCharacterTop}`);
            assert.equal(next.pinned, false);
          }
        }
      }
    }
    const image = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(out, `native-${width}.png`), Buffer.from(image.data, "base64"));
  }
  assert.equal(await client.evaluate(`window.__readingHosts.every(host => host.isConnected && document.getElementById(host.id) === host)`), true);
  assert.deepEqual((await states()).map(({ sessionId, cwd }) => ({ sessionId, cwd })), before.map(({ sessionId, cwd }) => ({ sessionId, cwd })));
  assert.equal(readAudit().slice(auditStart).some(entry => entry.action === "session-created" || entry.action === "session-disposed"), false);
  evidence.hostsAndSessionIdentitiesPreserved = true;
  console.log("READING ANCHOR NATIVE CHECKS PASSED; waiting for owned-process cleanup");
}
try {
  await runCrossPaneProjectIsolationSmoke({ identity: "com.ggcoder.local-fork", readingAnchors: true, reuseDevServer: true, verifyWorkspace });
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, output: out, error: evidence.error }));
}
