import assert from "node:assert/strict";
import { capturePreview } from "./run.mjs";

await capturePreview({ layout: "one", variant: "light", width: 1280, height: 800, verify: async (page) => {
  const listenerBaseline = await page.evaluate(() => [window.__ggListenerStats(), window.__chatPreview.listenerStats()]);
  await page.getByRole("button", { name: "Split Right", exact: true }).click();
  const pane = page.locator('[data-pane-id="pane-1"]');
  await pane.getByRole("button", { name: "Code", exact: true }).click();
  await pane.getByText("Synthetic comparison", { exact: true }).click();
  await pane.getByRole("button", { name: "+ New session", exact: true }).first().click();
  await pane.locator(".assistant-text").first().waitFor({ timeout: 10000 });
  assert.equal(await page.locator(".toast").count(), 0);
  const identities = await page.evaluate(async () => Promise.all(["primary", "pane-1"].map(async (paneId) => ({
    status: await window.__TAURI_INTERNALS__.invoke("agent_pane_status", { paneId }),
    state: await window.__TAURI_INTERNALS__.invoke("agent_state", { paneId }),
  }))));
  for (const { status, state } of identities) {
    assert(Number.isInteger(status.generation) && status.generation > 0);
    assert.equal(status.sessionId, state.sessionId);
    assert.equal(state.cwd, "/synthetic/chat-preview");
  }
  assert.notEqual(identities[0].status.sessionId, identities[1].status.sessionId);
  await page.evaluate(() => {
    window.__chatPreview.emit("pane-1", "run_start");
    window.__chatPreview.emit("pane-1", "text_delta", { text: "New pane routing regression marker" });
    window.__chatPreview.emit("pane-1", "run_end");
  });
  await pane.getByText("New pane routing regression marker", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-pane-id="primary"]').getByText("New pane routing regression marker", { exact: true }).count(), 0);
  await pane.locator(".cl-switch > span").click();
  await page.waitForFunction(() => {
    const inputs = [...document.querySelectorAll('.cl-switch input')];
    return inputs.length === 2 && inputs.every((input) => input.checked);
  });
  await pane.getByRole("button", { name: "Close pane-1 pane", exact: true }).click();
  await pane.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => {
    try { window.__chatPreview.emit("pane-1", "run_start"); return false; }
    catch { return true; }
  }), true);
  assert.equal(await page.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke("agent_pane_status", { paneId: "pane-1" }); return false; }
    catch { return true; }
  }), true);
  await page.locator(".cl-switch > span").click();
  await page.waitForFunction(() => !document.querySelector('.cl-switch input').checked);
  assert.equal(await page.locator(".toast").count(), 0);
  await page.waitForFunction((baseline) => JSON.stringify([window.__ggListenerStats(), window.__chatPreview.listenerStats()]) === JSON.stringify(baseline), listenerBaseline);
  assert.deepEqual(await page.evaluate(() => window.__chatPreview.errors), []);
  return { splitBind: true, targetedEvents: true, autopilotSynchronized: true, disposed: true, listenerBaselineRestored: listenerBaseline };
} });
