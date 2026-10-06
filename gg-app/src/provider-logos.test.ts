import { describe, expect, it } from "vitest";
import { PROVIDER_LOGOS, isMonochromeProviderLogo } from "./provider-logos";

const svgSources = import.meta.glob<string>("./assets/providers/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

function svgFor(provider: string): string | undefined {
  return svgSources[`./assets/providers/${provider}.svg`];
}

describe("provider logos on Light", () => {
  // Off-white-only marks vanish on Light tiles unless they are re-inked.
  it.each(Object.keys(PROVIDER_LOGOS).sort())(
    "%s is re-inked exactly when it is off-white",
    (provider) => {
      const svg = svgFor(provider);
      if (svg === undefined) {
        expect(isMonochromeProviderLogo(provider)).toBe(false);
        return;
      }
      const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]?.toLowerCase());
      const offWhiteOnly = fills.length > 0 && fills.every((fill) => fill === "#f4f6f8");
      expect(isMonochromeProviderLogo(provider)).toBe(offWhiteOnly);
    },
  );
});
