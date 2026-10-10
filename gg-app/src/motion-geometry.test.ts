// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => document.body.replaceChildren());
import { viewportScale } from "./motion-geometry";

describe("viewportScale", () => {
  it.each([0.5, 0.95, 1, 1.25, 1.5, 2])("preserves fractional layout pixels at %s", (scale) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.style.width = "100.25px";
    el.style.padding = "3px";
    el.style.border = "1px solid";
    expect(viewportScale(el, new DOMRect(0, 0, 108.25 * scale, 20))).toBeCloseTo(scale, 8);
    el.style.boxSizing = "border-box";
    expect(viewportScale(el, new DOMRect(0, 0, 100.25 * scale, 20))).toBeCloseTo(scale, 8);
  });

  it("falls back safely for hidden or unmeasured elements", () => {
    const el = document.createElement("div");
    expect(viewportScale(el, new DOMRect())).toBe(1);
    Object.defineProperty(el, "offsetWidth", { value: 100 });
    expect(viewportScale(el, new DOMRect(0, 0, 200, 20))).toBe(2);
    expect(viewportScale(el, new DOMRect())).toBe(1);
  });
});
