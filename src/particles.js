import * as THREE from 'three';
import { mulberry32 } from './noise.js';

// Fireflies (HDR, picked up by bloom) and sunlit dust motes drifting around the viewer.
export class Particles {
  constructor(terrain) {
    const rand = mulberry32(42);

    // fireflies: fixed world positions near the monument and meadows
    const fCount = 900;
    const fPos = new Float32Array(fCount * 3);
    const fSeed = new Float32Array(fCount);
    for (let i = 0; i < fCount; i++) {
      const r = 10 + Math.sqrt(rand()) * 110;
      const a = rand() * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      fPos[i * 3] = x;
      fPos[i * 3 + 1] = Math.max(terrain.getHeight(x, z), 0) + 0.5 + rand() * 2.5;
      fPos[i * 3 + 2] = z;
      fSeed[i] = rand() * 100;
    }
    const fGeo = new THREE.BufferGeometry();
    fGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
    fGeo.setAttribute('aSeed', new THREE.BufferAttribute(fSeed, 1));

    this.fireflyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vBlink;
        void main() {
          vec3 p = position;
          float t = uTime * 0.4 + aSeed;
          p += vec3(sin(t * 1.3) * 1.2, sin(t * 2.1) * 0.5, cos(t * 1.1) * 1.2);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vBlink = pow(0.5 + 0.5 * sin(uTime * 2.5 + aSeed * 7.0), 3.0);
          gl_PointSize = 160.0 * uPixelRatio / -mv.z;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uIntensity;
        varying float vBlink;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float core = smoothstep(0.5, 0.0, d);
          core = pow(core, 3.0);
          gl_FragColor = vec4(vec3(1.0, 0.85, 0.35) * core * vBlink * uIntensity, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.fireflies = new THREE.Points(fGeo, this.fireflyMat);
    this.fireflies.frustumCulled = false;

    // dust motes: a box of particles that wraps around the camera
    const dCount = 2500;
    const dPos = new Float32Array(dCount * 3);
    for (let i = 0; i < dCount * 3; i++) dPos[i] = (rand() * 2 - 1) * 20;
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCam;
        uniform float uPixelRatio;
        uniform vec3 uSunDir;
        varying float vFwd;
        void main() {
          vec3 p = position + vec3(uTime * 0.25, sin(uTime * 0.3 + position.x) * 0.4, uTime * 0.1);
          p = uCam + mod(p - uCam + 20.0, 40.0) - 20.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vec3 viewDir = normalize(p - cameraPosition);
          vFwd = pow(max(dot(viewDir, uSunDir), 0.0), 4.0);
          float fade = smoothstep(20.0, 8.0, length(p - uCam));
          gl_PointSize = 6.0 * uPixelRatio / -mv.z * fade;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunColor;
        varying float vFwd;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.1, d);
          gl_FragColor = vec4(uSunColor * a * (0.04 + vFwd * 0.6), 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(dGeo, this.dustMat);
    this.dust.frustumCulled = false;

    this.group = new THREE.Group();
    this.group.add(this.fireflies, this.dust);
  }

  update(t, camera, sunDir, sunColor, night, pixelRatio) {
    this.fireflyMat.uniforms.uTime.value = t;
    this.fireflyMat.uniforms.uIntensity.value = 0.6 + night * 25;
    this.fireflyMat.uniforms.uPixelRatio.value = pixelRatio;
    this.dustMat.uniforms.uTime.value = t;
    this.dustMat.uniforms.uCam.value.copy(camera.position);
    this.dustMat.uniforms.uSunDir.value.copy(sunDir);
    this.dustMat.uniforms.uSunColor.value.copy(sunColor);
    this.dustMat.uniforms.uPixelRatio.value = pixelRatio;
  }
}
