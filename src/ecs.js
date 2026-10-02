import { World } from 'miniplex';

/**
 * One registry for everything that thinks or moves physically. Entities are
 * plain objects; a system is a loop over a query of the components it needs.
 *
 *   kind      'shade' | 'hare' | 'orb'
 *   position  THREE.Vector3, feet (agents) or centre (orbs), written after the physics step
 *   body      { rb, col, lift, vy, grounded } from Physics
 *   agent     Yuka Vehicle that steers the entity
 *   asleep    present while the entity is parked (no AI, no physics)
 *   light     radius of light the entity casts (shades keep out of it)
 *   life      seconds left before an orb burns out
 */
export const ecs = new World();

export const queries = {
  agents: ecs.with('agent', 'body', 'position').without('asleep'),
  shades: ecs.with('kind', 'agent').where((e) => e.kind === 'shade'),
  hares: ecs.with('kind', 'agent').where((e) => e.kind === 'hare'),
  orbs: ecs.with('kind', 'body', 'position').where((e) => e.kind === 'orb'),
  lights: ecs.with('light', 'position'),
};

const GRAVITY = 20;
const desired = { x: 0, y: 0, z: 0 };

/**
 * Turn each agent's steering into a physical move: Yuka has already advanced
 * the vehicle, and the character controller slides that step along trees,
 * rocks, slopes and other creatures.
 */
export function motorSystem(physics, dt, kcc) {
  if (dt <= 0) return;
  for (const e of queries.agents) {
    const b = e.body, v = e.agent;
    b.vy = b.grounded ? -2 : Math.max(b.vy - GRAVITY * dt, -30);
    desired.x = v.position.x - e.position.x;
    desired.y = b.vy * dt;
    desired.z = v.position.z - e.position.z;
    if (!Number.isFinite(desired.x + desired.z)) {
      // a degenerate steering result would freeze the body for good; reset it
      v.position.copy(e.position);
      v.velocity.set(0, 0, 0);
      continue;
    }
    const ctrl = kcc[e.kind];
    ctrl.computeColliderMovement(b.col, desired, 0, ctrl.filterGroups);
    const m = ctrl.computedMovement();
    b.grounded = ctrl.computedGrounded();
    const p = b.rb.translation();
    b.rb.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
  }
}

/** Copy physics results back into entity positions and Yuka vehicles. */
export function syncSystem() {
  for (const e of queries.agents) {
    const p = e.body.rb.translation();
    e.position.set(p.x, p.y - e.body.lift, p.z);
    e.agent.position.copy(e.position);
  }
  for (const e of queries.orbs) {
    const p = e.body.rb.translation();
    e.position.set(p.x, p.y, p.z);
  }
}

/** Light sources in the world as {pos, r}, for creatures that fear light. */
export function collectLights(extra = []) {
  const out = extra.slice();
  for (const e of queries.lights) if (e.light > 0) out.push({ pos: e.position, r: e.light });
  return out;
}
