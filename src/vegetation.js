import * as THREE from 'three';
import { mulberry32, noise3, fbm } from './noise.js';
import { patchMaterial } from './shaderlib.js';

// Trees are built from a procedural branch skeleton (tapered, curved tubes)
// carrying alpha-tested cards painted with leaf clusters or needle sprays.
// One atlas per family (plus a normal atlas) so each species is a single
// geometry and material. Atlas layout (v = 1 is the top of the canvas):
//   v in [BARK_V0, 1]   seamless bark tile, u along a branch, v around it
//   v in [0, BARK_V0)   card cells (leaf clusters / needle sprays)
const ATLAS = 1024;
const BARK_ROWS = 256;
const BARK_GUARD = 12; // rows of wrapped bark above and below the sampled tile
const CELL_GAP = 48; // transparent rows between the bark strip and the cards
const BARK_V0 = 1 - BARK_ROWS / ATLAS;
const BARK_TILE_V0 = BARK_V0 + BARK_GUARD / ATLAS;
const BARK_TILE_H = (BARK_ROWS - 2 * BARK_GUARD) / ATLAS;
const BARK_TILE_LEN = 2.4; // metres of branch covered by one tile along its length
const BARK_TILE_CIRC = 0.6; // metres around the branch covered by one tile

const LOD_DIST = [0, 120, 320]; // metres from the chunk centre
const TREE_CHUNK = 120;
const ROCK_CHUNK = 220;

// ------------------------------------------------------------------ textures

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Value noise that tiles with an integer period per axis (in lattice cells).
function periodicNoise(seed) {
  const hash = (i, j) => {
    let h = (i * 374761393 + j * 668265263 + seed * 1013904223) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x, y, px, py) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const i0 = ((ix % px) + px) % px, i1 = (i0 + 1) % px;
    const j0 = ((iy % py) + py) % py, j1 = (j0 + 1) % py;
    const a = hash(i0, j0), b = hash(i1, j0), c = hash(i0, j1), d = hash(i1, j1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const fbm = (x, y, px, py, oct) => {
    let s = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < oct; o++) {
      s += amp * noise(x, y, px, py);
      norm += amp;
      x *= 2;
      y *= 2;
      px *= 2;
      py *= 2;
      amp *= 0.5;
    }
    return s / norm;
  };
  return { noise, fbm };
}

// Paint a seamless bark tile into the top strip of the colour and normal
// atlases. `furrow` bark has long crevices running along the branch,
// `plate` bark is broken into flaky plates (conifers).
function paintBark(col, nrm, seed, style) {
  const W = ATLAS, TH = BARK_ROWS - 2 * BARK_GUARD;
  const pn = periodicNoise(seed);
  const clamp = THREE.MathUtils.clamp, ss = THREE.MathUtils.smoothstep;
  const height =
    style === 'furrow'
      ? (u, v) => {
          const warp = pn.fbm(u * 2, v * 2, 2, 2, 3) - 0.5;
          const q = v * 12 + warp * 2.2;
          const n = clamp((pn.fbm(u * 3, q, 3, 12, 3) - 0.5) * 3.6, -1, 1);
          const crack = Math.pow(1 - Math.abs(n), 3.0);
          const plates = pn.fbm(u * 6, v * 8, 6, 8, 2);
          const detail = pn.fbm(u * 28, v * 14, 28, 14, 3);
          return clamp(1 - crack * 0.9 - (1 - plates) * 0.25 + (detail - 0.5) * 0.3, 0, 1);
        }
      : (u, v) => {
          const warp = pn.fbm(u * 3, v * 3, 3, 3, 2) - 0.5;
          const f = pn.fbm(u * 9 + warp * 1.5, v * 7 + warp, 9, 7, 3);
          const plate = ss(f, 0.4, 0.5);
          const flakes = ss(pn.fbm(u * 20, v * 16, 20, 16, 2), 0.45, 0.6);
          const detail = pn.fbm(u * 36, v * 28, 36, 28, 2);
          return clamp(plate * 0.6 + flakes * 0.2 + (detail - 0.5) * 0.3 + 0.1, 0, 1);
        };
  const H = new Float32Array(W * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < W; x++) H[y * W + x] = height(x / W, y / TH);

  const ridge = style === 'furrow' ? [0.44, 0.36, 0.28] : [0.42, 0.27, 0.18];
  const crevice = style === 'furrow' ? [0.11, 0.075, 0.05] : [0.1, 0.055, 0.035];
  const lichen = style === 'furrow' ? [0.5, 0.55, 0.36] : [0.48, 0.5, 0.34];
  const bump = style === 'furrow' ? 2.6 : 2.0;
  for (let y = 0; y < BARK_ROWS; y++) {
    const ty = (((y - BARK_GUARD) % TH) + TH) % TH;
    for (let x = 0; x < W; x++) {
      const h = H[ty * W + x];
      const hx = (H[ty * W + ((x + 1) % W)] - H[ty * W + ((x + W - 1) % W)]) * 0.5;
      const hy = (H[((ty + 1) % TH) * W + x] - H[((ty + TH - 1) % TH) * W + x]) * 0.5;
      const u = x / W, v = ty / TH;
      const tone = 0.82 + 0.36 * pn.fbm(u * 2, v * 3, 2, 3, 2);
      const lich = ss(pn.fbm(u * 5, v * 4, 5, 4, 3), 0.56, 0.68) * ss(h, 0.45, 0.8);
      const k = Math.pow(h, 1.3);
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        let val = (crevice[c] + (ridge[c] - crevice[c]) * k) * tone;
        val = val + (lichen[c] - val) * lich * 0.7;
        col[i + c] = clamp(val, 0, 1) * 255;
      }
      col[i + 3] = 255;
      // canvas y runs downward while v runs upward, so dh/dv = -hy
      let nx = -hx * bump * 24, ny = hy * bump * 24, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      nrm[i] = (nx * 0.5 + 0.5) * 255;
      nrm[i + 1] = (ny * 0.5 + 0.5) * 255;
      nrm[i + 2] = (nz * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }
}

// Card cells for broadleaf clusters: a 2 x 2 grid below the bark strip.
const LEAF_CELL_W = 512, LEAF_CELL_H = (ATLAS - BARK_ROWS - CELL_GAP) / 2;
const LEAF_CELL_Y0 = BARK_ROWS + CELL_GAP;
const LEAF_CELL_ASPECT = (LEAF_CELL_W - 16) / (LEAF_CELL_H - 16);
function leafCellUV(cell) {
  const cx = (cell % 2) * LEAF_CELL_W, cy = LEAF_CELL_Y0 + Math.floor(cell / 2) * LEAF_CELL_H;
  const inset = 8;
  return {
    u0: (cx + inset) / ATLAS,
    u1: (cx + LEAF_CELL_W - inset) / ATLAS,
    v0: 1 - (cy + LEAF_CELL_H - inset) / ATLAS,
    v1: 1 - (cy + inset) / ATLAS,
  };
}

function leafPath(g, L, W, lobed) {
  g.beginPath();
  g.moveTo(0, 0);
  if (lobed) {
    g.bezierCurveTo(L * 0.2, -W * 0.5, L * 0.25, -W * 1.15, L * 0.45, -W * 0.7);
    g.bezierCurveTo(L * 0.6, -W * 0.95, L * 0.85, -W * 0.4, L, 0);
    g.bezierCurveTo(L * 0.85, W * 0.4, L * 0.6, W * 0.95, L * 0.45, W * 0.7);
    g.bezierCurveTo(L * 0.25, W * 1.15, L * 0.2, W * 0.5, 0, 0);
  } else {
    g.bezierCurveTo(L * 0.25, -W, L * 0.72, -W * 0.85, L, 0);
    g.bezierCurveTo(L * 0.72, W * 0.85, L * 0.25, W, 0, 0);
  }
  g.closePath();
}

function paintLeafCells(g, rand) {
  const quad = (p0, p1, p2, t) => {
    const s = 1 - t;
    return [s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0], s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1]];
  };
  for (let cell = 0; cell < 4; cell++) {
    const cx0 = (cell % 2) * LEAF_CELL_W, cy0 = LEAF_CELL_Y0 + Math.floor(cell / 2) * LEAF_CELL_H;
    const lobed = cell >= 2;
    const aspect = lobed ? 0.5 : 0.4;
    g.save();
    g.beginPath();
    g.rect(cx0 + 6, cy0 + 6, LEAF_CELL_W - 12, LEAF_CELL_H - 12);
    g.clip();
    const bx = cx0 + LEAF_CELL_W / 2, by = cy0 + LEAF_CELL_H - 12;
    // twigs fanning out from the bottom centre
    const twigs = [];
    const nT = 5 + Math.floor(rand() * 3);
    for (let i = 0; i < nT; i++) {
      const a = -Math.PI / 2 + (i / (nT - 1) - 0.5) * 2.1 + (rand() - 0.5) * 0.3;
      const len = 190 + rand() * 130;
      const ex = bx + Math.cos(a) * len, ey = Math.max(cy0 + 30, by + Math.sin(a) * len);
      const cp = [(bx + ex) / 2 + (rand() - 0.5) * 70, (by + ey) / 2 - 25 + (rand() - 0.5) * 30];
      twigs.push({ p0: [bx, by], p1: cp, p2: [ex, ey] });
    }
    g.lineCap = 'round';
    for (const t of twigs) {
      for (let k = 0; k < 10; k++) {
        const a = quad(t.p0, t.p1, t.p2, k / 10), b = quad(t.p0, t.p1, t.p2, (k + 1) / 10);
        g.strokeStyle = k < 3 ? '#3d2f22' : '#55432f';
        g.lineWidth = 6 - k * 0.45;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
      }
    }
    // leaves along the twigs, inner ones first so the outer ones overlap them
    const leaves = [];
    for (const t of twigs) {
      const n = 22 + Math.floor(rand() * 7);
      for (let k = 0; k < n; k++) {
        const s = 0.1 + (k / n) * 0.9 + rand() * 0.03;
        const p = quad(t.p0, t.p1, t.p2, s), q = quad(t.p0, t.p1, t.p2, Math.min(1, s + 0.03));
        const ta = Math.atan2(q[1] - p[1], q[0] - p[0]);
        const side = k % 2 ? 1 : -1;
        const L = 26 + rand() * 20 + s * 6;
        leaves.push({
          x: p[0] + Math.cos(ta + Math.PI / 2) * side * 2 + (rand() - 0.5) * 10,
          y: p[1] + Math.sin(ta + Math.PI / 2) * side * 2 + (rand() - 0.5) * 10,
          a: ta + side * (0.3 + rand() * 0.7),
          L,
          W: L * aspect * (0.9 + rand() * 0.25),
          depth: s * 0.7 + rand() * 0.3,
        });
      }
    }
    leaves.sort((a, b) => a.depth - b.depth);
    for (const lf of leaves) {
      const hue = 84 + rand() * 28;
      const sat = 36 + rand() * 20;
      const light = 26 + lf.depth * 24 + rand() * 8;
      g.save();
      g.translate(lf.x, lf.y);
      g.rotate(lf.a);
      // contact shadow under the leaf
      g.save();
      g.translate(1.5, 3);
      g.scale(1.14, 1.18);
      leafPath(g, lf.L, lf.W, lobed);
      g.fillStyle = 'rgba(6, 12, 3, 0.32)';
      g.fill();
      g.restore();
      const grad = g.createLinearGradient(0, 0, lf.L, 0);
      grad.addColorStop(0, `hsl(${hue - 6}, ${sat}%, ${light - 8}%)`);
      grad.addColorStop(1, `hsl(${hue + 6}, ${sat + 6}%, ${light + 10}%)`);
      leafPath(g, lf.L, lf.W, lobed);
      g.fillStyle = grad;
      g.fill();
      g.strokeStyle = `hsla(${hue}, 40%, ${light - 14}%, 0.22)`;
      g.lineWidth = 1;
      g.stroke();
      // midrib and side veins
      g.strokeStyle = `hsla(${hue + 10}, 35%, ${light + 22}%, 0.4)`;
      g.lineWidth = 0.9;
      g.beginPath();
      g.moveTo(2, 0);
      g.lineTo(lf.L * 0.93, 0);
      for (let v = 1; v <= 3; v++) {
        const vx = lf.L * (0.2 + v * 0.18);
        g.moveTo(vx, 0);
        g.lineTo(vx + lf.L * 0.14, -lf.W * 0.5);
        g.moveTo(vx, 0);
        g.lineTo(vx + lf.L * 0.14, lf.W * 0.5);
      }
      g.stroke();
      g.restore();
    }
    g.restore();
  }
}

// Needle spray rows: u runs from the branch base (0) to its tip (1).
const NEEDLE_ROWS = 3;
const NEEDLE_ROW_H = Math.floor((ATLAS - BARK_ROWS - CELL_GAP) / NEEDLE_ROWS);
const NEEDLE_Y0 = BARK_ROWS + CELL_GAP;
function needleRowUV(row) {
  const y0 = NEEDLE_Y0 + row * NEEDLE_ROW_H;
  return { u0: 8 / ATLAS, u1: 1 - 8 / ATLAS, v0: 1 - (y0 + NEEDLE_ROW_H - 4) / ATLAS, v1: 1 - (y0 + 4) / ATLAS };
}

function paintNeedleRows(g, rand) {
  g.lineCap = 'round';
  for (let row = 0; row < NEEDLE_ROWS; row++) {
    const y0 = NEEDLE_Y0 + row * NEEDLE_ROW_H, mid = y0 + NEEDLE_ROW_H / 2;
    const hueBase = [138, 122, 108][row], satBase = [26, 32, 36][row];
    g.save();
    g.beginPath();
    g.rect(4, y0 + 3, ATLAS - 8, NEEDLE_ROW_H - 6);
    g.clip();
    const main = (t) => [14 + t * 990, mid - 4 + t * t * 12];
    const twigs = [{ pts: (t) => main(t), w0: 6, w1: 2, len: 990, scale: 1 }];
    for (let t = 0.06; t < 0.95; t += 0.034 + rand() * 0.012) {
      const side = twigs.length % 2 ? 1 : -1;
      const [sx, sy] = main(t);
      const ang = side * (0.35 + rand() * 0.3);
      const len = (100 - 55 * t) * (0.6 + rand() * 0.7);
      const ex = sx + Math.cos(ang) * len, ey = sy + Math.sin(ang) * len;
      twigs.push({ pts: (s) => [sx + (ex - sx) * s, sy + (ey - sy) * s + Math.sin(s * Math.PI) * side * 5], w0: 2.6, w1: 1, len, scale: 0.7, tip: t });
    }
    for (const tw of twigs) {
      for (let k = 0; k < 8; k++) {
        const a = tw.pts(k / 8), b = tw.pts((k + 1) / 8);
        g.strokeStyle = '#4a3828';
        g.lineWidth = tw.w0 + (tw.w1 - tw.w0) * (k / 8);
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
      }
    }
    // two passes: a dark, thick underlayer for depth, then the lit needles
    for (const pass of [0, 1]) {
      for (const tw of twigs) {
        const isMain = tw.scale === 1;
        const step = isMain ? 6 : 5;
        for (let d = 8; d < tw.len - 4; d += step) {
          const s = d / tw.len;
          const p = tw.pts(s), q = tw.pts(Math.min(1, s + 0.02));
          const ta = Math.atan2(q[1] - p[1], q[0] - p[0]);
          const tipness = isMain ? s * 0.6 : (tw.tip || 0) * 0.3 + s * 0.6;
          for (const side of [-1, 1]) {
            const ang = ta + side * (isMain ? 0.8 + rand() * 0.35 : 0.5 + rand() * 0.4);
            const nl = (isMain ? 22 + rand() * 10 : 16 + rand() * 10) * (1 - s * 0.25);
            const light = pass ? 20 + tipness * 22 + rand() * 8 : 12 + tipness * 6;
            const hue = hueBase - tipness * 14 + rand() * 8;
            g.strokeStyle = pass ? `hsl(${hue}, ${satBase + rand() * 12}%, ${light}%)` : `hsla(${hue + 5}, ${satBase}%, ${light}%, 0.7)`;
            g.lineWidth = pass ? 1.4 : 2.3;
            g.beginPath();
            g.moveTo(p[0], p[1]);
            g.lineTo(p[0] + Math.cos(ang) * nl, p[1] + Math.sin(ang) * nl);
            g.stroke();
          }
        }
      }
    }
    g.restore();
  }
}

// Build the colour and normal atlases for one tree family. Transparent
// texels get the average foliage colour so mipmaps don't darken the edges.
function buildAtlas(seed, kind) {
  const c = makeCanvas(ATLAS, ATLAS);
  const g = c.getContext('2d');
  const rand = mulberry32(seed);
  if (kind === 'leaf') paintLeafCells(g, rand);
  else paintNeedleRows(g, rand);
  const img = g.getImageData(0, 0, ATLAS, ATLAS);
  const col = img.data;
  const nrm = new Uint8Array(ATLAS * ATLAS * 4);
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < col.length; i += 4) {
    if (col[i + 3] > 200) {
      r += col[i];
      gg += col[i + 1];
      b += col[i + 2];
      n++;
    }
  }
  const fill = n ? [r / n, gg / n, b / n] : [40, 60, 20];
  for (let i = 0; i < col.length; i += 4) {
    if (col[i + 3] < 8) {
      col[i] = fill[0];
      col[i + 1] = fill[1];
      col[i + 2] = fill[2];
      col[i + 3] = 0;
    }
    nrm[i] = 128;
    nrm[i + 1] = 128;
    nrm[i + 2] = 255;
    nrm[i + 3] = 255;
  }
  paintBark(col, nrm, seed * 7 + 3, kind === 'leaf' ? 'furrow' : 'plate');
  const make = (data, srgb) => {
    const t = new THREE.DataTexture(data, ATLAS, ATLAS, THREE.RGBAFormat);
    t.flipY = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  return { map: make(new Uint8Array(col.buffer), true), normalMap: make(nrm, false) };
}

// ------------------------------------------------------------------ geometry

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

function perpendicular(v) {
  const a = Math.abs(v.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  return a.cross(v).normalize();
}

// Grow a polyline from `start` along `dir`: each step jitters the heading
// and bends it toward the sky (phototropism) or the ground (gravity).
function growCurve(rand, start, dir, len, segs, { wobble = 0.1, up = 0 } = {}) {
  const pts = [start.clone()];
  const d = dir.clone().normalize();
  const p = start.clone();
  for (let i = 0; i < segs; i++) {
    d.x += (rand() - 0.5) * wobble;
    d.y += (rand() - 0.5) * wobble + up / segs;
    d.z += (rand() - 0.5) * wobble;
    d.normalize();
    p.addScaledVector(d, len / segs);
    pts.push(p.clone());
  }
  return pts;
}

function pointAt(pts, t, out = new THREE.Vector3()) {
  const f = THREE.MathUtils.clamp(t, 0, 1) * (pts.length - 1);
  const i = Math.min(Math.floor(f), pts.length - 2);
  return out.lerpVectors(pts[i], pts[i + 1], f - i);
}

function tangentAt(pts, t, out = new THREE.Vector3()) {
  const f = THREE.MathUtils.clamp(t, 0, 1) * (pts.length - 1);
  const i = Math.min(Math.floor(f), pts.length - 2);
  return out.subVectors(pts[i + 1], pts[i]).normalize();
}

function resample(pts, segs) {
  const out = [];
  for (let i = 0; i <= segs; i++) out.push(pointAt(pts, i / segs));
  return out;
}

function taper(n, r0, r1, pow = 1) {
  const r = [];
  for (let i = 0; i < n; i++) r.push(r0 + (r1 - r0) * Math.pow(i / (n - 1), pow));
  return r;
}

class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
  }
  vert(p, n, u, v, c) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
    return this.pos.length / 3 - 1;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  // quad from four corners; normals and colours supplied per corner
  quad(ps, ns, uvs, cs) {
    const i = ps.map((p, k) => this.vert(p, ns[k], uvs[k][0], uvs[k][1], cs[k]));
    this.tri(i[0], i[1], i[2]);
    this.tri(i[0], i[2], i[3]);
  }
  // Tapered tube along a polyline with a twist-free (parallel transport)
  // frame. Bark uvs count tiles: u along the length, v around, so the
  // shader can repeat the strip and keep texel density constant.
  tube(pts, radii, rings, colorFn) {
    const n = pts.length;
    const T = [], N = [], B = [];
    for (let i = 0; i < n; i++) {
      T.push(new THREE.Vector3().subVectors(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]).normalize());
    }
    N.push(perpendicular(T[0]));
    for (let i = 1; i < n; i++) {
      _q.setFromUnitVectors(T[i - 1], T[i]);
      N.push(N[i - 1].clone().applyQuaternion(_q));
    }
    for (let i = 0; i < n; i++) B.push(new THREE.Vector3().crossVectors(T[i], N[i]));
    const avgR = radii.reduce((a, b) => a + b, 0) / n;
    const rep = Math.max(1, Math.round((2 * Math.PI * avgR) / BARK_TILE_CIRC));
    const uOff = Math.floor(pts[0].x * 3.7 + pts[0].y * 5.1) % 7; // unsynchronised bark between branches
    let arc = 0;
    const rows = [];
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      if (i > 0) arc += pts[i].distanceTo(pts[i - 1]);
      const u = uOff + arc / BARK_TILE_LEN;
      const row = [];
      for (let j = 0; j <= rings; j++) {
        const th = (j / rings) * Math.PI * 2;
        const dir = N[i].clone().multiplyScalar(Math.cos(th)).addScaledVector(B[i], Math.sin(th));
        const p = pts[i].clone().addScaledVector(dir, radii[i]);
        colorFn(i / (n - 1), th, p, c);
        row.push(this.vert(p, dir, u, BARK_TILE_V0 + (j / rings) * rep * BARK_TILE_H, c));
      }
      rows.push(row);
    }
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < rings; j++) {
        const a = rows[i][j], b = rows[i][j + 1], cc = rows[i + 1][j + 1], d = rows[i + 1][j];
        this.tri(a, d, cc);
        this.tri(a, cc, b);
      }
    }
  }
  // Ribbon along a polyline: `side` vectors and half widths per point, uv
  // rect mapped along the length (u) and across (v).
  strip(pts, sides, widths, uv, normalFn, colorFn) {
    const n = pts.length;
    const c = new THREE.Color();
    const rows = [];
    for (let i = 0; i < n; i++) {
      const u = uv.u0 + (uv.u1 - uv.u0) * (i / (n - 1));
      const l = pts[i].clone().addScaledVector(sides[i], -widths[i]);
      const r = pts[i].clone().addScaledVector(sides[i], widths[i]);
      const nl = normalFn(l), nr = normalFn(r);
      rows.push([this.vert(l, nl, u, uv.v0, colorFn(i / (n - 1), l, c)), this.vert(r, nr, u, uv.v1, colorFn(i / (n - 1), r, c))]);
    }
    for (let i = 0; i < n - 1; i++) {
      const [a, b] = rows[i], [cc, d] = rows[i + 1];
      this.tri(a, b, d);
      this.tri(a, d, cc);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// Bark vertex colour: tonal variation along the trunk, moss and dirt near
// the ground. The albedo itself comes from the bark tile.
function barkColor(t, th, p, c, seed) {
  const tone = 0.78 + 0.3 * (0.5 + 0.5 * noise3(p.x * 1.3 + seed, p.y * 0.9, p.z * 1.3));
  c.setRGB(tone, tone * 0.97, tone * 0.92);
  const moss = THREE.MathUtils.clamp(1 - p.y / 1.6, 0, 1) * (0.35 + 0.65 * Math.max(0, noise3(p.x * 3 + seed, p.y * 3, p.z * 3 + 7)));
  c.lerp(_mossColor, moss * 0.75);
  return c;
}
const _mossColor = new THREE.Color(0.42, 0.55, 0.3);

// A leaf card standing on `base`, its twig running along `up`, facing `facing`.
function leafCard(b, base, up, facing, w, h, uv, normalFn, colorFn) {
  const right = new THREE.Vector3().crossVectors(up, facing).normalize();
  const ps = [
    base.clone().addScaledVector(right, -w / 2),
    base.clone().addScaledVector(right, w / 2),
    base.clone().addScaledVector(right, w / 2).addScaledVector(up, h),
    base.clone().addScaledVector(right, -w / 2).addScaledVector(up, h),
  ];
  const uvs = [
    [uv.u0, uv.v0],
    [uv.u1, uv.v0],
    [uv.u1, uv.v1],
    [uv.u0, uv.v1],
  ];
  b.quad(ps, ps.map(normalFn), uvs, ps.map(colorFn));
}

// ---- broadleaf

function broadleafSkeleton(seed) {
  const rand = mulberry32(seed);
  const trunkH = 2.5 + rand() * 1.3;
  const canopyR = 3.0 + rand() * 0.9;
  const tubes = [];
  const twigs = [];
  const lean = new THREE.Vector3((rand() - 0.5) * 0.3, 1, (rand() - 0.5) * 0.3).normalize();
  const trunk = growCurve(rand, new THREE.Vector3(0, -0.4, 0), lean, trunkH + 0.4, 6, { wobble: 0.1, up: 0.2 });
  tubes.push({ pts: trunk, r0: 0.36, r1: 0.16, level: 0 });

  const nL = 4 + Math.floor(rand() * 2);
  const rot0 = rand() * Math.PI * 2;
  for (let k = 0; k < nL; k++) {
    const leader = k === nL - 1;
    const s = leader ? 1 : 0.55 + 0.4 * (k / (nL - 1)) + rand() * 0.08;
    const base = pointAt(trunk, THREE.MathUtils.clamp(s, 0, 1));
    const az = rot0 + (k / nL) * Math.PI * 2 + (rand() - 0.5) * 0.9;
    const elev = leader ? 1.15 + rand() * 0.2 : 0.5 + rand() * 0.45;
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const len = canopyR * (0.85 + rand() * 0.4) * (leader ? 0.75 : 1);
    const pts = growCurve(rand, base, dir, len, 5, { wobble: 0.16, up: 0.3 });
    tubes.push({ pts, r0: 0.14 * (0.9 + rand() * 0.3), r1: 0.045, level: 1 });
    const nS = 3 + Math.floor(rand() * 2);
    for (let j = 0; j < nS; j++) {
      const t = 0.3 + (0.65 * (j + 0.3 + rand() * 0.5)) / nS;
      const p = pointAt(pts, t);
      const pd = tangentAt(pts, t);
      const axis = perpendicular(pd).applyAxisAngle(pd, rand() * Math.PI * 2);
      const sdir = pd.clone().applyAxisAngle(axis, 0.65 + rand() * 0.5);
      sdir.y += 0.3;
      sdir.normalize();
      const slen = len * (0.42 + rand() * 0.3);
      const spts = growCurve(rand, p, sdir, slen, 3, { wobble: 0.2, up: 0.25 });
      tubes.push({ pts: spts, r0: 0.055, r1: 0.016, level: 2 });
      for (let m = 0; m < 4; m++) {
        const tt = 0.25 + m * 0.24 + rand() * 0.12;
        const tp = pointAt(spts, tt);
        const td = tangentAt(spts, tt);
        const ax = perpendicular(td).applyAxisAngle(td, rand() * Math.PI * 2);
        const tdir = td.applyAxisAngle(ax, m === 3 ? 0.2 : 0.5 + rand() * 0.6);
        tdir.y += 0.15;
        twigs.push({ p: tp, dir: tdir.normalize(), len: 0.95 + rand() * 0.4 });
      }
    }
    const tip = pts[pts.length - 1];
    const tdir = tangentAt(pts, 1);
    twigs.push({ p: tip, dir: tdir, len: 1.1 + rand() * 0.3 });
    const mid = pointAt(pts, 0.6);
    const mdir = tangentAt(pts, 0.6).applyAxisAngle(perpendicular(tdir), (rand() - 0.5) * 1.4);
    twigs.push({ p: mid, dir: mdir.normalize(), len: 0.9 + rand() * 0.3 });
  }
  const centre = new THREE.Vector3();
  for (const t of twigs) centre.add(t.p);
  centre.divideScalar(twigs.length);
  return { rand: mulberry32(seed + 101), trunkH, canopyR, tubes, twigs, centre };
}

function broadleafGeometry(sk, tint, lod) {
  const { rand, canopyR, centre: C, tubes, twigs } = sk;
  const b = new Builder();
  const rings = [[8, 6, 4], [6, 4, 3], [5, 3, 3]][lod];
  const segs = [[6, 5, 3], [4, 3, 2], [3, 2, 1]][lod];
  for (const t of tubes) {
    if (lod === 2 && t.level === 2) continue;
    if (lod === 1 && t.level === 2) continue;
    const pts = t.pts.length - 1 === segs[t.level] ? t.pts : resample(t.pts, segs[t.level]);
    b.tube(pts, taper(pts.length, t.r0, t.r1), rings[t.level], (tt, th, p, c) => barkColor(tt, th, p, c, sk.trunkH));
  }

  const tintC = new THREE.Color(tint[0], tint[1], tint[2]);
  const normalFn = (p) => {
    const out = p.clone().sub(C);
    out.y *= 1.35;
    return out.normalize();
  };
  let cardRand = 1;
  const colorFn = (p) => {
    const outward = THREE.MathUtils.clamp(p.distanceTo(C) / (canopyR * 0.95), 0, 1);
    const up = THREE.MathUtils.clamp(((p.y - C.y) / canopyR) * 0.5 + 0.5, 0, 1);
    const shade = (0.3 + 0.45 * outward * outward + 0.3 * up) * cardRand;
    return tintC.clone().multiplyScalar(shade);
  };
  const scale = [1.5, 1.9, 2.6][lod];
  const card = (base, up, facing, size) => {
    cardRand = 0.85 + rand() * 0.3;
    const h = size * scale, w = h * LEAF_CELL_ASPECT;
    leafCard(b, base, up, facing, w, h, leafCellUV(Math.floor(rand() * 4)), normalFn, colorFn);
  };
  // cards on the twigs: one along the twig, one crossed, one lying on the canopy surface
  twigs.forEach((tw, i) => {
    if (lod === 2 && i % 2) return;
    const roll = rand() * Math.PI * 2;
    const facing = perpendicular(tw.dir).applyAxisAngle(tw.dir, roll);
    if (lod < 2) card(tw.p, tw.dir, facing, tw.len);
    if (lod === 0) card(tw.p, tw.dir, facing.clone().applyAxisAngle(tw.dir, Math.PI / 2), tw.len * 0.85);
    const mid = tw.p.clone().addScaledVector(tw.dir, tw.len * 0.55);
    const out = normalFn(mid);
    let up = tw.dir.clone().sub(out.clone().multiplyScalar(tw.dir.dot(out)));
    if (up.lengthSq() < 0.05) up = perpendicular(out);
    up.normalize();
    const tilt = out.clone().applyAxisAngle(up, (rand() - 0.5) * 0.9);
    card(mid.clone().addScaledVector(up, -tw.len * 0.5), up, tilt, tw.len * (lod === 2 ? 1.1 : 0.9 + rand() * 0.2));
  });
  // fill cards clumped around the twigs so the canopy is opaque but lumpy
  const nFill = [40, 24, 18][lod];
  for (let i = 0; i < nFill; i++) {
    const tw = twigs[Math.floor(rand() * twigs.length)];
    const p = tw.p.clone().addScaledVector(tw.dir, tw.len * (0.2 + rand() * 0.6));
    p.add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.9));
    const out = normalFn(p);
    const up = perpendicular(out).applyAxisAngle(out, rand() * Math.PI * 2);
    up.y += 0.4;
    up.sub(out.clone().multiplyScalar(up.dot(out))).normalize();
    const size = 0.9 + rand() * 0.4;
    card(p.clone().addScaledVector(up, -size * scale * 0.5), up, out, size);
  }
  return b.build();
}

// ---- pine

function pineSkeleton(seed) {
  const rand = mulberry32(seed);
  const H = 10 + rand() * 3;
  const y0 = 0.9 + rand() * 1.3;
  const maxL = 2.6 + rand() * 0.7;
  const trunk = [];
  let ox = 0, oz = 0;
  for (let i = 0; i <= 12; i++) {
    const y = -0.4 + (i / 12) * (H + 0.4);
    if (i > 1) {
      ox += (rand() - 0.5) * 0.08;
      oz += (rand() - 0.5) * 0.08;
    }
    trunk.push(new THREE.Vector3(ox, y, oz));
  }
  const branches = [];
  const branch = (y, t, az, L, inner) => {
    const e0 = 0.08 + 0.42 * t + (rand() - 0.5) * 0.18;
    const droop = (0.5 + 0.4 * (1 - t)) * (0.8 + rand() * 0.4);
    const root = pointAt(trunk, (y + 0.4) / (H + 0.4));
    const pts = [root.clone()];
    const p = root.clone();
    for (let i = 1; i <= 4; i++) {
      const s = (i - 0.5) / 4;
      const e = e0 - droop * s * s;
      p.add(new THREE.Vector3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e)).multiplyScalar(L / 4));
      pts.push(p.clone());
    }
    branches.push({ pts, t, L, inner, roll: (rand() - 0.5) * 0.7, shade: 0.88 + rand() * 0.24, row: Math.floor(rand() * NEEDLE_ROWS) });
  };
  let rot = rand() * Math.PI * 2;
  for (let y = y0; y < H - 0.7; y += 0.42 + rand() * 0.25) {
    const t = (y - y0) / (H - y0);
    const L = maxL * Math.pow(1 - t, 0.85) + 0.35;
    const n = Math.max(3, Math.round(8 - 3 * t + (rand() - 0.5)));
    rot += 0.9 + rand() * 0.4;
    for (let k = 0; k < n; k++) {
      branch(y + (rand() - 0.5) * 0.24, t, rot + (k / n) * Math.PI * 2 + (rand() - 0.5) * 0.5, L, false);
    }
    // short sprays between whorls fill the view toward the trunk
    if (t < 0.8) for (let k = 0; k < 2; k++) branch(y + 0.2 + rand() * 0.2, t, rand() * Math.PI * 2, L * 0.45, true);
  }
  return { rand: mulberry32(seed + 77), H, trunk, branches, maxL };
}

function pineGeometry(sk, tint, lod) {
  const { rand, H, trunk, branches } = sk;
  const b = new Builder();
  const trunkPts = resample(trunk, [12, 8, 5][lod]);
  b.tube(trunkPts, taper(trunkPts.length, 0.3, 0.02, 0.8), [8, 6, 5][lod], (t, th, p, c) => barkColor(t, th, p, c, H));

  const tintC = new THREE.Color(tint[0], tint[1], tint[2]);
  const up = new THREE.Vector3(0, 1, 0);
  const cardSegs = [3, 2, 1][lod];
  const widen = [1, 1.25, 1.9][lod];
  const c = new THREE.Color();
  branches.forEach((br, bi) => {
    const { pts, t, L } = br;
    if (br.inner && lod > 0) return;
    const normalFn = (p) => _v.set(p.x, 0.55 + 0.5 * t, p.z).normalize().clone();
    const colorFn = (s, p) => {
      const shade = (0.35 + 0.65 * s) * (0.82 + 0.18 * t) * br.shade * (br.inner ? 0.7 : 1);
      return c.copy(tintC).multiplyScalar(shade);
    };
    if (lod === 0 && t < 0.6 && !br.inner) {
      // bare inner part of the branch
      const inner = [pointAt(pts, 0), pointAt(pts, 0.3)];
      b.tube(inner, [0.05 * (1 - t) + 0.02, 0.015], 3, (tt, th, p, cc) => barkColor(tt, th, p, cc, H));
    }
    const s0 = 0.18;
    const spts = [], tangents = [];
    for (let i = 0; i <= cardSegs; i++) {
      const s = s0 + (1 - s0) * (i / cardSegs);
      spts.push(pointAt(pts, s));
      tangents.push(tangentAt(pts, Math.min(s, 0.98)));
    }
    const w = (0.17 + 0.1 * L) * widen;
    const widths = spts.map((p, i) => {
      const f = i / cardSegs;
      return w * (0.55 + 0.45 * Math.sin(Math.PI * (0.12 + 0.88 * f)));
    });
    const uv = needleRowUV(br.row);
    // main card, roughly horizontal, rolled a little around the branch
    const sidesH = tangents.map((tg) => new THREE.Vector3().crossVectors(tg, up).normalize().applyAxisAngle(tg, br.roll));
    b.strip(spts, sidesH, widths, uv, normalFn, colorFn);
    // a second card standing on edge gives the spray thickness from the side
    if ((lod === 0 && !br.inner) || (lod > 0 && bi % 2 === 0)) {
      const sidesV = tangents.map((tg, i) => sidesH[i].clone().applyAxisAngle(tg, Math.PI / 2 + (rand() - 0.5) * 0.4));
      b.strip(spts, sidesV, widths.map((x) => x * 0.8), uv, normalFn, colorFn);
    }
  });
  // leader: crossed vertical sprays at the top
  const top = trunk[trunk.length - 1];
  const leaderPts = [top.clone().addScaledVector(up, -0.9), top.clone().addScaledVector(up, 0.5)];
  const lw = [0.32, 0.32];
  const luv = needleRowUV(1);
  const lcol = (s, p) => c.copy(tintC).multiplyScalar(0.9 + 0.1 * s);
  const lnrm = (p) => _v.set(p.x, 0.8, p.z).normalize().clone();
  b.strip(leaderPts, [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)], lw, luv, lnrm, lcol);
  b.strip(leaderPts, [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)], lw, luv, lnrm, lcol);
  return b.build();
}

// ---- rocks

function rockGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const s = seed * 7.13;
  const sq = 0.5 + (seed % 3) * 0.12;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let d = 1 + 0.35 * noise3(v.x * 1.2 + s, v.y * 1.2, v.z * 1.2);
    d += 0.1 * noise3(v.x * 4 + s, v.y * 4, v.z * 4);
    d += 0.03 * noise3(v.x * 12 + s, v.y * 12, v.z * 12);
    d = Math.min(d, 1.05 - 0.2 * Math.abs(v.x * 0.7 + v.z * 0.3));
    v.multiplyScalar(d);
    v.y *= sq;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const col = new Float32Array(pos.count * 3);
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(g.attributes.normal, i);
    const grey = 0.2 + 0.1 * noise3(v.x * 3 + s, v.y * 3, v.z * 3);
    const moss = Math.max(0, THREE.MathUtils.smoothstep(n.y, 0.55, 0.85) * (0.6 + 0.4 * noise3(v.x * 2, v.y * 2 + s, v.z * 2)));
    col[i * 3] = THREE.MathUtils.lerp(grey, 0.05, moss);
    col[i * 3 + 1] = THREE.MathUtils.lerp(grey * 0.95, 0.08, moss);
    col[i * 3 + 2] = THREE.MathUtils.lerp(grey * 0.9, 0.02, moss);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// ------------------------------------------------------------------ materials

function foliageMaterial(key, atlas, sway) {
  const m = new THREE.MeshStandardMaterial({
    map: atlas.map,
    normalMap: atlas.normalMap,
    normalScale: new THREE.Vector2(1, 1),
    vertexColors: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.8,
    metalness: 0,
  });
  const V0 = BARK_V0.toFixed(5), TV0 = BARK_TILE_V0.toFixed(5), TH = BARK_TILE_H.toFixed(5);
  patchMaterial(m, key, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWindStrength;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          float ph = ip.x * 0.07 + ip.z * 0.05;
          float k = max(transformed.y - 1.5, 0.0);
          k = k * k * ${sway.toFixed(4)} * uWindStrength;
          transformed.x += (sin(uTime * 1.1 + ph) + 0.4 * sin(uTime * 2.7 + ph * 2.0)) * k;
          transformed.z += cos(uTime * 0.9 + ph * 1.3) * k * 0.6;
          // per-card flutter (bark samples the strip above BARK_V0)
          float leaf = step(uv.y, ${V0} - 0.001);
          float fl = sin(uTime * (4.0 + uWindStrength * 3.0) + dot(transformed, vec3(3.1, 1.7, 2.3)) + ph * 10.0);
          transformed += normal * fl * 0.035 * leaf * uWindStrength * min(transformed.y * 0.15, 1.0);
        #endif
        `
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        // The bark strip repeats along (u) and around (v) each branch. Sampling
        // with the un-wrapped derivatives keeps the mip selection seamless.
        vec2 fuv = vMapUv;
        vec2 fdx = dFdx(fuv), fdy = dFdy(fuv);
        float isBark = step(${V0}, fuv.y);
        vec2 buv = vec2(fract(fuv.x), ${TV0} + fract((fuv.y - ${TV0}) / ${TH}) * ${TH});
        fuv = mix(fuv, buv, isBark);
        vec4 sampledDiffuseColor = textureGrad(map, fuv, fdx, fdy);
        diffuseColor *= sampledDiffuseColor;
        // keep alpha-tested coverage stable across mip levels (no thinning with distance)
        // (estimated the way an 8x anisotropic filter picks its level, so edge-on cards are not over-boosted)
        vec2 mdx = fdx * ${ATLAS.toFixed(1)}, mdy = fdy * ${ATLAS.toFixed(1)};
        float lx = dot(mdx, mdx), ly = dot(mdy, mdy);
        float mipLevel = max(0.0, 0.5 * log2(max(min(lx, ly), max(lx, ly) / 64.0)));
        diffuseColor.a *= 1.0 + mipLevel * 0.3;
        diffuseColor.a = max(diffuseColor.a, isBark);
        `
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = textureGrad(normalMap, fuv, fdx, fdy).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        #endif
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        // leaves are waxier than bark; relative so rain wetness still applies
        roughnessFactor *= mix(1.0, 1.15, isBark);
        `
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #include <emissivemap_fragment>
        // light glowing through the leaves when looking toward the sun
        vec3 fvd = normalize(vFogWorldPos - cameraPosition);
        float ftr = pow(max(dot(fvd, uSunDirW), 0.0), 4.0) * (1.0 - isBark);
        totalEmissiveRadiance += diffuseColor.rgb * uSunColorN * ftr * 0.3 * worldShadowFactor(vFogWorldPos);
        `
      );
  });
  return m;
}

// ------------------------------------------------------------------ scatter

export function createVegetation(terrain, { treeScale = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'vegetation';
  const rand = mulberry32(99);
  const dummy = new THREE.Object3D();
  const normal = new THREE.Vector3();

  const leafMat = foliageMaterial('leaf', buildAtlas(11, 'leaf'), 0.006);
  const pineMat = foliageMaterial('pine', buildAtlas(12, 'needle'), 0.0035);
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  patchMaterial(rockMat, 'rock');

  const lods = (build, sk, tint) => [0, 1, 2].map((lod) => build(sk, tint, lod));
  const species = [
    { geos: lods(pineGeometry, pineSkeleton(1), [0.42, 0.58, 0.4]), mat: pineMat, kind: 'pine', count: 1300 },
    { geos: lods(pineGeometry, pineSkeleton(2), [0.34, 0.52, 0.42]), mat: pineMat, kind: 'pine', count: 1300 },
    { geos: lods(pineGeometry, pineSkeleton(3), [0.48, 0.6, 0.32]), mat: pineMat, kind: 'pine', count: 1000 },
    { geos: lods(broadleafGeometry, broadleafSkeleton(4), [0.34, 0.58, 0.2]), mat: leafMat, kind: 'leaf', count: 700 },
    { geos: lods(broadleafGeometry, broadleafSkeleton(5), [1.05, 0.5, 0.12]), mat: leafMat, kind: 'leaf', count: 450 },
    { geos: lods(broadleafGeometry, broadleafSkeleton(6), [0.82, 0.7, 0.18]), mat: leafMat, kind: 'leaf', count: 600 },
  ];
  group.userData.triangles = species.map((sp) => sp.geos.map((g) => g.index.count / 3));

  const colliders = [];

  // Instances are bucketed into spatial chunks so frustum culling can skip
  // whole patches of forest in the main, shadow and reflection passes. Each
  // tree chunk is a LOD with three geometry levels chosen by distance.
  const bucket = (items, size) => {
    const buckets = new Map();
    for (const it of items) {
      const key = `${Math.floor(it.x / size)},${Math.floor(it.z / size)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(it);
    }
    return buckets.values();
  };
  const instanced = (geo, mat, list, centre) => {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    list.forEach((it, i) => {
      m.copy(it.matrix);
      m.elements[12] -= centre.x;
      m.elements[13] -= centre.y;
      m.elements[14] -= centre.z;
      mesh.setMatrixAt(i, m);
      if (it.color) mesh.setColorAt(i, it.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  };
  const addTreeChunks = (geos, mat, items) => {
    for (const list of bucket(items, TREE_CHUNK)) {
      const centre = new THREE.Vector3();
      for (const it of list) centre.add(_v.setFromMatrixPosition(it.matrix));
      centre.divideScalar(list.length);
      const lod = new THREE.LOD();
      lod.position.copy(centre);
      geos.forEach((geo, level) => lod.addLevel(instanced(geo, mat, list, centre), LOD_DIST[level], 0.08));
      group.add(lod);
    }
  };
  const addRockChunks = (geo, mat, items) => {
    for (const list of bucket(items, ROCK_CHUNK)) group.add(instanced(geo, mat, list, new THREE.Vector3()));
  };

  for (const sp of species) {
    const count = Math.floor(sp.count * treeScale);
    const items = [];
    let attempts = 0;
    while (items.length < count && attempts < count * 60) {
      attempts++;
      const r = 32 + Math.sqrt(rand()) * 640;
      const a = rand() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = terrain.getHeight(x, z);
      terrain.getNormal(x, z, normal);
      if (normal.y < 0.82) continue;
      const forest = fbm(x * 0.005, z * 0.005, 3, sp.kind === 'pine' ? 300 : 400);
      if (sp.kind === 'pine') {
        if (h < 4 || h > 125 || forest < -0.02) continue;
      } else {
        if (h < 2.5 || h > 50 || forest < 0.02) continue;
      }
      // keep the vista from the monument toward the lake open
      const vx = x - 75, vz = z + 20;
      if (Math.hypot(vx, vz) < 60) continue;
      const s = (0.8 + rand() * 0.8) * (sp.kind === 'pine' ? 1.05 : 1.0);
      dummy.position.set(x, h - 0.3, z);
      dummy.rotation.set((rand() - 0.5) * 0.06, rand() * Math.PI * 2, (rand() - 0.5) * 0.06);
      dummy.scale.set(s, s * (0.9 + rand() * 0.3), s);
      dummy.updateMatrix();
      // per-instance brightness and a slight hue shift between yellow and blue greens
      const v = 0.8 + rand() * 0.4;
      const hue = (rand() - 0.5) * 0.2;
      items.push({ x, z, matrix: dummy.matrix.clone(), color: new THREE.Color(v * (1 + hue), v, v * (1 - hue)) });
      colliders.push({ x, z, r: 0.4 * s });
    }
    addTreeChunks(sp.geos, sp.mat, items);
  }

  // rocks and boulders
  const rockGeos = [rockGeometry(1), rockGeometry(2), rockGeometry(3)];
  for (let v = 0; v < rockGeos.length; v++) {
    const count = 320;
    const items = [];
    let attempts = 0;
    while (items.length < count && attempts < count * 40) {
      attempts++;
      const r = 22 + Math.sqrt(rand()) * 600;
      const a = rand() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = terrain.getHeight(x, z);
      if (h < -3) continue;
      terrain.getNormal(x, z, normal);
      const big = rand() < 0.08;
      const s = big ? 3 + rand() * 5 : 0.3 + Math.pow(rand(), 2) * 2.2;
      dummy.position.set(x, h - s * 0.25, z);
      dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      dummy.rotateY(rand() * Math.PI * 2);
      dummy.scale.set(s * (0.8 + rand() * 0.5), s, s * (0.8 + rand() * 0.5));
      dummy.updateMatrix();
      items.push({ x, z, matrix: dummy.matrix.clone() });
      if (s > 1) colliders.push({ x, z, r: s * 0.8, kind: 'rock' });
    }
    addRockChunks(rockGeos[v], rockMat, items);
  }

  return { group, colliders };
}
