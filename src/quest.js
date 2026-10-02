import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { noiseGLSL } from './shaderlib.js';

export function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,255,255,0.8)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const WISP_COLORS = [0x7fe8ff, 0x9dffcf, 0xffd27f, 0xff9ee6, 0xb49dff, 0x8fffa0, 0xffffff];

export class Quest {
  constructor(scene, terrain, crystalPos, { onCollect, onDeliver, onComplete } = {}) {
    this.scene = scene;
    this.crystalPos = crystalPos.clone();
    this.onCollect = onCollect;
    this.onDeliver = onDeliver;
    this.onComplete = onComplete;
    this.total = 7;
    this.collected = 0;
    this.delivered = 0;
    this.complete = false;

    const tex = glowTexture();
    this.wisps = [];
    const rand = mulberry32(2024);
    const n = new THREE.Vector3();

    const pillarMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color() }, uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vDist;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vDist = length(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uFade;
        varying vec2 vUv;
        varying float vDist;
        ${noiseGLSL}
        void main() {
          float edge = pow(sin(vUv.x * 3.14159 * 2.0) * 0.5 + 0.5, 0.5);
          float flow = 0.55 + 0.45 * vnoise(vec2(vUv.x * 8.0, vUv.y * 30.0 - uTime * 1.5));
          float fade = pow(1.0 - vUv.y, 2.0) * smoothstep(0.0, 0.02, vUv.y);
          float near = smoothstep(6.0, 40.0, vDist); // subtle up close, a beacon from afar
          gl_FragColor = vec4(uColor * flow * fade * near * uFade * 1.8, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const pillarGeo = new THREE.CylinderGeometry(0.5, 0.5, 110, 16, 1, true);
    pillarGeo.translate(0, 55, 0);

    const sparkGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(60 * 3);
    for (let i = 0; i < 60; i++) {
      sp[i * 3] = rand() * Math.PI * 2;
      sp[i * 3 + 1] = rand();
      sp[i * 3 + 2] = rand();
    }
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));

    for (let i = 0; i < this.total; i++) {
      // pick a walkable, open spot in each sector of the valley
      let best = null;
      for (let tries = 0; tries < 400 && !best; tries++) {
        const a = (i / this.total) * Math.PI * 2 + 0.35 + (rand() - 0.5) * 0.5;
        const r = 90 + rand() * 190;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = terrain.getHeight(x, z);
        terrain.getNormal(x, z, n);
        if (h > 2.5 && h < 70 && n.y > 0.9) best = new THREE.Vector3(x, h, z);
      }
      if (!best) best = new THREE.Vector3(60 + i * 10, terrain.getHeight(60 + i * 10, 40) + 0, 40);
      const color = new THREE.Color(WISP_COLORS[i]);
      const hdr = color.clone().multiplyScalar(6);

      const group = new THREE.Group();
      group.position.copy(best);
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 2), new THREE.MeshBasicMaterial({ color: hdr, fog: false }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: color.clone().multiplyScalar(3), blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      halo.scale.setScalar(2.6);
      const pm = pillarMat.clone();
      pm.uniforms.uColor.value.copy(color);
      const pillar = new THREE.Mesh(pillarGeo, pm);
      pillar.frustumCulled = false;
      const sparkMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uColor: { value: hdr }, uPixelRatio: { value: 1 } },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform float uPixelRatio;
          varying float vA;
          void main() {
            float a = position.x + uTime * (0.6 + position.z);
            float r = 0.5 + position.y * 0.9;
            float h = fract(position.z + uTime * 0.25 * (0.5 + position.y));
            vec3 p = vec3(cos(a) * r, h * 2.5 - 0.6, sin(a) * r);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            vA = sin(h * 3.14159);
            gl_PointSize = 22.0 * uPixelRatio / -mv.z;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vA;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            gl_FragColor = vec4(uColor * pow(smoothstep(0.5, 0.0, d), 2.0) * vA, 1.0);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sparks = new THREE.Points(sparkGeo, sparkMat);
      sparks.frustumCulled = false;
      const bob = new THREE.Group();
      bob.add(core, halo, sparks);
      group.add(bob, pillar);
      scene.add(group);

      this.wisps.push({
        group, bob, core, halo, pillar, sparks, color, hdr,
        home: best.clone(),
        state: 'idle',
        t: 0,
        from: new THREE.Vector3(),
        slot: i,
      });
    }

    // one shared light follows the nearest wisp
    this.light = new THREE.PointLight(0x9fe8ff, 0, 18, 2);
    scene.add(this.light);

    // pickup burst
    const bc = 260;
    const bGeo = new THREE.BufferGeometry();
    const bv = new Float32Array(bc * 3);
    for (let i = 0; i < bc; i++) {
      const v = new THREE.Vector3(rand() - 0.5, rand() * 0.9, rand() - 0.5).normalize().multiplyScalar(2 + rand() * 6);
      bv.set([v.x, v.y, v.z], i * 3);
    }
    bGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bc * 3), 3));
    bGeo.setAttribute('aVel', new THREE.BufferAttribute(bv, 3));
    this.burstMat = new THREE.ShaderMaterial({
      uniforms: { uAge: { value: 99 }, uOrigin: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color() }, uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aVel;
        uniform float uAge;
        uniform vec3 uOrigin;
        uniform float uPixelRatio;
        varying float vLife;
        void main() {
          float t = uAge;
          vec3 p = uOrigin + aVel * (1.0 - exp(-t * 2.5)) * 0.9 + vec3(0.0, -0.8 * t * t + t * 1.2, 0.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vLife = 1.0 - clamp(t / 1.8, 0.0, 1.0);
          gl_PointSize = 26.0 * uPixelRatio / -mv.z * vLife;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vLife;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(uColor * pow(smoothstep(0.5, 0.0, d), 2.0) * vLife * 6.0, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.burst = new THREE.Points(bGeo, this.burstMat);
    this.burst.frustumCulled = false;
    scene.add(this.burst);
  }

  /** Positions of wisps still out in the world (for the compass). */
  targets() {
    return this.wisps.filter((w) => w.state === 'idle').map((w) => ({ pos: w.group.position, color: w.color }));
  }

  update(dt, t, playerPos, canCollect, pixelRatio) {
    let nearest = null, nearestD = Infinity;
    for (const w of this.wisps) {
      w.sparks.material.uniforms.uTime.value = t + w.slot * 3;
      w.sparks.material.uniforms.uPixelRatio.value = pixelRatio;
      w.pillar.material.uniforms.uTime.value = t;
      if (w.state === 'idle') {
        w.bob.position.y = 1.4 + Math.sin(t * 1.6 + w.slot) * 0.25;
        const d = playerPos.distanceTo(w.group.position.clone().setY(w.group.position.y + 1.4));
        if (d < nearestD) {
          nearestD = d;
          nearest = w;
        }
        if (canCollect && d < 2.4) this.collect(w);
      } else if (w.state === 'flying') {
        w.t += dt / 3.5;
        const k = Math.min(w.t, 1);
        const e = k * k * (3 - 2 * k);
        const target = this.orbitPos(w, t);
        const p = new THREE.Vector3().lerpVectors(w.from, target, e);
        p.y += Math.sin(k * Math.PI) * 40;
        w.group.position.copy(p);
        w.pillar.material.uniforms.uFade.value = 1 - k;
        if (k >= 1) {
          w.state = 'orbit';
          w.pillar.visible = false;
          this.delivered++;
          this.onDeliver?.(this.delivered, this.total);
          if (this.delivered === this.total && !this.complete) {
            this.complete = true;
            this.onComplete?.();
          }
        }
      } else if (w.state === 'orbit') {
        w.group.position.copy(this.orbitPos(w, t));
        w.bob.position.y = 0;
      }
    }

    if (nearest && nearestD < 30) {
      this.light.position.copy(nearest.group.position).y += 1.6;
      this.light.color.copy(nearest.color);
      this.light.intensity = 25 * (0.8 + 0.2 * Math.sin(t * 4));
    } else {
      this.light.intensity = 0;
    }

    this.burstMat.uniforms.uAge.value += dt;
    this.burstMat.uniforms.uPixelRatio.value = pixelRatio;
    this.burst.visible = this.burstMat.uniforms.uAge.value < 2;
    return { nearest, nearestD };
  }

  orbitPos(w, t) {
    const a = (w.slot / this.total) * Math.PI * 2 + t * 0.35;
    return new THREE.Vector3(
      this.crystalPos.x + Math.cos(a) * 5.2,
      this.crystalPos.y - 1.2 + Math.sin(t * 1.3 + w.slot) * 0.4,
      this.crystalPos.z + Math.sin(a) * 5.2
    );
  }

  collect(w) {
    w.state = 'flying';
    w.t = 0;
    w.from.copy(w.group.position).y += w.bob.position.y;
    w.group.position.copy(w.from);
    w.bob.position.y = 0;
    this.collected++;
    this.burstAt(w.from, w.color);
    this.onCollect?.(this.collected, this.total, w);
  }

  /** Fire the shared spark burst at a point. */
  burstAt(pos, color) {
    const bu = this.burstMat.uniforms;
    bu.uAge.value = 0;
    bu.uOrigin.value.copy(pos);
    bu.uColor.value.copy(color);
  }
}
