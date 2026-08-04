import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const asciiLogoSource = readFileSync(new URL("./AsciiLogo.tsx", import.meta.url), "utf8");

describe("narrow-window layout contracts", () => {
  it("fits every Supah Coder logo column inside the home gutters", () => {
    const logoLines = [...asciiLogoSource.matchAll(/^\s+"([^"]+)",$/gm)].map((match) => match[1]);
    expect(logoLines).toHaveLength(6);
    expect(Math.max(...logoLines.map((line) => [...line].length))).toBe(86);

    const responsiveSize = appCss.match(
      /\.ascii-logo\s*\{[\s\S]*?font-size:\s*min\(12px,\s*calc\(\(100vw - (\d+)px\) \/ ([\d.]+)\)\)/,
    );
    expect(responsiveSize).not.toBeNull();
    const horizontalGutter = Number(responsiveSize?.[1]);
    const logoWidthEm = Number(responsiveSize?.[2]);

    for (const viewportWidth of [320, 484, 1164]) {
      const fontSize = Math.min(12, (viewportWidth - horizontalGutter) / logoWidthEm);
      expect(fontSize * logoWidthEm).toBeLessThanOrEqual(viewportWidth - horizontalGutter);
    }
    expect(Math.min(12, (1164 - horizontalGutter) / logoWidthEm)).toBe(12);
  });

  it("keeps the portaled model menu fixed above responsive footer clipping", () => {
    expect(appCss).toMatch(
      /\.model-menu\s*\{[\s\S]*?responsive footer overflow cannot clip[\s\S]*?position:\s*fixed;/,
    );
  });

  it("keeps Roadmap phase detail inside a 320px viewport with one vertical Notes scroller", () => {
    const viewportWidth = 320;
    const modalWidth = viewportWidth - 12;
    const panelRailWidth = modalWidth - 28;
    const phaseDetailWidth = panelRailWidth - 24;

    expect(phaseDetailWidth).toBe(256);
    expect(phaseDetailWidth).toBeGreaterThan(0);
    expect(appCss).toMatch(
      /\.notes-panel\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;/,
    );
    expect(appCss).toMatch(
      /\.notes-phase-detail :is\(section, details, form, dl, ul, li, div\)\s*\{\s*min-width:\s*0;/,
    );
    expect(appCss).toMatch(
      /\.notes-phase-detail :is\(p, li, dt, dd, small, span, strong, a, code, pre\)\s*\{\s*overflow-wrap:\s*anywhere;/,
    );
    expect(appCss).toMatch(
      /\.notes-reminder-section input,[\s\S]*?\.notes-reminder-section textarea\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?min-width:\s*0;/,
    );

    const notesVerticalScrollerSelectors = [
      ...appCss.matchAll(/([^{}]+)\{[^{}]*overflow-y:\s*auto;/g),
    ]
      .map((match) => match[1]?.trim() ?? "")
      .filter(
        (selector) =>
          selector === ".notes-panel" ||
          selector.includes("notes-roadmap") ||
          selector.includes("notes-phase"),
      );
    expect(notesVerticalScrollerSelectors).toEqual([".notes-panel"]);

    const phaseViewRules = [...appCss.matchAll(/\.notes-phase-view[^{}]*\{([^{}]*)\}/g)]
      .map((match) => match[1])
      .join("\n");
    expect(phaseViewRules).not.toMatch(/overflow-y:\s*(?:auto|scroll)/);
    expect(appCss).toMatch(/\.notes-phase-view-select\s*\{\s*display:\s*none;/);
    expect(appCss).toMatch(/\.notes-phase-view-select label\s*\{[\s\S]*?white-space:\s*nowrap;/);
    expect(appCss).toMatch(
      /@media \(max-width:\s*560px\)[\s\S]*?\.notes-phase-views\s*\{\s*display:\s*none;[\s\S]*?\.notes-phase-view-select\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*auto minmax\(0,\s*1fr\);/,
    );
  });

  it("biases the Roadmap workspace toward detail with compact, consistently spaced controls", () => {
    expect(appCss).toMatch(
      /\.notes-roadmap-workspace\.has-detail\s*\{[\s\S]*?grid-template-columns:\s*minmax\(260px,\s*0\.68fr\)\s*minmax\(0,\s*1\.32fr\);/,
    );
    expect(appCss).toMatch(
      /\.notes-phase-detail-heading\s*\{[\s\S]*?gap:\s*8px 12px;[\s\S]*?padding:\s*10px 12px 8px;/,
    );
    expect(appCss).toMatch(/\.notes-phase-detail-actions\s*\{[\s\S]*?gap:\s*8px;/);
    expect(appCss).toMatch(
      /\.notes-phase-views button\s*\{[\s\S]*?min-height:\s*30px;[\s\S]*?padding:\s*6px 8px 5px;/,
    );
    expect(appCss).toMatch(/\.notes-phase-view-select\s*\{[\s\S]*?padding:\s*8px 10px;/);
  });

  it("lets expanded saved prompts wrap in the Notes panel instead of creating a nested scroller", () => {
    const promptBlock = appCss.match(/\.notes-phase-saved-prompt pre\s*\{([\s\S]*?)\}/)?.[1];

    expect(promptBlock).toBeDefined();
    expect(promptBlock).toMatch(/overflow:\s*visible;/);
    expect(promptBlock).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(promptBlock).toMatch(/white-space:\s*pre-wrap;/);
    expect(promptBlock).not.toMatch(/max-height:/);
    expect(appCss).toMatch(
      /@media \(max-width:\s*560px\)[\s\S]*?\.notes-phase-detail-actions \.notes-roadmap-primary\s*\{\s*width:\s*100%;/,
    );
  });
});
