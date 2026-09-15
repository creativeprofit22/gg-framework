import { lazy, Suspense, useSyncExternalStore } from "react";
import { useGgUiEnabled } from "./gg-ui";

// Keep the shader in its own chunk; inactive/static controls never request it.
const MetalFx = lazy(() => import("metal-fx").then((module) => ({ default: module.MetalFx })));
const STATIC_MEDIA = "(prefers-reduced-motion: reduce), (forced-colors: active)";

function subscribeStaticAppearance(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(STATIC_MEDIA);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function prefersStaticAppearance(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia(STATIC_MEDIA).matches;
}

/** Decorative sibling: the real button keeps its focus, click handler, and fallback styling. */
export function ActionMetal({
  active,
  windowFocused,
  variant = "circle",
}: {
  active: boolean;
  windowFocused: boolean;
  variant?: "circle" | "button";
}): React.ReactElement | null {
  const ggUiEnabled = useGgUiEnabled();
  const staticAppearance = useSyncExternalStore(
    subscribeStaticAppearance,
    prefersStaticAppearance,
    () => true,
  );
  if (!active || !ggUiEnabled || staticAppearance) return null;

  return (
    <Suspense fallback={null}>
      <MetalFx
        className="action-metal"
        preset="chromatic"
        variant={variant}
        theme="dark"
        strength={0.81}
        innerShadow
        normalizeHostStyles={false}
        paused={!windowFocused}
        aria-hidden="true"
      >
        <span className="action-metal-surface" />
      </MetalFx>
    </Suspense>
  );
}
