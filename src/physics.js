import { TERRAIN_SIZE, TERRAIN_SEGMENTS } from './terrain.js';

// Collision groups: the high 16 bits say what a collider is, the low 16 bits
// what it collides with. Both sides of a pair have to agree.
export const GROUP = { WORLD: 1, CREATURE: 2, ORB: 4 };
export const groups = (member, filter) => (member << 16) | filter;

// Rapier's WASM build is large, so it lives in its own chunk. loadRapier() is
// called at startup so the download overlaps world generation.
let RAPIER = null;
let loading = null;
export function loadRapier() {
  loading ||= import('@dimforge/rapier3d-compat').then(async (m) => {
    await m.default.init();
    return (RAPIER = m.default);
  });
  return loading;
}

/**
 * Rapier world for everything that moves physically: creatures (kinematic
 * character controllers) and thrown light orbs (dynamic). The player keeps
 * its own hand-tuned controller in player.js and is kept out of creatures
 * through `player.dynamicColliders`.
 */
export class Physics {
  static async create(terrain, opts) {
    await loadRapier();
    return new Physics(terrain, opts);
  }

  constructor(terrain, { colliders = [], discs = [] } = {}) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const world = this.world;
    const worldGroups = groups(GROUP.WORLD, 0xffff);

    // Rapier's heightfield is column-major with rows along z; the terrain grid
    // is row-major with z rows, so transpose it. The triangle diagonal then
    // matches the rendered mesh and physics agrees with getHeight to the mm.
    const N = TERRAIN_SEGMENTS, n = N + 1;
    const heights = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) heights[iz + ix * n] = terrain.heights[iz * n + ix];
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.heightfield(N, N, heights, { x: TERRAIN_SIZE, y: 1, z: TERRAIN_SIZE })
        .setFriction(0.9)
        .setCollisionGroups(worldGroups),
      ground
    );

    // Static props. Trunks and standing stones are tall cylinders, rocks and
    // underwater boulders are spheres sized to the visible stone.
    for (const c of colliders) {
      const h = terrain.getHeight(c.x, c.z);
      let desc;
      if (c.top !== undefined) {
        desc = RAPIER.ColliderDesc.ball(c.r).setTranslation(c.x, c.top - c.r, c.z);
      } else if (c.kind === 'rock') {
        desc = RAPIER.ColliderDesc.ball(c.r).setTranslation(c.x, h - c.r * 0.31, c.z);
      } else {
        const half = (c.height ?? 9) / 2;
        desc = RAPIER.ColliderDesc.cylinder(half, c.r).setTranslation(c.x, h - 1 + half, c.z);
      }
      world.createCollider(desc.setFriction(0.7).setCollisionGroups(worldGroups), ground);
    }
    // raised floors (the monument plateau)
    for (const d of discs) {
      const half = 2;
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(half, d.r).setTranslation(d.x ?? 0, d.top - half, d.z ?? 0).setFriction(0.8).setCollisionGroups(worldGroups),
        ground
      );
    }

    world.step(); // build the broad phase so queries work before the first frame
  }

  /** Character controller shared by every creature of one kind. */
  controller({ climb = 50, step = 0.4, snap = 0.5 } = {}) {
    const kcc = this.world.createCharacterController(0.02);
    kcc.setUp({ x: 0, y: 1, z: 0 });
    kcc.setMaxSlopeClimbAngle((climb * Math.PI) / 180);
    kcc.setMinSlopeSlideAngle(((climb - 8) * Math.PI) / 180);
    kcc.enableAutostep(step, 0.15, false);
    kcc.enableSnapToGround(snap);
    kcc.setSlideEnabled(true);
    kcc.setApplyImpulsesToDynamicBodies(true);
    kcc.setCharacterMass(3);
    return kcc;
  }

  /** A capsule creature body with its feet at `pos`. */
  createAgentBody(pos, { radius, half }) {
    const lift = half + radius;
    const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y + lift, pos.z));
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(half, radius).setCollisionGroups(groups(GROUP.CREATURE, GROUP.WORLD | GROUP.CREATURE | GROUP.ORB)),
      rb
    );
    return { rb, col, lift, vy: 0, grounded: false };
  }

  createBall(pos, { radius, restitution = 0.4, friction = 0.8, density = 1.2 }) {
    const rb = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setCcdEnabled(true).setAngularDamping(0.8).setLinearDamping(0.05)
    );
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.ball(radius)
        .setRestitution(restitution)
        .setFriction(friction)
        .setDensity(density)
        .setCollisionGroups(groups(GROUP.ORB, GROUP.WORLD | GROUP.CREATURE | GROUP.ORB)),
      rb
    );
    return { rb, col };
  }

  remove(body) {
    this.world.removeRigidBody(body.rb);
  }

  step(dt) {
    if (dt <= 0) return;
    // The rest of the game runs on a variable timestep, so physics does too.
    this.world.timestep = Math.min(Math.max(dt, 1 / 240), 1 / 30);
    this.world.step();
  }
}
