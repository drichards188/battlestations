import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { globalUniforms } from './shaderlib.js';

const DEG = Math.PI / 180;

function addStarsAndMoon(material) {
  material.uniforms.uStorm = { value: 0 };
  material.uniforms.uFlash = { value: 0 };
  material.fragmentShader = 'uniform float uStorm;\nuniform float uFlash;\n' + material.fragmentShader.replace(
    'gl_FragColor = vec4( texColor, 1.0 );',
    /* glsl */ `
    float night = (1.0 - smoothstep(-0.12, 0.04, vSunDirection.y)) * (1.0 - uStorm);
    if (night > 0.0 && direction.y > 0.0) {
      vec3 sd = direction * 350.0;
      vec3 cell = floor(sd);
      vec3 f = fract(sd) - 0.5;
      float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
      float h2 = fract(h * 91.7);
      float star = step(0.992, h) * smoothstep(0.22, 0.0, length(f));
      float tw = 0.55 + 0.45 * sin(time * (1.5 + h2 * 3.0) + h * 200.0);
      vec3 starCol = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), h2);
      // faint milky band
      float band = exp(-pow(dot(direction, normalize(vec3(0.3, 0.2, 1.0))) * 3.5, 2.0));
      texColor += starCol * star * tw * night * 1.2 * smoothstep(0.0, 0.25, direction.y);
      texColor += vec3(0.02, 0.024, 0.045) * band * night * smoothstep(0.0, 0.4, direction.y);
      float md = dot(direction, -vSunDirection);
      float moon = smoothstep(0.99955, 0.99975, md);
      float moonGlow = pow(max(md, 0.0), 180.0);
      texColor += vec3(0.8, 0.85, 1.0) * (moon * 1.4 + moonGlow * 0.04) * night;
    }
    // overcast: flatten the sky toward a heavy blue-grey, lit by lightning
    float skyL = dot(texColor, vec3(0.2126, 0.7152, 0.0722));
    texColor = mix(texColor, vec3(skyL) * vec3(0.8, 0.86, 0.95) * 0.5, uStorm * 0.85);
    texColor += vec3(0.55, 0.6, 0.8) * uFlash * (0.4 + 0.6 * smoothstep(-0.1, 0.4, direction.y));
    gl_FragColor = vec4( texColor, 1.0 );`
  );
}

export class Atmosphere {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    this.sky = new Sky();
    this.sky.scale.setScalar(15000);
    addStarsAndMoon(this.sky.material);
    this.uniforms = this.sky.material.uniforms;
    this.uniforms.turbidity.value = 4.5;
    this.uniforms.rayleigh.value = 1.6;
    this.uniforms.mieCoefficient.value = 0.004;
    this.uniforms.mieDirectionalG.value = 0.82;
    this.uniforms.cloudCoverage.value = 0.38;
    this.uniforms.cloudDensity.value = 0.5;
    this.uniforms.cloudElevation.value = 0.55;
    scene.add(this.sky);

    // A small copy of the sky used to bake image based lighting.
    this.envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(this.sky.geometry, this.sky.material);
    envSky.scale.setScalar(50);
    this.envScene.add(envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;

    this.sunDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3();

    this.sun = new THREE.DirectionalLight(0xffffff, 5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = 2;
    this.shadowExtent = 140;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -this.shadowExtent;
    sc.right = sc.top = this.shadowExtent;
    sc.near = 1;
    sc.far = 1200;
    scene.add(this.sun, this.sun.target);

    scene.fog = new THREE.FogExp2(0x9ab0c8, 0.0011);

    // Tiny render target used to read back the horizon color for fog.
    this.probeRT = new THREE.WebGLRenderTarget(16, 8, { type: THREE.HalfFloatType });
    this.probeCam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.probeBuf = new Uint16Array(16 * 8 * 4);

    this.elevation = 7;
    this.azimuth = 105;
    this.lastEnvKey = '';
    this.night = 0;
    this.storm = 0;
  }

  setStorm(storm) {
    this.storm = storm;
    this.uniforms.uStorm.value = storm;
  }

  set(elevation, azimuth) {
    this.elevation = elevation;
    this.azimuth = azimuth;
    const phi = (90 - elevation) * DEG;
    const theta = azimuth * DEG;
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.uniforms.sunPosition.value.copy(this.sunDir);

    const day = THREE.MathUtils.smoothstep(elevation, -2, 6);
    this.night = 1 - THREE.MathUtils.smoothstep(elevation, -8, 0);

    if (elevation > -3) {
      this.lightDir.copy(this.sunDir);
      if (this.lightDir.y < 0.03) this.lightDir.y = 0.03;
      this.lightDir.normalize();
      const warm = THREE.MathUtils.smoothstep(elevation, 0, 28);
      this.sun.color.setRGB(1.0, 0.42 + 0.53 * warm, 0.18 + 0.72 * warm);
      this.sun.intensity = 6.5 * day * (1 - 0.82 * this.storm);
    } else {
      // Moonlight comes from the opposite side, kept reasonably high.
      this.lightDir.copy(this.sunDir).negate();
      this.lightDir.y = Math.max(this.lightDir.y, 0.45);
      this.lightDir.normalize();
      this.sun.color.setRGB(0.55, 0.65, 1.0);
      this.sun.intensity = 0.55 * this.night * (1 - 0.8 * this.storm);
    }

    this.baseEnvIntensity = THREE.MathUtils.lerp(1.0, 0.4, this.night);
    this.scene.environmentIntensity = this.baseEnvIntensity;
    this.scene.backgroundIntensity = 1;

    const key = `${elevation.toFixed(1)}|${azimuth.toFixed(1)}|${this.storm.toFixed(2)}`;
    if (key !== this.lastEnvKey) {
      this.lastEnvKey = key;
      this.bakeEnvironment();
      this.updateFogColor(!this.fogSunBase);
    }
  }

  bakeEnvironment() {
    const showDisc = this.uniforms.showSunDisc.value;
    this.uniforms.showSunDisc.value = 0; // avoid a hot spot in the IBL
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
    this.uniforms.showSunDisc.value = showDisc;
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
  }

  // Render the horizon in two directions (side-on and toward the sun) into one
  // small target, then read it back asynchronously so the GPU never stalls.
  renderProbe(side, toward) {
    const r = this.renderer;
    const rt = this.probeRT;
    const prev = r.getRenderTarget();
    const cam = this.probeCam;
    cam.position.set(0, 0, 0);
    rt.scissorTest = true;
    r.setRenderTarget(rt);
    [side, toward].forEach((dir, i) => {
      rt.viewport.set(i * 8, 0, 8, 8);
      rt.scissor.set(i * 8, 0, 8, 8);
      r.setRenderTarget(rt);
      cam.lookAt(dir);
      r.render(this.envScene, cam);
    });
    r.setRenderTarget(prev);
  }

  applyProbe() {
    const f = THREE.DataUtils.fromHalfFloat;
    const avg = (x0) => {
      const c = new THREE.Color(0, 0, 0);
      for (let y = 0; y < 8; y++) {
        for (let x = x0; x < x0 + 8; x++) {
          const i = (y * 16 + x) * 4;
          c.r += f(this.probeBuf[i]);
          c.g += f(this.probeBuf[i + 1]);
          c.b += f(this.probeBuf[i + 2]);
        }
      }
      return c.multiplyScalar(1 / 64);
    };
    const base = avg(0);
    const sunSide = avg(8);
    this.scene.fog.color.copy(base);
    globalUniforms.fogSunColor.value
      .setRGB(Math.max(sunSide.r - base.r, 0), Math.max(sunSide.g - base.g, 0), Math.max(sunSide.b - base.b, 0))
      .multiplyScalar(0.5);
    this.fogSunBase = globalUniforms.fogSunColor.value.clone();
  }

  updateFogColor(sync = false) {
    globalUniforms.fogSunDir.value.copy(this.sunDir);
    if (this.probePending) {
      this.probeDirty = true;
      return;
    }
    const flat = new THREE.Vector3(this.sunDir.x, 0, this.sunDir.z).normalize();
    const side = new THREE.Vector3(-flat.z, 0.05, flat.x).normalize();
    const toward = new THREE.Vector3(flat.x, 0.05, flat.z).normalize();
    this.renderProbe(side, toward);
    const r = this.renderer;
    if (sync || !r.readRenderTargetPixelsAsync) {
      r.readRenderTargetPixels(this.probeRT, 0, 0, 16, 8, this.probeBuf);
      this.applyProbe();
      return;
    }
    this.probePending = true;
    r.readRenderTargetPixelsAsync(this.probeRT, 0, 0, 16, 8, this.probeBuf)
      .catch(() => r.readRenderTargetPixels(this.probeRT, 0, 0, 16, 8, this.probeBuf))
      .then(() => {
        this.applyProbe();
        this.probePending = false;
        if (this.probeDirty) {
          this.probeDirty = false;
          this.updateFogColor();
        }
      });
  }

  /** Keep the shadow frustum centred on the viewer, snapped to texels to avoid shimmer. */
  update(focus, time) {
    this.uniforms.time.value = time;
    const ext = this.shadowExtent;
    const texel = (ext * 2) / this.sun.shadow.mapSize.x;

    // Snap in light space so shadow edges don't crawl while moving.
    const lightRot = new THREE.Matrix4().lookAt(new THREE.Vector3(), this.lightDir, new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    const p = focus.clone().applyMatrix4(inv);
    p.x = Math.round(p.x / texel) * texel;
    p.y = Math.round(p.y / texel) * texel;
    p.applyMatrix4(lightRot);

    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.lightDir, 500);
    this.sun.target.updateMatrixWorld();
  }

  setShadowQuality(mapSize, extent) {
    this.shadowExtent = extent;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -extent;
    sc.right = sc.top = extent;
    sc.updateProjectionMatrix();
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
  }
}
