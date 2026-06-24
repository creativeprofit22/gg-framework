import { useEffect, useRef, useState } from "react";

/**
 * The empty-state "wake" screen — the app addressing the user, Matrix-style.
 *
 * A faint, brand-tinted digital-rain canvas drifts behind a single line of
 * terminal text that types itself out one character at a time, cycles through a
 * few homage lines ("Wake up…" → "The codebase has you…"), then rests on the
 * invitation with a blinking block cursor. The whole thing fades out the moment
 * the first prompt is sent (the parent stops rendering it once items appear).
 *
 * Pure 2D canvas + timeouts, zero deps. Honors `prefers-reduced-motion`: the
 * rain is skipped and the final line is shown immediately, no typing.
 */

// Sequential lines, typed one at a time on the same row (each replaces the
// prior). The last entry is the resting invitation and never gets cleared.
const LINES = [
  "Wake up\u2026",
  "The codebase has you.",
  "Follow the commit history.",
  "Talk to me. Let\u2019s start coding.",
] as const;

const TYPE_MS = 55; // per-character type speed
const HOLD_MS = 1400; // pause once a line finishes typing
const ERASE_MS = 22; // per-character erase speed

type Phase = "typing" | "holding" | "erasing";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function MatrixRain(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const context = canvasEl.getContext("2d");
    if (!context) return;
    const canvas = canvasEl;
    const ctx = context;

    // Katakana + digits + a few brackets — the classic rain alphabet.
    const GLYPHS =
      "\u30A2\u30AB\u30B5\u30BF\u30CA\u30CF\u30DE\u30E4\u30E9\u30EF\u30F30123456789<>[]{}=+*";
    const FONT_SIZE = 14;

    let columns = 0;
    let drops: number[] = [];
    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      const parent = canvas.parentElement;
      if (!parent) return;
      width = parent.clientWidth;
      height = parent.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      columns = Math.max(1, Math.floor(width / FONT_SIZE));
      drops = Array.from({ length: columns }, () =>
        Math.floor((Math.random() * height) / FONT_SIZE),
      );
    }
    resize();

    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    let raf = 0;
    let last = 0;
    const STEP = 70; // ms between rain advances (~14fps — calm, cheap)

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      if (now - last < STEP) return;
      last = now;

      // Trail fade — translucent wash over the prior frame.
      ctx.fillStyle = "rgba(15, 17, 21, 0.18)";
      ctx.fillRect(0, 0, width, height);
      ctx.font = `${FONT_SIZE}px var(--mono, monospace)`;

      for (let i = 0; i < columns; i++) {
        const ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        const x = i * FONT_SIZE;
        const y = drops[i] * FONT_SIZE;
        // Brand periwinkle/blue rain — bright lead glyph, dim tail.
        ctx.fillStyle = Math.random() > 0.97 ? "#9b8cf7" : "rgba(77, 157, 255, 0.55)";
        ctx.fillText(ch, x, y);
        if (y > height && Math.random() > 0.975) drops[i] = 0;
        else drops[i]++;
      }
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="wake-rain" aria-hidden="true" />;
}

export function WakeScreen(): React.ReactElement {
  const reduced = prefersReducedMotion();
  const [text, setText] = useState(reduced ? LINES[LINES.length - 1] : "");
  const [done, setDone] = useState(reduced);

  useEffect(() => {
    if (reduced) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let line = 0;
    let pos = 0;
    let phase: Phase = "typing";

    const isLast = () => line === LINES.length - 1;

    function tick() {
      if (cancelled) return;
      const full = LINES[line];

      if (phase === "typing") {
        pos++;
        setText(full.slice(0, pos));
        if (pos >= full.length) {
          if (isLast()) {
            setDone(true);
            return; // rest here forever — the invitation stays
          }
          phase = "holding";
          timer = setTimeout(tick, HOLD_MS);
        } else {
          timer = setTimeout(tick, TYPE_MS);
        }
        return;
      }

      if (phase === "holding") {
        phase = "erasing";
        timer = setTimeout(tick, ERASE_MS);
        return;
      }

      // erasing
      pos--;
      setText(full.slice(0, Math.max(0, pos)));
      if (pos <= 0) {
        line++;
        phase = "typing";
        timer = setTimeout(tick, TYPE_MS * 4);
      } else {
        timer = setTimeout(tick, ERASE_MS);
      }
    }

    timer = setTimeout(tick, 450); // brief beat before the first keystroke
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reduced]);

  return (
    <div className="wake-screen transcript-reveal" aria-label="Ready to start">
      {!reduced && <MatrixRain />}
      <div className="wake-text">
        <span className="wake-line">{text}</span>
        <span className={`wake-cursor${done ? " wake-cursor-rest" : ""}`}>{"\u2588"}</span>
      </div>
    </div>
  );
}
