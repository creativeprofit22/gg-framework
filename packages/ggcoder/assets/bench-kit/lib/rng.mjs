// @ts-check
// Seeded randomness. Every random choice in the kit (bootstrap draws, run
// order, rating labels) comes from an explicit seed so a study can be replayed.

/**
 * Deterministic PRNG (mulberry32), ported from bench/search/stats.mjs.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 32-bit FNV-1a hash of a string, used to derive sub-seeds ("seed:aa").
 * @param {string} text
 */
export function seedFrom(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Fisher–Yates shuffle into a new array.
 * @template T
 * @param {readonly T[]} items
 * @param {() => number} rng
 * @returns {T[]}
 */
export function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = /** @type {T} */ (out[i]);
    out[i] = /** @type {T} */ (out[j]);
    out[j] = tmp;
  }
  return out;
}

/**
 * Pick one index uniformly.
 * @param {number} length
 * @param {() => number} rng
 */
export function pickIndex(length, rng) {
  return Math.floor(rng() * length);
}
