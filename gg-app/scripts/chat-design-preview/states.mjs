import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { capturePreview } from "./run.mjs";

const results = [];
const states = ["empty", "activity", "error", "retry", "variants", "completed"];
const requested = process.argv[2];
if (requested && !states.includes(requested)) throw new Error("Unsupported fixture state");
for (const variant of ["original", "reading", "light"]) {
  for (const state of requested ? [requested] : states) {
    try {
      const evidence = await capturePreview({ variant, state, layout: "one", width: 1280, height: 800, verify: async (page) => {
        if (state === "empty") assert.equal(await page.locator(".assistant-text").count(), 0);
        if (state === "activity") await page.getByText("preview-only.ts", { exact: false }).first().waitFor();
        if (state === "error") {
          const headline = page.getByText("Synthetic provider failure", { exact: true });
          await headline.waitFor();
          if (variant === "light") assert.equal(await headline.evaluate((element) => getComputedStyle(element).color), "rgb(165, 42, 38)");
        }
        if (state === "retry") {
          const retry = page.getByRole("button", { name: "Retry Roadmap review" });
          await retry.waitFor();
          await page.evaluate(() => { window.__chatPreview.allowRetry = true; });
          await retry.click();
          await retry.waitFor({ state: "detached" });
        }
        if (state === "variants") {
          assert.equal(await page.locator(".user-msg.command").count(), 2);
          assert.equal(await page.locator(".user-ken").count(), 1);
          await page.locator(".transcript").evaluate((element) => { element.scrollTop = element.scrollHeight; });
          if (variant === "light") assert.equal(await page.locator(".user-ken-sent .command-shimmer").evaluate((element) => getComputedStyle(element).color), "rgb(18, 102, 99)");
          await page.evaluate(() => window.__chatPreview.emit("primary", "run_start"));
          await page.locator("textarea").fill("Synthetic queued follow-up; no model request.");
          await page.locator("textarea").press("Enter");
          await page.locator(".user-msg.queued").waitFor();
          await page.evaluate(() => window.__chatPreview.emit("primary", "queued", { count: 1, messages: [{ id: "q1", text: "Synthetic queued follow-up; no model request." }] }));
          await page.evaluate(() => new Promise(requestAnimationFrame));
          await page.evaluate(() => window.__chatPreview.emit("primary", "queued", { count: 0, messages: [] }));
          await page.locator(".user-msg.promoted").waitFor();
          await page.evaluate(() => window.__chatPreview.emit("primary", "run_end"));
        }
        const unnamedButtons = await page.getByRole("button", { name: "", exact: true }).evaluateAll((elements) => elements.map((el) => ({ tag: el.outerHTML.slice(0, 500), title: el.getAttribute("title") })));
        const result = { stateRendered: true, retryRecovered: state === "retry", queuedAndPromoted: state === "variants", unnamedButtons };
        if (state === "completed") {
          const input = page.locator("textarea");
          await input.focus(); await page.keyboard.press("Tab");
          result.keyboardFocusVisible = await page.evaluate(() => document.activeElement?.matches(":focus-visible"));
          await page.locator(".assistant-text p").last().click();
          result.pointerFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, focusVisible: document.activeElement?.matches(":focus-visible") }));
          for (let i = 0; i < 20; i++) await page.keyboard.press("Control+=");
          await page.waitForFunction(() => document.documentElement.style.zoom === "2");
          result.zoom200 = await page.evaluate(() => ({ zoom: getComputedStyle(document.documentElement).zoom, innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, composerVisible: !!document.querySelector("textarea") }));
          await page.keyboard.press("Control+0");
          await page.waitForFunction(() => document.documentElement.style.zoom === "1");
        }
        return result;
      } });
      results.push({ variant, state, status: "passed", evidence: evidence.additional });
    } catch (error) { results.push({ variant, state, status: "failed", error: String(error) }); }
  }
}
const output = new URL(`../../../.gg/eyes/out/chat-workspace-preview/states-${Date.now()}.json`, import.meta.url);
await writeFile(output, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ output: output.href, results }, null, 2));
if (results.some((result) => result.status === "failed")) process.exitCode = 1;
