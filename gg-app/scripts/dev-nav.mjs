#!/usr/bin/env node
/**
 * Navigate the running dev app to named screens and screenshot them.
 *
 *   node gg-app/scripts/dev-nav.mjs settings chat
 *   node gg-app/scripts/dev-nav.mjs all --viewports 1280x800,390x844
 *   node gg-app/scripts/dev-nav.mjs home --out <dir> --url http://127.0.0.1:PORT
 *
 * --out defaults to .gg/screenshots/dev-nav at the repo root. --url defaults to
 * GG_SHOT_URL, then http://127.0.0.1:1420; only loopback URLs are accepted.
 *
 * Needs `pnpm --filter gg-app dev --host 127.0.0.1` already running. The
 * native shell is simulated with the synthetic fixture from
 * capture-screenshots.mjs: no daemon, no credentials, and every non-loopback
 * request is blocked. Screens prove browser rendering only, never native
 * Tauri, IPC, or installer behaviour.
 *
 * Exits 1 when a step fails, the page throws, the console logs an error, an
 * error banner ([role=alert]) is visible, or the page scrolls sideways, so a
 * broken route is never mistaken for a fresh screenshot.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initScript, requireVisualFixtureUrl, responses } from "./capture-screenshots.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const STEP_TIMEOUT_MS = 5000;

const openProject = [
  { click: "role=button[name='Code']", waitFor: ".picker-item" },
  { click: ".picker-item >> nth=0", waitFor: "text=+ New session" },
];
const openSession = [...openProject, { click: "text=+ New session", waitFor: "textarea" }];

/** Fictional run so the transcript has a prompt, tool calls and a reply. */
async function playChat(page) {
  await page.fill("textarea", "Why does checkout double-charge on a flaky connection?");
  await page.keyboard.press("Enter");
  const emit = (type, data = {}) => page.evaluate(([t, d]) => window.__ggEmit(t, d), [type, data]);
  await emit("run_start");
  await emit("tool_call_start", {
    toolCallId: "t1",
    name: "grep",
    args: { pattern: "idempotenc" },
  });
  await emit("tool_call_end", { toolCallId: "t1", result: "no matches", isError: false });
  await emit("tool_call_start", {
    toolCallId: "t2",
    name: "read",
    args: { file_path: "src/routes/checkout.ts" },
  });
  await emit("tool_call_end", { toolCallId: "t2", result: "read 184 lines", isError: false });
  await emit("text_delta", {
    text: "`POST /api/checkout` has no replay protection, so a retry lands as a second charge.\n\nThe fix is an **idempotency key**.",
  });
  await emit("turn_end", { usage: { inputTokens: 18240, outputTokens: 640 } });
  await emit("agent_done");
  await emit("run_end");
}

/** Screen name → steps from a fresh load of Home. */
export const SCREENS = {
  home: { steps: [] },
  projects: { steps: openProject.slice(0, 1) },
  sessions: { steps: openProject },
  workspace: { steps: openSession },
  chat: { steps: openSession, play: playChat },
  notes: {
    steps: [...openSession, { click: "role=button[name='Notes']", waitFor: "role=dialog" }],
  },
  tasks: {
    steps: [...openSession, { click: "role=button[name='Tasks']", waitFor: "role=dialog" }],
  },
  settings: { steps: [{ click: "role=button[name='Settings']", waitFor: ".settings-page" }] },
  // The tray menu's Settings item opens the dialog form of the same panel.
  "settings-dialog": {
    responses: { window_tray_intent: "settings" },
    steps: [{ waitFor: ".modal.settings-modal" }],
  },
};

export function parseViewport(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (!match) throw new Error(`Viewport must look like 1280x800, received "${value}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function parseArgs(argv) {
  const options = {
    screens: [],
    viewports: [parseViewport("1280x800"), parseViewport("390x844")],
    out: resolve(here, "../../.gg/screenshots/dev-nav"),
    url: requireVisualFixtureUrl(process.env.GG_SHOT_URL ?? "http://127.0.0.1:1420"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--viewports") options.viewports = value().split(",").map(parseViewport);
    else if (arg === "--out") options.out = resolve(value());
    else if (arg === "--url") options.url = requireVisualFixtureUrl(value());
    else if (arg === "all") options.screens.push(...Object.keys(SCREENS));
    else if (arg in SCREENS) options.screens.push(arg);
    else
      throw new Error(`Unknown screen "${arg}". Screens: ${Object.keys(SCREENS).join(", ")}, all`);
  }
  if (options.screens.length === 0)
    throw new Error(`Name at least one screen: ${Object.keys(SCREENS).join(", ")}, all`);
  options.screens = [...new Set(options.screens)];
  return options;
}

/** The repo's Playwright browser first; installed Chrome or Edge if it is missing. */
async function launchBrowser() {
  const attempts = [{}, { channel: "chrome" }, { channel: "msedge" }];
  let lastError;
  for (const extra of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, ...extra });
      return { browser, label: extra.channel ?? "playwright chromium" };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `No usable browser. Run "npx playwright install chromium" or install Chrome.\n${lastError}`,
  );
}

async function capture(browser, options, name, viewport) {
  const screen = SCREENS[name];
  const problems = [];
  const context = await browser.newContext({ viewport });
  try {
    await context.route("**/*", (route) =>
      LOOPBACK.has(new URL(route.request().url()).hostname) ? route.continue() : route.abort(),
    );
    await context.addInitScript(initScript, {
      responses: { ...responses, ...screen.responses },
      appVersion: "0.0.0-dev-nav",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text().slice(0, 200)}`);
    });
    await page.goto(options.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#root > *", { timeout: STEP_TIMEOUT_MS });
    for (const step of screen.steps) {
      try {
        if (step.click) await page.click(step.click, { timeout: STEP_TIMEOUT_MS });
        if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout: STEP_TIMEOUT_MS });
      } catch {
        problems.push(`step failed: ${step.click ?? "wait"} → ${step.waitFor ?? "(none)"}`);
        break;
      }
    }
    if (screen.play && problems.length === 0) await screen.play(page);
    // Let entrance animations settle; the steps above already waited for content.
    await page.waitForTimeout(700);
    const alerts = await page
      .locator("[role=alert]:visible")
      .allInnerTexts()
      .then((texts) => texts.map((t) => t.trim()).filter(Boolean));
    for (const text of alerts)
      problems.push(`visible alert: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    if (overflowX) problems.push("page scrolls sideways");
    const file = resolve(options.out, `${name}-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: file });
    return { file, problems };
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    await fetch(options.url, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(
      `Dev server is not answering at ${options.url}. Start: pnpm --filter gg-app dev --host 127.0.0.1`,
    );
  }
  await mkdir(options.out, { recursive: true });
  const { browser, label } = await launchBrowser();
  console.log(`dev-nav: ${label}, synthetic native fixture, ${options.url}`);
  let failed = 0;
  try {
    for (const name of options.screens) {
      for (const viewport of options.viewports) {
        const { file, problems } = await capture(browser, options, name, viewport);
        failed += problems.length > 0 ? 1 : 0;
        console.log(
          `${problems.length ? "✗" : "✓"} ${name} ${viewport.width}x${viewport.height} → ${file}`,
        );
        for (const problem of problems) console.log(`    ${problem}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failed > 0) {
    console.log(`\n${failed} capture(s) had problems; their screenshots show the broken state.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`dev-nav: ${error.message}`);
    process.exitCode = 1;
  });
}
