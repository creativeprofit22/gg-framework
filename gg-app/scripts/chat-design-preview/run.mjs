import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePreviewOptions, paneCounts } from "./layouts.mjs";
import { requireReady, requireCapture } from "./measurements.mjs";
import { exercisePreview } from "./interactions.mjs";
import { previewCheckoutIdentity } from "./server-identity.mjs";

const origin = "http://127.0.0.1:1420";
export async function capturePreview({ layout = "six", variant = "original", width = 2560, height = 1400, interactions = false, state = "completed", code = "light", verify } = {}) {
  parsePreviewOptions(new URLSearchParams({ layout, variant, state }));
  if (!["light", "charcoal"].includes(code)) throw new Error("Invalid code surface");
  for (const key of Object.keys(process.env)) {
    if (/CDP|BROWSER_ENDPOINT|PLAYWRIGHT.*(ENDPOINT|CONNECT)/i.test(key) && process.env[key]) {
      throw new Error("Inherited browser endpoint present; inspect and clear it before using this runner");
    }
  }
  const url = `${origin}/__chat-design-preview?${new URLSearchParams({ layout, variant, state, code, size: "16", tracking: "normal", paragraphs: "roomy", cap: "on", markers: "on", streaming: "crisp" })}`;
  const expectedIdentity = previewCheckoutIdentity(fileURLToPath(new URL("../..", import.meta.url)));
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Preview server HTTP failure: ${response.status}`);
  if (response.headers.get("x-chat-preview") !== "synthetic-only-v1") throw new Error("Expected explicitly enabled preview server on port 1420");
  if (response.headers.get("x-chat-preview-checkout") !== expectedIdentity) {
    throw new Error("Preview checkout identity missing or mismatched on port 1420; use the preview server from this checkout");
  }
  const out = resolve(fileURLToPath(new URL("../../..", import.meta.url)), ".gg/eyes/out/chat-workspace-preview");
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: "block" });
    const errors = [];
    await context.route("**/*", (route) => {
      const request = new URL(route.request().url());
      if (request.origin !== origin || /^\/(api|agent|events|sessions)(\/|$)/.test(request.pathname)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url, { waitUntil: "networkidle" });
    const initial = { phase: "initial", ...await requireReady(page, paneCounts[layout], state) };
    await page.locator("[data-chat-preview-controls]").evaluateAll((elements) => elements.forEach((element) => { element.hidden = true; }));
    const results = {};
    if (interactions) results.interactions = await exercisePreview(page);
    if (verify) results.additional = await verify(page);
    const name = `${variant}-${code}-${state}-${layout}-${width}x${height}-${Date.now()}`;
    const metrics = { schemaVersion: 2, phase: "capture", ...await requireCapture(page, paneCounts[layout], state), initial, ...results };
    if (errors.length) throw new Error(errors.join("; "));
    // Capture to memory first: late errors must not publish a success PNG/JSON pair.
    const image = await page.screenshot();
    if (errors.length) throw new Error(errors.join("; "));
    const fixtureErrors = await page.evaluate(() => window.__chatPreview?.errors ?? ["Missing preview bootstrap"]);
    if (fixtureErrors.length) throw new Error(`Fixture errors: ${fixtureErrors.join("; ")}`);
    await writeFile(resolve(out, `${name}.png`), image);
    await writeFile(resolve(out, `${name}.json`), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify({ name, paneCount: metrics.panes.length, errors: metrics.errors, output: out }));
    await context.close();
    return metrics;
  } finally { await browser.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [layout = "six", variant = "original", width = "2560", height = "1400"] = process.argv.slice(2);
  const dimensions = [Number(width), Number(height)];
  if (dimensions.some((n) => !Number.isInteger(n) || n < 320 || n > 3840)) throw new Error("Invalid viewport");
  await capturePreview({ layout, variant, width: dimensions[0], height: dimensions[1] });
}
