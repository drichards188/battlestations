// Procedural audio for the naval battle: every sound is synthesized at runtime, nothing is
// loaded. Weapons, blasts and water are pre-rendered into sample banks (see the offline
// synthesis section) and played back with per-shot variation; positional one-shots get air
// absorption, a sound-travel delay and direction-only panning (distance gain is computed
// here). World events are queued per frame and only the loudest few become voices; the rest
// feed a low battle rumble.
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const pick = (list) => (list && list.length ? list[Math.floor(Math.random() * list.length)] : null);

const SOUND_SPEED = 343;
const MAX_DELAY = 6;
const MAX_VOICES = 72; // positional one-shots (buffer playback is cheap)
const DIRECT_VOICES = 32; // the player's gun, UI cues and ambience one-shots
const ENGINE_VOICES = 6;
const AUDIBLE = 0.002;
// far small-arms fire is not worth a voice: it only feeds the battle rumble
const MIN_GAIN = { gun: 0.005, mg: 0.01 };

// per-frame caps and minimum spacing (s) for queued world events; close events get triple caps
const CAPS = { gun: 3, bigGun: 2, mg: 1, flak: 3, explosion: 3, splash: 3, hit: 3, whistle: 1, torpedo: 1 };
const GAPS = { gun: 0.02, bigGun: 0.04, mg: 0.05, flak: 0.04, explosion: 0, splash: 0.04, hit: 0.03, whistle: 0.2, torpedo: 0 };

// bank: which sample set; near / mid: distance bands (m) for the near, mid and far renderings
const GUNS = {
  '40mm': { bank: 'b40', ref: 28, level: 0.85, reverb: 0.06, near: 170, mid: 1100 },
  '20mm': { bank: 'b20', ref: 16, level: 0.6, reverb: 0.04, near: 120, mid: 700 },
  '5in': { bank: 'b5', ref: 75, level: 1.1, reverb: 0.16, near: 450, mid: 2000, big: true },
  '16in': { bank: 'b16', ref: 450, level: 1.3, reverb: 0.3, near: 1500, mid: 1500, big: true },
};

// Radial engines: relative loudness, playback rate of the engine loop at cruise and whether
// it has a second, unsynchronized engine (the Betty's twins beat against each other).
const ENGINES = {
  zero: { level: 0.9, rate: 1.0 },
  val: { level: 1, rate: 1.0 },
  kate: { level: 1, rate: 1.0 },
  betty: { level: 1.25, rate: 1.0, twin: true },
  hellcat: { level: 1.1, rate: 1.0 },
};

// D minor: calm pads, the combat ostinato (eighth notes over four bars) and horn notes
const PADS = [
  [38, 50, 53, 57, 62],
  [34, 46, 53, 58, 62],
  [31, 43, 50, 55, 58],
  [33, 45, 52, 57, 61],
];
const OSTINATO = [
  38, 0, 38, 41, 38, 0, 36, 0,
  38, 0, 38, 41, 43, 0, 41, 40,
  38, 0, 38, 41, 38, 0, 45, 0,
  46, 0, 45, 0, 43, 0, 40, 0,
];
const HORN = [57, 60, 62, 64, 65, 67, 69];
const TEMPO = 104;

// ------------------------------------------------------------------ offline synthesis
// Weapon reports, blasts and splashes are rendered once into sample buffers from
// physically motivated layers: a Friedlander blast wave, pitch-dropping body thumps,
// filtered gas noise, modal metal rings, early reflections off deck and superstructure,
// the sea-surface reflection and a rolling echo for distant shots. Playback then only
// needs a buffer source per shot, which keeps hundreds of rounds a second cheap.
const TAU = Math.PI * 2;

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RBJ biquad run in place: 'lp', 'hp' or 'bp' (0 dB peak). */
function biquad(x, sr, type, f, q = 0.707) {
  const w = (TAU * Math.min(f, sr * 0.45)) / sr;
  const cs = Math.cos(w), a = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') {
    b0 = (1 - cs) / 2;
    b1 = 1 - cs;
    b2 = b0;
  } else if (type === 'hp') {
    b0 = (1 + cs) / 2;
    b1 = -(1 + cs);
    b2 = b0;
  } else {
    b0 = a;
    b1 = 0;
    b2 = -a;
  }
  const a0 = 1 + a;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  const c1 = (-2 * cs) / a0, c2 = (1 - a) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - c1 * y1 - c2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return x;
}

/** Low-pass whose cutoff follows f(t), updated every 32 samples. */
function sweepLp(x, sr, f) {
  let y1 = 0, y2 = 0, x1 = 0, x2 = 0, b0 = 0, b1 = 0, b2 = 0, c1 = 0, c2 = 0;
  for (let i = 0; i < x.length; i++) {
    if ((i & 31) === 0) {
      const w = (TAU * Math.min(f(i / sr), sr * 0.45)) / sr;
      const cs = Math.cos(w), a = Math.sin(w) / 1.414;
      const a0 = 1 + a;
      b0 = (1 - cs) / 2 / a0;
      b1 = (1 - cs) / a0;
      b2 = b0;
      c1 = (-2 * cs) / a0;
      c2 = (1 - a) / a0;
    }
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - c1 * y1 - c2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return x;
}

function onePole(x, sr, f) {
  const k = 1 - Math.exp((-TAU * f) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += k * (x[i] - y);
    x[i] = y;
  }
  return x;
}

function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    if (v > p) p = v;
  }
  return p;
}

function normalize(x, to = 1) {
  const p = peak(x);
  if (p > 0) {
    const k = to / p;
    for (let i = 0; i < x.length; i++) x[i] *= k;
  }
  return x;
}

/** White noise shaped by an attack/decay envelope, `dur` seconds long. */
function burst(sr, r, dur, attack, decay) {
  const n = Math.ceil(dur * sr);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = (r() * 2 - 1) * (1 - Math.exp(-t / attack)) * Math.exp(-t / decay);
  }
  return x;
}

/** A filtered noise layer at unit peak. */
function layer(sr, r, { dur, attack = 0.001, decay, type = 'lp', f, q = 0.707, sweep = null }) {
  const x = burst(sr, r, dur, attack, decay);
  if (sweep) sweepLp(x, sr, sweep);
  else biquad(x, sr, type, f, q);
  if (type === 'bp' || type === 'lp') biquad(x, sr, 'hp', 18);
  return normalize(x);
}

function mixInto(dst, src, at, gain, sr) {
  const i0 = Math.round(at * sr);
  const n = Math.min(src.length, dst.length - i0);
  for (let i = 0; i < n; i++) dst[i0 + i] += src[i] * gain;
}

/** Friedlander blast wave: instant (or `rise`) overpressure, positive phase T, then the suction phase. */
function blast(x, sr, at, amp, T, b = 1.6, rise = 0.00006) {
  const i0 = Math.round(at * sr), n = Math.ceil(T * 7 * sr), nr = Math.max(1, Math.round(rise * sr));
  for (let i = 0; i < n && i0 + i < x.length; i++) {
    const t = i / sr;
    let p = (1 - t / T) * Math.exp((-b * t) / T);
    if (i < nr) p *= i / nr;
    x[i0 + i] += amp * p;
  }
}

/** Supersonic N-wave of a passing round. */
function nWave(x, sr, at, amp, T) {
  const i0 = Math.round(at * sr), n = Math.max(2, Math.round(T * sr));
  for (let i = 0; i <= n && i0 + i < x.length; i++) x[i0 + i] += amp * (1 - (2 * i) / n);
}

/** Damped sine whose pitch falls from f0 toward f1 with time constant tau. */
function thump(x, sr, at, f0, f1, tau, amp, decay, attack = 0.0015) {
  const i0 = Math.round(at * sr);
  const n = Math.min(Math.ceil(decay * 7 * sr), x.length - i0);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (TAU * (f1 + (f0 - f1) * Math.exp(-t / tau))) / sr;
    x[i0 + i] += amp * (1 - Math.exp(-t / attack)) * Math.exp(-t / decay) * Math.sin(ph);
  }
}

/** Struck metal: damped inharmonic modes [freq, amp, decay]. */
function modes(x, sr, at, list, r, gain = 1) {
  const i0 = Math.round(at * sr);
  for (const [f, a, d] of list) {
    const n = Math.min(Math.ceil(d * 6 * sr), x.length - i0);
    const ph = r() * TAU, w = (TAU * f) / sr;
    for (let i = 0; i < n; i++) x[i0 + i] += gain * a * Math.exp(-i / sr / d) * Math.sin(ph + w * i);
  }
}

/** Early reflections: low-passed, delayed copies [delay, gain, cutoff]. */
function reflect(dst, src, sr, taps) {
  for (const [d, g, f] of taps) mixInto(dst, onePole(Float32Array.from(src), sr, f), d, g, sr);
}

/** Rolling echo of a distant report off the sea, other hulls and the haze. */
function roll(dst, src, sr, r, { count = 16, t0 = 0.15, t1 = 2, gain = 0.5, f = 600 }) {
  const dark = onePole(Float32Array.from(src), sr, f);
  onePole(dark, sr, f * 0.8);
  for (let k = 0; k < count; k++) {
    const u = Math.pow((k + r()) / count, 1.4);
    const d = t0 + (t1 - t0) * u;
    mixInto(dst, dark, d, gain * Math.exp(-2.6 * u) * (0.45 + 0.55 * r()), sr);
  }
}

function saturate(x, drive) {
  const k = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(drive * x[i]) * k;
  return x;
}

/** Fade the last `sec` out so a buffer never ends on a click. */
function tail(x, sr, sec = 0.05) {
  const n = Math.min(x.length, Math.round(sec * sr));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

const LEFT = [[0.0035, 0.42, 2600], [0.011, 0.28, 1800], [0.019, 0.2, 1500], [0.037, 0.14, 1100], [0.058, 0.09, 900]];
const RIGHT = [[0.0048, 0.4, 2600], [0.0085, 0.3, 1900], [0.023, 0.19, 1400], [0.031, 0.15, 1200], [0.071, 0.08, 800]];

/** Turn a dry near report into a stereo pair with the gun tub, deck and superstructure around it. */
function ship(sr, dry, left = LEFT, right = RIGHT, drive = 1.15) {
  const L = Float32Array.from(dry), R = Float32Array.from(dry);
  reflect(L, dry, sr, left);
  reflect(R, dry, sr, right);
  saturate(normalize(L), drive);
  saturate(normalize(R), drive);
  const k = 0.95 / Math.max(peak(L), peak(R));
  for (let i = 0; i < L.length; i++) {
    L[i] *= k;
    R[i] *= k;
  }
  return [tail(L, sr), tail(R, sr)];
}

/** Distant versions: slower rise, highs gone, the sea reflection and a rolling echo. */
function distant(sr, r, dry, band, { len, roll: rl }) {
  const n = Math.ceil(len * sr);
  const x = new Float32Array(n);
  mixInto(x, dry, 0, 1, sr);
  mixInto(x, dry, 0.004 + r() * 0.008, 0.7, sr);
  roll(x, dry, sr, r, rl);
  if (band === 'far') {
    biquad(x, sr, 'lp', 700, 0.6);
    onePole(x, sr, 1100);
  } else biquad(x, sr, 'lp', 3600, 0.6);
  biquad(x, sr, 'hp', 25);
  return [tail(normalize(x, 0.95), sr, 0.2)];
}

// ---------------------------------------------------------------- weapon recipes

/** 40mm Bofors: the deep "pom", then recoil, the auto-loader and (sometimes) a new clip. */
function bofors(sr, r, band, clip = false) {
  const len = band === 'far' ? 0.5 : 0.62;
  const x = new Float32Array(Math.ceil(len * sr));
  const near = band === 'player' || band === 'near';
  const T = (band === 'far' ? 0.0062 : band === 'mid' ? 0.0042 : 0.0028) * (0.9 + 0.2 * r());
  blast(x, sr, 0, 1, T, 1.6, band === 'far' ? 0.0011 : band === 'mid' ? 0.0003 : 0.00005);
  if (band !== 'far') nWave(x, sr, 0.0003, 0.3, 0.0004);
  // the "pom": a body around 70-170 Hz with a strong second harmonic, over a sub thump
  thump(x, sr, 0, 175 * (0.92 + 0.16 * r()), 96, 0.04, 0.8, 0.075);
  thump(x, sr, 0, 350, 190, 0.03, 0.36, 0.045);
  thump(x, sr, 0, 90, 46, 0.045, 0.22, 0.08);
  mixInto(x, layer(sr, r, { dur: 0.15, attack: 0.002, decay: 0.035, f: 110 }), 0, 0.45, sr); // chest thump
  mixInto(x, layer(sr, r, { dur: 0.25, decay: 0.045, type: 'bp', f: 520, q: 0.8 }), 0, 0.55, sr); // muzzle gas
  mixInto(x, layer(sr, r, { dur: 0.15, decay: 0.03, type: 'bp', f: 1300, q: 0.9 }), 0, 0.25, sr);
  if (band !== 'far') mixInto(x, layer(sr, r, { dur: 0.05, attack: 0.0002, decay: 0.009, type: 'hp', f: 3000 }), 0, 0.3, sr);
  if (near) {
    const k = band === 'player' ? 1 : 0.45;
    // recoil and counter-recoil: steel slamming on steel
    const t1 = 0.052 + 0.012 * r();
    mixInto(x, layer(sr, r, { dur: 0.06, attack: 0.0004, decay: 0.012, type: 'bp', f: 480, q: 1.4 }), t1, 0.45 * k, sr);
    modes(x, sr, t1, [[600 + 60 * r(), 0.2, 0.07], [1470 + 90 * r(), 0.13, 0.05], [2710 + 140 * r(), 0.08, 0.035]], r, k);
    // the loader rams the next round
    const t2 = 0.098 + 0.02 * r();
    mixInto(x, layer(sr, r, { dur: 0.03, attack: 0.0002, decay: 0.005, type: 'hp', f: 2200 }), t2, 0.35 * k, sr);
    modes(x, sr, t2, [[2180 + 150 * r(), 0.09, 0.05], [3450 + 200 * r(), 0.07, 0.04], [5120 + 250 * r(), 0.04, 0.03]], r, k);
    if (clip) {
      // a fresh four-round clip drops into the guides
      for (let i = 0; i < 4; i++) {
        const t = 0.17 + i * 0.016 + r() * 0.008;
        modes(x, sr, t, [[2400 + 900 * r(), 0.05, 0.05], [3900 + 900 * r(), 0.03, 0.03], [1250 + 300 * r(), 0.04, 0.06]], r, k);
        mixInto(x, layer(sr, r, { dur: 0.012, attack: 0.0001, decay: 0.002, type: 'hp', f: 2500 }), t, 0.12 * k, sr);
      }
    }
  }
  return x;
}

/** 20mm Oerlikon: a sharper, lighter "bap" and the blowback bolt slamming home. */
function oerlikon(sr, r, band) {
  const x = new Float32Array(Math.ceil(0.24 * sr));
  const near = band === 'player' || band === 'near';
  const T = (band === 'far' ? 0.0032 : band === 'mid' ? 0.0019 : 0.0012) * (0.9 + 0.2 * r());
  blast(x, sr, 0, 1, T, 1.7, band === 'far' ? 0.0008 : band === 'mid' ? 0.0002 : 0.00004);
  if (band !== 'far') nWave(x, sr, 0.0002, 0.45, 0.0003);
  thump(x, sr, 0, 230 * (0.9 + 0.2 * r()), 90, 0.015, 0.45, 0.035);
  mixInto(x, layer(sr, r, { dur: 0.06, decay: 0.02, type: 'bp', f: 1500, q: 0.8 }), 0, 0.35, sr);
  if (band !== 'far') mixInto(x, layer(sr, r, { dur: 0.03, attack: 0.0001, decay: 0.006, type: 'hp', f: 4000 }), 0, 0.35, sr);
  if (near) {
    const k = band === 'player' ? 1 : 0.5;
    const t1 = 0.03 + 0.01 * r();
    mixInto(x, layer(sr, r, { dur: 0.03, attack: 0.0002, decay: 0.005, type: 'hp', f: 1500 }), t1, 0.32 * k, sr);
    modes(x, sr, t1, [[1850 + 120 * r(), 0.13, 0.03], [3100 + 200 * r(), 0.09, 0.025], [4700 + 300 * r(), 0.05, 0.02]], r, k);
    mixInto(x, layer(sr, r, { dur: 0.05, decay: 0.02, type: 'bp', f: 2500, q: 2 }), 0.05, 0.07 * k, sr); // spring rattle
  }
  return x;
}

/** 5"/38: the slam of the blast, a thump in the chest, the gunhouse ringing and a long rumble. */
function fiveInch(sr, r, band) {
  const x = new Float32Array(Math.ceil((band === 'far' ? 1 : 2.4) * sr));
  const T = (band === 'far' ? 0.02 : band === 'mid' ? 0.013 : 0.009) * (0.9 + 0.2 * r());
  blast(x, sr, 0, 1, T, 1.4, band === 'far' ? 0.003 : band === 'mid' ? 0.0008 : 0.0001);
  if (band !== 'far') nWave(x, sr, 0.0005, 0.35, 0.0006);
  thump(x, sr, 0, 62, 24, 0.08, 0.9, 0.35);
  thump(x, sr, 0, 250, 135, 0.04, 0.5, 0.09); // the slam
  mixInto(x, layer(sr, r, { dur: 1, attack: 0.002, decay: 0.22, f: 300 }), 0, 0.8, sr);
  mixInto(x, layer(sr, r, { dur: 0.4, decay: 0.07, type: 'bp', f: 800, q: 0.6 }), 0, 0.5, sr);
  if (band !== 'far') mixInto(x, layer(sr, r, { dur: 0.06, attack: 0.0002, decay: 0.012, type: 'hp', f: 2500 }), 0, 0.3, sr);
  if (band === 'near') {
    modes(x, sr, 0.004, [[210 + 20 * r(), 0.12, 0.35], [515 + 40 * r(), 0.1, 0.25], [1130 + 80 * r(), 0.07, 0.2], [1980 + 120 * r(), 0.04, 0.12]], r);
    mixInto(x, layer(sr, r, { dur: 2.2, attack: 0.05, decay: 0.7, f: 170 }), 0.03, 0.5, sr);
    roll(x, x.slice(0, Math.round(0.4 * sr)), sr, r, { count: 12, t0: 0.18, t1: 1.6, gain: 0.25, f: 500 });
  }
  return x;
}

/** 16": cannon thunder. */
function sixteenInch(sr, r) {
  const x = new Float32Array(Math.ceil(1.2 * sr));
  blast(x, sr, 0, 1, 0.03 * (0.9 + 0.2 * r()), 1.3, 0.0006);
  thump(x, sr, 0, 42, 15, 0.15, 1, 0.6);
  mixInto(x, layer(sr, r, { dur: 1.2, attack: 0.004, decay: 0.35, f: 220 }), 0, 1, sr);
  return x;
}

/** One volley of a strafing fighter: 7.7 mm cowl guns ripping, now and then the 20 mm wing cannon. */
function strafe(sr, r, cannon) {
  const x = new Float32Array(Math.ceil(0.22 * sr));
  for (let i = 0; i < 4; i++) {
    const t = i * 0.033 + r() * 0.006;
    blast(x, sr, t, 0.55 + 0.25 * r(), 0.0006, 1.8, 0.00003);
    mixInto(x, layer(sr, r, { dur: 0.02, attack: 0.0002, decay: 0.004, type: 'bp', f: 2600, q: 0.9 }), t, 0.2, sr);
  }
  if (cannon) {
    blast(x, sr, 0.012, 1, 0.0016, 1.6, 0.00005);
    thump(x, sr, 0.012, 170, 70, 0.02, 0.45, 0.05);
    blast(x, sr, 0.12, 0.9, 0.0016, 1.6, 0.00005);
    thump(x, sr, 0.12, 170, 70, 0.02, 0.4, 0.05);
  }
  return x;
}

/** 5" VT burst: a sharp crack near, a hollow "whump" further off, fragments whirring away. */
function flakBurst(sr, r) {
  const x = new Float32Array(Math.ceil(0.6 * sr));
  blast(x, sr, 0, 1, 0.0035 * (0.9 + 0.2 * r()), 1.5, 0.00006);
  nWave(x, sr, 0.0002, 0.35, 0.0004);
  thump(x, sr, 0, 150, 62, 0.04, 0.32, 0.14);
  mixInto(x, layer(sr, r, { dur: 0.5, decay: 0.08, type: 'bp', f: 600, q: 0.7 }), 0, 0.45, sr);
  mixInto(x, layer(sr, r, { dur: 0.08, attack: 0.0002, decay: 0.015, type: 'hp', f: 2500 }), 0, 0.3, sr);
  for (let i = 0; i < 5; i++) {
    const t = 0.03 + r() * 0.3;
    const f0 = 1800 + r() * 2500;
    mixInto(x, layer(sr, r, { dur: 0.25, attack: 0.02, decay: 0.06, sweep: (tt) => f0 * Math.exp(-tt * 4) + 300 }), t, 0.05 + 0.06 * r(), sr);
  }
  return x;
}

/** Explosions: an aircraft blowing up, a bomb on deck, a kamikaze or magazine. */
function boom(sr, r, kind) {
  const big = kind === 'huge', bomb = kind === 'bomb';
  const len = big ? 4.5 : bomb ? 3.4 : 2.2;
  const x = new Float32Array(Math.ceil(len * sr));
  const T = (big ? 0.026 : bomb ? 0.016 : 0.005) * (0.9 + 0.2 * r());
  blast(x, sr, 0, 1, T, 1.3, 0.0001);
  thump(x, sr, 0, big ? 40 : bomb ? 52 : 90, big ? 15 : bomb ? 19 : 34, big ? 0.15 : 0.09, 0.95, big ? 0.7 : bomb ? 0.5 : 0.22);
  mixInto(x, layer(sr, r, { dur: len, attack: 0.003, decay: big ? 0.9 : bomb ? 0.6 : 0.3, f: big ? 260 : 400 }), 0, 0.9, sr);
  // burning fuel and the fireball rolling up
  mixInto(x, layer(sr, r, { dur: 1.6, attack: 0.04, decay: 0.45, sweep: (t) => 2200 * Math.exp(-t * 2.2) + 250 }), 0.02, bomb || big ? 0.45 : 0.6, sr);
  // metal debris raining onto steel and into the sea
  const n = big ? 22 : bomb ? 16 : 7;
  for (let i = 0; i < n; i++) {
    const t = 0.2 + Math.pow(r(), 0.7) * (big ? 3 : bomb ? 2.4 : 1.4);
    const f = 500 + r() * 2600;
    modes(x, sr, t, [[f, 0.06, 0.07 + r() * 0.1], [f * 2.31, 0.03, 0.05]], r, 0.5 + r());
    mixInto(x, layer(sr, r, { dur: 0.03, attack: 0.0002, decay: 0.006, type: 'hp', f: 1500 }), t, 0.05 + 0.05 * r(), sr);
  }
  if (bomb || big) {
    mixInto(x, layer(sr, r, { dur: len - 0.3, attack: 0.25, decay: big ? 1.6 : 1.1, f: 140 }), 0.25, 0.5, sr);
    roll(x, x.slice(0, Math.round(0.5 * sr)), sr, r, { count: 14, t0: 0.2, t1: big ? 3.4 : 2.4, gain: 0.3, f: 380 });
  }
  return x;
}

/** Water: a shell spout, or a bomb near-miss column that roars up and rains back down. */
function water(sr, r, big, torpedo = false) {
  if (!big) {
    const x = new Float32Array(Math.ceil(0.9 * sr));
    mixInto(x, layer(sr, r, { dur: 0.04, attack: 0.0002, decay: 0.008, type: 'hp', f: 1200 }), 0, 0.5, sr);
    thump(x, sr, 0, 170, 60, 0.03, 0.4, 0.05);
    mixInto(x, layer(sr, r, { dur: 0.5, attack: 0.01, decay: 0.12, type: 'bp', f: 2400, q: 0.6 }), 0.005, 0.45, sr);
    for (let i = 0; i < 6; i++) {
      // bubbles and droplets: short rising chirps
      const t = 0.05 + r() * 0.5, f0 = 450 + r() * 700;
      const i0 = Math.round(t * sr), m = Math.round(0.03 * sr);
      let ph = 0;
      for (let k = 0; k < m && i0 + k < x.length; k++) {
        ph += (TAU * f0 * (1 + (k / m) * 0.8)) / sr;
        x[i0 + k] += 0.08 * Math.sin(ph) * Math.exp(-k / (0.25 * m));
      }
    }
    return x;
  }
  const len = torpedo ? 6 : 5;
  const x = new Float32Array(Math.ceil(len * sr));
  // the charge detonating under water: a deep, felt thud
  thump(x, sr, 0, torpedo ? 34 : 45, torpedo ? 13 : 18, 0.12, 1, torpedo ? 0.8 : 0.45);
  mixInto(x, layer(sr, r, { dur: 1, attack: 0.004, decay: 0.3, f: 120 }), 0, 0.8, sr);
  if (torpedo) {
    // the hull shudders and groans
    const sh = layer(sr, r, { dur: 1.8, attack: 0.02, decay: 0.55, f: 110 });
    for (let i = 0; i < sh.length; i++) sh[i] *= 0.6 + 0.4 * Math.sin((TAU * 11 * i) / sr);
    mixInto(x, sh, 0.02, 0.7, sr);
    modes(x, sr, 0.05, [[95, 0.12, 1.1], [143, 0.09, 0.9], [217, 0.06, 0.7], [331, 0.04, 0.5]], r);
  }
  // the column roaring up
  const t0 = torpedo ? 0.35 : 0.08;
  mixInto(x, layer(sr, r, { dur: 2.4, attack: 0.18, decay: 0.75, sweep: (t) => 3000 * Math.exp(-t * 0.9) + 500 }), t0, 0.6, sr);
  // tons of water falling back: a dense hiss of droplets in grains
  const rain = new Float32Array(Math.ceil(3.4 * sr));
  for (let i = 0; i < rain.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.6) * Math.exp(-t / 1.5);
    rain[i] = (r() * 2 - 1) * env * (r() < 0.02 ? 3 : 1);
  }
  biquad(rain, sr, 'hp', 650);
  biquad(rain, sr, 'lp', 6000);
  mixInto(x, normalize(rain), t0 + 1.1, 0.32, sr);
  mixInto(x, layer(sr, r, { dur: 2.5, attack: 0.3, decay: 1, f: 300 }), t0 + 1.2, 0.25, sr);
  return x;
}

/** Bullets and splinters striking steel plate, sometimes ricocheting away. */
function steelHit(sr, r) {
  const x = new Float32Array(Math.ceil(0.55 * sr));
  blast(x, sr, 0, 0.7, 0.00025, 2, 0.00002);
  const f = 900 + r() * 1400;
  modes(x, sr, 0, [[f, 0.4, 0.22], [f * 1.59, 0.25, 0.16], [f * 2.14, 0.18, 0.12], [f * 2.65, 0.12, 0.09], [f * 3.91, 0.07, 0.06]], r);
  mixInto(x, layer(sr, r, { dur: 0.02, attack: 0.0001, decay: 0.003, type: 'hp', f: 3500 }), 0, 0.4, sr);
  if (r() < 0.35) {
    // ricochet whining off into the distance
    const i0 = Math.round(0.01 * sr), m = Math.round(0.4 * sr), fs = 3600 + r() * 800;
    let ph = 0;
    for (let k = 0; k < m && i0 + k < x.length; k++) {
      const t = k / sr;
      ph += (TAU * fs * Math.exp(-t * 3.2) * (1 + 0.02 * Math.sin(t * 60))) / sr;
      x[i0 + k] += 0.22 * Math.sin(ph) * Math.exp(-t / 0.18) * Math.min(1, t / 0.01);
    }
  }
  return x;
}

/** Our high-explosive round bursting on an airframe. */
function planeHit(sr, r) {
  const x = new Float32Array(Math.ceil(0.4 * sr));
  blast(x, sr, 0, 1, 0.0011, 1.6, 0.00003);
  mixInto(x, layer(sr, r, { dur: 0.2, attack: 0.0005, decay: 0.05, type: 'bp', f: 1800, q: 0.8 }), 0.002, 0.45, sr);
  modes(x, sr, 0.003, [[680 + 80 * r(), 0.12, 0.06], [1340 + 120 * r(), 0.09, 0.05], [2410 + 200 * r(), 0.06, 0.04]], r);
  return x;
}

/** Spent cases falling to the steel deck: big 40mm brass clangs, small 20mm tinkles. */
function casings(sr, r, small) {
  const x = new Float32Array(Math.ceil(1.1 * sr));
  let t = 0.28 + r() * 0.2;
  const f0 = small ? 2600 + r() * 1200 : 900 + r() * 450;
  let a = 0.5;
  for (let b = 0; b < 4; b++) {
    const ratios = small ? [[1, 1, 0.08], [2.4, 0.5, 0.05], [4.9, 0.25, 0.03]] : [[1, 1, 0.22], [2.73, 0.5, 0.12], [5.1, 0.25, 0.07], [7.4, 0.12, 0.05]];
    modes(x, sr, t, ratios.map(([k, g, d]) => [f0 * k * (0.98 + 0.04 * r()), g * a, d]), r);
    mixInto(x, layer(sr, r, { dur: 0.01, attack: 0.0001, decay: 0.002, type: 'hp', f: 2000 }), t, a * 0.3, sr);
    t += (small ? 0.06 : 0.1) * Math.pow(0.7, b) + r() * 0.03;
    a *= 0.5;
  }
  return x;
}

/** A 2 ms supersonic crack and the whiz of a round passing close by. */
function snap(sr, r) {
  const x = new Float32Array(Math.ceil(0.12 * sr));
  nWave(x, sr, 0, 1, 0.00025 + r() * 0.0002);
  mixInto(x, layer(sr, r, { dur: 0.1, attack: 0.002, decay: 0.025, type: 'bp', f: 3000 + r() * 1500, q: 1.5 }), 0.001, 0.25, sr);
  return x;
}

/**
 * One engine cycle (two crank revolutions) repeated `cycles` times with per-cylinder
 * variation: exhaust pulses in firing order, the propeller's blade-pass harmonics and
 * exhaust turbulence. Every component is periodic in the loop, so it loops without a seam.
 */
function engine(sr, r, { cyl, cycleHz, blades, rough = 0.35 }) {
  const cycles = 12;
  const n = Math.round((sr / cycleHz) * cycles);
  const x = new Float32Array(n);
  const fireHz = cyl * cycleHz;
  const amps = Array.from({ length: cyl }, () => 1 + rough * (r() - 0.5) * 2);
  const pulse = new Float32Array(Math.round(0.006 * sr));
  for (let i = 0; i < pulse.length; i++) {
    const t = i / sr;
    pulse[i] = Math.exp(-t / 0.0013) * (Math.sin(TAU * 430 * t) * 0.8 + (1 - t / 0.0016) * 0.7);
  }
  const total = cyl * cycles;
  for (let k = 0; k < total; k++) {
    const t = (k + (r() - 0.5) * 0.06) / fireHz;
    const i0 = Math.round(t * sr);
    const a = amps[k % cyl] * (0.85 + 0.3 * r());
    for (let i = 0; i < pulse.length; i++) x[(i0 + i + n) % n] += pulse[i] * a * 0.9;
  }
  // propeller: blade-pass and its harmonics, a whole number of periods per loop
  const bpfLoop = Math.round(blades * cycles) / (n / sr);
  for (let h = 1; h <= 9; h++) {
    const a = 0.42 / Math.pow(h, 0.8), ph = r() * TAU, w = (TAU * bpfLoop * h) / sr;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin(ph + w * i);
  }
  // exhaust and slipstream turbulence, made periodic by a circular crossfade
  const m = Math.round(0.02 * sr);
  const turb = new Float32Array(n + m);
  for (let i = 0; i < turb.length; i++) turb[i] = r() * 2 - 1;
  biquad(turb, sr, 'lp', 1400);
  for (let i = 0; i < m; i++) {
    const w = i / m;
    turb[i] = turb[i] * w + turb[n + i] * (1 - w);
  }
  normalize(turb, 0.35);
  for (let i = 0; i < n; i++) x[i] += turb[i] * (0.7 + 0.3 * Math.sin((TAU * bpfLoop * i) / sr));
  biquad(x, sr, 'hp', 25);
  return normalize(x, 0.9);
}

/**
 * Every bank as a list of build tasks [group, key, fn], so start() can render the
 * essentials at once and spread the rest over a few frames. `make(channels, sampleRate)`
 * turns sample arrays into an AudioBuffer. Distances: 'player' / 'near' / 'mid' / 'far'.
 */
function bankTasks(SR, make) {
  const midSR = Math.min(SR, 32000), farSR = 16000;
  const set = (n, seed, fn) => () => Array.from({ length: n }, (_, i) => fn(mulberry(seed + i * 7919)));
  const mono = (sr) => (x) => make([tail(normalize(x, 0.95), sr)], sr);
  const rolls = {
    small: { count: 14, t0: 0.12, t1: 1.6, gain: 0.45, f: 700 },
    big: { count: 18, t0: 0.25, t1: 3.2, gain: 0.55, f: 380 },
  };
  const far = (sr, recipe, len, rl) => (r) => make(distant(sr, r, recipe(r), 'far', { len, roll: rl }), sr);
  const mid = (sr, recipe, len, rl) => (r) => make(distant(sr, r, recipe(r), 'mid', { len, roll: rl }), sr);
  const twentyL = [[0.0025, 0.4, 3000], [0.006, 0.26, 2200], [0.013, 0.16, 1600], [0.045, 0.08, 1000]];
  const twentyR = [[0.0031, 0.38, 3000], [0.0074, 0.25, 2200], [0.017, 0.15, 1500], [0.052, 0.07, 900]];
  // radials: Sakae and Kinsei (14 cylinders), Kasei (Betty), R-2800 (Hellcat, 18 cylinders)
  const eng = (spec, seed) => () => make([engine(22050, mulberry(seed), spec)], 22050);
  return [
    // the essentials, rendered on the first click
    ['b40', 'player', set(6, 11, (r) => make(ship(SR, bofors(SR, r, 'player')), SR))],
    ['b40', 'clip', set(3, 23, (r) => make(ship(SR, bofors(SR, r, 'player', true)), SR))],
    ['b20', 'player', set(6, 61, (r) => make(ship(SR, oerlikon(SR, r, 'player'), twentyL, twentyR, 1.1), SR))],
    ['casing', 'big', set(5, 197, (r) => mono(SR)(casings(SR, r, false)))],
    ['casing', 'small', set(5, 199, (r) => mono(SR)(casings(SR, r, true)))],
    ['engine', 'zero', eng({ cyl: 14, cycleHz: 2500 / 120, blades: 3.5 }, 211)],
    ['engine', 'val', eng({ cyl: 14, cycleHz: 2400 / 120, blades: 3.5, rough: 0.45 }, 223)],
    ['engine', 'kate', eng({ cyl: 14, cycleHz: 2350 / 120, blades: 3.5, rough: 0.4 }, 227)],
    ['engine', 'betty', eng({ cyl: 14, cycleHz: 2450 / 120, blades: 13 / 3, rough: 0.4 }, 229)],
    ['engine', 'hellcat', eng({ cyl: 18, cycleHz: 2700 / 120, blades: 3, rough: 0.25 }, 233)],
    null, // everything after this is rendered over the following frames
    ['b40', 'near', set(5, 31, (r) => mono(SR)(saturate(normalize(bofors(SR, r, 'near')), 1.3)))],
    ['b40', 'mid', set(4, 41, mid(midSR, (r) => bofors(midSR, r, 'mid'), 1.4, rolls.small))],
    ['b40', 'far', set(4, 53, far(farSR, (r) => bofors(farSR, r, 'far'), 2.4, rolls.big))],
    ['b20', 'near', set(4, 71, (r) => mono(SR)(oerlikon(SR, r, 'near')))],
    ['b20', 'mid', set(3, 79, mid(midSR, (r) => oerlikon(midSR, r, 'mid'), 0.9, rolls.small))],
    ['b20', 'far', set(3, 89, far(farSR, (r) => oerlikon(farSR, r, 'far'), 1.6, rolls.small))],
    ['b5', 'player', set(3, 113, (r) => make(ship(SR, fiveInch(SR, r, 'near')), SR))],
    ['b5', 'near', set(4, 97, (r) => mono(midSR)(saturate(normalize(fiveInch(midSR, r, 'near')), 1.4)))],
    ['b5', 'mid', set(3, 101, mid(midSR, (r) => fiveInch(midSR, r, 'mid'), 3, rolls.big))],
    ['b5', 'far', set(3, 109, far(farSR, (r) => fiveInch(farSR, r, 'far'), 4, rolls.big))],
    ['hit', 'steel', set(8, 181, (r) => mono(SR)(steelHit(SR, r)))],
    ['hit', 'plane', set(4, 191, (r) => mono(midSR)(planeHit(midSR, r)))],
    ['hit', 'snap', set(5, 193, (r) => mono(SR)(snap(SR, r)))],
    ['mg', 'near', set(4, 127, (r) => mono(midSR)(strafe(midSR, r, r() < 0.5)))],
    ['mg', 'far', set(3, 131, mid(midSR, (r) => strafe(midSR, r, r() < 0.5), 0.9, rolls.small))],
    ['flak', 'near', set(4, 137, (r) => mono(midSR)(flakBurst(midSR, r)))],
    ['flak', 'far', set(4, 139, far(farSR, (r) => flakBurst(farSR, r), 2.2, rolls.small))],
    ['boom', 'air', set(3, 149, (r) => mono(midSR)(boom(midSR, r, 'air')))],
    ['boom', 'bomb', set(3, 151, (r) => mono(midSR)(boom(midSR, r, 'bomb')))],
    ['boom', 'huge', set(2, 157, (r) => mono(24000)(boom(24000, r, 'huge')))],
    ['boom', 'far', set(3, 163, far(farSR, (r) => boom(farSR, r, 'bomb'), 5, rolls.big))],
    ['splash', 'small', set(5, 167, (r) => mono(midSR)(water(midSR, r, false)))],
    ['splash', 'big', set(3, 173, (r) => mono(22050)(water(22050, r, true)))],
    ['splash', 'torpedo', set(2, 179, (r) => mono(22050)(water(22050, r, true, true)))],
    ['b16', 'near', set(2, 113, (r) => make(distant(midSR, r, sixteenInch(midSR, r), 'mid', { len: 4, roll: { ...rolls.big, gain: 0.7 } }), midSR))],
    ['b16', 'far', set(1, 119, far(farSR, (r) => sixteenInch(farSR, r), 5, { ...rolls.big, t1: 4.5, gain: 0.7 }))],
  ];
}


export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.musicVolume = 0.5;
    this.muted = false;
    this.state = { wind: 1, rain: 0, combat: 0, raid: false, shipSpeed: 10, deafen: 0, zoom: false, drive: -1 };
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this.listenerVel = { x: 0, y: 0, z: 0 };
    this.lastPos = null;
    this.queue = [];
    this.voices = [];
    this.posVoices = 0;
    this.directVoices = 0;
    this.lastPlay = {};
    this.used = {};
    this.whistles = [];
    this.aircraft = [];
    this.engines = [];
    this.bank = {};
    this.pending = [];
    this.bedEnergy = 0;
    this.combat = 0;
    this.intensity = 0;
    this.barrel = 0;
    this.shots = 0;
    this.lastKind = '40mm';
    this.throttle = {};
    this.nextSlap = 0;
    this.nextThump = 0;
    this.nextPad = 0;
    this.padIndex = 0;
    this.nextHorn = 8;
    this.nextStep = 0;
    this.stepIndex = 0;
  }

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    // mix -> deafness low-pass -> master volume -> compressor -> out
    this.mix = ctx.createGain();
    this.deafLp = ctx.createBiquadFilter();
    this.deafLp.type = 'lowpass';
    this.deafLp.frequency.value = 20000;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 4;
    comp.attack.value = 0.006;
    comp.release.value = 0.12;
    // a brickwall stage and a soft clip so coinciding blasts never hard-clip the output
    const wall = ctx.createDynamicsCompressor();
    wall.threshold.value = -1.5;
    wall.knee.value = 0;
    wall.ratio.value = 20;
    wall.attack.value = 0.001;
    wall.release.value = 0.05;
    const soft = ctx.createWaveShaper();
    const sc = new Float32Array(2049);
    for (let k = 0; k < sc.length; k++) {
      const x = (k / (sc.length - 1)) * 2 - 1; // the shaper maps its input range -1..1 onto the curve
      const a = Math.abs(x);
      sc[k] = Math.sign(x) * (a < 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
    }
    soft.curve = sc;
    this.mix.connect(this.deafLp).connect(this.master).connect(comp).connect(wall).connect(soft).connect(ctx.destination);

    // ringing ears after a near blast, not muffled by the deafness filter
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 0;
    this.ringGain.connect(this.master);
    for (const [f, g] of [[3950, 0.7], [4180, 0.3]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(this.ringGain);
      o.start();
    }

    // open sea: a long, sparse tail
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.6, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.7;
    this.reverbSend.connect(this.reverb).connect(this.mix);

    // ambience, engines and music duck under the guns; world sounds duck under big blasts
    this.duckBus = ctx.createGain();
    this.duckBus.connect(this.mix);
    this.sfxDuck = ctx.createGain();
    this.sfxDuck.connect(this.mix);
    const bus = (g, dest = this.mix) => {
      const b = ctx.createGain();
      b.gain.value = g;
      b.connect(dest);
      return b;
    };
    this.amb = bus(1, this.duckBus);
    this.engineBus = bus(0.85, this.duckBus);
    this.music = bus(this.musicVolume * 0.45, this.duckBus);
    this.sfx = bus(1, this.sfxDuck);
    this.blast = bus(1); // a close 5in or bomb: never ducked by itself
    this.stinger = bus(0.6);
    const musicVerb = ctx.createGain();
    musicVerb.gain.value = 0.6;
    this.music.connect(musicVerb).connect(this.reverbSend);

    // the player's gun gets its own fast limiter so sustained fire never clips the mix
    this.near = ctx.createGain();
    this.near.gain.value = 0.95;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.06;
    this.near.connect(lim).connect(this.mix);
    // a late slap off the superstructure (the early reflections are in the samples)
    for (const [t, g, f] of [[0.085, 0.07, 2200], [0.23, 0.035, 1200]]) {
      const d = ctx.createDelay(0.5);
      d.delayTime.value = t;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = f;
      const g2 = ctx.createGain();
      g2.gain.value = g;
      lim.connect(d).connect(lp).connect(g2).connect(this.mix);
    }

    this.white = this.noiseBuffer('white');
    this.brown = this.noiseBuffer('brown');
    this.pink = this.noiseBuffer('pink');

    // render the essential sample banks now, the rest over the next frames
    const make = (chans, sr) => {
      const b = ctx.createBuffer(chans.length, chans[0].length, sr);
      chans.forEach((c, i) => b.copyToChannel(c, i));
      return b;
    };
    const tasks = bankTasks(ctx.sampleRate, make);
    const split = tasks.indexOf(null);
    for (const t of tasks.slice(0, split)) this.runTask(t);
    this.pending = tasks.slice(split + 1);
    this.pump();

    this.buildAmbience();
    this.drone = this.buildDrone();
    this.drive = this.buildDrive();
    this.engineNoise = this.loop(this.white);
    for (let i = 0; i < ENGINE_VOICES; i++) this.engines.push(this.buildEngineVoice(i));
    this.nextPad = ctx.currentTime + 1;
    this.nextStep = ctx.currentTime + 0.1;
  }

  runTask([group, key, fn]) {
    (this.bank[group] ||= {})[key] = fn();
  }

  // one bank per tick so the first seconds never stall
  pump() {
    if (!this.pending.length) return;
    this.runTask(this.pending.shift());
    setTimeout(() => this.pump(), 16);
  }

  buildAmbience() {
    const ctx = this.ctx;
    const chain = (src, nodes, dest) => {
      let n = src;
      for (const x of nodes) n = n.connect(x);
      n.connect(dest);
    };
    const filter = (type, freq, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };

    // swell of the open ocean
    this.washLp = filter('lowpass', 500);
    this.washGain = gain();
    chain(this.loop(this.brown), [this.washLp, this.washGain], this.amb);

    // water rushing along the hull and the bow wave
    this.rushBp = filter('bandpass', 850, 0.6);
    this.rushGain = gain();
    chain(this.loop(this.pink), [this.rushBp, this.rushGain], this.amb);

    this.windFilter = filter('bandpass', 400, 0.7);
    this.windGain = gain();
    chain(this.loop(this.brown), [this.windFilter, this.windGain], this.amb);

    // wind singing in the rigging, stays and wire railings
    this.rigging = [];
    this.rigGain = gain();
    this.rigGain.connect(this.amb);
    for (const [f, g] of [[340, 0.5], [520, 0.35], [870, 0.2]]) {
      const bp = filter('bandpass', f, 22);
      chain(this.loop(this.white), [bp, gain(g)], this.rigGain);
      this.rigging.push({ bp, f, ph: Math.random() * 6 });
    }

    this.rainGain = gain();
    chain(this.loop(this.white), [filter('highpass', 900), filter('lowpass', 7500), this.rainGain], this.amb);
    this.rainLowGain = gain();
    chain(this.loop(this.brown), [filter('lowpass', 350), this.rainLowGain], this.amb);

    // turbines, reduction gears and blowers deep in the hull, with a slow beat
    this.hum = gain(0.05);
    const humLp = filter('lowpass', 170);
    humLp.connect(this.hum).connect(this.amb);
    for (const [f, type, g] of [[36, 'sawtooth', 0.3], [36.45, 'sawtooth', 0.3], [54.3, 'sine', 0.25]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = gain(g);
      o.connect(og).connect(humLp);
      o.start();
    }
    chain(this.loop(this.pink), [filter('bandpass', 240, 2), gain(0.35)], this.hum);

    // low rumble of a battle beyond the horizon
    this.bedGain = gain();
    chain(this.loop(this.brown), [filter('lowpass', 95), this.bedGain], this.amb);
  }

  // the rest of the raid beyond the individually voiced planes: a few engine loops beating
  buildDrone() {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 250;
    const g = ctx.createGain();
    g.gain.value = 0;
    const am = ctx.createGain();
    am.gain.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.37;
    const lg = ctx.createGain();
    lg.gain.value = 0.2;
    lfo.connect(lg).connect(am.gain);
    lfo.start();
    const E = this.bank.engine;
    [['zero', 0.94], ['val', 1.0], ['kate', 1.05], ['zero', 1.11]].forEach(([type, rate]) => {
      const s = this.loop(E[type]);
      s.playbackRate.value = rate;
      const sg = ctx.createGain();
      sg.gain.value = 0.3;
      s.connect(sg).connect(lp);
    });
    lp.connect(am).connect(g).connect(this.engineBus);
    return { lp, gain: g };
  }

  // The quad mount's power drives: electric motors turning hydraulic pumps, running all the time
  // the mount is manned. Training or elevating hard loads them: the motors sag a little under
  // the load and the pumps whine and hiss with the oil flow.
  buildDrive() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const motor = ctx.createOscillator();
    motor.type = 'sawtooth';
    motor.frequency.value = 120; // 60-cycle mains hum
    const pump = ctx.createOscillator();
    pump.type = 'sawtooth';
    pump.frequency.value = 262; // nine pistons at 1,750 rpm
    const mg = ctx.createGain();
    mg.gain.value = 0.2;
    const pg = ctx.createGain();
    pg.gain.value = 0;
    motor.connect(mg).connect(lp);
    pump.connect(pg).connect(lp);
    const hb = ctx.createBiquadFilter();
    hb.type = 'bandpass';
    hb.frequency.value = 2400;
    hb.Q.value = 1.1;
    const hg = ctx.createGain();
    hg.gain.value = 0;
    this.loop(this.pink).connect(hb).connect(hg).connect(out);
    lp.connect(out);
    out.connect(this.near);
    motor.start();
    pump.start();
    return { out, motor, pump, pg, hg };
  }

  // A radial engine voice: the engine loop (and a second one for twins) through a soft
  // saturator, a low shelf for the buffeting of a close pass, the dive scream of the
  // prop tips, a crackle when burning, and a distance low-pass.
  buildEngineVoice(i) {
    const ctx = this.ctx;
    const pre = ctx.createGain();
    pre.gain.value = 0.8;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let k = 0; k < curve.length; k++) {
      const x = (k / (curve.length - 1)) * 2 - 1;
      curve[k] = Math.tanh(1.8 * x) / Math.tanh(1.8);
    }
    shaper.curve = curve;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 140;
    shelf.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.value = 2000;
    pre.connect(shaper).connect(shelf).connect(lp);

    // prop tips going transonic in a steep dive: a harsh rising band of noise and a whine
    const screamBp = ctx.createBiquadFilter();
    screamBp.type = 'bandpass';
    screamBp.Q.value = 3;
    screamBp.frequency.value = 2400;
    const screamG = ctx.createGain();
    screamG.gain.value = 0;
    this.engineNoise.connect(screamBp).connect(screamG).connect(lp);
    const whine = ctx.createOscillator();
    whine.type = 'sawtooth';
    const whineLp = ctx.createBiquadFilter();
    whineLp.type = 'lowpass';
    whineLp.frequency.value = 3000;
    const whineG = ctx.createGain();
    whineG.gain.value = 0;
    whine.connect(whineLp).connect(whineG).connect(lp);
    whine.frequency.value = 500;
    whine.start();

    const crackBp = ctx.createBiquadFilter();
    crackBp.type = 'bandpass';
    crackBp.frequency.value = 1600;
    crackBp.Q.value = 0.8;
    const crackleG = ctx.createGain();
    crackleG.gain.value = 0;
    this.engineNoise.connect(crackBp).connect(crackleG).connect(lp);
    const crackAm = ctx.createOscillator();
    crackAm.type = 'square';
    crackAm.frequency.value = 13;
    const crackDepth = ctx.createGain();
    crackDepth.gain.value = 0;
    crackAm.connect(crackDepth).connect(crackleG.gain);
    crackAm.start();

    const out = ctx.createGain();
    out.gain.value = 0;
    const pan = this.panner(false);
    lp.connect(out).connect(pan).connect(this.engineBus);
    return { id: null, type: null, keep: false, release: false, level: 0, hrtf: false, seed: i * 1.7, pre, srcs: [], shelf, lp, screamBp, screamG, whine, whineG, crackleG, crackDepth, out, pan };
  }

  /** Swap the voice's engine loop when it is handed to an aircraft of another type. */
  setEngineType(v, type) {
    const E = this.bank.engine;
    for (const s of v.srcs) {
      s.src.stop();
      s.src.disconnect();
    }
    v.srcs = [];
    const spec = ENGINES[type] || ENGINES.zero;
    const n = spec.twin ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const src = this.loop(E[type] || E.zero);
      const g = this.ctx.createGain();
      g.gain.value = n > 1 ? 0.6 : 1;
      src.connect(g).connect(v.pre);
      v.srcs.push({ src, detune: k ? 1.013 : 1 });
    }
    v.type = type;
  }

  noiseBuffer(type) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (type === 'brown') {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        } else if (type === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        } else d[i] = w;
      }
    }
    return buf;
  }

  impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  loop(buffer) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.start(0, Math.random() * buffer.duration);
    return s;
  }

  // Direction-only panner: distance attenuation is applied separately.
  panner(hrtf) {
    const p = this.ctx.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 1;
    p.rolloffFactor = 0;
    return p;
  }

  setPannerPos(p, x, y, z, glide = 0) {
    if (p.positionX) {
      if (glide > 0) {
        const now = this.ctx.currentTime;
        p.positionX.setTargetAtTime(x, now, glide);
        p.positionY.setTargetAtTime(y, now, glide);
        p.positionZ.setTargetAtTime(z, now, glide);
      } else {
        p.positionX.value = x;
        p.positionY.value = y;
        p.positionZ.value = z;
      }
    } else p.setPosition(x, y, z);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  setMusicVolume(v) {
    this.musicVolume = v;
    if (this.music) this.music.gain.value = v * 0.45;
  }

  toggleMute() {
    this.muted = !this.muted;
    this.setVolume(this.volume);
    return this.muted;
  }

  /** Pull ambience, engines and music down for a moment (and other world sounds for big blasts). */
  duck(depth, time, sfx = false) {
    const now = this.ctx.currentTime;
    const targets = sfx ? [this.duckBus.gain, this.sfxDuck.gain] : [this.duckBus.gain];
    for (const g of targets) {
      g.cancelScheduledValues(now);
      g.setTargetAtTime(depth, now, 0.004);
      g.setTargetAtTime(1, now + time * 0.25, time * 0.45);
    }
  }

  // ------------------------------------------------------------------ routing

  dist(p) {
    const l = this.listenerPos;
    return Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
  }

  gainAt(d, ref, level) {
    return level * Math.min(1, ref / Math.max(d, 1));
  }

  // air absorbs the highs: distant guns become a dull rumble
  absorb(d) {
    return Math.max(160, 18000 / (1 + d / 110));
  }

  // Out of voices: silence the quietest positional voice if the new sound is clearly louder.
  steal(g) {
    let quiet = null;
    for (const v of this.voices) if (!v.direct && !v.stolen && (!quiet || v.g < quiet.g)) quiet = v;
    if (!quiet || quiet.g > g * 0.5) return false;
    const now = this.ctx.currentTime;
    quiet.out.gain.cancelScheduledValues(now);
    quiet.out.gain.setTargetAtTime(0, now, 0.015);
    quiet.stolen = true;
    quiet.end = now + 0.05;
    this.posVoices--;
    return true;
  }

  /** Positional voice: returns a route to connect sources to, or null when inaudible / out of voices. */
  route(pos, { ref = 20, level = 1, reverb = 0, hrtf = false, delay = true, bus = this.sfx } = {}) {
    const ctx = this.ctx;
    const d = this.dist(pos);
    const g = this.gainAt(d, ref, level);
    if (g < AUDIBLE || (this.posVoices >= MAX_VOICES && !this.steal(g))) {
      this.bedEnergy += g * 0.15;
      return null;
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = this.absorb(d);
    const pan = this.panner(hrtf && d < 150);
    this.setPannerPos(pan, pos.x, pos.y, pos.z);
    const out = ctx.createGain();
    out.gain.value = g;
    lp.connect(pan).connect(out).connect(bus);
    const nodes = [lp, pan, out];
    if (reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      out.connect(send).connect(this.reverbSend);
      nodes.push(send);
    }
    const at = delay ? Math.min(d / SOUND_SPEED, MAX_DELAY) : 0;
    return { dest: lp, out, t0: ctx.currentTime + at + 0.01, d, g, end: 0, nodes, direct: false, stolen: false };
  }

  /** Non-positional voice (the player's gun, UI, ambience one-shots). `force` skips the cap (rare cues). */
  direct({ level = 1, pan = 0, bus = this.near, filter = null, reverb = 0, force = false, at = 0 } = {}) {
    if (this.directVoices >= DIRECT_VOICES && !force) return null;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = level;
    const sp = ctx.createStereoPanner();
    sp.pan.value = pan;
    out.connect(sp).connect(bus);
    const nodes = [out, sp];
    let dest = out;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type;
      f.frequency.value = filter.freq;
      f.Q.value = filter.q ?? 0.7;
      f.connect(out);
      dest = f;
      nodes.push(f);
    }
    if (reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      out.connect(send).connect(this.reverbSend);
      nodes.push(send);
    }
    return { dest, t0: ctx.currentTime + 0.005 + at, d: 0, g: level, end: 0, nodes, direct: true };
  }

  finish(r) {
    if (!r) return;
    this.voices.push(r);
    if (r.direct) this.directVoices++;
    else this.posVoices++;
  }

  reap(now) {
    let j = 0;
    for (const v of this.voices) {
      if (v.end + 0.1 < now) {
        for (const n of v.nodes) n.disconnect();
        if (v.direct) this.directVoices--;
        else if (!v.stolen) this.posVoices--;
      } else this.voices[j++] = v;
    }
    this.voices.length = j;
  }

  enqueue(kind, pos, ref, level, play) {
    const g = this.gainAt(this.dist(pos), ref, level);
    if (g < (MIN_GAIN[kind] ?? AUDIBLE)) {
      this.bedEnergy += g * 0.15;
      return;
    }
    if (this.queue.length < 256) this.queue.push({ kind, g, play });
  }

  flush(now) {
    const q = this.queue;
    if (!q.length) return;
    q.sort((a, b) => b.g - a.g);
    const used = this.used;
    for (const k in used) used[k] = 0;
    for (const e of q) {
      const n = used[e.kind] || 0;
      const close = e.g > 0.15; // close events skip the spacing and get a larger cap
      const cap = (CAPS[e.kind] ?? 2) * (close ? 3 : 1);
      const spaced = close || now - (this.lastPlay[e.kind] || -1) >= (GAPS[e.kind] ?? 0.03);
      // a full pool is handled by route(), which steals the quietest voice for louder sounds
      if (n >= cap || !spaced) {
        this.bedEnergy += e.g * 0.15;
        continue;
      }
      used[e.kind] = n + 1;
      this.lastPlay[e.kind] = now;
      e.play();
    }
    q.length = 0;
  }

  // ------------------------------------------------------------------ sources

  /** Play a pre-rendered sample into a voice. */
  playBuf(r, buf, { at = 0, rate = 1, gain = 1 } = {}) {
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    let node = src;
    if (gain !== 1) {
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      node = g;
      r.nodes.push(g);
    }
    node.connect(r.dest);
    r.nodes.push(src);
    const t0 = r.t0 + at;
    src.start(t0);
    r.end = Math.max(r.end, t0 + buf.duration / rate + 0.02);
  }

  /** Near, mid or far rendering of a sample set for a distance d. */
  variant(set, d, near, mid) {
    if (!set) return null;
    const list = d < near ? set.near || set.mid || set.far : d < mid ? set.mid || set.far || set.near : set.far || set.mid || set.near;
    return list ? pick(list) : null;
  }

  noise(r, { at = 0, dur = 0.1, freq = 1000, sweep = 0, q = 0.7, type = 'bandpass', gain = 0.3, attack = 0.004, buf = this.white }) {
    const ctx = this.ctx;
    const t0 = r.t0 + at;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t0 + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(gain, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(r.dest);
    src.start(t0, Math.random() * 3);
    src.stop(t0 + dur + 0.05);
    r.end = Math.max(r.end, t0 + dur + 0.05);
    return g;
  }

  tone(r, { at = 0, type = 'sine', f0 = 100, f1 = 0, sweep = 0, dur = 0.3, gain = 0.5, attack = 0.003 }) {
    const ctx = this.ctx;
    const t0 = r.t0 + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + (sweep || dur));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(gain, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(r.dest);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    r.end = Math.max(r.end, t0 + dur + 0.05);
    return o;
  }

  // struck metal: a few inharmonic partials
  ring(r, { at = 0, f = 800, dur = 0.4, gain = 0.2, partials = [[1, 1], [2.76, 0.45], [5.4, 0.2]] }) {
    for (const [ratio, amp] of partials) this.tone(r, { at, f0: f * ratio, dur: dur / Math.sqrt(ratio), gain: gain * amp, attack: 0.002 });
  }

  // ------------------------------------------------------------------ weapons

  gun(kind, pos, opts = {}) {
    if (!this.ctx) return;
    if (opts.player) {
      this.playerGun(kind, opts.barrel);
      return;
    }
    if (kind === 'mg') {
      this.strafe(pos);
      return;
    }
    const spec = GUNS[kind] || GUNS['40mm'];
    this.enqueue(spec.big ? 'bigGun' : 'gun', pos, spec.ref, spec.level, () => {
      const d = this.dist(pos);
      const close = spec.big && d < spec.near * 0.6;
      const buf = this.variant(this.bank[spec.bank], d, spec.near, spec.mid);
      if (!buf) return;
      const r = this.route(pos, { ref: spec.ref, level: spec.level, reverb: spec.reverb, hrtf: d < 300, bus: close ? this.blast : this.sfx });
      if (!r) return;
      this.playBuf(r, buf, { rate: 0.95 + Math.random() * 0.1 });
      this.finish(r);
      // a 5in going off next to you swallows everything else for a moment
      if (close) this.duck(0.3 + 0.5 * clamp(d / (spec.near * 0.6), 0, 1), 0.7, true);
    });
  }

  // The player's own mount: the samples carry the barrels, loaders, tub and deck. `barrel` is the
  // gun that fired (0..3 left to right on the quad, 0..1 on the twin) so the report pans with it.
  playerGun(kind, barrel) {
    const B = this.bank;
    const small = kind === '20mm';
    const big = kind === '5in';
    this.lastKind = kind;
    const set = big ? B.b5?.player : small ? B.b20?.player : B.b40?.player;
    if (!set) return;
    this.barrel = barrel ?? (this.barrel + 1) % 4;
    const pan = small || big ? (this.barrel % 2 ? 0.16 : -0.16) : [-0.3, -0.12, 0.1, 0.28][this.barrel % 4];
    const r = this.direct({ level: small ? 0.8 : 1, pan, reverb: big ? 0.14 : 0.07 });
    if (!r) return;
    this.shots++;
    this.playBuf(r, pick(set), { rate: 0.97 + Math.random() * 0.06 });
    this.finish(r);
    // a 5in going off under you swallows everything else for a moment
    if (big) this.duck(0.35, 0.6, true);
    else this.duck(small ? 0.85 : 0.7, small ? 0.08 : 0.14);
  }

  /** A loader drops a full 4-round clip into the guides of gun `barrel` (0..3). */
  clipIn(barrel = 0) {
    if (!this.ctx || this.throttled('clipIn' + barrel, 0.15)) return;
    const pan = [-0.3, -0.12, 0.1, 0.28][barrel % 4];
    const r = this.direct({ level: 0.55, pan });
    if (!r) return;
    this.noise(r, { dur: 0.05, freq: 1800, q: 1.5, gain: 0.35 }); // clip scrapes into the guides
    this.noise(r, { at: 0.07, dur: 0.06, freq: 260, type: 'lowpass', gain: 0.55, buf: this.brown }); // seats on the stack
    this.ring(r, { at: 0.07, f: 1180 + Math.random() * 120, dur: 0.22, gain: 0.05 }); // brass on brass
    this.noise(r, { at: 0.075, dur: 0.025, freq: 3400, type: 'highpass', gain: 0.25 });
    this.finish(r);
  }

  /** The empty clip is stripped off and clatters away. */
  clipOut(barrel = 0) {
    if (!this.ctx || this.throttled('clipOut' + barrel, 0.15)) return;
    const pan = [-0.3, -0.12, 0.1, 0.28][barrel % 4];
    const r = this.direct({ level: 0.4, pan });
    if (!r) return;
    this.noise(r, { dur: 0.03, freq: 2600, q: 2, gain: 0.3 });
    this.ring(r, { f: 760 + Math.random() * 90, dur: 0.18, gain: 0.05, partials: [[1, 1], [2.3, 0.5], [4.1, 0.3]] });
    for (let i = 0; i < 2; i++) this.noise(r, { at: 0.35 + i * 0.12 + Math.random() * 0.05, dur: 0.03, freq: 2200, q: 3, gain: 0.18 }); // hits the deck
    this.finish(r);
  }

  // A strafing fighter's volley; rounds passing close crack before the report arrives.
  strafe(pos) {
    const set = this.bank.mg;
    if (!set) return;
    this.enqueue('mg', pos, 22, 0.6, () => {
      const d = this.dist(pos);
      const r = this.route(pos, { ref: 22, level: 0.6, reverb: 0.05, hrtf: d < 300 });
      if (!r) return;
      this.playBuf(r, pick(d < 450 ? set.near : set.far), { rate: 0.95 + Math.random() * 0.1 });
      this.finish(r);
      const snaps = this.bank.hit?.snap;
      if (snaps && d < 900 && Math.random() < 0.3) {
        const s = this.direct({ level: 0.35 * (1 - d / 900), pan: Math.random() * 1.4 - 0.7, bus: this.sfx, at: d / 780 });
        if (s) {
          this.playBuf(s, pick(snaps), { rate: 0.9 + Math.random() * 0.2 });
          if (Math.random() < 0.5) this.playBuf(s, pick(snaps), { at: 0.03 + Math.random() * 0.05, rate: 0.9 + Math.random() * 0.2, gain: 0.7 });
          this.finish(s);
        }
      }
    });
  }

  flak(pos) {
    if (!this.ctx) return;
    const set = this.bank.flak;
    if (!set) return;
    this.enqueue('flak', pos, 55, 0.95, () => {
      const d = this.dist(pos);
      const r = this.route(pos, { ref: 55, level: 0.95, reverb: 0.25, hrtf: d < 400 });
      if (!r) return;
      this.playBuf(r, pick(d < 700 ? set.near : set.far), { rate: 0.92 + Math.random() * 0.16 });
      this.finish(r);
    });
  }

  explosion(pos, size = 0.5) {
    if (!this.ctx) return;
    const set = this.bank.boom;
    if (!set) return;
    const s = clamp(size, 0, 1);
    const cls = s >= 0.85 ? 'huge' : s >= 0.45 ? 'bomb' : 'air';
    const ref = 40 + 140 * s, level = 0.9 + 0.4 * s;
    this.enqueue('explosion', pos, ref, level, () => {
      const d = this.dist(pos);
      const close = d < 120 + 200 * s;
      const r = this.route(pos, { ref, level, reverb: 0.3, hrtf: d < 400, bus: close ? this.blast : this.sfx });
      if (!r) return;
      const far = d > 900;
      this.playBuf(r, pick(far ? set.far : set[cls]), { rate: (far ? 1.1 - 0.25 * s : 1) * (0.94 + Math.random() * 0.12) });
      this.finish(r);
      if (close) this.duck(0.25, 1 + s, true);
    });
  }

  splash(pos, size = 0.3) {
    if (!this.ctx) return;
    const set = this.bank.splash;
    if (!set) return;
    const s = clamp(size, 0, 1);
    const ref = 15 + 70 * s, level = 0.5 + 0.5 * s;
    this.enqueue('splash', pos, ref, level, () => {
      const r = this.route(pos, { ref, level, reverb: 0.08 });
      if (!r) return;
      if (s <= 0.22) this.playBuf(r, pick(set.small), { rate: (1.2 - s * 1.5) * (0.92 + Math.random() * 0.16) });
      else this.playBuf(r, pick(set.big), { rate: (1.12 - 0.25 * s) * (0.95 + Math.random() * 0.1) });
      this.finish(r);
    });
  }

  whistle(pos, dur = 3) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.whistles = this.whistles.filter((e) => e > now);
    if (this.whistles.length >= 3) return;
    const len = clamp(dur, 1, 7);
    this.enqueue('whistle', pos, 220, 0.6, () => {
      const r = this.route(pos, { ref: 220, level: 0.6, delay: false, hrtf: true });
      if (!r) return;
      const ctx = this.ctx;
      const t0 = r.t0;
      // the bomb's fins and nose: a falling whistle with a second, rougher partial
      for (const [mul, g0, type] of [[1, 0.35, 'sine'], [1.51, 0.08, 'triangle']]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime((2100 + Math.random() * 300) * mul, t0);
        o.frequency.exponentialRampToValueAtTime((620 + Math.random() * 120) * mul, t0 + len);
        const vib = ctx.createOscillator();
        vib.frequency.value = 6 + Math.random() * 2;
        const vg = ctx.createGain();
        vg.gain.value = 14 * mul;
        vib.connect(vg).connect(o.frequency);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(g0 * 0.17, t0 + len * 0.3);
        g.gain.exponentialRampToValueAtTime(g0, t0 + len * 0.97);
        g.gain.linearRampToValueAtTime(0, t0 + len);
        o.connect(g).connect(r.dest);
        o.start(t0);
        vib.start(t0);
        o.stop(t0 + len + 0.05);
        vib.stop(t0 + len + 0.05);
      }
      this.noise(r, { dur: len, freq: 1800, sweep: 600, q: 2.5, gain: 0.14, attack: len * 0.9 });
      r.end = Math.max(r.end, t0 + len + 0.05);
      this.whistles.push(r.end);
      this.finish(r);
    });
  }

  hit(pos, kind = 'plane') {
    if (!this.ctx) return;
    const set = this.bank.hit;
    if (!set) return;
    const steel = kind === 'steel';
    const ref = steel ? 6 : 25, level = steel ? 0.75 : 0.7;
    this.enqueue('hit', pos, ref, level, () => {
      const r = this.route(pos, { ref, level, hrtf: true, reverb: steel ? 0.04 : 0.1 });
      if (!r) return;
      this.playBuf(r, pick(steel ? set.steel : set.plane), { rate: 0.9 + Math.random() * 0.2 });
      this.finish(r);
    });
  }

  torpedoHit(pos) {
    if (!this.ctx) return;
    const set = this.bank.splash;
    if (!set) return;
    this.enqueue('torpedo', pos, 160, 1.2, () => {
      const d = this.dist(pos);
      const close = d < 300;
      const r = this.route(pos, { ref: 160, level: 1.2, reverb: 0.25, bus: close ? this.blast : this.sfx });
      if (!r) return;
      this.playBuf(r, pick(set.torpedo), { rate: 0.95 + Math.random() * 0.1 });
      this.finish(r);
      if (close) this.duck(0.3, 1.5, true);
    });
  }

  // lightning `dist` metres away (weather.js): a rolling peal after the sound-travel delay
  thunder(dist = 1000) {
    if (!this.ctx) return;
    const near = clamp(1 - dist / 1500, 0, 1);
    const r = this.direct({ level: 0.35 + 0.5 * near, pan: Math.random() * 1.2 - 0.6, bus: this.amb, at: Math.min(dist / SOUND_SPEED, 4), force: true });
    if (!r) return;
    if (near > 0.3) this.noise(r, { dur: 0.3, freq: 2500, type: 'highpass', gain: 0.4 * near });
    this.playBuf(r, pick(this.bank.boom?.far || this.bank.b16?.far), { rate: 0.55 + Math.random() * 0.15 });
    this.noise(r, { at: 0.05, dur: 5, freq: 160, type: 'lowpass', gain: 0.6, attack: 0.3, buf: this.brown });
    this.finish(r);
  }

  // ------------------------------------------------------------------ cues

  kill() {
    if (!this.ctx) return;
    const r = this.direct({ level: 0.5, bus: this.near, reverb: 0.25, force: true });
    if (!r) return;
    this.tone(r, { f0: 98, f1: 62, dur: 0.5, gain: 0.6 });
    this.noise(r, { dur: 0.05, freq: 500, type: 'lowpass', gain: 0.3, buf: this.brown });
    this.tone(r, { at: 0.04, type: 'triangle', f0: midi(62), dur: 0.7, gain: 0.12, attack: 0.02 });
    this.tone(r, { at: 0.04, type: 'triangle', f0: midi(69), dur: 0.7, gain: 0.09, attack: 0.02 });
    this.finish(r);
  }

  throttled(name, gap) {
    const now = this.ctx.currentTime;
    if (now - (this.throttle[name] ?? -1) < gap) return true;
    this.throttle[name] = now;
    return false;
  }

  hitMarker() {
    if (!this.ctx || this.throttled('hitMarker', 0.03)) return;
    const r = this.direct({ level: 0.35 });
    if (!r) return;
    this.noise(r, { dur: 0.012, freq: 5000, type: 'highpass', gain: 0.5 });
    this.tone(r, { f0: 2600, dur: 0.035, gain: 0.2 });
    this.finish(r);
  }

  /** Spent brass ringing on the steel deck; `kind` defaults to the gun last fired. */
  casing(kind = this.lastKind) {
    if (!this.ctx || this.throttled('casing', 0.1)) return;
    const set = this.bank.casing;
    if (!set) return;
    const small = kind === '20mm';
    const r = this.direct({ level: small ? 0.22 : 0.3, pan: Math.random() * 1.2 - 0.6 });
    if (!r) return;
    this.playBuf(r, pick(small ? set.small : set.big), { rate: 0.9 + Math.random() * 0.2 });
    this.finish(r);
  }

  overheat() {
    if (!this.ctx || this.throttled('overheat', 1)) return;
    const r = this.direct({ level: 0.6, force: true });
    if (!r) return;
    this.noise(r, { dur: 2.8, freq: 2500, type: 'highpass', gain: 0.35, attack: 0.05 });
    this.noise(r, { dur: 1.5, freq: 6000, q: 1, gain: 0.2, attack: 0.02 });
    for (let i = 0; i < 6; i++) this.noise(r, { at: Math.random() * 2, dur: 0.02, freq: 3000 + Math.random() * 3000, q: 2, gain: 0.15 });
    this.finish(r);
  }

  reload() {
    if (!this.ctx || this.throttled('reload', 0.5)) return;
    const r = this.direct({ level: 0.6, pan: 0.15, force: true });
    if (!r) return;
    this.noise(r, { dur: 0.03, freq: 2800, type: 'highpass', gain: 0.4 }); // latch
    this.noise(r, { at: 0.18, dur: 0.06, freq: 900, q: 3, gain: 0.4 }); // empty drum off
    this.ring(r, { at: 0.18, f: 420, dur: 0.3, gain: 0.08 });
    this.noise(r, { at: 0.75, dur: 0.08, freq: 300, type: 'lowpass', gain: 0.6, buf: this.brown }); // full drum seated
    this.noise(r, { at: 0.76, dur: 0.05, freq: 1500, q: 4, gain: 0.3 });
    this.noise(r, { at: 1.05, dur: 0.04, freq: 2000, type: 'highpass', gain: 0.4 }); // cocking
    this.noise(r, { at: 1.12, dur: 0.05, freq: 700, q: 2, gain: 0.35 });
    this.finish(r);
  }

  cutout() {
    if (!this.ctx || this.throttled('cutout', 0.25)) return;
    const r = this.direct({ level: 0.6, force: true });
    if (!r) return;
    this.noise(r, { dur: 0.12, freq: 180, type: 'lowpass', gain: 0.7, buf: this.brown });
    this.noise(r, { dur: 0.05, freq: 1400, q: 5, gain: 0.3 });
    this.ring(r, { f: 310, dur: 0.35, gain: 0.06 });
    this.finish(r);
  }

  // general quarters: the ship's alarm gong through the 1MC speakers
  alarm() {
    if (!this.ctx || this.throttled('alarm', 4)) return;
    const r = this.direct({ level: 0.5, bus: this.near, filter: { type: 'bandpass', freq: 1100, q: 0.6 }, reverb: 0.35, force: true });
    if (!r) return;
    for (let i = 0; i < 14; i++) {
      this.ring(r, { at: i * 0.36, f: 640, dur: 0.45, gain: 0.5, partials: [[1, 1], [2, 0.5], [2.76, 0.35], [4.1, 0.15]] });
      this.noise(r, { at: i * 0.36, dur: 0.02, freq: 2500, q: 1, gain: 0.2 });
    }
    this.finish(r);
  }

  radio() {
    if (!this.ctx || this.throttled('radio', 0.3)) return;
    const r = this.direct({ level: 0.35, pan: -0.1, filter: { type: 'bandpass', freq: 1800, q: 1.2 }, force: true });
    if (!r) return;
    this.noise(r, { dur: 0.14, freq: 2200, q: 0.3, gain: 0.5, attack: 0.002 });
    this.tone(r, { at: 0.12, type: 'square', f0: 1000, dur: 0.09, gain: 0.08 });
    this.noise(r, { at: 0.22, dur: 0.08, freq: 2200, q: 0.3, gain: 0.3 });
    this.finish(r);
  }

  stationChange() {
    if (!this.ctx || this.throttled('station', 0.3)) return;
    const r = this.direct({ level: 0.55, force: true });
    if (!r) return;
    for (let i = 0; i < 5; i++) {
      this.noise(r, { at: i * 0.17, dur: 0.06, freq: 380, q: 1.2, gain: 0.45 });
      this.noise(r, { at: i * 0.17, dur: 0.015, freq: 2500, type: 'highpass', gain: 0.15 });
    }
    this.noise(r, { at: 0.95, dur: 0.06, freq: 1000, q: 3, gain: 0.3 });
    this.ring(r, { at: 0.95, f: 520, dur: 0.5, gain: 0.08 });
    this.finish(r);
  }

  victory() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + 0.05;
    [0, 0.25, 0.45, 0.6, 0.72, 0.82, 0.9].forEach((t, i) => this.timp(t0 + t, 38, 0.15 + i * 0.03, this.stinger));
    this.timp(t0 + 1, 38, 0.45, this.stinger);
    for (const n of [50, 57, 62, 66, 69]) this.brass(t0 + 1, n, 4.5, 0.07, 0.9, this.stinger, 0.6);
  }

  defeat() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + 0.05;
    this.timp(t0, 38, 0.45, this.stinger);
    this.timp(t0 + 1.6, 33, 0.4, this.stinger);
    for (const n of [38, 45, 50, 53]) this.brass(t0 + 0.2, n, 6, 0.07, 0.35, this.stinger, 2);
    const r = { dest: this.stinger, t0, end: 0 };
    this.ring(r, { f: midi(31), dur: 6, gain: 0.12, partials: [[1, 1], [2.1, 0.5], [2.9, 0.4], [4.3, 0.2]] });
  }

  // ------------------------------------------------------------------ aircraft

  setAircraft(list) {
    this.aircraft = list || [];
  }

  updateEngines(dt, now) {
    const l = this.listenerPos;
    const ranked = this.aircraft.map((p) => ({ p, d: Math.hypot(p.pos.x - l.x, p.pos.y - l.y, p.pos.z - l.z), v: null }));
    ranked.sort((a, b) => a.d - b.d);
    const n = Math.min(ENGINE_VOICES, ranked.length);

    // keep voices on planes that are still among the nearest, give free voices to the rest
    for (const v of this.engines) v.keep = false;
    for (let i = 0; i < n; i++) {
      const v = this.engines.find((e) => e.id === ranked[i].p.id);
      if (v) {
        v.keep = true;
        v.release = false;
        ranked[i].v = v;
      }
    }
    for (let i = 0; i < n; i++) {
      if (ranked[i].v) continue;
      const v = this.engines.find((e) => e.id === null);
      if (!v) break;
      v.id = ranked[i].p.id;
      v.keep = true;
      v.release = false;
      v.fresh = true;
      ranked[i].v = v;
    }
    for (const v of this.engines) {
      if (v.id === null) continue;
      if (!v.keep) v.release = true;
      const w = ranked.find((r) => r.p.id === v.id);
      if (!w) v.release = true;
      const target = w ? this.driveEngine(v, w.p, w.d, now) : 0;
      const g = v.release ? 0 : target;
      v.level += (g - v.level) * (1 - Math.exp(-dt / 0.06));
      v.out.gain.setTargetAtTime(g, now, v.release ? 0.04 : 0.06);
      v.fresh = false;
      // a released voice is free once it has faded out (crossfade without clicks)
      if (v.release && v.level < 0.003) {
        v.id = null;
        v.release = false;
        v.level = 0;
        if (v.hrtf) {
          v.hrtf = false;
          v.pan.panningModel = 'equalpower';
        }
      }
    }

    // the rest of the raid as one droning bed
    let energy = 0, sumD = 0, rest = 0;
    for (let i = n; i < ranked.length; i++) {
      const e = ENGINES[ranked[i].p.type] || ENGINES.zero;
      energy += (e.level * 300) / Math.max(ranked[i].d, 300);
      sumD += ranked[i].d;
      rest++;
    }
    this.drone.gain.gain.setTargetAtTime(Math.min(0.14, 0.05 * energy), now, 0.5);
    this.drone.lp.frequency.setTargetAtTime(rest ? 160 + 900 / (1 + sumD / rest / 900) : 200, now, 0.5);
  }

  driveEngine(v, p, d, now) {
    const e = ENGINES[p.type] || ENGINES.zero;
    if (v.type !== p.type || !v.srcs.length) this.setEngineType(v, p.type);
    const l = this.listenerPos, lv = this.listenerVel;
    const inv = 1 / Math.max(d, 1e-3);
    const dx = (p.pos.x - l.x) * inv, dy = (p.pos.y - l.y) * inv, dz = (p.pos.z - l.z) * inv;
    const vs = p.vel ? p.vel.x * dx + p.vel.y * dy + p.vel.z * dz : 0; // source receding
    const vl = lv.x * dx + lv.y * dy + lv.z * dz; // listener approaching
    const doppler = clamp((SOUND_SPEED + vl) / (SOUND_SPEED + vs), 0.55, 1.9);
    const th = clamp(p.throttle ?? 0.8, 0, 1);
    const dive = clamp(p.dive ?? 0, 0, 1);
    // rpm: cruise, full throttle and an overspeeding prop in a dive
    let rate = e.rate * (0.84 + 0.2 * th + 0.22 * dive) * doppler;
    if (p.burning) rate *= 1 + 0.035 * Math.sin(now * 23 + v.seed); // misfiring

    const fresh = v.fresh;
    const set = (param, val, tc = 0.03) => (fresh ? param.setValueAtTime(val, now) : param.setTargetAtTime(val, now, tc));
    for (const s of v.srcs) set(s.src.playbackRate, rate * s.detune);
    set(v.screamBp.frequency, 2200 * rate + 1600 * dive);
    set(v.whine.frequency, 85 * 6 * rate * (1 + 0.3 * dive));
    set(v.lp.frequency, Math.min(14000, 250 + 9000 / (1 + d / 140)) * (0.7 + 0.3 * th), 0.05);
    v.screamG.gain.setTargetAtTime(0.16 * dive * dive * dive, now, 0.15);
    v.whineG.gain.setTargetAtTime(0.05 * dive * dive + 0.006, now, 0.15);
    // a close pass buffets: the low end swells
    v.shelf.gain.setTargetAtTime(d < 140 ? 10 * (1 - d / 140) : 0, now, 0.05);
    v.crackleG.gain.setTargetAtTime(p.burning ? 0.16 : 0, now, 0.1);
    v.crackDepth.gain.setTargetAtTime(p.burning ? 0.14 : 0, now, 0.1);

    const hrtf = d < 300 && !v.release;
    if (hrtf !== v.hrtf) {
      v.hrtf = hrtf;
      v.pan.panningModel = hrtf ? 'HRTF' : 'equalpower';
    }
    this.setPannerPos(v.pan, p.pos.x, p.pos.y, p.pos.z, fresh ? 0 : 0.02);
    return 0.55 * e.level * (0.55 + 0.45 * th) * Math.min(1, 45 / Math.max(d, 1)) * (1 + 0.6 * dive);
  }

  // ------------------------------------------------------------------ music

  timp(t, note, gain, dest = this.music) {
    const ctx = this.ctx;
    const f = midi(note);
    for (const [ratio, amp, len] of [[1, 1, 1.4], [1.5, 0.35, 0.6], [1.98, 0.2, 0.4]]) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(f * ratio * 1.12, t);
      o.frequency.exponentialRampToValueAtTime(f * ratio, t + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain * amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + len + 0.05);
    }
    this.noise({ dest, t0: t, end: 0 }, { dur: 0.05, freq: 500, type: 'lowpass', gain: gain * 0.5, buf: this.pink });
  }

  snare(t, gain) {
    const r = { dest: this.music, t0: t, end: 0 };
    this.noise(r, { dur: 0.14, freq: 1900, q: 0.8, gain });
    this.tone(r, { type: 'triangle', f0: 185, f1: 160, dur: 0.07, gain: gain * 0.6 });
  }

  // brass-like: detuned saws through a low-pass whose envelope opens on the attack
  brass(t, note, dur, gain, bright = 0.5, dest = this.music, attack = 0.03) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(250, t);
    lp.frequency.linearRampToValueAtTime(250 + 1800 * bright, t + attack + 0.05);
    lp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(gain * 0.7, t + attack, dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    lp.connect(g).connect(dest);
    for (const det of [-6, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(note);
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }


  horn(t, note, dur, gain) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.25);
    g.gain.setValueAtTime(gain, t + dur - 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    lp.connect(g).connect(this.music);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5;
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(12, t + 0.6);
    vib.connect(vg);
    for (const type of ['sawtooth', 'triangle']) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = midi(note);
      vg.connect(o.detune);
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    vib.start(t);
    vib.stop(t + dur + 0.05);
  }

  tremolo(t, note, dur, gain) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lg = ctx.createGain();
    lg.gain.value = 0.5;
    lfo.connect(lg).connect(am.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.4);
    g.gain.setValueAtTime(gain, t + dur - 0.5);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    lp.connect(am).connect(g).connect(this.music);
    for (const det of [-5, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(note);
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }

  pad(notes, dur, gain) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, t0);
    lp.frequency.linearRampToValueAtTime(1000, t0 + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(450, t0 + dur);
    lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    lp.connect(g).connect(this.music);
    for (const n of notes) {
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(n);
        o.detune.value = det;
        const og = ctx.createGain();
        og.gain.value = 0.18 / notes.length;
        o.connect(og).connect(lp);
        o.start(t0);
        o.stop(t0 + dur + 0.1);
      }
    }
  }

  hornPhrase(t) {
    let idx = 2 + Math.floor(Math.random() * 3);
    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const dur = 1.4 + Math.random();
      this.horn(t, HORN[idx], dur, 0.045);
      t += dur * 0.92;
      idx = clamp(idx + Math.floor(Math.random() * 5) - 2, 0, HORN.length - 1);
    }
  }

  combatStep(i, t, k) {
    const s = i % 16, bar = (i >> 4) & 3;
    const kk = clamp((k - 0.15) / 0.85, 0, 1);
    const step = 60 / TEMPO / 4;
    // timpani on the downbeats, pickups as it builds
    if (s === 0) this.timp(t, bar === 3 ? 33 : 38, 0.08 + 0.3 * kk);
    if (s === 8) this.timp(t, 33, 0.05 + 0.25 * kk);
    if (k > 0.45 && (s === 6 || s === 11)) this.timp(t, 38, 0.18 * kk);
    // low brass ostinato
    if (k > 0.35 && s % 2 === 0) {
      const n = OSTINATO[bar * 8 + s / 2];
      if (n) this.brass(t, n, 0.17, 0.09 * kk, 0.3 + 0.5 * kk);
    }
    // snare: backbeat, ghost notes and a roll into every fourth bar
    if (k > 0.55) {
      if (s === 4 || s === 12) this.snare(t, 0.16 * kk);
      else if (Math.random() < (k - 0.55) * 0.8) this.snare(t, 0.05 * kk);
      if (bar === 3 && s >= 12) {
        const g = 0.05 + (s - 12) * 0.03 * kk;
        this.snare(t, g);
        this.snare(t + step / 2, g);
      }
    }
    // high string tremolo at the most intense moments
    if (k > 0.72 && s === 0 && bar % 2 === 0) this.tremolo(t, (i >> 5) & 1 ? 65 : 62, (60 / TEMPO) * 8, 0.035 * kk);
  }

  updateMusic(dt, now) {
    const st = this.state;
    const target = st.raid ? Math.max(0.3, st.combat) : st.combat * 0.3;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt / 3));
    const k = this.intensity;
    if (now >= this.nextPad) {
      this.pad(PADS[this.padIndex++ % PADS.length], 12, 0.05 * (1 - 0.5 * k));
      this.nextPad = now + 9;
    }
    if (k < 0.3 && now >= this.nextHorn) {
      this.hornPhrase(now + 0.5);
      this.nextHorn = now + 16 + Math.random() * 14;
    }
    // sixteenth-note sequencer, scheduled slightly ahead; it keeps time even while silent
    const step = 60 / TEMPO / 4;
    if (this.nextStep < now - 0.2) this.nextStep = now + 0.05;
    while (this.nextStep < now + 0.12) {
      if (k > 0.15) this.combatStep(this.stepIndex, this.nextStep, k);
      this.nextStep += step;
      this.stepIndex = (this.stepIndex + 1) % 64;
    }
  }

  // ------------------------------------------------------------------ per frame

  hullSlap() {
    const r = this.direct({ level: 1, pan: Math.random() * 1.4 - 0.7, bus: this.amb });
    if (!r) return;
    this.noise(r, { dur: 0.25 + Math.random() * 0.2, freq: 380, type: 'lowpass', gain: 0.12 + Math.random() * 0.08, attack: 0.02, buf: this.brown });
    this.noise(r, { at: 0.03, dur: 0.35, freq: 900, q: 1, gain: 0.05, attack: 0.03 });
    this.finish(r);
  }

  // somewhere over the horizon another group is fighting: the far renderings of real guns
  distantThump(k) {
    const B = this.bank;
    const sets = [B.b5?.far, B.b40?.far, B.b40?.far, B.flak?.far, k > 0.6 ? B.boom?.far : null].filter(Boolean);
    if (!sets.length) return;
    const r = this.direct({ level: (0.05 + 0.1 * k * Math.random()) * 0.9, pan: Math.random() * 1.6 - 0.8, bus: this.amb });
    if (!r) return;
    const set = pick(sets);
    const burst = set === B.b40?.far ? 2 + Math.floor(Math.random() * 4) : 1;
    for (let i = 0; i < burst; i++) this.playBuf(r, pick(set), { at: i * (0.12 + Math.random() * 0.04), rate: 0.85 + Math.random() * 0.2 });
    this.finish(r);
  }

  update(dt, camera, s) {
    if (!this.ctx) return;
    if (s) Object.assign(this.state, s);
    if (this.ctx.state !== 'running') {
      this.queue.length = 0;
      return;
    }
    const st = this.state;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // listener pose from the camera's world matrix (the camera may ride on the gun)
    const m = camera.matrixWorld.elements;
    const px = m[12], py = m[13], pz = m[14];
    let fx = -m[8], fy = -m[9], fz = -m[10];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let ux = m[4], uy = m[5], uz = m[6];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = px;
      L.positionY.value = py;
      L.positionZ.value = pz;
      L.forwardX.value = fx;
      L.forwardY.value = fy;
      L.forwardZ.value = fz;
      L.upX.value = ux;
      L.upY.value = uy;
      L.upZ.value = uz;
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
    const lp = this.listenerPos, lv = this.listenerVel;
    if (this.lastPos && dt > 0) {
      const vx = (px - this.lastPos.x) / dt, vy = (py - this.lastPos.y) / dt, vz = (pz - this.lastPos.z) / dt;
      if (Math.hypot(vx, vy, vz) > 80) lv.x = lv.y = lv.z = 0; // teleported (station change)
      else {
        const k = Math.min(1, dt * 5);
        lv.x += (vx - lv.x) * k;
        lv.y += (vy - lv.y) * k;
        lv.z += (vz - lv.z) * k;
      }
    }
    this.lastPos = this.lastPos || {};
    this.lastPos.x = px;
    this.lastPos.y = py;
    this.lastPos.z = pz;
    lp.x = px;
    lp.y = py;
    lp.z = pz;

    this.reap(now);
    this.flush(now);
    this.updateEngines(dt, now);

    // the mount's power drive, when the player is on a power-driven mount (drive >= 0 is its load)
    const dv = this.drive;
    if (dv) {
      const k = Math.max(0, st.drive);
      dv.out.gain.setTargetAtTime(st.drive >= 0 ? 0.045 + 0.08 * k : 0, now, 0.12);
      dv.pg.gain.setTargetAtTime(0.05 + 0.3 * k, now, 0.07);
      dv.hg.gain.setTargetAtTime(0.03 + 0.16 * k, now, 0.07);
      dv.motor.frequency.setTargetAtTime(120 * (1 - 0.03 * k), now, 0.25);
      dv.pump.frequency.setTargetAtTime(262 * (1 - 0.04 * k), now, 0.25);
    }

    // ambience
    this.amb.gain.setTargetAtTime(st.zoom ? 0.75 : 1, now, 0.3);
    const swell = 0.5 + 0.5 * Math.sin(now * 0.55) * Math.sin(now * 0.21 + 1.3);
    this.washGain.gain.setTargetAtTime((0.09 + 0.08 * swell) * (1 + 0.25 * st.wind), now, 0.3);
    this.washLp.frequency.setTargetAtTime(380 + 320 * swell + 80 * st.wind, now, 0.3);
    const speed = clamp(st.shipSpeed / 10, 0, 2);
    this.rushGain.gain.setTargetAtTime(0.045 * speed * (0.75 + 0.25 * swell), now, 0.4);
    this.rushBp.frequency.setTargetAtTime(700 + 300 * swell, now, 0.4);
    if (now > this.nextSlap) {
      this.hullSlap();
      this.nextSlap = now + 1.2 + (Math.random() * 3) / (0.6 + 0.4 * st.wind);
    }
    const gust = 0.5 + 0.5 * Math.sin(now * 0.31) * Math.sin(now * 0.17 + 1);
    this.windGain.gain.setTargetAtTime(0.04 + 0.05 * st.wind * gust, now, 0.3);
    this.windFilter.frequency.setTargetAtTime(250 + gust * 500 * st.wind, now, 0.3);
    // the rigging sings with the apparent wind over the deck (true wind plus our own speed)
    const apparent = 0.4 * st.wind + 0.06 * st.shipSpeed;
    this.rigGain.gain.setTargetAtTime(0.012 * apparent * apparent * (0.4 + 0.6 * gust), now, 0.4);
    for (const rg of this.rigging) rg.bp.frequency.setTargetAtTime(rg.f * (0.85 + 0.25 * gust + 0.05 * Math.sin(now * 0.7 + rg.ph)), now, 0.4);
    this.rainGain.gain.setTargetAtTime(st.rain * 0.22, now, 0.5);
    this.rainLowGain.gain.setTargetAtTime(st.rain * 0.25, now, 0.5);
    this.hum.gain.setTargetAtTime(0.04 + 0.015 * speed, now, 0.5);

    // battle beyond the horizon: smoothed combat plus whatever events were too far to voice
    this.combat += (st.combat - this.combat) * (1 - Math.exp(-dt / 1.5));
    this.bedEnergy *= Math.exp(-dt * 2);
    this.bedGain.gain.setTargetAtTime(Math.min(0.22, 0.1 * this.combat + 0.3 * Math.sqrt(this.bedEnergy)), now, 0.3);
    if (this.combat > 0.05 && now > this.nextThump) {
      this.distantThump(this.combat);
      this.nextThump = now + (0.3 + Math.random() * 1.4) / (0.3 + this.combat);
    }

    // deafness after a near blast: muffled mix and ringing
    const df = clamp(st.deafen || 0, 0, 1);
    const cutoff = df > 0.01 ? 20000 * Math.pow(350 / 20000, Math.pow(df, 0.6)) : 20000;
    this.deafLp.frequency.setTargetAtTime(cutoff, now, 0.08);
    this.ringGain.gain.setTargetAtTime(0.045 * df * df, now, 0.1);

    if (this.musicVolume > 0) this.updateMusic(dt, now);
  }
}
