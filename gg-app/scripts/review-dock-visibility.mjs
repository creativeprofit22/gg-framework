import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { initScript, requireVisualFixtureUrl, responses } from "./capture-screenshots.mjs";
import { assertControlReachable } from "./workspace-narrow-visual.mjs";

/*
 * Real-browser guard for the pane's pending-work surfaces: plan approval,
 * Roadmap draft review, Roadmap refresh recovery and the app-update banner.
 *
 * Upstream 0.91 made the composer dock float over the bottom of the
 * conversation. The Local Fork review dock stayed a sibling of that floating
 * dock, so it rendered underneath it and the plan approval gate vanished while
 * the composer stayed locked. jsdom never computes layout, so only a real
 * browser hit test catches that class of regression: every control below must
 * be the topmost element at its own position, not merely present in the DOM.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const defaultOutputDir = resolve(projectRoot, ".gg/screenshots");
const defaultUrl = requireVisualFixtureUrl(process.env.GG_SHOT_URL ?? "http://127.0.0.1:1420");

const CWD = "/Users/demo/projects/aurora-store";
export const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "narrow", width: 390, height: 844 },
  { name: "short", width: 1280, height: 560 },
];

const pendingPlanReview = {
  checkpointId: "fixture-checkpoint",
  generation: 1,
  planPath: `${CWD}/.gg/plans/fixture-plan.md`,
  content: [
    "# Add checkout retry",
    "",
    ...Array.from({ length: 24 }, (_, index) => `${index + 1}. Fictional plan step ${index + 1}.`),
  ].join("\n"),
  contentHash: "fixture-hash",
  state: "pending-review",
  reviewStatus: "unreviewed",
  feedback: null,
};

const roadmapDraft = {
  id: "fixture-draft",
  projectKey: CWD,
  basedOnRevision: 1,
  createdAt: "2026-10-14T12:00:00.000Z",
  createdBySessionId: "fixture-session",
  sourcesNotCited: null,
  summary: "Add the fictional delivery phase.",
  references: [],
  phases: [
    {
      phaseId: "fixture-phase",
      title: "Ship fictional checkout retry",
      goal: "Deliver the fictional workflow after approval.",
      doneWhen: ["The fictional workflow is available"],
      sourcePrompt: "Implement the fictional workflow.",
      referenceIds: [],
    },
  ],
  status: "pending",
};

const updateMetadata = {
  rid: 1,
  currentVersion: "0.91.1",
  version: "0.99.0",
  date: null,
  body: "",
  rawJson: {},
};

/** Scenario fixtures: what the daemon reports and which surfaces must be reachable. */
export const scenarios = [
  {
    name: "pending-reviews",
    roadmap: { status: "ok", draft: roadmapDraft },
    update: true,
  },
  {
    name: "roadmap-refresh-error",
    // A malformed draft makes the strict parser reject the reply, which is
    // exactly the "refresh failed, retry" recovery path.
    roadmap: { status: "ok", draft: { id: 42 } },
    update: false,
  },
];

function scenarioResponses(scenario) {
  return {
    ...responses,
    agent_state: {
      ...responses.agent_state,
      sessionId: "fixture-session",
      cwd: CWD,
      pendingPlanReview: scenario.name === "pending-reviews" ? pendingPlanReview : null,
    },
    agent_history: { history: [] },
    agent_sessions: { sessions: [] },
    agent_pane_restore: 1,
    agent_roadmap_phase_draft_get: scenario.roadmap,
  };
}

async function openWorkspace(context, url, scenario, viewport) {
  const page = await context.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.addInitScript(initScript, {
    responses: scenarioResponses(scenario),
    appVersion: "0.91.1",
  });
  await page.addInitScript(
    ({ cwd, update }) => {
      localStorage.setItem(
        "gg-workspace-layout-recursive:main",
        JSON.stringify({
          version: 9,
          root: { type: "leaf", paneId: "primary" },
          focusedPaneId: "primary",
          panes: { primary: { kind: "agent", mode: "code", cwd, sessionPath: null } },
        }),
      );
      // The shared fixture rejects every updater call; answer the check so
      // the update banner renders for this scenario only.
      const internals = window.__TAURI_INTERNALS__;
      const invoke = internals.invoke.bind(internals);
      internals.invoke = (command, args) =>
        command === "plugin:updater|check" && update
          ? Promise.resolve(update)
          : invoke(command, args);
    },
    { cwd: CWD, update: scenario.update ? updateMetadata : null },
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".dock .deck").waitFor({ timeout: 15_000 });
  // Let the workspace entrance (dissolve-in) and dock measurement settle.
  await page.waitForTimeout(800);
  return page;
}

/** Fails when the review dock and the composer deck paint over one another. */
async function assertNoOverlap(page, first, second, label) {
  const boxes = await page.evaluate(
    ([a, b]) =>
      [a, b].map((selector) => {
        const element = document.querySelector(selector);
        return element ? element.getBoundingClientRect().toJSON() : null;
      }),
    [first, second],
  );
  const [a, b] = boxes;
  assert.ok(a && b, `${label}: missing ${a ? second : first}`);
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  assert.ok(
    overlapX <= 1 || overlapY <= 1,
    `${label}: ${first} and ${second} overlap by ${overlapX.toFixed(1)}×${overlapY.toFixed(1)}px`,
  );
}

/** Every sampled point of a non-interactive surface must hit the surface itself. */
async function assertTopmost(locator, label) {
  await locator.waitFor({ state: "visible", timeout: 5_000 });
  const occluded = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const misses = [];
    for (const fx of [0.1, 0.5, 0.9]) {
      for (const fy of [0.25, 0.75]) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (!element.contains(hit))
          misses.push(`${Math.round(x)},${Math.round(y)} → ${hit?.tagName}.${hit?.className}`);
      }
    }
    return misses;
  });
  assert.deepEqual(occluded, [], `${label} is covered at ${occluded.join("; ")}`);
}

/*
 * Local Fork builds show the in-pane banner only for protected-update progress
 * (pushed by the shell as "local-patched-update"); upstream-mode builds show it
 * when the updater reports a version. Drive whichever path this build listens
 * on, then require the banner to be on top.
 */
async function assertUpdateBannerOnTop(page, prefix) {
  await page.evaluate(() =>
    window.__ggEmitEvent?.("local-patched-update", {
      type: "error",
      message: "Fixture: protected update failed.",
    }),
  );
  const banner = page.locator(".update-banner").first();
  await assertTopmost(banner, `${prefix} update banner`);
  if ((await banner.evaluate((element) => element.tagName)) === "BUTTON")
    await assertControlReachable(banner, `${prefix} update banner`);
}

async function check(evidence, label, run) {
  try {
    await run();
    evidence.push({ label, failures: [] });
  } catch (error) {
    // One failing surface can list dozens of occluded points; keep reports readable.
    const message = String(error.message).replace(/\u001b\[[0-9;]*m/g, "");
    evidence.push({
      label,
      failures: [`${label}: ${message.length > 600 ? `${message.slice(0, 600)}…` : message}`],
    });
  }
}

/** Wait out the review's finite entrance animations (opacity fades read as "not visible"). */
async function settleReviews(page) {
  await page.waitForFunction(
    () =>
      (document.querySelector(".review-dock")?.getAnimations({ subtree: true }) ?? []).every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().endTime === Infinity,
      ),
    null,
    { timeout: 5_000 },
  );
}

async function verifyPendingReviews(page, prefix, evidence) {
  const dock = page.locator(".review-dock");
  const planTrigger = dock.locator('[data-review-trigger="plan"]');
  const roadmapTrigger = dock.locator('[data-review-trigger="roadmap"]');
  await check(evidence, `${prefix} plan trigger`, () =>
    assertControlReachable(planTrigger, `${prefix} plan trigger`),
  );
  await check(evidence, `${prefix} roadmap trigger`, () =>
    assertControlReachable(roadmapTrigger, `${prefix} roadmap trigger`),
  );
  await check(evidence, `${prefix} header Review draft`, () =>
    assertControlReachable(page.locator(".roadmap-draft-trigger"), `${prefix} header Review draft`),
  );
  await check(evidence, `${prefix} update banner`, () => assertUpdateBannerOnTop(page, prefix));
  await check(evidence, `${prefix} collapsed dock vs deck`, () =>
    assertNoOverlap(page, ".review-dock", ".dock .deck", `${prefix} collapsed`),
  );

  // Expanded plan: both decisions must be on top and clickable.
  await planTrigger.click({ timeout: 3_000 }).catch(() => planTrigger.press("Enter"));
  const plan = page.locator(".review-dock .plan-review");
  await plan.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
  await settleReviews(page);
  for (const name of ["Approve", "Feedback"]) {
    await check(evidence, `${prefix} plan ${name}`, () =>
      assertControlReachable(plan.getByRole("button", { name, exact: true }), `${prefix} ${name}`),
    );
  }
  await check(evidence, `${prefix} expanded plan vs deck`, () =>
    assertNoOverlap(page, ".review-dock", ".dock .deck", `${prefix} plan expanded`),
  );

  // Maximized plan keeps the decisions reachable too.
  const size = dock.locator(".review-dock-size");
  await check(evidence, `${prefix} maximize control`, async () => {
    await assertControlReachable(size, `${prefix} maximize`);
    await size.click({ timeout: 3_000 });
    await settleReviews(page);
    await assertControlReachable(
      plan.getByRole("button", { name: "Approve", exact: true }),
      `${prefix} maximized Approve`,
    );
    await assertNoOverlap(page, ".review-dock", ".dock .deck", `${prefix} maximized`);
    await size.click({ timeout: 3_000 });
  });

  // Expanded Roadmap draft: Reject and Create must be on top and clickable.
  await roadmapTrigger.click({ timeout: 3_000 }).catch(() => roadmapTrigger.press("Enter"));
  const roadmap = page.locator(".review-dock .roadmap-draft-review");
  await roadmap.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
  await settleReviews(page);
  await check(evidence, `${prefix} roadmap Reject draft`, () =>
    assertControlReachable(roadmap.locator(".roadmap-draft-reject"), `${prefix} Reject draft`),
  );
  await check(evidence, `${prefix} roadmap Create`, () =>
    assertControlReachable(roadmap.locator(".roadmap-draft-create"), `${prefix} Create phases`),
  );
  await check(evidence, `${prefix} expanded roadmap vs deck`, () =>
    assertNoOverlap(page, ".review-dock", ".dock .deck", `${prefix} roadmap expanded`),
  );
}

async function verifyRefreshError(page, prefix, evidence) {
  const retry = page.getByRole("button", { name: "Retry Roadmap review", exact: true });
  await retry.waitFor({ state: "attached", timeout: 5_000 }).catch(() => {});
  await check(evidence, `${prefix} Retry Roadmap review`, () =>
    assertControlReachable(retry, `${prefix} Retry Roadmap review`),
  );
}

export async function runReviewDockVisibilityFixture({
  url = defaultUrl,
  screenshot = false,
  outputDir = defaultOutputDir,
} = {}) {
  const fixtureUrl = requireVisualFixtureUrl(url);
  if (screenshot) await mkdir(outputDir, { recursive: true });
  // Headless and disposable: no native window, no production app data.
  const browser = await chromium.launch({ headless: true });
  const evidence = [];
  const screenshots = [];
  try {
    for (const scenario of scenarios) {
      for (const viewport of viewports) {
        const context = await browser.newContext();
        try {
          const page = await openWorkspace(context, fixtureUrl, scenario, viewport);
          const prefix = `${scenario.name} ${viewport.width}×${viewport.height}`;
          if (scenario.name === "pending-reviews")
            await verifyPendingReviews(page, prefix, evidence);
          else await verifyRefreshError(page, prefix, evidence);
          if (screenshot) {
            const output = resolve(outputDir, `review-dock-${scenario.name}-${viewport.name}.png`);
            await page.screenshot({ path: output });
            screenshots.push(output);
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  const failures = evidence.flatMap((entry) => entry.failures);
  assert.deepEqual(failures, [], failures.join("\n"));
  return { checks: evidence.length, screenshots };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const screenshot = process.argv.includes("--screenshot");
  const result = await runReviewDockVisibilityFixture({ screenshot });
  console.log(`REVIEW_DOCK_VISIBILITY=${JSON.stringify(result)}`);
}
