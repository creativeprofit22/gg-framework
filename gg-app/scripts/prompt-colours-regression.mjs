import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { initScript, requireVisualFixtureUrl, responses } from "./capture-screenshots.mjs";

const url = requireVisualFixtureUrl(process.env.GG_SHOT_URL ?? "http://127.0.0.1:1421");
const output = fileURLToPath(new URL("../../.gg/screenshots/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(initScript, {
    responses: {
      ...responses,
      agent_history: { history: [
        { role: "user", text: "Help me quickly identify my prompts in this conversation. Preserve readable wrapping for longer messages, including café and 日本語." },
        { role: "assistant", text: "Your messages should stand out while assistant replies retain their familiar appearance." },
        { role: "user", text: "@Ken review this approach", ken: true },
        { role: "user", text: "/plan", command: "plan" },
        { role: "user", text: "Mentor handoff", kenSent: true },
      ] },
      agent_sessions: { sessions: [] },
      agent_pane_restore: 1,
    },
    appVersion: "0.62.1",
  });
  await context.addInitScript(() => {
    localStorage.setItem("gg-workspace-layout-recursive:main", JSON.stringify({
      version: 9,
      root: { type: "leaf", paneId: "primary" },
      focusedPaneId: "primary",
      panes: { primary: { kind: "agent", mode: "code", cwd: "/Users/demo/projects/aurora-store", sessionPath: null } },
    }));
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".user-msg.user-ken").waitFor();
  await page.locator("textarea.input").fill("Composer stays unchanged");
  // Freeze transient states on copies of the real rendered prompt. This tests
  // their CSS, not the native event transport or queue timing.
  await page.locator(".user-msg:not(.command):not(.user-ken)").first().evaluate((prompt) => {
    prompt.dataset.colourProbe = "ordinary";
    for (const state of ["queued", "promoted"]) {
      const copy = prompt.cloneNode(true);
      copy.classList.add(state);
      copy.dataset.colourProbe = state;
      copy.textContent = `${state === "queued" ? "Queued" : "Promoted"} prompt — existing styling preserved`;
      prompt.parentElement.appendChild(copy);
    }
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = 150;
    }
  });
  for (const [name, width] of [["desktop", 1280], ["narrow", 420]]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await page.evaluate(() => {
      const selectors = {
        ordinary: '[data-colour-probe="ordinary"]',
        composer: "textarea.input",
        assistant: ".assistant-text",
        ken: ".user-msg.user-ken",
        command: ".user-msg.command:not(.user-ken-sent)",
        commandText: ".user-msg.command:not(.user-ken-sent) .command-shimmer",
        kenSent: ".user-msg.user-ken-sent",
        queued: '[data-colour-probe="queued"]',
        promoted: '[data-colour-probe="promoted"]',
      };
      const measure = () => Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing ${key}: ${selector}`);
        const style = getComputedStyle(element);
        return [key, { color: style.color, background: style.backgroundColor, border: style.borderTopColor, borderStyle: style.borderTopStyle, opacity: style.opacity }];
      }));
      const rule = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
        .find((rule) => rule.selectorText?.startsWith(".user-msg:where("));
      if (!rule) throw new Error("Missing prompt identity rule");
      const current = measure();
      const saved = rule.style.cssText;
      let baseline;
      try {
        rule.style.cssText = "";
        baseline = measure();
      } finally {
        rule.style.cssText = saved;
      }
      const prompt = document.querySelector(selectors.ordinary);
      const rect = prompt.getBoundingClientRect();
      return { current, baseline, geometry: { left: rect.left, right: rect.right, width: innerWidth, scrollWidth: prompt.scrollWidth, clientWidth: prompt.clientWidth } };
    });
    for (const key of ["ordinary", "command"]) {
      assert.equal(result.current[key].color, "rgb(191, 219, 254)");
      assert.equal(result.current[key].background, "rgb(23, 43, 70)");
      assert.equal(result.current[key].border, "rgb(54, 87, 125)");
      assert.notDeepEqual(result.current[key], result.baseline[key]);
    }
    for (const key of ["composer", "assistant", "ken", "kenSent", "commandText", "queued", "promoted"]) {
      assert.deepEqual(result.current[key], result.baseline[key], `${name}: ${key} styling changed`);
    }
    assert.ok(result.geometry.left >= 0 && result.geometry.right <= result.geometry.width, `${name}: prompt escaped viewport`);
    assert.ok(result.geometry.scrollWidth <= result.geometry.clientWidth, `${name}: prompt text overflow`);
    await page.screenshot({ path: `${output}/prompt-colours-${name}.png`, fullPage: true });
    console.log(`${name}: prompt and slash-command colours, seven preserved styles, and wrapping passed`);
  }
} finally {
  await browser.close();
}
