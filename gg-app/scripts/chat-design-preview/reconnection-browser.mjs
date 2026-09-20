// Run against the opt-in server; never restart it or attach to a personal browser.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { previewCheckoutIdentity } from "./server-identity.mjs";
import { requireReady } from "./measurements.mjs";

const origin = "http://127.0.0.1:1420";
const path = "/__chat-design-preview?layout=one&capture=1";
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws://127.0.0.1:1420 ws://localhost:1420; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
for (const [key, value] of Object.entries(process.env)) {
  if (/CDP|BROWSER_ENDPOINT|PLAYWRIGHT.*(ENDPOINT|CONNECT)/i.test(key) && value) throw new Error("Inherited browser endpoint must be inspected first");
}
const response = await fetch(`${origin}${path}`, { redirect: "error", signal: AbortSignal.timeout(10000) });
assert.equal(response.status, 200);
assert.equal(response.headers.get("x-chat-preview"), "synthetic-only-v1");
assert.equal(response.headers.get("x-chat-preview-checkout"), previewCheckoutIdentity(fileURLToPath(new URL("../..", import.meta.url))));
assert.equal(response.headers.get("content-security-policy"), csp);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || /^\/(api|agent|events|sessions)(\/|$)/.test(url.pathname)) return route.abort();
    return route.continue();
  });
  await context.addInitScript(() => {
    window.__hmrTest = { sockets: [], violations: [], documentId: crypto.randomUUID() };
    addEventListener("securitypolicyviolation", (event) => window.__hmrTest.violations.push({ directive: event.effectiveDirective, uri: event.blockedURI }));
    // Preserve real constructor behavior. Only retain this owned page's socket handles.
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__hmrTest.sockets.push(this);
        if (args[1] === "vite-ping") this.addEventListener("open", () => console.debug("chat-preview-test: vite-ping opened"));
      }
    };
  });
  const page = await context.newPage();
  // Network-level safety net, not routeWebSocket: that API replaces the native
  // constructor and intercepts sockets before Chromium can apply CSP.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setBlockedURLs", { urls: ["ws://127.0.0.1:1/*", "wss://example.invalid/*"] });
  const errors = [];
  let pingOpened = false;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text() === "chat-preview-test: vite-ping opened") pingOpened = true;
  });
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
  await requireReady(page, 1, "completed");
  await page.waitForFunction(() => window.__hmrTest.sockets.some((socket) => socket.protocol === "vite-hmr" && socket.readyState === WebSocket.OPEN));
  const documentId = await page.evaluate(() => window.__hmrTest.documentId);
  await page.evaluate(() => {
    const sockets = window.__hmrTest.sockets.filter((socket) => socket.protocol === "vite-hmr" && socket.readyState === WebSocket.OPEN);
    if (sockets.length !== 1) throw new Error("Expected exactly one owned HMR socket");
    sockets[0].close();
  });
  try {
    await page.waitForFunction((previous) => window.__hmrTest?.documentId !== previous && document.readyState !== "loading", documentId, { timeout: 15000 });
  } catch (error) {
    console.error("Reconnect diagnostics:", await page.evaluate(() => ({ sharedWorker: typeof SharedWorker, violations: window.__hmrTest.violations })), { pingOpened });
    throw error;
  }
  assert.equal(pingOpened, true, "Vite's real main-thread WebSocket ping must open before reload");
  await requireReady(page, 1, "completed");
  assert.equal(await page.evaluate(() => typeof SharedWorker), "undefined");
  assert.deepEqual(await page.evaluate(() => window.__hmrTest.violations), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__chatPreview.errors), []);

  console.log("Reconnect passed; checking forbidden network destinations.");
  const isolation = await page.evaluate(async () => {
    const fetchBlocked = await fetch("http://127.0.0.1:1/api").then(() => false, (error) => error.message.includes("Network fetch disabled"));
    let eventsBlocked = false;
    try { new EventSource("http://127.0.0.1:1/events"); } catch (error) { eventsBlocked = error.message.includes("EventSource disabled"); }
    const destinations = ["ws://127.0.0.1:1/", "wss://example.invalid/"];
    for (const url of destinations) await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); reject(new Error(`No blocked-socket result: ${url}`)); }, 5000);
      socket.addEventListener("error", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("open", () => { clearTimeout(timer); socket.close(); reject(new Error("Forbidden socket opened")); }, { once: true });
    });
    return { fetchBlocked, eventsBlocked, destinations };
  });
  assert.equal(isolation.fetchBlocked, true);
  assert.equal(isolation.eventsBlocked, true);
  await page.waitForFunction(() => window.__hmrTest.violations.filter((event) => event.directive === "connect-src").length === 2);
  assert.deepEqual((await page.evaluate(() => window.__hmrTest.violations)).map((event) => event.uri).sort(), isolation.destinations.sort());
  // The connect-src violations above prove CSP rejected these, not just CDP.

  // Check the ordinary document in a separate context without running native app code.
  const ordinary = await browser.newContext({ serviceWorkers: "block" });
  await ordinary.route("**/*", (route) => route.request().resourceType() === "document" && route.request().url() === `${origin}/`
    ? route.continue() : route.abort());
  const normalPage = await ordinary.newPage();
  const normalResponse = await normalPage.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  assert.equal(normalResponse.status(), 200);
  assert.equal(normalResponse.headers()["x-chat-preview"], undefined);
  assert.equal(normalResponse.headers()["content-security-policy"], undefined);
  assert(!((await normalResponse.text()).includes("bootstrapPreview")));
  assert.deepEqual(await normalPage.evaluate(() => ({ worker: typeof SharedWorker, preview: typeof window.__chatPreview,
    fetch: Function.prototype.toString.call(fetch).includes("[native code]"), events: Function.prototype.toString.call(EventSource).includes("[native code]") })),
  { worker: "function", preview: "undefined", fetch: true, events: true });
  console.log("PASS: owned HMR disconnect → real vite-ping → reload ready; unchanged CSP and network isolation; ordinary document capabilities unchanged (app scripts blocked).");
} finally {
  await browser.close();
}
