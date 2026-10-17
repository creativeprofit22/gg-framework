import { useEffect, useRef, useState } from "react";
import { createCampfireRenderer, type CampfireRenderer } from "./campfire-scene";
import { BIOMES, type Biome } from "./critter-terrain";
import { useWindowFocused } from "./useWindowFocused";

/** Embers and smoke drift slowly; 24 frames a second keeps them smooth. */
const FRAME_MS = 1000 / 24;
/** Where a still (reduced-motion) frame is taken: sparks up, smoke curling. */
const STILL_SECONDS = 30;

/** Terrains that belong in the campfire's clearing. */
const SCENERY_BIOME_IDS: ReadonlySet<string> = new Set(["meadow"]);

/**
 * The terrain the home screen shows with the scenery on: the visit's pick when
 * it has a scene, otherwise one that does, so ground and horizon always match.
 */
export function withScenery(biome: Biome): Biome {
  if (SCENERY_BIOME_IDS.has(biome.id)) return biome;
  return BIOMES.find((b) => SCENERY_BIOME_IDS.has(b.id)) ?? biome;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The home screen's backdrop: the critters' campfire clearing in the pines,
 * lit by the local clock (see scene-light.ts). Fills the home screen under
 * all content and never takes pointer events.
 *
 * - Background windows stop animating (the last frame stays), so an idle
 *   window costs nothing.
 * - Reduced motion draws one still frame, re-lit as the hour moves on.
 * - No 2D canvas: nothing draws, and the plain background shows.
 */
export function HomeScenery({ hour }: { hour: number }): React.ReactElement {
  const focused = useWindowFocused();
  const [reduced] = useState(prefersReducedMotion);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<CampfireRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) setRenderer(createCampfireRenderer(canvas, window.devicePixelRatio));
  }, []);

  // Before the first fit, so the scene is painted once, already lit.
  useEffect(() => {
    renderer?.setHour(hour);
  }, [renderer, hour]);

  useEffect(() => {
    const box = canvasRef.current?.parentElement;
    if (!renderer || !box) return;
    const fit = (): void => renderer.resize(box.clientWidth, box.clientHeight);
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [renderer]);

  useEffect(() => {
    if (!renderer) return;
    if (reduced) {
      renderer.frame(STILL_SECONDS);
      return;
    }
    if (!focused) return;
    let raf = 0;
    let last = -Infinity;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      renderer.frame(now / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [renderer, focused, reduced]);

  return (
    <div className="home-scenery" aria-hidden="true">
      <canvas className="home-scenery-canvas" ref={canvasRef} />
    </div>
  );
}
