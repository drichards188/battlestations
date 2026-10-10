import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The ammunition supply of the player's quad Bofors, as live objects, after the Navy's OP 820
// (40-MM Antiaircraft Gun), the Army's TM 9-252 and OD 4391 (quad mount Mk 2).
//
// Each gun's automatic loader is a pair of curved guides standing on the breech casing, above
// the rammer tray. Rounds lie in them noses forward, one on another, fanning slightly toward the
// muzzle as the guides curve forward. The lowest rests on the star wheels; the loader holds
// seven, with an eighth on the tray. Clips are dropped into the feed lips at the top and ride
// down the guides with their rounds until the cam on the rear rail has pulled every clip hook
// off its rim, two rounds from the bottom; then the rear rail throws the empty clip out through
// the clip slot in the side of the slide (left on a left gun, right on a right gun).
//
// One gun cycle, about half a second: the rammer catapults the round on the tray into the
// chamber and the gun fires. In recoil the feed pawls ride up the column; the extractors throw
// the empty case back out of the breech, through the rear door and into the deflector, which
// sends it down a trough and a tube through the carriage to the deck. In counterrecoil the
// feed pawls force the column down one round, the star wheels turn a quarter turn and the
// lowest round drops onto the tray. When only two rounds are left, one on the tray and one on
// the star wheels, the loader catch stops the gun with the rammer cocked, and it fires again by
// itself the moment the loader is refilled.
//
// The crew: a first loader at each gun takes clips from a second loader working out of the
// ready racks and drops them in, about one every one and a half to two seconds. Passers
// restock the racks from the ready-service lockers; the magazine hoist refills the lockers.
// Nothing runs like clockwork: loaders tire and fumble, clips go in crooked and have to be
// rocked home, now and then one jams and has to be cleared with the tools, and every shot
// rattles the rounds in the play of their guides.

const rr = (a, b) => a + (b - a) * Math.random();
const SPENT = 64;
const CLIPS = 16;
const _m = new THREE.Matrix4();
const _cm = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _a = { py: 0, pz: 0, th: 0 };

const _b = { py: 0, pz: 0, th: 0 };

// the gun cycle after a shot (seconds)
const EJECT_AT = 0.045; // recoil: case out, feed pawls at the top of their stroke
const FEED_AT = 0.085; // counterrecoil: column forced down, lowest round onto the tray
const TRAY_TIME = 0.06; // the round settles on the tray and the rammer is cocked
// the feed pawls drive the column down at this speed (round spacings per second)
const PAWL_V = 9;
// a loader's moves (seconds)
const SWING = [0.22, 0.34];
const HANG = [0.2, 0.55];
const JAM = [3, 6];

// one round in clip space: case base at the origin, nose along -Z
function lathe(profile, segs) {
  const g = new THREE.LatheGeometry(profile.map(([r, d]) => new THREE.Vector2(r, d)), segs);
  g.rotateX(-Math.PI / 2);
  return g;
}

function roundGeometry() {
  // 40 x 311R: rimmed case 311 mm long, round 447 mm overall
  const caseGeo = lathe(
    [[0, 0], [0.0298, 0], [0.0298, 0.006], [0.0268, 0.007], [0.0268, 0.011], [0.0284, 0.012], [0.0272, 0.27], [0.0222, 0.288], [0.0222, 0.311], [0, 0.311]],
    16
  );
  const proj = lathe(
    [[0, 0.311], [0.0212, 0.311], [0.0212, 0.326], [0.0202, 0.328], [0.0202, 0.392], [0.0185, 0.41], [0.0135, 0.428], [0.0095, 0.436], [0.006, 0.444], [0, 0.447]],
    16
  );
  // driving band copper, body olive drab with a yellow HE band, steel fuze
  const pos = proj.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const d = -pos.getZ(i);
    if (d < 0.327) c.setRGB(0.55, 0.26, 0.12);
    else if (d > 0.36 && d < 0.372) c.setRGB(0.62, 0.52, 0.12);
    else if (d < 0.427) c.setRGB(0.19, 0.2, 0.12);
    else c.setRGB(0.16, 0.16, 0.15);
    col.set([c.r, c.g, c.b], i * 3);
  }
  proj.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return { caseGeo, projGeo: proj };
}

// The clip (BuOrd 40mm clip Mk 5): a pressed-steel strip down one side of the case heads, with a
// concave seat and a spring hook clamping each rim and a lifting tab at the top. `s` is the
// side it sits on, which is the side of the gun it is thrown out of.
function clipGeometry(dy, s) {
  const h = dy * 3 + 0.03;
  const parts = [
    new THREE.BoxGeometry(0.006, h, 0.03).translate(s * 0.034, dy * 1.5, -0.008),
    new THREE.BoxGeometry(0.012, h, 0.004).translate(s * 0.03, dy * 1.5, -0.022), // stiffening flange
    new THREE.BoxGeometry(0.03, 0.006, 0.026).translate(s * 0.022, dy * 3 + 0.035, -0.008), // tab
    new THREE.BoxGeometry(0.006, 0.022, 0.026).translate(s * 0.008, dy * 3 + 0.027, -0.008),
  ];
  for (let i = 0; i < 4; i++) {
    parts.push(new THREE.BoxGeometry(0.012, 0.014, 0.008).translate(s * 0.027, i * dy + 0.018, 0.0)); // hook over the rim
    parts.push(new THREE.CylinderGeometry(0.004, 0.004, 0.012, 6).rotateZ(Math.PI / 2).translate(s * 0.042, i * dy, -0.012)); // spring pin
  }
  return mergeGeometries(parts);
}

// a star wheel: a four-sided prism on an axis parallel to the rounds
function starGeometry() {
  return new THREE.CylinderGeometry(0.019, 0.019, 0.07, 4).rotateX(Math.PI / 2);
}

function instanced(geo, mat, count, parent, shadow = true) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.count = 0;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

let shared = null;
function resources(dy) {
  if (shared) return shared;
  const { caseGeo, projGeo } = roundGeometry();
  shared = {
    caseGeo,
    projGeo,
    clipGeo: [clipGeometry(dy, -1), clipGeometry(dy, 1)],
    starGeo: starGeometry(),
    pawlGeo: new THREE.BoxGeometry(0.01, 0.026, 0.05),
    brass: new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 1, roughness: 0.32 }),
    shell: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.25, roughness: 0.55 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x3a3d40, metalness: 0.75, roughness: 0.42 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x24272a, metalness: 0.7, roughness: 0.5 }),
  };
  return shared;
}

// A round in the guides. `y` is its place in the column in round spacings above the star
// wheels, `v` its downward speed. While its clip still holds it `clip` is set and `k` eases
// from 0 (square in the clip) to 1 (fanned in the curved guides). `rattle` is how hard it is
// shaking in the play of the guides; each round shakes at its own frequencies.
function round(y, v = 0, clip = null) {
  return { y, v, clip, k: clip ? 0 : 1, rattle: 0, f: [rr(38, 52), rr(44, 60), rr(30, 40)], ph: [rr(0, 6.3), rr(0, 6.3), rr(0, 6.3)] };
}

export class BoforsFeed {
  constructor(gun, { audio } = {}) {
    const L = (this.layout = gun.feed);
    this.gun = gun;
    this.audio = audio;
    this.cap = L.cap;
    this.t = 0;
    this.fall = 160;
    this.guns = L.xs.map((x, b) => ({
      b,
      x,
      side: L.eject[b],
      col: [],
      tray: true, // a round on the rammer tray, rammer cocked
      cycle: -1, // time into the cycle after a shot, -1 when done
      ejected: true,
      fed: true,
      drop: null, // the round falling from the star wheels onto the tray
      star: 0,
      starTo: 0,
      pawl: 0,
      clip: null, // the clip in the first loader's hands
      loader: { state: 'ready', t: 0, wait: 0, skill: rr(0.9, 1.12), fatigue: 0 },
    }));
    this.rackMax = L.rackSlots.length;
    this.rack = this.rackMax;
    this.lockersMax = 40;
    this.lockers = this.lockersMax;
    this.passT = 0;
    this.hoistT = 0;

    const R = resources(L.dy);
    const n = L.xs.length * (this.cap + 9);
    this.feedCases = instanced(R.caseGeo, R.brass, n, gun.pitch);
    this.feedShells = instanced(R.projGeo, R.shell, n, gun.pitch);
    this.feedClips = [-1, 1].map((s) => instanced(R.clipGeo[(s + 1) / 2], R.steel, L.xs.length * 3, gun.pitch));
    this.stars = instanced(R.starGeo, R.dark, L.xs.length * 2, gun.pitch, false);
    this.pawls = instanced(R.pawlGeo, R.dark, L.xs.length * 2, gun.pitch, false);
    // true while the player is on this mount: then its crew is hidden and the loaders' clips are
    // drawn here; on a mount the AI crews, the sailors carry their own
    this.manual = false;
    const nr = L.rackSlots.length;
    this.rackCases = instanced(R.caseGeo, R.brass, nr * 4, gun.root);
    this.rackShells = instanced(R.projGeo, R.shell, nr * 4, gun.root);
    this.rackClips = instanced(R.clipGeo[0], R.steel, nr, gun.root);
    // spent brass and empty clips land on the training platform
    this.spentMesh = instanced(R.caseGeo, R.brass, SPENT, gun.yaw);
    this.clipMesh = [-1, 1].map((s) => instanced(R.clipGeo[(s + 1) / 2], R.steel, CLIPS, gun.yaw));
    this.spent = [];
    this.clips = [];
    this.reset();
  }

  /** Per gun, for the HUD: rounds in the loader, the round on the tray, the loader's clip, a jam. */
  get hudState() {
    return this.guns.map((g) => ({
      rounds: g.col.length,
      tray: g.tray || !!g.drop,
      stopped: g.col.length < 2,
      hand: g.clip ? (g.clip.phase === 'held' ? 'ready' : 'in') : null,
      jam: g.clip?.phase === 'jam',
    }));
  }

  /** Index of a gun whose loader is clearing a jammed clip, or -1. */
  get jammed() {
    return this.guns.findIndex((g) => g.clip?.phase === 'jam');
  }

  /**
   * Fire gun `b`: false if it can't, because the last cycle hasn't finished or the loader catch
   * has stopped it with two rounds left. Otherwise starts the cycle.
   */
  take(b) {
    const g = this.guns[b];
    if (!g.tray || g.cycle >= 0) return false;
    const [r0, r1] = g.col;
    if (!r0 || !r1 || r0.y > 0.08 || r1.y > 1.15) return false;
    g.tray = false;
    g.cycle = 0;
    g.ejected = g.fed = false;
    // the shot jars everything on the slide, its own loader hardest
    for (const o of this.guns) {
      const k = o === g ? 1 : 0.35;
      for (const r of o.col) r.rattle = Math.min(1, r.rattle + k * rr(0.5, 0.9));
      if (o.clip && o.clip.phase !== 'held') o.clip.rattle = Math.min(1, o.clip.rattle + k * 0.6);
    }
    return true;
  }

  // ---- where things are

  // a point on the guide arc `s` round spacings above the star wheels (below them, straight down
  // onto the tray): case-base position and the nose-down tilt of a round lying there
  arc(s, out) {
    const L = this.layout;
    if (s <= 0) {
      out.th = 0;
      out.py = L.y0 + s * L.dy;
      out.pz = L.z;
    } else {
      const th = (s * L.dy) / L.R;
      out.th = th;
      out.py = L.y0 + L.R * Math.sin(th);
      out.pz = L.z - L.R * (1 - Math.cos(th));
    }
    return out;
  }

  // a clip whose lowest round is at `s`: the clip is straight, so it sits on the chord, square
  // to the guides at its middle
  clipFrame(s, out) {
    const L = this.layout;
    this.arc(s + 1.5, out);
    const h = 1.5 * L.dy;
    out.py -= h * Math.cos(out.th);
    out.pz += h * Math.sin(out.th);
    return out;
  }

  // pitch space -> yaw space (the platform the brass lands on)
  toYaw(x, y, z, out) {
    return out.set(x, y, z).applyMatrix4(this.gun.pitch.matrix);
  }

  dirToYaw(x, y, z, out) {
    return out.set(x, y, z).applyQuaternion(this.gun.pitch.quaternion);
  }

  spawn(list, max, pos, vel, q) {
    const o = list.length >= max ? list.shift() : { pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3() };
    o.pos.copy(pos);
    o.vel.copy(vel);
    if (q) o.q.copy(q);
    else o.q.setFromEuler(_e.set(rr(-0.3, 0.3), rr(0, Math.PI * 2), rr(-0.3, 0.3)));
    o.w.set(rr(-14, 14), rr(-8, 8), rr(-14, 14));
    o.rest = false;
    o.age = 0;
    o.chute = false;
    list.push(o);
    return o;
  }

  ejectCase(g) {
    // out of the rear door into the deflector, which turns it down the chute under the breech
    // casing; the trough and the tube through the carriage deliver it to the deck in front
    const L = this.layout;
    const p = this.toYaw(g.x + rr(-0.015, 0.015), L.chute.y, L.chute.z, new THREE.Vector3());
    const v = this.dirToYaw(rr(-0.15, 0.15), rr(-2.6, -2.0), rr(0.4, 0.9), new THREE.Vector3());
    _q.setFromEuler(_e.set(Math.PI / 2 - 0.3, 0, 0)).premultiply(this.gun.pitch.quaternion);
    const o = this.spawn(this.spent, SPENT, p, v, _q);
    o.w.set(rr(-3, 3), rr(-2, 2), rr(-2, 2));
    o.chute = true;
  }

  ejectClip(g, c) {
    // stripped: the rear rail throws the empty clip out through the clip slot in the side
    this.clipFrame(c.rounds[0].y, _a);
    const p = this.toYaw(g.x + g.side * 0.03, _a.py, _a.pz, new THREE.Vector3());
    const v = this.dirToYaw(g.side * rr(0.7, 1.1), rr(-0.2, 0.3), rr(-0.15, 0.15), new THREE.Vector3());
    _q.setFromEuler(_e.set(-_a.th, 0, 0)).premultiply(this.gun.pitch.quaternion);
    const o = this.spawn(this.clips, CLIPS, p, v, _q);
    o.side = g.side;
    this.dirToYaw(rr(-2, 2), rr(-3, 3), g.side * rr(-9, -4), o.w);
    for (const r of c.rounds) r.clip = null;
    this.audio?.clipOut(g.b);
  }

  update(dt) {
    if (dt <= 0) return this.render();
    this.t += dt;
    // gravity helps the column down less as the guns elevate; the feed pawls do the rest
    this.fall = 70 + 160 * Math.max(0, Math.cos(this.gun.pitch.rotation.x));
    this.supply(dt);
    for (const g of this.guns) {
      this.loader(g, dt);
      this.cycle(g, dt);
      this.column(g, dt);
    }
    this.physics(this.spent, dt, 0.029, 45);
    this.physics(this.clips, dt, 0.008, 40);
    this.render();
  }

  supply(dt) {
    // second loaders queue at the racks: whoever's first loader has waited longest gets the next clip
    const waiting = this.guns.filter((g) => g.loader.state === 'empty').sort((a, b) => b.loader.wait - a.loader.wait);
    for (const g of waiting) {
      if (this.rack <= 0) break;
      this.rack--;
      const ld = g.loader;
      ld.state = 'fetch';
      ld.wait = 0;
      // turn, take the clip, turn back: slower as he tires, and now and then a bad grip
      ld.t = rr(0.9, 1.4) * ld.skill * (1 + ld.fatigue * 0.25) + (Math.random() < 0.07 ? rr(0.4, 1.0) : 0);
    }
    // passers carry clips from the lockers to the racks; the hoist refills the lockers
    this.passT -= dt;
    if (this.passT <= 0 && this.rack < this.rackMax && this.lockers > 0) {
      this.rack++;
      this.lockers--;
      this.passT = rr(0.6, 0.95);
    }
    this.hoistT -= dt;
    if (this.hoistT <= 0 && this.lockers < this.lockersMax) {
      this.lockers++;
      this.hoistT = rr(1.4, 1.9);
    }
  }

  newClip(g) {
    return {
      phase: 'held',
      t: 0,
      dur: 0,
      // held ready at his chest, below and behind the feed lips (out of the player's sight),
      // never quite the same way twice
      hold: { x: rr(-0.03, 0.03), y: rr(-0.62, -0.52), z: rr(0.13, 0.2), rx: rr(0.1, 0.3), rz: rr(-0.15, 0.15) },
      // how far off he is as he brings it over the lips
      miss: { x: rr(-0.012, 0.012), z: rr(-0.018, 0.018), rx: rr(-0.07, 0.07), rz: rr(-0.07, 0.07) },
      rounds: null,
      landed: false,
      rattle: 0,
      sway: rr(0, 6.3),
    };
  }

  loader(g, dt) {
    const ld = g.loader;
    ld.fatigue = Math.max(0, ld.fatigue - dt * 0.01);
    if (ld.state === 'fetch') {
      ld.t -= dt;
      if (ld.t <= 0) {
        ld.state = 'ready';
        g.clip = this.newClip(g);
      }
    } else if (ld.state === 'empty') ld.wait += dt;
    const c = g.clip;
    if (!c) return;
    c.t += dt;
    c.rattle = Math.max(0, c.rattle - dt * 6);
    if (c.phase === 'held') {
      // he goes the moment there's room for four, give or take his reaction
      if (g.col.length <= this.cap - 4) {
        c.react ??= rr(0.04, 0.3) * ld.skill;
        c.react -= dt;
        if (c.react <= 0) {
          c.phase = 'swing';
          c.t = 0;
          c.dur = rr(...SWING) * ld.skill * (1 + ld.fatigue * 0.2);
          // a crooked clip catches in the lips and has to be rocked in; worse, its rounds jam
          // in the guides and have to be freed with the round-releasing tool and the pusher
          const u = Math.random();
          c.jam = u < 0.015 + ld.fatigue * 0.012;
          c.hang = !c.jam && u < 0.12 + ld.fatigue * 0.04;
          if (c.hang || c.jam) {
            c.miss.x *= 2.2;
            c.miss.rx *= 2;
            c.miss.rz *= 2.5;
          }
        }
      }
    } else if (c.phase === 'swing' && c.t >= c.dur) {
      c.phase = c.jam ? 'jam' : c.hang ? 'hang' : 'drop';
      c.t = 0;
      c.dur = c.jam ? rr(...JAM) * ld.skill : c.hang ? rr(...HANG) : 0;
      if (c.jam) this.audio?.clipIn(g.b);
    } else if ((c.phase === 'hang' || c.phase === 'jam') && c.t >= c.dur) {
      c.phase = 'drop';
      c.t = 0;
    }
    if (c.phase === 'drop') {
      // let go in the lips: the clip and its rounds fall down the guides onto the column
      const v = c.hang || c.jam ? rr(3, 6) : rr(0.5, 2);
      c.rounds = [];
      for (let i = 0; i < 4; i++) {
        const r = round(this.layout.lips + i, v, c);
        g.col.push(r);
        c.rounds.push(r);
      }
      c.phase = 'riding';
      c.rattle = 0.6;
      g.clip = null;
      ld.state = 'empty';
      ld.wait = 0;
      ld.fatigue += 0.05;
    }
  }

  cycle(g, dt) {
    if (g.cycle >= 0) {
      g.cycle += dt;
      // feed pawls: up the column in recoil, down in counterrecoil
      g.pawl = g.cycle < EJECT_AT ? g.cycle / EJECT_AT : Math.max(0, 1 - (g.cycle - EJECT_AT) / (FEED_AT + 0.05 - EJECT_AT));
      if (!g.ejected && g.cycle >= EJECT_AT) {
        g.ejected = true;
        this.ejectCase(g);
      }
      if (!g.fed && g.cycle >= FEED_AT) {
        g.fed = true;
        // the lowest round goes down through the star wheels onto the tray, and the pawls force
        // the column down after it
        if (g.col[0]?.clip) this.ejectClip(g, g.col[0].clip);
        const low = g.col.shift();
        if (low) g.drop = { r: low, y: low.y, v: PAWL_V * 0.6 };
        for (const r of g.col) r.v = Math.max(r.v, PAWL_V);
        g.starTo += Math.PI / 2;
      }
      if (g.fed && g.cycle >= FEED_AT + TRAY_TIME) {
        g.tray = true;
        g.cycle = -1;
      }
    } else g.pawl = 0;
    if (g.drop) {
      const d = g.drop;
      d.v += 400 * dt;
      d.y -= d.v * dt;
      if (d.y < -1.2) g.drop = null;
    }
    const ds = g.starTo - g.star;
    g.star += Math.sign(ds) * Math.min(Math.abs(ds), dt * 40);
  }

  column(g, dt) {
    // each round slides down the guides until it lies on the one below (the lowest on the star
    // wheels); a clip's rounds move together because they lie on each other
    let floor = 0;
    let floorV = 0;
    const knock = 1.5 + this.fall * dt * 2;
    for (const r of g.col) {
      r.v += this.fall * dt;
      r.y -= r.v * dt;
      if (r.y <= floor) {
        // rounds lying on each other stop dead together; the knock shows as a shake
        const hit = r.v - floorV;
        if (hit > knock) {
          r.rattle = Math.min(1, r.rattle + Math.min(0.8, hit * 0.05));
          const c = r.clip;
          if (c && !c.landed && r === c.rounds[0]) {
            c.landed = true;
            this.audio?.clipIn(g.b);
          }
        }
        r.v = floorV;
        r.y = floor;
      }
      r.rattle = Math.max(0, r.rattle - dt * 5);
      r.k = r.clip ? Math.max(0, r.k - dt * 10) : Math.min(1, r.k + dt * 10);
      floor = r.y + 1;
      floorV = r.v;
    }
    // a clip is fully stripped when its lowest round is two from the bottom
    for (const r of g.col) {
      const c = r.clip;
      if (c && r === c.rounds[0] && r.y <= 1.02) this.ejectClip(g, c);
    }
  }

  physics(list, dt, radius, life) {
    const L = this.layout;
    const K = L.carriage;
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      o.age += dt;
      if (o.age > life) {
        list.splice(i, 1);
        continue;
      }
      if (o.rest) continue;
      o.vel.y -= 9.8 * dt;
      o.pos.addScaledVector(o.vel, dt);
      _q.setFromAxisAngle(_v.copy(o.w).normalize(), o.w.length() * dt);
      o.q.premultiply(_q);
      const onCarriage = Math.abs(o.pos.x) < K.x && o.pos.z > K.z0 && o.pos.z < K.z1;
      if (o.chute && onCarriage && o.pos.y < K.y + 0.1) {
        // into the trough and through the carriage: out of the tube at the front, onto the deck
        o.chute = false;
        o.pos.set(o.pos.x, L.outlet.y, L.outlet.z);
        o.vel.set(rr(-0.2, 0.2), rr(-0.6, -0.2), -rr(0.6, 1.2));
        o.q.setFromEuler(_e.set(-0.4, rr(-0.3, 0.3), 0));
        o.w.set(rr(-8, -3), rr(-3, 3), rr(-3, 3));
        continue;
      }
      // the top of the carriage, the crew platform (r < 1.95, 0.42 m up) or the tub floor
      const floor = (onCarriage && !o.chute ? K.y : Math.hypot(o.pos.x, o.pos.z) < 1.92 ? 0.42 : 0) + radius;
      if (o.pos.y < floor) {
        o.pos.y = floor;
        if (Math.abs(o.vel.y) > 0.8) {
          // bounce and clatter
          o.vel.y *= -0.32;
          o.vel.x *= 0.6;
          o.vel.z *= 0.6;
          o.w.multiplyScalar(0.5);
        } else {
          o.rest = true;
          o.q.setFromEuler(_e.set(0, Math.random() * Math.PI * 2, 0));
          if (o.side) o.q.multiply(_q.setFromEuler(_e.set(0, 0, (o.side * Math.PI) / 2)));
        }
      }
    }
  }

  // a round's pose: on the guide arc, or square in its clip, shaking in the play of the guides
  roundMatrix(g, r, y, out = _m) {
    const L = this.layout;
    this.arc(y, _a);
    let { py, pz, th } = _a;
    if (r.k < 1 && r.clip) {
      const i = r.clip.rounds.indexOf(r);
      this.clipFrame(r.clip.rounds[0].y, _b);
      const cpy = _b.py + i * L.dy * Math.cos(_b.th);
      const cpz = _b.pz - i * L.dy * Math.sin(_b.th);
      const k = r.k;
      py = cpy + (py - cpy) * k;
      pz = cpz + (pz - cpz) * k;
      th = _b.th + (th - _b.th) * k;
    }
    const a = r.rattle;
    const t = this.t;
    _e.set(-th + a * 0.035 * Math.sin(t * r.f[0] + r.ph[0]), a * 0.03 * Math.sin(t * r.f[1] + r.ph[1]), 0);
    _q.setFromEuler(_e);
    _p.set(g.x + a * 0.002 * Math.sin(t * r.f[2] + r.ph[2]), py + a * a * 0.003 * Math.sin(t * r.f[0] * 1.3), pz);
    return out.compose(_p, _q, _s);
  }

  // a riding clip, square to the guides on its rounds
  ridingClipMatrix(g, c, out) {
    this.clipFrame(c.rounds[0].y, _a);
    const a = c.rounds[0].rattle;
    _e.set(-_a.th, 0, a * 0.04 * Math.sin(this.t * 47 + c.sway));
    _p.set(g.x + a * 0.002 * Math.sin(this.t * 53), _a.py, _a.pz);
    return out.compose(_p, _q.setFromEuler(_e), _s);
  }

  // a clip in the loader's hands: held ready, swung over the lips, rocked in or stuck crooked
  handClipMatrix(g, c, out) {
    const L = this.layout;
    this.clipFrame(L.lips, _a);
    const ease = (u) => u * u * (3 - 2 * u);
    const H = c.hold, M = c.miss;
    let x, y, z, rx, rz;
    if (c.phase === 'held') {
      const sway = Math.sin(this.t * 2.1 + c.sway) * 0.006;
      x = H.x;
      y = H.y + sway;
      z = H.z;
      rx = H.rx;
      rz = H.rz + sway * 2;
    } else if (c.phase === 'swing') {
      // lifted first, then brought forward over the lips
      const w = Math.min(1, c.t / c.dur);
      const u = ease(w);
      x = H.x + (M.x - H.x) * u;
      y = H.y + (0.025 - H.y) * (1 - (1 - w) ** 2) + Math.sin(w * Math.PI) * 0.04;
      z = H.z + (M.z - H.z) * w * w;
      rx = H.rx + (M.rx - H.rx) * u;
      rz = H.rz + (M.rz - H.rz) * u;
    } else if (c.phase === 'hang') {
      // caught crooked in the lips: rocked side to side until it lines up
      const u = Math.min(1, c.t / c.dur);
      const w = Math.sin(c.t * 34) * (1 - u);
      x = M.x * (1 - u) + w * 0.004;
      y = 0.025 * (1 - u);
      z = M.z * (1 - u);
      rx = M.rx * (1 - u);
      rz = M.rz * (1 - u) + w * 0.06;
    } else {
      // jammed part way into the guides: worked at with the tools in short hard jerks
      const u = Math.min(1, c.t / c.dur);
      const jerk = Math.max(0, Math.sin(c.t * 7)) ** 6 * Math.sin(c.t * 61);
      x = M.x * 0.6 + jerk * 0.004;
      y = -0.035 + jerk * 0.006;
      z = M.z * 0.6;
      rx = M.rx * 1.4 * (1 - u * u);
      rz = M.rz * 1.6 * (1 - u * u) + jerk * 0.05;
    }
    const k = c.rattle;
    rz += k * 0.03 * Math.sin(this.t * 47 + c.sway);
    // offsets are in the frame of the lips: y along the guides, z back along the rounds
    const cy = Math.cos(_a.th), sy = Math.sin(_a.th);
    _p.set(g.x + x, _a.py + y * cy + z * sy, _a.pz - y * sy + z * cy);
    _e.set(-_a.th + rx, 0, rz);
    return out.compose(_p, _q.setFromEuler(_e), _s);
  }

  render() {
    const L = this.layout;
    let n = 0;
    const nc = [0, 0];
    const put = (mat) => {
      this.feedCases.setMatrixAt(n, mat);
      this.feedShells.setMatrixAt(n, mat);
      n++;
    };
    const putClip = (side, mat) => {
      const k = (side + 1) / 2;
      this.feedClips[k].setMatrixAt(nc[k]++, mat);
    };
    let ns = 0;
    for (const g of this.guns) {
      for (const r of g.col) {
        put(this.roundMatrix(g, r, r.y));
        if (r.clip && r === r.clip.rounds[0]) putClip(g.side, this.ridingClipMatrix(g, r.clip, _cm));
      }
      // the round going down through the star wheels, until the tray takes it out of sight
      if (g.drop) put(this.roundMatrix(g, g.drop.r, g.drop.y));
      // the clip in the loader's hands
      const c = g.clip;
      if (c && this.manual) {
        this.handClipMatrix(g, c, _cm);
        putClip(g.side, _cm);
        for (let i = 0; i < 4; i++) put(_m.makeTranslation(0, i * L.dy, 0).premultiply(_cm));
      }
      // star wheels either side of the lowest case, counter-rotating a quarter turn a round
      for (const s of [-1, 1]) {
        _e.set(0, 0, s * g.star + Math.PI / 4);
        _p.set(g.x + s * 0.046, L.y0 - 0.014, L.z - 0.07);
        this.stars.setMatrixAt(ns, _m.compose(_p, _q.setFromEuler(_e), _s));
        // feed pawls in the side guides, riding up a round in recoil and forcing the column down
        this.arc(2.2 + g.pawl, _a);
        _p.set(g.x + s * 0.034, _a.py, _a.pz - 0.2 * Math.cos(_a.th));
        _e.set(-_a.th, 0, 0);
        this.pawls.setMatrixAt(ns, _m.compose(_p, _q.setFromEuler(_e), _s));
        ns++;
      }
    }
    this.feedCases.count = this.feedShells.count = n;
    this.feedClips[0].count = nc[0];
    this.feedClips[1].count = nc[1];
    this.stars.count = this.pawls.count = ns;
    for (const m of [this.feedCases, this.feedShells, ...this.feedClips, this.stars, this.pawls]) m.instanceMatrix.needsUpdate = true;

    // ready racks: full clips in the first `rack` slots
    let r = 0;
    for (let k = 0; k < this.rack; k++) {
      const slot = L.rackSlots[k];
      this.rackClips.setMatrixAt(k, slot);
      for (let i = 0; i < 4; i++) {
        _m.makeTranslation(0, i * L.dy, 0).premultiply(slot);
        this.rackCases.setMatrixAt(r, _m);
        this.rackShells.setMatrixAt(r, _m);
        r++;
      }
    }
    this.rackCases.count = this.rackShells.count = r;
    this.rackClips.count = this.rack;
    for (const m of [this.rackCases, this.rackShells, this.rackClips]) m.instanceMatrix.needsUpdate = true;

    this.spent.forEach((o, i) => this.spentMesh.setMatrixAt(i, _m.compose(o.pos, o.q, _s)));
    this.spentMesh.count = this.spent.length;
    this.spentMesh.instanceMatrix.needsUpdate = true;
    const nk = [0, 0];
    for (const o of this.clips) {
      const k = (o.side + 1) / 2;
      this.clipMesh[k].setMatrixAt(nk[k]++, _m.compose(o.pos, o.q, _s));
    }
    for (let k = 0; k < 2; k++) {
      this.clipMesh[k].count = nk[k];
      this.clipMesh[k].instanceMatrix.needsUpdate = true;
    }
  }

  /** This mount's ready racks and lockers, kept while the player is on another mount. */
  supplyState() {
    return { rack: this.rack, lockers: this.lockers };
  }

  /**
   * The player takes over a mount whose AI crew has kept it loaded: guides full, a round on
   * every tray, the loaders ready; the racks and lockers as that mount left them (`supply`).
   */
  takeOver(supply) {
    this.reset();
    if (supply) {
      this.rack = supply.rack;
      this.lockers = supply.lockers;
    }
  }

  /** Between raids the passers and the hoist catch up completely, and the loaders get a breather. */
  restock() {
    this.lockers = this.lockersMax;
    this.rack = this.rackMax;
    for (const g of this.guns) g.loader.fatigue *= 0.3;
  }

  /**
   * A fresh battle, loaded per the drill: the first clip pushed home puts a round on the tray and
   * three on the star wheels and is thrown out; a second clip sits on top. Each first loader
   * holds a third ready.
   */
  reset() {
    for (const g of this.guns) {
      g.col = [round(0), round(1), round(2)];
      const c = this.newClip(g);
      c.phase = 'riding';
      c.landed = true;
      c.rounds = [];
      for (let i = 0; i < 4; i++) {
        const r = round(3 + i, 0, c);
        g.col.push(r);
        c.rounds.push(r);
      }
      g.tray = true;
      g.cycle = -1;
      g.ejected = g.fed = true;
      g.drop = null;
      g.pawl = 0;
      g.clip = this.newClip(g);
      g.loader.state = 'ready';
      g.loader.t = 0;
      g.loader.wait = 0;
      g.loader.fatigue = 0;
    }
    this.spent.length = 0;
    this.clips.length = 0;
    this.restock();
  }
}
