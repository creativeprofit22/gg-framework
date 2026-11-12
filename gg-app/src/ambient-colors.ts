/**
 * Ambient backgrounds (Home dither, wake-screen code rain, the window glow)
 * share one colour family: the `--ambient-*` tokens in App.css, which point at
 * each theme's own `--bg` / `--glow` / `--primary`. Canvas and WebGL effects
 * cannot read `var()`, so they resolve the tokens here — on mount and on
 * appearance change only, never per frame.
 */

/** Linear 0–1 channels, the shape the WebGL dither expects. */
export type Rgb = readonly [number, number, number];

export interface AmbientColors {
  /** The surface the effect sits on (`--ambient-base`). */
  base: Rgb;
  /** The calm ink every effect draws with (`--ambient-ink`). */
  ink: Rgb;
  /** The rare brighter accent (`--ambient-ink-hi`). */
  inkHi: Rgb;
}

/** Dark-theme values, used when tokens cannot be resolved (tests, no CSS). */
export const AMBIENT_FALLBACK: AmbientColors = {
  base: [10 / 255, 10 / 255, 12 / 255],
  ink: [85 / 255, 96 / 255, 216 / 255],
  inkHi: [176 / 255, 182 / 255, 255 / 255],
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_FN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i;

/** Parse `#rgb`, `#rrggbb`, `rgb()` or `rgba()` into 0–1 channels; alpha is ignored. */
export function parseCssColor(value: string): Rgb | null {
  const text = value.trim();
  const hex = HEX.exec(text)?.[1];
  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    const n = Number.parseInt(full, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const fn = RGB_FN.exec(text);
  if (!fn) return null;
  const channels = [fn[1], fn[2], fn[3]].map((c) => Number(c));
  if (channels.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return null;
  const [r = 0, g = 0, b = 0] = channels;
  return [r / 255, g / 255, b / 255];
}

/**
 * Resolve the ambient tokens as seen by `element` (so a themed island such as
 * the wake screen gets its own values), falling back per token.
 */
export function readAmbientColors(element: Element | null): AmbientColors {
  if (!element || typeof getComputedStyle !== "function") return AMBIENT_FALLBACK;
  const style = getComputedStyle(element);
  const read = (name: string, fallback: Rgb): Rgb =>
    parseCssColor(style.getPropertyValue(name)) ?? fallback;
  return {
    base: read("--ambient-base", AMBIENT_FALLBACK.base),
    ink: read("--ambient-ink", AMBIENT_FALLBACK.ink),
    inkHi: read("--ambient-ink-hi", AMBIENT_FALLBACK.inkHi),
  };
}

/** A canvas-ready `rgba()` string. */
export function rgbaCss([r, g, b]: Rgb, alpha = 1): string {
  const to255 = (c: number): number => Math.round(Math.min(1, Math.max(0, c)) * 255);
  return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${alpha})`;
}
