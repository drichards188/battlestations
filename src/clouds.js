import * as THREE from 'three';
import { globalUniforms, noiseGLSL } from './shaderlib.js';
import { mulberry32 } from './noise.js';

// Trade-wind cumulus: clusters of lit, soft billboards at 800-1600 m, recycled around the
// camera and drifting with the wind. Sorted back to front every frame.
const FIELD = 26000;

export class Clouds {
  constructor(scene, { count = 70 } = {}) {
    const rand = mulberry32(5);
    this.clouds = [];
    const puffs = [];
    for (let c = 0; c < count; c++) {
      const cloud = {
        x: (rand() - 0.5) * FIELD,
        z: (rand() - 0.5) * FIELD,
        base: 820 + rand() * 300,
        size: 0.6 + rand() * 1.1,
        puffs: [],
      };
      const n = Math.round(16 + cloud.size * 26);
      const w = 270 * cloud.size, tall = 280 * cloud.size;
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand());
        // a flat base layer, then towers that narrow upward
        const h = Math.pow(rand(), 1.6);
        const narrow = 1 - h * 0.6;
        const p = {
          cloud,
          ox: Math.cos(a) * d * w * narrow,
          oz: Math.sin(a) * d * w * 0.75 * narrow,
          oy: h * tall + 30,
          s: (100 + rand() * 130) * cloud.size * (1 - h * 0.3),
          seed: rand() * 100,
        };
        cloud.puffs.push(p);
        puffs.push(p);
      }
      this.clouds.push(cloud);
    }
    this.puffs = puffs;
    this.wind = new THREE.Vector2(-4, 1.5);

    const q = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = q.index;
    g.setAttribute('position', q.attributes.position);
    g.setAttribute('uv', q.attributes.uv);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(puffs.length * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(puffs.length * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.aA);
    g.setAttribute('iB', this.aB);
    g.instanceCount = puffs.length;
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uLightView: { value: new THREE.Vector3(0, 1, 0) },
          uSun: { value: new THREE.Color(1, 1, 1) },
          uAmbient: { value: new THREE.Color(0.5, 0.6, 0.7) },
          uCover: { value: 1 },
        },
      ]),
      vertexShader: /* glsl */ `
        attribute vec4 iA; // centre, size
        attribute vec4 iB; // height in cloud 0..1, seed, cloud base, unused
        varying vec2 vUv;
        varying vec4 vB;
        varying float vY;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = viewMatrix * vec4(iA.xyz, 1.0);
          mvPosition.xy += position.xy * iA.w;
          vUv = uv;
          vB = iB;
          vY = iA.y + position.y * iA.w * 0.6 - iB.z;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uLightView;
        uniform vec3 uSun;
        uniform vec3 uAmbient;
        uniform float uCover;
        varying vec2 vUv;
        varying vec4 vB;
        varying float vY;
        ${noiseGLSL}
        #include <fog_pars_fragment>
        void main() {
          vec2 q = vUv * 2.0 - 1.0;
          float r = length(q);
          if (r > 1.0) discard;
          vec3 n = vec3(q, sqrt(max(1.0 - r * r, 0.0)));
          // billowy, lumpy edges instead of a disc
          float lump = fbm2(q * 2.3 + vB.y) - 0.5;
          float fine = fbm2(q * 7.0 - vB.y * 1.7) - 0.5;
          float rr = r + lump * 0.3 + fine * 0.12;
          float dens = smoothstep(1.0, 0.5, rr);
          // flat, dark bases; bright, billowing tops
          dens *= smoothstep(-30.0, 40.0, vY);
          if (dens < 0.01) discard;
          float ndl = dot(n, uLightView);
          float hk = clamp(vY / 500.0, 0.0, 1.0);
          vec3 lit = uSun * (0.35 + 0.65 * max(ndl, 0.0)) * (0.55 + 0.45 * hk);
          lit += uSun * pow(max(-uLightView.z, 0.0), 6.0) * (1.0 - dens) * 0.6; // silver lining
          vec3 col = uAmbient * (0.6 + 0.5 * hk) + lit * 0.9;
          // parachute flares light the cloud bases from below (softened close in: a billboard is
          // not a volume, and a flare hanging just under one would blow it out)
          for (int fi = 0; fi < 4; fi++) {
            if (fi >= uFlareCount) break;
            vec3 fd = uFlarePos[fi] - vFogWorldPos;
            col += uFlareCol[fi] / (dot(fd, fd) + 1.0e6) * 0.15 * (1.0 - 0.5 * hk);
          }
          gl_FragColor = vec4(col, dens * 0.92 * uCover);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    Object.assign(this.mat.uniforms, globalUniforms);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.order = new Float64Array(puffs.length);
    this._v = new THREE.Vector3();
  }

  update(dt, camera, { sunDir, sunColor, sunIntensity = 6.5, ambient, cover = 1 }) {
    const cx = camera.position.x, cz = camera.position.z;
    const half = FIELD / 2;
    for (const c of this.clouds) {
      c.x += this.wind.x * dt;
      c.z += this.wind.y * dt;
      // wrap around the camera so the sky never runs out
      if (c.x - cx > half) c.x -= FIELD;
      if (c.x - cx < -half) c.x += FIELD;
      if (c.z - cz > half) c.z -= FIELD;
      if (c.z - cz < -half) c.z += FIELD;
    }
    const e = camera.matrixWorldInverse.elements;
    const P = this.puffs;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      const x = p.cloud.x + p.ox, y = p.cloud.base + p.oy, z = p.cloud.z + p.oz;
      p.x = x;
      p.y = y;
      p.z = z;
      const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
      this.order[i] = Math.floor((vz + 100000) * 4) * 8192 + i;
    }
    const sorted = this.order.sort();
    const A = this.aA.array, B = this.aB.array;
    for (let k = 0; k < P.length; k++) {
      const p = P[sorted[k] % 8192];
      const o = k * 4;
      A[o] = p.x;
      A[o + 1] = p.y;
      A[o + 2] = p.z;
      A[o + 3] = p.s;
      B[o] = p.oy / 400;
      B[o + 1] = p.seed;
      B[o + 2] = p.cloud.base;
    }
    this.aA.needsUpdate = true;
    this.aB.needsUpdate = true;
    const u = this.mat.uniforms;
    u.uLightView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
    u.uSun.value.copy(sunColor).multiplyScalar(sunIntensity / Math.PI);
    u.uAmbient.value.copy(ambient);
    u.uCover.value = cover;
  }
}
