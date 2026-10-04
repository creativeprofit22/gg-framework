import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const glassCss = readFileSync(new URL("./glass.css", import.meta.url), "utf8");
const appearanceCss = readFileSync(new URL("./appearance.css", import.meta.url), "utf8");
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

  it("keeps Markdown tables fluid so chat panes wrap cells instead of scrolling sideways", () => {
    // Every `.markdown table { … }` width, in cascade order (App.css, then the
    // glass theme layered on top). Regression: glass.css once set
    // `width: max-content`, overriding the fluid width on every wide table.
    const declared: string[] = [];
    for (const css of [appCss, glassCss]) {
      for (const rule of css.matchAll(/^\.markdown table\s*\{([^}]*)\}/gm)) {
        for (const decl of (rule[1] ?? "").matchAll(/(?:^|;|\*\/)\s*width\s*:\s*([^;]+);/g)) {
          declared.push((decl[1] ?? "").trim());
        }
      }
    }
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.at(-1)).toBe("100%");
    expect(declared).not.toContain("max-content");
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

  it("splits Roadmap cards and phase detail with compact, consistently spaced controls", () => {
    expect(appCss).toMatch(/\.notes-roadmap-list\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*10px;/);
    expect(appCss).toMatch(
      /\.notes-phase-detail\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?margin:\s*0 12px 12px;/,
    );
    // Selecting a phase opens an adjacent detail column on wide layouts.
    expect(appCss).toMatch(
      /\.notes-roadmap-workspace\.has-detail\s*\{[^}]*grid-template-columns:\s*minmax\(/,
    );
    // Narrow layouts show the detail instead of the list.
    expect(appCss).toMatch(
      /@media \(max-width:\s*760px\)[\s\S]*?\.notes-roadmap-workspace\.has-detail \.notes-roadmap-list\s*\{\s*display:\s*none;/,
    );
    expect(appCss).not.toMatch(/\.notes-roadmap-workspace\s*\{[^}]*grid-template-columns:/);
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

  it("gives the pane drag handle the 44px touch floor without crowding the pane actions", () => {
    // Mouse density stays at 24px; coarse pointers get the same 44px box as the
    // pane actions and Close.
    expect(appCss).toMatch(/^\.pane-drag-handle\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/m);
    expect(appCss).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*\.pane-drag-handle\s*\{\s*width:\s*44px;\s*height:\s*44px;\s*\}\s*\}/,
    );

    // Floating chrome (Home/Settings): above the narrow-pane breakpoint, the
    // focused pane's four 44px actions share the top line with the handle and
    // must start right of it.
    const handleLeft = Number(
      appCss.match(/^\.pane-drag-handle-agent\s*\{[^}]*?left:\s*(\d+)px;/m)?.[1],
    );
    const coarseActions = appCss.match(
      /@media \(pointer: coarse\)\s*\{\s*\.workspace-pane-actions\s*\{\s*right:\s*(\d+)px;[\s\S]*?@container conversation-pane \(max-width:\s*(\d+)px\)\s*\{\s*\.workspace-pane-actions\s*\{\s*top:\s*52px;/,
    );
    expect(coarseActions).not.toBeNull();
    const actionsRight = Number(coarseActions?.[1]);
    const narrowBreakpoint = Number(coarseActions?.[2]);
    const actionsRowWidth = 4 * 44 + 3 * 3;

    const firstSharedWidth = narrowBreakpoint + 1;
    expect(firstSharedWidth - actionsRight - actionsRowWidth).toBeGreaterThanOrEqual(
      handleLeft + 44,
    );
  });
});

describe("glass accessibility fallback", () => {
  const solidFallbackQuery =
    /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\)\s*\{\s*/;
  const glassTokens = (block: string | undefined): Map<string, string> =>
    new Map(
      [...(block ?? "").matchAll(/(--glass[\w-]*)\s*:\s*([^;]+);/g)].map(
        (match) => [match[1] ?? "", (match[2] ?? "").trim()] as const,
      ),
    );

  it("turns Light glass solid too, despite Light's higher-specificity tints", () => {
    // Regression: the Light tints sit on `:root[data-appearance-theme="light"]`
    // (0,2,0), which beat glass.css's `:root` (0,1,0) fallback, so Light glass
    // stayed translucent under Reduce transparency / Increase contrast.
    const darkFallback = glassTokens(
      glassCss.match(new RegExp(`${solidFallbackQuery.source}:root\\s*\\{([^}]*)\\}`))?.[1],
    );
    const lightTints = glassTokens(
      appearanceCss.match(/^:root\[data-appearance-theme="light"\]\s*\{([^}]*)\}/m)?.[1],
    );
    const lightFallback = glassTokens(
      appearanceCss.match(
        new RegExp(
          `${solidFallbackQuery.source}:root\\[data-appearance-theme="light"\\]\\s*\\{([^}]*)\\}`,
        ),
      )?.[1],
    );

    expect(darkFallback.get("--glass")).toBe("var(--surface-1)");
    expect(lightFallback.get("--glass")).toBe("var(--surface-1)");
    const overridden = [...lightTints.keys()].filter((token) => darkFallback.has(token));
    expect(overridden.length).toBeGreaterThan(0);
    for (const token of overridden) {
      expect(lightFallback.get(token), token).toBe(darkFallback.get(token));
    }
  });
});
