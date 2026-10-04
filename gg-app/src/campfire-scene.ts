// The home screen's backdrop: a clearing in the pines around a campfire just
// out of view at the bottom of the window, lit by the local clock (see
// scene-light.ts for the five looks). Painted smooth at device resolution,
// so the pixel-art critters are the only pixel art on screen.
//
// Parts that only change with the light or the window size (sky, sun, moon,
// ridge, treelines) are painted into offscreen canvases; each frame stamps
// those and draws the small moving details: embers, smoke, mist, stars,
// fireflies, pollen in the sunbeams, birds, bats, and an owl's eyes.

import { seeded } from "./critter-terrain";
import {
  clamp01,
  lightAt,
  mixRgb,
  moonAt,
  SKY_STOPS,
  skyAt,
  sunAt,
  type Rgb,
  type SceneLight,
} from "./scene-light";

const TAU = Math.PI * 2;
/** Device pixels per CSS pixel, capped: the scene is soft, 2× is plenty. */
const MAX_DPR = 2;
const EMBER_HOT: Rgb = [255, 210, 122];
const EMBER_COOL: Rgb = [255, 90, 42];
const FIREFLY: Rgb = [214, 255, 122];
const STAR: Rgb = [232, 234, 250];
const MOON: Rgb = [230, 228, 238];
const OWL_EYE: Rgb = [255, 196, 90];
const POLLEN: Rgb = [255, 244, 214];
const SILHOUETTE: Rgb = [14, 10, 18];
/**
 * Half the width of the home content (the logo is ~470px wide, the buttons
 * ~420px) plus a margin: the sun's disc never comes closer to the middle.
 */
export const CONTENT_HALF_WIDTH = 260;

// ── Layout (seeded, so the same window always gets the same clearing) ──

interface Star {
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly twinkle: number;
  readonly phase: number;
  readonly big: boolean;
}

interface Pine {
  readonly x: number;
  /** Where the trunk meets the ground. */
  readonly base: number;
  readonly tall: number;
  /** 0 a step back from the clearing's edge … 1 right at the front. */
  readonly near: number;
}

interface Drifter {
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly phase: number;
  readonly size: number;
}

interface Ember {
  readonly x0: number;
  readonly life: number;
  readonly offset: number;
  readonly rise: number;
  readonly sway: number;
  readonly swaySpeed: number;
  readonly phase: number;
  readonly size: number;
}

export interface CampfireLayout {
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** The distant ridge's foot: the sky's gradient ends here. */
  readonly horizon: number;
  /** The ridge's top edge, sampled every RIDGE_STEP px from the left. */
  readonly ridge: readonly number[];
  readonly farTrees: readonly { readonly x: number; readonly tall: number }[];
  /** The pines around the clearing, back to front. */
  readonly pines: readonly Pine[];
  /** Where the owl's eyes shine, on the tallest pine at the left. */
  readonly owl: { readonly x: number; readonly y: number };
  readonly stars: readonly Star[];
  readonly embers: readonly Ember[];
  readonly fireflies: readonly Drifter[];
  readonly pollen: readonly Drifter[];
}

const RIDGE_STEP = 4;

/** The ridge's top at `x`, read off the sampled heights. */
export function ridgeAt(layout: CampfireLayout, x: number): number {
  const i = Math.max(0, Math.min(layout.ridge.length - 1, Math.round(x / RIDGE_STEP)));
  return layout.ridge[i] ?? layout.horizon;
}

export function layoutCampfire(width: number, height: number): CampfireLayout {
  const random = seeded(4271);
  const horizon = Math.round(height * 0.82);
  const phase = random() * TAU;

  const ridge = Array.from({ length: Math.ceil(width / RIDGE_STEP) + 2 }, (_, i) => {
    const x = i * RIDGE_STEP;
    const roll =
      0.55 * Math.sin(x * 0.0043 + phase) +
      0.3 * Math.sin(x * 0.011 + phase * 2) +
      0.15 * Math.sin(x * 0.029 + phase * 3);
    return horizon - height * (0.045 + 0.035 * roll);
  });

  const farTrees: { x: number; tall: number }[] = [];
  for (let x = random() * 6; x < width; x += 4 + random() * 9) {
    farTrees.push({ x, tall: 7 + random() ** 1.5 * 20 });
  }

  const pines: Pine[] = [];
  for (const side of [0, 1] as const) {
    for (let i = 0; i < 11; i++) {
      const p = random();
      const reach = width * (0.06 + 0.22 * p);
      const near = 1 - p;
      pines.push({
        x: side === 0 ? reach * random() : width - reach * random(),
        base: height * (0.995 - near * 0.03),
        tall: height * (0.22 + near * 0.42 + random() * 0.1),
        near,
      });
    }
  }
  // A tall one at the left for the owl to watch from.
  const perch: Pine = { x: width * 0.075, base: height, tall: height * 0.74, near: 1 };
  pines.push(perch);
  pines.sort((a, b) => a.near - b.near);

  const starCount = Math.min(520, Math.round((width * horizon) / 1700));
  const stars = Array.from({ length: starCount }, () => {
    const roll = random();
    return {
      x: random() * width,
      y: random() ** 1.4 * horizon * 0.85,
      level: 0.25 + random() * 0.75,
      twinkle: roll < 0.35 ? 0.6 + random() * 1.4 : 0,
      phase: random() * TAU,
      big: roll > 0.965,
    };
  });

  const embers = Array.from({ length: 170 }, () => ({
    x0: width * (0.5 + (random() - 0.5) * 0.42),
    life: 5 + random() * 7,
    offset: random() * 12,
    rise: 0.55 + random() * 0.5,
    sway: 10 + random() * 30,
    swaySpeed: 0.5 + random() * 1.2,
    phase: random() * TAU,
    size: 1.3 + random() * 1.9,
  }));

  const fireflies = Array.from({ length: 28 }, () => ({
    x: random() * width,
    y: height * (0.6 + random() * 0.34),
    speed: 0.15 + random() * 0.3,
    phase: random() * TAU,
    size: 1.4 + random() * 1.2,
  }));

  const pollen = Array.from({ length: 70 }, () => ({
    x: random() * width,
    y: random() * height * 0.9,
    speed: 2 + random() * 5,
    phase: random() * TAU,
    size: 0.9 + random() * 1.3,
  }));

  return {
    width,
    height,
    horizon,
    ridge,
    farTrees,
    pines,
    owl: { x: perch.x, y: perch.base - perch.tall * 0.62 },
    stars,
    embers,
    fireflies,
    pollen,
  };
}

// ── Painting helpers ──

function css(c: Rgb, alpha = 1): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
}

function pine(
  ctx: CanvasRenderingContext2D,
  x: number,
  base: number,
  tall: number,
  trunk = false,
): void {
  const tiers = 5;
  ctx.beginPath();
  for (let i = 0; i < tiers; i++) {
    const y = base - (tall * i) / tiers;
    const half = (tall / 3.2) * (1 - i / (tiers + 1));
    ctx.moveTo(x - half, y);
    ctx.lineTo(x, y - tall / tiers - tall * 0.12);
    ctx.lineTo(x + half, y);
  }
  ctx.fill();
  if (trunk) ctx.fillRect(x - tall * 0.012, base - tall * 0.05, tall * 0.024, tall * 0.05 + 40);
}

/**
 * Where the sun's disc sits on screen. It climbs at the left in the morning
 * and sinks at the right in the evening, and only crosses over while it's
 * above the top of the window, so it never passes behind the logo or buttons.
 */
export function sunDisc(
  layout: CampfireLayout,
  hour: number,
): { readonly x: number; readonly y: number; readonly r: number; readonly elevation: number } {
  const { width, height, horizon } = layout;
  const sun = sunAt(hour);
  const r = height * 0.04;
  // sunAt walks x from 0.3 (sunrise) to 0.75 (sunset); its midpoint is midday.
  const rising = sun.x < 0.525;
  const along = rising ? (sun.x - 0.3) / 0.225 : (0.75 - sun.x) / 0.225;
  const fromEdge = Math.min(
    width * (0.1 + 0.12 * clamp01(along)),
    width / 2 - CONTENT_HALF_WIDTH - r,
  );
  const inset = Math.max(r + 8, fromEdge);
  return {
    x: rising ? inset : width - inset,
    y: horizon - sun.elevation * horizon * 1.15,
    r,
    elevation: sun.elevation,
  };
}

/** Sky, sun and moon: everything behind the ridge. */
function paintSky(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  light: SceneLight,
  hour: number,
): void {
  const { width, height, horizon } = layout;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  for (const [stop] of SKY_STOPS) sky.addColorStop(stop, css(skyAt(light, stop)));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // The sun: low and huge-glowing at either end of the day, out of frame at
  // midday (its light comes down as the beams instead).
  const sun = sunDisc(layout, hour);
  if (sun.elevation > -0.4) {
    const sx = sun.x;
    const sy = sun.y;
    const low = clamp01(1 - sun.elevation * 2.5);
    const reach = height * (0.35 + 0.4 * low);
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, reach);
    glow.addColorStop(0, css(light.glow, 0.55 * clamp01(sun.elevation + 0.4)));
    glow.addColorStop(0.25, css(light.glow, 0.18 * clamp01(sun.elevation + 0.4)));
    glow.addColorStop(1, css(light.glow, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    if (sun.elevation > -0.05) {
      ctx.fillStyle = css(light.sun);
      ctx.beginPath();
      ctx.arc(sx, sy, sun.r, 0, TAU);
      ctx.fill();
    }
  }

  // The moon, a crescent high in the dark part of the sky.
  const moon = moonAt(hour);
  if (moon.elevation > 0 && light.stars > 0.15) {
    const r = height * 0.022;
    const mx = width * moon.x;
    const my = height * (0.07 + 0.2 * (1 - moon.elevation));
    const alpha = clamp01((light.stars - 0.15) * 1.6);
    const halo = ctx.createRadialGradient(mx, my, r, mx, my, r * 7);
    halo.addColorStop(0, css(MOON, 0.16 * alpha));
    halo.addColorStop(1, css(MOON, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(mx - r * 7, my - r * 7, r * 14, r * 14);
    const sprite = document.createElement("canvas");
    const size = Math.ceil(r * 2 + 4);
    sprite.width = size;
    sprite.height = size;
    const s = sprite.getContext("2d");
    if (s) {
      s.fillStyle = css(MOON);
      s.beginPath();
      s.arc(size / 2, size / 2, r, 0, TAU);
      s.fill();
      s.globalCompositeOperation = "destination-out";
      s.beginPath();
      s.arc(size / 2 + r * 0.55, size / 2 - r * 0.2, r * 0.95, 0, TAU);
      s.fill();
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, mx - size / 2, my - size / 2);
      ctx.globalAlpha = 1;
    }
  }
}

/** The far ridge and its fringe of tiny pines. */
function paintFar(ctx: CanvasRenderingContext2D, layout: CampfireLayout, light: SceneLight): void {
  const { width, height, horizon } = layout;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = css(light.ridge);
  ctx.beginPath();
  ctx.moveTo(0, height);
  layout.ridge.forEach((y, i) => ctx.lineTo(i * RIDGE_STEP, y));
  ctx.lineTo(width + RIDGE_STEP, height);
  ctx.fill();
  // The ridge fades into the haze at its foot.
  const haze = ctx.createLinearGradient(0, horizon - height * 0.08, 0, horizon + height * 0.04);
  haze.addColorStop(0, css(light.mist, 0));
  haze.addColorStop(1, css(light.mist, 0.25 + 0.35 * light.mistLevel));
  ctx.fillStyle = haze;
  ctx.fillRect(0, horizon - height * 0.08, width, height);
  ctx.fillStyle = css(light.treeFar);
  for (const t of layout.farTrees) pine(ctx, t.x, ridgeAt(layout, t.x) + t.tall * 0.35, t.tall);
  const ground = horizon + height * 0.02;
  ctx.fillRect(0, ground, width, height - ground);
  for (const t of layout.farTrees) pine(ctx, t.x + 3, ground + 2, t.tall * 1.25);
}

/** The pines around the clearing, back ones fading into the haze. */
function paintNear(ctx: CanvasRenderingContext2D, layout: CampfireLayout, light: SceneLight): void {
  ctx.clearRect(0, 0, layout.width, layout.height);
  for (const p of layout.pines) {
    ctx.fillStyle = css(mixRgb(light.treeFar, light.treeNear, 0.35 + 0.65 * p.near));
    pine(ctx, p.x, p.base, p.tall, true);
  }
}

// ── The moving details ──

function drawStars(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  level: number,
  t: number,
): void {
  if (level <= 0.01) return;
  for (const s of layout.stars) {
    const tw = s.twinkle > 0 ? 0.55 + 0.45 * Math.sin(t * s.twinkle + s.phase) : 1;
    ctx.fillStyle = css(STAR, s.level * tw * level);
    const size = s.big ? 1.8 : 1.1;
    ctx.fillRect(s.x, s.y, size, size);
  }
}

/** Soft shafts of light slanting down through the trees from the sun's side. */
function drawBeams(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  light: SceneLight,
  hour: number,
  t: number,
): void {
  if (light.beams <= 0.01) return;
  const { width, height } = layout;
  const sun = sunAt(hour);
  const fromRight = sun.x > 0.5;
  const ox = width * (fromRight ? 1.05 : -0.05);
  const oy = -height * 0.15;
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 6; i++) {
    const spread = 0.18 + i * 0.12;
    const pulse = 0.55 + 0.45 * Math.sin(t * 0.13 + i * 1.7);
    const ex = fromRight ? ox - width * spread * 1.4 : ox + width * spread * 1.4;
    const half = width * (0.018 + 0.012 * ((i * 7) % 3));
    const g = ctx.createLinearGradient(ox, oy, ex, height);
    g.addColorStop(0, css(light.glow, 0));
    g.addColorStop(0.35, css(light.glow, 0.07 * light.beams * pulse));
    g.addColorStop(1, css(light.glow, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex - half, height);
    ctx.lineTo(ex + half, height);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** A small flock crossing high up every so often, wings beating. */
function drawBirds(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  level: number,
  t: number,
): void {
  if (level <= 0.05) return;
  const period = 38;
  const cross = 22;
  const into = t % period;
  if (into > cross) return;
  const { width, height } = layout;
  const lead = -40 + (into / cross) * (width + 120);
  ctx.strokeStyle = css(SILHOUETTE, 0.75 * level);
  ctx.lineWidth = 1.3;
  for (let i = 0; i < 5; i++) {
    const x = lead - i * 18 - (i % 2) * 6;
    const y = height * 0.17 + i * 7 * (i % 2 ? 1 : -0.6) + Math.sin(t * 0.6 + i) * 3;
    const flap = Math.sin(t * 9 + i * 1.3) * 3;
    ctx.beginPath();
    ctx.moveTo(x - 5, y - flap);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 5, y - flap);
    ctx.stroke();
  }
}

/** Bats darting around the clearing's edge in the blue hour. */
function drawBats(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  level: number,
  t: number,
): void {
  if (level <= 0.05) return;
  const { width, height } = layout;
  ctx.fillStyle = css(SILHOUETTE, 0.85 * level);
  for (let i = 0; i < 3; i++) {
    const loop = (t * (0.045 + i * 0.012) + i * 0.37) % 1;
    const x = width * (-0.05 + loop * 1.1) + Math.sin(t * 2.3 + i * 4) * 26;
    const y =
      height * (0.16 + i * 0.07) + Math.sin(t * 3.1 + i) * 14 + Math.sin(t * 7.7 + i * 2) * 5;
    const flap = Math.abs(Math.sin(t * 16 + i * 2));
    const span = 7;
    ctx.beginPath();
    ctx.moveTo(x - span, y - 2 + flap * 4);
    ctx.quadraticCurveTo(x - span / 2, y - 3 * flap, x, y);
    ctx.quadraticCurveTo(x + span / 2, y - 3 * flap, x + span, y - 2 + flap * 4);
    ctx.quadraticCurveTo(x, y + 2, x - span, y - 2 + flap * 4);
    ctx.fill();
  }
}

/** Low banks of mist drifting through the far trees. */
function drawMist(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  light: SceneLight,
  t: number,
): void {
  if (light.mistLevel <= 0.02) return;
  const { width, height, horizon } = layout;
  for (let i = 0; i < 5; i++) {
    const w = width * (0.35 + (i % 3) * 0.12);
    const x = (((i * 0.27 + t * (0.004 + i * 0.0015)) % 1.4) - 0.2) * width;
    const y = horizon + height * (0.01 + (i % 3) * 0.035);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(w / 100, (height * 0.05) / 100);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 100);
    g.addColorStop(0, css(light.mist, 0.34 * light.mistLevel));
    g.addColorStop(1, css(light.mist, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-100, -100, 200, 200);
    ctx.restore();
  }
}

/** How the fire breathes: a slow swell with a quick flicker on top. */
export function flicker(t: number): number {
  return 0.85 + 0.1 * Math.sin(t * 7.3) * Math.sin(t * 3.1) + 0.05 * Math.sin(t * 13.7);
}

/** The firelight from below, swelling and flickering. */
function drawFireGlow(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  fire: number,
  t: number,
): void {
  if (fire <= 0.01) return;
  const { width, height } = layout;
  const f = flicker(t) * fire;
  const g = ctx.createRadialGradient(
    width * 0.5,
    height * 1.08,
    0,
    width * 0.5,
    height * 1.08,
    height * 0.95,
  );
  g.addColorStop(0, `rgba(255,140,60,${0.42 * f})`);
  g.addColorStop(0.35, `rgba(200,70,40,${0.17 * f})`);
  g.addColorStop(1, "rgba(120,30,30,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}

/** The smoke column curling up from the fire and thinning out. */
function drawSmoke(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  light: SceneLight,
  t: number,
): void {
  if (light.smokeLevel <= 0.02) return;
  const { width, height } = layout;
  const puffs = 28;
  for (let i = 0; i < puffs; i++) {
    const age = (t * 0.035 + i / puffs) % 1;
    const y = height * (1.02 - age * 0.78);
    const x = width * 0.5 + Math.sin(age * 4 + t * 0.25 + i) * age * 40 + age * age * width * 0.09;
    const r = 10 + age * height * 0.09;
    const alpha = light.smokeLevel * 0.17 * Math.min(1, age * 6) * (1 - age) ** 1.8;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, css(light.smoke, alpha));
    g.addColorStop(1, css(light.smoke, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

/** Sparks rising from the fire, cooling from gold to red as they climb. */
function drawEmbers(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  fire: number,
  t: number,
): void {
  if (fire <= 0.01) return;
  const { height } = layout;
  const shown = Math.round(layout.embers.length * fire);
  // A low fire throws fewer sparks, and they don't climb as high.
  const lift = 0.35 + 0.65 * fire;
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < shown; i++) {
    const e = layout.embers[i];
    if (!e) continue;
    const age = ((t + e.offset) % e.life) / e.life;
    const y = height * (1.02 - age * e.rise * 1.1 * lift);
    const x =
      e.x0 +
      Math.sin(t * e.swaySpeed + e.phase) * e.sway * age +
      age * age * 60 * Math.sin(e.phase);
    const fade = Math.min(1, age * 8) * (1 - age) ** 1.4;
    const twinkle = 0.7 + 0.3 * Math.sin(t * 9 + e.phase * 5);
    const col = mixRgb(EMBER_HOT, EMBER_COOL, age);
    ctx.fillStyle = css(col, fade * twinkle);
    ctx.fillRect(x, y, e.size, e.size);
    ctx.fillStyle = css(col, fade * twinkle * 0.18);
    ctx.beginPath();
    ctx.arc(x + e.size / 2, y + e.size / 2, e.size * 2.2, 0, TAU);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Two amber eyes in the pines, blinking now and then, glancing about. */
function drawOwl(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  level: number,
  t: number,
): void {
  if (level <= 0.05) return;
  const blink = t % 7 < 0.18 || (t % 23 > 11 && t % 23 < 11.15);
  if (blink) return;
  const glance = Math.sin(t * 0.21) > 0.6 ? 1.5 : Math.sin(t * 0.21) < -0.6 ? -1.5 : 0;
  const { x, y } = layout.owl;
  for (const dx of [-3.2, 3.2]) {
    const ex = x + dx + glance;
    const g = ctx.createRadialGradient(ex, y, 0, ex, y, 6);
    g.addColorStop(0, css(OWL_EYE, 0.35 * level));
    g.addColorStop(1, css(OWL_EYE, 0));
    ctx.fillStyle = g;
    ctx.fillRect(ex - 6, y - 6, 12, 12);
    ctx.fillStyle = css(OWL_EYE, 0.95 * level);
    ctx.beginPath();
    ctx.arc(ex, y, 1.6, 0, TAU);
    ctx.fill();
  }
}

function drawFireflies(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  level: number,
  t: number,
): void {
  if (level <= 0.02) return;
  ctx.globalCompositeOperation = "lighter";
  for (const f of layout.fireflies) {
    const on = Math.max(0, Math.sin(t * (0.6 + f.speed) + f.phase)) ** 6;
    if (on < 0.02) continue;
    const x = f.x + Math.sin(t * f.speed + f.phase) * 40 + Math.sin(t * f.speed * 2.3) * 12;
    const y = f.y + Math.cos(t * f.speed * 1.3 + f.phase) * 18;
    const a = on * level;
    const g = ctx.createRadialGradient(x, y, 0, x, y, f.size * 5);
    g.addColorStop(0, css(FIREFLY, 0.45 * a));
    g.addColorStop(1, css(FIREFLY, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - f.size * 5, y - f.size * 5, f.size * 10, f.size * 10);
    ctx.fillStyle = css(FIREFLY, a);
    ctx.fillRect(x - f.size / 2, y - f.size / 2, f.size, f.size);
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Motes of pollen drifting down through the sunlight. */
function drawPollen(
  ctx: CanvasRenderingContext2D,
  layout: CampfireLayout,
  level: number,
  t: number,
): void {
  if (level <= 0.02) return;
  const { width, height } = layout;
  for (const p of layout.pollen) {
    const y = (p.y + t * p.speed) % (height * 0.9);
    const x = (p.x + Math.sin(t * 0.3 + p.phase) * 20 + t * p.speed * 0.4) % width;
    const glint = 0.45 + 0.55 * Math.sin(t * 1.7 + p.phase) ** 2;
    ctx.fillStyle = css(POLLEN, 0.5 * glint * level);
    ctx.fillRect(x, y, p.size, p.size);
  }
}

// ── The renderer ──

export interface CampfireRenderer {
  /** Fits the scene to the window (CSS pixels) and repaints. */
  resize(cssWidth: number, cssHeight: number): void;
  /** Moves the light to a local hour (0–24) and repaints. Nothing paints until it's set. */
  setHour(hour: number): void;
  /** Draws a frame at a time in seconds. */
  frame(seconds: number): void;
}

/** A layer canvas sized to the scene, drawing in CSS pixels. */
function layer(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx } : null;
}

export function createCampfireRenderer(
  canvas: HTMLCanvasElement,
  devicePixelRatio: number,
): CampfireRenderer | null {
  const ctx = canvas.getContext("2d", { alpha: false });
  const sky = layer();
  const far = layer();
  const near = layer();
  if (!ctx || !sky || !far || !near) return null;
  const dpr = Math.max(1, Math.min(MAX_DPR, devicePixelRatio || 1));

  let layout: CampfireLayout | null = null;
  let hour: number | null = null;
  let light = lightAt(0);
  let last = 0;

  function repaint(): void {
    if (!layout || hour === null || !sky || !far || !near) return;
    for (const l of [sky, far, near]) l.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintSky(sky.ctx, layout, light, hour);
    paintFar(far.ctx, layout, light);
    paintNear(near.ctx, layout, light);
    renderer.frame(last);
  }

  const renderer: CampfireRenderer = {
    resize(cssWidth, cssHeight) {
      const width = Math.max(1, Math.round(cssWidth));
      const height = Math.max(1, Math.round(cssHeight));
      if (layout && layout.width === width && layout.height === height) return;
      for (const c of [canvas, sky.canvas, far.canvas, near.canvas]) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      layout = layoutCampfire(width, height);
      repaint();
    },
    setHour(next) {
      hour = next;
      light = lightAt(next);
      repaint();
    },
    frame(seconds) {
      last = seconds;
      if (!layout || hour === null) return;
      const t = seconds;
      const { width, height } = layout;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(sky.canvas, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStars(ctx, layout, light.stars, t);
      drawBeams(ctx, layout, light, hour, t);
      drawBirds(ctx, layout, light.birds, t);
      drawBats(ctx, layout, light.bats, t);
      ctx.drawImage(far.canvas, 0, 0, width, height);
      drawMist(ctx, layout, light, t);
      drawFireGlow(ctx, layout, light.fire, t);
      drawSmoke(ctx, layout, light, t);
      ctx.drawImage(near.canvas, 0, 0, width, height);
      drawEmbers(ctx, layout, light.fire, t);
      drawOwl(ctx, layout, light.owl, t);
      drawFireflies(ctx, layout, light.fireflies, t);
      drawPollen(ctx, layout, light.pollen, t);
    },
  };
  return renderer;
}
