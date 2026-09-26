import assert from "node:assert/strict";
import { capturePreview } from "./run.mjs";
import { fixtureResponses } from "./fixtures.mjs";

// Browser-only IPC fixture: never invokes an award or reads a progress store.
const initial = fixtureResponses().agent_progress;
for (const scenario of [
  { layout: "two", width: 1280, height: 800 },
  { layout: "six", width: 2560, height: 1400 },
  { layout: "two", width: 390, height: 844 },
]) {
  await capturePreview({ ...scenario, variant: "light", verify: async (page) => {
    const ids = await page.evaluate(() => window.__chatPreview.paneIds());
    await page.waitForFunction((count) => document.querySelectorAll(".rank-badge").length === count, ids.length);
    await page.evaluate(() => {
      window.__progressSounds = [];
      HTMLMediaElement.prototype.play = function () {
        window.__progressSounds.push(this.src);
        return Promise.resolve();
      };
    });
    const results = [];
    let xp = initial.xp;
    for (const owner of [ids[1], "primary"]) {
      for (const reverse of [false, true]) {
        xp += 10;
        const snapshot = { ...initial, xp, xpIntoLevel: initial.xpIntoLevel + xp - initial.xp,
          level: 15, levelUp: { from: 14, to: 15, rankName: "Shipwright" },
          eventNonce: `${owner}-${reverse}` };
        const order = reverse ? [...ids].reverse() : ids;
        const soundStart = await page.evaluate(() => window.__progressSounds.length);
        for (const id of order) {
          await page.evaluate(({ id, snapshot, owner }) => window.__chatPreview.emit(id, "progress", { ...snapshot, origin: id === owner }), { id, snapshot, owner });
          await page.waitForFunction(({ id, into }) => document.querySelector(`[data-pane-id="${id}"] .rank-badge`)?.title.includes(`${into}/`), { id, into: snapshot.xpIntoLevel });
        }
        assert.equal(await page.locator(".rank-xp-chip").count(), 1, "Only the earning pane shows an XP chip");
        assert.equal(await page.locator(`[data-pane-id="${owner}"] .rank-xp-chip`).textContent(), "+10 XP");
        assert.equal(await page.locator(".rank-badge-celebrate").count(), ids.length, "All panes celebrate rank-up");
        const sounds = await page.evaluate((start) => window.__progressSounds.slice(start), soundStart);
        assert.equal(sounds.filter((src) => src.includes("exp-new")).length, 1);
        assert.equal(sounds.filter((src) => src.includes("levelup")).length, 1);
        // Retain DOM identity: duplicates must not restart the celebration animation.
        await page.evaluate(() => { window.__progressRankNodes = [...document.querySelectorAll(".rank-level")]; });
        for (const id of order) await page.evaluate(({ id, snapshot, owner }) => window.__chatPreview.emit(id, "progress", { ...snapshot, origin: id === owner }), { id, snapshot, owner });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator(".rank-xp-chip").count(), 1);
        assert.equal(await page.evaluate(() => [...document.querySelectorAll(".rank-level")].every((node, i) => node === window.__progressRankNodes[i])), true);
        assert.equal(await page.evaluate(() => window.__progressSounds.length), soundStart + 2);
        results.push({ owner, reverse, totals: "all panes", chip: "origin only", sounds: "one XP + one rank", duplicate: "no repeated effects" });
        await page.waitForFunction(() => !document.querySelector(".rank-xp-chip,.rank-badge-celebrate"));
      }
    }
    return { progressRouting: results, boundary: "synthetic IPC; no real XP or native verification" };
  } });
}
