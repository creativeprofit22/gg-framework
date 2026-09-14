import { useEffect, useRef } from "react";
import { theme } from "./theme";

/**
 * One-shot confetti burst, fired from the center of its positioned parent the
 * moment it mounts. Pure `<canvas>` + requestAnimationFrame, zero dependencies.
 * Drop it inside a `position: relative` container; it fills that container with
 * a non-interactive overlay, plays a single ~1.6s burst, then renders nothing.
 *
 * Respects `prefers-reduced-motion` (renders nothing). Used by the What's-new
 * window to celebrate a fresh update — see `WhatsNewWindow.tsx`.
 */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  size: number;
  color: string;
}

const COLORS = [
  theme.primary,
  theme.secondary,
  theme.success,
  theme.warning,
  theme.info,
  theme.error,
];
const COUNT = 80;
const GRAVITY = 0.18;
const DRAG = 0.985;
const FADE_AFTER_MS = 900;
const LIFE_MS = 1700;

export function Confetti(): React.ReactElement | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reduced) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = canvas;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    // Burst origin: center of the modal.
    const cx = w / 2;
    const cy = h / 2;
    const particles: Particle[] = Array.from({ length: COUNT }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 5 + Math.random() * 9;
      return {
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3, // bias upward so it arcs nicely
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.4,
        size: 4 + Math.random() * 4,
        color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? theme.primary,
      };
    });

    const start = performance.now();
    let raf = 0;

    const tick = (now: number): void => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, w, h);
      const fade =
        elapsed < FADE_AFTER_MS
          ? 1
          : Math.max(0, 1 - (elapsed - FADE_AFTER_MS) / (LIFE_MS - FADE_AFTER_MS));

      for (const p of particles) {
        p.vx *= DRAG;
        p.vy = p.vy * DRAG + GRAVITY;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;

        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }

      if (elapsed < LIFE_MS) {
        raf = requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, w, h);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  if (reduced) return null;

  return <canvas ref={canvasRef} className="confetti-canvas" aria-hidden="true" />;
}
