import * as THREE from 'three';

// The opening: General Quarters. The player is below decks when the general alarm goes; he and
// his shipmates run up through the ship ("up and forward to starboard"), through the watertight
// doors and up the inclined ladders, out onto the deck and up to Mount 47, where the battle
// begins. The camera rides the route (free mouse-look); Space skips it.
//
// The route and the interior set come from models/interior.js, the running crew from
// models/runners.js. Everything here is in the player's ship's space, so it moves and rolls
// with the ship.

const clamp = THREE.MathUtils.clamp;
const rr = (a, b) => a + (b - a) * Math.random();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _t = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();
const _fr = new THREE.Frustum();
const _sp = new THREE.Sphere(new THREE.Vector3(), 1);

// how fast men move along each kind of stretch (m/s; the route's own speeds take precedence)
const SPEED = { start: 2.2, walk: 3.4, door: 1.3, hatch: 0.8, ladder: 0.95, exit: 2.4, deck: 4.0, tub: 1.4 };
const STRIDE = 1.35;

// what the bosun's mate and the men call as they go; times in seconds from the alarm (the 1MC
// recording's gong runs to 3.6 s, then the call)
const CALLS = [
  [4.3, 'General quarters, general quarters. All hands man your battle stations.', 'info'],
  [7, 'Up and forward to starboard! Make a hole!', 'warn'],
  [22.5, 'Set condition Zebra throughout the ship.', 'info'],
];
// the bosun's mate repeats the call while the crew are still on their way
const REPEAT_AT = 15.5;

export class GeneralQuarters {
  constructor({ ship, camera, audio, hud }) {
    this.ship = ship;
    this.camera = camera;
    this.audio = audio;
    this.hud = hud;
    this.active = false;
    this.events = { done: null };
    this.look = { yaw: 0, pitch: 0 };
    this.interior = null;
    this.runners = null;
    addEventListener('mousemove', (e) => {
      if (!this.active || !document.pointerLockElement) return;
      this.look.yaw = clamp(this.look.yaw - e.movementX * 0.0025, -1.3, 1.3);
      this.look.pitch = clamp(this.look.pitch - e.movementY * 0.0025, -0.9, 0.9);
    });
    addEventListener('keydown', (e) => {
      if (this.active && e.code === 'Space') {
        e.preventDefault();
        this.skip();
      }
    });
  }

  /** Attach the interior set and the crew (built elsewhere); without the set the sequence is skipped. */
  setup(interior, runners) {
    this.interior = interior;
    this.runners = runners;
    if (interior) {
      // the outside pieces (the ladder up to the sponson) are part of the ship from now on
      this.ship.group.add(interior.group);
      interior.inside.visible = false;
      const P = interior.path;
      this.curve = new THREE.CatmullRomCurve3(P.map((w) => w.p), false, 'centripetal', 0.5);
      this.feetCurve = new THREE.CatmullRomCurve3(P.map((w) => w.feet), false, 'centripetal', 0.5);
      // distance along the route at each waypoint (polyline), for speeds and tags
      this.cum = [0];
      for (let i = 1; i < P.length; i++) this.cum.push(this.cum[i - 1] + P[i].p.distanceTo(P[i - 1].p));
      this.length = this.cum[this.cum.length - 1];
      this.ladderFeet = Object.values(interior.ladders || {}).filter((i) => Number.isInteger(i)).sort((a, b) => a - b);
    }
    if (runners) {
      runners.group.visible = false;
      // drawn with the interior so the men show through the hatches and the weather door
      const order = interior?.renderOrder?.interior ?? -3;
      runners.group.traverse((o) => {
        if (o.isMesh) o.renderOrder = order;
      });
      this.ship.group.add(runners.group);
    }
  }

  get available() {
    return !!(this.interior && this.curve);
  }

  // the waypoint index whose stretch contains distance s
  seg(s) {
    const c = this.cum;
    let i = 0;
    while (i < c.length - 2 && c[i + 1] <= s) i++;
    return i;
  }

  // a point along the route at distance s, on the eye line (or the floor with `feet`)
  at(s, out, feet = false) {
    s = clamp(s, 0, this.length);
    const i = this.seg(s);
    const span = this.cum[i + 1] - this.cum[i] || 1;
    const u = (i + (s - this.cum[i]) / span) / (this.cum.length - 1);
    (feet ? this.feetCurve : this.curve).getPoint(u, out);
    return i;
  }

  tag(i) {
    return this.interior.path[i]?.tag || 'walk';
  }

  speed(i) {
    const w = this.interior.path[i];
    return w?.speed ?? SPEED[w?.tag] ?? SPEED.walk;
  }

  start() {
    if (!this.available) {
      this.events.done?.();
      return false;
    }
    this.active = true;
    this.t = 0;
    this.s = 0;
    this.phase = 0;
    this.calls = 0;
    this.repeated = false;
    this.blend = -1;
    this.look.yaw = this.look.pitch = 0;
    this.inside = true;
    this.interior.inside.visible = true;
    for (const d of [...(this.interior.doors || []), ...(this.interior.hatches || [])]) {
      d.object.rotation[d.axis || 'y'] = d.closedAngle ?? 0;
      d.opened = false;
      d.t = 0;
    }
    // tight spaces: let the camera's near plane in close, and put it back afterwards
    this.near = this.camera.near;
    this.camera.near = 0.08;
    this.camera.updateProjectionMatrix();
    this.audio.setInterior?.(true);
    // the crew: most ahead of the player, a few behind; each keeps his own pace and lane
    const R = this.runners;
    this.crew = [];
    if (R) {
      R.group.visible = true;
      const n = R.count ?? 12;
      // the men ahead are out of their racks along the berthing aisle (the rest are already through
      // the door and up the first ladder); the men behind turn out once the player is past them.
      // The ones ahead are a shade quicker than the player, so the gaps open as they go
      const ahead = Math.round(n * 0.7);
      for (let k = 0; k < n; k++) {
        const front = k < ahead;
        const j = ahead - 1 - k;
        this.crew.push({
          s: front ? (j < 5 ? 2.4 + j * rr(1.45, 1.65) : 10 + (j - 5) * rr(1.8, 2.2)) : 0,
          behind: !front,
          delay: front ? rr(0.2, 0.8) : 3.2 + (k - ahead) * rr(0.9, 1.4),
          pace: front ? rr(1.02, 1.14) : rr(0.95, 1.1),
          lane: (k % 2 ? 1 : -1) * rr(0.1, 0.3),
          done: false,
        });
      }
    }
    this.audio.alarm?.();
    return true;
  }

  skip() {
    if (!this.active) return;
    this.finish();
  }

  finish() {
    this.active = false;
    this.interior.inside.visible = false;
    if (this.runners) this.runners.group.visible = false;
    this.camera.near = this.near ?? 0.3;
    this.camera.updateProjectionMatrix();
    this.audio.setInterior?.(false);
    this.hud.radio('Mount four-seven manned and ready.', 'info');
    this.events.done?.();
  }

  /**
   * One frame. `toGun(camera)` places the camera on the player's gun (the gunner's eye) so the
   * last moments can blend into it. Returns false once the sequence is over.
   */
  update(dt, toGun) {
    if (!this.active) return false;
    this.t += dt;
    while (this.calls < CALLS.length && this.t >= CALLS[this.calls][0]) {
      const [, text, kind] = CALLS[this.calls++];
      this.hud.radio(text, kind);
    }
    if (!this.repeated && this.t >= REPEAT_AT) {
      this.repeated = true;
      this.audio.gqRepeat?.();
    }
    // the player follows a beat behind the alarm, at the pace of the stretch he is on
    if (this.t > 1.6 && this.blend < 0) {
      const i = this.seg(this.s);
      const v = this.speed(i);
      const before = this.phase;
      // he can't run up the back of the man in front (further back on a ladder)
      const climbing = this.tag(i) === 'ladder' || this.tag(i) === 'hatch';
      let cap = this.length;
      for (const c of this.crew || []) if (!c.done && c.away == null && c.s > this.s && this.t > c.delay) cap = Math.min(cap, c.s - (climbing ? 3.4 : 2.2));
      this.s = Math.min(this.length, Math.max(this.s, Math.min(cap, this.s + v * dt)));
      this.phase = (this.phase + (v * dt) / STRIDE) % 1;
      // a footfall twice a stride
      if (Math.floor(before * 2) !== Math.floor(this.phase * 2) || this.phase < before) {
        const tag = this.tag(i);
        this.audio.footstep?.(tag === 'ladder' || tag === 'hatch' ? 'ladder' : 'deck', this.inside ? 1 : 0.7);
      }
      if (this.inside && (this.tag(i) === 'exit' || this.tag(i) === 'deck')) {
        this.inside = false;
        this.audio.setInterior?.(false);
      }
      if (this.s >= this.length - 0.05) this.blend = 0;
    }
    this.doors(dt);
    this.moveCrew(dt);
    this.placeCamera(dt, toGun);
    return this.active;
  }

  // watertight doors and hatches swing open as the first man comes up to them
  doors(dt) {
    let lead = this.s;
    for (const c of this.crew || []) if (this.t > c.delay) lead = Math.max(lead, c.s);
    for (const d of [...(this.interior.doors || []), ...(this.interior.hatches || [])]) {
      const at = this.cum[clamp(d.approachIndex ?? (d.pathIndex ?? 0), 0, this.cum.length - 1)];
      if (!d.opened && lead > at - (d.approachIndex != null ? 0 : 2.2)) {
        d.opened = true;
        d.t = 0;
        this.audio.doorClang?.(d.hatch ? 0.8 : 1);
      }
      if (d.opened && d.t < 1) {
        d.t = Math.min(1, d.t + dt / 0.45);
        const k = 1 - Math.pow(1 - d.t, 3);
        const a0 = d.closedAngle ?? 0, a1 = d.openAngle ?? Math.PI / 2;
        d.object.rotation[d.axis || 'y'] = a0 + (a1 - a0) * k;
      }
    }
  }

  // the ladder foot a man at waypoint stretch i is climbing from
  ladderFoot(i) {
    let foot = null;
    for (const l of this.ladderFeet) if (l <= i) foot = l;
    return foot != null ? this.interior.path[foot].feet : null;
  }

  moveCrew(dt) {
    const R = this.runners;
    if (!R) return;
    const P = this.interior.path;
    // out of the weather door the other men go their own ways to their stations, and drop out
    // once the player can't see them (last frame's view)
    const peel = this.interior.peel;
    const peelS = peel ? this.cum[peel.at] : Infinity;
    _m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_m);
    // everyone keeps a little room from the man in front of him
    const order = this.crew.filter((c) => !c.done && c.away == null).sort((a, b) => b.s - a.s);
    this.crew.forEach((c, k) => {
      const end = this.length - 1.2;
      if (c.away != null && !c.done) {
        c.away += SPEED.walk * c.pace * dt;
        const u = Math.min(1, c.away / 1.5);
        _f.copy(peel.dir).multiplyScalar(c.away).add(P[peel.at].feet);
        _f.x += peel.dir.z * c.lane * 1.5 * u;
        _f.z -= peel.dir.x * c.lane * 1.5 * u;
        _sp.center.set(_f.x, _f.y + 1, _f.z).applyMatrix4(this.ship.group.matrixWorld);
        if (c.away > peel.length || (c.away > 2 && !_fr.intersectsSphere(_sp))) c.done = true;
        else {
          // he swings round onto the new heading over his first couple of strides
          const h1 = Math.atan2(-peel.dir.x, -peel.dir.z);
          let dh = h1 - c.h0;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          R.set(k, { position: _f, heading: c.h0 + dh * u, state: 'run', ladderBase: null, door: null, visible: true });
          return;
        }
      }
      if (this.t > c.delay && !c.done) {
        const i = this.seg(Math.max(0, c.s));
        const v = this.speed(i) * c.pace;
        const j = order.indexOf(c);
        const front = j > 0 ? order[j - 1].s - 1.4 : Infinity;
        // men behind don't run up the player's back
        const cap = c.behind ? this.s - 1.8 : Infinity;
        c.s = Math.max(c.s, Math.min(end, peelS, cap, front, c.s + v * dt));
        if (c.s >= peelS) {
          c.away = 0;
          this.at(peelS - 0.4, _a, true);
          this.at(peelS, _t, true);
          c.h0 = Math.atan2(-(_t.x - _a.x), -(_t.z - _a.z));
        } else if (c.s >= end) c.done = true;
      }
      const hidden = c.done || (c.behind && (this.t <= c.delay || c.s < 0.3));
      if (hidden) {
        R.set(k, { visible: false, state: 'hidden' });
        return;
      }
      const s = Math.max(0, c.s);
      const i = this.at(s, _f, true);
      this.at(s + 0.4, _a, true);
      _t.subVectors(_a, _f);
      const tag = this.tag(i);
      const climbing = tag === 'ladder' || tag === 'hatch';
      const heading = Math.atan2(-_t.x, -_t.z);
      // keep to a lane where the space allows (never on a ladder)
      const half = Math.max(0, (P[i]?.half ?? 0) - 0.18);
      const lane = climbing ? 0 : clamp(c.lane, -half, half);
      _f.x += Math.cos(heading) * lane;
      _f.z -= Math.sin(heading) * lane;
      let state = 'run';
      if (this.t <= c.delay) state = 'idle';
      else if (c.s > end - 2.5) state = 'arrive';
      else if (climbing) state = 'climb';
      else if (tag === 'door') state = 'duck';
      // the crowd advances each man's gait from how far he moved, so feet stay planted; on a
      // ladder and through a door it is driven by the ladder's foot and the door's sill
      const door = tag === 'door' ? P[this.interior.doors?.[P[i].door]?.pathIndex ?? i]?.feet : null;
      R.set(k, {
        position: _f,
        heading,
        state,
        ladderDir: climbing ? _t.clone().normalize() : undefined,
        ladderBase: climbing ? this.ladderFoot(i) : null,
        door: door || null,
        visible: true,
      });
    });
    R.update(dt);
  }

  placeCamera(dt, toGun) {
    const cam = this.camera;
    const i = this.at(this.s, _p);
    // look 1.6 m along the route (the last 1.6 m keep the final stretch's direction)
    const s0 = Math.min(this.s, this.length - 1.6);
    this.at(s0 + 1.6, _a);
    this.at(s0, _t);
    _t.subVectors(_a, _t);
    // and at the end, turn to where the waypoint says to look (the gun)
    const look = this.interior.path[this.cum.length - 1]?.look;
    if (look) _t.normalize().lerp(look, THREE.MathUtils.smoothstep(this.s, this.length - 2.5, this.length));
    const tag = this.tag(i);
    const climbing = tag === 'ladder' || tag === 'hatch';
    // head bob: up and down twice a stride, a sway once, steadier on a ladder
    const moving = this.t > 1.6 && this.s < this.length - 0.05;
    const b = moving ? (climbing ? 0.4 : 1) : 0;
    const ph = this.phase * Math.PI * 2;
    _p.y += Math.abs(Math.sin(ph)) * 0.035 * b - 0.015 * b;
    const heading = Math.atan2(-_t.x, -_t.z);
    _p.x += Math.cos(heading) * Math.sin(ph) * 0.018 * b;
    _p.z -= Math.sin(heading) * Math.sin(ph) * 0.018 * b;
    // look along the route (half the ladder's steepness: a man looks at the treads ahead of him),
    // then wherever the player turns his head
    const pitch = Math.atan2(_t.y, Math.hypot(_t.x, _t.z)) * (climbing ? 0.5 : 0.7);
    _e.set(pitch + this.look.pitch, heading + this.look.yaw, Math.sin(ph) * 0.008 * b);
    _q.setFromEuler(_e);
    // into world space with the ship
    this.ship.group.updateMatrixWorld();
    const wp = _p.applyMatrix4(this.ship.group.matrixWorld);
    _q.premultiply(this.ship.group.getWorldQuaternion(_q2));
    if (this.blend >= 0) {
      // step up into the tub and onto the gun
      this.blend = Math.min(1, this.blend + dt / 1.2);
      const k = this.blend * this.blend * (3 - 2 * this.blend);
      toGun(cam);
      cam.position.lerpVectors(wp, cam.position, k);
      _q2.copy(cam.quaternion);
      cam.quaternion.copy(_q).slerp(_q2, k);
      cam.updateMatrixWorld();
      if (this.blend >= 1) this.finish();
      return;
    }
    cam.position.copy(wp);
    cam.quaternion.copy(_q);
    cam.updateMatrixWorld();
  }
}
