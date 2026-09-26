import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { chromium } from "playwright";
import { initScript, responses } from "./capture-screenshots.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "dist/.vite/manifest.json"), "utf8"));
const markdownFile = manifest["src/Markdown.tsx"]?.file;
assert.ok(markdownFile, "Build must contain an on-demand Markdown chunk");
const server = await preview({ root, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(initScript, {
    responses: { ...responses, select_project: 1 },
    appVersion: "0.62.1",
  });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/${markdownFile}`) requests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator(".app").first().waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(requests.length, 0, "Startup must not request the rich-text renderer");
  await page.getByText("Code", { exact: true }).click();
  await page.locator(".picker-item").first().click();
  await page.getByText("+ New session", { exact: true }).click();
  await page.locator("textarea").first().waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(requests.length, 0, "An empty chat must not request the rich-text renderer");

  // Hold the real production chunk to exercise the readable loading fallback.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(`**/${markdownFile}`, async (route) => {
    await held;
    await route.continue();
  });
  const text = "**Lazy renderer works**\n\n```js\nconst answer = 42;\n```";
  await page.evaluate((text) => window.__ggEmit("text_delta", { text }), text);
  await page.locator('.markdown[aria-busy="true"]').waitFor();
  assert.ok((await page.locator('.markdown[aria-busy="true"]').textContent()).length > 0);
  release();
  await page.locator(".markdown strong", { hasText: "Lazy renderer works" }).waitFor();
  await page.locator(".markdown code .hljs-keyword").waitFor();
  assert.equal(requests.length, 1, "First content loads the renderer exactly once");
  assert.deepEqual(errors, []);
  console.log("Production browser smoke: zero renderer requests on startup/empty chat; readable fallback, formatted text and code highlighting passed. Native IPC mocked; browser headless.");
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
