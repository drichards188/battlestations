import * as THREE from 'three';
import * as YUKA from 'yuka';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ecs, queries } from './ecs.js';
import { GROUP, groups } from './physics.js';
import { patchMaterial, noiseGLSL } from './shaderlib.js';
import { mulberry32 } from './noise.js';

const MAX_SHADES = 8;
export const SANCTUARY = 24; // radius around the monument that shades never enter
const HUNT_RANGE = 34;
const MAX_HUNTERS = 2; // the rest of the pack stalks at a distance
const LOSE_RANGE = 48;
const HARE_WAKE_RADIUS = 260; // warrens farther than this from the camera sleep
const SHADE_BODY = { radius: 0.4, half: 0.5 };
const HARE_BODY = { radius: 0.17, half: 0.04 };

const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const dummy = new THREE.Object3D();
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------ steering

/**
 * Highest-priority steering for anything that walks the valley: turn away from
 * water ahead, climb out of it if already in, stay near home, and keep out of
 * a forbidden disc (the monument's sanctuary).
 */
class GroundBehavior extends YUKA.SteeringBehavior {
  constructor(terrain, { minHeight = 1, keepOut = null } = {}) {
    super();
    this.terrain = terrain;
    this.minHeight = minHeight;
    this.keepOut = keepOut;
    this.home = null;
    this.homeRadius = Infinity;
  }

  calculate(vehicle, force) {
    force.set(0, 0, 0);
    const p = vehicle.position, v = vehicle.velocity, T = this.terrain;
    const pull = vehicle.maxSpeed * 6;
    const sp = Math.hypot(v.x, v.z);
    if (sp > 0.05) {
      const look = 1.5 + sp * 0.7;
      const ax = p.x + (v.x / sp) * look, az = p.z + (v.z / sp) * look;
      if (T.getHeight(ax, az) < this.minHeight) {
        // the terrain normal's xz points downhill, so steer against it
        T.getNormal(ax, az, _n);
        force.x += -v.x * 3 - _n.x * pull;
        force.z += -v.z * 3 - _n.z * pull;
      }
    }
    if (T.getHeight(p.x, p.z) < this.minHeight) {
      T.getNormal(p.x, p.z, _n);
      force.x -= _n.x * pull * 2;
      force.z -= _n.z * pull * 2;
    }
    if (this.home) {
      const dx = this.home.x - p.x, dz = this.home.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > this.homeRadius) {
        force.x += (dx / d) * (d - this.homeRadius) * 2;
        force.z += (dz / d) * (d - this.homeRadius) * 2;
      }
    }
    const k = this.keepOut;
    if (k) {
      const dx = p.x - k.x, dz = p.z - k.z;
      const d = Math.hypot(dx, dz) || 1;
      const edge = k.r + 6;
      if (d < edge) {
        force.x += (dx / d) * (edge - d) * pull * 0.3;
        force.z += (dz / d) * (edge - d) * pull * 0.3;
      }
    }
    return force;
  }
}

/** A Vehicle that runs a state machine and stays flat on the ground. */
class Agent extends YUKA.Vehicle {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.brain = new YUKA.StateMachine(this);
    this.stateTime = 0;
    this.yaw = Math.random() * Math.PI * 2;
    this.behaviors = {};
  }

  /** Activate only the named behaviors, with the given weights. */
  use(weights) {
    for (const [name, b] of Object.entries(this.behaviors)) {
      if (name === 'ground') continue;
      const w = weights[name] || 0;
      b.active = w > 0;
      b.weight = w;
    }
  }

  go(state) {
    this.stateTime = 0;
    this.brain.changeTo(state);
  }

  is(...names) {
    const cur = this.brain.currentState;
    return names.some((n) => this.brain.states.get(n) === cur);
  }

  update(delta) {
    this.stateTime += delta;
    if (this.cooldown > 0) this.cooldown -= delta;
    this.brain.update();
    super.update(delta);
    this.velocity.y = 0;
    return this;
  }
}

const state = (fns) => {
  const s = new YUKA.State();
  if (fns.enter) s.enter = fns.enter;
  if (fns.execute) s.execute = fns.execute;
  if (fns.exit) s.exit = fns.exit;
  return s;
};

function setAsleep(e, asleep) {
  if (asleep && !e.asleep) {
    ecs.addComponent(e, 'asleep', true);
    e.body.rb.setEnabled(false);
  } else if (!asleep && e.asleep) {
    ecs.removeComponent(e, 'asleep');
    e.body.rb.setEnabled(true);
  }
}

function teleport(e, x, y, z) {
  e.body.rb.setTranslation({ x, y: y + e.body.lift, z }, true);
  e.body.vy = 0;
  e.position.set(x, y, z);
  e.agent.position.set(x, y, z);
  e.agent.velocity.set(0, 0, 0);
}

// ------------------------------------------------------------------ shades

function nearestLight(pos, lights, margin) {
  let best = null, bestK = Infinity;
  for (const l of lights) {
    const d = Math.hypot(pos.x - l.pos.x, pos.z - l.pos.z);
    const k = d - (l.r + margin);
    if (k < 0 && k < bestK) {
      bestK = k;
      best = l;
    }
  }
  return best;
}

const shadeStates = {
  dormant: state({
    enter(a) {
      a.use({});
      a.velocity.set(0, 0, 0);
      a.fade = 0;
      setAsleep(a.entity, true);
    },
  }),
  emerge: state({
    enter(a) {
      a.use({});
      a.fade = 0;
      setAsleep(a.entity, false);
    },
    execute(a) {
      a.fade = Math.min(a.stateTime / 1.8, 1);
      if (a.stateTime > 1.8) a.go('prowl');
    },
  }),
  prowl: state({
    enter(a) {
      a.maxSpeed = 2.8;
      a.use({ seek: 1, wander: 0.6, separation: 1 });
      a.retarget = 0;
    },
    execute(a) {
      const c = a.ctx, me = a.position;
      const focus = c.player ? c.player.pos : c.camera;
      a.retarget -= c.dt;
      if (a.retarget <= 0) {
        // drift toward wherever the player is, loosely
        a.retarget = 3 + Math.random() * 3;
        const ang = Math.random() * Math.PI * 2;
        a.behaviors.seek.target.set(focus.x + Math.cos(ang) * 12, me.y, focus.z + Math.sin(ang) * 12);
      }
      const d = Math.hypot(focus.x - me.x, focus.z - me.z);
      if (c.player?.huntable && d < HUNT_RANGE && a.cooldown <= 0 && c.huntSlots > 0) {
        c.huntSlots--;
        a.go('hunt');
      }
      else if (d > 170) a.go('fade');
    },
  }),
  hunt: state({
    enter(a) {
      a.maxSpeed = 5.0;
      a.use({ pursuit: 1, wander: 0.1, separation: 2.5 });
    },
    execute(a) {
      const p = a.ctx.player, me = a.position;
      if (!p || !p.huntable) return a.go('prowl');
      const d = Math.hypot(p.pos.x - me.x, p.pos.z - me.z);
      if (d > LOSE_RANGE) a.go('prowl');
      else if (d < 2.8) a.go('attack');
    },
  }),
  attack: state({
    enter(a) {
      a.use({});
      a.lunge = null;
    },
    execute(a) {
      const p = a.ctx.player, me = a.position;
      if (!p || !p.huntable) return a.go('retreat');
      if (a.stateTime < 0.4) {
        // wind up: stop and swell
        a.velocity.multiplyScalar(0.8);
        a.burn = Math.max(a.burn, a.stateTime / 0.4);
      } else if (a.stateTime < 0.8) {
        if (!a.lunge) {
          const dx = p.pos.x - me.x, dz = p.pos.z - me.z, d = Math.hypot(dx, dz) || 1;
          a.lunge = { x: dx / d, z: dz / d };
          a.maxSpeed = 12;
        }
        a.velocity.set(a.lunge.x * 12, 0, a.lunge.z * 12);
        if (Math.hypot(p.pos.x - me.x, p.pos.z - me.z) < 1.7) {
          a.ctx.onHit?.(a.entity);
          a.go('retreat');
        }
      } else a.go('retreat');
    },
  }),
  retreat: state({
    enter(a) {
      a.maxSpeed = 4;
      a.use({ flee: 1, wander: 0.2, separation: 1 });
      a.behaviors.flee.panicDistance = 40;
      a.cooldown = 4 + Math.random() * 4;
    },
    execute(a) {
      const p = a.ctx.player;
      if (p) a.behaviors.flee.target.set(p.pos.x, a.position.y, p.pos.z);
      if (a.stateTime > 2.6) a.go('prowl');
    },
  }),
  flee: state({
    enter(a) {
      a.maxSpeed = 6.5;
      a.use({ flee: 1, wander: 0.15 });
    },
    execute(a) {
      const l = nearestLight(a.position, a.ctx.lights, 5);
      a.burn = Math.max(a.burn, 0.4);
      if (l) {
        a.behaviors.flee.target.set(l.pos.x, a.position.y, l.pos.z);
        a.behaviors.flee.panicDistance = l.r + 8;
      } else if (a.stateTime > 1.2) a.go('prowl');
    },
  }),
  fade: state({
    enter(a) {
      a.use({});
      a.velocity.multiplyScalar(0.3);
    },
    execute(a) {
      a.fade -= a.ctx.dt * a.fadeRate;
      if (a.fade <= 0) {
        a.respawnIn = a.banished ? 16 + Math.random() * 8 : 3 + Math.random() * 4;
        a.banished = false;
        a.fadeRate = 0.7;
        a.go('dormant');
      }
    },
  }),
};

// light overrides hunting: anything that can move flees out of it
const shadeGlobal = state({
  execute(a) {
    if (!a.is('prowl', 'hunt', 'retreat', 'attack')) return;
    if (nearestLight(a.position, a.ctx.lights, 3)) a.go('flee');
  },
});

function shadeGeometry() {
  // a hooded, cloaked figure turned on a lathe, open at the hem
  const prof = [
    [0.56, 0], [0.5, 0.25], [0.4, 0.7], [0.33, 1.1], [0.37, 1.45], [0.34, 1.6],
    [0.22, 1.72], [0.25, 1.85], [0.245, 2.0], [0.16, 2.16], [0.0, 2.32],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(prof, 20);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = THREE.MathUtils.smoothstep(y, 1.7, 2.32);
    pos.setZ(i, pos.getZ(i) + k * 0.13); // hood leans forward
  }
  geo.computeVertexNormals();
  return geo;
}

function shadeMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x07060c, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  m.defines = { SKIP_WET: '' };
  patchMaterial(m, 'shade', (shader) => {
    shader.uniforms.uShadeRim = { value: new THREE.Color(0.32, 0.2, 0.95) };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute vec4 aShade; // phase, fade, burn, lean
        uniform float uTime;
        varying vec4 vShade;
        varying vec2 vShadeUV;`
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          float sh = clamp(position.y / 2.32, 0.0, 1.0);
          float low = (1.0 - sh) * (1.0 - sh);
          float ang = atan(position.z, position.x);
          float ph = aShade.x;
          // the robe billows, and trails behind when moving
          transformed.xz *= 1.0 + 0.18 * low * sin(uTime * 2.6 + ang * 3.0 + ph);
          transformed.x += sin(uTime * 1.9 + position.y * 2.8 + ph) * 0.07 * low;
          transformed.z += cos(uTime * 1.6 + position.y * 2.2 + ph * 1.3) * 0.08 * low - aShade.w * 0.5 * low;
          transformed.y += aShade.w * 0.12 * low;
          vShade = aShade;
          vShadeUV = vec2(ang, sh);
        }`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uTime;
        uniform vec3 uShadeRim;
        varying vec4 vShade;
        varying vec2 vShadeUV;
        ${noiseGLSL}`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        /* glsl */ `#include <clipping_planes_fragment>
        {
          vec2 ring = vec2(cos(vShadeUV.x), sin(vShadeUV.x)) * 1.6;
          float n = vnoise(ring + vec2(vShadeUV.y * 6.0 - uTime * 1.3, vShade.x));
          if (vShadeUV.y < 0.25 && n > vShadeUV.y * 4.0 + 0.1) discard; // tattered hem
          float d = vnoise(ring * 2.0 + vec2(vShadeUV.y * 11.0, vShade.x * 7.0));
          if (d > vShade.y * 1.15 - 0.05) discard; // dissolve in and out
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          float rim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.5);
          totalEmissiveRadiance += uShadeRim * rim * (0.35 + 0.65 * vShadeUV.y) * (1.2 + vShade.z * 6.0);
        }`
      );
  });
  return m;
}

// ------------------------------------------------------------------ hares

const hareStates = {
  graze: state({
    enter(a) {
      a.use({});
      a.until = 2 + Math.random() * 5;
    },
    execute(a) {
      a.velocity.multiplyScalar(0.85);
      if (a.stateTime > a.until) a.go('hop');
    },
  }),
  hop: state({
    enter(a) {
      a.maxSpeed = 2.2;
      a.use({ wander: 1, separation: 1.2, cohesion: 0.25 });
      a.until = 1.5 + Math.random() * 3;
    },
    execute(a) {
      if (a.stateTime > a.until) a.go('graze');
    },
  }),
  flee: state({
    enter(a) {
      a.maxSpeed = 8.5;
      a.use({ flee: 1, separation: 0.8 });
    },
    execute(a) {
      const t = a.threat;
      if (t) a.behaviors.flee.target.set(t.x, a.position.y, t.z);
      if (!t && a.stateTime > 1) a.go('hop');
    },
  }),
  burrow: state({
    enter(a) {
      a.maxSpeed = 4;
      a.use({ arrive: 1 });
      a.behaviors.arrive.target.set(a.warren.x, a.position.y, a.warren.z);
    },
    execute(a) {
      if (Math.hypot(a.position.x - a.warren.x, a.position.z - a.warren.z) < 1.5 || a.stateTime > 25) a.go('hidden');
    },
  }),
  hidden: state({
    enter(a) {
      a.use({});
      a.velocity.set(0, 0, 0);
      setAsleep(a.entity, true);
    },
    execute(a) {
      if (a.ctx.night < 0.35) {
        const ang = Math.random() * Math.PI * 2, r = Math.random() * 4;
        const x = a.warren.x + Math.cos(ang) * r, z = a.warren.z + Math.sin(ang) * r;
        setAsleep(a.entity, false);
        teleport(a.entity, x, a.ctx.terrain.getHeight(x, z), z);
        a.go('graze');
      }
    },
  }),
};

const hareGlobal = state({
  execute(a) {
    if (a.is('hidden')) return;
    a.threat = null;
    const c = a.ctx, me = a.position;
    if (c.player) {
      const panic = c.player.sprint ? 15 : 8;
      if (Math.hypot(c.player.pos.x - me.x, c.player.pos.z - me.z) < panic) a.threat = c.player.pos;
    }
    for (const s of c.shadePositions) if (Math.hypot(s.x - me.x, s.z - me.z) < 16) a.threat = s;
    for (const o of c.orbPositions) if (Math.hypot(o.x - me.x, o.z - me.z) < 3) a.threat = o;
    if (a.threat && !a.is('flee')) {
      a.behaviors.flee.panicDistance = 30;
      a.go('flee');
    } else if (!a.threat && c.night > 0.6 && !a.is('burrow')) a.go('burrow');
  },
});

function hareGeometry() {
  const fur = new THREE.Color(0.36, 0.27, 0.19), pale = new THREE.Color(0.86, 0.83, 0.78);
  const dark = new THREE.Color(0.02, 0.015, 0.015), pink = new THREE.Color(0.55, 0.34, 0.3);
  const part = (color, sx, sy, sz, x, y, z, rx = 0) => {
    const g = new THREE.SphereGeometry(1, 12, 9);
    g.scale(sx, sy, sz);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    const c = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < c.length; i += 3) c.set([color.r, color.g, color.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  return mergeGeometries([
    part(fur, 0.15, 0.14, 0.22, 0, 0.18, -0.02), // body
    part(fur, 0.13, 0.13, 0.12, 0, 0.14, -0.12), // haunches
    part(fur, 0.085, 0.085, 0.1, 0, 0.3, 0.17), // head
    part(pale, 0.05, 0.05, 0.05, 0, 0.2, -0.23), // tail
    part(fur, 0.026, 0.11, 0.016, 0.035, 0.42, 0.12, -0.35), // ears
    part(fur, 0.026, 0.11, 0.016, -0.035, 0.42, 0.12, -0.35),
    part(dark, 0.018, 0.018, 0.018, 0.055, 0.32, 0.22), // eyes
    part(dark, 0.018, 0.018, 0.018, -0.055, 0.32, 0.22),
    part(pink, 0.016, 0.014, 0.012, 0, 0.29, 0.265), // nose
  ]);
}

// ------------------------------------------------------------------ creatures

/**
 * Shades (hostile wraiths) and hares (skittish herds), each an ECS entity
 * with a Yuka vehicle for a brain and a Rapier character controller for a
 * body. Shades come out with the dark, hunt the walking player, lunge to
 * drain their light and flee from light orbs; hares graze, hop, scatter from
 * the player and from shades, and burrow at night.
 */
export class Creatures {
  constructor(scene, terrain, physics, { onHit, onBanish } = {}) {
    this.terrain = terrain;
    this.physics = physics;
    this.onBanish = onBanish;
    const rand = (this.rand = mulberry32(77));

    this.ctx = {
      dt: 0, t: 0, terrain, night: 0, player: null, camera: new THREE.Vector3(),
      lights: [], shadePositions: [], orbPositions: [], onHit,
    };
    // Yuka entity the shades pursue (mirrors the player each frame)
    this.quarry = new YUKA.MovingEntity();
    this.quarry.maxSpeed = 20;

    this.kcc = { shade: physics.controller({ climb: 55, step: 0.5 }), hare: physics.controller({ climb: 50, step: 0.25, snap: 0.4 }) };
    // Controllers only collide with the world: creatures that start a move
    // touching each other can wedge, so their spacing comes from steering
    // (separation) instead, and orbs are light enough to be shoved aside.
    this.kcc.shade.filterGroups = this.kcc.hare.filterGroups = groups(GROUP.CREATURE, GROUP.WORLD);

    this.shadeManager = new YUKA.EntityManager();
    this.hareManager = new YUKA.EntityManager();
    this.shades = [];
    this.hares = [];
    this.colliders = []; // {x, z, r} of awake creatures for the player controller
    this.dread = 0;
    this.spawnTimer = 0;
    this.banishedAll = false;

    // ---- shades
    this.shadeMesh = new THREE.InstancedMesh(shadeGeometry(), shadeMaterial(), MAX_SHADES);
    this.shadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHADES * 4), 4);
    this.shadeAttr.setUsage(THREE.DynamicDrawUsage);
    this.shadeMesh.geometry.setAttribute('aShade', this.shadeAttr);
    this.shadeMesh.frustumCulled = false;
    this.shadeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.shadeMesh);

    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.28, 0.85).multiplyScalar(5) });
    patchMaterial(eyeMat, 'shade-eyes');
    const eyeGeo = new THREE.SphereGeometry(0.035, 8, 6);
    eyeGeo.scale(1.5, 0.6, 1);
    this.eyeMesh = new THREE.InstancedMesh(eyeGeo, eyeMat, MAX_SHADES * 2);
    this.eyeMesh.frustumCulled = false;
    this.eyeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.eyeMesh);

    for (let i = 0; i < MAX_SHADES; i++) {
      const a = new Agent(this.ctx);
      a.maxForce = 16;
      a.fade = 0;
      a.burn = 0;
      a.fadeRate = 0.7;
      a.respawnIn = i * 1.5;
      a.phase = rand() * 50;
      a.cooldown = 0;
      a.updateNeighborhood = true;
      a.neighborhoodRadius = 4;
      const ground = new GroundBehavior(terrain, { minHeight: 0.6, keepOut: { x: 0, z: 0, r: SANCTUARY } });
      a.behaviors = {
        ground,
        flee: new YUKA.FleeBehavior(new YUKA.Vector3(), 20),
        pursuit: new YUKA.PursuitBehavior(this.quarry, 0.8),
        seek: new YUKA.SeekBehavior(new YUKA.Vector3()),
        separation: new YUKA.SeparationBehavior(),
        wander: new YUKA.WanderBehavior(2, 4, 6),
      };
      for (const b of Object.values(a.behaviors)) a.steering.add(b);
      for (const [id, s] of Object.entries(shadeStates)) a.brain.add(id, s);
      a.brain.globalState = shadeGlobal;
      const e = ecs.add({ kind: 'shade', agent: a, position: new THREE.Vector3(0, -400, 0), body: physics.createAgentBody(new THREE.Vector3(0, -400, 0), SHADE_BODY), index: i });
      a.entity = e;
      a.go('dormant');
      this.shadeManager.add(a);
      this.shades.push(e);
    }

    // ---- hares
    const warrens = this.findWarrens(rand, 4);
    const perWarren = 7;
    const count = warrens.length * perWarren;
    const hareMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    patchMaterial(hareMat, 'hare');
    this.hareMesh = new THREE.InstancedMesh(hareGeometry(), hareMat, count);
    this.hareMesh.castShadow = true;
    this.hareMesh.receiveShadow = true;
    this.hareMesh.frustumCulled = false;
    this.hareMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.hareMesh);

    warrens.forEach((w, wi) => {
      for (let k = 0; k < perWarren; k++) {
        const a = new Agent(this.ctx);
        a.maxForce = 30;
        a.warren = w;
        a.hop = rand();
        a.phase = rand() * 50;
        a.size = 0.85 + rand() * 0.35; // not `scale`: that is Yuka's own transform
        a.updateNeighborhood = true;
        a.neighborhoodRadius = 3;
        const ground = new GroundBehavior(terrain, { minHeight: 1.2 });
        ground.home = w;
        ground.homeRadius = 28;
        a.behaviors = {
          ground,
          flee: new YUKA.FleeBehavior(new YUKA.Vector3(), 30),
          arrive: new YUKA.ArriveBehavior(new YUKA.Vector3(), 2, 0.5),
          separation: new YUKA.SeparationBehavior(),
          cohesion: new YUKA.CohesionBehavior(),
          wander: new YUKA.WanderBehavior(1.2, 2.5, 8),
        };
        for (const b of Object.values(a.behaviors)) a.steering.add(b);
        for (const [id, s] of Object.entries(hareStates)) a.brain.add(id, s);
        a.brain.globalState = hareGlobal;
        const ang = rand() * Math.PI * 2, r = 2 + rand() * 8;
        const p = new THREE.Vector3(w.x + Math.cos(ang) * r, 0, w.z + Math.sin(ang) * r);
        p.y = terrain.getHeight(p.x, p.z);
        a.position.copy(p);
        const e = ecs.add({ kind: 'hare', agent: a, position: p, body: physics.createAgentBody(p, HARE_BODY), index: wi * perWarren + k });
        a.entity = e;
        a.go('graze');
        this.hareManager.add(a);
        this.hares.push(e);
      }
    });
  }

  /** Open, gently sloped meadow spots for hare warrens, not too far from the start. */
  findWarrens(rand, count) {
    const out = [];
    for (let tries = 0; tries < 4000 && out.length < count; tries++) {
      const ang = rand() * Math.PI * 2, r = 45 + rand() * 170;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      const h = this.terrain.getHeight(x, z);
      this.terrain.getNormal(x, z, _n);
      if (h < 3 || h > 45 || _n.y < 0.93) continue;
      if (out.some((w) => Math.hypot(w.x - x, w.z - z) < 60)) continue;
      out.push(new THREE.Vector3(x, h, z));
    }
    return out;
  }

  get shadeCount() {
    return this.shades.filter((e) => !e.agent.is('dormant')).length;
  }

  /** Pick a spawn point out of sight, on land, away from the sanctuary. */
  spawnPoint(focus, forward) {
    const camYaw = Math.atan2(forward.x, forward.z);
    for (let tries = 0; tries < 40; tries++) {
      const ang = camYaw + Math.PI + (this.rand() - 0.5) * (tries < 20 ? 2.4 : 6.2);
      const r = 45 + this.rand() * 45;
      const x = focus.x + Math.sin(ang) * r, z = focus.z + Math.cos(ang) * r;
      if (Math.hypot(x, z) < SANCTUARY + 10 || Math.abs(x) > 760 || Math.abs(z) > 760) continue;
      const h = this.terrain.getHeight(x, z);
      if (h < 1.2) continue;
      this.terrain.getNormal(x, z, _n);
      if (_n.y < 0.75) continue;
      return _p.set(x, h, z);
    }
    return null;
  }

  /**
   * AI step. `state`: { player: {pos, vel, sprint, huntable} | null,
   * camera, forward, night, threat (0..1), lights: [{pos, r}] }.
   */
  think(dt, t, state) {
    const c = this.ctx;
    c.dt = dt;
    c.t = t;
    c.night = state.night;
    c.player = state.player;
    c.camera.copy(state.camera);
    c.lights = state.lights;
    if (dt <= 0) return;
    if (state.player) {
      this.quarry.position.copy(state.player.pos);
      this.quarry.velocity.copy(state.player.vel);
    }

    // ---- shade population follows the threat level
    const want = this.banishedAll ? 0 : Math.round(MAX_SHADES * THREE.MathUtils.clamp(state.threat, 0, 1));
    const live = this.shades.filter((e) => !e.agent.is('dormant', 'fade'));
    this.spawnTimer -= dt;
    for (const e of this.shades) if (e.agent.is('dormant')) e.agent.respawnIn -= dt;
    if (live.length < want && this.spawnTimer <= 0) {
      const e = this.shades.find((s) => s.agent.is('dormant') && s.agent.respawnIn <= 0);
      const focus = state.player ? state.player.pos : state.camera;
      const p = e && this.spawnPoint(focus, state.forward);
      if (p) {
        teleport(e, p.x, p.y, p.z);
        e.agent.go('emerge');
        this.spawnTimer = 1.5 + this.rand() * 2;
      }
    } else if (live.length > want) {
      const focus = state.player ? state.player.pos : state.camera;
      live.sort((a, b) => b.position.distanceToSquared(focus) - a.position.distanceToSquared(focus));
      live[0].agent.go('fade');
    }

    // a direct hit from a moving orb banishes a shade
    for (const o of queries.orbs) {
      const v = o.body.rb.linvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z < 9) continue;
      for (const e of this.shades) {
        const a = e.agent;
        if (a.fade < 0.5 || a.is('fade', 'dormant')) continue;
        _p.copy(e.position).y += 1.3;
        if (_p.distanceTo(o.position) < 1.4) this.banish(e);
      }
    }

    c.shadePositions.length = 0;
    for (const e of this.shades) if (e.agent.fade > 0.5) c.shadePositions.push(e.position);
    c.orbPositions.length = 0;
    for (const o of queries.orbs) c.orbPositions.push(o.position);

    // hares far from the camera sleep (their warrens stay put)
    for (const e of this.hares) {
      const a = e.agent;
      const far = Math.hypot(a.warren.x - state.camera.x, a.warren.z - state.camera.z) > HARE_WAKE_RADIUS;
      a.active = !far;
      if (!a.is('hidden')) setAsleep(e, far);
    }

    c.huntSlots = MAX_HUNTERS - this.shades.filter((e) => e.agent.is('hunt', 'attack')).length;
    this.shadeManager.update(dt);
    this.hareManager.update(dt);

    // feedback for the loop: how close is the nearest menacing shade
    let dread = 0;
    this.hunting = false;
    if (state.player) {
      for (const e of this.shades) {
        const a = e.agent;
        if (a.fade <= 0) continue;
        const d = e.position.distanceTo(state.player.pos);
        const menace = a.is('hunt', 'attack') ? 1 : 0.45;
        dread = Math.max(dread, THREE.MathUtils.clamp(1 - d / 45, 0, 1) * menace * a.fade);
        if (a.is('hunt')) this.hunting = true;
      }
    }
    this.dread += (dread - this.dread) * (1 - Math.exp(-dt * 3));

    // dynamic colliders the player controller pushes against
    this.colliders.length = 0;
    for (const e of this.shades) if (e.agent.fade > 0.3) this.colliders.push({ x: e.position.x, z: e.position.z, r: 0.45 });
    for (const e of this.hares) if (!e.asleep) this.colliders.push({ x: e.position.x, z: e.position.z, r: 0.18 });
  }

  banish(e) {
    const a = e.agent;
    a.burn = 1;
    a.banished = true;
    a.fadeRate = 1.8;
    a.go('fade');
    this.onBanish?.(e.position.clone().setY(e.position.y + 1.3));
  }

  /** The finale drives every shade out for good. */
  banishAll() {
    this.banishedAll = true;
    for (const e of this.shades) if (!e.agent.is('dormant', 'fade')) this.banish(e);
  }

  /** Send shades near a point away (used when the player respawns). */
  scatter(pos, radius) {
    for (const e of this.shades) {
      if (e.agent.is('dormant', 'fade')) continue;
      if (e.position.distanceTo(pos) < radius) e.agent.go('fade');
    }
  }

  render(dt, t) {
    // ---- shades
    const attr = this.shadeAttr.array;
    for (const e of this.shades) {
      const a = e.agent, i = e.index;
      a.burn = Math.max(0, a.burn - dt * 1.2);
      if (a.fade <= 0.001) {
        _m.makeScale(0, 0, 0);
        this.shadeMesh.setMatrixAt(i, _m);
        this.eyeMesh.setMatrixAt(i * 2, _m);
        this.eyeMesh.setMatrixAt(i * 2 + 1, _m);
        attr[i * 4 + 1] = 0;
        continue;
      }
      const sp = Math.hypot(a.velocity.x, a.velocity.z);
      if (sp > 0.3) a.yaw += wrapAngle(Math.atan2(a.velocity.x, a.velocity.z) - a.yaw) * (1 - Math.exp(-dt * 6));
      const rise = a.is('emerge', 'fade') ? (1 - a.fade) * -1.4 : 0;
      const swell = a.is('attack') && a.stateTime < 0.4 ? 1 + a.stateTime * 0.3 : 1;
      dummy.position.copy(e.position);
      dummy.position.y += 0.25 + Math.sin(t * 1.5 + a.phase) * 0.12 + rise;
      dummy.rotation.set(0, a.yaw, 0);
      dummy.scale.set(1, swell, 1);
      dummy.updateMatrix();
      this.shadeMesh.setMatrixAt(i, dummy.matrix);
      attr[i * 4] = a.phase;
      attr[i * 4 + 1] = a.fade;
      attr[i * 4 + 2] = a.burn;
      attr[i * 4 + 3] = Math.min(sp / 6, 1);
      const eye = a.fade > 0.4 ? 1 : 0;
      for (const side of [0, 1]) {
        _p.set(side ? 0.075 : -0.075, 1.93, 0.29).applyMatrix4(dummy.matrix);
        _q.setFromAxisAngle(_up, a.yaw);
        _m.compose(_p, _q, _s.setScalar(eye));
        this.eyeMesh.setMatrixAt(i * 2 + side, _m);
      }
    }
    this.shadeMesh.instanceMatrix.needsUpdate = true;
    this.eyeMesh.instanceMatrix.needsUpdate = true;
    this.shadeAttr.needsUpdate = true;

    // ---- hares: a hop arc tied to distance travelled
    for (const e of this.hares) {
      const a = e.agent, i = e.index;
      if (e.asleep) {
        _m.makeScale(0, 0, 0);
        this.hareMesh.setMatrixAt(i, _m);
        continue;
      }
      const sp = Math.hypot(a.velocity.x, a.velocity.z);
      if (sp > 0.2) a.yaw += wrapAngle(Math.atan2(a.velocity.x, a.velocity.z) - a.yaw) * (1 - Math.exp(-dt * 10));
      if (sp > 0.15) a.hop += dt * (1.6 + sp * 0.55);
      else a.hop += (Math.round(a.hop) - a.hop) * (1 - Math.exp(-dt * 8)); // settle between hops
      const arc = Math.abs(Math.sin(a.hop * Math.PI));
      const amp = Math.min(sp / 2, 1);
      dummy.position.copy(e.position);
      dummy.position.y += arc * (0.12 + 0.18 * amp) * amp;
      const graze = a.is('graze') ? Math.max(0, Math.sin(t * 0.7 + a.phase * 3 + i)) * 0.25 : 0;
      dummy.rotation.set(Math.cos(a.hop * Math.PI) * -0.3 * amp + graze, a.yaw, 0, 'YXZ');
      dummy.scale.setScalar(a.size);
      dummy.updateMatrix();
      this.hareMesh.setMatrixAt(i, dummy.matrix);
    }
    this.hareMesh.instanceMatrix.needsUpdate = true;
  }
}
