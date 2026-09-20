import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { capturePreview } from "./run.mjs";

// Bundle the pure backend producer fixture in memory; never read/write the progress store.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../src/test-fixtures/progress-transition.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm",
});
const { progressTransition } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

for (const [width, height] of [[1280, 800], [390, 844]]) {
  await capturePreview({ layout: "one", variant: "original", width, height, verify: async (page) => {
    const results = [];
    for (const [from, to, rank, tier, reduced] of [
      [55, 56, false, false, false], [60, 61, true, false, false],
      [100, 101, true, true, false], [55, 151, true, true, false],
      [100, 101, true, true, true],
    ]) {
      await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
      const snapshot = progressTransition(from, to, `${from}-${to}-${reduced}`);
      const text = rank ? `Rank up! → ${snapshot.rankName}` : `Level up! → Level ${to}`;
      await page.evaluate((data) => window.__chatPreview.emit("primary", "progress", data), { ...snapshot, origin: false });
      await page.getByText(text, { exact: true }).waitFor();
      assert.equal(await page.locator(".confetti-canvas").count(), tier && !reduced ? 1 : 0);
      assert.equal(await page.locator(".rank-badge-celebrate").count(), 1);
      if (reduced) {
        assert.equal(await page.locator(".rank-name").first().evaluate((el) => getComputedStyle(el).animationName), "none");
      }
      await page.evaluate((data) => {
        window.__chatPreview.emit("primary", "progress", { ...data, origin: true });
        window.__chatPreview.emit("primary", "progress", { ...data, ladder: [], levelUp: null, eventNonce: null });
      }, snapshot);
      assert.equal(await page.getByText(text, { exact: true }).count(), 1);
      results.push({ from, to, text, tierConfetti: tier && !reduced, reduced });
      // Observe normal teardown, then prove refreshing the same nonce cannot replay it.
      await page.locator(".rank-badge-celebrate").waitFor({ state: "detached" });
      await page.evaluate((data) => window.__chatPreview.emit("primary", "progress", data), snapshot);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator(".confetti-canvas").count(), 0);
      assert.equal(await page.locator(".rank-badge-celebrate").count(), 0);
    }
    return { boundary: "synthetic native IPC; pure backend snapshots; no real awards or storage", results };
  } });
}
