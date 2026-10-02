import * as THREE from 'three';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';

const perlin = new ImprovedNoise();

// Deterministic PRNG so the world is identical on every load.
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const noise3 = (x, y, z) => perlin.noise(x, y, z);

export function fbm(x, z, octaves = 5, seed = 0) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin.noise(x * freq, seed + i * 17.31, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm;
}

export function ridged(x, z, octaves = 5, seed = 100) {
  let amp = 0.5, freq = 1, sum = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin.noise(x * freq, seed + i * 9.7, z * freq));
    n *= n * weight;
    weight = Math.min(Math.max(n * 2, 0), 1);
    sum += n * amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum;
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Seamlessly tiling normal map built from a sum of sine waves with integer
 * frequencies. Used for water ripples and surface micro detail.
 */
export function makeTileableNormalMap({ size = 512, waves = 48, seed = 1, minFreq = 2, maxFreq = 24, strength = 1 } = {}) {
  const rand = mulberry32(seed);
  const ws = [];
  for (let i = 0; i < waves; i++) {
    const f = minFreq + Math.floor(rand() * (maxFreq - minFreq));
    const ang = rand() * Math.PI * 2;
    const kx = Math.round(Math.cos(ang) * f);
    const ky = Math.round(Math.sin(ang) * f);
    if (kx === 0 && ky === 0) continue;
    const amp = 1 / Math.pow(Math.hypot(kx, ky), 1.2);
    ws.push({ kx, ky, amp, ph: rand() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4);
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let dx = 0, dy = 0;
      for (const w of ws) {
        const c = Math.cos(TAU * (w.kx * u + w.ky * v) + w.ph) * w.amp * TAU;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      dx *= strength * 0.02;
      dy *= strength * 0.02;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      data[i + 2] = (inv * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return tex;
}
