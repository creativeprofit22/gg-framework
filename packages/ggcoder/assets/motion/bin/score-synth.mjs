#!/usr/bin/env node
// GG Motion score synth: render a beat-locked music bed and sound effects from
// a small JSON score, fully offline and deterministic (same score + seed =>
// identical audio). No samples, no API keys, no licensing questions.
//
// Usage: node score-synth.mjs <score.json> <out-dir>
// Writes: <out>/music.wav, <out>/sfx.wav (48 kHz stereo PCM) and
//         <out>/tempo-map.json (beat/bar/section/hit times in seconds) so the
//         animation is timed from exactly the grid the audio was built on.
//
// Score shape (all times in seconds unless noted):
// {
//   "bpm": 120, "duration": 20, "seed": 7,
//   "key": "A", "scale": "minor",              // used when chords are omitted
//   "chords": ["Am", "F", "C", "G"],           // one per bar, cycled
//   "style": "pulse",                          // pulse | cinematic | minimal
//   "sections": [{ "name": "intro", "from": 0, "energy": 0.3 }, ...],
//   "hits": [{ "t": 1.5, "sfx": "whoosh" }, { "beat": 16, "sfx": "impact" }, { "bar": 8, "sfx": "riser" }],
//   "beatTimes": [0.51, 1.02, ...],            // optional: measured beats of a supplied song
//   "music": true                              // false => sfx.wav only (e.g. over a supplied song)
// }
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SR = 48000;
const SFX_NAMES = [
  "whoosh", "whoosh-short", "riser", "impact", "sub-drop", "pop", "click", "tick",
  "glitch", "shimmer", "sting", "typing", "swell", "snap",
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------- validation ----------
function validate(raw) {
  if (!raw || typeof raw !== "object") fail("score must be a JSON object");
  const bpm = Number(raw.bpm ?? 120);
  const duration = Number(raw.duration);
  if (!(bpm >= 40 && bpm <= 220)) fail("bpm must be between 40 and 220");
  if (!(duration > 0 && duration <= 900)) fail("duration must be between 0 and 900 seconds");
  const style = raw.style ?? "pulse";
  if (!["pulse", "cinematic", "minimal"].includes(style)) fail(`unknown style: ${style}`);
  const sections = Array.isArray(raw.sections) && raw.sections.length
    ? raw.sections.map((s, i) => {
        const from = Number(s.from);
        const energy = Number(s.energy);
        if (!(from >= 0) || !(energy >= 0 && energy <= 1)) fail(`section ${i}: needs from >= 0 and energy 0..1`);
        return { name: String(s.name ?? `section-${i + 1}`), from, energy };
      }).sort((a, b) => a.from - b.from)
    : [{ name: "main", from: 0, energy: 0.7 }];
  const hits = (Array.isArray(raw.hits) ? raw.hits : []).map((h, i) => {
    if (!SFX_NAMES.includes(h.sfx)) fail(`hit ${i}: unknown sfx "${h.sfx}". Use one of: ${SFX_NAMES.join(", ")}`);
    if (h.t === undefined && h.beat === undefined && h.bar === undefined) fail(`hit ${i}: needs t, beat or bar`);
    const gain = h.gain === undefined ? 1 : Number(h.gain);
    if (!(gain >= 0 && gain <= 2)) fail(`hit ${i}: gain must be 0..2`);
    return { ...h, gain };
  });
  const beatTimes = Array.isArray(raw.beatTimes) ? raw.beatTimes.map(Number).filter((n) => n >= 0).sort((a, b) => a - b) : null;
  return {
    bpm, duration, style, sections, hits, beatTimes,
    seed: Number.isInteger(raw.seed) ? raw.seed : 1,
    key: String(raw.key ?? "A"),
    scale: raw.scale === "major" ? "major" : "minor",
    chords: Array.isArray(raw.chords) && raw.chords.length ? raw.chords.map(String) : null,
    music: raw.music !== false,
  };
}

// ---------- music theory ----------
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function parseRoot(name) {
  const m = /^([A-G])([#b]?)/.exec(name);
  if (!m) fail(`bad chord or key: ${name}`);
  return (NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
}
function chordNotes(name) {
  const root = parseRoot(name);
  const rest = name.replace(/^[A-G][#b]?/, "");
  const minor = /^m(?!aj)/.test(rest);
  const tones = [0, minor ? 3 : 4, 7];
  if (/7/.test(rest)) tones.push(/maj7/.test(rest) ? 11 : 10);
  return { root, tones };
}
function defaultChords(key, scale) {
  const r = parseRoot(key);
  const name = (semi, minor) => `${Object.keys(NOTE).find((k) => NOTE[k] === (r + semi) % 12) ?? "C"}${minor ? "m" : ""}`;
  // i-VI-III-VII (minor) or I-V-vi-IV (major); fall back to the root when a degree is sharp.
  return scale === "minor"
    ? [name(0, true), name(8, false), name(3, false), name(10, false)]
    : [name(0, false), name(7, false), name(9, true), name(5, false)];
}
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// ---------- deterministic noise ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- DSP helpers ----------
function biquad(type, freq, q) {
  let b0, b1, b2, a1, a2, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const set = (f) => {
    const w = (2 * Math.PI * Math.min(Math.max(f, 20), SR * 0.45)) / SR;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + alpha;
    if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = alpha; b1 = 0; b2 = -alpha; }
    b0 /= a0; b1 /= a0; b2 /= a0; a1 = (-2 * c) / a0; a2 = (1 - alpha) / a0;
  };
  set(freq);
  const run = (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
  run.set = set;
  return run;
}

class Bus {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.l = new Float32Array(this.n);
    this.r = new Float32Array(this.n);
  }
  add(start, samples, gain = 1, pan = 0) {
    const s0 = Math.round(start * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < samples.length; i++) {
      const j = s0 + i;
      if (j < 0 || j >= this.n) continue;
      const v = samples[i];
      this.l[j] += v * gl * Math.SQRT2;
      this.r[j] += v * gr * Math.SQRT2;
    }
  }
  addStereo(start, left, right, gain = 1) {
    const s0 = Math.round(start * SR);
    for (let i = 0; i < left.length; i++) {
      const j = s0 + i;
      if (j < 0 || j >= this.n) continue;
      this.l[j] += left[i] * gain;
      this.r[j] += right[i] * gain;
    }
  }
}

const buf = (sec) => new Float32Array(Math.max(1, Math.round(sec * SR)));
const env = (t, attack, decay) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

// ---------- instruments (each returns mono samples) ----------
function kick(punch = 1) {
  const out = buf(0.45);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = 45 + 110 * Math.exp(-t / 0.035);
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.tanh(Math.sin(phase) * 1.6 * punch) * Math.exp(-t / 0.22) + (t < 0.004 ? (1 - t / 0.004) * 0.3 : 0);
  }
  return out;
}
function clap(rand) {
  const out = buf(0.3);
  const bp = biquad("bp", 1300, 1.2);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const burst = t < 0.03 ? Math.exp(-((t % 0.01) / 0.003)) : Math.exp(-(t - 0.03) / 0.09);
    out[i] = bp(rand() * 2 - 1) * burst * 2.2;
  }
  return out;
}
function hat(rand, open = false) {
  const out = buf(open ? 0.25 : 0.06);
  const hp = biquad("hp", 7500, 0.8);
  for (let i = 0; i < out.length; i++) out[i] = hp(rand() * 2 - 1) * Math.exp(-(i / SR) / (open ? 0.09 : 0.018));
  return out;
}
function saw(freq, seconds, cutoff, attack, decay, detune = 0) {
  const out = buf(seconds);
  const lp = biquad("lp", cutoff, 0.9);
  let p1 = 0, p2 = 0.37;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    p1 = (p1 + (freq * (1 + detune)) / SR) % 1;
    p2 = (p2 + (freq * (1 - detune)) / SR) % 1;
    out[i] = lp((p1 * 2 - 1 + (p2 * 2 - 1)) * 0.5) * env(t, attack, decay);
  }
  return out;
}
function sine(f0, f1, seconds, decay, attack = 0.002) {
  const out = buf(seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / (seconds / 4));
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(phase) * env(t, attack, decay);
  }
  return out;
}
function noiseSweep(rand, seconds, fFrom, fTo, shape) {
  const out = buf(seconds);
  const bp = biquad("bp", fFrom, 1.4);
  for (let i = 0; i < out.length; i++) {
    const k = i / out.length;
    if (i % 64 === 0) bp.set(fFrom * (fTo / fFrom) ** k);
    out[i] = bp(rand() * 2 - 1) * shape(k) * 2.4;
  }
  return out;
}

// ---------- sound effects ----------
function sfx(name, rand, beatSec, chord) {
  switch (name) {
    case "whoosh":
      return noiseSweep(rand, 0.7, 300, 5000, (k) => Math.sin(Math.PI * k) ** 2);
    case "whoosh-short":
      return noiseSweep(rand, 0.32, 600, 6000, (k) => Math.sin(Math.PI * k) ** 1.5);
    case "riser": {
      const len = beatSec * 4;
      const n = noiseSweep(rand, len, 200, 9000, (k) => k ** 2.2);
      const tone = sine(110, 440, len, 99, len * 0.9);
      for (let i = 0; i < n.length; i++) n[i] = n[i] * 0.8 + tone[i] * 0.25 * (i / n.length) ** 2;
      return n;
    }
    case "impact": {
      const body = sine(90, 42, 1.4, 0.45);
      const hit = noiseSweep(rand, 0.25, 4000, 300, (k) => Math.exp(-k * 6));
      for (let i = 0; i < hit.length; i++) body[i] += hit[i] * 0.6;
      return body.map((v) => Math.tanh(v * 1.4));
    }
    case "sub-drop":
      return sine(95, 28, 1.2, 0.5);
    case "pop":
      return sine(900, 320, 0.09, 0.03);
    case "click": {
      const out = buf(0.025);
      const hp = biquad("hp", 2500, 0.7);
      for (let i = 0; i < out.length; i++) out[i] = hp(rand() * 2 - 1) * Math.exp(-(i / SR) / 0.004);
      return out;
    }
    case "tick":
      return sine(2400, 2200, 0.04, 0.008);
    case "snap": {
      const out = buf(0.08);
      const bp = biquad("bp", 2200, 3);
      for (let i = 0; i < out.length; i++) out[i] = bp(rand() * 2 - 1) * Math.exp(-(i / SR) / 0.012) * 3;
      return out;
    }
    case "glitch": {
      const out = buf(0.3);
      let hold = 0, v = 0;
      for (let i = 0; i < out.length; i++) {
        if (hold-- <= 0) { hold = Math.floor(rand() * 900) + 60; v = (rand() * 2 - 1) * (rand() < 0.3 ? 0 : 1); }
        out[i] = Math.round(v * 6) / 6 * 0.7;
      }
      return out;
    }
    case "shimmer": {
      const out = buf(1.4);
      chord.tones.forEach((tone, idx) => {
        const note = sine(hz(chord.root + tone + 84), hz(chord.root + tone + 84), 1.4 - idx * 0.08, 0.5);
        const off = Math.round(idx * 0.08 * SR);
        for (let i = 0; i < note.length && i + off < out.length; i++) out[i + off] += note[i] * 0.3;
      });
      return out;
    }
    case "sting": {
      const len = 2.2;
      const out = buf(len);
      for (const tone of chord.tones) {
        const s = saw(hz(chord.root + tone + 48), len, 2600, 0.005, 0.7, 0.004);
        for (let i = 0; i < s.length; i++) out[i] += s[i] * 0.35;
      }
      const body = sfx("impact", rand, beatSec, chord);
      for (let i = 0; i < body.length; i++) out[i] += body[i] * 0.8;
      return out;
    }
    case "swell": {
      const len = beatSec * 2;
      const out = buf(len);
      for (const tone of chord.tones) {
        const s = saw(hz(chord.root + tone + 60), len, 1800, len * 0.95, 0.05, 0.006);
        for (let i = 0; i < s.length; i++) out[i] += s[i] * 0.3;
      }
      return out;
    }
    case "typing": {
      const out = buf(1.2);
      let t = 0;
      while (t < 1.1) {
        const c = sfx("click", rand, beatSec, chord);
        const off = Math.round(t * SR);
        for (let i = 0; i < c.length && off + i < out.length; i++) out[off + i] += c[i] * (0.5 + rand() * 0.5);
        t += 0.06 + rand() * 0.07;
      }
      return out;
    }
    default:
      return fail(`unknown sfx ${name}`);
  }
}

// ---------- arrangement ----------
function render(score) {
  const rand = rng(score.seed);
  const beatSec = 60 / score.bpm;
  const barSec = beatSec * 4;
  const beats = score.beatTimes ?? Array.from({ length: Math.ceil(score.duration / beatSec) + 1 }, (_, i) => i * beatSec);
  const within = (t) => t >= 0 && t < score.duration;
  const beatsIn = beats.filter(within);
  const bars = beatsIn.filter((_, i) => i % 4 === 0);
  const chordNames = score.chords ?? defaultChords(score.key, score.scale);
  const chords = chordNames.map(chordNotes);
  const chordAt = (t) => chords[Math.max(0, bars.filter((b) => b <= t + 1e-6).length - 1) % chords.length];
  const sectionAt = (t) => score.sections.filter((s) => s.from <= t + 1e-6).at(-1) ?? score.sections[0];
  const beatTime = (b) => (b < beats.length ? beats[b] : beats.at(-1) + (b - beats.length + 1) * beatSec);

  const music = new Bus(score.duration + 2.5);
  const effects = new Bus(score.duration + 2.5);
  const pumpCurve = new Float32Array(music.n).fill(1);

  if (score.music) {
    const kickSamples = kick();
    const cinematic = score.style === "cinematic";
    const minimal = score.style === "minimal";
    beatsIn.forEach((t, i) => {
      const e = sectionAt(t).energy;
      const onBar = i % 4 === 0;
      const kickOn = cinematic ? onBar && e >= 0.3 : e >= 0.5 || (e >= 0.2 && i % 2 === 0);
      if (kickOn && !minimal) {
        music.add(t, kickSamples, cinematic ? 0.9 : 0.75);
        const s0 = Math.round(t * SR);
        for (let k = 0; k < 0.25 * SR && s0 + k < pumpCurve.length; k++) {
          pumpCurve[s0 + k] = Math.min(pumpCurve[s0 + k], 0.45 + 0.55 * (k / (0.25 * SR)) ** 0.6);
        }
      }
      if (!cinematic && !minimal && e >= 0.6 && i % 2 === 1) music.add(t, clap(rand), 0.32, 0.05);
      if (!cinematic && e >= 0.4) {
        music.add(t + beatSec / 2, hat(rand), 0.12, 0.3);
        if (e >= 0.85) {
          music.add(t + beatSec / 4, hat(rand), 0.06, -0.3);
          music.add(t + (3 * beatSec) / 4, hat(rand), 0.06, -0.3);
        }
      }
      if (minimal && e > 0) music.add(t, sfx("tick", rand, beatSec, chordAt(t)), 0.05 + 0.08 * e, i % 2 ? 0.4 : -0.4);
    });

    // Bass on eighths (pulse) or held roots (cinematic), following the bar's chord.
    const bassBus = new Bus(score.duration + 2.5);
    for (const t of beatsIn) {
      const e = sectionAt(t).energy;
      if (e < 0.35 || minimal) continue;
      const c = chordAt(t);
      const f = hz(c.root + 36);
      if (cinematic) {
        if (bars.includes(t)) bassBus.add(t, saw(f, barSec, 380, 0.02, barSec * 0.6), 0.5);
      } else {
        for (const off of [0, beatSec / 2]) bassBus.add(t + off, saw(f, beatSec / 2, 300 + 900 * e, 0.004, 0.12), 0.42);
      }
    }
    // Pads: one chord per bar, slow attack; brighter with energy.
    for (const t of bars) {
      const e = sectionAt(t).energy;
      if (e <= 0) continue;
      const c = chordAt(t);
      const len = barSec * 1.05;
      const left = new Float32Array(Math.round(len * SR));
      const right = new Float32Array(left.length);
      c.tones.forEach((tone, idx) => {
        const note = saw(hz(c.root + tone + 60), len, 700 + 2200 * e, barSec * 0.35, barSec * 0.9, 0.006 + idx * 0.002);
        for (let i = 0; i < note.length && i < left.length; i++) {
          left[i] += note[i] * (idx % 2 ? 0.7 : 1);
          right[i] += note[i] * (idx % 2 ? 1 : 0.7);
        }
      });
      music.addStereo(t, left, right, (minimal ? 0.16 : 0.11) * (0.5 + e));
    }
    // Sidechain pump on bass + pads gives the bed its "breathing" motion.
    for (let i = 0; i < music.n; i++) {
      const p = pumpCurve[i];
      music.l[i] = music.l[i] * (0.35 + 0.65 * p) + bassBus.l[i] * p;
      music.r[i] = music.r[i] * (0.35 + 0.65 * p) + bassBus.r[i] * p;
    }

    // Automatic transitions: a riser into, and an impact on, every big energy jump.
    score.sections.forEach((s, i) => {
      if (i === 0) return;
      const prev = score.sections[i - 1];
      if (s.energy - prev.energy >= 0.35 && s.from >= barSec) {
        const riser = sfx("riser", rand, beatSec, chordAt(s.from));
        effects.add(s.from - riser.length / SR, riser, 0.35);
        effects.add(s.from, sfx("impact", rand, beatSec, chordAt(s.from)), 0.55);
      }
    });
  }

  // Explicit hits, resolved to seconds on the same grid.
  const resolvedHits = score.hits.map((h, i) => {
    const t = h.t !== undefined ? Number(h.t) : h.beat !== undefined ? beatTime(Number(h.beat)) : beatTime(Number(h.bar) * 4);
    if (!(t >= 0)) fail(`hit ${i}: resolved to an invalid time`);
    const samples = sfx(h.sfx, rand, beatSec, chordAt(t));
    // A riser/swell placed at t should *arrive* at t.
    const start = h.sfx === "riser" || h.sfx === "swell" ? t - samples.length / SR : t;
    const pan = typeof h.pan === "number" ? Math.max(-1, Math.min(1, h.pan)) : h.sfx.startsWith("whoosh") ? (i % 2 ? 0.35 : -0.35) : 0;
    const base = { impact: 0.6, sting: 0.6, "sub-drop": 0.6, riser: 0.4, whoosh: 0.4, "whoosh-short": 0.35, glitch: 0.3, shimmer: 0.3, swell: 0.35 }[h.sfx] ?? 0.4;
    effects.add(start, samples, base * h.gain, pan);
    return { t: Number(t.toFixed(4)), sfx: h.sfx };
  });

  return {
    music, effects,
    map: {
      bpm: score.bpm,
      beatSec: Number(beatSec.toFixed(5)),
      barSec: Number(barSec.toFixed(5)),
      duration: score.duration,
      beats: beatsIn.map((t) => Number(t.toFixed(4))),
      bars: bars.map((t) => Number(t.toFixed(4))),
      sections: score.sections.map((s, i) => ({ ...s, to: score.sections[i + 1]?.from ?? score.duration })),
      chords: chordNames,
      hits: resolvedHits,
    },
  };
}

// ---------- mastering + WAV ----------
function master(bus, duration, targetPeak) {
  const n = Math.round(duration * SR);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    bus.l[i] = Math.tanh(bus.l[i] * 1.1);
    bus.r[i] = Math.tanh(bus.r[i] * 1.1);
    peak = Math.max(peak, Math.abs(bus.l[i]), Math.abs(bus.r[i]));
  }
  const g = peak > 0 ? targetPeak / peak : 0;
  const fade = Math.min(n, Math.round(0.03 * SR));
  const out = Buffer.alloc(44 + n * 4);
  out.write("RIFF", 0); out.writeUInt32LE(36 + n * 4, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const f = i >= n - fade ? (n - i) / fade : 1;
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.l[i] * g * f)) * 32767), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, bus.r[i] * g * f)) * 32767), 46 + i * 4);
  }
  return { wav: out, peakDb: peak > 0 ? 20 * Math.log10(targetPeak) : null };
}

const [scoreArg, outArg] = process.argv.slice(2);
if (!scoreArg || !outArg) fail("usage: score-synth.mjs <score.json> <out-dir>");
let raw;
try {
  raw = JSON.parse(await readFile(resolve(scoreArg), "utf8"));
} catch (error) {
  fail(`Could not read score ${scoreArg}: ${error instanceof Error ? error.message : String(error)}`);
}
const score = validate(raw);
const outDir = resolve(outArg);
await mkdir(outDir, { recursive: true });
const { music, effects, map } = render(score);
const written = [];
if (score.music) {
  await writeFile(join(outDir, "music.wav"), master(music, score.duration, 0.79).wav); // ≈ -2 dBFS peak
  written.push("music.wav");
}
if (map.hits.length || score.music) {
  await writeFile(join(outDir, "sfx.wav"), master(effects, score.duration, 0.71).wav); // ≈ -3 dBFS peak
  written.push("sfx.wav");
}
await writeFile(join(outDir, "tempo-map.json"), `${JSON.stringify(map, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, outDir, files: [...written, "tempo-map.json"], bpm: map.bpm, beats: map.beats.length, hits: map.hits.length })}\n`);
