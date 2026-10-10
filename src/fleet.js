import * as THREE from 'three';
import { buildShip } from './models/ships.js';
import * as GunModels from './models/guns.js';
import { leadPoint, SHELLS, OWNER } from './ballistics.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rr = (a, b) => a + (b - a) * Math.random();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _u = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

// AI gun crews at real rates of fire. interval: seconds between rounds for the whole mount
// (barrels alternate); mag/reload model the 20mm's 60-round drums.
export const GUNS = {
  // 5"/38: ~18 rounds a minute per gun; the Mk 28 twin trains at 25 and elevates at 15 deg/s
  '5in-twin': { shell: '5in', range: 7000, interval: 1.65, trainRate: 0.436, elevRate: 0.262, err: 0.03, flash: 2.6, smoke: true },
  '5in-single': { shell: '5in', range: 7000, interval: 3.3, trainRate: 0.45, elevRate: 0.4, err: 0.03, flash: 2.3, smoke: true },
  // Bofors: ~120 rounds a minute per barrel; Mk 1 twin and Mk 2 quad power drives train at
  // 26 and elevate at 24 degrees a second
  '40mm-quad': { shell: '40mm', range: 2400, interval: 0.125, trainRate: 0.454, elevRate: 0.419, err: 0.024, flash: 1, smoke: false },
  '40mm-twin': { shell: '40mm', range: 2400, interval: 0.25, trainRate: 0.454, elevRate: 0.419, err: 0.024, flash: 1, smoke: false },
  // Oerlikon: ~450 rounds a minute, 60-round drum, a few seconds to change it
  '20mm': { shell: '20mm', range: 1500, interval: 0.133, trainRate: 1.5, elevRate: 1.3, err: 0.026, flash: 0.55, smoke: false, mag: 60, reload: 5 },
};

// Hit points and damage by weapon per class.
const HP = { bb: 100, cv: 90, cl: 60, dd: 34 };
const DAMAGE = {
  bomb: { bb: 13, cv: 18, cl: 22, dd: 30 },
  torpedo: { bb: 21, cv: 28, cl: 36, dd: 55 },
  kamikaze: { bb: 15, cv: 22, cl: 26, dd: 38 },
  wreck: { bb: 6, cv: 8, cl: 9, dd: 14 },
  // machine-gun hits on steel: casualties more than structural damage
  strafe: { bb: 0.005, cv: 0.01, cl: 0.01, dd: 0.015 },
  nearMiss: { bb: 1.2, cv: 2, cl: 3, dd: 5 },
};
const TURN = { bb: 1.7 * DEG, cv: 1.5 * DEG, cl: 2.4 * DEG, dd: 4 * DEG };
const MAXSPEED = { bb: 14, cv: 16, cl: 16, dd: 18 };

// Task group: [class, name, camo, offset right (m), offset ahead (m), hull number, variant]
// Our ship is USS Alabama (BB-60) as of June 1944: Measure 21. Her sister South Dakota had the
// flagship conning tower and eight 5" mounts; Indiana wore Measure 32 design 11D.
const ORDER = [
  ['bb', 'USS Alabama', 'auto', 0, 0, null, 'alabama'],
  ['cv', 'USS Lexington', 'ms21', 1050, -250],
  ['bb', 'USS South Dakota', 'auto', -950, -150, null, 'southdakota'],
  ['bb', 'USS Indiana', 'ms32', 120, -1350, null, 'alabama'],
  ['cl', 'USS Santa Fe', 'ms32', 700, 1100],
  ['cl', 'USS Mobile', 'ms22', -720, 1000],
  ['dd', 'USS Kidd', 'ms21', 0, 2050, 661],
  ['dd', 'USS Hickox', 'ms22', 1650, 1250, 673],
  ['dd', 'USS Hunt', 'ms21', 2050, -650, 674],
  ['dd', 'USS Lewis Hancock', 'ms32', 0, -2350, 675],
  ['dd', 'USS Marshall', 'ms22', -2050, -650, 676],
  ['dd', 'USS Charrette', 'ms21', -1650, 1250, 581],
];

let mountModels = null;

// A gun mount: pose in ship space, current train/elevation, crew state.
export class Mount {
  constructor(ship, spec) {
    this.ship = ship;
    this.kind = spec.kind;
    this.def = GUNS[spec.kind] || GUNS['40mm-quad'];
    this.pos = spec.pos.clone();
    this.train0 = spec.train0 || 0;
    this.arc = spec.arc || [-Math.PI, Math.PI];
    this.train = this.train0;
    this.elev = 0.05;
    const mm = mountModels[spec.kind];
    this.pivot = mm ? mm.pivot.clone() : new THREE.Vector3(0, 1.2, 0);
    this.muzzles = mm ? mm.muzzles.map((v) => v.clone()) : [new THREE.Vector3(0, 0, -3)];
    this.elevLimits = mm ? mm.elev : [-0.2, 1.5];
    this.baseMatrix = new THREE.Matrix4();
    this.deckMatrix = new THREE.Matrix4();
    this.gunMatrix = new THREE.Matrix4();
    this.target = null;
    this.retarget = Math.random() * 0.6;
    this.cool = Math.random() * this.def.interval;
    this.barrel = 0;
    this.errPhase = Math.random() * 100;
    this.errRate = rr(0.25, 0.6);
    this.aimed = false;
    this.manual = false; // the player is on it
    this.fireRange = this.def.range;
  }

  /** Bring the train angle into the mount's arc; null if it can't get there. */
  fitArc(a) {
    const [lo, hi] = this.arc;
    for (let k = -1; k <= 1; k++) {
      const v = a + k * TAU;
      if (v >= lo && v <= hi) return v;
    }
    return null;
  }

  update(shipMatrix) {
    _m.makeTranslation(this.pos.x, this.pos.y, this.pos.z);
    this.deckMatrix.multiplyMatrices(shipMatrix, _m);
    _m.makeRotationY(this.train).setPosition(this.pos);
    this.baseMatrix.multiplyMatrices(shipMatrix, _m);
    _m.makeRotationX(this.elev).setPosition(this.pivot);
    this.gunMatrix.multiplyMatrices(this.baseMatrix, _m);
  }

  pivotWorld(out) {
    return out.setFromMatrixPosition(this.gunMatrix);
  }

  muzzleWorld(i, out) {
    return out.copy(this.muzzles[i % this.muzzles.length]).applyMatrix4(this.gunMatrix);
  }

  boreWorld(out) {
    return out.set(-this.gunMatrix.elements[8], -this.gunMatrix.elements[9], -this.gunMatrix.elements[10]).normalize();
  }
}

export class Ship {
  constructor(cls, name, camo, slot, hullNumber, seed, variant) {
    this.cls = cls;
    this.name = name;
    this.model = buildShip(cls, { seed, camo, hullNumber, ...(variant ? { variant } : {}) });
    this.group = this.model.group;
    this.group.name = name;
    this.slot = slot; // { right, ahead }
    this.length = this.model.length;
    this.halfLength = this.model.length / 2;
    this.halfBeam = this.model.beam / 2;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.speed = 11;
    this.turnRate = 0;
    this.heave = 0;
    this.heaveV = 0;
    this.pitch = 0;
    this.pitchV = 0;
    this.roll = 0;
    this.rollV = 0;
    this.list = 0;
    this.listTarget = 0;
    this.sink = 0;
    this.hp = HP[cls];
    this.maxHp = HP[cls];
    this.sunk = false;
    this.sinkT = 0;
    this.gone = false;
    this.evade = 0;
    this.evadeHeading = 0;
    this.fires = [];
    this.mounts = this.model.mounts.map((m) => new Mount(this, m));
    this.matrix = this.group.matrixWorld;
    this.inverse = new THREE.Matrix4();
    this.sternPrev = null;
    this.hazeT = Math.random();
    this.deckHeight = this.model.deckAt(0);
    this.invulnerable = false;
    this.radius = this.halfLength + 25;
  }

  worldPoint(local, out) {
    return out.copy(local).applyMatrix4(this.matrix);
  }

  toLocal(world, out) {
    return out.copy(world).applyMatrix4(this.inverse);
  }

  /** A point on the ship to aim at: superstructure for kamikazes, the deck for strafing runs. */
  randomAimPoint(deck = false) {
    const md = this.model;
    if (!deck && md.boxes.length && Math.random() < 0.75) {
      const b = md.boxes[Math.floor(Math.random() * md.boxes.length)];
      return new THREE.Vector3(rr(b.min.x, b.max.x) * 0.6, b.min.y + (b.max.y - b.min.y) * rr(0.3, 0.8), rr(b.min.z, b.max.z));
    }
    const z = rr(-0.8, 0.8) * this.halfLength;
    return new THREE.Vector3(rr(-0.5, 0.5) * md.halfBeamAt(z), md.deckAt(z) + 1, z);
  }

  /** Is the ship-space point inside the hull or a superstructure box? */
  containsLocal(p, margin = 0) {
    const md = this.model;
    if (Math.abs(p.z) < this.halfLength + margin && p.y > -md.draft - margin) {
      const hb = md.halfBeamAt(clamp(p.z, -this.halfLength, this.halfLength));
      if (Math.abs(p.x) < hb + margin && p.y < md.deckAt(clamp(p.z, -this.halfLength, this.halfLength)) + margin) return true;
    }
    for (const b of md.boxes) {
      if (p.x > b.min.x - margin && p.x < b.max.x + margin && p.y > b.min.y - margin && p.y < b.max.y + margin && p.z > b.min.z - margin && p.z < b.max.z + margin) return true;
    }
    return false;
  }

  /** Ray (ship space) against the superstructure boxes: true if blocked before maxT. */
  rayBlocked(origin, dir, maxT, ignoreNear = 4) {
    for (const b of this.model.boxes) {
      let t0 = 0, t1 = maxT;
      let ok = true;
      for (const ax of ['x', 'y', 'z']) {
        const o = origin[ax], d = dir[ax];
        if (Math.abs(d) < 1e-8) {
          if (o < b.min[ax] || o > b.max[ax]) {
            ok = false;
            break;
          }
        } else {
          let ta = (b.min[ax] - o) / d, tb = (b.max[ax] - o) / d;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) {
            ok = false;
            break;
          }
        }
      }
      if (ok && t1 > ignoreNear) return true;
    }
    return false;
  }
}

export class Fleet {
  constructor(scene, { fx, audio, ocean, ballistics }) {
    this.scene = scene;
    this.fx = fx;
    this.audio = audio;
    this.ocean = ocean;
    this.ballistics = ballistics;
    this.difficulty = { gunnery: 1, shipDamage: 1, lethality: 0.1 };
    this.events = { damaged: null, sunk: null };
    this.center = new THREE.Vector3();
    this.guide = { heading: 75 * DEG, base: 75 * DEG, speed: 11, legT: 60, leg: 1 };
    this.hold = false; // freeze shooting (title screen safety)

    mountModels = mountModels || GunModels.buildMountModels();
    this.ships = ORDER.map(([cls, name, camo, right, ahead, hull, variant], i) => {
      const s = new Ship(cls, name, camo, { right, ahead }, hull, 11 + i * 7, variant);
      scene.add(s.group);
      return s;
    });
    this.own = this.ships[0];
    this.carrier = this.ships[1];
    // the other battleships man their stations with AI mounts
    for (const s of this.ships) {
      if (s === this.own) continue;
      for (const st of s.model.stations || []) s.mounts.push(new Mount(s, { ...st, kind: st.kind === '20mm-twin' ? '20mm' : st.kind }));
    }

    // instanced mount visuals, one base and one gun mesh per kind
    const mat = GunModels.createMountMaterial();
    this.mountMeshes = {};
    for (const kind of Object.keys(mountModels)) {
      const list = [];
      for (const s of this.ships) for (const m of s.mounts) if (m.kind === kind) list.push(m);
      if (!list.length) continue;
      const mm = mountModels[kind];
      const base = new THREE.InstancedMesh(mm.base, mat, list.length);
      const gun = new THREE.InstancedMesh(mm.gun, mat, list.length);
      for (const im of [base, gun]) {
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        scene.add(im);
      }
      this.mountMeshes[kind] = { base, gun, list };
    }

    this.place();
  }

  slotWorld(s, out) {
    const h = this.guide.heading;
    const fx = Math.sin(h), fz = -Math.cos(h);
    const rx = Math.cos(h), rz = Math.sin(h);
    return out.set(this.center.x + rx * s.slot.right + fx * s.slot.ahead, 0, this.center.z + rz * s.slot.right + fz * s.slot.ahead);
  }

  /** Put every ship on its station (start of a game). */
  place() {
    for (const s of this.ships) {
      this.slotWorld(s, _v);
      s.position.set(_v.x, 0, _v.z);
      s.heading = this.guide.heading;
      s.speed = this.guide.speed;
      s.sternPrev = null;
      this.pose(s, 0);
    }
  }

  reset() {
    this.guide.legT = 60;
    for (const s of this.ships) {
      s.hp = s.maxHp;
      s.sunk = false;
      s.gone = false;
      s.sinkT = 0;
      s.sink = 0;
      s.list = s.listTarget = 0;
      s.fires.length = 0;
      s.evade = 0;
      s.group.visible = true;
      for (const m of s.mounts) m.target = null;
    }
    this.place();
  }

  shipAt(p, margin = 0) {
    for (const s of this.ships) {
      if (s.gone) continue;
      const dx = p.x - s.position.x, dz = p.z - s.position.z;
      if (dx * dx + dz * dz > s.radius * s.radius) continue;
      s.toLocal(p, _u);
      if (s.containsLocal(_u, margin)) return s;
    }
    return null;
  }

  nearestShip(p) {
    let best = null, bd = Infinity;
    for (const s of this.ships) {
      if (s.gone) continue;
      s.toLocal(p, _u);
      const z = clamp(_u.z, -s.halfLength, s.halfLength);
      const hb = s.model.halfBeamAt(z);
      const dx = Math.max(Math.abs(_u.x) - hb, 0), dz = Math.abs(_u.z - z);
      const d = Math.hypot(dx, dz);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return { ship: best, dist: bd };
  }

  /** Weighted choice of a target ship for an attacker; the player's ship and the carrier draw most. */
  pickTarget(bias = 1) {
    const live = this.ships.filter((s) => !s.sunk);
    if (!live.length) return null;
    const w = live.map((s) => (s === this.own ? 3.2 * bias : s === this.carrier ? 2.4 : s.cls === 'bb' ? 1 : s.cls === 'cl' ? 0.7 : 0.45));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < live.length; i++) {
      r -= w[i];
      if (r <= 0) return live[i];
    }
    return live[0];
  }

  damage(ship, kind, worldPos, scale = 1) {
    if (ship.sunk || ship.invulnerable) return 0;
    const amount = (DAMAGE[kind]?.[ship.cls] ?? 1) * scale * this.difficulty.shipDamage;
    ship.hp -= amount;
    const local = ship.toLocal(worldPos, new THREE.Vector3());
    if (kind === 'bomb' || kind === 'kamikaze' || kind === 'torpedo' || kind === 'wreck') {
      // fires on deck near the hit
      const z = clamp(local.z, -ship.halfLength * 0.9, ship.halfLength * 0.9);
      const fire = new THREE.Vector3(clamp(local.x, -ship.model.halfBeamAt(z) * 0.8, ship.model.halfBeamAt(z) * 0.8), 0, z);
      fire.y = Math.max(local.y, ship.model.deckAt(z)) + 0.5;
      if (kind === 'torpedo') fire.y = ship.model.deckAt(z) + 0.5;
      ship.fires.push({ local: fire, size: kind === 'wreck' ? 0.8 : rr(1.1, 1.8), life: rr(30, 75), t: 0, emit: 0, smoke: 0 });
      if (kind === 'torpedo') ship.listTarget += (local.x > 0 ? 1 : -1) * rr(2, 4) * DEG;
    }
    this.events.damaged?.(ship, kind, worldPos, amount);
    if (ship.hp <= 0) this.sinkShip(ship);
    return amount;
  }

  sinkShip(ship) {
    if (ship.sunk) return;
    ship.sunk = true;
    ship.hp = 0;
    ship.sinkT = 0;
    ship.listTarget = (ship.listTarget >= 0 ? 1 : -1) * rr(14, 26) * DEG;
    for (let i = 0; i < 4; i++) {
      const z = rr(-0.7, 0.7) * ship.halfLength;
      ship.fires.push({ local: new THREE.Vector3(rr(-0.4, 0.4) * ship.halfBeam, ship.model.deckAt(z) + 0.5, z), size: rr(1.5, 2.4), life: 999, t: 0, emit: 0, smoke: 0 });
    }
    this.events.sunk?.(ship);
  }

  // ---------------------------------------------------------------- update
  update(dt, t, ctx) {
    const g = this.guide;
    // zig-zag about the base course
    g.legT -= dt;
    if (g.legT <= 0) {
      g.leg = -g.leg;
      g.legT = rr(80, 140);
      g.target = g.base + g.leg * rr(15, 30) * DEG;
    }
    if (g.target !== undefined) g.heading += clamp(wrapPi(g.target - g.heading), -1.1 * DEG * dt, 1.1 * DEG * dt);
    this.center.x += Math.sin(g.heading) * g.speed * dt;
    this.center.z -= Math.cos(g.heading) * g.speed * dt;

    const torps = ctx.ordnance ? ctx.ordnance.running : [];
    const wakes = [];
    for (const s of this.ships) {
      if (s.gone) continue;
      this.helm(s, dt, torps);
      this.pose(s, dt);
      this.burn(s, dt, ctx.camera);
      // stern wake into the foam map
      const st = s.worldPoint(_v.set(0, 0, s.halfLength * 0.92), _w);
      if (s.sternPrev) {
        const spd = clamp(s.speed / 11, 0, 1.4);
        this.ocean.stamp(s.sternPrev.x, s.sternPrev.z, st.x, st.z, s.halfBeam * 0.95, 0.85 * spd, spd, 0.25);
      } else s.sternPrev = new THREE.Vector3();
      s.sternPrev.copy(st);
      if (s.sinkT < 60) wakes.push({ x: s.position.x, z: s.position.z, heading: s.heading, halfLength: s.halfLength, halfBeam: s.halfBeam, speed: s.speed });
    }
    // nearest ships first for the wake uniforms
    const cp = ctx.camera.position;
    wakes.sort((a, b) => Math.hypot(a.x - cp.x, a.z - cp.z) - Math.hypot(b.x - cp.x, b.z - cp.z));
    this.ocean.setShips(wakes);

    // gun crews; no aircraft draws more than a handful of mounts at once
    for (const p of ctx.air.planes) p.gunners = 0;
    for (const s of this.ships) for (const m of s.mounts) if (m.target && m.target.alive) m.target.gunners++;
    for (const s of this.ships) {
      if (s.gone) continue;
      for (const m of s.mounts) {
        m.update(s.matrix);
        if (!s.sunk && !m.manual) this.aim(m, dt, ctx);
      }
    }
    this.renderMounts();
    this.renderCrew(ctx.camera);
  }

  helm(s, dt, torps) {
    const g = this.guide;
    let desired, spd;
    if (s.sunk) {
      desired = s.heading;
      spd = 0;
    } else {
      this.slotWorld(s, _v);
      const fx = Math.sin(g.heading), fz = -Math.cos(g.heading);
      const ex = _v.x - s.position.x, ez = _v.z - s.position.z;
      const along = ex * fx + ez * fz;
      const cross = ex * Math.cos(g.heading) + ez * Math.sin(g.heading);
      desired = g.heading + clamp(cross * 0.0012, -0.5, 0.5);
      spd = clamp(g.speed + along * 0.01, 4, MAXSPEED[s.cls]);
      // lookouts: comb the tracks of torpedoes running at us
      if (s.evade <= 0) {
        for (const tp of torps) {
          const rx = s.position.x - tp.pos.x, rz = s.position.z - tp.pos.z;
          const dist = Math.hypot(rx, rz);
          if (dist > 1800) continue;
          const along2 = rx * tp.dir.x + rz * tp.dir.z;
          if (along2 < 0) continue;
          const lateral = Math.abs(rx * tp.dir.z - rz * tp.dir.x);
          if (lateral < s.halfLength + 60) {
            const h1 = Math.atan2(tp.dir.x, -tp.dir.z);
            const h2 = h1 + Math.PI;
            s.evadeHeading = Math.abs(wrapPi(h1 - s.heading)) < Math.abs(wrapPi(h2 - s.heading)) ? h1 : h2;
            s.evade = 30;
            break;
          }
        }
      }
      if (s.evade > 0) {
        s.evade -= dt;
        desired = s.evadeHeading;
        spd = MAXSPEED[s.cls];
      }
    }
    const maxTurn = TURN[s.cls] * (s.sunk ? 0.2 : 1);
    const wantRate = clamp(wrapPi(desired - s.heading) * 0.15, -maxTurn, maxTurn);
    s.turnRate += (wantRate - s.turnRate) * (1 - Math.exp(-dt * 0.4)); // rudder and hull lag
    s.heading += s.turnRate * dt;
    s.speed += (spd - s.speed) * (1 - Math.exp(-dt * (s.sunk ? 0.05 : 0.08)));
    s.velocity.set(Math.sin(s.heading) * s.speed, 0, -Math.cos(s.heading) * s.speed);
    s.position.x += s.velocity.x * dt;
    s.position.z += s.velocity.z * dt;
  }

  // pitch, roll and heave from the waves under the hull, through a lightly damped filter
  pose(s, dt) {
    const oc = this.ocean;
    const fx = Math.sin(s.heading), fz = -Math.cos(s.heading);
    const rx = Math.cos(s.heading), rz = Math.sin(s.heading);
    const L = s.halfLength * 0.7, B = s.halfBeam * 0.8;
    const x = s.position.x, z = s.position.z;
    const hb = oc.heightAt(x + fx * L, z + fz * L);
    const hs = oc.heightAt(x - fx * L, z - fz * L);
    const hp = oc.heightAt(x - rx * B, z - rz * B);
    const hst = oc.heightAt(x + rx * B, z + rz * B);
    const heaveT = (hb + hs + hp + hst) * 0.25 * 0.85;
    const pitchT = Math.atan2(hb - hs, 2 * L) * 0.8;
    const rollT = Math.atan2(hst - hp, 2 * B) * 0.9 + Math.sin(performance.now() * 0.00042 + s.slot.right) * 0.012 * (s.cls === 'dd' ? 2.5 : 1);
    if (dt > 0) {
      const spring = (v, vel, target, w, damp) => {
        const a = (target - v) * w * w - vel * 2 * damp * w;
        return vel + a * dt;
      };
      s.heaveV = spring(s.heave, s.heaveV, heaveT, 0.9, 0.5);
      s.heave += s.heaveV * dt;
      s.pitchV = spring(s.pitch, s.pitchV, pitchT, 0.8, 0.45);
      s.pitch += s.pitchV * dt;
      s.rollV = spring(s.roll, s.rollV, rollT, s.cls === 'dd' ? 0.7 : 0.45, 0.12);
      s.roll += s.rollV * dt;
      s.list += (s.listTarget - s.list) * (1 - Math.exp(-dt * (s.sunk ? 0.05 : 0.15)));
      if (s.sunk) {
        s.sinkT += dt;
        s.sink = Math.max(0, s.sinkT - 25) * 0.18 + Math.max(0, s.sinkT - 70) * 0.5;
        if (s.sinkT > 75) s.pitch += dt * 0.004 * Math.sign(s.slot.ahead || 1);
        if (s.sink > s.model.deckAt(0) + 60) {
          s.gone = true;
          s.group.visible = false;
        }
      }
    } else {
      s.heave = heaveT;
      s.pitch = pitchT;
      s.roll = rollT;
    }
    const heel = s.turnRate * s.speed * 0.12; // ships heel outward in a turn
    _e.set(s.pitch, -s.heading, s.roll + s.list + heel);
    s.group.quaternion.setFromEuler(_e);
    s.position.y = s.heave - s.sink;
    s.group.position.copy(s.position);
    s.group.updateMatrixWorld(true);
    s.inverse.copy(s.matrix).invert();
  }

  burn(s, dt, camera) {
    for (let i = s.fires.length - 1; i >= 0; i--) {
      const f = s.fires[i];
      f.t += dt;
      if (f.t > f.life) {
        s.fires.splice(i, 1);
        continue;
      }
      const k = Math.min(1, (f.life - f.t) / 10) * Math.min(1, f.t * 2 + 0.3);
      f.emit -= dt;
      if (f.emit <= 0) {
        f.emit = 0.045;
        s.worldPoint(f.local, _v);
        if (_v.y > -1) this.fx.fire(_v, f.size * k, 1);
      }
    }
    s.hazeT -= dt;
    if (s.hazeT <= 0 && !s.sunk) {
      s.hazeT = 1.4;
      for (const fn of s.model.funnels || []) this.fx.haze(s.worldPoint(fn.pos, _v));
    }
  }

  // ---------------------------------------------------------------- AI gun crews
  aim(m, dt, ctx) {
    const air = ctx.air;
    const def = m.def;
    const s = m.ship;
    m.retarget -= dt;
    const pivot = m.pivotWorld(_v);
    if (m.retarget <= 0) {
      m.retarget = rr(0.4, 0.8);
      let best = null, bestScore = Infinity;
      for (const p of air.planes) {
        if (!p.alive || (p !== m.target && p.gunners >= 10)) continue;
        const d = pivot.distanceTo(p.pos);
        if (d > def.range) continue;
        s.toLocal(p.pos, _w).sub(m.pos);
        const tr = m.fitArc(Math.atan2(-_w.x, -_w.z));
        if (tr === null) continue;
        const el = Math.atan2(_w.y - m.pivot.y, Math.hypot(_w.x, _w.z));
        if (el < m.elevLimits[0] || el > m.elevLimits[1]) continue;
        const threat = p.target === s && (p.phase === 'dive' || p.phase === 'run' || p.phase === 'terminal' || p.phase === 'strafe');
        let score = d * (threat ? 0.45 : 1) * (p === m.target ? 0.75 : 1) * (p.state === 'egress' ? 2.5 : 1);
        if (p.role === 'kamikaze' && p.phase === 'terminal') score *= 0.6;
        if (score < bestScore) {
          bestScore = score;
          best = p;
        }
      }
      if (best && best !== m.target) best.gunners++;
      m.target = best;
    }
    const p = m.target;
    let wantT = m.train0, wantE = 0.05;
    let tof = 0;
    if (p && p.alive) {
      tof = leadPoint(SHELLS[def.shell], pivot, s.velocity, p.pos, p.vel, _w);
      s.toLocal(_w, _u);
      _u.sub(m.pos);
      const tr = m.fitArc(Math.atan2(-_u.x, -_u.z));
      if (tr !== null) {
        wantT = tr;
        wantE = clamp(Math.atan2(_u.y - m.pivot.y, Math.hypot(_u.x, _u.z)), m.elevLimits[0], m.elevLimits[1]);
      } else m.target = null;
    } else m.target = null;
    const dT = wantT - m.train, dE = wantE - m.elev;
    m.train += clamp(dT, -def.trainRate * dt, def.trainRate * dt);
    m.elev += clamp(dE, -def.elevRate * dt, def.elevRate * dt);
    m.cool -= dt;
    if (!m.target || this.hold) return;
    if (Math.abs(dT) > 0.04 || Math.abs(dE) > 0.04 || m.cool > 0) return;
    if (pivot.distanceTo(p.pos) > m.fireRange) return;
    m.cool += def.interval * rr(0.92, 1.08);
    if (m.cool < -def.interval) m.cool = 0;
    if (def.mag) {
      m.rounds = (m.rounds ?? def.mag) - 1;
      if (m.rounds <= 0) {
        m.rounds = def.mag;
        m.cool = def.reload * rr(0.8, 1.3);
      }
    }
    this.shoot(m, tof, ctx);
  }

  shoot(m, tof, ctx) {
    const def = m.def;
    const muzzle = m.muzzleWorld(m.barrel++, _v);
    const dir = m.boreWorld(_w);
    // crew aim error wanders slowly; per-round dispersion on top
    m.errPhase += m.errRate * def.interval;
    const e = def.err * this.difficulty.gunnery;
    const ex = Math.sin(m.errPhase) * e + (Math.random() - 0.5) * e * 0.6;
    const ey = Math.cos(m.errPhase * 1.31) * e + (Math.random() - 0.5) * e * 0.6;
    _u.set(-dir.z, 0, dir.x).normalize();
    dir.addScaledVector(_u, ex);
    dir.y += ey;
    dir.normalize();
    const fuze = def.shell === '5in' ? tof * rr(0.9, 1.12) + rr(-0.2, 0.3) : 0;
    this.ballistics.fire(def.shell, muzzle, dir, m.ship.velocity, OWNER.FLEET, { fuze, dmg: this.difficulty.lethality * (def.shell === '5in' ? 1.8 : 1) });
    const cam = ctx.camera.position;
    const dist = muzzle.distanceTo(cam);
    if (dist < 3500) this.fx.muzzle(muzzle, dir, def.flash * (dist < 600 ? 1 : 1.6), def.smoke || dist < 400);
    this.audio.gun(def.shell, muzzle);
  }

  /** Gun crews: instanced sailors at every mount (call once all mounts exist, stations included). */
  addCrew() {
    if (!GunModels.buildSailor || !GunModels.crewSpots || this.crew) return;
    const mat = GunModels.createCrewMaterial();
    const lists = {};
    for (const s of this.ships) {
      for (const m of s.mounts) {
        const kind = m.kind === '20mm-twin' ? '20mm' : m.kind;
        for (const sp of GunModels.crewSpots(kind) || []) {
          const local = new THREE.Matrix4().makeRotationY(sp.yaw || 0).setPosition(sp.pos);
          (lists[sp.pose] ||= []).push({ m, local, rotates: sp.rotates });
        }
      }
    }
    this.crew = Object.entries(lists).map(([pose, list]) => {
      const mesh = new THREE.InstancedMesh(GunModels.buildSailor(pose), mat, list.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return { mesh, list };
    });
  }

  renderCrew(camera) {
    if (!this.crew) return;
    const zero = _m2.makeScale(0, 0, 0);
    const cp = camera.position;
    for (const { mesh, list } of this.crew) {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const s = c.m.ship;
        const far = (s.position.x - cp.x) ** 2 + (s.position.z - cp.z) ** 2 > 1400 * 1400;
        if (s.gone || s.sinkT > 20 || c.m.manual || far) mesh.setMatrixAt(i, zero);
        else mesh.setMatrixAt(i, _m.multiplyMatrices(c.rotates ? c.m.baseMatrix : c.m.deckMatrix, c.local));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  renderMounts() {
    for (const { base, gun, list } of Object.values(this.mountMeshes)) {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        // gone, or the player is on it and its detailed model stands in its place
        if (m.ship.gone || m.detailed) {
          _m2.makeScale(0, 0, 0);
          base.setMatrixAt(i, _m2);
          gun.setMatrixAt(i, _m2);
          continue;
        }
        base.setMatrixAt(i, m.baseMatrix);
        gun.setMatrixAt(i, m.gunMatrix);
      }
      base.instanceMatrix.needsUpdate = true;
      gun.instanceMatrix.needsUpdate = true;
    }
  }
}

