import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { capturePreview } from "./run.mjs";

import { contrastRatio as contrast } from "./measurements.mjs";
const results = [];
for (const code of ["light", "charcoal"]) {
  for (const dimensions of [{ layout: "one", width: 1280, height: 800 }, { layout: "one", width: 390, height: 844 }, { layout: "six", width: 2560, height: 1400 }, { layout: "six", width: 2048, height: 1120 }]) {
    const evidence = await capturePreview({ variant: "light", code, ...dimensions, verify: async (page) => {
      await page.locator(".transcript").evaluateAll((elements) => elements.forEach((element) => {
        const pre = element.querySelector("pre");
        element.scrollTop += pre.getBoundingClientRect().top - element.getBoundingClientRect().top - 30;
      }));
      const colors = await page.evaluate(() => {
        const root = getComputedStyle(document.getElementById("root"));
        const bg = getComputedStyle(document.querySelector("pre")).backgroundColor;
        const palette = Object.fromEntries(["text", "keyword", "entity", "constant", "string", "symbol", "comment"].map((name) => [name, root.getPropertyValue(`--preview-code-${name}`).trim()]));
        const tokens = [...document.querySelectorAll("pre span[class]")].map((el) => ({ class: el.className, color: getComputedStyle(el).color }));
        const headerBg = getComputedStyle(document.querySelector(".chat-head")).backgroundColor;
        const footerBg = getComputedStyle(document.querySelector(".footer")).backgroundColor;
        const composerBg = getComputedStyle(document.querySelector(".inputwrap")).backgroundColor;
        const controls = [...document.querySelectorAll(".chat-head-cwd,.chat-head-dirty,.thinking-toggle,.model-label,.model-button,.ctx-meter")].map((el) => ({ class: el.className, color: getComputedStyle(el).color, bg: el.closest(".footer") ? footerBg : headerBg }));
        const toggle = document.querySelector(".cl-switch > span");
        return { bg, palette, tokens, headerBg, footerBg, composerBg, controls, toggleTrack: getComputedStyle(toggle, "::before").backgroundColor, toggleThumb: getComputedStyle(toggle, "::after").backgroundColor, placeholder: getComputedStyle(document.querySelector("textarea"), "::placeholder").color };
      });
      assert.equal(colors.headerBg, "rgb(239, 237, 243)");
      assert.equal(colors.footerBg, colors.headerBg);
      assert.equal(colors.composerBg, "rgb(246, 245, 249)");
      for (const [name, color] of Object.entries(colors.palette)) assert(contrast(color, colors.bg) >= 4.5, `${code} palette ${name} contrast`);
      assert(colors.tokens.some((token) => token.class.includes("hljs-comment")), "Actual comment syntax was not rendered");
      for (const token of colors.tokens) assert(contrast(token.color, colors.bg) >= 4.5, `${code} rendered ${token.class} contrast`);
      for (const control of colors.controls) assert(contrast(control.color, control.bg) >= 4.5, `${control.class} contrast`);
      assert(contrast(colors.placeholder, colors.composerBg) >= 4.5, "Placeholder contrast");
      assert(contrast(colors.toggleThumb, colors.toggleTrack) >= 3, "Off-state toggle contrast");
      // Let the workspace's existing pane-activation focus settle before keyboard traversal.
      await page.locator("textarea").first().focus();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator(".cl-switch input").first().focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.locator(".cl-switch").first().evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
      // Exercise the real copy handler, but never overwrite the user's OS clipboard.
      await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.__previewCopiedCode = text; } } }));
      const pre = page.locator(".markdown pre").first();
      const source = (await pre.textContent()).replace(/\n$/, "");
      await pre.hover();
      await page.getByRole("button", { name: "Copy code", exact: true }).first().click();
      await page.getByRole("button", { name: "Copied", exact: true }).first().waitFor();
      assert.equal(await page.evaluate(() => window.__previewCopiedCode), source);
      const padding = await pre.evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineEnd));
      const copyBox = await page.getByRole("button", { name: "Copied", exact: true }).first().boundingBox();
      assert(padding >= copyBox.width + 7, "Code text overlaps its copy control");
      return { code, ...colors, minimumSyntaxContrast: Math.min(...Object.values(colors.palette).map((color) => contrast(color, colors.bg))), copyHandler: "passed with mocked clipboard boundary" };
    } });
    results.push({ code, ...dimensions, evidence: evidence.additional });
  }
}
for (const variant of ["original", "reading"]) {
  await capturePreview({ variant, layout: "one", width: 1280, height: 800, code: "charcoal", verify: async (page) => {
    assert.equal(await page.locator("pre").first().evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(11, 13, 17)");
    return { originalCodeSurfaceUnchanged: true };
  } });
}
await capturePreview({ variant: "light", layout: "one", width: 1280, height: 800, state: "activity", verify: async (page) => {
  await page.locator(".livetoolpanel .tool-line").waitFor();
  const samples = await page.locator(".livetoolpanel .tool-line > span").evaluateAll((elements) => elements.map((el) => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el.closest(".livetoolpanel")).backgroundColor })));
  for (const sample of samples) assert(contrast(sample.color, sample.bg) >= 4.5, "Live tool text contrast");
  for (const isError of [false, true]) {
    await page.evaluate((isError) => window.__chatPreview.emit("primary", "tool_call_end", { toolCallId: "synthetic-read", isError, result: isError ? "Synthetic read failure" : "Synthetic read completed" }), isError);
    const dot = page.locator(`.tool-dot[title="${isError ? "Failed" : "Completed"}"]`);
    await dot.waitFor();
    assert.equal(await dot.evaluate((el) => getComputedStyle(el).color), isError ? "rgb(165, 42, 38)" : "rgb(36, 100, 59)");
  }
  return { toolTextContrast: "passed", successErrorColors: "preserved with light equivalents" };
} });
const output = new URL(`../../../.gg/eyes/out/chat-workspace-preview/surfaces-${Date.now()}.json`, import.meta.url);
await writeFile(output, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ output: output.href, comparisons: results.length, baselineIsolation: "passed" }));
