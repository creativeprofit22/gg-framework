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
const promptBodies = [
  "  Implement café 日本語\n\n    Preserve indentation",
  "Second independent prompt\n" + "Full source content. ".repeat(80),
];
const appUrl = requireVisualFixtureUrl(process.env.GG_SHOT_URL ?? "http://localhost:1420");

function copiedStatus(block) {
  return block.getByRole("status").filter({ hasText: /^Prompt copied\.$/ });
}

async function armDelayedCopy(page) {
  await page.evaluate(() => {
    window.__delayNextCopy = true;
  });
}

async function verifyPendingCopyAndRelease(page, blocks, block) {
  await page.waitForFunction(() => typeof window.__releaseCopy === "function");
  await block.getByRole("button", { name: "Copying prompt…", exact: true }).waitFor();
  // The previous block remains successful while this write is explicitly held.
  assert.equal(await copiedStatus(blocks.first()).count(), 1);
  assert.equal(await copiedStatus(block).count(), 0);
  assert.equal(await block.locator(".ken-prompt-copy").isDisabled(), true);
  await page.evaluate(() => window.__releaseCopy());
}

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
        agent_history: {
          history: promptBodies.map((text) => ({
            role: "assistant",
            ken: true,
            text: `\`\`\`prompt\n${text}\n\`\`\``,
          })),
        },
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
        fastSwitch: '.astra-fast-toggle[role="switch"]',
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

    const copyEvidence = [];
    const accessibilityEvidence = [];
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === "agent_set_openai_codex_fast")
          return Promise.resolve({ openAICodexFast: args.enabled });
        return invoke(command, args);
      };
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => {
        if (window.__delayNextCopy) {
          window.__delayNextCopy = false;
          await new Promise((resolveCopy) => {
            window.__releaseCopy = resolveCopy;
          });
          window.__releaseCopy = null;
        }
        await write(text);
        window.__copiedSource = text;
      };
    });
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 700 : 900 });
      for (const scenario of astraVisualScenarios
        .filter((entry) => entry.controls === "enabled")
        .slice(0, 2)) {
        await applyAstraScenario(page, scenario);
        await assertAstraVisualState(page, scenario);
        await page.locator(".astra-fast-toggle").hover();
        if (screenshot) {
          const output = resolve(outputDir, `prompt-fast-${scenario.name}-${width}.png`);
          await page.screenshot({ path: output });
          screenshots.push(output);
        }
      }
      const fast = page.locator(".astra-fast-toggle");
      await fast.focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(
        () =>
          document.querySelector(".astra-fast-toggle")?.getAttribute("aria-checked") === "false" &&
          !document.querySelector(".astra-fast-toggle")?.disabled,
      );
      // Disabling the switch while its mutation settles drops native focus.
      await fast.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector(".astra-fast-toggle")?.getAttribute("aria-checked") === "true",
      );
      await fast.hover();
      assert.equal(
        await fast.getAttribute("title"),
        "Fast mode is on. Uses 2.5× credits. Click to turn off.",
      );
      const blocks = page.locator(".ken-prompt-block");
      const copies = blocks.locator(".ken-prompt-copy");
      assert.equal(await copies.count(), 2);
      for (let index = 0; index < 2; index++) {
        const block = blocks.nth(index);
        const copy = block.getByRole("button", { name: "Copy prompt", exact: true });
        await copy.scrollIntoViewIfNeeded();
        const geometry = await copy.evaluate((button) => {
          const save = button.previousElementSibling;
          const a = save.getBoundingClientRect();
          const b = button.getBoundingClientRect();
          return {
            sameRow: a.top === b.top,
            gap: b.left - a.right,
            width: b.width,
            height: b.height,
          };
        });
        assert.ok(geometry.sameRow && geometry.gap === 6);
        assert.ok(geometry.width >= 30 && geometry.height >= 30);
        await copy.evaluate((button) => button.previousElementSibling.focus());
        await page.keyboard.press("Tab");
        assert.equal(await copy.evaluate((button) => button === document.activeElement), true);
        assert.equal(await copy.evaluate((button) => button.matches(":focus-visible")), true);
        if (screenshot) {
          const output = resolve(outputDir, `prompt-focus-${width}-${index}.png`);
          await page.screenshot({ path: output });
          screenshots.push(output);
        }
        if (index === 1) await armDelayedCopy(page);
        await page.keyboard.press(index === 0 ? "Enter" : "Space");
        if (index === 1) await verifyPendingCopyAndRelease(page, blocks, block);
        await copiedStatus(block).waitFor();
        assert.equal(
          // Windows clipboard round-trips LF as CRLF; verify exact API input separately.
          (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"),
          promptBodies[index],
        );
        assert.equal(await page.evaluate(() => window.__copiedSource), promptBodies[index]);
        copyEvidence.push({
          viewportWidth: width,
          index,
          ...geometry,
          success: await copiedStatus(block).innerText(),
          delayedWrite: index === 1,
        });
      }
      if (screenshot) {
        const output = resolve(outputDir, `prompt-copy-success-${width}.png`);
        await page.screenshot({ path: output });
        screenshots.push(output);
      }
      await page.evaluate(() => {
        window.__fixtureClipboard = navigator.clipboard;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error("Fixture denied")) },
        });
      });
      await copies.last().click();
      await page.getByRole("alert").filter({ hasText: "Could not copy prompt" }).waitFor();
      const contrast = await page.evaluate(() => {
        const rgb = (value) =>
          value
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
        const luminance = (color) =>
          rgb(color)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        return [
          ".ken-prompt-copy",
          ".ken-prompt-error",
          ".ken-prompt-success",
          ".astra-fast-toggle",
        ].map((selector) => {
          const element = document.querySelector(selector);
          const foreground = getComputedStyle(element).color;
          let ancestor = element;
          while (
            ancestor.parentElement &&
            getComputedStyle(ancestor).backgroundColor === "rgba(0, 0, 0, 0)"
          )
            ancestor = ancestor.parentElement;
          const background = getComputedStyle(ancestor).backgroundColor;
          const a = luminance(foreground);
          const b = luminance(background);
          return {
            selector,
            foreground,
            background,
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
      });
      for (const sample of contrast)
        assert.ok(
          sample.ratio >= (sample.selector === ".ken-prompt-copy" ? 3 : 4.5),
          JSON.stringify(sample),
        );
      accessibilityEvidence.push({ width, contrast });
      if (screenshot) {
        const output = resolve(outputDir, `prompt-copy-failure-${width}.png`);
        await page.screenshot({ path: output });
        screenshots.push(output);
      }
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: window.__fixtureClipboard,
        }),
      );
      await armDelayedCopy(page);
      await copies.last().click();
      await verifyPendingCopyAndRelease(page, blocks, blocks.last());
      await copiedStatus(blocks.last()).waitFor();
      assert.equal(
        (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"),
        promptBodies[1],
      );
      assert.equal(await page.evaluate(() => window.__copiedSource), promptBodies[1]);
      await page
        .getByRole("alert")
        .filter({ hasText: "Could not copy prompt" })
        .waitFor({ state: "detached" });
      await page.locator(".ken-prompt-body").last().click();
      assert.equal(
        await copies.last().evaluate((button) => button.matches(":focus-visible")),
        false,
      );
      await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
      await copies.last().scrollIntoViewIfNeeded();
      assert.equal(
        await copies.last().evaluate((button) => getComputedStyle(button).transitionDuration),
        "0s",
      );
      if (screenshot) {
        const output = resolve(outputDir, `prompt-forced-colors-${width}.png`);
        await page.screenshot({ path: output });
        screenshots.push(output);
      }
      await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      await copies.last().scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      if (screenshot) {
        const output = resolve(outputDir, `prompt-zoom-200-${width}.png`);
        await page.screenshot({ path: output });
        screenshots.push(output);
      }
      await page.evaluate(() => {
        document.documentElement.style.zoom = "";
      });
    }
    await page.setViewportSize({ width: 320, height: 700 });
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

    return { shell, scenarioShells, notes, copyEvidence, accessibilityEvidence, screenshots };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runWorkspaceNarrowVisualFixture();
  console.log(`WORKSPACE_NARROW_METRICS=${JSON.stringify(result)}`);
}
