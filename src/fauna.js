import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { patchMaterial } from './shaderlib.js';

// Wing flapping is done in the vertex shader; the CPU only moves each instance.
function flapMaterial(key, color, speed, amp, { glide = false, ...opts } = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide, ...opts });
  patchMaterial(m, key, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWing;\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3;
          float glide = smoothstep(-0.3, 0.3, sin(uTime * 0.37 + ph));
          float flap = sin(uTime * ${speed.toFixed(2)} + ph) * mix(1.0, 0.15, glide * ${glide ? '1.0' : '0.0'});
          transformed.y += flap * abs(aWing) * ${amp.toFixed(3)};
          transformed.x *= 1.0 - abs(flap) * abs(aWing) * 0.15;
        #endif
        `
      );
  });
  return m;
}

function birdGeometry() {
  // body plus two wings split at the elbow so they can bend
  const P = [
    0, 0, 0.45, 0, 0.04, -0.4, 0.06, 0, -0.1, -0.06, 0, -0.1, // body (nose, tail, sides)
    0.06, 0, 0.1, 0.55, 0.02, 0.0, 0.06, 0, -0.12, // right inner
    0.55, 0.02, 0.0, 1.05, 0, -0.15, 0.5, 0.01, -0.12, // right outer
    -0.06, 0, 0.1, -0.55, 0.02, 0.0, -0.06, 0, -0.12,
    -0.55, 0.02, 0.0, -1.05, 0, -0.15, -0.5, 0.01, -0.12,
  ];
  const W = [0, 0, 0, 0, 0, 0.5, 0, 0.5, 1, 0.5, 0, -0.5, 0, -0.5, -1, -0.5];
  const I = [0, 2, 1, 0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11, 13, 15, 14];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

function butterflyGeometry() {
  const P = [0, 0, 0.12, 0, 0, -0.12, 0.2, 0, 0.14, 0.18, 0, -0.1, -0.2, 0, 0.14, -0.18, 0, -0.1];
  const W = [0, 0, 1, 1, -1, -1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  g.setIndex([0, 2, 1, 1, 2, 3, 0, 1, 4, 1, 5, 4]);
  g.computeVertexNormals();
  return g;
}

export class Fauna {
  constructor(scene, terrain) {
    this.terrain = terrain;
    const rand = mulberry32(31);
    this.dummy = new THREE.Object3D();

    this.birdCount = 48;
    this.birds = new THREE.InstancedMesh(birdGeometry(), flapMaterial('bird', 0x1a1714, 9.0, 0.5, { glide: true }), this.birdCount);
    this.birds.frustumCulled = false;
    this.birds.castShadow = true;
    this.birdData = [];
    for (let i = 0; i < this.birdCount; i++) {
      const flock = i % 3;
      this.birdData.push({
        flock,
        off: new THREE.Vector3((rand() - 0.5) * 30, (rand() - 0.5) * 10, (rand() - 0.5) * 30),
        ph: rand() * 100,
        scale: 0.7 + rand() * 0.5,
        pos: new THREE.Vector3(),
      });
    }
    scene.add(this.birds);

    this.flyCount = 50;
    const bfMat = flapMaterial('butterfly', 0xffffff, 22.0, 0.18, { roughness: 0.6, emissive: 0x000000 });
    this.flies = new THREE.InstancedMesh(butterflyGeometry(), bfMat, this.flyCount);
    this.flies.frustumCulled = false;
    const palette = [0xffb347, 0xfff27a, 0x7ec8ff, 0xffffff, 0xff7aa8, 0xc39bff];
    this.flyData = [];
    for (let i = 0; i < this.flyCount; i++) {
      this.flies.setColorAt(i, new THREE.Color(palette[i % palette.length]));
      this.flyData.push({ anchor: new THREE.Vector3(1e9, 0, 0), ph: rand() * 100, sp: 0.6 + rand() * 0.6 });
    }
    this.flies.instanceColor.needsUpdate = true;
    scene.add(this.flies);
    this.rand = rand;
  }

  update(dt, t, focus, day, rain) {
    const d = this.dummy;
    // birds: three flocks circling the valley on slow Lissajous paths
    this.birds.visible = day > 0.2 && rain < 0.6;
    if (this.birds.visible) {
      const flocks = [0, 1, 2].map((f) => {
        const s = t * (0.05 + f * 0.012) + f * 2.1;
        return new THREE.Vector3(Math.sin(s) * (180 + f * 90), 70 + f * 25 + Math.sin(s * 2.3) * 15, Math.cos(s * 0.8) * (160 + f * 70));
      });
      for (let i = 0; i < this.birdCount; i++) {
        const b = this.birdData[i];
        const wob = new THREE.Vector3(Math.sin(t * 0.7 + b.ph) * 6, Math.sin(t * 0.9 + b.ph * 1.3) * 3, Math.cos(t * 0.6 + b.ph) * 6);
        const target = flocks[b.flock].clone().add(b.off).add(wob);
        const prev = b.pos.clone();
        if (b.pos.lengthSq() === 0) b.pos.copy(target);
        b.pos.lerp(target, 1 - Math.exp(-dt * 1.5));
        const vel = b.pos.clone().sub(prev);
        d.position.copy(b.pos);
        if (vel.lengthSq() > 1e-6) d.lookAt(b.pos.clone().add(vel));
        d.rotateZ(THREE.MathUtils.clamp(-vel.x * 2, -0.6, 0.6));
        d.scale.setScalar(b.scale);
        d.updateMatrix();
        this.birds.setMatrixAt(i, d.matrix);
      }
      this.birds.instanceMatrix.needsUpdate = true;
    }

    // butterflies drift around meadow spots near the player
    this.flies.visible = day > 0.4 && rain < 0.2;
    if (this.flies.visible) {
      for (let i = 0; i < this.flyCount; i++) {
        const f = this.flyData[i];
        if (f.anchor.distanceTo(focus) > 45) {
          const a = this.rand() * Math.PI * 2, r = 6 + this.rand() * 35;
          f.anchor.set(focus.x + Math.cos(a) * r, 0, focus.z + Math.sin(a) * r);
          f.anchor.y = this.terrain.getHeight(f.anchor.x, f.anchor.z);
          if (f.anchor.y < 1.5) f.anchor.y = -100; // not over water
        }
        const s = t * f.sp + f.ph;
        d.position.set(
          f.anchor.x + Math.sin(s) * 2.5 + Math.sin(s * 2.7) * 0.8,
          f.anchor.y + 0.7 + Math.abs(Math.sin(s * 1.9)) * 0.9,
          f.anchor.z + Math.cos(s * 0.8) * 2.5
        );
        d.rotation.set(0, s * 0.8 + Math.sin(s * 3) * 0.6, Math.sin(s * 5) * 0.2);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.flies.setMatrixAt(i, d.matrix);
      }
      this.flies.instanceMatrix.needsUpdate = true;
    }
  }
}
