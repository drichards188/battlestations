import * as THREE from 'three';
import { mulberry32, fbm, noise3, makeTileableNormalMap } from './noise.js';
import { patchMaterial, noiseGLSL } from './shaderlib.js';
import { WATER_LEVEL, LAKE_CENTER, causticGLSL, lakeReef } from './terrain.js';

// Life in and around the lake: swaying kelp and eelgrass forests, schooling
// fish, water-worn boulders, reed beds and lily pads at the shore, drifting
// plankton and bubbles, and the water surface seen from below. Everything
// is GPU instanced and bucketed into chunks so the frustum can skip it.

const KELP_CHUNK = 40;
const ROCK_CHUNK = 60;
const SHORE_CHUNK = 50;
const KELP_MAX = 26000;
const ACTIVE_RADIUS = 420; // camera further than this from the lake and the life sleeps
const KELP_FAR = 220;
const SHORE_FAR = 300;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();

const rotYGLSL = /* glsl */ `
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
`;

// Caustics and depth attenuation shared by everything that lives on the lake
// bed; the terrain applies the same model so all of it reads as one scene.
const underwaterLightGLSL = /* glsl */ `
  float uwDepth = uWaterLevel - vUwPos.y;
  if (uwDepth > 0.0) {
    float c = caustic(vUwPos.xz * 0.28, uTime * 0.6);
    float att = exp(-uwDepth * 0.18) * smoothstep(0.0, 0.6, uwDepth);
    float deep = exp(-uwDepth * 0.045);
    vec3 tint = mix(vec3(1.0), vec3(0.35, 0.75, 0.8), smoothstep(0.0, 5.0, uwDepth));
    reflectedLight.directDiffuse *= (1.0 + c * att * 4.0) * deep * tint;
    reflectedLight.directSpecular *= deep * tint;
    reflectedLight.indirectDiffuse *= mix(1.0, deep, 0.6) * tint;
    reflectedLight.indirectSpecular *= mix(1.0, deep, 0.6) * tint;
  }
`;

// ------------------------------------------------------------------ geometry

function ribbonGeometry(segments) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    pos.push(-0.5, t, 0, 0.5, t, 0);
    uv.push(0, t, 1, t);
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Low-poly fish: an elliptical body tube with nose at +z, plus forked tail,
// dorsal, anal and pectoral fins as flat cards. Length 1.25 in local units.
function fishGeometry() {
  const pos = [], nrm = [], idx = [];
  const L = 14, A = 10;
  const halfW = (t) => 0.005 + 0.105 * Math.sin(Math.PI * Math.pow(t, 0.72));
  const halfH = (t) => halfW(t) * (1.5 + 0.4 * Math.sin(Math.PI * t));
  for (let i = 0; i <= L; i++) {
    const t = i / L, z = -0.5 + t;
    const rw = halfW(t), rh = halfH(t);
    for (let j = 0; j <= A; j++) {
      const a = (j / A) * Math.PI * 2;
      pos.push(Math.cos(a) * rw, Math.sin(a) * rh, z);
      const nx = Math.cos(a) / rw, ny = Math.sin(a) / rh, il = 1 / Math.hypot(nx, ny);
      nrm.push(nx * il, ny * il, 0);
    }
  }
  for (let i = 0; i < L; i++) {
    for (let j = 0; j < A; j++) {
      const a = i * (A + 1) + j, b = a + A + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const tri = (p0, p1, p2, n) => {
    const b = pos.length / 3;
    pos.push(...p0, ...p1, ...p2);
    nrm.push(...n, ...n, ...n);
    idx.push(b, b + 1, b + 2);
  };
  const quad = (p0, p1, p2, p3, n) => {
    tri(p0, p1, p2, n);
    tri(p0, p2, p3, n);
  };
  const X = [1, 0, 0];
  // forked caudal fin
  tri([0, 0.0, -0.48], [0, 0.18, -0.76], [0, 0.0, -0.6], X);
  tri([0, 0.0, -0.48], [0, 0.0, -0.6], [0, -0.18, -0.76], X);
  // dorsal fin along the back
  const hz = (z) => halfH(z + 0.5);
  quad([0, hz(0.18) - 0.01, 0.18], [0, hz(0.18) + 0.13, 0.12], [0, hz(-0.12) + 0.1, -0.05], [0, hz(-0.12) - 0.01, -0.12], X);
  // anal fin
  tri([0, -hz(-0.2) + 0.01, -0.2], [0, -hz(-0.35) + 0.01, -0.35], [0, -hz(-0.28) - 0.08, -0.3], X);
  // pectoral fins
  for (const s of [-1, 1]) {
    const w = halfW(0.65) * 0.9;
    tri([s * w, -0.03, 0.15], [s * (w + 0.13), -0.1, -0.02], [s * w, -0.08, 0.04], [0, 1, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// Water-worn boulder with an algae film on its upper faces.
function boulderGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const s = seed * 5.71;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let d = 1 + 0.22 * noise3(v.x * 1.1 + s, v.y * 1.1, v.z * 1.1);
    d += 0.06 * noise3(v.x * 3.5 + s, v.y * 3.5, v.z * 3.5);
    v.multiplyScalar(d);
    v.y *= 0.6 + (seed % 3) * 0.1;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const col = new Float32Array(pos.count * 3);
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(g.attributes.normal, i);
    const grey = 0.2 + 0.09 * noise3(v.x * 2.5 + s, v.y * 2.5, v.z * 2.5);
    const algae = THREE.MathUtils.smoothstep(n.y, 0.35, 0.8) * (0.55 + 0.45 * Math.max(0, noise3(v.x * 2 + s, v.y * 2, v.z * 2 + 3)));
    col[i * 3] = THREE.MathUtils.lerp(grey * 1.05, 0.07, algae);
    col[i * 3 + 1] = THREE.MathUtils.lerp(grey, 0.15, algae);
    col[i * 3 + 2] = THREE.MathUtils.lerp(grey * 0.9, 0.04, algae);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// A clump of reed blades with one cattail. Vertex colours carry the shading.
function reedGeometry(rand) {
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  const blade = (bx, bz, az, tilt, H, w0, c0, c1, segs = 5, curve = 0.2) => {
    const b = pos.length / 3;
    const dx = Math.cos(az), dz = Math.sin(az);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const lean = Math.sin(tilt) * t * H + curve * t * t * H;
      const y = Math.cos(tilt) * t * H;
      const w = w0 * (1 - t * 0.85);
      const x = bx + dx * lean, z = bz + dz * lean;
      pos.push(x - dz * w, y, z + dx * w, x + dz * w, y, z - dx * w);
      c.copy(c0).lerp(c1, t);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (i < segs) {
        const a = b + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  };
  const base = new THREE.Color(0.1, 0.19, 0.04), tip = new THREE.Color(0.36, 0.4, 0.1);
  const nB = 6 + Math.floor(rand() * 3);
  for (let i = 0; i < nB; i++) {
    const a = rand() * Math.PI * 2, r = rand() * 0.22;
    const azOut = a + (rand() - 0.5) * 0.8;
    blade(Math.cos(a) * r, Math.sin(a) * r, azOut, 0.12 + rand() * 0.28, 1.2 + rand() * 1.1, 0.03 + rand() * 0.02, base, tip, 5, 0.1 + rand() * 0.25);
  }
  // cattail: two crossed stalk ribbons and a dark head near the top
  const H = 1.9 + rand() * 0.5;
  const sx = (rand() - 0.5) * 0.15, sz = (rand() - 0.5) * 0.15;
  const stalkC = new THREE.Color(0.22, 0.28, 0.08);
  blade(sx, sz, 0, 0.04, H, 0.014, stalkC, stalkC, 3, 0.05);
  blade(sx, sz, Math.PI / 2, 0.04, H, 0.014, stalkC, stalkC, 3, 0.05);
  const headC = new THREE.Color(0.2, 0.1, 0.04);
  const hb = pos.length / 3, hr = 0.036, y0 = H * 0.86, y1 = H * 0.97;
  for (let j = 0; j < 8; j++) {
    const a = (j / 8) * Math.PI * 2;
    pos.push(sx + Math.cos(a) * hr, y0, sz + Math.sin(a) * hr, sx + Math.cos(a) * hr, y1, sz + Math.sin(a) * hr);
    col.push(headC.r, headC.g, headC.b, headC.r * 1.3, headC.g * 1.3, headC.b * 1.3);
    const n0 = hb + j * 2, n1 = hb + ((j + 1) % 8) * 2;
    idx.push(n0, n0 + 1, n1, n1, n0 + 1, n1 + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Lily pad: a slightly cupped disc with a notch; uv = (radius, angle).
function lilyPadGeometry() {
  const pos = [], uv = [], idx = [];
  const N = 22, notch = 0.24;
  pos.push(0.06, 0, 0);
  uv.push(0, 0);
  for (let i = 0; i <= N; i++) {
    const a = notch + (i / N) * (Math.PI * 2 - notch * 2);
    pos.push(Math.cos(a) * 0.55, 0.008, Math.sin(a) * 0.55, Math.cos(a), 0.025, Math.sin(a));
    uv.push(0.55, a, 1, a);
    if (i < N) {
      const b = 1 + i * 2;
      idx.push(0, b, b + 2, b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Water lily flower: two rings of petals around a yellow heart.
function lilyFlowerGeometry() {
  const pos = [], col = [], idx = [];
  const petal = (a, len, lift, w, c0, c1) => {
    const b = pos.length / 3;
    const dx = Math.cos(a), dz = Math.sin(a);
    const tipY = Math.sin(lift) * len, tipR = Math.cos(lift) * len;
    pos.push(0, 0.02, 0, dx * tipR * 0.5 - dz * w, 0.02 + tipY * 0.5, dz * tipR * 0.5 + dx * w, dx * tipR, 0.02 + tipY, dz * tipR, dx * tipR * 0.5 + dz * w, 0.02 + tipY * 0.5, dz * tipR * 0.5 - dx * w);
    col.push(c0.r, c0.g, c0.b, c1.r, c1.g, c1.b, c1.r, c1.g, c1.b, c1.r, c1.g, c1.b);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const pink = new THREE.Color(0.9, 0.45, 0.6), white = new THREE.Color(1.0, 0.92, 0.95);
  for (let i = 0; i < 9; i++) petal((i / 9) * Math.PI * 2, 0.15, 0.55, 0.035, pink, white);
  for (let i = 0; i < 6; i++) petal((i / 6) * Math.PI * 2 + 0.3, 0.1, 1.0, 0.03, pink, white);
  const yellow = new THREE.Color(1.0, 0.8, 0.2);
  const hb = pos.length / 3;
  pos.push(0, 0.06, 0);
  col.push(yellow.r, yellow.g, yellow.b);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    pos.push(Math.cos(a) * 0.03, 0.045, Math.sin(a) * 0.03);
    col.push(yellow.r * 0.8, yellow.g * 0.7, yellow.b * 0.5);
    idx.push(hb, hb + 1 + i, hb + 1 + ((i + 1) % 6));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ materials

function kelpMaterial(uniforms) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
  m.defines = { SKIP_WET: '' };
  patchMaterial(m, 'kelp', (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec4 aPlantA; // x, groundY, z, rotation
        attribute vec4 aPlantB; // height, width, variant, phase
        uniform float uTime;
        uniform float uFadeStart;
        uniform float uFadeEnd;
        varying vec3 vUwPos;
        varying float vT;
        varying float vVariant;
        varying float vBright;
        ${rotYGLSL}
        `
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        vec3 objectNormal = normalize(mix(rotY(aPlantA.w) * normal, vec3(0.0, 1.0, 0.0), 0.35));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 base = vec3(aPlantA.x, aPlantA.y, aPlantA.z);
        float H = aPlantB.x, W = aPlantB.y, variant = aPlantB.z, ph = aPlantB.w;
        float t = position.y;
        // shrink away before the chunk is culled so nothing pops
        float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(base.xz - cameraPosition.xz));
        H *= fade;
        W *= fade;
        // eelgrass keeps its width, kelp fronds widen then taper to a tip
        float kelp = clamp(variant, 0.0, 1.0);
        float prof = mix(1.0 - t * t * 0.7, 0.25 + 0.75 * sin(3.14159 * min(t * 1.15, 1.0)), kelp);
        vec3 p = vec3(position.x * W * prof, t * H, 0.0);
        p.z += sin(t * 28.0 + position.x * 5.0 + ph) * 0.06 * W * kelp; // crinkled kelp edges
        p = rotY(aPlantA.w) * p;
        // a slowly turning current plus each plant's own sway, growing toward the tip
        vec2 cur = vec2(cos(uTime * 0.09 + ph * 0.2), sin(uTime * 0.07 + ph * 0.3));
        float sway = 0.35 + sin(uTime * 0.8 + ph + t * 2.2) * 0.30 + sin(uTime * 1.9 + ph * 1.7 + t * 4.0) * 0.08;
        float bend = sway * t * t;
        p.xz += cur * bend * H * 0.55;
        p.y -= bend * bend * H * 0.25;
        vec3 world = base + p;
        vUwPos = world;
        vT = t;
        vVariant = variant;
        vBright = fract(sin(aPlantA.x * 12.9898 + aPlantA.z * 78.233) * 43758.5453);
        vec3 transformed = world;
        `
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        uniform float uWaterLevel;
        varying vec3 vUwPos;
        varying float vT;
        varying float vVariant;
        varying float vBright;
        ${causticGLSL}
        `
      )
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        vec3 grassA = vec3(0.05, 0.16, 0.03), grassB = vec3(0.11, 0.22, 0.045);
        vec3 kelpA = vec3(0.10, 0.11, 0.02), kelpB = vec3(0.24, 0.18, 0.045);
        vec3 redA = vec3(0.16, 0.04, 0.03), redB = vec3(0.34, 0.11, 0.06);
        float kv = clamp(vVariant, 0.0, 1.0), rv = clamp(vVariant - 1.0, 0.0, 1.0);
        vec3 lo = mix(mix(grassA, kelpA, kv), redA, rv);
        vec3 hi = mix(mix(grassB, kelpB, kv), redB, rv);
        diffuseColor.rgb *= mix(lo, hi, smoothstep(0.0, 1.0, vT)) * (0.8 + 0.4 * vBright);
        diffuseColor.rgb *= mix(0.45, 1.0, smoothstep(0.0, 0.35, vT)); // dark at the holdfast
        `
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #include <emissivemap_fragment>
        // light through the blades when looking up toward the sun
        vec3 viewDirW = normalize(vUwPos - cameraPosition);
        float trans = pow(max(dot(viewDirW, uSunDirW), 0.0), 5.0) * worldShadowFactor(vUwPos);
        totalEmissiveRadiance += diffuseColor.rgb * uSunColorN * trans * 0.4 * exp(-(uWaterLevel - vUwPos.y) * 0.08);
        `
      )
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${underwaterLightGLSL}`);
  });
  return m;
}

function fishMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.3, side: THREE.DoubleSide });
  m.defines = { SKIP_WET: '' };
  patchMaterial(m, 'fish', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec4 aFish; // tail phase, tail amplitude, species, unused
        varying vec3 vLocal;
        varying vec3 vUwPos;
        varying float vSpecies;
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 transformed = vec3(position);
        #ifdef USE_INSTANCING
          // a wave travelling down the body, strongest at the tail; fins flutter a little
          float tailW = smoothstep(0.45, -0.75, position.z);
          tailW *= tailW;
          transformed.x += sin(aFish.x - position.z * 4.0) * (0.015 + 0.13 * tailW) * aFish.y;
          transformed.x += sin(aFish.x * 1.3 + position.y * 20.0) * 0.012 * step(0.16, abs(position.y));
          vUwPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vUwPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        vLocal = position;
        vSpecies = aFish.z;
        `
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        uniform float uWaterLevel;
        varying vec3 vLocal;
        varying vec3 vUwPos;
        varying float vSpecies;
        ${causticGLSL}
        `
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        // species: 0 minnow (silver, dark back), 1 perch (olive with bars), 2 carp (bronze)
        float k1 = clamp(vSpecies, 0.0, 1.0), k2 = clamp(vSpecies - 1.0, 0.0, 1.0);
        float back = smoothstep(-0.08, 0.1, vLocal.y);
        vec3 lo = mix(mix(vec3(0.78, 0.8, 0.74), vec3(0.6, 0.56, 0.3), k1), vec3(0.55, 0.42, 0.22), k2);
        vec3 hi = mix(mix(vec3(0.07, 0.11, 0.1), vec3(0.1, 0.15, 0.05), k1), vec3(0.17, 0.12, 0.05), k2);
        vec3 fc = mix(lo, hi, back);
        float bars = smoothstep(0.3, 0.7, sin(vLocal.z * 38.0) * 0.5 + 0.5) * k1 * (1.0 - k2) * back;
        fc *= 1.0 - bars * 0.55;
        fc *= 1.0 - 0.25 * exp(-abs(vLocal.y - 0.01) * 60.0) * (1.0 - k2); // lateral line
        fc *= 1.0 - 0.35 * step(0.16, abs(vLocal.y)) * (1.0 - k2); // darker fins
        float eye = smoothstep(0.024, 0.014, length(vLocal.yz - vec2(0.05, 0.37)));
        fc = mix(fc, vec3(0.02), eye);
        diffuseColor.rgb *= fc;
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(0.35, 0.6, k2); // minnows flash, carp are matte
        `
      )
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${underwaterLightGLSL}`);
  });
  return m;
}

function boulderMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  patchMaterial(m, 'boulder', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUwPos;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vUwPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vUwPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        `
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform float uWaterLevel;\nvarying vec3 vUwPos;\n${causticGLSL}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${underwaterLightGLSL}`);
  });
  return m;
}

function reedMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  m.defines = { SKIP_WET: '' };
  patchMaterial(m, 'reed', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWindStrength;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          float gust = sin(uTime * 0.9 + ip.x * 0.05 + ip.z * 0.04) * 0.5 + sin(uTime * 1.7 + ip.x * 0.11 + ip.z * 0.07) * 0.25 + 0.35;
          float k = position.y * position.y * 0.07 * uWindStrength;
          transformed.x += gust * k + sin(uTime * 3.1 + position.y * 2.0 + ip.z) * k * 0.15;
          transformed.z += gust * k * 0.35;
        #endif
        `
      );
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  });
  return m;
}

function lilyMaterial(flower) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: flower, color: 0xffffff, roughness: flower ? 0.6 : 0.5, metalness: 0, side: THREE.DoubleSide });
  m.defines = { SKIP_WET: '' };
  patchMaterial(m, flower ? 'lilyflower' : 'lilypad', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec2 vPadUv;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          transformed.y += sin(uTime * 1.2 + ip.x * 0.8 + ip.z * 1.1) * 0.012 + sin(uTime * 2.3 + ip.x * 2.0) * 0.005;
        #endif
        vPadUv = uv;
        `
      );
    if (!flower) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPadUv;')
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          float veins = smoothstep(0.85, 1.0, sin(vPadUv.y * 11.0 + sin(vPadUv.x * 9.0) * 0.4) * 0.5 + 0.5) * smoothstep(0.15, 0.5, vPadUv.x);
          vec3 top = mix(vec3(0.07, 0.2, 0.04), vec3(0.16, 0.3, 0.06), smoothstep(0.2, 1.0, vPadUv.x));
          top = mix(top, vec3(0.2, 0.34, 0.08), veins * 0.6);
          vec3 under = vec3(0.26, 0.09, 0.06);
          diffuseColor.rgb *= gl_FrontFacing ? top : under;
          `
        );
    }
  });
  return m;
}

function moteMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uPixelRatio: { value: 1 },
      uLight: { value: new THREE.Color() },
      uWaterLevel: { value: WATER_LEVEL },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aKind;
      uniform float uTime;
      uniform vec3 uCam;
      uniform float uPixelRatio;
      uniform float uWaterLevel;
      varying float vKind;
      varying float vFade;
      void main() {
        vec3 p = position;
        if (aKind > 0.5) {
          // bubbles rise and wobble
          p.y += uTime * (0.35 + aSeed * 0.35);
          p.x += sin(uTime * 1.7 + aSeed * 20.0) * 0.08;
          p.z += cos(uTime * 1.3 + aSeed * 17.0) * 0.08;
        } else {
          // plankton drifts with the current
          p += vec3(sin(uTime * 0.23 + aSeed * 7.0), sin(uTime * 0.19 + aSeed * 3.0), cos(uTime * 0.21 + aSeed * 5.0)) * 0.6;
          p += vec3(uTime * 0.12, uTime * 0.02, uTime * 0.08);
        }
        p = uCam + mod(p - uCam + 15.0, 30.0) - 15.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = length(p - uCam);
        vFade = smoothstep(15.0, 6.0, dist) * smoothstep(0.35, 1.2, dist) * step(p.y, uWaterLevel - 0.1);
        vKind = aKind;
        gl_PointSize = (aKind > 0.5 ? 12.0 + aSeed * 8.0 : 4.0 + aSeed * 2.0) * uPixelRatio / -mv.z * vFade;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uLight;
      varying float vKind;
      varying float vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a;
        if (vKind > 0.5) {
          // a thin bright rim with a faint interior, like a real bubble
          a = smoothstep(0.5, 0.42, d) * (0.18 + 0.82 * smoothstep(0.3, 0.46, d));
          a += smoothstep(0.2, 0.0, length(gl_PointCoord - vec2(0.36, 0.34))) * 0.5;
        } else {
          a = smoothstep(0.5, 0.05, d) * 0.5;
        }
        gl_FragColor = vec4(uLight * a * vFade, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// The underside of the water surface: Snell's window of sky straight up, a
// dark mirror of the lake toward the horizon, wave wobble and the sun's glint.
function ceilingMaterial(normals) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uNormals: { value: normals },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSkyColor: { value: new THREE.Color() },
      uTint: { value: new THREE.Color() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform sampler2D uNormals;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform vec3 uTint;
      varying vec3 vW;
      void main() {
        vec2 uv = vW.xz;
        vec3 n = texture2D(uNormals, uv / 23.0 + uTime * vec2(0.02, 0.013)).xyz * 2.0 - 1.0;
        n += (texture2D(uNormals, uv / 7.0 - uTime * vec2(0.03, 0.02)).xyz * 2.0 - 1.0) * 0.6;
        n += (texture2D(uNormals, uv / 2.5 + uTime * vec2(0.05, -0.04)).xyz * 2.0 - 1.0) * 0.25;
        n = normalize(vec3(n.x, n.z * 1.6, n.y));
        vec3 toCam = cameraPosition - vW;
        float dist = length(toCam);
        vec3 V = toCam / max(dist, 1e-3);            // surface -> camera (points down)
        float cosT = max(dot(V, -n), 0.0);           // 1 when looking straight up
        // inside Snell's window (about 48 degrees) the sky shows through, outside is total internal reflection
        float window = smoothstep(0.58, 0.74, cosT);
        vec3 sky = uSkyColor * (0.9 + 0.5 * smoothstep(0.7, 1.0, cosT));
        vec3 mirror = uTint * 1.6 * (0.6 + 0.4 * smoothstep(0.9, 1.0, n.y));
        vec3 col = mix(mirror, sky, window);
        // the sun, refracted toward the zenith and broken up by the waves
        vec3 sunR = normalize(vec3(uSunDir.x * 0.55, max(uSunDir.y, 0.05) + 0.45, uSunDir.z * 0.55));
        vec3 Vp = normalize(V + vec3(n.x, 0.0, n.z) * 0.9);
        float g = max(dot(-Vp, sunR), 0.0);
        float glint = pow(g, 80.0) * 8.0 + pow(g, 10.0) * 0.5;
        col += uSunColor * glint * window;
        // bright ripple caustic-like shimmer across the whole underside
        col *= 0.85 + 0.3 * smoothstep(0.86, 1.0, n.y);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: true,
  });
}

// ------------------------------------------------------------------ fish

// Species: size is body length in metres, depth the bed depth they patrol,
// layer their preferred height between the bed and the surface.
const SPECIES = [
  { size: [0.15, 0.2], squash: 0.7, speed: [0.9, 2.2], burst: 4.5, school: 34, depth: [1.6, 6], layer: [0.3, 0.85], sep: 0.4, cohesion: 1.4, align: 1.6, wander: 22 },
  { size: [0.34, 0.5], squash: 1.0, speed: [0.45, 1.3], burst: 3.5, school: 11, depth: [4, 15], layer: [0.15, 0.6], sep: 0.9, cohesion: 1.0, align: 1.0, wander: 30 },
  { size: [0.85, 1.15], squash: 0.9, speed: [0.25, 0.7], burst: 2.5, school: 5, depth: [9, 40], layer: [0.05, 0.3], sep: 2.5, cohesion: 0.4, align: 0.6, wander: 38 },
];
const SCHOOL_PLAN = [0, 1, 2, 0, 1, 0, 1, 0, 1, 0, 2, 0, 1];

export class Underwater {
  constructor(terrain, { kelp = 1, fish = 200 } = {}) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'underwater';
    this.colliders = [];
    this.enabled = true;
    this.kelpDensity = kelp;
    const rand = mulberry32(7331);
    this.rand = rand;
    const cx = LAKE_CENTER.x, cz = LAKE_CENTER.y;
    const depthAt = (x, z) => WATER_LEVEL - terrain.getHeight(x, z);
    // Visit the terrain cells of the lake region whose centre passes `accept`
    // and drop jittered candidates into each: far cheaper than sampling the
    // whole square when the target is a thin shore band.
    const scan = (accept, perCell, fn) => {
      const cell = terrain.cell;
      for (let z = cz - 200; z < cz + 260; z += cell) {
        for (let x = cx - 200; x < cx + 200; x += cell) {
          if (!accept(terrain.getHeight(x + cell * 0.5, z + cell * 0.5))) continue;
          for (let i = 0; i < perCell; i++) fn(x + rand() * cell, z + rand() * cell);
        }
      }
    };
    const shuffle = (list) => {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = list[i];
        list[i] = list[j];
        list[j] = t;
      }
      return list;
    };

    // ---- kelp and eelgrass
    this.kelpUniforms = { uFadeStart: { value: KELP_FAR - 60 }, uFadeEnd: { value: KELP_FAR - 8 } };
    const kelpMat = kelpMaterial(this.kelpUniforms);
    const ribbon = ribbonGeometry(7);
    const candidates = [];
    scan((hc) => hc < -0.3 && hc > -19, 40, (x, z) => {
      const d = depthAt(x, z);
      if (d < 0.8 || d > 17) return;
      terrain.getNormal(x, z, _n);
      if (_n.y < 0.6) return;
      // meadows and forests come in patches, thinning out in the very shallows
      const patch = fbm(x * 0.03, z * 0.03, 3, 1300);
      const density = THREE.MathUtils.smoothstep(patch, -0.08, 0.32) * (0.55 + 0.45 * THREE.MathUtils.smoothstep(d, 0.8, 2.5));
      if (rand() > density) return;
      let variant, h, w;
      const kelpW = THREE.MathUtils.smoothstep(d, 3, 6) * (1 - THREE.MathUtils.smoothstep(d, 13, 17));
      if (rand() < 0.07 && _n.y < 0.93) {
        variant = 2; // red algae on the rock
        h = 0.35 + rand() * 0.5;
        w = 0.12 + rand() * 0.08;
      } else if (rand() < kelpW) {
        variant = 1;
        h = Math.min(d - 0.6, 2.5 + rand() * 6.5);
        w = 0.24 + rand() * 0.2;
      } else {
        variant = 0;
        h = Math.min(d - 0.3, 0.7 + rand() * 1.3);
        w = 0.05 + rand() * 0.04;
      }
      if (h < 0.3) return;
      candidates.push({ x, y: terrain.getHeight(x, z) - 0.05, z, rot: rand() * Math.PI * 2, h, w, variant, ph: rand() * 100 });
    });
    // shuffle before capping so a full budget thins the whole lake evenly,
    // and so drawing a prefix of a chunk (the distance LOD) thins it evenly too
    const plants = new Map();
    for (const p of shuffle(candidates).slice(0, KELP_MAX)) {
      const key = `${Math.floor(p.x / KELP_CHUNK)},${Math.floor(p.z / KELP_CHUNK)}`;
      if (!plants.has(key)) plants.set(key, []);
      plants.get(key).push(p);
    }
    const placed = Math.min(candidates.length, KELP_MAX);
    this.kelpGroup = new THREE.Group();
    this.kelpChunks = [];
    for (const list of plants.values()) {
      const n = list.length;
      const a = new Float32Array(n * 4), b = new Float32Array(n * 4);
      const centre = new THREE.Vector3();
      let maxH = 0;
      list.forEach((p, i) => {
        a.set([p.x, p.y, p.z, p.rot], i * 4);
        b.set([p.h, p.w, p.variant, p.ph], i * 4);
        centre.add(_v.set(p.x, p.y, p.z));
        maxH = Math.max(maxH, p.h);
      });
      centre.divideScalar(n);
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', ribbon.attributes.position);
      geo.setAttribute('uv', ribbon.attributes.uv);
      geo.setAttribute('normal', ribbon.attributes.normal);
      geo.setIndex(ribbon.index);
      geo.setAttribute('aPlantA', new THREE.InstancedBufferAttribute(a, 4));
      geo.setAttribute('aPlantB', new THREE.InstancedBufferAttribute(b, 4));
      geo.instanceCount = n;
      let radius = 0;
      for (const p of list) radius = Math.max(radius, centre.distanceTo(_v.set(p.x, p.y, p.z)));
      geo.boundingSphere = new THREE.Sphere(centre.clone().setY(centre.y + maxH * 0.4), radius + maxH + 1);
      const mesh = new THREE.Mesh(geo, kelpMat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.name = 'kelp';
      this.kelpGroup.add(mesh);
      this.kelpChunks.push({ mesh, geo, total: n, centre });
    }
    this.kelpTotal = placed;
    this.group.add(this.kelpGroup);

    // ---- boulders: big water-worn blocks on the reefs, cobbles on the flats
    const boulderMat = boulderMaterial();
    const boulderGeos = [boulderGeometry(1), boulderGeometry(2), boulderGeometry(3)];
    const rocks = boulderGeos.map(() => new Map());
    const dummy = new THREE.Object3D();
    let nRocks = 0, attempts = 0;
    while (nRocks < 420 && attempts < 20000) {
      attempts++;
      const x = cx + (rand() * 2 - 1) * 200, z = cz + (rand() * 2 - 1) * 200;
      const h = terrain.getHeight(x, z);
      const d = WATER_LEVEL - h;
      if (d < 1.4) continue;
      const reef = Math.min(1, lakeReef(x, z) * 2.5);
      const big = rand() < 0.15 + reef * 0.5;
      if (!big && rand() < 0.4) continue;
      const s = big ? 1.2 + rand() * (2.2 + reef * 2.5) : 0.25 + Math.pow(rand(), 2) * 0.9;
      if (h + s * 0.7 > -1.2) continue; // stays under the surface
      terrain.getNormal(x, z, _n);
      dummy.position.set(x, h - s * 0.3, z);
      dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _n);
      dummy.rotateY(rand() * Math.PI * 2);
      dummy.scale.set(s * (0.85 + rand() * 0.4), s, s * (0.85 + rand() * 0.4));
      dummy.updateMatrix();
      const v = Math.floor(rand() * boulderGeos.length);
      const key = `${Math.floor(x / ROCK_CHUNK)},${Math.floor(z / ROCK_CHUNK)}`;
      if (!rocks[v].has(key)) rocks[v].set(key, []);
      rocks[v].get(key).push(dummy.matrix.clone());
      if (s >= 1.2) this.colliders.push({ x, z, r: s * 0.7, top: h + s * 0.6 });
      nRocks++;
    }
    this.boulderGroup = new THREE.Group();
    rocks.forEach((chunks, v) => {
      for (const list of chunks.values()) {
        const mesh = new THREE.InstancedMesh(boulderGeos[v], boulderMat, list.length);
        list.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.boulderGroup.add(mesh);
      }
    });
    this.group.add(this.boulderGroup);

    // ---- fish
    this.fishGeo = fishGeometry();
    const schools = [];
    const homes = [];
    let fishTotal = 0;
    for (const spIdx of SCHOOL_PLAN) {
      const sp = SPECIES[spIdx];
      let home = null;
      for (let tries = 0; tries < 300 && !home; tries++) {
        const x = cx + (rand() * 2 - 1) * 140, z = cz + (rand() * 2 - 1) * 140;
        const d = depthAt(x, z);
        if (d < sp.depth[0] + 1 || d > sp.depth[1]) continue;
        if (homes.some((hm) => Math.hypot(hm.x - x, hm.z - z) < 22)) continue;
        home = new THREE.Vector3(x, 0, z);
      }
      if (!home) home = new THREE.Vector3(cx + (rand() - 0.5) * 60, 0, cz + (rand() - 0.5) * 60);
      homes.push(home);
      const school = { sp: spIdx, home, target: home.clone(), seed: rand() * 100, fish: [], centre: new THREE.Vector3(), avgVel: new THREE.Vector3() };
      const bed = terrain.getHeight(home.x, home.z);
      const layer = sp.layer[0] + (sp.layer[1] - sp.layer[0]) * 0.5;
      home.y = THREE.MathUtils.lerp(bed + 0.6, WATER_LEVEL - 0.6, layer);
      school.target.y = home.y;
      for (let i = 0; i < sp.school; i++) {
        const size = sp.size[0] + rand() * (sp.size[1] - sp.size[0]);
        school.fish.push({
          pos: home.clone().add(_v.set((rand() - 0.5) * 6, (rand() - 0.5) * 1.5, (rand() - 0.5) * 6)),
          vel: new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5).normalize().multiplyScalar(sp.speed[0]),
          off: new THREE.Vector3((rand() - 0.5) * 4, (rand() - 0.5) * 1.2, (rand() - 0.5) * 4),
          size,
          phase: rand() * 100,
          fear: 0,
          dart: 3 + rand() * 12,
          prevVel: new THREE.Vector3(),
          tint: new THREE.Color().setHSL(0.55 + (rand() - 0.5) * 0.08, 0.12, 0.7 + rand() * 0.25),
          index: fishTotal + i,
          school,
        });
      }
      fishTotal += sp.school;
      schools.push(school);
    }
    this.schools = schools;
    this.fishList = schools.flatMap((s) => s.fish);
    this.fishTotal = fishTotal;
    this.fishAttr = new THREE.InstancedBufferAttribute(new Float32Array(fishTotal * 4), 4);
    this.fishAttr.setUsage(THREE.DynamicDrawUsage);
    this.fishGeo.setAttribute('aFish', this.fishAttr);
    this.fish = new THREE.InstancedMesh(this.fishGeo, fishMaterial(), fishTotal);
    this.fish.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fish.castShadow = false;
    this.fish.receiveShadow = true;
    this.fish.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, -10, cz), 200);
    this.fish.name = 'fish';
    for (const f of this.fishList) {
      this.fish.setColorAt(f.index, f.tint);
      this.fishAttr.setXYZW(f.index, f.phase, 0.8, f.school.sp, 0);
    }
    this.fish.instanceColor.needsUpdate = true;
    this.fishActive = Math.min(fish, fishTotal);
    this.fish.count = this.fishActive;
    this.group.add(this.fish);
    this.dummy = dummy;

    // ---- reed beds along the shore
    const reedMat = reedMaterial();
    const reedGeos = [reedGeometry(rand), reedGeometry(rand), reedGeometry(rand)];
    const reeds = reedGeos.map(() => new Map());
    let nReeds = 0;
    scan((hc) => hc > -2.5 && hc < 1.5, 4, (x, z) => {
      if (nReeds >= 1400) return;
      const h = terrain.getHeight(x, z);
      if (h < -1.1 || h > 0.35) return;
      terrain.getNormal(x, z, _n);
      if (_n.y < 0.9) return;
      const patch = fbm(x * 0.04, z * 0.04, 2, 1500);
      if (patch < 0.05 || rand() > (patch - 0.05) * 3) return;
      const s = 0.8 + rand() * 0.5;
      dummy.position.set(x, h - 0.05, z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.set(s, s * (0.85 + rand() * 0.3), s);
      dummy.updateMatrix();
      const v = Math.floor(rand() * reedGeos.length);
      const key = `${Math.floor(x / SHORE_CHUNK)},${Math.floor(z / SHORE_CHUNK)}`;
      if (!reeds[v].has(key)) reeds[v].set(key, []);
      reeds[v].get(key).push(dummy.matrix.clone());
      nReeds++;
    });
    this.shoreGroup = new THREE.Group();
    this.shoreChunks = [];
    reeds.forEach((chunks, v) => {
      for (const list of chunks.values()) {
        const mesh = new THREE.InstancedMesh(reedGeos[v], reedMat, list.length);
        list.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.shoreGroup.add(mesh);
        this.shoreChunks.push(mesh);
      }
    });

    // ---- lily pads in calm shallow bays, some in flower
    const pads = [], flowers = [];
    const bays = [];
    attempts = 0;
    while (bays.length < 7 && attempts < 4000) {
      attempts++;
      const x = cx + (rand() * 2 - 1) * 230, z = cz + (rand() * 2 - 1) * 230;
      const d = depthAt(x, z);
      if (d < 0.7 || d > 1.8) continue;
      if (bays.some((b) => Math.hypot(b.x - x, b.z - z) < 40)) continue;
      bays.push({ x, z, r: 7 + rand() * 8 });
    }
    for (const bay of bays) {
      const local = [];
      for (let tries = 0; tries < 400 && local.length < 60; tries++) {
        const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * bay.r;
        const x = bay.x + Math.cos(a) * r, z = bay.z + Math.sin(a) * r;
        const d = depthAt(x, z);
        if (d < 0.45 || d > 2.6) continue;
        const s = 0.22 + rand() * 0.26;
        if (local.some((p) => Math.hypot(p.x - x, p.z - z) < (p.s + s) * 0.9)) continue;
        local.push({ x, z, s });
        dummy.position.set(x, WATER_LEVEL + 0.03, z);
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        pads.push(dummy.matrix.clone());
        if (rand() < 0.16) {
          dummy.position.y += 0.02;
          dummy.scale.setScalar(0.7 + rand() * 0.5);
          dummy.updateMatrix();
          flowers.push(dummy.matrix.clone());
        }
      }
    }
    const padMesh = new THREE.InstancedMesh(lilyPadGeometry(), lilyMaterial(false), Math.max(pads.length, 1));
    pads.forEach((m, i) => padMesh.setMatrixAt(i, m));
    padMesh.count = pads.length;
    padMesh.instanceMatrix.needsUpdate = true;
    padMesh.computeBoundingSphere();
    padMesh.receiveShadow = true;
    const flowerMesh = new THREE.InstancedMesh(lilyFlowerGeometry(), lilyMaterial(true), Math.max(flowers.length, 1));
    flowers.forEach((m, i) => flowerMesh.setMatrixAt(i, m));
    flowerMesh.count = flowers.length;
    flowerMesh.instanceMatrix.needsUpdate = true;
    flowerMesh.computeBoundingSphere();
    flowerMesh.castShadow = true;
    this.shoreGroup.add(padMesh, flowerMesh);
    this.shoreChunks.push(padMesh, flowerMesh);
    this.group.add(this.shoreGroup);
    this.counts = { kelp: placed, boulders: nRocks, reeds: nReeds, pads: pads.length, flowers: flowers.length };

    // ---- plankton and bubbles around the diver
    const mCount = 1500;
    const mPos = new Float32Array(mCount * 3), mSeed = new Float32Array(mCount), mKind = new Float32Array(mCount);
    for (let i = 0; i < mCount; i++) {
      mPos[i * 3] = (rand() * 2 - 1) * 15;
      mPos[i * 3 + 1] = (rand() * 2 - 1) * 15;
      mPos[i * 3 + 2] = (rand() * 2 - 1) * 15;
      mSeed[i] = rand();
      mKind[i] = i % 7 === 0 ? 1 : 0;
    }
    const mGeo = new THREE.BufferGeometry();
    mGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
    mGeo.setAttribute('aSeed', new THREE.BufferAttribute(mSeed, 1));
    mGeo.setAttribute('aKind', new THREE.BufferAttribute(mKind, 1));
    this.moteMat = moteMaterial();
    this.motes = new THREE.Points(mGeo, this.moteMat);
    this.motes.frustumCulled = false;
    this.motes.visible = false;
    this.group.add(this.motes);

    // ---- the surface seen from below
    const ceilGeo = new THREE.PlaneGeometry(1400, 1400, 1, 1);
    ceilGeo.rotateX(-Math.PI / 2);
    this.ceilingMat = ceilingMaterial(makeTileableNormalMap({ size: 256, seed: 33, minFreq: 2, maxFreq: 20, strength: 1.0 }));
    this.ceiling = new THREE.Mesh(ceilGeo, this.ceilingMat);
    this.ceiling.position.set(cx, WATER_LEVEL - 0.03, cz);
    this.ceiling.visible = false;
    this.ceiling.name = 'water-underside';
    this.group.add(this.ceiling);

    this.reflectionHidden = [this.kelpGroup, this.boulderGroup, this.fish, this.motes, this.ceiling];
    this.savedVisible = [];
  }

  /** Scale the plant density (0..1 of the generated set) and the number of live fish. */
  setQuality(kelp, fish) {
    this.kelpDensity = kelp;
    this.fishActive = Math.min(fish, this.fishTotal);
    this.fish.count = this.fishActive;
  }

  setEnabled(on) {
    this.enabled = on;
  }

  /** Hide the underwater objects while the lake renders its reflection. */
  setReflection(on) {
    if (on) {
      this.savedVisible = this.reflectionHidden.map((o) => o.visible);
      for (const o of this.reflectionHidden) o.visible = false;
    } else {
      this.reflectionHidden.forEach((o, i) => (o.visible = this.savedVisible[i]));
    }
  }

  // ------------------------------------------------------------------ fish behaviour

  simulate(dt, t, swimmer) {
    const terrain = this.terrain;
    const active = this.fishActive;
    for (const school of this.schools) {
      const sp = SPECIES[school.sp];
      const first = school.fish[0];
      if (!first || first.index >= active) continue;
      // the school's goal wanders through its home range on a smooth noise path,
      // pulled back toward home whenever it strays into water too shallow
      const s = t * 0.03 + school.seed;
      const ox = noise3(s, school.seed, 0) * sp.wander * 1.6, oz = noise3(0, school.seed, s) * sp.wander * 1.6;
      let tx = school.home.x + ox, tz = school.home.z + oz;
      for (let k = 0; k < 4; k++) {
        const d = WATER_LEVEL - terrain.getHeight(tx, tz);
        if (d >= sp.depth[0] + 0.8) break;
        tx = (tx + school.home.x) * 0.5;
        tz = (tz + school.home.z) * 0.5;
      }
      const bed = terrain.getHeight(tx, tz);
      const layer = THREE.MathUtils.lerp(sp.layer[0], sp.layer[1], noise3(s * 1.7, 3, school.seed) * 0.5 + 0.5);
      const ty = THREE.MathUtils.lerp(bed + 0.7, WATER_LEVEL - 0.6, layer);
      school.target.set(tx, ty, tz);

      const fish = school.fish;
      school.centre.set(0, 0, 0);
      school.avgVel.set(0, 0, 0);
      let n = 0;
      for (const f of fish) {
        if (f.index >= active) break;
        school.centre.add(f.pos);
        school.avgVel.add(f.vel);
        n++;
      }
      if (!n) continue;
      school.centre.divideScalar(n);
      school.avgVel.divideScalar(n);

      for (let i = 0; i < n; i++) {
        const f = fish[i];
        const steer = _v.set(0, 0, 0);
        // seek the goal (with a personal offset) and the school's centre
        steer.addScaledVector(_v2.copy(school.target).add(f.off).sub(f.pos), 0.35);
        steer.addScaledVector(_v2.copy(school.centre).sub(f.pos), sp.cohesion * 0.25);
        steer.addScaledVector(_v2.copy(school.avgVel).sub(f.vel), sp.align * 0.5);
        // keep personal space
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const o = fish[j];
          _v2.subVectors(f.pos, o.pos);
          const d = _v2.length();
          if (d < sp.sep && d > 1e-4) steer.addScaledVector(_v2, ((sp.sep - d) / sp.sep) * 6 / d);
        }
        // stay between the bed and the surface, and turn back from the shore ahead
        const bedHere = terrain.getHeight(f.pos.x, f.pos.z);
        if (f.pos.y < bedHere + 0.7) steer.y += (bedHere + 0.7 - f.pos.y) * 8;
        if (f.pos.y > WATER_LEVEL - 0.45) steer.y -= (f.pos.y - (WATER_LEVEL - 0.45)) * 8;
        const ax = f.pos.x + f.vel.x * 1.5, az = f.pos.z + f.vel.z * 1.5;
        const bedAhead = terrain.getHeight(ax, az);
        if (bedAhead > f.pos.y - 0.5) {
          steer.y += 3;
          steer.addScaledVector(_v2.copy(school.home).sub(f.pos).setY(0).normalize(), 4);
        }
        if (WATER_LEVEL - bedAhead < sp.depth[0] * 0.6) steer.addScaledVector(_v2.copy(school.home).sub(f.pos).setY(0).normalize(), 6);
        // the diver scares them
        f.fear = Math.max(0, f.fear - dt * 0.6);
        if (swimmer) {
          _v2.subVectors(f.pos, swimmer);
          const d = _v2.length();
          if (d < 7) {
            steer.addScaledVector(_v2.normalize(), (7 - d) * 3);
            f.fear = 1;
          }
        }
        // the occasional dart
        f.dart -= dt;
        if (f.dart < 0) {
          f.dart = 4 + this.rand() * 14;
          f.fear = Math.max(f.fear, 0.5);
          steer.addScaledVector(_v2.set(this.rand() - 0.5, (this.rand() - 0.5) * 0.3, this.rand() - 0.5), 30);
        }

        f.vel.addScaledVector(steer, dt);
        const maxS = sp.speed[1] + sp.burst * f.fear;
        const minS = sp.speed[0] * (0.7 + 0.3 * f.fear);
        const sp2 = f.vel.length();
        if (sp2 > maxS) f.vel.multiplyScalar(maxS / sp2);
        else if (sp2 < minS) f.vel.multiplyScalar(minS / Math.max(sp2, 1e-3));
        f.vel.y = THREE.MathUtils.clamp(f.vel.y, -sp.speed[1] * 0.5, sp.speed[1] * 0.5);
        f.pos.addScaledVector(f.vel, dt);
        f.pos.y = THREE.MathUtils.clamp(f.pos.y, terrain.getHeight(f.pos.x, f.pos.z) + 0.25, WATER_LEVEL - 0.3);

        // pose: face the velocity, bank into turns, beat the tail with speed
        const d = this.dummy;
        d.position.copy(f.pos);
        d.lookAt(_v2.copy(f.pos).add(f.vel));
        const turn = f.prevVel.x * f.vel.z - f.prevVel.z * f.vel.x;
        d.rotateZ(THREE.MathUtils.clamp(turn * 4, -0.5, 0.5));
        d.scale.set(f.size, f.size * sp.squash, f.size);
        d.updateMatrix();
        this.fish.setMatrixAt(f.index, d.matrix);
        f.prevVel.copy(f.vel);
        const speed = f.vel.length() / (sp.size[1] * 4);
        f.phase += dt * (3 + speed * 5) * (1 + f.fear);
        this.fishAttr.setXYZW(f.index, f.phase, 0.5 + Math.min(speed, 1) * 0.6, school.sp, 0);
      }
    }
    this.fish.instanceMatrix.needsUpdate = true;
    this.fishAttr.needsUpdate = true;
  }

  // ------------------------------------------------------------------ per frame

  update(dt, t, camera, { underwater = false, swimmer = null, sunDir, sunColor, skyColor, pixelRatio = 1, tint } = {}) {
    const cam = camera.position;
    const camD = Math.hypot(cam.x - LAKE_CENTER.x, cam.z - LAKE_CENTER.y);
    const near = this.enabled && camD < ACTIVE_RADIUS;
    this.kelpGroup.visible = near;
    this.boulderGroup.visible = near;
    this.fish.visible = near;
    this.shoreGroup.visible = this.enabled && camD < ACTIVE_RADIUS + 200;

    if (near) {
      for (const c of this.kelpChunks) {
        const d = c.centre.distanceTo(cam);
        c.mesh.visible = d < KELP_FAR + 30;
        const lod = 1 - THREE.MathUtils.smoothstep(d, 60, KELP_FAR) * 0.7;
        c.geo.instanceCount = Math.floor(c.total * this.kelpDensity * lod);
      }
      for (const m of this.shoreChunks) {
        const bs = m.boundingSphere || m.geometry.boundingSphere;
        m.visible = !bs || bs.center.distanceTo(cam) < SHORE_FAR + bs.radius;
      }
      // the sim runs whenever the lake is anywhere near so schools never freeze in view
      if (dt > 0) this.simulate(Math.min(dt, 0.1), t, swimmer);
    }

    this.motes.visible = underwater && this.enabled;
    this.ceiling.visible = underwater && this.enabled;
    if (underwater) {
      const mu = this.moteMat.uniforms;
      mu.uTime.value = t;
      mu.uCam.value.copy(cam);
      mu.uPixelRatio.value = pixelRatio;
      if (sunColor) mu.uLight.value.copy(sunColor).multiplyScalar(0.8).addScalar(0.08);
      const cu = this.ceilingMat.uniforms;
      cu.uTime.value = t;
      if (sunDir) cu.uSunDir.value.copy(sunDir);
      if (sunColor) cu.uSunColor.value.copy(sunColor);
      if (skyColor) cu.uSkyColor.value.copy(skyColor).multiplyScalar(1.4);
      if (tint) cu.uTint.value.copy(tint);
    }
  }
}
