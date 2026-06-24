import { useEffect, useRef } from "react";

/**
 * Ambient home-screen backdrop: a slow brand-tinted constellation — drifting
 * nodes with faint lines drawn between near neighbours. Sits behind the meme
 * layer and all content (z-index 0, non-interactive), vignette-masked so it
 * fades at the edges and never competes with the logo/buttons.
 *
 * Pure 2D canvas, zero deps, DPR-aware. Honors `prefers-reduced-motion`: the
 * field is rendered once as a static frame (no animation loop).
 */

const NODE_COLOR = "rgba(77, 157, 255, 0.85)"; // primary blue
const ACCENT_COLOR = "rgba(155, 140, 247, 0.9)"; // secondary periwinkle
const LINK_COLOR = "77, 157, 255"; // rgb channels for line alpha
const LINK_DIST = 132; // px within which two nodes get a connecting line
const SPEED = 0.12; // px per frame drift

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  accent: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function HomeBackdrop(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const context = canvasEl.getContext("2d");
    if (!context) return;
    const canvas = canvasEl;
    const ctx = context;
    const reduced = prefersReducedMotion();

    let width = 0;
    let height = 0;
    let nodes: Node[] = [];

    function build() {
      const parent = canvas.parentElement;
      if (!parent) return;
      width = parent.clientWidth;
      height = parent.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Node count scales with area, capped so big screens stay cheap.
      const count = Math.min(70, Math.floor((width * height) / 22000));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 2 * SPEED,
        vy: (Math.random() - 0.5) * 2 * SPEED,
        r: 1 + Math.random() * 1.6,
        accent: Math.random() > 0.82,
      }));
    }
    function draw() {
      ctx.clearRect(0, 0, width, height);

      // Links first so nodes sit on top.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist > LINK_DIST) continue;
          const alpha = (1 - dist / LINK_DIST) * 0.22;
          ctx.strokeStyle = `rgba(${LINK_COLOR}, ${alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      for (const n of nodes) {
        ctx.fillStyle = n.accent ? ACCENT_COLOR : NODE_COLOR;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    build();

    // On resize, rebuild the field. In static (reduced-motion) mode the loop
    // isn't running, so repaint immediately or the canvas stays blank.
    const ro = new ResizeObserver(() => {
      build();
      if (reduced) draw();
    });
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    function step() {
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        // Wrap softly around the edges for an endless drift.
        if (n.x < -10) n.x = width + 10;
        else if (n.x > width + 10) n.x = -10;
        if (n.y < -10) n.y = height + 10;
        else if (n.y > height + 10) n.y = -10;
      }
    }

    if (reduced) {
      draw(); // single static frame
      return () => ro.disconnect();
    }

    let raf = 0;
    function frame() {
      raf = requestAnimationFrame(frame);
      step();
      draw();
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="home-backdrop" aria-hidden="true" />;
}
