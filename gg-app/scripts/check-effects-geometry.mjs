// Run: pnpm --filter gg-app exec node scripts/check-effects-geometry.mjs
// Requires Playwright's Chromium and WebKit browsers. Optional executable overrides:
// CHROMIUM_EXECUTABLE and WEBKIT_EXECUTABLE. No desktop credentials/session needed.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { build, preview } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".gg"), { recursive: true });
const temporary = await mkdtemp(path.join(root, ".gg/effects-geometry-"));
let server;
try {
  const entry = path.join(temporary, "index.html");
  const original = await readFile(path.join(root, "index.html"), "utf8");
  assert(original.includes('id="app-style-nonce"'));
  await writeFile(
    entry,
    original.replace("/src/main.tsx", "/scripts/fixtures/effects-geometry.tsx"),
  );
  const outDir = path.join(temporary, "dist");
  await build({ root, build: { outDir, rolldownOptions: { input: entry } } });
  server = await preview({ root, build: { outDir }, preview: { host: "127.0.0.1", port: 0 } });
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const relative = path.relative(root, entry).split(path.sep).join("/");
  const url = `http://127.0.0.1:${address.port}/${relative}`;
  const {
    app: {
      security: { csp },
    },
  } = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  // Emulate Tauri's per-window authorization of the initial inline stylesheet.
  const policy = csp.replace(/style-src([^;]*)/, "style-src$1 'nonce-geometry-test'");
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const executablePath = process.env[`${name.toUpperCase()}_EXECUTABLE`];
    const browser = await engine.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      for (const zoom of [0.5, 0.95, 1, 1.25, 2]) {
        const page = await browser.newPage({
          viewport: { width: 900, height: 600 },
          deviceScaleFactor: 2,
        });
        try {
          await page.addInitScript((value) => {
            document.addEventListener("DOMContentLoaded", () => {
              document.documentElement.style.zoom = String(value);
            });
          }, zoom);
          await page.route("**/index.html", async (route) => {
            const response = await route.fetch();
            await route.fulfill({
              response,
              body: (await response.text()).replace(
                '<style id="app-style-nonce">',
                '<style id="app-style-nonce" nonce="geometry-test">',
              ),
              headers: { ...response.headers(), "content-security-policy": policy },
            });
          });
          await page.goto(url);
          await page.waitForSelector(".enhance-pill-host .metal-fx-rim-canvas", {
            state: "attached",
          });
          // Allow the appearance transition to finish, without forcing an artificial resize.
          await page.waitForTimeout(500);
          const measurements = await page.locator(".metal-fx-root").evaluateAll((roots) =>
            roots.map((host) => {
              const rim = host.querySelector(".metal-fx-rim-canvas");
              return {
                width: host.offsetWidth,
                height: host.offsetHeight,
                rimWidth: rim ? parseFloat(rim.style.width) + 2 * parseFloat(rim.style.left) : null,
                rimHeight: rim
                  ? parseFloat(rim.style.height) + 2 * parseFloat(rim.style.top)
                  : null,
              };
            }),
          );
          assert.equal(measurements.length, 3, "Enhance, Send and New must all render real metal");
          for (const measurement of measurements) {
            assert(measurement.rimWidth !== null && measurement.rimHeight !== null);
            assert(
              Math.abs(measurement.width - measurement.rimWidth) <= 1,
              `${name} zoom=${zoom}: ${JSON.stringify(measurement)}`,
            );
            assert(
              Math.abs(measurement.height - measurement.rimHeight) <= 1,
              `${name} zoom=${zoom}: ${JSON.stringify(measurement)}`,
            );
          }
          await page.getByRole("button", { name: "GG UI on" }).click();
          assert.equal(await page.locator(".action-metal").count(), 0);
          assert.equal(
            await page.getByRole("button", { name: "Enhance?", exact: true }).count(),
            1,
          );
          assert.equal(await page.evaluate(() => localStorage.getItem("gg-ui-enabled")), "0");
          await page.reload();
          await page.getByRole("button", { name: "GG UI off" }).waitFor();
          assert.equal(await page.locator(".action-metal").count(), 0);
          await page.getByRole("button", { name: "GG UI off" }).click();
          await page.waitForFunction(
            () => document.querySelectorAll(".metal-fx-rim-canvas").length === 3,
          );
          console.log(
            `PASS ${name} ${zoom * 100}%: matching rims, toggle off/on, persisted after reload`,
          );
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  if (server)
    await new Promise((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(temporary, { recursive: true, force: true });
}
