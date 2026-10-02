import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { patchMaterial, noiseGLSL } from './shaderlib.js';
import { TERRAIN_SIZE } from './terrain.js';

// GPU grass field. Blades live in a square tile that wraps around the viewer,
// so a fixed pool of instances always carpets the ground near the camera.
// Placement, height, masking, wind and player interaction all run in the vertex shader.

function bladeGeometry(segments = 5) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = 0.032 * (1 - t * t * 0.95);
    const curve = t * t * 0.18;
    pos.push(-w, t, curve, w, t, curve);
    uv.push(0, t, 1, t);
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class Grass {
  constructor(terrain, { count = 350000, radius = 60 } = {}) {
    this.terrain = terrain;
    this.radius = radius;

    this.uniforms = {
      uHeightTex: { value: terrain.heightTexture },
      uTerrainSize: { value: TERRAIN_SIZE },
      uTerrainRes: { value: terrain.n },
      uCamPos: { value: new THREE.Vector3() },
      uPlayer: { value: new THREE.Vector3(0, -1000, 0) },
      uTileSize: { value: radius * 2 },
    };

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.material.defines = { SKIP_WET: '' }; // thin blades turn to mirrors if treated as wet surfaces

    patchMaterial(this.material, 'grass', (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute vec4 aBlade; // xz offset in tile, rotation, scale
          uniform sampler2D uHeightTex;
          uniform float uTerrainSize;
          uniform float uTerrainRes;
          uniform vec3 uCamPos;
          uniform vec3 uPlayer;
          uniform float uTileSize;
          uniform float uTime;
          uniform float uWindStrength;
          varying float vBladeY;
          varying float vVariant;
          varying vec3 vWPos;
          ${noiseGLSL}

          float tH(ivec2 i) { return texelFetch(uHeightTex, clamp(i, ivec2(0), ivec2(int(uTerrainRes) - 1)), 0).r; }
          // same triangle split as the CPU mesh so blades sit exactly on the surface
          float terrainHeight(vec2 xz, out vec3 nrm) {
            float cell = uTerrainSize / (uTerrainRes - 1.0);
            vec2 g = (xz + uTerrainSize * 0.5) / cell;
            ivec2 i = ivec2(floor(g));
            vec2 f = fract(g);
            float ha = tH(i), hd = tH(i + ivec2(1, 0)), hb = tH(i + ivec2(0, 1)), hc = tH(i + ivec2(1, 1));
            float h;
            if (f.x + f.y <= 1.0) {
              h = ha + (hd - ha) * f.x + (hb - ha) * f.y;
              nrm = normalize(vec3(-(hd - ha), cell, -(hb - ha)));
            } else {
              h = hc + (hb - hc) * (1.0 - f.x) + (hd - hc) * (1.0 - f.y);
              nrm = normalize(vec3(-(hc - hb), cell, -(hc - hd)));
            }
            return h;
          }
          mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
          `
        )
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          vec3 objectNormal = normalize(mix(rotY(aBlade.z) * normal, vec3(0.0, 1.0, 0.0), 0.55));
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3(tangent.xyz);
          #endif
          `
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          // world position of this blade, wrapped around the camera
          vec2 wxz = aBlade.xy + uTileSize * floor((uCamPos.xz - aBlade.xy) / uTileSize + 0.5);
          vec3 tn;
          float groundH = terrainHeight(wxz, tn);

          // mask: grass only on gentle, dry, non-snowy ground away from the monument
          float slope = 1.0 - tn.y;
          float patchN = fbm2(wxz * 0.035);
          float mask = 1.0 - smoothstep(0.16, 0.24, slope + (patchN - 0.5) * 0.1);
          mask *= smoothstep(1.6, 3.2, groundH);
          mask *= 1.0 - smoothstep(150.0, 175.0, groundH);
          mask *= smoothstep(15.5, 17.5, length(wxz));
          mask *= smoothstep(0.25, 0.45, patchN + vnoise(wxz * 0.3) * 0.25);

          // fade out toward the edge of the tile
          float camDist = length(wxz - uCamPos.xz);
          float fade = 1.0 - smoothstep(uTileSize * 0.32, uTileSize * 0.49, camDist);

          float scale = aBlade.w * mask * fade * (0.75 + patchN * 0.7);
          vBladeY = position.y;
          vVariant = fract(aBlade.x * 12.9898 + aBlade.y * 78.233);

          vec3 p = rotY(aBlade.z) * position;
          p *= vec3(1.0 + scale * 0.25, scale * 0.6, 1.0 + scale * 0.25);

          // layered wind: slow gusts rolling across the field plus fast flutter
          vec2 windDir = normalize(vec2(1.0, 0.35));
          float gust = fbm2(wxz * 0.018 - windDir * uTime * (0.35 + uWindStrength * 0.25));
          float flutter = sin(uTime * (3.2 + uWindStrength) + wxz.x * 0.9 + wxz.y * 0.7 + vVariant * 6.28) * 0.12;
          float bend = ((gust * 1.25 - 0.2) * uWindStrength + flutter * sqrt(uWindStrength)) * position.y * position.y;
          p.xz += windDir * bend * scale * 0.9;
          p.y -= abs(bend) * scale * 0.25;

          vec3 world = vec3(wxz.x, groundH, wxz.y) + p;

          // push blades away from the player
          vec2 away = world.xz - uPlayer.xz;
          float d = length(away);
          float push = (1.0 - smoothstep(0.2, 1.8, d)) * step(abs(uPlayer.y - groundH), 3.0) * position.y;
          world.xz += (away / max(d, 1e-3)) * push * 0.7 * scale;
          world.y -= push * 0.35 * scale;

          vWPos = world;
          vec3 transformed = world;
          `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          varying float vBladeY;
          varying float vVariant;
          varying vec3 vWPos;
          `
        )
        .replace(
          '#include <normal_fragment_begin>',
          // blades are thin cards: light both faces as if they faced the viewer's side
          '#include <normal_fragment_begin>\nnormal = normalize(vNormal);'
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          vec3 baseC = vec3(0.012, 0.03, 0.006);
          vec3 tipA = vec3(0.13, 0.20, 0.035);
          vec3 tipB = vec3(0.26, 0.24, 0.07);
          vec3 tipC = vec3(0.07, 0.16, 0.03);
          vec3 tip = vVariant < 0.5 ? mix(tipA, tipC, vVariant * 2.0) : mix(tipA, tipB, (vVariant - 0.5) * 2.0);
          diffuseColor.rgb *= mix(baseC, tip, smoothstep(0.0, 1.0, vBladeY));
          `
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `
          #include <emissivemap_fragment>
          // fake subsurface transmission when looking toward the sun through the blades
          vec3 viewDirW = normalize(vWPos - cameraPosition);
          float trans = pow(max(dot(viewDirW, uSunDirW), 0.0), 6.0) * vBladeY * worldShadowFactor(vWPos);
          totalEmissiveRadiance += uSunColorN * vec3(0.35, 0.45, 0.08) * trans * 0.12;
          // subtle AO at the base of the blades
          diffuseColor.rgb *= mix(0.35, 1.0, smoothstep(0.0, 0.5, vBladeY));
          `
        );
    });

    this.geometry = bladeGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'grass';
    this.setCount(count);
  }

  setCount(count) {
    const rand = mulberry32(1234);
    const data = new Float32Array(count * 4);
    const R = this.radius;
    for (let i = 0; i < count; i++) {
      data[i * 4] = (rand() * 2 - 1) * R;
      data[i * 4 + 1] = (rand() * 2 - 1) * R;
      data[i * 4 + 2] = rand() * Math.PI * 2;
      data[i * 4 + 3] = 0.45 + Math.pow(rand(), 1.5) * 0.9;
    }
    this.geometry.setAttribute('aBlade', new THREE.InstancedBufferAttribute(data, 4));
    this.geometry.instanceCount = count;
    this.count = count;
  }

  update(camera, playerPos) {
    this.uniforms.uCamPos.value.copy(camera.position);
    if (playerPos) this.uniforms.uPlayer.value.copy(playerPos);
  }
}
