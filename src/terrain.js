import * as THREE from 'three';
import { fbm, ridged, smoothstep, lerp, makeTileableNormalMap } from './noise.js';
import { patchMaterial, noiseGLSL } from './shaderlib.js';

export const TERRAIN_SIZE = 1600;
export const TERRAIN_SEGMENTS = 512;
export const WATER_LEVEL = 0;
export const PLATEAU_HEIGHT = 9;
export const LAKE_CENTER = new THREE.Vector2(150, -40);

/**
 * Relief of the lake bed: reefs of ridged rock, a drop-off that splits the
 * basin into a shallow shelf and a deep side, a sinuous trench along the
 * deep side and low dunes on the flats. Everything is scaled by how far the
 * plain bowl already sits below the surface, so the shoreline and the valley
 * above it are untouched, and no feature rises above -1.5 m.
 */
const reefMask = (x, z) => smoothstep(-0.05, 0.3, fbm(x * 0.011, z * 0.011, 3, 800));
const reefRidge = (x, z) => ridged(x * 0.03, z * 0.03, 4, 700);

/** How much reef rock rises at a point of the lake bed (0 on the flats, ~1 on a crest). */
export function lakeReef(x, z) {
  return reefMask(x, z) * reefRidge(x, z);
}

export function lakeBedInfo(x, z, h) {
  const lx = x - LAKE_CENTER.x, lz = z - LAKE_CENTER.y;
  const d2 = lx * lx + lz * lz;
  if (h > -1.5 || d2 > 300 * 300) return null;
  const m = smoothstep(-1.5, -6, h);
  const room = -1.5 - h;
  const d = Math.sqrt(d2);

  const rid = reefRidge(x, z);
  const reef = reefMask(x, z);
  let add = rid * rid * reef * Math.min(9, room * 0.65);

  const along = lx * 0.55 + lz * 0.83;
  const across = -lx * 0.83 + lz * 0.55 + Math.sin(along * 0.05) * 18 + fbm(x * 0.015, z * 0.015, 2, 900) * 10;
  const wall = smoothstep(-4, 8, across) * smoothstep(140, 80, d);
  add -= 8 * wall;

  const tr = across - 26 + Math.sin(along * 0.08) * 6;
  const trench = Math.exp(-(tr * tr) / (2 * 9 * 9)) * smoothstep(130, 70, d);
  add -= 7 * trench;

  add += fbm(x * 0.045, z * 0.045, 3, 1100) * 1.2 * (1 - reef * 0.7);

  return { height: h + add * m, reef: reef * rid * m, wall, trench, mask: m };
}

/** Analytic height function; the mesh and all placement use its sampled grid. */
export function heightFunction(x, z) {
  const r = Math.hypot(x, z);
  let h = fbm(x * 0.004, z * 0.004, 6) * 32 + 10;
  h += fbm(x * 0.03, z * 0.03, 3, 50) * 1.6;
  const m = ridged(x * 0.0022, z * 0.0022, 6);
  h += m * m * 260 * smoothstep(170, 560, r);

  const lx = x - LAKE_CENTER.x, lz = z - LAKE_CENTER.y;
  h -= 30 * Math.exp(-(lx * lx + lz * lz) / (2 * 75 * 75));

  // river valley leading out of the lake
  const rz = z + 40 + Math.sin(x * 0.012) * 40;
  if (x > 150) h -= 12 * Math.exp(-(rz * rz) / (2 * 14 * 14)) * smoothstep(150, 220, x);

  // flatten the plateau where the monument stands
  h = lerp(PLATEAU_HEIGHT, h, smoothstep(18, 60, r));

  const bed = lakeBedInfo(x, z, h);
  return bed ? bed.height : h;
}

// Tileable caustic pattern (after Dave Hoskins' water caustic).
export const causticGLSL = /* glsl */ `
float caustic(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
`;

export class Terrain {
  constructor() {
    const N = TERRAIN_SEGMENTS;
    const S = TERRAIN_SIZE;
    this.n = N + 1;
    this.cell = S / N;
    this.half = S / 2;

    this.heights = new Float32Array(this.n * this.n);
    for (let iz = 0; iz < this.n; iz++) {
      for (let ix = 0; ix < this.n; ix++) {
        const x = -this.half + ix * this.cell;
        const z = -this.half + iz * this.cell;
        this.heights[iz * this.n + ix] = heightFunction(x, z);
      }
    }

    const geo = new THREE.PlaneGeometry(S, S, N, N);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    // After rotation, vertex order is row-major with z increasing, matching our grid.
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.heights[i]);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    // Height texture lets the GPU grass shader sit exactly on the terrain.
    this.heightTexture = new THREE.DataTexture(this.heights, this.n, this.n, THREE.RedFormat, THREE.FloatType);
    this.heightTexture.minFilter = this.heightTexture.magFilter = THREE.NearestFilter;
    this.heightTexture.needsUpdate = true;

    const detail = makeTileableNormalMap({ size: 512, seed: 7, minFreq: 3, maxFreq: 40, strength: 1.4 });
    detail.repeat.set(S / 6, S / 6);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      normalMap: detail,
      normalScale: new THREE.Vector2(0.9, 0.9),
    });

    patchMaterial(mat, 'terrain', (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\nuniform float uTime;\nuniform float uWaterLevel;\n${noiseGLSL}\n${causticGLSL}`
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          vec3 wp = vWPos;
          vec3 wn = normalize(vWNormal);
          float slope = 1.0 - wn.y;
          float n1 = fbm2(wp.xz * 0.02);
          float n2 = fbm2(wp.xz * 0.15 + 13.1);
          float n3 = vnoise(wp.xz * 2.7);
          float n4 = vnoise(wp.xz * 11.0);

          vec3 grassA = vec3(0.045, 0.085, 0.018);
          vec3 grassB = vec3(0.10, 0.14, 0.035);
          vec3 dry    = vec3(0.24, 0.20, 0.09);
          vec3 grass = mix(grassA, grassB, smoothstep(0.3, 0.7, n1));
          grass = mix(grass, dry, smoothstep(0.55, 0.8, n2 * 0.6 + n1 * 0.4) * 0.7);
          grass *= 0.8 + 0.4 * n3;

          vec3 dirt = vec3(0.16, 0.11, 0.07) * (0.8 + 0.4 * n4);
          vec3 rock = mix(vec3(0.13, 0.12, 0.11), vec3(0.32, 0.29, 0.26), smoothstep(0.25, 0.75, n2));
          // horizontal strata in cliffs
          rock *= 0.75 + 0.35 * vnoise(vec2(wp.y * 0.7, n1 * 4.0)) + 0.15 * n4;
          vec3 sand = vec3(0.46, 0.39, 0.27) * (0.85 + 0.3 * n3);
          vec3 snow = vec3(0.85, 0.88, 0.95) * (0.92 + 0.08 * n3);

          float rockW = smoothstep(0.24, 0.40, slope + (n1 - 0.5) * 0.18);
          float dirtW = smoothstep(0.16, 0.24, slope + (n2 - 0.5) * 0.1) * (1.0 - rockW);
          float sandW = 1.0 - smoothstep(0.8, 2.6, wp.y + (n2 - 0.5) * 2.0);
          float snowW = smoothstep(165.0, 195.0, wp.y + n1 * 40.0) * (1.0 - smoothstep(0.28, 0.42, slope + (n2 - 0.5) * 0.2));
          float wet = 1.0 - smoothstep(-0.3, 0.9, wp.y);

          vec3 terrainCol = grass;
          terrainCol = mix(terrainCol, dirt, dirtW);
          terrainCol = mix(terrainCol, sand, sandW);
          terrainCol = mix(terrainCol, rock, rockW);
          terrainCol = mix(terrainCol, snow, snowW);

          // lake bed: rippled sand on the shallow shelf, silt in the deep basin,
          // gravel patches, and an algae film on rock where the light still reaches
          float uwD = uWaterLevel - wp.y;
          float uwM = smoothstep(-0.3, 1.0, uwD);
          vec2 ripDir = normalize(vec2(0.7, 0.7) + vec2(n1 - 0.5, n2 - 0.5) * 1.6);
          float ripPh = dot(wp.xz, ripDir) * 4.5 + n2 * 10.0;
          float ripple = sin(ripPh);
          float siltW = smoothstep(5.0, 11.0, uwD + (n2 - 0.5) * 4.0) * (1.0 - rockW);
          float algae = smoothstep(12.0, 2.0, uwD) * smoothstep(0.35, 0.7, n2 * 0.5 + n3 * 0.5);
          float gravelN = vnoise(wp.xz * 4.0 + 5.0);
          float gravel = smoothstep(0.45, 0.75, gravelN) * (1.0 - siltW) * (1.0 - rockW) * smoothstep(0.4, 0.6, n1);
          vec3 sandUW = vec3(0.42, 0.37, 0.25) * (0.85 + 0.3 * n3) * (0.92 + 0.08 * ripple);
          vec3 silt = vec3(0.12, 0.115, 0.09) * (0.8 + 0.4 * n4);
          vec3 rockUW = mix(rock, vec3(0.09, 0.2, 0.05), algae * 0.75);
          vec3 bed = mix(sandUW, silt, siltW);
          bed = mix(bed, vec3(0.2, 0.19, 0.17) * (0.7 + 0.6 * n4), gravel * 0.6);
          bed = mix(bed, rockUW, rockW);
          bed = mix(bed, vec3(0.05, 0.13, 0.03), algae * 0.4 * (1.0 - rockW) * (1.0 - siltW));
          terrainCol = mix(terrainCol, bed, uwM);
          terrainCol *= mix(1.0, mix(0.55, 0.72, uwM), wet);

          // rain: everything darkens, and flat hollows collect puddles
          float puddle = uWetness * smoothstep(0.58, 0.68, fbm2(wp.xz * 0.07 + 3.7))
                       * (1.0 - smoothstep(0.02, 0.07, slope)) * (1.0 - snowW) * (1.0 - sandW * 0.5);
          terrainCol *= mix(1.0, 0.62, uWetness * (1.0 - snowW));
          terrainCol *= mix(1.0, 0.45, puddle);
          diffuseColor.rgb *= terrainCol;
          `
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
          float roughnessFactor = mix(0.95, 0.82, rockW);
          roughnessFactor = mix(roughnessFactor, 0.45, snowW);
          roughnessFactor = mix(roughnessFactor, mix(0.25, mix(0.6, 0.45, rockW), uwM), wet);
          roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.45, uWetness * (1.0 - snowW));
          roughnessFactor = mix(roughnessFactor, 0.03, puddle);
          `
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          #include <normal_fragment_maps>
          if (uwM > 0.0) {
            // sand ripple crests and gravel bumps (analytic ripple slope, finite-difference gravel)
            vec2 g = ripDir * cos(ripPh) * 0.22 * (1.0 - siltW) * (1.0 - rockW);
            vec2 gp = wp.xz * 4.0 + 5.0;
            g += vec2(vnoise(gp + vec2(0.24, 0.0)) - gravelN, vnoise(gp + vec2(0.0, 0.24)) - gravelN) * 0.6 * gravel;
            normal = normalize(normal + mat3(viewMatrix) * vec3(-g.x, 0.0, -g.y) * uwM);
          }
          normal = normalize(mix(normal, normalize(vNormal), puddle)); // puddles are mirror flat
          `
        )
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `
          #include <lights_fragment_end>
          // sunlight focused by the water surface onto the lake bed, fading with depth
          float uwDepth = uWaterLevel - wp.y;
          if (uwDepth > 0.0) {
            float c = caustic(wp.xz * 0.28, uTime * 0.6);
            float att = exp(-uwDepth * 0.18) * smoothstep(0.0, 0.6, uwDepth);
            float deep = exp(-uwDepth * 0.045);
            vec3 tint = mix(vec3(1.0), vec3(0.35, 0.75, 0.8), smoothstep(0.0, 5.0, uwDepth));
            reflectedLight.directDiffuse *= (1.0 + c * att * 5.0) * deep * tint;
            reflectedLight.directSpecular *= deep * tint;
            reflectedLight.indirectDiffuse *= mix(1.0, deep, 0.6) * tint;
            reflectedLight.indirectSpecular *= mix(1.0, deep, 0.6) * tint;
          }
          `
        );
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.name = 'terrain';
  }

  /** Exact height on the rendered triangle mesh. */
  getHeight(x, z) {
    const fx = (x + this.half) / this.cell;
    const fz = (z + this.half) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.n - 1 || fz >= this.n - 1) return heightFunction(x, z);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const n = this.n, H = this.heights;
    const ha = H[iz * n + ix];
    const hb = H[(iz + 1) * n + ix];
    const hc = H[(iz + 1) * n + ix + 1];
    const hd = H[iz * n + ix + 1];
    if (tx + tz <= 1) return ha + (hd - ha) * tx + (hb - ha) * tz;
    return hc + (hb - hc) * (1 - tx) + (hd - hc) * (1 - tz);
  }

  getNormal(x, z, target = new THREE.Vector3()) {
    const e = this.cell;
    const hl = this.getHeight(x - e, z), hr = this.getHeight(x + e, z);
    const hd = this.getHeight(x, z - e), hu = this.getHeight(x, z + e);
    return target.set(hl - hr, 2 * e, hd - hu).normalize();
  }
}
