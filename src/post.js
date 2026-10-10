import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

const fsVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const linearDepthGLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform float cameraNear;
  uniform float cameraFar;
  float linDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return 2.0 * cameraNear * cameraFar / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
  }
`;

// ---------------------------------------------------------------- scene pass
// Renders the scene once into an HDR target with a depth texture that the
// AO, depth of field and underwater effects all reuse, then resolves it.
class ScenePass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture });
    this.depthTexture = depthTexture;
    this.resolve = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: this.rt.texture },
          tDepth: { value: depthTexture },
          cameraNear: { value: 0.1 },
          cameraFar: { value: 1000 },
          uUnderwater: { value: 0 },
          uWaterTint: { value: new THREE.Color(0.01, 0.05, 0.06) },
          uTime: { value: 0 },
        },
        vertexShader: fsVertex,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform float uUnderwater;
          uniform vec3 uWaterTint;
          uniform float uTime;
          varying vec2 vUv;
          ${linearDepthGLSL}
          void main() {
            vec2 uv = vUv;
            if (uUnderwater > 0.5) {
              uv += vec2(sin(uv.y * 38.0 + uTime * 2.1), cos(uv.x * 31.0 + uTime * 1.7)) * 0.0022;
              vec3 c = texture2D(tDiffuse, uv).rgb;
              float d = linDepth(uv);
              c *= exp(-vec3(0.35, 0.07, 0.05) * min(d, 60.0) * 0.35); // red is absorbed first
              float fogAmt = 1.0 - exp(-d * 0.085);
              vec3 tint = uWaterTint * (0.6 + 0.8 * smoothstep(0.0, 1.0, uv.y));
              // shafts of light from the surface
              float shafts = pow(max(0.0, sin(uv.x * 22.0 + sin(uv.x * 7.0 + uTime * 0.5) * 2.0 + uTime * 0.3)), 6.0);
              tint += uWaterTint * shafts * smoothstep(0.2, 1.0, uv.y) * 1.5;
              gl_FragColor = vec4(mix(c, tint, fogAmt), 1.0);
            } else {
              gl_FragColor = vec4(texture2D(tDiffuse, uv).rgb, 1.0);
            }
          }
        `,
        depthTest: false,
        depthWrite: false,
      })
    );
  }
  setSize(w, h) {
    this.rt.setSize(w, h);
  }
  render(renderer, writeBuffer) {
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    const u = this.resolve.material.uniforms;
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.resolve.render(renderer);
  }
  dispose() {
    this.rt.dispose();
    this.resolve.dispose();
  }
}

// ---------------------------------------------------------------- auto exposure
// Center-weighted log-average luminance, reduced on the GPU (64 -> 16 -> 4 -> 1)
// and smoothed over time like an eye adapting.
class ExposurePass extends Pass {
  constructor() {
    super();
    const rt = (s) => new THREE.WebGLRenderTarget(s, s, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    this.chain = [rt(64), rt(16), rt(4), rt(1)];
    this.adapt = [rt(1), rt(1)];
    this.ping = 0;
    this.first = true;
    this.params = { auto: true, key: 0.2, min: 0.25, max: 2.0, up: 2.5, down: 1.0 };
    this.dt = 1 / 60;

    this.lumQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: fsVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          float acc = 0.0;
          for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
            vec2 o = (vec2(float(i), float(j)) - 1.5) / 256.0;
            vec3 c = texture2D(tDiffuse, vUv + o).rgb;
            acc += log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
          }
          vec2 d = (vUv - 0.5) * 2.0;
          float w = exp(-dot(d, d) * 1.5) + 0.15;
          gl_FragColor = vec4(acc / 16.0 * w, w, 0.0, 1.0);
        }
      `,
    }));
    this.reduceQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: fsVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc;
        void main() {
          ivec2 b = ivec2(gl_FragCoord.xy) * 4;
          vec4 s = vec4(0.0);
          for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) s += texelFetch(tSrc, b + ivec2(i, j), 0);
          gl_FragColor = s / 16.0;
        }
      `,
    }));
    this.adaptQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tPrev: { value: null }, tCur: { value: null }, uDt: { value: 0 }, uUp: { value: 2 }, uDown: { value: 1 }, uReset: { value: 1 } },
      vertexShader: fsVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tPrev;
        uniform sampler2D tCur;
        uniform float uDt, uUp, uDown, uReset;
        void main() {
          vec4 c = texelFetch(tCur, ivec2(0), 0);
          float cur = c.r / max(c.g, 1e-4);
          float prev = texelFetch(tPrev, ivec2(0), 0).r;
          float speed = cur > prev ? uUp : uDown;
          float v = uReset > 0.5 ? cur : prev + (cur - prev) * (1.0 - exp(-uDt * speed));
          gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
        }
      `,
    }));
    this.applyQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tAdapt: { value: null },
        uKey: { value: 0.2 }, uMin: { value: 0.25 }, uMax: { value: 3.5 }, uOn: { value: 1 },
      },
      vertexShader: fsVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tAdapt;
        uniform float uKey, uMin, uMax, uOn;
        varying vec2 vUv;
        void main() {
          float avg = exp(texelFetch(tAdapt, ivec2(0), 0).r);
          float e = uOn > 0.5 ? clamp(uKey / avg, uMin, uMax) : 1.0;
          gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * e, 1.0);
        }
      `,
    }));
  }

  render(renderer, writeBuffer, readBuffer) {
    const p = this.params;
    this.lumQuad.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.chain[0]);
    this.lumQuad.render(renderer);
    for (let i = 1; i < this.chain.length; i++) {
      this.reduceQuad.material.uniforms.tSrc.value = this.chain[i - 1].texture;
      renderer.setRenderTarget(this.chain[i]);
      this.reduceQuad.render(renderer);
    }
    const prev = this.adapt[this.ping], next = this.adapt[1 - this.ping];
    const au = this.adaptQuad.material.uniforms;
    au.tPrev.value = prev.texture;
    au.tCur.value = this.chain[3].texture;
    au.uDt.value = this.dt;
    au.uUp.value = p.up;
    au.uDown.value = p.down;
    au.uReset.value = this.first ? 1 : 0;
    renderer.setRenderTarget(next);
    this.adaptQuad.render(renderer);
    this.first = false;
    this.ping = 1 - this.ping;

    const u = this.applyQuad.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tAdapt.value = next.texture;
    u.uKey.value = p.key;
    u.uMin.value = p.min;
    u.uMax.value = p.max;
    u.uOn.value = p.auto ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.applyQuad.render(renderer);
  }
}

// ---------------------------------------------------------------- depth of field
const DoFShader = {
  name: 'DoFShader',
  defines: { SAMPLES: 48 },
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    uFocus: { value: 20 },
    uAuto: { value: 0 },
    uAperture: { value: 0.6 },
    uMaxBlur: { value: 14 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: fsVertex,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uFocus, uAuto, uAperture, uMaxBlur;
    uniform vec2 uResolution;
    varying vec2 vUv;
    ${linearDepthGLSL}
    float coc(float d, float f) { return clamp(uAperture * abs(d - f) / max(d, 1e-3), 0.0, 1.0) * uMaxBlur; }
    void main() {
      float focus = uFocus;
      if (uAuto > 0.5) {
        focus = 0.0;
        for (int i = 0; i < 5; i++) {
          vec2 o = vec2(float(i % 3) - 1.0, float(i / 3) - 0.5) * 0.02;
          focus += linDepth(vec2(0.5) + o);
        }
        focus /= 5.0;
      }
      float d0 = linDepth(vUv);
      float r0 = coc(d0, focus);
      vec3 c0 = texture2D(tDiffuse, vUv).rgb;
      if (r0 < 0.5) { gl_FragColor = vec4(c0, 1.0); return; }
      vec3 acc = c0;
      float wsum = 1.0;
      vec2 px = 1.0 / uResolution;
      float ga = 2.39996323;
      for (int i = 0; i < SAMPLES; i++) {
        float fi = float(i) + 0.5;
        float r = sqrt(fi / float(SAMPLES)) * r0;
        float a = fi * ga;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * px;
        float sd = linDepth(uv);
        float sr = coc(sd, focus);
        if (sd > d0) sr = min(sr, r0); // sharp foreground must not smear onto blurred background
        float w = clamp(sr - r + 1.0, 0.0, 1.0);
        acc += texture2D(tDiffuse, uv).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, 1.0);
    }
  `,
};

// ---------------------------------------------------------------- lens
// God rays, lens flare and chromatic aberration, driven by the actual
// brightness at the sun's screen position so they are occluded naturally.
const LensShader = {
  name: 'LensShader',
  defines: { RAY_SAMPLES: 48 },
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uSunOnScreen: { value: 0 },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uAspect: { value: 1 },
    uCA: { value: 0.012 },
    uFlare: { value: 1 },
    uRays: { value: 1 },
  },
  vertexShader: fsVertex,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSun;
    uniform float uSunOnScreen;
    uniform vec3 uSunColor;
    uniform float uAspect;
    uniform float uCA;
    uniform float uFlare;
    uniform float uRays;
    varying vec2 vUv;

    float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec2 dir = vUv - 0.5;
      float d2 = dot(dir, dir);
      vec2 off = dir * d2 * uCA;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      if (uSunOnScreen > 0.001) {
        float vis = 0.0;
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 0.5236;
          vec2 o = vec2(cos(a), sin(a) * uAspect) * 0.004 * float(1 + i % 3);
          vis += smoothstep(3.0, 20.0, lum(texture2D(tDiffuse, uSun + o).rgb));
        }
        vis = vis / 12.0 * uSunOnScreen;

        vec2 delta = (uSun - vUv) / float(RAY_SAMPLES) * 0.85;
        vec2 p = vUv;
        float decay = 1.0, rays = 0.0;
        float jitter = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
        p += delta * jitter;
        for (int i = 0; i < RAY_SAMPLES; i++) {
          p += delta;
          float l = lum(texture2D(tDiffuse, p).rgb);
          rays += smoothstep(2.0, 10.0, l) * decay;
          decay *= 0.965;
        }
        rays /= float(RAY_SAMPLES);
        vec2 sd = (vUv - uSun) * vec2(uAspect, 1.0);
        float falloff = exp(-length(sd) * 2.2);
        col += uSunColor * rays * falloff * uRays * 0.35 * uSunOnScreen;

        vec3 flare = vec3(0.0);
        vec2 axis = vec2(0.5) - uSun;
        float ghostPos[5] = float[](0.35, 0.7, 1.15, 1.45, 1.9);
        float ghostSize[5] = float[](0.05, 0.02, 0.09, 0.035, 0.13);
        vec3 ghostTint[5] = vec3[](vec3(0.4, 0.8, 1.0), vec3(1.0, 0.6, 0.3), vec3(0.5, 1.0, 0.6), vec3(1.0, 0.4, 0.8), vec3(0.3, 0.5, 1.0));
        for (int i = 0; i < 5; i++) {
          vec2 gp = uSun + axis * ghostPos[i];
          float gd = length((vUv - gp) * vec2(uAspect, 1.0));
          float g = smoothstep(ghostSize[i], ghostSize[i] * 0.6, gd);
          g *= 0.6 + 0.4 * smoothstep(ghostSize[i] * 0.5, ghostSize[i], gd);
          flare += ghostTint[i] * g * 0.05;
        }
        vec2 hv = normalize(vUv - vec2(0.5)) * 0.32 + vec2(0.5);
        float halo = smoothstep(0.08, 0.0, abs(length((vUv - vec2(0.5)) * vec2(uAspect, 1.0)) - length((uSun - vec2(0.5)) * vec2(uAspect, 1.0)) * 0.7));
        halo *= exp(-length((vUv - hv) * vec2(uAspect, 1.0)) * 3.0) * 0.03;
        float streak = exp(-abs(sd.y) * 260.0) * exp(-abs(sd.x) * 2.2) * 0.35;
        float glow = exp(-length(sd) * 12.0) * 0.25;
        col += uSunColor * (flare + halo + streak + glow) * vis * uFlare;
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ---------------------------------------------------------------- grade
export const GRADES = {
  Kodachrome: { saturation: 1.18, contrast: 1.1, shadow: [0.95, 0.99, 1.06], highlight: [1.08, 1.01, 0.9] },
  Natural: { saturation: 1.1, contrast: 1.05, shadow: [0.97, 1.0, 1.04], highlight: [1.03, 1.0, 0.96] },
  Cinematic: { saturation: 1.05, contrast: 1.12, shadow: [0.88, 1.0, 1.12], highlight: [1.1, 1.0, 0.88] },
  Warm: { saturation: 1.15, contrast: 1.06, shadow: [1.02, 0.98, 0.92], highlight: [1.1, 1.02, 0.86] },
  Cool: { saturation: 0.95, contrast: 1.04, shadow: [0.9, 0.98, 1.12], highlight: [0.96, 1.0, 1.06] },
  Vivid: { saturation: 1.4, contrast: 1.1, shadow: [0.98, 1.0, 1.02], highlight: [1.02, 1.0, 0.98] },
  Newsreel: { saturation: 0, contrast: 1.3, shadow: [0.98, 0.98, 1], highlight: [1.04, 1.02, 0.97] },
};

const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.35 },
    uGrain: { value: 0.03 },
    uSaturation: { value: 1.1 },
    uContrast: { value: 1.05 },
    uShadowTint: { value: new THREE.Color(0.97, 1.0, 1.04) },
    uHighlightTint: { value: new THREE.Color(1.03, 1.0, 0.96) },
    uSharpen: { value: 0.35 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uFade: { value: 0 },
  },
  vertexShader: fsVertex,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uSaturation, uContrast, uSharpen, uFade;
    uniform vec3 uShadowTint, uHighlightTint;
    uniform vec2 uResolution;
    varying vec2 vUv;
    void main() {
      vec2 px = 1.0 / uResolution;
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // contrast-adaptive sharpening
      vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb;
      vec3 s = texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb;
      vec3 e = texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb;
      vec3 w = texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb;
      vec3 mn = min(c, min(min(n, s), min(e, w)));
      vec3 mx = max(c, max(max(n, s), max(e, w)));
      vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
      vec3 wgt = -sqrt(amp) * uSharpen * 0.2;
      c = clamp((c + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt), 0.0, 1.0);

      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      c *= mix(uShadowTint, uHighlightTint, smoothstep(0.1, 0.8, l));
      vec2 v = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.25, 0.9, dot(v, v) * 2.2);
      float g = fract(sin(dot(vUv * 1000.0 + uTime * 17.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      c += g * uGrain * (1.0 - l * 0.6);
      c *= 1.0 - uFade;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.camera = camera;
    const size = renderer.getSize(new THREE.Vector2());

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, rt);

    this.scenePass = new ScenePass(scene, camera);
    this.composer.addPass(this.scenePass);

    this.gtao = new GTAOPass(scene, camera, size.x, size.y);
    this.gtao.setGBuffer(this.scenePass.depthTexture); // normals reconstructed from the scene depth
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 1.0;
    this.gtao.updateGtaoMaterial({
      radius: 1.4,
      distanceExponent: 1.5,
      thickness: 2.0,
      scale: 1.25,
      samples: 16,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.composer.addPass(this.gtao);

    this.exposure = new ExposurePass();
    this.composer.addPass(this.exposure);

    this.dof = new ShaderPass(DoFShader);
    this.dof.uniforms.tDepth.value = this.scenePass.depthTexture;
    this.dof.enabled = false;
    this.composer.addPass(this.dof);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.5, 2.5);
    this.composer.addPass(this.bloom);

    this.lens = new ShaderPass(LensShader);
    this.composer.addPass(this.lens);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.setSize(size.x, size.y);
    this._v = new THREE.Vector3();
  }

  get underwater() {
    return this.scenePass.resolve.material.uniforms;
  }

  setSize(w, h) {
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.dof.uniforms.uResolution.value.set(w * pr, h * pr);
    this.grade.uniforms.uResolution.value.set(w * pr, h * pr);
  }

  setGrade(name) {
    const g = GRADES[name] || GRADES.Natural;
    const u = this.grade.uniforms;
    u.uSaturation.value = g.saturation;
    u.uContrast.value = g.contrast;
    u.uShadowTint.value.setRGB(...g.shadow);
    u.uHighlightTint.value.setRGB(...g.highlight);
  }

  update(t, dt, sunDir, sunColor, sunElevation) {
    const u = this.lens.uniforms;
    const v = this._v.copy(this.camera.position).addScaledVector(sunDir, 1000).project(this.camera);
    const inFront = v.z < 1 && v.z > -1;
    u.uSun.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    const edge = Math.max(Math.abs(v.x), Math.abs(v.y));
    const onScreen = inFront ? THREE.MathUtils.smoothstep(1.35 - edge, 0, 0.4) : 0;
    u.uSunOnScreen.value = onScreen * THREE.MathUtils.smoothstep(sunElevation, -2, 3);
    u.uRays.value = THREE.MathUtils.lerp(1.4, 0.35, THREE.MathUtils.smoothstep(sunElevation, 5, 45));
    u.uSunColor.value.copy(sunColor);
    u.uAspect.value = this.camera.aspect;

    const d = this.dof.uniforms;
    d.cameraNear.value = this.camera.near;
    d.cameraFar.value = this.camera.far;

    this.scenePass.resolve.material.uniforms.uTime.value = t;
    this.grade.uniforms.uTime.value = t;
    this.exposure.dt = dt;
  }

  render(dt) {
    this.composer.render(dt);
  }
}
