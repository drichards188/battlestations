import * as THREE from 'three';
import { buildPlayerGun } from './models/guns.js';
import { GUNS } from './fleet.js';
import { solveLead, SHELLS, OWNER } from './ballistics.js';
import { BoforsFeed } from './feed.js';

const clamp = THREE.MathUtils.clamp;
const DEG = Math.PI / 180;
const rr = (a, b) => a + (b - a) * Math.random();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

// The player's guns. rates in rad/s, heat per round, cooling per second.
const PLAYER_GUNS = {
  // The quad's four guns each cycle about every half second (OP 820). The quad is two twin
  // slides, and each slide's delay gear lets one gun fire only when the other recoils, so the
  // guns of a pair alternate and one gun of each pair fires at the same moment (OD 4391).
  // Power drives (Mk 2 quad, NavWeaps): train 26 and elevation 24 deg/s; the automatic cutoffs
  // stop the mount from full speed within 10 deg in train and 6 deg in elevation (OD 4391),
  // which sets how hard the drives can accelerate and brake.
  '40mm-quad': {
    shell: '40mm', interval: 0.125, barrelPeriod: 0.5, stagger: [0, 0.25, 0, 0.25], pairs: true,
    drive: { train: 26 * DEG, elev: 24 * DEG, trainAcc: 34 * DEG, elevAcc: 48 * DEG, gain: 5, lag: 0.1, lead: [34 * DEG, 28 * DEG] },
    heat: 0.0115, coolFiring: 0.05, coolIdle: 0.16, spread: 0.0011, kick: 0.09, flash: 1.1, order: [0, 2, 1, 3],
  },
  // 5"/38 twin Mk 28 Mod 0 (NavWeaps): each gun is loaded by hand from the hoists (the fuze set
  // in the hoist, the projectile and the powder case laid on the tray, power-rammed) and fires
  // as its breech closes while the pointer holds the firing key: about 15 rounds a minute a gun
  // sustained, 22 in a burst (NAVPERS 10797-A). VT-fuzed. Drives: train 25, elevation 15 deg/s;
  // no source gives their acceleration, so the braking is estimated from the Bofors mount's.
  '5in-twin': {
    shell: '5in', load: [2.7, 3.6], fumble: 0.06, recoilReturn: 2.4, heat: 0, spread: 0.0006, kick: 0.45, deafen: 0.08, flash: 2.6, smoke: true, order: [0, 1],
    drive: { train: 25 * DEG, elev: 15 * DEG, trainAcc: 21 * DEG, elevAcc: 15 * DEG, gain: 4, lag: 0.15, lead: [30 * DEG, 24 * DEG] },
  },
  // single Oerlikon (Alabama's were all singles in 1944): ~450 rounds a minute, 60-round drum
  '20mm': { shell: '20mm', interval: 0.133, trainRate: 3.4, elevRate: 2.8, heat: 0, mag: 60, reload: 4, spread: 0.0022, kick: 0.03, flash: 0.55, order: [0] },
  '20mm-twin': { shell: '20mm', interval: 0.068, trainRate: 3.2, elevRate: 2.6, heat: 0, mag: 60, reload: 4, spread: 0.002, kick: 0.035, flash: 0.6, order: [0, 1] },
};
GUNS['20mm-twin'] = { ...GUNS['20mm'], interval: 0.0667, mag: 120 };

export class Gunner {
  constructor(camera, fleet, { fx, audio, ballistics, dom }) {
    this.camera = camera;
    this.fleet = fleet;
    this.fx = fx;
    this.audio = audio;
    this.ballistics = ballistics;
    this.ship = fleet.own;
    this.active = false;
    this.firing = false;
    this.zoom = false;
    this.sensitivity = 1;
    this.invertY = false;
    this.trauma = 0;
    this.deafen = 0;
    this.t = 0;
    this.blocked = false;
    this.lastCutout = 0;
    this.target = null;
    this.lead = new THREE.Vector3();
    this.leadValid = false;
    this.events = { switch: null };
    this.view = 'centre'; // or 'pointer': the 40mm pointer's seat behind his ring sight

    // Every AA gun aboard is a station. The AI crews each until the player takes it over; one
    // detailed model per kind stands in for the mount he is on, and that mount's AI instance is
    // hidden while he is.
    this.models = {};
    this.stations = this.ship.mounts.filter((m) => PLAYER_GUNS[m.kind] && this.model(m.kind)).map((m) => this.makeStation(m));
    this.nameStations();
    // the battle starts on Mount 47, the starboard quad amidships
    this.home = Math.max(0, this.stations.findIndex((s) => s.label === '47' && s.spec.kind === '40mm-quad'));
    this.index = this.home;
    this.aimTrain = this.station.mount.train;
    this.aimElev = 0.2;
    this.driveLoad = -1;

    dom.addEventListener('mousedown', (e) => {
      if (!this.active || !document.pointerLockElement) return;
      if (e.button === 0) this.firing = true;
      if (e.button === 2) this.zoom = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
      if (e.button === 2) this.zoom = false;
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('blur', () => {
      this.firing = false;
      this.zoom = false;
    });
    addEventListener('mousemove', (e) => {
      if (!this.active || !document.pointerLockElement) return;
      const k = 0.0021 * this.sensitivity * (this.camera.fov / 62);
      this.aimTrain -= e.movementX * k;
      this.aimElev -= e.movementY * k * (this.invertY ? -1 : 1);
    });
  }

  // The shared detailed model of a kind, built on first use (null if there is none).
  model(kind) {
    if (kind in this.models) return this.models[kind];
    const gun = buildPlayerGun(kind);
    // buildPlayerGun falls back to the quad Bofors for kinds it has no model for
    const fits = kind === '5in-twin' ? !!gun.fiveInch : kind === '40mm-quad' ? !!gun.feed : kind.startsWith('20mm');
    if (!fits) return (this.models[kind] = null);
    gun.root.visible = false;
    this.ship.group.add(gun.root);
    gun.yaw.rotation.y = 0;
    gun.pitch.rotation.x = 0;
    gun.root.updateMatrixWorld(true);
    if (kind === '5in-twin') gun.pointerRing = false;
    return (this.models[kind] = {
      kind,
      gun,
      pivot: gun.root.worldToLocal(gun.pitch.getWorldPosition(new THREE.Vector3())),
      muzzles: gun.muzzles.map((mz) => gun.pitch.worldToLocal(mz.getWorldPosition(new THREE.Vector3()))),
      barrelZ: gun.barrels.map((b) => b.position.z),
      magBase: gun.magazines.map((mg) => mg.position.clone()),
      magRot: gun.magazines.map((mg) => mg.rotation.clone()),
      feed: kind === '40mm-quad' ? new BoforsFeed(gun, { audio: this.audio }) : null,
      owner: null,
    });
  }

  makeStation(m) {
    const M = this.models[m.kind];
    const def = PLAYER_GUNS[m.kind];
    return {
      spec: { kind: m.kind, pos: m.pos, train0: m.train0, arc: m.arc, name: '' },
      label: '',
      model: M,
      gun: M.gun,
      mount: m,
      def,
      recoil: M.gun.barrels.map(() => 0),
      barrelZ: M.barrelZ,
      heat: 0,
      overheated: false,
      ammo: def.mag ? M.gun.magazines.map(() => def.mag) : null,
      reload: 0,
      shot: 0,
      cool: 0,
      feed: M.feed,
      supply: null, // this mount's ready racks and lockers while the player is on another
      // a 5in gun's loading cycle: ready when t reaches dur
      five: def.load ? [0, 1].map(() => ({ t: 1, dur: 0 })) : null,
      barrelT: M.gun.barrels.map(() => 0),
      wasFiring: false,
      // power drive state: mount rates, and how fast the handwheels (mouse) are turning
      vT: 0,
      vE: 0,
      cmdVT: 0,
      cmdVE: 0,
      dry: false,
      magBase: M.magBase,
      magRot: M.magRot,
    };
  }

  // Numbers and names, counting aft, odd to starboard and even to port (the usual Navy scheme;
  // no source confirms the sides for Alabama). In 1944 her 5in mounts were numbered 1 to 10
  // (DANFS: on 21 February 1944 "5-inch mount no. 9 accidentally fired into mount no. 5"); the
  // 40mm quads 41 to 52 as we have them; the 20mm numbering is ours.
  nameStations() {
    const KIND = { '5in-twin': '5"/38 twin', '40mm-quad': '40mm quad', '20mm': '20mm Oerlikon', '20mm-twin': '20mm twin' };
    const BASE = { '5in-twin': 1, '40mm-quad': 41, '20mm': 1, '20mm-twin': 1 };
    const model = this.ship.model;
    for (const kind of Object.keys(BASE)) {
      const list = this.stations.filter((s) => s.spec.kind === kind);
      const zs = [...new Set(list.map((s) => Math.round(s.mount.pos.z)))].sort((a, b) => a - b);
      for (const s of list) {
        const { x, y, z } = s.mount.pos;
        const side = x > 0.5 ? 'Starboard' : x < -0.5 ? 'Port' : 'Centreline';
        const n = BASE[kind] + zs.indexOf(Math.round(z)) * 2 + (x < -0.5 ? 1 : 0);
        const deck = model.deckAt ? model.deckAt(z, x) : y;
        const lv = Math.round((y - deck) / 2.6);
        const level = lv <= 0 ? (z < -70 ? 'forecastle' : z > 85 ? 'fantail' : 'main deck') : `0${lv} level`;
        s.label = String(n);
        s.spec.id = `${kind}-${n}`;
        s.spec.name = kind.startsWith('20mm') ? `20mm No. ${n} · ${side}, ${level}` : `Mount ${n} · ${side} ${KIND[kind]}, ${level}`;
        s.spec.short = KIND[kind];
      }
    }
    // the quads first, then the 5in, then the 20mm, each counting aft
    const order = { '40mm-quad': 0, '5in-twin': 1, '20mm': 2, '20mm-twin': 3 };
    this.stations.sort((a, b) => order[a.spec.kind] - order[b.spec.kind] || Number(a.label) - Number(b.label));
  }

  // Put the kind's detailed model on the mount the player is taking, hiding its AI instance and
  // giving the mount the model's pivot and muzzles; any other model goes back to its AI mount.
  occupy(st) {
    for (const M of Object.values(this.models)) if (M && M.owner && M.owner !== st) this.release(M.owner);
    const M = st.model;
    const m = st.mount;
    m.ai ??= { pivot: m.pivot.clone(), muzzles: m.muzzles.map((v) => v.clone()), elevLimits: m.elevLimits };
    m.pivot.copy(M.pivot);
    m.muzzles = M.muzzles.map((v) => v.clone());
    m.elevLimits = M.gun.elev;
    m.detailed = true;
    if (M.owner !== st) {
      M.owner = st;
      M.gun.root.position.copy(m.pos);
      M.gun.root.visible = true;
      st.recoil.fill(0);
      // the AI crew kept the guides topped up; the racks and lockers are this mount's own
      M.feed?.takeOver(st.supply);
    }
  }

  release(st) {
    const M = st.model;
    const m = st.mount;
    if (M.feed) st.supply = M.feed.supplyState();
    m.detailed = false;
    if (m.ai) {
      m.pivot.copy(m.ai.pivot);
      m.muzzles = m.ai.muzzles.map((v) => v.clone());
      m.elevLimits = m.ai.elevLimits;
    }
    M.owner = null;
    M.gun.root.visible = false;
  }

  /** A new battle: every mount's guns cool, drums full, guides, racks and lockers stocked. */
  newBattle() {
    for (const s of this.stations) {
      s.heat = 0;
      s.overheated = false;
      s.reload = 0;
      if (s.ammo) s.ammo = s.ammo.map(() => s.def.mag);
      s.supply = null;
      if (s.five) for (const g of s.five) g.t = g.dur = 0;
    }
    for (const M of Object.values(this.models)) M?.feed?.reset();
  }

  /** Between raids the passers and the hoists restock every mount. */
  restock() {
    for (const s of this.stations) s.supply = null;
    for (const M of Object.values(this.models)) M?.feed?.restock();
  }

  get station() {
    return this.stations[this.index];
  }

  setActive(on) {
    this.active = on;
    this.firing = false;
    this.zoom = false;
    for (const s of this.stations) s.mount.manual = false;
    if (on) {
      const st = this.station;
      st.mount.manual = true;
      this.aimTrain = st.mount.train;
      this.aimElev = st.mount.elev;
      this.takeOver(st);
    }
  }

  select(i) {
    if (i === this.index || !this.stations[i]) return false;
    this.station.mount.manual = false;
    this.index = i;
    const st = this.station;
    st.mount.manual = this.active;
    st.mount.target = null;
    this.aimTrain = st.mount.train;
    this.aimElev = Math.max(st.mount.elev, 0.15);
    this.takeOver(st);
    this.firing = false;
    this.audio.stationChange();
    this.events.switch?.(st);
    return true;
  }

  // taking a mount over from its AI crew: the drives start from rest under the new command
  takeOver(st) {
    this.occupy(st);
    st.vT = st.vE = st.cmdVT = st.cmdVE = 0;
    st.prevAimT = this.aimTrain;
    st.prevAimE = this.aimElev;
  }

  reload() {
    const st = this.station;
    if (!st.ammo || st.reload > 0) return;
    if (st.ammo.every((a) => a === st.def.mag)) return;
    // no two drum changes are alike: a slow or fumbled latch, a drum that has to be rocked home
    const fumble = Math.random() < 0.12;
    st.reload = st.def.reload * rr(0.88, 1.18) + (fumble ? rr(0.5, 1.1) : 0);
    st.reloadDur = st.reload;
    st.drumJ = { side: rr(0.18, 0.3), lift: rr(0.24, 0.36), tilt: rr(-0.35, 0.35), miss: rr(0.012, 0.03) * (fumble ? 2.5 : 1), rock: fumble };
    st.reloadSound = false;
    this.audio.clipOut(1); // empty drums unlatched and lifted off
  }

  shake(k) {
    this.trauma = Math.min(1, this.trauma + k);
  }

  update(dt, rawDt, { air }) {
    this.t += rawDt;
    const st = this.station;
    const m = st.mount;
    const def = st.def;
    this.trauma = Math.max(0, this.trauma - rawDt * 1.4);
    this.deafen = Math.max(0, this.deafen - rawDt * 0.25);

    for (const s of this.stations) {
      // cooling and reloading happen whoever is on the gun
      s.heat = Math.max(0, s.heat - dt * (s === st && this.firing && this.active ? def.coolFiring || 0 : (s.def.coolIdle || 0.2)));
      if (s.overheated && s.heat < 0.4) s.overheated = false;
      if (s.reload > 0) {
        s.reload -= dt;
        if (s.reload <= 0) {
          s.reload = 0;
          s.ammo = s.ammo.map(() => s.def.mag);
        }
      }
      if (s.five) for (const g of s.five) g.t += dt;
      for (let i = 0; i < s.recoil.length; i++) s.recoil[i] = Math.max(0, s.recoil[i] - dt * (s.def.recoilReturn || 7));
    }
    // the detailed models: drums and the Bofors feed on the mount each stands in for
    for (const M of Object.values(this.models)) {
      if (!M?.owner) continue;
      this.animateDrums(M.owner);
      if (M.feed) {
        // on the player's mount the crew is hidden and the feed draws the loaders' clips
        M.feed.manual = this.active && M.owner === st;
        M.feed.update(dt);
      }
    }

    if (this.active) {
      // commanded aim, clamped to the mount's limits; the mount slews after it
      const [lo, hi] = m.arc;
      if (def.drive) {
        // the pointer and trainer can only wind their handwheels so far ahead of the mount
        const [lt, le] = def.drive.lead;
        this.aimTrain = clamp(this.aimTrain, m.train - lt, m.train + lt);
        this.aimElev = clamp(this.aimElev, m.elev - le, m.elev + le);
      }
      this.aimTrain = clamp(this.aimTrain, lo, hi);
      this.aimElev = clamp(this.aimElev, m.elevLimits[0], m.elevLimits[1]);
      if (def.drive) this.powerDrive(st, dt);
      else {
        // a free-swinging Oerlikon: as fast as the gunner can heave it round
        const dT = this.aimTrain - m.train, dE = this.aimElev - m.elev;
        const kT = Math.min(Math.abs(dT) * 14, def.trainRate) * dt;
        const kE = Math.min(Math.abs(dE) * 14, def.elevRate) * dt;
        m.train += clamp(dT, -kT, kT);
        m.elev += clamp(dE, -kE, kE);
        this.driveLoad = -1;
      }
      m.update(this.ship.matrix);
      this.fire(dt, st);
    }

    // pose every detailed gun from its mount
    for (const M of Object.values(this.models)) {
      const s = M?.owner;
      if (!s) continue;
      s.gun.yaw.rotation.y = s.mount.train;
      s.gun.pitch.rotation.x = s.mount.elev;
      s.gun.barrels.forEach((b, i) => (b.position.z = s.barrelZ[i] + s.recoil[i] * s.gun.recoil));
      s.gun.root.updateMatrixWorld(true);
    }

    if (this.active) {
      this.placeCamera(rawDt);
      this.designate(air);
    }
  }

  // The electro-hydraulic power drives under local control. The pointer's and trainer's
  // handwheels (the mouse) set where the mount should point; each drive answers a moment late,
  // runs no faster than its top speed, and speeds up and brakes no harder than its gear allows,
  // braking early so it comes to rest on the command. Turning the handwheels steadily (tracking
  // a target) carries the mount along at that rate.
  powerDrive(st, dt) {
    if (dt <= 0) return;
    const m = st.mount;
    const D = st.def.drive;
    const k = Math.min(1, dt / 0.08);
    st.cmdVT += ((this.aimTrain - st.prevAimT) / dt - st.cmdVT) * k;
    st.cmdVE += ((this.aimElev - st.prevAimE) / dt - st.cmdVE) * k;
    st.prevAimT = this.aimTrain;
    st.prevAimE = this.aimElev;
    const axis = (err, v, rate, vmax, amax) => {
      const brake = Math.sqrt(2 * amax * 0.8 * Math.abs(err));
      const want = clamp(clamp(rate, -vmax, vmax) + Math.sign(err) * Math.min(Math.abs(err) * D.gain, brake), -vmax, vmax);
      return v + clamp((want - v) * Math.min(1, dt / D.lag), -amax * dt, amax * dt);
    };
    st.vT = axis(this.aimTrain - m.train, st.vT, st.cmdVT, D.train, D.trainAcc);
    st.vE = axis(this.aimElev - m.elev, st.vE, st.cmdVE, D.elev, D.elevAcc);
    m.train += st.vT * dt;
    m.elev += st.vE * dt;
    // the train stops and the elevation buffers
    const [lo, hi] = m.arc;
    if (m.train < lo || m.train > hi) {
      m.train = clamp(m.train, lo, hi);
      st.vT = 0;
    }
    const [el, eh] = m.elevLimits;
    if (m.elev < el || m.elev > eh) {
      m.elev = clamp(m.elev, el, eh);
      st.vE = 0;
    }
    this.driveLoad = Math.min(1, Math.max(Math.abs(st.vT) / D.train, Math.abs(st.vE) / D.elev));
  }

  fire(dt, st) {
    const def = st.def;
    const m = st.mount;
    // the rate timer can only bank one round, or a long pause would release a burst in a single frame
    st.cool = Math.max(st.cool - dt, -def.interval);
    for (let b = 0; b < st.barrelT.length; b++) st.barrelT[b] -= dt;
    st.dry = false;
    if (!this.firing) {
      st.wasFiring = false;
      return;
    }
    if (st.overheated || st.reload > 0) return;
    if (st.ammo && st.ammo.every((a) => a <= 0)) {
      this.reload();
      return;
    }
    // firing cutout: don't shoot through our own superstructure
    const bore = m.boreWorld(_w);
    const muzzle = m.muzzleWorld(0, _v);
    const o = this.ship.toLocal(muzzle, _u);
    const d = _q.copy(this.ship.group.quaternion).invert();
    const dl = bore.clone().applyQuaternion(d);
    this.blocked = this.ship.rayBlocked(o, dl, 220, 1.5);
    if (this.blocked) {
      if (this.t - this.lastCutout > 0.6) {
        this.audio.cutout();
        this.lastCutout = this.t;
      }
      return;
    }
    if (st.five) {
      // each gun fires as its breech closes on a fresh round, for as long as the key is held
      for (const b of def.order) {
        const g = st.five[b];
        if (g.t < g.dur) continue;
        g.t = 0;
        // a fumbled projectile or a powder case that won't seat costs a second or two
        g.dur = rr(...def.load) * (Math.random() < def.fumble ? rr(1.4, 1.9) : 1);
        this.shoot(st, b);
      }
      return;
    }
    if (st.feed) {
      // each gun fires on its own cycle, and only with a round in its guides
      if (!st.wasFiring) st.barrelT = def.stagger.map((t) => t + Math.random() * 0.015);
      st.wasFiring = true;
      for (let b = 0; b < st.barrelT.length; b++) {
        if (st.barrelT[b] > 0) continue;
        if (!st.feed.take(b)) {
          st.barrelT[b] = 0.03; // waiting on the loader
          st.dry = true;
          continue;
        }
        st.barrelT[b] = Math.max(st.barrelT[b], -0.05) + def.barrelPeriod * (0.94 + Math.random() * 0.12);
        // the delay gear: its partner on the slide can't fire until this one has recoiled
        if (def.pairs) st.barrelT[b ^ 1] = Math.max(st.barrelT[b ^ 1], def.barrelPeriod * (0.47 + Math.random() * 0.06));
        this.shoot(st, b);
        if (st.overheated) break;
      }
      return;
    }
    while (st.cool <= 0) {
      // the loaders and the paired guns never keep perfect time
      st.cool += def.interval * (0.86 + Math.random() * 0.28);
      const bi = def.order[st.shot % def.order.length];
      if (st.ammo) {
        const g = bi % st.ammo.length;
        if (st.ammo[g] <= 0) continue;
        st.ammo[g]--;
      }
      this.shoot(st, bi);
      if (st.overheated) break;
    }
    if (st.cool < -def.interval) st.cool = 0;
  }

  shoot(st, bi) {
    const def = st.def;
    const m = st.mount;
    st.shot++;
    const mz = m.muzzleWorld(bi, _v);
    const dir = m.boreWorld(_w);
    dir.x += rr(-1, 1) * def.spread;
    dir.y += rr(-1, 1) * def.spread;
    dir.z += rr(-1, 1) * def.spread;
    dir.normalize();
    this.ballistics.fire(def.shell, mz, dir, this.ship.velocity, OWNER.PLAYER);
    st.recoil[bi] = 1;
    // cordite smoke from every few rounds only: puffs this close to the eye are full-screen overdraw
    this.fx.muzzle(mz, dir, def.flash, def.smoke || st.shot % 4 === 0);
    if (def.deafen) this.deafen = Math.min(1, this.deafen + def.deafen);
    this.audio.gun(def.shell, null, { player: true, barrel: bi });
    this.audio.casing();
    this.shake(def.kick);
    if (def.heat) {
      st.heat += def.heat;
      if (st.heat >= 1) {
        st.heat = 1;
        st.overheated = true;
        this.audio.overheat();
      }
    }
  }

  // 20mm drum change: the empty drums come off, the loader fetches full ones and seats them
  animateDrums(s) {
    const mags = s.gun.magazines;
    if (!mags.length) return;

    const k = s.reload > 0 ? 1 - s.reload / (s.reloadDur || s.def.reload) : 1;
    const J = s.drumJ;
    // the drum is rocked onto its latch rather than placed: it goes home with a final shove
    const seatAt = J?.rock ? 0.96 : 0.92;
    if (s.reload > 0 && k > seatAt && !s.reloadSound) {
      s.reloadSound = true;
      this.audio.reload();
    }
    mags.forEach((mg, i) => {
      const base = s.magBase[i];
      const rot = s.magRot[i];
      const side = i % 2 ? 1 : -1;
      mg.visible = true;
      mg.rotation.copy(rot);
      if (s.reload <= 0 || !J) {
        // a fresh drum settles on its latch for a moment
        const t = this.t - (s.seatedAt ?? -9);
        const w = t < 0.4 ? Math.exp(-t * 9) * Math.sin(t * 60) : 0;
        mg.position.set(base.x, base.y + w * 0.006, base.z);
        mg.rotation.z = rot.z + w * 0.03;
        return;
      }
      if (k < 0.2) {
        // unlatched, lifted and swung clear, never quite the same way twice
        const u = k / 0.2;
        mg.position.set(base.x + side * J.side * u, base.y + J.lift * u * (2 - u), base.z + 0.08 * u);
        mg.rotation.z = rot.z + side * J.tilt * u;
      } else if (k < 0.62) mg.visible = false;
      else {
        // the full drum comes in a little off, is lined up over the post and pushed home
        const u = (k - 0.62) / 0.38;
        const e = 1 - u;
        const off = J.miss * Math.sin(u * Math.PI * (J.rock ? 3 : 1.4)) * e;
        mg.position.set(base.x + side * J.side * 0.85 * e * e + off, base.y + J.lift * e * e * e, base.z + off * 0.6);
        mg.rotation.z = rot.z + side * (J.tilt * 0.6 * e + off * 6);
      }
    });
    if (s.reload <= 0 && J) {
      if (!s.reloadSound) this.audio.reload();
      s.drumJ = null;
      s.seatedAt = this.t;
    }
  }

  /** Toggle between the centre view and the pointer's ring sight (40mm only). */
  toggleView() {
    if (!this.station.gun.eyes) return false;
    this.view = this.view === 'centre' ? 'pointer' : 'centre';
    return true;
  }

  /** True when a physical ring sight is in front of the eye (the HUD reticle steps aside). */
  get ringSight() {
    const gun = this.station.gun;
    return (this.view === 'pointer' && !!gun.eyes && gun.pointerRing !== false) || !!gun.ringSight;
  }

  placeCamera(rawDt) {
    const gun = this.station.gun;
    const eye = gun.eye;
    if (gun.eyes) {
      const e = gun.eyes;
      if (this.view === 'centre' && e.centreHigh) {
        const k = THREE.MathUtils.smoothstep(this.station.mount.elev, 0, 1.4);
        eye.position.lerpVectors(e.centre, e.centreHigh, k);
      } else eye.position.copy(e[this.view] || e.centre);
      eye.updateMatrixWorld();
    }
    eye.getWorldPosition(this.camera.position);
    // an enclosed mount's sight hoods don't elevate, but the sights are geared to the guns
    (gun.eyeSpace === 'yaw' ? gun.pitch : eye).getWorldQuaternion(this.camera.quaternion);
    // shake: trauma squared, smooth noise
    const s = this.trauma * this.trauma;
    if (s > 1e-4) {
      const t = this.t * 23;
      const n = (a) => Math.sin(t * a) * 0.6 + Math.sin(t * a * 2.13 + 1.7) * 0.4;
      _e.set(n(1.1) * 0.03 * s, n(0.9) * 0.03 * s, n(1.3) * 0.04 * s);
      _q.setFromEuler(_e);
      this.camera.quaternion.multiply(_q);
      this.camera.position.y += n(1.7) * 0.05 * s;
    }
    this.camera.updateMatrixWorld();
  }

  /** The aircraft nearest the bore line gets the lead computing sight. */
  designate(air) {
    const cam = this.camera;
    const fwd = cam.getWorldDirection(_u);
    let best = null, bestA = 0.26;
    for (const p of air.planes) {
      if (!p.alive) continue;
      _v.subVectors(p.pos, cam.position);
      const d = _v.length();
      if (d > 4500 || d < 30) continue;
      const a = Math.acos(clamp(_v.dot(fwd) / d, -1, 1)) * (p === this.target ? 0.7 : 1);
      if (a < bestA) {
        bestA = a;
        best = p;
      }
    }
    this.target = best;
    this.leadValid = false;
    if (best) {
      const kind = SHELLS[this.station.def.shell];
      this.tof = solveLead(kind, this.station.mount.pivotWorld(_w), this.ship.velocity, best.pos, best.vel, this.lead);
      this.leadValid = true;
      this.range = cam.position.distanceTo(best.pos);
    }
  }

  /** Where the mouse is commanding the gun to go (world direction), for the HUD. */
  commandDir(out) {
    const m = this.station.mount;
    const c = Math.cos(this.aimElev);
    out.set(-Math.sin(this.aimTrain) * c, Math.sin(this.aimElev), -Math.cos(this.aimTrain) * c);
    return out.applyQuaternion(this.ship.group.quaternion);
  }

  get heat() {
    return this.station.heat;
  }
}
