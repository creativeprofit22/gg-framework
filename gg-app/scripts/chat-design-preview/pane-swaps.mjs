import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePreview } from "./run.mjs";

const out = resolve(fileURLToPath(new URL("../../..", import.meta.url)), ".gg/eyes/out/chat-pane-swaps");
await mkdir(out, { recursive: true });
export async function exerciseDrag(page) {
  await page.getByRole("button", { name: "Rearrange panes", exact: true }).click();
  await page.evaluate(() => {
    window.__paneDragEvents = [];
    for (const type of ["dragstart", "pointercancel", "drop", "dragend", "focusin", "blur"]) {
      document.addEventListener(type, (event) => {
        window.__paneDragEvents.push(type === "focusin" || type === "blur" ? `${type}:${event.target.tagName}:${event.target.getAttribute?.("aria-label")}` : type);
        if (type === "dragstart") {
          const source = event.target;
          queueMicrotask(() => { window.__paneDragSource = { connected: source.isConnected, same: document.querySelector('[data-pane-drag-handle="preview-3"]') === source, rect: source.getBoundingClientRect().toJSON() }; });
        }
      }, { capture: true });
    }
  });
  const source = page.getByRole("button", { name: "Move pane preview-3", exact: true });
  const from = await source.boundingBox();
  const target = await page.locator('[data-pane-id="primary"]').boundingBox();
  assert.ok(from && target);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  let timer;
  try {
    await Promise.race([
      page.mouse.move(from.x - 15, from.y + 10, { steps: 4 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("HTML drag initiation did not complete within 10 seconds")), 10000); }),
    ]);
  } catch (error) {
    const events = await page.evaluate(() => ({ events: window.__paneDragEvents, source: window.__paneDragSource, active: !!document.querySelector(".pane-drag-active") }));
    await writeFile(resolve(out, `html-drag-timeout-${Date.now()}.json`), JSON.stringify(events, null, 2));
    throw error;
  } finally { clearTimeout(timer); }
  await page.mouse.move(target.x + 8, target.y + target.height / 2, { steps: 12 });
  await page.mouse.move(target.x + 9, target.y + target.height / 2);
  await page.mouse.up();
  const events = await page.evaluate(() => window.__paneDragEvents);
  const moved = await page.locator('[data-pane-id="preview-3"]').boundingBox();
  const primary = await page.locator('[data-pane-id="primary"]').boundingBox();
  await writeFile(resolve(out, `html-drag-${Date.now()}.json`), JSON.stringify({ events, moved, primary }, null, 2));
  assert.ok(events.includes("dragstart") && events.includes("pointercancel") && events.includes("drop"), "Real HTML drag lifecycle must include pointercancel and drop");
  assert.ok(moved.x < primary.x, "Dropped conversation must move left of primary");
  return { events, moved, primary, evidence: "Synthetic browser with real WorkspaceShell and AgentPane; not native Tauri" };
}
async function settled(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-pane-slot')].every((el) => el.getAnimations().length === 0), null, { timeout: 5000 });
}
export async function exerciseSwaps(page) {
  page.setDefaultTimeout(8000);
  const prefix = `swaps-${page.viewportSize().width}x${page.viewportSize().height}-${Date.now()}`;
  const button = (id) => page.locator(`[data-pane-swap="${id}"]:not([data-pane-swap-direction])`);
  const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-pane-swap"));
  const snapshot = () => page.evaluate(() => [...document.querySelectorAll('.workspace-pane-slot')].map((el) => ({
    id: el.dataset.paneId, left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight,
    draft: el.querySelector('textarea')?.value, scroll: el.querySelector('.transcript')?.scrollTop,
  })));
  await page.evaluate(() => { window.__swapHosts = [...document.querySelectorAll('.workspace-pane-slot')]; });
  const original = await snapshot();
  assert.equal(await button('preview-2').count(), 0);
  assert.equal(await button('preview-5').count(), 0);
  assert.equal(await page.locator('[data-pane-swap-direction]').count(), 4);
  await page.screenshot({ path: resolve(out, `${prefix}-before.png`) });
  console.log('Swap browser check: native Enter/Space and focus continuity');
  await button('primary').focus();
  await page.evaluate(() => { window.__swapFocusEvents = []; document.addEventListener('focusin', (event) => window.__swapFocusEvents.push({ tag: event.target.tagName, name: event.target.getAttribute('aria-label') }), true); });
  await page.keyboard.press('Enter');
  await writeFile(resolve(out, `${prefix}-focus.json`), JSON.stringify(await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 800), events: window.__swapFocusEvents, status: [...document.querySelectorAll('[role="status"]')].map(el => el.textContent), buttons: [...document.querySelectorAll('[data-pane-swap]')].map(el => el.dataset.paneSwap) })), null, 2));
  assert.equal(await active(), 'preview-2');
  assert.equal(await button('primary').count(), 0);
  const animated = await page.evaluate(() => [...document.querySelectorAll('.workspace-pane-slot')].flatMap((el) => el.getAnimations().map((a) => ({ id: el.dataset.paneId, duration: a.effect.getTiming().duration, frames: a.effect.getKeyframes() }))));
  // An explicit paused midpoint is a visual inspection aid, not timing evidence.
  await page.evaluate(() => document.querySelectorAll('.workspace-pane-slot').forEach((el) => el.getAnimations().forEach((a) => { a.pause(); a.currentTime = 80; })));
  await page.screenshot({ path: resolve(out, `${prefix}-midpoint.png`), animations: 'allow' });
  await page.evaluate(() => document.querySelectorAll('.workspace-pane-slot').forEach((el) => el.getAnimations().forEach((a) => a.play())));
  await page.keyboard.press('Space');
  assert.equal(await active(), 'primary');
  await settled(page);
  assert.deepEqual((await snapshot()).map(({ id, left, top, width, height }) => ({ id, left, top, width, height })), original.map(({ id, left, top, width, height }) => ({ id, left, top, width, height })));
  // Distinct taps accepted during movement; a held key must not issue extra swaps.
  await page.keyboard.down('Enter');
  assert.equal(await active(), 'preview-2');
  await page.keyboard.down('Enter');
  assert.equal(await active(), 'preview-2');
  await page.keyboard.up('Enter');
  await page.keyboard.press('Enter');
  assert.equal(await active(), 'primary');
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  assert.equal(await active(), 'primary');
  await page.keyboard.up('Space');
  assert.equal(await active(), 'preview-2');
  await page.keyboard.press('Space');
  assert.equal(await active(), 'primary');
  await page.keyboard.press('Tab');
  assert.notEqual(await active(), 'primary');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await active(), 'primary');
  await settled(page);
  console.log('Swap browser check: both rows, drafts, selection and reduced motion');
  const input = page.locator('[data-pane-id="preview-4"] textarea').first();
  const middleInput = page.locator('[data-pane-id="preview-5"] textarea').first();
  await input.fill('Lower-row draft remains here');
  await middleInput.fill('Displaced draft remains there');
  await input.focus();
  await input.evaluate((el) => el.setSelectionRange(3, 9, 'backward'));
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft');
  await settled(page);
  assert.equal(await input.evaluate((el) => document.activeElement === el), true);
  assert.deepEqual(await input.evaluate((el) => [el.value, el.selectionStart, el.selectionEnd, el.selectionDirection]), ['Lower-row draft remains here', 3, 9, 'backward']);
  assert.equal(await middleInput.inputValue(), 'Displaced draft remains there');
  const changed = await snapshot();
  assert.deepEqual(changed.slice(0, 3), original.slice(0, 3));
  await page.keyboard.press('Control+Alt+Shift+ArrowLeft');
  await settled(page);
  await page.keyboard.press('Control+Alt+Shift+ArrowRight');
  await settled(page);
  assert.equal(await button('preview-6').count(), 0);
  assert.equal(await input.evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press('Control+Alt+Shift+ArrowRight');
  await settled(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await button('preview-3').focus();
  await page.keyboard.press('Enter');
  assert.equal(await active(), 'preview-2');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.workspace-pane-slot')].flatMap((el) => el.getAnimations()).length), 0);
  await page.keyboard.press('Enter');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.emulateMedia({ forcedColors: 'active' });
  assert.equal(await active(), 'preview-3');
  const forcedFocus = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { width: parseFloat(style.outlineWidth), style: style.outlineStyle, color: style.outlineColor };
  });
  // Forced-colors may strengthen the authored ring with browser/system metrics.
  await page.screenshot({ path: resolve(out, `${prefix}-forced-colors.png`) });
  assert.ok(forcedFocus.width >= 2 && forcedFocus.style !== 'none' && forcedFocus.color !== 'transparent', JSON.stringify(forcedFocus));
  await page.emulateMedia({ forcedColors: 'none' });
  // Enter the pane first: its hover state reveals the optional action.
  await page.locator('[data-pane-id="primary"]').hover();
  await button('primary').click();
  assert.equal(await active(), 'preview-2');
  await button('preview-2').click();
  assert.equal(await active(), 'primary');
  await settled(page);
  if (page.viewportSize().width >= 1000) {
    console.log('Swap browser check: unequal-width paragraph anchors in both conversations');
    const divider = page.getByRole('separator', { name: 'Resize horizontal workspace panes', exact: true }).first();
    await divider.press('ArrowRight');
    await divider.press('ArrowRight');
    const anchors = await page.evaluate(() => {
      window.__readingAnchors = ['primary', 'preview-2'].map((id) => {
        const pane = document.querySelector(`[data-pane-id="${id}"]`);
        const scroll = pane.querySelector('.transcript');
        const p = pane.querySelector('.assistant-text p');
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        const range = document.createRange();
        const offset = Math.min(60, text.length - 1);
        range.setStart(text, offset); range.setEnd(text, offset + 1);
        scroll.scrollTop += range.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 4;
        scroll.dispatchEvent(new Event('scroll'));
        // Track the first visible character, not an arbitrary later character
        // on that line (which may correctly wrap onto a new line).
        for (let index = 0; index < text.length; index++) {
          range.setStart(text, index); range.setEnd(text, index + 1);
          if (range.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top) break;
        }
        return { id, scroll, range, top: range.getBoundingClientRect().top - scroll.getBoundingClientRect().top };
      });
      return window.__readingAnchors.map(({ id, top }) => ({ id, top }));
    });
    await page.locator('[data-pane-id="primary"] textarea').first().focus();
    await page.keyboard.press('Control+Alt+Shift+ArrowLeft');
    await settled(page);
    const restored = await page.evaluate(() => window.__readingAnchors.map(({ id, scroll, range }) => ({ id, top: range.getBoundingClientRect().top - scroll.getBoundingClientRect().top })));
    for (let i = 0; i < anchors.length; i++) assert.ok(Math.abs(anchors[i].top - restored[i].top) <= 2, `Reading anchor moved in ${anchors[i].id}: ${anchors[i].top} -> ${restored[i].top}`);
    await page.keyboard.press('Control+Alt+Shift+ArrowLeft'); await settled(page);
  }
  assert.equal(await page.evaluate(() => window.__swapHosts.every((el) => el.isConnected && document.getElementById(el.id) === el)), true);
  await page.screenshot({ path: resolve(out, `${prefix}-after.png`) });
  const result = { prefix, animated, original, final: await snapshot(), evidence: 'Synthetic browser; real WorkspaceShell/AgentPane; native IPC and screen readers unverified' };
  await writeFile(resolve(out, `${prefix}.json`), JSON.stringify(result, null, 2));
  return result;
}
function boundedVerification(verify) {
  return async (page) => {
    // mouse.move and evaluate do not share Playwright locator timeouts. Closing
    // the owned context also releases an in-flight protocol wait on timeout.
    const deadline = setTimeout(() => { void page.context().close().catch(() => {}); }, 25000);
    try { return await verify(page); } finally { clearTimeout(deadline); }
  };
}
if (process.argv[2] === "drag") await capturePreview({ layout: "six", verify: boundedVerification(exerciseDrag) });
if (process.argv[2] === "swaps") await capturePreview({ layout: "six", width: Number(process.argv[3] || 1280), height: Number(process.argv[4] || 800), state: process.argv[5] || 'completed', verify: boundedVerification(exerciseSwaps) });
