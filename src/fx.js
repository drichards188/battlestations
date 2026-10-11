import * as THREE from 'three';
import { globalUniforms } from './shaderlib.js';
import { mulberry32, noise3 } from './noise.js';

const rand = Math.random;
const rr = (a, b) => a + (b - a) * rand();
const tmpV = new THREE.Vector3();

// ---------------------------------------------------------------- puff atlas
// Four soft cumulus-like puffs in a 2x2 atlas. rg = billboard-space normal, a = density.
function makePuffAtlas(size = 128) {
  const N = size * 2;
  const data = new Uint8Array(N * N * 4);
  const r = mulberry32(77);
  for (let tile = 0; tile < 4; tile++) {
    const blobs = [];
    const nb = 9 + Math.floor(r() * 6);
    for (let i = 0; i < nb; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.22;
      blobs.push({ x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d * 0.9, s: 0.1 + r() * 0.13 });
    }
    const dens = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size, v = (y + 0.5) / size;
        let d = 0;
        for (const b of blobs) {
          const dx = u - b.x, dy = v - b.y;
          d += Math.exp(-(dx * dx + dy * dy) / (b.s * b.s));
        }
        const n = noise3(u * 7 + tile * 13, v * 7, tile) * 0.5 + noise3(u * 17, v * 17 + tile * 5, 3) * 0.25;
        const edge = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) / 0.5);
        dens[y * size + x] = Math.max(0, Math.min(1, (d * 0.55 + n * 0.6 - 0.2) * Math.min(1, edge * 3)));
      }
    }
    const ox = (tile % 2) * size, oy = Math.floor(tile / 2) * size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = (xx, yy) => dens[Math.min(size - 1, Math.max(0, yy)) * size + Math.min(size - 1, Math.max(0, xx))];
        const gx = (at(x + 1, y) - at(x - 1, y)) * 3.5;
        const gy = (at(x, y + 1) - at(x, y - 1)) * 3.5;
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const i = ((oy + y) * N + ox + x) * 4;
        data[i] = (-gx * inv * 0.5 + 0.5) * 255;
        data[i + 1] = (-gy * inv * 0.5 + 0.5) * 255;
        data[i + 2] = 255;
        data[i + 3] = Math.pow(at(x, y), 1.2) * 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------- particle pool
const FIELDS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'rot', 'rotV', 'r', 'g', 'b', 'a', 'glow', 'tile', 'drag', 'buoy', 'kind', 'len'];

class Pool {
  constructor(max) {
    this.max = max;
    this.n = 0;
    for (const f of FIELDS) this[f] = new Float32Array(max);
  }
  spawn() {
    if (this.n >= this.max) return -1;
    return this.n++;
  }
  kill(i) {
    const j = --this.n;
    if (i !== j) for (const f of FIELDS) this[f][i] = this[f][j];
  }
}

const quadGeo = (attrs, max) => {
  const q = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = q.index;
  g.setAttribute('position', q.attributes.position);
  g.setAttribute('uv', q.attributes.uv);
  const out = {};
  for (const name of attrs) {
    const arr = new Float32Array(max * 4);
    const a = new THREE.InstancedBufferAttribute(arr, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
    out[name] = a;
  }
  g.instanceCount = 0;
  return { geo: g, attrs: out };
};

// kinds (smoke system)
export const SMOKE = { FLAK: 0, PUFF: 1, TRAIL: 2, BLACK: 3, CORDITE: 4, SPRAY: 5, MIST: 6, HAZE: 7 };
// kinds (glow system)
const FLAME = 0, FLASH = 1, SPARK = 2;

export class FX {
  constructor(scene, { maxSmoke = 7000, maxGlow = 4000, maxDebris = 300, lights = 4 } = {}) {
    this.scene = scene;
    this.smoke = new Pool(maxSmoke);
    this.glow = new Pool(maxGlow);
    this.wind = new THREE.Vector3(-5, 0, 2);
    this.budget = 1; // scaled by the quality preset
    const atlas = makePuffAtlas();

    // lit, sorted smoke / spray
    const s = quadGeo(['iA', 'iB', 'iC'], maxSmoke);
    this.smokeAttrs = s.attrs;
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTex: { value: null },
          uLightView: { value: new THREE.Vector3(0, 1, 0) },
          uSun: { value: new THREE.Color(1, 1, 1) },
          uAmbient: { value: new THREE.Color(0.4, 0.45, 0.5) },
          uGlowColor: { value: new THREE.Color(4, 1.4, 0.3) },
        },
      ]),
      vertexShader: /* glsl */ `
        attribute vec4 iA; // position, size
        attribute vec4 iB; // albedo, alpha
        attribute vec4 iC; // rotation, glow, tile
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vGlow;
        varying float vRot;
        varying float vNear;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = viewMatrix * vec4(iA.xyz, 1.0);
          float c = cos(iC.x), s = sin(iC.x);
          mvPosition.xy += mat2(c, s, -s, c) * position.xy * iA.w;
          float tile = iC.z;
          vUv = (uv + vec2(mod(tile, 2.0), floor(tile / 2.0))) * 0.5;
          vCol = iB;
          vGlow = iC.y;
          vRot = iC.x;
          vNear = smoothstep(1.0, 4.0 + iA.w * 0.6, -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
          if (vNear < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // fully faded: skip the fill
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        uniform vec3 uLightView;
        uniform vec3 uSun;
        uniform vec3 uAmbient;
        uniform vec3 uGlowColor;
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vGlow;
        varying float vRot;
        varying float vNear;
        #include <fog_pars_fragment>
        void main() {
          vec4 t = texture2D(uTex, vUv);
          float a = t.a * vCol.a * vNear;
          if (a < 0.004) discard;
          vec2 nxy = t.rg * 2.0 - 1.0;
          float c = cos(vRot), s = sin(vRot);
          nxy = mat2(c, s, -s, c) * nxy;
          vec3 n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
          float ndl = dot(n, uLightView);
          float thin = 1.0 - t.a;
          vec3 light = uAmbient * (0.75 + 0.25 * n.y) + uSun * (0.3 + 0.7 * max(ndl, 0.0) + thin * 0.4 * max(-uLightView.z, 0.0));
          #ifdef USE_FOG
          // parachute flares light the smoke too (the flare uniforms come with the fog chunk)
          for (int fi = 0; fi < 4; fi++) {
            if (fi >= uFlareCount) break;
            vec3 fd = uFlarePos[fi] - vFogWorldPos;
            float d2 = dot(fd, fd);
            vec3 fl = normalize((viewMatrix * vec4(fd, 0.0)).xyz);
            light += uFlareCol[fi] / (d2 + 1.6e5) * (1.0 - smoothstep(9.0e6, 1.6e7, d2)) * (0.45 + 0.55 * max(dot(n, fl), 0.0) + thin * 0.3);
          }
          #endif
          vec3 col = vCol.rgb * light + uGlowColor * vGlow * (0.4 + t.a);
          gl_FragColor = vec4(col, a);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.smokeMat.uniforms.uTex.value = atlas;
    Object.assign(this.smokeMat.uniforms, globalUniforms);
    this.smokeMesh = new THREE.Mesh(s.geo, this.smokeMat);
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.renderOrder = 5;
    scene.add(this.smokeMesh);

    // additive HDR flames, flashes and sparks
    const gq = quadGeo(['iA', 'iB', 'iD'], maxGlow);
    this.glowAttrs = gq.attrs;
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: atlas },
        uFogDensity: { value: 0.0003 },
        uGlowScale: { value: 1 }, // turned down by night, when the eye is open wide
      },
      vertexShader: /* glsl */ `
        attribute vec4 iA; // position, size
        attribute vec4 iB; // hdr color, alpha
        attribute vec4 iD; // streak vector (world, length baked in), kind
        uniform float uFogDensity;
        uniform float uGlowScale;
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vKind;
        varying vec2 vQ;
        void main() {
          vec4 p0 = viewMatrix * vec4(iA.xyz, 1.0);
          vKind = iD.w;
          vec2 q = position.xy;
          vQ = q * 2.0;
          vUv = uv * 0.5;
          if (dot(iD.xyz, iD.xyz) > 1e-6) {
            // streak: stretch between the head and the tail in view space
            vec4 p1 = viewMatrix * vec4(iA.xyz - iD.xyz, 1.0);
            vec2 axis = p0.xy / -p0.z - p1.xy / -p1.z;
            axis = length(axis) > 1e-6 ? normalize(axis) : vec2(1.0, 0.0);
            vec2 perp = vec2(-axis.y, axis.x);
            float k = q.x + 0.5;
            vec4 p = mix(p1, p0, k);
            float w = max(iA.w, -p.z * 0.0015);
            p.xy += perp * q.y * w + axis * (q.x * w);
            gl_Position = projectionMatrix * p;
          } else {
            p0.xy += q * iA.w;
            gl_Position = projectionMatrix * p0;
          }
          float d = length(p0.xyz);
          vCol = iB * exp(-d * uFogDensity);
          vCol.rgb *= uGlowScale;
          vCol.a *= smoothstep(0.3, 1.5, -p0.z);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vKind;
        varying vec2 vQ;
        void main() {
          float a;
          if (vKind < 0.5) {
            a = texture2D(uTex, vUv).a;
            a = smoothstep(0.05, 0.8, a);
          } else if (vKind < 1.5) {
            float r = length(vQ);
            float ang = atan(vQ.y, vQ.x);
            float star = pow(abs(cos(ang * 3.0)), 12.0) * (1.0 - r) * 0.8;
            a = exp(-r * r * 9.0) + star + exp(-r * 3.5) * 0.25;
            a *= smoothstep(1.0, 0.8, r);
          } else {
            float r = abs(vQ.y);
            a = exp(-r * r * 6.0) * smoothstep(1.0, 0.6, abs(vQ.x));
          }
          gl_FragColor = vec4(vCol.rgb * a * vCol.a, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.glowMesh = new THREE.Mesh(gq.geo, this.glowMat);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 6;
    scene.add(this.glowMesh);

    // tumbling debris
    this.maxDebris = maxDebris;
    this.debris = [];
    const dg = new THREE.BoxGeometry(1, 0.25, 0.6);
    this.debrisMesh = new THREE.InstancedMesh(dg, new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: 0.7, metalness: 0.3 }), maxDebris);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.castShadow = true;
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.debrisMesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();

    // a fixed pool of point lights for nearby blasts and muzzle flashes (never added/removed at runtime)
    this.lights = [];
    for (let i = 0; i < lights; i++) {
      const l = new THREE.PointLight(0xffa860, 0, 0, 2);
      l.userData = { t: 0, life: 1, peak: 0 };
      scene.add(l);
      this.lights.push(l);
    }

    this.onWaterHit = null; // (pos, size) for debris splashes, set by main
    this._order = new Float64Array(maxSmoke);
    this._cam = new THREE.Vector3();
  }

  // ---------------------------------------------------------------- spawning
  addSmoke(kind, x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, { glow = 0, drag = 0.4, buoy = 0 } = {}) {
    const P = this.smoke;
    const i = P.spawn();
    if (i < 0) return;
    P.px[i] = x; P.py[i] = y; P.pz[i] = z;
    P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
    P.age[i] = 0; P.life[i] = life;
    P.s0[i] = s0; P.s1[i] = s1;
    P.rot[i] = rand() * 6.283; P.rotV[i] = rr(-0.3, 0.3);
    P.r[i] = r; P.g[i] = g; P.b[i] = b; P.a[i] = a;
    P.glow[i] = glow; P.tile[i] = Math.floor(rand() * 4);
    P.drag[i] = drag; P.buoy[i] = buoy; P.kind[i] = kind;
    return i;
  }

  addGlow(kind, x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, { len = 0, drag = 0.5, buoy = 0 } = {}) {
    const P = this.glow;
    const i = P.spawn();
    if (i < 0) return;
    P.px[i] = x; P.py[i] = y; P.pz[i] = z;
    P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
    P.age[i] = 0; P.life[i] = life;
    P.s0[i] = s0; P.s1[i] = s1;
    P.rot[i] = rand() * 6.283; P.rotV[i] = 0;
    P.r[i] = r; P.g[i] = g; P.b[i] = b; P.a[i] = a;
    P.kind[i] = kind; P.len[i] = len; P.drag[i] = drag; P.buoy[i] = buoy;
    P.tile[i] = Math.floor(rand() * 4);
    return i;
  }

  light(pos, intensity, life, color) {
    // reuse the weakest light
    let best = this.lights[0], bestV = Infinity;
    for (const l of this.lights) {
      const u = l.userData;
      const v = u.peak * Math.max(0, 1 - u.t / u.life);
      if (v < bestV) {
        bestV = v;
        best = l;
      }
    }
    if (bestV > intensity) return;
    best.position.copy(pos);
    best.color.set(color || 0xffa860);
    best.userData.t = 0;
    best.userData.life = life;
    best.userData.peak = intensity;
  }

  // A 5in burst: a fireball, then a jet-black cloud that is most of its size at once (the
  // explosion throws it out), ragged lobes and fragment streaks round it, then hangs in the sky
  // for a quarter of a minute, spreading and drifting. Thinned out with distance.
  flak(p) {
    const d = this._cam.distanceTo(p);
    if (d > 9000) return;
    const far = d > 3500 ? 0.4 : d > 1800 ? 0.7 : 1;
    this.addGlow(FLASH, p.x, p.y, p.z, 0, 0, 0, 0.14, 9, 17, 46, 30, 14, 1);
    this.addGlow(FLAME, p.x, p.y, p.z, 0, 0, 0, 0.45, 5, 10, 14, 5.5, 1.6, 1);
    if (d < 900) this.light(p, 2500, 0.18, 0xffb070);
    const k = Math.max(0.5, this.budget) * far;
    // the core: dense and black
    for (let i = 0, n = Math.max(2, Math.round(4 * k)); i < n; i++) {
      tmpV.randomDirection().multiplyScalar(rr(0.5, 2.5));
      this.addSmoke(SMOKE.FLAK, p.x + tmpV.x, p.y + tmpV.y, p.z + tmpV.z, tmpV.x * 2, tmpV.y * 2, tmpV.z * 2, rr(14, 20), rr(9, 12), rr(24, 32), 0.03, 0.029, 0.028, 0.96, { drag: 1.2 });
    }
    // ragged lobes thrown out and stopped by the air
    for (let i = 0, n = Math.max(1, Math.round(5 * k)); i < n; i++) {
      tmpV.randomDirection();
      this.addSmoke(SMOKE.FLAK, p.x + tmpV.x * 3, p.y + tmpV.y * 3, p.z + tmpV.z * 3, tmpV.x * rr(10, 18), tmpV.y * rr(10, 18), tmpV.z * rr(10, 18), rr(10, 15), rr(4, 6), rr(15, 21), 0.042, 0.04, 0.038, 0.85, { drag: 2.4 });
    }
    // fragments: dark streaks of smoke and a spray of hot sparks
    if (d < 2500) {
      for (let i = 0, n = Math.round(4 * k); i < n; i++) {
        const v = tmpV.randomDirection().multiplyScalar(rr(30, 45));
        this.addSmoke(SMOKE.PUFF, p.x, p.y, p.z, v.x, v.y, v.z, rr(1.2, 2), 1.2, 3.5, 0.05, 0.05, 0.05, 0.55, { drag: 1.8 });
      }
    }
    for (let i = 0; i < 10; i++) {
      const v = tmpV.randomDirection().multiplyScalar(rr(50, 110));
      this.addGlow(SPARK, p.x, p.y, p.z, v.x, v.y, v.z, rr(0.2, 0.45), 0.3, 0.12, 30, 16, 6, 1, { len: 0.05, drag: 1.5 });
    }
  }

  // A 40mm self-destructing at the end of its tracer: a sharp little flash and a tight dark puff,
  // a quarter the size of a 5in burst, that lingers. A burst of fire leaves a string of them.
  airburst(p) {
    const d = this._cam.distanceTo(p);
    if (d > 6000) return;
    this.addGlow(FLASH, p.x, p.y, p.z, 0, 0, 0, 0.07, 2.2, 4, 40, 26, 11, 1);
    this.addGlow(FLAME, p.x, p.y, p.z, 0, 0, 0, 0.18, 1, 2.2, 12, 5, 1.4, 1);
    const n = d < 2500 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.addSmoke(SMOKE.PUFF, p.x + rr(-0.6, 0.6), p.y + rr(-0.6, 0.6), p.z + rr(-0.6, 0.6), rr(-1, 1), rr(-1, 1), rr(-1, 1), rr(7, 10), rr(2, 2.6), rr(5.5, 7), 0.06, 0.058, 0.056, 0.9, { drag: 1.2 });
    }
  }

  // A muzzle flash. `own`: the player's own gun, a couple of metres from his eye, gets the flash its
  // flash hider really let out (about half a metre across on an Oerlikon, a metre on a Bofors) and
  // a dimmer core, or it would fill a third of the view and bloom over the gun.
  muzzle(p, dir, size = 1, smoke = true, own = false) {
    const s = size;
    const k = own ? 0.35 : 1, z = own ? 0.55 : 1;
    this.addGlow(FLASH, p.x + dir.x * 0.4 * s * z, p.y + dir.y * 0.4 * s * z, p.z + dir.z * 0.4 * s * z, 0, 0, 0, own ? 0.045 : 0.06, 0.9 * s * z, 1.4 * s * z * 0.85, 60 * k, 34 * k, 12 * k, 1);
    // a cone of flame along the bore that doesn't travel
    this.addGlow(SPARK, p.x, p.y, p.z, dir.x, dir.y, dir.z, 0.05, 0.45 * s * z, 0.6 * s * z, 40 * k, 20 * k, 6 * k, 1, { len: 2.2 * s * z, drag: 1e6 });
    if (smoke) {
      // pushed out ahead of the muzzle so it never sits on the camera
      this.addSmoke(SMOKE.CORDITE, p.x + dir.x * 3 * s, p.y + dir.y * 3 * s, p.z + dir.z * 3 * s, dir.x * 14 * s, dir.y * 14 * s, dir.z * 14 * s, rr(1, 2) * s, 0.6 * s, rr(3, 4.5) * s, 0.5, 0.48, 0.45, 0.35, { drag: 2.5, buoy: 0.6 });
    }
  }

  sparks(p, n = 8, speed = 25, color = [30, 18, 6]) {
    for (let i = 0; i < n; i++) {
      const v = tmpV.randomDirection().multiplyScalar(rr(0.3, 1) * speed);
      this.addGlow(SPARK, p.x, p.y, p.z, v.x, v.y + speed * 0.3, v.z, rr(0.25, 0.7), 0.08, 0.05, color[0], color[1], color[2], 1, { len: 0.04, drag: 0.6, buoy: -9.8 });
    }
  }

  /** Smoke puff for trails behind damaged aircraft and burning wreckage. k: 0 grey .. 1 black and burning. */
  trail(p, vel, k) {
    const black = k > 0.5;
    const c = black ? 0.035 : 0.3 - k * 0.3;
    this.addSmoke(black ? SMOKE.BLACK : SMOKE.TRAIL, p.x + rr(-0.3, 0.3), p.y + rr(-0.3, 0.3), p.z + rr(-0.3, 0.3), vel.x * 0.15, vel.y * 0.15, vel.z * 0.15, rr(2.5, 4.5) * (black ? 1.5 : 1), 1 + k, 4 + k * 5, c, c, c * 1.05, black ? 0.75 : 0.5, { drag: 1.2, glow: black ? 0.05 : 0 });
    if (k > 0.6) {
      this.addGlow(FLAME, p.x, p.y, p.z, vel.x * 0.6, vel.y * 0.6, vel.z * 0.6, rr(0.15, 0.3), 1.2, 2.6, 14, 5, 1.2, 1, { drag: 3 });
    }
  }

  /** One frame of a burning fire (ship fires call this repeatedly). */
  fire(p, size = 1, smokeRate = 1) {
    const s = size;
    this.addGlow(FLAME, p.x + rr(-1, 1) * s, p.y + rr(0, 1) * s, p.z + rr(-1, 1) * s, rr(-0.5, 0.5), rr(2, 5) * s, rr(-0.5, 0.5), rr(0.5, 1.1), 1.4 * s, 3.4 * s, 9, 3.6, 0.9, 1, { drag: 0.5 });
    if (rand() < 0.35 * smokeRate * this.budget) {
      this.addSmoke(SMOKE.BLACK, p.x, p.y + 2 * s, p.z, rr(-0.5, 0.5), rr(4, 7), rr(-0.5, 0.5), rr(12, 22), 2.5 * s, rr(18, 32) * Math.sqrt(s), 0.03, 0.028, 0.026, 0.8, { glow: 0.35, drag: 0.15, buoy: 0.4 });
    }
  }

  /** Funnel exhaust haze. */
  haze(p) {
    this.addSmoke(SMOKE.HAZE, p.x, p.y, p.z, rr(-0.4, 0.4), rr(2, 4), rr(-0.4, 0.4), rr(6, 10), 2, 12, 0.32, 0.31, 0.3, 0.18, { drag: 0.2, buoy: 0.1 });
  }

  explosion(p, size = 1, { water = false, debris = true, fireball = true } = {}) {
    const s = size;
    if (fireball) {
      this.addGlow(FLASH, p.x, p.y, p.z, 0, 0, 0, 0.18, 10 * s, 26 * s, 60, 40, 22, 1);
      const nf = Math.round(14 * s * this.budget) + 4;
      for (let i = 0; i < nf; i++) {
        const v = tmpV.randomDirection().multiplyScalar(rr(4, 16) * s);
        this.addGlow(FLAME, p.x + v.x * 0.15, p.y + v.y * 0.15, p.z + v.z * 0.15, v.x, v.y + 3 * s, v.z, rr(0.6, 1.4) * Math.sqrt(s), 3 * s, rr(8, 14) * s, 16, 6.5, 1.6, 1, { drag: 2.2, buoy: 1.5 });
      }
      this.light(p, 4000 * s * s, 0.6 + s * 0.5, 0xff9a50);
    }
    const ns = Math.round(10 * s * this.budget) + 3;
    for (let i = 0; i < ns; i++) {
      const v = tmpV.randomDirection().multiplyScalar(rr(3, 10) * s);
      this.addSmoke(SMOKE.BLACK, p.x + v.x * 0.3, p.y + v.y * 0.3, p.z + v.z * 0.3, v.x, Math.abs(v.y) + 2 * s, v.z, rr(6, 14) * Math.sqrt(s), 4 * s, rr(14, 26) * s, 0.04, 0.035, 0.03, 0.85, { glow: 0.5, drag: 1.2, buoy: 0.8 });
    }
    this.sparks(p, Math.round(18 * s) + 4, 30 * s + 15);
    if (debris) this.debrisBurst(p, Math.round(8 * s) + 3, 12 + 20 * s, 0.4 + s * 0.8);
    if (water) this.splash(p, size * 1.2);
  }

  /** Water column: a shell spout (size ~0.15) up to a bomb near-miss (size ~1). */
  splash(p, size = 1) {
    const s = size;
    const n = Math.round((8 + 34 * s) * this.budget) + 3;
    const h = 4 + 40 * s;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2, rad = rr(0, 1) * (1 + 5 * s);
      const up = Math.sqrt(2 * 9.8 * h) * rr(0.45, 1.0);
      const out = rr(0.5, 2.5) * (1 + 3 * s);
      this.addSmoke(SMOKE.SPRAY, p.x + Math.cos(a) * rad, 0.3, p.z + Math.sin(a) * rad, Math.cos(a) * out, up, Math.sin(a) * out, rr(1.4, 3.2) * (0.6 + s * 0.6), 1 + s * 2, rr(4, 9) * (0.4 + s), 0.86, 0.9, 0.92, 0.75, { drag: 0.25, buoy: -9.8 });
    }
    const nm = Math.round((3 + 10 * s) * this.budget) + 1;
    for (let i = 0; i < nm; i++) {
      const a = rand() * Math.PI * 2;
      this.addSmoke(SMOKE.MIST, p.x + Math.cos(a) * 3 * s, 1 + rand() * 4 * s, p.z + Math.sin(a) * 3 * s, Math.cos(a) * 6 * s, rr(1, 3), Math.sin(a) * 6 * s, rr(4, 8), 4 * s + 1, rr(16, 30) * s + 3, 0.8, 0.84, 0.86, 0.35, { drag: 0.8 });
    }
  }

  debrisBurst(p, n, speed, size) {
    for (let i = 0; i < n; i++) {
      if (this.debris.length >= this.maxDebris) break;
      const v = new THREE.Vector3().randomDirection().multiplyScalar(rr(0.3, 1) * speed);
      v.y = Math.abs(v.y) + speed * 0.3;
      this.debris.push({
        p: p.clone(),
        v,
        q: new THREE.Quaternion().random(),
        w: new THREE.Vector3().randomDirection().multiplyScalar(rr(4, 14)),
        s: size * rr(0.4, 1.2),
        life: rr(3, 7),
        smoke: rand() < 0.4,
      });
    }
  }

  // ---------------------------------------------------------------- update
  update(dt, camera, { sunDir, sunColor, sunIntensity = 6.5, ambient, night = 0 }) {
    const cam = this._cam.copy(camera.position);
    // by night the exposure is wide open: flashes and fires would bloom across half the sky
    this.glowMat.uniforms.uGlowScale.value = 1 - 0.65 * night;
    const wind = this.wind;

    // smoke
    const P = this.smoke;
    for (let i = P.n - 1; i >= 0; i--) {
      P.age[i] += dt;
      if (P.age[i] >= P.life[i]) {
        P.kill(i);
        continue;
      }
      const dk = Math.exp(-P.drag[i] * dt);
      // drag pulls velocity toward the wind
      P.vx[i] = wind.x + (P.vx[i] - wind.x) * dk;
      P.vz[i] = wind.z + (P.vz[i] - wind.z) * dk;
      P.vy[i] = P.vy[i] * (P.buoy[i] < 0 ? 1 : dk) + P.buoy[i] * dt;
      P.px[i] += P.vx[i] * dt;
      P.py[i] += P.vy[i] * dt;
      P.pz[i] += P.vz[i] * dt;
      P.rot[i] += P.rotV[i] * dt;
      if (P.kind[i] === SMOKE.SPRAY && P.py[i] < -1 && P.vy[i] < 0) P.age[i] = P.life[i];
    }
    // back-to-front order
    const n = P.n;
    const order = this._order;
    const fx = camera.matrixWorldInverse.elements;
    for (let i = 0; i < n; i++) {
      const z = fx[2] * P.px[i] + fx[6] * P.py[i] + fx[10] * P.pz[i] + fx[14];
      order[i] = Math.floor((z + 100000) * 8) * 16384 + i;
    }
    const sorted = order.subarray(0, n).sort();
    const A = this.smokeAttrs.iA.array, B = this.smokeAttrs.iB.array, C = this.smokeAttrs.iC.array;
    for (let k = 0; k < n; k++) {
      const i = sorted[k] % 16384;
      const t = P.age[i] / P.life[i];
      const grow = 1 - Math.pow(1 - t, 2.2);
      const o = k * 4;
      A[o] = P.px[i];
      A[o + 1] = P.py[i];
      A[o + 2] = P.pz[i];
      A[o + 3] = P.s0[i] + (P.s1[i] - P.s0[i]) * grow;
      const fade = Math.min(1, t * 12) * (1 - t * t);
      B[o] = P.r[i];
      B[o + 1] = P.g[i];
      B[o + 2] = P.b[i];
      B[o + 3] = P.a[i] * fade;
      C[o] = P.rot[i];
      C[o + 1] = P.glow[i] * Math.max(0, 1 - t * 3);
      C[o + 2] = P.tile[i];
    }
    for (const a of Object.values(this.smokeAttrs)) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
    this.smokeMesh.geometry.instanceCount = n;

    const su = this.smokeMat.uniforms;
    su.uLightView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
    su.uSun.value.copy(sunColor).multiplyScalar(sunIntensity / Math.PI);
    su.uAmbient.value.copy(ambient);

    // glow
    const Q = this.glow;
    for (let i = Q.n - 1; i >= 0; i--) {
      Q.age[i] += dt;
      if (Q.age[i] >= Q.life[i]) {
        Q.kill(i);
        continue;
      }
      if (Q.drag[i] < 1e5) {
        const dk = Math.exp(-Q.drag[i] * dt);
        Q.vx[i] *= dk;
        Q.vz[i] *= dk;
        Q.vy[i] = Q.vy[i] * dk + Q.buoy[i] * dt;
        Q.px[i] += Q.vx[i] * dt;
        Q.py[i] += Q.vy[i] * dt;
        Q.pz[i] += Q.vz[i] * dt;
      }
    }
    const GA = this.glowAttrs.iA.array, GB = this.glowAttrs.iB.array, GD = this.glowAttrs.iD.array;
    for (let i = 0; i < Q.n; i++) {
      const t = Q.age[i] / Q.life[i];
      const o = i * 4;
      const kind = Q.kind[i];
      GA[o] = Q.px[i];
      GA[o + 1] = Q.py[i];
      GA[o + 2] = Q.pz[i];
      GA[o + 3] = Q.s0[i] + (Q.s1[i] - Q.s0[i]) * Math.sqrt(t);
      let r = Q.r[i], g = Q.g[i], b = Q.b[i], a = Q.a[i];
      if (kind === FLAME) {
        // white-hot to orange to a dull red ember
        const cool = Math.min(1, t * 1.4);
        r *= 1 - cool * 0.55;
        g *= 1 - cool * 0.8;
        b *= 1 - cool * 0.95;
        a *= Math.min(1, t * 10) * (1 - t);
      } else if (kind === FLASH) {
        a *= 1 - t;
      } else {
        a *= 1 - t * t;
      }
      GB[o] = r;
      GB[o + 1] = g;
      GB[o + 2] = b;
      GB[o + 3] = a;
      const len = Q.len[i];
      if (len > 0) {
        const vx = Q.vx[i], vy = Q.vy[i], vz = Q.vz[i];
        if (Q.drag[i] >= 1e5) {
          // static cone: (vx, vy, vz) is a unit direction, len its length
          GD[o] = -vx * len;
          GD[o + 1] = -vy * len;
          GD[o + 2] = -vz * len;
        } else {
          GD[o] = vx * len;
          GD[o + 1] = vy * len;
          GD[o + 2] = vz * len;
        }
      } else {
        GD[o] = GD[o + 1] = GD[o + 2] = 0;
      }
      GD[o + 3] = kind;
    }
    for (const a of Object.values(this.glowAttrs)) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Q.n * 4);
      a.needsUpdate = true;
    }
    this.glowMesh.geometry.instanceCount = Q.n;

    // debris
    const m = this._m, q = this._q, sc = this._s;
    let k = 0;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      d.v.y -= 9.8 * dt;
      d.p.addScaledVector(d.v, dt);
      q.setFromAxisAngle(tmpV.copy(d.w).normalize(), d.w.length() * dt);
      d.q.multiply(q);
      if (d.smoke && rand() < dt * 20) this.trail(d.p, d.v, 0.2);
      if (d.p.y < 0 || d.life <= 0) {
        if (d.p.y < 0 && this.onWaterHit) this.onWaterHit(d.p, 0.08);
        this.debris.splice(i, 1);
      }
    }
    for (const d of this.debris) {
      sc.setScalar(d.s);
      m.compose(d.p, d.q, sc);
      this.debrisMesh.setMatrixAt(k++, m);
    }
    this.debrisMesh.count = k;
    this.debrisMesh.instanceMatrix.needsUpdate = true;

    // lights
    for (const l of this.lights) {
      const u = l.userData;
      u.t += dt;
      const f = Math.max(0, 1 - u.t / u.life);
      l.intensity = u.peak * f * f;
      l.visible = true;
    }
  }

  get counts() {
    return { smoke: this.smoke.n, glow: this.glow.n, debris: this.debris.length };
  }
}
