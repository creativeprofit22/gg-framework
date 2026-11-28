// @ts-check
// Run order. Candidates are rotated through every position (a Latin-square
// style rotation of a seeded base order) so warm caches, thermal drift and
// background load hit every candidate equally. Workload item order is
// shuffled per repeat from the same seed.
import { makeRng, seedFrom, shuffle } from "./rng.mjs";

/**
 * @typedef {{ index: number, phase: "warmup" | "measure", repeat: number, item: string, candidate: string, position: number }} Slot
 */

/**
 * Build the full, deterministic run schedule.
 * @param {{ candidates: readonly string[], items: readonly string[], repeats: number, warmupRepeats?: number, seed: number }} options
 * @returns {Slot[]}
 */
export function buildSchedule({ candidates, items, repeats, warmupRepeats = 0, seed }) {
  if (candidates.length === 0 || items.length === 0) return [];
  const base = shuffle(candidates, makeRng(seedFrom(`${seed}:order`)));
  const n = base.length;
  /** @type {Slot[]} */
  const slots = [];
  const total = warmupRepeats + repeats;
  for (let r = 0; r < total; r++) {
    const phase = r < warmupRepeats ? "warmup" : "measure";
    const repeat = phase === "warmup" ? r : r - warmupRepeats;
    const itemOrder = shuffle(items, makeRng(seedFrom(`${seed}:items:${r}`)));
    itemOrder.forEach((item, itemIndex) => {
      const offset = (r + itemIndex) % n;
      for (let p = 0; p < n; p++) {
        slots.push({
          index: slots.length,
          phase,
          repeat,
          item,
          candidate: /** @type {string} */ (base[(p + offset) % n]),
          position: p,
        });
      }
    });
  }
  return slots;
}

/**
 * How often each candidate ran in each position (balance check).
 * @param {readonly Slot[]} slots
 */
export function positionCounts(slots) {
  /** @type {Record<string, number[]>} */
  const out = {};
  for (const s of slots) {
    if (s.phase !== "measure") continue;
    const row = (out[s.candidate] ??= []);
    row[s.position] = (row[s.position] ?? 0) + 1;
  }
  return out;
}
