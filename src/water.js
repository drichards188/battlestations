import * as THREE from 'three';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { makeTileableNormalMap } from './noise.js';
import { globalUniforms, noiseGLSL } from './shaderlib.js';
import { TERRAIN_SIZE, WATER_LEVEL } from './terrain.js';

// Custom shading on top of three's planar-mirror Water: depth-based absorption
// from the terrain heightmap, soft shoreline, animated foam and HDR sun glints.
const fragmentShader = /* glsl */ `
uniform sampler2D mirrorSampler;
uniform float time;
uniform float size;
uniform float distortionScale;
uniform sampler2D normalSampler;
uniform vec3 sunColor;
uniform vec3 sunDirection;
uniform sampler2D heightTex;
uniform float terrainSize;
uniform float terrainRes;
uniform vec3 shallowColor;
uniform vec3 deepColor;
uniform float nightFactor;
uniform float uRain;
uniform float uStorm;

varying vec4 mirrorCoord;
varying vec4 worldPosition;

#include <common>
#include <packing>
#include <bsdfs>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

${noiseGLSL}

float terrainHeight(vec2 xz) {
  vec2 g = (xz + terrainSize * 0.5) / terrainSize * (terrainRes - 1.0);
  if (g.x < 0.0 || g.y < 0.0 || g.x > terrainRes - 2.0 || g.y > terrainRes - 2.0) return -50.0;
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  float a = texelFetch(heightTex, i, 0).r;
  float b = texelFetch(heightTex, i + ivec2(1, 0), 0).r;
  float c = texelFetch(heightTex, i + ivec2(0, 1), 0).r;
  float d = texelFetch(heightTex, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// expanding rain-drop rings, a few per square metre
vec2 rainRipples(vec2 p, float t) {
  vec2 acc = vec2(0.0);
  for (int l = 0; l < 2; l++) {
    vec2 q = p * (1.6 + float(l) * 0.9) + float(l) * 17.3;
    vec2 cell = floor(q);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 c = cell + vec2(float(i), float(j));
        float h = hash12(c);
        vec2 center = c + vec2(hash12(c + 3.1), hash12(c + 7.7));
        float ph = fract(t * (0.7 + h * 0.5) + h);
        vec2 d = q - center;
        float r = length(d);
        float ringR = ph * 0.9;
        float w = sin((r - ringR) * 34.0) * exp(-abs(r - ringR) * 14.0) * (1.0 - ph) * (1.0 - ph);
        acc += d / (r + 1e-3) * w;
      }
    }
  }
  return acc;
}

vec3 getNormal(vec2 uv) {
  vec2 uv0 = (uv / 103.0) + vec2(time / 17.0, time / 29.0);
  vec2 uv1 = uv / 107.0 - vec2(time / -19.0, time / 31.0);
  vec2 uv2 = uv / vec2(21.0, 23.0) + vec2(time / 11.0, time / 13.0);
  vec2 uv3 = uv / vec2(9.0, 7.0) - vec2(time / 5.0, time / -6.0);
  vec3 n = texture2D(normalSampler, uv0).xyz * 2.0 - 1.0;
  n += texture2D(normalSampler, uv1).xyz * 2.0 - 1.0;
  n += (texture2D(normalSampler, uv2).xyz * 2.0 - 1.0) * 0.6;
  n += (texture2D(normalSampler, uv3).xyz * 2.0 - 1.0) * 0.35;
  n.xy *= 1.0 + uStorm * 1.5;
  return normalize(vec3(n.x, n.z * 1.0, n.y));
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 xz = worldPosition.xz;
  float depth = max(worldPosition.y - terrainHeight(xz), 0.0);

  vec3 n = getNormal(xz * size);
  // calmer, flatter water right at the shore
  n = normalize(mix(vec3(0.0, 1.0, 0.0), n, 0.35 + 0.65 * smoothstep(0.0, 2.5, depth)));
  if (uRain > 0.01) {
    vec2 rr = rainRipples(xz, time) * uRain * 0.5;
    n = normalize(n + vec3(rr.x, 0.0, rr.y));
  }

  vec3 toEye = cameraPosition - worldPosition.xyz;
  float dist = length(toEye);
  vec3 V = toEye / dist;

  vec2 distortion = n.xz * (0.001 + 1.0 / dist) * distortionScale;
  vec3 reflection = texture2D(mirrorSampler, mirrorCoord.xy / mirrorCoord.w + distortion).rgb;

  float NdotV = max(dot(n, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

  float shadow = getShadowMask() * worldShadowFactor(worldPosition.xyz);
  float sunUp = smoothstep(-0.05, 0.1, sunDirection.y);

  // body color: shallow turquoise -> deep teal with Beer-Lambert style falloff
  float absorb = 1.0 - exp(-depth * 0.18);
  vec3 body = mix(shallowColor, deepColor, absorb);
  float sunDiffuse = max(dot(sunDirection, vec3(0.0, 1.0, 0.0)), 0.0);
  body *= (0.25 + sunDiffuse * shadow) * sunColor * 0.25 + vec3(0.02, 0.03, 0.04) * (1.0 - nightFactor * 0.8);

  // sun glints (HDR so bloom picks them up)
  vec3 H = normalize(sunDirection + V);
  float spec = pow(max(dot(n, H), 0.0), 900.0) * 60.0 + pow(max(dot(n, H), 0.0), 120.0) * 1.5;
  vec3 specular = sunColor * spec * shadow * sunUp;

  vec3 color = mix(body, reflection, fresnel) + specular;

  // shoreline foam
  float foamBand = 1.0 - smoothstep(0.0, 1.4, depth);
  float foamNoise = fbm2(xz * 0.9 + vec2(time * 0.15, -time * 0.1));
  float waves = sin(depth * 6.0 - time * 1.6 + foamNoise * 6.0) * 0.5 + 0.5;
  float foam = foamBand * smoothstep(0.45, 0.8, foamNoise * 0.7 + waves * 0.5);
  foam = max(foam, smoothstep(0.25, 0.0, depth) * 0.8);
  vec3 foamCol = sunColor * 0.12 * (0.4 + 0.6 * shadow) + vec3(0.03);
  color = mix(color, foamCol, foam * 0.85);

  // shallow water is see-through
  float alpha = clamp(smoothstep(0.0, 3.5, depth) + fresnel * 0.7 + foam, 0.0, 1.0);
  alpha = max(alpha, 0.35);

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export function createWater(terrain, { reflectionSize = 1024 } = {}) {
  const normals = makeTileableNormalMap({ size: 512, seed: 21, minFreq: 2, maxFreq: 28, strength: 1.2 });
  const geo = new THREE.PlaneGeometry(8000, 8000, 1, 1);
  const water = new Water(geo, {
    textureWidth: reflectionSize,
    textureHeight: reflectionSize,
    waterNormals: normals,
    sunDirection: new THREE.Vector3(0, 1, 0),
    sunColor: 0xffffff,
    waterColor: 0x0a2a33,
    distortionScale: 3.2,
    fog: true,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  water.name = 'water';

  const mirrorTex = water.material.uniforms.mirrorSampler.value;
  mirrorTex.type = THREE.HalfFloatType; // HDR reflections so the sky keeps its highlights

  const m = water.material;
  Object.assign(m.uniforms, globalUniforms, {
    heightTex: { value: terrain.heightTexture },
    terrainSize: { value: TERRAIN_SIZE },
    terrainRes: { value: terrain.n },
    shallowColor: { value: new THREE.Color(0.08, 0.32, 0.30) },
    deepColor: { value: new THREE.Color(0.005, 0.03, 0.045) },
    nightFactor: { value: 0 },
    uRain: { value: 0 },
    uStorm: { value: 0 },
  });
  m.uniforms.size.value = 1.0;
  m.fragmentShader = fragmentShader;
  m.transparent = true;
  m.needsUpdate = true;

  return water;
}
