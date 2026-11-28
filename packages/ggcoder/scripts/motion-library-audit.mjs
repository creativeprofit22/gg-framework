// Shared rules for GG Motion's style library, used by the build script and
// the test suite so both enforce exactly the same contract.

export const KINDS = [
  "background",
  "type",
  "diagram",
  "data",
  "ui",
  "3d",
  "frame",
  "transition",
  "texture",
];

/** The only remote script a library file may load (same pin as HyperFrames' catalog). */
export const GSAP_PREFIX = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/";

/** Design tokens every look defines and every piece may read. */
export const TOKENS = [
  "--field",
  "--field-2",
  "--ink",
  "--accent",
  "--muted",
  "--line",
  "--display",
  "--display-weight",
  "--display-stretch",
  "--display-tracking",
  "--text",
  "--mono",
  "--radius",
];

/** Wall-clock, randomness and free-running loops make seeked frames differ between renders. */
const FORBIDDEN = [
  [/Math\.random\s*\(/, "Math.random (use a seeded generator)"],
  [/Date\.now\s*\(|new Date\s*\(/, "wall-clock time"],
  [/performance\.now\s*\(/, "wall-clock time"],
  [/requestAnimationFrame\s*\(/, "requestAnimationFrame loop"],
  [/set(Interval|Timeout)\s*\(/, "timers"],
  [/animation[^;{}]*\binfinite\b/, "infinite CSS animation"],
  [/fonts\.googleapis|fonts\.gstatic/, "remote fonts (use the bundled library)"],
];

/**
 * Determinism and network problems in a library HTML file.
 * @param {string} source
 * @returns {string[]}
 */
export function auditSource(source) {
  const issues = [];
  for (const [pattern, label] of FORBIDDEN) if (pattern.test(source)) issues.push(label);
  for (const url of source.match(/https?:\/\/[^\s"'()<>`]+/g) ?? []) {
    if (!url.startsWith(GSAP_PREFIX) && !url.startsWith("http://www.w3.org/")) {
      issues.push(`remote URL ${url}`);
    }
  }
  return issues;
}
