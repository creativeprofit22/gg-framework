import { useEffect, useRef } from "react";
import { createCritterFloor } from "./critter-floor";
import { CritterTerrain } from "./CritterTerrain";
import { TERRAIN_CLOSE_MS, TERRAIN_LAND_MS, type Biome } from "./critter-terrain";
import { homeRoster } from "./home-roster";

/** Let the home page assemble (its reveal-up entry) before the first beam lands. */
const ENTRY_DELAY_MS = 600;

interface Props {
  /** The terrain they live on; the home screen picks one each visit. */
  biome: Biome;
}

/**
 * The whole critter roster living along the bottom of the home screen, on the
 * visit's terrain (meadow, beach, desert, space, snow).
 * The ground rises out of the window's bottom edge, then they beam in one by one, then wander, meet, bonk and play with each other,
 * and spook when clicked (the same engine as the chat's sub-agent floor, in
 * its ambient mode). Decorative, so hidden from assistive tech.
 */
export function HomeCritters({ biome }: Props): React.ReactElement {
  const laneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const controller = createCritterFloor(lane, {
      reducedMotion,
      ambient: true,
      landAfterMs: TERRAIN_LAND_MS,
      closeAfterMs: TERRAIN_CLOSE_MS,
    });
    const entry = window.setTimeout(() => controller.sync(homeRoster()), ENTRY_DELAY_MS);
    return () => {
      window.clearTimeout(entry);
      controller.destroy();
    };
  }, []);

  return (
    <div className="home-critters" data-terrain={biome.id} aria-hidden="true">
      {/* Terrain first, so the floor the engine appends paints over it. */}
      <div className="critter-lane with-terrain" ref={laneRef}>
        <CritterTerrain biome={biome} />
      </div>
    </div>
  );
}
