import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { capturePreview } from "./run.mjs";

const findings = [];
for (const variant of ["original", "reading", "light"]) {
  const evidence = await capturePreview({ variant, layout: "one", width: 390, height: 844, verify: async (page) => {
    const accessibleNames = await page.getByRole("button", { name: "", exact: true }).count();
    assert.equal(accessibleNames, 0);
    const scannerTriage = await page.evaluate(() => {
      const rearrange = document.querySelector(".workspace-rearrangement-toggle");
      const rank = document.querySelector(".rank-name");
      const rankStyle = rank && getComputedStyle(rank);
      return {
        rearrangeDisabled: rearrange?.disabled,
        rank: rankStyle && { color: rankStyle.color, backgroundImage: rankStyle.backgroundImage, backgroundClip: rankStyle.backgroundClip },
        separators: [...document.querySelectorAll(".chat-head-sep,.footer-sep")].map((el) => ({ text: el.textContent, ariaHidden: el.getAttribute("aria-hidden") })),
        textSamples: [...document.querySelectorAll(".chat-head-cwd,.title-usage-reset,.statusrow")].map((el) => ({ class: el.className, color: getComputedStyle(el).color })),
      };
    });
    const input = page.locator("textarea");
    await input.focus();
    const keyboard = await input.evaluate((el) => ({ focusVisible: el.matches(":focus-visible"), caretColor: getComputedStyle(el).caretColor, outline: getComputedStyle(el).outlineStyle }));
    await page.locator(".assistant-text p").last().click();
    const pointer = await input.evaluate((el) => ({ focused: el === document.activeElement, focusVisible: el.matches(":focus-visible"), caretColor: getComputedStyle(el).caretColor, outline: getComputedStyle(el).outlineStyle }));
    for (let i = 0; i < 20; i++) await page.keyboard.press("Control+=");
    await page.waitForFunction(() => document.documentElement.style.zoom === "2");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const reflow = await page.evaluate(() => ({ zoom: getComputedStyle(document.documentElement).zoom, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, transcriptWidth: document.querySelector(".transcript")?.getBoundingClientRect().width, composer: document.querySelector("textarea")?.getBoundingClientRect().toJSON() }));
    assert.equal(reflow.documentWidth, reflow.viewport, "Document horizontally overflows at 200%");
    if (variant !== "original") assert(reflow.composer.top >= 0 && reflow.composer.bottom <= 844, "Candidate composer is clipped after keyboard focus at 200%");
    return { accessibleNames, scannerTriage, keyboard, pointer, reflow };
  } });
  findings.push({ variant, findings: evidence.additional });
}
const output = new URL(`../../../.gg/eyes/out/chat-workspace-preview/triage-${Date.now()}.json`, import.meta.url);
await writeFile(output, JSON.stringify(findings, null, 2));
console.log(JSON.stringify({ output: output.href, findings }, null, 2));
