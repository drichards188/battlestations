import * as THREE from 'three';

const G = 9.81;

// c: quadratic drag (1/m), v0 muzzle velocity, life: tracer burn / self-destruct time
export const SHELLS = {
  '40mm': { id: 0, v0: 881, c: 0.00026, life: 4.4, dmg: 1, tracer: [16, 2.6, 0.7], width: 0.24, tail: 0.035, selfDestruct: true, splash: 0.12 },
  '20mm': { id: 1, v0: 835, c: 0.00055, life: 3.0, dmg: 0.38, tracer: [16, 5.5, 1.3], width: 0.16, tail: 0.03, selfDestruct: false, splash: 0.06 },
  '5in': { id: 2, v0: 790, c: 0.00012, life: 14, dmg: 1.6, tracer: null, width: 0, tail: 0, selfDestruct: true, splash: 0.25, vt: 15 },
  mg: { id: 3, v0: 760, c: 0.0011, life: 2.4, dmg: 1, tracer: [7, 9, 5.5], width: 0.12, tail: 0.03, selfDestruct: false, splash: 0.05 },
};
const BY_ID = Object.values(SHELLS);
export const OWNER = { PLAYER: 0, FLEET: 1, ENEMY: 2 };

/** Time for a shell of `kind` to cover `dist` metres (straight line, quadratic drag, no gravity). */
export function timeOfFlight(kind, dist, v0 = kind.v0) {
  const c = kind.c;
  const x = Math.min(c * dist, 3);
  return (Math.exp(x) - 1) / (c * v0);
}

/**
 * Lead solution against a target moving at constant velocity: returns the point to aim
 * at (gravity drop included) in `out`, and the time of flight.
 */
export function leadPoint(kind, from, carrierVel, tPos, tVel, out, accel = null) {
  let t = timeOfFlight(kind, from.distanceTo(tPos));
  const rel = out;
  for (let i = 0; i < 4; i++) {
    rel.copy(tPos).addScaledVector(tVel, t).addScaledVector(carrierVel, -t);
    if (accel) rel.addScaledVector(accel, 0.5 * t * t);
    t = timeOfFlight(kind, rel.distanceTo(from));
  }
  // gravity drop, a little more than vacuum because the shell slows down
  rel.y += 0.5 * G * t * t * 1.12;
  return t;
}

const _sp = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _st = new THREE.Vector3();
const _sd = new THREE.Vector3();

/**
 * Exact lead for the player's sight: start from leadPoint, fly a shell through the same
 * integrator the game uses, and shift the aim point by the miss until it converges.
 */
export function solveLead(kind, from, carrierVel, tPos, tVel, out, iterations = 4, dt = 1 / 60) {
  let tof = leadPoint(kind, from, carrierVel, tPos, tVel, out);
  for (let it = 0; it < iterations; it++) {
    _sd.subVectors(out, from).normalize();
    _sp.copy(from);
    _sv.copy(_sd).multiplyScalar(kind.v0).add(carrierVel);
    _st.copy(tPos);
    let best = Infinity, bx = 0, by = 0, bz = 0, bt = 0;
    const steps = Math.ceil((tof * 1.6 + 0.5) / dt);
    let rx = _st.x - _sp.x, ry = _st.y - _sp.y, rz = _st.z - _sp.z;
    for (let i = 0; i < steps; i++) {
      const sp = _sv.length();
      const dk = 1 / (1 + kind.c * sp * dt);
      _sv.x *= dk;
      _sv.y = _sv.y * dk - G * dt;
      _sv.z *= dk;
      _sp.addScaledVector(_sv, dt);
      _st.addScaledVector(tVel, dt);
      // closest approach within the step, relative motion treated as linear
      const nx = _st.x - _sp.x, ny = _st.y - _sp.y, nz = _st.z - _sp.z;
      const ex = nx - rx, ey = ny - ry, ez = nz - rz;
      const el = ex * ex + ey * ey + ez * ez;
      let f = el > 1e-9 ? -(rx * ex + ry * ey + rz * ez) / el : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const dx = rx + ex * f, dy = ry + ey * f, dz = rz + ez * f;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        bx = dx; by = dy; bz = dz;
        bt = (i + f) * dt;
      } else if (d2 > best * 4 && i * dt > tof) break;
      rx = nx; ry = ny; rz = nz;
    }
    out.x += bx;
    out.y += by;
    out.z += bz;
    tof = bt;
    if (best < 0.25) break;
  }
  return tof;
}

const MAX = 14000;

export class Ballistics {
  constructor(scene) {
    this.n = 0;
    const F = (n = MAX) => new Float32Array(n);
    this.px = F(); this.py = F(); this.pz = F();
    this.vx = F(); this.vy = F(); this.vz = F();
    this.age = F(); this.life = F(); this.kind = F(); this.owner = F(); this.dmg = F(); this.fuze = F();
    this.stats = { fired: 0, hits: 0 };

    const q = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = q.index;
    g.setAttribute('position', q.attributes.position);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.aA);
    g.setAttribute('iB', this.aB);
    g.setAttribute('iD', this.aD);
    g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uFogDensity: { value: 0.00012 }, uPixel: { value: 0.0016 } },
      vertexShader: /* glsl */ `
        attribute vec4 iA; // head position, width
        attribute vec4 iB; // hdr color, alpha
        attribute vec4 iD; // tail vector
        uniform float uFogDensity;
        uniform float uPixel;
        varying vec4 vCol;
        varying vec2 vQ;
        void main() {
          vec4 p0 = viewMatrix * vec4(iA.xyz, 1.0);
          vec4 p1 = viewMatrix * vec4(iA.xyz - iD.xyz, 1.0);
          // keep both ends in front of the camera
          if (p1.z > -0.2) p1 = mix(p0, p1, (p0.z + 0.2) / max(p0.z - p1.z, 1e-4));
          vec2 axis = p0.xy / -p0.z - p1.xy / -p1.z;
          axis = length(axis) > 1e-7 ? normalize(axis) : vec2(1.0, 0.0);
          vec2 perp = vec2(-axis.y, axis.x);
          vec2 q = position.xy;
          vQ = q * 2.0;
          vec4 p = mix(p1, p0, q.x + 0.5);
          // never thinner than ~1.5 px so distant tracers still read
          float w = max(iA.w, -p.z * uPixel);
          float thin = iA.w / w;
          p.xy += perp * q.y * w + axis * q.x * w;
          gl_Position = projectionMatrix * p;
          vCol = iB * exp(-length(p0.xyz) * uFogDensity);
          vCol.a *= mix(0.35, 1.0, thin) * smoothstep(0.2, 0.6, -p0.z);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec4 vCol;
        varying vec2 vQ;
        void main() {
          float r = abs(vQ.y);
          float core = exp(-r * r * 9.0);
          float a = (core + exp(-r * 2.5) * 0.25) * smoothstep(1.0, 0.7, abs(vQ.x));
          gl_FragColor = vec4(vCol.rgb * a * vCol.a, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    scene.add(this.mesh);
    this._p = new THREE.Vector3();
    this._a = new THREE.Vector3();
  }

  /** Fire a shell. dir must be normalised; inherit = velocity of the gun platform. */
  fire(kindName, pos, dir, inherit, owner, { dmg = 1, fuze = 0, v0 } = {}) {
    if (this.n >= MAX) return false;
    const k = SHELLS[kindName];
    const i = this.n++;
    const v = v0 || k.v0;
    this.px[i] = pos.x; this.py[i] = pos.y; this.pz[i] = pos.z;
    this.vx[i] = dir.x * v + (inherit ? inherit.x : 0);
    this.vy[i] = dir.y * v + (inherit ? inherit.y : 0);
    this.vz[i] = dir.z * v + (inherit ? inherit.z : 0);
    this.age[i] = 0;
    this.life[i] = fuze > 0 ? Math.min(fuze, k.life) : k.life * (0.92 + Math.random() * 0.16);
    this.kind[i] = k.id;
    this.owner[i] = owner;
    this.dmg[i] = dmg * k.dmg;
    if (owner === OWNER.PLAYER) this.stats.fired++;
    return true;
  }

  kill(i) {
    const j = --this.n;
    if (i === j) return;
    this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.kind[i] = this.kind[j];
    this.owner[i] = this.owner[j]; this.dmg[i] = this.dmg[j];
  }

  /**
   * ctx: {
   *   planes: [{ pos, radius, alive }],
   *   hitPlane(plane, point, kindName, owner, dmg),
   *   proximity(point, owner) -> 5in burst (flak), damage handled by the callee,
   *   water(point, kindName, owner), expire(point, kindName),
   *   shipAt(point) -> ship or null, hitShip(ship, point, kindName)
   * }
   */
  update(dt, camera, ctx) {
    const planes = ctx.planes;
    const p = this._p;
    for (let i = this.n - 1; i >= 0; i--) {
      const k = BY_ID[this.kind[i]];
      const owner = this.owner[i];
      const ox = this.px[i], oy = this.py[i], oz = this.pz[i];
      let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const dk = 1 / (1 + k.c * sp * dt);
      vx *= dk;
      vy = vy * dk - G * dt;
      vz *= dk;
      const nx = ox + vx * dt, ny = oy + vy * dt, nz = oz + vz * dt;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.px[i] = nx; this.py[i] = ny; this.pz[i] = nz;
      this.age[i] += dt;

      let dead = false;
      if (owner !== OWNER.ENEMY) {
        // segment vs bounding spheres; 5in VT fuzes trigger inside their proximity radius
        const sx = nx - ox, sy = ny - oy, sz = nz - oz;
        const sl2 = sx * sx + sy * sy + sz * sz;
        const sl = Math.sqrt(sl2);
        for (let j = 0; j < planes.length; j++) {
          const pl = planes[j];
          if (!pl.alive) continue;
          const cx = pl.pos.x - ox, cy = pl.pos.y - oy, cz = pl.pos.z - oz;
          const reach = (k.vt || pl.radius) + sl;
          if (cx > reach || cx < -reach || cy > reach || cy < -reach || cz > reach || cz < -reach) continue;
          let t = (cx * sx + cy * sy + cz * sz) / sl2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = cx - sx * t, dy = cy - sy * t, dz = cz - sz * t;
          const d2 = dx * dx + dy * dy + dz * dz;
          const r = k.vt ? k.vt : pl.radius;
          if (d2 < r * r) {
            p.set(ox + sx * t, oy + sy * t, oz + sz * t);
            if (k.vt) ctx.proximity(p, owner, this.dmg[i] / k.dmg);
            else {
              ctx.hitPlane(pl, p, k === SHELLS['40mm'] ? '40mm' : k === SHELLS['20mm'] ? '20mm' : 'mg', owner, this.dmg[i]);
              if (owner === OWNER.PLAYER) this.stats.hits++;
            }
            dead = true;
            break;
          }
        }
      } else if (ny < 45 && ctx.shipAt) {
        p.set(nx, ny, nz);
        const ship = ctx.shipAt(p);
        if (ship) {
          ctx.hitShip(ship, p, 'mg');
          dead = true;
        }
      }
      if (!dead && ny < 0) {
        const t = oy / Math.max(oy - ny, 1e-4);
        p.set(ox + (nx - ox) * t, 0, oz + (nz - oz) * t);
        ctx.water(p, k === SHELLS['5in'] ? '5in' : k === SHELLS['40mm'] ? '40mm' : k === SHELLS['20mm'] ? '20mm' : 'mg', owner);
        dead = true;
      }
      if (!dead && this.age[i] >= this.life[i]) {
        p.set(nx, ny, nz);
        if (k.selfDestruct) ctx.expire(p, k === SHELLS['5in'] ? '5in' : '40mm', owner, this.dmg[i] / k.dmg);
        dead = true;
      }
      if (dead) this.kill(i);
    }
    this.render(camera);
  }

  render() {
    const A = this.aA.array, B = this.aB.array, D = this.aD.array;
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      const k = BY_ID[this.kind[i]];
      if (!k.tracer) continue;
      const o = m * 4;
      A[o] = this.px[i];
      A[o + 1] = this.py[i];
      A[o + 2] = this.pz[i];
      A[o + 3] = k.width;
      const fade = 1 - Math.pow(Math.min(this.age[i] / this.life[i], 1), 6);
      B[o] = k.tracer[0];
      B[o + 1] = k.tracer[1];
      B[o + 2] = k.tracer[2];
      B[o + 3] = fade;
      const tail = Math.min(k.tail, this.age[i]);
      D[o] = this.vx[i] * tail;
      D[o + 1] = this.vy[i] * tail;
      D[o + 2] = this.vz[i] * tail;
      m++;
    }
    for (const a of [this.aA, this.aB, this.aD]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, m * 4);
      a.needsUpdate = true;
    }
    this.mesh.geometry.instanceCount = m;
  }

  clear() {
    this.n = 0;
    this.mesh.geometry.instanceCount = 0;
  }
}
