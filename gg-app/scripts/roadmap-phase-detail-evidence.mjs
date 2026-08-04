import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { initScript, responses as baseResponses } from "./capture-screenshots.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, ".gg", "evidence", "roadmap-phase-detail");
const APP_URL = process.env.GG_APP_URL ?? "http://127.0.0.1:4173";
const NOW = "2026-08-04T12:00:00.000Z";
const CWD = "/Users/ken/Projects/roadmap-overflow-audit";
const PHASE_TITLE =
  "Lokalisierte Detailphase für zuverlässige Übergaben über sehr lange Arbeitsabläufe hinweg";
const LONG_TOKEN = "unbroken-content-".repeat(18);
const LONG_URL = `https://github.com/kenkaiiii/gg-framework/blob/main/gg-app/src/${LONG_TOKEN}/NotesRoadmap.tsx#L100-L240`;

const reference = {
  id: "reference-long-content",
  provider: "github",
  tool: "search_public_code_with_an_intentionally_long_tool_name_for_wrapping_evidence",
  canonicalUrl: LONG_URL,
  owner: "kenkaiiii",
  repo: "gg-framework",
  revision: `audit-${LONG_TOKEN}`,
  path: `gg-app/src/${LONG_TOKEN}/NotesRoadmap.tsx`,
  range: { startLine: 100, endLine: 240 },
  issue: null,
  pullRequest: null,
  query: `Find responsive phase detail handling for ${LONG_TOKEN}`,
  anchor: `phase-detail-${LONG_TOKEN}`,
  relevance: `The reference remains readable and wraps safely even when every metadata field contains ${LONG_TOKEN}`,
  capturedAt: NOW,
};

const report = {
  type: "status-update",
  id: "status-long-content",
  actor: "gg-coder",
  transition: "review",
  progress: `Implemented narrow-layout containment and verified ${LONG_TOKEN}`,
  blocker: null,
  evidence: [`Geometry report ${LONG_TOKEN}`, `Reference inspection ${LONG_URL}`],
  verification: "passed",
  verificationReason: null,
  verificationSession: {
    sessionId: `session-${LONG_TOKEN}`,
    sessionPath: `/Users/ken/.gg/sessions/${LONG_TOKEN}.jsonl`,
  },
  statusOutcome: "same-status",
  proposedReferences: [],
  timestamp: NOW,
};

const document = {
  version: 3,
  reference: "Roadmap phase detail overflow audit fixture",
  currentFocus: `Keep all phase content inside the viewport: ${LONG_TOKEN}`,
  tasks: [],
  handoff: { text: "", updatedAt: null, readAt: null },
  updatedAt: NOW,
  legacyImportedAt: null,
  phases: [
    {
      id: "phase-overflow-audit",
      title: PHASE_TITLE,
      goal: `Wrap a deliberately long phase goal and preserve its complete content: ${LONG_TOKEN}`,
      doneWhen: [
        `No horizontal overflow at 320px ${LONG_TOKEN}`,
        `Exactly one Notes vertical scroller ${LONG_TOKEN}`,
      ],
      order: 0,
      status: "in-progress",
      sourcePrompt: `Implement only this UI audit slice.\n\n${LONG_TOKEN}\n${LONG_URL}\n`.repeat(5),
      referenceIds: [reference.id],
      session: {
        sessionId: `session-${LONG_TOKEN}`,
        sessionPath: `/Users/ken/.gg/sessions/${LONG_TOKEN}.jsonl`,
      },
      reminder: null,
      attentionReason: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      archivedAt: null,
      overrides: { status: null, referenceIds: null },
      pendingAutomaticLifecycleTransition: null,
      lifecycleEvents: [],
      roadmapEvents: [report],
    },
  ],
  references: [reference],
};

const detailedPhase = document.phases[0];

function phasesForCount(count) {
  return Array.from({ length: count }, (_, order) => ({
    ...detailedPhase,
    id: `phase-density-${order + 1}`,
    title:
      order === 0
        ? PHASE_TITLE
        : `Phase ${String(order + 1).padStart(2, "0")} — Internationalisierte Auslieferung mit ausführlichem Arbeitstitel`,
    goal: `Zuverlässige Übergabe für Teams in Zürich, 東京 und São Paulo — ${LONG_TOKEN}`,
    doneWhen: [
      `Die Darstellung bleibt bei langen lokalisierten Inhalten stabil — ${LONG_TOKEN}`,
      "Tastaturfokus und erzwungene Farben bleiben eindeutig erkennbar",
    ],
    order,
    sourcePrompt: order === 0 ? detailedPhase.sourcePrompt : "",
    referenceIds: order === 0 ? [reference.id] : [],
    roadmapEvents: order === 0 ? [report] : [],
  }));
}

function notesResponseForCount(count) {
  return {
    status: "ok",
    snapshot: {
      projectKey: CWD,
      revision: 7,
      document: { ...document, phases: phasesForCount(count) },
    },
    recoveredFromBackup: false,
  };
}

function expectCondition(condition, message, detail) {
  if (condition) return;
  const suffix = detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

async function collectGeometry(page, viewport) {
  return page.evaluate(
    ({ viewport, phaseTitle }) => {
      const phase = document.querySelector(".notes-phase-detail");
      const panel = document.querySelector(".notes-panel:not([hidden])");
      const modal = document.querySelector(".notes-modal");
      if (
        !(phase instanceof HTMLElement) ||
        !(panel instanceof HTMLElement) ||
        !(modal instanceof HTMLElement)
      ) {
        throw new Error("Roadmap phase detail geometry targets are missing");
      }

      const phaseRect = phase.getBoundingClientRect();
      const visibleElements = [...phase.querySelectorAll("*")].filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
      const overflowers = visibleElements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            element.scrollWidth > element.clientWidth + 1 ||
            rect.left < phaseRect.left - 1 ||
            rect.right > phaseRect.right + 1
          );
        })
        .map((element) => ({
          className: element.className,
          tagName: element.tagName,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          left: Math.round(element.getBoundingClientRect().left * 10) / 10,
          right: Math.round(element.getBoundingClientRect().right * 10) / 10,
        }));

      const verticalScrollContainers = [...modal.querySelectorAll("*")]
        .filter((element) => element instanceof HTMLElement)
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            element.clientHeight > 0 &&
            !element.matches("input, textarea, select") &&
            (style.overflowY === "auto" || style.overflowY === "scroll")
          );
        })
        .map((element) => ({
          className: element.className,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        }));
      const verticalScrollers = verticalScrollContainers.filter(
        (element) => element.scrollHeight > element.clientHeight + 1,
      );

      const primaryActions = [...modal.querySelectorAll("button.notes-roadmap-primary")].filter(
        (element) => element.textContent?.trim().startsWith("Resume"),
      );
      const primary = phase.querySelector("button.notes-roadmap-primary");
      const primaryRect = primary?.getBoundingClientRect();
      const prompt = phase.querySelector(".notes-phase-saved-prompt pre");
      const tablist = phase.querySelector(".notes-phase-views");
      const viewSelector = phase.querySelector(".notes-phase-view-select");
      const visibleNavigation = [tablist, viewSelector].filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && element.getBoundingClientRect().height > 0;
      });
      const navigation = visibleNavigation[0];
      const tabRows =
        tablist instanceof HTMLElement && getComputedStyle(tablist).display !== "none"
          ? new Set(
              [...tablist.querySelectorAll('[role="tab"]')].map((tab) =>
                Math.round(tab.getBoundingClientRect().top),
              ),
            ).size
          : null;
      const selectorLabel = viewSelector?.querySelector("label");
      const selectorLabelStyle =
        selectorLabel instanceof HTMLElement ? getComputedStyle(selectorLabel) : null;
      const selectorLabelLines =
        selectorLabel instanceof HTMLElement && selectorLabelStyle
          ? selectorLabel.getBoundingClientRect().height /
            Number.parseFloat(selectorLabelStyle.lineHeight)
          : null;
      return {
        viewport,
        titleVisible: phase.textContent?.includes(phaseTitle) ?? false,
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOverflow: panel.scrollWidth - panel.clientWidth,
        phaseOverflow: phase.scrollWidth - phase.clientWidth,
        phaseRect: {
          left: phaseRect.left,
          right: phaseRect.right,
          width: phaseRect.width,
        },
        overflowers,
        verticalScrollContainers,
        verticalScrollers,
        navigationKind: navigation === tablist ? "tabs" : "select",
        navigationCount: visibleNavigation.length,
        navigationOverflow:
          navigation instanceof HTMLElement
            ? navigation.scrollWidth - navigation.clientWidth
            : null,
        navigationHeight: navigation?.getBoundingClientRect().height ?? null,
        navigationRows: navigation === tablist ? tabRows : selectorLabelLines,
        selectorValue:
          viewSelector?.querySelector("select") instanceof HTMLSelectElement
            ? viewSelector.querySelector("select").value
            : null,
        primaryActionCount: primaryActions.length,
        primaryInHeader: Boolean(primary?.closest(".notes-phase-detail-heading")),
        primaryInExecution: Boolean(primary?.closest(".notes-phase-execution")),
        primaryAboveFold: Boolean(
          primaryRect && primaryRect.top >= 0 && primaryRect.bottom <= viewport.height,
        ),
        primaryRect: primaryRect
          ? { top: primaryRect.top, bottom: primaryRect.bottom, width: primaryRect.width }
          : null,
        promptExpanded: Boolean(prompt),
        promptOverflow:
          prompt instanceof HTMLElement ? prompt.scrollWidth - prompt.clientWidth : null,
        promptOverflowY: prompt instanceof HTMLElement ? getComputedStyle(prompt).overflowY : null,
      };
    },
    { viewport, phaseTitle: PHASE_TITLE },
  );
}

async function openRoadmap(page) {
  const codeButton = page.getByRole("button", { name: "Code", exact: true });
  await codeButton.waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Code",
    );
    return button?.getAttribute("aria-disabled") === "false";
  });
  await codeButton.click();
  await page.locator(".picker-item").first().click();
  await page.getByText("+ New session", { exact: true }).click();
  await page.getByRole("button", { name: "Notes" }).click();
  await page.getByRole("tab", { name: "Roadmap" }).click();
}

async function openPhaseDetail(page) {
  await openRoadmap(page);
  const inspectPhase = page.getByRole("button", { name: `Inspect phase: ${PHASE_TITLE}` });
  await inspectPhase.waitFor({ timeout: 5_000 }).catch(async () => {
    throw new Error(`Phase fixture did not render:\n${await page.locator("body").innerText()}`);
  });
  await inspectPhase.click();
  await page.getByRole("heading", { name: PHASE_TITLE }).waitFor();
}

async function createPage(browser, { viewport, phaseCount, forcedColors = "none", scale = 1 }) {
  const context = await browser.newContext({
    viewport,
    screen: { width: viewport.width * scale, height: viewport.height * scale },
    deviceScaleFactor: scale,
    colorScheme: "dark",
    forcedColors,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript(initScript, {
    responses: {
      ...baseResponses,
      agent_state: { ...baseResponses.agent_state, cwd: CWD },
      agent_pane_status: { ready: true, error: null, generation: 1, sessionId: "session-audit" },
      select_project: 2,
      agent_notes_get: notesResponseForCount(phaseCount),
    },
    appVersion: "0.1.0-roadmap-audit",
    updateResponse: null,
    debugEnabled: false,
  });
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  return { context, page };
}

async function collectFocusEvidence(locator) {
  return locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      tagName: element.tagName,
      label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
      focused: document.activeElement === element,
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: styles.outlineStyle,
      outlineWidth: styles.outlineWidth,
    };
  });
}

async function captureDetailScenario(
  browser,
  { viewport, evidenceName, forcedColors = "none", scale = 1 },
) {
  const { context, page } = await createPage(browser, {
    viewport,
    phaseCount: 1,
    forcedColors,
    scale,
  });
  await openPhaseDetail(page);

  const details = page.locator(".notes-phase-saved-prompt");
  await details.locator("summary").click();
  const expandedGeometry = await collectGeometry(page, viewport);
  expectCondition(
    expandedGeometry.promptExpanded,
    "Expanded prompt did not render",
    expandedGeometry,
  );
  expectCondition(
    expandedGeometry.promptOverflow <= 1,
    "Expanded prompt overflows horizontally",
    expandedGeometry,
  );
  expectCondition(
    expandedGeometry.verticalScrollers.length === 1 &&
      String(expandedGeometry.verticalScrollers[0]?.className).split(/\s+/).includes("notes-panel"),
    "Notes must expose exactly one vertical scroller after expanding the long prompt",
    expandedGeometry,
  );
  await details.locator("summary").click();
  await page.locator("#notes-panel-roadmap").evaluate((element) => {
    element.scrollTop = 0;
  });

  const viewGeometry = {};
  const phaseViewTabs = page.locator(".notes-phase-views");
  const phaseViewSelector = page.getByLabel("Phase view", { exact: true });
  const usesNativeSelector = viewport.width <= 560;
  for (const view of ["Overview", "Completion", "References", "Activity", "More"]) {
    let state;
    if (usesNativeSelector) {
      await phaseViewSelector.focus();
      await phaseViewSelector.selectOption({ label: view });
      state = await phaseViewSelector.evaluate((element) => ({
        selected: element.value,
        focused: document.activeElement === element,
      }));
    } else {
      const tab = phaseViewTabs.getByRole("tab", { name: view, exact: true });
      await tab.click();
      state = await tab.evaluate((element) => ({
        selected: element.getAttribute("aria-selected"),
        focused: document.activeElement === element,
      }));
    }
    const currentGeometry = await collectGeometry(page, viewport);
    viewGeometry[view] = { ...currentGeometry, navigationState: state };
    expectCondition(
      state.focused &&
        (usesNativeSelector ? state.selected === view.toLowerCase() : state.selected === "true"),
      `${view} did not preserve selected-navigation focus`,
      viewGeometry[view],
    );
    expectCondition(
      currentGeometry.navigationCount === 1 &&
        currentGeometry.navigationKind === (usesNativeSelector ? "select" : "tabs") &&
        currentGeometry.navigationOverflow <= 1 &&
        currentGeometry.navigationRows <= 1.05,
      `${view} navigation wraps or overflows`,
      currentGeometry,
    );
    expectCondition(
      currentGeometry.documentOverflow <= 1 &&
        currentGeometry.panelOverflow <= 1 &&
        currentGeometry.phaseOverflow <= 1 &&
        currentGeometry.overflowers.length === 0,
      `${view} overflows horizontally`,
      currentGeometry,
    );
    expectCondition(
      currentGeometry.verticalScrollContainers.length === 1 &&
        String(currentGeometry.verticalScrollContainers[0]?.className)
          .split(/\s+/)
          .includes("notes-panel"),
      `${view} must retain exactly one vertical Roadmap scroll container`,
      currentGeometry,
    );
  }

  if (usesNativeSelector) {
    await phaseViewSelector.focus();
    await page.keyboard.press("Home");
    await phaseViewSelector.selectOption("overview");
  } else {
    await phaseViewTabs.getByRole("tab", { name: "More", exact: true }).focus();
    await page.keyboard.press("Home");
  }
  const focusTarget = usesNativeSelector
    ? phaseViewSelector
    : phaseViewTabs.getByRole("tab", { name: "Overview", exact: true });
  const focusEvidence = await collectFocusEvidence(focusTarget);
  expectCondition(
    focusEvidence.focused && focusEvidence.focusVisible && focusEvidence.outlineStyle !== "none",
    "Keyboard focus is not visibly retained on the compact phase navigator",
    focusEvidence,
  );
  await page.locator("#notes-panel-roadmap").evaluate((element) => {
    element.scrollTop = 0;
  });

  const geometry = await collectGeometry(page, viewport);
  expectCondition(geometry.titleVisible, "Localized phase title is not visible", geometry);
  expectCondition(geometry.documentOverflow <= 1, "Document overflows horizontally", geometry);
  expectCondition(geometry.panelOverflow <= 1, "Notes panel overflows horizontally", geometry);
  expectCondition(geometry.phaseOverflow <= 1, "Phase detail overflows horizontally", geometry);
  expectCondition(
    geometry.overflowers.length === 0,
    "Phase descendants escape the detail bounds",
    geometry,
  );
  expectCondition(
    geometry.verticalScrollers.length === 1 &&
      String(geometry.verticalScrollers[0]?.className).split(/\s+/).includes("notes-panel"),
    "Notes must expose exactly one vertical scroller",
    geometry,
  );
  expectCondition(
    geometry.primaryActionCount === 1,
    "Expected exactly one Resume phase action",
    geometry,
  );
  expectCondition(geometry.primaryInHeader, "Primary action is not in the detail header", geometry);
  expectCondition(
    !geometry.primaryInExecution,
    "Primary action is duplicated in the execution section",
    geometry,
  );
  expectCondition(geometry.primaryAboveFold, "Primary action is below the fold", geometry);

  const forcedColorsActive = await page.evaluate(
    () => matchMedia("(forced-colors: active)").matches,
  );
  expectCondition(
    forcedColorsActive === (forcedColors === "active"),
    "Forced-colors emulation does not match the requested scenario",
    { forcedColors, forcedColorsActive },
  );
  await page.screenshot({
    path: path.join(OUT_DIR, `${evidenceName}.png`),
    fullPage: false,
  });
  await context.close();
  return {
    scenario: evidenceName,
    phaseCount: 1,
    scale,
    forcedColors,
    ...geometry,
    expandedGeometry,
    viewGeometry,
    focusEvidence,
  };
}

async function captureListScenario(browser, { viewport, evidenceName, phaseCount }) {
  const { context, page } = await createPage(browser, { viewport, phaseCount });
  await openRoadmap(page);

  const roadmapTab = page.getByRole("tab", { name: "Roadmap" });
  await roadmapTab.focus();
  await page.keyboard.press("Tab");
  const newPhase = page.getByRole("button", { name: "New phase" });
  let focusTarget = newPhase;
  if (phaseCount > 0) {
    await page.keyboard.press("Tab");
    focusTarget = page.getByRole("button", { name: `Inspect phase: ${PHASE_TITLE}` });
  }
  const focusEvidence = await collectFocusEvidence(focusTarget);
  expectCondition(
    focusEvidence.focused && focusEvidence.focusVisible && focusEvidence.outlineStyle !== "none",
    `${phaseCount}-phase Roadmap did not preserve visible keyboard focus`,
    focusEvidence,
  );

  const geometry = await page.evaluate(
    ({ expectedPhaseCount }) => {
      const panel = document.querySelector("#notes-panel-roadmap");
      const workspace = document.querySelector(".notes-roadmap-workspace");
      const rows = [...document.querySelectorAll(".notes-roadmap-row")];
      if (!(panel instanceof HTMLElement) || !(workspace instanceof HTMLElement)) {
        throw new Error("Roadmap list geometry targets are missing");
      }
      return {
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOverflow: panel.scrollWidth - panel.clientWidth,
        workspaceOverflow: workspace.scrollWidth - workspace.clientWidth,
        rowCount: rows.length,
        expectedPhaseCount,
        hasDetail: Boolean(document.querySelector(".notes-phase-detail")),
        emptyStateVisible: Boolean(document.querySelector(".notes-roadmap-empty")),
        rowOverflowCount: rows.filter((row) => row.scrollWidth > row.clientWidth + 1).length,
      };
    },
    { expectedPhaseCount: phaseCount },
  );
  expectCondition(
    geometry.rowCount === phaseCount &&
      geometry.documentOverflow <= 1 &&
      geometry.panelOverflow <= 1 &&
      geometry.workspaceOverflow <= 1 &&
      geometry.rowOverflowCount === 0 &&
      !geometry.hasDetail &&
      geometry.emptyStateVisible === (phaseCount === 0),
    `${phaseCount}-phase Roadmap list failed its presentation contract`,
    geometry,
  );

  await page.screenshot({
    path: path.join(OUT_DIR, `${evidenceName}.png`),
    fullPage: false,
  });
  await context.close();
  return { scenario: evidenceName, phaseCount, viewport, ...geometry, focusEvidence };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 320, height: 800 },
    ]) {
      const size = `${viewport.width}x${viewport.height}`;
      results.push(
        await captureListScenario(browser, {
          viewport,
          evidenceName: `0-phases-${size}`,
          phaseCount: 0,
        }),
      );
      results.push(
        await captureDetailScenario(browser, {
          viewport,
          evidenceName: `1-phase-${size}`,
        }),
      );
      results.push(
        await captureListScenario(browser, {
          viewport,
          evidenceName: `50-phases-${size}`,
          phaseCount: 50,
        }),
      );
    }
    results.push(
      await captureDetailScenario(browser, {
        viewport: { width: 640, height: 800 },
        evidenceName: "1-phase-1280x800-at-200-percent",
        scale: 2,
      }),
    );
    results.push(
      await captureDetailScenario(browser, {
        viewport: { width: 1280, height: 800 },
        evidenceName: "1-phase-1280x800-forced-colors",
        forcedColors: "active",
      }),
    );

    await writeFile(path.join(OUT_DIR, "geometry.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Roadmap Slice 4 evidence passed: ${OUT_DIR}`);
    for (const result of results) {
      console.log(
        `${result.scenario}: phases=${result.phaseCount} document=${result.documentOverflow}px panel=${result.panelOverflow}px focus=${result.focusEvidence.focusVisible ? "visible" : "missing"}`,
      );
    }
  } finally {
    await browser.close();
  }
}

await main();
