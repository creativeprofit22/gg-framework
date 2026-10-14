// Sounds for the Goal farm: one for every poke reaction, timed to its
// animation (the hammer's four taps land on its swings, the creel fish slaps
// down where it lands, the well's "hello" echoes back fainter). All of it is
// synthesized with Web Audio, so there are no audio files: soft, rounded
// sounds through a gentle low-pass, a small room and a limiter, varied a
// little by each reaction's seed as its particles are. Things in use (a
// critter hammering at the bench) sound too, quieter and only now and then.
// Muted along with every other UI sound (see sounds.ts). The page that
// auditions them all is mockups/goal-farm-sounds/index.html.

import type { Reaction, ThingKind } from "./goal-farm-interact";
import { isSoundEnabled } from "./sounds";

/** Overall level of the farm's sounds; things in use play at USE_LEVEL of it. */
const MASTER_LEVEL = 0.45;
const USE_LEVEL = 0.45;

/**
 * A thing in use sounds at most this often (ms): a critter hammering for
 * minutes is an occasional tap-tap, not a loop. Its animation plays on.
 */
export const USE_SOUND_GAP_MS = 8000;

/**
 * Things whose use never sounds: Ken's tea steams whenever nothing's
 * happening (see usesNeedPace), and an idle farm stays quiet.
 */
const SILENT_USES: ReadonlySet<ThingKind> = new Set<ThingKind>(["teabench"]);

/** Which sound a reaction plays: kind and action, and a pond splash flicked off the stones. */
export function soundKey(r: Pick<Reaction, "kind" | "action" | "from">): string {
  const key = `${r.kind}:${r.action}`;
  return r.kind === "pond" && r.action === "splash" && r.from ? `${key}~flick` : key;
}

/** Should a thing in use sound now, given when it last did (ms, or undefined if never)? */
export function inUseSoundDue(kind: ThingKind, last: number | undefined, now: number): boolean {
  if (SILENT_USES.has(kind)) return false;
  return last === undefined || now - last >= USE_SOUND_GAP_MS;
}

/** Is there a sound for this key? */
export function hasFarmSound(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SOUNDS, key);
}

export interface FarmSounds {
  /** Sound a reaction as it starts (a poke, or a use: quieter, and spaced out). */
  play(reaction: Reaction): void;
  /** Stop everything and release the audio context. */
  dispose(): void;
}

/**
 * The farm's sound engine. The audio context is made on the first poke (a
 * click, so the webview lets it start); uses only sound once it's running,
 * so nothing queues up silently and bursts out later.
 */
export function createFarmSounds(): FarmSounds {
  let context: AudioContext | null = null;
  let graph: Graph | null = null;
  let closed = false;
  const lastUse = new Map<string, number>();
  const timers = new Set<number>();

  const open = (): Graph | null => {
    if (graph || closed) return graph;
    const Ctor = typeof window === "undefined" ? undefined : window.AudioContext;
    if (!Ctor) return null;
    try {
      const ac = new Ctor();
      context = ac;
      graph = buildGraph(ac, MASTER_LEVEL);
    } catch {
      return null;
    }
    return graph;
  };

  return {
    play(reaction) {
      if (closed || !isSoundEnabled()) return;
      const sound = SOUNDS[soundKey(reaction)];
      if (!sound) return;
      const use = reaction.use === true;
      if (use) {
        if (!graph || context?.state !== "running") return;
        if (!inUseSoundDue(reaction.kind, lastUse.get(reaction.target), reaction.start)) return;
        lastUse.set(reaction.target, reaction.start);
      }
      const g = use ? graph : open();
      if (!g) return;
      const { ac } = g;
      if (context?.state === "suspended") void context.resume().catch(() => {});
      try {
        const dry = ac.createGain();
        const wet = ac.createGain();
        const level = use ? USE_LEVEL : 1;
        dry.gain.value = level;
        wet.gain.value = level;
        dry.connect(g.bus);
        wet.connect(g.verbIn);
        sound(
          { ac, dry, wet, noise: g.noise, r: mulberry32(reaction.seed * 9973 + 1) },
          ac.currentTime + 0.02,
        );
        // Let go of the voice once it (and its echo) has rung out.
        const id = window.setTimeout(
          () => {
            timers.delete(id);
            dry.disconnect();
            wet.disconnect();
          },
          reaction.until - reaction.start + 3000,
        );
        timers.add(id);
      } catch {
        // Audio unavailable: play stays silent.
      }
    },
    dispose() {
      closed = true;
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      const ac = context;
      context = null;
      graph = null;
      if (ac) void ac.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

type NoiseColor = "white" | "pink" | "brown";
type Pan = number | readonly [number, number];
/** An envelope: [seconds from the start, level 0–1] points, ramped linearly from 0. */
type Env = readonly (readonly [number, number])[];
/** Glide points: [seconds from the start, Hz]. */
type Glide = readonly (readonly [number, number])[];

interface Graph {
  readonly ac: BaseAudioContext;
  readonly bus: GainNode;
  readonly verbIn: GainNode;
  readonly noise: Readonly<Record<NoiseColor, AudioBuffer>>;
}

/** One sound playing: where it goes (dry and to the room), and its own random numbers. */
interface Voice {
  readonly ac: BaseAudioContext;
  readonly dry: AudioNode;
  readonly wet: AudioNode;
  readonly noise: Readonly<Record<NoiseColor, AudioBuffer>>;
  readonly r: () => number;
}

type Sound = (v: Voice, t: number) => void;

function buildGraph(ac: BaseAudioContext, volume: number): Graph {
  const master = ac.createGain();
  master.gain.value = volume;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 14;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  const tame = ac.createBiquadFilter();
  tame.type = "lowpass";
  tame.frequency.value = 7500;
  tame.Q.value = 0.5;
  const bus = ac.createGain();
  bus.connect(tame);
  tame.connect(comp);
  comp.connect(master);
  master.connect(ac.destination);
  // The room: a darkened, decaying noise impulse.
  const len = Math.floor(ac.sampleRate * 1.6);
  const impulse = ac.createBuffer(2, len, ac.sampleRate);
  const r = mulberry32(7);
  for (let c = 0; c < 2; c++) {
    const d = impulse.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  const conv = ac.createConvolver();
  conv.buffer = impulse;
  const verbIn = ac.createGain();
  const dark = ac.createBiquadFilter();
  dark.type = "lowpass";
  dark.frequency.value = 3800;
  const verbOut = ac.createGain();
  verbOut.gain.value = 0.55;
  verbIn.connect(conv);
  conv.connect(dark);
  dark.connect(verbOut);
  verbOut.connect(tame);
  return { ac, bus, verbIn, noise: makeNoise(ac) };
}

function makeNoise(ac: BaseAudioContext): Record<NoiseColor, AudioBuffer> {
  const len = ac.sampleRate * 2;
  const r = mulberry32(11);
  const white = ac.createBuffer(1, len, ac.sampleRate);
  const pink = ac.createBuffer(1, len, ac.sampleRate);
  const brown = ac.createBuffer(1, len, ac.sampleRate);
  const w = white.getChannelData(0);
  const p = pink.getChannelData(0);
  const br = brown.getChannelData(0);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0,
    last = 0;
  for (let i = 0; i < len; i++) {
    const x = r() * 2 - 1;
    w[i] = x * 0.6;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.09;
    b6 = x * 0.115926;
    last = (last + 0.02 * x) / 1.02;
    br[i] = last * 3.2;
  }
  return { white, pink, brown };
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = (v: Voice, a: number, b: number): number => a + v.r() * (b - a);
const pick = <T>(v: Voice, xs: readonly [T, ...T[]]): T =>
  xs[Math.floor(v.r() * xs.length)] ?? xs[0];
const note = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
/** The yo scale (D E G A B): the farm's chimes stay in one calm, open mode. */
const YO: readonly [number, ...number[]] = [74, 76, 79, 81, 83, 86, 88, 91];

const perc = (a: number, d: number): Env => [
  [a, 1],
  [a + d * 0.12, 0.5],
  [a + d * 0.35, 0.2],
  [a + d * 0.7, 0.05],
  [a + d, 0],
];
const swell = (a: number, hold: number, rel: number): Env => [
  [a, 1],
  [a + hold, 1],
  [a + hold + rel * 0.4, 0.35],
  [a + hold + rel, 0],
];
const envEnd = (env: Env): number => env[env.length - 1]?.[0] ?? 0;

function applyEnv(param: AudioParam, t: number, env: Env, peak: number): void {
  param.setValueAtTime(0, t);
  for (const [dt, level] of env) param.linearRampToValueAtTime(level * peak, t + dt);
}

interface OutOpts {
  readonly env: Env;
  readonly peak: number;
  readonly pan?: Pan;
  readonly wet?: number;
}

/** The last stage of every source: its envelope, a pan, and dry plus a send to the room. */
function out(v: Voice, input: AudioNode, t: number, o: OutOpts): void {
  const g = v.ac.createGain();
  applyEnv(g.gain, t, o.env, o.peak);
  input.connect(g);
  let last: AudioNode = g;
  if (o.pan !== undefined && o.pan !== 0) {
    const p = v.ac.createStereoPanner();
    const [a, b] = typeof o.pan === "number" ? [o.pan, o.pan] : o.pan;
    p.pan.setValueAtTime(a, t);
    p.pan.linearRampToValueAtTime(b, t + envEnd(o.env));
    g.connect(p);
    last = p;
  }
  last.connect(v.dry);
  const wet = o.wet ?? 0.15;
  if (wet > 0) {
    const w = v.ac.createGain();
    w.gain.value = wet;
    last.connect(w);
    w.connect(v.wet);
  }
}

interface SweepOpts {
  readonly fpts?: Glide;
  readonly f2?: number;
  readonly glide?: number;
  readonly dur?: number;
}

function filter(
  v: Voice,
  type: BiquadFilterType,
  f: number,
  q: number,
  t: number,
  o: SweepOpts = {},
): BiquadFilterNode {
  const fl = v.ac.createBiquadFilter();
  fl.type = type;
  fl.Q.value = q;
  fl.frequency.setValueAtTime(f, t);
  if (o.fpts) for (const [dt, fr] of o.fpts) fl.frequency.linearRampToValueAtTime(fr, t + dt);
  else if (o.f2 !== undefined)
    fl.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide ?? o.dur ?? 0.1));
  return fl;
}

function lfo(
  v: Voice,
  t: number,
  dur: number,
  rate: number,
  rate2: number | undefined,
  depth: number,
  type: OscillatorType,
  target: AudioParam,
): void {
  const l = v.ac.createOscillator();
  l.type = type;
  l.frequency.setValueAtTime(rate, t);
  if (rate2) l.frequency.linearRampToValueAtTime(rate2, t + dur);
  const lg = v.ac.createGain();
  lg.gain.value = depth;
  l.connect(lg);
  lg.connect(target);
  l.start(t);
  l.stop(t + dur + 0.1);
}

interface AmOpts {
  readonly am?: number;
  readonly am2?: number;
  readonly amDepth?: number;
  readonly amType?: OscillatorType;
}

/** Tremolo: an LFO on the level, from 1 − depth up to 1. */
function tremolo(v: Voice, node: AudioNode, t: number, dur: number, o: AmOpts): AudioNode {
  if (!o.am) return node;
  const depth = o.amDepth ?? 0.8;
  const g = v.ac.createGain();
  g.gain.value = 1 - depth / 2;
  lfo(v, t, dur, o.am, o.am2, depth / 2, o.amType ?? "sine", g.gain);
  node.connect(g);
  return g;
}

interface NoiseOpts extends SweepOpts, AmOpts {
  readonly dur: number;
  readonly color?: NoiseColor;
  readonly ft?: BiquadFilterType;
  readonly f?: number;
  readonly q?: number;
  readonly lp?: number;
  readonly env?: Env;
  readonly peak?: number;
  readonly pan?: Pan;
  readonly wet?: number;
}

/** A filtered noise burst. */
function noise(v: Voice, t: number, o: NoiseOpts): void {
  const s = v.ac.createBufferSource();
  s.buffer = v.noise[o.color ?? "white"];
  s.loop = true;
  s.start(t, rnd(v, 0, 1.5));
  s.stop(t + o.dur + 0.1);
  let node: AudioNode = filter(v, o.ft ?? "bandpass", o.f ?? 1000, o.q ?? 1, t, o);
  s.connect(node);
  if (o.lp) {
    const l = filter(v, "lowpass", o.lp, 0.7, t);
    node.connect(l);
    node = l;
  }
  node = tremolo(v, node, t, o.dur, o);
  out(v, node, t, {
    env: o.env ?? perc(0.004, o.dur - 0.004),
    peak: o.peak ?? 0.1,
    pan: o.pan,
    wet: o.wet,
  });
}

interface ToneOpts extends AmOpts {
  readonly f: number;
  readonly dur: number;
  readonly type?: OscillatorType;
  readonly f2?: number;
  readonly glide?: number;
  readonly pts?: Glide;
  readonly vib?: number;
  readonly vibDepth?: number;
  readonly lp?: number;
  readonly q?: number;
  readonly a?: number;
  readonly env?: Env;
  readonly peak?: number;
  readonly pan?: Pan;
  readonly wet?: number;
}

/** An oscillator with an optional glide, vibrato and filter. */
function tone(v: Voice, t: number, o: ToneOpts): void {
  const osc = v.ac.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.f, t);
  if (o.pts) for (const [dt, fr] of o.pts) osc.frequency.linearRampToValueAtTime(fr, t + dt);
  else if (o.f2 !== undefined)
    osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide ?? o.dur));
  if (o.vib) lfo(v, t, o.dur, o.vib, 0, o.vibDepth ?? 6, "sine", osc.frequency);
  let node: AudioNode = osc;
  if (o.lp) {
    const l = filter(v, "lowpass", o.lp, o.q ?? 0.7, t);
    node.connect(l);
    node = l;
  }
  node = tremolo(v, node, t, o.dur, o);
  const a = o.a ?? 0.004;
  out(v, node, t, {
    env: o.env ?? perc(a, o.dur - a),
    peak: o.peak ?? 0.1,
    pan: o.pan,
    wet: o.wet,
  });
  osc.start(t);
  osc.stop(t + o.dur + 0.1);
}

interface VoiceOpts {
  readonly dur: number;
  readonly peak: number;
  /** Pitch: [seconds, Hz], the first at 0. */
  readonly pts: Glide;
  /** Two formants: [seconds, F1 Hz, F2 Hz], the first at 0. */
  readonly formants: readonly (readonly [number, number, number])[];
  readonly type?: OscillatorType;
  readonly lp?: number;
  readonly vib?: number;
  readonly vibDepth?: number;
  readonly env?: Env;
  readonly pan?: Pan;
  readonly wet?: number;
}

/** A voiced sound shaped by two formants: clucks, barks, yawns, "hello". */
function voiced(v: Voice, t: number, o: VoiceOpts): void {
  const osc = v.ac.createOscillator();
  osc.type = o.type ?? "sawtooth";
  osc.frequency.setValueAtTime(o.pts[0]?.[1] ?? 300, t);
  for (const [dt, fr] of o.pts.slice(1)) osc.frequency.linearRampToValueAtTime(fr, t + dt);
  if (o.vib) lfo(v, t, o.dur, o.vib, 0, o.vibDepth ?? 6, "sine", osc.frequency);
  const [, F1 = 700, F2 = 1200] = o.formants[0] ?? [];
  const f1 = filter(v, "bandpass", F1, 5, t);
  const f2 = filter(v, "bandpass", F2, 7, t);
  for (const [dt, a, b] of o.formants.slice(1)) {
    f1.frequency.linearRampToValueAtTime(a, t + dt);
    f2.frequency.linearRampToValueAtTime(b, t + dt);
  }
  const body = filter(v, "lowpass", 700, 0.7, t);
  const g1 = v.ac.createGain();
  g1.gain.value = 2.6;
  const g2 = v.ac.createGain();
  g2.gain.value = 1.6;
  const gb = v.ac.createGain();
  gb.gain.value = 0.25;
  const sum = v.ac.createGain();
  osc.connect(f1);
  f1.connect(g1);
  g1.connect(sum);
  osc.connect(f2);
  f2.connect(g2);
  g2.connect(sum);
  osc.connect(body);
  body.connect(gb);
  gb.connect(sum);
  const l = filter(v, "lowpass", o.lp ?? 2400, 0.6, t);
  sum.connect(l);
  out(v, l, t, {
    env: o.env ?? [
      [0.012, 1],
      [o.dur * 0.7, 0.85],
      [o.dur, 0],
    ],
    peak: o.peak,
    pan: o.pan,
    wet: o.wet ?? 0.12,
  });
  osc.start(t);
  osc.stop(t + o.dur + 0.1);
}

// ---- Building blocks -------------------------------------------------------

interface GrainOpts {
  readonly f: number;
  readonly peak: number;
  readonly dur?: number;
  readonly q?: number;
  readonly pan?: Pan;
  readonly wet?: number;
}

function grain(v: Voice, t: number, o: GrainOpts): void {
  const dur = o.dur ?? 0.03;
  noise(v, t, {
    dur,
    f: o.f,
    q: o.q ?? 1.5,
    peak: o.peak * 2.5,
    pan: o.pan,
    wet: o.wet ?? 0.1,
    env: perc(0.002, dur - 0.002),
  });
}

interface GrainsOpts {
  readonly n: number;
  readonly span: number;
  readonly f: readonly [number, number];
  readonly peak: number;
  readonly dur?: number;
  readonly q?: number;
  readonly bias?: number;
  readonly fade?: boolean;
  readonly pan?: number;
  readonly wet?: number;
}

function grains(v: Voice, t: number, o: GrainsOpts): void {
  for (let i = 0; i < o.n; i++) {
    const x = v.r() ** (o.bias ?? 1);
    const amp = o.fade ? 1 - x * 0.75 : 1;
    grain(v, t + x * o.span, {
      f: rnd(v, o.f[0], o.f[1]),
      dur: o.dur ?? rnd(v, 0.015, 0.04),
      q: o.q,
      peak: o.peak * amp * rnd(v, 0.5, 1),
      pan: o.pan ?? rnd(v, -0.3, 0.3),
      wet: o.wet,
    });
  }
}

function mallet(v: Voice, t: number, f: number, peak: number, dur = 0.6, pan = 0): void {
  tone(v, t, { f, dur, peak, a: 0.003, pan, wet: 0.25 });
  tone(v, t, { f: f * 4, dur: 0.07, peak: peak * 0.22, a: 0.002, pan, wet: 0.2 });
}

function bell(v: Voice, t: number, f: number, peak: number, dur = 1.2, wet = 0.4, pan = 0): void {
  tone(v, t, { f, dur, peak, a: 0.004, pan, wet });
  tone(v, t, { f: f * 1.004, dur: dur * 0.8, peak: peak * 0.4, a: 0.004, pan, wet });
  tone(v, t, { f: f * 2.76, dur: dur * 0.4, peak: peak * 0.22, a: 0.003, pan, wet });
  tone(v, t, { f: f * 5.4, dur: dur * 0.18, peak: peak * 0.07, a: 0.002, pan, wet });
}

function sparkle(
  v: Voice,
  t: number,
  o: {
    readonly n: number;
    readonly span: number;
    readonly peak: number;
    readonly notes?: readonly [number, ...number[]];
    readonly rising?: boolean;
  },
): void {
  const notes = o.notes ?? YO;
  for (let i = 0; i < o.n; i++) {
    const m = o.rising ? (notes[Math.min(notes.length - 1, i)] ?? notes[0]) : pick(v, notes);
    const at = o.rising ? (i / Math.max(1, o.n - 1)) * o.span : rnd(v, 0, o.span);
    bell(v, t + at, note(m), o.peak * rnd(v, 0.7, 1), 0.9, 0.5, rnd(v, -0.35, 0.35));
  }
}

/** A wood knock: a quick pitched tock with a click on top. */
function knock(v: Voice, t: number, f: number, peak: number, pan = 0): void {
  tone(v, t, { f: f * 1.5, f2: f, glide: 0.015, dur: 0.12, peak, a: 0.001, pan, wet: 0.12 });
  tone(v, t, { f: f * 2.7, dur: 0.05, peak: peak * 0.25, a: 0.001, pan, wet: 0.1 });
  noise(v, t, {
    dur: 0.035,
    f: f * 3,
    q: 2.5,
    peak: peak * 0.6,
    env: perc(0.001, 0.034),
    pan,
    wet: 0.1,
  });
}

function thud(v: Voice, t: number, f: number, peak: number, pan = 0): void {
  tone(v, t, { f: f * 1.8, f2: f, glide: 0.04, dur: 0.2, peak, a: 0.002, pan, wet: 0.08 });
  noise(v, t, {
    dur: 0.1,
    color: "brown",
    ft: "lowpass",
    f: 420,
    peak: peak * 0.6,
    env: perc(0.003, 0.097),
    pan,
    wet: 0.05,
  });
}

/** A water droplet: a quick rising sine. */
function drip(v: Voice, t: number, f: number, peak: number, wet = 0.25, pan = 0): void {
  tone(v, t, { f, f2: f * 2, glide: 0.035, dur: 0.09, peak, a: 0.002, pan, wet });
}

function bubble(v: Voice, t: number, f: number, peak: number, wet = 0.25, pan = 0): void {
  tone(v, t, { f, f2: f * 2.6, glide: 0.06, dur: 0.13, peak, a: 0.003, pan, wet });
}

function poof(
  v: Voice,
  t: number,
  o: { readonly peak: number; readonly f?: number; readonly dur?: number; readonly pan?: number },
): void {
  const f = o.f ?? 900;
  const dur = o.dur ?? 0.5;
  noise(v, t, {
    dur,
    color: "pink",
    ft: "lowpass",
    f,
    f2: f * 0.5,
    peak: o.peak,
    pan: o.pan,
    wet: 0.2,
    env: [
      [0.05, 1],
      [0.12, 0.6],
      [dur * 0.5, 0.2],
      [dur, 0],
    ],
  });
}

function swish(
  v: Voice,
  t: number,
  o: {
    readonly dur: number;
    readonly f: number;
    readonly f2: number;
    readonly q?: number;
    readonly peak: number;
    readonly pan?: Pan;
  },
): void {
  noise(v, t, {
    dur: o.dur,
    f: o.f,
    f2: o.f2,
    q: o.q ?? 1,
    peak: o.peak * 2,
    pan: o.pan,
    env: swell(o.dur * 0.35, 0, o.dur * 0.65),
    wet: 0.12,
  });
}

/** A bird's chirp: [seconds, Hz] points, the first at 0. */
function chirp(v: Voice, t: number, pts: Glide, dur: number, peak: number, pan = 0): void {
  tone(v, t, {
    f: pts[0]?.[1] ?? 2400,
    pts: pts.slice(1),
    dur,
    peak,
    pan,
    wet: 0.3,
    env: [
      [0.006, 1],
      [dur * 0.6, 0.6],
      [dur, 0],
    ],
  });
}

function crackle(
  v: Voice,
  t: number,
  o: { readonly n: number; readonly span: number; readonly peak: number },
): void {
  for (let i = 0; i < o.n; i++) {
    const at = v.r() * o.span;
    const pop = v.r() < 0.3;
    grain(v, t + at, {
      f: pop ? rnd(v, 700, 1200) : rnd(v, 2200, 4200),
      dur: pop ? 0.02 : rnd(v, 0.005, 0.012),
      q: 1.2,
      peak: o.peak * rnd(v, 0.4, 1) * (pop ? 1.3 : 1),
      pan: rnd(v, -0.25, 0.25),
      wet: 0.15,
    });
  }
}

function metalTick(v: Voice, t: number, peak: number, pan = 0): void {
  const f = rnd(v, 1900, 2300);
  tone(v, t, { f, dur: 0.06, peak: peak * 0.6, a: 0.001, pan, wet: 0.15 });
  tone(v, t, { f: f * 1.58, dur: 0.04, peak: peak * 0.3, a: 0.001, pan, wet: 0.15 });
  grain(v, t, { f: 3200, dur: 0.015, q: 2, peak, pan });
}

/** A stick-slip creak: a slow buzz through narrow wooden resonances. */
function creak(
  v: Voice,
  t: number,
  o: {
    readonly dur: number;
    readonly f1: number;
    readonly f2: number;
    readonly f3: number;
    readonly peak: number;
  },
): void {
  const osc = v.ac.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(o.f1, t);
  osc.frequency.linearRampToValueAtTime(o.f2, t + o.dur * 0.5);
  osc.frequency.linearRampToValueAtTime(o.f3, t + o.dur);
  const a = filter(v, "bandpass", 900, 5, t);
  const b = filter(v, "bandpass", 1750, 8, t);
  const gb = v.ac.createGain();
  gb.gain.value = 0.5;
  const sum = v.ac.createGain();
  sum.gain.value = 2;
  osc.connect(a);
  a.connect(sum);
  osc.connect(b);
  b.connect(gb);
  gb.connect(sum);
  out(v, sum, t, { env: swell(0.04, o.dur - 0.12, 0.08), peak: o.peak, wet: 0.15 });
  osc.start(t);
  osc.stop(t + o.dur + 0.1);
}

function rustle(
  v: Voice,
  t: number,
  o: {
    readonly dur: number;
    readonly n: number;
    readonly f: readonly [number, number];
    readonly peak: number;
    readonly body: { readonly f: number; readonly peak: number };
  },
): void {
  noise(v, t, {
    dur: o.dur,
    f: o.body.f,
    q: 0.8,
    peak: o.body.peak,
    env: [
      [0.08, 1],
      [o.dur * 0.4, 0.6],
      [o.dur, 0],
    ],
    wet: 0.12,
  });
  grains(v, t, { n: o.n, span: o.dur * 0.9, f: o.f, peak: o.peak, bias: 1.6, fade: true });
}

function wings(
  v: Voice,
  t: number,
  o: { readonly dur: number; readonly rate: number; readonly peak: number },
): void {
  const n = Math.floor(o.dur * o.rate);
  for (let i = 0; i < n; i++) {
    grain(v, t + i / o.rate + rnd(v, 0, 0.01), {
      f: rnd(v, 1100, 1800),
      dur: 0.035,
      q: 1.2,
      peak: o.peak * (1 - (i / n) * 0.6) * rnd(v, 0.7, 1),
      pan: rnd(v, -0.2, 0.2),
    });
  }
}

function flutter(
  v: Voice,
  t: number,
  o: {
    readonly dur: number;
    readonly rate: number;
    readonly rate2?: number;
    readonly f: number;
    readonly peak: number;
    readonly pan: readonly [number, number];
  },
): void {
  const rate2 = o.rate2 ?? o.rate;
  let at = 0;
  while (at < o.dur) {
    const x = at / o.dur;
    grain(v, t + at, {
      f: o.f * rnd(v, 0.85, 1.15),
      dur: 0.03,
      q: 1.5,
      peak: o.peak * (1 - x * 0.7),
      pan: o.pan[0] + (o.pan[1] - o.pan[0]) * x,
      wet: 0.25,
    });
    at += 1 / (o.rate + (rate2 - o.rate) * x);
  }
}

function buzz(
  v: Voice,
  t: number,
  o: {
    readonly dur: number;
    readonly rate: number;
    readonly rate2?: number;
    readonly f: number;
    readonly f2?: number;
    readonly peak: number;
    readonly env: Env;
    readonly pan?: Pan;
  },
): void {
  noise(v, t, {
    dur: o.dur,
    f: o.f,
    f2: o.f2,
    q: 2.2,
    peak: o.peak,
    env: o.env,
    pan: o.pan,
    am: o.rate,
    am2: o.rate2,
    amDepth: 1,
    amType: "triangle",
    wet: 0.1,
  });
}

/** Critter speech: a soft square blip, babbled. */
function blip(
  v: Voice,
  t: number,
  o: { readonly f: number; readonly f2?: number; readonly dur: number; readonly peak: number },
): void {
  const f2 = o.f2 ?? o.f;
  tone(v, t, {
    type: "square",
    f: o.f,
    f2,
    glide: o.dur,
    dur: o.dur,
    peak: o.peak,
    lp: 1700,
    q: 1.2,
    wet: 0.15,
    env: [
      [0.008, 1],
      [o.dur * 0.75, 0.85],
      [o.dur, 0],
    ],
  });
  tone(v, t, {
    f: o.f * 2,
    f2: f2 * 2,
    glide: o.dur,
    dur: o.dur,
    peak: o.peak * 0.25,
    wet: 0.15,
    env: [
      [0.008, 1],
      [o.dur * 0.6, 0.5],
      [o.dur, 0],
    ],
  });
}

function cluck(v: Voice, t: number, f: number, f2: number, dur: number, peak: number): void {
  voiced(v, t, {
    dur,
    peak,
    pts: [
      [0, f],
      [dur * 0.3, f2],
      [dur, f * 0.9],
    ],
    formants: [[0, 820, 1450]],
    lp: 2400,
  });
}

function slap(v: Voice, t: number, peak: number): void {
  noise(v, t, {
    dur: 0.07,
    color: "pink",
    ft: "lowpass",
    f: 2800,
    peak,
    env: perc(0.001, 0.069),
    wet: 0.12,
  });
  thud(v, t, 200, peak * 0.6);
  noise(v, t, { dur: 0.04, f: 1200, q: 1, peak: peak * 0.5, env: perc(0.001, 0.039) });
}

function hello(v: Voice, t: number, peak: number, lp: number, wet: number): void {
  noise(v, t, { dur: 0.06, f: 1500, q: 0.8, peak: peak * 0.3, env: perc(0.01, 0.05), wet });
  voiced(v, t + 0.03, {
    dur: 0.55,
    peak,
    lp,
    wet,
    vib: 5,
    vibDepth: 5,
    pts: [
      [0, 300],
      [0.08, 340],
      [0.2, 320],
      [0.24, 290],
      [0.55, 245],
    ],
    formants: [
      [0, 530, 1840],
      [0.2, 530, 1840],
      [0.26, 570, 840],
      [0.55, 450, 780],
    ],
  });
}

function houseLight(lo: number, hi: number, on: boolean): Sound {
  return (v, t) => {
    knock(v, t, 1700, 0.045);
    const [a, b] = on ? [lo, hi] : [hi, lo];
    mallet(v, t + 0.04, note(a), on ? 0.07 : 0.055);
    mallet(v, t + 0.15, note(b), on ? 0.07 : 0.05);
    if (on)
      tone(v, t + 0.05, {
        type: "triangle",
        f: note(lo - 12),
        dur: 0.6,
        peak: 0.018,
        lp: 1200,
        env: swell(0.2, 0.1, 0.3),
      });
  };
}

function splash(v: Voice, t: number, flicked: boolean): void {
  let h = 0;
  if (flicked) {
    knock(v, t, 2400, 0.018);
    swish(v, t + 0.03, { dur: 0.3, f: 1800, f2: 2600, q: 1.5, peak: 0.01 });
    h = 0.364; // The pebble's arc: 28% of the reaction.
  }
  bubble(v, t + h, 190, 0.1, 0.3);
  noise(v, t + h, {
    dur: 0.35,
    color: "pink",
    ft: "lowpass",
    f: 2600,
    f2: 900,
    peak: 0.065,
    env: perc(0.004, 0.34),
    wet: 0.2,
  });
  for (let k = 0; k < 3; k++)
    drip(
      v,
      t + h + 0.14 + k * 0.11 + rnd(v, 0, 0.05),
      rnd(v, 1300, 2100),
      0.022,
      0.3,
      rnd(v, -0.3, 0.3),
    );
}

function bamboo(v: Voice, t: number, peak: number): void {
  tone(v, t, { f: 480, dur: 0.3, peak, a: 0.001, wet: 0.45 });
  tone(v, t, { f: 1210, dur: 0.12, peak: peak * 0.5, a: 0.001, wet: 0.45 });
  tone(v, t, { f: 2070, dur: 0.05, peak: peak * 0.2, a: 0.001, wet: 0.45 });
  noise(v, t, {
    dur: 0.025,
    f: 2200,
    q: 2.5,
    peak: peak * 0.8,
    env: perc(0.001, 0.024),
    wet: 0.45,
  });
}

function birdOut(v: Voice, t: number, high: boolean): void {
  rustle(v, t, {
    dur: 0.5,
    n: 20,
    f: high ? [2600, 4400] : [1800, 3800],
    peak: 0.024,
    body: { f: high ? 1300 : 900, peak: 0.03 },
  });
  wings(v, t + 0.05, { dur: 0.7, rate: 16, peak: 0.035 });
}

function purr(v: Voice, t: number, dur: number, peak: number): void {
  const env = swell(0.3, dur - 0.7, 0.4);
  noise(v, t, {
    dur,
    color: "brown",
    ft: "lowpass",
    f: 300,
    peak,
    am: 25,
    amDepth: 0.9,
    amType: "sawtooth",
    env,
    wet: 0.05,
  });
  tone(v, t, {
    f: 50,
    dur,
    peak: peak * 0.4,
    am: 25,
    amDepth: 0.9,
    amType: "sawtooth",
    env,
    wet: 0,
  });
}

function lick(v: Voice, t: number, peak: number): void {
  grain(v, t, { f: 3800, dur: 0.015, q: 2.5, peak });
  grain(v, t + 0.01, { f: 1600, dur: 0.03, q: 1.5, peak: peak * 0.6 });
}

function rollOver(v: Voice, t: number): void {
  swish(v, t + 0.28, { dur: 0.25, f: 1400, f2: 2200, peak: 0.028 });
  swish(v, t + 1.58, { dur: 0.2, f: 2000, f2: 1300, peak: 0.024 });
}

function jump(
  v: Voice,
  t: number,
  hup: readonly [number, number],
  spring: readonly [number, number],
  peak: number,
): void {
  blip(v, t, { f: hup[0], f2: hup[1], dur: 0.09, peak });
  tone(v, t, { f: spring[0], f2: spring[1], glide: 0.16, dur: 0.2, peak: peak * 0.8 });
  thud(v, t + 0.74, spring[0] * 0.9, peak * 0.85);
  grains(v, t + 0.74, { n: 3, span: 0.06, f: [2500, 3800], peak: 0.01 });
}

function heart(v: Voice, t: number, notes: readonly [number, number, number], peak: number): void {
  drip(v, t, 900, 0.02);
  mallet(v, t + 0.05, note(notes[0]), peak);
  mallet(v, t + 0.17, note(notes[1]), peak);
  bell(v, t + 0.3, note(notes[2]), peak * 0.5, 1.0, 0.4);
}

// ---------------------------------------------------------------------------
// The sounds. Times are seconds into the reaction and follow the beats in
// goal-farm-render.ts: the hammer down every 320 ms, a saw stroke every
// ~283 ms, the hen's squat ending at 1.1 s, the creel fish landing at 70%.
// ---------------------------------------------------------------------------

const SOUNDS: Readonly<Record<string, Sound>> = {
  // Lights
  "lantern:on": (v, t) => {
    noise(v, t, { dur: 0.07, ft: "highpass", f: 2500, peak: 0.04, wet: 0.05 });
    noise(v, t + 0.03, {
      dur: 0.45,
      color: "pink",
      ft: "lowpass",
      f: 300,
      f2: 1400,
      glide: 0.2,
      peak: 0.09,
      env: swell(0.12, 0.05, 0.28),
    });
    sparkle(v, t + 0.15, { n: 4, span: 0.45, peak: 0.028 });
  },
  "lantern:off": (v, t) => {
    noise(v, t, {
      dur: 0.35,
      color: "pink",
      f: 1400,
      f2: 500,
      q: 0.8,
      peak: 0.08,
      env: swell(0.04, 0.03, 0.28),
    });
    bell(v, t + 0.08, note(79), 0.026, 1.0);
    bell(v, t + 0.22, note(74), 0.022, 1.2);
  },
  "house:on": houseLight(67, 74, true),
  "house:off": houseLight(67, 74, false),
  "annex:on": houseLight(76, 83, true),
  "annex:off": houseLight(76, 83, false),
  "campfire:on": (v, t) => {
    thud(v, t, 70, 0.08);
    noise(v, t, {
      dur: 0.8,
      color: "brown",
      ft: "lowpass",
      f: 250,
      f2: 1400,
      glide: 0.25,
      peak: 0.16,
      env: [
        [0.12, 1],
        [0.3, 0.7],
        [0.55, 0.25],
        [0.8, 0],
      ],
    });
    crackle(v, t + 0.05, { n: 14, span: 0.7, peak: 0.05 });
  },
  "campfire:off": (v, t) => {
    noise(v, t, {
      dur: 0.6,
      f: 3000,
      f2: 1800,
      q: 0.7,
      peak: 0.035,
      env: swell(0.05, 0.1, 0.45),
    });
    noise(v, t, {
      dur: 0.6,
      color: "brown",
      ft: "lowpass",
      f: 500,
      f2: 150,
      peak: 0.07,
      env: [
        [0.01, 1],
        [0.3, 0.4],
        [0.6, 0],
      ],
    });
    crackle(v, t + 0.05, { n: 4, span: 0.5, peak: 0.03 });
  },

  // Around the house
  "stove:rattle": (v, t) => {
    let at = 0;
    for (let i = 0; i < 14; i++) {
      metalTick(v, t + at, 0.05 * (1 - i / 17), rnd(v, -0.2, 0.2));
      at += rnd(v, 0.045, 0.075);
    }
    metalTick(v, t + at + 0.03, 0.04);
    knock(v, t + at + 0.03, 600, 0.03);
  },
  "stove:puff": (v, t) => {
    noise(v, t, {
      dur: 0.55,
      f: 2600,
      f2: 3800,
      q: 0.6,
      peak: 0.05,
      env: swell(0.07, 0.05, 0.42),
      pan: -0.25,
    });
    noise(v, t + 0.13, {
      dur: 0.5,
      f: 2400,
      f2: 3500,
      q: 0.6,
      peak: 0.04,
      env: swell(0.07, 0.05, 0.37),
      pan: 0.25,
    });
    for (let k = 0; k < 4; k++)
      bubble(v, t + 0.05 + k * 0.12 + rnd(v, 0, 0.05), rnd(v, 280, 420), 0.03);
  },
  "stove:flare": (v, t) => {
    thud(v, t, 65, 0.06);
    noise(v, t, {
      dur: 1.0,
      color: "pink",
      ft: "lowpass",
      f: 300,
      f2: 2200,
      glide: 0.25,
      peak: 0.12,
      env: [
        [0.06, 1],
        [0.25, 0.8],
        [0.6, 0.25],
        [1.0, 0],
      ],
    });
    crackle(v, t + 0.05, { n: 10, span: 0.8, peak: 0.045 });
  },
  "kennel:creak": (v, t) => {
    creak(v, t, { dur: 0.45, f1: 40, f2: 75, f3: 45, peak: 0.07 });
    creak(v, t + 0.55, { dur: 0.22, f1: 55, f2: 70, f3: 50, peak: 0.04 });
  },
  "kennel:zzz": (v, t) => {
    noise(v, t, {
      dur: 0.75,
      color: "brown",
      ft: "lowpass",
      f: 500,
      peak: 0.09,
      env: swell(0.35, 0.15, 0.25),
      am: 26,
      amDepth: 0.9,
      amType: "sawtooth",
      wet: 0.1,
    });
    noise(v, t + 0.95, {
      dur: 0.7,
      ft: "lowpass",
      f: 1200,
      peak: 0.02,
      env: swell(0.1, 0.3, 0.3),
    });
    tone(v, t + 0.95, { f: 620, f2: 430, dur: 0.7, peak: 0.018, env: swell(0.1, 0.3, 0.3) });
    noise(v, t + 1.75, {
      dur: 0.7,
      color: "brown",
      ft: "lowpass",
      f: 450,
      peak: 0.05,
      env: swell(0.35, 0.1, 0.25),
      am: 24,
      amDepth: 0.9,
      amType: "sawtooth",
      wet: 0.1,
    });
    mallet(v, t + 0.1, note(81), 0.012, 0.4);
    mallet(v, t + 0.55, note(83), 0.012, 0.4);
    mallet(v, t + 1.0, note(86), 0.012, 0.4);
  },
  "board:flutter": (v, t) => {
    for (let i = 0; i < 15; i++) {
      grain(v, t + i * 0.07 + rnd(v, 0, 0.015), {
        f: rnd(v, 2000, 3200),
        dur: 0.035,
        q: 1.2,
        peak: 0.045 * (1 - i / 18) * rnd(v, 0.6, 1),
      });
    }
  },
  "board:note": (v, t) => {
    knock(v, t, 2400, 0.04);
    noise(v, t + 0.01, { dur: 0.1, f: 3000, q: 0.9, peak: 0.025, env: swell(0.03, 0.02, 0.05) });
    sparkle(v, t + 0.18, { n: 4, span: 0.6, peak: 0.02 });
  },
  "kura:mouse": (v, t) => {
    grains(v, t + 0.1, { n: 5, span: 0.3, f: [4000, 5500], dur: 0.012, peak: 0.015 });
    chirp(
      v,
      t + 0.62,
      [
        [0, 2500],
        [0.03, 3100],
        [0.07, 2800],
      ],
      0.08,
      0.03,
    );
    chirp(
      v,
      t + 0.8,
      [
        [0, 2700],
        [0.03, 3300],
        [0.07, 3000],
      ],
      0.08,
      0.025,
    );
    grains(v, t + 1.85, { n: 6, span: 0.25, f: [3000, 4500], dur: 0.012, peak: 0.015 });
  },
  "kura:dust": (v, t) => {
    poof(v, t, { peak: 0.09, f: 700, dur: 0.6, pan: -0.15 });
    poof(v, t + 0.07, { peak: 0.07, f: 800, dur: 0.55, pan: 0.15 });
    grains(v, t + 0.1, { n: 8, span: 0.5, f: [4500, 6000], dur: 0.01, peak: 0.008 });
  },
  "postbox:letter": (v, t) => {
    noise(v, t + 0.05, {
      dur: 0.35,
      f: 2400,
      f2: 3400,
      q: 0.8,
      peak: 0.035,
      env: swell(0.1, 0.1, 0.15),
    });
    knock(v, t + 0.4, 1900, 0.018);
    noise(v, t + 1.85, {
      dur: 0.3,
      f: 3200,
      f2: 2300,
      q: 0.8,
      peak: 0.028,
      env: swell(0.08, 0.08, 0.14),
    });
    knock(v, t + 2.22, 900, 0.035);
  },
  "postbox:flag": (v, t) => {
    tone(v, t, {
      type: "triangle",
      f: 330,
      f2: 560,
      glide: 0.12,
      dur: 0.4,
      vib: 16,
      vibDepth: 25,
      peak: 0.045,
      lp: 1800,
    });
    metalTick(v, t + 0.26, 0.035);
    knock(v, t + 0.26, 1300, 0.02);
  },
  "bookcase:book": (v, t) => {
    noise(v, t, {
      dur: 0.38,
      color: "pink",
      f: 800,
      f2: 1200,
      q: 1.6,
      peak: 0.06,
      env: swell(0.08, 0.15, 0.15),
    });
    knock(v, t + 0.36, 500, 0.02);
    noise(v, t + 0.9, {
      dur: 0.3,
      color: "pink",
      f: 1200,
      f2: 800,
      q: 1.6,
      peak: 0.05,
      env: swell(0.06, 0.12, 0.12),
    });
    thud(v, t + 1.2, 150, 0.07);
    knock(v, t + 1.2, 420, 0.03);
  },
  "bookcase:dust": (v, t) => {
    poof(v, t, { peak: 0.06, f: 1300, dur: 0.5, pan: -0.1 });
    poof(v, t + 0.06, { peak: 0.05, f: 1500, dur: 0.45, pan: 0.2 });
    grains(v, t + 0.05, { n: 5, span: 0.4, f: [2500, 3500], peak: 0.01 });
  },
  "laptop:wake": (v, t) => {
    tone(v, t, { f: note(50), dur: 1.4, peak: 0.02, env: swell(0.3, 0.4, 0.7) });
    [74, 81, 86].forEach((m, i) =>
      tone(v, t + i * 0.12, {
        type: "triangle",
        f: note(m),
        dur: 0.5 + i * 0.2,
        peak: 0.04 - i * 0.004,
        lp: 2500,
        wet: 0.3,
        env: swell(0.02, 0.08, 0.4 + i * 0.2),
      }),
    );
    let at = 0.9;
    for (let k = 0; k < 6; k++) {
      grain(v, t + at, { f: 3000, dur: 0.012, q: 1.5, peak: 0.014 });
      at += rnd(v, 0.18, 0.3);
    }
  },
  "laptop:beep": (v, t) => {
    tone(v, t, {
      type: "square",
      f: 988,
      dur: 0.09,
      peak: 0.028,
      lp: 2200,
      env: [
        [0.005, 1],
        [0.07, 1],
        [0.09, 0],
      ],
    });
    tone(v, t + 0.13, {
      type: "square",
      f: 1319,
      dur: 0.12,
      peak: 0.024,
      lp: 2200,
      env: [
        [0.005, 1],
        [0.09, 1],
        [0.12, 0],
      ],
    });
  },
  "bench:hammer": (v, t) => {
    [0.05, 0.37, 0.69, 1.01].forEach((d, i) => {
      const a = i === 3 ? 0.7 : 1;
      thud(v, t + d, 150 * rnd(v, 0.95, 1.05), 0.055 * a);
      knock(v, t + d, 620 * rnd(v, 0.95, 1.05), 0.06 * a);
      grains(v, t + d + 0.02, { n: 2, span: 0.08, f: [3000, 4000], peak: 0.008 });
    });
  },
  "bench:saw": (v, t) => {
    for (let i = 0; i < 4; i++) {
      const push = i % 2 === 0;
      noise(v, t + i * 0.283, {
        dur: 0.27,
        f: push ? 1500 : 1300,
        f2: push ? 2100 : 1700,
        q: 2,
        peak: (push ? 0.15 : 0.1) * (i === 3 ? 0.7 : 1),
        env: [
          [0.05, 1],
          [0.2, 0.9],
          [0.27, 0],
        ],
        am: 90,
        amDepth: 0.8,
        amType: "sawtooth",
        lp: 3200,
      });
    }
  },
  "teabench:steam": (v, t) => {
    tone(v, t, { f: 2350, dur: 0.25, peak: 0.025, a: 0.001, wet: 0.3 });
    tone(v, t, { f: 2350 * 1.5, dur: 0.12, peak: 0.008, a: 0.001, wet: 0.3 });
    noise(v, t + 0.1, {
      dur: 2.2,
      f: 3500,
      q: 0.5,
      peak: 0.03,
      env: [
        [0.5, 1],
        [1.4, 0.8],
        [2.2, 0],
      ],
    });
  },
  "teabench:spin": (v, t) => {
    knock(v, t, 1100, 0.022);
    noise(v, t, {
      dur: 0.85,
      color: "pink",
      f: 1100,
      f2: 1500,
      q: 1,
      peak: 0.15,
      env: swell(0.12, 0.3, 0.4),
      am: 5.3,
      amDepth: 0.8,
    });
  },
  "creel:flop": (v, t) => {
    slap(v, t, 0.06);
    grain(v, t + 0.3, { f: 1600, dur: 0.03, peak: 0.02 });
    grain(v, t + 0.45, { f: 1800, dur: 0.03, peak: 0.018 });
    slap(v, t + 0.9, 0.08);
    drip(v, t + 1.0, 1700, 0.014);
    drip(v, t + 1.1, 1300, 0.011);
  },
  "torii:petals": (v, t) => {
    noise(v, t, {
      dur: 2.5,
      color: "pink",
      fpts: [
        [1, 900],
        [2.5, 550],
      ],
      f: 450,
      q: 0.7,
      peak: 0.06,
      env: [
        [0.7, 1],
        [1.5, 0.8],
        [2.5, 0],
      ],
      pan: [-0.4, 0.4],
    });
    sparkle(v, t + 0.4, { n: 5, span: 1.6, peak: 0.013 });
  },
  "torii:glimmer": (v, t) => {
    for (let k = 0; k < 5; k++)
      tone(v, t + k * 0.012, {
        f: note(pick(v, [88, 91])) * rnd(v, 0.99, 1.01),
        dur: 0.3,
        peak: 0.008,
        wet: 0.4,
      });
    tone(v, t, { f: note(55), dur: 1.2, peak: 0.012, env: swell(0.3, 0.3, 0.6) });
    tone(v, t, { f: note(62), dur: 1.2, peak: 0.01, env: swell(0.3, 0.3, 0.6) });
    sparkle(v, t + 0.05, {
      n: 8,
      span: 1.0,
      peak: 0.02,
      notes: [79, 81, 83, 86, 88, 91, 93, 95],
      rising: true,
    });
  },

  // Water
  "well:draw": (v, t) => {
    bubble(v, t + 0.02, 260, 0.045, 0.4);
    noise(v, t, { dur: 0.3, color: "pink", ft: "lowpass", f: 1200, peak: 0.04 });
    for (let i = 0; i < 10; i++) knock(v, t + 0.05 + i * 0.09, 900 + i * 20, 0.022);
    creak(v, t + 0.1, { dur: 0.75, f1: 30, f2: 45, f3: 35, peak: 0.02 });
    for (const d of [0.95, 1.12, 1.29, 1.42]) drip(v, t + d, rnd(v, 1300, 1800), 0.028, 0.45);
    for (let i = 0; i < 7; i++) knock(v, t + 1.45 + i * 0.06, 1000 - i * 25, 0.015);
    bubble(v, t + 1.72, 220, 0.055, 0.45);
    noise(v, t + 1.72, {
      dur: 0.35,
      color: "pink",
      ft: "lowpass",
      f: 1600,
      peak: 0.055,
      wet: 0.35,
    });
    drip(v, t + 1.85, 1500, 0.018, 0.45);
  },
  "well:pebble": (v, t) => {
    knock(v, t, 2600, 0.016);
    drip(v, t + 0.2, 1150, 0.08, 0.5);
    drip(v, t + 0.33, 1150, 0.03, 0.7);
    drip(v, t + 0.46, 1150, 0.013, 0.8);
  },
  "well:echo": (v, t) => {
    hello(v, t, 0.06, 2600, 0.3);
    hello(v, t + 1.3, 0.025, 1300, 0.7);
    hello(v, t + 1.85, 0.011, 900, 0.8);
  },
  "pond:splash": (v, t) => splash(v, t, false),
  "pond:splash~flick": (v, t) => splash(v, t, true),
  "pond:dart": (v, t) => {
    swish(v, t, { dur: 0.32, f: 600, f2: 2000, q: 1.2, peak: 0.07, pan: [-0.4, 0.4] });
    swish(v, t + 0.1, { dur: 0.25, f: 700, f2: 1700, q: 1.4, peak: 0.045, pan: [-0.2, 0.5] });
    noise(v, t, {
      dur: 0.4,
      color: "pink",
      ft: "lowpass",
      f: 500,
      peak: 0.035,
      env: swell(0.1, 0.05, 0.25),
    });
    bubble(v, t + 0.3, 420, 0.022);
    bubble(v, t + 0.42, 520, 0.018);
  },
  "pond:feed": (v, t) => {
    for (let k = 0; k < 7; k++)
      drip(v, t + k * 0.06 + rnd(v, 0, 0.03), rnd(v, 2600, 3400), 0.011, 0.2, rnd(v, -0.3, 0.3));
    [0.6, 0.85, 1.1, 1.45, 1.8].forEach((d, i) => {
      const at = t + d + rnd(v, -0.04, 0.04);
      const pan = rnd(v, -0.3, 0.3);
      bubble(v, at, rnd(v, 200, 320), 0.055 - i * 0.007, 0.3, pan);
      noise(v, at, { dur: 0.03, color: "pink", ft: "lowpass", f: 900, peak: 0.02, pan });
    });
  },
  "spout:gush": (v, t) => {
    noise(v, t, {
      dur: 1.25,
      color: "pink",
      ft: "lowpass",
      f: 1600,
      peak: 0.065,
      env: swell(0.15, 0.5, 0.6),
    });
    noise(v, t, {
      dur: 1.25,
      f: 700,
      q: 1.5,
      peak: 0.035,
      env: swell(0.15, 0.5, 0.6),
      am: 9,
      amDepth: 0.6,
    });
    for (let k = 0; k < 22; k++)
      drip(
        v,
        t + rnd(v, 0.05, 1.05),
        rnd(v, 500, 1400),
        rnd(v, 0.008, 0.02),
        0.3,
        rnd(v, -0.3, 0.3),
      );
  },
  "spout:clack": (v, t) => {
    bamboo(v, t, 0.13);
    noise(v, t + 0.06, {
      dur: 0.5,
      color: "pink",
      ft: "lowpass",
      f: 1300,
      peak: 0.035,
      env: swell(0.08, 0.15, 0.27),
    });
    for (let k = 0; k < 5; k++) drip(v, t + rnd(v, 0.1, 0.5), rnd(v, 600, 1300), 0.012, 0.3);
    bamboo(v, t + 0.62, 0.025);
  },

  // Trees and plants
  "tree:shake": (v, t) =>
    rustle(v, t, {
      dur: 1.3,
      n: 55,
      f: [1800, 3800],
      peak: 0.03,
      body: { f: 900, peak: 0.05 },
    }),
  "sakura:shake": (v, t) => {
    rustle(v, t, {
      dur: 1.2,
      n: 45,
      f: [2600, 4500],
      peak: 0.024,
      body: { f: 1300, peak: 0.035 },
    });
    sparkle(v, t + 0.1, { n: 6, span: 1.3, peak: 0.011 });
  },
  "camellia:shake": (v, t) => {
    rustle(v, t, {
      dur: 1.0,
      n: 40,
      f: [2000, 4000],
      peak: 0.027,
      body: { f: 1000, peak: 0.04 },
    });
    thud(v, t + 0.75, 210, 0.045);
    knock(v, t + 0.75, 700, 0.012);
  },
  "yuzu:shake": (v, t) => {
    rustle(v, t, {
      dur: 1.0,
      n: 40,
      f: [1800, 3600],
      peak: 0.027,
      body: { f: 900, peak: 0.045 },
    });
    thud(v, t + 0.62, 130, 0.075);
    knock(v, t + 0.62, 380, 0.025);
    noise(v, t + 0.68, {
      dur: 0.6,
      color: "brown",
      ft: "lowpass",
      f: 350,
      peak: 0.035,
      am: 11,
      am2: 6,
      amDepth: 0.9,
      env: [
        [0.05, 1],
        [0.4, 0.6],
        [0.6, 0],
      ],
    });
    thud(v, t + 1.15, 160, 0.022);
  },
  // A bush warbler (uguisu): a long "hoo…", then a quick "ho-ke-kyo".
  "sakura:bird": (v, t) => {
    birdOut(v, t, true);
    tone(v, t + 0.25, {
      f: 1150,
      f2: 1260,
      dur: 0.55,
      peak: 0.03,
      vib: 6,
      vibDepth: 8,
      env: swell(0.08, 0.3, 0.17),
      wet: 0.35,
    });
    chirp(
      v,
      t + 0.9,
      [
        [0, 1700],
        [0.12, 1750],
      ],
      0.12,
      0.032,
    );
    chirp(
      v,
      t + 1.05,
      [
        [0, 2300],
        [0.08, 2400],
      ],
      0.08,
      0.03,
    );
    chirp(
      v,
      t + 1.16,
      [
        [0, 2500],
        [0.06, 2300],
        [0.22, 1600],
      ],
      0.22,
      0.034,
    );
  },
  // A sparrow (suzume): "chun, chun".
  "tree:bird": (v, t) => {
    birdOut(v, t, false);
    for (const d of [0.15, 0.3, 0.6])
      chirp(
        v,
        t + d,
        [
          [0, 2400],
          [0.02, 2850],
          [0.06, 2100],
        ],
        0.06,
        0.03,
        rnd(v, -0.3, 0.3),
      );
  },
  // A white-eye (mejiro): a quick, high twitter.
  "camellia:bird": (v, t) => {
    birdOut(v, t, true);
    for (let k = 0; k < 9; k++) {
      const hi = k % 2 === 0 ? 2700 : 2350;
      chirp(
        v,
        t + 0.15 + k * 0.06,
        [
          [0, hi],
          [0.04, hi * 0.88],
        ],
        0.04,
        0.022 * (1 - k / 14),
      );
    }
  },
  // A bulbul (hiyodori): "pii-yo".
  "yuzu:bird": (v, t) => {
    birdOut(v, t, false);
    chirp(
      v,
      t + 0.2,
      [
        [0, 1700],
        [0.2, 2400],
      ],
      0.2,
      0.03,
    );
    chirp(
      v,
      t + 0.45,
      [
        [0, 2200],
        [0.25, 1500],
      ],
      0.25,
      0.03,
    );
  },
  "bush:rustle": (v, t) =>
    rustle(v, t, {
      dur: 0.8,
      n: 35,
      f: [2200, 4200],
      peak: 0.03,
      body: { f: 1200, peak: 0.04 },
    }),
  "bush:bird": (v, t) => {
    rustle(v, t, {
      dur: 0.4,
      n: 18,
      f: [2200, 4200],
      peak: 0.028,
      body: { f: 1200, peak: 0.035 },
    });
    wings(v, t + 0.05, { dur: 0.5, rate: 18, peak: 0.032 });
    chirp(
      v,
      t + 0.2,
      [
        [0, 2500],
        [0.05, 2100],
      ],
      0.05,
      0.03,
    );
    chirp(
      v,
      t + 0.32,
      [
        [0, 2600],
        [0.05, 2200],
      ],
      0.05,
      0.025,
    );
  },
  "bush:butterfly": (v, t) => {
    rustle(v, t, {
      dur: 0.35,
      n: 12,
      f: [2200, 4200],
      peak: 0.018,
      body: { f: 1200, peak: 0.02 },
    });
    flutter(v, t + 0.2, { dur: 1.4, rate: 9, f: 1800, peak: 0.011, pan: [0, 0.3] });
    sparkle(v, t + 0.3, { n: 3, span: 1.2, peak: 0.011 });
  },
  "field:sway": (v, t) => {
    noise(v, t, {
      dur: 1.2,
      f: 1200,
      fpts: [
        [0.4, 2400],
        [1.2, 1400],
      ],
      q: 0.8,
      peak: 0.05,
      env: swell(0.3, 0.2, 0.7),
      pan: [-0.3, 0.3],
    });
    grains(v, t, { n: 18, span: 1.0, f: [2500, 4200], peak: 0.012 });
  },
  "field:sprout": (v, t) => {
    tone(v, t, {
      type: "triangle",
      f: 260,
      f2: 620,
      glide: 0.5,
      dur: 0.7,
      peak: 0.04,
      lp: 1500,
      env: swell(0.15, 0.2, 0.35),
    });
    drip(v, t + 0.78, 950, 0.035);
    sparkle(v, t + 0.85, {
      n: 5,
      span: 0.45,
      peak: 0.02,
      notes: [79, 83, 86, 91, 95],
      rising: true,
    });
  },
  "stone:hop": (v, t) => {
    tone(v, t, { f: 420, f2: 700, glide: 0.06, dur: 0.08, peak: 0.025 });
    tone(v, t + 0.24, { f: 1400, dur: 0.04, peak: 0.035, a: 0.001 });
    grain(v, t + 0.24, { f: 2600, dur: 0.02, q: 3, peak: 0.045 });
    poof(v, t + 0.25, { peak: 0.025, f: 900, dur: 0.3 });
  },

  // Animals
  "hen:startle": (v, t) => {
    wings(v, t, { dur: 0.45, rate: 22, peak: 0.04 });
    cluck(v, t + 0.02, 520, 760, 0.2, 0.06);
    cluck(v, t + 0.33, 440, 470, 0.09, 0.035);
    cluck(v, t + 0.48, 430, 450, 0.08, 0.025);
  },
  "hen:flap": (v, t) => {
    wings(v, t, { dur: 1.2, rate: 14, peak: 0.038 });
    cluck(v, t + 0.3, 420, 460, 0.08, 0.028);
    cluck(v, t + 0.75, 440, 480, 0.08, 0.028);
  },
  "hen:peck": (v, t) => {
    for (let i = 0; i < 7; i++) {
      const at = t + 0.05 + i * 0.18 + rnd(v, 0, 0.02);
      const p = 0.032 * rnd(v, 0.6, 1);
      grain(v, at, { f: 2200, dur: 0.012, q: 2, peak: p });
      tone(v, at, { f: 1100, dur: 0.02, peak: p * 0.5, a: 0.001 });
    }
    cluck(v, t + 0.62, 400, 430, 0.06, 0.018);
  },
  "hen:egg": (v, t) => {
    [0, 0.24, 0.46, 0.64].forEach((d, i) =>
      cluck(v, t + d, 380 + i * 20, 400 + i * 25, 0.07, 0.028 + i * 0.005),
    );
    tone(v, t + 0.9, { f: 700, f2: 300, glide: 0.04, dur: 0.06, peak: 0.045, a: 0.001 });
    thud(v, t + 0.9, 180, 0.025);
    cluck(v, t + 1.15, 480, 500, 0.08, 0.035);
    cluck(v, t + 1.27, 620, 840, 0.24, 0.05);
    mallet(v, t + 1.6, note(79), 0.022);
    mallet(v, t + 1.72, note(86), 0.02);
  },
  "cat:hiss": (v, t) => {
    swish(v, t, { dur: 0.15, f: 2000, f2: 2600, peak: 0.018 });
    noise(v, t + 0.1, {
      dur: 0.95,
      f: 3400,
      q: 0.6,
      peak: 0.035,
      env: [
        [0.06, 1],
        [0.5, 0.8],
        [0.95, 0],
      ],
    });
    tone(v, t + 0.12, {
      type: "sawtooth",
      f: 95,
      dur: 0.9,
      peak: 0.02,
      lp: 300,
      am: 28,
      amDepth: 0.8,
      env: swell(0.1, 0.5, 0.3),
    });
  },
  "cat:groom": (v, t) => {
    purr(v, t, 2.1, 0.06);
    for (const d of [0.3, 0.7, 1.1, 1.5, 1.9]) lick(v, t + d, 0.022);
  },
  "cat:roll": (v, t) => {
    // "Mrrp?"
    voiced(v, t + 0.02, {
      dur: 0.22,
      peak: 0.04,
      vib: 30,
      vibDepth: 40,
      pts: [
        [0, 500],
        [0.22, 720],
      ],
      formants: [
        [0, 700, 1300],
        [0.22, 500, 1700],
      ],
      lp: 2000,
    });
    rollOver(v, t);
  },
  "cat:pounce": (v, t) => {
    for (const d of [0.08, 0.18, 0.28]) grain(v, t + d, { f: rnd(v, 2500, 3500), peak: 0.01 });
    voiced(v, t + 0.38, {
      dur: 0.08,
      peak: 0.03,
      pts: [
        [0, 650],
        [0.08, 950],
      ],
      formants: [[0, 600, 1700]],
      lp: 2200,
    });
    swish(v, t + 0.4, { dur: 0.25, f: 900, f2: 1800, peak: 0.035 });
    thud(v, t + 0.93, 170, 0.045);
    grains(v, t + 0.93, { n: 6, span: 0.15, f: [2500, 4000], peak: 0.014 });
  },
  "shiba:yawn": (v, t) => {
    voiced(v, t + 0.38, {
      dur: 1.3,
      peak: 0.04,
      lp: 2000,
      vib: 5.5,
      vibDepth: 8,
      pts: [
        [0, 360],
        [0.35, 620],
        [0.7, 520],
        [1.3, 280],
      ],
      formants: [
        [0, 750, 1250],
        [0.6, 700, 1150],
        [1.3, 380, 700],
      ],
      env: [
        [0.15, 1],
        [0.8, 0.8],
        [1.3, 0],
      ],
    });
    noise(v, t + 0.38, {
      dur: 1.3,
      ft: "lowpass",
      f: 900,
      peak: 0.012,
      env: [
        [0.2, 1],
        [0.9, 0.6],
        [1.3, 0],
      ],
    });
    grain(v, t + 1.85, { f: 1800, dur: 0.015, q: 2, peak: 0.018 });
    grain(v, t + 1.93, { f: 1700, dur: 0.015, q: 2, peak: 0.014 });
    noise(v, t + 2.05, {
      dur: 0.45,
      color: "pink",
      ft: "lowpass",
      f: 700,
      peak: 0.022,
      env: swell(0.15, 0.05, 0.25),
    });
  },
  "shiba:wag": (v, t) => {
    blip(v, t, { f: 600, f2: 700, dur: 0.12, peak: 0.015 });
    for (let i = 0; i < 10; i++)
      swish(v, t + i * 0.16, {
        dur: 0.1,
        f: 1300,
        f2: 1700,
        q: 1.2,
        peak: 0.018,
        pan: i % 2 ? -0.15 : 0.15,
      });
    // Happy panting.
    for (const d of [0.1, 0.42, 0.74, 1.06, 1.38]) {
      noise(v, t + d, { dur: 0.07, f: 1300, q: 1, peak: 0.06, env: swell(0.015, 0.02, 0.035) });
      noise(v, t + d + 0.12, {
        dur: 0.05,
        f: 1700,
        q: 1,
        peak: 0.035,
        env: swell(0.01, 0.015, 0.025),
      });
    }
  },
  "shiba:roll": (v, t) => {
    voiced(v, t + 0.05, {
      dur: 0.38,
      peak: 0.032,
      pts: [
        [0, 300],
        [0.15, 420],
        [0.38, 330],
      ],
      formants: [
        [0, 700, 1100],
        [0.38, 400, 800],
      ],
      lp: 1800,
    });
    rollOver(v, t);
  },
  "shiba:woof": (v, t) => {
    noise(v, t, { dur: 0.05, f: 900, q: 0.8, peak: 0.025 });
    voiced(v, t + 0.01, {
      dur: 0.17,
      peak: 0.08,
      lp: 1800,
      pts: [
        [0, 240],
        [0.04, 410],
        [0.17, 230],
      ],
      formants: [
        [0, 500, 950],
        [0.17, 420, 800],
      ],
    });
    thud(v, t + 0.46, 170, 0.028);
  },
  "dragonfly:zip": (v, t) => {
    buzz(v, t, {
      dur: 0.95,
      rate: 34,
      f: 900,
      f2: 620,
      peak: 0.16,
      env: [
        [0.08, 1],
        [0.4, 1],
        [0.95, 0],
      ],
      pan: [-0.6, 0.7],
    });
    buzz(v, t + 2.1, {
      dur: 0.9,
      rate: 30,
      f: 700,
      f2: 850,
      peak: 0.055,
      env: swell(0.35, 0.15, 0.4),
      pan: [0.6, -0.2],
    });
  },
  "dragonfly:land": (v, t) => {
    buzz(v, t, {
      dur: 1.5,
      rate: 32,
      rate2: 22,
      f: 800,
      f2: 650,
      peak: 0.11,
      env: [
        [0.3, 1],
        [1.0, 0.7],
        [1.5, 0],
      ],
      pan: [0.5, 0],
    });
    drip(v, t + 1.5, 1900, 0.022);
    drip(v, t + 1.62, 900, 0.011);
    buzz(v, t + 2.8, { dur: 0.14, rate: 30, f: 800, peak: 0.035, env: swell(0.03, 0.05, 0.06) });
  },
  "butterflies:scatter": (v, t) => {
    for (let j = 0; j < 3; j++)
      flutter(v, t + j * 0.08, {
        dur: 1.4,
        rate: 10 + j * 1.5,
        f: 1700 + j * 300,
        peak: 0.013,
        pan: [-0.5 + j * 0.5, (j - 1) * 0.8],
      });
    [95, 93, 91, 88, 86].forEach((m, k) =>
      bell(v, t + 0.1 + k * 0.15, note(m), 0.014, 0.9, 0.5, rnd(v, -0.3, 0.3)),
    );
  },
  "butterflies:land": (v, t) => {
    flutter(v, t, { dur: 2.2, rate: 10, rate2: 4, f: 1800, peak: 0.015, pan: [0.4, 0] });
    bell(v, t + 2.35, note(88), 0.02, 1.2, 0.5);
  },

  // The crew: worker critters chirp high and quick, Ken lower and warmer.
  "critter:wave": (v, t) => {
    blip(v, t, { f: 620, f2: 640, dur: 0.07, peak: 0.04 });
    blip(v, t + 0.1, { f: 740, f2: 760, dur: 0.07, peak: 0.04 });
    blip(v, t + 0.2, { f: 880, f2: 1020, dur: 0.13, peak: 0.045 });
    sparkle(v, t + 0.45, { n: 2, span: 0.15, peak: 0.014 });
  },
  "critter:jump": (v, t) => jump(v, t, [600, 860], [300, 760], 0.04),
  "coordinator:jump": (v, t) => jump(v, t, [420, 620], [220, 540], 0.045),
  "critter:heart": (v, t) => heart(v, t, [74, 81, 86], 0.045),
  "coordinator:heart": (v, t) => heart(v, t, [67, 74, 79], 0.05),
  "critter:spin": (v, t) => {
    [0, 0.22, 0.44].forEach((d, i) =>
      swish(v, t + d, {
        dur: 0.2,
        f: 1000 + i * 300,
        f2: 1400 + i * 300,
        q: 1.2,
        peak: 0.028,
        pan: i % 2 ? 0.3 : -0.3,
      }),
    );
    blip(v, t + 0.08, { f: 660, f2: 1050, dur: 0.3, peak: 0.022 });
  },
  "coordinator:summary": (v, t) => {
    noise(v, t, { dur: 0.12, f: 3000, q: 0.9, peak: 0.012 });
    let at = 0.08;
    for (let i = 0; i < 10; i++) {
      const f = note(pick(v, [62, 64, 67, 69, 71]));
      const dur = rnd(v, 0.07, 0.11);
      const last = i === 9;
      blip(v, t + at, {
        f,
        f2: last ? f * 1.2 : f * rnd(v, 0.95, 1.08),
        dur: last ? 0.16 : dur,
        peak: 0.038,
      });
      at += dur + rnd(v, 0.04, 0.09) + (i % 4 === 3 ? 0.12 : 0);
    }
    mallet(v, t + at + 0.25, note(74), 0.032);
    mallet(v, t + at + 0.25, note(81), 0.026);
    bell(v, t + at + 0.32, note(86), 0.016, 1.0, 0.4);
  },

  // Open ground
  "ground:snow": (v, t) => {
    noise(v, t, {
      dur: 0.18,
      color: "pink",
      ft: "lowpass",
      f: 1200,
      peak: 0.12,
      env: perc(0.01, 0.17),
    });
    grains(v, t, { n: 7, span: 0.12, f: [1500, 3000], q: 0.8, dur: 0.02, peak: 0.024 });
  },
  "ground:puddle": (v, t) => {
    bubble(v, t, 300, 0.045);
    noise(v, t, { dur: 0.22, color: "pink", ft: "lowpass", f: 2200, peak: 0.045 });
    drip(v, t + 0.12, 1700, 0.016);
    drip(v, t + 0.2, 1300, 0.011);
  },
  "ground:grass": (v, t) => {
    swish(v, t, { dur: 0.18, f: 1800, f2: 2600, q: 0.9, peak: 0.028 });
    grains(v, t, { n: 6, span: 0.15, f: [2500, 4000], peak: 0.011 });
  },
  "ground:dirt": (v, t) => {
    poof(v, t, { peak: 0.055, f: 600, dur: 0.35 });
    thud(v, t, 120, 0.022);
  },
};
