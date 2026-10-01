// The critter floor: sub-agents walk around on top of the pinned live region
// (tool panel / activity bar) as little pixel critters. This module owns the
// whole imperative side (DOM, per-frame movement, Web Animations effects) so
// React only re-renders when the agent list changes, never per frame.
//
// Lifecycle per agent: summoned in with a beam of light → acts out each real
// tool it runs (critter-work), fidgets between tools (critter-idle), notices
// the critters it crosses paths with (critter-social) → waves and teleports
// out once its work is finished (done, or idle and ready for follow-up), or
// tips over and fades when it fails while teammates check on it. A follow-up
// that sets an idle agent running again summons it back. Clicking a critter
// spooks it (critter-scare).
//
// Every behaviour runs as a "script" that owns the critter until it ends or
// something more important (higher PRIO) interrupts it; `ok()` turns false
// the moment the script loses ownership, so it stops at its next check.

import { makeCritterFx, SIZE } from "./critter-fx";
import { makeCritterIdle } from "./critter-idle";
import { makeCritterScare } from "./critter-scare";
import { makeCritterSocial } from "./critter-social";
import { CRITTERS, pickCritter, renderCritterFrame } from "./critter-sprites";
import type { CritterDef, CritterMove } from "./critter-sprites";
import { toolKindOf } from "./critter-tool-kind";
import { PRIO } from "./critter-types";
import type {
  Critter,
  CritterApi,
  EaseName,
  Job,
  JobKind,
  Liveliness,
  Priority,
  Script,
  TraitName,
  Variant,
  VariantOwner,
} from "./critter-types";
import { makeCritterWork } from "./critter-work";

export type FloorAgentStatus = "running" | "idle" | "done" | "error" | "interrupted";

/** One sub-agent as the floor sees it. Built from SubAgentLine by the caller. */
export interface FloorAgent {
  /** Stable identity across renders (one critter per key). */
  readonly key: string;
  /** Named agent type (e.g. "researcher"); picks the matching critter. */
  readonly agentName: string | undefined;
  /** Pin a specific critter (the home screen's roster); wins over agentName. */
  readonly critterId?: string;
  /** What the tooltip calls it. */
  readonly label: string;
  readonly status: FloorAgentStatus;
  /** Latest humanized tool activity: drives the work action, shown in the tooltip. */
  readonly activity: string | undefined;
  /** Preformatted token readout (↑ · ↻ cached · ↓), or null before any usage. */
  readonly tokens: string | null;
  readonly durationMs: number | undefined;
  readonly toolUseCount: number;
}

export interface CritterFloorOptions {
  /** Honour prefers-reduced-motion: no wandering, beams or jumps; fades only. */
  readonly reducedMotion: boolean;
  /**
   * A showcase floor with no real agents behind it (the home screen): critters
   * never stop to "think" between tools, and the hover card shows just the
   * name instead of agent stats.
   */
  readonly ambient?: boolean;
  /** Called each time the lane opens from closed (the chat rolls a new terrain). */
  readonly onLaneOpen?: () => void;
  /**
   * How long after the lane starts opening the first critter lands. Floors
   * with a terrain wait for the ground to rise first. Defaults to the lane's
   * own open time.
   */
  readonly landAfterMs?: number;
  /**
   * How long the lane stays open ("closing") after the last critter leaves.
   * Floors with a terrain need longer, to pack the scenery away in order.
   */
  readonly closeAfterMs?: number;
  /** Injected for tests; defaults to Math.random. */
  readonly random?: () => number;
}

export interface CritterFloorController {
  /** Reconcile the floor with the current agent list. Cheap; call on change. */
  sync(agents: readonly FloorAgent[]): void;
  /** Tear everything down (timers, frame loop, observers, DOM). */
  destroy(): void;
}

/** Wait for the lane to mostly open before the first critter lands. */
const LANE_OPEN_MS = 240;
const COLLAPSE_DELAY_MS = 450;
const SPAWN_GAP_MS = 220;
const SUMMON_MS = 900;
/** Every work action gets at least this long, so rapid tool calls don't jitter. */
const MIN_JOB_MS = 1200;
/** When a different tool arrives, the current action wraps up this soon after. */
const SWITCH_SOON_MS = 350;
/** No new tool for this long while running → the critter stops to think. */
const THINK_AFTER_MS = 6000;
const THINK_GAP_MS = 8000;
const THINK_MS = 4200;

const GREETINGS = [
  "Hi!",
  "Reporting in",
  "On it!",
  "*pop*",
  "Ready!",
  "Where am I?",
  "o/",
  "Let's go",
];
const FAREWELLS = [
  "Bye!",
  "Later!",
  "Done \u2713",
  "Off I go!",
  "Nailed it",
  "o/",
  "See ya!",
  "Peace \u270c",
];

/** Walk speed (px/s) and walk-frame interval per movement style. */
const MOVE: Readonly<Record<CritterMove, { speed: number; frameMs: number }>> = {
  walk: { speed: 26, frameMs: 170 },
  hop: { speed: 34, frameMs: 200 },
  hover: { speed: 30, frameMs: 70 },
  float: { speed: 18, frameMs: 260 },
  scuttle: { speed: 38, frameMs: 110 },
  squish: { speed: 16, frameMs: Number.POSITIVE_INFINITY },
};

/** How often things happen on the floor (the preview's "normal" setting). */
const LIVELY: Liveliness = { fidget: 0.42, seek: 0.12, bump: 0.75, trip: 0.015, gap: 1 };

interface Trait {
  readonly speed: number;
  readonly fidget: number;
  readonly seek: number;
  readonly bump: number;
  readonly trip: number;
}
// A personality per critter, rolled at summon, so two foxes don't act alike.
const TRAITS: Readonly<Record<TraitName, Trait>> = {
  chill: { speed: 0.85, fidget: 0.7, seek: 0.8, bump: 0.8, trip: 1 },
  restless: { speed: 1.2, fidget: 1.5, seek: 1, bump: 1, trip: 1 },
  chatty: { speed: 1, fidget: 1, seek: 2.4, bump: 1.15, trip: 1 },
  shy: { speed: 0.95, fidget: 1, seek: 0.25, bump: 0.45, trip: 1 },
  clumsy: { speed: 1.05, fidget: 1, seek: 1, bump: 1.4, trip: 5 },
};
const TRAIT_NAMES = Object.keys(TRAITS) as readonly TraitName[];

/** Base length of each kind of work action before it is stretched or cut. */
const JOB_MS: Readonly<Record<JobKind, number>> = {
  read: 2600,
  search: 3200,
  edit: 3000,
  run: 3000,
  web: 3400,
  think: THINK_MS,
};

const EASE: Readonly<Record<EaseName, (k: number) => number>> = {
  linear: (k) => k,
  "ease-in": (k) => k * k * k,
  "ease-out": (k) => 1 - (1 - k) ** 3,
  "ease-in-out": (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
};

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
  const ambient = options.ambient === true;
  const rand = (a: number, b: number): number => a + random() * (b - a);
  const now = (): number => performance.now();

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
  const live = (): readonly Critter[] => [...critters.values()];
  const clampX = (x: number): number => Math.max(4, Math.min(floorWidth - SIZE - 4, x));

  const fx = makeCritterFx({ random, later, cancelLater, live });

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
            c.x = clampX(c.x);
            c.target = clampX(c.target);
            if (c.tween) {
              c.tween.from = clampX(c.tween.from);
              c.tween.to = clampX(c.tween.to);
            }
            place(c);
          }
        });
  resizeObserver?.observe(lane);

  // ── Lane: open while anyone is out (or about to be), collapse after ──
  // While the last critter has gone and the collapse is pending the lane is
  // "closing" (still open), so its terrain can sink before the lane shuts.
  function openLane(): number {
    if (collapseTimer) {
      cancelLater(collapseTimer);
      collapseTimer = 0;
    }
    lane.classList.remove("closing");
    if (!lane.classList.contains("open")) {
      lane.classList.add("open");
      laneReadyAt = now() + (reduced ? 0 : (options.landAfterMs ?? LANE_OPEN_MS));
      options.onLaneOpen?.();
    }
    return Math.max(0, laneReadyAt - now());
  }
  function maybeCollapseLane(): void {
    if (critters.size > 0 || pending.size > 0 || collapseTimer) return;
    if (lane.classList.contains("open")) lane.classList.add("closing");
    const delay = reduced ? COLLAPSE_DELAY_MS : (options.closeAfterMs ?? COLLAPSE_DELAY_MS);
    collapseTimer = later(delay, () => {
      collapseTimer = 0;
      lane.classList.remove("closing");
      if (critters.size === 0 && pending.size === 0) lane.classList.remove("open");
    });
  }

  // ── Frame loop: runs only while critters exist and the window is visible ──
  function startLoop(): void {
    if (rafId || destroyed || critters.size === 0 || document.hidden) return;
    lastFrameTs = now();
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }
  function frame(ts: number): void {
    rafId = 0;
    const dt = Math.min(0.05, Math.max(0, (ts - lastFrameTs) / 1000));
    lastFrameTs = ts;
    for (const c of critters.values()) tick(c, ts, dt);
    if (!reduced) social.scan(ts);
    if (tooltipKey) positionTooltip();
    startLoop();
  }
  const onVisibility = (): void => {
    if (document.hidden) stopLoop();
    else startLoop();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // ── Script runner ──
  const canAct = (c: Critter): boolean =>
    !c.leaving && c.el.isConnected && c.agent.status === "running";
  const isFree = (c: Critter): boolean => canAct(c) && c.prio <= PRIO.idle && c.mode !== "summon";

  function cancelBodyAnimations(c: Critter): void {
    for (const a of c.body.getAnimations()) a.cancel();
    for (const a of c.react.getAnimations()) a.cancel();
  }

  function interrupt(c: Critter): void {
    if (c.prio === PRIO.work && c.job && !c.pendingJob) {
      // Spooked or pulled away mid-task: the agent is still running that
      // tool, so pick it back up afterwards.
      const left = c.job.endAt - now();
      if (left > 900) c.pendingJob = makeJob(c.job.kind, left);
    }
    c.job = null;
    c.token++;
    c.prio = PRIO.free;
    c.next = null;
    c.legs = 0;
    if (c.tween) {
      c.tween.resolve();
      c.tween = null;
    }
    cancelBodyAnimations(c);
    fx.clearProps(c);
    c.el.classList.remove("sitting", "phasing", "sooty");
  }

  function begin(c: Critter, prio: Priority): void {
    c.prio = prio;
    c.mode = "script";
    c.frame = 0;
    c.seek = null;
  }

  function release(c: Critter): void {
    const next = c.next;
    c.next = null;
    c.prio = PRIO.free;
    c.legs = 0;
    c.tween = null;
    c.job = null;
    cancelBodyAnimations(c);
    fx.clearProps(c);
    c.el.classList.remove("phasing", "sooty", "sitting");
    if (!canAct(c)) return;
    fx.setBadge(c, null);
    // The agent moved on to another tool while this one was busy.
    const queued = c.pendingJob;
    if (queued) {
      c.pendingJob = null;
      if (startJob(c, queued)) return;
    }
    if (next?.flee) {
      c.mode = "flee";
      c.dir = next.dir ?? c.dir;
      c.timer = next.flee;
      fx.sweat(c);
    } else if (next?.dir) {
      walkOn(c, next.dir);
      if (next.behind) social.passBehind(c);
    } else {
      c.mode = "pause";
      c.timer = reduced ? Number.POSITIVE_INFINITY : rand(0.3, 1.1);
    }
  }

  async function runScript(fn: Script, ok: () => boolean, done: () => void): Promise<boolean> {
    try {
      await fn(ok);
    } catch (err) {
      console.error("critter script failed", err);
    }
    done();
    return true;
  }

  function perform(c: Critter, prio: Priority, fn: Script): Promise<boolean> {
    if (!canAct(c) || c.prio >= prio || c.mode === "summon") return Promise.resolve(false);
    interrupt(c);
    const token = c.token;
    begin(c, prio);
    const ok = (): boolean => c.token === token && canAct(c);
    return runScript(fn, ok, () => {
      if (c.token === token) release(c);
    });
  }

  function performPair(a: Critter, b: Critter, prio: Priority, fn: Script): Promise<boolean> {
    const able = (c: Critter): boolean => canAct(c) && c.prio < prio && c.mode !== "summon";
    if (!able(a) || !able(b)) return Promise.resolve(false);
    interrupt(a);
    interrupt(b);
    const ta = a.token;
    const tb = b.token;
    begin(a, prio);
    begin(b, prio);
    const ok = (): boolean => a.token === ta && b.token === tb && canAct(a) && canAct(b);
    return runScript(fn, ok, () => {
      if (a.token === ta) release(a);
      if (b.token === tb) release(b);
    });
  }

  /** Pick a weighted variant, never one of the last one or two used. */
  function pickVariant<V extends Variant>(
    owner: VariantOwner,
    key: string,
    list: readonly V[],
    weightFn?: (v: V) => number,
    subject?: Critter,
  ): V {
    const who = subject ?? (isCritter(owner) ? owner : undefined);
    const recent = owner.recent.get(key) ?? [];
    const weight = (v: V): number => {
      if (v.only && (!who || !v.only(who))) return 0;
      if (weightFn) return Math.max(0, weightFn(v));
      if (typeof v.w === "function") return who ? Math.max(0, v.w(who)) : 1;
      return Math.max(0, v.w ?? 1);
    };
    let pool = list.filter((v) => weight(v) > 0);
    const avoid = pool.length > 3 ? 2 : pool.length > 1 ? 1 : 0;
    const skip = avoid ? recent.slice(-avoid) : [];
    const fresh = pool.filter((v) => !skip.includes(v.id));
    if (fresh.length) pool = fresh;
    const fallback = pool[pool.length - 1] ?? list[0];
    if (!fallback) throw new Error(`pickVariant(${key}) from an empty list`);
    let chosen = fallback;
    let r = random() * pool.reduce((s, v) => s + weight(v), 0);
    for (const v of pool) {
      r -= weight(v);
      if (r <= 0) {
        chosen = v;
        break;
      }
    }
    owner.recent.set(key, [...recent, chosen.id].slice(-3));
    return chosen;
  }
  const isCritter = (o: VariantOwner): o is Critter => "agent" in o && "def" in o;

  // ── Movement primitives the scripts use ──
  function face(c: Critter, dir: 1 | -1): void {
    c.dir = dir;
  }
  function tween(
    c: Critter,
    to: number,
    ms: number,
    ease: EaseName,
    walking: boolean,
  ): Promise<void> {
    if (c.tween) c.tween.resolve();
    return new Promise((resolve) => {
      c.tween = {
        from: c.x,
        to: clampX(to),
        t0: now(),
        ms: Math.max(1, ms),
        ease: EASE[ease],
        walking,
        token: c.token,
        resolve,
      };
    });
  }
  const tweenX = (c: Critter, x: number, ms: number, ease: EaseName = "ease-out"): Promise<void> =>
    tween(c, x, ms, ease, false);
  /** Walk (with legs moving) to x at the critter's speed × mul. */
  function goTo(c: Critter, x: number, mul = 1): Promise<void> {
    const to = clampX(x);
    const dist = Math.abs(to - c.x);
    if (dist < 1) return Promise.resolve();
    face(c, to >= c.x ? 1 : -1);
    const ms = (dist / (speedOf(c) * mul)) * 1000;
    return tween(c, to, ms, "linear", true);
  }
  /** A small knock that doesn't interrupt whatever the critter is doing. */
  function jolt(c: Critter, n = 1, dir = -c.dir): void {
    if (reduced) return;
    c.react.animate(
      [
        { transform: "none" },
        { transform: `translateX(${dir * 3 * n}px) rotate(${dir * 6 * n}deg)` },
        { transform: "none" },
      ],
      { duration: 260, easing: "ease-out" },
    );
  }
  const speedOf = (c: Critter): number =>
    MOVE[c.def.move].speed * TRAITS[c.trait].speed * (c.hyped ? 1.25 : 1);
  function lively(c: Critter): Liveliness {
    const t = TRAITS[c.trait];
    return {
      fidget: LIVELY.fidget * t.fidget,
      seek: LIVELY.seek * t.seek,
      bump: Math.min(1, LIVELY.bump * t.bump),
      trip: LIVELY.trip * t.trip,
      gap: LIVELY.gap,
    };
  }

  const api: CritterApi = {
    fx,
    live,
    lively,
    pickVariant,
    perform,
    performPair,
    canAct,
    isFree,
    face,
    clampX,
    goTo,
    tweenX,
    jolt,
    floorWidth: () => floorWidth,
    now,
  };
  const work = makeCritterWork(api);
  const idle = makeCritterIdle(api);
  const social = makeCritterSocial(api);
  const scares = makeCritterScare(api);

  // ── Work: real tool activity → acted-out work ──
  function makeJob(kind: JobKind, ms: number): Job {
    const t = now();
    return {
      kind,
      startedAt: t,
      endAt: t + ms,
      minEndAt: t + Math.min(ms, MIN_JOB_MS),
      winding: false,
    };
  }
  function jobLength(kind: JobKind): number {
    return JOB_MS[kind] * rand(0.8, 1.3);
  }
  /** Start acting out a job now. Returns false if the critter couldn't take it. */
  function startJob(c: Critter, job: Job): boolean {
    if (!canAct(c) || c.prio >= PRIO.work || c.mode === "summon") return false;
    // The job's clock starts when the critter actually starts on it.
    const ms = job.endAt - job.startedAt;
    const fresh = makeJob(job.kind, ms);
    void perform(c, PRIO.work, async (ok) => {
      c.job = fresh;
      c.saidLong = false;
      await work.run(c, fresh, ok);
    });
    return true;
  }

  /** A running agent started a new tool. */
  function onActivity(c: Critter, activity: string): void {
    c.lastActivityAt = now();
    const kind = toolKindOf(activity);
    if (!kind || reduced) return;
    const current = c.prio === PRIO.work ? c.job : null;
    if (current && !current.winding) {
      if (current.kind === kind) {
        // More of the same: keep going a little longer.
        current.endAt = Math.max(current.endAt, now() + jobLength(kind) * 0.7);
        return;
      }
      // A different tool: wrap this one up soon, then start the new one.
      current.endAt = Math.max(current.minEndAt, Math.min(current.endAt, now() + SWITCH_SOON_MS));
      c.pendingJob = makeJob(kind, jobLength(kind));
      return;
    }
    const job = makeJob(kind, jobLength(kind));
    if (c.prio > PRIO.work || c.mode === "summon" || current) {
      // Busy with something more important (or finishing an outro): queue it.
      c.pendingJob = job;
      return;
    }
    startJob(c, job);
  }

  /** Long quiet stretch between tools: stop and think for a bit. */
  function maybeThink(c: Critter, t: number): boolean {
    if (ambient) return false;
    if (c.pendingJob || t - c.lastActivityAt < THINK_AFTER_MS || t - c.lastThinkAt < THINK_GAP_MS) {
      return false;
    }
    c.lastThinkAt = t;
    return startJob(c, makeJob("think", THINK_MS * rand(0.8, 1.2)));
  }

  // ── Placement + movement ──
  function place(c: Critter): void {
    c.el.classList.toggle("left", c.def.move !== "scuttle" && c.dir < 0);
    c.el.classList.toggle("frame1", c.frame === 1);
    c.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
    if (c.def.move === "squish" && c.mode !== "script") {
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
  function walkOn(c: Critter, dir: 1 | -1): void {
    face(c, dir);
    c.target = clampX(c.x + dir * rand(40, 140));
    c.mode = "walk";
  }
  function pickTarget(c: Critter): void {
    const reach = random() < 0.25 ? floorWidth * 0.6 : rand(40, 160);
    const raw = c.x + (random() < 0.5 ? -reach : reach);
    c.target = clampX(raw);
    c.dir = c.target >= c.x ? 1 : -1;
    c.mode = "walk";
  }
  /** What a free critter does when its pause runs out. */
  function decide(c: Critter, t: number): void {
    if (maybeThink(c, t)) return;
    const L = lively(c);
    if (random() < L.seek && social.seek(c)) return;
    if (random() < L.fidget) {
      idle.fidget(c);
      if (c.prio !== PRIO.free) return;
    }
    if (random() < 0.2) c.dir = c.dir > 0 ? -1 : 1; // glance the other way
    pickTarget(c);
  }

  function tick(c: Critter, t: number, dt: number): void {
    c.phase += dt;
    if (c.hyped && t > c.hypedUntil) c.hyped = false;
    const move = MOVE[c.def.move];
    let moving = false;

    const tw = c.tween;
    if (tw) {
      if (tw.token !== c.token) {
        c.tween = null;
        tw.resolve();
      } else {
        const k = Math.min(1, (t - tw.t0) / tw.ms);
        c.x = tw.from + (tw.to - tw.from) * tw.ease(k);
        if (tw.walking) {
          moving = true;
          stepFrame(c, dt, move.frameMs);
        }
        if (k >= 1) {
          c.tween = null;
          tw.resolve();
        }
      }
    } else if (c.mode === "walk") {
      moving = true;
      c.x += c.dir * speedOf(c) * dt;
      stepFrame(c, dt, move.frameMs);
      const canTrip = social.grounded(c) && c.def.move !== "squish";
      if (canTrip && random() < lively(c).trip * dt) {
        idle.trip(c);
      } else if (c.dir > 0 ? c.x >= c.target : c.x <= c.target) {
        c.x = c.target;
        c.frame = 0;
        if (c.seek && social.arrived(c)) {
          // the visit script owns it now
        } else {
          c.mode = "pause";
          c.timer = rand(0.6, 2.6) * LIVELY.gap;
        }
      }
    } else if (c.mode === "flee") {
      moving = true;
      c.x = clampX(c.x + c.dir * speedOf(c) * 5 * dt);
      stepFrame(c, dt, 55);
      c.timer -= dt;
      if (c.timer <= 0) {
        c.mode = "pause";
        c.timer = rand(0.4, 1.2);
        c.frame = 0;
      }
    } else if (c.mode === "pause") {
      if (c.def.move === "hover") stepFrame(c, dt, move.frameMs);
      c.timer -= dt;
      if (c.timer <= 0 && !reduced && isFree(c)) decide(c, t);
    } else if (c.legs > 0) {
      moving = true; // running in place (hamster wheel, tag…)
      stepFrame(c, dt, c.legs);
    } else if (c.def.move === "hover") {
      stepFrame(c, dt, move.frameMs); // bees keep buzzing no matter what
    }

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
    const pinned = CRITTERS.find((critter) => critter.id === agent.critterId);
    const def = pinned ?? pickCritter(agent.agentName, agent.key, taken);
    const set = spritesFor(def);
    const root = el("div", "critter summoning");
    root.style.setProperty("--critter-color", def.palette.B ?? "#ffffff");
    const shadow = el("div", "critter-shadow");
    const react = el("div", "critter-react");
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
    react.appendChild(body);
    root.append(shadow, react);
    floor.appendChild(root);

    const t = now();
    const c: Critter = {
      key: agent.key,
      def,
      el: root,
      react,
      body,
      sil,
      shadow,
      startedAt: t,
      trait: TRAIT_NAMES[Math.floor(random() * TRAIT_NAMES.length)] ?? "chill",
      recent: new Map(),
      agent,
      x: rand(SIZE, Math.max(SIZE + 1, floorWidth - SIZE * 2)),
      y: 0,
      dir: random() < 0.5 ? -1 : 1,
      target: 0,
      mode: "summon",
      timer: 0,
      frame: 0,
      frameT: 0,
      phase: random() * 10,
      prio: PRIO.free,
      token: 0,
      hyped: false,
      hypedUntil: 0,
      job: null,
      pendingJob: null,
      lastKind: null,
      lastActivityAt: t,
      lastThinkAt: t,
      saidLong: false,
      lastAct: agent.activity ?? "",
      legs: 0,
      next: null,
      seek: null,
      tween: null,
      leaving: false,
      scareIndex: Math.floor(random() * 5),
    };
    c.target = c.x;
    root.addEventListener("mouseenter", () => showTooltip(c));
    root.addEventListener("mouseleave", () => hideTooltip(c.key));
    root.addEventListener("click", () => onClick(c));
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
      fx.say(c, fx.pick(GREETINGS), 1300, true);
      // It may already be mid-tool by the time it lands.
      if (c.agent.activity) onActivity(c, c.agent.activity);
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
    later(SUMMON_MS * 0.55, () => fx.sparks(c, 10, true));
    later(SUMMON_MS + 60, settle);
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

  /** Stop everything the critter was doing; it ignores the floor from now on. */
  function beginLeaving(c: Critter): void {
    interrupt(c);
    c.pendingJob = null;
    c.leaving = true;
    c.prio = PRIO.gone;
    c.mode = "script";
    c.frame = 0;
    c.el.classList.add("leaving");
    c.el.classList.remove("behind");
    fx.clearBubble(c);
    fx.setBadge(c, null);
    if (tooltipKey === c.key) hideTooltip(c.key);
  }

  // Four ways to say goodbye before beaming out.
  const FAREWELL_MOVES: readonly ((c: Critter) => Animation)[] = [
    (c) =>
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
      ),
    (c) =>
      c.body.animate(
        [
          { transform: "none" },
          { transform: `rotate(${c.dir * 22}deg) translateY(1px)`, offset: 0.35 },
          { transform: `rotate(${c.dir * 22}deg) translateY(1px)`, offset: 0.65 },
          { transform: "none" },
        ],
        { duration: 800, easing: "ease-in-out" },
      ),
    (c) =>
      c.body.animate(
        [
          { transform: "scaleX(1)" },
          { transform: "scaleX(0.05)", offset: 0.25 },
          { transform: "scaleX(-1)", offset: 0.5 },
          { transform: "scaleX(0.05)", offset: 0.75 },
          { transform: "scaleX(1)" },
        ],
        { duration: 700, easing: "linear" },
      ),
    (c) => {
      fx.confetti(c, 8);
      return c.body.animate(
        [
          { transform: "none" },
          { transform: "translateY(-12px) scale(0.92, 1.1)", offset: 0.35 },
          { transform: "scale(1.15, 0.85)", offset: 0.7 },
          { transform: "none" },
        ],
        { duration: 700, easing: "ease-out" },
      );
    },
  ];

  /** Say goodbye, then reverse the summon: light up, stretch thin, zip up the beam. */
  function teleportOut(c: Critter, finished: boolean): void {
    beginLeaving(c);
    if (finished) {
      fx.setBadge(c, "ok", "\u2713");
      if (!reduced) social.cheer(c);
    }
    fx.say(c, finished ? fx.pick(FAREWELLS) : "Called back", 1300, true);
    if (reduced) {
      later(900, () => {
        c.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: "forwards" });
        later(420, () => remove(c));
      });
      return;
    }
    fx.pick(FAREWELL_MOVES)(c);
    later(1050, () => {
      fx.clearBubble(c);
      fx.setBadge(c, null);
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
      later(320, () => fx.sparks(c, 12, false));
      later(1000, () => remove(c));
    });
  }

  /** Tips over (dropping whatever it held); nearby teammates come to check. */
  function fallOver(c: Critter): void {
    const held = c.react.querySelector(".critter-prop") !== null;
    if (held && !reduced) fx.dropProps(c);
    beginLeaving(c);
    fx.setBadge(c, "err", "\u2717");
    // Tipping over swings the sprite sideways; keep it clear of the walls.
    c.x = Math.min(Math.max(c.x, SIZE * 0.8), floorWidth - SIZE * 1.2);
    place(c);
    c.el.classList.add("fallen");
    if (reduced) {
      later(300, () => c.el.classList.add("fading"));
      later(1000, () => remove(c));
      return;
    }
    fx.say(c, fx.pick(["x_x", "ow\u2026", "I tried\u2026", "oops"]), 1300, true);
    const helpers = social.checkOn(c);
    const stay = helpers > 0 ? 3600 : 900;
    later(stay, () => c.el.classList.add("fading"));
    later(stay + 700, () => remove(c));
  }

  function remove(c: Critter): void {
    if (critters.get(c.key) !== c) return;
    c.token++;
    c.tween?.resolve();
    c.tween = null;
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

  // ── Click to spook ──
  const SCARE_BADGES = ["!", "!!", "?!", "!", "eep"];
  function onClick(c: Critter): void {
    if (c.leaving || c.mode === "summon") return;
    if (reduced) {
      fx.setBadge(c, "yikes", SCARE_BADGES[c.scareIndex % SCARE_BADGES.length] ?? "!");
      c.scareIndex++;
      later(900, () => {
        if (!c.leaving) fx.setBadge(c, null);
      });
      return;
    }
    scares.scare(c);
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
    if (ambient) {
      tooltip.replaceChildren(...lines);
      return;
    }
    const status = el("div", "critter-tooltip-dim");
    status.textContent = `${c.def.name} \u00b7 ${tooltipStatus(c.agent, now() - c.startedAt)}`;
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
    const t = now();
    const laneWait = openLane();
    const at = Math.max(t + laneWait, nextSpawnAt);
    nextSpawnAt = at + SPAWN_GAP_MS;
    const id = later(at - t, () => {
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
    if (agent.status !== "running" || !agent.activity) return;
    if (agent.activity === previous.activity && agent.toolUseCount === previous.toolUseCount) {
      return;
    }
    c.lastAct = agent.activity;
    // Still landing: settle() picks up the latest activity once it touches down.
    if (c.mode === "summon") return;
    onActivity(c, agent.activity);
  }

  function sync(agents: readonly FloorAgent[]): void {
    if (destroyed) return;
    latest = new Map(agents.map((agent) => [agent.key, agent]));
    for (const agent of agents) {
      const existing = critters.get(agent.key);
      if (existing) {
        update(existing, agent);
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
    for (const c of critters.values()) {
      c.token++;
      c.tween?.resolve();
      c.tween = null;
    }
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    resizeObserver?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    critters.clear();
    pending.clear();
    floor.remove();
    tooltip.remove();
    lane.classList.remove("open", "closing");
  }

  return { sync, destroy };
}
