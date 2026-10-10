import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../shaderlib.js';

// Gun models. AI mounts are low-poly vertex-colored geometry for InstancedMesh
// (the base trains about +Y, the gun elevates about +X at the pivot). The
// player's guns are detailed meshes with a camera anchor behind the bore.
// Model space: forward -Z, up +Y, right +X, meters.

const DEG = Math.PI / 180;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

export const MOUNT_KINDS = ['5in-twin', '5in-single', '40mm-quad', '40mm-twin', '20mm'];

// AI mount palette (sRGB hex, stored as linear vertex colors)
const C = {
  paint: 0x4c5764,
  paintDark: 0x3a434e,
  steel: 0x2f3337,
  black: 0x17181a,
  canvas: 0x535a60, // painted canvas
  rubber: 0x202020,
  brass: 0x9c7c3c,
  olive: 0x4d5233,
};

// ---------------------------------------------------------------- geometry helpers

function xf(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(1, 1, 1));
}

const box = (w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => new THREE.BoxGeometry(w, h, d).applyMatrix4(xf(x, y, z, rx, ry, rz));

// Cylinders along an axis from a0 to a1, radius r0 at a0 and r1 at a1.
const yTube = (y0, y1, r0, r1 = r0, seg = 16, x = 0, z = 0) =>
  new THREE.CylinderGeometry(r1, r0, y1 - y0, seg).applyMatrix4(xf(x, (y0 + y1) / 2, z));

function zTube(z0, z1, r0, r1 = r0, seg = 16, x = 0, y = 0) {
  const g = new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), seg);
  return g.applyMatrix4(xf(x, y, (z0 + z1) / 2, z1 > z0 ? Math.PI / 2 : -Math.PI / 2));
}

function xTube(x0, x1, r0, r1 = r0, seg = 16, y = 0, z = 0) {
  const g = new THREE.CylinderGeometry(r1, r0, Math.abs(x1 - x0), seg);
  return g.applyMatrix4(xf((x0 + x1) / 2, y, z, 0, 0, x1 > x0 ? -Math.PI / 2 : Math.PI / 2));
}

// Torus around the given axis ('x', 'y' or 'z').
function ring(R, r, axis, x, y, z, radial = 6, tubular = 24) {
  const rot = axis === 'x' ? [0, Math.PI / 2, 0] : axis === 'y' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  return new THREE.TorusGeometry(R, r, radial, tubular).applyMatrix4(xf(x, y, z, ...rot));
}

class FnCurve extends THREE.Curve {
  constructor(fn) {
    super();
    this.fn = fn;
  }
  getPoint(t, target = new THREE.Vector3()) {
    return target.copy(this.fn(t));
  }
}
const pathTube = (fn, segs, r, radial = 6) => new THREE.TubeGeometry(new FnCurve(fn), segs, r, radial, false);
const rod = (a, b, r, radial = 8) => pathTube((t) => a.clone().lerp(b, t), 1, r, radial);

const rect = (x0, x1, z0, z1, y) => [V(x0, y, z0), V(x1, y, z0), V(x1, y, z1), V(x0, y, z1)];

// Plan of an enclosed gunhouse at height y: flat front at z = front, straight
// sides at x = +-w, rounded rear centered at z = rearC.
function house(y, w, front, rearC, rearD, n = 8) {
  const pts = [V(-w, y, front), V(w, y, front)];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI;
    pts.push(V(Math.cos(a) * w, y, rearC + Math.sin(a) * rearD));
  }
  return pts;
}

// Convex solid through stacked rings of points (same count, ordered around the
// outline). Flat shaded, faces oriented away from the centroid.
function loft(rings, { top = true, bottom = false, crease = 0 } = {}) {
  const c = new THREE.Vector3();
  let n = 0;
  for (const r of rings) for (const p of r) {
    c.add(p);
    n++;
  }
  c.divideScalar(n);
  const out = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), m = new THREE.Vector3();
  const tri = (a, b, d) => {
    e1.subVectors(b, a);
    e2.subVectors(d, a);
    e1.cross(e2);
    if (e1.lengthSq() < 1e-12) return;
    m.copy(a).add(b).add(d).divideScalar(3).sub(c);
    if (e1.dot(m) < 0) out.push(a, d, b);
    else out.push(a, b, d);
  };
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < A.length; i++) {
      const j = (i + 1) % A.length;
      tri(A[i], A[j], B[j]);
      tri(A[i], B[j], B[i]);
    }
  }
  const cap = (R) => {
    for (let i = 1; i < R.length - 1; i++) tri(R[0], R[i], R[i + 1]);
  };
  if (top) cap(rings[rings.length - 1]);
  if (bottom) cap(rings[0]);
  const g = new THREE.BufferGeometry().setFromPoints(out);
  if (crease > 0) return toCreasedNormals(g, crease); // smooth the rounded rear, keep hard corners
  g.computeVertexNormals();
  return g;
}

// Thick wall on an arc between radii r0..r1 and heights y0..y1, centered on the
// Y axis. Angle a maps to (cos a, sin a) in XZ: 90 deg is +Z (rear), 270 deg is -Z (front).
function arcWall(r0, r1, y0, y1, a0, a1, seg) {
  const P = [], N = [];
  const quad = (a, b, c, d, na, nb, nc, nd) => {
    const fn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (fn.dot(na.clone().add(nb).add(nc).add(nd)) < 0) {
      [b, d] = [d, b];
      [nb, nd] = [nd, nb];
    }
    for (const [p, q] of [[a, na], [b, nb], [c, nc], [a, na], [c, nc], [d, nd]]) {
      P.push(p.x, p.y, p.z);
      N.push(q.x, q.y, q.z);
    }
  };
  const pt = (r, y, a) => V(Math.cos(a) * r, y, Math.sin(a) * r);
  const up = V(0, 1, 0), down = V(0, -1, 0);
  for (let i = 0; i < seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg, b = a0 + ((a1 - a0) * (i + 1)) / seg;
    const na = V(Math.cos(a), 0, Math.sin(a)), nb = V(Math.cos(b), 0, Math.sin(b));
    const ia = na.clone().negate(), ib = nb.clone().negate();
    quad(pt(r1, y0, a), pt(r1, y0, b), pt(r1, y1, b), pt(r1, y1, a), na, nb, nb, na);
    quad(pt(r0, y0, a), pt(r0, y0, b), pt(r0, y1, b), pt(r0, y1, a), ia, ib, ib, ia);
    quad(pt(r0, y1, a), pt(r0, y1, b), pt(r1, y1, b), pt(r1, y1, a), up, up, up, up);
    quad(pt(r0, y0, a), pt(r0, y0, b), pt(r1, y0, b), pt(r1, y0, a), down, down, down, down);
  }
  if (Math.abs(a1 - a0) < Math.PI * 2 - 1e-6) {
    for (const [a, s] of [[a0, -1], [a1, 1]]) {
      const t = V(-Math.sin(a) * s, 0, Math.cos(a) * s);
      quad(pt(r0, y0, a), pt(r1, y0, a), pt(r1, y1, a), pt(r0, y1, a), t, t, t, t);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  return g;
}

// Non-indexed, position + normal only, so everything merges.
function clean(geo) {
  let g = geo;
  if (g.index) {
    g = geo.toNonIndexed();
    geo.dispose();
  }
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.clearGroups();
  return g;
}

function setColor(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// Geometry merged into one buffer with a vertex color per part (AI mounts).
class ColorParts {
  constructor() {
    this.geos = [];
  }
  add(geo, hex) {
    this.geos.push(setColor(clean(geo), hex));
  }
  build() {
    const g = mergeGeometries(this.geos);
    for (const x of this.geos) x.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

// Geometry merged into one mesh per material (player guns). A part is either a
// material or { mat, color } for vertex-colored materials (paint shades).
class MatParts {
  constructor() {
    this.map = new Map();
  }
  add(spec, geo) {
    const mat = spec.isMaterial ? spec : spec.mat;
    const g = clean(geo);
    if (mat.vertexColors) setColor(g, spec.isMaterial ? 0xffffff : spec.color);
    if (!this.map.has(mat)) this.map.set(mat, []);
    this.map.get(mat).push(g);
  }
  build(parent) {
    for (const [mat, geos] of this.map) {
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      for (const g of geos) g.dispose();
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
    }
    this.map.clear();
    return parent;
  }
}

// ---------------------------------------------------------------- materials

const NOISE_GLSL = /* glsl */ `
varying vec3 vSurfPos;
float gHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float gNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(gHash(i + vec3(0.0, 1.0, 0.0)), gHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0.0, 0.0, 1.0)), gHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(gHash(i + vec3(0.0, 1.0, 1.0)), gHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

// Height bump from screen-space derivatives (no UVs or tangents needed).
const bumpGLSL = (h) => /* glsl */ `
  {
    float bh = ${h};
    vec3 bdx = dFdx(-vViewPosition);
    vec3 bdy = dFdy(-vViewPosition);
    vec3 br1 = cross(bdy, normal);
    vec3 br2 = cross(normal, bdx);
    float bdet = dot(bdx, br1);
    vec3 bgrad = sign(bdet) * (dFdx(bh) * br1 + dFdy(bh) * br2);
    normal = normalize(abs(bdet) * normal - bgrad);
  }
`;

// Wear from object-space noise, so it sticks to a part as it trains and elevates.
function wearPatch({ color, rough = '', metal = '', bump = '' }) {
  return (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSurfPos = transformed;');
    let f = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${color}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${rough}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${metal}`);
    if (bump) f = f.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${bumpGLSL(bump)}`);
    shader.fragmentShader = f;
  };
}

// Painted steel: mottling, grime, salt-stained streaks and chips down to dark primer.
const PAINT_WEAR = {
  color: /* glsl */ `
    vec3 sp = vSurfPos;
    float sN = gNoise(sp * 2.7) * 0.5 + gNoise(sp * 8.3) * 0.3 + gNoise(sp * 25.0) * 0.2;
    float sGrime = smoothstep(0.5, 0.85, gNoise(sp * 1.3 + 7.1) * 0.7 + gNoise(sp * 6.0) * 0.3);
    float sChip = smoothstep(0.84, 0.9, gNoise(sp * 17.0) * 0.75 + gNoise(sp * 53.0) * 0.25);
    float sStreak = smoothstep(0.62, 0.92, gNoise(vec3(sp.x * 34.0, sp.y * 1.3, sp.z * 34.0)));
    diffuseColor.rgb *= (0.88 + 0.2 * sN) * (1.0 - 0.3 * sGrime);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.72 + vec3(0.03, 0.017, 0.008), sStreak * 0.45);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.075, 0.07, 0.065), sChip * 0.85);
  `,
  rough: /* glsl */ `
    roughnessFactor = clamp(roughnessFactor * (0.9 + 0.25 * sN) + 0.15 * sGrime, 0.05, 1.0);
    roughnessFactor = mix(roughnessFactor, 0.32, sChip);
  `,
  metal: 'metalnessFactor = mix(metalnessFactor, 0.75, sChip);',
  bump: 'gNoise(sp * 70.0) * 0.00018 + gNoise(sp * 17.0) * 0.0003 - sChip * 0.00025',
};

// Gunmetal: blotchy tone and fine machining lines along the bore.
const METAL_WEAR = {
  color: /* glsl */ `
    vec3 sp = vSurfPos;
    float sN = gNoise(sp * 4.0) * 0.6 + gNoise(sp * 19.0) * 0.4;
    float sLine = gNoise(vec3(sp.x * 60.0, sp.y * 60.0, sp.z * 3.0));
    diffuseColor.rgb *= 0.8 + 0.35 * sN;
  `,
  rough: 'roughnessFactor = clamp(roughnessFactor + 0.18 * (sLine - 0.5) + 0.1 * (sN - 0.5), 0.12, 1.0);',
  bump: 'sLine * 0.00012',
};

// Non-slip tread plate: alternating diagonal lugs, worn bright where crews stand.
const DECK_WEAR = {
  color: /* glsl */ `
    vec3 sp = vSurfPos;
    float sN = gNoise(sp * 3.1) * 0.6 + gNoise(sp * 13.0) * 0.4;
    vec2 tq = sp.xz * 26.0;
    vec2 tc = fract(tq) - 0.5;
    float talt = mod(floor(tq.x) + floor(tq.y), 2.0);
    vec2 tr = talt > 0.5 ? vec2(tc.x + tc.y, tc.x - tc.y) : vec2(tc.x - tc.y, tc.x + tc.y);
    float sLug = smoothstep(0.13, 0.07, abs(tr.x)) * smoothstep(0.5, 0.42, abs(tr.y));
    float sWear = smoothstep(0.45, 0.8, gNoise(sp * 2.2 + 4.0));
    diffuseColor.rgb *= (0.85 + 0.25 * sN) * (1.0 - 0.3 * (1.0 - sLug) * sWear);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.16, 0.16), sLug * sWear * 0.7);
  `,
  rough: 'roughnessFactor = mix(roughnessFactor, 0.42, sLug * sWear);',
  metal: 'metalnessFactor = mix(metalnessFactor, 0.7, sLug * sWear);',
  bump: 'sLug * 0.0018 + gNoise(sp * 40.0) * 0.0002',
};

const MOUNT_WEAR = {
  color: /* glsl */ `
    vec3 sp = vSurfPos;
    float sN = gNoise(sp * 1.9) * 0.6 + gNoise(sp * 7.0) * 0.4;
    float sStreak = gNoise(vec3(sp.x * 9.0, sp.y * 0.8, sp.z * 9.0));
    diffuseColor.rgb *= (0.88 + 0.22 * sN) * (1.0 - 0.18 * smoothstep(0.55, 0.85, sStreak));
  `,
  rough: 'roughnessFactor = clamp(roughnessFactor + 0.12 * (sN - 0.5), 0.05, 1.0);',
};

let mountMaterial = null;
/** One vertex-colored paint material shared by every AI mount base and gun. */
export function createMountMaterial() {
  if (mountMaterial) return mountMaterial;
  mountMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.15 });
  patchMaterial(mountMaterial, 'mount-paint', wearPatch(MOUNT_WEAR));
  return mountMaterial;
}

let playerMats = null;
function playerMaterials() {
  if (playerMats) return playerMats;
  const std = (color, roughness, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.12 });
  const metal = std(0x2c2f33, 0.38, 0.7);
  const deck = std(0x3e4955, 0.75, 0.2);
  patchMaterial(paint, 'pgun-paint', wearPatch(PAINT_WEAR));
  patchMaterial(metal, 'pgun-metal', wearPatch(METAL_WEAR));
  patchMaterial(deck, 'pgun-deck', wearPatch(DECK_WEAR));
  // painted canvas (blast bags): blotchy, matte, darker in the creases
  const canvas = std(0x4f575e, 0.95, 0);
  patchMaterial(canvas, 'pgun-canvas', wearPatch({
    color: /* glsl */ `
      vec3 sp = vSurfPos;
      float sN = gNoise(sp * 6.0) * 0.6 + gNoise(sp * 23.0) * 0.4;
      diffuseColor.rgb *= 0.8 + 0.3 * sN;
    `,
    rough: 'roughnessFactor = clamp(roughnessFactor - 0.08 * sN, 0.6, 1.0);',
  }));
  playerMats = {
    paint: { mat: paint, color: 0x515c69 },
    paintDark: { mat: paint, color: 0x3a434e },
    metal,
    deck,
    brass: std(0xc8a050, 0.3, 1),
    olive: std(0x4d5233, 0.55, 0.1),
    rubber: std(0x151515, 0.9),
    canvas,
    glass: std(0x0b0f13, 0.06, 0.3),
    dark: std(0x08090a, 0.9),
  };
  return playerMats;
}

// ---------------------------------------------------------------- AI mounts

// Plan outline of an enclosed gunhouse at height y: chamfered front corners
// (cheeks), straight sides at x = +-w, chamfered rear corners.
function plan(y, { fw, w, front, cheek, rear, rw }) {
  const c = w - rw;
  return [V(-fw, y, front), V(fw, y, front), V(w, y, front + cheek), V(w, y, rear - c), V(rw, y, rear), V(-rw, y, rear), V(-w, y, rear - c), V(-w, y, front + cheek)];
}

// Small raised details on a flat face: rivet heads along a line.
function rivets(P, a, b, n, size, color) {
  for (let i = 0; i < n; i++) {
    const p = a.clone().lerp(b, (i + 0.5) / n);
    P.add(new THREE.OctahedronGeometry(size * 0.7).translate(p.x, p.y, p.z), color);
  }
}

// The twin 5"/38 Mk 28 enclosed mount (North Carolina, South Dakota and Iowa classes), shared by
// the AI model and the player's detailed one so the two line up exactly. Mount base space:
// origin on the barbette top at the training axis. NAVPERS 10797-A gives the twin gunhouse as
// about 15.5 ft long, 15 ft wide and 10.5 ft high; NavWeaps gives 84 in between the gun axes.
const MK28 = { fw: 1.62, w: 2.3, front: -2.05, rear: 2.35, rw: 1.85, eave: 1.95, roof: 2.74, slopeIn: 0.19 };
const MK28_PIVOT = V(0, 1.4, -1.85); // trunnion axis, just behind the face plate
const MK28_GX = 1.067; // half the 84 in between the gun axes
const MK28_MUZZLE = 4.95; // muzzle ahead of the trunnions (5.68 m overall gun length)
// Sight hoods projecting through the upper side plates: pointer at the left front, trainer at
// the right front, the checker on the left behind and above the pointer. Outer and inner x,
// front and rear z, top y; the telescope window is centred 0.27 below the top on the front face.
const MK28_HOODS = {
  pointer: { xo: -2.33, xi: -1.73, z0: -1.32, z1: -0.36, top: 3.02 },
  trainer: { xo: 2.33, xi: 1.73, z0: -1.32, z1: -0.36, top: 3.02 },
  checker: { xo: -2.27, xi: -1.79, z0: -0.2, z1: 0.42, top: 3.32 },
};
const MK28_HATCH = V(0, MK28.roof, 1.15); // mount captain's roof hatch, near the after end

// Enclosed 5"/38 gunhouse shared by the twin Mk 28/32 and the single Mk 30.
function gunhouse(base, { fw, w, front, rear, rw, eave, roof, ports, hoods = [], sideHoods = [], ears, slopeIn, doorZ = null, caseDoors = null, seg = 32, roofRivets = true }) {
  // training base: roller path skirt and the gunhouse foot ring
  base.add(yTube(0, 0.09, w + 0.05, w + 0.05, seg), C.paintDark);
  base.add(yTube(0.09, 0.22, w - 0.05, w - 0.05, seg), C.paint);
  const r0 = plan(0.22, { fw, w, front, cheek: 0.55, rear, rw });
  const r1 = plan(eave, { fw, w, front: front + slopeIn, cheek: 0.42, rear, rw });
  const r2 = plan(roof - 0.12, { fw: fw - 0.15, w: w - 0.12, front: front + slopeIn + 0.36, cheek: 0.36, rear: rear - 0.09, rw: rw - 0.09 });
  const r3 = plan(roof, { fw: fw - 0.24, w: w - 0.22, front: front + slopeIn + 0.48, cheek: 0.32, rear: rear - 0.17, rw: rw - 0.17 });
  base.add(loft([r0, r1, r2, r3], { crease: 20 * DEG }), C.paint);
  const slope = Math.atan2(slopeIn, eave - 0.22), cham = Math.atan2(0.36, roof - 0.12 - eave);
  const faceZ = (y) => front + (slopeIn * (y - 0.22)) / (eave - 0.22);
  const chamZ = (y) => front + slopeIn + (0.36 * (y - eave)) / (roof - 0.12 - eave);
  // gun ports: slots up the face plate and into the sloped roof front, so the guns reach 85 deg
  for (const x of ports) {
    base.add(box(0.56, eave - 0.95, 0.08, x, (eave + 0.95) / 2, faceZ((eave + 0.95) / 2) - 0.01, slope), C.black);
    base.add(box(0.56, 0.44, 0.08, x, eave + 0.19, chamZ(eave + 0.19) - 0.01, cham), C.black);
  }
  // horizontal plate seams and vertical butt straps with rivet rows on the sides
  const dz = doorZ ?? (front + rear) / 2 + 0.05;
  for (const sx of [-1, 1]) {
    base.add(box(0.014, 0.03, rear - front - 0.9, sx * (w + 0.007), 1.12, (front + rear) / 2 + 0.2), C.paintDark);
    for (const z of [front + 1.2, (front + rear) / 2 + 0.7]) {
      if (Math.abs(z - dz) < 0.5) continue;
      base.add(box(0.014, eave - 0.32, 0.05, sx * (w + 0.007), (eave + 0.22) / 2, z), C.paintDark);
      rivets(base, V(sx * (w + 0.02), 0.38, z), V(sx * (w + 0.02), eave - 0.12, z), 5, 0.035, C.paintDark);
    }
    // side access door with hinges and dogs
    base.add(box(0.04, 1.45, 0.78, sx * (w + 0.02), 0.95, dz), C.paintDark);
    for (const y of [0.45, 1.45]) base.add(xTube(sx * w, sx * (w + 0.07), 0.035, 0.035, 6, y, dz - 0.4), C.steel);
    for (const y of [0.7, 1.2]) base.add(box(0.05, 0.05, 0.1, sx * (w + 0.05), y, dz + 0.32), C.steel);
    // handrail along the side, ahead of the door
    const r1z = Math.min(rear - 0.9, dz - 0.55);
    base.add(rod(V(sx * (w + 0.12), 1.55, front + 1.1), V(sx * (w + 0.12), 1.55, r1z), 0.022, 5), C.paintDark);
    for (const z of [front + 1.1, r1z]) base.add(xTube(sx * w, sx * (w + 0.12), 0.02, 0.02, 5, 1.55, z), C.paintDark);
  }
  if (caseDoors) {
    // empty-case ejector doors low in the rear plate, upper scuttles for the hot-case men
    for (const x of caseDoors) {
      base.add(box(0.44, 0.4, 0.04, x, 0.72, rear + 0.015), C.paintDark);
      base.add(box(0.36, 0.3, 0.04, x * 0.92, 1.5, rear + 0.015), C.paintDark);
    }
  } else {
    // rear door
    base.add(box(0.85, 1.55, 0.05, 0, 1.02, rear + 0.015), C.paintDark);
    for (const y of [0.5, 1.5]) base.add(yTube(y - 0.08, y + 0.08, 0.03, 0.03, 6, 0.45, rear + 0.04), C.steel);
  }
  // roof: hatch, ventilator, periscope stub, lifting eyes, rivets along the edge
  const ry = roof;
  base.add(box(0.95, 0.07, 0.85, 0, ry + 0.035, rear - 1.25), C.paintDark);
  for (const x of [-0.38, 0.38]) base.add(xTube(x - 0.08, x + 0.08, 0.03, 0.03, 6, ry + 0.06, rear - 0.82), C.steel);
  base.add(yTube(ry, ry + 0.26, 0.12, 0.12, 8, -0.7, rear - 0.7), C.paintDark);
  base.add(yTube(ry + 0.26, ry + 0.34, 0.22, 0.2, 10, -0.7, rear - 0.7), C.paintDark);
  base.add(yTube(ry, ry + 0.18, 0.06, 0.06, 6, 0.8, rear - 1.6), C.steel);
  for (const x of [-(w - 0.5), w - 0.5]) base.add(ring(0.07, 0.018, 'z', x, ry + 0.06, rear - 0.5, 4, 8), C.steel);
  if (roofRivets) for (const sx of [-1, 1]) rivets(base, V(sx * (w - 0.6), ry + 0.01, front + slopeIn + 0.9), V(sx * (w - 0.6), ry + 0.01, rear - 0.4), 6, 0.03, C.paintDark);
  // pointer's and trainer's sight hoods on the roof (single mount)
  for (const x of hoods) {
    const z0 = front + slopeIn + 0.62;
    base.add(loft([rect(x - 0.28, x + 0.28, z0, z0 + 0.82, ry - 0.02), rect(x - 0.23, x + 0.23, z0 + 0.24, z0 + 0.78, ry + 0.34)], { crease: 30 * DEG }), C.paint);
    base.add(box(0.32, 0.15, 0.03, x, ry + 0.2, z0 + 0.1, -0.62), C.black);
    base.add(box(0.36, 0.04, 0.12, x, ry + 0.3, z0 + 0.12, -0.4), C.paintDark); // brow shade
  }
  // sight hoods through the upper side plates (twin mount), telescope window and open shutter
  for (const h of sideHoods) {
    const a = Math.min(h.xo, h.xi), b = Math.max(h.xo, h.xi), xc = (a + b) / 2;
    base.add(loft([rect(a, b, h.z0 + 0.05, h.z1, eave - 0.1), rect(a, b, h.z0, h.z1, h.top - 0.16), rect(a + 0.05, b - 0.05, h.z0 + 0.15, h.z1 - 0.06, h.top)], { crease: 30 * DEG }), C.paint);
    base.add(box(0.32, 0.14, 0.03, xc, h.top - 0.27, h.z0 - 0.01), C.black);
    base.add(box(0.44, 0.03, 0.22, xc, h.top - 0.11, h.z0 - 0.12, 0.35), C.paintDark);
  }
  // rangefinder ears on the rear quarters
  if (ears) {
    for (const sx of [-1, 1]) {
      base.add(xTube(sx * (w - 0.2), sx * (w + 0.42), 0.14, 0.14, 10, ry - 0.42, rear - 0.75), C.paint);
      base.add(box(0.16, 0.36, 0.38, sx * (w + 0.48), ry - 0.42, rear - 0.75), C.paint);
      base.add(box(0.12, 0.14, 0.03, sx * (w + 0.48), ry - 0.42, rear - 0.95), C.black);
    }
  }
}

// 5"/38 barrel with slide, canvas blast bag, a plain taper to the muzzle and a dark bore.
function fiveInchBarrel(gun, x) {
  gun.add(zTube(0.9, 0.12, 0.2, 0.2, 10, x), C.black); // slide, inside the house
  gun.add(zTube(0.16, -0.06, 0.36, 0.33, 12, x), C.canvas); // blast bag, gathered at the port
  gun.add(zTube(-0.06, -0.48, 0.33, 0.2, 12, x), C.canvas);
  for (const z of [0.08, -0.14]) gun.add(zTube(z + 0.02, z - 0.02, 0.35, 0.35, 12, x), C.canvas);
  gun.add(zTube(-0.46, -0.52, 0.205, 0.205, 12, x), C.steel); // slide nose and bag clamp
  gun.add(zTube(-0.52, -2.4, 0.152, 0.125, 14, x), C.paint);
  gun.add(zTube(-2.4, -4.86, 0.125, 0.1, 14, x), C.paint);
  gun.add(zTube(-4.86, -4.95, 0.104, 0.104, 14, x), C.steel);
  gun.add(zTube(-4.95, -4.952, 0.064, 0.064, 10, x), C.black); // bore
}

function mount5inTwin() {
  const base = new ColorParts(), gun = new ColorParts();
  gunhouse(base, { ...MK28, ports: [-MK28_GX, MK28_GX], sideHoods: Object.values(MK28_HOODS), ears: true, doorZ: 1.2, caseDoors: [-1.0, 1.0] });
  for (const x of [-MK28_GX, MK28_GX]) fiveInchBarrel(gun, x);
  gun.add(box(1.6, 0.18, 0.5, 0, 0, 0.4), C.black); // carriage between the slides, inside
  return {
    base: base.build(),
    gun: gun.build(),
    pivot: MK28_PIVOT.clone(),
    muzzles: [V(-MK28_GX, 0, -MK28_MUZZLE), V(MK28_GX, 0, -MK28_MUZZLE)],
    elev: [-15 * DEG, 85 * DEG],
    footprint: 2.6,
  };
}

function mount5inSingle() {
  const base = new ColorParts(), gun = new ColorParts();
  gunhouse(base, { fw: 1.12, w: 1.7, front: -1.65, rear: 1.8, rw: 1.35, eave: 1.7, roof: 2.42, ports: [0], hoods: [-1.0], ears: false, slopeIn: 0.15, seg: 20, roofRivets: false });
  fiveInchBarrel(gun, 0);
  // the Mk 30 body tapers: shift the barrel bands to the single gun's length
  return {
    base: base.build(),
    gun: gun.build(),
    pivot: V(0, 1.25, -1.48),
    muzzles: [V(0, 0, -4.9)],
    elev: [-15 * DEG, 85 * DEG],
    footprint: 2.0,
  };
}

// Open Bofors mount (quad Mk 2, twin Mk 1). Base: training ring, crew platform,
// carriage with side frames, seats, handwheels, sights. Gun: cradles, water-cooled
// barrels with flash hiders, loader guides holding clips, recoil springs.
// The crew platform matches the player's detailed quad so crew spots fit both.
function mountBofors(xs, { frameX, seatX, pivotY, cradles, plat, seg = 1 }) {
  const base = new ColorParts(), gun = new ColorParts();
  const n = (k) => Math.max(4, Math.round(k * seg));
  // training base, crew platform with tread rim and stanchions
  base.add(yTube(0, 0.3, frameX + 0.25, frameX + 0.2, n(20)), C.paintDark);
  base.add(yTube(0.3, 0.42, plat, plat, n(30)), C.paint);
  base.add(ring(plat, 0.02, 'y', 0, 0.42, 0, 3, n(28)), C.paintDark);
  // lower carriage and the elevating gear housing
  base.add(box(frameX * 2 + 0.02, 0.18, 1.2, 0, 0.51, 0.2), C.paint);
  base.add(box(0.5, 0.32, 0.45, 0, 0.72, 0.55), C.paintDark);
  for (const s of [-1, 1]) {
    // side frame with a lightening hole, trunnion bearing cap and bolts
    base.add(loft([rect(s * frameX, s * (frameX + 0.12), -0.6, 0.95, 0.42), rect(s * frameX, s * (frameX + 0.12), -0.28, 0.42, pivotY + 0.15)], { bottom: true }), C.paint);
    base.add(box(0.13, 0.3, 0.32, s * (frameX + 0.06), 0.85, 0.25), C.paintDark);
    base.add(xTube(s * (frameX - 0.02), s * (frameX + 0.2), 0.17, 0.17, n(12), pivotY), C.paint);
    base.add(xTube(s * (frameX + 0.2), s * (frameX + 0.24), 0.12, 0.1, n(10), pivotY), C.steel);
    // seat on a post, backrest, foot rest
    const sx = s * seatX;
    base.add(yTube(0.42, 0.92, 0.035, 0.035, 6, sx, 0.25), C.paintDark);
    base.add(box(0.42, 0.06, 0.4, sx, 0.93, 0.25), C.rubber);
    base.add(box(0.42, 0.42, 0.05, sx, 1.2, 0.47), C.rubber);
    base.add(box(0.04, 0.4, 0.04, sx, 1.0, 0.47), C.paintDark);
    base.add(xTube(sx - 0.2, sx + 0.2, 0.018, 0.018, 5, 0.6, -0.3), C.paintDark);
    // gearbox and handwheel with spokes and handle
    const hx = s * (seatX - 0.16);
    base.add(box(0.2, 0.28, 0.26, s * (frameX + 0.22), 1.2, -0.3), C.paint);
    base.add(xTube(s * (frameX + 0.32), hx, 0.03, 0.03, 6, 1.2, -0.3), C.steel);
    base.add(ring(0.17, 0.016, 'x', hx, 1.2, -0.3, 4, n(14)), C.steel);
    if (seg >= 1) for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      base.add(rod(V(hx, 1.2, -0.3), V(hx, 1.2 + Math.sin(a) * 0.17, -0.3 + Math.cos(a) * 0.17), 0.01, 4), C.steel);
    }
    base.add(xTube(hx, hx + s * 0.1, 0.018, 0.018, 5, 1.37, -0.3), C.rubber);
  }
  // pointer's and trainer's ring sights on a bar above the seats (train only)
  for (const s of [-1, 1]) {
    const x = s * (seatX - 0.05);
    base.add(yTube(0.42, pivotY + 0.62, 0.025, 0.02, 5, s * (frameX + 0.18), 0.6), C.paintDark);
    base.add(xTube(s * (frameX + 0.18), x, 0.02, 0.02, 5, pivotY + 0.62, 0.6), C.paintDark);
    base.add(ring(0.12, 0.007, 'z', x, pivotY + 0.62, 0.15, 3, n(12)), C.steel);
    if (seg >= 1) base.add(ring(0.055, 0.006, 'z', x, pivotY + 0.62, 0.15, 3, n(8)), C.steel);
    base.add(rod(V(x, pivotY + 0.62, 0.6), V(x, pivotY + 0.62, 0.15), 0.012, 4), C.paintDark);
  }

  // ---- elevating parts
  gun.add(xTube(-frameX + 0.04, frameX - 0.04, 0.07, 0.07, n(10)), C.steel);
  for (const [cx, w] of cradles) {
    gun.add(loft([rect(cx - w / 2, cx + w / 2, -0.32, 0.55, -0.24), rect(cx - w / 2, cx + w / 2, -0.26, 0.5, 0.12)], { bottom: true }), C.paint);
    // elevating arc under the cradle
    gun.add(pathTube((t) => {
      const b = (110 + t * 90) * DEG;
      return V(cx, Math.cos(b) * 0.5, Math.sin(b) * 0.5);
    }, n(8), 0.03, 4), C.steel);
  }
  for (const x of xs) {
    gun.add(zTube(0.05, -1.3, 0.082, 0.082, n(9), x), C.paint); // water jacket
    for (const z of [-0.02, -1.27]) gun.add(zTube(z + 0.035, z - 0.035, 0.092, 0.092, n(9), x), C.paintDark);
    gun.add(zTube(-1.3, -1.95, 0.044, 0.04, n(7), x), C.steel);
    gun.add(zTube(-1.95, -2.25, 0.042, 0.072, n(9), x), C.steel); // flash hider
    gun.add(zTube(0.1, -0.6, 0.028, 0.028, 5, x, 0.115), C.steel); // recoil spring
    gun.add(box(0.17, 0.2, 0.3, x, 0, 0.25), C.paint); // breech ring
    // loader guide posts with a 4-round clip standing in them
    for (const sd of [-1, 1]) for (const z of [-0.12, 0.17]) gun.add(box(0.014, 0.3, 0.025, x + sd * 0.072, 0.25, z), C.paintDark);
    gun.add(box(0.06, 0.23, 0.3, x, 0.22, 0.02), C.brass);
    for (let i = 0; i < 4; i++) gun.add(zTube(-0.13, -0.3, 0.021, 0.006, 5, x, 0.13 + i * 0.06), C.olive);
    gun.add(box(0.012, 0.25, 0.05, x + 0.034, 0.22, 0.05), C.steel); // clip spine
  }
  return {
    base: base.build(),
    gun: gun.build(),
    pivot: V(0, pivotY, 0),
    muzzles: xs.map((x) => V(x, 0, -2.25)),
    elev: [-15 * DEG, 90 * DEG],
    footprint: plat + 0.2,
  };
}

// Single 20mm Oerlikon: pedestal with height crank, cradle head, curved shield,
// gun with recoil spring casing, drum magazine, shoulder rests, ring sight.
function mount20mm() {
  const base = new ColorParts(), gun = new ColorParts();
  base.add(yTube(0, 0.06, 0.34, 0.32, 12), C.paintDark);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    base.add(yTube(0.06, 0.09, 0.02, 0.02, 4, Math.cos(a) * 0.28, Math.sin(a) * 0.28), C.steel);
  }
  base.add(yTube(0.06, 0.62, 0.13, 0.12, 12), C.paint);
  base.add(yTube(0.62, 0.68, 0.15, 0.15, 12), C.paintDark);
  base.add(yTube(0.68, 1.02, 0.1, 0.09, 10), C.paint);
  base.add(box(0.1, 0.16, 0.12, 0.15, 0.5, 0), C.paintDark); // height gear
  base.add(rod(V(0.2, 0.5, 0), V(0.32, 0.5, 0), 0.015, 4), C.steel);
  base.add(rod(V(0.32, 0.5, 0), V(0.32, 0.38, 0.06), 0.012, 4), C.steel); // crank
  base.add(yTube(1.02, 1.14, 0.15, 0.15, 10), C.paint);
  for (const s of [-1, 1]) {
    base.add(box(0.05, 0.32, 0.12, s * 0.16, 1.26, 0), C.paint); // yoke
    base.add(rod(V(s * 0.16, 1.14, -0.05), V(s * 0.3, 0.95, -0.62), 0.018, 4), C.paintDark); // shield struts
  }
  // shield: two plates, the upper one cut back over the gun
  base.add(arcWall(0.74, 0.756, 0.4, 0.92, 222 * DEG, 318 * DEG, 10), C.paint);
  base.add(arcWall(0.74, 0.756, 0.92, 1.12, 236 * DEG, 304 * DEG, 8), C.paint);
  base.add(arcWall(0.756, 0.77, 0.9, 0.94, 222 * DEG, 318 * DEG, 10), C.paintDark);

  gun.add(box(0.1, 0.15, 0.5, 0, -0.02, 0.2), C.steel); // receiver
  gun.add(box(0.11, 0.03, 0.4, 0, 0.065, 0.22), C.paintDark);
  gun.add(zTube(-0.05, -0.58, 0.052, 0.052, 8), C.steel); // recoil spring casing
  for (let i = 0; i < 4; i++) gun.add(zTube(-0.1 - i * 0.12, -0.12 - i * 0.12, 0.057, 0.057, 8), C.paintDark);
  gun.add(zTube(-0.58, -1.6, 0.024, 0.021, 6), C.steel);
  gun.add(zTube(-1.6, -1.75, 0.022, 0.042, 8), C.steel); // flash hider
  gun.add(yTube(0.08, 0.2, 0.19, 0.19, 14, 0, 0.12), C.paintDark); // drum magazine
  gun.add(ring(0.19, 0.01, 'y', 0, 0.14, 0.12, 3, 14), C.paint);
  gun.add(yTube(0.2, 0.23, 0.05, 0.05, 6, 0, 0.12), C.steel);
  // ring sight on a bracket above the gun, front sight post
  gun.add(rod(V(0, 0.08, 0.3), V(0, 0.3, 0.3), 0.012, 4), C.steel);
  gun.add(ring(0.1, 0.006, 'z', 0, 0.36, 0.3, 3, 12), C.steel);
  gun.add(ring(0.045, 0.005, 'z', 0, 0.36, 0.3, 3, 8), C.steel);
  gun.add(rod(V(0, 0.06, -0.5), V(0, 0.32, -0.5), 0.008, 4), C.steel);
  for (const s of [-1, 1]) {
    gun.add(box(0.08, 0.16, 0.07, s * 0.17, -0.12, 0.62), C.rubber); // shoulder rests
    gun.add(rod(V(s * 0.05, -0.05, 0.42), V(s * 0.17, -0.1, 0.6), 0.012, 4), C.steel);
    gun.add(yTube(-0.28, -0.12, 0.018, 0.018, 5, s * 0.12, 0.48), C.rubber); // grips
  }
  return {
    base: base.build(),
    gun: gun.build(),
    pivot: V(0, 1.3, 0),
    muzzles: [V(0, 0, -1.75)],
    elev: [-15 * DEG, 87 * DEG],
    footprint: 0.85,
  };
}

/** Geometry for every AI mount kind (see MOUNT_KINDS). */
export function buildMountModels() {
  return {
    '5in-twin': mount5inTwin(),
    '5in-single': mount5inSingle(),
    '40mm-quad': mountBofors([-0.68, -0.36, 0.36, 0.68], { frameX: 0.98, seatX: 1.58, pivotY: 1.3, plat: 1.95, cradles: [[-0.52, 0.6], [0.52, 0.6]] }),
    '40mm-twin': mountBofors([-0.22, 0.22], { frameX: 0.55, seatX: 1.08, pivotY: 1.15, plat: 1.32, cradles: [[0, 0.82]], seg: 0.7 }),
    '20mm': mount20mm(),
  };
}

// ---------------------------------------------------------------- gun crews

export const CREW_POSES = ['stand', 'load', 'point', 'brace'];

// Crew palette (sRGB): dungarees, chambray shirt, kapok vest, helmet, flash gear.
const K = {
  skin: 0xa77c60,
  dungaree: 0x2b3850,
  chambray: 0x7189ab,
  vestTan: 0xa38d5c,
  vestGrey: 0x6c6f6a,
  helmet: 0x4a535c,
  shoe: 0x1b1916,
  flash: 0xc4bda8,
  belt: 0x3a3124,
};

// Joint positions per pose (metres, origin at the feet, facing -Z). l/r = the
// sailor's left (+X) and right (-X) side.
const POSES = {
  stand: {
    hip: [0, 0.95, 0.01], l: { hip: [0.1, 0.93, 0.01], knee: [0.11, 0.5, -0.01], ankle: [0.12, 0.09, 0.02], sh: [0.2, 1.42, 0.01], el: [0.25, 1.14, 0.04], wr: [0.26, 0.88, 0.0] },
    r: { hip: [-0.1, 0.93, 0.01], knee: [-0.11, 0.5, -0.01], ankle: [-0.12, 0.09, 0.02], sh: [-0.2, 1.42, 0.01], el: [-0.25, 1.14, 0.04], wr: [-0.24, 0.89, -0.03] },
    neck: [0, 1.5, 0.0], head: [0, 1.62, -0.01],
  },
  load: {
    hip: [0, 0.9, 0.08], l: { hip: [0.11, 0.88, 0.08], knee: [0.14, 0.5, -0.1], ankle: [0.14, 0.09, 0.0], sh: [0.19, 1.33, -0.15], el: [0.24, 1.18, -0.36], wr: [0.15, 1.22, -0.52] },
    r: { hip: [-0.11, 0.88, 0.08], knee: [-0.12, 0.49, -0.04], ankle: [-0.13, 0.09, 0.14], sh: [-0.19, 1.33, -0.15], el: [-0.24, 1.18, -0.36], wr: [-0.15, 1.22, -0.52] },
    neck: [0, 1.41, -0.2], head: [0, 1.52, -0.27],
    clip: true,
  },
  point: {
    // seated, feet forward, hands out on the handwheels
    hip: [0, 0.56, 0.08], l: { hip: [0.11, 0.55, 0.08], knee: [0.13, 0.55, -0.32], ankle: [0.13, 0.09, -0.36], sh: [0.19, 1.04, 0.02], el: [0.23, 0.83, -0.16], wr: [0.17, 0.82, -0.4] },
    r: { hip: [-0.11, 0.55, 0.08], knee: [-0.13, 0.55, -0.32], ankle: [-0.13, 0.09, -0.36], sh: [-0.19, 1.04, 0.02], el: [-0.23, 0.83, -0.16], wr: [-0.17, 0.82, -0.4] },
    neck: [0, 1.12, -0.02], head: [0, 1.24, -0.06],
  },
  brace: {
    // feet apart, knees flexed, leaning into the shoulder rests, hands up on the grips
    hip: [0, 0.88, 0.06], l: { hip: [0.11, 0.86, 0.06], knee: [0.2, 0.48, -0.06], ankle: [0.24, 0.09, 0.02], sh: [0.2, 1.34, -0.04], el: [0.3, 1.2, -0.24], wr: [0.2, 1.3, -0.4] },
    r: { hip: [-0.11, 0.86, 0.06], knee: [-0.2, 0.48, 0.0], ankle: [-0.24, 0.09, 0.14], sh: [-0.2, 1.34, -0.04], el: [-0.3, 1.2, -0.24], wr: [-0.2, 1.3, -0.4] },
    neck: [0, 1.42, -0.06], head: [0, 1.54, -0.1],
  },
};

const UP = new THREE.Vector3(0, 1, 0);
// Tapered open tube from a to b (radius r0 at a, r1 at b).
function limb(a, b, r0, r1, seg = 7) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.normalize());
  return g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, V(1, 1, 1)));
}
const ball = (p, r, w = 6, h = 4) => new THREE.SphereGeometry(r, w, h).translate(p.x, p.y, p.z);

// Elliptic ring perpendicular to the axis `up` (unit), lateral axis near +X.
function ellipse(c, up, rx, rz, n = 8) {
  const side = V(1, 0, 0).addScaledVector(up, -up.x).normalize();
  const depth = new THREE.Vector3().crossVectors(side, up).normalize();
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(c.clone().addScaledVector(side, Math.cos(a) * rx).addScaledVector(depth, Math.sin(a) * rz));
  }
  return pts;
}

const sailorCache = new Map();

/**
 * A WWII USN gun crewman: steel helmet, kapok life vest, chambray and dungarees,
 * optionally anti-flash hood and gloves. Origin at the feet, facing -Z.
 * opts: { flash, vest: 'tan' | 'grey' } (defaults depend on the pose).
 */
export function buildSailor(pose = 'stand', opts = {}) {
  const flash = opts.flash ?? (pose === 'point' || pose === 'load');
  const vest = opts.vest ?? (pose === 'stand' ? 'grey' : 'tan');
  const key = `${pose}|${flash}|${vest}`;
  if (sailorCache.has(key)) return sailorCache.get(key);
  const J = POSES[pose] || POSES.stand;
  const P = new ColorParts();
  const v = (a) => V(a[0], a[1], a[2]);
  const vestC = vest === 'grey' ? K.vestGrey : K.vestTan;
  const handC = flash ? K.flash : K.skin;

  for (const side of [J.l, J.r]) {
    const hip = v(side.hip), knee = v(side.knee), ankle = v(side.ankle);
    P.add(limb(hip, knee, 0.078, 0.06), K.dungaree);
    P.add(ball(knee, 0.06), K.dungaree);
    P.add(limb(knee, ankle, 0.056, 0.046), K.dungaree);
    // shoe: heel to toe along the facing direction
    const heel = ankle.clone().add(V(0, -0.045, 0.05)), toe = ankle.clone().add(V(0, -0.05, -0.17));
    P.add(limb(heel, toe, 0.05, 0.045, 6), K.shoe);
    P.add(ball(toe, 0.045, 6, 3), K.shoe);
    const sh = v(side.sh), el = v(side.el), wr = v(side.wr);
    P.add(ball(sh, 0.062), vestC);
    P.add(limb(sh, el, 0.05, 0.043), K.chambray);
    P.add(ball(el, 0.043), K.chambray);
    P.add(limb(el, wr, 0.042, 0.034), K.chambray);
    P.add(ball(wr.clone().add(new THREE.Vector3().subVectors(wr, el).normalize().multiplyScalar(0.05)), 0.046), handC);
  }

  // torso: pelvis and belly in dungarees, belt, chest under the bulky kapok vest
  const hip = v(J.hip), neck = v(J.neck), head = v(J.head);
  const axis = new THREE.Vector3().subVectors(neck, hip).normalize();
  const along = (k) => hip.clone().lerp(neck, k);
  P.add(loft([ellipse(along(-0.06), axis, 0.15, 0.1), ellipse(along(0.18), axis, 0.155, 0.105)], { top: false, bottom: true }), K.dungaree);
  P.add(loft([ellipse(along(0.18), axis, 0.16, 0.11), ellipse(along(0.24), axis, 0.16, 0.11)], { top: false }), K.belt);
  P.add(loft([ellipse(along(0.24), axis, 0.175, 0.13), ellipse(along(0.62), axis, 0.205, 0.15), ellipse(along(0.9), axis, 0.19, 0.13), ellipse(along(1.0), axis, 0.11, 0.09)]), vestC);
  // vest collar
  P.add(loft([ellipse(along(0.96), axis, 0.13, 0.11), ellipse(along(1.07), axis, 0.1, 0.09)], { top: false }), vestC);
  P.add(limb(neck, head.clone().lerp(neck, 0.5), 0.05, 0.05, 6), flash ? K.flash : K.skin);

  // head, face, helmet with its brim
  const fwd = new THREE.Vector3().subVectors(head, neck).cross(V(1, 0, 0)).normalize().negate();
  P.add(ball(head, 0.1, 8, 6), flash ? K.flash : K.skin);
  if (flash) P.add(new THREE.SphereGeometry(0.068, 8, 5).scale(1, 1.3, 0.5).translate(head.x, head.y - 0.012, head.z).translate(fwd.x * 0.075, fwd.y * 0.075, fwd.z * 0.075), K.skin); // face opening in the hood
  const tilt = new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3().subVectors(head, neck).normalize());
  const hm = new THREE.Matrix4().compose(head.clone().add(V(0, 0.035, 0)), tilt, V(1, 1, 1));
  P.add(new THREE.SphereGeometry(0.128, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1).applyMatrix4(hm), K.helmet);
  P.add(new THREE.CylinderGeometry(0.15, 0.155, 0.014, 12, 1, true).scale(1, 1, 1.1).applyMatrix4(hm), K.helmet);
  P.add(new THREE.CircleGeometry(0.155, 12).rotateX(Math.PI / 2).scale(1, 1, 1.1).translate(0, -0.007, 0).applyMatrix4(hm), K.helmet);

  if (J.clip) {
    // a 4-round 40mm clip held in front, rounds horizontal and pointing forward
    const c = v(J.l.wr).lerp(v(J.r.wr), 0.5).add(V(0, -0.02, -0.06));
    P.add(box(0.058, 0.23, 0.3, c.x, c.y - 0.0, c.z + 0.02), C.brass);
    for (let i = 0; i < 4; i++) P.add(zTube(c.z - 0.13, c.z - 0.3, 0.021, 0.006, 5, c.x, c.y - 0.09 + i * 0.06), C.olive);
    P.add(box(0.012, 0.26, 0.05, c.x + 0.034, c.y, c.z + 0.03), C.steel);
  }
  const g = P.build();
  g.computeBoundingSphere();
  sailorCache.set(key, g);
  return g;
}

const spot = (x, y, z, yaw, pose, rotates) => ({ pos: V(x, y, z), yaw, pose, rotates });

/**
 * Crew positions in the mount's base space. `rotates` spots train with the mount;
 * the others stand on the deck at the mount origin (train 0). They clear the gun
 * at every train and elevation.
 */
export function crewSpots(kind) {
  switch (kind) {
    case '40mm-quad':
      // pointer and trainer on the seats, four loaders behind the breeches, two passers by the tub door
      return [
        spot(1.58, 0.42, 0.17, 0, 'point', true),
        spot(-1.58, 0.42, 0.17, 0, 'point', true),
        spot(0.36, 0.42, 1.75, 0, 'load', true),
        spot(-0.36, 0.42, 1.75, 0, 'load', true),
        spot(1.05, 0.42, 1.6, 0, 'load', true),
        spot(-1.05, 0.42, 1.6, 0, 'stand', true),
        spot(0.86, 0, 2.48, 0.33, 'brace', false),
        spot(-0.86, 0, 2.48, -0.33, 'stand', false),
      ];
    case '40mm-twin':
      return [
        spot(1.08, 0.42, 0.17, 0, 'point', true),
        spot(-1.08, 0.42, 0.17, 0, 'point', true),
        spot(0, 0.42, 1.12, 0, 'load', true),
      ];
    case '20mm':
      // the gunner leans into the shoulder rests; the loader keeps a spare drum ready at his side.
      // The barrel sweeps the whole tub, so the loader trains with the gun rather than standing still.
      return [
        spot(0, 0, 0.86, 0, 'brace', true),
        spot(0.55, 0, 0.98, 0.5, 'stand', true),
      ];
    default:
      return []; // 5" crews are inside the gunhouse
  }
}

let crewMaterial = null;
/** One shared cloth material for every sailor (instanced). */
export function createCrewMaterial() {
  if (crewMaterial) return crewMaterial;
  crewMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  patchMaterial(crewMaterial, 'crew-cloth', wearPatch({
    color: /* glsl */ `
      vec3 sp = vSurfPos;
      float sN = gNoise(sp * 9.0) * 0.6 + gNoise(sp * 31.0) * 0.4;
      diffuseColor.rgb *= 0.86 + 0.24 * sN;
    `,
    rough: 'roughnessFactor = clamp(roughnessFactor + 0.1 * (sN - 0.5), 0.3, 1.0);',
  }));
  return crewMaterial;
}

// ---------------------------------------------------------------- player guns

// Place geometry in a frame standing against the tub wall at angle a, radius r,
// with local -Z facing the mount center.
const wallFrame = (a, r) => xf(Math.cos(a) * r, 0, Math.sin(a) * r, 0, Math.PI / 2 - a);

function addLocker(P, M, a, r, w, h, d) {
  const m = wallFrame(a, r);
  const add = (mat, g) => P.add(mat, g.applyMatrix4(m));
  add(M.paint, box(w, h, d, 0, h / 2, 0));
  add(M.paintDark, box(w + 0.03, 0.04, d + 0.03, 0, h + 0.02, 0)); // lid
  add(M.paintDark, box(w - 0.08, 0.012, 0.01, 0, h - 0.06, -d / 2 - 0.005)); // lid seam
  add(M.metal, box(0.16, 0.03, 0.03, 0, h - 0.13, -d / 2 - 0.015)); // handle
  for (const s of [-1, 1]) add(M.metal, box(0.05, 0.1, 0.02, s * w * 0.32, h - 0.1, -d / 2 - 0.01)); // dogs
  add(M.paintDark, box(w, 0.06, d + 0.04, 0, 0.03, 0)); // foot
}

// Open rack of 4-round clips standing upright. With `slots`, the clips are left out and the
// frame of each clip position is pushed instead (rounds stacked along local +Y, noses along -Z).
const CLIP_UPRIGHT = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0));
function addClipRack(P, M, a, r, clips, slots = null) {
  const m = wallFrame(a, r);
  const add = (mat, g) => P.add(mat, g.applyMatrix4(m));
  const w = clips * 0.27 + 0.06;
  if (slots) {
    for (let c = 0; c < clips; c++) {
      const cx = -w / 2 + 0.03 + 0.27 * (c + 0.5);
      slots.push(m.clone().multiply(new THREE.Matrix4().makeTranslation(cx - 0.09, 0.4, 0)).multiply(CLIP_UPRIGHT));
    }
  }
  add(M.paint, box(w, 0.04, 0.32, 0, 0.38, 0)); // shelf
  add(M.paint, box(w, 0.9, 0.03, 0, 0.45, 0.15)); // back plate
  add(M.paint, box(w, 0.03, 0.05, 0, 0.62, -0.13)); // retaining bar
  for (const s of [-1, 1]) add(M.paint, box(0.03, 0.9, 0.32, s * (w / 2 - 0.015), 0.45, 0));
  for (let c = 0; c < (slots ? 0 : clips); c++) {
    const cx = -w / 2 + 0.03 + 0.27 * (c + 0.5);
    add(M.metal, box(0.25, 0.04, 0.012, cx, 0.6, 0.035)); // clip spine
    for (let i = 0; i < 4; i++) {
      const x = cx - 0.09 + i * 0.06;
      add(M.brass, yTube(0.4, 0.71, 0.029, 0.027, 12, x, 0));
      add(M.brass, yTube(0.71, 0.725, 0.021, 0.021, 12, x, 0));
      add(M.olive, yTube(0.725, 0.81, 0.02, 0.02, 12, x, 0));
      add(M.olive, yTube(0.81, 0.87, 0.02, 0.004, 12, x, 0));
    }
  }
}

function addTub(P, M, r, h, gapDeg, stiffeners) {
  const g = (gapDeg / 2) * DEG;
  P.add(M.deck, yTube(-0.06, 0, r + 0.03, r + 0.03, 64));
  P.add(M.paint, arcWall(r - 0.03, r, 0, h, 90 * DEG + g, 450 * DEG - g, 72));
  const lip = new THREE.TorusGeometry(r - 0.015, 0.022, 6, 72, Math.PI * 2 - g * 2);
  lip.applyMatrix4(xf(0, 0, 0, Math.PI / 2)).applyMatrix4(xf(0, h, 0, 0, -(90 * DEG + g)));
  P.add(M.paint, lip);
  for (let i = 0; i < stiffeners; i++) {
    const a = 90 * DEG + g + 0.1 + ((360 * DEG - g * 2 - 0.2) * i) / (stiffeners - 1);
    P.add(M.paint, box(0.012, h - 0.05, 0.08, Math.cos(a) * (r - 0.07), (h - 0.05) / 2, Math.sin(a) * (r - 0.07), 0, Math.PI / 2 - a));
  }
  // drain scuppers and the door sill
  P.add(M.paintDark, box(0.9, 0.05, 0.08, 0, 0.025, r - 0.02));
}

// Seeded random for scattered props, so every build looks the same.
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Spent cartridge cases lying on the tub floor between rMin and rMax, avoiding
// the given angular sectors (degrees, same convention as the tub: 90 = rear).
function addBrass(P, M, { n, rMin, rMax, len, rad, skip = [], seed = 7, clips = 0 }) {
  const r = rng(seed);
  let placed = 0, tries = 0;
  while (placed < n && tries++ < n * 20) {
    const a = r() * 360;
    if (skip.some(([a0, a1]) => a > a0 && a < a1)) continue;
    const d = rMin + Math.sqrt(r()) * (rMax - rMin);
    const x = Math.cos(a * DEG) * d, z = Math.sin(a * DEG) * d;
    const yaw = r() * Math.PI * 2;
    const m = xf(x, rad, z, 0, yaw, 0);
    P.add(M.brass, zTube(len / 2, -len / 2, rad, rad * 0.94, 10).applyMatrix4(m));
    P.add(M.metal, zTube(len / 2, len / 2 + 0.004, rad * 1.08, rad * 1.08, 10).applyMatrix4(m)); // rim
    placed++;
  }
  // a few empty clip spines kicked aside
  for (let i = 0; i < clips; i++) {
    const a = r() * 360, d = rMin + r() * (rMax - rMin);
    P.add(M.metal, box(0.25, 0.012, 0.04, Math.cos(a * DEG) * d, 0.006, Math.sin(a * DEG) * d, 0, r() * Math.PI, 0));
  }
}

function buildPlayerBofors() {
  const M = playerMaterials();
  const root = new THREE.Group();
  root.name = 'player-40mm-quad';
  const yaw = new THREE.Object3D();
  root.add(yaw);
  const pitch = new THREE.Object3D();
  pitch.position.set(0, 1.55, 0);
  yaw.add(pitch);

  // ---- static: tub, pedestal, ready ammunition
  const S = new MatParts();
  addTub(S, M, 3.26, 1.3, 22, 18);
  S.add(M.paintDark, yTube(0, 0.24, 1.32, 1.25, 48));
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    S.add(M.metal, yTube(0.24, 0.27, 0.022, 0.022, 6, Math.cos(a) * 1.17, Math.sin(a) * 1.17));
  }
  for (const a of [200, 340, 148, 32]) addLocker(S, M, a * DEG, 2.97, 1.1, 0.9, 0.5);
  const rackSlots = [];
  for (const a of [243, 297]) addClipRack(S, M, a * DEG, 3.05, 3, rackSlots);
  addBrass(S, M, { n: 46, rMin: 2.05, rMax: 2.62, len: 0.31, rad: 0.029, skip: [[20, 44], [136, 160], [188, 212], [328, 352]], seed: 40, clips: 6 });
  S.build(root);

  // ---- carriage: rotating base, crew platform, side frames, seats, handwheels
  const Y = new MatParts();
  Y.add(M.paint, yTube(0.24, 0.36, 1.3, 1.3, 48));
  Y.add(M.metal, ring(1.31, 0.02, 'y', 0, 0.3, 0, 4, 64));
  Y.add(M.deck, yTube(0.36, 0.42, 1.95, 1.95, 64));
  Y.add(M.paintDark, ring(1.95, 0.022, 'y', 0, 0.42, 0, 6, 64));
  Y.add(M.paint, box(1.96, 0.18, 1.2, 0, 0.51, 0.2)); // lower carriage
  for (const s of [-1, 1]) {
    const x0 = s * 0.98, x1 = s * 1.1;
    Y.add(M.paint, loft([rect(x0, x1, -0.6, 0.95, 0.42), rect(x0, x1, -0.28, 0.42, 1.7)], { bottom: true }));
    Y.add(M.paint, box(0.1, 0.06, 1.5, s * 1.04, 0.47, 0.17)); // frame foot
    Y.add(M.paint, xTube(s * 0.96, s * 1.18, 0.19, 0.19, 28, 1.55)); // trunnion bearing
    Y.add(M.metal, xTube(s * 1.18, s * 1.22, 0.13, 0.11, 24, 1.55));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      Y.add(M.metal, xTube(s * 1.18, s * 1.205, 0.016, 0.016, 6, 1.55 + Math.sin(a) * 0.155, Math.cos(a) * 0.155));
    }
    // seat
    const sx = s * 1.58;
    Y.add(M.paintDark, yTube(0.42, 0.9, 0.035, 0.035, 10, sx, 0.25));
    Y.add(M.rubber, box(0.42, 0.06, 0.4, sx, 0.93, 0.25));
    Y.add(M.rubber, box(0.42, 0.42, 0.05, sx, 1.2, 0.47));
    Y.add(M.paintDark, box(0.04, 0.4, 0.04, sx, 1.0, 0.47));
    Y.add(M.paintDark, xTube(sx - 0.2, sx + 0.2, 0.018, 0.018, 8, 0.6, -0.3)); // foot rest
    // handwheel on a gearbox bolted to the frame
    Y.add(M.paint, box(0.2, 0.28, 0.26, s * 1.2, 1.2, -0.3));
    Y.add(M.metal, xTube(s * 1.3, s * 1.42, 0.03, 0.03, 10, 1.2, -0.3));
    Y.add(M.metal, ring(0.17, 0.016, 'x', s * 1.42, 1.2, -0.3, 8, 32));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      Y.add(M.metal, rod(V(s * 1.42, 1.2, -0.3), V(s * 1.42, 1.2 + Math.sin(a) * 0.17, -0.3 + Math.cos(a) * 0.17), 0.01, 6));
    }
    Y.add(M.rubber, xTube(s * 1.42, s * 1.54, 0.018, 0.018, 8, 1.37, -0.3));
  }
  Y.build(yaw);

  // ---- cradles, loaders, sights (elevate with the guns)
  const P = new MatParts();
  P.add(M.metal, xTube(-0.98, 0.98, 0.075, 0.075, 20));
  for (const s of [-1, 1]) {
    const cx = s * 0.535;
    P.add(M.paint, loft([rect(cx - 0.3, cx + 0.3, -0.28, 0.88, -0.24), rect(cx - 0.3, cx + 0.3, -0.22, 0.8, 0.12)], { bottom: true }));
    P.add(M.paintDark, box(0.62, 0.03, 0.9, cx, -0.245, 0.3)); // cradle bottom plate
    // elevating arc
    P.add(M.metal, pathTube((t) => {
      const b = (100 + t * 100) * DEG;
      return V(s * 0.87, Math.cos(b) * 0.55, Math.sin(b) * 0.55);
    }, 20, 0.03, 6));
    // pointer's / trainer's sight on a trunnion extension
    const x = s * 1.5;
    P.add(M.metal, xTube(s * 1.22, x + s * 0.03, 0.045, 0.045, 12));
    P.add(M.paint, yTube(-0.05, 0.45, 0.025, 0.02, 10, x, 0));
    P.add(M.paint, zTube(0.0, 0.32, 0.02, 0.02, 8, x, 0.45));
    P.add(M.metal, ring(0.13, 0.006, 'z', x, 0.48, 0.3, 4, 32));
    P.add(M.metal, ring(0.065, 0.005, 'z', x, 0.48, 0.3, 4, 24));
    for (let i = 0; i < 4; i++) P.add(M.metal, box(0.004, 0.13, 0.004, x, 0.48, 0.3, 0, 0, (i * Math.PI) / 4));
    P.add(M.paint, zTube(0.0, -0.45, 0.02, 0.02, 8, x, 0.45));
    P.add(M.metal, yTube(0.45, 0.5, 0.006, 0.006, 6, x, -0.45));
  }
  P.add(M.paint, box(0.47, 0.16, 0.6, 0, -0.17, 0.25)); // center bracket below the bore
  const X = [-0.7, -0.37, 0.37, 0.7];
  // Automatic loader, after the cutaways in OP 820: the rounds lie noses forward, one on another,
  // between curved guides standing on the breech casing above the rammer tray. The guides curve
  // forward (radius FEED.R), so the rounds fan slightly toward the muzzle. Case bases at FEED.z,
  // the lowest round on the star wheels at FEED.y0; the loader holds FEED.cap rounds, and clips
  // are dropped into the feed lips with their lowest round FEED.lips spacings up.
  const FEED = { y0: 0.165, dy: 0.06, z: 0.42, cap: 7, lips: 7, R: 1.0 };
  // a point `d` along a round lying `sl` spacings up the guides, forward from its case base
  const arcPt = (bx, sl, d) => {
    const th = Math.max(0, sl) * FEED.dy / FEED.R;
    const py = FEED.y0 + (sl > 0 ? FEED.R * Math.sin(th) : sl * FEED.dy);
    const pz = FEED.z - FEED.R * (1 - Math.cos(th));
    return { p: V(bx, py - d * Math.sin(th), pz - d * Math.cos(th)), th };
  };
  // a strip following the guides from sl0 to sl1, at x, centred d forward of the case bases
  const guideStrip = (mat, x, sl0, sl1, d, w, depth) => {
    for (let sl = sl0; sl < sl1 - 1e-6; sl += 0.5) {
      const { p, th } = arcPt(x, Math.min(sl + 0.25, sl1), d);
      P.add(mat, box(w, FEED.dy * 0.52, depth, p.x, p.y, p.z, -th));
    }
  };
  for (const bx of X) {
    for (const s of [-1, 1]) {
      // rear guides: channels at the case heads, tall enough to take a clip dropped in the lips
      guideStrip(M.paint, bx + s * 0.046, -0.6, FEED.lips + 3.6, 0.012, 0.008, 0.036);
      const lip = arcPt(bx + s * 0.052, FEED.lips + 3.9, 0.012);
      P.add(M.metal, box(0.008, 0.04, 0.036, lip.p.x, lip.p.y, lip.p.z, -lip.th, 0, -s * 0.45)); // feed lip
      // front guides: rods along the projectiles
      P.add(M.metal, pathTube((t) => arcPt(bx + s * 0.03, -0.4 + t * (FEED.cap + 0.2), 0.37).p, 16, 0.006, 6));
      // the slide's cheeks either side of the lower rounds, where the feed pawls work
      guideStrip(M.paint, bx + s * 0.044, -0.6, 3.4, 0.2, 0.006, 0.2);
    }
    // breech casing top: the lowest round drops through the opening onto the rammer tray
    P.add(M.paintDark, box(0.17, 0.012, 0.56, bx, 0.126, FEED.z - 0.22));
    P.add(M.rubber, box(0.064, 0.004, 0.46, bx, 0.133, FEED.z - 0.22));
    P.add(M.paint, box(0.12, 0.08, 0.12, bx, 0.17, FEED.z + 0.12)); // rammer housing
    P.add(M.metal, box(0.15, 0.025, 0.04, bx, 0.135, FEED.z - 0.49)); // front guide foot
    // (the clips, rounds, star wheels and feed pawls are live objects, see feed.js)
    // the case deflector behind and under the breech, turning empty cases down the chute
    P.add(M.paintDark, loft([rect(bx - 0.07, bx + 0.07, 0.32, 0.62, -0.14), rect(bx - 0.06, bx + 0.06, 0.58, 0.82, -0.48)], { top: false, bottom: false, crease: 25 * DEG }));
    P.add(M.metal, box(0.15, 0.02, 0.06, bx, -0.13, 0.13));
  }
  P.build(pitch);

  // ---- barrels (recoil along +Z)
  const barrels = [], muzzles = [], breeches = [];
  for (const bx of X) {
    const b = new THREE.Object3D();
    b.position.set(bx, 0, 0);
    pitch.add(b);
    const B = new MatParts();
    B.add(M.paint, zTube(0.05, -1.32, 0.082, 0.082, 28)); // water jacket
    for (const z of [-0.02, -0.66, -1.28]) {
      B.add(M.paintDark, zTube(z + 0.035, z - 0.035, 0.092, 0.092, 28));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2; // clamp bolts
        B.add(M.metal, box(0.018, 0.018, 0.05, Math.cos(a) * 0.095, Math.sin(a) * 0.095, z));
      }
    }
    // coolant inlet and outlet fittings with short hoses
    for (const [z, y] of [[-0.12, -0.085], [-1.18, 0.085]]) {
      B.add(M.metal, yTube(y * 1.05, y * 1.45, 0.02, 0.02, 10, 0, z));
      B.add(M.rubber, pathTube((t) => V(0.03 * Math.sin(t * 3), y * 1.45 + Math.sign(y) * t * 0.06, z + t * 0.18), 6, 0.016, 8));
    }
    B.add(M.metal, zTube(-1.32, -2.04, 0.046, 0.041, 24));
    B.add(M.metal, zTube(-1.32, -1.36, 0.054, 0.054, 24)); // barrel nut
    B.add(M.metal, zTube(-2.04, -2.34, 0.043, 0.074, 24)); // flash hider
    for (let i = 0; i < 8; i++) {
      // slots in the flash hider cone
      const a = (i / 8) * Math.PI * 2;
      const slot = box(0.012, 0.004, 0.2, 0, 0, 0).applyMatrix4(xf(0, 0.0605, -2.2, Math.atan2(0.031, 0.3), 0, 0)).applyMatrix4(xf(0, 0, 0, 0, 0, a));
      B.add(M.rubber, slot);
    }
    B.add(M.metal, zTube(-2.3, -2.34, 0.078, 0.078, 24)); // muzzle ring
    B.add(M.metal, zTube(0.12, -0.62, 0.028, 0.028, 12, 0, 0.1)); // recoil spring housing
    B.add(M.paint, box(0.17, 0.2, 0.3, 0, 0, 0.25)); // breech ring
    B.add(M.paintDark, box(0.19, 0.04, 0.32, 0, 0.1, 0.25)); // breech casing top
    B.add(M.metal, rod(V(0.09, 0.02, 0.15), V(0.12, -0.12, 0.38), 0.012, 6)); // breech operating lever
    B.add(M.rubber, zTube(0.38, 0.42, 0.02, 0.02, 8, 0.12, -0.12));
    B.build(b);
    const m = new THREE.Object3D();
    m.position.set(0, 0, -2.34);
    b.add(m);
    barrels.push(b);
    muzzles.push(m);
    const br = new THREE.Object3D();
    br.position.set(bx, -0.26, -0.05);
    pitch.add(br);
    breeches.push(br);
  }

  // camera anchors: centred behind and above the loaders (far enough back at low elevation to
  // see the rounds go down the guides, drawn in as the guns elevate so the eye stays above the
  // platform), or the pointer's seat behind his ring sight
  const eyes = { centre: new THREE.Vector3(0, 1.08, 1.75), centreHigh: new THREE.Vector3(0, 1.0, 1.05), pointer: new THREE.Vector3(-1.5, 0.48, 0.72) };
  const eye = new THREE.Object3D();
  eye.position.copy(eyes.centre);
  pitch.add(eye);

  // the loader geometry (pitch space) for feed.js: gun x and the side each throws its empty
  // clips (the quad is two twin slides, a Mk 1 left gun and a Mk 2 right gun on each); the
  // deflector chute's mouth; and in yaw space the case tube outlets at the front of the
  // carriage, the carriage top, and the ready rack clip positions (root space)
  const feed = {
    xs: X.slice(),
    eject: [-1, 1, -1, 1],
    ...FEED,
    chute: { y: -0.47, z: 0.7 },
    outlet: { y: 0.52, z: -0.45 },
    carriage: { x: 0.98, y: 0.6, z0: -0.4, z1: 0.8 },
    rackSlots,
  };
  return { root, yaw, pitch, barrels, muzzles, breeches, eye, eyes, recoil: 0.2, elev: [-15 * DEG, 90 * DEG], magazines: [], feed };
}

function buildPlayerOerlikon() {
  const M = playerMaterials();
  const root = new THREE.Group();
  root.name = 'player-20mm-twin';
  const yaw = new THREE.Object3D();
  root.add(yaw);
  const pitch = new THREE.Object3D();
  pitch.position.set(0, 1.5, 0);
  yaw.add(pitch);

  // ---- static: tub, pedestal, ready-service lockers, spare drums
  const S = new MatParts();
  addTub(S, M, 1.93, 1.1, 32, 12);
  S.add(M.paintDark, yTube(0, 0.07, 0.42, 0.4, 40));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    S.add(M.metal, yTube(0.07, 0.1, 0.022, 0.022, 6, Math.cos(a) * 0.34, Math.sin(a) * 0.34));
  }
  S.add(M.paint, yTube(0.07, 0.96, 0.17, 0.15, 36));
  S.add(M.paintDark, yTube(0.5, 0.56, 0.18, 0.18, 36));
  for (const a of [205, 335]) addLocker(S, M, a * DEG, 1.69, 0.7, 0.75, 0.4);
  {
    const m = wallFrame(150 * DEG, 1.7);
    const add = (mat, g) => S.add(mat, g.applyMatrix4(m));
    add(M.paint, box(0.5, 0.04, 0.46, 0, 0.5, 0));
    add(M.paint, box(0.5, 0.6, 0.03, 0, 0.3, 0.22));
    for (const y of [0.58, 0.7]) {
      add(M.paintDark, yTube(y - 0.055, y + 0.055, 0.2, 0.2, 32, 0, 0));
      add(M.metal, yTube(y + 0.055, y + 0.07, 0.05, 0.05, 12, 0, 0));
    }
  }
  addBrass(S, M, { n: 34, rMin: 0.55, rMax: 1.55, len: 0.11, rad: 0.0145, skip: [[135, 165], [195, 215], [325, 345]], seed: 20 });
  // pedestal height crank
  S.add(M.paint, box(0.12, 0.18, 0.14, 0.2, 0.55, 0));
  S.add(M.metal, xTube(0.26, 0.36, 0.015, 0.015, 8, 0.55, 0));
  S.add(M.metal, rod(V(0.36, 0.55, 0), V(0.36, 0.43, 0.08), 0.012, 6));
  S.add(M.rubber, xTube(0.36, 0.44, 0.016, 0.016, 8, 0.43, 0.08));
  S.build(root);

  // ---- carriage head, yoke and the curved shield (trains, does not elevate)
  const Y = new MatParts();
  Y.add(M.paint, yTube(0.96, 1.06, 0.23, 0.23, 36));
  Y.add(M.paintDark, ring(0.23, 0.015, 'y', 0, 1.0, 0, 6, 36));
  Y.add(M.paint, box(0.98, 0.08, 0.26, 0, 1.06, 0));
  for (const s of [-1, 1]) {
    Y.add(M.paint, loft([rect(s * 0.41, s * 0.47, -0.16, 0.18, 1.02), rect(s * 0.41, s * 0.47, -0.09, 0.09, 1.6)], { bottom: true }));
    Y.add(M.metal, xTube(s * 0.39, s * 0.5, 0.075, 0.075, 20, 1.5));
    Y.add(M.paintDark, box(0.04, 0.05, 0.75, s * 0.32, 1.0, -0.5)); // shield brackets
  }
  Y.add(M.paint, arcWall(0.93, 0.945, 0.45, 1.06, 215 * DEG, 325 * DEG, 32));
  const lip = new THREE.TorusGeometry(0.9375, 0.012, 6, 32, 110 * DEG);
  lip.applyMatrix4(xf(0, 0, 0, Math.PI / 2)).applyMatrix4(xf(0, 1.06, 0, 0, -215 * DEG));
  Y.add(M.paintDark, lip);
  Y.build(yaw);

  // ---- guns
  const P = new MatParts();
  const GX = [-0.25, 0.25];
  const magazines = [], barrels = [], muzzles = [], breeches = [];
  for (const gx of GX) {
    P.add(M.metal, box(0.12, 0.18, 0.64, gx, -0.02, 0.08)); // receiver
    P.add(M.paintDark, box(0.13, 0.03, 0.5, gx, 0.08, 0.1));
    P.add(M.metal, yTube(0.07, 0.11, 0.08, 0.08, 20, gx, 0.02)); // magazine seat
    P.add(M.metal, box(0.03, 0.1, 0.08, gx, -0.16, 0.36)); // trigger housing
    // drum magazine
    const mag = new THREE.Object3D();
    mag.position.set(gx, 0.165, 0.02);
    pitch.add(mag);
    const D = new MatParts();
    D.add(M.paintDark, yTube(-0.055, 0.055, 0.205, 0.205, 48));
    for (const y of [-0.035, 0.035]) D.add(M.paint, ring(0.205, 0.008, 'y', 0, y, 0, 6, 48));
    D.add(M.metal, yTube(0.055, 0.075, 0.05, 0.05, 20));
    D.add(M.metal, box(0.12, 0.02, 0.025, 0, 0.085, 0));
    D.build(mag);
    magazines.push(mag);
    // barrel group
    const b = new THREE.Object3D();
    b.position.set(gx, 0, 0);
    pitch.add(b);
    const B = new MatParts();
    B.add(M.metal, zTube(-0.24, -0.74, 0.058, 0.058, 28));
    B.add(M.metal, zTube(-0.74, -0.78, 0.05, 0.04, 24));
    B.add(M.metal, zTube(-0.78, -1.96, 0.026, 0.022, 20));
    for (let i = 0; i < 6; i++) B.add(M.metal, zTube(-0.82 - i * 0.045, -0.835 - i * 0.045, 0.042, 0.042, 20));
    B.add(M.metal, zTube(-1.96, -2.1, 0.024, 0.046, 20));
    B.build(b);
    const m = new THREE.Object3D();
    m.position.set(0, 0, -2.1);
    b.add(m);
    barrels.push(b);
    muzzles.push(m);
    const br = new THREE.Object3D();
    br.position.set(gx + Math.sign(gx) * 0.07, -0.05, 0.1);
    pitch.add(br);
    breeches.push(br);
  }
  P.add(M.metal, xTube(-0.39, 0.39, 0.04, 0.04, 16)); // trunnion axle
  P.add(M.metal, box(0.38, 0.06, 0.08, 0, -0.08, -0.2)); // cross ties
  P.add(M.metal, box(0.38, 0.06, 0.08, 0, -0.1, 0.3));
  for (const s of [-1, 1]) {
    // shoulder rests and hand grips, below the sight line
    P.add(M.metal, rod(V(s * 0.25, -0.1, 0.36), V(s * 0.33, -0.3, 0.74), 0.016));
    P.add(M.rubber, box(0.1, 0.2, 0.07, s * 0.33, -0.32, 0.78));
    P.add(M.rubber, yTube(-0.32, -0.16, 0.02, 0.02, 10, s * 0.17, 0.5));
    P.add(M.metal, rod(V(s * 0.17, -0.16, 0.5), V(s * 0.25, -0.1, 0.36), 0.012));
  }
  P.build(pitch);

  const eye = new THREE.Object3D();
  eye.position.set(0, 0.6, 0.95);
  pitch.add(eye);

  return { root, yaw, pitch, barrels, muzzles, breeches, eye, recoil: 0.08, elev: [-10 * DEG, 85 * DEG], magazines };
}

// Single 20mm Oerlikon on a Mk 4 mount with the Mk 10 height-adjusting pedestal, as fitted
// in dozens along a 1944 battleship's galleries: curved two-plate shield, 60-round drum,
// shoulder rests and the ring-and-bead sight the gunner aims through.
function buildPlayerOerlikonSingle() {
  const M = playerMaterials();
  const root = new THREE.Group();
  root.name = 'player-20mm';
  const yaw = new THREE.Object3D();
  root.add(yaw);
  const pitch = new THREE.Object3D();
  pitch.position.set(0, 1.35, 0);
  yaw.add(pitch);

  // ---- static: tub, pedestal with its height gear, locker, spare drums, spent brass
  const S = new MatParts();
  addTub(S, M, 1.35, 1.05, 36, 10);
  S.add(M.paintDark, yTube(0, 0.06, 0.32, 0.3, 40)); // base flange
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    S.add(M.metal, yTube(0.06, 0.09, 0.02, 0.02, 6, Math.cos(a) * 0.26, Math.sin(a) * 0.26));
  }
  S.add(M.paint, yTube(0.06, 0.2, 0.2, 0.15, 36)); // flared foot
  S.add(M.paint, yTube(0.2, 0.62, 0.15, 0.145, 36)); // outer column
  S.add(M.paintDark, yTube(0.6, 0.66, 0.165, 0.165, 36)); // clamp collar
  for (const a of [0, Math.PI]) S.add(M.metal, box(0.05, 0.05, 0.05, Math.cos(a) * 0.17, 0.63, Math.sin(a) * 0.17));
  S.add(M.metal, yTube(0.66, 0.98, 0.115, 0.11, 32)); // telescoping inner column, bright where it slides
  S.add(M.paint, yTube(0.66, 0.7, 0.122, 0.122, 32));
  // height-adjusting gearbox and crank on the right of the column
  S.add(M.paint, box(0.14, 0.2, 0.16, 0.2, 0.45, 0));
  S.add(M.paintDark, box(0.15, 0.03, 0.17, 0.2, 0.56, 0));
  S.add(M.metal, xTube(0.27, 0.37, 0.016, 0.016, 10, 0.45, 0));
  S.add(M.metal, rod(V(0.37, 0.45, 0), V(0.37, 0.32, 0.09), 0.012, 6));
  S.add(M.rubber, xTube(0.37, 0.46, 0.017, 0.017, 10, 0.32, 0.09));
  S.add(M.metal, box(0.03, 0.22, 0.03, 0.15, 0.78, 0.0)); // locking lever
  S.add(M.rubber, yTube(0.88, 0.95, 0.02, 0.02, 8, 0.15, 0));
  // ready-service locker forward-left and a rack of spare drums aft-left
  addLocker(S, M, 205 * DEG, 1.12, 0.62, 0.72, 0.36);
  {
    const m = wallFrame(140 * DEG, 1.14);
    const add = (mat, g) => S.add(mat, g.applyMatrix4(m));
    add(M.paint, box(0.48, 0.04, 0.44, 0, 0.42, 0));
    add(M.paint, box(0.48, 0.66, 0.03, 0, 0.33, 0.21));
    for (const s2 of [-1, 1]) add(M.paint, box(0.03, 0.66, 0.44, s2 * 0.225, 0.33, 0));
    for (const y of [0.5, 0.62, 0.74]) {
      add(M.paintDark, yTube(y - 0.055, y + 0.055, 0.2, 0.2, 32, 0, 0));
      add(M.paint, ring(0.2, 0.007, 'y', 0, y + 0.02, 0, 4, 32));
      add(M.metal, yTube(y + 0.055, y + 0.068, 0.05, 0.05, 12, 0, 0));
    }
    add(M.metal, box(0.5, 0.025, 0.025, 0, 0.82, -0.2)); // retaining bar
  }
  addBrass(S, M, { n: 24, rMin: 0.42, rMax: 1.15, len: 0.11, rad: 0.0145, skip: [[125, 155], [190, 222], [80, 100]], seed: 33 });
  S.build(root);

  // ---- carriage head, cradle yoke and the curved two-plate shield (trains with the gun)
  const Y = new MatParts();
  Y.add(M.paint, yTube(0.98, 1.08, 0.21, 0.2, 36)); // training head
  Y.add(M.paintDark, ring(0.21, 0.014, 'y', 0, 1.0, 0, 6, 36));
  Y.add(M.metal, box(0.06, 0.04, 0.1, -0.2, 1.03, 0.05)); // train lock
  Y.add(M.paint, box(0.36, 0.07, 0.22, 0, 1.11, 0)); // cradle saddle
  for (const s2 of [-1, 1]) {
    Y.add(M.paint, loft([rect(s2 * 0.13, s2 * 0.18, -0.12, 0.14, 1.1), rect(s2 * 0.13, s2 * 0.18, -0.07, 0.07, 1.36)], { bottom: true }));
    Y.add(M.metal, xTube(s2 * 0.12, s2 * 0.21, 0.055, 0.055, 20, 1.35)); // trunnion bearings
    Y.add(M.metal, xTube(s2 * 0.21, s2 * 0.23, 0.035, 0.03, 16, 1.35));
    // shield struts from the saddle out to the plates
    Y.add(M.paintDark, rod(V(s2 * 0.12, 1.1, -0.08), V(s2 * 0.3, 0.86, -0.64), 0.017, 6));
    Y.add(M.paintDark, rod(V(s2 * 0.16, 1.12, -0.02), V(s2 * 0.42, 1.12, -0.56), 0.014, 6));
  }
  // lower plate, then the upper plate with a slot for the barrel at low elevation
  Y.add(M.paint, arcWall(0.7, 0.714, 0.5, 1.06, 226 * DEG, 314 * DEG, 30));
  Y.add(M.paint, arcWall(0.7, 0.714, 1.06, 1.32, 238 * DEG, 263 * DEG, 10));
  Y.add(M.paint, arcWall(0.7, 0.714, 1.06, 1.32, 277 * DEG, 302 * DEG, 10));
  Y.add(M.paintDark, arcWall(0.714, 0.73, 1.04, 1.08, 226 * DEG, 314 * DEG, 30)); // joint strap
  for (const [a0, a1, y] of [[226, 314, 0.5], [238, 263, 1.32], [277, 302, 1.32]]) {
    const lip = new THREE.TorusGeometry(0.707, 0.008, 4, 16, (a1 - a0) * DEG);
    lip.applyMatrix4(xf(0, 0, 0, Math.PI / 2)).applyMatrix4(xf(0, y, 0, 0, -a0 * DEG));
    Y.add(M.paintDark, lip);
  }
  for (let i = 0; i < 9; i++) {
    // rivets along the strap
    const a = (228 + i * 10.5) * DEG;
    Y.add(M.metal, box(0.014, 0.014, 0.01, Math.cos(a) * 0.732, 1.06, Math.sin(a) * 0.732, 0, Math.PI / 2 - a, 0));
  }
  Y.build(yaw);

  // ---- the gun (elevates): receiver, cocking gear, grips, shoulder rests, sights
  const P = new MatParts();
  P.add(M.metal, box(0.12, 0.17, 0.62, 0, -0.02, 0.08)); // receiver body
  P.add(M.paintDark, box(0.13, 0.025, 0.5, 0, 0.075, 0.1)); // receiver top
  for (const z of [-0.12, 0.08, 0.28]) P.add(M.metal, box(0.135, 0.15, 0.02, 0, -0.025, z)); // bands
  P.add(M.metal, yTube(0.065, 0.11, 0.082, 0.082, 24, 0, 0.02)); // magazine seat
  P.add(M.metal, box(0.06, 0.04, 0.06, 0.07, 0.1, 0.12)); // magazine catch
  P.add(M.metal, box(0.03, 0.09, 0.08, 0, -0.15, 0.34)); // trigger housing
  P.add(M.metal, box(0.05, 0.05, 0.06, 0, -0.13, 0.05)); // ejection port housing
  P.add(M.metal, xTube(-0.13, 0.13, 0.038, 0.038, 16)); // trunnion pin
  P.add(M.metal, box(0.07, 0.07, 0.12, 0.09, -0.02, 0.38)); // cocking lever bracket
  P.add(M.metal, rod(V(0.12, -0.02, 0.38), V(0.2, -0.12, 0.44), 0.012, 6));
  // shoulder rests (padded crescents) on curved arms, hand grips below them
  for (const s2 of [-1, 1]) {
    P.add(M.metal, pathTube((t) => V(s2 * (0.05 + t * 0.17), -0.04 - Math.sin(t * Math.PI * 0.5) * 0.08, 0.36 + t * 0.28), 8, 0.014, 6));
    const pad = new THREE.TorusGeometry(0.075, 0.03, 6, 12, Math.PI);
    pad.applyMatrix4(xf(s2 * 0.22, -0.06, 0.66, Math.PI / 2, 0, 0));
    P.add(M.rubber, pad);
    P.add(M.metal, box(0.16, 0.012, 0.05, s2 * 0.22, -0.1, 0.66));
    P.add(M.metal, rod(V(s2 * 0.05, -0.08, 0.3), V(s2 * 0.13, -0.18, 0.46), 0.012, 6));
    P.add(M.rubber, yTube(-0.36, -0.18, 0.021, 0.019, 12, s2 * 0.13, 0.47));
    P.add(M.metal, yTube(-0.385, -0.36, 0.024, 0.024, 12, s2 * 0.13, 0.47));
  }
  P.add(M.metal, box(0.27, 0.025, 0.03, 0, -0.18, 0.46)); // grip crossbar
  // ring-and-bead sight on the left, clear of the drum: ring near the eye, bead forward
  // the sight line rides high enough that the barrel and flash hider show beyond the drum
  const sx = -0.18, sy = 0.4;
  P.add(M.metal, rod(V(-0.04, 0.07, 0.3), V(sx, sy - 0.1, 0.36), 0.011, 6)); // ring sight arm
  P.add(M.metal, yTube(sy - 0.112, sy - 0.096, 0.012, 0.012, 8, sx, 0.36));
  P.add(M.metal, ring(0.096, 0.005, 'z', sx, sy, 0.36, 4, 40));
  P.add(M.metal, ring(0.043, 0.004, 'z', sx, sy, 0.36, 4, 28));
  for (let i = 0; i < 4; i++) P.add(M.metal, box(0.003, 0.192, 0.003, sx, sy, 0.36, 0, 0, (i * Math.PI) / 4)); // spokes
  P.add(M.metal, rod(V(-0.03, 0.06, -0.62), V(sx, sy - 0.015, -0.6), 0.009, 6)); // bead arm off the spring casing
  P.add(M.metal, new THREE.SphereGeometry(0.008, 8, 6).translate(sx, sy, -0.6));
  P.build(pitch);

  // ---- barrel group (recoils along +Z): spring casing, cooling rings, barrel, flash hider
  const b = new THREE.Object3D();
  pitch.add(b);
  const B = new MatParts();
  B.add(M.metal, zTube(-0.23, -0.74, 0.058, 0.058, 32)); // recoil spring casing
  for (let i = 0; i < 5; i++) B.add(M.paintDark, zTube(-0.3 - i * 0.1, -0.32 - i * 0.1, 0.062, 0.062, 32));
  B.add(M.metal, zTube(-0.74, -0.78, 0.054, 0.042, 28)); // casing cap
  B.add(M.metal, zTube(-0.78, -1.96, 0.026, 0.022, 24)); // barrel
  for (let i = 0; i < 7; i++) B.add(M.metal, zTube(-0.82 - i * 0.04, -0.835 - i * 0.04, 0.041, 0.041, 24)); // cooling rings
  B.add(M.metal, zTube(-1.96, -2.1, 0.024, 0.045, 24)); // flash hider
  B.add(M.metal, zTube(-2.08, -2.1, 0.047, 0.047, 24));
  B.add(M.rubber, zTube(-2.099, -2.101, 0.018, 0.018, 12)); // bore
  B.build(b);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -2.1);
  b.add(muzzle);
  const breech = new THREE.Object3D();
  breech.position.set(0, -0.15, 0.05); // cases drop out of the bottom of the receiver
  pitch.add(breech);

  // ---- 60-round drum on top of the receiver (moved by the caller during drum changes)
  const mag = new THREE.Object3D();
  mag.position.set(0, 0.17, 0.02);
  pitch.add(mag);
  const D = new MatParts();
  D.add(M.paintDark, yTube(-0.055, 0.055, 0.205, 0.205, 48));
  D.add(M.paint, yTube(0.055, 0.062, 0.2, 0.17, 48)); // domed cover
  for (const y of [-0.035, 0.0, 0.035]) D.add(M.paint, ring(0.205, 0.007, 'y', 0, y, 0, 6, 48));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2; // cover ribs
    D.add(M.paint, box(0.15, 0.008, 0.012, Math.cos(a) * 0.1, 0.064, Math.sin(a) * 0.1, 0, -a, 0));
  }
  D.add(M.metal, yTube(0.062, 0.085, 0.05, 0.05, 20)); // winding key
  D.add(M.metal, box(0.13, 0.02, 0.025, 0, 0.095, 0));
  D.add(M.metal, box(0.06, 0.05, 0.05, 0, -0.07, 0)); // mouth
  D.build(mag);

  const eye = new THREE.Object3D();
  eye.position.set(sx, sy, 0.78);
  pitch.add(eye);

  return { root, yaw, pitch, barrels: [b], muzzles: [muzzle], breeches: [breech], eye, recoil: 0.06, elev: [-10 * DEG, 85 * DEG], magazines: [mag], ringSight: true };
}

// ---------------------------------------------------------------- player 5"/38 twin mount

// Plan of the Mk 28 gunhouse at height y: flat front, chamfered cheeks, straight sides and
// rounded rear corners of radius rr (n segments each).
function plan28(y, { fw, w, front, cheek, rear, rr }, n = 6) {
  const pts = [V(-fw, y, front), V(fw, y, front), V(w, y, front + cheek)];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 0.5;
    pts.push(V(w - rr + Math.cos(a) * rr, y, rear - rr + Math.sin(a) * rr));
  }
  for (let i = 0; i <= n; i++) {
    const a = Math.PI * 0.5 + (i / n) * Math.PI * 0.5;
    pts.push(V(-(w - rr) + Math.cos(a) * rr, y, rear - rr + Math.sin(a) * rr));
  }
  pts.push(V(-w, y, front + cheek));
  return pts;
}

// A row of n bolt heads from a to b, standing out along the surface normal nrm (unit).
function boltRow(P, spec, a, b, n, nrm, r = 0.02) {
  const q = new THREE.Quaternion().setFromUnitVectors(UP, nrm);
  const one = V(1, 1, 1);
  for (let i = 0; i < n; i++) {
    const p = a.clone().lerp(b, n === 1 ? 0.5 : i / (n - 1)).addScaledVector(nrm, 0.008);
    P.add(spec, new THREE.CylinderGeometry(r * 0.75, r, 0.018, 6).applyMatrix4(new THREE.Matrix4().compose(p, q, one)));
  }
}

// Canvas blast bag (bloomer) along -Z from z0 (radius r0, inside the port) to z1 (r1, clamped
// to the slide), slack and creased, sagging a little under its own weight.
function bloomer(z0, z1, r0, r1, seed) {
  const h = Math.abs(z1 - z0);
  const g = new THREE.CylinderGeometry(r1, r0, h, 36, 12, true);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = y / h + 0.5; // 0 at the port, 1 at the clamp
    const a = Math.atan2(z, x);
    const env = Math.sin(t * Math.PI);
    const k = 1 + env * (0.05 * Math.sin(a * 7 + seed + t * 3) + 0.03 * Math.sin(a * 3 - seed * 2) + 0.04 * Math.sin(t * Math.PI * 4));
    p.setXYZ(i, x * k, y, z * k - 0.03 * env);
  }
  g.computeVertexNormals();
  return g.applyMatrix4(xf(0, 0, (z0 + z1) / 2, -Math.PI / 2));
}

/**
 * Twin 5"/38 enclosed mount Mk 28, the South Dakota class secondary battery (USS Alabama, 1944).
 * Same origin, outline and trunnion as the AI '5in-twin' (mount5inTwin), so it can replace one.
 * The gunhouse trains with `yaw` and does not elevate; the slides, bloomers and barrels elevate
 * with `pitch` (trunnion axis, +X). Barrels recoil 15 in along +Z. Camera anchors live in yaw
 * space (eyeSpace 'yaw'): the mount captain's head out of his roof hatch, and the pointer's,
 * trainer's and checker's telescope windows in the hoods through the upper side plates.
 * Sources:
 * - NavWeaps, 5"/38 Mark 12 (gun axes 84 in apart, Mk 28 train 25 deg/s and elevation
 *   15 deg/s, -15/+85 deg, recoil 15 in, 15-22 rpm per gun):
 *   https://www.navweaps.com/Weapons/WNUS_5-38_mk12.php
 * - Naval Ordnance and Gunnery (NAVPERS 10797-A, 1957) ch. 8B, 5"/38 twin mount (gunhouse
 *   about 15.5 x 15 x 10.5 ft, side doors near the after end, roof hatch aft, case chutes to
 *   doors in the rear plate, telescopes in hooded ports through the side plates, foot treadle):
 *   https://eugeneleeslover.com/USNAVY/CHAPTER-8-B.html
 * - okieboat.com after OP 805 (pointer left front, trainer right front, checker left behind
 *   and above the pointer, mount captain under a roof hatch, upper and lower case ports):
 *   https://okieboat.com/Gun%20mount.html
 * - Dick Baker, 5"/38 crews (mount captain on a raised seat at the rear between the guns):
 *   https://www.navweaps.com/Weapons/WNUS_5-38_mk12_Crews.php
 */
function buildPlayer5inTwin() {
  const M = playerMaterials();
  const G = MK28, GX = MK28_GX, HATCH = MK28_HATCH, HOODS = MK28_HOODS;
  const deckBlue = { mat: M.paint.mat, color: 0x3d4652 }; // Measure 21: Deck Blue on horizontal surfaces
  const root = new THREE.Group();
  root.name = 'player-5in-twin';
  const yaw = new THREE.Object3D();
  root.add(yaw);
  const pitch = new THREE.Object3D();
  pitch.position.copy(MK28_PIVOT);
  yaw.add(pitch);

  // face plate (leaning back from 0.22 to the eave) and the sloped roof front above it
  const chamY = G.roof - 0.12;
  const faceT = Math.atan2(G.slopeIn, G.eave - 0.22), chamT = Math.atan2(0.36, chamY - G.eave);
  const faceN = V(0, Math.sin(faceT), -Math.cos(faceT)), chamN = V(0, Math.sin(chamT), -Math.cos(chamT));
  const facePt = (x, y, d = 0) => V(x, y, G.front + (G.slopeIn * (y - 0.22)) / (G.eave - 0.22)).addScaledVector(faceN, d);
  const chamPt = (x, y, d = 0) => V(x, y, G.front + G.slopeIn + (0.36 * (y - G.eave)) / (chamY - G.eave)).addScaledVector(chamN, d);
  const sideX = (y) => G.w - (y <= G.eave ? 0 : (0.12 * (y - G.eave)) / (chamY - G.eave)); // side plate at height y

  const Y = new MatParts();
  const onFace = (spec, w, h, t, x, y, d) => {
    const p = facePt(x, y, d);
    Y.add(spec, box(w, h, t, p.x, p.y, p.z, faceT));
  };
  const onCham = (spec, w, h, t, x, y, d) => {
    const p = chamPt(x, y, d);
    Y.add(spec, box(w, h, t, p.x, p.y, p.z, chamT));
  };

  // ---- training base: flange over the roller path, foot ring under the shield
  Y.add(M.paintDark, yTube(0, 0.09, G.w + 0.06, G.w + 0.06, 72));
  Y.add(M.paint, yTube(0.09, 0.22, G.w - 0.03, G.w - 0.03, 72));
  for (let i = 0; i < 48; i++) {
    const a = ((i + 0.5) / 48) * Math.PI * 2;
    Y.add(M.metal, yTube(0.09, 0.106, 0.019, 0.015, 6, Math.cos(a) * (G.w + 0.025), Math.sin(a) * (G.w + 0.025)));
  }

  // ---- the shield: Navy Blue walls, Deck Blue roof
  const r0 = plan28(0.22, { fw: G.fw, w: G.w, front: G.front, cheek: 0.55, rear: G.rear, rr: 0.55 });
  const r1 = plan28(G.eave, { fw: G.fw, w: G.w, front: G.front + G.slopeIn, cheek: 0.42, rear: G.rear, rr: 0.55 });
  const r2 = plan28(chamY, { fw: G.fw - 0.15, w: G.w - 0.12, front: G.front + G.slopeIn + 0.36, cheek: 0.36, rear: G.rear - 0.09, rr: 0.5 });
  const r3 = plan28(G.roof, { fw: G.fw - 0.24, w: G.w - 0.22, front: G.front + G.slopeIn + 0.48, cheek: 0.32, rear: G.rear - 0.17, rr: 0.45 });
  Y.add(M.paint, loft([r0, r1, r2], { top: false, bottom: true, crease: 19 * DEG }));
  Y.add(deckBlue, loft([r2, r3], { crease: 19 * DEG }));

  // ---- gun ports: slots up the face plate and into the sloped roof front (the guns reach
  // 85 deg just ahead of the plate), with armoured lips. The canvas laced round each slot
  // closes it; the bloomer (pitch) gathers it onto the slide.
  for (const gx of [-GX, GX]) {
    const y0 = 0.98, ya = (y0 + G.eave) / 2, ha = (G.eave - y0) / Math.cos(faceT), hb = 0.42 / Math.cos(chamT);
    onFace(M.canvas, 0.54, ha, 0.02, gx, ya, 0.002);
    onCham(M.canvas, 0.54, hb, 0.02, gx, G.eave + 0.21, 0.002);
    for (const s of [-1, 1]) {
      onFace(M.paintDark, 0.07, ha + 0.04, 0.07, gx + s * 0.305, ya, 0.03);
      onCham(M.paintDark, 0.07, hb, 0.07, gx + s * 0.305, G.eave + 0.21, 0.03);
    }
    onFace(M.paintDark, 0.68, 0.07, 0.08, gx, y0 - 0.035, 0.035); // sill
    onCham(M.paintDark, 0.68, 0.07, 0.07, gx, G.eave + 0.44, 0.03); // header
  }
  // bolts along the foot of the face plate and up its outer edges
  boltRow(Y, M.paint, facePt(-1.45, 0.36), facePt(1.45, 0.36), 12, faceN);
  for (const s of [-1, 1]) boltRow(Y, M.paint, facePt(s * 1.5, 0.55), facePt(s * 1.5, 1.85), 6, faceN);

  // ---- sides: plate seam, butt straps, access door near the after end, handrail, rangefinder ear
  for (const sx of [-1, 1]) {
    const nx = V(sx, 0, 0), xw = sx * G.w;
    Y.add(M.paintDark, box(0.012, 0.035, 2.1, sx * (G.w + 0.006), 1.12, -0.35));
    boltRow(Y, M.paint, V(sx * (G.w + 0.012), 1.17, -1.3), V(sx * (G.w + 0.012), 1.17, 0.62), 10, nx);
    for (const z of [-0.5, 0.42]) {
      Y.add(M.paintDark, box(0.014, 1.5, 0.12, sx * (G.w + 0.007), 1.08, z));
      for (const e of [-0.035, 0.035]) boltRow(Y, M.paint, V(sx * (G.w + 0.014), 0.42, z + e), V(sx * (G.w + 0.014), 1.74, z + e), 7, nx, 0.017);
    }
    // watertight door: coaming, leaf, hinges forward, dogs aft, handle; a step below it
    const dz = 1.2;
    Y.add(M.paintDark, box(0.05, 1.6, 0.9, sx * (G.w + 0.012), 1.08, dz));
    Y.add(M.paint, box(0.05, 1.46, 0.76, sx * (G.w + 0.03), 1.08, dz));
    for (const y of [0.52, 1.08, 1.64]) {
      Y.add(M.metal, yTube(y - 0.07, y + 0.07, 0.028, 0.028, 10, sx * (G.w + 0.07), dz - 0.4));
      Y.add(M.paintDark, box(0.014, 0.06, 0.3, sx * (G.w + 0.06), y, dz - 0.25));
    }
    for (const [y, z] of [[0.5, dz + 0.4], [1.08, dz + 0.4], [1.66, dz + 0.4], [0.32, dz], [1.84, dz]]) {
      Y.add(M.metal, box(0.04, 0.04, 0.06, sx * (G.w + 0.075), y, z));
      Y.add(M.metal, box(0.025, 0.11, 0.025, sx * (G.w + 0.1), y - 0.03, z, 0, 0, sx * 0.3));
    }
    Y.add(M.metal, rod(V(sx * (G.w + 0.06), 1.0, dz + 0.22), V(sx * (G.w + 0.12), 1.0, dz + 0.27), 0.015, 6));
    Y.add(M.metal, rod(V(sx * (G.w + 0.12), 1.0, dz + 0.27), V(sx * (G.w + 0.12), 1.0, dz + 0.4), 0.015, 6));
    Y.add(M.paintDark, box(0.32, 0.04, 0.6, sx * (G.w + 0.16), 0.24, dz));
    Y.add(M.paintDark, box(0.025, 0.1, 0.6, sx * (G.w + 0.31), 0.2, dz));
    // handrail ahead of the door
    const hx = sx * (G.w + 0.12);
    Y.add(M.paintDark, rod(V(hx, 1.62, -1.25), V(hx, 1.62, 0.62), 0.022, 8));
    for (const z of [-1.25, -0.05, 0.62]) Y.add(M.paintDark, xTube(xw, hx, 0.016, 0.016, 6, 1.62, z));
    // the mount rangefinder's end hoods on the rear quarters
    const ey = G.roof - 0.42, ez = G.rear - 0.75, wx = sideX(ey);
    Y.add(M.paint, xTube(sx * (wx - 0.3), sx * (G.w + 0.4), 0.14, 0.14, 24, ey, ez));
    Y.add(M.paintDark, xTube(sx * (wx - 0.02), sx * (wx + 0.05), 0.2, 0.2, 24, ey, ez));
    boltRow(Y, M.paint, V(sx * (wx + 0.05), ey + 0.17, ez), V(sx * (wx + 0.05), ey - 0.17, ez), 2, nx, 0.015);
    Y.add(M.paint, box(0.17, 0.38, 0.4, sx * (G.w + 0.48), ey, ez));
    Y.add(M.paintDark, box(0.19, 0.03, 0.42, sx * (G.w + 0.48), ey + 0.2, ez));
    Y.add(M.glass, box(0.11, 0.12, 0.012, sx * (G.w + 0.48), ey + 0.02, ez - 0.203));
    Y.add(M.paintDark, box(0.2, 0.022, 0.13, sx * (G.w + 0.48), ey + 0.12, ez - 0.26, 0.3));
  }

  // ---- rear plate: empty-case ejector doors low down (the chutes, up to 40 deg elevation),
  // upper scuttles the hot-case men throw cases through at higher angles, rungs up the middle
  const rz = G.rear;
  for (const s of [-1, 1]) {
    const x = s * 1.0, ux = s * 0.92;
    Y.add(M.paintDark, box(0.52, 0.48, 0.03, x, 0.72, rz + 0.012));
    Y.add(M.paint, box(0.44, 0.4, 0.035, x, 0.72, rz + 0.03));
    Y.add(M.metal, xTube(x - 0.2, x + 0.2, 0.022, 0.022, 10, 0.93, rz + 0.05));
    Y.add(M.paintDark, box(0.52, 0.03, 0.14, x, 0.47, rz + 0.07));
    Y.add(M.paintDark, box(0.42, 0.36, 0.03, ux, 1.5, rz + 0.012));
    Y.add(M.paint, box(0.34, 0.28, 0.035, ux, 1.5, rz + 0.03));
    Y.add(M.metal, xTube(ux - 0.15, ux + 0.15, 0.02, 0.02, 10, 1.65, rz + 0.05));
    Y.add(M.metal, box(0.1, 0.03, 0.04, ux, 1.4, rz + 0.06));
    boltRow(Y, M.paint, V(s * 0.4, 0.36, rz), V(s * 1.6, 0.36, rz), 5, V(0, 0, 1));
    boltRow(Y, M.paint, V(s * 0.4, 1.86, rz), V(s * 1.6, 1.86, rz), 5, V(0, 0, 1));
  }
  for (const y of [0.5, 0.85, 1.2, 1.55, 1.9, 2.25]) {
    const zr = y <= G.eave ? rz : rz - (0.09 * (y - G.eave)) / (chamY - G.eave);
    Y.add(M.paintDark, rod(V(-0.2, y, zr), V(-0.2, y, zr + 0.12), 0.016, 6));
    Y.add(M.paintDark, rod(V(-0.2, y, zr + 0.12), V(0.2, y, zr + 0.12), 0.016, 6));
    Y.add(M.paintDark, rod(V(0.2, y, zr + 0.12), V(0.2, y, zr), 0.016, 6));
  }

  // ---- roof: plate seams, bolts, lifting eyes, mushroom ventilators, grab handle
  const ry = G.roof, UPV = V(0, 1, 0);
  Y.add(M.paintDark, box(3.0, 0.012, 0.045, 0, ry + 0.006, 0.28));
  Y.add(M.paintDark, box(0.045, 0.012, 1.45, 0, ry + 0.006, -0.45));
  for (const z of [0.2, 0.36]) boltRow(Y, deckBlue, V(-1.45, ry, z), V(1.45, ry, z), 12, UPV, 0.018);
  for (const x of [-0.08, 0.08]) boltRow(Y, deckBlue, V(x, ry, -1.12), V(x, ry, 0.12), 6, UPV, 0.018);
  const inset = plan28(ry, { fw: G.fw - 0.36, w: G.w - 0.34, front: G.front + G.slopeIn + 0.6, cheek: 0.28, rear: G.rear - 0.3, rr: 0.32 }, 3);
  for (let i = 0; i < inset.length; i++) {
    const a = inset[i], b = inset[(i + 1) % inset.length];
    const n = Math.max(1, Math.round(a.distanceTo(b) / 0.3));
    for (let k = 0; k < n; k++) {
      const p = a.clone().lerp(b, k / n);
      if (Math.abs(p.x) > 1.68 && p.z < 0.5) continue; // under the sight hoods
      boltRow(Y, deckBlue, p, p, 1, UPV, 0.018);
    }
  }
  for (const [x, z] of [[-1.45, -0.75], [1.45, -0.75], [-1.5, 1.95], [1.5, 1.95]]) {
    Y.add(M.paintDark, box(0.16, 0.04, 0.12, x, ry + 0.02, z));
    Y.add(M.metal, ring(0.055, 0.016, 'x', x, ry + 0.1, z, 6, 16));
  }
  for (const s of [-1, 1]) {
    const vx = s * 1.05, vz = 1.62;
    Y.add(M.paint, yTube(ry, ry + 0.36, 0.11, 0.11, 24, vx, vz));
    Y.add(M.paint, yTube(ry + 0.22, ry + 0.36, 0.24, 0.24, 32, vx, vz)); // mushroom cap skirt
    Y.add(M.paint, yTube(ry + 0.36, ry + 0.42, 0.24, 0.15, 32, vx, vz));
    Y.add(M.metal, yTube(ry + 0.42, ry + 0.46, 0.03, 0.03, 8, vx, vz)); // closing screw
  }
  for (const x of [-0.22, 0.22]) Y.add(M.paintDark, rod(V(x, ry, 2.02), V(x, ry + 0.14, 2.02), 0.016, 6));
  Y.add(M.paintDark, rod(V(-0.22, ry + 0.14, 2.02), V(0.22, ry + 0.14, 2.02), 0.016, 6));

  // ---- the mount captain's hatch: coaming, the dark opening, lid open aft with its handwheel
  Y.add(M.paint, arcWall(0.4, 0.47, ry, ry + 0.16, 0, Math.PI * 2, 48).translate(HATCH.x, 0, HATCH.z));
  Y.add(M.paintDark, ring(0.435, 0.022, 'y', HATCH.x, ry + 0.16, HATCH.z, 6, 48));
  Y.add(M.dark, yTube(ry - 0.01, ry + 0.09, 0.4, 0.4, 48, HATCH.x, HATCH.z));
  {
    const hingeY = ry + 0.16, hingeZ = HATCH.z + 0.47;
    const m = new THREE.Matrix4().makeTranslation(HATCH.x, hingeY, hingeZ).multiply(new THREE.Matrix4().makeRotationX(100 * DEG)).multiply(new THREE.Matrix4().makeTranslation(0, 0.025, -0.47));
    Y.add(M.paint, new THREE.CylinderGeometry(0.47, 0.47, 0.05, 48).applyMatrix4(m));
    Y.add(M.paintDark, ring(0.45, 0.02, 'y', 0, 0.025, 0, 6, 48).applyMatrix4(m));
    Y.add(M.metal, ring(0.13, 0.012, 'y', 0, -0.08, 0, 6, 24).applyMatrix4(m)); // dogging handwheel
    Y.add(M.metal, yTube(-0.08, -0.025, 0.02, 0.02, 8).applyMatrix4(m));
    for (const x of [-0.18, 0.18]) Y.add(M.metal, xTube(x - 0.07, x + 0.07, 0.032, 0.032, 10, hingeY, hingeZ));
    Y.add(M.paintDark, xTube(0.3, 0.62, 0.045, 0.045, 12, ry + 0.06, hingeZ)); // counterbalance spring
  }

  // ---- sight hoods through the upper side plates: telescope window recessed in a frame,
  // armoured shutter swung up on its hinge, bolts along the foot
  for (const h of Object.values(HOODS)) {
    const a = Math.min(h.xo, h.xi), b = Math.max(h.xo, h.xi), xc = (a + b) / 2, s = Math.sign(h.xo);
    Y.add(M.paint, loft([rect(a, b, h.z0 + 0.05, h.z1, G.eave - 0.1), rect(a, b, h.z0, h.z1, h.top - 0.16), rect(a + 0.05, b - 0.05, h.z0 + 0.15, h.z1 - 0.06, h.top)], { crease: 30 * DEG }));
    const wy = h.top - 0.27;
    Y.add(M.glass, box(0.3, 0.13, 0.012, xc, wy, h.z0 - 0.004));
    for (const e of [-1, 1]) {
      Y.add(M.paintDark, box(0.4, 0.045, 0.045, xc, wy + e * 0.088, h.z0 - 0.02));
      Y.add(M.paintDark, box(0.045, 0.22, 0.045, xc + e * 0.178, wy, h.z0 - 0.02));
    }
    const hy = wy + 0.11, hz = h.z0 - 0.03, th = 0.38;
    Y.add(M.metal, xTube(xc - 0.19, xc + 0.19, 0.018, 0.018, 8, hy, hz));
    Y.add(M.paintDark, box(0.44, 0.03, 0.24, xc, hy + 0.12 * Math.sin(th), hz - 0.12 * Math.cos(th), th));
    const yb = Math.max(G.eave, G.eave + ((G.w - Math.abs(h.xo)) / 0.12) * (chamY - G.eave)) + 0.1;
    boltRow(Y, M.paint, V(h.xo, yb, h.z0 + 0.12), V(h.xo, yb, h.z1 - 0.1), 5, V(s, 0, 0), 0.017);
    boltRow(Y, M.paint, V(xc, h.top, h.z0 + 0.3), V(xc, h.top, h.z1 - 0.15), 3, UPV, 0.016);
  }
  Y.build(yaw);

  // ---- elevating parts that show outside: slide noses, bag clamps and the bloomers
  const P = new MatParts();
  for (const gx of [-GX, GX]) {
    P.add(M.paint, zTube(0.3, -0.5, 0.2, 0.2, 36, gx));
    P.add(M.metal, zTube(-0.44, -0.53, 0.21, 0.21, 36, gx));
    P.add(M.canvas, bloomer(0.04, -0.46, 0.31, 0.208, gx * 3.1).translate(gx, 0, 0));
  }
  P.build(pitch);

  // ---- barrels (recoil along +Z inside the slides): plain taper, bare muzzle, dark bore
  const barrels = [], muzzles = [], breeches = [];
  for (const gx of [-GX, GX]) {
    const b = new THREE.Object3D();
    b.position.set(gx, 0, 0);
    pitch.add(b);
    const B = new MatParts();
    B.add(M.paint, zTube(0.05, -0.53, 0.153, 0.152, 40));
    B.add(M.paint, zTube(-0.53, -2.4, 0.152, 0.126, 40));
    B.add(M.paint, zTube(-2.4, -4.86, 0.126, 0.101, 40));
    B.add(M.metal, zTube(-4.86, -MK28_MUZZLE, 0.104, 0.104, 40));
    B.add(M.dark, zTube(-MK28_MUZZLE, -MK28_MUZZLE - 0.003, 0.0635, 0.0635, 24));
    B.build(b);
    const m = new THREE.Object3D();
    m.position.set(0, 0, -MK28_MUZZLE);
    b.add(m);
    barrels.push(b);
    muzzles.push(m);
    const br = new THREE.Object3D(); // breech face, where the case is extracted
    br.position.set(gx, 0, 0.75);
    pitch.add(br);
    breeches.push(br);
  }

  // camera anchors in yaw space (the gunhouse does not elevate): the mount captain standing on
  // his raised platform, head and shoulders out of the hatch (high enough to see the outer
  // barrels over the roof edge at zero elevation), and just ahead of each telescope window
  const win = (h) => V((h.xo + h.xi) / 2, h.top - 0.27, h.z0);
  const eyes = {
    centre: V(0, ry + 0.86, HATCH.z - 0.05),
    pointer: win(HOODS.pointer).add(V(0, 0, -0.06)),
    trainer: win(HOODS.trainer).add(V(0, 0, -0.06)),
    checker: win(HOODS.checker).add(V(0, 0, -0.06)),
  };
  const eye = new THREE.Object3D();
  eye.position.copy(eyes.centre);
  yaw.add(eye);

  const fiveInch = {
    trunnion: MK28_PIVOT.clone(), // yaw space
    trunnionHeight: MK28_PIVOT.y,
    barrelSpacing: 2 * GX, // 84 in
    barrelX: [-GX, GX],
    muzzleLength: MK28_MUZZLE,
    recoilLength: 0.381, // 15 in
    trainRate: 25 * DEG, // rad/s, NavWeaps (Mk 28)
    elevRate: 15 * DEG,
    roundsPerMinute: { sustained: 15, burst: 22 }, // per gun
    chuteMaxElev: 40 * DEG, // above this the hot-case man throws the case out by hand
    caseDoors: [V(-1.0, 0.72, G.rear + 0.06), V(1.0, 0.72, G.rear + 0.06)], // yaw space, chute outlets
    caseScuttles: [V(-0.92, 1.5, G.rear + 0.06), V(0.92, 1.5, G.rear + 0.06)],
    hatch: V(HATCH.x, ry + 0.16, HATCH.z),
    sights: { pointer: win(HOODS.pointer), trainer: win(HOODS.trainer), checker: win(HOODS.checker) },
    house: { front: G.front, rear: G.rear, halfWidth: G.w, roof: G.roof },
    projectileKg: 24.5, // 54 lb AA common, separate 28 lb case (semi-fixed)
    caseKg: 12.7,
  };
  return { root, yaw, pitch, barrels, muzzles, breeches, eye, eyes, eyeSpace: 'yaw', recoil: 0.381, elev: [-15 * DEG, 85 * DEG], magazines: [], fiveInch };
}

/** Detailed first-person gun: '5in-twin', '40mm-quad', '20mm-twin' or '20mm' (single). */
export function buildPlayerGun(kind) {
  if (kind === '5in-twin') return buildPlayer5inTwin();
  if (kind === '20mm') return buildPlayerOerlikonSingle();
  return kind === '20mm-twin' ? buildPlayerOerlikon() : buildPlayerBofors();
}
