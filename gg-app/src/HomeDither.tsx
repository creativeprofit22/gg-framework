import { Component, lazy, Suspense, useState, useSyncExternalStore } from "react";
import { appearance, type Appearance } from "./appearance";
// Type-only: erased at build, so three.js stays in the lazily loaded chunk.
import type { Rgb } from "./Dither";
import { useWindowFocused } from "./useWindowFocused";

// three.js + postprocessing are large, so they load in their own chunk, only
// when the home screen is shown (never on the chat or project screens).
const Dither = lazy(() => import("./Dither").then((module) => ({ default: module.Dither })));

/**
 * Dark: React Bits' suggested grey waves on black. Light: grey dots on the
 * Light theme's near-white background (#fcfbfd), so Home ink drawn for Light
 * reads against it. The dither quantises each colour channel to `colorNum`
 * levels, so a tinted wave comes out as saturated primary dots; neutral grey
 * stays calm behind the text.
 */
const PALETTES = {
  dark: {
    wave: [0.34509803921568627, 0.34509803921568627, 0.34509803921568627] as const,
    background: [0, 0, 0] as const,
  },
  light: {
    wave: [0.6, 0.6, 0.6] as const,
    background: [0.988, 0.984, 0.992] as const,
  },
} satisfies Record<Appearance["theme"], { wave: Rgb; background: Rgb }>;

const getTheme = (): Appearance["theme"] => appearance.getSnapshot().preferences.theme;

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Keeps a failed effect (lost GPU context, a driver bug) from taking the home
 * screen down with it: the backdrop just disappears, leaving the plain
 * background.
 */
class BackdropBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The home screen's animated backdrop: React Bits' dithered waves, filling the
 * screen behind the logo and buttons. The waves bend away from the pointer,
 * read from the whole home screen, so content on top stays clickable.
 *
 * - Background windows stop rendering (the last frame stays), so an idle
 *   window costs no GPU time.
 * - Reduced motion draws one still frame, with no pointer response.
 * - No WebGL: nothing renders, and the plain background shows.
 */
export function HomeDither(): React.ReactElement | null {
  const focused = useWindowFocused();
  const palette = PALETTES[useSyncExternalStore(appearance.subscribe, getTheme)];
  const [reduced] = useState(prefersReducedMotion);
  const [supported] = useState(webglAvailable);
  // The home screen element: pointer events are read from it, since the
  // backdrop itself sits under the content and never receives them.
  const [home, setHome] = useState<HTMLElement | null>(null);

  if (!supported) return null;

  return (
    <div
      className="home-dither"
      aria-hidden="true"
      ref={(el) => setHome(el?.parentElement ?? null)}
    >
      {home && (
        <BackdropBoundary>
          <Suspense fallback={null}>
            <Dither
              waveColor={palette.wave}
              backgroundColor={palette.background}
              colorNum={4}
              pixelSize={2}
              waveAmplitude={0.3}
              waveFrequency={3}
              waveSpeed={0.05}
              mouseRadius={0.3}
              disableAnimation={reduced}
              enableMouseInteraction={!reduced}
              frameloop={focused && !reduced ? "always" : "demand"}
              eventSource={home}
            />
          </Suspense>
        </BackdropBoundary>
      )}
    </div>
  );
}
