import * as THREE from 'three';
import { ecs, queries } from './ecs.js';
import { glowTexture } from './quest.js';
import { WATER_LEVEL } from './terrain.js';

const MAX_ORBS = 6;
const LIFE = 30;
const LIGHT_RADIUS = 11; // shades keep out of this
const RADIUS = 0.2;
const RECHARGE = 4.5; // seconds per charge
const COLOR = new THREE.Color(1, 0.72, 0.42);

/**
 * Throwable light orbs: Rapier balls that bounce down slopes, float on the
 * lake and light the dark. Each is an ECS entity with a `light` component,
 * which is what shades flee from. A small pool of point lights follows the
 * orbs nearest the camera (the light count must stay fixed, or three would
 * recompile every lit shader).
 */
export class LightOrbs {
  constructor(scene, physics, { lights = 2 } = {}) {
    this.physics = physics;
    this.maxCharges = 3;
    this.charges = this.maxCharges;
    this.recharge = 0;

    const tex = glowTexture();
    const coreGeo = new THREE.IcosahedronGeometry(RADIUS * 0.8, 2);
    this.pool = [];
    for (let i = 0; i < MAX_ORBS; i++) {
      const group = new THREE.Group();
      const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: COLOR.clone().multiplyScalar(12), fog: false }));
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, color: COLOR.clone().multiplyScalar(3), blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      );
      group.add(core, halo);
      group.visible = false;
      scene.add(group);
      this.pool.push({ group, core, halo, entity: null });
    }
    this.lights = [];
    for (let i = 0; i < lights; i++) {
      const l = new THREE.PointLight(COLOR, 0, 18, 2);
      scene.add(l);
      this.lights.push(l);
    }
  }

  get count() {
    return queries.orbs.entities.length;
  }

  /** Throw from `origin` along `dir`, adding the thrower's velocity. Returns false when out of charges. */
  throw(origin, dir, inherit) {
    if (this.charges < 1) return false;
    this.charges--;
    let slot = this.pool.find((s) => !s.entity);
    if (!slot) {
      // recycle the oldest orb
      slot = this.pool.reduce((a, b) => (a.entity.life < b.entity.life ? a : b));
      this.remove(slot.entity);
    }
    const body = this.physics.createBall(origin, { radius: RADIUS, restitution: 0.45 });
    body.rb.setLinvel({ x: dir.x * 17 + inherit.x, y: dir.y * 17 + 1.5 + Math.max(inherit.y, 0), z: dir.z * 17 + inherit.z }, true);
    body.rb.setAngvel({ x: Math.random() * 4 - 2, y: 0, z: Math.random() * 4 - 2 }, true);
    slot.entity = ecs.add({
      kind: 'orb',
      body,
      position: origin.clone(),
      light: LIGHT_RADIUS,
      life: LIFE,
      age: 0,
      slot,
      lastVel: new THREE.Vector3(),
      wet: false,
    });
    slot.group.visible = true;
    return true;
  }

  remove(e) {
    this.physics.remove(e.body);
    e.slot.group.visible = false;
    e.slot.entity = null;
    ecs.remove(e);
  }

  /** Lifetime, buoyancy, bounce/splash events, visuals and the light pool. */
  update(dt, t, camera, { onBounce, onSplash } = {}) {
    if (this.charges < this.maxCharges) {
      this.recharge += dt / RECHARGE;
      if (this.recharge >= 1) {
        this.recharge = 0;
        this.charges++;
      }
    } else this.recharge = 0;

    const v = new THREE.Vector3();
    for (const e of [...queries.orbs]) {
      e.life -= dt;
      e.age += dt;
      const k = THREE.MathUtils.clamp(e.life / 2.5, 0, 1); // burn out over the last seconds
      e.light = LIGHT_RADIUS * k;
      if (e.life <= 0 || e.position.y < -80) {
        this.remove(e);
        continue;
      }
      const rb = e.body.rb;
      const lv = rb.linvel();
      v.set(lv.x, lv.y, lv.z);
      const dv = v.distanceTo(e.lastVel);
      if (dv > 2.5 && e.age > 0.1 && dt > 0) onBounce?.(e.position, Math.min(dv / 14, 1));
      e.lastVel.copy(v);

      // float: buoyancy grows with depth (it balances gravity 0.8 radii
      // under) and heavy water drag settles the bobbing
      const depth = WATER_LEVEL - (e.position.y - RADIUS);
      if (depth > 0) {
        if (!e.wet && v.y < -2) onSplash?.(e.position, Math.min(-v.y / 12, 1));
        e.wet = true;
        rb.setGravityScale(1 - 2.5 * Math.min(depth / (2 * RADIUS), 1), true);
        rb.setLinearDamping(6);
      } else if (e.wet) {
        e.wet = false;
        rb.setGravityScale(1, true);
        rb.setLinearDamping(0.05);
      }

      const s = e.slot;
      s.group.position.copy(e.position);
      s.core.scale.setScalar(0.3 + 0.7 * k);
      s.halo.scale.setScalar(2.4 * k * (1 + 0.08 * Math.sin(t * 9 + e.age)));
    }

    // point lights go to the orbs nearest the camera
    const live = [...queries.orbs].sort((a, b) => a.position.distanceToSquared(camera.position) - b.position.distanceToSquared(camera.position));
    this.lights.forEach((l, i) => {
      const e = live[i];
      if (!e) {
        l.intensity = 0;
        return;
      }
      l.position.copy(e.position);
      l.intensity = 22 * THREE.MathUtils.clamp(e.life / 2.5, 0, 1) * (1 + 0.06 * Math.sin(t * 13 + i));
    });
  }
}
