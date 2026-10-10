import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../shaderlib.js';
import { mulberry32, smoothstep, lerp } from '../noise.js';

// Procedural US Navy warships of mid-1944: lofted hulls, superstructure, main
// battery turrets and fittings, merged into one mesh per material.
// Ship space: origin midships on the design waterline, bow -Z, starboard +X.
// Rotating gun mounts are drawn elsewhere (instanced); a ship provides their
// foundations (barbettes, gun tubs) and lists them in `mounts`.

export const SHIP_CLASSES = {
  bb: { name: 'South Dakota class battleship', length: 207, beam: 33, draft: 10.7 },
  cv: { name: 'Essex class carrier', length: 266, beam: 28, draft: 8.7 },
  cl: { name: 'Cleveland class light cruiser', length: 186, beam: 20, draft: 7.5 },
  dd: { name: 'Fletcher class destroyer', length: 115, beam: 12, draft: 4.2 },
};

const PI = Math.PI;
const HALF = PI / 2;
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const STBD = (w = 1.75) => [-HALF - w, -HALF + w];
const PORT = (w = 1.75) => [HALF - w, HALF + w];
const FWD = (w = 2.5) => [-w, w];
const AFT = (w = 2.5) => [PI - w, PI + w];
const sideArc = (x, w) => (x >= 0 ? STBD(w) : PORT(w));
const sideTrain = (x) => (x >= 0 ? -HALF : HALF);
const span = (s, a, b) => (s > 0 ? [a, b] : [-b, -a]); // x range a..b mirrored to side s

// paint chips (sRGB, converted to linear by THREE.Color)
const PAINT = {
  navy: new THREE.Color(0x3e4855), // Navy Blue 5-N
  haze: new THREE.Color(0x8a929a), // Haze Gray 5-H
  ocean: new THREE.Color(0x66707a), // Ocean Gray 5-O
  light: new THREE.Color(0xaab0b4), // Light Gray 5-L
  black: new THREE.Color(0x26272a), // Dull Black BK
  deck: new THREE.Color(0x3a414b), // Deck Blue 20-B
  boot: new THREE.Color(0x161616),
  red: new THREE.Color(0x6a2f26),
  rust: new THREE.Color(0x6e4128),
  teak: new THREE.Color(0xa08c70),
  stain: new THREE.Color(0x48515d), // flight deck stain No. 21
};
const WHITE = new THREE.Color(1, 1, 1);
const DARK = new THREE.Color(0x0b0c0d);
const GLASS = new THREE.Color(0x10161c);
const STEEL = new THREE.Color(0x2c2f33);
const CANVAS = new THREE.Color(0x8c897d);
const RAFT = new THREE.Color(0x7c8188);
const CHAIN = new THREE.Color(0x231f1c);
const BRASS = new THREE.Color(0xb08a3c);
const RUBBER = new THREE.Color(0x1a1a1a);
const NAV_RED = new THREE.Color(0x8a1410);
const NAV_GREEN = new THREE.Color(0x1d6a2a);
const SEA_BLUE = new THREE.Color(0x3a4b63); // OS2U upper surfaces
const UNDER_WHITE = new THREE.Color(0xc4c7c2);
const FLAG_RED = new THREE.Color(0x8f1d22);
const FLAG_BLUE = new THREE.Color(0x1d2a52);
const SHADE = new THREE.Color(0.74, 0.74, 0.74); // darker shade of the scheme color
const TINT = new THREE.Color(0.9, 0.9, 0.9);

// ---------------------------------------------------------------- hull lofting

const M1 = 12; // section points from the keel to the waterline
const M2 = 9; // waterline to deck edge
const STATIONS = 120;

class Hull {
  constructor(p) {
    Object.assign(this, { knuckle: 0, bulb: 0 }, p);
    this.us = [];
    for (let i = 0; i < STATIONS; i++) this.us.push(0.5 - 0.5 * Math.cos((PI * i) / (STATIONS - 1)));
  }
  z(u) {
    return -this.L / 2 + u * this.L;
  }
  u(z) {
    return (z + this.L / 2) / this.L;
  }
  // deck edge height: sheer rising toward the bow
  deckH(u) {
    let h = this.dMid;
    if (u < 0.45) h += (this.dBow - this.dMid) * (1 - u / 0.45) ** 2;
    return h + (this.dStern - this.dMid) * smoothstep(0.6, 1, u);
  }
  // raked stem with a curved forefoot, cruiser stern lifting clear of the water
  keelY(u) {
    let y = -this.T;
    if (u < this.stemU) y = lerp(this.deckH(0) - 0.01, -this.T, Math.pow(u / this.stemU, 0.7));
    if (u > this.sternU) y = lerp(y, this.sternY, Math.pow(smoothstep(this.sternU, 1, u), 1.3));
    return y;
  }
  wlHB(u) {
    let w = this.B / 2;
    if (u < this.fb) w *= Math.sin((u / this.fb) * HALF);
    if (u > 1 - this.fs) w *= Math.sqrt(Math.max(0, 1 - ((u - 1 + this.fs) / this.fs) ** 2));
    return w;
  }
  // the deck outline is fuller than the waterline: flare forward, round overhang aft
  deckHB(u) {
    let w = this.B / 2;
    if (u < this.fbd) w *= Math.pow(Math.sin((u / this.fbd) * HALF), 0.7);
    if (u > 1 - this.fsd) w *= Math.sqrt(Math.max(0, 1 - ((u - 1 + this.fsd) / this.fsd) ** 2));
    return w;
  }
  nSec(u) {
    let n = lerp(this.nBow, this.nMid, smoothstep(0, 0.3, u));
    return lerp(n, this.nStern, smoothstep(0.7, 1, u));
  }
  // starboard half section from the keel center up to the deck edge
  section(u) {
    const yD = this.deckH(u), wD = this.deckHB(u), yK = this.keelY(u);
    const pts = [];
    let sx = 0, sy = yK;
    if (yK < 0) {
      // superellipse: U-shaped amidships, V-shaped at the bow, with an optional forefoot bulb
      const wW = this.wlHB(u), b = -yK, e = 2 / this.nSec(u);
      const bulbK = this.bulb * Math.exp(-(((u - 0.028) / 0.032) ** 2));
      for (let i = 0; i < M1; i++) {
        const a = (i / (M1 - 1)) * HALF;
        const y = -b * Math.pow(Math.cos(a), e);
        let x = wW * Math.pow(Math.sin(a), e);
        if (bulbK > 1e-3) x += bulbK * Math.exp(-((y / this.T + 0.62) ** 2) / 0.06) * Math.sin(a);
        pts.push([x, y]);
      }
      sx = pts[M1 - 1][0];
      sy = 0;
    } else {
      for (let i = 0; i < M1; i++) pts.push([0, yK]);
    }
    // above the waterline: flare, and on some bows a knuckle where the flare stops
    const kn = this.knuckle * (1 - smoothstep(0.22, 0.4, u));
    for (let j = 1; j <= M2; j++) {
      const t = j / M2;
      const smooth = sx + (wD - sx) * Math.pow(t, 1.6);
      const tk = 0.45;
      const sharp = t < tk ? sx + (wD - sx) * 0.92 * Math.pow(t / tk, 1.3) : sx + (wD - sx) * (0.92 + 0.08 * ((t - tk) / (1 - tk)));
      pts.push([lerp(smooth, sharp, kn), sy + (yD - sy) * t]);
    }
    return pts;
  }
  halfWidthAt(u, y) {
    const s = this.section(u);
    for (let j = 0; j < s.length - 1; j++) {
      const [x0, y0] = s[j], [x1, y1] = s[j + 1];
      if (y1 > y0 && y >= y0 && y <= y1) return lerp(x0, x1, (y - y0) / (y1 - y0));
    }
    return s[s.length - 1][0];
  }
  deckY(z, x = 0) {
    const u = THREE.MathUtils.clamp(this.u(z), 0, 1);
    const w = this.deckHB(u);
    const k = w > 0.01 ? 1 - Math.min((x / w) ** 2, 1) : 0;
    return this.deckH(u) + this.camber * k;
  }
  // highest / lowest deck point under a round footprint (for mounts on the sheer)
  deckMax(z, x, r) {
    let m = -Infinity;
    for (const dz of [-r, 0, r]) for (const dx of [-r, 0, r]) m = Math.max(m, this.deckY(z + dz, x + dx));
    return m;
  }
  deckMin(z, x, r) {
    let m = Infinity;
    for (const dz of [-r, 0, r]) for (const dx of [-r, 0, r]) m = Math.min(m, this.deckY(z + dz, x + dx));
    return m;
  }
  halfBeamAt(z) {
    const u = this.u(z);
    if (u <= 0 || u >= 1 || this.keelY(u) >= 0) return 0;
    return this.wlHB(u);
  }

  hullGeometry() {
    const M = M1 + M2;
    const pos = [], idx = [];
    for (const s of [1, -1]) {
      const base = pos.length / 3;
      for (const u of this.us) {
        const z = this.z(u);
        for (const [x, y] of this.section(u)) pos.push(s * x, y, z);
      }
      for (let i = 0; i < STATIONS - 1; i++) {
        for (let j = 0; j < M - 1; j++) {
          const a = base + i * M + j, b = a + M, c = b + 1, d = a + 1;
          if (s > 0) idx.push(a, c, b, a, d, c);
          else idx.push(a, b, c, a, c, d);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // collapsed points (stem, stern) only touch degenerate faces; keep their normals valid anyway
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) if (n.getX(i) === 0 && n.getY(i) === 0 && n.getZ(i) === 0) n.setXYZ(i, 0, 1, 0);
    return g;
  }

  deckGeometry(K = 12) {
    const pos = [], uv = [], idx = [];
    for (const u of this.us) {
      const z = this.z(u), w = this.deckHB(u), yD = this.deckH(u);
      for (let k = 0; k <= K; k++) {
        const t = (2 * k) / K - 1;
        const x = w * t;
        pos.push(x, yD + this.camber * (1 - t * t), z);
        uv.push(x / 4, z / 16);
      }
    }
    for (let i = 0; i < STATIONS - 1; i++) {
      for (let k = 0; k < K; k++) {
        const a = i * (K + 1) + k, b = a + K + 1, c = b + 1, d = a + 1;
        idx.push(a, b, c, a, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
}

// ---------------------------------------------------------------- geometry helpers

function rrect(x0, x1, z0, z1, c = 0) {
  if (c <= 0) return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  return [[x0 + c, z0], [x1 - c, z0], [x1, z0 + c], [x1, z1 - c], [x1 - c, z1], [x0 + c, z1], [x0, z1 - c], [x0, z0 + c]];
}

// order a convex outline so side faces point outward and the cap points up
function orient(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area > 0;
}

/** Vertical prism between a bottom and a top outline (same vertex count), flat shaded. */
function prismGeo(pb, pt, y0, y1, { top = true, bottom = false } = {}) {
  pt = pt || pb;
  if (orient(pb)) {
    pb = [...pb].reverse();
    pt = [...pt].reverse();
  }
  const pos = [];
  const v = (p, y) => pos.push(p[0], y, p[1]);
  const n = pb.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    v(pb[i], y0); v(pb[j], y0); v(pt[j], y1);
    v(pb[i], y0); v(pt[j], y1); v(pt[i], y1);
  }
  const centroid = (ps) => ps.reduce((c, p) => [c[0] + p[0] / ps.length, c[1] + p[1] / ps.length], [0, 0]);
  if (top) {
    const c = centroid(pt);
    for (let i = 0; i < n; i++) {
      v(c, y1); v(pt[i], y1); v(pt[(i + 1) % n], y1);
    }
  }
  if (bottom) {
    const c = centroid(pb);
    for (let i = 0; i < n; i++) {
      v(c, y0); v(pb[(i + 1) % n], y0); v(pb[i], y0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function flip(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

/** Open surfaces (dishes, shields) seen from both sides with the single-sided paint. */
function twoSided(g) {
  const back = flip(g.clone());
  return mergeGeometries([g.toNonIndexed(), back.toNonIndexed()]);
}

// foundation sizes per mount kind: radius, height, type
const FOUNDATION = {
  '5in-twin': [2.9, 0.55, 'barbette'],
  '5in-single': [2.2, 0.4, 'barbette'],
  '40mm-quad': [3.0, 1.25, 'tub'],
  '40mm-twin': [2.2, 1.15, 'tub'],
  '20mm': [1.3, 0.95, 'tub'],
  '20mm-twin': [2.0, 1.1, 'tub'],
  // player stations: just outside and below the detailed tub of the player's gun, which hides them
  'station-40mm-quad': [3.31, 1.27, 'tub', -0.08],
  'station-20mm-twin': [1.98, 1.07, 'tub', -0.08],
  'station-20mm': [1.39, 1.03, 'tub', -0.08],
};

const MAT_ID = { brass: 2, glass: 3 };

class Parts {
  constructor(hull) {
    this.hull = hull;
    this.paint = [];
    this.deck = [];
    this.rail = [];
    this.boxes = [];
    this.mounts = [];
    this.stations = [];
    // every AA mount can be manned by the player: 40mm and 20mm sit on the station foundations
    // sized to hide under the detailed player guns
    this.playable = false;
    this.funnels = [];
    this.parking = [];
    this.floors = []; // flat roofs and platforms (for placing deck furniture)
    this.occupied = []; // round footprints already taken: { x, y, z, r }
  }

  /**
   * Geometry into the main merged mesh. Painted in the ship's scheme by default;
   * `color` gives an explicit color (paint: 1 keeps the scheme and tints it),
   * `mat` 'brass' or 'glass' switches the surface response.
   */
  add(geo, o = {}) {
    if (o.m) geo.applyMatrix4(o.m);
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    const c = o.color || WHITE;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 3) {
      col[i] = c.r;
      col[i + 1] = c.g;
      col[i + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const id = o.mat ? MAT_ID[o.mat] : o.paint ?? (o.color ? 0 : 1);
    g.setAttribute('aPaint', new THREE.BufferAttribute(new Float32Array(n).fill(id), 1));
    this.paint.push(g);
    if (o.solid) {
      g.computeBoundingBox();
      this.boxes.push({ min: g.boundingBox.min.clone(), max: g.boundingBox.max.clone() });
    }
    return g;
  }

  box(x0, x1, y0, y1, z0, z1, o = {}) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return this.add(g, o);
  }

  /** Deckhouse block with chamfered corners; `taper` insets the top outline. Its roof becomes a floor. */
  block(x0, x1, y0, y1, z0, z1, o = {}) {
    const c = o.c || 0, t = o.taper || 0;
    const pt = t ? rrect(x0 + t, x1 - t, z0 + t, z1 - t, Math.max(0, c - t * 0.5)) : null;
    this.floors.push({ x0: x0 + t + c * 0.5, x1: x1 - t - c * 0.5, z0: z0 + t + c * 0.5, z1: z1 - t - c * 0.5, y: y1 });
    return this.add(prismGeo(rrect(x0, x1, z0, z1, c), pt, y0, y1, o), o);
  }

  windows(x0, x1, y0, y1, z0, z1, c = 0) {
    const e = 0.05;
    this.add(prismGeo(rrect(x0 - e, x1 + e, z0 - e, z1 + e, c), null, y0, y1, { top: false }), { color: GLASS, mat: 'glass' });
    // window frames: thin mullions every 1.1 m along the band
    const mull = (xa, za, xb, zb) => {
      const len = Math.hypot(xb - xa, zb - za);
      const n = Math.floor(len / 1.1);
      for (let i = 1; i < n; i++) {
        const f = i / n;
        this.box(xa + (xb - xa) * f - 0.05, xa + (xb - xa) * f + 0.05, y0, y1, za + (zb - za) * f - 0.05, za + (zb - za) * f + 0.05, { color: SHADE, paint: 1 });
      }
    };
    mull(x0 - e, z0 - e, x1 + e, z0 - e);
    mull(x0 - e, z0 - e, x0 - e, z1 + e);
    mull(x1 + e, z0 - e, x1 + e, z1 + e);
  }

  cyl(x, y, z, r0, r1, h, seg = 16, o = {}) {
    const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, !!o.open);
    if (o.sx || o.sz) g.scale(o.sx || 1, 1, o.sz || 1);
    g.translate(x, y + h / 2, z);
    return this.add(g, o);
  }

  tube(a, b, r, seg = 8, o = {}) {
    const d = b.clone().sub(a);
    const len = d.length();
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, !!o.open);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    g.translate(a.x, a.y, a.z);
    return this.add(g, o);
  }

  /** Thin signal halyard or stay. */
  line(a, b, r = 0.014) {
    return this.tube(a, b, r, 3, { color: DARK, open: true });
  }

  /** Open-topped gun tub (splinter shield) with its floor at y. */
  tub(x, y, z, r, h, floor = 0.03) {
    const seg = r > 2 ? 40 : r > 1 ? 24 : 16, t = 0.1;
    this.add(new THREE.CylinderGeometry(r, r, h, seg, 1, true).translate(x, y + h / 2, z));
    this.add(flip(new THREE.CylinderGeometry(r - t, r - t, h, seg, 1, true)).translate(x, y + h / 2, z));
    this.add(new THREE.RingGeometry(r - t, r, seg).rotateX(-HALF).translate(x, y + h, z));
    this.add(new THREE.CircleGeometry(r - t, seg).rotateX(-HALF).translate(x, y + floor, z));
    // a rolled lip and a few stiffeners make the shield read as plate, not a pipe
    if (r > 1) {
      this.add(new THREE.TorusGeometry(r - 0.05, 0.045, 4, seg).rotateX(HALF).translate(x, y + h, z));
      const ns = r > 2 ? 10 : 6;
      for (let i = 0; i < ns; i++) {
        const a = (i / ns) * PI * 2;
        this.box(x + Math.cos(a) * (r + 0.02) - 0.04, x + Math.cos(a) * (r + 0.02) + 0.04, y + 0.05, y + h - 0.05, z + Math.sin(a) * (r + 0.02) - 0.04, z + Math.sin(a) * (r + 0.02) + 0.04);
      }
    }
  }

  /** Tub or barbette; `base` extends it down to a lower surface (sheer, camber). */
  // the foundation a mount of this kind stands on
  fkey(kind) {
    return this.playable && FOUNDATION[`station-${kind}`] ? `station-${kind}` : kind;
  }

  foundation(kind, x, y, z, base = y) {
    const [r, h, type, floor] = FOUNDATION[this.fkey(kind)];
    if (type === 'tub') {
      this.tub(x, y, z, r, h, floor);
      if (base < y - 0.01) this.cyl(x, base, z, r, r, y - base, r > 2 ? 40 : 24, { open: true });
    } else {
      const b = Math.min(base, y - h);
      this.cyl(x, b, z, r, r, y - b, 40);
      this.cyl(x, y - 0.12, z, r + 0.08, r + 0.08, 0.12, 40); // roller path lip
    }
  }

  mount(kind, x, y, z, train0, arc, base = y) {
    this.foundation(kind, x, y, z, base);
    this.mounts.push({ id: `${kind}-${this.mounts.length}`, kind, pos: v3(x, y, z), train0, arc });
    // a mount the player can man keeps a little more room around it
    const key = this.fkey(kind);
    this.occupied.push({ x, y, z, r: FOUNDATION[key][0] + (key === kind ? 0.1 : 0.6) });
  }

  /** Mount on the side given by the sign of x, trained outboard. */
  sideMount(kind, x, y, z, w = 1.75) {
    this.mount(kind, x, y, z, sideTrain(x), sideArc(x, w));
  }

  // floor (or barbette top) clear of the cambered, sheered main deck, plus the depth of the skirt below it
  onDeck(kind, x, z) {
    const [r, h, type] = FOUNDATION[this.fkey(kind)];
    const H = this.hull;
    return [H.deckMax(z, x, r) + (type === 'tub' ? 0.03 : h), H.deckMin(z, x, r) - 0.3];
  }

  deckMount(kind, x, z, train0, arc) {
    const [y, base] = this.onDeck(kind, x, z);
    this.mount(kind, x, y, z, train0, arc, base);
  }

  deckSide(kind, x, z, w = 1.75) {
    this.deckMount(kind, x, z, sideTrain(x), sideArc(x, w));
  }

  station(id, name, kind, x, y, z, train0, arc, base = y) {
    this.foundation(`station-${kind}`, x, y, z, base);
    this.stations.push({ id, name, kind, pos: v3(x, y, z), train0, arc });
    // keep the player's surroundings clear of furniture
    this.occupied.push({ x, y, z, r: FOUNDATION[`station-${kind}`][0] + 0.9 });
  }

  deckStation(id, name, kind, x, z, train0, arc) {
    const [y, base] = this.onDeck(kind, x, z);
    this.station(id, name, kind, x, y, z, train0, arc, base);
  }

  /** Watertight door on a wall facing +X (s = 1) or -X (s = -1) at x, with frame and dogs. */
  door(s, x, y, z) {
    this.box(...span(s, x - 0.02, x + 0.05), y, y + 1.9, z - 0.45, z + 0.45, { color: SHADE, paint: 1 });
    this.box(...span(s, x - 0.02, x + 0.08), y + 1.9, y + 2.0, z - 0.55, z + 0.55, { color: SHADE, paint: 1 });
    for (const dy of [0.35, 0.95, 1.55]) this.box(...span(s, x + 0.05, x + 0.11), y + dy, y + dy + 0.06, z + 0.3, z + 0.42, { color: STEEL });
  }

  /** Ready-service ammunition locker (lid seam and hasps). */
  locker(x, y, z, alongX = false, small = false) {
    const [sx, sz] = small ? (alongX ? [0.85, 0.55] : [0.55, 0.85]) : alongX ? [1.3, 0.75] : [0.75, 1.3];
    const h = small ? 0.62 : 0.95;
    this.box(x - sx / 2, x + sx / 2, y, y + h, z - sz / 2, z + sz / 2, { color: TINT, paint: 1 });
    this.box(x - sx / 2 - 0.03, x + sx / 2 + 0.03, y + h - 0.12, y + h + 0.03, z - sz / 2 - 0.03, z + sz / 2 + 0.03, { color: SHADE, paint: 1 });
    this.box(x - 0.06, x + 0.06, y + h - 0.32, y + h - 0.12, z - sz / 2 - 0.05, z + sz / 2 + 0.05, { color: STEEL });
  }

  /** Mk 51 director: a small tub, pedestal and gyro gunsight box beside a 40mm mount. */
  mk51(x, y, z, facing = 0) {
    this.tub(x, y, z, 0.8, 0.95);
    this.cyl(x, y, z, 0.13, 0.11, 1.05, 8, { color: STEEL });
    const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, y + 1.05, z);
    this.add(new THREE.BoxGeometry(0.42, 0.3, 0.5).translate(0, 0.15, 0), { m, color: STEEL });
    this.add(new THREE.BoxGeometry(0.5, 0.05, 0.05).translate(0, 0.12, 0.28), { m, color: STEEL });
    this.add(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 8).rotateX(HALF).translate(0, 0.2, -0.3), { m, color: GLASS, mat: 'glass' });
  }

  /** Porthole on the hull side s at hull parameter u and height y, tilted with the flare. */
  porthole(s, u, y, r = 0.19) {
    const H = this.hull;
    const x = H.halfWidthAt(u, y);
    if (x < 1) return;
    const slope = (H.halfWidthAt(u, y + 0.4) - H.halfWidthAt(u, y - 0.4)) / 0.8;
    const m = new THREE.Matrix4().makeRotationZ(-s * Math.atan(slope)).multiply(new THREE.Matrix4().makeRotationY(s * HALF));
    m.setPosition(s * (x + 0.03), y, H.z(u));
    this.add(new THREE.CircleGeometry(r, 10), { m, color: GLASS, mat: 'glass' });
    this.add(new THREE.RingGeometry(r, r + 0.07, 10).translate(0, 0, 0.012), { m, color: SHADE, paint: 1 });
    this.add(new THREE.BoxGeometry(r * 2.6, 0.05, 0.08).translate(0, r + 0.12, 0.03), { m, color: SHADE, paint: 1 }); // eyebrow
  }

  portholeRow(s, z0, z1, dy, step = 2.4) {
    const H = this.hull;
    for (let z = z0; z <= z1; z += step) {
      const u = H.u(z);
      if (u > 0.01 && u < 0.99) this.porthole(s, u, H.deckH(u) - dy);
    }
  }

  /** Porthole on a flat wall facing +X (s = 1) or -X at x. */
  wallPort(s, x, y, z, r = 0.17) {
    const m = new THREE.Matrix4().makeRotationY(s * HALF).setPosition(x + s * 0.02, y, z);
    this.add(new THREE.CircleGeometry(r, 10), { m, color: GLASS, mat: 'glass' });
    this.add(new THREE.RingGeometry(r, r + 0.06, 10).translate(0, 0, 0.01), { m, color: SHADE, paint: 1 });
  }

  /** Degaussing cable run along the hull side, just below the deck edge. */
  degauss(s, u0, u1, dy) {
    const H = this.hull;
    const pts = [];
    for (const u of H.us) {
      if (u < u0 || u > u1) continue;
      const y = H.deckH(u) - dy;
      const x = H.halfWidthAt(u, y);
      if (x > 0.6) pts.push(v3(s * (x + 0.06), y, H.z(u)));
    }
    if (pts.length < 4) return;
    this.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.075, 4, false));
    // straps every few metres
    for (let i = 2; i < pts.length - 2; i += 3) this.add(new THREE.BoxGeometry(0.06, 0.26, 0.12).translate(pts[i].x + s * 0.02, pts[i].y, pts[i].z));
  }

  /** Scuppers draining the deck: dark slots in the hull just under the deck edge (rust runs down in the shader). */
  scuppers(s, z0, z1, step, offset) {
    const H = this.hull;
    for (let z = Math.ceil((z0 - offset) / step) * step + offset; z <= z1; z += step) {
      const u = H.u(z);
      const y = H.deckH(u) - 0.35;
      const x = H.halfWidthAt(u, y);
      if (x < 1) continue;
      this.box(...span(s, x - 0.05, x + 0.04), y - 0.1, y + 0.1, z - 0.22, z + 0.22, { color: DARK });
    }
  }

  /** Inclined ladder with stringers, rungs and hand rails from a (bottom) to b (top). */
  ladder(a, b, w = 0.62) {
    const d = b.clone().sub(a);
    const len = d.length();
    const side = v3(d.z, 0, -d.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize().multiplyScalar(w / 2);
    const up = v3(0, 0.9, 0);
    for (const sg of [-1, 1]) {
      const o = side.clone().multiplyScalar(sg);
      this.tube(a.clone().add(o), b.clone().add(o), 0.035, 4);
      this.tube(a.clone().add(o).add(up), b.clone().add(o).add(up), 0.025, 4);
      this.tube(b.clone().add(o), b.clone().add(o).add(up), 0.025, 4);
    }
    const n = Math.max(2, Math.round(len / 0.28));
    for (let i = 1; i < n; i++) {
      const p = a.clone().addScaledVector(d, i / n);
      this.tube(p.clone().sub(side), p.clone().add(side), 0.022, 4);
    }
  }

  /** Carley float stowed upright against a wall facing +X (s = 1) or -X at x. */
  carley(s, x, y, z) {
    const g = new THREE.TorusGeometry(0.85, 0.16, 5, 16).scale(1.45, 0.62, 1).rotateY(HALF).translate(x + s * 0.24, y, z);
    this.add(g, { color: RAFT });
    this.box(...span(s, x + 0.2, x + 0.26), y - 0.4, y + 0.4, z - 1.05, z + 1.05, { color: DARK });
    for (const dz of [-0.9, 0.9]) this.box(...span(s, x, x + 0.4), y - 0.05, y + 0.05, z + dz - 0.05, z + dz + 0.05, { color: STEEL });
  }

  /** Closed chock (fairlead) at the deck edge. */
  chock(x, y, z) {
    this.box(x - 0.25, x + 0.25, y, y + 0.12, z - 0.45, z + 0.45);
    for (const dz of [-0.32, 0.32]) this.box(x - 0.18, x + 0.18, y + 0.12, y + 0.42, z + dz - 0.1, z + dz + 0.1);
    this.box(x - 0.18, x + 0.18, y + 0.42, y + 0.5, z - 0.42, z + 0.42);
  }

  /** Gooseneck ventilator opening toward `facing`. */
  gooseneck(x, y, z, facing = 0) {
    this.cyl(x, y, z, 0.2, 0.2, 0.9, 10);
    const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, y + 0.9, z);
    this.add(new THREE.TorusGeometry(0.3, 0.2, 8, 10, PI).rotateY(HALF).translate(0, 0, -0.3), { m });
    this.add(new THREE.CircleGeometry(0.2, 10).rotateX(HALF).translate(0, -0.01, -0.6), { m, color: DARK });
  }

  /** Signal lamp (12 inch) on a short pedestal. */
  signalLamp(x, y, z, facing = 0) {
    this.cyl(x, y, z, 0.08, 0.08, 0.7, 6);
    const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, y + 0.85, z);
    this.add(new THREE.CylinderGeometry(0.2, 0.2, 0.42, 12).rotateX(HALF), { m, color: STEEL });
    this.add(new THREE.CircleGeometry(0.17, 12).rotateY(PI).translate(0, 0, -0.22), { m, color: GLASS, mat: 'glass' });
    this.add(new THREE.BoxGeometry(0.3, 0.06, 0.06).translate(0, 0.24, 0), { m, color: BRASS, mat: 'brass' });
  }

  /** Running light in its screen. */
  navLight(x, y, z, color) {
    this.box(x - 0.04, x + 0.04, y, y + 0.5, z - 0.4, z + 0.2);
    this.box(x - 0.15, x + 0.15, y + 0.12, y + 0.36, z - 0.12, z + 0.12, { color });
  }

  /** National ensign flying aft (+Z) from a hoist point. */
  ensign(x, y, z, w = 2.4, h = 1.26) {
    const sh = h / 13;
    for (let i = 0; i < 13; i++) {
      this.box(x - 0.015, x + 0.015, y - (i + 1) * sh, y - i * sh, z, z + w, { color: i % 2 ? WHITE : FLAG_RED });
    }
    this.box(x - 0.025, x + 0.025, y - 7 * sh, y, z, z + w * 0.4, { color: FLAG_BLUE });
  }

  hullMesh() {
    this.add(this.hull.hullGeometry());
  }

  deckMesh(kind) {
    const g = this.hull.deckGeometry();
    if (kind === 'teak') this.deck.push(g.toNonIndexed());
    else this.add(g);
  }

  /** Flat deck surface from a convex outline (wood material, planks along Z). */
  deckPoly(pts, y) {
    if (orient(pts)) pts = [...pts].reverse();
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    const pos = [], uv = [], nor = [];
    const v = (p) => {
      pos.push(p[0], y, p[1]);
      uv.push(p[0] / 4, p[1] / 16);
      nor.push(0, 1, 0);
    };
    for (let i = 0; i < pts.length; i++) {
      v(c); v(pts[i]); v(pts[(i + 1) % pts.length]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.deck.push(g);
  }

  /** Alpha-tested railing (stanchions and wires) along a polyline of foot points. */
  railLine(pts, h = 1.05) {
    const pos = [], nor = [], uv = [];
    let d = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = a.distanceTo(b);
      if (len < 1e-3) continue;
      const nx = (b.z - a.z) / len, nz = -(b.x - a.x) / len;
      for (const [p, dy, dd] of [[a, 0, d], [b, 0, d + len], [b, h, d + len], [a, 0, d], [b, h, d + len], [a, h, d]]) {
        pos.push(p.x, p.y + dy, p.z);
        nor.push(nx, 0, nz);
        uv.push(dd / 1.6, dy > 0 ? 1 : 0);
      }
      d += len;
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.rail.push(g);
  }

  railLoop(pts, y, h) {
    const p = pts.map(([x, z]) => v3(x, y, z));
    p.push(p[0].clone());
    this.railLine(p, h);
  }

  edgeRails(u0 = 0.012, u1 = 0.992) {
    const H = this.hull;
    for (const s of [-1, 1]) {
      const pts = [];
      for (const u of H.us) if (u >= u0 && u <= u1) pts.push(v3(s * (H.deckHB(u) - 0.08), H.deckH(u), H.z(u)));
      this.railLine(pts);
    }
  }

  /** Bollards and chocks along both deck edges at the given stations. */
  mooring(zs, inset = 0.9) {
    const H = this.hull;
    for (const s of [-1, 1]) {
      for (const z of zs) {
        const e = H.deckHB(H.u(z));
        bollard(this, s * (e - inset), H.deckY(z, e - inset), z);
        this.chock(s * (e - 0.35), H.deckY(z, e - 0.35), z + 1.6);
      }
    }
  }

  // support under a footprint: a recorded roof/platform at height y, or the main deck near y
  supportAt(x, z, y, r) {
    for (const f of this.floors) {
      if (Math.abs(f.y - y) < 0.15 && x - r > f.x0 && x + r < f.x1 && z - r > f.z0 && z + r < f.z1) return f.y;
    }
    const H = this.hull;
    const u = H.u(z);
    if (u < 0.02 || u > 0.98) return null;
    const d = H.deckY(z, x);
    if (Math.abs(d - y) < 0.7 && Math.abs(x) + r < H.deckHB(u) - 0.4) return d;
    return null;
  }

  clearAt(x, z, y, r) {
    for (const o of this.occupied) if (Math.abs(o.y - y) < 2.5 && Math.hypot(o.x - x, o.z - z) < o.r + r) return false;
    for (const b of this.boxes) {
      if (y + 0.4 > b.min.y && y < b.max.y - 0.1 && x + r > b.min.x && x - r < b.max.x && z + r > b.min.z && z - r < b.max.z) return false;
    }
    return true;
  }

  /** Put a footprint of radius r next to a mount (inboard first, then aft, forward, outboard). */
  besideMount(m, r) {
    const [mr] = FOUNDATION[this.fkey(m.kind)];
    const inb = Math.abs(m.pos.x) > 0.5 ? -Math.sign(m.pos.x) : 0;
    const dirs = inb ? [[inb, 0], [0, 1], [0, -1], [inb * 0.7, 0.7], [inb * 0.7, -0.7]] : [[0, 1], [0, -1], [1, 0], [-1, 0]];
    const d = mr + r + 0.2;
    for (const [dx, dz] of dirs) {
      const x = m.pos.x + dx * d, z = m.pos.z + dz * d;
      const y = this.supportAt(x, z, m.pos.y - (FOUNDATION[m.kind][1] > 0.6 && m.kind.startsWith('5') ? FOUNDATION[m.kind][1] : 0), r);
      if (y === null || !this.clearAt(x, z, y, r)) continue;
      this.occupied.push({ x, y, z, r });
      return { x, y, z, dx, dz };
    }
    return null;
  }

  /** Ready-service lockers by every light AA mount, a Mk 51 director by each 40mm quad. */
  furnish() {
    for (const m of this.mounts) {
      if (m.kind === '40mm-quad') {
        const d = this.besideMount(m, 0.85);
        if (d) this.mk51(d.x, d.y, d.z, Math.atan2(-(m.pos.x - d.x), -(m.pos.z - d.z)) + PI);
      }
      if (m.kind.startsWith('40mm') || m.kind === '20mm') {
        const small = m.kind === '20mm';
        const p = this.besideMount(m, small ? 0.5 : 0.8);
        if (p) this.locker(p.x, p.y, p.z, Math.abs(p.dz) > Math.abs(p.dx), small);
      }
    }
  }

  finish(extra) {
    const H = this.hull;
    const boxes = this.boxes;
    const topAt = (z) => {
      let t = extra.deckAt(z);
      for (const b of boxes) if (z >= b.min.z && z <= b.max.z && b.min.x <= 1 && b.max.x >= -1) t = Math.max(t, b.max.y);
      return t;
    };
    return {
      paintGeo: mergeGeometries(this.paint),
      deckGeo: this.deck.length ? mergeGeometries(this.deck) : null,
      railGeo: this.rail.length ? mergeGeometries(this.rail) : null,
      halfBeamAt: (z) => H.halfBeamAt(z),
      topAt,
      boxes,
      mounts: this.mounts,
      stations: this.stations,
      funnels: this.funnels,
      parking: this.parking,
      line: Math.min(H.dMid, H.dStern),
      ...extra,
    };
  }
}

// ---------------------------------------------------------------- fittings

/**
 * Main battery turret: barbette, faceted gunhouse with a sloped face plate, gun ports,
 * stepped barrels with blast bags, roof periscope hoods and rangefinder.
 */
function turret(P, { x = 0, z, y, deckY, facing = 0, w, len, h, guns, bl, br, gap, bbR, rangefinder = true }) {
  P.cyl(x, deckY - 0.4, z, bbR, bbR, y - deckY + 0.45, 48, { solid: true });
  const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, 0, z);
  const f = -len * 0.4, r = len * 0.6, hw = w / 2, c = w * 0.16, slope = h * 0.6, rc = w * 0.07;
  // the rear overhangs the barbette; side faces lean in slightly, roof edges chamfered
  const base = [[-hw + rc, r], [hw - rc, r], [hw, r - rc], [hw, f + c], [hw - c, f], [-hw + c, f], [-hw, f + c], [-hw, r - rc]];
  const top = [[-hw * 0.94 + rc, r - 0.25], [hw * 0.94 - rc, r - 0.25], [hw * 0.94, r - 0.25 - rc], [hw * 0.94, f + c + slope], [hw - c, f + slope], [-hw + c, f + slope], [-hw * 0.94, f + c + slope], [-hw * 0.94, r - 0.25 - rc]];
  const g = P.add(prismGeo(base, top, y, y + h, { bottom: true }), { m });
  g.computeBoundingBox();
  P.boxes.push({ min: g.boundingBox.min.clone(), max: g.boundingBox.max.clone() });
  // skirt between the gunhouse and the barbette
  P.add(new THREE.CylinderGeometry(bbR + 0.12, bbR + 0.12, 0.35, 48, 1, true).translate(0, y + 0.05, 0), { m, color: SHADE, paint: 1 });
  // rangefinder hoods at the rear corners and the rangefinder across the rear
  if (rangefinder) {
    for (const s of [-1, 1]) {
      P.add(prismGeo(rrect(-0.55, 0.55, -len * 0.08, len * 0.08, 0.2), rrect(-0.45, 0.45, -len * 0.07, len * 0.07, 0.15), 0, h * 0.34).translate(s * (hw + 0.45), y + h * 0.5, r - len * 0.2), { m });
      P.add(new THREE.CircleGeometry(0.25, 10).rotateY(PI).translate(s * (hw + 0.45), y + h * 0.67, r - len * 0.2 - len * 0.081), { m, color: GLASS, mat: 'glass' });
    }
  }
  // roof: sight hoods along the front edge, hatches and a ventilator aft
  for (const sx of [-0.62, 0, 0.62]) {
    const hx = sx * hw;
    P.add(prismGeo(rrect(hx - 0.45, hx + 0.45, -0.6, 0.6, 0.15), rrect(hx - 0.38, hx + 0.38, -0.3, 0.55, 0.12), 0, 0.55).translate(0, y + h, f + slope + 1.4), { m });
    P.add(new THREE.BoxGeometry(0.6, 0.18, 0.04).translate(hx, y + h + 0.3, f + slope + 0.79), { m, color: DARK });
  }
  for (const s of [-1, 1]) P.add(new THREE.BoxGeometry(1.1, 0.14, 1.3).translate(s * hw * 0.45, y + h + 0.07, r - 2.0), { m });
  P.add(new THREE.CylinderGeometry(0.42, 0.36, 0.5, 12).translate(0, y + h + 0.25, r - 1.4), { m });
  P.add(new THREE.CylinderGeometry(0.6, 0.6, 0.14, 12).translate(0, y + h + 0.57, r - 1.4), { m });
  // gun ports on the face plate
  const lean = Math.atan2(slope, h);
  const axisY = y + h * 0.42;
  const tilt = new THREE.Matrix4().makeRotationX(0.025);
  for (let i = 0; i < guns; i++) {
    const bx = (i - (guns - 1) / 2) * gap;
    const port = new THREE.BoxGeometry(br * 3.0, h * 0.5, 0.08).rotateX(lean).translate(bx, axisY + 0.1, f + slope * 0.43 - 0.03);
    P.add(port, { m, color: DARK });
    const gm = new THREE.Matrix4().makeTranslation(bx, axisY, f + slope * 0.42).multiply(tilt);
    // chase steps down two thirds of the way out; muzzle swell at the end
    const b1 = new THREE.CylinderGeometry(br * 0.86, br, bl * 0.4, 18, 1).rotateX(-HALF).translate(0, 0, -bl * 0.2);
    const b2 = new THREE.CylinderGeometry(br * 0.68, br * 0.8, bl * 0.6, 18, 1).rotateX(-HALF).translate(0, 0, -bl * 0.7);
    const sw = new THREE.CylinderGeometry(br * 0.78, br * 0.7, bl * 0.035, 18, 1).rotateX(-HALF).translate(0, 0, -bl * 0.98);
    const ring = new THREE.CylinderGeometry(br * 0.9, br * 0.9, 0.12, 18, 1).rotateX(-HALF).translate(0, 0, -bl * 0.4);
    for (const piece of [b1, b2, sw, ring]) P.add(piece.applyMatrix4(gm), { m });
    P.add(new THREE.CircleGeometry(br * 0.42, 12).rotateY(PI).translate(0, 0, -bl - 0.001).applyMatrix4(gm), { m, color: DARK });
    // canvas blast bag where the barrel leaves the port
    const bag = new THREE.CylinderGeometry(br * 1.45, br * 1.7, 1.5, 14, 3).rotateX(-HALF).translate(0, 0, -0.35);
    const bp = bag.attributes.position;
    for (let k = 0; k < bp.count; k++) {
      const wob = 1 + 0.06 * Math.sin(bp.getZ(k) * 9 + Math.atan2(bp.getY(k), bp.getX(k)) * 5);
      bp.setXYZ(k, bp.getX(k) * wob, bp.getY(k) * wob, bp.getZ(k));
    }
    bag.computeVertexNormals();
    P.add(bag.applyMatrix4(gm), { m, color: CANVAS });
  }
}

/** Elliptical stack with a raked top, cap band, clinker grating, steam pipes and a base fairing. */
function funnel(P, { x = 0, z, y0, y1, rx, rz, rake = 0, cap = 0.9, pipes = 2, fairing = true }) {
  const h = y1 - y0;
  const shape = (r, yA, yB, open, seg = 40) => {
    const hh = yB - yA;
    const g = new THREE.CylinderGeometry(r, r * 1.03, hh, seg, 4, open);
    g.scale(rx, 1, rz);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + (rake * (p.getY(i) + hh / 2 + (yA - y0))) / h);
    g.translate(x, yA + hh / 2, z);
    g.computeVertexNormals();
    return g;
  };
  P.add(shape(1, y0, y1 - cap, true), { solid: true });
  P.add(shape(1.035, y1 - cap, y1, true), { color: PAINT.black });
  P.add(shape(1.045, y1 - cap - 0.18, y1 - cap, true), { color: PAINT.black }); // cap band rim
  P.add(flip(shape(0.92, y1 - 2.5, y1, true)), { color: DARK });
  P.add(new THREE.RingGeometry(0.92, 1.035, 40).scale(rx, rz, 1).rotateX(-HALF).translate(x, y1, z + rake), { color: PAINT.black });
  P.add(new THREE.CircleGeometry(0.93, 40).scale(rx, rz, 1).rotateX(-HALF).translate(x, y1 - 1.4, z + rake * 0.85), { color: DARK });
  // clinker screen bars across the opening
  for (let i = -3; i <= 3; i++) {
    P.add(new THREE.BoxGeometry(rx * 1.85, 0.08, 0.08).translate(x, y1 - 0.15, z + rake + (i * rz * 0.9) / 3.6), { color: PAINT.black });
  }
  P.add(new THREE.BoxGeometry(0.08, 0.08, rz * 1.85).translate(x, y1 - 0.15, z + rake), { color: PAINT.black });
  // steam / whistle pipes up the after face
  for (let i = 0; i < pipes; i++) {
    const px = x + (i - (pipes - 1) / 2) * rx * 0.5;
    const pz0 = z + rz * 1.02 + 0.25, pz1 = pz0 + rake;
    P.tube(v3(px, y0 + 1, pz0 + (rake * 1) / h), v3(px, y1 + 0.9, pz1 + 0.05), 0.16, 8, { color: SHADE, paint: 1 });
  }
  // whistle platform on the forward face
  P.box(x - 0.9, x + 0.9, y1 - cap - 2.2, y1 - cap - 2.05, z - rz * 1.02 - 1.0 + rake * 0.75, z - rz * 1.02 + rake * 0.75);
  P.cyl(x + 0.4, y1 - cap - 2.05, z - rz * 1.02 - 0.5 + rake * 0.75, 0.12, 0.1, 0.6, 8, { color: BRASS, mat: 'brass' });
  if (fairing) P.add(shape(1.1, y0 - 0.1, y0 + 1.2, true), {});
  P.funnels.push({ pos: v3(x, y1, z + rake), radius: Math.max(rx, rz) * 0.9 });
}

/** Mk 37 dual-purpose director with rangefinder, Mk 12 radar dish and the Mk 22 "orange peel". */
function mk37(P, x, y, z, facing = 0) {
  const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, 0, z);
  P.add(new THREE.CylinderGeometry(1.2, 1.3, 0.7, 24).translate(0, y + 0.35, 0), { m });
  P.add(prismGeo(rrect(-1.9, 1.9, -2.3, 2.1, 0.6), rrect(-1.7, 1.7, -1.9, 1.9, 0.5), y + 0.7, y + 3.0), { m });
  // sighting ports and hatches
  for (const sx of [-1.1, 0, 1.1]) P.add(new THREE.BoxGeometry(0.55, 0.22, 0.06).translate(sx, y + 2.4, -2.18), { m, color: DARK });
  P.add(new THREE.BoxGeometry(0.9, 0.12, 0.9).translate(0.6, y + 3.06, 1.0), { m });
  P.add(new THREE.CylinderGeometry(0.26, 0.26, 5.6, 12).rotateZ(HALF).translate(0, y + 2.3, 0.9), { m });
  for (const s of [-1, 1]) {
    P.add(new THREE.CylinderGeometry(0.42, 0.42, 0.55, 12).rotateZ(HALF).translate(s * 2.9, y + 2.3, 0.9), { m });
    P.add(new THREE.CircleGeometry(0.2, 10).rotateY(PI).translate(s * 2.9, y + 2.3, 0.47), { m, color: GLASS, mat: 'glass' });
  }
  // Mk 12 dish on its frame, Mk 22 orange peel beside it
  P.add(new THREE.BoxGeometry(0.25, 1.0, 0.25).translate(0, y + 3.5, -0.4), { m });
  P.add(twoSided(new THREE.CylinderGeometry(1.45, 1.45, 1.05, 12, 1, true, -0.62, 1.24)).translate(0, y + 4.3, -1.6), { m, color: STEEL });
  P.add(new THREE.BoxGeometry(2.6, 0.08, 0.08).translate(0, y + 3.75, -0.25), { m, color: STEEL });
  P.add(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 6).rotateX(HALF).translate(0, y + 4.3, -1.0), { m, color: STEEL });
  P.add(twoSided(new THREE.SphereGeometry(1.15, 8, 10, -0.28, 0.56, 0.45, 2.2)).translate(1.75, y + 4.0, -1.05), { m, color: STEEL });
}

/** Mk 38 main battery director (k = 0.65 for a cruiser's Mk 34) with rangefinder and Mk 8 radar. */
function mk38(P, x, y, z, facing = 0, k = 1) {
  const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, 0, z);
  const add = (g, o = {}) => P.add(g.scale(k, k, k).translate(0, y, 0), { m, ...o });
  add(new THREE.CylinderGeometry(2.0, 2.1, 0.5, 28).translate(0, 0.25, 0));
  add(prismGeo(rrect(-2.2, 2.2, -2.6, 2.2, 1.1), rrect(-1.95, 1.95, -2.2, 2.0, 0.95), 0.5, 2.6));
  add(prismGeo(rrect(-1.95, 1.95, -2.2, 2.0, 0.95), rrect(-1.6, 1.6, -1.6, 1.7, 0.7), 2.6, 3.05));
  for (const sx of [-1.2, 0, 1.2]) add(new THREE.BoxGeometry(0.6, 0.24, 0.06).translate(sx, 2.1, -2.58), { color: DARK });
  // rangefinder through the hood, ear housings with their windows
  add(new THREE.CylinderGeometry(0.34, 0.34, 11, 14).rotateZ(HALF).translate(0, 1.9, 0.6));
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(1.0, 1.0, 1.1).translate(s * 5.5, 1.9, 0.6));
    add(new THREE.CircleGeometry(0.22, 10).rotateY(PI).translate(s * 5.5, 1.9, 0.04), { color: GLASS, mat: 'glass' });
  }
  // Mk 8 "cheese" array on its frame
  add(new THREE.BoxGeometry(4.2, 1.1, 0.28).translate(0, 3.8, -1.5), { color: STEEL });
  for (let i = -3; i <= 3; i++) add(new THREE.BoxGeometry(0.05, 1.1, 0.12).translate(i * 0.6, 3.8, -1.7), { color: DARK });
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.12, 0.85, 0.12).translate(s * 1.4, 3.2, -1.3), { color: STEEL });
  add(new THREE.BoxGeometry(0.9, 0.25, 0.7).translate(0, 3.15, 0.6));
}

/** SK "bedspring" air-search antenna: reflector grid with dipole rows, facing local -Z. */
function bedspring(P, x, y, z, s, facing = 0) {
  const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, y, z);
  const n = 8, t = 0.06;
  for (let i = 0; i <= n; i++) {
    const a = -s / 2 + (i * s) / n;
    P.add(new THREE.BoxGeometry(t, s, t).translate(a, 0, 0), { m, color: STEEL });
    P.add(new THREE.BoxGeometry(s, t, t).translate(0, a, 0), { m, color: STEEL });
  }
  // dipoles standing proud of the screen
  for (let r = 0; r < 4; r++) {
    const yy = -s * 0.375 + (r * s) / 4 + s / 8;
    P.add(new THREE.BoxGeometry(s * 0.9, 0.05, 0.05).translate(0, yy, -0.35), { m, color: STEEL });
    for (let c = 0; c < 4; c++) P.add(new THREE.BoxGeometry(0.05, 0.05, 0.35).translate(-s * 0.375 + (c * s) / 4 + s / 8, yy, -0.18), { m, color: STEEL });
  }
  P.add(new THREE.BoxGeometry(0.3, 0.3, 1.3).translate(0, 0, 0.65), { m, color: STEEL });
  P.add(new THREE.CylinderGeometry(0.03, 0.03, 1.2, 4).translate(0, s / 2 + 0.6, 0), { m, color: STEEL }); // IFF whip
}

/** SG surface-search radar: a small curved reflector on a pedestal. */
function sgRadar(P, x, y, z, facing = 0) {
  const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, y, z);
  P.add(new THREE.CylinderGeometry(0.22, 0.28, 0.5, 10).translate(0, 0.25, 0), { m, color: STEEL });
  P.add(twoSided(new THREE.CylinderGeometry(1.1, 1.1, 0.42, 14, 1, true, -0.85, 1.7)).translate(0, 0.75, -0.6), { m, color: STEEL });
  P.add(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6).rotateX(HALF).translate(0, 0.75, -0.1), { m, color: STEEL });
}

function searchlight(P, x, y, z, facing = 0) {
  P.cyl(x, y, z, 0.3, 0.22, 0.75, 10);
  const m = new THREE.Matrix4().makeRotationY(facing).setPosition(x, y + 1.25, z);
  P.add(new THREE.CylinderGeometry(0.62, 0.62, 0.9, 18).rotateX(HALF), { m, color: STEEL });
  P.add(new THREE.CylinderGeometry(0.66, 0.66, 0.12, 18).rotateX(HALF).translate(0, 0, -0.46), { m, color: STEEL });
  P.add(new THREE.CircleGeometry(0.55, 18).rotateY(PI).translate(0, 0, -0.53), { m, color: GLASS, mat: 'glass' });
  for (const s of [-1, 1]) P.add(new THREE.BoxGeometry(0.08, 0.7, 0.2).translate(s * 0.7, -0.3, 0), { m });
}

function vent(P, x, y, z) {
  P.cyl(x, y, z, 0.32, 0.32, 1.1, 12);
  P.cyl(x, y + 1.1, z, 0.55, 0.5, 0.28, 14);
  P.cyl(x, y + 1.38, z, 0.5, 0.2, 0.18, 14);
}

function bollard(P, x, y, z) {
  P.box(x - 0.35, x + 0.35, y, y + 0.08, z - 0.85, z + 0.85);
  for (const dz of [-0.45, 0.45]) {
    P.cyl(x, y + 0.08, z + dz, 0.2, 0.2, 0.5, 12);
    P.cyl(x, y + 0.58, z + dz, 0.24, 0.24, 0.06, 12);
  }
}

function capstan(P, x, y, z) {
  P.cyl(x, y, z, 0.9, 0.75, 0.55, 18, { color: STEEL });
  P.cyl(x, y + 0.55, z, 0.65, 0.5, 0.35, 18, { color: STEEL });
  P.cyl(x, y + 0.9, z, 0.5, 0.55, 0.12, 18, { color: STEEL });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * PI * 2;
    P.box(x + Math.cos(a) * 0.62 - 0.05, x + Math.cos(a) * 0.62 + 0.05, y + 0.6, y + 0.85, z + Math.sin(a) * 0.62 - 0.05, z + Math.sin(a) * 0.62 + 0.05, { color: STEEL });
  }
}

/** Anchor chain of alternating flat and upright links lying along the deck. */
function chain(P, a, b) {
  const d = new THREE.Vector3().subVectors(b, a);
  const n = Math.max(2, Math.floor(d.length() / 0.42));
  const yaw = Math.atan2(d.x, d.z);
  const links = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.TorusGeometry(0.14, 0.045, 4, 8).scale(1, 1.5, 1);
    const up = i % 2 === 1;
    if (up) g.rotateY(HALF);
    g.rotateX(HALF).rotateY(yaw);
    const p = a.clone().addScaledVector(d, (i + 0.5) / n);
    g.translate(p.x, p.y + (up ? 0.18 : 0.05), p.z);
    links.push(g);
  }
  P.add(mergeGeometries(links), { color: CHAIN });
}

/** Life rafts against the wall whose outer face is at x0 or x1 (outer side chosen by sign). */
function raft(P, x0, x1, y, z) {
  const s = x1 > 0 ? 1 : -1;
  P.carley(s, s > 0 ? x0 : x1, y + 0.55, z);
}

/** Quintuple torpedo tube mount: base ring, platform, tubes with end caps, trainer's hood. */
function torpedoTubes(P, y, z, len) {
  P.cyl(0, y, z, 1.5, 1.6, 0.45, 24);
  P.box(-1.8, 1.8, y + 0.45, y + 0.6, z - 1.3, z + 1.3);
  for (let i = -2; i <= 2; i++) {
    const tx = i * 0.68;
    P.add(new THREE.CylinderGeometry(0.3, 0.3, len, 14).rotateX(HALF).translate(tx, y + 0.92, z));
    for (const s of [-1, 1]) {
      P.add(new THREE.CylinderGeometry(0.33, 0.33, 0.12, 14).rotateX(HALF).translate(tx, y + 0.92, z + s * len * 0.28));
      P.add(new THREE.CircleGeometry(0.28, 12).rotateY(s > 0 ? 0 : PI).translate(tx, y + 0.92, z + s * (len / 2 + 0.005)), { color: DARK });
    }
  }
  P.box(-1.75, 1.75, y + 0.6, y + 0.68, z - len * 0.3, z - len * 0.26);
  P.box(-0.8, 0.8, y + 0.6, y + 1.9, z + len / 2 - 1.6, z + len / 2 - 0.2);
  P.box(-0.7, 0.7, y + 1.45, y + 1.65, z + len / 2 - 1.62, z + len / 2 - 1.58, { color: GLASS, mat: 'glass' });
}

/** Bower anchors housed in hawse pipes on both bows. */
function anchors(P, H, u) {
  const z = H.z(u), y = H.deckH(u) - 2.4;
  for (const s of [-1, 1]) {
    const x = H.halfWidthAt(u, y);
    P.box(...span(s, x - 0.2, x + 0.08), y + 0.1, y + 1.0, z - 0.6, z + 0.6, { color: DARK });
    // the hawse lip and the anchor: shank, crown and flukes
    P.add(new THREE.TorusGeometry(0.62, 0.08, 6, 14).rotateY(HALF).translate(s * (x + 0.06), y + 0.55, z), { color: STEEL });
    P.box(...span(s, x - 0.05, x + 0.3), y - 1.7, y + 0.3, z - 0.22, z + 0.22, { color: STEEL });
    P.box(...span(s, x - 0.1, x + 0.35), y - 2.0, y - 1.5, z - 0.95, z + 0.95, { color: STEEL });
    for (const dz of [-0.9, 0.9]) P.box(...span(s, x - 0.05, x + 0.4), y - 1.6, y - 1.1, z + dz - 0.18, z + dz + 0.18, { color: STEEL });
  }
}

/** Hawse pipes on deck, chain stoppers and chains running aft to the capstans. */
function groundTackle(P, H, hz, hx, cz, cx) {
  for (const s of [-1, 1]) {
    P.cyl(s * hx, H.deckY(hz, hx) - 0.1, hz, 0.7, 0.7, 0.24, 16, { color: DARK });
    P.cyl(s * hx, H.deckY(hz, hx) + 0.12, hz, 0.78, 0.72, 0.1, 16, { color: STEEL });
    const mid = v3(s * lerp(hx, cx, 0.45), H.deckY(lerp(hz, cz, 0.45), lerp(hx, cx, 0.45)), lerp(hz, cz, 0.45));
    P.box(mid.x - 0.35, mid.x + 0.35, mid.y, mid.y + 0.3, mid.z - 0.6, mid.z + 0.6, { color: STEEL }); // chain stopper
    chain(P, v3(s * hx, H.deckY(hz, hx), hz), v3(s * cx, H.deckY(cz, cx), cz - 1.3));
    capstan(P, s * cx, H.deckY(cz, cx), cz);
  }
}

/** Shallow V breakwater across the forecastle, apex at z0, with brackets on its after face. */
function breakwater(P, H, z0, halfW, rake, h = 1.1) {
  const n = 6;
  for (const s of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const xa = (s * i * halfW) / n, xb = (s * (i + 1) * halfW) / n;
      const za = z0 + (Math.abs(xa) / halfW) * rake, zb = z0 + (Math.abs(xb) / halfW) * rake;
      const xm = (xa + xb) / 2, zm = (za + zb) / 2;
      const len = Math.hypot(xb - xa, zb - za) + 0.05;
      const yb = H.deckY(zm, xm);
      P.add(new THREE.BoxGeometry(len, h, 0.1).rotateY(-Math.atan2(zb - za, xb - xa)).translate(xm, yb + h / 2 - 0.05, zm));
      P.box(xm - 0.04, xm + 0.04, yb, yb + h * 0.8, zm + 0.05, zm + 0.45);
    }
  }
}

/** Aircraft catapult: turntable and lattice track pointing along `yaw` (rotation.y convention). */
function catapult(P, x, y, z, yaw, len = 20) {
  const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
  P.add(new THREE.CylinderGeometry(1.3, 1.4, 0.9, 20).translate(0, 0.45, 0), { m });
  const top = 1.9;
  for (const s of [-1, 1]) {
    P.add(new THREE.BoxGeometry(0.12, 0.12, len).translate(s * 0.55, top, -len / 2 + 2), { m, color: STEEL });
    P.add(new THREE.BoxGeometry(0.1, 0.1, len).translate(s * 0.55, 1.05, -len / 2 + 2), { m });
    const n = Math.floor(len / 1.7);
    for (let i = 0; i <= n; i++) {
      const zz = 2 - (i * len) / n;
      P.add(new THREE.BoxGeometry(0.08, top - 1.05, 0.08).translate(s * 0.55, (top + 1.05) / 2, zz), { m });
      if (i < n) {
        const za = zz, zb = 2 - ((i + 1) * len) / n;
        const d = v3(0, top - 1.05, zb - za);
        const g = new THREE.CylinderGeometry(0.035, 0.035, d.length(), 4);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), d.clone().normalize()));
        g.translate(s * 0.56, (top + 1.05) / 2, (za + zb) / 2);
        P.add(g, { m });
      }
    }
  }
  for (let i = 0; i <= 10; i++) P.add(new THREE.BoxGeometry(1.2, 0.07, 0.07).translate(0, top - 0.05, 2 - (i * len) / 10), { m });
  P.add(new THREE.BoxGeometry(1.4, 0.35, 2.2).translate(0, top + 0.2, -len * 0.35), { m, color: STEEL }); // launching car
}

/** Vought OS2U Kingfisher on its float, nose toward local -Z. */
function kingfisher(P, x, y, z, yaw) {
  const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
  const add = (g, color, o = {}) => P.add(g, { m, color, ...o });
  const lathe = (prof, seg = 14) => new THREE.LatheGeometry(prof.map(([r, t]) => new THREE.Vector2(Math.max(r, 0.001), t)), seg).rotateX(-HALF);
  // fuselage: cowled radial engine tapering to the tail
  add(lathe([[0.001, 4.65], [0.5, 4.6], [0.66, 4.3], [0.68, 3.7], [0.62, 3.0], [0.58, 1.5], [0.5, 0], [0.38, -1.8], [0.24, -3.4], [0.12, -4.2], [0.001, -4.3]]).translate(0, 0.62, 0.15), SEA_BLUE);
  add(lathe([[0.001, 4.75], [0.62, 4.72], [0.7, 4.4], [0.7, 3.85], [0.001, 3.8]]).translate(0, 0.62, 0.15), STEEL);
  add(new THREE.SphereGeometry(0.2, 10, 8).scale(1, 1, 1.6).translate(0, 0.62, -4.75), STEEL);
  for (const a of [0, PI]) add(new THREE.BoxGeometry(0.16, 1.3, 0.05).translate(0, 0.65, 0).rotateZ(a + 0.4).translate(0, 0.62, -4.95), DARK);
  // long greenhouse canopy for pilot and observer
  add(new THREE.CapsuleGeometry(0.42, 2.9, 4, 10).rotateX(HALF).scale(1, 0.85, 1).translate(0, 1.12, -0.6), GLASS, { mat: 'glass' });
  for (let i = 0; i < 6; i++) add(new THREE.TorusGeometry(0.43, 0.03, 4, 10, PI).scale(1, 0.85, 1).translate(0, 1.12, -2.0 + i * 0.56), SEA_BLUE);
  // tapered wing with rounded tips, white undersides
  const half = 5.45;
  const wing = [[-half + 0.3, -1.25], [-half, -1.7], [-half + 0.3, -2.4], [0, -2.75], [half - 0.3, -2.4], [half, -1.7], [half - 0.3, -1.25], [0, -0.75]];
  add(prismGeo(wing, null, 0.92, 1.1), SEA_BLUE);
  add(prismGeo(wing, null, 0.88, 0.92, { top: false, bottom: true }), UNDER_WHITE);
  add(new THREE.BoxGeometry(0.06, 0.04, 0.5).translate(-half + 0.5, 1.12, -1.6), DARK);
  // tailplane and fin
  const tail = [[-2.1, 3.6], [-2.2, 3.95], [-1.9, 4.35], [0, 4.4], [1.9, 4.35], [2.2, 3.95], [2.1, 3.6], [0, 3.2]];
  add(prismGeo(tail, null, 0.74, 0.84), SEA_BLUE);
  const fin = new THREE.Shape();
  fin.moveTo(3.0, 0.8);
  fin.lineTo(4.45, 0.75);
  fin.lineTo(4.4, 2.0);
  fin.quadraticCurveTo(4.1, 2.35, 3.7, 2.1);
  fin.lineTo(3.0, 0.8);
  add(new THREE.ExtrudeGeometry(fin, { depth: 0.1, bevelEnabled: false }).rotateY(-HALF).translate(0.05, 0, 0), SEA_BLUE);
  // main float on two struts, stabilising floats under the wingtips
  add(lathe([[0.001, 3.2], [0.22, 2.7], [0.42, 1.3], [0.44, 0], [0.36, -1.6], [0.12, -2.6], [0.001, -2.7]]).translate(0, -1.05, -1.35), UNDER_WHITE);
  for (const dz of [-2.4, -0.4]) {
    for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 5).rotateZ(s * 0.28).translate(s * 0.22, -0.25, dz), STEEL);
  }
  for (const s of [-1, 1]) {
    add(lathe([[0.001, 0.75], [0.15, 0.5], [0.17, 0], [0.1, -0.6], [0.001, -0.7]], 8).translate(s * 4.6, 0.3, -1.6), UNDER_WHITE);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.62, 4).translate(s * 4.6, 0.62, -1.6), STEEL);
  }
}

/** Boat / aircraft crane: pedestal, house and a lattice jib resting at an angle. */
function crane(P, x, y, z, yaw, len = 12, elev = 0.35) {
  const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
  P.add(new THREE.CylinderGeometry(0.75, 0.9, 2.4, 16).translate(0, 1.2, 0), { m });
  P.add(new THREE.BoxGeometry(1.7, 1.5, 2.3).translate(0, 3.1, 0.2), { m });
  const base = v3(0, 3.4, -0.6), tip = v3(0, 3.4 + Math.sin(elev) * len, -0.6 - Math.cos(elev) * len);
  for (const s of [-1, 1]) {
    const a = base.clone().setX(s * 0.45), b = tip.clone().setX(s * 0.12);
    const d = b.clone().sub(a);
    const g = new THREE.CylinderGeometry(0.1, 0.1, d.length(), 6).translate(0, d.length() / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), d.normalize())).translate(a.x, a.y, a.z);
    P.add(g, { m });
  }
  for (let i = 1; i < 8; i++) {
    const p = base.clone().lerp(tip, i / 8);
    const w = 0.45 - (0.33 * i) / 8;
    P.add(new THREE.BoxGeometry(w * 2, 0.06, 0.06).translate(p.x, p.y, p.z), { m });
  }
  P.add(new THREE.CylinderGeometry(0.02, 0.02, 2.5, 3).translate(tip.x, tip.y - 1.25, tip.z), { m, color: DARK });
  P.add(new THREE.BoxGeometry(0.3, 0.4, 0.3).translate(tip.x, tip.y - 2.6, tip.z), { m, color: STEEL });
}

/** Depth charge rack: low rails, guard rails on posts and a row of charges on their sides. */
function dcRack(P, x, y, z0, z1) {
  for (const s of [-0.45, 0.45]) {
    P.box(x + s - 0.05, x + s + 0.05, y, y + 0.14, z0, z1, { color: STEEL });
    P.box(x + s - 0.03, x + s + 0.03, y + 0.95, y + 1.0, z0, z1, { color: STEEL });
    for (let z = z0 + 0.2; z <= z1; z += 1.2) P.box(x + s - 0.03, x + s + 0.03, y + 0.14, y + 0.95, z - 0.03, z + 0.03, { color: STEEL });
  }
  for (let z = z0 + 0.4; z < z1 - 0.3; z += 0.62) {
    P.add(new THREE.CylinderGeometry(0.28, 0.28, 0.72, 14).rotateZ(HALF).translate(x, y + 0.42, z), { color: STEEL });
    for (const s of [-1, 1]) P.add(new THREE.CircleGeometry(0.2, 10).rotateY(s * HALF).translate(x + s * 0.362, y + 0.42, z), { color: DARK });
  }
}

/** K-gun depth charge projector with an arbor and charge, firing outboard. */
function kGun(P, s, x, y, z) {
  P.cyl(x, y, z, 0.32, 0.32, 0.2, 10, { color: STEEL });
  const g = new THREE.CylinderGeometry(0.16, 0.16, 1.0, 10).rotateZ(-s * 0.75).translate(x + s * 0.32, y + 0.55, z);
  P.add(g, { color: STEEL });
  P.add(new THREE.CylinderGeometry(0.28, 0.28, 0.7, 12).rotateZ(-s * 0.75).translate(x + s * 0.72, y + 0.95, z), { color: STEEL });
  P.add(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 8).rotateZ(PI / 2).translate(x - s * 0.1, y + 0.45, z + 0.6), { color: STEEL }); // reload rack
}

// ---------------------------------------------------------------- South Dakota class battleship

function buildBB(variant = 'alabama') {
  const SD = variant === 'southdakota';
  const H = new Hull({
    L: 207, B: 33, T: 10.7, dMid: 7.8, dBow: 11.6, dStern: 7.2, camber: 0.25,
    fb: 0.34, fbd: 0.28, fs: 0.17, fsd: 0.1, stemU: 0.045, sternU: 0.86, sternY: 0.9, nBow: 1.5, nMid: 8, nStern: 3.2, bulb: 1.3,
  });
  const P = new Parts(H);
  P.playable = true;
  P.hullMesh();
  P.deckMesh('teak');
  P.edgeRails();
  const dk = (z, x = 0) => H.deckY(z, x);
  const edge = (z) => H.deckHB(H.u(z));
  const l1 = 10.4, l2 = 13.0, l3 = 15.6;

  // hull: portholes fore and aft of the armour belt, degaussing cable, scuppers
  for (const s of [-1, 1]) {
    P.portholeRow(s, -93, -42, 1.7, 2.4);
    P.portholeRow(s, -88, -56, 3.9, 2.4);
    P.portholeRow(s, 64, 94, 1.6, 2.4);
    P.degauss(s, 0.025, 0.975, 0.95);
    P.scuppers(s, -95, 96, 6, 1);
  }

  // main battery: two triple 16"/45 turrets forward (No. 2 superfiring), one aft
  const T16 = { w: 13.4, len: 16, h: 4.2, guns: 3, bl: 18.5, br: 0.5, gap: 2.8, bbR: 7.0 };
  turret(P, { ...T16, z: -60, deckY: dk(-60), y: dk(-60) + 1.1, rangefinder: false });
  turret(P, { ...T16, z: -38, deckY: dk(-38), y: dk(-38) + 5.0 });
  turret(P, { ...T16, z: 62, deckY: dk(62), y: dk(62) + 1.1, facing: PI });

  // superstructure: 01 deckhouse, conning tower, 02 and 03 levels with sponsons
  P.block(-14, 14, 7.0, l1, -34, 46, { c: 2.5, solid: true });
  // conning tower; South Dakota was completed as a fleet flagship with an extra level on it
  const ct = SD ? 2.4 : 0;
  P.cyl(0, l1 - 0.1, -29.5, 4.2, 4.2, 6.0 + ct, 48, { solid: true });
  if (SD) {
    P.cyl(0, l1 + 5.75, -29.5, 4.28, 4.28, 0.12, 48); // the joint of the added level
    for (const a of [-0.9, -0.3, 0.3, 0.9]) P.box(Math.sin(a) * 4.18 - 0.35, Math.sin(a) * 4.18 + 0.35, l1 + 6.9, l1 + 7.1, -29.5 - Math.cos(a) * 4.18 - 0.05, -29.5 - Math.cos(a) * 4.18 + 0.05, { color: DARK });
  }
  P.cyl(0, l1 + 5.0 + ct, -29.5, 4.26, 4.26, 0.45, 48, { color: GLASS, mat: 'glass', open: true });
  P.cyl(0, l1 + 5.9 + ct, -29.5, 4.2, 3.5, 0.5, 48);
  P.block(-1.2, 1.2, l1 + 6.35 + ct, l1 + 7.2 + ct, -32.6, -30.0, { c: 0.4 }); // sighting hood
  P.box(-1.0, 1.0, l1 + 6.75 + ct, l1 + 6.95 + ct, -32.65, -32.55, { color: DARK });
  P.block(-7.5, 7.5, l1 - 0.1, l2, -25, 36, { c: 1.5, solid: true });
  // the twin 5"/38 mounts alternate low (01 level) and high (02 level sponsons) along each side:
  // five per side on Alabama, Indiana and Massachusetts; South Dakota gave up the middle pair
  const FIVE_LOW = SD ? [-24, 22] : [-24, -1, 22];
  const FIVE_HIGH = [-12, 10];
  for (const s of [-1, 1]) {
    for (const zc of FIVE_HIGH) P.block(...span(s, 7.0, 13.8), l1 - 0.1, l2, zc - 3.6, zc + 3.6);
    P.block(...span(s, 7.0, 15.2), l1 - 0.1, l2, 29.5, 38.5, { bottom: true });
    P.block(...span(s, 5.0, 11.4), l2 - 0.1, l3, 23.5, 30.5, { bottom: true });
    // sponson knees under the overhanging platforms
    for (const zc of FIVE_HIGH) for (const dz of [-2.5, 2.5]) P.box(...span(s, 13.4, 13.7), l1 - 1.4, l1 - 0.1, zc + dz - 0.06, zc + dz + 0.06);
    for (const z of [30.5, 37.5]) P.add(new THREE.BoxGeometry(0.12, 2.2, 2.2).rotateZ(s * 0.6).translate(s * 14.3, l1 - 0.6, z));
  }
  P.block(-6, 6, l2 - 0.1, l3, -24, 16, { c: 1.2, solid: true });
  P.block(-5.5, 5.5, l2 - 0.1, l3, 16, 30, { c: 1.2, solid: true });

  // 01 deckhouse portholes between the doors, rafts and ladders
  for (const s of [-1, 1]) {
    for (let z = -30.5; z < 44; z += 3.1) {
      if ([-19, 23, 38].some((d) => Math.abs(z - d) < 1.4) || [-3, 9].some((r) => Math.abs(z - r) < 1.8) || (z > -10 && z < -5)) continue;
      P.wallPort(s, s * 14, 9.0, z);
    }
    for (let z = -22; z < 34; z += 2.6) if (Math.abs(z + 2) > 1.5) P.wallPort(s, s * 7.5, 11.9, z);
  }

  // tower: navigation bridge (04), flag bridge (05), sky control (06), director platform (07)
  let y = l3;
  for (const [hw, z0, z1, top, c] of [[5.2, -24.5, -11, 18.2, 1.8], [4.6, -24, -12, 20.8, 1.6], [3.8, -22.5, -13, 23.4, 1.3], [3.0, -21, -14, 26.0, 1.0]]) {
    P.block(-hw, hw, y - 0.1, top, z0, z1, { c, solid: true });
    y = top;
  }
  P.windows(-5.2, 5.2, 16.5, 17.2, -24.5, -11, 1.8);
  P.windows(-4.6, 4.6, 19.6, 20.3, -24, -12, 1.6);
  P.windows(-3.8, 3.8, 22.3, 22.9, -22.5, -13, 1.3);
  P.box(-7.6, 7.6, 18.2, 18.45, -22.6, -19.4);
  for (const s of [-1, 1]) {
    // bridge wings with splinter shields, running lights and signal lamps
    P.box(...span(s, 7.45, 7.6), 18.45, 19.5, -22.6, -19.4);
    P.box(...span(s, 4.6, 7.6), 18.45, 19.5, -22.6, -22.45);
    P.navLight(s * 7.66, 18.7, -20.3, s > 0 ? NAV_GREEN : NAV_RED);
    P.signalLamp(s * 6.7, 18.45, -21.7, 0);
    // sky lookout platforms on the 06 level
    P.box(...span(s, 3.7, 5.6), 23.25, 23.45, -20.5, -16.5);
    P.box(...span(s, 5.45, 5.6), 23.45, 24.45, -20.5, -16.5);
    P.signalLamp(s * 4.8, 23.45, -19.6, s * 0.4);
    // ladders up the tower
    P.ladder(v3(s * 6.4, l3, -11.6), v3(s * 5.0, 18.2, -11.6));
  }
  mk38(P, 0, 26.0, -17.5);

  // foremast: tripod, SK bedspring, SG on top, yards and signal halyards
  P.tube(v3(0, 26, -12.4), v3(0, 43.6, -12.4), 0.3);
  P.tube(v3(-2.6, 23.4, -14.2), v3(0, 33.5, -12.4), 0.18);
  P.tube(v3(2.6, 23.4, -14.2), v3(0, 33.5, -12.4), 0.18);
  P.box(-1.8, 1.8, 35.1, 35.35, -14.4, -10.6);
  P.railLine([v3(-1.8, 35.35, -14.4), v3(1.8, 35.35, -14.4), v3(1.8, 35.35, -10.6), v3(-1.8, 35.35, -10.6), v3(-1.8, 35.35, -14.4)], 0.9);
  bedspring(P, 0, 38.3, -13.6, 5.2);
  P.box(-0.9, 0.9, 41.6, 41.8, -13.3, -11.5);
  sgRadar(P, 0, 41.8, -12.4);
  P.tube(v3(-6.5, 32.6, -12.4), v3(6.5, 32.6, -12.4), 0.11);
  P.tube(v3(-3.8, 29.2, -12.4), v3(3.8, 29.2, -12.4), 0.08);
  for (const s of [-1, 1]) {
    for (const [xa, xb] of [[6.3, 7.0], [5.0, 6.0], [3.6, 4.8]]) P.line(v3(s * xa, 32.5, -12.4), v3(s * xb, 18.6, -21.2));
    P.line(v3(s * 3.6, 29.1, -12.4), v3(s * 4.2, 23.6, -18));
  }
  P.line(v3(0, 43.4, -12.4), v3(0, dk(-101.6) + 5.0, -101.6)); // jackstay to the jackstaff
  mk37(P, 0, l3, -7.5);

  // single stack faired into the superstructure, searchlight platforms on its sides
  funnel(P, { z: 3, y0: l3 - 0.2, y1: 30.5, rx: 4.0, rz: 6.0, rake: 1.6, pipes: 2 });
  for (const s of [-1, 1]) {
    P.box(...span(s, 3.4, 6.8), 21.8, 22.05, 3.4, 9.0);
    P.railLine([v3(s * 3.9, 22.05, 3.4), v3(s * 6.8, 22.05, 3.4), v3(s * 6.8, 22.05, 9.0), v3(s * 3.9, 22.05, 9.0)], 0.95);
    searchlight(P, s * 5.6, 22.05, 4.6, -s * HALF);
    searchlight(P, s * 5.6, 22.05, 7.8, -s * HALF);
    P.ladder(v3(s * 5.8, l3, 11.6), v3(s * 5.8, 21.8, 8.6), 0.55);
  }

  // aft fire control tower: Mk 37 forward, Mk 38 aft; mainmast with SG and the ensign
  P.block(-3.4, 3.4, l3 - 0.1, 19.0, 17.5, 24.5, { c: 0.9, solid: true });
  mk37(P, 0, 19.0, 21.2, PI);
  P.block(-2.6, 2.6, l3 - 0.1, 21.6, 24.5, 29.5, { c: 0.7, solid: true });
  mk38(P, 0, 21.6, 27.0, PI, 0.85);
  for (const s of [-1, 1]) P.ladder(v3(s * 4.4, l3, 26.5), v3(s * 3.45, 19.0, 23.4), 0.55);
  P.tube(v3(0, l3, 15.2), v3(0, 34.6, 15.2), 0.26);
  for (const s of [-1, 1]) P.tube(v3(s * 2.4, l3, 16.8), v3(0, 26, 15.2), 0.15);
  P.tube(v3(-4.6, 28.6, 15.2), v3(4.6, 28.6, 15.2), 0.1);
  P.box(-1.1, 1.1, 33.8, 34.0, 14.2, 16.2);
  sgRadar(P, 0, 34.0, 15.2);
  P.tube(v3(0, 29.8, 15.2), v3(0, 31.7, 19.9), 0.07);
  P.ensign(0, 31.7, 19.9);
  for (const s of [-1, 1]) P.line(v3(s * 4.4, 28.5, 15.2), v3(s * 4.0, l3, 22.0));

  // secondary battery: twin 5"/38 Mk 28 mounts, 10 on Alabama, 8 on South Dakota
  for (const s of [-1, 1]) {
    for (const z of FIVE_LOW) P.sideMount('5in-twin', s * 11.0, l1 + 0.55, z);
    for (const z of FIVE_HIGH) P.sideMount('5in-twin', s * 10.6, l2 + 0.55, z);
  }

  // 40mm: Alabama carried twelve quad Bofors after her November 1943 refit (none on the
  // forecastle: the two planned there in 1945 were judged too wet and never fitted). Six a side:
  // main deck abreast No. 2 turret (41/42), 01 level forward corners (43/44), 03 level aft (45/46),
  // 02 level sponsons aft (47/48), 01 level aft corners (49/50), main deck abreast No. 3 turret (51/52).
  for (const s of [-1, 1]) {
    P.deckSide('40mm-quad', s * 12.2, -45, 1.9);
    // the forward corners: Mount 43 can bear well forward past the conning tower
    if (s < 0) P.sideMount('40mm-quad', s * 10.6, l1, -30.2, 1.9);
    else P.mount('40mm-quad', 10.6, l1, -30.2, -0.7, [-2.0, 0.3]);
    P.sideMount('40mm-quad', s * 8.2, l3, 27, 1.9);
    P.mount('40mm-quad', s * 11.6, l2, 34, -s * HALF, s > 0 ? STBD(1.8) : PORT(1.8));
    P.sideMount('40mm-quad', s * 11.0, l1, 43, 1.9);
    P.deckSide('40mm-quad', s * 12.6, 53, 1.9);
  }
  if (SD) {
    // South Dakota had seventeen quads by 1944: also on No. 3 turret's roof, in the 01 level
    // space left by her missing 5" pair, and a pair on the forecastle
    P.mount('40mm-quad', 0, dk(62) + 1.1 + 4.2, 57.5, PI, AFT(2.2));
    for (const s of [-1, 1]) {
      P.sideMount('40mm-quad', s * 11.0, l1, -1, 1.9);
      P.deckMount('40mm-quad', s * 4.6, -84, s > 0 ? -0.5 : 0.5, s > 0 ? [-2.6, 0.9] : [-0.9, 2.6]);
    }
  }

  // 20mm singles (about fifty in mid-1944): deck edges fore and aft, a splinter-shielded gallery
  // amidships, the fantail and the forward 02 level
  for (const s of [-1, 1]) {
    for (const z of [-90, -80, -68, -56, 60, 68, 78]) P.deckSide('20mm', s * (edge(z) - 1.7), z);
    for (const z of [-26, -19, -12, -5, 2, 9, 16]) P.deckSide('20mm', s * 15.2, z);
    P.deckSide('20mm', s * 9.5, 87);
    P.sideMount('20mm', s * 6.8, l2, -24);
    for (let z = -28.5; z < 18.5; z += 4.7) {
      const zm = z + 2.35;
      P.box(...span(s, 16.22, 16.32), dk(zm, 16.3) - 0.05, dk(zm, 16.3) + 1.05, z, z + 4.72);
      P.box(...span(s, 16.0, 16.32), dk(zm, 16.3) + 0.98, dk(zm, 16.3) + 1.06, z, z + 4.72);
    }
  }
  if (SD) {
    // five 20mm on No. 2 turret's roof (South Dakota, 1943)
    const ty = dk(-38) + 5.0 + 4.2;
    for (const [x, z] of [[-4.2, -40], [-1.4, -41], [1.4, -41], [4.2, -40], [0, -35.5]]) P.mount('20mm', x, ty, z, 0, [-2.6, 2.6]);
  }

  // a single Oerlikon on the fantail (Alabama's 20mm were all singles in 1944)
  P.deckMount('20mm', 0, 95, PI, AFT(2.4));

  // forecastle: ground tackle forward of the breakwater, anchors, jackstaff
  groundTackle(P, H, -97, 3.8, -81, 3.4);
  anchors(P, H, 0.035);
  breakwater(P, H, -76, 11, 3.6);
  P.tube(v3(0, dk(-101.6), -101.6), v3(0, dk(-101.6) + 5.0, -101.6), 0.06);
  P.mooring([-84, -50, 50, 84]);
  for (const s of [-1, 1]) {
    vent(P, s * 7.5, dk(-75, 7.5), -75);
    vent(P, s * 5.0, l1, 41);
    vent(P, s * 3.0, l1, 44.5);
    P.gooseneck(s * 10, dk(72, 10), 72, s * HALF);
    P.gooseneck(s * 6, dk(-64, 6), -64, PI);
    // Carley floats on the deckhouse and tower sides
    for (const z of [-3, 9]) raft(P, ...span(s, 14.0, 14.4), 8.5, z);
    raft(P, ...span(s, 7.5, 7.9), 11.1, 14.5);
    raft(P, ...span(s, 5.2, 5.6), 16.3, -18.5);
    // ladders: main deck to the 01 level, 01 to 02
    P.ladder(v3(s * 15.9, dk(-7.5, 15.9), -7.5), v3(s * 14.05, l1, -7.5));
    P.ladder(v3(s * 9.9, l1, 14.6), v3(s * 7.55, l2, 14.6));
  }

  // fantail: two catapults with a Kingfisher, aircraft crane
  for (const s of [-1, 1]) catapult(P, s * 6.2, dk(84, 6.2), 84, PI + s * 0.32, 20);
  {
    // Alabama embarked up to three OS2U Kingfishers; one sits on the starboard catapult
    const a = 0.32, d = 13;
    kingfisher(P, 6.2 + Math.sin(a) * d, dk(84, 6.2) + 3.75, 84 + Math.cos(a) * d, PI + a);
  }
  crane(P, -7.5, dk(96, -7.5), 96, 0, 11, 0.5);

  // doors
  for (const s of [-1, 1]) {
    for (const z of [-19, 23, 38]) P.door(s, s * 14.0, dk(z, 14) + 0.05, z);
    for (const z of [-18, -1, 24]) P.door(s, s * 7.5, l1, z);
    P.door(s, s * 6.0, l2, -2);
  }

  // railings
  P.railLoop(rrect(-13.9, 13.9, -33.9, 45.9, 2.4), l1);
  for (const s of [-1, 1]) {
    P.railLine([v3(s * 7.6, l2, 38.4), v3(s * 15.1, l2, 38.4), v3(s * 15.1, l2, 29.6), v3(s * 7.6, l2, 29.6)]);
    P.railLine([v3(s * 4.6, 18.45, -22.5), v3(s * 7.5, 18.45, -22.5), v3(s * 7.5, 18.45, -19.5), v3(s * 4.6, 18.45, -19.5)]);
    for (const zc of FIVE_HIGH) P.railLine([v3(s * 13.7, l2, zc - 3.5), v3(s * 13.7, l2, zc + 3.5)]);
  }

  P.furnish();
  const ha = H.z(0.035);
  return P.finish({
    deckAt: (z) => H.deckY(z),
    dazH: 34,
    lenHalf: H.L / 2,
    deck: 'teak',
    hawse: new THREE.Vector4(ha, H.deckH(0.035) - 1.4, 0, 1),
    scupper: new THREE.Vector2(6, 1),
  });
}

// ---------------------------------------------------------------- Essex class carrier

function buildCV() {
  const H = new Hull({
    L: 250, B: 28, T: 8.7, dMid: 8.4, dBow: 13.2, dStern: 8.6, camber: 0.2,
    fb: 0.28, fbd: 0.2, fs: 0.15, fsd: 0.08, stemU: 0.04, sternU: 0.88, sternY: 1.2, nBow: 1.5, nMid: 7, nStern: 3.5,
  });
  const P = new Parts(H);
  P.hullMesh();
  P.deckMesh('steel');
  const dk = (z, x = 0) => H.deckY(z, x);
  const FD = 17.6, FB = 16.9;
  const rand = mulberry32(19);

  for (const s of [-1, 1]) {
    P.portholeRow(s, -118, -74, 1.5, 2.4);
    P.portholeRow(s, -112, -84, 3.3, 2.4);
    P.degauss(s, 0.03, 0.97, 1.0);
    P.scuppers(s, -118, 120, 6, 1);
  }

  // hangar with open bays between the hangar deck and the flight deck, roller curtains part drawn
  P.block(-13.6, 13.6, 8.0, FB, -100, 112, { solid: true });
  for (const s of [-1, 1]) {
    for (let z = -88; z <= 100; z += 13) {
      if (s < 0 && z > -12 && z < 18) continue; // deck-edge elevator
      P.box(...span(s, 13.55, 13.68), 10.0, 15.2, z - 4.6, z + 4.6, { color: DARK });
      const f = rand() < 0.35 ? 1 : 0.15 + rand() * 0.55;
      const yb = 15.2 - 5.2 * f;
      P.box(...span(s, 13.66, 13.72), yb, 15.2, z - 4.55, z + 4.55, { color: TINT, paint: 1 });
      for (let yy = yb + 0.35; yy < 15.2; yy += 0.35) P.box(...span(s, 13.71, 13.74), yy - 0.03, yy, z - 4.55, z + 4.55, { color: SHADE, paint: 1 });
      // frames between the bays
      P.box(...span(s, 13.6, 13.85), 9.8, 15.5, z + 6.0, z + 6.9);
    }
  }

  // flight deck, deck-edge elevator, overhang supports
  const fd = [[-7, -133], [7, -133], [14.5, -119], [16, -102], [16, 124], [14, 133], [-14, 133], [-16, 124], [-16, -102], [-14.5, -119]];
  P.add(prismGeo(fd, null, FB, FD, { top: false, bottom: true }));
  P.deckPoly(fd, FD);
  P.boxes.push({ min: v3(-16, 8, -133), max: v3(16, FD, 133) });
  const elev = rrect(-25, -16, -4, 10);
  P.add(prismGeo(elev, null, FB, FD, { top: false, bottom: true }));
  P.deckPoly(elev, FD);
  for (const z of [-2, 4, 8]) P.tube(v3(-13.7, 12.5, z), v3(-24, FB - 0.05, z), 0.12);
  P.box(-24.6, -16, FB - 0.45, FB, -3.8, -3.4);
  P.box(-24.6, -16, FB - 0.45, FB, 9.4, 9.8);
  for (const s of [-1, 1]) {
    P.tube(v3(s * 4.5, dk(-112), -112), v3(s * 6, FB, -116), 0.35);
    P.tube(v3(s * 2.5, dk(-121), -121), v3(s * 4, FB, -128), 0.3);
    P.tube(v3(s * 10, 6, 117), v3(s * 11, FB, 128), 0.35);
  }
  // flight deck edge: gutter lip and deck-edge stanchions for the safety nets
  for (const s of [-1, 1]) {
    P.box(...span(s, 15.9, 16.05), FD, FD + 0.12, -102, 124);
    for (let z = -100; z < 124; z += 4) P.box(...span(s, 16.0, 16.9), FD - 0.35, FD - 0.25, z - 0.04, z + 0.04, { color: STEEL });
  }

  // galleries and catwalks just below the flight deck edge
  const gallery = (s, z0, z1, yG = 15.0) => {
    P.box(...span(s, 15.4, 21.6), yG - 0.45, yG, z0, z1);
    P.floors.push({ x0: s > 0 ? 15.4 : -21.6, x1: s > 0 ? 21.6 : -15.4, z0, z1, y: yG });
    P.railLine([v3(s * 21.5, yG, z0), v3(s * 21.5, yG, z1)]);
    for (let z = z0 + 2; z < z1; z += 8) P.tube(v3(s * 13.8, yG - 4.5, z), v3(s * 20.5, yG - 0.4, z), 0.15);
  };
  gallery(-1, -64, -44);
  gallery(-1, 46, 66);
  gallery(-1, -30, 36);
  gallery(1, 56, 80);
  for (const s of [-1, 1]) {
    for (const [z0, z1] of [[-100, -66], [84, 118]]) {
      P.box(...span(s, 15.8, 18.4), 15.3, 15.6, z0, z1);
      P.floors.push({ x0: s > 0 ? 15.8 : -18.4, x1: s > 0 ? 18.4 : -15.8, z0, z1, y: 15.6 });
      P.railLine([v3(s * 18.35, 15.6, z0), v3(s * 18.35, 15.6, z1)]);
      for (let z = z0 + 3; z < z1; z += 7) P.tube(v3(s * 13.8, 12.2, z), v3(s * 17.6, 15.3, z), 0.1);
    }
  }
  P.box(-11, 11, 13.6, 14.2, 122, 132.5);
  P.floors.push({ x0: -11, x1: 11, z0: 122, z1: 132.5, y: 14.2 });
  P.railLine([v3(-11, 14.2, 132.4), v3(11, 14.2, 132.4)]);

  // island: bridge levels, pri-fly, raked stack, tripod mast with SK, SC and SG, two Mk 37s
  P.block(13.0, 19.2, FD - 0.1, 21.2, -30, 26, { c: 1.0, solid: true, bottom: true });
  P.block(14.0, 19.0, 21.1, 24.0, -22, 16, { c: 0.8, solid: true });
  P.windows(14.0, 19.0, 22.9, 23.6, -22, 16, 0.8);
  P.block(14.6, 18.8, 23.9, 26.6, -18, 8, { c: 0.8, solid: true });
  P.windows(14.6, 18.8, 25.5, 26.2, -18, 8, 0.8);
  P.block(14.2, 18.8, 21.1, 23.3, 16, 18.6, { c: 0.5 }); // primary flight control
  P.box(14.3, 18.7, 22.1, 22.9, 18.6, 18.66, { color: GLASS, mat: 'glass' });
  for (let z = -27; z < 24; z += 3.4) P.wallPort(-1, 13.0, 19.4, z);
  for (const z of [-24, -8, 10]) P.door(-1, 13.0, FD, z);
  P.box(12.2, 13.0, 23.9, 24.1, -20, -12); // bridge wing to port
  P.box(12.2, 12.3, 24.1, 25.0, -20, -12);
  P.navLight(12.15, 24.2, -16, NAV_RED);
  P.navLight(19.1, 24.2, -16, NAV_GREEN);
  P.signalLamp(12.8, 24.1, -19, 0);
  P.box(14.6, 14.7, 26.6, 27.6, -10, 8);
  P.box(18.7, 18.8, 26.6, 27.6, -10, 8);
  funnel(P, { x: 16.8, z: 2, y0: 24, y1: 33.5, rx: 1.9, rz: 4.6, rake: 2.2, pipes: 1, fairing: false });
  P.tube(v3(16.6, 26.6, -10), v3(16.6, 45.2, -10), 0.3);
  P.tube(v3(15.0, 26.6, -13), v3(16.6, 36, -10), 0.18);
  P.tube(v3(18.2, 26.6, -13), v3(16.6, 36, -10), 0.18);
  P.box(15.1, 18.1, 37.0, 37.25, -12.2, -8.6);
  bedspring(P, 16.6, 40.2, -11.0, 5.0);
  P.box(15.8, 17.4, 43.4, 43.6, -10.8, -9.2);
  sgRadar(P, 16.6, 43.6, -10);
  P.box(15.3, 17.9, 33.3, 33.5, -7.6, -4.8);
  bedspring(P, 16.6, 35.2, -6.2, 3.0);
  P.tube(v3(12.0, 35, -10), v3(21.2, 35, -10), 0.1);
  for (const s of [-1, 1]) P.line(v3(16.6 + s * 4.4, 34.9, -10), v3(16.6 + s * 2.2, 26.7, -17.5));
  P.tube(v3(16.6, 31, -10), v3(16.6, 33, -5.5), 0.07);
  P.ensign(16.6, 33, -5.5);
  mk37(P, 16.6, 26.6, -14.5);
  mk37(P, 16.8, 24.0, 12.5, PI);
  crane(P, 15.5, FD, 28, PI, 12, 0.6);
  // hinged radio masts at the starboard deck edge, swung out
  for (const z of [-80, -45, 95, 110]) P.tube(v3(16.2, FD - 0.6, z), v3(16.2 + 9 * Math.sin(1.15), FD - 0.6 + 9 * Math.cos(1.15), z), 0.1);

  // 5"/38: twin mounts fore and aft of the island, singles on the port galleries
  for (const z of [-46, -34, 34, 46]) P.mount('5in-twin', 12.6, FD + 0.55, z, -HALF, STBD(1.9));
  for (const z of [-60, -48, 50, 62]) P.mount('5in-single', -18.4, 15.4, z, HALF, PORT(1.8));

  // 40mm quads
  P.mount('40mm-quad', 16.2, 21.2, -26.5, -HALF, STBD(1.9));
  P.mount('40mm-quad', 16.2, 21.2, 22.5, -HALF, STBD(1.9));
  for (const s of [-1, 1]) P.deckMount('40mm-quad', s * 4.2, -112, 0, FWD(1.9));
  for (const z of [-26, -12, 18, 32]) P.mount('40mm-quad', -18.6, 15.0, z, HALF, PORT(1.8));
  for (const z of [60, 76]) P.mount('40mm-quad', 18.6, 15.0, z, -HALF, STBD(1.8));
  for (const s of [-1, 1]) P.mount('40mm-quad', s * 6.5, 14.2, 128, PI, AFT(1.9));

  // 20mm on the catwalks
  for (const s of [-1, 1]) for (const z of [-96, -82, -70, 88, 100, 112]) P.sideMount('20mm', s * 17.1, 15.6, z);

  // Hellcats spotted aft, wings spread, facing forward
  for (let i = 0; i < 6; i++) {
    const z = 54 + i * 12.5;
    P.parking.push({ pos: v3(-7.0, FD + 1.9, z), yaw: 0 });
    P.parking.push({ pos: v3(6.5, FD + 1.9, z + 6), yaw: 0 });
  }

  // forecastle under the flight deck overhang
  anchors(P, H, 0.035);
  for (const s of [-1, 1]) {
    capstan(P, s * 3.0, dk(-106, 3), -106);
    vent(P, s * 8.0, dk(-100, 8), -100);
    bollard(P, s * 6.5, dk(-102, 6.5), -102);
    P.cyl(s * 2.6, dk(-117, 2.6) - 0.1, -117, 0.6, 0.6, 0.22, 14, { color: DARK });
  }

  P.furnish();
  const deckAt = (z) => (z > -133 && z < 133 ? FD : H.deckY(z));
  return P.finish({
    deckAt,
    dazH: 36,
    lenHalf: 133,
    deck: 'flight',
    hawse: new THREE.Vector4(H.z(0.035), H.deckH(0.035) - 1.4, 0, 1),
    scupper: new THREE.Vector2(6, 1),
  });
}

// ---------------------------------------------------------------- Cleveland class light cruiser

function buildCL() {
  const H = new Hull({
    L: 186, B: 20.2, T: 7.5, dMid: 6.4, dBow: 9.8, dStern: 5.9, camber: 0.18,
    fb: 0.3, fbd: 0.24, fs: 0.16, fsd: 0.09, stemU: 0.045, sternU: 0.87, sternY: 0.8, nBow: 1.5, nMid: 7, nStern: 3.2,
  });
  const P = new Parts(H);
  P.hullMesh();
  P.deckMesh('teak');
  P.edgeRails();
  const dk = (z, x = 0) => H.deckY(z, x);
  const edge = (z) => H.deckHB(H.u(z));
  const l1 = 9.0, l2 = 11.6, l3 = 14.2, l4 = 16.8;

  for (const s of [-1, 1]) {
    P.portholeRow(s, -86, -48, 1.5, 2.3);
    P.portholeRow(s, -80, -55, 3.2, 2.3);
    P.portholeRow(s, 48, 86, 1.4, 2.3);
    P.degauss(s, 0.03, 0.97, 0.85);
    P.scuppers(s, -86, 86, 6, 1);
  }

  // four triple 6"/47 turrets, two forward and two aft, superfiring pairs
  const T6 = { w: 8.4, len: 10.5, h: 3.1, guns: 3, bl: 8.6, br: 0.24, gap: 1.55, bbR: 4.0 };
  turret(P, { ...T6, z: -54, deckY: dk(-54), y: dk(-54) + 0.8, rangefinder: false });
  turret(P, { ...T6, z: -42, deckY: dk(-42), y: dk(-42) + 3.1 });
  turret(P, { ...T6, z: 46, deckY: dk(46), y: dk(46) + 3.1, facing: PI });
  turret(P, { ...T6, z: 58, deckY: dk(58), y: dk(58) + 0.8, facing: PI, rangefinder: false });

  // superstructure
  P.block(-7.4, 7.4, 5.8, l1, -35.5, 39.5, { c: 1.6, solid: true });
  P.block(-6, 6, l1 - 0.1, l2, -29, -14, { c: 1.2, solid: true });
  P.block(-4.6, 4.6, l2 - 0.1, l3, -28, -17, { c: 1.0, solid: true });
  P.windows(-4.6, 4.6, 13.2, 13.9, -28, -17, 1.0);
  P.block(-3.4, 3.4, l3 - 0.1, l4, -27, -19, { c: 0.8, solid: true });
  P.windows(-3.4, 3.4, 15.9, 16.4, -27, -19, 0.8);
  P.box(-7.8, 7.8, l2, l2 + 0.25, -26.5, -23);
  for (const s of [-1, 1]) {
    P.box(...span(s, 7.65, 7.8), l2 + 0.25, l2 + 1.25, -26.5, -23);
    P.navLight(s * 7.85, l2 + 0.4, -24, s > 0 ? NAV_GREEN : NAV_RED);
    P.signalLamp(s * 7.0, l2 + 0.25, -25.6, 0);
    for (let z = -33; z < 38; z += 2.9) if (![-20, 8, 22].some((d) => Math.abs(z - d) < 1.4) && ![-3, 10].some((r) => Math.abs(z - r) < 1.8)) P.wallPort(s, s * 7.4, 7.6, z);
    P.ladder(v3(s * 7.9, dk(-13, 7.9), -13), v3(s * 6.05, l1, -13));
  }
  mk37(P, 0, l4, -23);
  P.block(-2.4, 2.4, l4 - 0.1, l4 + 0.6, -19.6, -16.2, { c: 0.5 });
  mk38(P, 0, l4 + 0.6, -17.9, 0, 0.62);
  // tripod foremast, SK and SG radars
  P.tube(v3(0, l2, -15.5), v3(0, 32, -15.5), 0.28);
  for (const s of [-1, 1]) P.tube(v3(s * 2.6, l1, -12.5), v3(0, 24, -15.5), 0.18);
  P.box(-1.5, 1.5, 25.0, 25.25, -17, -14);
  bedspring(P, 0, 27.6, -16.2, 4.2);
  P.box(-0.8, 0.8, 30.6, 30.8, -16.3, -14.7);
  sgRadar(P, 0, 30.8, -15.5);
  P.tube(v3(-5, 22.5, -15.5), v3(5, 22.5, -15.5), 0.1);
  for (const s of [-1, 1]) P.line(v3(s * 4.8, 22.4, -15.5), v3(s * 7.0, l2 + 0.3, -25.8));
  // two stacks
  funnel(P, { z: -6, y0: l1 - 0.2, y1: 21.5, rx: 2.3, rz: 3.6, rake: 1.2, pipes: 1 });
  funnel(P, { z: 12, y0: l1 - 0.2, y1: 21.0, rx: 2.3, rz: 3.6, rake: 1.2, pipes: 1 });
  for (const s of [-1, 1]) {
    P.box(...span(s, 2.2, 4.4), 16.2, 16.4, 1.5, 5.5);
    searchlight(P, s * 3.4, 16.4, 3.5, -s * HALF);
  }
  // aft superstructure, director and mainmast
  P.block(-4.5, 4.5, l1 - 0.1, l2, 24, 32.5, { c: 1.0, solid: true });
  mk37(P, 0, l2, 28.2, PI);
  P.tube(v3(0, l1, 22), v3(0, 26.5, 22), 0.24);
  P.tube(v3(-4, 23, 22), v3(4, 23, 22), 0.1);
  P.box(-0.8, 0.8, 26.5, 26.7, 21.2, 22.8);
  sgRadar(P, 0, 26.7, 22, PI);
  P.tube(v3(0, 21, 22), v3(0, 22.8, 26.2), 0.06);
  P.ensign(0, 22.8, 26.2, 2.0, 1.05);

  // 6 twin 5"/38: centerline fore and aft, two pairs amidships
  P.mount('5in-twin', 0, l1 + 0.55, -32.5, 0, FWD(2.6));
  P.mount('5in-twin', 0, l1 + 0.55, 36.5, PI, AFT(2.6));
  for (const s of [-1, 1]) {
    P.sideMount('5in-twin', s * 5.6, l1 + 0.55, 3);
    P.sideMount('5in-twin', s * 5.6, l1 + 0.55, 18.5);
  }

  // 40mm: quads on sponsons, twins at the bow and stern
  for (const s of [-1, 1]) {
    for (const z of [-10, 27]) {
      P.block(...span(s, 7.0, 13.6), l1 - 0.6, l1, z - 3.4, z + 3.4, { bottom: true });
      P.sideMount('40mm-quad', s * 10.4, l1, z, 1.9);
      P.railLine([v3(s * 7.4, l1, z - 3.35), v3(s * 13.55, l1, z - 3.35), v3(s * 13.55, l1, z + 3.35), v3(s * 7.4, l1, z + 3.35)]);
    }
  }
  P.deckMount('40mm-twin', 0, -70, 0, FWD(2.5));
  P.deckMount('40mm-twin', 0, 78, PI, AFT(2.5));

  // 20mm
  for (const s of [-1, 1]) {
    for (const z of [-62, -46, 50, 64, 72]) P.deckSide('20mm', s * (edge(z) - 1.5), z);
    P.sideMount('20mm', s * 7.0, l2 + 0.25, -24.7);
  }

  // fantail: catapults, Kingfisher, crane
  for (const s of [-1, 1]) catapult(P, s * 4.8, dk(68, 4.8), 68, PI + s * 0.25, 15);
  kingfisher(P, 4.8 + Math.sin(0.25) * 10, dk(68, 4.8) + 3.75, 68 + Math.cos(0.25) * 10, PI + 0.25);
  crane(P, 0, dk(88), 88, PI, 9, 0.6);

  groundTackle(P, H, -84, 3.2, -62, 2.4);
  anchors(P, H, 0.035);
  P.tube(v3(0, dk(-92), -92), v3(0, dk(-92) + 4.0, -92), 0.05);
  P.mooring([-75, 40, 70], 0.8);
  for (const s of [-1, 1]) {
    raft(P, ...span(s, 7.4, 7.8), 6.9, -3);
    raft(P, ...span(s, 7.4, 7.8), 6.9, 10);
    vent(P, s * 3.5, l1, 34);
    P.gooseneck(s * 5, dk(-60, 5), -60, PI);
    for (const z of [-20, 8, 22]) P.door(s, s * 7.4, dk(z, 7.4) + 0.05, z);
  }
  P.railLoop(rrect(-7.3, 7.3, -35.4, 39.4, 1.5), l1);

  P.furnish();
  return P.finish({
    deckAt: (z) => H.deckY(z),
    dazH: 24,
    lenHalf: H.L / 2,
    deck: 'teak',
    hawse: new THREE.Vector4(H.z(0.035), H.deckH(0.035) - 1.4, 0, 1),
    scupper: new THREE.Vector2(6, 1),
  });
}

// ---------------------------------------------------------------- Fletcher class destroyer

function buildDD() {
  const H = new Hull({
    L: 115, B: 12, T: 4.2, dMid: 4.2, dBow: 7.6, dStern: 3.7, camber: 0.12,
    fb: 0.32, fbd: 0.26, fs: 0.14, fsd: 0.06, stemU: 0.05, sternU: 0.88, sternY: 0.6, nBow: 1.4, nMid: 5, nStern: 3.0, knuckle: 1,
  });
  const P = new Parts(H);
  P.hullMesh();
  P.deckMesh('steel');
  P.edgeRails();
  const dk = (z, x = 0) => H.deckY(z, x);
  const edge = (z) => H.deckHB(H.u(z));

  for (const s of [-1, 1]) {
    P.portholeRow(s, -39, -28, 1.3, 1.9);
    P.portholeRow(s, -37, -30, 2.5, 1.9);
    P.portholeRow(s, 24, 50, 1.2, 1.9);
    P.degauss(s, 0.035, 0.965, 0.45);
    P.scuppers(s, -52, 52, 5, 0.5);
  }

  // forward deckhouse and a rounded open bridge
  const fh = dk(-30) + 2.4;
  P.block(-3.4, 3.4, dk(-13) - 0.5, fh, -33, -13, { c: 0.8, solid: true });
  P.block(-3.0, 3.0, fh - 0.1, fh + 2.6, -26, -14, { c: 1.4, solid: true });
  P.windows(-3.0, 3.0, fh + 1.7, fh + 2.3, -26, -14, 1.4);
  P.block(-2.4, 2.4, fh + 2.5, fh + 4.1, -24, -16, { c: 0.6, solid: true });
  P.box(-5, 5, fh + 2.6, fh + 2.8, -25.5, -22.5);
  for (const s of [-1, 1]) {
    P.box(...span(s, 4.85, 5.0), fh + 2.8, fh + 3.8, -25.5, -22.5);
    P.navLight(s * 5.05, fh + 2.9, -23.5, s > 0 ? NAV_GREEN : NAV_RED);
    P.signalLamp(s * 4.3, fh + 2.8, -24.9, 0);
    for (let z = -32; z < -14; z += 2.2) if (Math.abs(z + 20) > 1.2) P.wallPort(s, s * 3.4, fh - 1.1, z);
    P.ladder(v3(s * 4.3, dk(-12, 4.3), -12), v3(s * 3.45, fh, -14.5), 0.5);
  }
  mk37(P, 0, fh + 4.1, -20);
  P.tube(v3(0, fh + 4.1, -15), v3(0, fh + 20.2, -15), 0.18);
  for (const s of [-1, 1]) P.tube(v3(s * 1.8, fh + 2.6, -16.5), v3(0, fh + 11, -15), 0.1);
  P.tube(v3(-3.8, fh + 12.5, -15), v3(3.8, fh + 12.5, -15), 0.08);
  for (const s of [-1, 1]) P.line(v3(s * 3.6, fh + 12.4, -15), v3(s * 4.7, fh + 2.9, -25.2));
  bedspring(P, 0, fh + 15.0, -15.5, 2.8);
  P.box(-0.7, 0.7, fh + 17.6, fh + 17.75, -15.7, -14.3);
  sgRadar(P, 0, fh + 17.75, -15);
  P.tube(v3(0, fh + 9, -15), v3(0, fh + 10.5, -11.5), 0.05);
  P.ensign(0, fh + 10.5, -11.5, 1.7, 0.9);

  // amidships deckhouse with two raked stacks and the torpedo tubes
  const mh = dk(0) + 2.4;
  P.block(-2.8, 2.8, dk(0) - 0.5, mh, -10, 14, { c: 0.6, solid: true });
  funnel(P, { z: -5.5, y0: mh - 0.1, y1: mh + 8.2, rx: 1.35, rz: 2.2, rake: 1.1, cap: 0.6, pipes: 1 });
  funnel(P, { z: 7.5, y0: mh - 0.1, y1: mh + 7.8, rx: 1.35, rz: 2.2, rake: 1.1, cap: 0.6, pipes: 1 });
  torpedoTubes(P, mh, 1.0, 6.4);
  torpedoTubes(P, dk(19), 19, 6.4);
  for (const s of [-1, 1]) {
    for (let z = -8.5; z < 13; z += 2.4) P.wallPort(s, s * 2.8, mh - 1.0, z);
    raft(P, ...span(s, 2.8, 3.2), dk(-2) + 0.6, -2);
  }

  // after deckhouse
  const ah = dk(28) + 2.4;
  P.block(-3.0, 3.0, dk(28) - 0.5, ah, 23.5, 33, { c: 0.6, solid: true });
  for (const s of [-1, 1]) P.ladder(v3(s * 3.9, dk(22, 3.9), 22), v3(s * 3.05, ah, 24.2), 0.5);

  // five single 5"/38 mounts
  P.deckMount('5in-single', 0, -38, 0, FWD(2.6));
  P.mount('5in-single', 0, fh + 0.4, -29.5, 0, FWD(2.5));
  P.mount('5in-single', 0, ah + 0.4, 30.5, PI, AFT(2.5));
  P.deckMount('5in-single', 0, 38.5, PI, AFT(2.6));
  P.deckMount('5in-single', 0, 47, PI, AFT(2.6));

  // 40mm twins: platforms abreast the after stack, one on the after deckhouse
  for (const s of [-1, 1]) {
    P.block(...span(s, 2.7, 6.2), mh - 0.4, mh, 10.2, 14.8, { bottom: true });
    P.sideMount('40mm-twin', s * 3.9, mh, 12.5, 1.9);
  }
  P.mount('40mm-twin', 0, ah, 25, PI, AFT(2.2));

  // 20mm singles
  for (const s of [-1, 1]) {
    P.sideMount('20mm', s * 4.2, fh + 2.8, -24);
    for (const z of [-8, 3]) P.deckSide('20mm', s * 4.6, z);
    P.deckSide('20mm', s * (edge(36) - 1.4), 36);
    P.door(s, s * 3.4, dk(-20, 3.4) + 0.05, -20);
    P.door(s, s * 2.8, dk(-7, 2.8) + 0.05, -8);
  }

  // stern: depth charge racks and K-guns
  for (const s of [-1, 1]) {
    dcRack(P, s * 1.5, dk(54), 49.5, 56.5);
    for (const z of [41, 44.5]) kGun(P, s, s * (edge(z) - 1.2), dk(z, edge(z) - 1.2), z);
  }

  groundTackle(P, H, -51, 2.0, -42, 1.4);
  anchors(P, H, 0.04);
  P.mooring([-45, 20, 44], 0.6);

  P.furnish();
  const u = H.u(-46);
  return P.finish({
    deckAt: (z) => H.deckY(z),
    dazH: 14,
    lenHalf: H.L / 2,
    deck: null,
    numBox: new THREE.Vector4(-50, -42, H.deckH(u) - 3.3, H.deckH(u) - 0.7),
    hawse: new THREE.Vector4(H.z(0.04), H.deckH(0.04) - 1.4, 0, 1),
    scupper: new THREE.Vector2(5, 0.5),
  });
}

// ---------------------------------------------------------------- textures

const canvasOf = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

let plankTex = null;
/** Grayscale deck planks along Z: 32 planks per 4 m, staggered butt joints, caulking. */
function plankTexture() {
  if (plankTex) return plankTex;
  const W = 512, H = 2048, c = canvasOf(W, H), ctx = c.getContext('2d');
  const rand = mulberry32(77);
  const pw = W / 32, seg = H / 3;
  for (let i = 0; i < 32; i++) {
    const x0 = i * pw, off = rand() * H;
    for (let k = 0; k < 3; k++) {
      const y0 = (off + k * seg) % H;
      const tone = 150 + rand() * 55;
      for (const yy of [y0, y0 - H]) {
        ctx.fillStyle = `rgb(${tone},${tone},${tone})`;
        ctx.fillRect(x0, yy, pw, seg);
        for (let g = 0; g < 5; g++) {
          const d = rand() * 30 - 15;
          ctx.fillStyle = `rgba(${d > 0 ? 255 : 0},${d > 0 ? 255 : 0},${d > 0 ? 255 : 0},${Math.abs(d) / 200})`;
          ctx.fillRect(x0 + 1 + rand() * (pw - 2), yy, 1, seg);
        }
        ctx.fillStyle = 'rgb(48,44,40)';
        ctx.fillRect(x0, yy, pw, 2);
      }
    }
    ctx.fillStyle = 'rgb(40,37,34)';
    ctx.fillRect(x0, 0, 1.5, H);
  }
  plankTex = new THREE.CanvasTexture(c);
  plankTex.wrapS = plankTex.wrapT = THREE.RepeatWrapping;
  plankTex.colorSpace = THREE.SRGBColorSpace;
  plankTex.anisotropy = 8;
  return plankTex;
}

let railTex = null;
function railTexture() {
  if (railTex) return railTex;
  const c = canvasOf(64, 64), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(30, 0, 4, 64);
  ctx.fillRect(0, 1, 64, 4);
  ctx.fillRect(0, 26, 64, 3);
  ctx.fillRect(0, 48, 64, 3);
  railTex = new THREE.CanvasTexture(c);
  railTex.wrapS = THREE.RepeatWrapping;
  railTex.wrapT = THREE.ClampToEdgeWrapping;
  railTex.colorSpace = THREE.SRGBColorSpace;
  return railTex;
}

/**
 * Measure 32 dazzle: bold angular polygons, one-hot RGB (light / ocean / black)
 * so filtering blends correctly. Top half starboard, bottom half port.
 */
function dazzleTexture(seed) {
  const W = 2048, H = 512, c = canvasOf(W, H), ctx = c.getContext('2d');
  const COL = ['#ff0000', '#00ff00', '#0000ff'];
  for (const half of [0, 1]) {
    const rand = mulberry32(seed * 131 + half * 977 + 5);
    const y0 = half * 256;
    const P = (u, v) => [u * W, y0 + (1 - v) * 256];
    const poly = (pts, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      pts.forEach(([u, v], i) => (i ? ctx.lineTo(...P(u, v)) : ctx.moveTo(...P(u, v))));
      ctx.closePath();
      ctx.fill();
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, W, 256);
    ctx.clip();
    ctx.fillStyle = COL[0];
    ctx.fillRect(0, y0, W, 256);
    let u = -0.04;
    while (u < 1.04) {
      const w = 0.04 + rand() * 0.1;
      const s1 = (rand() - 0.5) * 0.18, s2 = (rand() - 0.5) * 0.18;
      poly([[u, -0.1], [u + w, -0.1], [u + w + s1, 1.1], [u + s2, 1.1]], COL[1 + Math.floor(rand() * 2)]);
      if (rand() < 0.7) {
        const a = u + rand() * w, b = u + w + 0.02 + rand() * 0.06;
        poly([[a, -0.1], [b, -0.1], [b + (rand() - 0.5) * 0.12, 0.2 + rand() * 0.6]], COL[Math.floor(rand() * 3)]);
      }
      if (rand() < 0.5) {
        const a = u + rand() * w, h0 = 0.35 + rand() * 0.4;
        poly([[a, h0], [a + 0.05 + rand() * 0.08, h0 + (rand() - 0.5) * 0.3], [a + 0.03, 1.1], [a - 0.04, 1.1]], COL[Math.floor(rand() * 3)]);
      }
      u += w + 0.015 + rand() * 0.07;
    }
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  return tex;
}

function numberTexture(n) {
  const c = canvasOf(256, 128), ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 112px "Arial Narrow", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 128, 68, 240);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

const BLANK = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
BLANK.needsUpdate = true;

// ---------------------------------------------------------------- materials

const noiseGLSL = /* glsl */ `
float shHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float shNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(shHash(i), shHash(i + vec2(1.0, 0.0)), u.x), mix(shHash(i + vec2(0.0, 1.0)), shHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/**
 * Hull and superstructure paint: camouflage scheme, waterline bands, plating seams and
 * weld beads, rust from scuppers and hawse pipes, funnel soot, non-skid decks; brass and
 * glass fittings get their own response.
 */
function paintMaterial(built, camo, seed, hullNumber) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1 });
  const scheme = camo === 'ms32' ? 2 : camo === 'ms22' ? 1 : 0;
  const num = hullNumber != null && built.numBox;
  const soot = [new THREE.Vector4(), new THREE.Vector4()];
  (built.funnels || []).slice(0, 2).forEach((f, i) => soot[i].set(f.pos.x, f.pos.y, f.pos.z, f.radius * 1.9 + 2));
  const u = {
    uShScheme: { value: scheme },
    uShNavy: { value: PAINT.navy },
    uShHaze: { value: PAINT.haze },
    uShOcean: { value: PAINT.ocean },
    uShLight: { value: PAINT.light },
    uShBlack: { value: PAINT.black },
    uShDeck: { value: PAINT.deck },
    uShBoot: { value: PAINT.boot },
    uShRed: { value: PAINT.red },
    uShRust: { value: PAINT.rust },
    uShLine: { value: built.line },
    uShDazH: { value: built.dazH },
    uShDazU: { value: new THREE.Vector2(built.lenHalf + 10, built.lenHalf * 2 + 20) },
    uShDazzle: { value: scheme === 2 ? dazzleTexture(seed) : BLANK },
    uShNum: { value: num ? numberTexture(hullNumber) : BLANK },
    uShNumOn: { value: num ? 1 : 0 },
    uShNumBox: { value: built.numBox || new THREE.Vector4() },
    uShSoot: { value: soot },
    uShHawse: { value: built.hawse || new THREE.Vector4() },
    uShScupper: { value: built.scupper || new THREE.Vector2(6, 1) },
  };
  patchMaterial(m, 'ship-paint', (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPaint;\nvarying vec3 vShPos;\nvarying vec3 vShNrm;\nvarying float vShPaint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShPos = position;\nvShNrm = normal;\nvShPaint = aPaint;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying vec3 vShPos;
varying vec3 vShNrm;
varying float vShPaint;
uniform int uShScheme;
uniform vec3 uShNavy, uShHaze, uShOcean, uShLight, uShBlack, uShDeck, uShBoot, uShRed, uShRust;
uniform float uShLine, uShDazH, uShNumOn;
uniform vec2 uShDazU, uShScupper;
uniform vec4 uShNumBox, uShHawse;
uniform vec4 uShSoot[2];
uniform sampler2D uShDazzle, uShNum;
${noiseGLSL}
vec3 shScheme(vec3 p, vec3 n) {
  // single exit: D3D's compiler warns about early returns here
  vec3 col = uShNavy;
  if (uShScheme == 2) {
    bool sideFace = abs(n.x) > abs(n.z);
    float side = (sideFace ? n.x : p.x) >= 0.0 ? 0.5 : 0.0;
    float along = sideFace ? p.z : p.z + p.x * sign(n.z) * 0.8;
    vec2 uv = vec2((along + uShDazU.x) / uShDazU.y, side + clamp(p.y / uShDazH, 0.01, 0.99) * 0.5);
    vec3 w = texture2D(uShDazzle, uv).rgb;
    w /= max(w.r + w.g + w.b, 1e-3);
    col = uShLight * w.r + uShOcean * w.g + uShBlack * w.b;
  } else if (uShScheme == 1) {
    col = p.y < uShLine ? uShNavy : uShHaze;
  }
  return col;
}`
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  vec3 n = normalize(vShNrm);
  vec3 p = vShPos;
  vec3 c = diffuseColor.rgb;
  float fw = length(fwidth(p));
  float detail = 1.0 - smoothstep(0.02, 0.09, fw); // fine detail fades out with distance
  bool painted = vShPaint > 0.5 && vShPaint < 1.5;
  if (painted) {
    bool deckFace = n.y > 0.72;
    c *= deckFace ? uShDeck : shScheme(p, n);
    float mott = shNoise(p.xz * 0.11 + p.y * 0.07) * 0.6 + shNoise(p.zy * 0.9 + p.x * 0.3) * 0.4;
    c *= 0.9 + 0.2 * mott;
    if (deckFace) {
      // non-skid: a fine gritty grain
      c *= 1.0 - 0.1 * detail * shHash(floor(p.xz * 45.0));
    } else if (abs(n.y) < 0.6) {
      float along = abs(n.x) > abs(n.z) ? p.z : p.x;
      // plating: strakes every 2.4 m, staggered butts, weld beads catching the light
      float strake = floor(p.y / 2.4);
      float sy = abs(fract(p.y / 2.4 + 0.5) - 0.5) * 2.4;
      float sb = abs(fract(along / 8.5 + strake * 0.37) - 0.5) * 8.5;
      float seam = max(1.0 - smoothstep(0.0, 0.035, sy), (1.0 - smoothstep(0.0, 0.03, sb)) * 0.8);
      c *= 1.0 - 0.08 * seam * detail;
      c *= 1.0 + 0.05 * detail * (1.0 - smoothstep(0.035, 0.08, sy)) * step(0.035, sy);
      // hungry-horse: plating dished slightly between the frames
      c *= 1.0 - 0.025 * detail * sin(along * 6.2832 / 1.22) * sin(along * 6.2832 / 1.22);
      float streak = smoothstep(0.74, 0.95, shNoise(vec2(along * 4.0, p.y * 0.05 + 7.0)));
      streak *= smoothstep(0.45, 0.75, shNoise(vec2(along * 0.2, 3.1)));
      c = mix(c, uShRust * (0.75 + 0.5 * mott), streak * 0.3);
      c *= 1.0 - 0.16 * smoothstep(0.55, 1.0, shNoise(vec2(along * 0.6, p.y * 1.7)));
      // rust runs from the scuppers down the hull
      if (abs(n.x) > 0.6 && p.y < uShLine) {
        float cell = floor((p.z - uShScupper.y) / uShScupper.x + 0.5);
        float sz = abs(fract((p.z - uShScupper.y) / uShScupper.x + 0.5) - 0.5) * uShScupper.x;
        float w = 0.12 + 0.05 * (uShLine - p.y);
        float len = 2.0 + 4.0 * shHash(vec2(cell, 3.0 + sign(n.x)));
        float drip = (1.0 - smoothstep(w * 0.4, w, sz)) * smoothstep(uShLine - len, uShLine - 0.5, p.y);
        drip *= (0.45 + 0.55 * shNoise(vec2(p.z * 3.0, p.y * 0.6))) * step(0.35, shHash(vec2(cell, 9.0 + sign(n.x))));
        c = mix(c, uShRust * vec3(0.7, 0.66, 0.62), drip * 0.33);
      }
      // and heavily from the hawse pipes
      if (uShHawse.w > 0.5 && abs(n.x) > 0.4 && p.y < uShHawse.y && p.y > 0.4) {
        float hw = 0.5 + (uShHawse.y - p.y) * 0.1;
        float hk = 1.0 - smoothstep(hw * 0.35, hw, abs(p.z - uShHawse.x));
        c = mix(c, uShRust * 0.65, hk * (0.55 + 0.45 * shNoise(vec2(p.z * 5.0, p.y * 0.5))) * 0.7);
      }
    }
  }
  // funnel gases blacken whatever is near the stack tops
  for (int i = 0; i < 2; i++) {
    vec4 s = uShSoot[i];
    if (s.w <= 0.0) continue;
    float d = length(p - s.xyz);
    float k = (1.0 - smoothstep(s.w * 0.25, s.w, d)) * smoothstep(s.y - s.w, s.y - 0.5, p.y);
    c *= 1.0 - 0.65 * k * (0.6 + 0.4 * shNoise(p.xz * 2.0 + p.y));
  }
  if (p.y < 0.6) c = (p.y > -0.7 ? uShBoot : uShRed) * (0.85 + 0.3 * shNoise(p.xz * 0.4 + p.y));
  if (uShNumOn > 0.5 && abs(n.x) > 0.5 && p.z > uShNumBox.x && p.z < uShNumBox.y && p.y > uShNumBox.z && p.y < uShNumBox.w) {
    float nu = (p.z - uShNumBox.x) / (uShNumBox.y - uShNumBox.x);
    if (n.x > 0.0) nu = 1.0 - nu;
    float d = texture2D(uShNum, vec2(nu, (p.y - uShNumBox.z) / (uShNumBox.w - uShNumBox.z))).r;
    c = mix(c, vec3(0.72), d);
  }
  diffuseColor.rgb = c;
}`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
if (vShPaint > 1.5 && vShPaint < 2.5) roughnessFactor *= 0.42;
else if (vShPaint > 2.5) roughnessFactor *= 0.1;
else if (vShPaint > 0.5 && normalize(vShNrm).y > 0.72) roughnessFactor = min(1.0, roughnessFactor * 1.12);`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
if (vShPaint > 1.5 && vShPaint < 2.5) metalnessFactor = 1.0;
else if (vShPaint > 2.5) metalnessFactor = 0.0;`
      );
  });
  return m;
}

/** Wood deck: weathered teak with tar caulking, or a stained flight deck with markings and tie-down strips. */
// stained: teak under Measures 21/22 was stained Deck Blue; it wears through to the wood in patches
function deckMaterial(kind, stained = false) {
  const m = new THREE.MeshStandardMaterial({ map: plankTexture(), roughness: 0.86, metalness: 0 });
  const u = {
    uShTint: { value: kind === 'flight' || stained ? PAINT.stain : PAINT.teak },
    uShMarks: { value: kind === 'flight' ? 1 : 0 },
    uShWorn: { value: stained ? 1 : 0 },
    uShTeak: { value: PAINT.teak },
  };
  patchMaterial(m, stained ? 'ship-deck-stained' : 'ship-deck', (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShDPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShDPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vShDPos;\nuniform vec3 uShTint;\nuniform float uShMarks;\nuniform float uShWorn;\nuniform vec3 uShTeak;\n${noiseGLSL}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
{
  vec3 p = vShDPos;
  float fw = length(fwidth(p.xz));
  float detail = 1.0 - smoothstep(0.03, 0.12, fw);
  float v = shNoise(p.xz * 0.08) * 0.6 + shNoise(p.xz * 0.6) * 0.4;
  // scrubbed and sun-bleached in the open, darker and greyer where water lies
  float bleach = smoothstep(0.35, 0.8, shNoise(p.xz * 0.05 + 3.0));
  float damp = smoothstep(0.55, 0.85, shNoise(p.xz * 0.23 + 11.0)) * 0.6;
  vec3 tint = mix(uShTint, uShTint * vec3(0.78, 0.8, 0.84), damp);
  // scuffed stain showing the teak underneath along the walkways
  if (uShWorn > 0.5) tint = mix(tint, uShTeak * 0.8, smoothstep(0.62, 0.92, shNoise(p.xz * vec2(0.9, 0.12) + 7.0)) * 0.45);
  diffuseColor.rgb *= tint * (0.84 + 0.3 * v) * (1.0 + 0.14 * bleach);
  // per-plank grain streaks
  diffuseColor.rgb *= 1.0 - 0.06 * detail * shNoise(vec2(p.x * 8.0, p.z * 0.35));
  if (uShMarks > 0.5) {
    float mk = step(abs(p.x), 0.3) * step(fract(p.z / 9.0), 0.55);
    mk += step(abs(abs(p.x) - 14.6), 0.2) * step(abs(p.z), 128.0);
    mk += step(abs(p.z + 104.0), 0.35) * step(abs(p.x), 12.0);
    // centerline elevator outlines
    for (int i = 0; i < 2; i++) {
      float zc = i == 0 ? -70.0 : 40.0;
      vec2 q = abs(vec2(p.x, p.z - zc)) - vec2(7.0);
      mk += step(abs(max(q.x, q.y)), 0.18);
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6), clamp(mk, 0.0, 1.0) * 0.85);
    // steel tie-down strips across the deck
    float tz = abs(fract(p.z / 1.52 + 0.5) - 0.5) * 1.52;
    diffuseColor.rgb *= 1.0 - 0.22 * detail * (1.0 - smoothstep(0.03, 0.06, tz)) * step(abs(p.x), 15.5);
    // tyre and oil stains down the landing area
    diffuseColor.rgb *= 1.0 - 0.12 * smoothstep(0.6, 0.9, shNoise(vec2(p.x * 0.25, p.z * 0.04))) * (1.0 - smoothstep(4.0, 9.0, abs(p.x)));
  }
}`
      );
  });
  return m;
}

function railMaterial(camo) {
  const color = camo === 'ms22' ? PAINT.haze : camo === 'ms32' ? PAINT.light : PAINT.navy;
  return new THREE.MeshStandardMaterial({ map: railTexture(), color, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3 });
}

// ---------------------------------------------------------------- build

const BUILDERS = { bb: buildBB, cv: buildCV, cl: buildCL, dd: buildDD };

/**
 * Battleship variants. Alabama (and her sisters Indiana and Massachusetts) carried ten twin
 * 5"/38 mounts; South Dakota, completed as a fleet flagship with an extra conning tower level,
 * carried eight. Camouflage in mid-1944 (NHHC): Alabama Measure 21 (mid-1943 to early 1945),
 * South Dakota Measure 21, Indiana Measure 32/11D (late 1943 to fall 1944), Massachusetts Measure 22.
 */
export const BB_VARIANTS = {
  alabama: { name: 'USS Alabama', hull: 'BB-60', camo: 'ms21' },
  southdakota: { name: 'USS South Dakota', hull: 'BB-57', camo: 'ms21' },
};
const classCache = new Map();
const paintCache = new Map();
const deckCache = new Map();
const railCache = new Map();

/**
 * Build a ship of class `cls` ('bb' | 'cv' | 'cl' | 'dd'). Battleships take a `variant`
 * ('alabama' | 'southdakota'); camo 'auto' picks the scheme the ship wore in mid-1944.
 * Geometry is built once per class (and variant) and shared; materials are shared per
 * camouflage/seed/number.
 */
export function buildShip(cls, { seed = 1, camo = 'auto', hullNumber = null, variant = 'alabama' } = {}) {
  const v = cls === 'bb' ? (BB_VARIANTS[variant] ? variant : 'alabama') : '';
  if (camo === 'auto') camo = cls === 'bb' ? BB_VARIANTS[v].camo : 'ms21';
  const ck = `${cls}|${v}`;
  let built = classCache.get(ck);
  if (!built) {
    built = BUILDERS[cls](v || undefined);
    classCache.set(ck, built);
  }
  const key = `${ck}|${camo}|${camo === 'ms32' ? seed : 0}|${hullNumber}`;
  let paint = paintCache.get(key);
  if (!paint) paintCache.set(key, (paint = paintMaterial(built, camo, seed, hullNumber)));
  // battleship teak stained Deck Blue under Measures 21 and 22 (and 32's deck colors)
  const stained = cls === 'bb' && built.deck === 'teak';
  const dkey = `${built.deck}|${stained}`;
  if (built.deck && !deckCache.has(dkey)) deckCache.set(dkey, deckMaterial(built.deck, stained));
  if (!railCache.has(camo)) railCache.set(camo, railMaterial(camo));

  const group = new THREE.Group();
  group.name = v ? `ship-${cls}-${v}` : `ship-${cls}`;
  const hull = new THREE.Mesh(built.paintGeo, paint);
  hull.castShadow = hull.receiveShadow = true;
  group.add(hull);
  if (built.deckGeo) {
    const deck = new THREE.Mesh(built.deckGeo, deckCache.get(dkey));
    deck.castShadow = deck.receiveShadow = true;
    group.add(deck);
  }
  if (built.railGeo) {
    const rail = new THREE.Mesh(built.railGeo, railCache.get(camo));
    rail.receiveShadow = true;
    group.add(rail);
  }

  const c = SHIP_CLASSES[cls];
  const copy = (list) => list.map((o) => ({ ...o, pos: o.pos.clone(), ...(o.arc ? { arc: [...o.arc] } : {}) }));
  return {
    group,
    length: c.length,
    beam: c.beam,
    draft: c.draft,
    halfBeamAt: built.halfBeamAt,
    deckAt: built.deckAt,
    topAt: built.topAt,
    boxes: built.boxes,
    mounts: copy(built.mounts),
    stations: copy(built.stations),
    funnels: copy(built.funnels),
    parking: copy(built.parking),
  };
}
