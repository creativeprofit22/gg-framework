import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  astraVisualScenarios,
  assertAstraVisualState,
  initScript,
  requireVisualFixtureUrl,
  responses,
} from "./capture-screenshots.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const defaultOutputDir = resolve(projectRoot, ".gg/screenshots");
const appUrl = requireVisualFixtureUrl(process.env.GG_SHOT_URL ?? "http://localhost:1420");

function assertContained(metrics, containerName, childName) {
  const container = metrics[containerName];
  const child = metrics[childName];
  assert.ok(container, `Missing ${containerName} metrics`);
  assert.ok(child, `Missing ${childName} metrics`);
  assert.ok(
    child.right <= container.right && child.left >= container.left,
    `${childName} (${child.left}..${child.right}) escaped ${containerName} (${container.left}..${container.right})`,
  );
  assert.ok(
    child.scrollWidth <= child.clientWidth,
    `${childName} overflows: clientWidth=${child.clientWidth}, scrollWidth=${child.scrollWidth}`,
  );
}

async function elementMetrics(page, selectors) {
  return page.evaluate((entries) => {
    const measured = {};
    for (const [name, selector] of Object.entries(entries)) {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) continue;
      const rect = element.getBoundingClientRect();
      measured[name] = {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
      };
    }
    return measured;
  }, selectors);
}

async function applyAstraScenario(page, scenario) {
  const { accountId, contextTokens, contextWindow, openAICodexContextProfile, openAICodexFast } =
    scenario.state;
  await page.evaluate(
    ({ extras, running }) => {
      window.__ggEmit?.("run_end", {});
      window.__ggEmit?.("extras", extras);
      if (running) window.__ggEmit?.("run_start", {});
    },
    {
      extras: {
        accountId,
        contextTokens,
        contextWindow,
        openAICodexContextProfile,
        openAICodexFast,
      },
      running: scenario.controls === "disabled",
    },
  );
  await page.waitForTimeout(150);
}

export async function runWorkspaceNarrowVisualFixture({
  outputDir = defaultOutputDir,
  screenshot = true,
  url = appUrl,
} = {}) {
  const fixtureUrl = requireVisualFixtureUrl(url);
  if (screenshot) await mkdir(outputDir, { recursive: true });
  // Headless Chromium creates no visible OS window; the native app is never launched.
  const browser = await chromium.launch({ headless: true });
  try {
    // newContext is an isolated, non-persistent profile with no production app data.
    const context = await browser.newContext({
      viewport: { width: 320, height: 700 },
      deviceScaleFactor: 2,
    });
    await context.addInitScript(initScript, {
      responses: {
        ...responses,
        agent_state: astraVisualScenarios[0].state,
        agent_sessions: { sessions: [] },
        agent_pane_restore: 1,
        agent_pane_status: { paneId: "primary", generation: 1, ready: true },
      },
      appVersion: "0.29.0",
    });
    await context.addInitScript(() => {
      localStorage.setItem(
        "gg-workspace-layout-recursive:main",
        JSON.stringify({
          version: 9,
          root: { type: "leaf", paneId: "primary" },
          focusedPaneId: "primary",
          panes: {
            primary: {
              kind: "agent",
              mode: "code",
              cwd: "/Users/demo/projects/aurora-store",
              sessionPath: null,
            },
          },
        }),
      );
    });
    const page = await context.newPage();
    await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".chat-head-nav");
    await page.waitForTimeout(1_000);

    const scenarioShells = {};
    const screenshots = [];
    for (const [index, scenario] of astraVisualScenarios.entries()) {
      await applyAstraScenario(page, scenario);
      await assertAstraVisualState(page, scenario);
      const metrics = await elementMetrics(page, {
        viewport: "html",
        workspace: ".workspace-grid",
        pane: ".workspace-pane-slot",
        agentPane: ".agent-pane",
        header: ".chat-head",
        headerNav: ".chat-head-nav",
        headerActions: ".chat-head-nav .picker-head-actions",
        footer: ".footer",
        footerControls: ".footer-right",
        astraControls: ".astra-control-group",
        contextSelector: 'select[aria-label="OpenAI Codex context profile"]',
        fastSwitch: '[role="switch"][aria-label="Fast · 2.5× credits"]',
        contextMeter: ".ctx-meter",
      });
      assert.equal(metrics.viewport.clientWidth, 320);
      assert.equal(metrics.viewport.scrollWidth, 320);
      assert.equal(metrics.workspace.clientWidth, 320);
      assertContained(metrics, "workspace", "pane");
      assertContained(metrics, "pane", "agentPane");
      assertContained(metrics, "pane", "header");
      assertContained(metrics, "header", "headerNav");
      assertContained(metrics, "headerNav", "headerActions");
      assertContained(metrics, "pane", "footer");
      assertContained(metrics, "footer", "footerControls");
      assertContained(metrics, "footerControls", "contextMeter");
      if (scenario.controls !== "hidden") {
        assertContained(metrics, "footerControls", "astraControls");
        assertContained(metrics, "astraControls", "contextSelector");
        assertContained(metrics, "astraControls", "fastSwitch");
      }
      scenarioShells[scenario.name] = metrics;

      if (screenshot) {
        const name = index === 0 ? "workspace-shell-320.png" : `workspace-${scenario.name}-320.png`;
        const output = resolve(outputDir, name);
        await page.screenshot({ path: output });
        screenshots.push(output);
      }
    }

    const shell = scenarioShells[astraVisualScenarios[0].name];
    await page.click('.picker-head-actions button[aria-label*="notes" i]');
    await page.waitForSelector(".notes-tabs-scroll");
    await page.waitForTimeout(300);
    const notes = await elementMetrics(page, {
      viewport: "html",
      modal: ".notes-modal",
      tabsViewport: ".notes-tabs-scroll",
      tabs: ".notes-tabs",
    });
    assert.equal(notes.viewport.clientWidth, 320);
    assert.equal(notes.viewport.scrollWidth, 320);
    assertContained(notes, "viewport", "modal");
    assert.ok(
      notes.tabsViewport.scrollWidth > notes.tabsViewport.clientWidth,
      `Notes tabs should scroll locally: clientWidth=${notes.tabsViewport.clientWidth}, scrollWidth=${notes.tabsViewport.scrollWidth}`,
    );

    if (screenshot) {
      const notesScreenshot = resolve(outputDir, "workspace-notes-tabs-320.png");
      await page.screenshot({ path: notesScreenshot });
      screenshots.push(notesScreenshot);
    }
    await context.close();

    return { shell, scenarioShells, notes, screenshots };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runWorkspaceNarrowVisualFixture();
  console.log(`WORKSPACE_NARROW_METRICS=${JSON.stringify(result)}`);
}
