import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { previewCheckoutIdentity } from "./server-identity.mjs";

// Pure backend snapshot construction, in memory only: never import the store or daemon.
const source = await readFile(new URL("../../../packages/ggcoder/src/core/progress/ranks.ts", import.meta.url), "utf8");
const { buildSnapshot, xpForLevel } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
function snapshot(level) {
  const xp = xpForLevel(level);
  return buildSnapshot({ xp, createdAt: "2026-07-01T12:00:00Z",
    streak: { current: 1, best: 1 },
    totals: { prompts: 1, commits: 0, linesShipped: 0, projects: ["/synthetic/chat-preview"] },
    xpBySource: { prompts: xp, commits: 0, streakBonus: 0 }, lastEvent: null });
}
const initial = snapshot(14);
const live = snapshot(15);
assert.equal(initial.rankName, "Compiler");
assert.equal(live.rankName, "Operator");
const origin = "http://127.0.0.1:1420";
const url = `${origin}/__chat-design-preview?layout=two&variant=original`;
for (const key of Object.keys(process.env)) {
  if (/CDP|BROWSER_ENDPOINT|PLAYWRIGHT.*(ENDPOINT|CONNECT)/i.test(key) && process.env[key]) {
    throw new Error("Inherited browser endpoint present; inspect before running");
  }
}
const response = await fetch(url, { redirect: "error" });
assert.equal(response.status, 200);
assert.equal(response.headers.get("x-chat-preview"), "synthetic-only-v1");
assert.equal(response.headers.get("x-chat-preview-checkout"), previewCheckoutIdentity(fileURLToPath(new URL("../..", import.meta.url))));
const html = await response.text();
// This inline script runs after the existing synthetic bridge, before deferred React modules.
const injection = `<script>
window.__heldProgress = [];
window.__releasedProgress = 0;
const originalInvoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'agent_progress'
  ? new Promise(resolve => window.__heldProgress.push(() => { window.__releasedProgress++; resolve(${JSON.stringify(initial)}); }))
  : originalInvoke(command, args);
</script>`;
assert.ok(html.includes("</body>"));
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await context.route("**/*", (route) => {
      const request = new URL(route.request().url());
      if (request.origin !== origin || /^\/(api|agent|events|sessions)(\/|$)/.test(request.pathname)) return route.abort();
      if (request.pathname === "/__chat-design-preview") return route.fulfill({ status: 200, contentType: "text/html", body: html.replace("</body>", `${injection}</body>`) });
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__heldProgress.length >= 2 && window.__chatPreview.paneIds().length === 2);
    assert.equal(await page.locator(".rank-badge").count(), 0, "Initial GET remains held");
    await page.evaluate(live => {
      for (const id of window.__chatPreview.paneIds()) window.__chatPreview.emit(id, "progress", live);
    }, live);
    await page.waitForFunction(() => [...document.querySelectorAll(".rank-badge")].length === 2 && [...document.querySelectorAll(".rank-badge")].every(badge => badge.title.startsWith("Operator — Level 15")));
    const held = await page.evaluate(() => window.__heldProgress.length);
    await page.evaluate(() => { for (const release of window.__heldProgress.splice(0)) release(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__releasedProgress), held);
    const titles = await page.locator(".rank-badge").evaluateAll(nodes => nodes.map(node => node.title));
    assert.equal(titles.length, 2);
    for (const title of titles) assert.ok(title.startsWith("Operator — Level 15"), `Late GET rolled badge back: ${title}`);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__chatPreview.errors), []);
    console.log(JSON.stringify({ viewport, heldLevel: 14, liveLevel: 15, releasedRequests: held, titles, rollback: false, boundary: "synthetic IPC; pure backend snapshots; no progress store access" }));
    await context.close();
  }
} finally { await browser.close(); }
