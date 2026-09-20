// Owned-browser regression: delay real fixture responses/imports, never rewrite
// message DOM. Uses only the explicitly enabled server from this checkout.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { requireReady } from "./measurements.mjs";
import { previewReady } from "../../src/dev/chat-design-preview/readiness.mjs";
import { previewCheckoutIdentity } from "./server-identity.mjs";

const origin = "http://127.0.0.1:1420";
for (const [key, value] of Object.entries(process.env)) {
  if (/CDP|BROWSER_ENDPOINT|PLAYWRIGHT.*(ENDPOINT|CONNECT)/i.test(key) && value) throw new Error("Inherited browser endpoint must be inspected first");
}
const response = await fetch(`${origin}/__chat-design-preview`, { redirect: "error" });
assert.equal(response.status, 200);
assert.equal(response.headers.get("x-chat-preview"), "synthetic-only-v1");
assert.equal(response.headers.get("x-chat-preview-checkout"), previewCheckoutIdentity(fileURLToPath(new URL("../..", import.meta.url))));

function holdHistory() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  window.__releaseHistory = release;
  window.__historyHeld = 0;
  window.__readyEvents = 0;
  addEventListener("chat-preview-ready", () => { window.__readyEvents++; });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === "agent_history" && args?.paneId === "preview-6") {
      window.__historyHeld++;
      await gate;
    }
    return invoke(cmd, args);
  };
}

const browser = await chromium.launch({ headless: true });
const passed = [];
try {
  async function scenario({ name, layout = "six", state = "completed", hold = false, lazy = false, never = false }) {
    const context = await browser.newContext({ viewport: { width: 2560, height: 1400 }, serviceWorkers: "block" });
    let releaseMarkdown;
    const markdownGate = new Promise((resolve) => { releaseMarkdown = resolve; });
    const errors = [];
    try {
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/(api|agent|events|sessions)(\/|$)/.test(url.pathname)) return route.abort();
        if (hold && url.pathname === "/__chat-design-preview") {
          const response = await route.fetch({ maxRedirects: 0 });
          const html = await response.text();
          const seam = '<script type="module" src="/src/main.tsx"></script>';
          assert(html.includes(seam), "Main entry seam must exist");
          return route.fulfill({ response, body: html.replace(seam, `<script>(${holdHistory.toString()})();</script>${seam}`) });
        }
        if (lazy && url.pathname === "/src/Markdown.tsx") await markdownGate;
        return route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/__chat-design-preview?${new URLSearchParams({ layout, state, capture: "1" })}`, { waitUntil: "domcontentloaded" });
      const count = layout === "one" ? 1 : 6;
      if (hold) {
        await page.waitForFunction((state) => window.__historyHeld > 0 &&
          [...document.querySelectorAll('.workspace-pane-slot')].filter((pane) => pane.dataset.paneId !== "preview-6")
            .filter((pane) => state === "empty" ? pane.querySelector('.wake-screen') : pane.querySelectorAll('.assistant-text .markdown p').length >= 3).length === 5, state);
        assert.equal(await page.locator('[data-pane-id="preview-6"] .assistant-text').count(), 0);
      }
      if (lazy) await page.locator('.markdown[aria-busy="true"]').first().waitFor();
      if (hold || lazy) {
        assert.equal(await page.evaluate(previewReady), false);
        // Exercise the actual harness timeout rather than merely sampling its predicate.
        await assert.rejects(requireReady(page, count, state, never ? 31000 : 500), { name: "TimeoutError" });
        assert.equal(await page.locator('#root[data-eyes-ready="true"]').count(), 0);
        if (hold) assert.equal(await page.evaluate(() => window.__readyEvents), 0);
        if (state === "activity") assert.equal(await page.getByText("preview-only.ts", { exact: false }).count(), 0);
        assert.deepEqual(await page.evaluate(() => window.__chatPreview.errors), []);
        if (never) {
          assert.deepEqual(errors, []);
          passed.push(name);
          return;
        }
        if (hold) await page.evaluate(() => window.__releaseHistory());
        if (lazy) releaseMarkdown();
      }
      const metrics = await requireReady(page, count, state);
      assert.equal(await page.evaluate(previewReady), true);
      assert.equal(metrics.panes.length, count);
      if (state !== "empty") assert(metrics.panes.every((pane) => pane.prose !== null));
      if (hold) assert.equal(await page.evaluate(() => window.__readyEvents), 1);
      if (state === "activity") {
        for (const id of await page.evaluate(() => window.__chatPreview.paneIds())) {
          await page.locator(`[data-pane-id="${id}"]`).getByText("preview-only.ts", { exact: false }).first().waitFor();
        }
      }
      assert.deepEqual(errors, []);
      passed.push(name);
    } finally {
      releaseMarkdown();
      await context.close();
    }
  }
  await scenario({ name: "six histories held/released", hold: true });
  await scenario({ name: "never-resolving history", hold: true, never: true });
  await scenario({ name: "declared empty hydration", state: "empty", hold: true });
  await scenario({ name: "lazy Markdown", lazy: true });
  await scenario({ name: "activity waits for all histories", state: "activity", hold: true });
  await scenario({ name: "normal one pane", layout: "one" });
  await scenario({ name: "normal six panes" });
  console.log(JSON.stringify({ passed, limits: ["Synthetic IPC; no native integration"] }));
} finally { await browser.close(); }
