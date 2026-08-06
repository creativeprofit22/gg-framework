import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { initScript, responses } from "./capture-screenshots.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const defaultOutputDir = resolve(projectRoot, ".gg/screenshots");
const appUrl = process.env.GG_SHOT_URL ?? "http://localhost:1420";

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

export async function runWorkspaceNarrowVisualFixture({
  outputDir = defaultOutputDir,
  screenshot = true,
  url = appUrl,
} = {}) {
  if (screenshot) await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 320, height: 700 },
      deviceScaleFactor: 2,
    });
    await context.addInitScript(initScript, {
      responses: {
        ...responses,
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
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".chat-head-nav");
    await page.waitForTimeout(1_000);

    const shell = await elementMetrics(page, {
      viewport: "html",
      workspace: ".workspace-grid",
      pane: ".workspace-pane-slot",
      agentPane: ".agent-pane",
      header: ".chat-head",
      headerNav: ".chat-head-nav",
      headerActions: ".chat-head-nav .picker-head-actions",
    });
    assert.equal(shell.viewport.clientWidth, 320);
    assert.equal(shell.viewport.scrollWidth, 320);
    assert.equal(shell.workspace.clientWidth, 320);
    assertContained(shell, "workspace", "pane");
    assertContained(shell, "pane", "agentPane");
    assertContained(shell, "pane", "header");
    assertContained(shell, "header", "headerNav");
    assertContained(shell, "headerNav", "headerActions");

    const shellScreenshot = resolve(outputDir, "workspace-shell-320.png");
    if (screenshot) await page.screenshot({ path: shellScreenshot });

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

    const notesScreenshot = resolve(outputDir, "workspace-notes-tabs-320.png");
    if (screenshot) await page.screenshot({ path: notesScreenshot });
    await context.close();

    return {
      shell,
      notes,
      screenshots: screenshot ? [shellScreenshot, notesScreenshot] : [],
    };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runWorkspaceNarrowVisualFixture();
  console.log(`WORKSPACE_NARROW_METRICS=${JSON.stringify(result)}`);
}
