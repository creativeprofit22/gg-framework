// The critter floor: sub-agents walk around on top of the pinned live region
// (tool panel / activity bar) as little pixel critters. This module owns the
// whole imperative side (DOM, per-frame movement, Web Animations effects) so
// React only re-renders when the agent list changes, never per frame.
//
// Lifecycle per agent: summoned in with a beam of light → wanders, hopping on
// each new tool and now and then saying what it is doing → waves and teleports
// out once its work is finished (done, or idle and ready for follow-up), or
// tips over and fades when it fails. A follow-up that sets an idle agent
// running again summons it back. Clicking a critter spooks it (five reactions,
// cycled so repeated clicks differ).

import {
  CRITTER_CELLS,
  pickCritter,
  renderCritterFrame,
  type CritterDef,
  type CritterMove,
} from "./critter-sprites";

export type FloorAgentStatus = "running" | "idle" | "done" | "error" | "interrupted";

/** One sub-agent as the floor sees it. Built from SubAgentLine by the caller. */
export interface FloorAgent {
  /** Stable identity across renders (one critter per key). */
  readonly key: string;
  /** Named agent type (e.g. "researcher"); picks the matching critter. */
  readonly agentName: string | undefined;
  /** What the tooltip calls it. */
  readonly label: string;
  readonly status: FloorAgentStatus;
  /** Latest humanized tool activity, shown in the speech bubble / tooltip. */
  readonly activity: string | undefined;
  /** Preformatted token readout (↑ · ↻ cached · ↓), or null before any usage. */
  readonly tokens: string | null;
  readonly durationMs: number | undefined;
  readonly toolUseCount: number;
}

export interface CritterFloorOptions {
  /** Honour prefers-reduced-motion: no wandering, beams or jumps; fades only. */
  readonly reducedMotion: boolean;
  /** Injected for tests; defaults to Math.random. */
  readonly random?: () => number;
}

export interface CritterFloorController {
  /** Reconcile the floor with the current agent list. Cheap; call on change. */
  sync(agents: readonly FloorAgent[]): void;
  /** Tear everything down (timers, frame loop, observers, DOM). */
  destroy(): void;
}

/** One sprite cell in CSS px. Matches `--critter-px` in App.css. */
const PX = 2;
const SIZE = CRITTER_CELLS * PX;
/** Wait for the lane to mostly open before the first critter lands. */
const LANE_OPEN_MS = 240;
const COLLAPSE_DELAY_MS = 450;
const SPAWN_GAP_MS = 220;
const SUMMON_MS = 900;
/** One critter talks at a time; each waits this long between its own lines. */
const SPEECH_MS = 2200;
const SPEECH_GAP_MS = 4000;

const GREETINGS = ["Hi!", "Reporting in", "On it!", "*pop*", "Ready!"];
const FAREWELLS = ["Bye!", "Later!", "Done \u2713", "Off I go!", "Nailed it", "See ya!"];

/** Walk speed (px/s) and walk-frame interval per movement style. */
const MOVE: Record<CritterMove, { speed: number; frameMs: number }> = {
  walk: { speed: 26, frameMs: 170 },
  hop: { speed: 34, frameMs: 200 },
  hover: { speed: 30, frameMs: 70 },
  float: { speed: 18, frameMs: 260 },
  scuttle: { speed: 38, frameMs: 110 },
  squish: { speed: 16, frameMs: Number.POSITIVE_INFINITY },
};

type Mode = "busy" | "pause" | "walk" | "flee";

interface Critter {
  readonly key: string;
  readonly def: CritterDef;
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly sil: HTMLImageElement;
  readonly shadow: HTMLDivElement;
  readonly startedAt: number;
  agent: FloorAgent;
  x: number;
  y: number;
  dir: 1 | -1;
  target: number;
  mode: Mode;
  timer: number;
  frame: 0 | 1;
  frameT: number;
  phase: number;
  scareIndex: number;
  /** Set once the critter is on its way out; it ignores further updates. */
  leaving: boolean;
  lastSpokeAt: number;
}

interface SpriteSet {
  readonly f0: string;
  readonly f1: string;
  readonly sil: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function formatSeconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

export function createCritterFloor(
  lane: HTMLElement,
  options: CritterFloorOptions,
): CritterFloorController {
  const random = options.random ?? Math.random;
  const reduced = options.reducedMotion;
  const rand = (a: number, b: number): number => a + random() * (b - a);
  const pick = <T>(list: readonly T[], fallback: T): T =>
    list[Math.floor(random() * list.length)] ?? fallback;

  const floor = el("div", "critter-floor");
  const tooltip = el("div", "critter-tooltip");
  tooltip.hidden = true;
  lane.append(floor, tooltip);

  const critters = new Map<string, Critter>();
  const pending = new Map<string, number>();
  const sprites = new Map<string, SpriteSet>();
  const timers = new Set<number>();
  let latest = new Map<string, FloorAgent>();
  let floorWidth = lane.clientWidth;
  let laneReadyAt = 0;
  let nextSpawnAt = 0;
  let collapseTimer = 0;
  let speakingUntil = 0;
  let rafId = 0;
  let lastFrameTs = 0;
  let tooltipKey: string | null = null;
  let destroyed = false;

  const later = (ms: number, fn: () => void): number => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, ms);
    timers.add(id);
    return id;
  };
  const cancelLater = (id: number): void => {
    window.clearTimeout(id);
    timers.delete(id);
  };

  const spritesFor = (def: CritterDef): SpriteSet => {
    const cached = sprites.get(def.id);
    if (cached) return cached;
    const set = {
      f0: renderCritterFrame(def, 0),
      f1: renderCritterFrame(def, 1),
      sil: renderCritterFrame(def, 0, "#ffffff"),
    };
    sprites.set(def.id, set);
    return set;
  };

  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          floorWidth = lane.clientWidth;
          for (const c of critters.values()) {
            c.x = Math.max(4, Math.min(floorWidth - SIZE - 4, c.x));
            c.target = Math.max(4, Math.min(floorWidth - SIZE - 4, c.target));
            place(c);
          }
        });
  resizeObserver?.observe(lane);

  // ── Lane: open while anyone is out (or about to be), collapse after ──
  function openLane(): number {
    if (collapseTimer) {
      cancelLater(collapseTimer);
      collapseTimer = 0;
    }
    if (!lane.classList.contains("open")) {
      lane.classList.add("open");
      laneReadyAt = performance.now() + (reduced ? 0 : LANE_OPEN_MS);
    }
    return Math.max(0, laneReadyAt - performance.now());
  }
  function maybeCollapseLane(): void {
    if (critters.size > 0 || pending.size > 0 || collapseTimer) return;
    collapseTimer = later(COLLAPSE_DELAY_MS, () => {
      collapseTimer = 0;
      if (critters.size === 0 && pending.size === 0) lane.classList.remove("open");
    });
  }

  // ── Frame loop: runs only while critters exist and the window is visible ──
  function startLoop(): void {
    if (rafId || destroyed || critters.size === 0 || document.hidden) return;
    lastFrameTs = performance.now();
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }
  function frame(now: number): void {
    rafId = 0;
    const dt = Math.min(0.05, Math.max(0, (now - lastFrameTs) / 1000));
    lastFrameTs = now;
    for (const c of critters.values()) tick(c, dt);
    if (tooltipKey) positionTooltip();
    startLoop();
  }
  const onVisibility = (): void => {
    if (document.hidden) stopLoop();
    else startLoop();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // ── Small DOM effects ──
  function setBadge(c: Critter, kind: "ok" | "err" | "yikes" | null, text = ""): void {
    c.el.querySelector(".critter-badge")?.remove();
    if (!kind) return;
    const badge = el("div", `critter-badge critter-badge-${kind}`);
    badge.textContent = text;
    c.el.appendChild(badge);
  }
  function clearBubble(c: Critter): void {
    c.el.querySelector(".critter-bubble")?.remove();
  }
  function say(c: Critter, text: string, force = false): void {
    const now = performance.now();
    if (!force && (now < speakingUntil || now - c.lastSpokeAt < SPEECH_GAP_MS)) return;
    if (!force) speakingUntil = now + SPEECH_MS + 400;
    c.lastSpokeAt = now;
    clearBubble(c);
    const bubble = el("div", "critter-bubble");
    const label = el("span", "critter-bubble-text");
    label.textContent = text;
    bubble.appendChild(label);
    c.el.appendChild(bubble);
    later(force ? 1300 : SPEECH_MS, () => bubble.remove());
  }
  function sparkBurst(c: Critter, count: number, outward: boolean): void {
    if (reduced) return;
    const colors = [
      "#ffffff",
      c.def.palette.B ?? "#ffffff",
      c.def.palette.H ?? "#ffffff",
      c.def.palette.A ?? c.def.palette.B ?? "#ffffff",
    ];
    for (let i = 0; i < count; i++) {
      const spark = el("div", "critter-spark");
      spark.style.setProperty("--critter-spark", pick(colors, "#ffffff"));
      c.el.appendChild(spark);
      const angle = outward ? rand(-Math.PI, 0) : rand(-Math.PI * 0.8, -Math.PI * 0.2);
      const dist = outward ? rand(14, 30) : rand(18, 50);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist * (outward ? 0.9 : 1.6);
      const anim = spark.animate(
        [
          { transform: "translate(0, 0) scale(1.4)", opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0 },
        ],
        { duration: rand(420, 700), easing: "cubic-bezier(0.2, 0.8, 0.4, 1)", fill: "forwards" },
      );
      anim.onfinish = () => spark.remove();
    }
  }
  function beam(c: Critter, direction: "in" | "out"): void {
    if (reduced) return;
    const glow = el("div", "critter-beam");
    const core = el("div", "critter-beam-core");
    const ring = el("div", "critter-ring");
    c.el.prepend(glow, core);
    c.el.appendChild(ring);
    // Summon pours DOWN onto the floor; teleport shoots UP off it.
    const origin = direction === "in" ? "50% 0%" : "50% 100%";
    glow.style.transformOrigin = origin;
    core.style.transformOrigin = origin;
    const grow: Keyframe[] = [
      { transform: "scaleY(0)", opacity: 0 },
      { transform: "scaleY(1)", opacity: 1, offset: 0.25 },
      { transform: "scaleY(1)", opacity: 0.9, offset: 0.6 },
      {
        transform: direction === "in" ? "scaleY(0.2) scaleX(2.2)" : "scaleY(1.2) scaleX(0.2)",
        opacity: 0,
      },
    ];
    glow.animate(grow, { duration: 820, easing: "ease-out", fill: "forwards" });
    core.animate(grow, { duration: 700, easing: "ease-out", fill: "forwards" });
    ring.animate(
      [
        { transform: "scale(0.2)", opacity: 0 },
        { transform: "scale(1)", opacity: 1, offset: 0.3 },
        { transform: "scale(2.4)", opacity: 0 },
      ],
      { duration: 760, delay: direction === "in" ? 160 : 0, easing: "ease-out", fill: "both" },
    );
    later(1100, () => {
      glow.remove();
      core.remove();
      ring.remove();
    });
  }
  function sweat(c: Critter): void {
    for (let i = 0; i < 3; i++) {
      const drop = el("div", "critter-sweat");
      drop.style.left = `${c.dir > 0 ? 1 : SIZE - 4}px`;
      c.el.appendChild(drop);
      const anim = drop.animate(
        [
          { transform: "translate(0, 0)", opacity: 1 },
          { transform: `translate(${-c.dir * rand(8, 16)}px, ${rand(-10, -2)}px)`, opacity: 0 },
        ],
        { duration: 450, delay: i * 90, easing: "ease-out", fill: "both" },
      );
      anim.onfinish = () => drop.remove();
    }
  }
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      later(ms, resolve);
    });

  // ── Placement + movement ──
  function place(c: Critter): void {
    c.el.classList.toggle("left", c.def.move !== "scuttle" && c.dir < 0);
    c.el.classList.toggle("frame1", c.frame === 1);
    c.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
    if (c.def.move === "squish") {
      const s = c.mode === "walk" ? Math.sin(c.phase * 9) : 0;
      c.body.style.transform = s === 0 ? "" : `scale(${1 + s * 0.08}, ${1 - s * 0.1})`;
    }
  }
  function stepFrame(c: Critter, dt: number, ms: number): void {
    c.frameT += dt * 1000;
    if (c.frameT > ms) {
      c.frameT = 0;
      c.frame = c.frame === 0 ? 1 : 0;
    }
  }
  function pickTarget(c: Critter): void {
    const reach = random() < 0.25 ? floorWidth * 0.6 : rand(40, 160);
    const raw = c.x + (random() < 0.5 ? -reach : reach);
    c.target = Math.max(8, Math.min(floorWidth - SIZE - 8, raw));
    c.dir = c.target >= c.x ? 1 : -1;
    c.mode = "walk";
  }
  function tick(c: Critter, dt: number): void {
    c.phase += dt;
    const move = MOVE[c.def.move];
    if (c.mode === "walk") {
      c.x += c.dir * move.speed * dt;
      stepFrame(c, dt, move.frameMs);
      if (c.dir > 0 ? c.x >= c.target : c.x <= c.target) {
        c.x = c.target;
        c.mode = "pause";
        c.timer = rand(0.6, 2.6);
        c.frame = 0;
      }
    } else if (c.mode === "flee") {
      c.x = Math.max(4, Math.min(floorWidth - SIZE - 4, c.x + c.dir * move.speed * 5 * dt));
      stepFrame(c, dt, 55);
      c.timer -= dt;
      if (c.timer <= 0) {
        c.mode = "busy"; // the scare reaction hands control back
        c.frame = 0;
      }
    } else if (c.mode === "pause") {
      if (c.def.move === "hover") stepFrame(c, dt, move.frameMs);
      c.timer -= dt;
      if (c.timer <= 0 && !reduced) {
        if (random() < 0.2) c.dir = c.dir > 0 ? -1 : 1; // glance the other way
        pickTarget(c);
      }
    } else if (c.mode === "busy" && c.def.move === "hover") {
      stepFrame(c, dt, move.frameMs); // bees keep buzzing no matter what
    }

    const moving = c.mode === "walk" || c.mode === "flee";
    if (c.def.move === "hover") c.y = reduced ? -8 : -8 + Math.sin(c.phase * 3) * 3;
    else if (c.def.move === "float") c.y = reduced ? -5 : -5 + Math.sin(c.phase * 2) * 2.5;
    else if (c.def.move === "hop" && moving) c.y = -Math.abs(Math.sin(c.phase * 7)) * 5;
    else if (moving && c.frame === 1 && c.def.move !== "squish") c.y = -1;
    else c.y = 0;
    place(c);
  }

  // ── Summon in / teleport out / fall over ──
  function create(agent: FloorAgent): void {
    const taken = new Set([...critters.values()].map((c) => c.def.id));
    const def = pickCritter(agent.agentName, agent.key, taken);
    const set = spritesFor(def);
    const root = el("div", "critter summoning");
    root.style.setProperty("--critter-color", def.palette.B ?? "#ffffff");
    const shadow = el("div", "critter-shadow");
    const body = el("div", "critter-body");
    const flip = el("div", "critter-flip");
    const f0 = el("img", "critter-f0");
    const f1 = el("img", "critter-f1");
    const sil = el("img", "critter-sil");
    for (const [img, src] of [
      [f0, set.f0],
      [f1, set.f1],
      [sil, set.sil],
    ] as const) {
      img.src = src;
      img.alt = "";
      img.draggable = false;
    }
    flip.append(f0, f1, sil);
    body.appendChild(flip);
    root.append(shadow, body);
    floor.appendChild(root);

    const c: Critter = {
      key: agent.key,
      def,
      el: root,
      body,
      sil,
      shadow,
      startedAt: performance.now(),
      agent,
      x: rand(SIZE, Math.max(SIZE + 1, floorWidth - SIZE * 2)),
      y: 0,
      dir: random() < 0.5 ? -1 : 1,
      target: 0,
      mode: "busy",
      timer: 0,
      frame: 0,
      frameT: 0,
      phase: random() * 10,
      scareIndex: Math.floor(random() * SCARES.length),
      leaving: false,
      lastSpokeAt: 0,
    };
    c.target = c.x;
    root.addEventListener("mouseenter", () => showTooltip(c));
    root.addEventListener("mouseleave", () => hideTooltip(c.key));
    root.addEventListener("click", () => void scare(c));
    critters.set(c.key, c);
    place(c);
    summonIn(c);
    startLoop();
  }

  /** Beam + ring, then a white silhouette grows out of the floor and fades
   *  into the critter's colours. */
  function summonIn(c: Critter): void {
    const settle = (): void => {
      c.el.classList.remove("summoning");
      if (c.leaving) return;
      c.mode = "pause";
      c.timer = reduced ? Number.POSITIVE_INFINITY : rand(0.3, 1.2);
      say(c, pick(GREETINGS, "Hi!"), true);
    };
    if (reduced) {
      c.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
      later(300, settle);
      return;
    }
    beam(c, "in");
    c.shadow.animate(
      [
        { opacity: 0, transform: "scaleX(0.2)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 500, delay: 250, fill: "backwards" },
    );
    c.body.animate(
      [
        { transform: "translateY(-14px) scale(0.05, 0.05)", offset: 0 },
        { transform: "translateY(-14px) scale(0.05, 0.05)", offset: 0.22 },
        { transform: "translateY(-4px) scale(0.55, 1.35)", offset: 0.45 },
        { transform: "translateY(0) scale(1.28, 0.72)", offset: 0.62 },
        { transform: "translateY(0) scale(0.92, 1.1)", offset: 0.8 },
        { transform: "none", offset: 1 },
      ],
      { duration: SUMMON_MS, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)", fill: "backwards" },
    );
    c.sil.animate(
      [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: 0.62 },
        { opacity: 0, offset: 1 },
      ],
      { duration: SUMMON_MS + 150, easing: "ease-in" },
    );
    later(SUMMON_MS * 0.55, () => sparkBurst(c, 10, true));
    later(SUMMON_MS + 60, settle);
  }

  function beginLeaving(c: Critter): void {
    c.leaving = true;
    c.mode = "busy";
    c.frame = 0;
    c.el.classList.add("leaving");
    for (const anim of c.body.getAnimations()) anim.cancel();
    clearBubble(c);
    if (tooltipKey === c.key) hideTooltip(c.key);
  }

  /** Wave goodbye, then reverse the summon: light up, stretch thin, zip up the beam. */
  function teleportOut(c: Critter, finished: boolean): void {
    beginLeaving(c);
    if (finished) setBadge(c, "ok", "\u2713");
    say(c, finished ? pick(FAREWELLS, "Bye!") : "Called back", true);
    if (reduced) {
      later(900, () => {
        c.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: "forwards" });
        later(420, () => remove(c));
      });
      return;
    }
    c.body.animate(
      [
        { transform: "none" },
        { transform: "rotate(-12deg)" },
        { transform: "rotate(10deg)" },
        { transform: "rotate(-10deg)" },
        { transform: "rotate(8deg)" },
        { transform: "none" },
      ],
      { duration: 800, easing: "ease-in-out" },
    );
    later(1050, () => {
      clearBubble(c);
      setBadge(c, null);
      beam(c, "out");
      c.sil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, fill: "forwards" });
      c.shadow.animate([{ opacity: 1 }, { opacity: 0, transform: "scaleX(0.2)" }], {
        duration: 500,
        fill: "forwards",
      });
      c.body.animate(
        [
          { transform: "none", offset: 0 },
          { transform: "scale(1.25, 0.72)", offset: 0.3 },
          { transform: "translateY(-6px) scale(0.55, 1.5)", offset: 0.55 },
          { transform: "translateY(-70px) scale(0.08, 2.6)", opacity: 0, offset: 1 },
        ],
        { duration: 620, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" },
      );
      later(320, () => sparkBurst(c, 12, false));
      later(1000, () => remove(c));
    });
  }

  function fallOver(c: Critter): void {
    beginLeaving(c);
    setBadge(c, "err", "\u2717");
    c.el.classList.add("fallen");
    later(reduced ? 300 : 900, () => c.el.classList.add("fading"));
    later(reduced ? 1000 : 1600, () => remove(c));
  }

  function remove(c: Critter): void {
    if (critters.get(c.key) !== c) return;
    for (const anim of c.el.getAnimations({ subtree: true })) anim.cancel();
    c.el.remove();
    critters.delete(c.key);
    if (tooltipKey === c.key) hideTooltip(c.key);
    if (critters.size === 0) stopLoop();
    // A follow-up landed while it was waving goodbye: bring it straight back.
    const current = latest.get(c.key);
    if (current?.status === "running" && !pending.has(c.key)) summon(current);
    maybeCollapseLane();
  }

  // ── Scare reactions: 5 variants, cycled per critter so every click differs ──
  type Scare = (c: Critter) => Promise<void>;
  const SCARES: readonly Scare[] = [
    // 1. Startle jump: big leap and a squashy landing.
    async (c) => {
      setBadge(c, "yikes", "!");
      await c.body.animate(
        [
          { transform: "none" },
          { transform: "scale(1.25, 0.7)", offset: 0.12 },
          { transform: "translateY(-26px) scale(0.85, 1.2)", offset: 0.45 },
          { transform: "translateY(-26px) scale(0.9, 1.1)", offset: 0.55 },
          { transform: "translateY(0) scale(1.3, 0.7)", offset: 0.82 },
          { transform: "none" },
        ],
        { duration: 700, easing: "ease-in-out" },
      ).finished;
    },
    // 2. Bolt: shake, then sprint away with sweat drops flying off.
    async (c) => {
      setBadge(c, "yikes", "!!");
      await c.body.animate(
        [
          { transform: "translateX(0)" },
          { transform: "translateX(-2px)" },
          { transform: "translateX(2px)" },
          { transform: "translateX(-2px)" },
          { transform: "translateX(0)" },
        ],
        { duration: 200 },
      ).finished;
      setBadge(c, null);
      c.dir = c.x > floorWidth / 2 ? -1 : 1;
      c.mode = "flee";
      c.timer = 0.75;
      sweat(c);
      await pause(800);
    },
    // 3. Shiver: flashes pale and trembles in place.
    async (c) => {
      setBadge(c, "yikes", "?!");
      c.sil.animate(
        [{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0 }, { opacity: 0.6 }, { opacity: 0 }],
        {
          duration: 420,
        },
      );
      const frames: Keyframe[] = [];
      for (let i = 0; i <= 14; i++) {
        frames.push({ transform: `translateX(${i % 2 ? 1.5 : -1.5}px) scale(0.96, 0.94)` });
      }
      frames.push({ transform: "none" });
      await c.body.animate(frames, { duration: 750, easing: "linear" }).finished;
    },
    // 4. Backflip: panic-flips into the air and sticks the landing.
    async (c) => {
      setBadge(c, "yikes", "!");
      const spin = c.dir > 0 ? -360 : 360;
      await c.body.animate(
        [
          { transform: "none" },
          { transform: "scale(1.2, 0.75)", offset: 0.12 },
          { transform: `translateY(-24px) rotate(${spin / 2}deg)`, offset: 0.5 },
          { transform: `translateY(0) rotate(${spin}deg) scale(1.2, 0.8)`, offset: 0.85 },
          { transform: `rotate(${spin}deg)` },
        ],
        { duration: 760, easing: "ease-in-out" },
      ).finished;
      sparkBurst(c, 6, true);
    },
    // 5. Duck and cover: flattens into the floor, trembles, peeks back up.
    async (c) => {
      setBadge(c, "yikes", "eep");
      await c.body.animate(
        [
          { transform: "none" },
          { transform: "scale(1.3, 0.35)", offset: 0.12 },
          { transform: "translateX(-1px) scale(1.3, 0.35)", offset: 0.3 },
          { transform: "translateX(1px) scale(1.3, 0.35)", offset: 0.45 },
          { transform: "translateX(-1px) scale(1.3, 0.35)", offset: 0.6 },
          { transform: "scale(1.2, 0.5)", offset: 0.75 },
          { transform: "scale(0.95, 1.08)", offset: 0.9 },
          { transform: "none" },
        ],
        { duration: 1300, easing: "ease-in-out" },
      ).finished;
    },
  ];
  const SCARE_BADGES = ["!", "!!", "?!", "!", "eep"];

  async function scare(c: Critter): Promise<void> {
    if (c.leaving || c.mode === "busy" || c.mode === "flee") return;
    c.mode = "busy";
    c.frame = 0;
    clearBubble(c);
    const index = c.scareIndex % SCARES.length;
    c.scareIndex++;
    try {
      if (reduced) {
        setBadge(c, "yikes", SCARE_BADGES[index] ?? "!");
        await pause(900);
      } else {
        await SCARES[index]?.(c);
      }
    } catch {
      // The animation was cancelled because the critter is leaving.
    }
    if (c.leaving || critters.get(c.key) !== c) return;
    setBadge(c, null);
    c.mode = "pause";
    c.timer = reduced ? Number.POSITIVE_INFINITY : rand(0.4, 1.2);
  }

  /** A quick hop when the agent starts a new tool. */
  function hop(c: Critter): void {
    if (reduced || c.mode === "busy" || c.mode === "flee") return;
    c.body.animate(
      [
        { transform: "none" },
        { transform: "translateY(-5px) scale(0.95, 1.06)", offset: 0.4 },
        { transform: "scale(1.08, 0.92)", offset: 0.8 },
        { transform: "none" },
      ],
      { duration: 280, easing: "ease-out" },
    );
  }

  // ── Tooltip: the stats the old in-chat feed showed ──
  function tooltipStatus(agent: FloorAgent, elapsedMs: number): string {
    const time = formatSeconds(agent.durationMs ?? elapsedMs);
    const tools = `${agent.toolUseCount} ${agent.toolUseCount === 1 ? "tool" : "tools"}`;
    switch (agent.status) {
      case "idle":
        return `idle \u00b7 ready for follow-up \u00b7 ${time}`;
      case "done":
        return `done \u00b7 ${tools} \u00b7 ${time}`;
      case "error":
        return `failed \u00b7 ${time}`;
      case "interrupted":
        return `interrupted \u00b7 ${time}`;
      default:
        return `working \u00b7 ${tools} \u00b7 ${time}`;
    }
  }
  function renderTooltip(c: Critter): void {
    const head = el("div", "critter-tooltip-name");
    const swatch = el("span", "critter-tooltip-swatch");
    swatch.style.background = c.def.palette.B ?? "#ffffff";
    const label = el("span", "");
    label.textContent = c.agent.label;
    head.append(swatch, label);
    const lines: HTMLElement[] = [head];
    const status = el("div", "critter-tooltip-dim");
    status.textContent = `${c.def.name} \u00b7 ${tooltipStatus(c.agent, performance.now() - c.startedAt)}`;
    lines.push(status);
    if (c.agent.tokens) {
      const tokens = el("div", "critter-tooltip-dim");
      tokens.textContent = c.agent.tokens;
      lines.push(tokens);
    }
    if (c.agent.status === "running" && c.agent.activity) {
      const activity = el("div", "critter-tooltip-activity");
      activity.textContent = c.agent.activity;
      lines.push(activity);
    }
    tooltip.replaceChildren(...lines);
  }
  function positionTooltip(): void {
    const c = tooltipKey ? critters.get(tooltipKey) : undefined;
    if (!c) return;
    const width = tooltip.offsetWidth;
    const left = Math.max(4, Math.min(floorWidth - width - 4, c.x + SIZE / 2 - width / 2));
    tooltip.style.transform = `translateX(${left.toFixed(1)}px)`;
  }
  function showTooltip(c: Critter): void {
    if (c.leaving) return;
    tooltipKey = c.key;
    renderTooltip(c);
    tooltip.hidden = false;
    positionTooltip();
  }
  function hideTooltip(key: string): void {
    if (tooltipKey !== key) return;
    tooltipKey = null;
    tooltip.hidden = true;
  }

  // ── Reconcile with the agent list ──
  function summon(agent: FloorAgent): void {
    const now = performance.now();
    const laneWait = openLane();
    const at = Math.max(now + laneWait, nextSpawnAt);
    nextSpawnAt = at + SPAWN_GAP_MS;
    const id = later(at - now, () => {
      pending.delete(agent.key);
      const current = latest.get(agent.key);
      // Finished before it ever landed (a very quick agent): skip it.
      if (current?.status !== "running" || critters.has(agent.key)) {
        maybeCollapseLane();
        return;
      }
      create(current);
    });
    pending.set(agent.key, id);
  }

  function update(c: Critter, agent: FloorAgent): void {
    const previous = c.agent;
    c.agent = agent;
    if (c.leaving) return;
    if (tooltipKey === c.key) renderTooltip(c);
    // "idle" is how a background agent reports its work finished (ready for
    // follow-up), so it leaves exactly like a done one.
    if (agent.status === "done" || agent.status === "idle") return teleportOut(c, true);
    if (agent.status === "interrupted") return teleportOut(c, false);
    if (agent.status === "error") return fallOver(c);
    if (c.el.classList.contains("summoning")) return;
    if (agent.status === "running" && agent.activity && agent.activity !== previous.activity) {
      hop(c);
      say(c, agent.activity);
    }
  }

  function sync(agents: readonly FloorAgent[]): void {
    if (destroyed) return;
    latest = new Map(agents.map((agent) => [agent.key, agent]));
    for (const agent of agents) {
      const live = critters.get(agent.key);
      if (live) {
        update(live, agent);
        continue;
      }
      // Only working agents are summoned: finished ones (including a resumed
      // session's history) stay off the floor until a follow-up wakes them.
      if (!pending.has(agent.key) && agent.status === "running") summon(agent);
    }
    // Agents that vanished from the list (session switch, transcript reload).
    for (const [key, id] of pending) {
      if (!latest.has(key)) {
        cancelLater(id);
        pending.delete(key);
      }
    }
    for (const c of [...critters.values()]) {
      if (!latest.has(c.key)) remove(c);
    }
    maybeCollapseLane();
  }

  function destroy(): void {
    destroyed = true;
    stopLoop();
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    resizeObserver?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    critters.clear();
    pending.clear();
    floor.remove();
    tooltip.remove();
    lane.classList.remove("open");
  }

  return { sync, destroy };
}
