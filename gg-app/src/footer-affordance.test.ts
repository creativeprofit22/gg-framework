// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const appCss = readFileSync("src/App.css", "utf8");

// The shared footer affordance block: the hover/focus pill and picker chevron.
// Only this block is injected — jsdom's CSS parser does not need the rest of
// the sheet, and hover cannot be simulated, so these checks cover the resting
// pill geometry, the disabled chevron and the selectors the pill keys off.
function footerAffordanceCss(): string {
  const start = appCss.indexOf("/* Footer controls read as plain text at rest");
  const end = appCss.indexOf(".model-menu {", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return appCss.slice(start, end).split("var(--radius-sm)").join("4px");
}

function renderPicker(className: string, disabled: boolean): HTMLElement {
  const picker = document.createElement(className === "native" ? "span" : "label");
  picker.className = className === "native" ? "model-picker model-picker-native" : "model-picker";
  const text = document.createElement("span");
  text.className = "model-select-text";
  text.textContent = className === "native" ? "GPT" : "Context stable";
  const select = document.createElement("select");
  select.className = "model-select";
  select.disabled = disabled;
  picker.append(text, select);
  document.body.append(picker);
  return picker;
}

describe("footer control affordance", () => {
  beforeEach(() => {
    const style = document.createElement("style");
    style.textContent = footerAffordanceCss();
    document.head.append(style);
  });

  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("gives the Codex context picker the same pill geometry as the native model picker", () => {
    const native = getComputedStyle(renderPicker("native", false));
    const context = getComputedStyle(renderPicker("context", false));

    for (const style of [native, context]) {
      expect(style.paddingTop).toBe("3px");
      expect(style.paddingLeft).toBe("6px");
      expect(style.marginTop).toBe("-3px");
      expect(style.marginLeft).toBe("-6px");
      expect(style.borderRadius).toBe("4px");
    }
  });

  it("does not give the fallback button wrapper a second pill around the button", () => {
    const wrapper = document.createElement("span");
    wrapper.className = "model-picker";
    const button = document.createElement("button");
    button.className = "model-button";
    wrapper.append(button);
    document.body.append(wrapper);

    expect(getComputedStyle(wrapper).paddingLeft).not.toBe("6px");
    expect(getComputedStyle(button).paddingLeft).toBe("6px");
  });

  it("keys the hover/focus pill and chevron on the shared select structure", () => {
    const css = footerAffordanceCss();
    expect(css).not.toContain(".model-picker-native");
    expect(css).toContain(
      ".model-picker:has(> .model-select:not(:disabled)):is(:hover, :has(:focus-visible)) {",
    );
    expect(css).toMatch(
      /\.model-picker:has\(> \.model-select:not\(:disabled\)\):is\(:hover, :has\(:focus-visible\)\)\s+\.model-select-text::after/,
    );
  });

  it("gives a disabled context picker no pill trigger and a dimmed chevron", () => {
    const picker = renderPicker("context", true);
    const text = picker.querySelector(".model-select-text");
    if (!text) throw new Error("missing picker text");
    expect(picker.matches(".model-picker:has(> .model-select:not(:disabled))")).toBe(false);
    // jsdom does not compute pseudo-element styles, so check the disabled
    // chevron rule's selector matches this picker's text and dims it.
    const disabledChevron = footerAffordanceCss().match(
      /\.model-picker:has\(\.model-select:disabled\) \.model-select-text::after\s*\{\s*opacity:\s*([\d.]+);/,
    );
    expect(disabledChevron?.[1]).toBe("0.25");
    expect(text.matches(".model-picker:has(.model-select:disabled) .model-select-text")).toBe(true);
  });
});
