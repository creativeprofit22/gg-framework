import { useEffect, useRef } from "react";
import type { Trophy, TrophySnapshot } from "./agent";
import { Icon } from "./icons";
import { viewportScale } from "./motion-geometry";
import { prefersReducedMotion } from "./transcript-motion";
import { TIER_NAME, TrophyMedal } from "./TrophiesPanel";
import { playTrophyUnlock } from "./trophy-sound";

// Mirrors of the App.css easing tokens (checked by scripts/motion-tokens.test.mjs).
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
/** The release spin: fast off the mark, a small overshoot as it lands face up. */
const SPIN_EASE = "cubic-bezier(0.15, 0.75, 0.35, 1.08)";

const LEVEL = { bronze: 0, silver: 1, gold: 2, platinum: 3 } as const;
/** How long the card waits, face up, before it files itself away. Hover or focus pauses it. */
const HOLD_MS = 7000;

/** The unlock's beats for a tier: rarer trophies charge longer and spin more. */
export function trophyTimeline(tier: Trophy["tier"]) {
  const level = LEVEL[tier];
  const charge = 0.5;
  const chargeFor = 1 + level * 0.35;
  const turns = 1 + level;
  const spinFor = 0.8 + level * 0.16;
  return { level, charge, chargeFor, turns, spinFor, end: charge + chargeFor + spinFor };
}

/**
 * The trophy unlock ("Charge"): a card lands face down in the corner where
 * toasts live, powers up (light racing round its edge, energy drawn in, arcs
 * crackling), then lets go in a spin of one to four turns, by tier, and lands
 * face up. It never blocks work. After a few seconds, or on dismiss, it files
 * itself into the trophies key on the deck. Reduced motion: it simply fades in
 * face up, with the chime alone.
 */
export function TrophyUnlock({
  trophy,
  snapshot,
  onOpenTrophies,
  onDone,
  keyScope,
}: {
  trophy: Trophy;
  snapshot: TrophySnapshot | null;
  onOpenTrophies: () => void;
  onDone: () => void;
  /**
   * Local Fork: where to look for the trophies key. Split panes each have a
   * deck, so the card must file into the earning pane's key, not the first.
   */
  keyScope?: () => ParentNode | null;
}): React.ReactElement {
  const keyScopeRef = useRef(keyScope);
  useEffect(() => {
    keyScopeRef.current = keyScope;
  }, [keyScope]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const leaveRef = useRef<() => void>(() => {});
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const card = cardRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !card || !canvas) return;
    const reduced = prefersReducedMotion() || typeof wrap.animate !== "function";
    const tl = trophyTimeline(trophy.tier);
    const rel = tl.charge + tl.chargeFor;
    const animations: Animation[] = [];
    const timers: number[] = [];
    let stopParticles = (): void => {};
    let finished = false;
    const anim = (
      el: Element,
      kf: Keyframe[],
      o: KeyframeAnimationOptions,
    ): { finished: Promise<unknown> } => {
      // Local Fork: `reduced` is chosen when animate() is missing, but the
      // reduced fades still called it and threw, taking the pane down. Skip
      // the motion and settle at once; the card still shows and files away.
      if (typeof el.animate !== "function") return { finished: Promise.resolve() };
      const a = el.animate(kf, { fill: "both", ...o });
      animations.push(a);
      return a;
    };
    const later = (ms: number, fn: () => void): void => {
      timers.push(window.setTimeout(fn, ms));
    };
    const stopSound = playTrophyUnlock(tl, reduced);

    const finish = (): void => {
      if (finished) return;
      finished = true;
      doneRef.current();
    };

    // Face up and live: the card can be read, dismissed or followed.
    let holdLeft = HOLD_MS;
    const goLive = (): void => {
      wrap.inert = false;
      wrap.setAttribute("data-flat", "");
      const tick = window.setInterval(() => {
        if (!wrap.matches(":hover") && !wrap.contains(document.activeElement)) holdLeft -= 100;
        if (holdLeft <= 0) {
          window.clearInterval(tick);
          leaveRef.current();
        }
      }, 100);
      timers.push(tick);
    };

    // Exit: shrink and arc into the trophies key, which lights up as it lands.
    let leaving = false;
    leaveRef.current = () => {
      if (leaving) return;
      leaving = true;
      wrap.inert = true;
      const key = (keyScopeRef.current?.() ?? document).querySelector<HTMLElement>(
        "[data-trophy-key]",
      );
      if (reduced || !key) {
        anim(wrap, [{ opacity: 1 }, { opacity: 0 }], {
          duration: 240,
          easing: EASE_IN,
        }).finished.then(finish, finish);
        return;
      }
      const r = wrap.getBoundingClientRect();
      const k = key.getBoundingClientRect();
      const scale = viewportScale(wrap, r);
      const dx = (k.left + k.width / 2 - (r.left + r.width / 2)) / scale;
      const dy = (k.top + k.height / 2 - (r.top + r.height / 2)) / scale;
      const frames: Keyframe[] = [];
      for (let i = 0; i <= 24; i++) {
        const u = i / 24;
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        frames.push({
          transform: `translate(${dx * e}px, ${dy * e - Math.sin(Math.PI * e) * 60}px) scale(${1 - 0.94 * e}) rotate(${-12 * e}deg)`,
          opacity: e > 0.9 ? 1 - (e - 0.9) * 10 : 1,
        });
      }
      anim(wrap, frames, { duration: 620, easing: "linear" }).finished.then(() => {
        key.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(0.88)" },
            { transform: "scale(1.1)" },
            { transform: "scale(1)" },
          ],
          { duration: 420, easing: EASE_OUT },
        );
        key.setAttribute("data-trophy-lit", "");
        window.setTimeout(() => key.removeAttribute("data-trophy-lit"), 1400);
        finish();
      }, finish);
    };

    wrap.inert = true;
    if (reduced) {
      card.style.transform = "none";
      anim(wrap, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: EASE_OUT });
      goLive();
    } else {
      card.style.transform = "rotateY(180deg)";
      const back = card.querySelector<HTMLElement>(".tu-back");
      const backTrace = back?.querySelector<HTMLElement>(".tu-trace");
      const core = back?.querySelector<HTMLElement>(".tu-core");
      const frontTrace = card.querySelector<HTMLElement>(".tu-front .tu-trace");
      const glare = card.querySelector<HTMLElement>(".tu-glare");
      const shine = card.querySelector<HTMLElement>(".tu-medal .tu-shine");
      const C = tl.charge * 1000;
      const CD = tl.chargeFor * 1000;
      const R = rel * 1000;
      const S = tl.spinFor * 1000;

      anim(
        wrap,
        [
          { transform: "translateY(240px)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 420, easing: EASE_EXPO },
      );
      if (backTrace) {
        anim(backTrace, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: C });
        anim(backTrace, [{ "--tu-a": "0deg" }, { "--tu-a": `${360 * (2 + tl.level)}deg` }], {
          duration: CD,
          delay: C,
          easing: EASE_IN,
        });
      }
      if (core)
        anim(core, [{ opacity: 0 }, { opacity: 0.9 }], { duration: CD, delay: C, easing: EASE_IN });
      // A shiver that grows as it charges, then a squeeze before letting go.
      const shiver: Keyframe[] = [];
      for (let i = 0; i <= 40; i++) {
        const amp = Math.pow(i / 40, 2) * (2 + tl.level);
        shiver.push({
          translate:
            i === 40
              ? "0 0"
              : `${(Math.random() * 2 - 1) * amp}px ${(Math.random() * 2 - 1) * amp}px`,
        });
      }
      anim(wrap, shiver, { duration: CD, delay: C, easing: "linear", fill: "none" });
      anim(wrap, [{ scale: "1" }, { scale: "0.95" }], {
        duration: CD,
        delay: C,
        easing: EASE_IN,
        fill: "forwards",
      });
      anim(wrap, [{ scale: "0.95" }, { scale: "1.06" }, { scale: "1" }], {
        duration: 420,
        delay: R,
        easing: EASE_OUT,
        fill: "forwards",
      });
      const from = 180 + 360 * tl.turns;
      anim(
        card,
        [
          { transform: `rotateY(${from}deg) translateZ(0)` },
          { transform: `rotateY(${from * 0.42}deg) translateZ(110px) scale(1.04)`, offset: 0.5 },
          { transform: "rotateY(0deg) translateZ(0) scale(1)" },
        ],
        { duration: S, delay: R, easing: SPIN_EASE, fill: "forwards" },
      );
      later(R + S - 60, () => {
        card.style.transform = "none";
        if (frontTrace) {
          anim(
            frontTrace,
            [
              { "--tu-a": "0deg", opacity: 1 },
              { "--tu-a": "540deg", opacity: 1, offset: 0.7 },
              { "--tu-a": "720deg", opacity: 0 },
            ],
            { duration: 2600, easing: "linear", fill: "forwards" },
          );
        }
        if (glare)
          anim(glare, [{ transform: "translateX(-110%)" }, { transform: "translateX(110%)" }], {
            duration: 1000,
            easing: EASE_OUT,
          });
        if (shine)
          anim(shine, [{ transform: "translateX(-130%)" }, { transform: "translateX(130%)" }], {
            duration: 900,
            easing: EASE_OUT,
          });
        goLive();
      });
      stopParticles = runParticles(canvas, wrap, trophy.tier, tl);
    }

    return () => {
      for (const a of animations) a.cancel();
      for (const t of timers) {
        window.clearTimeout(t);
        window.clearInterval(t);
      }
      stopParticles();
      stopSound();
    };
  }, [trophy.id, trophy.tier]);

  return (
    <div className="trophy-unlock">
      <canvas ref={canvasRef} className="tu-fx" aria-hidden="true" />
      <span className="sr-only" role="status">
        {`${TIER_NAME[trophy.tier]} trophy unlocked: ${trophy.title}. ${trophy.description}`}
      </span>
      <div ref={wrapRef} className="tu-wrap" data-tier={trophy.tier}>
        <div className="tu-shadow" aria-hidden="true" />
        <div ref={cardRef} className="tu-card">
          <div className="tu-edge" aria-hidden="true">
            {EDGE.map((k) => (
              <i key={k} style={{ "--k": k } as React.CSSProperties} />
            ))}
          </div>
          <div className="tu-back" aria-hidden="true">
            <span className="tu-mono">GG</span>
            <span className="tu-cap">TROPHY</span>
            <span className="tu-core" />
            <span className="tu-trace" />
          </div>
          <div className="tu-front">
            <span className="tu-medal-wrap">
              <TrophyMedal tier={trophy.tier} shine className="trophy-medal tu-medal" />
            </span>
            <div className="tu-head">
              <div className="tu-id">
                <span className="tu-eyebrow">
                  <span className="tier-dot" data-tier={trophy.tier} aria-hidden="true" />
                  {TIER_NAME[trophy.tier]} trophy unlocked
                </span>
                <span className="tu-title">{trophy.title}</span>
              </div>
              <button
                type="button"
                className="key key-icon key-sm"
                aria-label="Dismiss"
                title="Dismiss"
                onClick={() => leaveRef.current()}
              >
                <Icon name="xmark" size={13} />
              </button>
            </div>
            <p className="tu-desc">{trophy.description}</p>
            <div className="tu-foot">
              {snapshot && (
                <span className="tu-count">
                  {snapshot.earned} of {snapshot.total} trophies
                </span>
              )}
              <button
                type="button"
                className="tu-link"
                onClick={() => {
                  onOpenTrophies();
                  leaveRef.current();
                }}
              >
                See all trophies
              </button>
            </div>
            <span className="tu-trace" aria-hidden="true" />
            <span className="tu-glare" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
}

const EDGE = [-0.5, -0.357, -0.214, -0.071, 0.071, 0.214, 0.357, 0.5] as const;

const TIER_COLORS: Readonly<Record<Trophy["tier"], readonly string[]>> = {
  bronze: ["#f6cfa8", "#c98a55", "#ffffff", "#8fa3ff"],
  silver: ["#f7f9fb", "#bcc5cf", "#ffffff", "#8fa3ff"],
  gold: ["#fff2c0", "#f0c75e", "#ffffff", "#8fa3ff"],
  platinum: ["#eef2ff", "#a9b8ff", "#ffffff", "#62e8d8", "#ff8fd0"],
};

/**
 * The charge's particles on a fixed, window-sized canvas: energy drawn in
 * while it charges, arcs across the card, a glow under it, and sparks plus a
 * shockwave on release. One-shot: the loop ends a couple of seconds after the
 * card lands. Returns a function that stops it early.
 */
function runParticles(
  canvas: HTMLCanvasElement,
  wrap: HTMLElement,
  tier: Trophy["tier"],
  tl: ReturnType<typeof trophyTimeline>,
): () => void {
  const g = canvas.getContext("2d");
  if (!g) return () => {};
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  g.scale(dpr, dpr);
  const colors = TIER_COLORS[tier];
  const pick = (): string => colors[Math.floor(Math.random() * colors.length)] ?? "#ffffff";
  const rand = (a: number, b: number): number => a + Math.random() * (b - a);
  const rel = tl.charge + tl.chargeFor;
  const end = rel + tl.spinFor;

  // The card's resting box, in the canvas's layout pixels.
  const box = () => {
    const c = canvas.getBoundingClientRect();
    const r = wrap.getBoundingClientRect();
    const scale = viewportScale(canvas, c);
    return {
      x: (r.left - c.left) / scale,
      y: (r.top - c.top) / scale,
      w: r.width / scale,
      h: r.height / scale,
    };
  };
  let b = box();
  const perim = (): [number, number] => {
    const s = rand(0, 2 * (b.w + b.h));
    if (s < b.w) return [b.x + s, b.y];
    if (s < b.w + b.h) return [b.x + b.w, b.y + s - b.w];
    if (s < 2 * b.w + b.h) return [b.x + (s - b.w - b.h), b.y + b.h];
    return [b.x, b.y + (s - 2 * b.w - b.h)];
  };
  type P = {
    k: "in" | "spark" | "wave";
    x: number;
    y: number;
    vx: number;
    vy: number;
    age: number;
    life: number;
    c: string;
    r: number;
  };
  const parts: P[] = [];
  let burst = false;
  const start = performance.now();
  let last = start;
  let frame = 0;

  const step = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const e = (now - start) / 1000;
    if (e < rel) b = box();
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    g.clearRect(0, 0, w, h);
    const k = Math.max(0, Math.min(1, (e - tl.charge) / tl.chargeFor));
    const glow = e < rel ? k : Math.max(0, 1 - (e - rel) / 1.6);
    if (glow > 0) {
      const R = 160 + glow * 120;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      grd.addColorStop(0, colors[1] ?? "#ffffff");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      g.globalAlpha = 0.4 * glow;
      g.fillStyle = grd;
      g.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    if (e > tl.charge && e < rel) {
      const n = Math.round(1 + k * (3 + tl.level * 2));
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2);
        const d = rand(180, 260);
        parts.push({
          k: "in",
          x: cx + Math.cos(a) * d * 1.3,
          y: cy + Math.sin(a) * d * 0.8,
          vx: 0,
          vy: 0,
          age: 0,
          life: 2,
          c: pick(),
          r: 1.4,
        });
      }
      if (e > tl.charge + 0.2 && Math.random() < 0.15 + k * 0.6) {
        const [ax, ay] = perim();
        const [bx, by] =
          Math.random() < 0.5
            ? [ax + (ax - cx) * rand(0.15, 0.4), ay + (ay - cy) * rand(0.3, 0.8)]
            : perim();
        g.globalAlpha = 1;
        g.strokeStyle = Math.random() < 0.5 ? "#ffffff" : (colors[0] ?? "#ffffff");
        g.lineWidth = rand(0.8, 1.8);
        g.shadowColor = colors[1] ?? "#ffffff";
        g.shadowBlur = 10;
        g.beginPath();
        g.moveTo(ax, ay);
        for (let s = 1; s < 6; s++)
          g.lineTo(ax + ((bx - ax) * s) / 6 + rand(-8, 8), ay + ((by - ay) * s) / 6 + rand(-8, 8));
        g.lineTo(bx, by);
        g.stroke();
        g.shadowBlur = 0;
      }
    }
    if (e >= rel && !burst) {
      burst = true;
      for (let i = 0; i < 80 + tl.level * 35; i++) {
        const [px, py] = perim();
        const a = Math.atan2(py - cy, (px - cx) * 0.6) + rand(-0.3, 0.3);
        const s = rand(120, 480);
        parts.push({
          k: "spark",
          x: px,
          y: py,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          age: 0,
          life: rand(0.4, 1),
          c: pick(),
          r: rand(1, 2.4),
        });
      }
      parts.push({
        k: "wave",
        x: cx,
        y: cy,
        vx: 0,
        vy: 0,
        age: 0,
        life: 0.7,
        c: colors[0] ?? "#ffffff",
        r: 0,
      });
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!p) continue;
      p.age += dt;
      if (p.age > p.life) {
        parts.splice(i, 1);
        continue;
      }
      const lk = p.age / p.life;
      if (p.k === "in") {
        const dx = cx - p.x;
        const dy = cy - p.y;
        const d = Math.hypot(dx, dy);
        if (d < 50 || e > rel) {
          parts.splice(i, 1);
          continue;
        }
        const sp = 120 + p.age * 600;
        const ox = p.x;
        const oy = p.y;
        p.x += (dx / d) * sp * dt;
        p.y += (dy / d) * sp * dt;
        g.globalAlpha = Math.min(1, p.age * 4) * 0.9;
        g.strokeStyle = p.c;
        g.lineWidth = p.r;
        g.beginPath();
        g.moveTo(ox - (dx / d) * 8, oy - (dy / d) * 8);
        g.lineTo(p.x, p.y);
        g.stroke();
      } else if (p.k === "spark") {
        const ox = p.x;
        const oy = p.y;
        p.vx *= 0.97;
        p.vy = p.vy * 0.97 + 260 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        g.globalAlpha = 1 - lk;
        g.strokeStyle = p.c;
        g.lineWidth = p.r;
        g.beginPath();
        g.moveTo(ox, oy);
        g.lineTo(p.x, p.y);
        g.stroke();
      } else {
        g.globalAlpha = 0.7 * (1 - lk);
        g.strokeStyle = p.c;
        g.lineWidth = 3 * (1 - lk) + 0.5;
        g.beginPath();
        g.arc(p.x, p.y, 60 + lk * 380, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (e < end + 2 || parts.length > 0) frame = requestAnimationFrame(step);
    else g.clearRect(0, 0, w, h);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}
