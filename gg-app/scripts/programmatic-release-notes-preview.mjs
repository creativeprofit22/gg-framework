import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { initScript, responses, requireVisualFixtureUrl } from "./capture-screenshots.mjs";

// Browser-only verification. Native window APIs and Decisions IPC are mocked;
// records below are actual retained workflow evidence, not synthetic verification.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, ".gg/screenshots/upstream-0664-release-notes");
const baseUrl = requireVisualFixtureUrl(
  process.env.GG_RELEASE_PREVIEW_URL ?? "http://127.0.0.1:1436/",
);
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const notes = await readJson("gg-app/src/local-release-notes.json");
const app = await readJson("gg-app/package.json");
const recordPaths = [
  ".gg/local-fixes/backups/2026-09-22T06-31-25-214Z/decisions.json",
  ".gg/local-fixes/backups/2026-09-15T14-59-43-648Z/decisions.json",
  ".gg/local-fixes/backups/2026-09-08T04-18-39-833Z/decisions.json",
];
const records = await Promise.all(recordPaths.map(readJson));
for (const record of records) {
  assert.equal(record.verification.workflowVerified, true);
  assert.ok(record.evidence.merge);
  assert.ok(Array.from(record.summary.text).length >= 40);
  assert.ok(Array.from(record.summary.text).length <= 500);
}
assert.equal(records[0].evidence.merge, "04991d1277beb6eae7dfa7fb9177832cfdcbc4a9");
assert.equal(records[0].evidence.upstreamParent, "ec29187fabda3767663e0ff815423307ed3420a6");
assert.equal(records[0].verification.installer, null);
assert.equal(app.version, "0.66.4");
assert.equal(records[0].verification.checks, "passed");
const plain = (text) => text.replaceAll("`", "");
const browser = await chromium.launch({
  headless: true,
  executablePath: chromium.executablePath(),
});
const results = [];
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(initScript, {
    responses: { ...responses, app_verified_decisions: records },
    appVersion: app.version,
  });
  async function assertLayout() {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await page
        .locator(".whatsnew-item")
        .evaluateAll((items) => items.every((el) => el.scrollWidth <= el.clientWidth + 1)),
      true,
    );
    const button = page.getByRole("button", { name: "Got it", exact: true });
    assert.ok(await button.isVisible());
    const bounds = await button.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 640);
  }
  for (const width of [600, 400]) {
    await page.setViewportSize({ width, height: 640 });
    const url = new URL(baseUrl);
    url.searchParams.set("whatsnew", "1");
    await page.goto(url.href);
    await page.getByRole("tab", { name: "Local Fork", exact: true }).click();
    await page.getByText(notes.label, { exact: true }).waitFor();
    for (const item of notes.sections.flatMap((section) => section.items)) {
      const note = page.locator(".whatsnew-item").filter({ hasText: plain(item) });
      assert.equal(await note.count(), 1);
      await note.scrollIntoViewIfNeeded();
      assert.ok(await note.isVisible());
      await assertLayout();
    }
    assert.ok(
      await page.locator(".whatsnew-highlight").filter({ hasText: "Opportunities" }).count(),
    );
    await page
      .getByText("Upstream 0.63.4, with reviews that stay in reach", { exact: true })
      .scrollIntoViewIfNeeded();
    await assertLayout();
    await page.screenshot({ path: resolve(output, `local-history-${width}.png`) });
    await page.getByText(notes.label, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `local-latest-${width}.png`) });
    await page.getByRole("tab", { name: "Decisions", exact: true }).click();
    for (let index = 0; index < records.length; index++) {
      const summary = page
        .locator(".whatsnew-item")
        .filter({ hasText: plain(records[index].summary.text) });
      await summary.waitFor();
      assert.equal(await summary.count(), 1);
      await summary.scrollIntoViewIfNeeded();
      await assertLayout();
      await page.screenshot({
        path: resolve(
          output,
          `decisions-${index === 0 ? "latest" : `history-${index}`}-${width}.png`,
        ),
      });
    }
    results.push({
      width,
      height: 640,
      latestAndHistory: true,
      exactCurrentCopy: true,
      inlineHighlights: true,
      gotItVisible: true,
      noHorizontalOverflow: true,
    });
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(
    resolve(output, "preview-result.json"),
    JSON.stringify(
      {
        results,
        recordPaths,
        merge: records[0].evidence.merge,
        version: app.version,
        boundary:
          "Browser rendering only; native APIs and Decisions IPC mocked using real records. No daemon, paid model, installer, or installed-app verification.",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real Local Fork and Decisions copy, latest/history, highlights, scrolling, visible Got it, and no horizontal overflow at 600x640 and 400x640.",
  );
  console.log(
    `Screenshots: ${output}. Native APIs and Decisions IPC mocked; no installer verification.`,
  );
} finally {
  await browser.close();
}
