import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolvePxTokens } from "./test-support/resolve-css-tokens";

// App.css plus the Local Fork sheets imported directly after it, in cascade order.
const appCss = resolvePxTokens(
  ["./App.css", "./WorkspaceShell.css", "./NotesRoadmap.css", "./LocalUpdateSummaryOption.css"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n"),
);
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
    // glass.css is Light-only, so its rules carry the zero-specificity
    // `:where(:root[data-appearance-theme="light"])` scope prefix. It now has
    // no table rules at all (asserted below), but any that return are scanned.
    const declared: string[] = [];
    for (const css of [appCss, glassCss]) {
      for (const rule of css.matchAll(
        /^(?::where\(:root\[data-appearance-theme="light"\]\)\s+)?\.markdown table\s*\{([^}]*)\}/gm,
      )) {
        for (const decl of (rule[1] ?? "").matchAll(/(?:^|;|\*\/)\s*width\s*:\s*([^;]+);/g)) {
          declared.push((decl[1] ?? "").trim());
        }
      }
    }
    expect(declared.length).toBeGreaterThan(0);
    expect(glassCss).not.toMatch(/\.markdown table\s*\{/);
    expect(declared.at(-1)).toBe("100%");
    expect(declared).not.toContain("max-content");
  });

  it("exempts Markdown tables from the prose reading cap and lets headers wrap between words", () => {
    const cap = appearanceCss.match(
      /:root\[data-appearance-cap="on"\]([^{]*)\{\s*max-inline-size:\s*74ch;/,
    );
    // Every table (folding /steroids one included) renders as one `.md-table`
    // card, the direct child of the reply's Markdown.
    expect(cap?.[1]?.replace(/\s+/g, " ").trim()).toBe(
      ".assistant-text .markdown > :not(.md-table)",
    );
    // The always-on 36em prose measure must also exempt the table card, or the
    // /steroids candidates table is squeezed and its right columns hidden.
    const measure = appCss.match(
      /(\.assistant-text\s+\.markdown\s*>\s*:not\([^)]*\))\s*\{\s*max-width:\s*36em;/,
    );
    expect(measure?.[1]?.replace(/\s+/g, " ").trim()).toBe(
      ".assistant-text .markdown > :not(.md-table, .code-block, .ken-prompt-block)",
    );
    expect(appCss).not.toMatch(/\.markdown th,\s*\.markdown td code\s*\{\s*white-space:\s*nowrap;/);
    expect(appCss).toMatch(/\.markdown td code\s*\{\s*white-space:\s*nowrap;/);
  });

  it("draws every Markdown table grid from shared ink tokens, with no Light-only overrides", () => {
    // Regression: glass.css's Light-only table rules drew white hairlines and a
    // white header strip, which vanished on Light's white canvas.
    expect(glassCss).not.toMatch(/\.markdown\s+(?:table|th|td|tbody|tr|:is\(th)/);
    expect(appCss).toMatch(/--table-line:\s*rgb\(var\(--ink-rgb\) \/ [\d.]+\);/);
    expect(appCss).toMatch(/--table-line-strong:\s*rgb\(var\(--ink-rgb\) \/ [\d.]+\);/);
    expect(appCss).toMatch(
      /\.markdown th,\s*\.markdown td\s*\{[^}]*border-bottom:\s*1px solid var\(--table-line\);/,
    );
    expect(appCss).toMatch(
      /\.markdown \.md-table-scroll\s*\{[^}]*border:\s*1px solid var\(--table-line-strong\);/,
    );
    // Material is per theme through tokens on the same rules: Dark's Alloy keys
    // in App.css :root, Light's liquid glass in appearance.css. Light's values
    // must not live in glass.css, whose zero-specificity scope loses to :root.
    for (const token of [
      "--table-card-bg",
      "--table-head-bg",
      "--table-toggle-bg",
      "--table-grain",
    ]) {
      expect(appCss).toMatch(new RegExp(`${token}:`));
      expect(appearanceCss).toMatch(
        new RegExp(`:root\\[data-appearance-theme="light"\\]\\s*\\{[^}]*${token}:`),
      );
      expect(glassCss).not.toMatch(new RegExp(`${token}:`));
    }
    expect(appCss).toMatch(/--table-head-bg:\s*var\(--key\);/);
    expect(appCss).toMatch(/\.markdown th\s*\{[^}]*background-image:\s*var\(--table-grain\);/);
    // Reduced transparency / more contrast drop the grain in both themes.
    for (const css of [appCss, appearanceCss]) {
      expect(css).toMatch(
        /@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\)\s*\{[^@]*?--table-grain:\s*none;/,
      );
    }
    // Content stays light: no zebra fill, and dates and ranks carry no chip or
    // badge fill (the palette probe measured the chip fill as the heaviest
    // colour in Light).
    expect(appCss).not.toMatch(/tr:nth-child\(even\)/);
    expect(appCss).not.toMatch(/\.markdown \.md-date\s*\{[^}]*background/);
    expect(appCss).not.toMatch(/\.markdown \.md-rank\s*\{[^}]*background/);
    // Header icon motions only run when motion is welcome.
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.markdown th:is\(:hover, :focus-within\) \.md-th-icon/,
    );
    // Narrow panes tighten cells for every theme, not only Light.
    expect(appCss).toMatch(
      /@container \(max-width:\s*420px\)\s*\{[^@]*?\.markdown :is\(th, td\)\s*\{\s*padding:/,
    );
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
    // Phase sub-views stay a tablist at every width: the row scrolls sideways
    // instead of swapping to a select.
    expect(appCss).not.toMatch(/\.notes-phase-view-select/);
    expect(appCss).toMatch(
      /\.notes-phase-views-scroll\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/,
    );
    expect(appCss).toMatch(/\.notes-phase-views button\s*\{[^}]*white-space:\s*nowrap;/);
    expect(appCss).not.toMatch(/\.notes-phase-views button\s*\{[^}]*text-overflow:/);
    expect(appCss).not.toMatch(/\.notes-phase-views\s*\{\s*display:\s*none;/);
    // Focus rings are drawn inside tabs so the scrollers cannot clip them.
    expect(appCss).toMatch(
      /\.notes-modal \[role="tab"\]:focus-visible\s*\{\s*outline-offset:\s*-2px;/,
    );
  });

  it("sizes narrow phase-overview labels to the longest word so none breaks mid-word", () => {
    const narrow = [...appCss.matchAll(/@media \(max-width:\s*560px\)\s*\{([\s\S]*?)\n\}/g)]
      .map((block) => block[1])
      .join("\n");
    expect(narrow).toMatch(
      /\.notes-phase-overview-completion dl\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0,\s*1fr\);/,
    );
    expect(narrow).toMatch(
      /\.notes-phase-overview-completion dl > div\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-template-columns:\s*subgrid;/,
    );
    // A fixed label column (88px held "Implementation" at 390px) made the word wrap.
    expect(narrow).not.toMatch(
      /\.notes-phase-overview-completion dl > div\s*\{[^}]*grid-template-columns:\s*\d+px/,
    );
  });

  it("gives the Saved prompt summary the 44px touch floor on coarse pointers", () => {
    const coarse = [...appCss.matchAll(/@media \(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/g)]
      .map((block) => block[1])
      .join("\n");
    expect(coarse).toMatch(/\.notes-phase-saved-prompt summary\s*\{[^}]*min-height:\s*44px;/);
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
    // Narrow layouts show the detail instead of the list (the groups wrapper holds the lists).
    expect(appCss).toMatch(
      /@media \(max-width:\s*760px\)[\s\S]*?\.notes-roadmap-workspace\.has-detail \.notes-roadmap-groups\s*\{\s*display:\s*none;/,
    );
    expect(appCss).not.toMatch(/\.notes-roadmap-workspace\s*\{[^}]*grid-template-columns:/);
    expect(appCss).toMatch(
      /\.notes-phase-detail-heading\s*\{[\s\S]*?gap:\s*8px 12px;[\s\S]*?padding:\s*10px 12px 8px;/,
    );
    expect(appCss).toMatch(/\.notes-phase-detail-actions\s*\{[\s\S]*?gap:\s*8px;/);
    expect(appCss).toMatch(
      /\.notes-phase-views button\s*\{[\s\S]*?min-height:\s*32px;[\s\S]*?padding:\s*6px 8px 5px;/,
    );
    expect(appCss).toMatch(
      /@media \(pointer: coarse\)\s*\{[^}]*\.notes-phase-views button\s*\{\s*min-height:\s*44px;/,
    );
  });

  it("sizes Roadmap and phase-detail buttons at 32px for mice and 44px for touch", () => {
    expect(appCss).toMatch(
      /\.notes-roadmap-new,\s*\.notes-roadmap-primary,[^{]*\.notes-storage-diagnostics button\s*\{\s*min-height:\s*32px;/,
    );
    expect(appCss).toMatch(
      /\.notes-phase-references-empty button\s*\{\s*flex:\s*0 0 auto;\s*min-height:\s*32px;/,
    );
    const touchFloor =
      /@media \(pointer: coarse\)\s*\{\s*\.notes-roadmap-new,\s*\.notes-roadmap-primary,\s*\.notes-phase-detail-actions \.notes-roadmap-primary,\s*\.notes-roadmap-card-action,[^{]*\.notes-phase-detail-heading button,[^{]*\.notes-phase-references-empty button\s*\{\s*min-height:\s*44px;\s*\}\s*\}/;
    expect(appCss).toMatch(touchFloor);
    // The 560px block raises these to 36px; the touch floor must come later to win.
    const narrowRule = appCss.search(
      /\.notes-phase-references-heading > button\s*\{\s*min-height:\s*36px;/,
    );
    expect(narrowRule).toBeGreaterThan(-1);
    expect(appCss.search(touchFloor)).toBeGreaterThan(narrowRule);
  });

  it("tiers Notes buttons with paired theme tokens and a focus-revealed Quiet look", () => {
    const primary = appCss.match(/button\.notes-btn-primary\s*\{([^}]*)\}/)?.[1];
    expect(primary).toMatch(/background:\s*var\(--primary\);/);
    expect(primary).toMatch(/color:\s*var\(--on-primary\);/);
    expect(appCss).toMatch(
      /button\.notes-btn-primary:hover:not\(:disabled\)\s*\{[^}]*background:\s*var\(--primary-hi\);[^}]*color:\s*var\(--on-primary\);/,
    );
    // Keyboard focus reveals Quiet buttons the same way hover does.
    expect(appCss).toMatch(
      /button\.notes-btn-quiet:is\([^{]*:focus-visible\)\s*\{[^}]*background:\s*var\(--gloss-neutral\);/,
    );
    expect(appCss).toMatch(
      /button\.notes-btn-quiet\.notes-btn-danger:is\(:hover, :focus-visible\):not\(:disabled\)\s*\{\s*color:\s*var\(--error\);/,
    );
    // No Notes button rule hard-codes white ink (it failed contrast on Dark's pale violet).
    const notesButtonRules = [...appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
      /\.notes-[\w-]*(?:button|btn|primary|card-action|toggle)|\.notes-[\w-]+ button/.test(
        selector ?? "",
      ),
    );
    expect(notesButtonRules.length).toBeGreaterThan(10);
    for (const [, , body] of notesButtonRules) {
      expect(body).not.toMatch(/(?:^|[\s;])color:\s*(?:#fff\b|#ffffff\b|white\b)/i);
    }
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

  it("styles the composer Enhance pill and pins it out of the input's text flow", () => {
    // Regression: an upstream merge removed these rules while the fork still
    // renders the pill, leaving a browser-default grey button in the composer.
    expect(appCss).toMatch(
      /^\.enhance-pill-host\s*\{[^}]*position:\s*absolute;[^}]*left:\s*50%;[^}]*pointer-events:\s*none;/m,
    );
    expect(appCss).toMatch(
      /^\.enhance-pill\s*\{[^}]*background:\s*var\(--primary\);[^}]*color:\s*var\(--on-primary\);/m,
    );
    expect(appCss).toMatch(/^\.enhance-pill-host\.visible\s*\{[^}]*pointer-events:\s*auto;/m);
    // The decorative metal rim sits behind its button instead of in the layout.
    expect(appCss).toMatch(
      /\.enhance-pill-host > \.action-metal,[\s\S]*?\{\s*position:\s*absolute;\s*inset:\s*0;/,
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
