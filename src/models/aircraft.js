import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../shaderlib.js';

// Procedural WW2 aircraft: Japanese raiders plus the US Hellcat parked on the carrier.
// Model space: forward -Z, up +Y, right (starboard) +X, origin at the CG, meters.
// Besides position/normal/aPart every vertex carries aSurf: (span fraction, chord fraction)
// on wings and tail surfaces, (0, -1) elsewhere. The livery shader uses it for control
// surfaces, leading-edge wear, wheel wells and markings.

export const PART = { FUSELAGE: 0, WING: 1, TAIL: 2, COWL: 3, GLASS: 4, PROP: 5, SPINNER: 6, GEAR: 7, ORDNANCE: 8, DARK: 9 };
export const AIRCRAFT_TYPES = ['zero', 'val', 'kate', 'betty', 'hellcat'];

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const D2R = Math.PI / 180;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------- geometry helpers

// Flip winding if the surface faces inward (signed volume about its centroid).
function orient(g) {
  const p = g.attributes.position, idx = g.index.array;
  const c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) c.add(V(p.getX(i), p.getY(i), p.getZ(i)));
  c.divideScalar(p.count);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(p, idx[t]).sub(c);
    b.fromBufferAttribute(p, idx[t + 1]).sub(c);
    d.fromBufferAttribute(p, idx[t + 2]).sub(c);
    vol += a.dot(b.cross(d));
  }
  if (vol < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const s = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = s;
    }
  }
  return g;
}

// Surface through rings of points (each ring a closed loop with the same count). Points may
// carry .s/.c surface coordinates, which become the aSurf attribute.
function tube(rings, { capStart = false, capEnd = false } = {}) {
  const n = rings[0].length;
  const pos = [], surf = [];
  for (const r of rings) {
    for (const p of r) {
      pos.push(p.x, p.y, p.z);
      surf.push(p.s ?? 0, p.c ?? -1);
    }
  }
  const idx = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + ((j + 1) % n), c = (i + 1) * n + j, d = (i + 1) * n + ((j + 1) % n);
      idx.push(a, b, c, b, d, c);
    }
  }
  const cap = (ring, base, start) => {
    const c = new THREE.Vector3();
    let s = 0, cc = 0;
    ring.forEach((p) => {
      c.add(p);
      s += p.s ?? 0;
      cc += p.c ?? -1;
    });
    c.divideScalar(n);
    const ci = pos.length / 3;
    pos.push(c.x, c.y, c.z);
    surf.push(s / n, cc / n);
    for (let j = 0; j < n; j++) {
      const a = base + j, b = base + ((j + 1) % n);
      if (start) idx.push(ci, b, a);
      else idx.push(ci, a, b);
    }
  };
  if (capStart) cap(rings[0], 0, true);
  if (capEnd) cap(rings[rings.length - 1], (rings.length - 1) * n, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSurf', new THREE.Float32BufferAttribute(surf, 2));
  g.setIndex(idx);
  return orient(g);
}

// Egg-shaped superellipse section in the XY plane at depth z (separate top and bottom heights).
function section(n, z, w, hT, hB, yc = 0, e = 2, xc = 0) {
  const pts = [];
  const k = 2 / e;
  w = Math.max(w, 2e-3);
  hT = Math.max(hT, 2e-3);
  hB = Math.max(hB, 2e-3);
  for (let j = 0; j < n; j++) {
    const a = (j / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const h = s >= 0 ? hT : hB;
    pts.push(V(xc + w * Math.sign(c) * Math.pow(Math.abs(c), k), yc + h * Math.sign(s) * Math.pow(Math.abs(s), k), z));
  }
  return pts;
}

const catmull = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

// Smoothly resample key stations (arrays of numbers) into `count` stations.
function resample(keys, count) {
  if (count <= keys.length) return keys;
  const n = keys.length, out = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * (n - 1);
    const k = Math.min(Math.floor(t), n - 2), f = t - k;
    const p0 = keys[Math.max(k - 1, 0)], p1 = keys[k], p2 = keys[k + 1], p3 = keys[Math.min(k + 2, n - 1)];
    out.push(p1.map((_, j) => catmull(p0[j], p1[j], p2[j], p3[j], f)));
  }
  return out;
}

// Stations [z, halfWidth, heightTop, heightBottom, centerY, exponent]; 4-tuples [z, w, h, yc] are accepted.
const norm = (st) => st.map((s) => (s.length === 4 ? [s[0], s[1], s[2], s[2], s[3], 2] : s.length === 5 ? [...s, 2] : s));

function loft(stations, { n = 20, count = 0, xc = 0, capStart = true, capEnd = true } = {}) {
  const st = resample(norm(stations), count);
  return tube(
    st.map(([z, w, hT, hB, yc, e]) => section(n, z, w, hT, hB, yc, e, xc)),
    { capStart, capEnd }
  );
}

// Linear lookup of a loft's section at z (for frames, fillets and placement).
function sectionAt(stations, z) {
  const st = norm(stations);
  if (z <= st[0][0]) return st[0];
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    if (z <= b[0]) {
      const t = (z - a[0]) / (b[0] - a[0]);
      return a.map((v, j) => lerp(v, b[j], t));
    }
  }
  return st[st.length - 1];
}

// Tube of radius r (n sides) along a polyline.
function pathTube(points, r, n = 5, r2 = r) {
  const rings = [];
  let prevU = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const a = points[Math.max(i - 1, 0)], b = points[Math.min(i + 1, points.length - 1)];
    const t = b.clone().sub(a).normalize();
    let u = prevU ? prevU.clone().projectOnPlane(t) : V(0, 1, 0).projectOnPlane(t);
    if (u.lengthSq() < 1e-6) u = V(1, 0, 0).projectOnPlane(t);
    u.normalize();
    prevU = u;
    const v = new THREE.Vector3().crossVectors(t, u).normalize();
    const pts = [];
    for (let j = 0; j < n; j++) {
      const q = (j / n) * Math.PI * 2 + Math.PI / n;
      pts.push(p.clone().addScaledVector(u, r * Math.cos(q)).addScaledVector(v, r2 * Math.sin(q)));
    }
    rings.push(pts);
  }
  return tube(rings, { capStart: true, capEnd: true });
}

// Streamlined strut between two points with an elliptic section (a along the flow, b across).
function strut(p0, p1, a, b = a, n = 8, a1 = a, b1 = b) {
  const dir = p1.clone().sub(p0).normalize();
  let u = V(0, 0, 1).projectOnPlane(dir);
  if (u.lengthSq() < 1e-6) u = V(1, 0, 0).projectOnPlane(dir);
  u.normalize();
  const v = new THREE.Vector3().crossVectors(dir, u).normalize();
  const mk = (c, ra, rb) => {
    const pts = [];
    for (let j = 0; j < n; j++) {
      const t = (j / n) * Math.PI * 2;
      pts.push(c.clone().addScaledVector(u, ra * Math.cos(t)).addScaledVector(v, rb * Math.sin(t)));
    }
    return pts;
  };
  return tube([mk(p0, a, b), mk(p1, a1, b1)], { capStart: true, capEnd: true });
}

// Wheel (or any short drum) turning about the X axis.
function wheel(c, r, w, n = 18) {
  const prof = [[-w / 2, r * 0.45], [-w / 2 + w * 0.12, r * 0.88], [-w * 0.25, r], [w * 0.25, r], [w / 2 - w * 0.12, r * 0.88], [w / 2, r * 0.45]];
  const rings = prof.map(([dx, rr]) => {
    const pts = [];
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2;
      pts.push(V(c.x + dx, c.y + rr * Math.cos(a), c.z + rr * Math.sin(a)));
    }
    return pts;
  });
  return tube(rings, { capStart: true, capEnd: true });
}

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.deleteAttribute('uv');
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

function sphere(x, y, z, r, sx = 1, sy = 1, sz = 1, w = 10, h = 7) {
  const g = new THREE.SphereGeometry(r, w, h);
  g.deleteAttribute('uv');
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

// Flat disc facing -Z (normals set explicitly).
function disc(x, y, z, w, h, n = 24) {
  const pos = [], nor = [];
  for (let j = 0; j < n; j++) {
    const a0 = (j / n) * Math.PI * 2, a1 = ((j + 1) / n) * Math.PI * 2;
    pos.push(x, y, z, x + w * Math.cos(a1), y + h * Math.sin(a1), z, x + w * Math.cos(a0), y + h * Math.sin(a0), z);
    nor.push(0, 0, -1, 0, 0, -1, 0, 0, -1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

function mirrorX(g) {
  const m = g.clone();
  m.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  if (m.index) return orient(m);
  // non-indexed: reverse every triangle
  const p = m.attributes.position;
  for (let t = 0; t < p.count; t += 3) {
    for (const name of Object.keys(m.attributes)) {
      const a = m.attributes[name], k = a.itemSize;
      for (let c = 0; c < k; c++) {
        const tmp = a.array[(t + 1) * k + c];
        a.array[(t + 1) * k + c] = a.array[(t + 2) * k + c];
        a.array[(t + 2) * k + c] = tmp;
      }
    }
  }
  return m;
}

// ---------------------------------------------------------------- wings

// Planform at spanwise station x: chord, leading edge z and dihedral height.
function wingAt(o, x) {
  const { semispan, root, tip = root * 0.5, zLE, sweep = 0, y = 0, dihedral = 0, dihedralFrom = 0, round = 0.15, shape = 'taper' } = o;
  const s = clamp(x / semispan, 0, 1);
  let c, le;
  if (shape === 'ellipse') {
    c = root * Math.sqrt(Math.max(0, 1 - Math.pow(s, 2.4)));
    const ref = zLE + 0.3 * root + sweep * x; // straight 30% chord line
    le = ref - 0.3 * c;
  } else {
    const lin = lerp(root, tip, s);
    c = lin;
    if (shape !== 'square' && s > 1 - round) {
      const k = (s - (1 - round)) / round;
      c = lin * Math.sqrt(Math.max(0, 1 - k * k));
    }
    le = zLE + sweep * x + (lin - c) * 0.42;
  }
  return { c, le, y: y + Math.max(0, x - dihedralFrom) * Math.tan(dihedral) };
}

// One wing half (span along +X) with a NACA 00xx-like cambered section and washout.
function wingHalf(o) {
  const { semispan, tRoot = 0.15, tTip = 0.09, shape = 'taper', S = 20, C = 26, camber = 0.015, x0 = 0, washout = 0 } = o;
  const rings = [];
  for (let i = 0; i <= S; i++) {
    const u = i / S;
    const s = shape === 'square' ? u : Math.sin((u * Math.PI) / 2);
    const x = x0 + s * (semispan - x0);
    const { c, le, y } = wingAt(o, x);
    const sf = x / semispan;
    const tc = lerp(tRoot, tTip, sf);
    const tw = -washout * D2R * sf; // nose down toward the tip
    const ct = Math.cos(tw), st = Math.sin(tw);
    const pts = [];
    for (let j = 0; j < C; j++) {
      const th = (j / C) * Math.PI * 2;
      const xc = 0.5 * (1 + Math.cos(th)); // j = 0 trailing edge, j = C/2 leading edge
      const up = j < C / 2 ? 1 : -1;
      const yt = 5 * tc * c * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
      const ly = camber * c * 4 * xc * (1 - xc) + up * yt;
      const lz = (xc - 0.25) * c;
      const p = V(x, y + ly * ct - lz * st, le + 0.25 * c + ly * st + lz * ct);
      p.s = sf;
      p.c = xc;
      pts.push(p);
    }
    rings.push(pts);
  }
  return tube(rings, { capEnd: shape === 'square' });
}

const wingPair = (o) => {
  const r = wingHalf(o);
  return [r, mirrorX(r)];
};

// Vertical surface: a wing half rotated so its span points up from baseY.
function finSurface(o, baseY) {
  const g = wingHalf({ ...o, y: 0, camber: 0, washout: 0 });
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setXY(i, y, x + baseY);
  }
  return orient(g);
}

// ---------------------------------------------------------------- props and engines

function bladeSet(center, R, count, chord, hub = 0.17) {
  const out = [];
  const zf = V(0, 0, 1);
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2 + 0.3;
    const d = V(Math.cos(a), Math.sin(a), 0), t = V(-Math.sin(a), Math.cos(a), 0);
    const rings = [];
    const st = 10;
    for (let i = 0; i <= st; i++) {
      const u = i / st;
      const r = lerp(hub, R, u);
      // round shank, paddle widest near 60% radius, rounded tip
      const shank = 1 - smoothstep01(0.0, 0.25, u);
      const body = 0.78 + 0.22 * Math.sin(Math.min(u / 0.6, 1) * Math.PI * 0.5);
      const tipK = u < 0.82 ? 1 : 0.3 + 0.7 * Math.cos(((u - 0.82) / 0.18) * Math.PI * 0.5);
      const w = lerp(chord * body * tipK, 0.09, shank);
      const th = lerp(0.045 * (1 - 0.65 * u), 0.085, shank);
      const pitch = lerp(58, 15, Math.pow(u, 0.8)) * D2R;
      const cv = t.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(zf, Math.sin(pitch));
      const tv = t.clone().multiplyScalar(-Math.sin(pitch)).addScaledVector(zf, Math.cos(pitch));
      const c = center.clone().addScaledVector(d, r);
      const pts = [];
      for (let m = 0; m < 8; m++) {
        const q = (m / 8) * Math.PI * 2;
        // flat-backed airfoil: thicker toward the leading edge
        const cq = Math.cos(q), sq = Math.sin(q);
        const thick = th * (sq > 0 ? 0.55 : 0.45) * (0.75 + 0.25 * cq);
        pts.push(c.clone().addScaledVector(cv, (w / 2) * cq).addScaledVector(tv, thick * sq));
      }
      rings.push(pts);
    }
    out.push(tube(rings, { capStart: true, capEnd: true }));
  }
  return out;
}

function smoothstep01(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function spinner(x, y, zTip, zBase, r, n = 18) {
  const st = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const rr = r * Math.sqrt(1 - Math.pow(1 - t, 2.2)) + 0.004;
    st.push([lerp(zTip, zBase, t), rr, rr, rr, y, 2]);
  }
  return loft(st, { n, xc: x, capStart: false, capEnd: true });
}

// Radial engine cowling, open at the front with an inward lip.
function cowl({ x = 0, y = 0, zF, zB, w, h = w, wB, hB = wB, inner = 0.74, n = 32 }) {
  const rings = [
    section(n, zF + 0.16, w * inner, h * inner, h * inner, y, 2, x),
    section(n, zF + 0.02, w * (inner + 0.1), h * (inner + 0.1), h * (inner + 0.1), y, 2, x),
    section(n, zF - 0.005, w * 0.9, h * 0.9, h * 0.9, y, 2, x),
    section(n, zF + 0.04, w * 0.985, h * 0.985, h * 0.985, y, 2, x),
    section(n, zF + 0.12, w, h, h, y, 2, x),
    section(n, lerp(zF, zB, 0.45), w * 1.012, h * 1.012, h * 1.012, y, 2, x),
    section(n, lerp(zF, zB, 0.8), lerp(w, wB, 0.6) * 1.005, lerp(h, hB, 0.6) * 1.005, lerp(h, hB, 0.6) * 1.005, y, 2, x),
    section(n, zB, wB, hB, hB, y, 2, x),
  ];
  return tube(rings);
}

// Two-row radial: cylinders and the reduction-gear housing seen through the cowl mouth.
function engineFace(e, out) {
  const h = e.h || e.w;
  const R0 = e.w * 0.26, R1 = e.w * 0.68;
  for (let row = 0; row < 2; row++) {
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + (row ? Math.PI / 7 : 0) + 0.2;
      const ca = Math.cos(a), sa = Math.sin(a) * (h / e.w);
      const z = e.zF + 0.3 + row * 0.2;
      out.push([strut(V(e.x + ca * R0, e.y + sa * R0, z), V(e.x + ca * R1, e.y + sa * R1, z), 0.075, 0.075, 6, 0.06, 0.06), PART.DARK]);
    }
  }
  // crankcase and gear housing behind the spinner
  out.push([loft([[e.zF + 0.1, e.w * 0.3, e.w * 0.3, e.w * 0.3, e.y, 2], [e.zF + 0.22, e.w * 0.36, e.w * 0.36, e.w * 0.36, e.y, 2], [e.zF + 0.6, e.w * 0.32, e.w * 0.32, e.w * 0.32, e.y, 2]], { n: 14, xc: e.x }), PART.DARK]);
  out.push([disc(e.x, e.y, e.zF + 0.62, e.w * 0.9, h * 0.9), PART.DARK]);
}

// Cowl flaps around the back of the cowling, slightly open.
function cowlFlaps(e, out, count = 16, open = 0.12) {
  const h = e.hB || e.wB;
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2;
    if (e.flapGap && Math.abs(Math.sin(a) + 1) < 0.25) continue; // leave the chin clear
    const ca = Math.cos(a), sa = Math.sin(a);
    // x radial, y around the cowl, z aft from the hinge; opened outward about the hinge line
    const g = box(0.02, ((2 * Math.PI * e.wB) / count) * 0.92, 0.26, 0, 0, 0.13);
    const m = new THREE.Matrix4().makeRotationZ(a).multiply(new THREE.Matrix4().makeRotationY(open));
    g.applyMatrix4(m);
    g.translate(e.x + ca * e.wB * 0.995, e.y + sa * h * 0.995, e.zB - 0.02);
    out.push([g, PART.COWL, true]);
  }
}

function exhausts(e, out, perSide = 4) {
  const h = e.hB || e.wB;
  for (const side of [-1, 1]) {
    for (let k = 0; k < perSide; k++) {
      const a = lerp(-0.55, 0.35, perSide > 1 ? k / (perSide - 1) : 0.5);
      const ca = Math.cos(a), sa = Math.sin(a);
      const p0 = V(e.x + side * ca * e.wB * 0.96, e.y + sa * h * 0.96, e.zB - 0.1);
      const p1 = V(e.x + side * ca * (e.wB + 0.07), e.y + sa * (h + 0.03) - 0.02, e.zB + 0.16);
      out.push([strut(p0, p1, 0.045, 0.032, 6, 0.04, 0.03), PART.DARK]);
    }
  }
}

// ---------------------------------------------------------------- ordnance

function bombPieces() {
  const body = loft(
    [[-0.8, 0.0, 0.0, 0.0, 0, 2], [-0.76, 0.06, 0.06, 0.06, 0, 2], [-0.66, 0.115, 0.115, 0.115, 0, 2], [-0.46, 0.15, 0.15, 0.15, 0, 2], [0.18, 0.15, 0.15, 0.15, 0, 2], [0.42, 0.105, 0.105, 0.105, 0, 2], [0.6, 0.06, 0.06, 0.06, 0, 2], [0.8, 0.035, 0.035, 0.035, 0, 2]],
    { n: 16, count: 14 }
  );
  const flat = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    flat.push(box(0.012, 0.17, 0.34, Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0.62, 0, 0, a - Math.PI / 2));
  }
  // fin bracing ring and nose fuze
  const smooth = [body, strut(V(0, 0, 0.66), V(0, 0, 0.72), 0.2, 0.2, 14), strut(V(0, 0, -0.84), V(0, 0, -0.79), 0.025, 0.025, 6)];
  return { smooth, flat };
}

function torpedoPieces() {
  const body = loft(
    [[-2.63, 0.0, 0.0, 0.0, 0, 2], [-2.58, 0.11, 0.11, 0.11, 0, 2], [-2.48, 0.185, 0.185, 0.185, 0, 2], [-2.3, 0.225, 0.225, 0.225, 0, 2], [1.45, 0.225, 0.225, 0.225, 0, 2], [1.95, 0.175, 0.175, 0.175, 0, 2], [2.3, 0.1, 0.1, 0.1, 0, 2], [2.48, 0.05, 0.05, 0.05, 0, 2], [2.6, 0.02, 0.02, 0.02, 0, 2]],
    { n: 18, count: 16 }
  );
  const flat = [
    // cruciform fins
    box(0.012, 0.6, 0.48, 0, 0, 2.36),
    box(0.6, 0.012, 0.48, 0, 0, 2.36),
    // wooden air-drop stabilizer box around the tail
    box(0.62, 0.012, 0.3, 0, 0.3, 2.47),
    box(0.62, 0.012, 0.3, 0, -0.3, 2.47),
    box(0.012, 0.62, 0.3, 0.3, 0, 2.47),
    box(0.012, 0.62, 0.3, -0.3, 0, 2.47),
    // contra-rotating propellers
    box(0.42, 0.05, 0.015, 0, 0, 2.56, 0, 0, 0.5),
    box(0.42, 0.05, 0.015, 0, 0, 2.56, 0, 0, 2.07),
    box(0.38, 0.045, 0.015, 0, 0, 2.6, 0, 0, 1.3),
    box(0.38, 0.045, 0.015, 0, 0, 2.6, 0, 0, 2.87),
  ];
  // suspension bands
  const smooth = [body, strut(V(0, 0, -0.7), V(0, 0, -0.6), 0.235, 0.235, 18), strut(V(0, 0, 0.6), V(0, 0, 0.7), 0.235, 0.235, 18)];
  return { smooth, flat };
}

// ---------------------------------------------------------------- aircraft specs
// Fuselage stations: [z, halfWidth, heightTop, heightBottom, centerY, superellipse exponent].

const JP_UPPER = [0.21, 0.27, 0.17];
const JP_LOWER = [0.62, 0.63, 0.55];
const JP_COWL = [0.045, 0.045, 0.05];
const GSB = [0.1, 0.14, 0.24];

const SPECS = {
  zero: {
    fuselage: [
      [-1.78, 0.6, 0.6, 0.6, 0.02, 2.0], [-1.2, 0.6, 0.63, 0.62, 0.03, 2.05], [-0.4, 0.58, 0.64, 0.64, 0.04, 2.1],
      [0.4, 0.55, 0.62, 0.62, 0.06, 2.1], [1.2, 0.5, 0.56, 0.6, 0.08, 2.05], [2.0, 0.44, 0.49, 0.55, 0.11, 2.0],
      [2.9, 0.36, 0.41, 0.47, 0.15, 2.0], [3.8, 0.28, 0.34, 0.39, 0.19, 2.0], [4.7, 0.2, 0.27, 0.3, 0.23, 2.0],
      [5.4, 0.13, 0.22, 0.22, 0.27, 2.0], [5.85, 0.07, 0.15, 0.13, 0.29, 2.0], [6.05, 0.02, 0.06, 0.04, 0.3, 2.0],
    ],
    canopy: [[-0.95, 0.2, 0.1, 0.62], [-0.72, 0.29, 0.36, 0.62], [-0.4, 0.33, 0.5, 0.64], [0.4, 0.33, 0.52, 0.66], [1.1, 0.31, 0.46, 0.68], [1.55, 0.27, 0.36, 0.7]],
    fairing: [[1.4, 0.26, 0.36, 0.7], [2.2, 0.2, 0.22, 0.68], [3.0, 0.11, 0.09, 0.64], [3.4, 0.04, 0.02, 0.6]],
    frames: [-0.72, -0.42, -0.05, 0.3, 0.68, 1.05, 1.42],
    crew: [0.2],
    mast: [V(0, 0.95, 2.2), V(0, 1.5, 2.45)],
    wire: true,
    engines: [{ x: 0, y: 0.02, zF: -2.82, zB: -1.72, w: 0.63, wB: 0.6, spinner: [-3.07, -2.8, 0.24], prop: { z: -2.92, r: 1.52, blades: 3, chord: 0.24 }, exhausts: 4, carb: true, oil: true }],
    wing: { semispan: 5.5, root: 2.55, tip: 1.15, zLE: -0.64, sweep: 0.02, y: -0.38, dihedral: 6.5 * D2R, dihedralFrom: 0.5, tRoot: 0.15, tTip: 0.09, round: 0.2, x0: 0.12, washout: 2.5 },
    htail: { semispan: 2.4, root: 1.25, tip: 0.6, zLE: 4.65, sweep: 0.15, y: 0.24, round: 0.3, tRoot: 0.1, tTip: 0.08, S: 10, C: 18 },
    fin: { semispan: 1.35, root: 1.45, tip: 0.6, zLE: 4.45, sweep: 0.45, round: 0.35, tRoot: 0.1, tTip: 0.08, S: 10, C: 18, base: 0.4 },
    gear: null,
    tailwheel: V(0, -0.2, 5.15),
    wingGuns: [2.3],
    pitot: -4.4,
    ordnance: { kind: 'bomb', pos: V(0, -0.98, -0.1), rack: -0.62 },
    guns: [V(-0.16, 0.58, -2.6), V(0.16, 0.58, -2.6), V(-2.3, -0.35, -1.1), V(2.3, -0.35, -1.1)],
    livery: { upper: JP_UPPER, lower: JP_LOWER, cowl: JP_COWL, demarc: [0.06, 0.045], fus: [3.1, 0.14, 0.32, 0.06], wingX: 3.9, wingR: 0.5, iff: [0.12, 0.48], glass: [0.36, 0.8], code: 352 },
  },
  val: {
    fuselage: [
      [-2.0, 0.63, 0.64, 0.64, 0.02, 2.0], [-1.3, 0.62, 0.68, 0.66, 0.03, 2.05], [-0.4, 0.6, 0.69, 0.68, 0.05, 2.1],
      [0.5, 0.57, 0.67, 0.66, 0.07, 2.1], [1.4, 0.52, 0.62, 0.62, 0.1, 2.05], [2.3, 0.46, 0.55, 0.57, 0.13, 2.0],
      [3.2, 0.39, 0.47, 0.49, 0.17, 2.0], [4.1, 0.32, 0.39, 0.41, 0.21, 2.0], [5.0, 0.24, 0.31, 0.33, 0.25, 2.0],
      [5.8, 0.17, 0.24, 0.25, 0.29, 2.0], [6.5, 0.1, 0.17, 0.16, 0.32, 2.0], [6.88, 0.03, 0.06, 0.05, 0.33, 2.0],
    ],
    canopy: [[-1.05, 0.22, 0.1, 0.66], [-0.78, 0.3, 0.38, 0.66], [-0.4, 0.34, 0.52, 0.68], [1.0, 0.34, 0.54, 0.7], [2.0, 0.32, 0.5, 0.72], [2.6, 0.28, 0.4, 0.73]],
    fairing: [[2.5, 0.27, 0.38, 0.73], [3.3, 0.2, 0.22, 0.7], [4.1, 0.1, 0.08, 0.64], [4.5, 0.04, 0.02, 0.6]],
    frames: [-0.78, -0.45, -0.05, 0.4, 0.85, 1.3, 1.75, 2.2, 2.52],
    crew: [-0.1, 1.85],
    mast: [V(0, 1.0, -1.25), V(0, 1.45, -1.0)],
    wire: true,
    engines: [{ x: 0, y: 0.02, zF: -3.07, zB: -1.95, w: 0.68, wB: 0.64, spinner: [-3.34, -3.05, 0.26], prop: { z: -3.19, r: 1.6, blades: 3, chord: 0.25 }, exhausts: 4, carb: true, oil: true }],
    wing: { semispan: 7.2, root: 2.9, zLE: -0.72, sweep: 0.0, y: -0.42, dihedral: 6 * D2R, dihedralFrom: 1.9, tRoot: 0.15, tTip: 0.09, shape: 'ellipse', S: 22, x0: 0.12, washout: 2 },
    htail: { semispan: 2.5, root: 1.45, tip: 0.7, zLE: 5.05, sweep: 0.1, y: 0.28, round: 0.4, tRoot: 0.1, tTip: 0.08, S: 10, C: 18 },
    fin: { semispan: 1.45, root: 1.75, tip: 0.65, zLE: 4.85, sweep: 0.5, round: 0.35, tRoot: 0.1, tTip: 0.08, S: 10, C: 18, base: 0.45 },
    fin2: { semispan: 0.42, root: 1.5, tip: 0.35, zLE: 3.75, sweep: 2.4, round: 0.0, tRoot: 0.09, tTip: 0.09, S: 4, C: 12, base: 0.55 },
    gear: 'spats',
    tailwheel: null,
    diveBrakes: true,
    pitot: -5.6,
    ordnance: { kind: 'bomb', pos: V(0, -1.0, -0.15), rack: -0.66, crutch: true },
    guns: [V(-0.16, 0.62, -2.95), V(0.16, 0.62, -2.95), V(-2.4, -0.38, -1.3), V(2.4, -0.38, -1.3)],
    livery: { upper: JP_UPPER, lower: JP_LOWER, cowl: JP_COWL, demarc: [0.08, 0.045], fus: [3.5, 0.16, 0.33, 0.06], wingX: 4.8, wingR: 0.55, iff: [0.12, 0.42], glass: [0.4, 0.84], code: 217 },
  },
  kate: {
    fuselage: [
      [-1.9, 0.61, 0.62, 0.62, 0.02, 2.0], [-1.2, 0.61, 0.66, 0.65, 0.03, 2.05], [-0.3, 0.59, 0.67, 0.68, 0.05, 2.1],
      [0.7, 0.56, 0.66, 0.67, 0.07, 2.1], [1.7, 0.52, 0.62, 0.63, 0.09, 2.05], [2.7, 0.46, 0.56, 0.57, 0.12, 2.0],
      [3.7, 0.39, 0.49, 0.5, 0.16, 2.0], [4.7, 0.31, 0.4, 0.41, 0.2, 2.0], [5.6, 0.23, 0.31, 0.32, 0.24, 2.0],
      [6.4, 0.15, 0.22, 0.23, 0.28, 2.0], [7.0, 0.08, 0.13, 0.12, 0.3, 2.0], [7.2, 0.03, 0.05, 0.04, 0.31, 2.0],
    ],
    canopy: [[-1.0, 0.22, 0.1, 0.65], [-0.72, 0.3, 0.38, 0.65], [-0.3, 0.34, 0.5, 0.67], [1.5, 0.35, 0.52, 0.69], [3.0, 0.33, 0.48, 0.71], [3.7, 0.28, 0.38, 0.72]],
    fairing: [[3.6, 0.27, 0.38, 0.72], [4.4, 0.18, 0.2, 0.69], [5.0, 0.08, 0.06, 0.64], [5.3, 0.03, 0.02, 0.6]],
    frames: [-0.72, -0.4, 0.0, 0.42, 0.85, 1.3, 1.75, 2.2, 2.65, 3.1, 3.55],
    crew: [0.05, 1.45, 2.85],
    mast: null,
    wire: false,
    engines: [{ x: 0, y: 0.02, zF: -2.88, zB: -1.85, w: 0.66, wB: 0.62, spinner: [-3.14, -2.86, 0.25], prop: { z: -2.99, r: 1.6, blades: 3, chord: 0.25 }, exhausts: 4, carb: true, oil: true }],
    wing: { semispan: 7.76, root: 3.0, tip: 1.35, zLE: -0.75, sweep: 0.05, y: -0.42, dihedral: 6 * D2R, dihedralFrom: 2.0, tRoot: 0.15, tTip: 0.09, round: 0.15, S: 22, x0: 0.12, washout: 2 },
    htail: { semispan: 2.6, root: 1.4, tip: 0.75, zLE: 5.4, sweep: 0.15, y: 0.26, round: 0.3, tRoot: 0.1, tTip: 0.08, S: 10, C: 18 },
    fin: { semispan: 1.5, root: 1.6, tip: 0.7, zLE: 5.3, sweep: 0.45, round: 0.3, tRoot: 0.1, tTip: 0.08, S: 10, C: 18, base: 0.45 },
    gear: null,
    tailwheel: V(0, -0.2, 6.2),
    pitot: -6.2,
    ordnance: { kind: 'torpedo', pos: V(0.28, -1.02, -0.25), rack: -0.6 },
    guns: [V(-0.15, 0.6, -2.7), V(0.15, 0.6, -2.7)],
    livery: { upper: JP_UPPER, lower: JP_LOWER, cowl: JP_COWL, demarc: [0.08, 0.04], fus: [4.3, 0.17, 0.33, 0.06], wingX: 5.5, wingR: 0.58, iff: [0.12, 0.42], glass: [0.42, 0.82], code: 311 },
  },
  betty: {
    fusN: 36,
    fuselage: [
      [-6.3, 0.75, 0.8, 0.78, 0.0, 2.0], [-5.5, 0.95, 1.02, 1.0, 0.02, 2.0], [-4.2, 1.05, 1.15, 1.13, 0.05, 2.05],
      [-2.0, 1.08, 1.18, 1.16, 0.07, 2.05], [0.5, 1.07, 1.17, 1.15, 0.09, 2.05], [3.0, 1.0, 1.1, 1.08, 0.13, 2.0],
      [5.5, 0.86, 0.95, 0.93, 0.2, 2.0], [7.5, 0.7, 0.78, 0.76, 0.28, 2.0], [9.3, 0.52, 0.58, 0.56, 0.38, 2.0],
      [10.8, 0.36, 0.4, 0.39, 0.48, 2.0], [11.5, 0.27, 0.29, 0.28, 0.53, 2.0],
    ],
    glassNose: [[-8.0, 0.05, 0.05, -0.06], [-7.85, 0.3, 0.3, -0.05], [-7.5, 0.55, 0.57, -0.04], [-7.0, 0.7, 0.74, -0.02], [-6.5, 0.77, 0.82, 0.0], [-6.15, 0.79, 0.84, 0.0]],
    glassTail: [[11.4, 0.3, 0.32, 0.53], [11.8, 0.22, 0.23, 0.56], [12.15, 0.1, 0.1, 0.58], [12.3, 0.03, 0.03, 0.59]],
    canopy: [[-5.9, 0.5, 0.12, 0.8], [-5.4, 0.62, 0.45, 0.82], [-4.6, 0.66, 0.52, 0.84], [-3.6, 0.62, 0.48, 0.84], [-3.0, 0.5, 0.3, 0.82]],
    frames: [-5.45, -5.0, -4.55, -4.1, -3.65, -3.25],
    crew: [-4.9],
    crewX: [-0.32, 0.32],
    blister: [[1.6, 0.05, 0.05, 1.12], [1.9, 0.4, 0.3, 1.15], [2.6, 0.45, 0.38, 1.15], [3.3, 0.35, 0.28, 1.13], [3.6, 0.05, 0.05, 1.1]],
    waist: { z: 6.4, y: 0.35, len: 1.1 },
    mast: [V(0, 1.15, -2.4), V(0, 1.75, -2.1)],
    engines: [-1, 1].map((s) => ({
      x: s * 3.85, y: -0.1, zF: -3.5, zB: -2.35, w: 0.78, wB: 0.72, spinner: [-3.77, -3.47, 0.3],
      prop: { z: -3.62, r: 1.7, blades: 3, chord: 0.28 }, exhausts: 3,
      nacelle: [[-2.4, 0.74, 0.74, 0.74, -0.1, 2], [-1.4, 0.72, 0.76, 0.8, -0.13, 2.1], [0.0, 0.62, 0.66, 0.74, -0.13, 2.15], [1.4, 0.48, 0.48, 0.56, -0.1, 2.1], [2.6, 0.3, 0.28, 0.32, -0.06, 2], [3.4, 0.08, 0.08, 0.08, -0.03, 2]],
    })),
    wing: { semispan: 12.5, root: 4.4, tip: 1.6, zLE: -1.1, sweep: 0.06, y: -0.15, dihedral: 6 * D2R, dihedralFrom: 1.2, tRoot: 0.17, tTip: 0.1, round: 0.12, S: 24, C: 28, x0: 0.3, washout: 2 },
    htail: { semispan: 4.1, root: 2.1, tip: 1.0, zLE: 9.6, sweep: 0.2, y: 0.5, round: 0.3, tRoot: 0.1, tTip: 0.08, S: 12, C: 18 },
    fin: { semispan: 2.7, root: 3.2, tip: 1.2, zLE: 8.6, sweep: 0.55, round: 0.3, tRoot: 0.12, tTip: 0.08, S: 12, C: 18, base: 0.75 },
    gear: null,
    tailwheel: V(0, -0.15, 10.6),
    pitot: null,
    ordnance: { kind: 'torpedo', pos: V(0, -1.15, -0.6), rack: null },
    guns: [V(0, -0.05, -7.95), V(0, 0.58, 12.25)],
    livery: { upper: [0.2, 0.25, 0.16], lower: [0.6, 0.6, 0.55], cowl: JP_COWL, demarc: [0.05, 0.04], fus: [6.7, 0.25, 0.52, 0.08], wingX: 9.2, wingR: 0.8, iff: [0.06, 0.28], glass: [0.3, 1.02], mottle: true, betty: true, code: 762 },
  },
  hellcat: {
    fuselage: [
      [-2.25, 0.67, 0.78, 0.78, -0.06, 2.0], [-1.4, 0.67, 0.82, 0.9, -0.02, 2.1], [-0.4, 0.65, 0.8, 0.94, 0.01, 2.15],
      [0.6, 0.61, 0.76, 0.88, 0.05, 2.15], [1.6, 0.55, 0.7, 0.78, 0.1, 2.1], [2.6, 0.47, 0.6, 0.66, 0.15, 2.05],
      [3.6, 0.38, 0.5, 0.54, 0.2, 2.0], [4.6, 0.29, 0.4, 0.42, 0.25, 2.0], [5.5, 0.2, 0.3, 0.3, 0.3, 2.0],
      [6.2, 0.11, 0.19, 0.18, 0.34, 2.0], [6.6, 0.03, 0.06, 0.05, 0.36, 2.0],
    ],
    canopy: [[-0.95, 0.24, 0.1, 0.76], [-0.68, 0.32, 0.4, 0.78], [-0.2, 0.35, 0.5, 0.8], [0.6, 0.33, 0.46, 0.82], [1.0, 0.28, 0.32, 0.82]],
    fairing: [[0.9, 0.3, 0.34, 0.82], [2.0, 0.26, 0.24, 0.78], [3.2, 0.18, 0.12, 0.7], [4.0, 0.08, 0.04, 0.62]],
    frames: [-0.68, -0.38, 0.0, 0.42, 0.85],
    crew: [0.25],
    mast: [V(0, 1.12, 1.6), V(0, 1.55, 1.85)],
    wire: true,
    engines: [{ x: 0, y: -0.1, zF: -3.36, zB: -2.2, w: 0.68, h: 0.76, wB: 0.67, hB: 0.77, spinner: [-3.64, -3.32, 0.3], prop: { z: -3.47, r: 1.95, blades: 3, chord: 0.27 }, exhausts: 3, chin: true, flapGap: true }],
    wing: { semispan: 6.53, root: 3.05, tip: 1.65, zLE: -0.78, sweep: 0.03, y: -0.5, dihedral: 7.5 * D2R, dihedralFrom: 1.6, tRoot: 0.16, tTip: 0.1, shape: 'square', S: 16, x0: 0.15, washout: 2 },
    htail: { semispan: 2.5, root: 1.5, tip: 0.85, zLE: 5.15, sweep: 0.2, y: 0.3, round: 0.2, tRoot: 0.1, tTip: 0.08, S: 10, C: 18 },
    fin: { semispan: 1.55, root: 1.75, tip: 0.8, zLE: 4.85, sweep: 0.45, round: 0.4, tRoot: 0.1, tTip: 0.08, S: 10, C: 18, base: 0.5 },
    gear: 'down',
    pitot: 5.9,
    ordnance: null,
    guns: [V(-2.7, -0.5, -1.45), V(2.7, -0.5, -1.45)],
    livery: { us: true, upper: GSB, lower: GSB, cowl: GSB, demarc: [0, 0], fus: [2.4, 0.15, 0.4, 0], wingX: 4.6, wingR: 0.5, iff: [99, 99], glass: [0.45, 0.94], code: 35 },
  },
};

// ---------------------------------------------------------------- assembly

function finish(g, part, { flat = false } = {}) {
  let geo = g;
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  if (!geo.attributes.aSurf) {
    const n = geo.attributes.position.count;
    const s = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) s[i * 2 + 1] = -1;
    geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(s, 2));
  }
  if (flat) {
    if (geo.index) geo = geo.toNonIndexed();
    geo.computeVertexNormals();
  } else if (!geo.attributes.normal || geo.index) {
    geo.computeVertexNormals();
  }
  if (geo.index) geo = geo.toNonIndexed();
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count).fill(part), 1));
  return geo;
}

function ordnancePieces(kind) {
  return kind === 'torpedo' ? torpedoPieces() : bombPieces();
}

// Upper surface height of a wing at span x and chord fraction xc (for parts sitting on the wing).
function wingSurfaceY(o, x, xc, up = 1) {
  const { c, y } = wingAt(o, x);
  const tc = lerp(o.tRoot ?? 0.15, o.tTip ?? 0.09, x / o.semispan);
  const yt = 5 * tc * c * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
  return y + (o.camber ?? 0.015) * c * 4 * xc * (1 - xc) + up * yt;
}

function build(type) {
  const s = SPECS[type];
  const out = [];
  const add = (g, part, opts) => out.push(finish(g, part, opts));

  // ---- fuselage, fairings, glazing
  const fusStations = norm(s.fuselage);
  add(loft(fusStations, { n: s.fusN || 30, count: s.fusN ? 34 : 30 }), PART.FUSELAGE);
  if (s.fairing) add(loft(s.fairing, { n: 18, count: 10 }), PART.FUSELAGE);
  add(loft(s.canopy, { n: 22, count: 14 }), PART.GLASS);
  if (s.glassNose) add(loft(s.glassNose, { n: s.fusN || 24, count: 10 }), PART.GLASS);
  if (s.glassTail) add(loft(s.glassTail, { n: 16, count: 6 }), PART.GLASS);
  if (s.blister) add(loft(s.blister, { n: 16, count: 8 }), PART.GLASS);
  if (s.waist) {
    for (const side of [-1, 1]) {
      const sec = sectionAt(fusStations, s.waist.z);
      const x = side * sec[1] * 0.93;
      add(loft([[s.waist.z - s.waist.len / 2, 0.02, 0.02, 0.02, s.waist.y, 2], [s.waist.z - s.waist.len * 0.35, 0.16, 0.3, 0.3, s.waist.y, 2], [s.waist.z + s.waist.len * 0.35, 0.16, 0.3, 0.3, s.waist.y, 2], [s.waist.z + s.waist.len / 2, 0.02, 0.02, 0.02, s.waist.y, 2]], { n: 12, xc: x }), PART.GLASS);
    }
  }

  // canopy framing as real geometry: hoops around the glazing plus the top rail
  const canopyAt = (z) => sectionAt(s.canopy, z);
  for (const z of s.frames || []) {
    const [, w, hT, , yc] = canopyAt(z);
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const a = lerp(-0.12, Math.PI + 0.12, k / 12);
      pts.push(V(Math.cos(a) * (w + 0.012), yc + Math.sin(a) * (hT + 0.012), z));
    }
    add(pathTube(pts, 0.022, 4, 0.016), PART.FUSELAGE);
  }
  if (s.frames && s.frames.length > 1) {
    const rail = [];
    const z0 = s.frames[0], z1 = s.frames[s.frames.length - 1];
    for (let k = 0; k <= 10; k++) {
      const z = lerp(z0, z1, k / 10);
      const [, , hT, , yc] = canopyAt(z);
      rail.push(V(0, yc + hT + 0.012, z));
    }
    add(pathTube(rail, 0.02, 4, 0.015), PART.FUSELAGE);
  }
  // crew: helmeted heads, headrests, gunsight
  for (const z of s.crew || []) {
    const [, , hT, , yc] = canopyAt(z);
    for (const cx of s.crewX || [0]) {
      const hy = yc + hT * 0.38;
      add(sphere(cx, hy, z, 0.115, 1, 1.08, 1.05), PART.DARK);
      add(sphere(cx, hy - 0.2, z + 0.05, 0.2, 1.1, 0.5, 0.75, 8, 5), PART.DARK);
      add(box(0.26, 0.3, 0.06, cx, hy - 0.02, z + 0.2), PART.DARK, { flat: true });
    }
  }
  if (s.crew && !s.crewX) {
    const zs = s.crew[0] - 0.55;
    const [, , hT, , yc] = canopyAt(zs);
    add(box(0.08, 0.1, 0.14, 0, yc + hT * 0.35, zs), PART.DARK, { flat: true });
  }

  if (s.mast) {
    add(strut(s.mast[0], s.mast[1], 0.06, 0.016, 6, 0.03, 0.01), PART.TAIL);
    if (s.wire) {
      const finTop = V(0, s.fin.base + s.fin.semispan * 0.92, s.fin.zLE + s.fin.semispan * s.fin.sweep + 0.25);
      add(strut(s.mast[1], finTop, 0.006, 0.006, 3), PART.DARK);
    }
  }

  // ---- engines
  const props = [], engines = [];
  let cowlZ = 0, exh = null;
  const extra = [];
  for (const e of s.engines) {
    add(cowl({ ...e }), PART.COWL);
    engineFace(e, extra);
    cowlFlaps(e, extra);
    exhausts(e, extra, e.exhausts || 4);
    cowlZ = e.zF + 0.16;
    const h = e.h || e.w;
    if (e.carb) add(loft([[e.zF + 0.02, 0.1, 0.05, 0.02, e.y + h * 0.98, 2.2], [e.zF + 0.12, 0.13, 0.09, 0.02, e.y + h * 0.98, 2.4], [e.zF + 0.7, 0.12, 0.07, 0.02, e.y + h * 0.99, 2.4], [e.zF + 0.95, 0.03, 0.01, 0.01, e.y + h * 0.99, 2]], { n: 14 }), PART.COWL);
    if (e.oil) add(loft([[e.zF + 0.35, 0.13, 0.02, 0.06, e.y - h * 0.97, 2.4], [e.zF + 0.45, 0.17, 0.02, 0.11, e.y - h * 0.97, 2.6], [e.zB + 0.1, 0.17, 0.02, 0.11, e.y - h * 0.96, 2.6], [e.zB + 0.55, 0.05, 0.02, 0.02, e.y - h * 0.92, 2]], { n: 14 }), PART.COWL);
    if (e.chin) {
      for (const side of [-1, 1]) add(loft([[e.zF + 0.05, 0.13, 0.03, 0.07, e.y - h * 0.9, 2.4], [e.zF + 0.2, 0.15, 0.03, 0.1, e.y - h * 0.92, 2.6], [e.zF + 0.9, 0.12, 0.03, 0.06, e.y - h * 0.94, 2.4], [e.zF + 1.2, 0.03, 0.01, 0.01, e.y - h * 0.9, 2]], { n: 12, xc: e.x + side * 0.24 }), PART.COWL);
    }
    if (e.nacelle) add(loft(e.nacelle, { n: 24, count: 14, xc: e.x }), PART.FUSELAGE);
    const [zt, zb, sr] = e.spinner;
    add(spinner(e.x, e.y, zt, zb, sr), PART.SPINNER);
    const pc = V(e.x, e.y, e.prop.z);
    for (const b of bladeSet(pc, e.prop.r, e.prop.blades, e.prop.chord)) add(b, PART.PROP, { flat: true });
    props.push({ center: pc, radius: e.prop.r });
    engines.push(V(e.x, e.y, (e.zF + e.zB) * 0.5 + 0.4));
    exh = { z: e.zB, y: e.y - 0.05, x: Math.abs(e.x), w: e.wB };
  }
  for (const [g, part, flat] of extra) add(g, part, { flat: !!flat });

  // ---- flying surfaces
  for (const g of wingPair(s.wing)) add(g, PART.WING);
  for (const g of wingPair(s.htail)) add(g, PART.TAIL);
  add(finSurface(s.fin, s.fin.base), PART.TAIL);
  if (s.fin2) add(finSurface(s.fin2, s.fin2.base), PART.TAIL);

  // wing root fillets blending the wing into the fuselage
  if (!s.engines[0].nacelle) {
    const r0 = wingAt(s.wing, 0.5);
    const z0 = r0.le - 0.15, z1 = r0.le + r0.c + 0.7;
    for (const side of [-1, 1]) {
      const st = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const z = lerp(z0, z1, t);
        const fs = sectionAt(fusStations, z);
        const bulge = Math.sin(Math.PI * Math.pow(t, 0.75));
        const wy = wingSurfaceY(s.wing, fs[1] * 0.9, clamp((z - r0.le) / r0.c, 0, 1));
        st.push([z, 0.05 + 0.24 * bulge, 0.03 + 0.17 * bulge, 0.05 + 0.08 * bulge, wy, 2]);
      }
      const fs = sectionAt(fusStations, (z0 + z1) / 2);
      add(loft(st, { n: 12, xc: side * fs[1] * 0.86 }), PART.FUSELAGE);
    }
  }

  // ---- details: pitot, wing guns, dive brakes, tailwheel, landing gear
  if (s.pitot) {
    const x = Math.abs(s.pitot), side = Math.sign(s.pitot);
    const w = wingAt(s.wing, x);
    add(strut(V(side * x, w.y - 0.04, w.le + 0.25), V(side * x, w.y - 0.04, w.le - 0.55), 0.014, 0.014, 5), PART.DARK);
  }
  for (const gx of s.wingGuns || []) {
    for (const side of [-1, 1]) {
      const w = wingAt(s.wing, gx);
      add(strut(V(side * gx, w.y, w.le + 0.2), V(side * gx, w.y, w.le - 0.45), 0.032, 0.032, 6), PART.DARK);
      add(strut(V(side * gx, w.y, w.le - 0.05), V(side * gx, w.y, w.le - 0.18), 0.045, 0.045, 6), PART.DARK);
    }
  }
  if (s.diveBrakes) {
    // slatted dive brakes folded under the wings ahead of the flaps
    for (const side of [-1, 1]) {
      for (const [xa, xb] of [[1.15, 2.5], [2.7, 3.95]]) {
        const xm = (xa + xb) / 2;
        const w = wingAt(s.wing, xm);
        const yb = wingSurfaceY(s.wing, xm, 0.55, -1) - 0.035;
        add(box(xb - xa, 0.025, 0.24, side * xm, yb, w.le + w.c * 0.55), PART.WING, { flat: true });
        add(box(xb - xa - 0.1, 0.012, 0.05, side * xm, yb - 0.02, w.le + w.c * 0.55), PART.DARK, { flat: true });
      }
    }
  }
  if (s.tailwheel) {
    const t = s.tailwheel;
    add(strut(V(t.x, t.y + 0.35, t.z - 0.1), V(t.x, t.y, t.z), 0.035, 0.035, 6), PART.GEAR);
    add(wheel(V(t.x, t.y - 0.08, t.z + 0.04), 0.11, 0.07, 12), PART.DARK);
  }

  let parked = null;
  if (s.gear === 'spats') {
    for (const side of [-1, 1]) {
      const x = side * 1.88;
      add(strut(V(x, -0.5, -0.28), V(x + side * 0.03, -1.55, -0.3), 0.3, 0.07, 12, 0.24, 0.06), PART.GEAR);
      add(loft([[-0.98, 0.02, 0.02, 0.02, -1.78, 2], [-0.85, 0.1, 0.14, 0.16, -1.78, 2], [-0.5, 0.19, 0.28, 0.3, -1.8, 2.1], [0.05, 0.2, 0.3, 0.31, -1.82, 2.1], [0.5, 0.14, 0.22, 0.22, -1.8, 2], [0.92, 0.03, 0.05, 0.05, -1.76, 2]], { n: 18, count: 12, xc: x + side * 0.03 }), PART.GEAR);
      add(wheel(V(x + side * 0.03, -1.86, -0.25), 0.3, 0.11, 14), PART.DARK);
    }
    add(strut(V(0, 0.15, 6.2), V(0, -0.22, 6.35), 0.04), PART.GEAR);
    add(wheel(V(0, -0.24, 6.36), 0.13, 0.08), PART.DARK);
  } else if (s.gear === 'down') {
    const main = V(1.8, -1.75, -0.3), tail = V(0, -0.85, 5.42);
    for (const side of [-1, 1]) {
      add(strut(V(side * 1.7, -0.62, 0.05), V(side * 1.78, -1.72, -0.28), 0.07, 0.07, 10), PART.GEAR);
      add(strut(V(side * 1.35, -0.6, 0.35), V(side * 1.76, -1.4, -0.2), 0.03, 0.03, 6), PART.GEAR);
      add(wheel(V(side * main.x, main.y, main.z), 0.42, 0.2), PART.DARK);
      add(wheel(V(side * (main.x + 0.02), main.y, main.z), 0.2, 0.24, 12), PART.GEAR);
      add(box(0.025, 0.95, 0.55, side * 1.86, -1.15, -0.12, -0.25, 0, 0), PART.GEAR, { flat: true });
    }
    add(strut(V(0, -0.02, 5.25), V(0, -0.8, 5.4), 0.04), PART.GEAR);
    add(wheel(tail, 0.16, 0.1), PART.DARK);
    // tail hook stowed under the rear fuselage
    add(strut(V(0, -0.02, 5.7), V(0, -0.1, 6.35), 0.025, 0.025, 5), PART.DARK);
    // resting attitude on the wheels: nose-up pitch and origin height above the deck
    const m0 = V(0, main.y - 0.42, main.z), t0 = V(0, tail.y - 0.16, tail.z);
    const pitch = Math.atan2(t0.y - m0.y, t0.z - m0.z);
    const cy = Math.cos(pitch), sy = Math.sin(pitch);
    parked = { pitch, height: -(m0.y * cy - m0.z * sy) };
  }

  // Hellcat wing guns poking out of the leading edges
  if (type === 'hellcat') {
    for (const side of [-1, 1]) {
      for (const x of [2.5, 2.72, 2.94]) {
        const w = wingAt(s.wing, x);
        add(strut(V(side * x, w.y, w.le + 0.15), V(side * x, w.y, w.le - 0.36), 0.024, 0.024, 6), PART.DARK);
      }
    }
  }

  let ordnance = null;
  if (s.ordnance) {
    const o = s.ordnance;
    ordnance = o.pos.clone();
    const pcs = ordnancePieces(o.kind);
    for (const g of pcs.smooth) add(g.clone().translate(o.pos.x, o.pos.y, o.pos.z), PART.ORDNANCE);
    for (const g of pcs.flat) add(g.clone().translate(o.pos.x, o.pos.y, o.pos.z), PART.ORDNANCE, { flat: true });
    if (o.rack !== null) {
      const len = o.kind === 'torpedo' ? 1.2 : 0.4;
      for (const dz of [-len, len]) add(strut(V(o.pos.x, o.rack, o.pos.z + dz), V(o.pos.x, o.pos.y + 0.12, o.pos.z + dz), 0.06, 0.02, 6), PART.DARK);
    }
    if (o.crutch) {
      // displacement yoke that swings the bomb clear of the propeller in the dive
      for (const side of [-1, 1]) add(strut(V(side * 0.16, o.rack + 0.05, o.pos.z - 0.7), V(side * 0.16, o.pos.y + 0.1, o.pos.z - 0.25), 0.025, 0.025, 5), PART.ORDNANCE);
      add(strut(V(-0.16, o.pos.y + 0.1, o.pos.z - 0.25), V(0.16, o.pos.y + 0.1, o.pos.z - 0.25), 0.025, 0.025, 5), PART.ORDNANCE);
    }
  }

  const geometry = mergeGeometries(out);
  geometry.computeBoundingSphere();
  let radius = 0;
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) radius = Math.max(radius, Math.hypot(p.getX(i), p.getY(i), p.getZ(i)));
  geometry.boundingSphere.center.set(0, 0, 0);
  geometry.boundingSphere.radius = radius;

  let propDisc = null;
  const discs = props.map((pr) => {
    const g = new THREE.CircleGeometry(pr.radius, 48);
    g.translate(pr.center.x, pr.center.y, pr.center.z - 0.02);
    return g;
  });
  if (discs.length) propDisc = discs.length > 1 ? mergeGeometries(discs) : discs[0];

  const w = s.livery;
  const wingMarkZ = (() => {
    const a = wingAt(s.wing, w.wingX);
    return a.le + a.c * 0.5;
  })();
  const well = (() => {
    const x = s.wing.semispan * 0.3;
    const a = wingAt(s.wing, x);
    return [x, a.le + a.c * 0.36, Math.min(0.36, a.c * 0.14)];
  })();
  const fin = [s.fin.zLE + s.fin.root * 0.38 + s.fin.semispan * s.fin.sweep * 0.35, s.fin.base + s.fin.semispan * 0.38, s.fin.semispan * 0.2];

  return {
    geometry,
    propDisc,
    props,
    engines,
    guns: s.guns.map((g) => g.clone()),
    ordnance,
    radius,
    parked,
    _shader: { props, cowlZ, wingMarkZ, livery: w, exh, well, fin, semispan: s.wing.semispan, gearDown: !!s.gear },
  };
}

const cache = {};

/** Geometry and attach points for an aircraft type. Results are cached per type (shared geometry). */
export function buildAircraft(type) {
  if (!SPECS[type]) throw new Error(`Unknown aircraft type: ${type}`);
  if (!cache[type]) cache[type] = build(type);
  const b = cache[type];
  return {
    geometry: b.geometry,
    propDisc: b.propDisc,
    props: b.props.map((p) => ({ center: p.center.clone(), radius: p.radius })),
    engines: b.engines.map((v) => v.clone()),
    guns: b.guns.map((v) => v.clone()),
    ordnance: b.ordnance ? b.ordnance.clone() : null,
    radius: b.radius,
    parked: b.parked ? { ...b.parked } : null,
  };
}

/** Bomb or torpedo on its own (forward -Z, origin at its center). */
export function buildOrdnance(kind) {
  const pcs = ordnancePieces(kind);
  const g = mergeGeometries([
    ...pcs.smooth.map((x) => finish(x.clone(), PART.ORDNANCE)),
    ...pcs.flat.map((x) => finish(x.clone(), PART.ORDNANCE, { flat: true })),
  ]);
  g.computeBoundingSphere();
  return g;
}

export function createOrdnanceMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x2b2e2a, roughness: 0.5, metalness: 0.45 });
}

// ---------------------------------------------------------------- shaders

const lin = (c) => c.map((x) => Math.pow(x, 2.2));
const f = (x) => Number(x).toFixed(4);
const v2 = (a, b) => `vec2(${f(a)}, ${f(b)})`;
const v3 = (c) => `vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;

function propConsts(sh) {
  const p0 = sh.props[0], p1 = sh.props[sh.props.length - 1];
  // twins: AC_P0 is the port (-X) engine, AC_P1 starboard
  const a = p0.center.x <= p1.center.x ? p0 : p1, b = a === p0 ? p1 : p0;
  return `
const vec2 AC_P0 = ${v2(a.center.x, a.center.y)};
const vec2 AC_P1 = ${v2(b.center.x, b.center.y)};
const float AC_PR = ${f(a.radius)};
`;
}

function liveryConsts(sh) {
  const L = sh.livery;
  const code = String(L.code || 0);
  return `
${L.us ? '#define AC_US' : '#define AC_JP'}
${L.mottle ? '#define AC_MOTTLE' : ''}
${L.betty ? '#define AC_BETTY' : ''}
${sh.gearDown ? '#define AC_GEAR_DOWN' : ''}
const vec3 AC_UPPER = ${v3(lin(L.upper))};
const vec3 AC_LOWER = ${v3(lin(L.lower))};
const vec3 AC_COWL_COL = ${v3(lin(L.cowl))};
const vec2 AC_DEMARC = ${v2(L.demarc[0], L.demarc[1])};
const vec4 AC_FUS_MARK = vec4(${f(L.fus[0])}, ${f(L.fus[1])}, ${f(L.fus[2])}, ${f(L.fus[3])});
const vec3 AC_WING_MARK = vec3(${f(L.wingX)}, ${f(sh.wingMarkZ)}, ${f(L.wingR)});
const vec2 AC_IFF = ${v2(L.iff[0], L.iff[1])};
const vec2 AC_GLASS = ${v2(L.glass[0], L.glass[1])};
const float AC_COWL_Z = ${f(sh.cowlZ)};
const vec4 AC_EXH = vec4(${f(sh.exh.z)}, ${f(sh.exh.y)}, ${f(sh.exh.x)}, ${f(sh.exh.w)});
const vec3 AC_WELL = vec3(${f(sh.well[0])}, ${f(sh.well[1])}, ${f(sh.well[2])});
const vec3 AC_FIN = vec3(${f(sh.fin[0])}, ${f(sh.fin[1])}, ${f(sh.fin[2])});
const float AC_SEMI = ${f(sh.semispan)};
const int AC_CODE_N = ${code.length};
const int AC_CODE[3] = int[3](${[0, 1, 2].map((i) => code[i] || 0).join(', ')});
`;
}

const vertexPars = /* glsl */ `
attribute float aPart;
#ifdef USE_INSTANCING
attribute vec4 aState;
#endif
uniform float uTime;
`;

// Shared by the colour and depth programs: prop spin and dropped ordnance.
const stateGLSL = /* glsl */ `
#ifdef USE_INSTANCING
  vec4 acSt = aState;
#else
  vec4 acSt = vec4(0.0, 0.0, 1.0, 0.0);
#endif
  float acPart = floor(aPart + 0.5);
  vec2 acPC = position.x > 0.0 ? AC_P1 : AC_P0;
  float acA = uTime * 38.0 + acSt.y;
  mat2 acRot = mat2(cos(acA), sin(acA), -sin(acA), cos(acA));
`;

const transformGLSL = /* glsl */ `
  if (acPart == 5.0) transformed.xy = acPC + acRot * (transformed.xy - acPC);
  if (acPart == 8.0) transformed *= step(0.5, acSt.z);
`;

const fragmentPars = /* glsl */ `
uniform float uTime;
varying vec3 vAcPos;
varying vec3 vAcNrm;
varying float vAcPart;
varying vec4 vAcState;
varying vec2 vAcSurf;

float acHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float acNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(acHash(i), acHash(i + vec2(1.0, 0.0)), u.x), mix(acHash(i + vec2(0.0, 1.0)), acHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 acLin(vec3 c) { return pow(c, vec3(2.2)); }
// thin lines every 'spacing' metres, faded out before they alias
float acLine(float v, float spacing, float width) {
  float d = abs(fract(v / spacing) - 0.5) * spacing;
  float aa = fwidth(v) + 1e-5;
  return (1.0 - smoothstep(width, width + aa, d)) * (1.0 - smoothstep(0.008, 0.03, aa));
}
// a line at value 'at' about one pixel wide
float acAt(float v, float at) {
  float aa = fwidth(v) + 1e-6;
  return 1.0 - smoothstep(0.6 * aa, 1.6 * aa, abs(v - at));
}
// canopy frames: thicker, so they survive to a longer range
float acFrame(float v, float spacing, float width) {
  float d = abs(fract(v / spacing) - 0.5) * spacing;
  float aa = fwidth(v) + 1e-5;
  return (1.0 - smoothstep(width, width + aa, d)) * (1.0 - smoothstep(0.03, 0.09, aa));
}
float acDisc(vec2 p, float r) {
  float d = length(p);
  return 1.0 - smoothstep(r, r + fwidth(d) + 1e-4, d);
}
// outline (one pixel inside) and fill of a rectangle in surface coordinates
vec2 acRect(vec2 p, vec2 lo, vec2 hi) {
  vec2 aa = fwidth(p) + 1e-6;
  vec2 a = (p - lo) / aa, b = (hi - p) / aa;
  float d = min(min(a.x, a.y), min(b.x, b.y));
  float inside = step(0.0, d);
  return vec2(inside * (1.0 - smoothstep(0.5, 1.5, d)), inside);
}
float acStar(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
// US star and bars: x = blue mask, y = white mask
vec2 acInsignia(vec2 p, float r) {
  float aa = fwidth(p.x) * 1.5 + 1e-4;
  float circ = 1.0 - smoothstep(r, r + aa, length(p));
  vec2 q = abs(p);
  float bh = r * 0.36, bl = r * 2.0, b = r * 0.12;
  float barW = (1.0 - smoothstep(bh, bh + aa, q.y)) * (1.0 - smoothstep(bl, bl + aa, q.x));
  float barB = (1.0 - smoothstep(bh + b, bh + b + aa, q.y)) * (1.0 - smoothstep(bl + b, bl + b + aa, q.x));
  float star = 1.0 - smoothstep(0.0, aa, acStar(p, r * 0.96, 0.38));
  return vec2(max(circ, barB), max(star * circ, barW * (1.0 - circ)));
}
// seven-segment style stencil digits (tail codes, side numbers); p in 0..1 x 0..1.6
float acSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float acDigit(vec2 p, int d, float aa) {
  const int M[10] = int[10](119, 36, 93, 109, 46, 107, 123, 37, 127, 111);
  int m = M[d];
  float s = 1e3;
  if ((m & 1) != 0) s = min(s, acSeg(p, vec2(0.17, 1.5), vec2(0.83, 1.5)));
  if ((m & 2) != 0) s = min(s, acSeg(p, vec2(0.17, 0.8), vec2(0.17, 1.5)));
  if ((m & 4) != 0) s = min(s, acSeg(p, vec2(0.83, 0.8), vec2(0.83, 1.5)));
  if ((m & 8) != 0) s = min(s, acSeg(p, vec2(0.17, 0.8), vec2(0.83, 0.8)));
  if ((m & 16) != 0) s = min(s, acSeg(p, vec2(0.17, 0.1), vec2(0.17, 0.8)));
  if ((m & 32) != 0) s = min(s, acSeg(p, vec2(0.83, 0.1), vec2(0.83, 0.8)));
  if ((m & 64) != 0) s = min(s, acSeg(p, vec2(0.17, 0.1), vec2(0.83, 0.1)));
  return 1.0 - smoothstep(0.13, 0.13 + aa, s);
}
// up to three digits centred at the origin, digit height h
float acNumber(vec2 p, float h) {
  float w = h * 0.68;
  vec2 q = vec2(p.x / w + float(AC_CODE_N) * 0.5 * 1.3, p.y / (h / 1.6) + 0.8);
  // anti-aliasing width from the continuous coordinate, not the per-cell one
  float aa = length(fwidth(q)) * 0.8 + 1e-4;
  float k = floor(q.x / 1.3);
  if (k < 0.0 || k >= float(AC_CODE_N) || q.y < -0.1 || q.y > 1.7) return 0.0;
  int idx = int(k);
  int d = idx == 0 ? AC_CODE[0] : idx == 1 ? AC_CODE[1] : AC_CODE[2];
  return acDigit(vec2(q.x - k * 1.3, q.y), d, aa) * (1.0 - smoothstep(0.25, 0.6, aa));
}
`;

const liveryGLSL = /* glsl */ `
  vec3 acP = vAcPos;
  vec3 acN = normalize(vAcNrm);
  float acPt = floor(vAcPart + 0.5);
  vec4 acS = vAcState;
  vec2 acSf = vAcSurf;
  bool acLift = acSf.y >= 0.0 && (acPt == 1.0 || acPt == 2.0);
  bool acFinSurf = acPt == 2.0 && abs(acN.x) > 0.6;
  float acPx = length(fwidth(acP));                       // metres per pixel here
  float acNear = 1.0 - smoothstep(0.012, 0.045, acPx);     // panel detail fades with range
  float acClose = 1.0 - smoothstep(0.004, 0.012, acPx);    // rivets only up close
  float acRough = 0.62;
  float acMetal = 0.12;
  vec3 acEmis = vec3(0.0);
  float acN1 = acNoise(acP.xz * 2.3 + acP.y * 1.7);
  float acN2 = acNoise(acP.xz * 0.45 + acP.y * 0.3 + 3.1);

  // camouflage: upper surfaces vs undersides
  float acUp;
  if (acPt == 0.0) {
    float dy = AC_DEMARC.x + AC_DEMARC.y * acP.z + 0.05 * sin(acP.z * 2.6) + 0.025 * sin(acP.z * 6.3 + 1.3);
    acUp = smoothstep(dy - 0.05, dy + 0.05, acP.y);
  } else {
    acUp = smoothstep(-0.25, 0.25, acN.y);
    if (acFinSurf) acUp = 1.0;
  }
  vec3 acUpper = AC_UPPER;
#ifdef AC_MOTTLE
  float acMot = smoothstep(0.5, 0.6, acNoise(acP.xz * 0.6 + 7.0) * 0.65 + acNoise(acP.xz * 1.9 + acP.y) * 0.35);
  acUpper *= mix(vec3(1.0), vec3(0.58, 0.68, 0.6), acMot);
#endif
#ifdef AC_JP
  // sun-bleached, patchy field paint on top
  acUpper *= mix(vec3(0.9, 0.93, 0.9), vec3(1.18, 1.12, 1.02), acN2 * acUp);
#endif
  vec3 acCol = mix(AC_LOWER, acUpper, acUp);
  acCol *= 0.9 + 0.2 * acN1;
#ifdef AC_US
  acRough = 0.3;
  acMetal = 0.22;
#endif

  // panel lines and rivets
  float acPanel = 0.0, acRivet = 0.0;
  if (acPt == 0.0) {
    acPanel = acLine(acP.z, 0.62, 0.005);
    acPanel = max(acPanel, acLine(acP.y + 0.08, 0.55, 0.004) * 0.6);
    acRivet = acLine(acP.z + 0.31, 0.62, 0.006) * step(0.5, fract(acP.y * 22.0));
  } else if (acLift) {
    float span = acFinSurf ? acP.y : acP.x;
    acPanel = max(acLine(span, 0.7, 0.005), max(acAt(acSf.y, 0.22), acAt(acSf.y, 0.6)) * 0.8);
    acRivet = acLine(span + 0.35, 0.7, 0.006) * step(0.5, fract(acP.z * 22.0));
  }
  acCol *= 1.0 - acPanel * 0.3 * acNear;
  acCol *= 1.0 - acRivet * 0.12 * acClose;

  // control surfaces: hinge and edge lines, fabric covering with rib tapes, trim tabs
  if (acLift) {
    vec2 ctl = vec2(0.0);
    vec2 fabric = vec2(0.0);
    if (acPt == 1.0) {
      vec2 ail = acRect(acSf, vec2(0.58, 0.74), vec2(0.93, 1.01));
      vec2 flap = acRect(acSf, vec2(0.08, 0.78), vec2(0.56, 1.01));
      ctl = max(ail, flap);
      fabric = ail;
      vec2 tab = acRect(acSf, vec2(0.6, 0.9), vec2(0.68, 1.01));
      ctl.x = max(ctl.x, tab.x);
    } else {
      fabric = acRect(acSf, vec2(0.04, 0.64), vec2(0.97, 1.01));
      ctl = fabric;
      vec2 tab = acRect(acSf, vec2(0.12, 0.88), vec2(0.34, 1.01));
      ctl.x = max(ctl.x, tab.x);
    }
    acCol *= 1.0 - ctl.x * 0.45;
#ifdef AC_JP
    float span = acFinSurf ? acP.y : acP.x;
    acCol *= mix(1.0, 0.94 + 0.08 * acLine(span, 0.24, 0.02), fabric.y);
    acRough = mix(acRough, 0.78, fabric.y);
#endif
  }

  vec3 acBare = vec3(0.2, 0.21, 0.22);
#ifdef AC_JP
  vec3 acRed = acLin(vec3(0.62, 0.07, 0.07));
  vec3 acWhite = acLin(vec3(0.86, 0.86, 0.82));
  if (acPt == 0.0) {
    vec2 q = vec2(acP.z - AC_FUS_MARK.x, acP.y - AC_FUS_MARK.y);
    float side = smoothstep(0.22, 0.42, abs(acN.x));
    acCol = mix(acCol, acWhite, acDisc(q, AC_FUS_MARK.z + AC_FUS_MARK.w) * side);
    acCol = mix(acCol, acRed, acDisc(q, AC_FUS_MARK.z) * side);
  }
  if (acPt == 1.0) {
    vec2 q = vec2(abs(acP.x) - AC_WING_MARK.x, acP.z - AC_WING_MARK.y);
    // upper wing roundels get a thin field-applied white outline
    acCol = mix(acCol, acWhite, acDisc(q, AC_WING_MARK.z + 0.05) * step(0.0, acN.y));
    acCol = mix(acCol, acRed, acDisc(q, AC_WING_MARK.z));
    // IFF yellow on the inboard leading edges, upper and lower
    float iff = step(AC_IFF.x, acSf.x) * step(acSf.x, AC_IFF.y) * (1.0 - smoothstep(0.1, 0.12, acSf.y));
    acCol = mix(acCol, acLin(vec3(0.86, 0.6, 0.12)), iff);
#ifndef AC_GEAR_DOWN
    // retracted main gear: wheel well doors outlined under the wing
    if (acN.y < -0.2) {
      vec2 wq = vec2(abs(acP.x) - AC_WELL.x, acP.z - AC_WELL.y);
      float ring = acAt(length(wq), AC_WELL.z);
      float leg = acRect(vec2(abs(acP.x), acP.z), vec2(0.35, AC_WELL.y - 0.22), vec2(AC_WELL.x, AC_WELL.y + 0.22)).x;
      acCol *= 1.0 - max(ring, leg) * 0.5 * acNear;
    }
#endif
  }
  // tail code on the fin
  if (acFinSurf) {
    float num = acNumber(vec2((acP.z - AC_FIN.x) * sign(acN.x) * -1.0, acP.y - AC_FIN.y), AC_FIN.z);
    acCol = mix(acCol, acWhite * vec3(1.0, 0.98, 0.9), num);
  }
  // worn paint showing bare aluminium: leading edges, wing roots and walkways, cowl ring, cockpit sill
  {
    float zone = 0.0;
    if (acLift) zone = (1.0 - smoothstep(0.02, 0.1, acSf.y)) * 0.6 + (acPt == 1.0 ? (1.0 - smoothstep(0.06, 0.2, acSf.x)) * acUp * 0.7 : 0.0);
    else if (acPt == 0.0) zone = 0.04 + (1.0 - smoothstep(0.3, 0.9, abs(acP.z - 0.1))) * acUp * 0.2;
    else if (acPt == 3.0) zone = 0.2 * (1.0 - smoothstep(0.0, 0.2, acP.z - AC_COWL_Z));
    float cn = acNoise(acP.xz * 11.0 + acP.y * 7.0) * 0.6 + acNoise(acP.zy * 29.0 + acP.x * 13.0) * 0.4;
    float chip = smoothstep(0.84 - zone * 0.3, 0.86 - zone * 0.3, cn) * step(0.01, zone);
    acCol = mix(acCol, acBare, chip);
    acRough = mix(acRough, 0.45, chip);
    acMetal = mix(acMetal, 0.65, chip);
  }
#endif

#ifdef AC_US
  vec3 acInsBlue = acLin(vec3(0.1, 0.15, 0.32));
  vec3 acInsWhite = acLin(vec3(0.88, 0.88, 0.86));
  if (acPt == 0.0 && abs(acN.x) > 0.45) {
    vec2 ins = acInsignia(vec2(acP.z - AC_FUS_MARK.x, acP.y - AC_FUS_MARK.y), AC_FUS_MARK.z);
    acCol = mix(acCol, acInsBlue, ins.x);
    acCol = mix(acCol, acInsWhite, ins.y);
  }
  if (acPt == 1.0 && ((acP.x < 0.0 && acN.y > 0.0) || (acP.x > 0.0 && acN.y < 0.0))) {
    vec2 ins = acInsignia(vec2(abs(acP.x) - AC_WING_MARK.x, -(acP.z - AC_WING_MARK.y)), AC_WING_MARK.z);
    acCol = mix(acCol, acInsBlue, ins.x);
    acCol = mix(acCol, acInsWhite, ins.y);
  }
  // wing fold line and anti-glare panel
  if (acPt == 1.0) acCol *= 1.0 - acAt(abs(acP.x), 2.55) * 0.5 * acNear;
#endif

  // exhaust soot streaming back from the stacks, oil weeping along the belly
  if ((acPt == 0.0 || acPt == 3.0) && acP.z > AC_EXH.x - 0.15) {
    float ez = acP.z - AC_EXH.x;
    float lat = abs(abs(acP.x) - AC_EXH.z);
    float sideK = smoothstep(AC_EXH.w * 0.25, AC_EXH.w * 0.55, lat) * (1.0 - smoothstep(AC_EXH.w * 1.2, AC_EXH.w * 1.5, lat));
    float band = 1.0 - smoothstep(0.1, 0.32 + ez * 0.1, abs(acP.y - (AC_EXH.y - ez * 0.05)));
    float streak = acNoise(vec2(acP.z * 1.3, acP.y * 24.0)) * 0.55 + 0.45;
    float soot = band * sideK * (1.0 - smoothstep(0.0, 2.6, ez)) * streak;
    acCol = mix(acCol, vec3(0.018, 0.016, 0.014), soot * 0.8);
    acRough = mix(acRough, 0.9, soot);
    if (acN.y < -0.3) {
      float oil = smoothstep(0.7, 0.9, acNoise(vec2(acP.x * 16.0, acP.z * 0.5))) * (1.0 - smoothstep(0.0, 3.2, ez));
      acCol = mix(acCol, acLin(vec3(0.12, 0.08, 0.04)), oil * 0.65);
      acRough = mix(acRough, 0.25, oil);
    }
  }

  if (acPt == 3.0) {
    acCol = AC_COWL_COL * (0.85 + 0.3 * acN1);
    acRough = 0.42;
    acMetal = 0.3;
#ifdef AC_JP
    // bluish-black cowl paint rubbed to metal on the lip
    float lip = 1.0 - smoothstep(0.0, 0.08, acP.z - AC_COWL_Z + 0.16);
    float cn2 = acNoise(acP.xy * 30.0 + acP.z);
    acCol = mix(acCol, acBare, smoothstep(0.8, 0.84, cn2) * lip);
#endif
#ifdef AC_US
    float num = acNumber(vec2((acP.z + 2.75) * -sign(acN.x), acP.y + 0.05), 0.4) * step(0.5, abs(acN.x));
    acCol = mix(acCol, acLin(vec3(0.88, 0.88, 0.86)), num);
#endif
  } else if (acPt == 4.0) {
    // canopy glass with painted frames; the cockpit is dark behind it
    // hoops and the top rail are real geometry; far away the centre line keeps the framing visible
    float fr = (1.0 - smoothstep(0.02, 0.03, abs(acP.x))) * (1.0 - acNear * 0.7);
    fr = max(fr, 1.0 - smoothstep(0.018, 0.028, abs(acP.y - AC_GLASS.y)));
#ifdef AC_BETTY
    if (acP.z < -5.9 || acP.z > 11.3 || abs(acP.z - 2.6) < 1.1 || abs(acP.z - 6.4) < 0.6) fr = max(fr, max(acFrame(acP.y, 0.28, 0.014), acFrame(acP.x, 0.3, 0.014)));
#endif
    acCol = mix(vec3(0.012, 0.018, 0.026), acUpper, fr);
    acRough = mix(0.03, 0.6, fr);
    acMetal = 0.0;
  } else if (acPt == 5.0) {
    vec2 pc = acP.x > 0.0 ? AC_P1 : AC_P0;
    float rr = length(acP.xy - pc);
#ifdef AC_US
    acCol = mix(vec3(0.012), acLin(vec3(0.85, 0.65, 0.1)), smoothstep(AC_PR - 0.17, AC_PR - 0.16, rr));
#else
    // brown blades with the two thin yellow warning bands at the tips
    float tip = smoothstep(AC_PR - 0.21, AC_PR - 0.2, rr) - smoothstep(AC_PR - 0.15, AC_PR - 0.14, rr) + smoothstep(AC_PR - 0.09, AC_PR - 0.08, rr);
    acCol = mix(acLin(vec3(0.26, 0.17, 0.1)), acLin(vec3(0.88, 0.62, 0.12)), clamp(tip, 0.0, 1.0));
#endif
    acRough = 0.5;
    acMetal = 0.2;
  } else if (acPt == 6.0) {
#ifdef AC_US
    acCol = AC_UPPER;
#else
    acCol = acLin(vec3(0.34, 0.22, 0.15));
#endif
    acRough = 0.4;
    acMetal = 0.35;
  } else if (acPt == 7.0) {
    // gear legs and spats in the underside colour
    acCol = AC_LOWER * (0.85 + 0.2 * acN1);
    acRough = 0.55;
  } else if (acPt == 8.0) {
    acCol = acLin(vec3(0.2, 0.21, 0.2)) * (0.85 + 0.3 * acN1);
    acRough = 0.45;
    acMetal = 0.45;
  } else if (acPt == 9.0) {
    // engines, guns, tyres, crew: dark metal with a little sheen
    acCol = vec3(0.035, 0.034, 0.033) * (0.8 + 0.4 * acN1);
    acRough = 0.55;
    acMetal = 0.5;
  }

  // battle damage: soot and scorch spreading over the airframe
  if (acS.x > 0.001) {
    float soot = acNoise(vec2(acP.x * 3.5 + acP.y * 2.0, acP.z * 0.4)) * 0.6 + acNoise(acP.xz * 1.6 + acP.y * 1.3) * 0.4;
    float burn = smoothstep(1.0 - acS.x, 1.2 - acS.x, soot + acS.x * 0.25);
    acCol = mix(acCol, vec3(0.01, 0.009, 0.008), burn * 0.94);
    acRough = mix(acRough, 0.95, burn);
    acMetal = mix(acMetal, 0.0, burn);
  }
  // hit flash: sparks dancing over the skin
  if (acS.w > 0.001) {
    float sp = step(0.8, acHash(floor(acP.xz * 3.0 + acP.y * 2.0) + floor(uTime * 24.0)));
    acEmis += vec3(1.0, 0.55, 0.22) * acS.w * (0.25 + 8.0 * sp);
  }
  diffuseColor.rgb = acCol;
`;

/** Instanced-ready material with procedural livery. Per-instance attribute aState: x damage, y prop phase, z ordnance attached, w hit flash. */
export function createAircraftMaterial(type) {
  const sh = (cache[type] || (cache[type] = build(type)))._shader;
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  mat.name = `aircraft-${type}`;
  patchMaterial(mat, `aircraft-${type}`, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${vertexPars}
${propConsts(sh)}
attribute vec2 aSurf;
varying vec3 vAcPos;
varying vec3 vAcNrm;
varying float vAcPart;
varying vec4 vAcState;
varying vec2 vAcSurf;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
${stateGLSL}
  if (acPart == 5.0) objectNormal.xy = acRot * objectNormal.xy;
  vAcNrm = objectNormal;
  vAcPart = acPart;
  vAcState = acSt;
  vAcPos = position;
  vAcSurf = aSurf;`
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${transformGLSL}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${propConsts(sh)}\n${liveryConsts(sh)}\n${fragmentPars}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${liveryGLSL}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor *= acRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = acMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += acEmis;');
  });
  return mat;
}

/** Shadow-pass material matching the colour material's vertex changes (spinning props, released ordnance). Set as mesh.customDepthMaterial. */
export function createAircraftDepthMaterial(type) {
  const sh = (cache[type] || (cache[type] = build(type)))._shader;
  const mat = new THREE.MeshDepthMaterial();
  patchMaterial(mat, `aircraft-depth-${type}`, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}\n${propConsts(sh)}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${stateGLSL}\n${transformGLSL}`);
  });
  return mat;
}

let discTexture = null;

/** Faint blurred-propeller disc (yellow tip ring) for the propDisc geometry. */
export function createPropDiscMaterial() {
  if (!discTexture) {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = ((x + 0.5) / size) * 2 - 1, dy = ((y + 0.5) / size) * 2 - 1;
        const r = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        const i = (y * size + x) * 4;
        if (r > 1 || r < 0.1) {
          img.data[i + 3] = 0;
          continue;
        }
        const tip = (r > 0.86 && r < 0.9) || (r > 0.93 && r < 0.96) ? 1 : 0;
        // three blades smeared into soft arcs
        const streak = 0.5 + 0.5 * Math.sin(ang * 3 + r * 7);
        let a = (0.07 + 0.06 * streak * (1 - r * 0.6) + 0.04 * tip) * THREE.MathUtils.smoothstep(r, 0.1, 0.25);
        a *= 1 - THREE.MathUtils.smoothstep(r, 0.96, 1.0);
        img.data[i] = tip ? 130 : 30;
        img.data[i + 1] = tip ? 105 : 28;
        img.data[i + 2] = tip ? 40 : 26;
        img.data[i + 3] = Math.round(Math.min(a, 0.18) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    discTexture = new THREE.CanvasTexture(c);
    discTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.MeshBasicMaterial({ map: discTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
}
