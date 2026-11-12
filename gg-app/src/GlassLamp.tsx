import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { GLASS_WISPS, sampleGlassWisps } from "./glass-wisps";
import { useMotionLevel } from "./window-motion";

const STILL_MEDIA = "(prefers-reduced-motion: reduce), (forced-colors: active)";
/** Fixed pose for the resting lamp: a balanced, readable swirl. */
const REST_SECONDS = 1;
const passes = ["far", "near"] as const;

function subscribeStill(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(STILL_MEDIA);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function prefersStill(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia(STILL_MEDIA).matches;
}

/** Seconds since `active` turned on, ticking only while the window may animate. */
function useLampClock(running: boolean): number {
  const [seconds, setSeconds] = useState(REST_SECONDS);
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    const start = performance.now() - REST_SECONDS * 1000;
    const tick = (now: number) => {
      setSeconds((now - start) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);
  return seconds;
}

/**
 * Decorative glass orb with smoke inside (technique from the user's bloub project).
 * Static by default; the smoke drifts only while `active` in a visible, focused
 * window, and never under reduced motion or forced colours. Status is always
 * carried by text elsewhere, so this is hidden from assistive technology.
 */
export function GlassLamp({
  active = false,
  size = 40,
}: {
  active?: boolean;
  size?: number;
}): React.ReactElement {
  const uid = useId();
  const motion = useMotionLevel();
  const still = useSyncExternalStore(subscribeStill, prefersStill, () => true);
  const running = active && motion === "full" && !still;
  const seconds = useLampClock(running);
  const ribbons = sampleGlassWisps(running ? seconds : REST_SECONDS);
  const id = (name: string) => `${uid}-${name}`;
  return (
    <svg
      className="inst-glass"
      data-active={active ? "" : undefined}
      data-running={running ? "" : undefined}
      width={size}
      height={size}
      viewBox="-104 -104 208 208"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={id("body")}>
          <circle r="100" />
        </clipPath>
        {/* Volume: lit off-centre, dark band inside the edge, lifted rim (bloub's shell). */}
        <radialGradient
          id={id("volume")}
          gradientUnits="userSpaceOnUse"
          cx="-18"
          cy="-26"
          r="124"
          fx="-26"
          fy="-34"
        >
          <stop offset="0" style={{ stopColor: "var(--inst-glass-core)" }} />
          <stop offset="0.42" style={{ stopColor: "var(--inst-glass-mid)" }} />
          <stop offset="0.76" style={{ stopColor: "var(--inst-glass-deep)" }} />
          <stop offset="0.91" style={{ stopColor: "var(--inst-glass-band)" }} />
          <stop offset="1" style={{ stopColor: "var(--inst-glass-rim)" }} />
        </radialGradient>
        <linearGradient
          id={id("shine")}
          gradientUnits="userSpaceOnUse"
          x1="-55"
          y1="-98"
          x2="5"
          y2="-24"
        >
          <stop stopColor="#f2f4ff" stopOpacity="0.9" />
          <stop offset="0.45" stopColor="#c2cbff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#8f9bd8" stopOpacity="0" />
        </linearGradient>
        {/* Rim: key light top-left, faint bounce light bottom-right. */}
        <linearGradient
          id={id("rim")}
          gradientUnits="userSpaceOnUse"
          x1="-90"
          y1="-90"
          x2="75"
          y2="92"
        >
          <stop stopColor="#e3e8ff" stopOpacity="0.75" />
          <stop offset="0.35" stopColor="#9aa6e6" stopOpacity="0.08" />
          <stop offset="0.7" stopColor="#9aa6e6" stopOpacity="0.05" />
          <stop offset="1" stopColor="#a9b6ff" stopOpacity="0.55" />
        </linearGradient>
        {passes.map((pass) =>
          ribbons.map((ribbon, index) => (
            <linearGradient
              key={`${pass}-${index}`}
              id={id(`wisp-${pass}-${index}`)}
              gradientUnits="userSpaceOnUse"
              {...GLASS_WISPS.gradient}
            >
              {ribbon[pass].map((opacity, stop) => (
                <stop
                  key={stop}
                  offset={GLASS_WISPS.offsets[stop]}
                  style={{ stopColor: "var(--inst-glass-smoke)" }}
                  stopOpacity={opacity}
                />
              ))}
            </linearGradient>
          )),
        )}
        {passes.map((pass) => (
          <filter
            key={pass}
            id={id(`blur-${pass}`)}
            filterUnits="userSpaceOnUse"
            x="-130"
            y="-130"
            width="260"
            height="260"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur
              stdDeviation={pass === "far" ? GLASS_WISPS.farSigma : GLASS_WISPS.nearSigma}
            />
          </filter>
        ))}
      </defs>
      <g clipPath={`url(#${id("body")})`}>
        <rect x="-104" y="-104" width="208" height="208" fill={`url(#${id("volume")})`} />
        {passes.map((pass) =>
          ribbons.map((ribbon, index) => (
            <path
              key={`${pass}-${index}`}
              d={ribbon.d}
              fill={`url(#${id(`wisp-${pass}-${index}`)})`}
              filter={`url(#${id(`blur-${pass}`)})`}
            />
          )),
        )}
        <path
          d="M -91 -24 C -91 -67 -61 -94 -24 -99 C -39 -83 -51 -66 -58 -42 C -63 -26 -81 -18 -91 -24 Z"
          fill={`url(#${id("shine")})`}
        />
        <path
          d="M -19 -99 C 21 -104 62 -77 77 -42 C 49 -71 20 -73 -1 -73 C -14 -73 -10 -91 -19 -99 Z"
          fill={`url(#${id("shine")})`}
          opacity="0.4"
        />
      </g>
      <circle r="98.5" fill="none" stroke={`url(#${id("rim")})`} strokeWidth="5" />
    </svg>
  );
}
