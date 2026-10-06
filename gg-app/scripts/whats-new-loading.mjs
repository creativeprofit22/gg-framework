import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { initScript, responses } from "./capture-screenshots.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  define: { "import.meta.env.VITE_GG_LOCAL_PATCHED": JSON.stringify("1") },
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  // Node-side expectations never enter the browser module graph.
  const { availableWhatsNewFeeds } = await server.ssrLoadModule("/src/whats-new.ts");
  const feeds = availableWhatsNewFeeds(true);
  const heads = Object.fromEntries(feeds.map((feed) => [feed.id, feed.entries[0].id]));
  browser = await chromium.launch({ headless: true });
  for (const home of [false, true]) {
    const context = await browser.newContext();
    await context.addInitScript(initScript, { responses, appVersion: "0.62.1" });
    await context.addInitScript((heads) => {
      localStorage.setItem("gg-app:whatsNewHeads:v1", JSON.stringify(heads));
      window.__notesOpens = 0;
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "open_whatsnew_window") {
          window.__notesOpens++;
          return Promise.resolve();
        }
        return invoke(cmd, args);
      };
    }, heads);
    const page = await context.newPage();
    const histories = [];
    page.on("request", (request) => {
      if (/\/src\/(?:local-changelog|changelog)\.ts(?:\?|$)/.test(request.url()))
        histories.push(request.url());
    });
    await page.goto(url);
    await page.locator(".app").first().waitFor();
    await page.waitForLoadState("networkidle");
    if (home) {
      // Mount the real HomeScreen independently, using only native IPC mocks.
      await page.evaluate(async () => {
        const { default: React } = await import("/node_modules/.vite/deps/react.js");
        const { default: ReactDOM } = await import("/node_modules/.vite/deps/react-dom_client.js");
        const { HomeScreen } = await import("/src/HomeScreen.tsx");
        const container = document.createElement("div");
        document.body.append(container);
        ReactDOM.createRoot(container).render(
          React.createElement(HomeScreen, {
            onProjects() {},
            onChat() {},
            onLogin() {},
          }),
        );
      });
      await page.getByRole("button", { name: "What's new", exact: true }).last().waitFor();
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new StorageEvent("storage", { key: "gg-app:whatsNewHeads:v1" }));
      });
      await page.waitForLoadState("networkidle");
    }
    assert.deepEqual(
      histories,
      [],
      `${home ? "HomeScreen" : "Workspace"} requested histories before notes opened`,
    );
    assert.equal(await page.evaluate(() => window.__notesOpens), 0);
    if (home) {
      await page.getByRole("button", { name: "What's new", exact: true }).last().click();
      await page.waitForFunction(() => window.__notesOpens === 1);
    }
    // Native window creation is mocked: navigate to its real frontend entry.
    await page.goto(`${url}?whatsnew=1`);
    await page.getByRole("tab", { name: /Local Fork/ }).waitFor();
    for (const feed of feeds) {
      await page.getByRole("tab", { name: new RegExp(feed.label) }).click();
      assert.deepEqual(
        await page.locator('[role="tabpanel"]:visible .whatsnew-item').allTextContents(),
        feed.entries.flatMap(({ items }) => items.map((item) => item.replace(/`([^`]+)`/g, "$1"))),
      );
    }
    assert.ok(histories.some((url) => url.includes("/src/changelog.ts")));
    assert.ok(histories.some((url) => url.includes("/src/local-changelog.ts")));
    console.log(
      `${home ? "HomeScreen + focus/storage" : "Workspace"}: zero history requests before opening; both histories requested and exact capped content rendered after opening (native IPC mocked).`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
