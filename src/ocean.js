import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { noiseGLSL, patchMaterial } from './shaderlib.js';
import { makeTileableNormalMap, mulberry32 } from './noise.js';

const G = 9.81;
const TAU = Math.PI * 2;
export const MAX_WAKE_SHIPS = 16;
export const MAX_SHALLOWS = 6;

// Trade-wind sea: a long low swell from the east plus a wind sea spread around the wind,
// wavelengths log-spaced, each wave about equally steep so no single train dominates.
function buildWaves() {
  const rand = mulberry32(1944);
  const waves = [];
  const add = (hdg, lambda, amp, chop) => {
    const a = (hdg * Math.PI) / 180;
    const k = TAU / lambda;
    waves.push({ dx: Math.sin(a), dz: -Math.cos(a), k, w: Math.sqrt(G * k), amp, chop, phase: rand() * TAU, lambda });
  };
  add(262, 190, 0.7, 0.8);
  add(248, 132, 0.45, 0.9);
  const n = 22;
  for (let i = 0; i < n; i++) {
    const lambda = 85 * Math.pow(4.2 / 85, i / (n - 1)) * (0.88 + rand() * 0.24);
    const spread = (rand() - 0.5) * 2 * (40 + i * 2.5);
    const k = TAU / lambda;
    const steep = 0.026 + rand() * 0.01;
    add(255 + spread, lambda, steep / k, 1.1 + rand() * 0.4);
  }
  return waves;
}

const f = (v) => v.toFixed(6);

function wavesGLSL(waves) {
  const A = waves.map((w) => `vec4(${f(w.dx)}, ${f(w.dz)}, ${f(w.k)}, ${f(w.w)})`).join(',\n  ');
  const B = waves.map((w) => `vec4(${f(w.amp)}, ${f(w.chop)}, ${f(w.phase)}, ${f(w.lambda)})`).join(',\n  ');
  return /* glsl */ `
const int NWAVES = ${waves.length};
const vec4 WAVE_A[${waves.length}] = vec4[](
  ${A}
);
const vec4 WAVE_B[${waves.length}] = vec4[](
  ${B}
);
uniform float uWaveTime;
uniform float uWaveAmp;

// Gerstner displacement at an undisplaced point; short waves fade out with distance
// where the grid can no longer resolve them.
vec3 oceanDisplace(vec2 p, float dist) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < NWAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    float fade = 1.0 - smoothstep(b.w * 1.8, b.w * 4.5, dist);
    float th = a.z * dot(a.xy, p) - a.w * uWaveTime + b.z;
    float amp = b.x * uWaveAmp * fade;
    d.xz += a.xy * (b.y * amp * cos(th));
    d.y += amp * sin(th);
  }
  return d;
}
`;
}

const fragPars = /* glsl */ `
uniform sampler2D uRipples;
uniform sampler2D uFoamTex;
uniform vec2 uFoamOrigin;
uniform float uFoamExtent;
uniform vec4 uShipA[${MAX_WAKE_SHIPS}];
uniform vec4 uShipB[${MAX_WAKE_SHIPS}];
uniform int uShipCount;
uniform vec4 uShallow[${MAX_SHALLOWS}];
uniform int uShallowCount;
uniform float uWhitecap;
uniform float uPixelAngle;
uniform float uSumAmp;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uAerColor;
uniform vec3 uSSSColor;
uniform float uBiolum;
varying vec3 vOcWorld;
varying vec2 vOcBase;
varying float vOcHeight;
${noiseGLSL}

// Height slopes of the resolved waves; the slope variance of waves too small for the
// pixel footprint goes into the roughness instead, so glints don't alias.
vec2 oceanSlope(vec2 p, float fp, inout float lostVar, out float height) {
  vec2 s = vec2(0.0);
  height = 0.0;
  for (int i = 0; i < NWAVES; i++) {
    vec4 a = WAVE_A[i];
    vec4 b = WAVE_B[i];
    float keep = smoothstep(fp * 2.5, fp * 7.0, b.w);
    float ka = a.z * b.x * uWaveAmp;
    lostVar += (1.0 - keep) * 0.5 * ka * ka;
    float th = a.z * dot(a.xy, p) - a.w * uWaveTime + b.z;
    s += a.xy * (ka * cos(th) * keep);
    height += b.x * uWaveAmp * sin(th) * keep;
  }
  return s;
}

vec2 rippleSlope(vec2 p, float fp, inout float lostVar) {
  vec2 s = vec2(0.0);
  float wind = 0.6 + 0.4 * uWaveAmp;
  // three rotated layers at unrelated scales so the tiles never line up
  const mat2 R1 = mat2(0.866, 0.5, -0.5, 0.866);
  const mat2 R2 = mat2(0.309, -0.951, 0.951, 0.309);
  float k1 = smoothstep(fp * 3.0, fp * 12.0, 13.7 * 0.08);
  float k2 = smoothstep(fp * 3.0, fp * 12.0, 5.3 * 0.08);
  float k3 = smoothstep(fp * 3.0, fp * 12.0, 2.1 * 0.08);
  vec3 n1 = texture2D(uRipples, (R1 * p) / 13.7 + vec2(uWaveTime * 0.013, uWaveTime * 0.006)).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uRipples, (R2 * p) / 5.3 + vec2(-uWaveTime * 0.024, uWaveTime * 0.019)).xyz * 2.0 - 1.0;
  vec3 n3 = texture2D(uRipples, p / 2.1 + vec2(uWaveTime * 0.05, -uWaveTime * 0.041)).xyz * 2.0 - 1.0;
  vec2 g1 = n1.xy / max(n1.z, 0.3), g2 = n2.xy / max(n2.z, 0.3), g3 = n3.xy / max(n3.z, 0.3);
  s -= (g1 * R1) * 0.13 * k1 * wind;
  s -= (g2 * R2) * 0.11 * k2 * wind;
  s -= g3 * 0.08 * k3 * wind;
  lostVar += ((1.0 - k1) * 0.007 + (1.0 - k2) * 0.005 + (1.0 - k3) * 0.003) * wind;
  return s;
}

// Bow waves, the churn along the hull and Kelvin wake arms of every ship nearby.
void shipWakes(vec2 p, inout float foam, inout float aer) {
  for (int i = 0; i < ${MAX_WAKE_SHIPS}; i++) {
    if (i >= uShipCount) break;
    vec4 A = uShipA[i];
    vec4 B = uShipB[i];
    vec2 rel = p - A.xy;
    float reach = B.x * 2.0 + 600.0;
    if (dot(rel, rel) > reach * reach) continue;
    vec2 fwd = vec2(A.z, -A.w);
    vec2 right = vec2(A.w, A.z);
    float a = dot(rel, fwd);
    float s = abs(dot(rel, right));
    float behind = B.x - a;
    if (behind < -8.0) continue;
    float spd = clamp(B.z / 11.0, 0.0, 1.6);
    float u = a / B.x;
    float hb = u > 0.0 ? B.y * (1.0 - pow(min(u, 1.0), 3.0)) : B.y * (1.0 - pow(min(-u, 1.0), 4.0) * 0.5);
    float hull = s - hb;
    if (abs(u) < 1.05) {
      float bowK = smoothstep(0.1, 0.92, u);
      float w = 1.5 + 6.0 * bowK * spd;
      float n = vnoise(p * 0.45 + vec2(0.0, uWaveTime * 1.3));
      float side = (1.0 - smoothstep(0.0, w, hull + n * 1.5)) * step(-1.0, hull);
      foam = max(foam, side * (0.3 + 0.7 * bowK) * spd);
      aer = max(aer, side * 0.6 * spd);
    }
    if (behind > 0.0) {
      float armS = B.y * 0.85 + behind * 0.34;
      float width = 2.0 + behind * 0.06;
      float d = s - armS;
      float fade = exp(-behind / (35.0 + 70.0 * spd)) * spd;
      float arm = exp(-d * d / (width * width));
      // short divergent crests feathering off the arm
      float feather = smoothstep(0.2, 0.9, sin(behind * 0.55 - s * 1.2) * 0.5 + 0.5) * (0.6 + 0.4 * vnoise(p * 0.3));
      foam = max(foam, arm * fade * 0.75 * feather);
      float inside = smoothstep(armS, armS * 0.4, s);
      aer = max(aer, (inside * 0.35 + arm * 0.45) * exp(-behind / (90.0 + 160.0 * spd)) * spd);
    }
  }
}

float shallows(vec2 p, inout float foam) {
  float sh = 0.0;
  for (int i = 0; i < ${MAX_SHALLOWS}; i++) {
    if (i >= uShallowCount) break;
    vec4 I = uShallow[i];
    vec2 rel = p - I.xy;
    float d = length(rel);
    if (d > I.w * 1.3) continue;
    float wob = (vnoise(rel * 0.004 + float(i) * 7.0) - 0.5) * I.w * 0.35;
    float dd = d + wob;
    sh = max(sh, 1.0 - smoothstep(I.z, I.w, dd));
    float reef = exp(-pow((dd - I.w * 0.93) / (I.w * 0.035), 2.0));
    foam = max(foam, reef * smoothstep(0.35, 0.7, vnoise(p * 0.05 + uWaveTime * 0.1)));
  }
  return sh;
}
`;

// envmap lookups that would sample below the horizon reflect the horizon haze instead
const envChunk = THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
  'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );',
  'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );\n\t\t\treflectVec.y = max( reflectVec.y, 0.012 );'
);

// ---------------------------------------------------------------- foam map
// World-space foam around the camera: ships, torpedoes and splashes stamp into it,
// it slowly spreads and decays. r = surface foam, g = aerated (turquoise) water.
class FoamMap {
  constructor(renderer, { size = 2048, extent = 5120, maxStamps = 512 } = {}) {
    this.renderer = renderer;
    this.size = size;
    this.extent = extent;
    this.texel = extent / size;
    const opts = {
      type: THREE.HalfFloatType,
      format: THREE.RGFormat,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    this.rts = [new THREE.WebGLRenderTarget(size, size, opts), new THREE.WebGLRenderTarget(size, size, opts)];
    this.ping = 0;
    this.origin = new THREE.Vector2();
    this.started = false;

    this.decay = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          tPrev: { value: null },
          uShift: { value: new THREE.Vector2() },
          uTexel: { value: 1 / size },
          uKeep: { value: new THREE.Vector2(1, 1) },
          uBlur: { value: 0.1 },
        },
        vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D tPrev;
          uniform vec2 uShift, uKeep;
          uniform float uTexel, uBlur;
          varying vec2 vUv;
          void main() {
            vec2 uv = vUv + uShift;
            vec2 c = texture2D(tPrev, uv).rg;
            vec2 n = texture2D(tPrev, uv + vec2(uTexel, 0.0)).rg + texture2D(tPrev, uv - vec2(uTexel, 0.0)).rg
                   + texture2D(tPrev, uv + vec2(0.0, uTexel)).rg + texture2D(tPrev, uv - vec2(0.0, uTexel)).rg;
            c = mix(c, n * 0.25, uBlur);
            vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
            gl_FragColor = vec4(c * uKeep * inside.x * inside.y, 0.0, 1.0);
          }
        `,
        depthTest: false,
        depthWrite: false,
      })
    );

    // capsule stamps from p0 to p1, max-blended
    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    this.segs = new Float32Array(maxStamps * 4);
    this.pars = new Float32Array(maxStamps * 4);
    this.segAttr = new THREE.InstancedBufferAttribute(this.segs, 4).setUsage(THREE.DynamicDrawUsage);
    this.parAttr = new THREE.InstancedBufferAttribute(this.pars, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSeg', this.segAttr);
    geo.setAttribute('aPar', this.parAttr);
    geo.instanceCount = 0;
    this.maxStamps = maxStamps;
    this.count = 0;
    this.stampMat = new THREE.ShaderMaterial({
      uniforms: { uOrigin: { value: this.origin }, uHalf: { value: extent / 2 } },
      vertexShader: /* glsl */ `
        attribute vec4 aSeg;
        attribute vec4 aPar;
        uniform vec2 uOrigin;
        uniform float uHalf;
        varying vec2 vLocal;
        varying vec4 vPar;
        varying float vHalfLen;
        void main() {
          vec2 a = aSeg.zw - aSeg.xy;
          float len = length(a);
          vec2 dir = len > 1e-4 ? a / len : vec2(1.0, 0.0);
          vec2 perp = vec2(-dir.y, dir.x);
          float r = aPar.x;
          vLocal = vec2(position.x * (len * 0.5 + r), position.y * r);
          vHalfLen = len * 0.5;
          vPar = aPar;
          vec2 w = (aSeg.xy + aSeg.zw) * 0.5 + dir * vLocal.x + perp * vLocal.y;
          gl_Position = vec4((w - uOrigin) / uHalf, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vLocal;
        varying vec4 vPar;
        varying float vHalfLen;
        void main() {
          float dx = max(abs(vLocal.x) - vHalfLen, 0.0);
          float d = length(vec2(dx, vLocal.y));
          float k = 1.0 - smoothstep(vPar.x * vPar.w, vPar.x, d);
          gl_FragColor = vec4(vPar.y * k, vPar.z * k, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.stampMesh = new THREE.Mesh(geo, this.stampMat);
    this.stampMesh.frustumCulled = false;
    this.stampScene = new THREE.Scene();
    this.stampScene.add(this.stampMesh);
    this.stampCam = new THREE.Camera();
  }

  get texture() {
    return this.rts[this.ping].texture;
  }

  /** Stamp a capsule from (x0,z0) to (x1,z1). softness 0..1 is where the edge falloff starts. */
  stamp(x0, z0, x1, z1, radius, foam, aer, softness = 0.2) {
    if (this.count >= this.maxStamps) return;
    const i = this.count++ * 4;
    this.segs[i] = x0;
    this.segs[i + 1] = z0;
    this.segs[i + 2] = x1;
    this.segs[i + 3] = z1;
    this.pars[i] = radius;
    this.pars[i + 1] = foam;
    this.pars[i + 2] = aer;
    this.pars[i + 3] = softness;
  }

  update(center, dt) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.autoClear;
    const nx = Math.round(center.x / this.texel) * this.texel;
    const nz = Math.round(center.z / this.texel) * this.texel;
    const du = this.started ? (nx - this.origin.x) / this.extent : 0;
    const dv = this.started ? (nz - this.origin.y) / this.extent : 0;
    this.origin.set(nx, nz);

    const src = this.rts[this.ping], dst = this.rts[1 - this.ping];
    const u = this.decay.material.uniforms;
    u.tPrev.value = src.texture;
    u.uShift.value.set(du, dv);
    u.uKeep.value.set(Math.exp(-dt / 14), Math.exp(-dt / 70));
    u.uBlur.value = this.started ? Math.min(dt * 1.6, 1) : 0;
    r.setRenderTarget(dst);
    if (!this.started) {
      r.setClearColor(0x000000, 0);
      r.clear();
      this.started = true;
    } else this.decay.render(r);

    if (this.count > 0) {
      this.segAttr.addUpdateRange(0, this.count * 4);
      this.parAttr.addUpdateRange(0, this.count * 4);
      this.segAttr.needsUpdate = true;
      this.parAttr.needsUpdate = true;
      this.stampMesh.geometry.instanceCount = this.count;
      r.autoClear = false;
      r.render(this.stampScene, this.stampCam);
      r.autoClear = prevClear;
    }
    this.count = 0;
    this.ping = 1 - this.ping;
    r.setRenderTarget(prevTarget);
  }
}

// ---------------------------------------------------------------- ocean
function radialGrid(rings, segs, rMin, rMax) {
  const pos = [0, 0, 0];
  for (let i = 0; i < rings; i++) {
    const r = rMin * Math.pow(rMax / rMin, i / (rings - 1));
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * TAU;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const idx = [];
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    const a = 1 + i * segs, b = 1 + (i + 1) * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      idx.push(a + j, b + j1, b + j);
      idx.push(a + j, a + j1, b + j1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

export class Ocean {
  constructor(renderer, { rings = 200, segs = 256 } = {}) {
    this.waves = buildWaves();
    this.time = 0;
    this.amp = 1;
    this.sumAmp = this.waves.reduce((s, w) => s + w.amp, 0);
    this.foam = new FoamMap(renderer);
    this._d = new THREE.Vector3();

    const ripples = makeTileableNormalMap({ size: 512, seed: 21, minFreq: 2, maxFreq: 28, strength: 1.2 });
    this.uniforms = {
      uWaveTime: { value: 0 },
      uWaveAmp: { value: 1 },
      uRipples: { value: ripples },
      uFoamTex: { value: this.foam.texture },
      uFoamOrigin: { value: this.foam.origin },
      uFoamExtent: { value: this.foam.extent },
      uShipA: { value: Array.from({ length: MAX_WAKE_SHIPS }, () => new THREE.Vector4()) },
      uShipB: { value: Array.from({ length: MAX_WAKE_SHIPS }, () => new THREE.Vector4()) },
      uShipCount: { value: 0 },
      uShallow: { value: Array.from({ length: MAX_SHALLOWS }, () => new THREE.Vector4()) },
      uShallowCount: { value: 0 },
      uWhitecap: { value: 0.35 },
      uPixelAngle: { value: 0.0011 },
      uSumAmp: { value: this.sumAmp },
      uDeepColor: { value: new THREE.Color(0.0, 0.028, 0.075) },
      uShallowColor: { value: new THREE.Color(0.05, 0.36, 0.34) },
      uAerColor: { value: new THREE.Color(0.06, 0.22, 0.24) },
      uSSSColor: { value: new THREE.Color(0.02, 0.2, 0.17) },
      uBiolum: { value: 0 }, // night: the churned water of wakes and bow waves glows faintly
    };

    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0, ior: 1.333 });
    mat.defines = { SKIP_WET: '', FLARE_DIFFUSE: '0.2', FLARE_SPECULAR: '0.35' };
    const wglsl = wavesGLSL(this.waves);
    patchMaterial(mat, 'ocean', (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>\n${wglsl}\nvarying vec3 vOcWorld;\nvarying vec2 vOcBase;\nvarying float vOcHeight;`
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          vec3 transformed = vec3(position);
          vec2 ocBase = (modelMatrix * vec4(position, 1.0)).xz;
          float ocDist = length(ocBase - cameraPosition.xz);
          vec3 ocD = oceanDisplace(ocBase, ocDist);
          transformed += ocD;
          transformed.y -= ocDist * ocDist / 12742000.0; // earth curvature: distant hulls sink below the horizon
          vOcBase = ocBase;
          vOcHeight = ocD.y;
          vOcWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          `
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${wglsl}\n${fragPars}`)
        .replace('#include <envmap_physical_pars_fragment>', envChunk)
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          vec3 ocV = normalize(cameraPosition - vOcWorld);
          // pixel footprint on the water: analytic (fwidth jumps between the radial grid's triangles)
          float ocFp = max(length(vOcWorld - cameraPosition) * uPixelAngle / sqrt(max(abs(ocV.y), 0.04)), 1e-3);
          float ocLost = 0.0;
          float ocH;
          vec2 ocSlope = oceanSlope(vOcBase, ocFp, ocLost, ocH) + rippleSlope(vOcBase, ocFp, ocLost);
          vec3 ocN = normalize(vec3(-ocSlope.x, 1.0, -ocSlope.y));

          float ocFoam = 0.0, ocAer = 0.0;
          vec2 fuv = (vOcBase - uFoamOrigin) / uFoamExtent + 0.5;
          float fedge = 1.0 - smoothstep(0.42, 0.5, max(abs(fuv.x - 0.5), abs(fuv.y - 0.5)));
          vec2 fm = texture2D(uFoamTex, fuv).rg * fedge;
          ocFoam = fm.r;
          ocAer = fm.g;
          shipWakes(vOcBase, ocFoam, ocAer);
          float ocShallow = shallows(vOcBase, ocFoam);

          // wind whitecaps on the crests
          float crest = ocH / max(uSumAmp * uWaveAmp * 0.45, 1e-3);
          // sparse, patchy: only some crests break, in clusters that drift
          float wcn = fbm2(vOcBase * 0.045 + vec2(uWaveTime * 0.05, 0.0));
          float wcp = vnoise(vOcBase * 0.013 - uWaveTime * 0.01);
          ocFoam = max(ocFoam, smoothstep(0.45, 0.9, crest + (wcn - 0.5) * 1.2) * uWhitecap * smoothstep(0.55, 0.8, wcn) * smoothstep(0.35, 0.75, wcp));

          // break foam up into streaks and bubbles
          float fd = fbm2(vOcBase * 0.32 + vec2(uWaveTime * 0.07, -uWaveTime * 0.05));
          float fd2 = vnoise(vOcBase * 1.7 - uWaveTime * 0.2);
          float foamAmt = clamp(ocFoam * 1.25, 0.0, 1.0);
          float ocFoamMask = smoothstep(1.0 - foamAmt, 1.0 - foamAmt + 0.35, fd * 0.75 + fd2 * 0.35) * smoothstep(0.0, 0.08, ocFoam);
          float farK = smoothstep(150.0, 2500.0, length(vOcWorld - cameraPosition));
          ocFoamMask = mix(ocFoamMask, foamAmt * 0.8, farK);

          vec3 water = mix(uDeepColor, uAerColor, clamp(ocAer, 0.0, 1.0) * 0.8);
          water = mix(water, uShallowColor, ocShallow);
          diffuseColor.rgb = mix(water, vec3(0.82, 0.86, 0.88), ocFoamMask);

          // light through thin wave crests, strongest looking toward the sun
          vec3 ocL = uSunDirW;
          float sunUp = smoothstep(-0.05, 0.2, ocL.y);
          float sssView = pow(clamp(dot(ocV, -normalize(ocL + ocN * 0.6)), 0.0, 1.0), 4.0);
          float crestK = smoothstep(-0.15, 0.9, crest);
          vec3 ocSSS = uSSSColor * uSunColorN * (sssView * 1.6 + 0.12) * crestK * sunUp * (1.0 - ocFoamMask) * (1.0 + ocShallow);
          // phosphorescence in freshly churned water, seen only in the dark
          // (wakes and bow waves only: the foam map and the hull's churn, not the wind's whitecaps)
          ocSSS += vec3(0.005, 0.034, 0.03) * uBiolum * clamp(fm.r * 0.6 + ocAer * 0.6, 0.0, 1.0) * (0.5 + 0.5 * fd2) * (1.0 - farK * 0.7);
          float ocRough = sqrt(0.0036 + ocLost * 1.6);
          ocRough = mix(min(ocRough, 0.45), 0.7, ocFoamMask);
          `
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = ocRough;')
        .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(ocN, 0.0)).xyz);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += ocSSS;');
    });
    this.material = mat;

    this.mesh = new THREE.Mesh(radialGrid(rings, segs, 0.8, 24000), mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ocean';
    this.mesh.renderOrder = -1;
  }

  /** Displacement of the undisplaced surface point (x, z); writes into `out`. */
  displace(x, z, out = this._d) {
    let dx = 0, dy = 0, dz = 0;
    const t = this.time, amp = this.amp;
    for (const w of this.waves) {
      const th = w.k * (w.dx * x + w.dz * z) - w.w * t + w.phase;
      const a = w.amp * amp;
      const c = Math.cos(th);
      dx += w.dx * w.chop * a * c;
      dz += w.dz * w.chop * a * c;
      dy += a * Math.sin(th);
    }
    return out.set(dx, dy, dz);
  }

  /** Surface height at world (x, z): inverts the horizontal Gerstner displacement first. */
  heightAt(x, z) {
    let px = x, pz = z;
    for (let i = 0; i < 3; i++) {
      const d = this.displace(px, pz);
      px = x - d.x;
      pz = z - d.z;
    }
    return this.displace(px, pz).y;
  }

  stamp(x0, z0, x1, z1, radius, foam, aer, softness) {
    this.foam.stamp(x0, z0, x1, z1, radius, foam, aer, softness);
  }

  /** ships: [{ x, z, heading (rad, compass), halfLength, halfBeam, speed }] */
  setShips(ships) {
    const u = this.uniforms;
    let n = 0;
    for (const s of ships) {
      if (n >= MAX_WAKE_SHIPS) break;
      u.uShipA.value[n].set(s.x, s.z, Math.sin(s.heading), Math.cos(s.heading));
      u.uShipB.value[n].set(s.halfLength, s.halfBeam, s.speed, 0);
      n++;
    }
    u.uShipCount.value = n;
  }

  /** shallows: [{ x, z, shore, reef }] lagoon water out to `reef` metres from the island centre */
  setShallows(list) {
    const u = this.uniforms;
    list.slice(0, MAX_SHALLOWS).forEach((s, i) => u.uShallow.value[i].set(s.x, s.z, s.shore, s.reef));
    u.uShallowCount.value = Math.min(list.length, MAX_SHALLOWS);
  }

  update(dt, camera, { amp = 1, whitecap = 0.35, pixelAngle = 0.0011, foam = true } = {}) {
    this.time += dt;
    this.amp += (amp - this.amp) * (1 - Math.exp(-dt * 0.2));
    const u = this.uniforms;
    u.uWaveTime.value = this.time;
    u.uWaveAmp.value = this.amp;
    u.uWhitecap.value = whitecap;
    u.uPixelAngle.value = pixelAngle;
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    if (foam) this.foam.update(camera.position, Math.max(dt, 1e-4));
    else this.foam.count = 0;
    u.uFoamTex.value = this.foam.texture;
  }
}

