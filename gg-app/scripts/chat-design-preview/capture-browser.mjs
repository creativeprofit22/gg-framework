// Owned-browser regression: run against this checkout's enabled preview server.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { capturePreview } from "./run.mjs";
import { measurePreview } from "./measurements.mjs";

const out = new URL("../../../.gg/eyes/out/chat-workspace-preview/", import.meta.url);
const results = [];
async function checkCapture(options, change) {
  let live;
  const before = new Set(await readdir(out));
  const evidence = await capturePreview({ ...options, verify: async (page) => {
    await change(page);
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async (options) => {
      live = await measurePreview(page);
      return screenshot(options);
    };
    return { callbackPreserved: true };
  } });
  assert.deepEqual(evidence.viewport, live.viewport);
  assert.deepEqual(evidence.panes, live.panes);
  assert.deepEqual(evidence.focus, live.focus);
  assert.deepEqual(evidence.settings, live.settings);
  assert.deepEqual(evidence.splits, live.splits);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.phase, "capture");
  assert.equal(evidence.initial.phase, "initial");
  assert.equal(evidence.initial.viewport.zoom, "1");
  assert.deepEqual(evidence.additional, { callbackPreserved: true });
  const added = (await readdir(out)).filter((name) => !before.has(name));
  assert.equal(added.length, 2);
  const path = added.find((name) => name.endsWith(".png"));
  assert(path);
  assert.deepEqual(JSON.parse(await readFile(new URL(path.replace(/\.png$/, ".json"), out), "utf8")), evidence);
  results.push({ path, status: "passed" });
  return evidence;
}

const zoom = await checkCapture({ layout: "one", variant: "light", width: 390, height: 844 }, async (page) => {
  for (let i = 0; i < 20; i++) await page.keyboard.press("Control+=");
  await page.waitForFunction(() => document.documentElement.style.zoom === "2");
  await page.locator(".zoom-overlay").waitFor({ state: "hidden" });
});
assert.equal(zoom.viewport.zoom, "2");
const changed = await checkCapture({ layout: "six", variant: "light", interactions: true }, async (page) => {
  const divider = page.getByRole("separator", { name: "Resize horizontal workspace panes" }).first();
  await divider.focus(); await divider.press("ArrowRight");
  const composer = page.locator("textarea").last();
  await composer.fill("Final capture draft"); await composer.focus();
  // Capture hides the comparison panel; still exercise its real change handler.
  await page.locator('[data-chat-preview-controls] select').nth(1).selectOption("15", { force: true });
  await page.setViewportSize({ width: 2400, height: 1320 });
});
assert.notDeepEqual(changed.panes[0].geometry, changed.initial.panes[0].geometry);
assert.notDeepEqual(changed.splits, changed.initial.splits);
assert.equal(changed.panes.at(-1).draft, "Final capture draft");
assert.equal(changed.focus.tag, "TEXTAREA");
assert.equal(changed.focus.paneId, changed.panes.at(-1).id);
assert.equal(changed.settings.size, "15");
assert.equal(changed.initial.settings.size, "16");
assert.equal(changed.interactions.resizeDraft, true);

for (const [name, invalidate, expected] of [
  ["missing workspace", () => document.querySelector(".workspace-pane-slot").remove(), /Invalid final preview workspace/],
  ["invalid workspace", () => document.querySelector("textarea").remove(), /Invalid final preview workspace/],
  ["fixture error", () => window.__chatPreview.errors.push("late fixture failure"), /late fixture failure/],
  ["Roadmap error", () => { const error = document.createElement("div"); error.textContent = "invalid Roadmap draft response"; document.body.append(error); }, /Invalid Roadmap fixture response/],
  ["page error", () => { setTimeout(() => { throw new Error("late page failure"); }, 0); }, /late page failure/],
]) {
  const before = await readdir(out);
  await assert.rejects(capturePreview({ layout: "one", verify: async (page) => {
    await page.evaluate(invalidate);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    page.screenshot = async () => { assert.fail("Invalid final state must not be captured"); };
  } }), expected);
  assert.deepEqual(await readdir(out), before, "Invalid state must not publish evidence");
  results.push({ name, status: "rejected as expected" });
}
await writeFile(new URL(`capture-regression-${Date.now()}.json`, out), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ captureRegression: "passed", cases: results.length }));
