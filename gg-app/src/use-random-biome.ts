import { useCallback, useEffect, useState } from "react";
import { pickBiome, type Biome } from "./critter-terrain";

/**
 * Which terrain was shown last (home screen or chat, any window), so the next
 * pick is always a different one.
 */
const LAST_TERRAIN_KEY = "gg-critter-terrain";

function readLastTerrain(): string | null {
  try {
    return localStorage.getItem(LAST_TERRAIN_KEY);
  } catch {
    return null;
  }
}

function rememberTerrain(id: string): void {
  try {
    localStorage.setItem(LAST_TERRAIN_KEY, id);
  } catch {
    // Storage unavailable: the next pick may repeat this one, which is fine.
  }
}

/**
 * A random critter terrain, never the one shown last. `reroll` swaps in a new
 * one (also never the current one) and keeps one identity for the component's
 * lifetime, so effects can depend on it without re-running.
 */
export function useRandomBiome(
  randomSource: () => number = Math.random,
): readonly [Biome, () => void] {
  // The first source wins, which keeps `reroll` stable.
  const [random] = useState(() => randomSource);
  const [biome, setBiome] = useState<Biome>(() => pickBiome(readLastTerrain(), random));

  useEffect(() => {
    rememberTerrain(biome.id);
  }, [biome]);

  const reroll = useCallback(() => {
    setBiome((current) => pickBiome(current.id, random));
  }, [random]);

  return [biome, reroll] as const;
}
