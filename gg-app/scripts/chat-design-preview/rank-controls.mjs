import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { capturePreview } from "./run.mjs";
import { fixtureResponses } from "./fixtures.mjs";
import { canonicalProgressScenarios } from "./progress-fixtures.mjs";
import { contrastRatio } from "./measurements.mjs";

const out = fileURLToPath(new URL(`../../../.gg/eyes/out/chat-workspace-preview/rank-controls-${Date.now()}/`, import.meta.url));
await mkdir(out, { recursive: true });
// Style-only effect isolation: deliberately NOT contract-valid rank combinations.
const styleOnlyEffects = ["dim", "plain", "blue", "green", "gradient", "gradient-glow", "animated", "gold", "gold-shimmer", "iridescent", "ember", "nebula", "rift", "void", "aether", "prism", "eternal", "platinum", "radiant", "omega", "origin"];
const canonicalScenarios = canonicalProgressScenarios();
const snapshot = canonicalScenarios.normal.snapshot;
assert.deepEqual(fixtureResponses().agent_progress, snapshot);

async function assertProgressRendered(page, dialog, expected) {
  await page.waitForFunction((data) => document.querySelector('.scorecard-level-num')?.textContent === String(data.level)
    && document.querySelector('.scorecard-rank')?.textContent === data.rankName
    && document.querySelector('.scorecard-rank')?.classList.contains(`rank-fx-${data.effectId}`)
    && document.querySelector('.scorecard-bar > span')?.style.width === `${data.percent}%`, expected);
  const badge = page.locator('.rank-badge').first();
  assert.equal(await badge.locator('.rank-level').textContent(), String(expected.level));
  assert.equal(await badge.locator('.rank-name').textContent(), expected.rankName);
  assert.equal(await badge.locator('.rank-name').evaluate((el, effect) => el.classList.contains(`rank-fx-${effect}`), expected.effectId), true);
  assert.equal(await dialog.locator('.scorecard-rank').evaluate((el, effect) => el.classList.contains(`rank-fx-${effect}`), expected.effectId), true);
  assert.equal(await dialog.locator('.scorecard-tier').textContent(), `${expected.tierName} tier`);
  assert.equal(await dialog.locator('.scorecard-level-num').textContent(), String(expected.level));
  assert.equal(await dialog.locator('.scorecard-stat').count(), 4);
  assert.equal(await dialog.locator('.scorecard-bar > span').evaluate((el) => el.style.width), `${expected.percent}%`);
  const labels = await page.evaluate((data) => {
    const fmt = (n) => new Intl.NumberFormat().format(n);
    return { meter: data.level === data.maxLevel ? 'Maximum level · 100%'
      : `${fmt(data.xpIntoLevel)} / ${fmt(data.xpForLevel)} XP · ${data.percent}%`,
      lifetime: `${fmt(data.xp)} lifetime XP`,
      title: `${data.rankName} — Level ${data.level} · ${data.level === data.maxLevel
        ? `Maximum level · ${fmt(data.xp)} lifetime XP` : `${data.xpIntoLevel}/${data.xpForLevel} XP to next`}` };
  }, expected);
  assert.equal(await dialog.locator('.scorecard-level-row').first().locator('span').last().textContent(), labels.meter);
  assert.equal(await dialog.locator('.scorecard-level-row').last().textContent(), labels.lifetime);
  assert.equal(await badge.getAttribute('title'), labels.title);
}
const results = [];
const cases = [
  { variant: "light", layout: "one", width: 1280, height: 800, zoom: 1 },
  { variant: "light", layout: "one", width: 390, height: 844, zoom: 1 },
  { variant: "light", layout: "one", width: 390, height: 844, zoom: 2 },
  { variant: "light", layout: "six", width: 2560, height: 1400, zoom: 1 },
  { variant: "original", layout: "one", width: 1280, height: 800, zoom: 1 },
];
for (const scenario of cases) {
  const evidence = await capturePreview({ ...scenario, verify: async (page) => {
    const badge = page.locator(".rank-badge").first();
    const toggle = page.getByRole("checkbox", { name: "Autopilot", exact: true }).first();
    await page.locator("textarea").first().focus();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (scenario.variant === "light") {
      const switchStyle = () => page.locator(".cl-switch > span").first().evaluate((span) => {
        const track = getComputedStyle(span, "::before"); const thumb = getComputedStyle(span, "::after");
        return { track: track.backgroundColor, thumb: thumb.backgroundColor, trackWidth: parseFloat(track.width), trackHeight: parseFloat(track.height), thumbWidth: parseFloat(thumb.width), thumbHeight: parseFloat(thumb.height), left: parseFloat(thumb.left), top: parseFloat(thumb.top), transform: thumb.transform, duration: thumb.transitionDuration, animation: thumb.animationName };
      });
      const off = await switchStyle();
      assert(contrastRatio(off.thumb, off.track) >= 3);
      assert(off.top >= 0 && off.top + off.thumbHeight <= off.trackHeight);
      await page.locator(".autopilot-toggle").first().screenshot({ path: `${out}${scenario.layout}-${scenario.width}-${scenario.zoom}-off.png` });
      await toggle.focus(); await page.keyboard.press("Space");
      await page.waitForFunction(() => [...document.querySelectorAll('.cl-switch input')].every((input) => input.checked));
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.cl-switch > span'), '::after').transform === 'matrix(1, 0, 0, 1, 14, 0)');
      const on = await switchStyle();
      assert(contrastRatio(on.thumb, on.track) >= 3);
      assert(on.left + 14 + on.thumbWidth <= on.trackWidth);
      assert.equal(on.animation, "none", "Enabled is not a perpetual working animation");
      assert.equal(await page.locator(".statusrow.running").count(), 0);
      await page.locator(".assistant-text p").last().click();
      await page.locator(".autopilot-toggle").first().screenshot({ path: `${out}${scenario.layout}-${scenario.width}-${scenario.zoom}-on.png` });
      assert.equal(await page.locator(".cl-switch").first().evaluate((el) => getComputedStyle(el).outlineStyle), "none");
      await toggle.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
      assert.equal(await page.locator(".cl-switch").first().evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
      await page.keyboard.press("Space");
      await page.waitForFunction(() => !document.querySelector('.cl-switch input').checked);
      await page.locator(".cl-switch > span").first().click();
      await page.waitForFunction(() => document.querySelector('.cl-switch input').checked);
      assert.equal(await page.locator(".cl-switch").first().evaluate((el) => getComputedStyle(el).outlineStyle), "none");
      await page.locator(".cl-switch > span").first().click();
      await page.waitForFunction(() => !document.querySelector('.cl-switch input').checked);
      await page.evaluate(() => window.__chatPreview.emit("primary", "run_start"));
      await page.waitForFunction(() => document.querySelector('.cl-switch input').disabled);
      const disabledBounds = await page.locator(".cl-switch > span").first().boundingBox();
      assert(disabledBounds);
      await page.mouse.click(disabledBounds.x + disabledBounds.width / 2, disabledBounds.y + disabledBounds.height / 2);
      assert.equal(await toggle.isChecked(), false);
      await page.evaluate(() => window.__chatPreview.emit("primary", "run_end"));
      await page.waitForFunction(() => !document.querySelector('.cl-switch input').disabled);
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal((await switchStyle()).duration, "0s");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      assert.equal(await page.evaluate(async () => { try { await window.__TAURI_INTERNALS__.invoke("agent_autopilot_set", { enabled: "invalid" }); return false; } catch { return true; } }), true);
    }
    await badge.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await assertProgressRendered(page, dialog, snapshot);
    const expectedBg = scenario.variant === "light" ? "rgb(252, 251, 253)" : "rgb(28, 30, 35)";
    assert.equal(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor), expectedBg);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "Close", exact: true }).evaluate((el) => el === document.activeElement), true);
    if (scenario.variant === "light") assert.equal(await page.getByRole("button", { name: "Close", exact: true }).evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await badge.evaluate((el) => el === document.activeElement), true);
    if (scenario.variant === "light") assert.equal(await badge.evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
    await badge.click(); await dialog.waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    if (scenario.variant === "light") assert.equal(await badge.evaluate((el) => getComputedStyle(el).outlineStyle), "none", "Pointer close leaves a sticky badge ring");
    await badge.click(); await dialog.waitFor();
    // Contract-valid scenarios are checked separately, including both sides of a tier boundary.
    const progressionResults = [];
    for (const [name, { snapshot: canonical }] of Object.entries(canonicalScenarios)) {
      await page.evaluate((data) => window.__chatPreview.emit("primary", "progress", data), canonical);
      await assertProgressRendered(page, dialog, canonical);
      progressionResults.push({ name, snapshot: canonical });
    }
    // Let transition feedback finish before style isolation and normal-example captures.
    await page.locator('.rank-badge-celebrate').first().waitFor({ state: 'detached' });
    await page.getByText(`Rank up! → ${canonicalScenarios.tierTransition.snapshot.rankName}`, { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.confetti-canvas').first().waitFor({ state: 'detached' });
    await page.evaluate((data) => window.__chatPreview.emit("primary", "progress", data), snapshot);
    await assertProgressRendered(page, dialog, snapshot);
    let minimumInkContrast = null;
    if (scenario.variant === "light" && scenario.width === 1280) {
      minimumInkContrast = Infinity;
      for (const effectId of styleOnlyEffects) {
        await page.evaluate((data) => window.__chatPreview.emit("primary", "progress", data), { ...snapshot, effectId });
        await dialog.locator(`.rank-fx-${effectId}`).waitFor();
        if (["animated", "gold-shimmer", "iridescent", "radiant", "origin"].includes(effectId)) {
          assert.equal(await dialog.locator(".scorecard-rank").evaluate((el) => getComputedStyle(el).animationName), "preview-rank-ink");
          await page.emulateMedia({ reducedMotion: "reduce" });
          assert.equal(await dialog.locator(".scorecard-rank").evaluate((el) => getComputedStyle(el).animationName), "none");
          await page.emulateMedia({ reducedMotion: "no-preference" });
        }
        const painted = await dialog.locator(".scorecard-rank").evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundImage }));
        const paintedColors = painted.background === "none" ? [painted.color] : painted.background.match(/rgb\([^)]+\)/g);
        assert(paintedColors?.length, "Unsupported painted rank colour format");
        for (const color of paintedColors) assert(contrastRatio(color, "#eeeaf2") >= 4.5, `${effectId} painted ink contrast`);
        const palette = await dialog.locator(".scorecard-rank").evaluate((el) => ["--rank-start", "--rank-mid", "--rank-end"].map((name) => getComputedStyle(el).getPropertyValue(name).trim()));
        for (const color of palette) {
          const ratio = contrastRatio(color, "#eeeaf2"); // Darkest base badge stop; modal is lighter.
          assert(ratio >= 4.5, `${effectId} ink contrast ${ratio}`);
          minimumInkContrast = Math.min(minimumInkContrast, ratio);
        }
      }
      await page.evaluate((data) => window.__chatPreview.emit("primary", "progress", data), snapshot);
      await assertProgressRendered(page, dialog, snapshot);
    }
    if (scenario.zoom === 2) {
      for (let i = 0; i < 20; i++) await page.keyboard.press("Control+=");
      await page.waitForFunction(() => document.documentElement.style.zoom === "2");
      await page.locator(".zoom-overlay").waitFor({ state: "hidden" });
    }
    const bounds = await dialog.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= scenario.width + 1 && bounds.y + bounds.height <= scenario.height + 1, "Dialog leaves viewport");
    const geometry = await dialog.evaluate((el) => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight }));
    assert(geometry.scrollWidth <= geometry.width + 1, "Scorecard horizontal overflow");
    if (scenario.variant === "light") {
      const samples = await dialog.locator(".modal-close,.scorecard-level-row span,.scorecard-level-num,.scorecard-tier,.scorecard-stat-label,.scorecard-stat b,.scorecard-stat-goal,.scorecard-footer > *").evaluateAll((elements) => elements.map((el) => getComputedStyle(el).color));
      for (const color of samples) assert(contrastRatio(color, expectedBg) >= 4.5, "Scorecard text contrast");
    }
    if (scenario.zoom === 2) {
      await dialog.hover(); await page.mouse.wheel(0, 5000);
      await page.waitForFunction(() => document.querySelector(".scorecard-modal").scrollTop > 0);
      const footer = await dialog.locator(".scorecard-footer").boundingBox();
      assert(footer && footer.y >= bounds.y && footer.y + footer.height <= bounds.y + bounds.height, "Footer cannot be reached by scrolling");
      await page.mouse.wheel(0, -5000);
      await page.waitForFunction(() => document.querySelector(".scorecard-modal").scrollTop === 0);
    }
    await page.screenshot({ path: `${out}${scenario.variant}-${scenario.layout}-${scenario.width}-zoom${scenario.zoom}.png` });
    return { bounds, geometry, minimumInkContrast, progression: { contractValid: true, scenarios: progressionResults }, styleOnlyEffectIsolation: { contractValid: false, effects: minimumInkContrast === null ? [] : styleOnlyEffects }, toggle: scenario.variant === "light" ? "off/on/disabled/reduced-motion/focus passed; synthetic IPC only" : "unchanged", modalFocusReturn: true };
  } });
  results.push({ ...scenario, evidence: evidence.additional });
}
await writeFile(`${out}results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ output: out, cases: results.length, canonicalScenarios: Object.keys(canonicalScenarios).length, styleOnlyRankEffects: styleOnlyEffects.length }));
