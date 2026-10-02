import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { globalUniforms } from './shaderlib.js';
import { TERRAIN_SIZE } from './terrain.js';

// Bakes an "occlusion height" map on the GPU: for every ground column, the
// height a point must reach before the key light clears the terrain in front
// of it. Re-baked only when the light direction changes.
export class TerrainShadow {
  constructor(renderer, terrain, size = 512) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.rt.texture.generateMipmaps = false;

    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          uHeight: { value: terrain.heightTexture },
          uRes: { value: terrain.n },
          uSize: { value: TERRAIN_SIZE },
          uLight: { value: new THREE.Vector3(0, 1, 0) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uHeight;
          uniform float uRes;
          uniform float uSize;
          uniform vec3 uLight;
          varying vec2 vUv;

          float H(vec2 xz) {
            vec2 g = clamp((xz / uSize + 0.5) * (uRes - 1.0), vec2(0.0), vec2(uRes - 1.001));
            ivec2 i = ivec2(floor(g));
            vec2 f = fract(g);
            float a = texelFetch(uHeight, i, 0).r;
            float b = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
            float c = texelFetch(uHeight, i + ivec2(0, 1), 0).r;
            float d = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
          }

          void main() {
            vec2 xz = (vUv - 0.5) * uSize;
            vec2 dir = normalize(uLight.xz + 1e-5);
            float slope = uLight.y / max(length(uLight.xz), 1e-4); // rise per metre toward the light
            float occ = -1e4;
            float soft = 0.4;
            float t = 1.5;
            for (int i = 0; i < 72; i++) {
              float h = H(xz + dir * t);
              // height at this column that would just graze this sample
              float need = h - t * slope;
              if (need > occ) { occ = need; soft = 0.4 + t * 0.015; }
              t *= 1.075;
              t += 0.6;
              if (t > 1400.0) break;
            }
            gl_FragColor = vec4(occ, soft, 0.0, 1.0);
          }
        `,
        depthTest: false,
        depthWrite: false,
      })
    );

    globalUniforms.uTerrainShadowTex.value = this.rt.texture;
    globalUniforms.uTerrainShadowOn.value = 1;
    this.lastDir = new THREE.Vector3();
  }

  update(lightDir) {
    if (this.lastDir.distanceToSquared(lightDir) < 1e-7) return;
    this.lastDir.copy(lightDir);
    this.quad.material.uniforms.uLight.value.copy(lightDir);
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rt);
    this.quad.render(r);
    r.setRenderTarget(prev);
  }
}
