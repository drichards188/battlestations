import * as THREE from 'three';
import { buildAircraft, createAircraftMaterial, createAircraftDepthMaterial, createPropDiscMaterial } from './models/aircraft.js';
import { OWNER } from './ballistics.js';

// Gameplay stats. turn: max turn rate (rad/s); speeds m/s.
export const PLANES = {
  zero: { label: 'ZERO', name: 'A6M5 Zero', role: 'fighter', cruise: 125, fast: 190, turn: 0.5, hp: 2, score: 100 },
  val: { label: 'VAL', name: 'D3A2 Val', role: 'dive', cruise: 105, fast: 130, turn: 0.38, hp: 3, score: 150 },
  kate: { label: 'KATE', name: 'B5N2 Kate', role: 'torpedo', cruise: 100, fast: 125, turn: 0.32, hp: 3, score: 150 },
  betty: { label: 'BETTY', name: 'G4M2 Betty', role: 'torpedo', cruise: 108, fast: 135, turn: 0.2, hp: 7, score: 300 },
};

const MAX_PER_TYPE = 48;
const MAX_EXHAUST = 512;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _aim = new THREE.Vector3();
const rr = (a, b) => a + (b - a) * Math.random();
const clamp = THREE.MathUtils.clamp;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

let nextId = 1;

// Formation slots (right, up, back) in metres: shotai of three in a V, three shotai per chutai.
const SLOTS = [
  [0, 0, 0], [-28, -3, 32], [28, -3, 32],
  [-95, -10, 90], [-123, -13, 122], [-67, -13, 122],
  [95, -10, 90], [67, -13, 122], [123, -13, 122],
  [0, -20, 190], [-28, -23, 222], [28, -23, 222],
];

export class Air {
  constructor(scene, { fx, audio, ordnance }) {
    this.scene = scene;
    this.fx = fx;
    this.audio = audio;
    this.ordnance = ordnance;
    this.planes = [];
    this.groups = [];
    this.models = {};
    this.meshes = {};
    this.difficulty = { accuracy: 1, hp: 1 };
    this.events = { kill: null, escape: null, crash: null, release: null, flare: null };
    this.stats = { killsPlayer: 0, killsFleet: 0 };

    // Exhaust flames: in the dark a radial's short stacks show a flicker of flame (aircraft on
    // an attack ran without navigation lights). Drawn only at night; never smaller than a couple
    // of pixels, so a gunner can pick up an aircraft by its exhaust.
    const eq = new THREE.PlaneGeometry(1, 1);
    const eg = new THREE.InstancedBufferGeometry();
    eg.index = eq.index;
    eg.setAttribute('position', eq.attributes.position);
    this.exA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_EXHAUST * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.exB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_EXHAUST * 4), 4).setUsage(THREE.DynamicDrawUsage);
    eg.setAttribute('iA', this.exA);
    eg.setAttribute('iB', this.exB);
    eg.instanceCount = 0;
    this.exhaustMat = new THREE.ShaderMaterial({
      uniforms: { uNight: { value: 0 }, uPixel: { value: 0.0016 } },
      vertexShader: /* glsl */ `
        attribute vec4 iA; // stack position, flicker
        attribute vec4 iB; // aircraft forward, flame size
        uniform float uNight;
        uniform float uPixel;
        varying vec3 vCol;
        varying vec2 vQ;
        void main() {
          vQ = position.xy * 2.0;
          vec3 toCam = cameraPosition - iA.xyz;
          float dist = length(toCam);
          // the stacks sit on the cowling's sides and blow aft: from dead ahead they are hidden
          float ahead = dot(toCam / max(dist, 1e-3), iB.xyz);
          float vis = 1.0 - 0.8 * smoothstep(0.35, 0.95, ahead);
          float s = max(iB.w, dist * uPixel * 2.2);
          float energy = max(iB.w * iB.w / (s * s), 0.2);
          vec4 mv = viewMatrix * vec4(iA.xyz, 1.0);
          mv.xy += position.xy * s;
          gl_Position = projectionMatrix * mv;
          vCol = vec3(1.0, 0.5, 0.2) * 3.0 * iA.w * vis * uNight * energy * exp(-dist * 0.0002);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying vec2 vQ;
        void main() {
          float r = length(vQ);
          float a = exp(-r * r * 5.0) * (1.0 - smoothstep(0.7, 1.0, r));
          gl_FragColor = vec4(vCol * a * mix(vec3(1.0), vec3(0.8, 0.95, 1.6), exp(-r * r * 30.0)), 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.exhaust = new THREE.Mesh(eg, this.exhaustMat);
    this.exhaust.frustumCulled = false;
    this.exhaust.renderOrder = 6;
    this.exhaust.visible = false;
    scene.add(this.exhaust);
    this.night = 0;

    const discMat = createPropDiscMaterial();
    for (const type of Object.keys(PLANES)) {
      const model = buildAircraft(type);
      this.models[type] = model;
      const mesh = new THREE.InstancedMesh(model.geometry, createAircraftMaterial(type), MAX_PER_TYPE);
      const state = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 4), 4).setUsage(THREE.DynamicDrawUsage);
      mesh.geometry = model.geometry.clone();
      mesh.geometry.setAttribute('aState', state);
      mesh.customDepthMaterial = createAircraftDepthMaterial(type);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      let disc = null;
      if (model.propDisc) {
        disc = new THREE.InstancedMesh(model.propDisc, discMat, MAX_PER_TYPE);
        disc.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        disc.count = 0;
        disc.frustumCulled = false;
        disc.renderOrder = 4;
        scene.add(disc);
      }
      this.meshes[type] = { mesh, state, disc };
    }
  }

  /** Planes that can be shot at. */
  get targets() {
    return this.planes;
  }

  get aliveCount() {
    let n = 0;
    for (const p of this.planes) if (p.alive) n++;
    return n;
  }

  clear() {
    this.planes.length = 0;
    this.groups.length = 0;
  }

  /** Night factor 0..1 (exhaust flames show), and the size of a pixel in radians at unit distance. */
  setNight(k, pixel) {
    this.night = k;
    this.exhaustMat.uniforms.uNight.value = k;
    this.exhaustMat.uniforms.uPixel.value = pixel;
  }

  /**
   * Spawn a raid group.
   * opts: { type, count, role ('dive'|'torpedo'|'strafe'|'kamikaze'|'flare'), bearing (deg, compass from
   *         the fleet centre), distance, altitude, center: Vector3, pickTarget: () => ship,
   *         drop ('para' parachute flares | 'float' float lights, for 'flare'), attackBearing (the
   *         raid's main axis, for laying the flares) }
   */
  spawnGroup({ type, count, role, bearing, distance = 7500, altitude = 1500, center, pickTarget, delay = 0, drop = 'para', attackBearing = bearing }) {
    const def = PLANES[type];
    const b = THREE.MathUtils.degToRad(bearing);
    const origin = new THREE.Vector3(center.x + Math.sin(b) * distance, altitude, center.z - Math.cos(b) * distance);
    const fwd = new THREE.Vector3(center.x - origin.x, 0, center.z - origin.z).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const group = { id: nextId++, type, role, planes: [], center: center.clone(), broken: false, bearing, delay, drop, attackBearing };
    for (let i = 0; i < count; i++) {
      const sl = SLOTS[i % SLOTS.length];
      const extra = Math.floor(i / SLOTS.length) * 260;
      const pos = origin.clone().addScaledVector(right, sl[0]).addScaledVector(fwd, -sl[2] - extra);
      pos.y += sl[1];
      const p = {
        id: nextId++,
        type,
        def,
        model: this.models[type],
        group,
        slot: new THREE.Vector3(sl[0], sl[1], sl[2] + extra),
        leader: null,
        role,
        pos,
        fwd: fwd.clone(),
        vel: fwd.clone().multiplyScalar(def.cruise),
        speed: def.cruise,
        bank: 0,
        roll: 0,
        right0: right.clone(),
        quat: new THREE.Quaternion(),
        hp: def.hp * this.difficulty.hp,
        maxHp: def.hp * this.difficulty.hp,
        radius: this.models[type].radius * 0.75 + 1.5,
        alive: true,
        dying: false,
        state: 'form',
        t: 0,
        target: null,
        aim: new THREE.Vector3(),
        ordnance: role === 'dive' || role === 'torpedo' || role === 'kamikaze',
        playerDmg: 0,
        fleetDmg: 0,
        lastOwner: -1,
        flash: 0,
        propPhase: Math.random() * 6.28,
        smokeT: 0,
        gunT: 0,
        passes: 0,
        jink: Math.random() * 10,
        burn: 0,
        pickTarget,
      };
      p.altitude = altitude;
      group.planes.push(p);
      this.planes.push(p);
    }
    group.leader = group.planes[0];
    for (const p of group.planes) p.leader = group.leader;
    this.groups.push(group);
    return group;
  }

  // ---------------------------------------------------------------- damage
  hit(p, point, kind, owner, dmg) {
    if (!p.alive) return;
    p.hp -= dmg;
    p.flash = 1;
    p.lastOwner = owner;
    if (owner === OWNER.PLAYER) p.playerDmg += dmg;
    else p.fleetDmg += dmg;
    this.fx.sparks(point, kind === '40mm' ? 10 : 5, 30);
    if (kind === '40mm') this.fx.addGlow(1, point.x, point.y, point.z, 0, 0, 0, 0.08, 2.5, 4, 40, 24, 10, 1);
    if (Math.random() < 0.4) this.fx.debrisBurst(point, 1, 15, 0.25);
    this.audio.hit(point, 'plane');
    if (p.hp <= 0) this.kill(p, owner);
  }

  /** 5in VT burst at `point`: fragments damage everything nearby. */
  proximity(point, owner, scale = 1) {
    this.fx.flak(point);
    this.audio.flak(point);
    for (const p of this.planes) {
      if (!p.alive) continue;
      const d = p.pos.distanceTo(point);
      if (d < 26) {
        const k = 1 - d / 26;
        const dmg = 1.3 * k * k * scale;
        if (dmg > 0.05) this.hit(p, _v.copy(p.pos).lerp(point, 0.3), 'flak', owner, dmg);
      }
    }
  }

  kill(p, owner) {
    p.alive = false;
    p.dying = true;
    p.state = 'dying';
    p.t = 0;
    const byPlayer = p.playerDmg > 0 && (owner === OWNER.PLAYER || p.playerDmg >= p.maxHp * 0.4);
    const assist = !byPlayer && p.playerDmg > 0;
    if (byPlayer) this.stats.killsPlayer++;
    else this.stats.killsFleet++;
    this.events.kill?.(p, { byPlayer, assist });
    // some blow apart in the air, the rest go down burning
    const blowUp = Math.random() < (p.ordnance && p.role !== 'torpedo' ? 0.5 : 0.3);
    if (blowUp) {
      this.fx.explosion(p.pos, p.type === 'betty' ? 0.75 : 0.45, { debris: true });
      this.audio.explosion(p.pos, 0.3);
      p.dying = false;
      p.gone = true;
      // the wreck still falls as debris
      this.fx.debrisBurst(p.pos, 10, 30, 0.8);
    } else {
      p.spin = rr(1.2, 3) * (Math.random() < 0.5 ? -1 : 1);
      p.burn = 1;
      this.fx.explosion(p.pos, 0.2, { debris: true, fireball: true });
    }
  }

  // ---------------------------------------------------------------- flight
  steer(p, dir, dt, turn, speedTarget) {
    const f = p.fwd;
    const prevH = Math.atan2(f.x, -f.z);
    const dot = clamp(f.dot(dir), -1, 1);
    const ang = Math.acos(dot);
    if (ang > 1e-5) {
      const step = Math.min(ang, turn * dt);
      _w.crossVectors(f, dir);
      if (_w.lengthSq() < 1e-10) _w.copy(p.right0);
      _w.normalize();
      f.applyAxisAngle(_w, step).normalize();
    }
    const yaw = wrapPi(Math.atan2(f.x, -f.z) - prevH) / Math.max(dt, 1e-4);
    const horiz = Math.sqrt(Math.max(0, 1 - f.y * f.y));
    const bankT = clamp(Math.atan((p.speed * yaw) / 9.81), -1.35, 1.35) * horiz;
    p.bank += (bankT - p.bank) * (1 - Math.exp(-dt * 3.5));
    // gravity helps in a dive, hurts in a climb
    p.speed += (speedTarget - p.speed) * (1 - Math.exp(-dt * 0.7)) - f.y * 6 * dt;
    p.vel.copy(f).multiplyScalar(p.speed);
    p.pos.addScaledVector(p.vel, dt);
  }

  orient(p) {
    const f = p.fwd;
    _x.crossVectors(f, UP);
    if (_x.lengthSq() > 0.003) p.right0.copy(_x.normalize());
    _y.crossVectors(p.right0, f).normalize();
    const b = p.bank + p.roll;
    const c = Math.cos(b), s = Math.sin(b);
    const up = _w.copy(_y).multiplyScalar(c).addScaledVector(p.right0, s);
    const right = _x.crossVectors(f, up).normalize();
    _z.copy(f).negate();
    _m.makeBasis(right, up, _z);
    p.quat.setFromRotationMatrix(_m);
  }

  /** desired direction toward `target` with altitude hold limits */
  toward(p, target, out = _d) {
    return out.subVectors(target, p.pos).normalize();
  }

  levelToward(p, x, z, alt, out = _d) {
    out.set(x - p.pos.x, 0, z - p.pos.z);
    const h = out.length() || 1;
    out.y = clamp((alt - p.pos.y) / Math.max(h * 0.25, 120), -0.45, 0.35) * h;
    return out.normalize();
  }

  pickTarget(p) {
    const s = p.pickTarget?.();
    if (s) p.target = s;
    return p.target;
  }

  update(dt, t, { fleet, ballistics, camera }) {
    const center = fleet.center;
    for (const g of this.groups) {
      if (g.delay > 0) g.delay -= dt;
      if (!g.leader.alive || g.leader.state !== 'form') {
        g.leader = g.planes.find((p) => p.alive && p.state === 'form') || g.leader;
      }
    }
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const p = this.planes[i];
      if (p.gone) {
        this.planes.splice(i, 1);
        continue;
      }
      p.t += dt;
      p.flash = Math.max(0, p.flash - dt * 6);
      if (p.alive) this.think(p, dt, t, fleet, ballistics, camera, center);
      else this.fall(p, dt, fleet);
      this.orient(p);
      this.effects(p, dt);
      if (p.alive && Math.hypot(p.pos.x - center.x, p.pos.z - center.z) > 11000 && p.state === 'egress') {
        p.gone = true;
        this.events.escape?.(p);
      }
    }
    this.groups = this.groups.filter((g) => g.planes.some((p) => !p.gone));
    this.render();
  }

  think(p, dt, t, fleet, ballistics, camera, center) {
    const def = p.def;
    const g = p.group;
    if (p.state === 'form') {
      const L = g.leader;
      const dist = Math.hypot(p.pos.x - center.x, p.pos.z - center.z);
      const breakAt = p.role === 'torpedo' ? 6200 : p.role === 'kamikaze' ? 4800 : p.role === 'dive' ? 3600 : p.role === 'flare' ? 6800 : 4200;
      if (g.broken || dist < breakAt) {
        g.broken = true;
        p.state = 'attack';
        p.t = -Math.random() * 3; // stagger
        this.startAttack(p, fleet);
        return;
      }
      if (L === p || !L.alive || L.state !== 'form') {
        // the leader flies toward the fleet, descending for the torpedo run
        const alt = p.role === 'torpedo' ? Math.max(p.altitude * 0.6, 300) : p.altitude;
        this.steer(p, this.levelToward(p, center.x, center.z, alt), dt, def.turn * 0.5, def.cruise);
      } else {
        // hold the formation slot
        _x.crossVectors(L.fwd, UP).normalize();
        _v.copy(L.pos).addScaledVector(_x, p.slot.x).addScaledVector(L.fwd, -p.slot.z);
        _v.y += p.slot.y;
        _w.copy(_v).addScaledVector(L.fwd, 80);
        const along = _d.subVectors(_v, p.pos).dot(L.fwd);
        this.steer(p, this.toward(p, _w), dt, def.turn, L.speed + clamp(along * 0.4, -15, 25));
      }
      return;
    }
    if (p.t < 0) {
      this.steer(p, p.fwd, dt, def.turn, def.cruise);
      return;
    }
    switch (p.role) {
      case 'dive':
        return this.diveBomber(p, dt, fleet);
      case 'torpedo':
        return this.torpedoBomber(p, dt, fleet);
      case 'kamikaze':
        return this.kamikaze(p, dt, fleet);
      case 'flare':
        return this.flarePlane(p, dt, fleet);
      default:
        return this.fighter(p, dt, t, fleet, ballistics);
    }
  }

  startAttack(p, fleet) {
    this.pickTarget(p);
    p.phase = 'approach';
    if (p.role === 'torpedo') p.side = Math.random() < 0.5 ? -1 : 1;
    if (p.role === 'kamikaze') p.low = Math.random() < 0.35;
  }

  egress(p, dt, fleet) {
    const c = fleet.center;
    _v.set(p.pos.x - c.x, 0, p.pos.z - c.z).normalize();
    if (!p.egressDir) p.egressDir = _v.clone();
    const alt = p.t < 6 ? Math.max(p.pos.y, 80) : 900;
    this.steer(p, this.levelToward(p, p.pos.x + p.egressDir.x * 3000, p.pos.z + p.egressDir.z * 3000, alt), dt, p.def.turn * 0.8, p.def.cruise * 1.05);
  }

  // Dive bomber: climb to a roll-in point upwind of the target, push over to ~65 degrees,
  // release around 450 m and pull out low over the water.
  diveBomber(p, dt, fleet) {
    const def = p.def;
    const s = p.target;
    if (!s || s.sunk) {
      if (!this.pickTarget(p) || p.target.sunk) return this.egress(p, dt, fleet);
    }
    const tp = p.target.position;
    if (p.phase === 'approach') {
      if (!p.rollIn) {
        // dive along the target's length, from astern or ahead
        const hd = p.target.heading + (Math.random() < 0.5 ? Math.PI : 0) + rr(-0.5, 0.5);
        p.rollIn = new THREE.Vector2(Math.sin(hd), -Math.cos(hd));
        p.rollAlt = p.altitude + rr(-150, 150);
      }
      const rx = tp.x + p.rollIn.x * 900, rz = tp.z + p.rollIn.y * 900;
      this.steer(p, this.levelToward(p, rx, rz, p.rollAlt), dt, def.turn * 0.7, def.cruise);
      const hd = Math.hypot(p.pos.x - tp.x, p.pos.z - tp.z);
      if (hd < 1050) {
        p.phase = 'dive';
        p.release = 380 + Math.random() * 180;
        p.miss = new THREE.Vector2(rr(-1, 1), rr(-1, 1)).multiplyScalar(15 / this.difficulty.accuracy);
      }
    } else if (p.phase === 'dive') {
      const tFall = (p.pos.y - p.release) / Math.max(p.speed * 0.85, 60) + 3.4;
      _v.copy(tp).addScaledVector(p.target.velocity, tFall);
      _v.x += p.miss.x * (1 + p.burn);
      _v.z += p.miss.y * (1 + p.burn);
      _v.y = p.target.deckHeight;
      this.steer(p, this.toward(p, _v), dt, def.turn * 1.4, def.fast);
      if (p.pos.y < p.release) {
        if (p.ordnance) {
          p.ordnance = false;
          this.ordnance.dropBomb(this.hardpoint(p), p.vel, p);
          this.events.release?.(p);
        }
        p.phase = 'pullout';
        p.t = 0;
      }
    } else if (p.phase === 'pullout') {
      _v.copy(p.fwd);
      _v.y = 0.25;
      this.steer(p, _v.normalize(), dt, def.turn * 1.5, def.fast);
      if (p.fwd.y > 0.05) {
        p.phase = 'egress';
        p.state = 'egress';
        p.t = 0;
      }
    } else this.egress(p, dt, fleet);
  }

  // Torpedo bomber: get down to 40 m out on the target's beam, run in, drop at ~1 km aimed at
  // the intercept point, then either break away or roar across the formation.
  torpedoBomber(p, dt, fleet) {
    const def = p.def;
    if (!p.target || p.target.sunk) {
      if (!this.pickTarget(p) || p.target.sunk) return this.egress(p, dt, fleet);
    }
    const s = p.target;
    const tp = s.position;
    const fx = Math.sin(s.heading), fz = -Math.cos(s.heading);
    if (p.phase === 'approach') {
      // which beam are we on?
      const side = Math.sign((p.pos.x - tp.x) * fz * -1 + (p.pos.z - tp.z) * fx) || p.side;
      p.side = side;
      const sx = tp.x - fz * side * 2600 + fx * 900;
      const sz = tp.z + fx * side * 2600 + fz * 900;
      this.steer(p, this.levelToward(p, sx, sz, 45), dt, def.turn * 0.8, def.cruise * 1.05);
      if (Math.hypot(p.pos.x - sx, p.pos.z - sz) < 700 || Math.hypot(p.pos.x - tp.x, p.pos.z - tp.z) < 2700) {
        p.phase = 'run';
        p.dropAt = 850 + Math.random() * 450;
      }
    } else if (p.phase === 'run') {
      const range = Math.hypot(p.pos.x - tp.x, p.pos.z - tp.z);
      // aim the airplane at where the torpedo will meet the ship
      const tTorp = Math.max(range - 250, 200) / 21 + 2.5;
      const ix = tp.x + s.velocity.x * tTorp, iz = tp.z + s.velocity.z * tTorp;
      this.steer(p, this.levelToward(p, ix, iz, 38), dt, def.turn * 0.9, def.cruise * 1.1);
      if (range < p.dropAt) {
        if (p.ordnance) {
          p.ordnance = false;
          const err = rr(-1, 1) * 0.06 / this.difficulty.accuracy;
          const dir = new THREE.Vector3(ix - p.pos.x, 0, iz - p.pos.z).normalize().applyAxisAngle(UP, err);
          this.ordnance.dropTorpedo(this.hardpoint(p), p.vel, dir, p);
          this.events.release?.(p);
        }
        p.phase = Math.random() < (p.type === 'betty' ? 0.25 : 0.55) ? 'overfly' : 'break';
        p.t = 0;
        p.breakSide = Math.random() < 0.5 ? -1 : 1;
      }
    } else if (p.phase === 'overfly') {
      // straight across the ship at mast height
      _v.copy(p.fwd);
      _v.y = clamp((60 - p.pos.y) * 0.01, -0.1, 0.15);
      this.steer(p, _v.normalize(), dt, def.turn * 0.4, def.fast);
      if (p.t > 22) {
        p.phase = 'egress';
        p.state = 'egress';
        p.t = 0;
      }
    } else if (p.phase === 'break') {
      _v.copy(p.fwd).applyAxisAngle(UP, p.breakSide * 1.6);
      _v.y = 0.12;
      this.steer(p, _v.normalize(), dt, def.turn, def.fast);
      if (p.t > 6) {
        p.phase = 'egress';
        p.state = 'egress';
        p.t = 0;
      }
    } else this.egress(p, dt, fleet);
  }

  // Kamikaze: high dive or a wave-top run, then straight at the ship, weaving.
  kamikaze(p, dt, fleet) {
    const def = p.def;
    if (!p.target || p.target.sunk) {
      if (!this.pickTarget(p) || p.target.sunk) return this.egress(p, dt, fleet);
    }
    const s = p.target;
    if (!p.aimLocal) p.aimLocal = s.randomAimPoint();
    const tp = s.worldPoint(p.aimLocal, _v);
    const range = p.pos.distanceTo(tp);
    if (p.phase === 'approach') {
      if (p.low) this.steer(p, this.levelToward(p, tp.x, tp.z, 30), dt, def.turn * 0.8, def.fast * 0.85);
      else this.steer(p, this.levelToward(p, tp.x, tp.z, p.altitude), dt, def.turn * 0.7, def.cruise);
      const hd = Math.hypot(p.pos.x - tp.x, p.pos.z - tp.z);
      if (hd < (p.low ? 2200 : 2600)) p.phase = 'terminal';
    } else {
      const tti = range / Math.max(p.speed, 50);
      _w.copy(tp).addScaledVector(s.velocity, tti);
      // weave to throw the gunners off, steadying close in
      const weave = Math.min(45, range * 0.03);
      _x.crossVectors(p.fwd, UP).normalize();
      _w.addScaledVector(_x, Math.sin(p.t * 1.6 + p.jink) * weave);
      _w.y += Math.cos(p.t * 1.1 + p.jink) * weave * 0.4;
      if (p.low && range > 900) _w.y = 25;
      this.steer(p, this.toward(p, _w), dt, def.turn * 1.25, def.fast);
    }
    this.checkShipCrash(p, fleet);
  }

  // Flare plane: at night a snooper lays float lights along the force's wake to mark its track,
  // and flare planes hang a line of parachute flares across the far side of the force from the
  // torpedo planes, so the ships stand out against the light. Then they turn away.
  flarePlane(p, dt, fleet) {
    const def = p.def;
    const g = p.group;
    if (!p.line) {
      const c = fleet.center;
      const float = g.drop === 'float';
      const n = float ? 5 : 4;
      const spacing = float ? 550 : 600; // float flares "at intervals of about 600 yards"
      // each aircraft of the group lays its own line, a few hundred metres from the next
      const k = g.planes.indexOf(p) - (g.planes.length - 1) / 2;
      let cx, cz, dx, dz;
      if (float) {
        const h = fleet.own.heading;
        dx = Math.sin(h);
        dz = -Math.cos(h);
        cx = c.x - dx * 2400 - dz * k * 450;
        cz = c.z - dz * 2400 + dx * k * 450;
      } else {
        const b = THREE.MathUtils.degToRad(g.attackBearing);
        const ux = -Math.sin(b), uz = Math.cos(b); // from the attackers through the force
        dx = -uz;
        dz = ux;
        cx = c.x + ux * (1500 + k * 700) + dx * k * 300;
        cz = c.z + uz * (1500 + k * 700) + dz * k * 300;
      }
      const half = ((n - 1) * spacing) / 2;
      let ax = cx - dx * half, az = cz - dz * half;
      // start from whichever end is nearer
      if (!float && Math.hypot(p.pos.x - (cx + dx * half), p.pos.z - (cz + dz * half)) < Math.hypot(p.pos.x - ax, p.pos.z - az)) {
        ax = cx + dx * half;
        az = cz + dz * half;
        dx = -dx;
        dz = -dz;
      }
      p.line = { ax, az, dx, dz, n, spacing, dropped: 0 };
      p.phase = 'approach';
    }
    const L = p.line;
    if (p.phase === 'approach') {
      const lx = L.ax - L.dx * 1300, lz = L.az - L.dz * 1300;
      this.steer(p, this.levelToward(p, lx, lz, p.altitude), dt, def.turn * 0.9, def.fast);
      if (Math.hypot(p.pos.x - lx, p.pos.z - lz) < 500) p.phase = 'drop';
    } else if (p.phase === 'drop') {
      const ex = L.ax + L.dx * ((L.n - 1) * L.spacing + 800), ez = L.az + L.dz * ((L.n - 1) * L.spacing + 800);
      this.steer(p, this.levelToward(p, ex, ez, p.altitude), dt, def.turn * 0.9, def.cruise);
      const along = (p.pos.x - L.ax) * L.dx + (p.pos.z - L.az) * L.dz;
      if (L.dropped < L.n && along >= L.dropped * L.spacing) {
        L.dropped++;
        this.events.flare?.(this.hardpoint(p), p.vel, g.drop);
      }
      if (L.dropped >= L.n || along > (L.n - 1) * L.spacing + 900) {
        p.phase = 'egress';
        p.state = 'egress';
        p.t = 0;
      }
    } else this.egress(p, dt, fleet);
  }

  // Fighters escort, then strafe the ships: shallow diving runs with all guns, pull up over the
  // deck, extend and come back.
  fighter(p, dt, t, fleet, ballistics) {
    const def = p.def;
    if (!p.target || p.target.sunk) {
      if (!this.pickTarget(p) || p.target.sunk) return this.egress(p, dt, fleet);
    }
    const s = p.target;
    const tp = s.position;
    if (p.phase === 'approach') {
      if (!p.setup) {
        const a = Math.random() * Math.PI * 2;
        p.setup = new THREE.Vector2(Math.cos(a), Math.sin(a));
      }
      const sx = tp.x + p.setup.x * 2600, sz = tp.z + p.setup.y * 2600;
      this.steer(p, this.levelToward(p, sx, sz, 650), dt, def.turn * 0.8, def.cruise);
      if (Math.hypot(p.pos.x - sx, p.pos.z - sz) < 500) {
        p.phase = 'strafe';
        p.aimLocal = s.randomAimPoint(true);
      }
    } else if (p.phase === 'strafe') {
      const ap = s.worldPoint(p.aimLocal, _v);
      const range = p.pos.distanceTo(ap);
      _w.copy(ap).addScaledVector(s.velocity, range / 700);
      _aim.subVectors(_w, p.pos).normalize();
      this.steer(p, _aim, dt, def.turn, def.fast * 0.9);
      const aim = _aim.dot(p.fwd);
      if (range < 1100 && range > 180 && aim > 0.995) {
        p.gunT -= dt;
        if (p.gunT <= 0) {
          p.gunT = 0.07;
          this.fireGuns(p, ballistics);
        }
      }
      if (range < 260 || p.pos.y < 40) {
        p.phase = 'pullup';
        p.t = 0;
      }
    } else if (p.phase === 'pullup') {
      _v.copy(p.fwd);
      _v.y = 0.45;
      this.steer(p, _v.normalize(), dt, def.turn * 1.3, def.cruise);
      if (p.t > 7) {
        p.passes++;
        if (p.passes >= 2 + Math.floor(Math.random() * 2)) {
          p.phase = 'egress';
          p.state = 'egress';
          p.t = 0;
        } else {
          p.phase = 'approach';
          p.setup = null;
          if (Math.random() < 0.4) this.pickTarget(p);
        }
      }
    } else this.egress(p, dt, fleet);
  }

  fireGuns(p, ballistics) {
    const guns = p.model.guns;
    for (const g of guns) {
      const muzzle = _x.copy(g).applyQuaternion(p.quat).add(p.pos);
      const spread = 0.008 / this.difficulty.accuracy;
      _y.copy(p.fwd);
      _y.x += rr(-spread, spread);
      _y.y += rr(-spread, spread);
      _y.z += rr(-spread, spread);
      ballistics.fire('mg', muzzle, _y.normalize(), p.vel, OWNER.ENEMY);
    }
    if (guns.length) {
      this.audio.gun('mg', p.pos);
      const g = guns[0];
      const m = _x.copy(g).applyQuaternion(p.quat).add(p.pos);
      this.fx.muzzle(m, p.fwd, 0.5, false);
    }
  }

  hardpoint(p) {
    const o = p.model.ordnance || _y.set(0, -1, 0);
    return new THREE.Vector3().copy(o).applyQuaternion(p.quat).add(p.pos);
  }

  checkShipCrash(p, fleet) {
    const ship = fleet.shipAt(p.pos, 4);
    if (ship) {
      this.events.crash?.(p, ship, p.alive);
      p.alive = false;
      p.gone = true;
      return true;
    }
    return false;
  }

  /** Out of control: burning, rolling, falling. Kamikazes shot down close in keep coming. */
  fall(p, dt, fleet) {
    p.roll += p.spin * dt;
    _v.copy(p.fwd);
    const steep = p.role === 'kamikaze' && p.phase === 'terminal' ? 0.15 : 0.55;
    _v.y -= steep * dt * 2;
    _v.normalize();
    p.fwd.copy(_v);
    p.speed = Math.max(60, p.speed + (-p.fwd.y * 9.8 - 2) * dt);
    p.vel.copy(p.fwd).multiplyScalar(p.speed);
    p.pos.addScaledVector(p.vel, dt);
    if (this.checkShipCrash(p, fleet)) return;
    if (p.pos.y <= 0) {
      p.gone = true;
      this.events.crash?.(p, null, false);
    }
  }

  effects(p, dt) {
    const dmg = 1 - Math.max(p.hp, 0) / p.maxHp;
    const k = p.alive ? (dmg > 0.66 ? 0.75 : dmg > 0.3 ? 0.3 : 0) : 0.9;
    if (k > 0) {
      p.smokeT -= dt;
      if (p.smokeT <= 0) {
        p.smokeT = 0.05;
        const eng = p.model.engines[0] || _y.set(0, 0, -2);
        const e = _x.copy(eng).applyQuaternion(p.quat).add(p.pos);
        this.fx.trail(e, p.vel, k);
      }
    }
  }

  render() {
    for (const type of Object.keys(this.meshes)) {
      const { mesh, state, disc } = this.meshes[type];
      let n = 0;
      for (const p of this.planes) {
        if (p.type !== type || p.gone || n >= MAX_PER_TYPE) continue;
        _m.compose(p.pos, p.quat, _s);
        mesh.setMatrixAt(n, _m);
        if (disc) disc.setMatrixAt(n, _m);
        const dmg = 1 - Math.max(p.hp, 0) / p.maxHp;
        state.setXYZW(n, p.alive ? dmg * 0.45 : 0.85, p.propPhase, p.ordnance ? 1 : 0, p.flash);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      state.needsUpdate = true;
      if (disc) {
        disc.count = n;
        disc.instanceMatrix.needsUpdate = true;
      }
    }

    // exhaust flames (night only): a pair of stacks per engine, either side of the cowling
    this.exhaust.visible = this.night > 0.01;
    if (!this.exhaust.visible) return;
    const A = this.exA.array, B = this.exB.array;
    let k = 0;
    for (const p of this.planes) {
      if (p.gone || !p.alive) continue;
      for (const e of p.model.engines) {
        for (const side of [-1, 1]) {
          if (k >= MAX_EXHAUST) break;
          _v.set(e.x + side * 0.78, e.y - 0.08, e.z + 0.3).applyQuaternion(p.quat).add(p.pos);
          const o = k * 4;
          A[o] = _v.x;
          A[o + 1] = _v.y;
          A[o + 2] = _v.z;
          A[o + 3] = 0.65 + 0.35 * Math.random();
          B[o] = p.fwd.x;
          B[o + 1] = p.fwd.y;
          B[o + 2] = p.fwd.z;
          B[o + 3] = 0.3;
          k++;
        }
      }
    }
    for (const a of [this.exA, this.exB]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, k * 4);
      a.needsUpdate = true;
    }
    this.exhaust.geometry.instanceCount = k;
  }
}
