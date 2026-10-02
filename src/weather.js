import * as THREE from 'three';
import { globalUniforms } from './shaderlib.js';
import { mulberry32 } from './noise.js';

export const WEATHER = {
  Clear: { cover: 0.35, rain: 0, wind: 1.0, storm: 0, fog: 1.0 },
  Cloudy: { cover: 0.7, rain: 0, wind: 1.5, storm: 0.35, fog: 1.4 },
  Rain: { cover: 0.9, rain: 0.7, wind: 2.0, storm: 0.7, fog: 2.2 },
  Storm: { cover: 1.0, rain: 1.0, wind: 3.2, storm: 1.0, fog: 2.8 },
};

// Rain streaks, lightning and the weather state that drives sky, fog, wind,
// wetness and water.
export class Weather {
  constructor(scene, audio) {
    this.scene = scene;
    this.audio = audio;
    this.target = { ...WEATHER.Clear };
    this.state = { ...WEATHER.Clear };
    this.wetness = 0;
    this.flash = 0;
    this.nextStrike = 6;
    this.rand = mulberry32(8);
    this.onFlash = null;

    // rain: camera-facing streaks in a box that wraps around the viewer
    const count = 16000;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    const offs = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      offs[i * 4] = this.rand() * 50 - 25;
      offs[i * 4 + 1] = this.rand() * 40;
      offs[i * 4 + 2] = this.rand() * 50 - 25;
      offs[i * 4 + 3] = this.rand();
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offs, 4));
    geo.instanceCount = count;
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uAmount: { value: 0 },
        uWind: { value: new THREE.Vector2(2, 1) },
        uColor: { value: new THREE.Color(0.5, 0.55, 0.6) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aOffset;
        uniform float uTime;
        uniform vec3 uCam;
        uniform float uAmount;
        uniform vec2 uWind;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          vec3 vel = vec3(uWind.x, -16.0 - aOffset.w * 6.0, uWind.y);
          vec3 p = aOffset.xyz + vel * uTime;
          p = uCam + mod(p - uCam + vec3(25.0, 20.0, 25.0), vec3(50.0, 40.0, 50.0)) - vec3(25.0, 20.0, 25.0);
          // cull a share of the drops for lighter rain
          float keep = step(aOffset.w, uAmount);
          // stretch along the fall direction, face the camera
          vec3 dir = normalize(vel);
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(dir, toCam));
          float len = 0.55 + aOffset.w * 0.35;
          vec3 world = p + side * position.x * 0.012 * keep + dir * position.y * len * keep;
          vUv = uv;
          float dist = length(p - uCam);
          vFade = smoothstep(25.0, 10.0, dist) * smoothstep(0.3, 1.5, dist);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          float a = (1.0 - abs(vUv.x - 0.5) * 2.0) * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
          gl_FragColor = vec4(uColor, a * vFade * 0.32);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.rain = new THREE.Mesh(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 10;
    scene.add(this.rain);

    // lightning bolt (rebuilt for every strike)
    this.boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 9, 14), fog: false, transparent: true });
    this.bolt = new THREE.Mesh(new THREE.BufferGeometry(), this.boltMat);
    this.bolt.visible = false;
    this.bolt.frustumCulled = false;
    scene.add(this.bolt);
    this.flashLight = new THREE.DirectionalLight(0xc8d4ff, 0);
    scene.add(this.flashLight, this.flashLight.target);
  }

  set(name) {
    this.name = name;
    this.target = { ...WEATHER[name] };
  }

  buildBolt(camPos) {
    const a = this.rand() * Math.PI * 2;
    const dist = 350 + this.rand() * 700;
    const base = new THREE.Vector3(camPos.x + Math.cos(a) * dist, 0, camPos.z + Math.sin(a) * dist);
    const pts = [];
    let p = new THREE.Vector3(base.x + (this.rand() - 0.5) * 100, 650, base.z + (this.rand() - 0.5) * 100);
    const segs = 22;
    for (let i = 0; i <= segs; i++) {
      pts.push(p.clone());
      const t = (i + 1) / segs;
      const target = new THREE.Vector3().lerpVectors(pts[0], base, t);
      p = target.add(new THREE.Vector3((this.rand() - 0.5) * 60, 0, (this.rand() - 0.5) * 60));
    }
    const curves = [new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0)];
    for (let b = 0; b < 3; b++) {
      const start = pts[4 + Math.floor(this.rand() * 10)];
      const bp = [start.clone()];
      let q = start.clone();
      for (let i = 0; i < 6; i++) {
        q = q.clone().add(new THREE.Vector3((this.rand() - 0.5) * 90, -40 - this.rand() * 40, (this.rand() - 0.5) * 90));
        bp.push(q);
      }
      curves.push(new THREE.CatmullRomCurve3(bp, false, 'centripetal', 0));
    }
    const geos = curves.map((c, i) => new THREE.TubeGeometry(c, i === 0 ? 120 : 30, i === 0 ? 1.6 : 0.8, 5, false));
    this.bolt.geometry.dispose();
    // merge by concatenation
    const pos = [], idx = [];
    let off = 0;
    for (const g of geos) {
      const pa = g.attributes.position.array;
      for (let i = 0; i < pa.length; i++) pos.push(pa[i]);
      for (const k of g.index.array) idx.push(k + off);
      off += g.attributes.position.count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    this.bolt.geometry = geo;
    return { pos: base, dist };
  }

  update(dt, t, camera, atmosphere) {
    const s = this.state, g = this.target;
    const k = 1 - Math.exp(-dt * 0.25);
    for (const key of Object.keys(s)) s[key] += (g[key] - s[key]) * k;

    // wetness builds up while raining and dries slowly afterwards
    if (s.rain > 0.05) this.wetness = Math.min(1, this.wetness + dt * 0.08 * s.rain);
    else this.wetness = Math.max(0, this.wetness - dt * 0.012);

    globalUniforms.uWetness.value = this.wetness;
    globalUniforms.uWindStrength.value = s.wind;
    globalUniforms.uCloudCoverage.value = s.cover;
    globalUniforms.uCloudShadow.value = 0.45 * (1 - s.storm * 0.5) * (atmosphere.night > 0.5 ? 0.3 : 1);
    globalUniforms.uCloudOffset.value.x += dt * 0.004 * s.wind;
    globalUniforms.uCloudOffset.value.y += dt * 0.002 * s.wind;

    const u = this.rainMat.uniforms;
    u.uTime.value = t;
    u.uCam.value.copy(camera.position);
    u.uAmount.value = s.rain;
    u.uWind.value.set(2.5 * s.wind, 1.2 * s.wind);
    u.uColor.value.copy(this.scene.fog.color).multiplyScalar(2.2).addScalar(0.04 + this.flash * 1.5);
    this.rain.visible = s.rain > 0.01;

    // lightning
    this.flash = Math.max(0, this.flash - dt * 5);
    if (s.storm > 0.85 && s.rain > 0.8) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = 5 + this.rand() * 12;
        const strike = this.buildBolt(camera.position);
        this.strikeT = 0;
        this.bolt.visible = true;
        this.flashLight.position.copy(strike.pos).setY(600);
        this.flashLight.target.position.copy(camera.position);
        if (this.audio) this.audio.thunder(strike.dist);
      }
    }
    if (this.strikeT !== undefined && this.strikeT < 0.6) {
      this.strikeT += dt;
      // flicker: two or three pulses
      const pulse = this.strikeT < 0.08 || (this.strikeT > 0.16 && this.strikeT < 0.22) || (this.strikeT > 0.34 && this.strikeT < 0.38);
      if (pulse) this.flash = 1;
      this.bolt.visible = pulse || this.strikeT < 0.3;
      this.boltMat.opacity = pulse ? 1 : 0.35;
    } else {
      this.bolt.visible = false;
    }
    this.flashLight.intensity = this.flash * 4;
    atmosphere.uniforms.uFlash.value = this.flash;
  }
}
