import { useEffect, useRef, useState } from "react";
import { Skeleton } from "./Skeleton";

/**
 * Prompt-enhancer animation that plays over the chat input while enhancing.
 * Three phases, with the input collapsing to its default (empty) size and then
 * growing naturally as the new prompt builds in:
 *
 *   1. DISSOLVE  — the whole draft fades out as one smooth motion (opacity +
 *                  a gentle upward drift + slight scale) while the box height
 *                  collapses to a single line — a soft "vanish", not a delete.
 *                  Deliberately no `filter: blur()`: an animated blur on a
 *                  promoted layer crashes WKWebView's compositor on Intel Macs
 *                  (whole window goes black). See .enh-diss-fade in App.css.
 *   2. SKELETON  — a shimmer placeholder holds the (now default-height) box while
 *                  the model thinks; covers the API call's variable latency.
 *   3. DECODE    — the enhanced text types in left-to-right behind a bright glyph
 *                  lead; the box expands line-by-line as the text wraps.
 *
 * Dissolve is CSS-transition driven (one smooth tween of opacity/transform/height);
 * decode is an RAF loop that mutates spans' textContent directly (no per-frame
 * React render). React only re-renders on phase change.
 */

// Same katakana/digit alphabet as WakeScreen's Matrix rain — keeps it on-brand.
const GLYPHS =
  "\u30A2\u30AB\u30B5\u30BF\u30CA\u30CF\u30DE\u30E4\u30E9\u30EF\u30F30123456789<>[]{}=+*";
const randGlyph = (): string => GLYPHS[(Math.random() * GLYPHS.length) | 0];

// Dissolve transition duration — must match the CSS `.enh-diss-fade` transition.
const DISSOLVE_MS = 460;
const GLYPH_SWAP_MS = 40; // how often the decode lead glyph re-rolls
// Decode duration scales with length so short prompts snap and long ones still
// feel deliberate, capped so it never drags.
const decodeDuration = (len: number): number => Math.min(950, Math.max(380, len * 7));

type Phase = "dissolve" | "skeleton" | "decode";

export function EnhanceDissolve({
  oldText,
  newText,
  onDone,
}: {
  oldText: string;
  newText: string | null;
  onDone: () => void;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("dissolve");

  const dissolveRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const leadRef = useRef<HTMLSpanElement | null>(null);
  const newTextRef = useRef(newText);
  const onDoneRef = useRef(onDone);
  // Keep the latest props in refs for the async timer/RAF callbacks below. Synced
  // in an effect (not during render) so they're current by the time those fire.
  useEffect(() => {
    newTextRef.current = newText;
    onDoneRef.current = onDone;
  });

  // DISSOLVE: one smooth CSS tween — fade + drift while the box height
  // collapses to a single line. No character deletion.
  useEffect(() => {
    if (phase !== "dissolve") return;
    const el = dissolveRef.current;
    const advance = (): void => setPhase(newTextRef.current !== null ? "decode" : "skeleton");
    if (!el) {
      advance();
      return;
    }
    // Lock the current (multi-line) height so it can transition down to one line.
    // The box is border-box with the composer's block padding, so the one-line
    // target includes that padding (matching an empty input's height).
    const cs = getComputedStyle(el);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const lineH = (parseFloat(cs.lineHeight) || 22.5) + pad;
    el.style.height = `${el.offsetHeight}px`;
    // Force a reflow so the start height is committed before the change below,
    // otherwise the browser collapses both into a single non-animated step.
    void el.offsetHeight;
    const raf = requestAnimationFrame(() => {
      el.classList.add("dissolving");
      el.style.height = `${lineH}px`;
    });
    const timer = setTimeout(advance, DISSOLVE_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [phase]);

  // SKELETON → DECODE as soon as the enhancer result lands.
  useEffect(() => {
    if (phase === "skeleton" && newText !== null) setPhase("decode");
  }, [phase, newText]);

  // DECODE: type newText in from 0 to full length, then finish.
  useEffect(() => {
    if (phase !== "decode" || newText === null) return;
    const total = newText.length;
    const dur = decodeDuration(total);
    const start = performance.now();
    let raf = 0;
    let lastSwap = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / dur);
      const shown = Math.round(total * t);
      if (textRef.current) textRef.current.textContent = newText.slice(0, shown);
      // Keep the newest typed-in text in view if it grows past the scroll cap.
      const box = textRef.current?.parentElement;
      if (box) box.scrollTop = box.scrollHeight;
      if (leadRef.current) {
        if (now - lastSwap >= GLYPH_SWAP_MS) lastSwap = now;
        leadRef.current.textContent = shown < total ? randGlyph() : "";
      }
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        onDoneRef.current();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, newText]);

  // Distinct keys per phase force React to mount a FRESH DOM node each phase
  // rather than reusing one div — otherwise the inline `height` set on the
  // dissolve node (to tween its collapse) bleeds into the decode node, pinning
  // it to one line so the typed-in text scrolls in place instead of expanding.
  if (phase === "dissolve") {
    return (
      <div key="dissolve" ref={dissolveRef} className="enh-diss enh-diss-fade" aria-hidden="true">
        {oldText}
      </div>
    );
  }

  if (phase === "skeleton") {
    return (
      <div key="skeleton" className="enh-diss enh-diss-skeleton" aria-hidden="true">
        <Skeleton />
      </div>
    );
  }

  return (
    <div key="decode" className="enh-diss" aria-hidden="true">
      <span ref={textRef} className="enh-diss-text" />
      <span ref={leadRef} className="enh-diss-lead" />
    </div>
  );
}
