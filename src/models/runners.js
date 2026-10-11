import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../shaderlib.js';
import { mulberry32 } from '../noise.js';

/**
 * Runners: an instanced crowd of articulated USN sailors (June 1944) for the General Quarters
 * sequence: men turning out of berthing and work spaces and running to their battle stations.
 *
 * Every body part type (pelvis, torso, kapok vest, head, hair, M1 / Mk 2 helmet, white hat, flash
 * hood, upper arm, forearm, hand, thigh, shin, boot, carried vest) is ONE InstancedMesh shared by all
 * runners, so the whole crowd costs one draw call per part type (up to 16 meshes, plus the
 * shadow pass), whatever the head count. Per-runner matrices come each frame from a procedural skeleton: the
 * feet follow planted tracks, legs and arms are solved with analytic two-bone IK.
 *
 * Space: everything is in the space of `runners.group`, normally the SHIP group (meters, bow -Z,
 * up +Y). A runner's local frame has its origin at the feet, faces -Z, +X is his right.
 *
 * API
 *   const runners = new Runners(count, { seed });
 *   shipGroup.add(runners.group);
 *   runners.set(i, { position, heading, state, phase, speed, ladderDir, lookAt, visible, ... });
 *   runners.update(dt);  // once per frame, after the set() calls
 *   runners.dispose();
 *
 * set(i, opts): every field is optional and sticky (omitted or undefined keeps the last value;
 * null clears speed, ladderBase, door, lookAt and carry).
 *   position   THREE.Vector3, the point between the feet on the deck / tread line (copied).
 *   heading    radians about +Y, 0 faces -Z (three's rotation.y convention).
 *   state      'run' | 'climb' | 'duck' | 'stand' | 'idle' | 'arrive' | 'hidden'.
 *              Switching state crossfades the pose (about 0.3 s, feet step rather than slide).
 *   phase      number: drive the cycle yourself (see below); applies to the next update() only,
 *              so pass it every frame. null / omitted: the class advances it from the speed.
 *   speed      m/s along the path. null: measured from the position change between updates
 *              (the default; sticky, so pass null to go back to measuring).
 *   ladderDir  THREE.Vector3, unit vector up the ladder (ship space), for 'climb'.
 *   ladderBase THREE.Vector3, optional: the foot of the ladder on the lower deck, on its nosing
 *              line (the line through the front edges of the treads). With it the climb phase
 *              comes from the position, so feet land exactly on the treads.
 *   rise       tread rise in meters (default 0.23). railHeight (0.86, above the nosing line,
 *              vertical) and ladderWidth (0.66, between the handrails) place the hands.
 *   door       THREE.Vector3, for 'duck': the centre of the watertight door's sill at deck level.
 *              sill (sill height, default 0.38) and doorTop (top of the opening above the deck,
 *              default 1.62) shape the step over and the duck.
 *   lookAt     THREE.Vector3 (ship space) to turn the head (and a little of the chest) toward,
 *              or null.
 *   carry      'helmet' | 'vest' | null: item in one hand (outfits start with some carrying).
 *              'helmet' works for M1 wearers and helmet carriers, 'vest' for vest carriers;
 *              otherwise it is ignored. null stows the item.
 *   visible    false hides the runner (same as state 'hidden').
 *
 * States and their phase:
 *   run     hurried passageway run (or walk at low speed: the gait blends walk to run between
 *           about 1.7 and 2.7 m/s, and settles into a stand below about 0.5 m/s). phase is the
 *           gait cycle, 0 = left heel strike. For planted feet it must advance by
 *           distance / runners.stride(i, speed) (that is what the class does by itself).
 *   arrive  slowing to a stop: like run but with braking lean, an overshoot when the body stops
 *           and heavy breathing; decelerate the position yourself (the gait follows the speed).
 *   climb   going up a steep inclined ladder (55 to 70 degrees): feet on the treads, body
 *           leaning into the ladder, hands sliding up the handrails (the carrying hand holds
 *           the item instead). `position` moves along the nosing line, `heading` faces up the
 *           ladder. phase is the tread cycle (0 = left foot lands on a tread, one cycle = two
 *           treads = climbStride(rise, ladderDir) along the ladder).
 *   duck    stepping through a watertight door: one long step over the high sill with the lead
 *           foot, the trail foot lifted over after it, head ducked under the top, the hand on the
 *           lead side grabbing the door frame. With `door` given the motion is driven by the
 *           position (start about 1 m before the sill, finish about 0.9 m past it, walking pace
 *           of about 1.2 to 1.8 m/s looks right). Without `door`, phase 0..1 maps to moving from
 *           1.0 m before the sill to 0.9 m past it (and with neither, progress starts 1.0 m before
 *           the sill on entering the state and follows the speed).
 *   stand   relaxed stand: weight on one leg, breathing (panting after a run), small sway.
 *   idle    stand plus looking around (often up at the sky), weight shifts, hands on hips for
 *           some; helmet carriers pull their helmet on shortly after stopping.
 *   hidden  not drawn.
 *
 * Other members:
 *   runners.group                THREE.Group to parent (ship space).
 *   runners.sailors[i]           { height, outfit: { shirt, hat, vest, flash, carry, ... } } (read only).
 *   runners.stride(i, speed)     meters per gait cycle for runner i at that speed.
 *   runners.don(i)               runner i pulls on the helmet he carries (helmet carriers also do
 *                                it by themselves after stopping; sailors[i].autoDon = false stops that).
 *   runners.headPosition(i, out) last solved head centre in group space.
 *   runners.count, runners.drawCalls, runners.trianglesPerRunner (approximate).
 * Exported helpers: gait(speed, height) -> { cycleHz, stride, step, duty, run } for an average
 * runner, climbStride(rise, ladderDir) -> meters along the ladder per climb cycle, RUNNER_STATES.
 */

const V3 = THREE.Vector3;
const PI = Math.PI;
const TAU = Math.PI * 2;
const DEG = PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const fract = (x) => x - Math.floor(x);
const wrapPi = (a) => a - TAU * Math.floor((a + PI) / TAU);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const bump = (x, a, b) => (x <= a || x >= b ? 0 : Math.sin((PI * (x - a)) / (b - a)));

export const RUNNER_STATES = ['run', 'climb', 'duck', 'stand', 'idle', 'arrive', 'hidden'];

const NOM_H = 1.75;
const DEFAULT_RISE = 0.23;

// Nominal skeleton of a 1.75 m sailor (meters). Pelvis origin = midpoint of the hip joints.
const SK = {
  hipY: 0.94, hipX: 0.088,
  thigh: 0.43, shin: 0.43, ankleY: 0.075,
  lumbar: 0.12, // pelvis origin to torso origin
  shX: 0.178, shY: 0.365, shZ: 0.015, // shoulder joints in torso space
  neckY: 0.425, neckZ: 0.012, // neck base (head part origin) in torso space
  upper: 0.295, fore: 0.255, grip: 0.07,
  heelZ: 0.065, toeZ: -0.185, // foot pivots in boot space (y = -ankleY): heel strike, toe-off
};

// ---------------------------------------------------------------- gait timing

// Steps per second against speed (m/s): passageway pace, shorter and quicker than an open sprint.
const STEP_TABLE = [[0, 1.7], [1, 1.9], [1.5, 2.05], [2.2, 2.45], [3, 2.8], [4, 3.0], [5, 3.15], [7, 3.4]];
function stepsPerSecond(v) {
  if (v <= 0) return STEP_TABLE[0][1];
  for (let i = 1; i < STEP_TABLE.length; i++) {
    const [v1, s1] = STEP_TABLE[i];
    if (v <= v1) {
      const [v0, s0] = STEP_TABLE[i - 1];
      return lerp(s0, s1, (v - v0) / (v1 - v0));
    }
  }
  return STEP_TABLE[STEP_TABLE.length - 1][1];
}

/**
 * Gait timing for an average runner of `height` at `speed` (m/s): cycle frequency (Hz, one cycle
 * = two steps), stride (meters per cycle), step (meters per step), duty factor (fraction of the
 * cycle a foot is down) and run (0 walk .. 1 run). Advance phase by distance / stride.
 */
export function gait(speed, height = NOM_H) {
  const v = Math.max(0, speed || 0);
  const cycleHz = stepsPerSecond(v) * 0.5 * Math.sqrt(NOM_H / height);
  const run = sstep(1.7, 2.7, v);
  const stride = v / cycleHz;
  return { cycleHz, stride, step: stride / 2, duty: lerp(0.6, 0.36, run), run };
}

/** Meters along the ladder per climb cycle (two treads) for a tread rise and ladder direction. */
export function climbStride(rise = DEFAULT_RISE, ladderDir = null) {
  const sinA = ladderDir ? clamp(ladderDir.y / Math.max(1e-6, ladderDir.length()), 0.3, 1) : Math.sin(60 * DEG);
  return (2 * rise) / sinA;
}

// ---------------------------------------------------------------- geometry helpers

function strip(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.clearGroups();
  return g;
}

// Vertex colors as a multiplier on the instance color (1 = the outfit color, < 1 darker details).
function paint(g, fn) {
  strip(g);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const m = typeof fn === 'number' ? fn : fn(p.getX(i), p.getY(i), p.getZ(i));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = m;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function merge(list) {
  const g = mergeGeometries(list, false);
  for (const x of list) x.dispose();
  g.computeBoundingSphere();
  return g;
}

// Surface of revolution about Y from a [y, r] profile listed bottom to top (outward normals).
function lathe(profile, seg = 10, sx = 1, sz = 1) {
  const g = new THREE.LatheGeometry(profile.map(([y, r]) => new THREE.Vector2(Math.max(r, 1e-4), y)), seg);
  if (sx !== 1 || sz !== 1) g.scale(sx, 1, sz);
  return g;
}

// Smooth solid through rings stacked along +Y. Ring: { y, rx, rz, cx, cz, ex (superellipse), dome }.
function ringLoft(rings, n = 14, capTop = true, capBottom = true) {
  const pos = [];
  const idx = [];
  for (const R of rings) {
    const e = 2 / (R.ex || 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU, c = Math.cos(a), s = Math.sin(a);
      pos.push((R.cx || 0) + Math.sign(c) * Math.abs(c) ** e * R.rx, R.y, (R.cz || 0) + Math.sign(s) * Math.abs(s) ** e * R.rz);
    }
  }
  const at = (k, i) => k * n + (i % n);
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      idx.push(at(k, i), at(k + 1, i), at(k, i + 1));
      idx.push(at(k, i + 1), at(k + 1, i), at(k + 1, i + 1));
    }
  }
  if (capBottom) {
    const R = rings[0], c = pos.length / 3;
    pos.push(R.cx || 0, R.y - (R.dome || 0), R.cz || 0);
    for (let i = 0; i < n; i++) idx.push(at(0, i), at(0, i + 1), c);
  }
  if (capTop) {
    const K = rings.length - 1, R = rings[K], c = pos.length / 3;
    pos.push(R.cx || 0, R.y + (R.dome || 0), R.cz || 0);
    for (let i = 0; i < n; i++) idx.push(at(K, i), c, at(K, i + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const ellipsoid = (rx, ry, rz, x, y, z, w = 10, h = 8) => new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz).translate(x, y, z);

// Reverse the winding (and normals) of an indexed geometry: an inside surface.
function flip(g) {
  const ix = g.index.array;
  for (let i = 0; i < ix.length; i += 3) {
    const t = ix[i + 1];
    ix[i + 1] = ix[i + 2];
    ix[i + 2] = t;
  }
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

// Drop the triangles whose centroid passes a test (e.g. the face opening of a flash hood).
function cut(g, test) {
  const ix = g.index.array, p = g.attributes.position;
  const keep = [];
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i], b = ix[i + 1], c = ix[i + 2];
    const x = (p.getX(a) + p.getX(b) + p.getX(c)) / 3, y = (p.getY(a) + p.getY(b) + p.getY(c)) / 3, z = (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3;
    if (!test(x, y, z)) keep.push(a, b, c);
  }
  g.setIndex(keep);
  return g;
}

// ---------------------------------------------------------------- part geometry (1.75 m sailor)

function geoPelvis() {
  // trouser seat and waist, belt on top. Origin at the midpoint of the hip joints.
  const g = ringLoft([
    { y: -0.14, rx: 0.06, rz: 0.06, cz: 0.0 },
    { y: -0.115, rx: 0.12, rz: 0.095, cz: 0.006 },
    { y: -0.07, rx: 0.158, rz: 0.116, cz: 0.014 },
    { y: 0.0, rx: 0.172, rz: 0.118, cz: 0.008 },
    { y: 0.06, rx: 0.165, rz: 0.112, cz: 0.0 },
    { y: 0.097, rx: 0.158, rz: 0.108 },
    { y: 0.103, rx: 0.163, rz: 0.113 },
    { y: 0.143, rx: 0.16, rz: 0.111 },
    { y: 0.149, rx: 0.152, rz: 0.103 },
  ], 16);
  return paint(g, (x, y, z) => (y > 0.1 ? (z < -0.1 && Math.abs(x) < 0.025 ? 0.75 : 0.36) : 1));
}

function geoTorso() {
  // shirt from the waist (tucked in) to the neck. Origin at the lumbar joint.
  const body = ringLoft([
    { y: -0.09, rx: 0.145, rz: 0.1 },
    { y: 0.0, rx: 0.15, rz: 0.104 },
    { y: 0.1, rx: 0.157, rz: 0.108, cz: -0.004 },
    { y: 0.2, rx: 0.17, rz: 0.116, cz: -0.012 },
    { y: 0.28, rx: 0.182, rz: 0.12, cz: -0.014 },
    { y: 0.335, rx: 0.19, rz: 0.112, cz: -0.006 },
    { y: 0.375, rx: 0.178, rz: 0.1, cz: 0.004 },
    { y: 0.405, rx: 0.135, rz: 0.084, cz: 0.01 },
    { y: 0.435, rx: 0.064, rz: 0.058, cz: 0.012 },
  ], 16);
  const parts = [paint(body, (x, y, z) => (z < -0.1 && Math.abs(x) < 0.012 && y > 0.05 ? 0.82 : 1))];
  for (const s of [-1, 1]) parts.push(paint(ellipsoid(0.06, 0.057, 0.06, s * SK.shX, SK.shY - 0.004, SK.shZ, 10, 7), 1)); // shoulders (sleeve tops)
  parts.push(paint(lathe([[0.4, 0.07], [0.445, 0.068]], 12).translate(0, 0, 0.012), 0.92)); // collar band
  return merge(parts);
}

function geoVest() {
  // 1944 kapok life vest: bulky padded body, collar pillow behind the neck, tie tapes.
  const body = ringLoft([
    { y: 0.0, rx: 0.178, rz: 0.132, ex: 2.6 },
    { y: 0.1, rx: 0.19, rz: 0.144, cz: -0.01, ex: 2.6 },
    { y: 0.2, rx: 0.2, rz: 0.152, cz: -0.016, ex: 2.6 },
    { y: 0.29, rx: 0.202, rz: 0.15, cz: -0.016, ex: 2.6 },
    { y: 0.345, rx: 0.182, rz: 0.13, cz: -0.006, ex: 2.4 },
    { y: 0.385, rx: 0.13, rz: 0.104, cz: 0.004 },
  ], 16, true, true);
  const parts = [paint(body, (x, y, z) => (z < -0.12 && Math.abs(x) < 0.015 ? 0.6 : 1))];
  const collar = lathe([[0.37, 0.07], [0.37, 0.116], [0.47, 0.11], [0.47, 0.074], [0.37, 0.07]], 14).translate(0, 0, 0.02);
  parts.push(paint(collar, 1));
  for (const y of [0.1, 0.22]) {
    parts.push(paint(ringLoft([{ y, rx: 0.196 + (y > 0.15 ? 0.008 : 0), rz: 0.15, cz: -0.012, ex: 2.6 }, { y: y + 0.024, rx: 0.198 + (y > 0.15 ? 0.008 : 0), rz: 0.152, cz: -0.012, ex: 2.6 }], 16, false, false), 0.42));
  }
  return merge(parts);
}

const HEAD_C = { x: 0, y: 0.165, z: -0.032 }; // cranium centre in head space (origin at the neck base)

function geoHead() {
  const parts = [];
  parts.push(paint(lathe([[-0.07, 0.062], [0.0, 0.056], [0.08, 0.05], [0.12, 0.048]], 10).rotateX(-0.15), 1)); // neck
  parts.push(paint(ellipsoid(0.077, 0.1, 0.098, HEAD_C.x, HEAD_C.y, HEAD_C.z, 16, 12), 1)); // cranium
  parts.push(paint(ellipsoid(0.062, 0.062, 0.07, 0, 0.108, -0.058, 12, 8), 1)); // jaw and cheeks
  parts.push(paint(ellipsoid(0.013, 0.024, 0.019, 0, 0.148, -0.127, 6, 5), 1)); // nose
  for (const s of [-1, 1]) {
    parts.push(paint(ellipsoid(0.014, 0.03, 0.02, s * 0.077, 0.155, -0.024, 6, 5), 0.92)); // ears
    parts.push(paint(ellipsoid(0.012, 0.008, 0.006, s * 0.031, 0.17, -0.118, 6, 4), 0.14)); // eyes
    parts.push(paint(new THREE.BoxGeometry(0.032, 0.007, 0.012).translate(s * 0.031, 0.184, -0.12), 0.32)); // brows
  }
  parts.push(paint(new THREE.BoxGeometry(0.03, 0.005, 0.008).translate(0, 0.112, -0.126), 0.55)); // mouth
  return merge(parts);
}

function geoHair() {
  // short haircut: a cap over the cranium, hairline high at the front, down to the nape behind.
  const g = new THREE.SphereGeometry(1, 16, 7, 0, TAU, 0, PI / 2 + 0.12).rotateX(0.6).scale(0.082, 0.104, 0.102).translate(HEAD_C.x, HEAD_C.y + 0.002, HEAD_C.z);
  return merge([paint(g, 1)]);
}

function geoHelmetM1() {
  // M1 steel helmet, origin at the rim centre, dome up, front -Z.
  const shell = new THREE.SphereGeometry(1, 18, 8, 0, TAU, 0, PI / 2 + 0.14).scale(0.125, 0.11, 0.145);
  const inner = flip(new THREE.SphereGeometry(1, 18, 6, 0, TAU, 0, PI / 2 + 0.14).scale(0.117, 0.1, 0.137));
  const rim = new THREE.TorusGeometry(1, 0.055, 4, 28).rotateX(PI / 2).scale(0.125, 0.11, 0.145).translate(0, -0.11 * Math.sin(0.14), 0);
  return merge([paint(shell, 1), paint(inner, 0.45), paint(rim, 0.9)]);
}

function geoHelmetMk2() {
  // Mk 2 (Brodie pattern) helmet: shallow bowl with a wide flat brim.
  const dome = new THREE.SphereGeometry(1, 18, 6, 0, TAU, 0, PI / 2).scale(0.11, 0.092, 0.122);
  const inner = flip(new THREE.SphereGeometry(1, 18, 5, 0, TAU, 0, PI / 2).scale(0.104, 0.085, 0.116));
  const brim = lathe([[-0.006, 0.104], [-0.022, 0.168], [-0.014, 0.172], [0.002, 0.108], [-0.006, 0.104]], 24, 1, 1.1);
  return merge([paint(dome, 1), paint(inner, 0.45), paint(brim, 0.92)]);
}

function geoWhiteHat() {
  // enlisted white hat ("dixie cup"): crown and rolled-up brim. Origin at the bottom centre.
  const crown = lathe([[0.0, 0.098], [0.06, 0.101], [0.074, 0.097], [0.08, 0.06], [0.082, 0.0]], 16, 1, 1.08);
  const brim = lathe([[0.0, 0.099], [0.004, 0.118], [0.04, 0.124], [0.05, 0.116], [0.046, 0.101], [0.0, 0.099]], 16, 1, 1.08);
  return merge([paint(crown, 1), paint(brim, 0.97)]);
}

function geoHood() {
  // anti-flash hood: covers head and neck down onto the shoulders, oval opening for the face.
  const shell = cut(new THREE.SphereGeometry(1, 18, 14).scale(0.088, 0.116, 0.108).translate(HEAD_C.x, HEAD_C.y - 0.004, HEAD_C.z),
    (x, y, z) => z < HEAD_C.z - 0.03 && (x / 0.052) ** 2 + ((y - HEAD_C.y + 0.02) / 0.07) ** 2 < 1);
  const cape = lathe([[-0.085, 0.175], [-0.06, 0.15], [-0.02, 0.1], [0.04, 0.072], [0.1, 0.07]], 14, 1, 0.85).translate(0, 0, 0.0);
  return merge([paint(shell, 1), paint(cape, 1)]);
}

function geoUpperArm() {
  // top end stays inside the torso's shoulder cap, so a bare arm never pokes through a sleeve
  return merge([paint(lathe([[-0.33, 0], [-0.326, 0.03], [-0.3, 0.043], [-0.2, 0.048], [-0.09, 0.052], [-0.03, 0.05], [0.01, 0.043], [0.04, 0]], 10, 0.95, 1), 1)]);
}

function geoForeArm() {
  return merge([paint(lathe([[-0.275, 0], [-0.27, 0.029], [-0.25, 0.033], [-0.16, 0.039], [-0.06, 0.045], [0.0, 0.044], [0.03, 0.035], [0.045, 0]], 10, 0.9, 1.05), 1)]);
}

function geoHand() {
  // loose fist: fingers along -Y from the wrist, thumb on the -Z side.
  const fist = ellipsoid(0.025, 0.05, 0.044, 0, -0.06, 0.003, 10, 8);
  const thumb = new THREE.SphereGeometry(1, 6, 5).scale(0.014, 0.03, 0.014).rotateX(0.5).translate(0, -0.05, -0.038);
  const wrist = lathe([[-0.025, 0.026], [0.015, 0.027]], 8);
  return merge([paint(fist, 1), paint(thumb, 0.97), paint(wrist, 1)]);
}

function geoThigh() {
  // loose dungaree trouser leg from the hip joint to the knee.
  return merge([paint(lathe([[-0.475, 0], [-0.462, 0.04], [-0.44, 0.056], [-0.4, 0.062], [-0.3, 0.07], [-0.15, 0.08], [-0.05, 0.085], [0.0, 0.086], [0.04, 0.072], [0.075, 0.04], [0.088, 0]], 10, 1, 1.04), 1)]);
}

function geoShin() {
  // knee to a hem just below the ankle, over the boot top.
  return merge([paint(lathe([[-0.468, 0], [-0.467, 0.061], [-0.44, 0.06], [-0.35, 0.058], [-0.2, 0.062], [-0.08, 0.064], [0.0, 0.064], [0.04, 0.05], [0.066, 0]], 10, 1, 1.05), 1)]);
}

function geoBoot() {
  // low leather work boot ("boondocker"), origin at the ankle joint, toe -Z, sole at y = -0.075.
  const g = ringLoft([
    { y: -0.073, rx: 0.03, rz: 0.035, cz: -0.04, ex: 2.6, dome: 0.004 },
    { y: -0.06, rx: 0.042, rz: 0.06, cz: -0.015, ex: 2.6 },
    { y: -0.02, rx: 0.048, rz: 0.066, cz: -0.009, ex: 2.6 },
    { y: 0.03, rx: 0.05, rz: 0.05, cz: -0.025, ex: 2.8 },
    { y: 0.09, rx: 0.053, rz: 0.036, cz: -0.039, ex: 3 },
    { y: 0.15, rx: 0.05, rz: 0.028, cz: -0.047, ex: 3 },
    { y: 0.19, rx: 0.038, rz: 0.022, cz: -0.052, ex: 2.6, dome: 0.012 },
  ], 12).rotateX(-PI / 2);
  return merge([paint(g, (x, y) => (y < -0.066 ? 0.42 : 1))]);
}

function geoBundle() {
  // a kapok vest carried by its collar, hanging from the hand (origin at the grip, along -Y).
  const g = ringLoft([
    { y: -0.44, rx: 0.045, rz: 0.15, ex: 3, dome: 0.01 },
    { y: -0.3, rx: 0.06, rz: 0.17, ex: 3 },
    { y: -0.12, rx: 0.064, rz: 0.172, ex: 3 },
    { y: -0.035, rx: 0.05, rz: 0.11, ex: 2.6 },
    { y: 0.01, rx: 0.035, rz: 0.05, dome: 0.01 },
  ], 12);
  const strap = ringLoft([{ y: -0.23, rx: 0.066, rz: 0.176, ex: 3 }, { y: -0.205, rx: 0.066, rz: 0.176, ex: 3 }], 12, false, false);
  return merge([paint(g, 1), paint(strap, 0.42)]);
}

// ---------------------------------------------------------------- materials

const RUNNER_NOISE = /* glsl */ `
varying vec3 vRunPos;
float rHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float rNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rHash(i), rHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(rHash(i + vec3(0.0, 1.0, 0.0)), rHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(rHash(i + vec3(0.0, 0.0, 1.0)), rHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(rHash(i + vec3(0.0, 1.0, 1.0)), rHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

// Part-space noise (sticks to each limb as it moves): blotchy wear on cloth, mottled paint on steel.
function noisePatch(color, rough) {
  return (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRunPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRunPos = transformed;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RUNNER_NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${color}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${rough}`);
  };
}

function createMaterials() {
  const cloth = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
  patchMaterial(cloth, 'runner-cloth', noisePatch(
    /* glsl */ `
      float rN = rNoise(vRunPos * 11.0) * 0.55 + rNoise(vRunPos * 37.0) * 0.3 + rNoise(vRunPos * 3.0) * 0.15;
      diffuseColor.rgb *= 0.84 + 0.3 * rN;
    `,
    'roughnessFactor = clamp(roughnessFactor + 0.12 * (rN - 0.5), 0.4, 1.0);',
  ));
  const skin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
  patchMaterial(skin, 'runner-skin', noisePatch(
    /* glsl */ `
      float rN = rNoise(vRunPos * 60.0) * 0.5 + rNoise(vRunPos * 14.0) * 0.5;
      diffuseColor.rgb *= 0.93 + 0.12 * rN;
    `,
    'roughnessFactor = clamp(roughnessFactor + 0.15 * (rN - 0.5), 0.35, 1.0);',
  ));
  const steel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2 });
  patchMaterial(steel, 'runner-steel', noisePatch(
    /* glsl */ `
      float rN = rNoise(vRunPos * 26.0) * 0.6 + rNoise(vRunPos * 80.0) * 0.4;
      float rChip = smoothstep(0.82, 0.9, rNoise(vRunPos * 45.0 + 3.0));
      diffuseColor.rgb *= 0.88 + 0.22 * rN;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.065, 0.06), rChip * 0.7);
    `,
    'roughnessFactor = clamp(roughnessFactor + 0.2 * (rN - 0.5) - 0.2 * rChip, 0.2, 1.0);',
  ));
  return { cloth, skin, steel };
}

// ---------------------------------------------------------------- outfits

// sRGB palette: USN working uniform 1944, kapok vests, helmets, flash gear, khakis for a chief.
const PAL = {
  dungaree: [0x2b3850, 0x323f58, 0x28344a, 0x37455f],
  chambray: [0x7189ab, 0x7b92b2, 0x6a83a6, 0x8199b8],
  skivvy: [0xd6d3ca, 0xcbc6ba],
  jacket: [0x34425e, 0x2f3c56],
  khaki: [0x8c7c58, 0x847452],
  vestTan: 0xa38d5c,
  vestGrey: 0x6c6f6a,
  helmet: [0x4a535c, 0x525b63, 0x454e57],
  whiteHat: [0xe4e2da, 0xd9d6cc],
  flash: 0xc4bda8,
  boot: [0x4a3626, 0x3d2c1f, 0x1d1a17],
  skin: [0xcfa184, 0xc0906f, 0xa77c60, 0x9c6f53, 0x7c5238, 0x5e3d2a],
  hair: [0x2a1d14, 0x3a2818, 0x18130f, 0x5a4026, 0x7d5d34, 0x6b3a20],
};

// Men turning out at General Quarters: from berthing (skivvy shirts, bare heads), from work
// spaces (chambray and dungarees, white hats), some already in helmets and life vests, a few
// with a helmet or kapok vest still in hand, one in flash gear, one chief in khakis.
const RECIPES = [
  { shirt: 'chambray', hat: 'white' },
  { shirt: 'chambray', hat: null },
  { shirt: 'skivvy', hat: null, sleeves: 'short' },
  { shirt: 'chambray', hat: 'm1' },
  { shirt: 'chambray', hat: 'mk2', vest: 'tan' },
  { shirt: 'chambray', hat: 'white', carry: 'helmet' },
  { shirt: 'skivvy', hat: null, sleeves: 'short', carry: 'vest' },
  { shirt: 'jacket', hat: 'm1', vest: 'grey' },
  { shirt: 'chambray', hat: 'm1', vest: 'tan', flash: true },
  { shirt: 'chambray', hat: null, sleeves: 'rolled', carry: 'helmet' },
  { shirt: 'chambray', hat: 'white', sleeves: 'rolled', carry: 'vest' },
  { shirt: 'khaki', trousers: 'khaki', hat: 'm1' },
];

// ---------------------------------------------------------------- pose

// Everything a body needs, in the runner's root space (feet origin, facing -Z). Index 0 = left.
class Pose {
  constructor() {
    this.pelvis = new V3(0, SK.hipY, 0);
    this.pelvisQ = new THREE.Quaternion();
    this.chestQ = new THREE.Quaternion(); // relative to the pelvis
    this.headQ = new THREE.Quaternion(); // root space
    this.ankle = [new V3(-0.1, SK.ankleY, 0), new V3(0.1, SK.ankleY, 0)];
    this.footQ = [new THREE.Quaternion(), new THREE.Quaternion()];
    this.knee = [new V3(0, 0, -1), new V3(0, 0, -1)]; // pole directions
    this.wrist = [new V3(-0.25, 0.85, 0), new V3(0.25, 0.85, 0)];
    this.elbow = [new V3(0, 0, 1), new V3(0, 0, 1)]; // pole directions
    this.fingers = [new V3(0, -1, 0), new V3(0, -1, 0)];
    this.thumb = [new V3(0, 0, -1), new V3(0, 0, -1)];
  }
  copy(o) {
    this.pelvis.copy(o.pelvis);
    this.pelvisQ.copy(o.pelvisQ);
    this.chestQ.copy(o.chestQ);
    this.headQ.copy(o.headQ);
    for (let k = 0; k < 2; k++) {
      this.ankle[k].copy(o.ankle[k]);
      this.footQ[k].copy(o.footQ[k]);
      this.knee[k].copy(o.knee[k]);
      this.wrist[k].copy(o.wrist[k]);
      this.elbow[k].copy(o.elbow[k]);
      this.fingers[k].copy(o.fingers[k]);
      this.thumb[k].copy(o.thumb[k]);
    }
    return this;
  }
  // Crossfade a -> b. Feet move one after the other and lift as they go, so it reads as a step.
  blend(a, b, t, stepFeet = true, leadFoot = 0) {
    this.pelvis.lerpVectors(a.pelvis, b.pelvis, t);
    this.pelvisQ.slerpQuaternions(a.pelvisQ, b.pelvisQ, t);
    this.chestQ.slerpQuaternions(a.chestQ, b.chestQ, t);
    this.headQ.slerpQuaternions(a.headQ, b.headQ, t);
    for (let k = 0; k < 2; k++) {
      let tf = t;
      if (stepFeet) tf = k === leadFoot ? sstep(0, 0.62, t) : sstep(0.38, 1, t);
      const dx = b.ankle[k].x - a.ankle[k].x, dz = b.ankle[k].z - a.ankle[k].z;
      this.ankle[k].lerpVectors(a.ankle[k], b.ankle[k], tf);
      if (stepFeet) this.ankle[k].y += Math.min(0.12, 0.5 * Math.hypot(dx, dz)) * Math.sin(PI * tf);
      this.footQ[k].slerpQuaternions(a.footQ[k], b.footQ[k], tf);
      this.knee[k].lerpVectors(a.knee[k], b.knee[k], tf).normalize();
      this.wrist[k].lerpVectors(a.wrist[k], b.wrist[k], t);
      this.elbow[k].lerpVectors(a.elbow[k], b.elbow[k], t).normalize();
      this.fingers[k].lerpVectors(a.fingers[k], b.fingers[k], t).normalize();
      this.thumb[k].lerpVectors(a.thumb[k], b.thumb[k], t).normalize();
    }
    return this;
  }
}

// ---------------------------------------------------------------- scratch objects

const _e = new THREE.Euler();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _f = new V3(), _g = new V3(), _h = new V3();
const _t = new V3(), _l = new V3(), _n = new V3(), _fh = new V3(), _Ld = new V3();
const _u = new V3(), _w = new V3(), _ik = new V3(), _ikb = new V3(), _sh = new V3();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _root = new THREE.Matrix4();
const _one = new V3(1, 1, 1);
const _Y = new V3(0, 1, 0), _X = new V3(1, 0, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpPose = new Pose();
const tmpPose2 = new Pose();

// Two-bone IK: root A, target T, bone lengths L1 and L2, bend toward `pole`. Writes the middle
// joint J, the reached end E and each bone's unit direction toward the bend side (f1, f2: the
// knee cap / back of the elbow side). Lengths are preserved; out of reach the chain straightens.
function ik2(A, T, L1, L2, pole, J, E, f1, f2) {
  _ik.subVectors(T, A);
  let d = _ik.length();
  if (d < 1e-6) _ik.set(0, -1, 0), (d = 1e-6);
  else _ik.divideScalar(d);
  d = clamp(d, Math.abs(L1 - L2) + 1e-4, (L1 + L2) * 0.9995);
  const ca = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const sa = Math.sqrt(1 - ca * ca);
  _ikb.copy(pole).addScaledVector(_ik, -pole.dot(_ik));
  if (_ikb.lengthSq() < 1e-10) {
    _ikb.set(0, 0, -1).addScaledVector(_ik, _ik.z);
    if (_ikb.lengthSq() < 1e-10) _ikb.set(1, 0, 0);
  }
  _ikb.normalize();
  J.copy(A).addScaledVector(_ik, L1 * ca).addScaledVector(_ikb, L1 * sa);
  E.copy(A).addScaledVector(_ik, d);
  f1.copy(_ik).multiplyScalar(-sa).addScaledVector(_ikb, ca);
  const p = (d - L1 * ca) / L2, q = (-L1 * sa) / L2;
  f2.copy(_ik).multiplyScalar(-q).addScaledVector(_ikb, p);
}

// Limb segment matrix: part geometry hangs along -Y from its origin at A toward B, local -Z faces
// `front`. Scales: sx/sz thickness, sy length.
function segMatrix(out, A, B, front, sx, sy, sz) {
  const y = _a.subVectors(A, B).normalize();
  const z = _b.copy(front).addScaledVector(y, -front.dot(y)).negate();
  if (z.lengthSq() < 1e-10) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = _c.crossVectors(y, z);
  return out.set(
    x.x * sx, y.x * sy, z.x * sz, A.x,
    x.y * sx, y.y * sy, z.y * sz, A.y,
    x.z * sx, y.z * sy, z.z * sz, A.z,
    0, 0, 0, 1,
  );
}

// Frame from an up axis (local +Y) and a forward axis (local -Z), orthogonalised.
function frameMatrix(out, P, up, fwd, sx, sy, sz) {
  const y = _a.copy(up).normalize();
  const z = _b.copy(fwd).addScaledVector(y, -fwd.dot(y)).negate();
  if (z.lengthSq() < 1e-10) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = _c.crossVectors(y, z);
  return out.set(
    x.x * sx, y.x * sy, z.x * sz, P.x,
    x.y * sx, y.y * sy, z.y * sz, P.y,
    x.z * sx, y.z * sy, z.z * sz, P.z,
    0, 0, 0, 1,
  );
}

// Rotate a ship-space vector into the root frame of heading h (and back).
function toLocal(out, v, h) {
  const c = Math.cos(h), s = Math.sin(h);
  return out.set(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
}

// Rolling a rigid boot on its heel (pitch > 0, toe up) or toe (pitch < 0): how far the ankle moves
// so the contact point stays put. heel / toe: ankle-to-contact offsets of the flat foot, axis: pitch axis.
function pivotOffset(out, pitch, heel, toe, axis) {
  const o = pitch > 0 ? heel : toe;
  _q1.setFromAxisAngle(axis, pitch);
  return out.copy(o).sub(_c.copy(o).applyQuaternion(_q1));
}

// Smooth pseudo-random wander in [-1, 1].
const wander = (t, o) => Math.sin(t * 0.61 + o) * 0.5 + Math.sin(t * 1.73 + o * 2.3) * 0.3 + Math.sin(t * 3.1 + o * 4.1) * 0.2;

// Duck through a watertight door: footholds in door coordinates (meters along the heading from the
// sill) against root progress p. Lead foot steps long over the sill, trail foot follows.
const LEAD_PLAN = [
  { z: -0.88, from: -Infinity, until: -0.5 },
  { swing: true, z0: -0.88, z1: 0.3, from: -0.5, until: -0.02, high: true, zr: [0, 0.8], env: [0.1, 0.4, 0.62, 1] },
  { z: 0.3, from: -0.02, until: 0.62 },
  { swing: true, z0: 0.3, z1: 1.45, from: 0.62, until: 1.0 },
  { z: 1.45, from: 1.0, until: Infinity },
];
const TRAIL_PLAN = [
  { z: -1.55, from: -Infinity, until: -1.0 },
  { swing: true, z0: -1.55, z1: -0.3, from: -1.0, until: -0.62 },
  { z: -0.3, from: -0.62, until: 0.02 },
  { swing: true, z0: -0.3, z1: 0.85, from: 0.02, until: 0.52, high: true, zr: [0.3, 1], env: [0, 0.32, 0.58, 1] },
  { z: 0.85, from: 0.52, until: Infinity },
];

const BLEND_TIME = { default: 0.3, climb: 0.38, duck: 0.3, stand: 0.45, idle: 0.6, arrive: 0.3 };

// ---------------------------------------------------------------- one runner

class Sailor {
  constructor(i, rnd, recipe) {
    const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
    this.index = i;
    this.height = lerp(1.65, 1.85, (rnd() + rnd()) / 2);
    this.s = this.height / NOM_H;
    this.W = lerp(0.92, 1.12, rnd()); // build: shoulder and limb width
    this.Wd = this.W * lerp(0.95, 1.08, rnd()); // depth (chest, belly)
    this.headS = 1.05 + (this.s - 1) * 0.35;
    const o = { shirt: 'chambray', trousers: 'dungaree', hat: null, vest: null, flash: false, carry: null, sleeves: 'long', ...recipe };
    if (o.shirt === 'chambray' && o.sleeves === 'long' && rnd() < 0.35) o.sleeves = 'rolled';
    this.outfit = o;
    this.carry = o.carry;
    this.carrySide = rnd() < 0.7 ? 0 : 1; // most carry in the left hand
    this.helmetOn = o.hat === 'm1' || o.hat === 'mk2';
    this.hatOn = o.hat === 'white';
    // colors
    const C = (h) => new THREE.Color(h);
    const shirt = o.shirt === 'skivvy' ? pick(PAL.skivvy) : o.shirt === 'jacket' ? pick(PAL.jacket) : o.shirt === 'khaki' ? pick(PAL.khaki) : pick(PAL.chambray);
    const skin = pick(PAL.skin);
    this.col = {
      trousers: C(o.trousers === 'khaki' ? pick(PAL.khaki) : pick(PAL.dungaree)),
      shirt: C(shirt),
      skin: C(skin),
      upper: C(o.sleeves === 'short' ? skin : shirt),
      fore: C(o.sleeves === 'long' ? shirt : skin),
      hand: C(o.flash ? PAL.flash : skin),
      hair: C(pick(PAL.hair)),
      helmet: C(pick(PAL.helmet)),
      whiteHat: C(pick(PAL.whiteHat)),
      vest: C(o.vest === 'grey' ? PAL.vestGrey : PAL.vestTan),
      bundle: C(rnd() < 0.6 ? PAL.vestTan : PAL.vestGrey),
      flash: C(PAL.flash),
      boot: C(pick(PAL.boot)),
    };
    // running style
    this.st = {
      cadence: lerp(0.94, 1.06, rnd()),
      armAmp: lerp(0.8, 1.25, rnd()),
      elbow: lerp(1.25, 1.62, rnd()),
      abd: lerp(0.08, 0.24, rnd()),
      lean: lerp(0.03, 0.13, rnd()),
      bounce: lerp(0.75, 1.2, rnd()),
      kneeLift: lerp(0.85, 1.2, rnd()),
      footW: lerp(0.85, 1.2, rnd()),
      crouch: lerp(0.7, 1.3, rnd()),
      hunch: lerp(0, 0.08, rnd()),
      headDown: lerp(0, 0.12, rnd()),
      lag: lerp(0.02, 0.06, rnd()),
      asym: lerp(-0.025, 0.025, rnd()),
      seed: rnd() * 100,
      stagger: lerp(-0.06, 0.06, rnd()),
      akimbo: rnd() < 0.35,
      lead: rnd() < 0.6 ? 1 : 0, // lead foot over door sills (index: 0 left, 1 right)
      hatTilt: lerp(0.05, 0.3, rnd()),
      hatRoll: lerp(-0.14, 0.14, rnd()),
    };
    this.hatOffset = new THREE.Matrix4();
    this.slots = {};

    // inputs
    this.pos = new V3();
    this.heading = 0;
    this.state = 'hidden';
    this.phaseIn = null;
    this.speedIn = null;
    this.ladderDir = new V3(0, Math.sin(60 * DEG), -Math.cos(60 * DEG));
    this.ladderBase = null;
    this.rise = DEFAULT_RISE;
    this.railHeight = 0.86;
    this.ladderWidth = 0.66;
    this.door = null;
    this.sill = 0.38;
    this.doorTop = 1.62;
    this.lookAt = null;
    this.visible = true;

    // dynamics
    this.cur = null;
    this.fromState = null;
    this.fromMode = 'live';
    this.blendW = 1;
    this.blendDur = 0.3;
    this.stateTime = 0;
    this.time = rnd() * 50;
    this.fresh = true;
    this.prev = new V3();
    this.prevHeading = 0;
    this.velL = new V3();
    this.v = 0;
    this.vAlong = 0;
    this.vPrev = 0;
    this.acc = 0;
    this.omega = 0;
    this.tdir = new V3(0, 0, -1);
    this.runPhase = rnd();
    this.climbPhase = 0;
    this.duckP = -1;
    this.lean = 0;
    this.leanV = 0;
    this.exertion = lerp(0.25, 0.45, rnd());
    this.breathPhase = rnd();
    this.headYaw = 0;
    this.headPitch = 0;
    this.lookW = 0;
    this.gazeYaw = 0;
    this.gazePitch = 0;
    this.gazeT = 0;
    this.weight = rnd() < 0.5 ? -0.6 : 0.6;
    this.weightTarget = this.weight;
    this.weightT = lerp(2, 6, rnd());
    this.akimboW = 0;
    this.donT = -1;
    this.donDelay = lerp(0.4, 1.6, rnd());
    this.autoDon = true;
    this.target = new Pose();
    this.fromPose = new Pose();
    this.frozen = new Pose();
    this.out = new Pose();
    this.headWorld = new V3();
    this.handM = [new THREE.Matrix4(), new THREE.Matrix4()];
    this.headM = new THREE.Matrix4();
  }

  gaitAt(v) {
    const cycleHz = stepsPerSecond(v) * 0.5 * Math.sqrt(NOM_H / this.height) * this.st.cadence;
    const r = sstep(1.7, 2.7, v);
    return { f: cycleHz, D: v / cycleHz, duty: lerp(0.6, 0.36, r), r };
  }

  // ------------------------------------------------------------ per-frame bookkeeping
  tick(dt) {
    if (this.fresh) {
      this.prev.copy(this.pos);
      this.prevHeading = this.heading;
      this.fresh = false;
      this.velL.set(0, 0, 0);
      this.v = this.speedIn ?? 0;
    }
    const st = this.st;
    toLocal(_Ld, this.ladderDir, this.heading).normalize();
    if (dt > 0) {
      _d.subVectors(this.pos, this.prev);
      if (_d.lengthSq() > 9) _d.set(0, 0, 0); // teleported
      toLocal(_d, _d, this.heading).divideScalar(dt);
      this.velL.lerp(_d, damp(20, dt));
      const vh = Math.hypot(this.velL.x, this.velL.z);
      if (vh > 0.25) _t.set(this.velL.x / vh, 0, this.velL.z / vh);
      else _t.set(0, 0, -1);
      if (_t.z > 0.3) _t.set(0, 0, -1); // no backward running: the body faces the way it goes
      this.tdir.lerp(_t, damp(6, dt)).normalize();
      const w = wrapPi(this.heading - this.prevHeading) / dt;
      this.omega += (clamp(w, -6, 6) - this.omega) * damp(8, dt);
      const along = this.velL.dot(_Ld);
      const vMeas = this.cur === 'climb' ? Math.max(0, along) : vh;
      const vNew = this.speedIn ?? vMeas;
      this.v = this.speedIn != null ? vNew : this.v + (vNew - this.v) * damp(25, dt);
      this.vAlong = this.speedIn ?? Math.max(0, along);
      this.acc += ((this.v - this.vPrev) / dt - this.acc) * damp(6, dt);
      this.vPrev = this.v;
      // body lean spring: brake -> lean back, then a small forward overshoot when the body stops
      const tgt = clamp(this.acc * 0.045, -0.22, 0.15) * (this.cur === 'climb' ? 0.3 : 1);
      this.leanV += (70 * (tgt - this.lean) - 7.5 * this.leanV) * dt;
      this.lean += this.leanV * dt;
      this.time += dt;
      this.stateTime += dt;
      // exertion and breathing
      const working = this.cur === 'run' || this.cur === 'climb' || this.cur === 'duck' || this.cur === 'arrive';
      if (working) this.exertion = Math.min(1, this.exertion + dt * (0.02 + 0.012 * this.v + (this.cur === 'climb' ? 0.03 : 0)));
      else this.exertion = Math.max(0.12, this.exertion - dt / 16);
      this.breathPhase += dt * lerp(0.24, 0.85, this.exertion);
    }
    this.prev.copy(this.pos);
    this.prevHeading = this.heading;

    // state change: crossfade from the previous pose
    if (this.state !== this.cur) {
      if (this.cur == null || this.cur === 'hidden') {
        this.blendW = 1;
      } else {
        if (this.blendW < 1) {
          this.frozen.copy(this.out);
          this.fromMode = 'frozen';
        } else this.fromMode = 'live';
        this.fromState = this.cur;
        this.blendW = 0;
        this.blendDur = BLEND_TIME[this.state] ?? BLEND_TIME.default;
        if (this.cur === 'climb' || this.state === 'climb') this.blendDur = BLEND_TIME.climb;
      }
      if (this.state === 'duck' && !this.door) this.duckP = -1.0;
      // which foot moves first in the crossfade: latched, so it can't swap halfway
      this.blendLead = this.state === 'duck' ? st.lead : this.runPhase < 0.5 ? 1 : 0;
      this.cur = this.state;
      this.stateTime = 0;
    }

    // phases
    const g = this.gaitAt(this.v);
    if (this.phaseIn != null && (this.cur === 'run' || this.cur === 'arrive')) this.runPhase = fract(this.phaseIn);
    else this.runPhase = fract(this.runPhase + g.f * dt);
    const rise = this.rise;
    const sinA = clamp(_Ld.y, 0.3, 1);
    const Dc = (2 * rise) / sinA;
    if (this.phaseIn != null && this.cur === 'climb') this.climbPhase = fract(this.phaseIn);
    else if (this.ladderBase) {
      const sAlong = _a.subVectors(this.pos, this.ladderBase).dot(_b.copy(this.ladderDir).normalize());
      this.climbPhase = fract((sAlong + 0.83 * (rise / sinA)) / Dc);
    } else this.climbPhase = fract(this.climbPhase + (this.vAlong * dt) / Dc);
    if (this.phaseIn != null && this.cur === 'duck') this.duckP = -1 + 1.9 * clamp(this.phaseIn, 0, 1);
    else if (this.door) {
      _a.subVectors(this.pos, this.door);
      this.duckP = -(_a.x * Math.sin(this.heading) + _a.z * Math.cos(this.heading)); // along the heading (-Z rotated)
    } else this.duckP = Math.min(1.2, this.duckP + this.v * dt);

    // helmet donning
    if (this.carry === 'helmet' && this.donT < 0 && this.autoDon && (this.cur === 'stand' || this.cur === 'idle' || this.cur === 'arrive') && this.stateTime > this.donDelay && this.v < 0.6) this.donT = 0;
    if (this.donT >= 0) {
      this.donT += dt;
      if (this.donT >= 0.52 && !this.helmetOn) {
        this.helmetOn = true;
        this.hatOn = false;
      }
      if (this.donT >= 1.25) {
        this.donT = -1;
        this.carry = null;
      }
    }

    // where the head looks (root space yaw / pitch), springs toward the wanted direction
    let yaw = 0, pitch = 0, rate = 7;
    const s = this.s;
    if (this.cur === 'run' || this.cur === 'arrive') {
      yaw = Math.atan2(-this.tdir.x, -this.tdir.z) + clamp(this.omega * 0.3, -0.6, 0.6);
      pitch = -0.07 - st.headDown;
    } else if (this.cur === 'climb') {
      pitch = 0.2;
      yaw = wander(this.time * 0.5, st.seed) * 0.12;
    } else if (this.cur === 'duck') {
      pitch = lerp(-0.12, -0.42, sstep(-1.0, -0.6, this.duckP) * (1 - sstep(-0.05, 0.4, this.duckP)));
    } else if (this.cur === 'idle') {
      this.gazeT -= dt;
      if (this.gazeT <= 0) {
        const r = fract(Math.sin(this.time * 12.9898 + st.seed) * 43758.5453);
        const r2 = fract(Math.sin(this.time * 78.233 + st.seed * 3.1) * 12543.1);
        this.gazeYaw = (r * 2 - 1) * 1.15;
        this.gazePitch = r2 < 0.35 ? lerp(0.25, 0.6, r2 / 0.35) : lerp(-0.15, 0.15, r2);
        this.gazeT = lerp(1.1, 3.4, fract(r * 7.13 + r2));
      }
      yaw = this.gazeYaw;
      pitch = this.gazePitch;
      rate = 9;
    } else {
      yaw = wander(this.time * 0.35, st.seed) * 0.18;
      pitch = -0.04 + wander(this.time * 0.3, st.seed + 5) * 0.06;
      rate = 4;
    }
    this.lookW += ((this.lookAt ? 1 : 0) - this.lookW) * damp(4, dt);
    if (this.lookW > 0.001 && this.lookAt) {
      _a.subVectors(this.lookAt, this.pos);
      toLocal(_a, _a, this.heading);
      _a.y -= 1.6 * s;
      const ly = Math.atan2(-_a.x, -_a.z);
      const lp = Math.atan2(_a.y, Math.hypot(_a.x, _a.z));
      const lim = this.cur === 'stand' || this.cur === 'idle' ? 1.5 : 1.0;
      yaw = lerp(yaw, clamp(ly, -lim, lim), this.lookW);
      pitch = lerp(pitch, clamp(lp, -0.7, 0.7), this.lookW);
    }
    this.headYaw += (yaw - this.headYaw) * damp(rate, dt);
    this.headPitch += (pitch - this.headPitch) * damp(rate, dt);

    // weight shifts at rest
    this.weightT -= dt;
    if (this.weightT <= 0) {
      this.weightTarget = -Math.sign(this.weightTarget || 1) * lerp(0.4, 1, fract(this.time * 0.37 + st.seed));
      this.weightT = lerp(3, 8, fract(this.time * 0.71 + st.seed * 0.3));
    }
    this.weight += (this.weightTarget - this.weight) * damp(1.6, dt);
    const akimbo = this.cur === 'idle' && st.akimbo && !this.carry && this.stateTime > 1.5 && this.lookW < 0.5;
    this.akimboW += ((akimbo ? 1 : 0) - this.akimboW) * damp(3, dt);

    // pose: current state, crossfaded from the previous one
    this.evalState(this.cur, this.target);
    if (this.blendW < 1) {
      this.blendW = Math.min(1, this.blendW + (dt > 0 ? dt / this.blendDur : 0));
      let from = this.frozen;
      if (this.fromMode === 'live') {
        this.evalState(this.fromState, this.fromPose);
        from = this.fromPose;
      }
      const w = sstep(0, 1, this.blendW);
      this.out.blend(from, this.target, w, true, this.blendLead);
      if (this.cur === 'duck' || this.fromState === 'duck') {
        // lowering the body moves the shoulders: carry the arms down with it
        const drop = this.clearDoor(this.out);
        if (drop > 0) for (let k = 0; k < 2; k++) this.out.wrist[k].y -= drop;
      }
    } else this.out.copy(this.target);
  }

  evalState(state, P) {
    switch (state) {
      case 'climb': return this.poseClimb(P);
      case 'duck': return this.poseDuck(P);
      case 'stand': return this.poseStand(P, false);
      case 'idle': return this.poseStand(P, true);
      case 'arrive': return this.poseGait(P, true);
      default: return this.poseGait(P, false);
    }
  }

  // ------------------------------------------------------------ pose helpers
  breath() {
    return Math.sin(this.breathPhase * TAU) * lerp(0.4, 1, this.exertion);
  }

  shoulder(P, k, out) {
    const s = this.s;
    _q1.multiplyQuaternions(P.pelvisQ, P.chestQ);
    out.set(0, SK.lumbar * s, 0).applyQuaternion(P.pelvisQ).add(P.pelvis);
    return out.add(_a.set((k ? 1 : -1) * SK.shX * s * this.W, SK.shY * s, SK.shZ * s).applyQuaternion(_q1));
  }

  // Keep the pelvis low enough that both feet can be reached with a slightly bent knee.
  fitPelvis(P) {
    const s = this.s, L = (SK.thigh + SK.shin) * s * 0.985;
    let drop = 0;
    for (let k = 0; k < 2; k++) {
      _a.set((k ? 1 : -1) * SK.hipX * s * this.W, 0, 0).applyQuaternion(P.pelvisQ).add(P.pelvis);
      const dx = P.ankle[k].x - _a.x, dz = P.ankle[k].z - _a.z;
      const h2 = dx * dx + dz * dz;
      if (h2 < L * L) drop = Math.max(drop, _a.y - (P.ankle[k].y + Math.sqrt(L * L - h2)));
    }
    P.pelvis.y -= Math.min(drop, 0.25 * s);
  }

  setPelvis(P, pitch, yaw, roll) {
    P.pelvisQ.setFromEuler(_e.set(-pitch, yaw, -roll, 'YXZ'));
  }

  setChest(P, lean, yaw, roll) {
    P.chestQ.setFromEuler(_e.set(-lean, yaw, -roll, 'YXZ'));
  }

  setHead(P, extraPitch = 0, roll = 0) {
    // limit the neck: the head turns at most ~70 degrees from the chest
    _q1.multiplyQuaternions(P.pelvisQ, P.chestQ);
    _e.setFromQuaternion(_q1, 'YXZ');
    const chestYaw = _e.y;
    const yaw = chestYaw + clamp(wrapPi(this.headYaw - chestYaw), -1.25, 1.25);
    P.headQ.setFromEuler(_e.set(clamp(this.headPitch + extraPitch, -0.9, 0.8), yaw, roll, 'YXZ'));
  }

  // Arm by joint angles in chest space: swing (forward +), elbow flexion, forearm turned in
  // toward the midline, abduction. Writes the wrist target, elbow pole, finger and thumb axes.
  armFK(P, k, swing, elbow, inward, abd, shrug = 0) {
    const s = this.s, sg = k ? 1 : -1;
    _q2.multiplyQuaternions(P.pelvisQ, P.chestQ);
    const S = this.shoulder(P, k, _sh);
    S.addScaledVector(_c.set(0, 1, 0).applyQuaternion(_q2), shrug * s);
    const ca = Math.cos(sg * abd), sa = Math.sin(sg * abd);
    // upper arm: R_z(abd) R_x(swing) (0,-1,0)
    let x = 0, y = -Math.cos(swing), z = -Math.sin(swing);
    _u.set(x * ca - y * sa, x * sa + y * ca, z).applyQuaternion(_q2);
    // forearm: R_z(abd) R_y(inward) R_x(swing + elbow) (0,-1,0)
    const te = swing + elbow, ci = Math.cos(sg * inward), si = Math.sin(sg * inward);
    const fz = -Math.sin(te), fy = -Math.cos(te);
    x = fz * si;
    y = fy;
    z = fz * ci;
    _w.set(x * ca - y * sa, x * sa + y * ca, z).applyQuaternion(_q2);
    const Lu = SK.upper * s, Lf = SK.fore * s;
    _d.copy(S).addScaledVector(_u, Lu); // elbow
    P.wrist[k].copy(_d).addScaledVector(_w, Lf);
    // pole: elbow off the shoulder-wrist line, with a backward-outward default when straight
    _f.subVectors(P.wrist[k], S).normalize();
    P.elbow[k].subVectors(_d, S).addScaledVector(_f, -_g.subVectors(_d, S).dot(_f));
    P.elbow[k].add(_g.set(sg * 0.02, 0, 0.03).applyQuaternion(_q2)).normalize();
    P.fingers[k].copy(_w);
    // thumb on the flexor side of the forearm (up when the elbow is bent, forward when it hangs)
    P.thumb[k].copy(_u).negate().addScaledVector(_w, _u.dot(_w));
    if (P.thumb[k].lengthSq() < 0.02) P.thumb[k].lerp(_g.set(0, 0, -1).applyQuaternion(_q2), 0.5);
    P.thumb[k].normalize();
  }

  // Foot on a planted track (run and climb). u in [0,1): 0 = touchdown, duty = stance length.
  // T: track direction (unit), D: track length per cycle, a: touchdown offset ahead of the root,
  // base: flat-foot ankle offset from the track point, N: lift direction, F: toe direction.
  footTrack(P, k, u, o) {
    const s = this.s;
    const β = o.duty, D = o.D, a = o.a;
    // foot yaw and pivot offsets (flat foot)
    const yaw = Math.atan2(-o.F.x, -o.F.z) + o.toeOut;
    _q3.setFromAxisAngle(_Y, yaw);
    _l.set(1, 0, 0).applyQuaternion(_q3); // pitch axis
    const heel = _g.set(0, -SK.ankleY * s, SK.heelZ * s).applyQuaternion(_q3);
    const ball = _h.set(0, -SK.ankleY * s, SK.toeZ * s).applyQuaternion(_q3); // rigid boot: heel-off rolls on the toe
    // pivot displacement: ankle = A0 + o - R(p) o
    let pitch;
    const A = P.ankle[k];
    if (u < β) {
      const uh = u / β;
      pitch = o.ptd * (1 - sstep(0, 0.2, uh)) + o.pto * sstep(o.ho, 1, uh);
      A.copy(o.T).multiplyScalar(a - u * D).add(o.base);
      A.add(pivotOffset(_f, pitch, heel, ball, _l));
    } else {
      const sw = (u - β) / (1 - β);
      const x0 = a - β * D, x1 = a;
      const m0 = -o.k0 * D * (1 - β), m1 = -o.k1 * D * (1 - β);
      const s2 = sw * sw, s3 = s2 * sw;
      // stairs: get over the next tread early, then come down onto it from above
      const xi = o.place
        ? lerp(x0, x1, sstep(0, o.place, sw))
        : (2 * s3 - 3 * s2 + 1) * x0 + (s3 - 2 * s2 + sw) * m0 + (-2 * s3 + 3 * s2) * x1 + (s3 - s2) * m1;
      pitch = o.midPitch != null
        ? lerp(lerp(o.pto, o.midPitch, sstep(0, 0.35, sw)), o.ptd, sstep(0.65, 1, sw)) // toes up to clear the treads
        : lerp(o.pto, o.ptd, sstep(0.1, 0.75, sw));
      A.copy(o.T).multiplyScalar(xi).add(o.base);
      // blend the pivot offsets of toe-off and touchdown
      pivotOffset(_f, o.pto, heel, ball, _l);
      pivotOffset(_d, o.ptd, heel, ball, _l);
      A.add(_f.lerp(_d, sstep(0, 1, sw)));
      A.addScaledVector(o.N, o.lift * Math.sin(PI * Math.pow(sw, o.kappa)));
      A.addScaledVector(o.lat, (k ? 1 : -1) * o.bow * Math.sin(PI * sw));
      if (o.pullBack) A.addScaledVector(o.F, -o.pullBack * sstep(0, 0.25, sw) * (1 - sstep(0.5, 0.78, sw))); // out from under the next tread
    }
    _q1.setFromAxisAngle(_X, pitch);
    P.footQ[k].multiplyQuaternions(_q3, _q1);
    P.knee[k].copy(o.F).multiplyScalar(1).add(_a.copy(o.lat).multiplyScalar((k ? 1 : -1) * 0.18)).normalize();
  }

  // ------------------------------------------------------------ run / walk / arrive
  poseGait(P, arriving) {
    const s = this.s, st = this.st, v = this.v;
    const g = this.gaitAt(v);
    const r = g.r, β = g.duty, D = g.D;
    const amp = sstep(0.0, 0.9, v);
    const φ = this.runPhase;
    _t.copy(this.tdir);
    _n.set(-_t.z, 0, _t.x); // right of the travel direction
    const opts = this._gaitOpts || (this._gaitOpts = { T: new V3(), base: new V3(), N: _Y, F: new V3(), lat: new V3() });
    opts.T.copy(_t);
    opts.F.copy(_t);
    opts.lat.copy(_n);
    opts.duty = β;
    opts.D = D;
    opts.a = β * D * lerp(0.5, 0.38, r);
    opts.ptd = lerp(0.22, 0.08, r) * amp;
    opts.pto = -lerp(0.5, 0.72, r) * amp;
    opts.ho = lerp(0.6, 0.45, r);
    opts.k0 = lerp(0.1, 0.55, r);
    opts.k1 = lerp(0.08, 0.25, r);
    opts.lift = lerp(0.07, 0.3, r) * st.kneeLift * s * amp;
    opts.kappa = lerp(1, 0.68, r);
    opts.bow = 0.02 * s * amp;
    const width = lerp(0.1, 0.065, r) * st.footW * s;
    let stanceSin = 0;
    for (let k = 0; k < 2; k++) {
      const sg = k ? 1 : -1;
      const u = fract(φ + (k ? 0.5 + st.asym : 0));
      opts.base.copy(_n).multiplyScalar(sg * width).add(_a.set(0, SK.ankleY * s, 0));
      opts.toeOut = -sg * lerp(0.12, 0.05, r);
      this.footTrack(P, k, u, opts);
      if (u < β) stanceSin += Math.sin((PI * u) / β);
    }
    // pelvis: walking vaults over the stance leg, running sinks into it
    const hipH = SK.hipY * s - lerp(0.012, 0.075, r) * st.crouch * s * amp;
    const bobWalk = 0.022 * s * Math.cos(TAU * 2 * (φ - β / 2));
    const bobRun = 0.045 * s * st.bounce * (0.5 - stanceSin);
    const y = hipH + lerp(bobWalk, bobRun, r) * amp;
    const sway = -Math.cos(TAU * (φ - β / 2)) * lerp(0.025, 0.01, r) * s * amp;
    P.pelvis.set(sway, y, 0);
    const turnRoll = -Math.atan((v * this.omega) / 9.81) * 0.9;
    const pyaw = -lerp(0.07, 0.12, r) * amp * Math.cos(TAU * (φ - 0.02));
    const proll = lerp(0.06, 0.035, r) * amp * Math.cos(TAU * (φ - β / 2)) + turnRoll;
    const ppitch = lerp(0.03, 0.14, r) * amp + st.lean * 0.4 * amp + this.lean * 0.5 + (arriving ? 0.02 : 0);
    this.setPelvis(P, ppitch, pyaw, proll);
    this.fitPelvis(P);
    // chest counter-rotates against the pelvis, leans with speed and acceleration, breathes
    const br = this.breath();
    const w1 = wander(this.time * 0.8, st.seed);
    const lean = st.lean * 0.7 * amp + lerp(0.02, 0.1, r) * amp + this.lean * 0.5 + st.hunch + br * 0.012 * (1 + this.exertion) + w1 * 0.015;
    this.setChest(P, lean, -pyaw * 1.5, -(proll - turnRoll) * 0.6);
    // arms swing against the legs; the carrying arm swings less
    for (let k = 0; k < 2; k++) {
      const c = Math.cos(TAU * (φ - st.lag - (k ? 0 : 0.5)));
      let swing = lerp(0.04, -0.06, r) + c * lerp(0.3, 0.58, r) * st.armAmp * amp * (1 + w1 * 0.08);
      let elbow = lerp(0.3, st.elbow, r * amp) + Math.max(0, c) * lerp(0.15, 0.35, r) * amp - Math.min(0, c) * 0.08 * amp;
      let inward = lerp(0.12, 0.35, r) + Math.max(0, c) * 0.25 * r;
      const abd = st.abd * lerp(0.5, 1, r) + 0.04;
      if (this.carry && k === this.carrySide) {
        swing = 0.06 + c * 0.12 * amp;
        elbow = this.carry === 'vest' ? 0.25 : 0.4 + 0.25 * r;
        inward = 0.15;
      }
      this.armFK(P, k, swing, elbow, inward, abd, br * 0.006);
    }
    this.setHead(P, 0, proll * 0.3);
    if (v < 0.9 || arriving) this.settle(P, sstep(0.25, 0.9, v));
    this.applyDon(P);
  }

  // At low speed the gait gives way to a stance (and after a run, heavy breathing).
  settle(P, moving) {
    if (moving >= 0.999) return;
    this.poseStand(tmpPose, false);
    tmpPose2.copy(P);
    P.blend(tmpPose, tmpPose2, moving, false);
  }

  // ------------------------------------------------------------ stand / idle
  poseStand(P, idle) {
    const s = this.s, st = this.st;
    const w = this.weight * (idle ? 1 : 0.5);
    for (let k = 0; k < 2; k++) {
      const sg = k ? 1 : -1;
      P.ankle[k].set(sg * 0.11 * s * st.footW, SK.ankleY * s, sg * st.stagger * s);
      P.footQ[k].setFromAxisAngle(_Y, -sg * 0.16);
      P.knee[k].set(sg * 0.2, 0, -1).normalize();
    }
    const br = this.breath();
    const ex = this.exertion;
    P.pelvis.set(w * 0.03 * s, SK.hipY * s - 0.012 * s, 0.01 * s);
    this.setPelvis(P, 0.02 + ex * 0.03, w * 0.04 + wander(this.time * 0.2, st.seed) * 0.03, -w * 0.05);
    this.fitPelvis(P);
    const lean = st.hunch * 0.6 + ex * 0.06 - br * 0.018 * (1 + ex);
    const follow = clamp(this.headYaw * 0.28, -0.35, 0.35);
    this.setChest(P, lean, follow, w * 0.06 + wander(this.time * 0.25, st.seed + 2) * 0.015);
    for (let k = 0; k < 2; k++) {
      const sg = k ? 1 : -1;
      const sway = wander(this.time * 0.4, st.seed + k * 7) * 0.03;
      let elbow = 0.2 + (k ? 0.04 : 0);
      if (this.carry && k === this.carrySide) elbow = this.carry === 'vest' ? 0.2 : 0.35;
      this.armFK(P, k, 0.05 + sway, elbow, 0.12, 0.07 + (idle ? 0.02 : 0), br * 0.009 * (1 + ex));
      if (this.akimboW > 0.001) {
        // hands on hips
        _q2.copy(P.pelvisQ);
        _a.set(sg * 0.165 * s * this.W, 0.09 * s, 0.015 * s).applyQuaternion(_q2).add(P.pelvis);
        P.wrist[k].lerp(_a, this.akimboW);
        P.elbow[k].lerp(_b.set(sg, 0, 0.45).applyQuaternion(_q2), this.akimboW).normalize();
        P.fingers[k].lerp(_b.set(-sg * 0.3, -0.6, -0.6).applyQuaternion(_q2), this.akimboW).normalize();
        P.thumb[k].lerp(_b.set(0, 0, 1).applyQuaternion(_q2), this.akimboW).normalize();
      }
    }
    this.setHead(P, 0, wander(this.time * 0.3, st.seed + 4) * 0.04);
    this.applyDon(P);
  }

  // ------------------------------------------------------------ inclined ladder
  poseClimb(P) {
    const s = this.s, st = this.st;
    toLocal(_Ld, this.ladderDir, this.heading).normalize();
    const sinA = clamp(_Ld.y, 0.3, 1);
    const Δ = this.rise / sinA, Dc = 2 * Δ;
    _fh.set(_Ld.x, 0, _Ld.z);
    if (_fh.lengthSq() < 1e-6) _fh.set(0, 0, -1);
    _fh.normalize();
    _l.crossVectors(_Ld, _Y).normalize(); // right
    _n.crossVectors(_l, _Ld).normalize(); // off the ladder, toward the climber
    const lat = this._climbLat || (this._climbLat = new V3());
    lat.copy(_l);
    const φ = this.climbPhase;
    const β = 0.62;
    const steep = sstep(55, 72, Math.asin(sinA) / DEG);
    const opts = this._climbOpts || (this._climbOpts = { T: new V3(), base: new V3(), N: new V3(), F: new V3(), lat: null });
    opts.T.copy(_Ld);
    opts.N.copy(_Y).addScaledVector(_n, 0.3).normalize();
    opts.F.copy(_fh);
    opts.place = 0.78;
    opts.midPitch = 0.3;
    opts.pullBack = (0.09 + 0.05 * steep) * s;
    opts.lat = lat;
    opts.duty = β;
    opts.D = Dc;
    opts.a = 0.83 * Δ;
    opts.ptd = 0.03;
    opts.pto = -0.38;
    opts.ho = 0.5;
    opts.k0 = 0.05;
    opts.k1 = 0;
    opts.lift = Math.min((0.1 + 0.32 * this.rise + 0.05 * steep) * s, 0.85 * this.rise); // the slot between treads is tight
    opts.kappa = 0.85;
    opts.bow = 0.015 * s;
    for (let k = 0; k < 2; k++) {
      const sg = k ? 1 : -1;
      const u = fract(φ + (k ? 0.5 : 0));
      // ball of the foot just past the nosing, heel over the edge
      opts.base.copy(_fh).multiplyScalar(-0.075 * s).addScaledVector(_Y, SK.ankleY * s).addScaledVector(lat, sg * 0.1 * s);
      opts.toeOut = -sg * 0.05;
      this.footTrack(P, k, u, opts);
      P.knee[k].copy(_fh).addScaledVector(lat, sg * 0.15).normalize();
    }
    // body: crouched over the treads, leaning into the ladder, surging with each push
    const sway = -Math.cos(TAU * (φ - β / 2)) * 0.022 * s;
    P.pelvis.copy(_Y).multiplyScalar(0.8 * s).addScaledVector(_fh, -lerp(0.12, 0.06, steep) * s).addScaledVector(_Ld, 0.02 * s * Math.sin(TAU * 2 * (φ - 0.1))).addScaledVector(lat, sway);
    const pyaw = -0.06 * Math.cos(TAU * φ);
    this.setPelvis(P, lerp(0.34, 0.24, steep) + 0.03 * Math.sin(TAU * 2 * φ), pyaw, 0.03 * Math.cos(TAU * (φ - β / 2)));
    this.fitPelvis(P);
    const br = this.breath();
    this.setChest(P, lerp(0.16, 0.22, steep) + st.hunch * 0.5 + br * 0.01, -pyaw * 1.3, 0);
    // hands slide up the handrails, each pushing ahead in turn (never back)
    const half = this.ladderWidth / 2;
    for (let k = 0; k < 2; k++) {
      const sg = k ? 1 : -1;
      if (this.carry && k === this.carrySide) {
        this.armFK(P, k, -0.05, 0.3, 0.1, 0.1); // the item hangs at his side
        continue;
      }
      const xi = 0.56 * s + 0.05 * Math.sin(TAU * (φ + (k ? 0.5 : 0) + 0.15));
      _a.copy(_Ld).multiplyScalar(xi).addScaledVector(_Y, this.railHeight).addScaledVector(lat, sg * half); // grip on the rail
      P.fingers[k].copy(lat).multiplyScalar(sg * 0.45).addScaledVector(_Y, -0.45).addScaledVector(_Ld, 0.55).normalize();
      P.thumb[k].copy(_Ld).addScaledVector(lat, -sg * 0.3).normalize();
      P.wrist[k].copy(_a).addScaledVector(P.fingers[k], -SK.grip * s).addScaledVector(_Y, 0.012);
      P.elbow[k].copy(lat).multiplyScalar(sg * 0.7).addScaledVector(_Y, -0.5).addScaledVector(_n, 0.35).normalize();
    }
    this.setHead(P, 0, 0);
    this.applyDon(P);
  }

  // ------------------------------------------------------------ watertight door
  poseDuck(P) {
    const s = this.s, st = this.st;
    const p = this.duckP;
    const leadK = this.carry && this.carrySide === st.lead ? 1 - st.lead : st.lead; // free hand on the frame
    const leadFoot = st.lead;
    const env = sstep(-1.0, -0.6, p) * (1 - sstep(0.0, 0.42, p));
    // how far to fold to clear the top of the opening
    const crouch = 0.07 * s;
    const ψ = clamp(Math.acos(clamp((this.doorTop - 0.06 - (SK.hipY * s - crouch)) / (0.83 * s), -1, 1)), 0.25, 0.9);
    for (let k = 0; k < 2; k++) {
      const sg = k ? 1 : -1;
      const plan = k === leadFoot ? LEAD_PLAN : TRAIL_PLAN;
      let seg = plan[plan.length - 1];
      for (const sgm of plan) if (p < sgm.until) { seg = sgm; break; }
      const A = P.ankle[k];
      let pitch = 0;
      const heelOff = (until) => -0.42 * sstep(until - 0.22, until, p);
      if (!seg.swing) {
        pitch = (seg.from > -1e9 ? 0.16 * (1 - sstep(seg.from, seg.from + 0.1, p)) : 0) + (seg.until < 1e9 ? heelOff(seg.until) : 0);
        A.set(sg * 0.1 * s, SK.ankleY * s, -(seg.z - p));
      } else {
        const sw = clamp((p - seg.from) / (seg.until - seg.from), 0, 1);
        const zr = seg.zr || [0, 1];
        const z = lerp(seg.z0, seg.z1, sstep(zr[0], zr[1], sw));
        let y;
        if (seg.high) {
          const e = seg.env;
          y = (this.sill + 0.13) * sstep(e[0], e[1], sw) * (1 - sstep(e[2], e[3], sw)) + 0.03 * Math.sin(PI * sw);
          pitch = lerp(-0.42, 0.22, sstep(0, 0.3, sw)) * (1 - sstep(0.75, 1, sw)) + 0.12 * sstep(0.75, 1, sw);
        } else {
          y = 0.08 * s * Math.sin(PI * sw);
          pitch = lerp(-0.42, 0.14, sstep(0.1, 0.8, sw));
        }
        A.set(sg * (0.1 * s + 0.035 * Math.sin(PI * sw)), SK.ankleY * s + y, -(z - p));
      }
      // heel or ball pivot on the ground
      _q3.setFromAxisAngle(_Y, -sg * 0.08);
      if (pitch !== 0) {
        _l.set(1, 0, 0).applyQuaternion(_q3);
        const o2 = (pitch > 0 ? _g.set(0, -SK.ankleY * s, SK.heelZ * s) : _g.set(0, -SK.ankleY * s, SK.toeZ * s)).applyQuaternion(_q3);
        _q1.setFromAxisAngle(_l, pitch);
        A.add(o2).sub(_c.copy(o2).applyQuaternion(_q1));
      }
      _q1.setFromAxisAngle(_X, pitch);
      P.footQ[k].multiplyQuaternions(_q3, _q1);
      P.knee[k].set(sg * 0.25, 0, -1).normalize();
    }
    // body: shift over the stance foot, fold forward under the top, turn the stepping hip forward
    const sgL = leadFoot ? 1 : -1;
    const b1 = bump(p, -0.5, -0.02), b2 = bump(p, 0.02, 0.52);
    P.pelvis.set(-sgL * 0.035 * s * b1 + sgL * 0.035 * s * b2, SK.hipY * s - crouch * env - 0.015 * s, 0);
    const pyaw = sgL * 0.12 * b1 - sgL * 0.1 * b2;
    this.setPelvis(P, 0.06 + ψ * 0.42 * env, pyaw, 0);
    this.fitPelvis(P);
    this.setChest(P, ψ * 0.58 * env + st.hunch * 0.5, -pyaw * 0.8, 0);
    this.setHead(P, 0, 0);
    this.clearDoor(P);
    // free hand grabs the door frame, the other swings low and forward for balance
    const hold = sstep(-0.85, -0.6, p) * (1 - sstep(0.1, 0.32, p));
    for (let k = 0; k < 2; k++) {
      const sg = k ? 1 : -1;
      if (this.carry && k === this.carrySide) {
        this.armFK(P, k, 0.2, this.carry === 'vest' ? 0.3 : 0.9, 0.3, 0.15);
        continue;
      }
      this.armFK(P, k, 0.3 + 0.15 * env, 0.85, 0.3, 0.16);
      if (k === leadK && hold > 0.001) {
        _a.set(sg * 0.3, 1.08, -(0.02 - p)); // grip on the frame edge
        _b.set(sg * 0.5, 0, -0.85).normalize();
        _c.copy(_a).addScaledVector(_b, -0.06 * s).addScaledVector(_X, -sg * 0.02);
        P.wrist[k].lerp(_c, hold);
        P.fingers[k].lerp(_b, hold).normalize();
        P.thumb[k].lerp(_Y, hold).normalize();
        P.elbow[k].lerp(_d.set(sg * 0.8, -0.5, 0.3).normalize(), hold).normalize();
      }
    }
    this.setHead(P, 0, 0);
  }

  // Measure the crown (hat or helmet included) near the door plane and sink lower (deeper knee bend)
  // if it would hit the top of the opening. Returns how far the body was lowered.
  clearDoor(P) {
    const s = this.s, p = this.duckP;
    _q1.multiplyQuaternions(P.pelvisQ, P.chestQ);
    _a.set(0, SK.lumbar * s, 0).applyQuaternion(P.pelvisQ).add(P.pelvis);
    _a.add(_b.set(0, SK.neckY * s, SK.neckZ * s).applyQuaternion(_q1));
    _a.add(_b.set(0, 0.315 * this.headS, -0.03).applyQuaternion(P.headQ));
    const near = 1 - sstep(0.26, 0.46, Math.abs(p - _a.z));
    const over = Math.min((_a.y - (this.doorTop - 0.05)) * near, 0.3 * s);
    if (over > 0) P.pelvis.y -= over;
    return Math.max(0, over);
  }

  // Raise the carried helmet over the head and pull it on (donT 0 .. 1.25 s).
  applyDon(P) {
    if (this.donT < 0) return;
    const k = this.carrySide, t = this.donT, s = this.s;
    const w = sstep(0, 0.3, t) * (1 - sstep(0.85, 1.22, t));
    // head top from the pose
    _q1.multiplyQuaternions(P.pelvisQ, P.chestQ);
    _a.set(0, SK.lumbar * s, 0).applyQuaternion(P.pelvisQ).add(P.pelvis);
    _a.add(_b.set(0, SK.neckY * s, SK.neckZ * s).applyQuaternion(_q1));
    _a.add(_b.set(0, 0.3 * this.headS, -0.03).applyQuaternion(P.headQ)); // crown
    const sg = k ? 1 : -1;
    const up = lerp(0.2, 0.06, sstep(0.3, 0.55, t));
    _c.copy(_a).addScaledVector(_Y, up).add(_b.set(sg * 0.05, 0, 0.03).applyQuaternion(P.headQ));
    P.wrist[k].lerp(_c, w);
    // swing the hand up in front of the shoulder (a straight path passes through it and flips the elbow)
    P.wrist[k].add(_d.set(sg * 0.12, 0, -0.3).applyQuaternion(_q1).multiplyScalar(Math.sin(PI * w) * s));
    P.elbow[k].lerp(_d.set(sg, -0.15, 0.3).normalize(), w).normalize(); // out and back: never through zero
    P.fingers[k].lerp(_d.set(-sg * 0.4, -0.3, -0.5).normalize(), w).normalize();
    P.thumb[k].lerp(_d.set(0, 0, -1), w).normalize();
  }
}

// ---------------------------------------------------------------- the crowd

export class Runners {
  constructor(count, { seed = 1944 } = {}) {
    this.count = count;
    this.group = new THREE.Group();
    this.group.name = 'runners';
    const rnd = mulberry32(seed);
    // deal the outfits like cards: every recipe appears before any repeats
    let deck = [];
    this.sailors = [];
    for (let i = 0; i < count; i++) {
      if (!deck.length) {
        deck = RECIPES.slice();
        for (let j = deck.length - 1; j > 0; j--) {
          const r = Math.floor(rnd() * (j + 1));
          [deck[j], deck[r]] = [deck[r], deck[j]];
        }
      }
      this.sailors.push(new Sailor(i, rnd, deck.pop()));
    }
    this.mats = createMaterials();
    const M = this.mats;
    const defs = [
      ['pelvis', geoPelvis, M.cloth, () => 1],
      ['torso', geoTorso, M.cloth, () => 1],
      ['vest', geoVest, M.cloth, (S) => (S.outfit.vest ? 1 : 0)],
      ['head', geoHead, M.skin, () => 1],
      ['hair', geoHair, M.cloth, (S) => (S.outfit.flash ? 0 : 1)],
      ['hood', geoHood, M.cloth, (S) => (S.outfit.flash ? 1 : 0)],
      ['m1', geoHelmetM1, M.steel, (S) => (S.outfit.hat === 'm1' || S.outfit.carry === 'helmet' ? 1 : 0)],
      ['mk2', geoHelmetMk2, M.steel, (S) => (S.outfit.hat === 'mk2' ? 1 : 0)],
      ['whitehat', geoWhiteHat, M.cloth, (S) => (S.outfit.hat === 'white' ? 1 : 0)],
      ['upperArm', geoUpperArm, M.cloth, () => 2],
      ['foreArm', geoForeArm, M.cloth, () => 2],
      ['hand', geoHand, M.skin, () => 2],
      ['thigh', geoThigh, M.cloth, () => 2],
      ['shin', geoShin, M.cloth, () => 2],
      ['boot', geoBoot, M.cloth, () => 2],
      ['bundle', geoBundle, M.cloth, (S) => (S.outfit.carry === 'vest' ? 1 : 0)],
    ];
    this.meshes = {};
    this.sphere = new THREE.Sphere(new V3(), 1);
    let tris = 0;
    for (const [name, build, mat, need] of defs) {
      let n = 0;
      for (const S of this.sailors) {
        const c = need(S);
        if (c) {
          S.slots[name] = n;
          n += c;
        }
      }
      if (!n) continue;
      const geo = build();
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.name = `runner-${name}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.boundingSphere = this.sphere;
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, ZERO);
      this.meshes[name] = mesh;
      this.group.add(mesh);
      const t = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      tris += (t * n) / count;
    }
    this.drawCalls = Object.keys(this.meshes).length;
    this.trianglesPerRunner = Math.round(tris);
    // per-instance colors
    for (const S of this.sailors) {
      const C = S.col, sl = S.slots, m = this.meshes;
      const put = (name, color, off = 0) => {
        if (sl[name] != null) m[name].setColorAt(sl[name] + off, color);
      };
      put('pelvis', C.trousers);
      put('torso', C.shirt);
      put('vest', C.vest);
      put('head', C.skin);
      put('hair', C.hair);
      put('hood', C.flash);
      put('m1', C.helmet);
      put('mk2', C.helmet);
      put('whitehat', C.whiteHat);
      put('bundle', C.bundle);
      for (let k = 0; k < 2; k++) {
        put('upperArm', C.upper, k);
        put('foreArm', C.fore, k);
        put('hand', C.hand, k);
        put('thigh', C.trousers, k);
        put('shin', C.trousers, k);
        put('boot', C.boot, k);
      }
      S.hatOffset.compose(new V3(0, 0.222, -0.022), new THREE.Quaternion().setFromEuler(new THREE.Euler(S.st.hatTilt, 0, S.st.hatRoll)), _one);
    }
    for (const mesh of Object.values(this.meshes)) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.m1Worn = new THREE.Matrix4().compose(new V3(0, 0.2, -0.03), new THREE.Quaternion().setFromAxisAngle(_X, 0.1), _one);
    this.mk2Worn = new THREE.Matrix4().compose(new V3(0, 0.213, -0.03), new THREE.Quaternion().setFromAxisAngle(_X, 0.06), _one);
    this.carryM = [0, 1].map((k) => {
      const sg = k ? 1 : -1;
      // helmet held by the back of its rim, dome out, front edge down
      return new THREE.Matrix4().set(0, sg, 0, sg * 0.02, 0, 0, 1, -0.215, sg, 0, 0, 0, 0, 0, 0, 1);
    });
    this.bundleM = new THREE.Matrix4().makeTranslation(0, -0.055, 0.0);
  }

  /** Set runner i's inputs; omitted fields keep their previous values. */
  set(i, o = {}) {
    const S = this.sailors[i];
    if (!S) return;
    if (o.position) S.pos.copy(o.position);
    if (o.heading != null) S.heading = o.heading;
    if (o.state) S.state = o.state;
    if (o.visible != null) S.visible = o.visible;
    S.phaseIn = o.phase ?? null;
    if (o.speed !== undefined) S.speedIn = o.speed;
    if (o.ladderDir) S.ladderDir.copy(o.ladderDir).normalize();
    if (o.ladderBase !== undefined) S.ladderBase = o.ladderBase ? (S.ladderBase || new V3()).copy(o.ladderBase) : null;
    if (o.rise != null) S.rise = o.rise;
    if (o.railHeight != null) S.railHeight = o.railHeight;
    if (o.ladderWidth != null) S.ladderWidth = o.ladderWidth;
    if (o.door !== undefined) S.door = o.door ? (S.door || new V3()).copy(o.door) : null;
    if (o.sill != null) S.sill = o.sill;
    if (o.doorTop != null) S.doorTop = o.doorTop;
    if (o.lookAt !== undefined) S.lookAt = o.lookAt ? (S.lookAt || new V3()).copy(o.lookAt) : null;
    if (o.carry !== undefined && o.carry !== S.carry) {
      const c = o.carry;
      const ok = c === null || (c === 'helmet' && S.slots.m1 != null) || (c === 'vest' && S.slots.bundle != null);
      if (ok) {
        if (c === 'helmet') S.helmetOn = false; // took it off to carry it
        S.carry = c;
        S.donT = -1;
      }
    }
  }

  /** Meters per gait cycle for runner i at `speed` (phase += distance / stride). */
  stride(i, speed) {
    const S = this.sailors[i];
    return S ? Math.max(1e-4, S.gaitAt(speed).D) : gait(speed).stride;
  }

  /** Runner i pulls on the helmet he is carrying. */
  don(i) {
    const S = this.sailors[i];
    if (S && S.carry === 'helmet' && S.donT < 0) S.donT = 0;
  }

  /** Last solved head centre of runner i, in group (ship) space. */
  headPosition(i, out = new V3()) {
    return out.copy(this.sailors[i].headWorld);
  }

  update(dt) {
    dt = clamp(dt || 0, 0, 0.1);
    let n = 0;
    const box = this.sphere.center.set(0, 0, 0);
    for (const S of this.sailors) {
      if (!S.visible || S.state === 'hidden') {
        if (S.cur !== 'hidden') this.hide(S);
        S.cur = 'hidden';
        S.fresh = true;
        continue;
      }
      S.tick(dt);
      S.phaseIn = null; // an explicit phase applies to the update that follows its set()
      this.solve(S);
      box.add(S.pos);
      n++;
    }
    this.group.visible = n > 0;
    if (n) {
      box.divideScalar(n);
      let r = 0;
      for (const S of this.sailors) if (S.cur !== 'hidden') r = Math.max(r, S.pos.distanceTo(box));
      this.sphere.radius = r + 2.5;
    }
    for (const mesh of Object.values(this.meshes)) mesh.instanceMatrix.needsUpdate = true;
  }

  hide(S) {
    for (const [name, slot] of Object.entries(S.slots)) {
      const mesh = this.meshes[name];
      const c = name === 'upperArm' || name === 'foreArm' || name === 'hand' || name === 'thigh' || name === 'shin' || name === 'boot' ? 2 : 1;
      for (let j = 0; j < c; j++) mesh.setMatrixAt(slot + j, ZERO);
    }
  }

  // Skeleton from the pose, then one matrix per part instance.
  solve(S) {
    const P = S.out, s = S.s, W = S.W, m = this.meshes, sl = S.slots;
    _q1.setFromAxisAngle(_Y, S.heading);
    _root.compose(S.pos, _q1, _one);
    const put = (name, local, off = 0) => m[name].setMatrixAt(sl[name] + off, _m2.multiplyMatrices(_root, local));
    const limbW = s * Math.pow(W, 0.7);

    put('pelvis', _m1.compose(P.pelvis, P.pelvisQ, _a.set(s * W, s, s * S.Wd)));
    // legs
    const hip = _f, knee = _g, ank = _h, f1 = _u, f2 = _w;
    for (let k = 0; k < 2; k++) {
      hip.set((k ? 1 : -1) * SK.hipX * s * W, 0, 0).applyQuaternion(P.pelvisQ).add(P.pelvis);
      ik2(hip, P.ankle[k], SK.thigh * s, SK.shin * s, P.knee[k], knee, ank, f1, f2);
      put('thigh', segMatrix(_m1, hip, knee, f1, limbW, s, limbW), k);
      put('shin', segMatrix(_m1, knee, ank, f2, limbW, s, limbW), k);
      put('boot', _m1.compose(ank, P.footQ[k], _a.set(s * lerp(1, W, 0.5), s, s)), k);
    }
    // torso, vest, head and headgear
    _q2.multiplyQuaternions(P.pelvisQ, P.chestQ);
    _t.set(0, SK.lumbar * s, 0).applyQuaternion(P.pelvisQ).add(P.pelvis);
    _m1.compose(_t, _q2, _a.set(s * W, s, s * S.Wd));
    put('torso', _m1);
    if (sl.vest != null) put('vest', _m1);
    _n.set(0, SK.neckY * s, SK.neckZ * s).applyQuaternion(_q2).add(_t);
    const hs = S.headS;
    S.headM.compose(_n, P.headQ, _a.set(hs, hs, hs));
    put('head', S.headM);
    S.headWorld.set(HEAD_C.x, HEAD_C.y, HEAD_C.z).applyMatrix4(S.headM).applyMatrix4(_root);
    if (sl.hair != null) {
      if (S.helmetOn && S.donT < 0) m.hair.setMatrixAt(sl.hair, ZERO);
      else put('hair', S.headM);
    }
    if (sl.hood != null) put('hood', S.headM);
    if (sl.whitehat != null) {
      if (S.hatOn) put('whitehat', _m1.multiplyMatrices(S.headM, S.hatOffset));
      else m.whitehat.setMatrixAt(sl.whitehat, ZERO);
    }
    if (sl.mk2 != null) put('mk2', _m1.multiplyMatrices(S.headM, this.mk2Worn));
    // arms and hands
    for (let k = 0; k < 2; k++) {
      const sh = S.shoulder(P, k, _sh);
      ik2(sh, P.wrist[k], SK.upper * s, SK.fore * s, P.elbow[k], knee, ank, f1, f2);
      put('upperArm', segMatrix(_m1, sh, knee, f1.negate(), limbW, s, limbW), k);
      put('foreArm', segMatrix(_m1, knee, ank, f2.negate(), limbW, s, limbW), k);
      _b.subVectors(ank, knee).normalize(); // forearm direction
      _c.copy(P.fingers[k]);
      if (_c.dot(_b) < 0.2) _c.addScaledVector(_b, 0.2 - _c.dot(_b)).normalize(); // wrist can't fold back
      _d.copy(_c).negate();
      frameMatrix(S.handM[k], ank, _d, P.thumb[k], s, s, s);
      put('hand', S.handM[k], k);
    }
    // helmets: worn, carried, or on their way up during donning
    if (sl.m1 != null) {
      const worn = _m3.multiplyMatrices(S.headM, this.m1Worn);
      if (S.donT >= 0) {
        const carried = _m1.multiplyMatrices(S.handM[S.carrySide], this.carryM[S.carrySide]);
        const t = sstep(0.12, 0.52, S.donT);
        carried.decompose(_a, _q1, _c);
        worn.decompose(_b, _q2, _c);
        _a.lerp(_b, t).addScaledVector(_Y, 0.1 * Math.sin(PI * t));
        _q1.slerp(_q2, sstep(0.05, 0.4, S.donT));
        put('m1', _m1.compose(_a, _q1, _c));
      } else if (S.helmetOn && S.outfit.hat !== 'mk2') put('m1', worn);
      else if (S.carry === 'helmet') put('m1', _m1.multiplyMatrices(S.handM[S.carrySide], this.carryM[S.carrySide]));
      else m.m1.setMatrixAt(sl.m1, ZERO);
    }
    if (sl.bundle != null) {
      if (S.carry === 'vest') put('bundle', _m1.multiplyMatrices(S.handM[S.carrySide], this.bundleM));
      else m.bundle.setMatrixAt(sl.bundle, ZERO);
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const mesh of Object.values(this.meshes)) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const mat of Object.values(this.mats)) mat.dispose();
    this.meshes = {};
  }
}
