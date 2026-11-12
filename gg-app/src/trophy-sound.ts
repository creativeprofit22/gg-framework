// The trophy unlock's sound, synthesized with Web Audio rather than shipped as
// an mp3: it follows the card's timeline, which stretches with the tier (a
// platinum trophy charges longer and spins more). Every tier lands on the same
// trophy motif, a bell rising a fifth (E5 to B5), so the ear learns it.
// Honors the app-wide sound toggle (sounds.ts).
import { isSoundEnabled } from "./sounds";

/** The card's beats, in seconds from the moment it appears. */
export interface TrophySoundTimeline {
  /** When the charge starts, and how long it lasts. */
  charge: number;
  chargeFor: number;
  /** Turns of the release spin, and how long it takes. */
  turns: number;
  spinFor: number;
  /** 0 bronze … 3 platinum. */
  level: number;
}

const MASTER = 0.5;
const E5 = 659.25;
const B5 = 987.77;
const PENTA = [1, 1.125, 1.25, 1.5, 1.6875, 2, 2.25, 2.5, 3, 3.375];

let shared: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
  shared ??= new window.AudioContext();
  if (shared.state === "suspended") void shared.resume().catch(() => {});
  return shared;
}

/** One playback's voice set, all routed through a bus that can be faded out. */
function voices(ac: AudioContext) {
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 5;
  const bus = ac.createGain();
  bus.gain.value = MASTER;
  bus.connect(comp).connect(ac.destination);
  // A short synthetic room so bells ring instead of clicking off.
  const verb = ac.createConvolver();
  const len = Math.floor(ac.sampleRate * 2.2);
  const ir = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  verb.buffer = ir;
  const wet = ac.createGain();
  wet.gain.value = 0.35;
  verb.connect(wet).connect(bus);
  const noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const t0 = ac.currentTime + 0.02;

  const out = (pan = 0, reverb = false): AudioNode => {
    const p = ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(bus);
    if (reverb) p.connect(verb);
    return p;
  };
  const env = (param: AudioParam, at: number, a: number, peak: number, d: number): void => {
    param.setValueAtTime(0.0001, at);
    param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + a);
    param.exponentialRampToValueAtTime(0.0001, at + a + d);
  };
  const tone = (o: {
    f: number;
    f2?: number;
    glide?: number;
    t?: number;
    a?: number;
    d?: number;
    g?: number;
    type?: OscillatorType;
    pan?: number;
    wet?: boolean;
  }): void => {
    const at = t0 + (o.t ?? 0);
    const a = o.a ?? 0.005;
    const d = o.d ?? 0.3;
    const osc = ac.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.f, at);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, at + (o.glide ?? 0.1));
    const v = ac.createGain();
    env(v.gain, at, a, o.g ?? 0.2, d);
    osc.connect(v).connect(out(o.pan, o.wet));
    osc.start(at);
    osc.stop(at + a + d + 0.05);
  };
  const noise = (o: {
    t?: number;
    d?: number;
    a?: number;
    g?: number;
    type?: BiquadFilterType;
    f1?: number;
    f2?: number;
    q?: number;
    pan?: number;
    wet?: boolean;
  }): void => {
    const at = t0 + (o.t ?? 0);
    const a = o.a ?? 0.01;
    const d = o.d ?? 0.3;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const flt = ac.createBiquadFilter();
    flt.type = o.type ?? "bandpass";
    flt.Q.value = o.q ?? 1;
    flt.frequency.setValueAtTime(o.f1 ?? 800, at);
    if (o.f2) flt.frequency.exponentialRampToValueAtTime(o.f2, at + a + d);
    const v = ac.createGain();
    env(v.gain, at, a, o.g ?? 0.2, d);
    src.connect(flt).connect(v).connect(out(o.pan, o.wet));
    src.start(at, Math.random());
    src.stop(at + a + d + 0.05);
  };
  // Inharmonic partials ring like struck metal.
  const bell = (f: number, t: number, g: number, d: number): void => {
    const partials: ReadonlyArray<readonly [number, number]> = [
      [1, 1],
      [2, 0.45],
      [2.76, 0.3],
      [5.4, 0.14],
      [8.93, 0.06],
    ];
    partials.forEach(([r, amp], i) => {
      tone({ f: f * r, t, a: 0.003, d: d / (1 + i * 0.7), g: g * amp, wet: true });
    });
  };
  const motif = (t: number, level: number): void => {
    bell(E5, t, 0.15, 1.3);
    bell(B5, t + 0.13, 0.17, 1.8);
    if (level >= 1) tone({ f: E5 * 2, t: t + 0.26, d: 1, g: 0.05, type: "triangle", wet: true });
    if (level >= 2) {
      tone({ f: 1661.2, t: t + 0.34, d: 0.8, g: 0.04, type: "triangle", wet: true });
      tone({ f: B5 * 2, t: t + 0.42, d: 1, g: 0.04, type: "triangle", wet: true });
    }
    if (level >= 3) {
      [E5 * 4, 3322.4, B5 * 4].forEach((f, i) => {
        tone({ f, t: t + 0.5 + i * 0.06, d: 0.9, g: 0.018, wet: true });
      });
    }
  };
  const sparkle = (t: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      tone({
        f: 1318.5 * (PENTA[i % PENTA.length] ?? 1),
        t: t + i * 0.045,
        d: 0.3,
        g: 0.024,
        pan: i % 2 ? 0.5 : -0.5,
        wet: true,
      });
    }
  };
  const fade = (): void => {
    bus.gain.cancelScheduledValues(ac.currentTime);
    bus.gain.setValueAtTime(bus.gain.value, ac.currentTime);
    bus.gain.linearRampToValueAtTime(0, ac.currentTime + 0.25);
  };
  return { tone, noise, motif, sparkle, fade };
}

/**
 * Play the unlock. Returns a stop function (fades out) for when the card is
 * dismissed early or the window goes away. `reduced` plays only the motif.
 */
export function playTrophyUnlock(tl: TrophySoundTimeline, reduced: boolean): () => void {
  if (!isSoundEnabled()) return () => {};
  const ac = context();
  if (!ac) return () => {};
  const v = voices(ac);
  const L = tl.level;
  if (reduced) {
    v.motif(0.05, L);
    return v.fade;
  }
  const rel = tl.charge + tl.chargeFor;
  const face = rel + tl.spinFor * 0.72;
  const end = rel + tl.spinFor;
  // Arrival: a whoosh, then the card landing.
  v.noise({ d: 0.18, a: 0.17, g: 0.05, f1: 400, f2: 3200, q: 1.2, pan: 0.6, wet: true });
  v.noise({ t: 0.38, d: 0.09, g: 0.16, type: "lowpass", f1: 1400, f2: 300, a: 0.002, pan: 0.6 });
  // The charge: a rising hum, a quickening arpeggio and crackle.
  v.tone({
    f: 110,
    f2: 220,
    glide: tl.chargeFor,
    t: tl.charge,
    a: tl.chargeFor * 0.9,
    d: 0.06,
    g: 0.04,
    type: "sawtooth",
  });
  v.tone({ f: 55, t: tl.charge, a: tl.chargeFor * 0.9, d: 0.08, g: 0.08 });
  v.noise({
    t: tl.charge,
    d: 0.08,
    a: tl.chargeFor,
    g: 0.06,
    type: "highpass",
    f1: 400,
    f2: 7000,
    wet: true,
  });
  const steps = Math.round(tl.chargeFor / 0.075);
  for (let i = 0; i < steps; i++) {
    const k = i / steps;
    const at = tl.charge + tl.chargeFor * (1 - Math.pow(1 - k, 1.6));
    const f = 329.63 * (PENTA[i % PENTA.length] ?? 1) * (i >= PENTA.length ? 2 : 1);
    v.tone({
      f,
      t: at,
      d: 0.09,
      g: 0.016 + k * 0.02,
      type: "triangle",
      pan: Math.random() * 0.6 - 0.3,
    });
  }
  for (
    let at = tl.charge + 0.2;
    at < rel - 0.05;
    at += 0.09 * (1 - (at - tl.charge) / tl.chargeFor) + 0.015
  ) {
    v.noise({
      t: at,
      d: 0.01 + Math.random() * 0.02,
      g: 0.03 + Math.random() * 0.05,
      type: "highpass",
      f1: 3000 + Math.random() * 4000,
      a: 0.001,
      pan: Math.random() * 1.2 - 0.6,
    });
  }
  // A breath in, then the release: a punch, a crash, a whoosh per turn.
  v.noise({ t: rel - 0.2, a: 0.19, d: 0.01, g: 0.12, type: "lowpass", f1: 600, f2: 7000 });
  v.tone({ f: 160, f2: 42, glide: 0.3, t: rel, d: 0.4, g: 0.45 });
  v.noise({
    t: rel,
    d: 2.2,
    g: 0.08 + L * 0.02,
    type: "highpass",
    f1: 7000,
    f2: 3500,
    a: 0.002,
    wet: true,
  });
  v.tone({ f: 82.41, t: rel, d: 0.9, g: 0.14 });
  for (let i = 0; i < tl.turns + 1; i++) {
    const at = rel + (i * tl.spinFor * 0.7) / (tl.turns + 1);
    v.noise({
      t: at,
      d: 0.11,
      a: 0.11,
      g: 0.05,
      f1: 400,
      f2: 3200,
      q: 1.2,
      pan: i % 2 ? 0.4 : -0.4,
      wet: true,
    });
  }
  v.noise({ t: end - 0.05, d: 0.025, g: 0.2, type: "highpass", f1: 3000, a: 0.001 });
  // The reveal: the trophy motif, with more on top for rarer tiers.
  v.motif(face, L);
  v.sparkle(face + 0.15, 5 + L * 3);
  if (L >= 1)
    for (const f of [329.63, 493.88])
      v.tone({ f, t: face, a: 0.04, d: 0.6, g: 0.03, type: "sawtooth", wet: true });
  if (L >= 2)
    for (const f of [329.63, 415.3, 493.88])
      v.tone({ f, t: face, a: 0.4, d: 1.6, g: 0.02, type: "triangle", wet: true });
  if (L >= 3)
    for (const f of [82.41, 164.81, 246.94])
      v.tone({ f, t: face, a: 0.6, d: 2.2, g: 0.03, type: "triangle", wet: true });
  return v.fade;
}
