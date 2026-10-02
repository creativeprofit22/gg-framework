// Synthetic Tasks-modal smoke: mounts the REAL TasksModal (and the app's real
// CSS) with synthetic tasks and in-memory handlers. No task is ever run and
// nothing is deleted on disk — every non-dev-server request is aborted. This
// verifies rendered presentation, keyboard/focus and failure handling only; it
// does not verify native IPC, the sidecar task store, or installer behaviour.
//
// Usage:
//   node scripts/tasks-actions-dev-smoke.mjs                 # hosts its own Vite server
//   node scripts/tasks-actions-dev-smoke.mjs --origin http://127.0.0.1:1420
//   node scripts/tasks-actions-dev-smoke.mjs --evidence <dir> # screenshots + report.json
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createServer } from "vite";
import { checkoutIdentity } from "./appearance-dev-identity.mjs";
import { initScript, responses } from "./capture-screenshots.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: { origin: { type: "string" }, evidence: { type: "string" } },
});
const evidence = args.evidence ? resolve(args.evidence) : null;

const LONG_TITLE =
  "Blocked task with a deliberately long title that must wrap to two lines instead of being ellipsised away";
const VIEWPORTS = [
  // label, width, height, coarse pointer (touch) — delete floor is 32px fine, 44px coarse.
  ["desktop", 1280, 800, false],
  ["narrow", 390, 844, true],
];

async function mount(page, origin) {
  // Loading the real entry first keeps the app's own stylesheet in <head>.
  await page.goto(origin);
  await page.evaluate(async () => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const {
      default: { createRoot },
    } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { TasksModal } = await import("/src/TasksModal.tsx");
    const now = "2026-09-21T12:00:00.000Z";
    const tasks = [
      {
        id: "pending",
        title: "Restore the transcript scroll anchor after a compaction pass",
        prompt:
          "Reproduce the jump first, then fix the anchor.\n\n" +
          "Keep the existing helpers and re-run the affected checks. ".repeat(24),
        status: "pending",
        createdAt: now,
      },
      {
        id: "blocked",
        title:
          "Blocked task with a deliberately long title that must wrap to two lines instead of being ellipsised away",
        prompt: "Waiting on the daemon fixture.",
        status: "blocked",
        createdAt: now,
      },
      {
        id: "running",
        title: "Running task",
        prompt: "Already in progress in another session.",
        status: "in-progress",
        createdAt: now,
      },
      {
        id: "done",
        title: "Finished task",
        prompt: "Nothing left to do.",
        status: "done",
        createdAt: now,
      },
    ];
    window.calls = [];
    window.failDelete = true;
    document.body.innerHTML = '<div id="fixture-root"></div>';
    const root = createRoot(document.querySelector("#fixture-root"));
    const render = (list) =>
      root.render(
        React.createElement(TasksModal, {
          tasks: list,
          running: false,
          onRun: async (id) => {
            window.calls.push(["run", id]);
          },
          onRunAll: async () => {
            window.calls.push(["run-all"]);
          },
          onDelete: async (id) => {
            window.calls.push(["delete", id]);
            if (window.failDelete) throw Error("Synthetic sidecar refused the delete");
            render(list.filter((t) => t.id !== id));
          },
          onClose: () => {
            window.calls.push(["close"]);
          },
        }),
      );
    render(tasks);
  });
  await page.getByRole("button", { name: /^Inspect task: Restore the transcript/ }).waitFor();
}

async function shot(page, name) {
  if (evidence) await page.screenshot({ path: resolve(evidence, `${name}.png`) });
}

async function journey(browser, origin, [label, width, height, touch], report) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    hasTouch: touch,
    isMobile: touch,
  });
  // Only the dev server is reachable: nothing can leave the fixture.
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await context.addInitScript(initScript, { responses, appVersion: "0.66.4" });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${label}: ${error.stack ?? error.message}`));
  try {
    await mount(page, origin);

    // Wording reflects what the run actually is, and done tasks offer no run.
    for (const name of [
      "Run: Restore the transcript scroll anchor after a compaction pass",
      `Retry: ${LONG_TITLE}`,
      "Run again: Running task",
    ])
      await page.getByRole("button", { name, exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: /^(Run|Retry|Run again): Finished task$/ }).count(),
      0,
      `${label}: done task must not offer a run control`,
    );

    // Hit area of the removal control, measured where the app's own CSS applies.
    const deleteBox = await page
      .getByRole("button", { name: "Delete task: Finished task", exact: true })
      .boundingBox();
    const floor = touch ? 44 : 32;
    assert.ok(
      deleteBox && deleteBox.width + 0.5 >= floor && deleteBox.height + 0.5 >= floor,
      `${label}: delete hit area ${deleteBox?.width}x${deleteBox?.height} below ${floor}px`,
    );

    // Long titles wrap to (at most) two lines rather than a single ellipsised line.
    const title = await page
      .getByRole("button", { name: `Inspect task: ${LONG_TITLE}`, exact: true })
      .evaluate((element) => {
        const style = getComputedStyle(element);
        const content =
          element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        return {
          lines: content / parseFloat(style.lineHeight),
          whiteSpace: style.whiteSpace,
          clamped: element.scrollHeight > element.clientHeight + 1,
        };
      });
    assert.notEqual(title.whiteSpace, "nowrap", `${label}: task titles must not be single-line`);
    assert.ok(
      title.lines > 1.5 && title.lines < 2.1,
      `${label}: long title renders ${title.lines.toFixed(2)} lines, expected two`,
    );
    await shot(page, `${label}-list`);

    // Keyboard into the detail panel: the full prompt scrolls internally while
    // the actions row stays on screen, then Back returns focus to the title.
    await page.getByRole("button", { name: /^Inspect task: Restore the transcript/ }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: /Back to tasks/ }).waitFor();
    const promptBox = await page.locator(".tasks-detail-prompt").evaluate((element) => ({
      scroll: element.scrollHeight,
      client: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      text: element.textContent.length,
    }));
    assert.ok(
      promptBox.scroll > promptBox.client + 1 && /auto|scroll/.test(promptBox.overflowY),
      `${label}: long prompt must scroll inside the detail panel`,
    );
    const actions = await page
      .locator(".tasks-detail .tasks-actions")
      .evaluate((element) => element.getBoundingClientRect().toJSON());
    assert.ok(
      actions.top >= 0 && actions.bottom <= height,
      `${label}: detail actions row is off screen`,
    );
    await shot(page, `${label}-detail`);
    await page.getByRole("button", { name: /Back to tasks/ }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.activeElement?.getAttribute("aria-label")?.startsWith("Inspect task: Restore"),
    );

    // Cancel: confirmation opens with the least-destructive control focused,
    // changes nothing, and returns focus to the control that opened it.
    await page.getByRole("button", { name: /^Delete task: Running task$/ }).click();
    await page.getByRole("alertdialog").waitFor();
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "Keep task",
      `${label}: Keep task was not initially focused`,
    );
    await shot(page, `${label}-confirm`);
    await page.getByRole("button", { name: "Keep task", exact: true }).click();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Delete task: Running task",
    );
    assert.equal(
      await page.evaluate(() => window.calls.length),
      0,
      `${label}: cancel dispatched an action`,
    );

    // Failure: the task survives, the confirmation stays, the error shows.
    await page.getByRole("button", { name: /^Delete task: Running task$/ }).click();
    await page.getByRole("button", { name: "Delete task", exact: true }).click();
    await page.getByText("Synthetic sidecar refused the delete").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Delete task", exact: true }).isDisabled(),
      false,
      `${label}: confirm stayed disabled after a failed delete`,
    );
    await page.getByRole("button", { name: /^Inspect task: Running task$/ }).waitFor();
    await shot(page, `${label}-delete-failure`);

    // Success: focus lands on a surviving task.
    await page.evaluate(() => {
      window.failDelete = false;
    });
    await page.getByRole("button", { name: "Delete task", exact: true }).click();
    await page.waitForFunction(() =>
      document.activeElement?.getAttribute("aria-label")?.startsWith("Inspect task: "),
    );
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert.notEqual(focused, "Inspect task: Running task", `${label}: focus on the deleted task`);
    await shot(page, `${label}-after-delete`);

    const overflow = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[role=dialog]")).map((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
      })),
    );
    assert.ok(overflow.length > 0, `${label}: no dialog rendered`);
    assert.ok(
      overflow.every((entry) => entry.scroll <= entry.width + 1),
      `${label}: dialog horizontal overflow`,
    );

    // Only in-memory deletes were ever dispatched; nothing ran.
    const calls = await page.evaluate(() => window.calls);
    assert.deepEqual(calls, [
      ["delete", "running"],
      ["delete", "running"],
    ]);
    report.journeys.push({ label, deleteBox, title, promptBox, focused, overflow, calls });
  } finally {
    await context.close();
  }
}

let server;
let origin = args.origin ? new URL(args.origin).origin : null;
const report = {
  boundary:
    "Actual TasksModal UI and CSS; synthetic in-memory handlers. No real task run, no real deletion, not native IPC or disk persistence.",
  journeys: [],
  errors: [],
};
let browser;
try {
  if (!origin) {
    server = await createServer({
      root: appRoot,
      logLevel: "warn",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    origin = new URL(server.resolvedUrls.local[0]).origin;
  }
  const identity = await (
    await fetch(`${origin}/__gg-app-dev-identity`, { signal: AbortSignal.timeout(5000) })
  ).json();
  assert.equal(identity.checkout, checkoutIdentity(), `${origin} serves a different checkout`);
  assert.equal(identity.preview, false, `${origin} is a design preview, not the app`);
  report.identity = identity;
  if (evidence) await mkdir(evidence, { recursive: true });

  browser = await chromium.launch({ headless: true });
  for (const viewport of VIEWPORTS) await journey(browser, origin, viewport, report);
  assert.deepEqual(report.errors, [], "page errors");
  console.log(
    `Tasks actions smoke passed at ${report.journeys.map((j) => j.label).join(" + ")} with zero page errors. ${report.boundary}`,
  );
} finally {
  await browser?.close();
  await server?.close();
  if (evidence) await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2));
}
