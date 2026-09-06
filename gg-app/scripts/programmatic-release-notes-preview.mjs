import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { initScript, responses } from "./capture-screenshots.mjs";

// Browser-only verification. Native window APIs and Decisions data are mocked;
// this never starts the daemon, runs a specialist, or verifies an installer.
const output = resolve(dirname(fileURLToPath(import.meta.url)), "../../.gg/screenshots");
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.addInitScript(initScript, {
    responses: {
      ...responses,
      app_verified_decisions: [{
        id: "preview-only",
        date: "2026-08-24",
        summary: {
          text: "Your custom provider setup stays exactly how you like it because it keeps fork-specific sessions separate. You still get upstream's clearer recovery guidance, so updates are easier to follow without giving up your setup.",
          source: "agent",
          generatedAt: "2026-08-24T10:00:15.000Z",
        },
        verification: { workflowVerified: true },
        decisions: [],
      }],
    },
    appVersion: "0.61.1",
  });
  for (const width of [600, 400]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("http://localhost:1420/?whatsnew=1");
    await page.getByRole("tab", { name: "Local Fork", exact: true }).click();
    const note = page.locator(".whatsnew-item").filter({ hasText: "Run one opportunity" });
    await note.scrollIntoViewIfNeeded();
    assert.ok(await note.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, `programmatic-local-${width}.png`) });

    await page.getByRole("tab", { name: "Decisions", exact: true }).click();
    await page.getByText(/Your custom provider setup stays exactly/).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole("button", { name: "Got it", exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, `programmatic-decisions-${width}.png`) });
  }
  console.log("PASS: both tabs at 600x640 and 400x640; no document horizontal overflow.");
  console.log("Native window APIs and Decisions data mocked. No daemon, specialist, packaging or installer verification.");
  console.log(`Screenshots: ${output}`);
} finally {
  await browser.close();
}
