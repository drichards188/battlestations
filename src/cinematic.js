import * as THREE from 'three';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// Title-screen camera tour around the task group (shots are framed relative to moving ships
// and aircraft), and the free photo-mode camera.
export class Cinematic {
  constructor(camera, fleet, air) {
    this.camera = camera;
    this.fleet = fleet;
    this.air = air;
    this.index = 0;
    this.t = 0;
    this.fade = 0;
    this.focus = 60;
    this.chase = null;
    this.keys = {};
    this.photoVel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    addEventListener('keydown', (e) => (this.keys[e.code] = true));
    addEventListener('keyup', (e) => (this.keys[e.code] = false));
    addEventListener('blur', () => (this.keys = {}));
    addEventListener('mousemove', (e) => {
      if (!this.photo || !document.pointerLockElement) return;
      this.yaw -= e.movementX * 0.002;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.002, -1.5, 1.5);
    });

    const F = this.fleet;
    const at = (ship, x, y, z, out) => ship.worldPoint(_w.set(x, y, z), out);
    this.shots = [
      {
        // low along the battleship's bow wave
        dur: 11,
        at: (k, o) => {
          const s = F.own;
          at(s, 34 - k * 6, 5 + k * 2, -150 + k * 70, o.pos);
          at(s, 0, 9, -80 + k * 30, o.look);
          o.focus = 60;
        },
      },
      {
        // chase an attacker if there is one, otherwise sweep over the formation
        dur: 12,
        dynamic: true,
        at: (k, o, self) => {
          const p = self.chase;
          if (p && !p.gone) {
            _v.copy(p.fwd).multiplyScalar(-38).addScaledVector(UP, 9);
            o.pos.copy(p.pos).add(_v);
            o.look.copy(p.pos).addScaledVector(p.fwd, 60);
            o.focus = 38;
            return;
          }
          const c = F.center, a = -0.4 + k * 0.6;
          o.pos.set(c.x + Math.cos(a) * 2200, 520 - k * 120, c.z + Math.sin(a) * 2200);
          o.look.copy(c);
          o.focus = 2000;
        },
      },
      {
        // over the shoulder of the starboard 40mm crew
        dur: 10,
        at: (k, o) => {
          const s = F.own;
          const st = s.model.stations?.[0];
          const base = st ? st.pos : _w.set(14, 12, 0);
          at(s, base.x - 4.5, base.y + 3.2, base.z + 7 - k * 3, o.pos);
          at(s, base.x + 300, base.y + 120 + k * 60, base.z - 200, o.look);
          o.focus = 8;
        },
      },
      {
        // the carrier sliding past, from the water
        dur: 12,
        at: (k, o) => {
          const s = F.carrier;
          at(s, -70, 4, -200 + k * 140, o.pos);
          at(s, 0, 18, -40 + k * 60, o.look);
          o.focus = 90;
        },
      },
      {
        // a destroyer from her quarter, the battleship beyond
        dur: 11,
        at: (k, o) => {
          const s = F.ships[6];
          at(s, 45 + k * 10, 12, 110 - k * 40, o.pos);
          at(s, -20, 6, -60, o.look);
          o.focus = 70;
        },
      },
      {
        // high and wide: the battle line under the trade-wind clouds
        dur: 13,
        at: (k, o) => {
          const s = F.own, a = 2.2 + k * 0.5;
          o.pos.set(s.position.x + Math.cos(a) * 520, 140 + k * 40, s.position.z + Math.sin(a) * 520);
          o.look.copy(s.position).setY(20);
          o.focus = 520;
        },
      },
    ];
    this.o = { pos: new THREE.Vector3(), look: new THREE.Vector3(), focus: 50 };
  }

  pickChase() {
    const cands = this.air.planes.filter((p) => p.alive && p.state !== 'egress');
    this.chase = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
  }

  update(dt) {
    this.t += dt;
    let shot = this.shots[this.index];
    if (this.t > shot.dur || (shot.dynamic && this.chase && this.chase.gone && this.t > 2)) {
      this.t = 0;
      this.index = (this.index + 1) % this.shots.length;
      shot = this.shots[this.index];
      if (shot.dynamic) this.pickChase();
    }
    const k = this.t / shot.dur;
    const ease = k * k * (3 - 2 * k) * 0.35 + k * 0.65;
    shot.at(ease, this.o, this);
    this.camera.position.copy(this.o.pos);
    this.camera.position.y = Math.max(this.camera.position.y, 2.5);
    this.camera.up.copy(UP);
    this.camera.lookAt(this.o.look);
    this.camera.updateMatrixWorld();
    this.focus = this.o.focus;
    const edge = 0.9;
    this.fade = THREE.MathUtils.clamp(Math.max(1 - this.t / edge, 1 - (shot.dur - this.t) / edge, 0), 0, 1);
  }

  // ---------------------------------------------------------------- photo mode
  enterPhoto() {
    this.photo = true;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
    this.photoVel.set(0, 0, 0);
  }

  exitPhoto() {
    this.photo = false;
  }

  updatePhoto(dt) {
    const k = this.keys;
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const fwd = this.camera.getWorldDirection(_v);
    const right = _w.crossVectors(fwd, UP).normalize();
    const input = new THREE.Vector3();
    if (k.KeyW) input.add(fwd);
    if (k.KeyS) input.sub(fwd);
    if (k.KeyD) input.add(right);
    if (k.KeyA) input.sub(right);
    if (k.Space) input.y += 1;
    if (k.KeyQ || k.ControlLeft) input.y -= 1;
    if (input.lengthSq()) input.normalize();
    const speed = k.ShiftLeft || k.ShiftRight ? 60 : 12;
    this.photoVel.lerp(input.multiplyScalar(speed), 1 - Math.exp(-dt * 5));
    this.camera.position.addScaledVector(this.photoVel, dt);
    this.camera.position.y = Math.max(this.camera.position.y, 1);
    this.camera.updateMatrixWorld();
  }
}
