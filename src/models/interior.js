import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, noise3 } from '../noise.js';

/*
 * The General Quarters route aboard USS Alabama (BB-60), June 1944: the set (interior spaces,
 * hatches, watertight doors, an exterior ladder) and the path the player's eye and the running
 * crew follow, from a second deck berthing compartment to Mount 47, the starboard quad 40mm
 * on the 02 level sponson aft.
 *
 * Everything is in ship space (metres, bow -Z, starboard +X, waterline y = 0), the space of
 * the ship model's group. The route stays on the starboard side ("up and forward to starboard,
 * down and aft to port"): every ladder it climbs is a starboard ladder. It runs aft as it climbs,
 * because Mount 47 is aft of the berthing.
 *
 *   B-205-L  crew berthing, 2nd deck: x 0.9..8.3, z 14..22, deck y 5.30, overhead 7.62
 *   B-207-L  passageway, 2nd deck: x 3.7..5.1, z 22..27.2; inclined ladder up through a hatch
 *   B-105-L  passageway, main deck level inside the 01 deckhouse: z 23.8..34.6, deck y 8.10,
 *            overhead 10.25; second inclined ladder up through a hatch
 *   B-0103-L passageway, 01 level inside the 02 level deckhouse: z 30.9..35.95, deck 10.45,
 *            overhead 12.80; watertight door in the after bulkhead (z 36) to the open 01 deck
 *   then aft and outboard on the 01 deck, up a new inclined ladder (x 5.45..7.0 at z 37.6) onto
 *   the sponson's open inboard edge, outboard along its after edge to the tub's rear door gap
 *   (11.6, 13.0, 37.7). About 36 m; the centripetal Catmull-Rom spline through the waypoints
 *   keeps at least 0.3 m from bulkheads and 0.4 m from the berths.
 *
 * Period detail (sources checked October 2026; where they are silent the choice is ours):
 * - Compartment designations: before 1949 a compartment was section letter (A forward of the
 *   machinery, B over it, C aft), deck and number (2xx second deck, 1xx main deck, 01xx above),
 *   odd numbers to starboard, and a use letter (L living spaces and passageways, A stores),
 *   marked on the door or hatch and on a 12 x 15 inch yellow rectangle on the bulkhead
 *   (tpub.com/dc32/23.htm; usni.org Naval History, Feb 2019 "Navigating within a pre-1949
 *   ship"). The deck-frame-side-use form (2-110-1-L) is post-1949 (nj2bb.org). Our numbers
 *   follow the scheme; Alabama's actual compartment numbers we could not find.
 * - Berths: pipe frames with canvas laced to them, a thin (about 4 inch) mattress, tiers of
 *   three hung from hangers on the bulkhead or stanchion side and from chains on the aisle
 *   side, with a bunk locker under the bottom berth (insidelst.com/berthing.htm; ussslater.org
 *   forward berthing: "three high", "a small bunk locker"). Alabama today shows metal berths
 *   "suspended from the ceiling" (alabamaliving.coop); accounts differ on three to five high.
 *   Stand-up lockers for petty officers (ussslater.org). Some battleships still used hammocks.
 * - Paint (Instructions for Painting and Cementing, June 1943, Ch. 8, shipcamouflage.com):
 *   Formula 27 flat fire-retardant inside white for bulkheads and overheads, 27-L inside light
 *   gray, 20-L light gray and 23 dark red for interior steel decks. Linoleum, cork and
 *   accumulated paint were stripped from ships after the 1942 Solomons fires
 *   (navalgazing.net/Survivability-Fire; battleshiptexas.info: no linoleum by WWII).
 * - Watertight doors: dogs press the door's gasket onto the frame's knife edge; 26 x 66 inch is
 *   a standard Navy door (USCG Drill Down 13; NSN listing). Battle lanterns were bulkhead
 *   mounted, came on when power failed, and were gray early in the war (collectorsweekly,
 *   Intrepid museum). Inclined ladder: 24 inch treads on naval ships (ASTM F1437); we found no
 *   1940s figure for the angle and use about 62 degrees.
 * - Not confirmed and so left out: fitting markings (X, Y, Z) in 1944, interior pipe color
 *   bands, red night lighting on battleships at General Quarters.
 *
 * Rendering: the ship's own hull and superstructure are single sided and invisible from
 * inside, so every space builds its own decks, bulkheads and overheads. Interiors are lit by
 * baked vertex colours (albedo x incandescent fixtures with soft shadows from berths and
 * lockers, plus a little bounce and corner occlusion) on MeshBasicMaterial with fog off. Where
 * the route passes through the ship's surfaces (the main deck under the first hatch, the 01
 * level roof under the second, the 02 deckhouse's after wall at the door) a depth-only portal
 * mask, drawn after the interior and before the ship, hides the ship's surface inside the
 * opening. Anything that must be seen through those openings (the interior, the running crew)
 * has to draw before the masks: use INTERIOR_RENDER_ORDER for it.
 */

const PI = Math.PI;
const HALF = PI / 2;
const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const hex = (h) => new THREE.Color(h);
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Draw order: the interior and anything seen through its openings first, then the portal masks. */
export const INTERIOR_RENDER_ORDER = -3;
export const PORTAL_RENDER_ORDER = -2;

// ---------------------------------------------------------------- layout

const Y2 = 5.3; // second deck
const Y2_OH = 7.62; // underside of the main deck plating (the teak above is at 7.80..8.05)
const Y1 = 8.1; // main deck level inside the 01 deckhouse (deckhouse block from 7.0 to 10.4)
const Y1_OH = 10.25; // the 02 level blocks reach down to 10.3
const Y01 = 10.45; // 01 level inside the 02 level block (its roof is the 01 deck at 10.4)
const Y01_OH = 12.8; // the 03 level blocks reach down to 12.9
const DECK01 = 10.4; // the open 01 deck (the ship's own surface)
const DECK02 = 13.0; // the 02 level sponson under Mount 47
const EYE = 1.65;
const DUCK = 1.5;
const CLIMB_EYE = 1.55;
const XC = 4.4; // the route's centreline through the passageways
const COAMING = 0.15;

const C = {
  white: hex(0xdad7cd), // Formula 27 inside white
  deckGray: hex(0x7f8383), // Formula 20-L light gray deck
  deckRed: hex(0x66392f), // Formula 23 dark red deck
  gray: hex(0x9a9e9f), // Formula 27-L inside light gray
  hatch: hex(0x8a8e8f),
  pipe: hex(0xd2cfc5),
  lagging: hex(0xded9cc),
  band: hex(0x9b9688),
  steel: hex(0x55585b),
  bright: hex(0x8f9091),
  dark: hex(0x26272a),
  rubber: hex(0x151515),
  red: hex(0x8a2118),
  brass: hex(0x9c7f42),
  canvas: hex(0xb2a88c),
  hose: hex(0xc4b997),
  ticking: hex(0xcdc8b8),
  pillow: hex(0xd6d3c8),
  rack: hex(0xa5a8a5),
  cable: hex(0x37383a),
  lantern: hex(0x6a6f72),
  glass: hex(0x1b2125),
  kapok: hex(0x67718a),
  seabag: hex(0xa59e86),
  shoe: hex(0x1e1a17),
  blankets: [hex(0x3d4555), hex(0x65655f), hex(0x515139), hex(0x4a4f5c)],
};
const LIGHT = new THREE.Color(1.0, 0.8, 0.58); // incandescent, linear
const GLOBE = new THREE.Color(4.4, 3.6, 2.6); // the globes' own glow (blooms)
const WHITE = new THREE.Color(1, 1, 1);

// box: [x0, x1, y0, y1, z0, z1]; amb: bounce light
const SPACES = {
  berth: { box: [0.9, 8.3, Y2, Y2_OH, 14.0, 22.0], amb: 0.055, deck: C.deckRed },
  pass2: { box: [3.7, 5.1, Y2, Y2_OH, 22.0, 27.2], amb: 0.05, deck: C.deckGray },
  pass1: { box: [3.7, 5.1, Y1, Y1_OH, 23.8, 34.6], amb: 0.05, deck: C.deckGray },
  pass01: { box: [3.7, 5.1, Y01, Y01_OH, 30.9, 35.95], amb: 0.05, deck: C.deckGray },
};

/** Compartments along the route, for a caption. `space` matches the path's waypoint `space`. */
export const ROUTE_INFO = [
  { id: 'B-205-L', name: 'Crew berthing', deck: 'Second deck', space: 'berth' },
  { id: 'B-207-L', name: 'Passageway', deck: 'Second deck', space: 'pass2' },
  { id: 'B-105-L', name: 'Passageway', deck: 'Main deck', space: 'pass1' },
  { id: 'B-0103-L', name: 'Passageway', deck: '01 level', space: 'pass01' },
  { id: null, name: 'Weather deck, starboard side', deck: '01 level', space: 'deck01' },
  { id: null, name: 'Mount 47, quad 40mm', deck: '02 level sponson', space: 'sponson' },
];

// hatches: opening in the deck at y, trunk down to `below`
const H1 = { name: 'main deck hatch', x0: 4.0, x1: 4.8, z0: 25.0, z1: 26.6, y: Y1, below: Y2_OH, upper: 'pass1', lower: 'pass2' };
const H2 = { name: '01 level hatch', x0: 4.0, x1: 4.8, z0: 31.5, z1: 33.0, y: Y01, below: Y1_OH, upper: 'pass01', lower: 'pass1' };
// inclined ladders, bottom and top of the tread line (the top lands on the hatch coaming)
const L1 = { b: v3(XC, Y2, 25.05), t: v3(XC, Y1 + COAMING, 26.6), floor: Y1 };
const L2 = { b: v3(XC, Y1, 31.68), t: v3(XC, Y01 + COAMING, 33.0), floor: Y01 };
const LX = { b: v3(5.45, DECK01, 37.6), t: v3(7.0, DECK02, 37.6), floor: DECK02 };
// watertight doors: 26 x 66 in clear opening, the sill 10 in above the deck
const DOOR = { w: 0.66, h: 1.68, r: 0.15, sill: 0.25 };
// o: centre of the opening at sill height on the bulkhead; the leaf is on the +n side
const D1 = { name: 'berthing door', o: v3(XC, Y2 + DOOR.sill, 22.0), n: v3(0, 0, 1), a: 'berth', b: 'pass2', open: -1.75, dA: 0.05, dB: 0.05 };
const D2 = { name: 'weather door', o: v3(XC, Y01 + DOOR.sill, 35.975), n: v3(0, 0, 1), a: 'pass01', b: null, open: -2.7, dA: 0.085, dB: 0.085 };

// ---------------------------------------------------------------- geometry

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Indexed triangle soup with explicit normals; faces are wound to agree with the given normal. */
class MeshData {
  constructor() {
    this.p = [];
    this.n = [];
    this.i = [];
  }

  get empty() {
    return this.i.length === 0;
  }

  v(p, n) {
    this.p.push(p.x, p.y, p.z);
    this.n.push(n.x, n.y, n.z);
    return this.p.length / 3 - 1;
  }

  tri(a, b, c, n) {
    _a.subVectors(b, a).cross(_b.subVectors(c, a));
    if (_a.dot(n) < 0) [b, c] = [c, b];
    const i = this.v(a, n);
    this.v(b, n);
    this.v(c, n);
    this.i.push(i, i + 1, i + 2);
  }

  quad(a, b, c, d, n) {
    _a.subVectors(b, a).cross(_b.subVectors(c, a));
    if (_a.dot(n) < 0) [b, d] = [d, b];
    const i = this.v(a, n);
    this.v(b, n);
    this.v(c, n);
    this.v(d, n);
    this.i.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /** Box of half sizes hx, hy, hz along the (orthonormal) axes of m, centred at m's position. */
  box(m, hx, hy, hz) {
    const e = m.elements;
    const ax = v3(e[0], e[1], e[2]).normalize(), ay = v3(e[4], e[5], e[6]).normalize(), az = v3(e[8], e[9], e[10]).normalize();
    const P = (sx, sy, sz) => v3(sx * hx, sy * hy, sz * hz).applyMatrix4(m);
    const c = [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)];
    this.quad(c[1], c[2], c[6], c[5], ax);
    this.quad(c[0], c[4], c[7], c[3], ax.clone().negate());
    this.quad(c[3], c[7], c[6], c[2], ay);
    this.quad(c[0], c[1], c[5], c[4], ay.clone().negate());
    this.quad(c[4], c[5], c[6], c[7], az);
    this.quad(c[0], c[3], c[2], c[1], az.clone().negate());
  }

  /** Axis-aligned box. */
  abox(x0, x1, y0, y1, z0, z1) {
    this.box(new THREE.Matrix4().makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2);
  }

  /** Smooth-shaded cylinder from a to b (open ends unless caps). */
  cyl(a, b, r, seg = 6, caps = false, r1 = r) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-5) return;
    const ax = d.divideScalar(len);
    const t = Math.abs(ax.y) < 0.9 ? UP : v3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ax, t).normalize();
    const w = new THREE.Vector3().crossVectors(ax, u);
    const base = this.p.length / 3;
    for (let i = 0; i <= seg; i++) {
      const ang = (i / seg) * PI * 2;
      const n = u.clone().multiplyScalar(Math.cos(ang)).addScaledVector(w, Math.sin(ang));
      this.v(a.clone().addScaledVector(n, r), n);
      this.v(b.clone().addScaledVector(n, r1), n);
    }
    for (let i = 0; i < seg; i++) {
      const p0 = base + i * 2;
      this.i.push(p0, p0 + 2, p0 + 3, p0, p0 + 3, p0 + 1);
    }
    if (caps) {
      for (const [c, rr, s] of [[a, r, -1], [b, r1, 1]]) {
        const n = ax.clone().multiplyScalar(s);
        for (let i = 0; i < seg; i++) {
          const a0 = (i / seg) * PI * 2, a1 = ((i + 1) / seg) * PI * 2;
          const p = (ang) => c.clone().addScaledVector(u, Math.cos(ang) * rr).addScaledVector(w, Math.sin(ang) * rr);
          this.tri(c, p(a0), p(a1), n);
        }
      }
    }
  }

  /** Bent pipe through the points (a run of cylinders with joints). */
  pipe(pts, r, seg = 6) {
    for (let i = 0; i < pts.length - 1; i++) this.cyl(pts[i], pts[i + 1], r, seg);
  }

  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setIndex(this.i);
    return g;
  }
}

/**
 * Flat panel subdivided into roughly `cell` sized quads (so baked light can fall off across it),
 * spanning o + a*u + b*v for u in [0, A], v in [0, B]; faces a x b. Holes are world boxes
 * { min, max }; the grid lines run along their edges and the cells inside are left out.
 */
function grid(o, a, b, A, B, cell, holes = []) {
  const n = new THREE.Vector3().crossVectors(a, b);
  const hs = holes.map((h) => {
    const p0 = h.min.clone().sub(o), p1 = h.max.clone().sub(o);
    const us = [p0.dot(a), p1.dot(a)].sort((x, y) => x - y), vs = [p0.dot(b), p1.dot(b)].sort((x, y) => x - y);
    return [us[0], us[1], vs[0], vs[1]];
  });
  const lines = (L, edges) => {
    const ex = edges.filter((e) => e > 1e-3 && e < L - 1e-3);
    const k = Math.max(1, Math.round(L / cell));
    const out = [0, L, ...ex];
    for (let i = 1; i < k; i++) {
      const s = (i * L) / k;
      if (ex.every((e) => Math.abs(e - s) > cell * 0.3)) out.push(s);
    }
    return [...new Set(out.map((x) => Math.round(x * 1e4) / 1e4))].sort((x, y) => x - y);
  };
  const us = lines(A, hs.flatMap((h) => [h[0], h[1]]));
  const vs = lines(B, hs.flatMap((h) => [h[2], h[3]]));
  const pos = [], nor = [], idx = [];
  for (const v of vs) {
    for (const u of us) {
      pos.push(o.x + a.x * u + b.x * v, o.y + a.y * u + b.y * v, o.z + a.z * u + b.z * v);
      nor.push(n.x, n.y, n.z);
    }
  }
  const nu = us.length;
  for (let j = 0; j < vs.length - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const uc = (us[i] + us[i + 1]) / 2, vc = (vs[j] + vs[j + 1]) / 2;
      if (hs.some((h) => uc > h[0] && uc < h[1] && vc > h[2] && vc < h[3])) continue;
      const p00 = j * nu + i, p10 = p00 + 1, p01 = p00 + nu, p11 = p01 + 1;
      idx.push(p00, p10, p11, p00, p11, p01);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

const hole = (x0, x1, y0, y1, z0, z1) => ({ min: v3(x0, y0, z0), max: v3(x1, y1, z1) });

/** Rounded rectangle outline (door openings), x centred, y from 0 to h, grown by `off`; counter-clockwise from +z. */
function rrect(w, h, r, off = 0, seg = 4) {
  const hw = w / 2 + off, rr = r + off, y0 = -off, y1 = h + off;
  const corners = [[hw - rr, y0 + rr, -HALF], [hw - rr, y1 - rr, 0], [-hw + rr, y1 - rr, HALF], [-hw + rr, y0 + rr, PI]];
  const pts = [];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * HALF;
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  }
  return pts;
}

// flat ring between two matching outlines in the plane z, facing nz
function ring(md, A, B, z, nz) {
  const N = v3(0, 0, nz);
  for (let i = 0; i < A.length; i++) {
    const j = (i + 1) % A.length;
    md.quad(v3(A[i][0], A[i][1], z), v3(B[i][0], B[i][1], z), v3(B[j][0], B[j][1], z), v3(A[j][0], A[j][1], z), N);
  }
}

// band swept along an outline from z0 to z1, facing out of the outline (or into it)
function band(md, P, z0, z1, inward = false) {
  for (let i = 0; i < P.length; i++) {
    const j = (i + 1) % P.length;
    let nx = P[j][1] - P[i][1], ny = -(P[j][0] - P[i][0]);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    const n = inward ? v3(-nx, -ny, 0) : v3(nx, ny, 0);
    md.quad(v3(P[i][0], P[i][1], z0), v3(P[j][0], P[j][1], z0), v3(P[j][0], P[j][1], z1), v3(P[i][0], P[i][1], z1), n);
  }
}

// filled (convex) outline in the plane z, facing nz
function cap(md, P, z, nz) {
  const cx = P.reduce((s, p) => s + p[0], 0) / P.length, cy = P.reduce((s, p) => s + p[1], 0) / P.length;
  const c = v3(cx, cy, z), N = v3(0, 0, nz);
  for (let i = 0; i < P.length; i++) {
    const j = (i + 1) % P.length;
    md.tri(c, v3(P[i][0], P[i][1], z), v3(P[j][0], P[j][1], z), N);
  }
}

/** Frame with its x axis along u, y up and z along the bulkhead normal n, at p. */
function wallFrame(p, n) {
  const u = UP.clone().cross(n).normalize();
  return new THREE.Matrix4().makeBasis(u, UP, n).setPosition(p);
}

const mAt = (base, x, y, z) => base.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z));

// ---------------------------------------------------------------- kits and baking

/** Interior pieces waiting for their baked light. */
class Kit {
  constructor(withUv = false) {
    this.pieces = [];
    this.withUv = withUv;
    this.bake = null; // local -> ship matrix for movable parts (their pose when baked)
  }

  /** o: { c albedo, s space, lit [spaces whose lights reach it], e emissive, recv (soft shadows), wrap, grime, m } */
  add(g, o) {
    if (g instanceof MeshData) {
      if (g.empty) return;
      g = g.geo();
    }
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(this.withUv && k === 'uv')) g.deleteAttribute(k);
    if (o.m) g.applyMatrix4(o.m);
    this.pieces.push({ g, ...o });
  }

  mesh(material) {
    if (!this.pieces.length) return null;
    const geo = mergeGeometries(this.pieces.map((p) => p.g));
    const mesh = new THREE.Mesh(geo, material);
    mesh.renderOrder = INTERIOR_RENDER_ORDER;
    mesh.castShadow = mesh.receiveShadow = false;
    return mesh;
  }
}

/** Exterior pieces in the ship's own paint (lit by the sun like the rest of the ship). */
class PaintKit {
  constructor() {
    this.parts = [];
  }

  // color: null paints in the ship's scheme (decks come out Deck Blue), otherwise a fixed colour
  add(g, { color = null, m = null } = {}) {
    if (g instanceof MeshData) {
      if (g.empty) return;
      g = g.geo();
    }
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (m) g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const c = color || WHITE;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPaint', new THREE.BufferAttribute(new Float32Array(n).fill(color ? 0 : 1), 1));
    this.parts.push(g);
  }

  mesh(material) {
    if (!this.parts.length) return null;
    const mesh = new THREE.Mesh(mergeGeometries(this.parts), material);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }
}

// how much of the segment p -> l is blocked by the occluder boxes (soft at the edges)
function shadow(occ, px, py, pz, lx, ly, lz) {
  const dx = lx - px, dy = ly - py, dz = lz - pz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let vis = 1;
  for (let k = 0; k < occ.length; k++) {
    const o = occ[k];
    let t0 = 0, t1 = 1;
    if (Math.abs(dx) < 1e-9) {
      if (px < o[0] || px > o[1]) continue;
    } else {
      let ta = (o[0] - px) / dx, tb = (o[1] - px) / dx;
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 >= t1) continue;
    }
    if (Math.abs(dy) < 1e-9) {
      if (py < o[2] || py > o[3]) continue;
    } else {
      let ta = (o[2] - py) / dy, tb = (o[3] - py) / dy;
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 >= t1) continue;
    }
    if (Math.abs(dz) < 1e-9) {
      if (pz < o[4] || pz > o[5]) continue;
    } else {
      let ta = (o[4] - pz) / dz, tb = (o[5] - pz) / dz;
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 >= t1) continue;
    }
    vis *= 1 - 0.9 * smooth(0, 0.08, (t1 - t0) * len);
    if (vis < 0.04) return vis;
  }
  return vis;
}

// darkening into the corners of a space's box
function cornerOcclusion(x, y, z, b) {
  const dF = Math.max(0, y - b[2]), dC = Math.max(0, b[3] - y);
  const dW = Math.max(0, Math.min(x - b[0], b[1] - x, z - b[4], b[5] - z));
  return 1 - 0.34 * Math.exp(-dF / 0.2 - dW / 0.22) - 0.28 * Math.exp(-dC / 0.24 - dW / 0.3) - 0.12 * Math.exp(-dF / 0.12);
}

const _P = new THREE.Vector3();
const _N = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/** Bake light into each piece's vertex colours; normals are dropped afterwards (MeshBasicMaterial). */
function bakeKit(kit, env) {
  for (const pc of kit.pieces) {
    const g = pc.g, pos = g.attributes.position, nor = g.attributes.normal, n = pos.count;
    const out = new Float32Array(n * 3);
    const bake = pc.bake || kit.bake;
    if (bake) _nm.getNormalMatrix(bake);
    if (pc.e) {
      for (let k = 0; k < n; k++) out.set([pc.e.r, pc.e.g, pc.e.b], k * 3);
    } else {
      const sp = SPACES[pc.s];
      const lit = pc.lit || [pc.s];
      const lights = env.lights.filter((L) => lit.includes(L.s));
      const recv = pc.recv || lit.length > 1;
      const c = pc.c || WHITE;
      const amb = sp.amb * (pc.amb ?? 1);
      const wrap = pc.wrap || 0;
      const grime = pc.grime ?? 0.06;
      for (let k = 0; k < n; k++) {
        _P.fromBufferAttribute(pos, k);
        _N.fromBufferAttribute(nor, k);
        if (bake) {
          _P.applyMatrix4(bake);
          _N.applyMatrix3(_nm).normalize();
        }
        const px = _P.x, py = _P.y, pz = _P.z, nx = _N.x, ny = _N.y, nz = _N.z;
        let r = amb, gg = amb * 0.94, b = amb * 0.86;
        for (const L of lights) {
          const dx = L.p.x - px, dy = L.p.y - py, dz = L.p.z - pz;
          const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
          let ndl = (nx * dx + ny * dy + nz * dz) / d;
          if (wrap) ndl = (ndl + wrap) / (1 + wrap);
          if (ndl <= 0) continue;
          let a = (L.i * ndl) / (d2 + 0.22);
          // the fixture's canopy keeps light off the overhead right above it
          if (dy < 0) a *= 1 - 0.8 * smooth(0.3, 0.85, -dy / d);
          if (recv) a *= shadow(env.occ, px + nx * 0.012, py + ny * 0.012, pz + nz * 0.012, L.p.x, L.p.y, L.p.z);
          r += LIGHT.r * a;
          gg += LIGHT.g * a;
          b += LIGHT.b * a;
        }
        let k2 = pc.noAo ? 1 : cornerOcclusion(px, py, pz, sp.box);
        if (grime) k2 *= 1 + grime * noise3(px * 1.9 + 3.1, py * 1.9, pz * 1.9 - 7.7);
        // scuffed and dirtier low on the bulkheads
        if (Math.abs(ny) < 0.5) k2 *= 1 - 0.14 * Math.exp(-Math.max(0, py - sp.box[2]) / 0.14);
        out[k * 3] = Math.min(2, c.r * r * k2);
        out[k * 3 + 1] = Math.min(2, c.g * gg * k2);
        out[k * 3 + 2] = Math.min(2, c.b * b * k2);
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(out, 3));
    g.deleteAttribute('normal');
  }
}

// ---------------------------------------------------------------- labels

const LABELS = [
  { text: 'B-205-L' }, { text: 'B-207-L' }, { text: 'B-105-L' }, { text: 'B-0103-L' },
  { text: 'B-203-L' }, { text: 'B-103-L' }, { text: 'B-107-L' }, { text: 'B-109-A' },
  { text: 'B-0105-L' }, { text: 'FIRE PLUG', bg: '#8f2219', fg: '#efe9dc', size: 46 },
  { text: 'JZ', bg: '#1d1e20', fg: '#e6e2d6', size: 70 },
];
const LABEL_INDEX = Object.fromEntries(LABELS.map((l, i) => [l.text, i]));

// 4 x 4 cells of 256 x 128 on a canvas: compartment numbers stencilled black on yellow plates
function labelAtlas() {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#cfc9b9';
  g.fillRect(0, 0, 1024, 512);
  const rnd = mulberry32(77);
  LABELS.forEach((l, k) => {
    const x = (k % 4) * 256, y = Math.floor(k / 4) * 128;
    g.fillStyle = l.bg || '#d3ad37';
    g.fillRect(x + 2, y + 2, 252, 124);
    g.strokeStyle = l.fg || '#141414';
    g.lineWidth = 4;
    g.strokeRect(x + 12, y + 12, 232, 104);
    g.fillStyle = l.fg || '#141414';
    g.font = `bold ${l.size || 54}px "Arial Narrow", "Liberation Sans Narrow", "Nimbus Sans Narrow", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(l.text, x + 128, y + 67, 214);
    // stencil bridges and wear
    g.fillStyle = l.bg || '#d3ad37';
    for (let i = 0; i < 9; i++) g.fillRect(x + 22 + i * 24 + rnd() * 6, y + 30 + rnd() * 50, 2.5, 7 + rnd() * 6);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(40,34,28,${0.08 + rnd() * 0.18})`;
      g.fillRect(x + rnd() * 252, y + rnd() * 124, 1 + rnd() * 3, 1 + rnd() * 3);
    }
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Plate on a bulkhead: centre p, facing n, w x h metres. */
function label(LBL, text, s, p, n, w = 0.38, h = 0.3) {
  const k = LABEL_INDEX[text];
  if (k === undefined) return;
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  const u0 = (k % 4) / 4, v1 = 1 - Math.floor(k / 4) / 4;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.25, v1 - 0.25 + uv.getY(i) * 0.25);
  LBL.add(g, { c: WHITE, s, m: wallFrame(p.clone().addScaledVector(n, 0.004), n), grime: 0.04 });
}

// ---------------------------------------------------------------- spaces

function shell(K, key, holes = {}) {
  const sp = SPACES[key];
  const [x0, x1, y0, y1, z0, z1] = sp.box;
  const X = v3(1, 0, 0), Y = v3(0, 1, 0), Z = v3(0, 0, 1);
  const cell = 0.3;
  K.add(grid(v3(x0, y0, z0), Z, X, z1 - z0, x1 - x0, cell, holes.floor), { c: sp.deck, s: key, recv: true, grime: 0.2 });
  K.add(grid(v3(x0, y1, z0), X, Z, x1 - x0, z1 - z0, cell, holes.over), { c: C.white, s: key, grime: 0.05 });
  const wall = { c: C.white, s: key, recv: true, grime: 0.07 };
  K.add(grid(v3(x0, y0, z0), Y, Z, y1 - y0, z1 - z0, cell, holes.px), wall);
  K.add(grid(v3(x1, y0, z0), Z, Y, z1 - z0, y1 - y0, cell, holes.nx), wall);
  K.add(grid(v3(x0, y0, z0), X, Y, x1 - x0, y1 - y0, cell, holes.pz), wall);
  K.add(grid(v3(x0, y0, z1), Y, X, y1 - y0, x1 - x0, cell, holes.nz), wall);
}

// deck beams (one every 4 ft frame) across a space, skipping openings; carlings along hatch sides
function beams(K, key, { depth = 0.22, skip = [], carlings = [] } = {}) {
  const [x0, x1, , y1, z0, z1] = SPACES[key].box;
  const md = new MeshData();
  for (let z = z0 + 1.22; z < z1 - 0.1; z += 1.22) {
    if (skip.some(([a, b]) => z > a - 0.06 && z < b + 0.06)) continue;
    md.abox(x0, x1, y1 - depth, y1, z - 0.006, z + 0.006);
    md.abox(x0, x1, y1 - depth, y1 - depth + 0.012, z - 0.05, z + 0.05);
  }
  for (const [x, za, zb] of carlings) md.abox(x - 0.006, x + 0.006, y1 - depth, y1, za, zb);
  K.add(md, { c: C.white, s: key, grime: 0.04 });
}

// pipes along z hung under the beams, with hangers at every frame
function pipeRun(K, key, runs, z0, z1) {
  const [, , , y1] = SPACES[key].box;
  const pm = new MeshData(), lag = new MeshData(), bands = new MeshData(), hang = new MeshData();
  for (const { x, y, r, lagged } of runs) {
    const tgt = lagged ? lag : pm;
    tgt.cyl(v3(x, y, z0), v3(x, y, z1), r, 8);
    if (lagged) for (let z = z0 + 0.45; z < z1 - 0.1; z += 0.9) bands.cyl(v3(x, y, z - 0.015), v3(x, y, z + 0.015), r + 0.004, 8);
    for (let z = z0 + 0.6; z < z1 - 0.1; z += 1.22) {
      hang.abox(x - 0.006, x + 0.006, y, y1, z - 0.015, z + 0.015);
      hang.cyl(v3(x - r - 0.006, y - r * 0.2, z), v3(x + r + 0.006, y - r * 0.2, z), 0.006, 3);
    }
  }
  K.add(pm, { c: C.pipe, s: key, wrap: 0.5, grime: 0.08 });
  K.add(lag, { c: C.lagging, s: key, wrap: 0.5, grime: 0.12 });
  K.add(bands, { c: C.band, s: key, wrap: 0.5 });
  K.add(hang, { c: C.steel, s: key, wrap: 0.4 });
}

// lead-sheathed cables on strap hangers along a bulkhead under the overhead
function cableRun(K, key, xWall, dir, y, z0, z1, count = 6) {
  const cb = new MeshData(), hang = new MeshData();
  for (let i = 0; i < count; i++) {
    const x = xWall + dir * (0.05 + i * 0.035), r = 0.009 + (i % 3) * 0.004;
    cb.cyl(v3(x, y + r, z0), v3(x, y + r, z1), r, 5);
  }
  const span = 0.05 + count * 0.035 + 0.02;
  for (let z = z0 + 0.3; z < z1 - 0.05; z += 0.61) {
    const xa = xWall, xb = xWall + dir * span;
    hang.abox(Math.min(xa, xb), Math.max(xa, xb), y - 0.012, y, z - 0.02, z + 0.02);
    hang.abox(Math.min(xb, xb - dir * 0.012), Math.max(xb, xb - dir * 0.012), y - 0.012, y + 0.08, z - 0.02, z + 0.02);
  }
  K.add(cb, { c: C.cable, s: key, wrap: 0.5, grime: 0.04 });
  K.add(hang, { c: C.steel, s: key, wrap: 0.4 });
}

// globe light: stem, canopy, frosted globe and its wire guard; registers the light for the bake
function globe(K, env, s, x, y, z, ceiling, i = 1) {
  const md = new MeshData();
  md.cyl(v3(x, ceiling, z), v3(x, y + 0.13, z), 0.016, 6);
  md.cyl(v3(x, y + 0.13, z), v3(x, y + 0.07, z), 0.1, 12, true, 0.085);
  for (let k = 0; k < 4; k++) {
    const a = k * HALF + PI / 4, dx = Math.cos(a), dz = Math.sin(a);
    md.cyl(v3(x + dx * 0.08, y + 0.07, z + dz * 0.08), v3(x + dx * 0.1, y - 0.01, z + dz * 0.1), 0.005, 3);
    md.cyl(v3(x + dx * 0.1, y - 0.01, z + dz * 0.1), v3(x + dx * 0.02, y - 0.11, z + dz * 0.02), 0.005, 3);
  }
  K.add(md, { c: C.gray, s, wrap: 0.6, noAo: true });
  K.add(new THREE.TorusGeometry(0.1, 0.005, 3, 14).rotateX(HALF).translate(x, y - 0.01, z), { c: C.steel, s, wrap: 0.6, noAo: true });
  K.add(new THREE.SphereGeometry(0.08, 14, 9).translate(x, y, z), { e: GLOBE, s });
  env.lights.push({ s, p: v3(x, y, z), i });
}

// battle lantern on a bulkhead bracket: p on the bulkhead at the lantern's centre height
function battleLantern(K, s, p, n) {
  const F = wallFrame(p, n);
  const body = new MeshData(), dark = new MeshData();
  body.box(mAt(F, 0, 0, 0.14), 0.095, 0.11, 0.1);
  body.box(mAt(F, 0, -0.13, 0.06), 0.06, 0.012, 0.06); // bracket
  body.box(mAt(F, 0, -0.07, 0.02), 0.06, 0.07, 0.02);
  body.cyl(v3(-0.06, 0.12, 0.14).applyMatrix4(F), v3(0.06, 0.12, 0.14).applyMatrix4(F), 0.012, 5);
  body.cyl(v3(0, 0, 0.24).applyMatrix4(F), v3(0, 0, 0.27).applyMatrix4(F), 0.082, 12, false);
  K.add(body, { c: C.lantern, s, wrap: 0.3 });
  dark.cyl(v3(0, 0, 0.268).applyMatrix4(F), v3(0, 0, 0.272).applyMatrix4(F), 0.07, 12, true);
  K.add(dark, { c: C.glass, s });
}

// sound-powered telephone jack box with its headset hung below
function phoneBox(K, LBL, s, p, n, circuit = 'JZ') {
  const F = wallFrame(p, n);
  const box = new MeshData(), dark = new MeshData();
  box.box(mAt(F, 0, 0, 0.06), 0.13, 0.16, 0.06);
  box.box(mAt(F, 0, 0.12, 0.125), 0.12, 0.012, 0.006); // lid hinge
  dark.box(mAt(F, 0, -0.03, 0.123), 0.1, 0.11, 0.004); // lid seam shadow
  dark.cyl(v3(0.05, -0.16, 0.08).applyMatrix4(F), v3(0.05, -0.2, 0.08).applyMatrix4(F), 0.012, 6); // jack
  // headset: two earpieces and a breastplate transmitter
  dark.cyl(v3(-0.08, -0.32, 0.08).applyMatrix4(F), v3(-0.08, -0.32, 0.12).applyMatrix4(F), 0.04, 10, true);
  dark.cyl(v3(0.07, -0.34, 0.08).applyMatrix4(F), v3(0.07, -0.34, 0.12).applyMatrix4(F), 0.04, 10, true);
  dark.pipe([v3(-0.08, -0.29, 0.1), v3(-0.04, -0.2, 0.1), v3(0.03, -0.21, 0.1), v3(0.07, -0.3, 0.1)].map((q) => q.applyMatrix4(F)), 0.006, 4);
  dark.cyl(v3(0, -0.5, 0.1).applyMatrix4(F), v3(0, -0.5, 0.17).applyMatrix4(F), 0.05, 10, true, 0.03);
  dark.pipe([v3(0.05, -0.2, 0.08), v3(0.04, -0.38, 0.1), v3(0, -0.46, 0.12)].map((q) => q.applyMatrix4(F)), 0.007, 4);
  K.add(box, { c: C.gray, s, recv: true });
  K.add(dark, { c: C.dark, s, wrap: 0.4 });
  label(LBL, circuit, s, p.clone().addScaledVector(UP, 0.29), n, 0.22, 0.11);
}

// fire plug off the fire main with its hose flaked on a rack, nozzle and spanner
function fireStation(K, LBL, s, p, n, ceiling) {
  const F = wallFrame(p, n);
  const at = (x, y, z) => v3(x, y, z).applyMatrix4(F);
  const pipeM = new MeshData(), red = new MeshData(), hose = new MeshData(), brass = new MeshData(), steel = new MeshData();
  const top = ceiling - p.y - 0.25;
  pipeM.cyl(at(0, top, 0.1), at(0, 1.08, 0.1), 0.034, 8);
  pipeM.cyl(at(0, 1.08, 0.1), at(0, 0.96, 0.1), 0.055, 10, true);
  pipeM.cyl(at(0, 1.0, 0.1), at(0, 0.9, 0.2), 0.03, 8);
  brass.cyl(at(0, 0.9, 0.2), at(0, 0.86, 0.24), 0.04, 10, true);
  red.cyl(at(0, 1.08, 0.1), at(0, 1.18, 0.1), 0.012, 6);
  K.add(new THREE.TorusGeometry(0.075, 0.011, 5, 16).rotateX(HALF).applyMatrix4(new THREE.Matrix4().makeTranslation(0, 1.19, 0.1)).applyMatrix4(F), { c: C.red, s, wrap: 0.4 });
  for (let k = 0; k < 4; k++) red.cyl(at(0, 1.19, 0.1), at(Math.cos(k * HALF) * 0.07, 1.19, 0.1 + Math.sin(k * HALF) * 0.07), 0.006, 3);
  // rack bracket and the flaked 2.5 inch hose
  steel.box(mAt(F, 0.42, 1.52, 0.08), 0.26, 0.02, 0.08);
  // faked in vertical folds hanging over the rack: two flattened legs and a bend per fold
  for (let k = 0; k < 6; k++) {
    const x = 0.2 + k * 0.085, low = 0.98 + (k % 2) * 0.05;
    for (const z of [0.055, 0.125]) hose.box(mAt(F, x, (1.51 + low) / 2, z), 0.034, (1.51 - low) / 2, 0.011);
    hose.cyl(at(x, low, 0.04), at(x, low, 0.14), 0.034, 8);
    hose.cyl(at(x, 1.52, 0.05), at(x, 1.52, 0.13), 0.022, 6);
  }
  // all-purpose nozzle clipped beside the rack, spanner below
  brass.cyl(at(0.78, 1.0, 0.07), at(0.78, 1.38, 0.07), 0.03, 8, true, 0.018);
  steel.box(mAt(F, 0.78, 1.2, 0.03), 0.03, 0.03, 0.03);
  steel.box(mAt(F, 0.2, 0.7, 0.02), 0.012, 0.11, 0.01);
  K.add(pipeM, { c: C.pipe, s, wrap: 0.4 });
  K.add(red, { c: C.red, s, wrap: 0.4 });
  K.add(hose, { c: C.hose, s, recv: true, grime: 0.15 });
  K.add(brass, { c: C.brass, s, wrap: 0.4 });
  K.add(steel, { c: C.steel, s, wrap: 0.3 });
  label(LBL, 'FIRE PLUG', s, at(0.3, 1.78, 0), n, 0.36, 0.13);
}

// bank of stand-up lockers against a bulkhead, fronts facing n
function lockerBank(K, env, s, p, n, count, w = 0.56, h = 1.85, d = 0.48) {
  const F = wallFrame(p, n);
  const body = new MeshData(), dark = new MeshData(), steel = new MeshData();
  const x0 = -(count * w) / 2;
  for (let i = 0; i < count; i++) {
    const cx = x0 + (i + 0.5) * w;
    body.box(mAt(F, cx, h / 2, d / 2), w / 2 - 0.004, h / 2, d / 2);
    dark.box(mAt(F, cx + w / 2 - 0.004, h / 2, d + 0.002), 0.004, h / 2 - 0.04, 0.003);
    for (const y of [0.12, 0.18, 0.24, h - 0.24, h - 0.18, h - 0.12]) dark.box(mAt(F, cx, y, d + 0.002), w * 0.3, 0.008, 0.003);
    steel.box(mAt(F, cx + w * 0.3, h * 0.55, d + 0.012), 0.012, 0.05, 0.012);
    steel.box(mAt(F, cx + w * 0.3, h * 0.55 - 0.08, d + 0.02), 0.016, 0.022, 0.012); // padlock
  }
  K.add(body, { c: C.gray, s, recv: true, grime: 0.1 });
  K.add(dark, { c: C.dark, s });
  K.add(steel, { c: C.steel, s, wrap: 0.3 });
  // as an occluder (world AABB of the bank)
  const corners = [v3(x0, 0, 0), v3(-x0, h, d)].map((q) => q.applyMatrix4(F));
  env.occ.push([Math.min(corners[0].x, corners[1].x), Math.max(corners[0].x, corners[1].x), Math.min(corners[0].y, corners[1].y), Math.max(corners[0].y, corners[1].y), Math.min(corners[0].z, corners[1].z), Math.max(corners[0].z, corners[1].z)]);
}

// ---------------------------------------------------------------- berthing

const ROWS = [
  // x0, x1, hanger side (-1 at x0, +1 at x1)
  [0.95, 1.6, -1],
  [2.5, 3.15, 1],
  [3.15, 3.8, -1],
  [5.0, 5.65, 1],
  [5.65, 6.3, -1],
  [7.65, 8.3, 1],
];
const SECTIONS = [[14.55, 16.5], [16.5, 18.45], [19.45, 21.4]];
const TIERS = [0.42, 1.02, 1.62];
const POSTS_X = [3.15, 5.65];
const BERTH_BEAMS = [15.22, 16.44, 17.66, 18.88, 20.1, 21.32];

function berthing(K, LBL, env, rnd) {
  const s = 'berth';
  const [bx0, bx1, , , bz0, bz1] = SPACES.berth.box;
  shell(K, s, { nz: [hole(XC - DOOR.w / 2, XC + DOOR.w / 2, D1.o.y, D1.o.y + DOOR.h, 21.9, 22.1)] });

  // overhead: beams, a ventilation trunk over the middle rows, pipes, cables, the 1MC speaker
  const bm = new MeshData();
  for (const z of BERTH_BEAMS) {
    bm.abox(bx0, bx1, Y2_OH - 0.22, Y2_OH, z - 0.006, z + 0.006);
    bm.abox(bx0, bx1, Y2_OH - 0.22, Y2_OH - 0.208, z - 0.05, z + 0.05);
  }
  K.add(bm, { c: C.white, s, grime: 0.04 });
  const duct = new MeshData();
  duct.abox(5.36, 5.94, Y2_OH - 0.32, Y2_OH - 0.02, bz0, bz1);
  for (let z = bz0 + 1.6; z < bz1; z += 1.6) duct.abox(5.34, 5.96, Y2_OH - 0.34, Y2_OH - 0.02, z - 0.02, z + 0.02);
  for (const z of [15.9, 20.6]) duct.abox(4.98, 5.36, Y2_OH - 0.3, Y2_OH - 0.12, z - 0.16, z + 0.16);
  K.add(duct, { c: C.white, s, grime: 0.06 });
  const grille = new MeshData();
  for (const z of [15.9, 20.6]) for (let k = 0; k < 4; k++) grille.abox(4.975, 4.98, Y2_OH - 0.28 + k * 0.04, Y2_OH - 0.265 + k * 0.04, z - 0.14, z + 0.14);
  K.add(grille, { c: C.dark, s });
  env.occ.push([5.36, 5.94, Y2_OH - 0.32, Y2_OH - 0.02, bz0, bz1]);
  pipeRun(K, s, [{ x: 2.72, y: 7.32, r: 0.035 }, { x: 3.0, y: 7.31, r: 0.06, lagged: true }, { x: 3.42, y: 7.34, r: 0.028 }], bz0, bz1);
  // a gate valve on the water line
  const valve = new MeshData();
  valve.abox(2.67, 2.77, 7.26, 7.38, 17.0, 17.14);
  valve.cyl(v3(2.72, 7.26, 17.07), v3(2.72, 7.16, 17.07), 0.01, 5);
  K.add(valve, { c: C.pipe, s, wrap: 0.4 });
  K.add(new THREE.TorusGeometry(0.06, 0.008, 4, 12).rotateX(HALF).translate(2.72, 7.16, 17.07), { c: C.red, s, wrap: 0.5 });
  cableRun(K, s, bx1, -1, 7.36, bz0, bz1, 7);
  const spk = new MeshData(), spkD = new MeshData();
  spk.abox(4.25, 4.55, 7.36, 7.6, 17.0, 17.3);
  spkD.abox(4.27, 4.53, 7.355, 7.36, 17.02, 17.28);
  K.add(spk, { c: C.gray, s });
  K.add(spkD, { c: C.dark, s });

  // berths: pipe frames, canvas, mattress, bedding; posts, bulkhead hangers, chains, bunk lockers
  const frame = new MeshData(), canvas = new MeshData(), mat = new MeshData(), pillow = new MeshData(), hard = new MeshData(), chainMd = new MeshData(), locker = new MeshData(), lockerD = new MeshData();
  const blanket = C.blankets.map(() => new MeshData());
  const posts = new MeshData();
  for (const x of POSTS_X) for (const z of [14.55, 16.5, 18.45, 19.45, 21.4]) posts.cyl(v3(x, Y2, z), v3(x, Y2_OH, z), 0.026, 8);
  for (const x of [bx0 + 0.015, bx1 - 0.015]) for (const z of [14.55, 16.5, 18.45, 19.45, 21.4]) posts.abox(x - 0.012, x + 0.012, Y2 + 0.1, Y2_OH - 0.24, z - 0.03, z + 0.03);
  K.add(posts, { c: C.rack, s, wrap: 0.4 });

  const drapes = [];
  let si = 0;
  for (const [x0, x1, hang] of ROWS) {
    const aisleX = hang < 0 ? x1 - 0.03 : x0 + 0.03; // chains on the aisle side
    const hangX = hang < 0 ? x0 : x1;
    const xc = (x0 + x1) / 2;
    for (const [z0, z1] of SECTIONS) {
      si++;
      const headLow = (si + Math.floor(x0)) % 2 === 0; // which end the pillows are
      const za = z0 + 0.05, zb = z1 - 0.05;
      // bunk locker under the bottom berth
      locker.abox(x0 + 0.04, x1 - 0.04, Y2 + 0.015, Y2 + 0.36, za + 0.03, zb - 0.03);
      lockerD.abox(aisleX - 0.02, aisleX + 0.02, Y2 + 0.2, Y2 + 0.26, (z0 + z1) / 2 - 0.03, (z0 + z1) / 2 + 0.03);
      env.occ.push([x0 + 0.04, x1 - 0.04, Y2 + 0.015, Y2 + 0.36, za + 0.03, zb - 0.03]);
      for (const h of TIERS) {
        const y = Y2 + h;
        // frame
        frame.cyl(v3(x0 + 0.03, y, za), v3(x0 + 0.03, y, zb), 0.016, 6);
        frame.cyl(v3(x1 - 0.03, y, za), v3(x1 - 0.03, y, zb), 0.016, 6);
        frame.cyl(v3(x0 + 0.03, y, za), v3(x1 - 0.03, y, za), 0.016, 6);
        frame.cyl(v3(x0 + 0.03, y, zb), v3(x1 - 0.03, y, zb), 0.016, 6);
        // hinge hangers on the post or bulkhead side
        for (const z of [za + 0.02, zb - 0.02]) hard.abox(Math.min(hangX, hangX - hang * 0.06), Math.max(hangX, hangX - hang * 0.06), y - 0.03, y + 0.02, z - 0.02, z + 0.02);
        // canvas laced inside the frame
        canvas.abox(x0 + 0.045, x1 - 0.045, y - 0.014, y - 0.004, za + 0.02, zb - 0.02);
        const roll = rnd();
        const state = roll < 0.42 ? 'made' : roll < 0.66 ? 'rolled' : 'unmade';
        const head = headLow ? za + 0.04 : zb - 0.34, foot = headLow ? zb - 0.42 : za + 0.04;
        if (state === 'rolled') {
          // mattress rolled up at the head with the bedding inside it, canvas bare
          const zr = headLow ? za + 0.16 : zb - 0.16;
          mat.cyl(v3(x0 + 0.06, y + 0.12, zr), v3(x1 - 0.06, y + 0.12, zr), 0.12, 10, true);
          env.occ.push([x0 + 0.05, x1 - 0.05, y - 0.02, y + 0.24, zr - 0.13, zr + 0.13]);
          continue;
        }
        mat.abox(x0 + 0.05, x1 - 0.05, y + 0.002, y + 0.098, za + 0.02, zb - 0.02);
        env.occ.push([x0 + 0.03, x1 - 0.03, y - 0.02, y + 0.1, za, zb]);
        const bl = blanket[Math.floor(rnd() * blanket.length)];
        if (state === 'made') {
          pillow.abox(xc - 0.2, xc + 0.2, y + 0.098, y + 0.18, head, head + 0.3);
          bl.abox(x0 + 0.07, x1 - 0.07, y + 0.098, y + 0.17, foot, foot + 0.38);
        } else {
          const tw = (rnd() - 0.5) * 0.5;
          const pm = new THREE.Matrix4().makeRotationY(tw).setPosition(xc + (rnd() - 0.5) * 0.08, y + 0.14, head + 0.15);
          pillow.box(pm, 0.2, 0.042, 0.15);
          drapes.push({ x0, x1, y: y + 0.098, z0: headLow ? za + 0.45 : za + 0.1, z1: headLow ? zb - 0.05 : zb - 0.5, aisle: -hang, c: C.blankets[Math.floor(rnd() * C.blankets.length)], seed: rnd() * 100 });
        }
      }
      // chains from padeyes on the overhead (or a beam's flange) down through the tiers
      for (const z of [za + 0.04, zb - 0.04]) {
        const onBeam = BERTH_BEAMS.some((b) => Math.abs(b - z) < 0.07);
        const top = onBeam ? Y2_OH - 0.22 : Y2_OH - 0.005;
        const bottom = Y2 + TIERS[0] - 0.02;
        hard.abox(aisleX - 0.02, aisleX + 0.02, top - 0.02, top, z - 0.02, z + 0.02);
        const nl = Math.floor((top - bottom) / 0.048);
        for (let k = 0; k < nl; k++) {
          const m = new THREE.Matrix4().makeRotationY(k % 2 ? HALF : 0).setPosition(aisleX, top - 0.03 - k * 0.048, z);
          chainMd.box(m, 0.006, 0.03, 0.014);
        }
      }
    }
  }
  K.add(frame, { c: C.rack, s, wrap: 0.5 });
  K.add(canvas, { c: C.canvas, s, recv: true, grime: 0.12 });
  K.add(mat, { c: C.ticking, s, recv: true, grime: 0.1 });
  K.add(pillow, { c: C.pillow, s, recv: true, wrap: 0.3 });
  blanket.forEach((b, i) => K.add(b, { c: C.blankets[i], s, recv: true, wrap: 0.25, grime: 0.15 }));
  K.add(hard, { c: C.steel, s, wrap: 0.3 });
  K.add(chainMd, { c: C.steel, s, wrap: 0.6, grime: 0 });
  K.add(locker, { c: C.gray, s, recv: true, grime: 0.12 });
  K.add(lockerD, { c: C.steel, s });
  // thrown-back blankets: a sheet draped over the mattress, sliding off on the aisle side
  for (const d of drapes) {
    const xc = (d.x0 + d.x1) / 2, w = 0.85, l = d.z1 - d.z0;
    const g = new THREE.PlaneGeometry(w, l, 8, 10).rotateX(-HALF).translate(xc + d.aisle * 0.1, d.y, (d.z0 + d.z1) / 2);
    const p = g.attributes.position;
    const edge = (d.x1 - d.x0) / 2 - 0.05;
    for (let k = 0; k < p.count; k++) {
      let x = p.getX(k), y = p.getY(k);
      const z = p.getZ(k), off = (x - xc) * d.aisle;
      if (off > edge) {
        const over = off - edge;
        x = xc + d.aisle * (edge + over * 0.25);
        y -= over * 1.1;
      } else if (off < -edge) x = xc - d.aisle * edge;
      y += 0.012 + 0.05 * Math.max(0, noise3(x * 7 + d.seed, z * 5, d.seed)) + 0.015 * Math.sin(z * 17 + d.seed);
      p.setXYZ(k, x, y, z);
    }
    g.computeVertexNormals();
    K.add(g, { c: d.c, s, recv: true, wrap: 0.3, grime: 0.12 });
  }

  // stand-up lockers on the forward and after bulkheads
  lockerBank(K, env, s, v3(2.35, Y2, bz0), v3(0, 0, 1), 5, 0.56);
  lockerBank(K, env, s, v3(6.75, Y2, bz1), v3(0, 0, -1), 5, 0.6);

  // life jackets on the posts, seabags, shoes, a helmet
  const kapok = new MeshData(), bags = new MeshData(), shoes = new MeshData();
  for (const [x, z, a] of [[3.15, 16.5, 0.2], [5.65, 19.45, -0.3], [3.15, 19.45, 2.9], [5.65, 14.55, 3.3]]) {
    const m = new THREE.Matrix4().makeRotationY(a).setPosition(x, Y2 + 1.25, z);
    kapok.box(mAt(m, 0, 0, 0.08), 0.17, 0.24, 0.04);
    kapok.box(mAt(m, 0, -0.02, 0.13), 0.15, 0.21, 0.025);
  }
  for (const [x, z] of [[1.25, 14.25], [1.45, 21.75], [7.3, 14.3]]) bags.cyl(v3(x, Y2, z), v3(x, Y2 + 0.62, z), 0.16, 10, true, 0.12);
  for (const [x, z, a] of [[6.45, 15.6, 0.3], [6.5, 17.2, -0.2], [7.45, 20.0, 2.8], [1.75, 18.0, 0.1], [4.95, 20.9, 1.6]]) {
    for (const o of [-0.06, 0.06]) {
      const m = new THREE.Matrix4().makeRotationY(a).setPosition(x + o * Math.cos(a), Y2 + 0.045, z - o * Math.sin(a));
      shoes.box(m, 0.045, 0.045, 0.14);
    }
  }
  K.add(kapok, { c: C.kapok, s, recv: true, wrap: 0.3 });
  K.add(bags, { c: C.seabag, s, recv: true, wrap: 0.3, grime: 0.15 });
  K.add(shoes, { c: C.shoe, s, recv: true });
  K.add(new THREE.SphereGeometry(0.15, 12, 6, 0, PI * 2, 0, HALF).scale(1, 0.75, 1.15).translate(8.0, Y2 + 0.37, 17.2), { c: hex(0x4c534d), s, recv: true, wrap: 0.3 });

  // lights, battle lantern, the compartment's number
  for (const [x, z] of [[XC, 15.8], [XC, 19.5], [2.05, 17.5], [2.05, 20.6], [6.975, 16.9], [6.975, 20.6]]) globe(K, env, s, x, Y2_OH - 0.34, z, Y2_OH, 1.0);
  battleLantern(K, s, v3(5.3, Y2 + 2.0, bz1), v3(0, 0, -1));
  staticDoor(K, LBL, s, v3(6.975, Y2 + DOOR.sill, bz0), v3(0, 0, 1), 'B-203-L');
  label(LBL, 'B-205-L', s, v3(3.66, Y2 + 1.55, bz1), v3(0, 0, -1));
}

// ---------------------------------------------------------------- passageways

function passages(K, LBL, env) {
  // second deck passageway: berthing door forward, ladder up through the main deck aft
  {
    const s = 'pass2';
    const [x0, x1, , y1, z0, z1] = SPACES[s].box;
    shell(K, s, {
      over: [hole(H1.x0, H1.x1, y1 - 0.1, y1 + 0.1, H1.z0, H1.z1)],
      pz: [hole(XC - DOOR.w / 2, XC + DOOR.w / 2, D1.o.y, D1.o.y + DOOR.h, 21.9, 22.1)],
    });
    beams(K, s, { skip: [[H1.z0, H1.z1]], carlings: [[H1.x0 - 0.015, 24.44, 26.88], [H1.x1 + 0.015, 24.44, 26.88]] });
    pipeRun(K, s, [{ x: 4.9, y: 7.34, r: 0.026 }, { x: 5.0, y: 7.3, r: 0.042, lagged: true }], z0, z1);
    cableRun(K, s, x0, 1, 7.38, z0, z1, 5);
    fireStation(K, LBL, s, v3(x0, Y2, 24.2), v3(1, 0, 0), y1);
    phoneBox(K, LBL, s, v3(x1, Y2 + 1.45, 24.05), v3(-1, 0, 0));
    battleLantern(K, s, v3(x1, Y2 + 1.95, 22.5), v3(-1, 0, 0));
    label(LBL, 'B-207-L', s, v3(x1, Y2 + 1.6, 23.2), v3(-1, 0, 0));
    globe(K, env, s, XC, y1 - 0.32, 23.85, y1);
    globe(K, env, s, XC, y1 - 0.32, 27.06, y1, 0.8);
  }
  // main deck passageway: hatch from below forward, ladder to the 01 level aft
  {
    const s = 'pass1';
    const [x0, x1, y0, y1, z0, z1] = SPACES[s].box;
    shell(K, s, {
      floor: [hole(H1.x0, H1.x1, y0 - 0.1, y0 + 0.1, H1.z0, H1.z1)],
      over: [hole(H2.x0, H2.x1, y1 - 0.1, y1 + 0.1, H2.z0, H2.z1)],
    });
    beams(K, s, { depth: 0.15, skip: [[H2.z0, H2.z1]], carlings: [[H2.x0 - 0.015, 31.12, 33.56], [H2.x1 + 0.015, 31.12, 33.56]] });
    // ventilation supply trunk along the starboard side, pipes and cables to port
    const duct = new MeshData();
    duct.abox(4.84, 5.09, y1 - 0.27, y1 - 0.01, z0, 27.75);
    duct.abox(4.84, 5.09, y1 - 0.27, y1 - 0.01, 27.75, 27.95); // elbow up into the overhead
    for (let z = z0 + 1.5; z < 27.7; z += 1.5) duct.abox(4.83, 5.1, y1 - 0.28, y1 - 0.01, z - 0.02, z + 0.02);
    K.add(duct, { c: C.white, s, grime: 0.06 });
    pipeRun(K, s, [{ x: 3.8, y: y1 - 0.2, r: 0.03 }, { x: 3.9, y: y1 - 0.12, r: 0.024 }], z0, z1);
    cableRun(K, s, x0, 1, y1 - 0.06, z0, z1, 4);
    stiffeners(K, s, x0, 1, z0, z1);
    staticDoor(K, LBL, s, v3(XC, y0 + DOOR.sill, z0), v3(0, 0, 1), 'B-103-L');
    staticDoor(K, LBL, s, v3(XC, y0 + DOOR.sill, z1), v3(0, 0, -1), 'B-107-L');
    staticDoor(K, LBL, s, v3(x1, y0 + DOOR.sill, 28.4), v3(-1, 0, 0), 'B-109-A');
    battleLantern(K, s, v3(x0, y0 + 1.85, 27.6), v3(1, 0, 0));
    phoneBox(K, LBL, s, v3(x0, y0 + 1.4, 30.3), v3(1, 0, 0));
    label(LBL, 'B-105-L', s, v3(x0, y0 + 1.6, 29.0), v3(1, 0, 0));
    for (const z of [24.4, 28.07, 30.5, 34.1]) globe(K, env, s, XC, y1 - 0.19, z, y1, 0.85);
  }
  // 01 level passageway: hatch from below, weather door in the after bulkhead
  {
    const s = 'pass01';
    const [x0, x1, y0, y1, z0, z1] = SPACES[s].box;
    shell(K, s, {
      floor: [hole(H2.x0, H2.x1, y0 - 0.1, y0 + 0.1, H2.z0, H2.z1)],
      nz: [hole(XC - DOOR.w / 2, XC + DOOR.w / 2, D2.o.y, D2.o.y + DOOR.h, z1 - 0.1, z1 + 0.1)],
    });
    beams(K, s, { depth: 0.2 });
    pipeRun(K, s, [{ x: 3.82, y: y1 - 0.26, r: 0.034 }, { x: 3.95, y: y1 - 0.3, r: 0.022 }], z0, z1);
    cableRun(K, s, x1, -1, y1 - 0.1, z0, z1, 5);
    stiffeners(K, s, x0, 1, z0, z1);
    staticDoor(K, LBL, s, v3(x1, y0 + DOOR.sill, 34.0), v3(-1, 0, 0), 'B-0105-L');
    phoneBox(K, LBL, s, v3(XC, y0 + 1.45, z0), v3(0, 0, 1));
    battleLantern(K, s, v3(x0, y0 + 1.95, 35.5), v3(1, 0, 0));
    label(LBL, 'B-0103-L', s, v3(x0, y0 + 1.6, 34.2), v3(1, 0, 0));
    globe(K, env, s, XC, y1 - 0.3, 31.5, y1, 0.9);
    globe(K, env, s, XC, y1 - 0.3, 35.15, y1, 0.9);
  }
}

// vertical bulkhead stiffeners every 0.61 m on one side of a passageway
function stiffeners(K, s, x, dir, z0, z1) {
  const [, , y0, y1] = SPACES[s].box;
  const md = new MeshData();
  for (let z = z0 + 0.61; z < z1 - 0.3; z += 0.61) {
    md.abox(Math.min(x, x + dir * 0.07), Math.max(x, x + dir * 0.07), y0 + 0.05, y1 - 0.02, z - 0.005, z + 0.005);
    md.abox(Math.min(x + dir * 0.06, x + dir * 0.07), Math.max(x + dir * 0.06, x + dir * 0.07), y0 + 0.05, y1 - 0.02, z - 0.03, z + 0.03);
  }
  K.add(md, { c: C.white, s, recv: true, grime: 0.06 });
}

// ---------------------------------------------------------------- doors

/**
 * Watertight door in door space: x along the bulkhead, y up from the sill, z along n (the leaf
 * side). Returns the pieces sorted by where they go: side A (-n), side B (+n), the leaf's A and
 * B faces, plus the hinge position.
 */
function doorParts({ dA = 0.05, dB = 0.05, through = true } = {}) {
  const { w, h, r } = DOOR;
  const inner = rrect(w, h, r), outer = rrect(w, h, r, 0.075), leafO = rrect(w, h, r, 0.065);
  const P = {
    a: new MeshData(), b: new MeshData(), sleeveA: new MeshData(), sleeveB: new MeshData(), steelA: new MeshData(), steelB: new MeshData(),
    knife: new MeshData(), leafA: new MeshData(), leafB: new MeshData(), leafSide: new MeshData(), gasket: new MeshData(), leafSteelA: new MeshData(), leafSteelB: new MeshData(),
  };
  if (through) {
    band(P.sleeveA, inner, -dA, 0, true);
    band(P.sleeveB, inner, 0, dB, true);
    ring(P.a, inner, outer, -dA, -1);
    band(P.a, outer, -dA, 0);
  }
  ring(P.b, inner, outer, dB, 1);
  band(P.b, outer, 0, dB);
  // knife edge on the leaf side, bearing on the gasket
  const k0 = rrect(w, h, r, 0.028), k1 = rrect(w, h, r, 0.04);
  ring(P.knife, k0, k1, dB + 0.02, 1);
  band(P.knife, k1, dB, dB + 0.02);
  band(P.knife, k0, dB, dB + 0.02, true);
  // leaf: plate with gasket, stiffeners and handles
  const z0 = dB + 0.02, z1 = dB + 0.07;
  cap(P.leafA, leafO, z0, -1);
  cap(P.leafB, leafO, z1, 1);
  band(P.leafSide, leafO, z0, z1);
  const g0 = rrect(w, h, r, 0.018), g1 = rrect(w, h, r, 0.05);
  ring(P.gasket, g0, g1, z0 - 0.008, -1);
  for (const y of [h * 0.3, h * 0.68]) P.leafB.abox(-w / 2 + 0.02, w / 2 - 0.02, y - 0.035, y + 0.035, z1, z1 + 0.014);
  const hx = w / 2 - 0.08;
  for (const [tgt, z, s] of [[P.leafSteelB, z1, 1], [P.leafSteelA, z0, -1]]) {
    tgt.cyl(v3(hx, h * 0.5 - 0.09, z + s * 0.06), v3(hx, h * 0.5 + 0.09, z + s * 0.06), 0.012, 6);
    tgt.cyl(v3(hx, h * 0.5 - 0.09, z), v3(hx, h * 0.5 - 0.09, z + s * 0.06), 0.01, 5);
    tgt.cyl(v3(hx, h * 0.5 + 0.09, z), v3(hx, h * 0.5 + 0.09, z + s * 0.06), 0.01, 5);
  }
  // hinges: knuckles on the frame, straps on the leaf
  const xh = -(w / 2 + 0.12), zh = dB + 0.045;
  for (const y of [0.28, h - 0.28]) {
    P.b.cyl(v3(xh, y - 0.07, zh), v3(xh, y + 0.07, zh), 0.024, 8, true);
    P.b.abox(xh - 0.01, -w / 2 - 0.06, y - 0.05, y + 0.05, dB, zh);
    P.leafB.abox(xh + 0.02, -w / 2 + 0.2, y - 0.035, y + 0.035, z1, z1 + 0.012);
  }
  // dogs: wedge arms on the leaf side (swung clear, ready to dog), handles on the other side
  const dogs = [[w / 2 + 0.11, 0.35], [w / 2 + 0.11, h / 2], [w / 2 + 0.11, h - 0.35], [0, h + 0.11], [0, -0.11], [-(w / 2 + 0.11), h / 2]];
  for (const [x, y] of dogs) {
    const ang = Math.atan2(y - h / 2, x) + (x > 0.1 ? 0.9 : 0) + HALF;
    const m = new THREE.Matrix4().makeRotationZ(ang).setPosition(x, y, dB + 0.03);
    P.steelB.cyl(v3(x, y, 0), v3(x, y, dB + 0.05), 0.018, 8, true);
    P.steelB.box(mAt(m, 0, 0.05, 0.02), 0.014, 0.06, 0.012);
    if (through) {
      const ma = new THREE.Matrix4().makeRotationZ(ang + 0.4).setPosition(x, y, -dA - 0.02);
      P.steelA.cyl(v3(x, y, 0), v3(x, y, -dA - 0.04), 0.015, 8, true);
      P.steelA.box(mAt(ma, 0, 0.055, -0.01), 0.012, 0.07, 0.01);
    }
  }
  return { P, xh, zh, inner };
}

// a closed door into a compartment off the route: frame and leaf on the bulkhead face only
function staticDoor(K, LBL, s, o, n, text) {
  const M = wallFrame(o, n);
  const { P } = doorParts({ dB: 0.012, through: false });
  const paint = { c: C.white, s, m: M, recv: true, grime: 0.08 };
  for (const k of ['b', 'leafA', 'leafB', 'leafSide']) K.add(P[k], paint);
  K.add(P.knife, { c: C.bright, s, m: M });
  K.add(P.gasket, { c: C.rubber, s, m: M });
  for (const k of ['steelB', 'leafSteelB']) K.add(P[k], { c: C.steel, s, m: M, wrap: 0.3 });
  if (text) label(LBL, text, s, v3(0, DOOR.h - 0.35, 0.012 + 0.07 + 0.016).applyMatrix4(M), n, 0.2, 0.16);
}

/** A route door: static frame plus a hinged leaf on a pivot; side B null means the weather side. */
function routeDoor(K, X, group, movers, D) {
  const M = wallFrame(D.o, D.n);
  const { P, xh, zh, inner } = doorParts({ dA: D.dA, dB: D.dB });
  const inA = { c: C.white, s: D.a, m: M, recv: true, grime: 0.08 };
  const outside = !D.b;
  const inB = { c: C.white, s: D.b || D.a, m: M, recv: true, grime: 0.08 };
  K.add(P.a, inA);
  K.add(P.sleeveA, inA);
  K.add(P.sleeveB, inB);
  K.add(P.steelA, { c: C.steel, s: D.a, m: M, wrap: 0.3 });
  if (outside) {
    X.add(P.b, { m: M });
    X.add(P.knife, { color: C.bright, m: M });
    X.add(P.steelB, { color: C.steel, m: M });
  } else {
    K.add(P.b, inB);
    K.add(P.knife, { c: C.bright, s: D.b, m: M });
    K.add(P.steelB, { c: C.steel, s: D.b, m: M, wrap: 0.3 });
  }
  // the leaf on its hinge pivot. The mount stands at deck zero under the hinge and the leaf keeps
  // its true height in the pivot's space, so the ship's paint shader (which works in object
  // space) doesn't take the weather side of the leaf for boot topping.
  const hinge = v3(xh, 0, zh).applyMatrix4(M);
  const local = new THREE.Matrix4().makeTranslation(-xh, D.o.y, -zh);
  const mount = new THREE.Object3D();
  mount.position.set(hinge.x, 0, hinge.z);
  mount.quaternion.setFromRotationMatrix(M);
  const pivot = new THREE.Object3D();
  pivot.name = D.name;
  mount.add(pivot);
  group.add(mount);
  const kit = new Kit();
  kit.bake = new THREE.Matrix4().makeRotationFromQuaternion(mount.quaternion).setPosition(mount.position);
  kit.add(P.leafA, { c: C.white, s: D.a, m: local, grime: 0.08 });
  kit.add(P.gasket, { c: C.rubber, s: D.a, m: local });
  kit.add(P.leafSteelA, { c: C.steel, s: D.a, m: local, wrap: 0.3 });
  kit.add(P.leafSide, { c: C.white, s: D.a, m: local });
  let paint = null;
  if (outside) {
    paint = new PaintKit();
    paint.add(P.leafB, { m: local });
    paint.add(P.leafSteelB, { color: C.steel, m: local });
  } else {
    kit.add(P.leafB, { c: C.white, s: D.b, m: local, grime: 0.08 });
    kit.add(P.leafSteelB, { c: C.steel, s: D.b, m: local, wrap: 0.3 });
  }
  movers.push({ kit, paint, pivot });
  return { pivot, mask: outside ? { M, inner, z: D.dB * 0.65 } : null };
}

// ---------------------------------------------------------------- hatches and ladders

function hatch(K, env, group, movers, masks, H) {
  const { x0, x1, z0, z1, y, below, upper, lower } = H;
  const W = x1 - x0, L = z1 - z0, xc = (x0 + x1) / 2;
  const X = v3(1, 0, 0), Y = v3(0, 1, 0), Z = v3(0, 0, 1);
  const lit = [upper, lower];
  const dy = y - below;
  // trunk lining through the deck
  const trunk = { c: C.white, s: upper, lit, grime: 0.06 };
  K.add(grid(v3(x0, below, z0), X, Y, W, dy, 0.2), trunk);
  K.add(grid(v3(x0, below, z1), Y, X, dy, W, 0.2), trunk);
  K.add(grid(v3(x0, below, z0), Y, Z, dy, L, 0.2), trunk);
  K.add(grid(v3(x1, below, z0), Z, Y, L, dy, 0.2), trunk);
  // coaming with its knife edge, dogs and hinge knuckles
  const t = 0.012, cm = new MeshData(), ke = new MeshData(), st = new MeshData();
  cm.abox(x0 - t, x1 + t, y, y + COAMING, z0 - t, z0);
  cm.abox(x0 - t, x1 + t, y, y + COAMING, z1, z1 + t);
  cm.abox(x0 - t, x0, y, y + COAMING, z0, z1);
  cm.abox(x1, x1 + t, y, y + COAMING, z0, z1);
  K.add(cm, { c: C.white, s: upper, lit, grime: 0.1 });
  const ky = y + COAMING;
  ke.abox(x0 - 0.008, x1 + 0.008, ky, ky + 0.012, z0 - 0.009, z0 - 0.003);
  ke.abox(x0 - 0.008, x1 + 0.008, ky, ky + 0.012, z1 + 0.003, z1 + 0.009);
  ke.abox(x0 - 0.009, x0 - 0.003, ky, ky + 0.012, z0, z1);
  ke.abox(x1 + 0.003, x1 + 0.009, ky, ky + 0.012, z0, z1);
  K.add(ke, { c: C.bright, s: upper });
  for (const [x, s] of [[x0 - t, -1], [x1 + t, 1]]) {
    for (const z of [z0 + L * 0.3, z0 + L * 0.75]) {
      st.cyl(v3(x, ky - 0.06, z), v3(x + s * 0.05, ky - 0.06, z), 0.016, 6, true);
      st.box(new THREE.Matrix4().makeRotationZ(s * 0.5).setPosition(x + s * 0.06, ky - 0.03, z), 0.012, 0.06, 0.012);
    }
  }
  const yh = y + COAMING + 0.032, zh = z0 - 0.06;
  for (const dx of [-0.25, 0.25]) st.cyl(v3(xc + dx - 0.06, yh, zh), v3(xc + dx + 0.06, yh, zh), 0.022, 8, true);
  K.add(st, { c: C.steel, s: upper, wrap: 0.3 });
  // the cover on its hinge: plate, gasket, stiffeners underneath, scuttle and lifting handles on top
  const mount = new THREE.Object3D();
  mount.position.set(xc, yh, zh);
  const pivot = new THREE.Object3D();
  pivot.name = H.name;
  mount.add(pivot);
  group.add(mount);
  const kit = new Kit();
  const open = -1.75;
  kit.bake = new THREE.Matrix4().makeTranslation(xc, yh, zh).multiply(new THREE.Matrix4().makeRotationX(open));
  const plate = new MeshData(), dark = new MeshData(), fit = new MeshData();
  const pw = W / 2 + 0.05, pl = L + 0.11;
  plate.abox(-pw, pw, -0.02, 0.02, 0, pl);
  for (const x of [-W / 4, W / 4]) plate.abox(x - 0.006, x + 0.006, -0.08, -0.02, 0.08, pl - 0.06);
  for (const z of [pl * 0.33, pl * 0.66]) plate.abox(-pw + 0.06, pw - 0.06, -0.07, -0.02, z - 0.006, z + 0.006);
  dark.abox(-pw + 0.02, pw - 0.02, -0.026, -0.02, 0.02, 0.06);
  dark.abox(-pw + 0.02, pw - 0.02, -0.026, -0.02, pl - 0.06, pl - 0.02);
  dark.abox(-pw + 0.02, -pw + 0.06, -0.026, -0.02, 0.02, pl - 0.02);
  dark.abox(pw - 0.06, pw - 0.02, -0.026, -0.02, 0.02, pl - 0.02);
  const sc = pl * 0.55;
  fit.cyl(v3(0, 0.02, sc), v3(0, 0.05, sc), 0.24, 18, true);
  fit.cyl(v3(0, 0.05, sc), v3(0, 0.1, sc), 0.012, 5);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * PI * 2;
    fit.cyl(v3(0, 0.1, sc), v3(Math.cos(a) * 0.09, 0.1, sc + Math.sin(a) * 0.09), 0.006, 3);
  }
  for (const x of [-0.18, 0.18]) fit.pipe([v3(x - 0.05, 0.02, pl - 0.12), v3(x - 0.05, 0.06, pl - 0.12), v3(x + 0.05, 0.06, pl - 0.12), v3(x + 0.05, 0.02, pl - 0.12)], 0.009, 5);
  for (const dx of [-0.25, 0.25]) fit.abox(dx - 0.04, dx + 0.04, 0.02, 0.032, 0.0, 0.3);
  kit.add(plate, { c: C.hatch, s: upper, grime: 0.12 });
  kit.add(dark, { c: C.rubber, s: upper });
  kit.add(fit, { c: C.steel, s: upper, wrap: 0.4 });
  kit.add(new THREE.TorusGeometry(0.09, 0.008, 4, 14).rotateX(HALF).translate(0, 0.1, sc), { c: C.red, s: upper, wrap: 0.4 });
  movers.push({ kit, paint: null, pivot });
  // portal mask just above the ship's own deck surface, inside the opening
  const ym = y - 0.005;
  masks.quad(v3(x0, ym, z0), v3(x1, ym, z0), v3(x1, ym, z1), v3(x0, ym, z1), UP);
  return { object: pivot, axis: 'x', closedAngle: 0, openAngle: open, name: H.name, hatch: true };
}

/**
 * Inclined ladder from bottom b to top t (tread line): stringers, treads with non-skid bars and
 * nosings, handrails both sides that carry on past the top to posts on the upper deck.
 */
function ladderParts(L, { w = 0.61, rail = 0.88, over = 0.32 } = {}) {
  const { b, t, floor } = L;
  const d = t.clone().sub(b), len = d.length(), dir = d.clone().normalize();
  const dh = v3(d.x, 0, d.z).normalize();
  const lat = v3(-dh.z, 0, dh.x);
  const nrm = UP.clone().addScaledVector(dir, -dir.y).normalize();
  const str = new MeshData(), tread = new MeshData(), rails = new MeshData();
  for (const sg of [-1, 1]) {
    const c = b.clone().add(t).multiplyScalar(0.5).addScaledVector(lat, sg * (w / 2 + 0.008)).addScaledVector(nrm, -0.06);
    str.box(new THREE.Matrix4().makeBasis(lat, nrm, dir).setPosition(c), 0.006, 0.1, len / 2 + 0.04);
  }
  const steps = Math.round((t.y - b.y) / 0.24);
  const TB = new THREE.Matrix4().makeBasis(lat, UP, dh);
  for (let i = 1; i < steps; i++) {
    const p = b.clone().addScaledVector(d, i / steps);
    tread.box(TB.clone().setPosition(p.clone().addScaledVector(dh, 0.05).addScaledVector(UP, -0.012)), w / 2, 0.012, 0.085);
    tread.cyl(p.clone().addScaledVector(lat, -w / 2).addScaledVector(dh, -0.035).addScaledVector(UP, -0.01), p.clone().addScaledVector(lat, w / 2).addScaledVector(dh, -0.035).addScaledVector(UP, -0.01), 0.013, 6);
    for (const f of [0.015, 0.06, 0.105]) tread.box(TB.clone().setPosition(p.clone().addScaledVector(dh, f).addScaledVector(UP, 0.003)), w / 2 - 0.02, 0.004, 0.006);
  }
  for (const sg of [-1, 1]) {
    const o = lat.clone().multiplyScalar(sg * (w / 2 + 0.06));
    const b0 = b.clone().add(o), t0 = t.clone().add(o);
    const bt = b0.clone().addScaledVector(UP, rail), tt = t0.clone().addScaledVector(UP, rail);
    const end = tt.clone().addScaledVector(dh, over);
    rails.pipe([bt, tt, end], 0.019, 8);
    rails.cyl(b0, bt, 0.019, 8);
    rails.cyl(v3(end.x, floor, end.z), end, 0.019, 8);
    // stringer brackets to the rail
    rails.cyl(b0.clone().addScaledVector(d, 0.5).addScaledVector(UP, 0.02), b0.clone().addScaledVector(d, 0.5).addScaledVector(UP, rail), 0.012, 5);
  }
  return { str, tread, rails, dh, lat };
}

function interiorLadder(K, L, s, lit) {
  const { str, tread, rails } = ladderParts(L);
  K.add(str, { c: C.gray, s, lit, grime: 0.1, wrap: 0.3 });
  K.add(tread, { c: C.deckGray, s, lit, grime: 0.15, wrap: 0.3 });
  K.add(rails, { c: C.white, s, lit, wrap: 0.4 });
}

// guard rails along the sides of a hatch opening, outside the coaming (the open cover closes the forward end)
function hatchRails(K, H, s) {
  const md = new MeshData();
  const top = H.y + 0.9, mid = H.y + 0.48, za = H.z0 + 0.12, zb = H.z1 + 0.05;
  for (const x of [H.x0 - 0.05, H.x1 + 0.05]) {
    md.cyl(v3(x, H.y, za), v3(x, top, za), 0.019, 8);
    md.cyl(v3(x, H.y, zb), v3(x, top, zb), 0.019, 8);
    md.cyl(v3(x, top, za), v3(x, top, zb), 0.019, 8);
    md.cyl(v3(x, mid, za), v3(x, mid, zb), 0.014, 6);
  }
  K.add(md, { c: C.white, s, wrap: 0.4 });
}

// ---------------------------------------------------------------- the route

// running speeds along each kind of stretch, m/s (waypoints may override: tight turns, the narrow strip by the tub)
const SPEED = { start: 2.2, walk: 3.4, door: 1.3, ladder: 0.95, hatch: 0.8, exit: 2.4, deck: 4.0, tub: 1.4 };

function buildPath() {
  const path = [];
  const add = (x, y, z, tag, o) => {
    const feet = o.feet || v3(x, y - EYE, z);
    path.push({ p: v3(x, y, z), tag, speed: SPEED[tag], feet, half: 0, ...o });
    return path.length - 1;
  };
  const walk = (x, floor, z, space, half, tag = 'walk', extra = {}) => add(x, floor + EYE, z, tag, { feet: v3(x, floor, z), space, half, ...extra });
  const climb = (L, space, hatchIndex, overhead) => {
    const d = L.t.clone().sub(L.b), dh = v3(d.x, 0, d.z).normalize();
    const foot = L.b.clone().addScaledVector(dh, -0.32);
    add(foot.x, foot.y + EYE, foot.z, 'ladder', { feet: foot, space });
    let tagged = false;
    for (const t of [0.2, 0.4, 0.6, 0.8, 1.0]) {
      const f = L.b.clone().addScaledVector(d, t);
      const e = f.clone().addScaledVector(UP, CLIMB_EYE).addScaledVector(dh, -0.15);
      const extra = {};
      let tag = 'ladder';
      if (hatchIndex != null && !tagged && e.y > overhead) {
        tag = 'hatch';
        extra.hatch = hatchIndex;
        tagged = true;
      }
      add(e.x, e.y, e.z, tag, { feet: f, space, ...extra });
    }
    const off = L.t.clone().addScaledVector(dh, 0.36);
    return off;
  };

  // berthing: out of the racks at the head of the starboard aisle, aft along it, across, aft to the door
  const turn = { speed: 2.4 };
  walk(6.975, Y2, 15.0, 'berth', 0.3, 'start');
  walk(6.975, Y2, 16.1, 'berth', 0.3, 'walk', { speed: 3.0 });
  walk(6.975, Y2, 17.2, 'berth', 0.3, 'walk', { speed: 3.0 });
  walk(6.94, Y2, 18.15, 'berth', 0.25, 'walk', turn);
  walk(6.62, Y2, 18.78, 'berth', 0.15, 'walk', turn);
  walk(5.95, Y2, 18.95, 'berth', 0.15, 'walk', turn);
  walk(5.2, Y2, 18.95, 'berth', 0.15, 'walk', turn);
  walk(4.62, Y2, 19.25, 'berth', 0.15, 'walk', turn);
  walk(4.43, Y2, 19.85, 'berth', 0.25, 'walk', { speed: 3.0 });
  walk(XC, Y2, 20.7, 'berth', 0.25, 'walk', { speed: 3.0 });
  walk(XC, Y2, 21.45, 'berth', 0.2, 'walk', { speed: 2.0 });
  const d1 = add(XC, Y2 + DUCK, 22.0, 'door', { feet: v3(XC, Y2 + DOOR.sill, 22.0), space: 'pass2', door: 0 });
  walk(XC, Y2, 22.6, 'pass2', 0.3, 'walk', { speed: 2.6 });
  walk(XC, Y2, 23.45, 'pass2', 0.35);
  walk(XC, Y2, 24.25, 'pass2', 0.2, 'walk', { speed: 2.0 });
  const l1 = path.length;
  let off = climb(L1, 'pass2', 0, Y2_OH);
  walk(off.x, Y1, off.z, 'pass1', 0.1, 'walk', { speed: 2.0 });
  walk(XC, Y1, 27.8, 'pass1', 0.35);
  walk(XC, Y1, 28.8, 'pass1', 0.35);
  walk(XC, Y1, 29.8, 'pass1', 0.35);
  walk(XC, Y1, 30.7, 'pass1', 0.25, 'walk', { speed: 2.0 });
  const l2 = path.length;
  off = climb(L2, 'pass1', 1, Y1_OH);
  walk(off.x, Y01, off.z, 'pass01', 0.1, 'walk', { speed: 2.0 });
  walk(XC, Y01, 34.2, 'pass01', 0.35);
  walk(XC, Y01, 35.15, 'pass01', 0.25, 'walk', { speed: 2.0 });
  const d2 = add(XC, Y01 + DUCK, 35.98, 'door', { feet: v3(XC, Y01 + DOOR.sill, 35.98), space: 'deck01', door: 1 });
  walk(XC, DECK01, 36.45, 'deck01', 0.2, 'exit');
  walk(4.5, DECK01, 36.95, 'deck01', 0.25, 'deck', { speed: 2.6 });
  walk(4.76, DECK01, 37.36, 'deck01', 0.2, 'deck', { speed: 2.0 });
  const lx = path.length;
  off = climb(LX, 'deck01', null, 0);
  walk(off.x, DECK02, 37.62, 'sponson', 0.1, 'deck', { speed: 2.2 });
  walk(8.2, DECK02, 37.76, 'sponson', 0.15, 'deck', { speed: 2.8 });
  walk(9.2, DECK02, 37.84, 'sponson', 0.15, 'deck', { speed: 2.8 });
  walk(10.2, DECK02, 37.88, 'sponson', 0.15, 'deck', { speed: 2.6 });
  walk(10.95, DECK02, 37.9, 'sponson', 0.1, 'deck', { speed: 2.0 });
  walk(11.42, DECK02, 37.84, 'sponson', 0, 'deck', { speed: 1.5 });
  const arrive = walk(11.6, DECK02, 37.7, 'sponson', 0, 'tub', { look: v3(0, -0.12, -1).normalize() });
  return { path, d1, d2, l1, l2, lx, arrive };
}

function lanes(path, offsets = [-0.3, 0.3]) {
  return offsets.map((offset) => ({
    offset,
    points: path.map((w, i) => {
      const a = path[Math.max(0, i - 1)].p, b = path[Math.min(path.length - 1, i + 1)].p;
      const dir = v3(b.x - a.x, 0, b.z - a.z);
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
      dir.normalize();
      const right = v3(-dir.z, 0, dir.x);
      return w.p.clone().addScaledVector(right, clamp(offset, -w.half, w.half));
    }),
  }));
}

// ---------------------------------------------------------------- build

function shipPaintMaterial(model) {
  let mat = null;
  model?.group?.traverse((o) => {
    if (!mat && o.isMesh && o.geometry?.attributes?.aPaint && !o.userData.gqInterior) mat = o.material;
  });
  return mat || new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x3e4855, roughness: 0.8, metalness: 0.1 });
}

/**
 * Build the General Quarters set for the player's battleship. `model` is the buildShip() result
 * (its group lends the ship's paint material to the exterior pieces). Everything returned is in
 * ship space; add `group` to the ship's group (identity transform).
 *
 * {
 *   group                      THREE.Group with `inside` and `outside`
 *   inside                     the spaces, doors, hatches and portal masks; hide it when the
 *                              sequence isn't running (it draws before the ship and costs fill)
 *   outside                    the ladder up to Mount 47's sponson and the weather door's frame,
 *                              lit in the ship's paint: part of the ship, keep it visible
 *   path[]                     { p: eye position, tag, speed (m/s), feet: floor or tread point,
 *                              space (ROUTE_INFO key), half: room either side for lanes,
 *                              door / hatch: index on 'door' / 'hatch' tags, look on 'tub' }
 *                              tags: start, walk, door, ladder, hatch, exit, deck, tub
 *   crewLanes[]                { offset, points[] }: the path shifted sideways by offset (to a
 *                              runner's right), clamped to `half`; one point per waypoint
 *   doors[] / hatches[]        { object (pivot at the hinge), axis 'y' | 'x', closedAngle,
 *                              openAngle, pathIndex (the waypoint passing through it),
 *                              approachIndex (start opening by here), name }; all start closed
 *   info[]                     ROUTE_INFO with `start`, the first waypoint in each compartment
 *   ladders, arrival, length   waypoint indices of the three ladder feet and of the arrival; metres
 *   peel                       { at: waypoint index, dir, length }: where the other men leave the
 *                              route for their own stations, along a clear stretch of deck
 *   stats                      { triangles, drawCalls, lights }
 *   renderOrder                { interior, portal }: anything to be seen through the hatches and
 *                              the weather door (the running crew) must use renderOrder <= interior
 * }
 */
export function buildInterior(model) {
  const rnd = mulberry32(1944);
  const env = { lights: [], occ: [] };
  const K = new Kit(), LBL = new Kit(true), X = new PaintKit();
  const masks = new MeshData();
  const movers = [];
  // `inside`: the spaces, their doors and hatches and the portal masks (only needed while the
  // sequence runs); `outside`: the new ladder and the weather door's frame, part of the ship
  const group = new THREE.Group();
  group.name = 'gq-interior';
  const inside = new THREE.Group();
  inside.name = 'gq-inside';
  const outside = new THREE.Group();
  outside.name = 'gq-outside';
  group.add(inside, outside);

  // decks between the spaces block light except at the hatches
  const slab = (yA, yB, H, za, zb) => {
    env.occ.push([3.6, 5.2, yA, yB, za, H.z0], [3.6, 5.2, yA, yB, H.z1, zb], [3.6, H.x0, yA, yB, H.z0, H.z1], [H.x1, 5.2, yA, yB, H.z0, H.z1]);
  };
  slab(Y2_OH, Y1, H1, 21.9, 34.7);
  slab(Y1_OH, Y01, H2, 23.7, 36.0);

  berthing(K, LBL, env, rnd);
  passages(K, LBL, env);
  const h1 = hatch(K, env, inside, movers, masks, H1);
  const h2 = hatch(K, env, inside, movers, masks, H2);
  hatchRails(K, H1, 'pass1');
  hatchRails(K, H2, 'pass01');
  interiorLadder(K, L1, 'pass2', ['pass2', 'pass1']);
  interiorLadder(K, L2, 'pass1', ['pass1', 'pass01']);
  const dr1 = routeDoor(K, X, inside, movers, D1);
  const dr2 = routeDoor(K, X, inside, movers, D2);
  // the weather door's portal: the opening's outline just outside the deckhouse wall
  {
    const md = new MeshData();
    cap(md, dr2.mask.inner, dr2.mask.z, 1);
    const g = md.geo().applyMatrix4(dr2.mask.M);
    const pos = g.attributes.position, idx = g.index.array;
    const base = masks.p.length / 3;
    for (let i = 0; i < pos.count; i++) masks.v(v3(pos.getX(i), pos.getY(i), pos.getZ(i)), D2.n);
    for (const i of idx) masks.i.push(base + i);
  }
  // the ladder up the sponson's after end, in the ship's paint
  {
    const { str, tread, rails } = ladderParts(LX);
    X.add(str);
    X.add(tread);
    X.add(rails);
  }

  // bake and build the meshes
  bakeKit(K, env);
  bakeKit(LBL, env);
  for (const mv of movers) bakeKit(mv.kit, env);
  const interiorMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const atlas = labelAtlas();
  const labelMat = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, fog: false });
  const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false, fog: false });
  const paintMat = shipPaintMaterial(model);
  const meshes = [];
  const put = (parent, mesh, name) => {
    if (!mesh) return;
    mesh.name = name;
    mesh.userData.gqInterior = true;
    parent.add(mesh);
    meshes.push(mesh);
  };
  put(inside, K.mesh(interiorMat), 'gq-interior-set');
  if (atlas) put(inside, LBL.mesh(labelMat), 'gq-interior-labels');
  const maskMesh = new THREE.Mesh(masks.geo(), maskMat);
  maskMesh.renderOrder = PORTAL_RENDER_ORDER;
  put(inside, maskMesh, 'gq-portals');
  put(outside, X.mesh(paintMat), 'gq-exterior');
  for (const mv of movers) {
    put(mv.pivot, mv.kit.mesh(interiorMat), `${mv.pivot.name}-inside`);
    if (mv.paint) put(mv.pivot, mv.paint.mesh(paintMat), `${mv.pivot.name}-outside`);
  }

  const { path, d1, d2, l1, l2, lx, arrive } = buildPath();
  const hatchIdx = path.map((w, i) => (w.tag === 'hatch' ? i : -1)).filter((i) => i >= 0);
  const doors = [
    { object: dr1.pivot, axis: 'y', closedAngle: 0, openAngle: D1.open, pathIndex: d1, approachIndex: d1 - 3, name: 'B-205-L / B-207-L', opensInto: 'pass2' },
    { object: dr2.pivot, axis: 'y', closedAngle: 0, openAngle: D2.open, pathIndex: d2, approachIndex: d2 - 3, name: 'B-0103-L / weather deck', opensInto: 'deck01' },
  ];
  const hatches = [
    { ...h1, pathIndex: hatchIdx[0], approachIndex: l1 },
    { ...h2, pathIndex: hatchIdx[1], approachIndex: l2 },
  ];
  let length = 0;
  for (let i = 1; i < path.length; i++) length += path[i].p.distanceTo(path[i - 1].p);
  let triangles = 0;
  for (const m of meshes) triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;

  return {
    group,
    inside,
    outside,
    path,
    crewLanes: lanes(path),
    doors,
    hatches,
    info: ROUTE_INFO.map((r) => ({ ...r, start: path.findIndex((w) => w.space === r.space) })),
    ladders: { mainDeck: l1, level01: l2, sponson: lx },
    arrival: arrive,
    // where the other men leave the route: out of the weather door they run aft and inboard along
    // the 01 deck to their own stations (clear of the ventilators for about 14 m)
    peel: { at: d2 + 1, dir: v3(-0.77, 0, 0.64).normalize(), length: 12 },
    length,
    stats: { triangles: Math.round(triangles), drawCalls: meshes.length, lights: env.lights.length },
    renderOrder: { interior: INTERIOR_RENDER_ORDER, portal: PORTAL_RENDER_ORDER },
  };
}
