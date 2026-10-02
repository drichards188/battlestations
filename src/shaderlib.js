import * as THREE from 'three';

// Uniforms shared by every patched material (same object references, so
// updating .value here updates every program at once).
export const globalUniforms = {
  uTime: { value: 0 },
  fogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  fogSunColor: { value: new THREE.Color(1, 0.8, 0.6) },
  fogHeightFalloff: { value: 0.012 },
  fogBaseHeight: { value: 0 },

  // world lighting shared by every lit material
  uSunDirW: { value: new THREE.Vector3(0, 1, 0) }, // direction of the active key light (sun or moon)
  uSunColorN: { value: new THREE.Color(1, 1, 1) }, // key light color, ~1 at full daylight
  uTerrainShadowTex: { value: null },
  uTerrainShadowOn: { value: 0 },
  uTerrainSize: { value: 1600 },
  uCloudShadow: { value: 0.45 },
  uCloudCoverage: { value: 0.38 },
  uCloudOffset: { value: new THREE.Vector2() },
  uWetness: { value: 0 },
  uWindStrength: { value: 1 },
  uWaterLevel: { value: 0 },
};

// Hash / value noise / fbm usable from any shader.
export const noiseGLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = r * p * 2.03; a *= 0.5; }
  return s;
}
`;

// Replace three's distance fog with analytic height fog plus sun in-scattering.
// Materials that do not receive the extra uniforms fall back to plain exp2 fog.
THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif
`;
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPos = cameraPosition + ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  uniform float fogDensity;
  uniform float fogNear;
  uniform float fogFar;
  uniform vec3 fogSunDir;
  uniform vec3 fogSunColor;
  uniform float fogHeightFalloff;
  uniform float fogBaseHeight;

  uniform sampler2D uTerrainShadowTex;
  uniform float uTerrainShadowOn;
  uniform float uTerrainSize;
  uniform float uCloudShadow;
  uniform float uCloudCoverage;
  uniform vec2 uCloudOffset;
  uniform float uWetness;
  uniform vec3 uSunDirW;
  uniform vec3 uSunColorN;

  float csHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float csNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(csHash(i), csHash(i + vec2(1.0, 0.0)), u.x),
               mix(csHash(i + vec2(0.0, 1.0)), csHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  // Large-scale shadowing that the (camera-local) shadow map can't provide:
  // terrain self-shadowing from a raymarched occlusion-height map, and
  // moving cloud shadows projected along the key light direction.
  float worldShadowFactor(vec3 wp) {
    float s = 1.0;
    if (uTerrainShadowOn > 0.5) {
      vec2 uv = wp.xz / uTerrainSize + 0.5;
      if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
        vec2 occ = texture2D(uTerrainShadowTex, uv).rg; // r: height needed to see the light, g: penumbra
        s = smoothstep(occ.r - occ.g, occ.r + 0.2, wp.y + 0.35);
      }
    }
    if (uCloudShadow > 0.0) {
      vec3 L = uSunDirW;
      vec2 cp = wp.xz + L.xz / max(L.y, 0.2) * (700.0 - wp.y);
      vec2 q = cp * 0.0022 + uCloudOffset;
      float c = csNoise(q) * 0.55 + csNoise(q * 2.1 + 5.3) * 0.3 + csNoise(q * 4.3 + 1.7) * 0.15;
      float cover = smoothstep(1.02 - uCloudCoverage, 1.25 - uCloudCoverage, c);
      s *= 1.0 - cover * uCloudShadow;
    }
    return s;
  }
#endif
`;
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  vec3 fogRay = vFogWorldPos - cameraPosition;
  float fogDist = length(fogRay);
  vec3 fogDir = fogRay / max(fogDist, 1e-4);
  float fogFactor;
  if (fogHeightFalloff > 1e-5) {
    float b = fogHeightFalloff;
    float camH = max(cameraPosition.y - fogBaseHeight, 0.0);
    float rd = fogDir.y * fogDist * b;
    float integral = abs(rd) > 1e-4 ? (1.0 - exp(-rd)) / rd : 1.0;
    float optical = fogDensity * exp(-camH * b) * fogDist * integral;
    fogFactor = 1.0 - exp(-optical);
  } else {
    fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
  }
  float sunAmt = pow(max(dot(fogDir, fogSunDir), 0.0), 8.0);
  vec3 fogCol = fogColor + fogSunColor * sunAmt * 0.3;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, clamp(fogFactor, 0.0, 1.0));
#endif
`;

// Apply world shadows to direct lighting of every lit material.
const lightsEnd = THREE.ShaderChunk.lights_fragment_end;
THREE.ShaderChunk.lights_fragment_end = lightsEnd + /* glsl */ `
#ifdef USE_FOG
  {
    float wsf = worldShadowFactor(vFogWorldPos);
    reflectedLight.directDiffuse *= wsf;
    reflectedLight.directSpecular *= wsf;
  }
#endif
`;

// Rain makes rough surfaces darker and glossier.
const roughEnd = THREE.ShaderChunk.roughnessmap_fragment;
THREE.ShaderChunk.roughnessmap_fragment = roughEnd + /* glsl */ `
#if defined(USE_FOG) && !defined(SKIP_WET)
  if (uWetness > 0.0) {
    float wetRough = uWetness * smoothstep(0.35, 0.8, roughnessFactor);
    diffuseColor.rgb *= 1.0 - 0.35 * wetRough;
    roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.35, wetRough);
  }
#endif
`;

/**
 * Attach the shared fog uniforms and an optional shader patch to a material.
 * `key` must be unique per distinct patch so three doesn't share programs.
 */
export function patchMaterial(material, key, patch) {
  material.onBeforeCompile = (shader, renderer) => {
    Object.assign(shader.uniforms, globalUniforms);
    if (patch) patch(shader, renderer);
  };
  material.customProgramCacheKey = () => key;
  material.userData.patched = true;
  return material;
}

/** Give every standard/physical material in the scene the fog uniforms. */
export function patchSceneFog(scene) {
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.isShaderMaterial) {
        if (m.fog) Object.assign(m.uniforms, globalUniforms);
      } else if (!m.userData.patched) {
        patchMaterial(m, 'fog');
      }
    }
  });
}
