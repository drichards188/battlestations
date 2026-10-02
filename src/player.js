import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { WATER_LEVEL, PLATEAU_HEIGHT } from './terrain.js';

const EYE = 1.7;
const SWIM_DEPTH = 1.35; // water deeper than this and you swim
const tmp = new THREE.Vector3();

export class Player {
  constructor(camera, dom, terrain, { colliders = [], groundOverride } = {}) {
    this.camera = camera;
    this.terrain = terrain;
    this.colliders = colliders;
    this.dynamicColliders = []; // creatures, refreshed every frame
    this.groundOverride = groundOverride;
    this.controls = new PointerLockControls(camera, dom);
    this.mode = 'cinematic';
    this.velocity = new THREE.Vector3();
    this.feet = new THREE.Vector3(0, -1000, 0);
    this.onGround = false;
    this.swimming = false;
    this.keys = {};
    this.bob = 0;
    this.lastStepSign = 1;
    this.landDip = 0;
    this.landVel = 0;
    this.fovOffset = 0;
    this.handlers = {};
    this.shots = this.buildShots();
    this.shotIndex = 0;
    this.shotT = 0;
    this.fade = 0;
    this.focus = 20;

    addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyF' && (this.mode === 'walk' || this.mode === 'fly')) this.mode = this.mode === 'fly' ? 'walk' : 'fly';
    });
    addEventListener('keyup', (e) => (this.keys[e.code] = false));
    addEventListener('blur', () => (this.keys = {}));
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }
  emit(name, ...args) {
    this.handlers[name]?.(...args);
  }

  groundAt(x, z) {
    let h = this.terrain.getHeight(x, z);
    if (this.groundOverride) h = Math.max(h, this.groundOverride(x, z));
    return h;
  }

  surfaceAt(x, z) {
    if (Math.hypot(x, z) < 16) return 'stone';
    if (this.terrain.getHeight(x, z) < WATER_LEVEL + 0.05) return 'water';
    return 'grass';
  }

  startExploring() {
    if (this.mode === 'cinematic') this.respawn();
    this.controls.lock();
  }

  /** Stand at the foot of the monument, facing the crystal. */
  respawn() {
    this.feet.set(-11, 0, 3);
    this.feet.y = this.groundAt(this.feet.x, this.feet.z);
    this.camera.position.copy(this.feet).y += EYE;
    this.camera.lookAt(0, this.feet.y + 4, 0);
    this.velocity.set(0, 0, 0);
    this.mode = 'walk';
  }

  /** Shove the player (a shade's blow). */
  knockback(x, z, up) {
    this.velocity.x += x;
    this.velocity.z += z;
    this.velocity.y = Math.max(this.velocity.y, up);
    this.onGround = false;
  }

  setCinematic() {
    this.mode = 'cinematic';
    this.shotT = 0;
    this.controls.unlock();
  }

  setPhoto(on) {
    if (on) {
      this.prevMode = this.mode === 'photo' ? this.prevMode : this.mode;
      this.mode = 'photo';
      this.velocity.set(0, 0, 0);
    } else {
      this.mode = this.prevMode === 'cinematic' ? 'fly' : this.prevMode || 'walk';
      if (this.mode === 'walk') {
        // drop back to wherever the photo camera ended up
        this.feet.set(this.camera.position.x, this.groundAt(this.camera.position.x, this.camera.position.z), this.camera.position.z);
      }
    }
  }

  // ------------------------------------------------------------------ cinematic shots

  buildShots() {
    const g = (x, z) => Math.max(this.groundAt(x, z), WATER_LEVEL);
    const crystal = new THREE.Vector3(0, PLATEAU_HEIGHT + 5.2, 0);
    return [
      {
        // skimming the lake into the low sun
        dur: 11,
        at: (k) => ({
          pos: new THREE.Vector3(40 + k * 60, 3.5 + k * 1.5, 25 - k * 25),
          look: new THREE.Vector3(170, 8 - k * 2, -60),
          focus: 60,
        }),
      },
      {
        // drifting through the kelp forest under the lake, toward the drop-off
        dur: 13,
        at: (k) => ({
          pos: new THREE.Vector3(122 + k * 10, -4.2 - k * 1.5, -104 + k * 42),
          look: new THREE.Vector3(150, -10 - k * 4, -40),
          focus: 9,
        }),
      },
      {
        // through the meadow toward the monument, grass in the foreground
        dur: 12,
        at: (k) => {
          const x = -46 + k * 22, z = 34 - k * 20;
          return { pos: new THREE.Vector3(x, g(x, z) + 1.0 + k * 0.6, z), look: crystal.clone().setY(crystal.y - 2), focus: Math.hypot(x, z) };
        },
      },
      {
        // slow orbit around the crystal
        dur: 12,
        at: (k) => {
          const a = 2.2 + k * 1.3;
          return {
            pos: new THREE.Vector3(Math.cos(a) * 10, crystal.y + 1.2 - k * 1.5, Math.sin(a) * 10),
            look: crystal,
            focus: 10,
          };
        },
      },
      {
        // aerial sweep over the valley
        dur: 14,
        at: (k) => {
          const a = -0.6 + k * 0.9;
          return {
            pos: new THREE.Vector3(Math.cos(a) * 240, 110 - k * 20, Math.sin(a) * 240),
            look: new THREE.Vector3(60, 0, -20),
            focus: 250,
          };
        },
      },
      {
        // rising up out of the forest edge
        dur: 12,
        at: (k) => {
          const x = -120 + k * 18, z = 95 - k * 20;
          return { pos: new THREE.Vector3(x, g(x, z) + 2.5 + k * 14, z), look: new THREE.Vector3(0, 12, 0), focus: Math.hypot(x, z) };
        },
      },
    ];
  }

  updateCinematic(dt) {
    this.shotT += dt;
    let shot = this.shots[this.shotIndex];
    if (this.shotT > shot.dur) {
      this.shotT = 0;
      this.shotIndex = (this.shotIndex + 1) % this.shots.length;
      shot = this.shots[this.shotIndex];
    }
    const k = this.shotT / shot.dur;
    const ease = k * k * (3 - 2 * k) * 0.35 + k * 0.65;
    const s = shot.at(ease);
    this.camera.position.copy(s.pos);
    this.camera.lookAt(s.look);
    this.focus = s.focus;
    // fade through black between shots
    const edge = 0.9;
    this.fade = Math.max(1 - this.shotT / edge, 1 - (shot.dur - this.shotT) / edge, 0);
    this.fade = THREE.MathUtils.clamp(this.fade, 0, 1);
    this.feet.set(s.pos.x, -1000, s.pos.z);
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    this.fade = 0;
    if (this.mode === 'cinematic') return this.updateCinematic(dt);

    const k = this.keys;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const flat = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    const free = this.mode === 'fly' || this.mode === 'photo';
    const input = new THREE.Vector3();
    if (k.KeyW || k.ArrowUp) input.add(free ? forward : flat);
    if (k.KeyS || k.ArrowDown) input.sub(free ? forward : flat);
    if (k.KeyD || k.ArrowRight) input.add(right);
    if (k.KeyA || k.ArrowLeft) input.sub(right);
    if (input.lengthSq() > 0) input.normalize();
    const sprint = k.ShiftLeft || k.ShiftRight;

    if (free) {
      const speed = this.mode === 'photo' ? (sprint ? 12 : 3) : sprint ? 90 : 25;
      if (k.Space) input.y += 1;
      if (k.ControlLeft || k.KeyQ) input.y -= 1;
      this.velocity.lerp(input.multiplyScalar(speed), 1 - Math.exp(-dt * 5));
      this.camera.position.addScaledVector(this.velocity, dt);
      const g = this.groundAt(this.camera.position.x, this.camera.position.z);
      this.camera.position.y = Math.max(this.camera.position.y, g + 0.4);
      this.feet.copy(this.camera.position).y -= EYE;
      this.fovOffset = 0;
      return;
    }

    // ---- walking / swimming
    const groundRaw = this.groundAt(this.feet.x, this.feet.z);
    const waterDepth = WATER_LEVEL - groundRaw;
    const wasSwimming = this.swimming;
    this.swimming = waterDepth > SWIM_DEPTH && this.feet.y < WATER_LEVEL - SWIM_DEPTH + 0.6;
    if (this.swimming && !wasSwimming && this.velocity.y < -3) this.emit('splash');

    const speed = this.swimming ? (sprint ? 5 : 3) : sprint ? 9 : 4.5;
    const target = input.clone().multiplyScalar(speed);
    const accel = this.swimming ? 3 : this.onGround ? 12 : 2;
    this.velocity.x += (target.x - this.velocity.x) * (1 - Math.exp(-dt * accel));
    this.velocity.z += (target.z - this.velocity.z) * (1 - Math.exp(-dt * accel));

    if (this.swimming) {
      // buoyancy toward floating at the surface, Q / Ctrl dives, Space swims up
      const floatY = WATER_LEVEL - SWIM_DEPTH;
      let vyTarget = (floatY - this.feet.y) * 2.5;
      if (k.KeyQ || k.ControlLeft) vyTarget = -3;
      if (k.Space) vyTarget = 3;
      this.velocity.y += (vyTarget - this.velocity.y) * (1 - Math.exp(-dt * 3));
    } else {
      this.velocity.y -= 22 * dt;
      if (k.Space && this.onGround) {
        this.velocity.y = 7.5;
        this.onGround = false;
        this.emit('jump');
      }
    }

    const next = this.feet.clone().addScaledVector(this.velocity, dt);
    for (const list of [this.colliders, this.dynamicColliders]) {
      for (const c of list) {
        if (c.top !== undefined && next.y > c.top) continue; // swim over submerged boulders
        const dx = next.x - c.x, dz = next.z - c.z;
        const r = c.r + 0.35;
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          next.x = c.x + (dx / d) * r;
          next.z = c.z + (dz / d) * r;
        }
      }
    }

    let ground = this.groundAt(next.x, next.z);
    const n = this.terrain.getNormal(next.x, next.z, tmp);
    if (!this.swimming && n.y < 0.62 && ground > this.feet.y + 0.05) {
      next.x = this.feet.x;
      next.z = this.feet.z;
      ground = this.groundAt(next.x, next.z);
    }

    const wasOnGround = this.onGround;
    const fallSpeed = -this.velocity.y;
    if (next.y <= ground) {
      next.y = ground;
      if (!wasOnGround && fallSpeed > 5) {
        this.landVel = -Math.min(fallSpeed * 0.18, 2.8);
        this.emit('land', Math.min(fallSpeed / 12, 1));
      }
      this.velocity.y = Math.max(this.velocity.y, 0);
      this.onGround = true;
    } else if (this.swimming) {
      this.onGround = false;
    } else if (next.y - ground > 0.3) {
      this.onGround = false;
    } else if (this.velocity.y <= 0) {
      next.y = ground;
      this.onGround = true;
    }
    this.feet.copy(next);

    // head bob, footsteps and landing dip
    const moving = Math.hypot(this.velocity.x, this.velocity.z);
    this.bob += dt * moving * 1.6;
    const bobS = Math.sin(this.bob * 2);
    if (this.onGround && moving > 0.8 && Math.sign(bobS) !== this.lastStepSign) {
      this.lastStepSign = Math.sign(bobS);
      if (this.lastStepSign < 0) this.emit('step', this.surfaceAt(this.feet.x, this.feet.z), Math.min(moving / 6, 1.2));
    }
    this.landVel += (-this.landDip * 60 - this.landVel * 9) * dt;
    this.landDip += this.landVel * dt;
    const bobY = this.onGround ? bobS * 0.04 * Math.min(moving / 4, 1.5) : 0;
    const swimBob = this.swimming ? Math.sin(performance.now() * 0.002) * 0.06 : 0;
    this.camera.position.set(this.feet.x, this.feet.y + EYE + bobY + this.landDip + swimBob, this.feet.z);
    this.fovOffset = sprint && moving > 6 && !this.swimming ? 7 : 0;
  }
}
