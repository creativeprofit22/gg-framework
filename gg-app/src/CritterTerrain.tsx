import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  DECOR_COLS,
  TERRAIN_PX,
  particleCount,
  renderTerrain,
  weatherParticles,
  type Biome,
  type PropSprite,
} from "./critter-terrain";

/** One decor strip, in CSS px; the props repeat every strip across the lane. */
const STRIP_PX = DECOR_COLS * TERRAIN_PX;
/** Until the lane is measured (and in tests, which have no layout). */
const FALLBACK_WIDTH = 1280;

/** CSS custom properties alongside the regular style keys. */
type Style = CSSProperties & Record<`--${string}`, string | number>;

/**
 * The lane's width, rounded up to whole decor strips so it only changes (and
 * re-renders the props) when another strip is needed, not on every pixel of a
 * window resize.
 */
function useStripWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => {
    const initial = typeof window === "undefined" ? 0 : window.innerWidth;
    return Math.ceil((initial || FALLBACK_WIDTH) / STRIP_PX) * STRIP_PX;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const measured = entry?.contentRect.width ?? 0;
      if (measured > 0) setWidth(Math.ceil(measured / STRIP_PX) * STRIP_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const px = (cells: number): string => `${cells * TERRAIN_PX}px`;

function PropSlot({
  prop,
  left,
  wave,
}: {
  prop: PropSprite;
  left: number;
  wave: number;
}): React.ReactElement {
  const style: Style = {
    left: `${left}px`,
    bottom: px(prop.bottom),
    width: px(prop.width),
    height: px(prop.height),
    "--img": `url("${prop.url}")`,
    "--wave": wave.toFixed(3),
  };
  const motion = prop.motion ? ` m-${prop.motion}` : "";
  return (
    <span className={`terrain-prop on-${prop.layer}${motion}`} style={style}>
      <span className="terrain-prop-art" />
    </span>
  );
}

/**
 * The pixel world critters stand on, inside a critter lane. In paint order:
 * the sky (weather and passing travelers), the land (the repeating ground
 * strip plus anything sunk into it), then the props on and above it. Every
 * entrance and exit is CSS keyed off the lane's open / closing classes; see
 * "Critter terrain" in App.css for the choreography.
 */
export function CritterTerrain({ biome }: { biome: Biome }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const width = useStripWidth(ref);
  const art = useMemo(() => renderTerrain(biome), [biome]);
  const particles = useMemo(
    () => weatherParticles(biome, particleCount(biome, width)),
    [biome, width],
  );

  // Every strip's props, each with its place in the left-to-right wave the
  // scenery sprouts (and packs away) in.
  const strips = width / STRIP_PX;
  const placed = Array.from({ length: strips }, (_, strip) =>
    art.props.map((prop, i) => {
      const left = strip * STRIP_PX + prop.x * TERRAIN_PX;
      return { key: `${strip}:${i}`, prop, left, wave: Math.min(1, left / width) };
    }),
  ).flat();
  const sunk = placed.filter((p) => p.prop.layer === "sunk");
  const standing = placed.filter((p) => p.prop.layer !== "sunk");

  return (
    <div className="critter-terrain" data-terrain={biome.id} ref={ref}>
      <div className="terrain-sky">
        {biome.weather && (
          <div className={`terrain-weather wx-${biome.weather.kind}`}>
            {particles.map((p, i) => {
              const style: Style = {
                left: `${p.left}%`,
                width: px(p.size),
                height: px(p.size),
                background: p.color,
                animationDuration: `${p.duration}s`,
                animationDelay: `${p.delay}s`,
                "--y": p.y,
                "--drift": `${p.drift}px`,
              };
              return <i key={i} className="wx" style={style} />;
            })}
          </div>
        )}
        {art.travelers.map((t, i) => {
          const style: Style = {
            bottom: px(t.bottom),
            height: px(t.height),
            "--period": `${t.period}s`,
            "--start": `${t.delay}s`,
          };
          // Starts just off the left edge.
          const artStyle: Style = {
            "--from": `-${px(t.width)}`,
            width: px(t.width),
            backgroundImage: `url("${t.url}")`,
          };
          return (
            <span key={i} className={`terrain-traveler tr-${t.kind}`} style={style}>
              <span className="terrain-traveler-art" style={artStyle} />
            </span>
          );
        })}
      </div>
      <div className="terrain-land">
        <div className="terrain-ground" style={{ backgroundImage: `url("${art.ground}")` }} />
        {sunk.map((p) => (
          <PropSlot key={p.key} prop={p.prop} left={p.left} wave={p.wave} />
        ))}
      </div>
      <div className="terrain-props">
        {standing.map((p) => (
          <PropSlot key={p.key} prop={p.prop} left={p.left} wave={p.wave} />
        ))}
      </div>
    </div>
  );
}
