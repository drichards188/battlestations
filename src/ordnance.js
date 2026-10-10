import * as THREE from 'three';
import { buildOrdnance, createOrdnanceMaterial } from './models/aircraft.js';

const G = 9.81;
const TORPEDO_SPEED = 21; // Type 91, ~41 knots
const TORPEDO_RANGE = 2600;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const FWD = new THREE.Vector3(0, 0, -1);

// Bombs and torpedoes in flight, and torpedoes running toward the ships.
export class Ordnance {
  constructor(scene, { fx, audio, ocean }) {
    this.fx = fx;
    this.audio = audio;
    this.ocean = ocean;
    this.bombs = [];
    this.torpedoes = [];
    this.events = { bombHit: null, nearMiss: null, torpedoHit: null, torpedoLaunched: null };
    const mat = createOrdnanceMaterial();
    this.bombMesh = new THREE.InstancedMesh(buildOrdnance('bomb'), mat, 64);
    this.torpMesh = new THREE.InstancedMesh(buildOrdnance('torpedo'), mat, 64);
    for (const m of [this.bombMesh, this.torpMesh]) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
  }

  clear() {
    this.bombs.length = 0;
    this.torpedoes.length = 0;
  }

  dropBomb(pos, vel, plane) {
    const b = { pos: pos.clone(), vel: vel.clone(), from: plane?.type, whistled: false };
    this.bombs.push(b);
  }

  dropTorpedo(pos, vel, dir, plane) {
    this.torpedoes.push({ pos: pos.clone(), vel: vel.clone(), dir: dir.clone(), running: false, run: 0, from: plane?.type, prev: new THREE.Vector3() });
  }

  update(dt, fleet, camera) {
    // bombs
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.vel.y -= G * dt;
      b.vel.multiplyScalar(1 - 0.02 * dt);
      b.pos.addScaledVector(b.vel, dt);
      if (!b.whistled && b.pos.y < 420) {
        b.whistled = true;
        this.audio.whistle(b.pos, Math.max(1.5, b.pos.y / Math.max(-b.vel.y, 30)));
      }
      const ship = fleet.shipAt(b.pos, 1);
      if (ship) {
        this.events.bombHit?.(ship, b.pos.clone());
        this.bombs.splice(i, 1);
        continue;
      }
      if (b.pos.y <= 0) {
        b.pos.y = 0;
        const near = fleet.nearestShip(b.pos);
        this.events.nearMiss?.(b.pos.clone(), near.ship, near.dist);
        this.bombs.splice(i, 1);
      }
    }

    // torpedoes: fall, enter the water, then run straight at depth
    for (let i = this.torpedoes.length - 1; i >= 0; i--) {
      const t = this.torpedoes[i];
      if (!t.running) {
        t.vel.y -= G * dt;
        t.vel.multiplyScalar(1 - 0.05 * dt);
        t.pos.addScaledVector(t.vel, dt);
        if (t.pos.y <= 0) {
          t.running = true;
          t.pos.y = -2.5;
          this.fx.splash(_v.set(t.pos.x, 0, t.pos.z), 0.3);
          this.audio.splash(t.pos, 0.35);
          this.ocean.stamp(t.pos.x, t.pos.z, t.pos.x, t.pos.z, 8, 1, 1, 0.3);
          t.prev.copy(t.pos);
          this.events.torpedoLaunched?.(t);
        }
        continue;
      }
      t.prev.copy(t.pos);
      t.pos.addScaledVector(t.dir, TORPEDO_SPEED * dt);
      t.run += TORPEDO_SPEED * dt;
      // the bubble track trails a little behind the torpedo itself
      this.ocean.stamp(t.prev.x - t.dir.x * 25, t.prev.z - t.dir.z * 25, t.pos.x - t.dir.x * 25, t.pos.z - t.dir.z * 25, 1.6, 0.55, 0.7, 0.1);
      if (t.run > 200) {
        const ship = fleet.shipAt(_v.set(t.pos.x, -2, t.pos.z), 0.5);
        if (ship) {
          this.events.torpedoHit?.(ship, new THREE.Vector3(t.pos.x, 0, t.pos.z));
          this.torpedoes.splice(i, 1);
          continue;
        }
      }
      if (t.run > TORPEDO_RANGE) this.torpedoes.splice(i, 1);
    }
    this.render();
  }

  /** Running torpedoes, for the ships' lookouts. */
  get running() {
    return this.torpedoes.filter((t) => t.running);
  }

  render() {
    let n = 0;
    for (const b of this.bombs) {
      _q.setFromUnitVectors(FWD, _v.copy(b.vel).normalize());
      _m.compose(b.pos, _q, _s);
      this.bombMesh.setMatrixAt(n++, _m);
    }
    this.bombMesh.count = n;
    this.bombMesh.instanceMatrix.needsUpdate = true;
    n = 0;
    for (const t of this.torpedoes) {
      if (t.running) continue;
      _v.copy(t.vel).normalize();
      _v.y *= 0.4;
      _q.setFromUnitVectors(FWD, _v.normalize());
      _m.compose(t.pos, _q, _s);
      this.torpMesh.setMatrixAt(n++, _m);
    }
    this.torpMesh.count = n;
    this.torpMesh.instanceMatrix.needsUpdate = true;
  }

  static get torpedoSpeed() {
    return TORPEDO_SPEED;
  }
}
