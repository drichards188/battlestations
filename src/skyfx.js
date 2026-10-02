import * as THREE from 'three';
import { noiseGLSL } from './shaderlib.js';

// Aurora curtains far to the north and the monument's light beam.
export class SkyFX {
  constructor(scene, beamOrigin) {
    this.auroraMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          // slow folding of the curtain
          p.z += sin(uv.x * 9.0 + uTime * 0.07) * 180.0 + sin(uv.x * 23.0 - uTime * 0.11) * 60.0;
          p.y += sin(uv.x * 5.0 + uTime * 0.05) * 60.0 * uv.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        varying vec2 vUv;
        ${noiseGLSL}
        void main() {
          float x = vUv.x;
          float fold = fbm2(vec2(x * 6.0 + uTime * 0.02, uTime * 0.03));
          float rays = pow(vnoise(vec2(x * 140.0 + fold * 18.0, uTime * 0.25)), 2.5);
          rays = 0.35 + rays * 1.4;
          float band = smoothstep(0.0, 0.12, vUv.y) * pow(1.0 - vUv.y, 1.6);
          float edges = smoothstep(0.0, 0.08, x) * smoothstep(1.0, 0.92, x);
          float patches = smoothstep(0.25, 0.7, fbm2(vec2(x * 3.0 - uTime * 0.015, 3.7)));
          vec3 green = vec3(0.1, 1.0, 0.45);
          vec3 violet = vec3(0.55, 0.15, 1.0);
          vec3 col = mix(green, violet, smoothstep(0.35, 0.95, vUv.y));
          col += vec3(1.0, 0.3, 0.5) * smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.08, 0.2, vUv.y)) * 0.4;
          float a = band * edges * patches * rays * uIntensity;
          gl_FragColor = vec4(col * a * 2.2, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.aurora = new THREE.Group();
    const geo = new THREE.PlaneGeometry(5200, 700, 240, 8);
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(geo, this.auroraMat);
      m.position.set(i * 900 - 300, 850 + i * 150, -2600 - i * 500);
      m.rotation.y = i * 0.25;
      m.frustumCulled = false;
      this.aurora.add(m);
    }
    this.aurora.visible = false;
    scene.add(this.aurora);

    // light beam from the crystal into the sky
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        ${noiseGLSL}
        void main() {
          float rim = pow(abs(dot(vN, vV)), 2.0);
          float flow = 0.6 + 0.4 * vnoise(vec2(vUv.x * 12.0, vUv.y * 40.0 - uTime * 3.0));
          float fade = smoothstep(0.0, 0.02, vUv.y) * pow(1.0 - vUv.y, 0.7);
          vec3 col = mix(vec3(0.5, 0.9, 1.0), vec3(1.0), rim);
          gl_FragColor = vec4(col * rim * flow * fade * uIntensity * 6.0, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const beamGeo = new THREE.CylinderGeometry(1.1, 1.1, 1400, 32, 1, true);
    beamGeo.translate(0, 700, 0);
    this.beam = new THREE.Mesh(beamGeo, this.beamMat);
    this.beam.position.copy(beamOrigin);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    scene.add(this.beam);

    // expanding shockwave ring
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uProgress: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uProgress;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float ring = exp(-pow((r - uProgress) * 60.0, 2.0)) * (1.0 - uProgress);
          gl_FragColor = vec4(vec3(0.4, 0.85, 1.0) * ring * 8.0, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.copy(beamOrigin).setY(beamOrigin.y - 3);
    this.ring.visible = false;
    scene.add(this.ring);

    this.auroraLevel = 0;
    this.beamLevel = 0;
    this.ringT = -1;
  }

  shockwave() {
    this.ringT = 0;
  }

  update(dt, t, night, storm, activated) {
    const target = night * (1 - storm) * (activated ? 1.3 : 0.35);
    this.auroraLevel += (target - this.auroraLevel) * (1 - Math.exp(-dt * 0.5));
    this.auroraMat.uniforms.uTime.value = t;
    this.auroraMat.uniforms.uIntensity.value = this.auroraLevel;
    this.aurora.visible = this.auroraLevel > 0.01;

    const bt = activated ? 1 : 0;
    this.beamLevel += (bt - this.beamLevel) * (1 - Math.exp(-dt * 0.8));
    this.beamMat.uniforms.uTime.value = t;
    this.beamMat.uniforms.uIntensity.value = this.beamLevel * (0.8 + 0.2 * Math.sin(t * 3));
    this.beam.visible = this.beamLevel > 0.01;

    if (this.ringT >= 0) {
      this.ringT += dt * 0.35;
      this.ringMat.uniforms.uProgress.value = this.ringT;
      this.ring.visible = this.ringT < 1;
      if (this.ringT >= 1) this.ringT = -1;
    }
  }
}
