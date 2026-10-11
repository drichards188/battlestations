import * as THREE from 'three';
import { globalUniforms, MAX_FLARE_LIGHTS } from './shaderlib.js';

const rr = (a, b) => a + (b - a) * Math.random();
const _v = new THREE.Vector3();

// Japanese night tactics (COMINCH Antiaircraft Action Summary, Oct 1945; USS North Carolina's
// report of 25 Nov 1943): a snooper marks the force's track with float lights on the water, then
// flare planes hang parachute flares beyond the ships so the torpedo planes see them in silhouette.
// We found no figures for the Japanese flares themselves: these are game values.
const PARA = {
  fuze: 4, // falls this long before the candle lights and the parachute opens
  burn: 150, // seconds of light
  sink: 3, // m/s under the parachute
  intensity: 1.5e6, // shader light units: ~1 at 1.2 km, a few times the crescent moon's light
  color: [1.0, 0.96, 0.88], // magnesium: white, a little warm
};
const FLOAT = {
  burn: 420, // "burned brightly for at least half an hour" (BB-55); trimmed for the game
  color: [1.0, 0.8, 0.45],
};
const MAX_SPRITES = 96;

/**
 * Parachute flares and float lights. Each flare is a sprite (core and halo), a smoke trail above
 * it, and while it burns one of MAX_FLARE_LIGHTS analytic lights in globalUniforms that every lit
 * material and the clouds pick up (see shaderlib.js). Float lights only glow.
 */
export class Flares {
  constructor(scene, ocean) {
    this.ocean = ocean;
    this.para = [];
    this.floats = [];
    this.onIgnite = null; // (pos, kind) when a flare lights or a float light hits the water
    this.wind = new THREE.Vector3();

    const q = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = q.index;
    g.setAttribute('position', q.attributes.position);
    const attr = () => new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRITES * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aA = attr();
    this.aB = attr();
    this.aC = attr();
    g.setAttribute('iA', this.aA);
    g.setAttribute('iB', this.aB);
    g.setAttribute('iC', this.aC);
    g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uPixel: { value: 0.0016 }, uFogDensity: { value: 0.00022 } },
      vertexShader: /* glsl */ `
        attribute vec4 iA; // position, size
        attribute vec4 iB; // hdr colour, alpha
        attribute vec4 iC; // kind (0 flare, 1 smoke trail, 2 float light), trail length, seed
        uniform float uPixel;
        uniform float uFogDensity;
        varying vec4 vCol;
        varying vec2 vQ;
        varying float vKind;
        varying float vH;
        void main() {
          vKind = iC.x;
          vQ = position.xy * 2.0;
          vH = 0.0;
          float dist = length(iA.xyz - cameraPosition);
          if (iC.x > 0.5 && iC.x < 1.5) {
            // the flare's own smoke, hanging along the path it has come down, lit from below
            vec3 up = vec3(0.0, 1.0, 0.0);
            vec3 toCam = normalize(cameraPosition - iA.xyz);
            vec3 side = normalize(cross(up, toCam) + vec3(1e-5, 0.0, 0.0));
            float k = position.y + 0.5;
            float w = max(mix(iA.w * 0.5, iA.w * 2.5, k), dist * uPixel * 1.5);
            vec3 world = iA.xyz + up * k * iC.y + side * position.x * w;
            vH = k;
            gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
          } else {
            // never smaller than a few pixels, so a flare far out still reads as a point of light
            float s = max(iA.w, dist * uPixel * (iC.x > 1.5 ? 3.0 : 6.0));
            vec4 mv = viewMatrix * vec4(iA.xyz, 1.0);
            mv.xy += position.xy * s;
            gl_Position = projectionMatrix * mv;
          }
          vCol = iB * exp(-dist * uFogDensity);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec4 vCol;
        varying vec2 vQ;
        varying float vKind;
        varying float vH;
        void main() {
          float a;
          if (vKind < 0.5) {
            float r = length(vQ);
            a = exp(-r * r * 16.0) + exp(-r * 4.5) * 0.08;
            a *= 1.0 - smoothstep(0.75, 1.0, r);
          } else if (vKind < 1.5) {
            a = exp(-vQ.x * vQ.x * 2.5) * exp(-vH * 2.2) * smoothstep(0.0, 0.05, vH);
          } else {
            float r = length(vQ * vec2(1.0, 0.7));
            a = exp(-r * r * 10.0) + exp(-r * 5.0) * 0.1;
            a *= 1.0 - smoothstep(0.8, 1.0, r);
          }
          gl_FragColor = vec4(vCol.rgb * a * vCol.a, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
  }

  clear() {
    this.para.length = 0;
    this.floats.length = 0;
    globalUniforms.uFlareCount.value = 0;
  }

  /** A flare leaves the aircraft. kind: 'para' (parachute flare) or 'float' (float light); color for float markers. */
  drop(pos, vel, kind = 'para', color = null) {
    const f = { pos: pos.clone(), vel: vel.clone(), t: 0, lit: false, seed: Math.random() * 100, top: pos.y };
    if (kind === 'para') {
      f.life = PARA.burn * rr(0.85, 1.1);
      this.para.push(f);
      if (this.para.length > 12) this.para.shift();
    } else {
      f.life = FLOAT.burn * rr(0.8, 1.1);
      f.color = color || FLOAT.color;
      this.floats.push(f);
      if (this.floats.length > 40) this.floats.shift();
    }
  }

  /** Light from parachute flare f at its age (ramps up, flickers, gutters out). */
  strength(f) {
    if (!f.lit) return 0;
    const a = f.t - PARA.fuze;
    const up = Math.min(1, a / 0.8);
    const out = Math.min(1, (f.life - a) / 5);
    const flick = 0.92 + 0.05 * Math.sin(f.t * 23 + f.seed) + 0.03 * Math.sin(f.t * 61 + f.seed * 3);
    return Math.max(0, up * out * flick);
  }

  /**
   * How well lit a point is by the burning parachute flares, about 1 at 1.2 km from a flare at
   * full strength (the shader's scale); what a gunner on deck needs to see an aircraft by.
   */
  lightAt(p) {
    let sum = 0;
    for (const f of this.para) {
      const s = this.strength(f);
      if (s <= 0) continue;
      const d2 = Math.max(160000, f.pos.distanceToSquared(p)); // softened inside 400 m
      sum += s * (1440000 / d2);
    }
    return sum;
  }

  update(dt, camera, pixel) {
    this.mat.uniforms.uPixel.value = pixel;
    const wind = this.wind;
    // parachute flares: fall on the fuze, then light and hang under the canopy
    for (let i = this.para.length - 1; i >= 0; i--) {
      const f = this.para[i];
      f.t += dt;
      if (!f.lit) {
        f.vel.multiplyScalar(Math.exp(-dt * 0.6));
        f.vel.y -= 9.8 * dt;
        f.pos.addScaledVector(f.vel, dt);
        if (f.t >= PARA.fuze) {
          f.lit = true;
          f.top = f.pos.y;
          this.onIgnite?.(f.pos, 'para');
        }
      } else {
        f.vel.lerp(_v.set(wind.x, -PARA.sink, wind.z), 1 - Math.exp(-dt * 1.5));
        f.pos.addScaledVector(f.vel, dt);
      }
      if (f.t - PARA.fuze > f.life || f.pos.y < 1) this.para.splice(i, 1);
    }
    // float lights: fall to the sea, then burn on the water
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.t += dt;
      if (!f.lit) {
        f.vel.multiplyScalar(Math.exp(-dt * 0.4));
        f.vel.y -= 9.8 * dt;
        f.pos.addScaledVector(f.vel, dt);
        const sea = this.ocean.heightAt(f.pos.x, f.pos.z);
        if (f.pos.y <= sea) {
          f.lit = true;
          f.t = 0;
          f.vel.set(wind.x * 0.05, 0, wind.z * 0.05);
          this.onIgnite?.(f.pos, 'float');
        }
      } else {
        f.pos.addScaledVector(f.vel, dt);
        f.pos.y = this.ocean.heightAt(f.pos.x, f.pos.z) + 0.35;
        if (f.t > f.life) this.floats.splice(i, 1);
      }
    }

    // the brightest flares (as seen from here) become the scene's flare lights
    const lit = this.para.filter((f) => f.lit).map((f) => ({ f, s: this.strength(f), d2: Math.max(f.pos.distanceToSquared(camera.position), 1e4) }));
    lit.sort((a, b) => b.s / b.d2 - a.s / a.d2);
    const n = Math.min(lit.length, MAX_FLARE_LIGHTS);
    const U = globalUniforms;
    for (let i = 0; i < n; i++) {
      const { f, s } = lit[i];
      U.uFlarePos.value[i].copy(f.pos);
      U.uFlareCol.value[i].set(PARA.color[0], PARA.color[1], PARA.color[2]).multiplyScalar(PARA.intensity * s);
    }
    U.uFlareCount.value = n;

    // sprites
    const A = this.aA.array, B = this.aB.array, C = this.aC.array;
    let k = 0;
    const put = (x, y, z, size, r, g, b, a, kind, len, seed) => {
      if (k >= MAX_SPRITES) return;
      const o = k * 4;
      A[o] = x; A[o + 1] = y; A[o + 2] = z; A[o + 3] = size;
      B[o] = r; B[o + 1] = g; B[o + 2] = b; B[o + 3] = a;
      C[o] = kind; C[o + 1] = len; C[o + 2] = seed; C[o + 3] = 0;
      k++;
    };
    for (const { f, s } of lit) {
      const c = PARA.color;
      const p = f.pos;
      put(p.x, p.y, p.z, 7, c[0] * 90 * s, c[1] * 90 * s, c[2] * 90 * s, 1, 0, 0, f.seed);
      const len = Math.min(f.top - p.y, 140);
      if (len > 2) put(p.x, p.y + 1, p.z, 5, 0.5 * s, 0.47 * s, 0.42 * s, 1, 1, len, f.seed);
    }
    for (const f of this.floats) {
      if (!f.lit) continue;
      const out = Math.min(1, (f.life - f.t) / 8) * Math.min(1, f.t * 2);
      const fl = (0.8 + 0.2 * Math.sin(f.t * 17 + f.seed) * Math.sin(f.t * 7.3 + f.seed * 2)) * out;
      const c = f.color;
      put(f.pos.x, f.pos.y, f.pos.z, 1.4, c[0] * 18 * fl, c[1] * 18 * fl, c[2] * 18 * fl, 1, 2, 0, f.seed);
    }
    for (const a of [this.aA, this.aB, this.aC]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, k * 4);
      a.needsUpdate = true;
    }
    this.mesh.geometry.instanceCount = k;
    this.mesh.visible = k > 0;
  }

  get burning() {
    return this.para.filter((f) => f.lit).length;
  }
}
