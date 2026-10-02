import * as THREE from 'three';
import { mulberry32, noise3, makeTileableNormalMap } from './noise.js';
import { PLATEAU_HEIGHT } from './terrain.js';

// Procedural flagstone texture (albedo + roughness) drawn on a canvas.
function flagstoneTextures() {
  const size = 1024;
  const albedo = document.createElement('canvas');
  albedo.width = albedo.height = size;
  const rough = document.createElement('canvas');
  rough.width = rough.height = size;
  const a = albedo.getContext('2d');
  const r = rough.getContext('2d');
  const rand = mulberry32(5);

  a.fillStyle = '#2a2622';
  a.fillRect(0, 0, size, size);
  r.fillStyle = '#e6e6e6';
  r.fillRect(0, 0, size, size);

  const rows = 8;
  const rowH = size / rows;
  for (let y = 0; y < rows; y++) {
    let x = y % 2 ? -rowH * 0.5 : 0;
    while (x < size) {
      const w = rowH * (0.8 + rand() * 0.9);
      const tone = 95 + rand() * 45;
      const warm = rand() * 12;
      a.fillStyle = `rgb(${tone + warm},${tone + warm * 0.5},${tone - 6})`;
      a.fillRect(x + 4, y * rowH + 4, w - 8, rowH - 8);
      const rv = 150 + rand() * 80;
      r.fillStyle = `rgb(${rv},${rv},${rv})`;
      r.fillRect(x + 4, y * rowH + 4, w - 8, rowH - 8);
      x += w;
    }
  }
  // grime and speckle
  const img = a.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) {
    const px = i % size, py = (i / size) | 0;
    const n = noise3(px * 0.01, py * 0.01, 3) * 30 + noise3(px * 0.08, py * 0.08, 9) * 12 + (rand() - 0.5) * 14;
    img.data[i * 4] += n;
    img.data[i * 4 + 1] += n;
    img.data[i * 4 + 2] += n;
  }
  a.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 16;
  const roughnessMap = new THREE.CanvasTexture(rough);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  return { map, roughnessMap };
}

export function createMonument() {
  const group = new THREE.Group();
  group.name = 'monument';
  const y0 = PLATEAU_HEIGHT;
  const rand = mulberry32(77);
  const animated = [];

  const { map, roughnessMap } = flagstoneTextures();
  map.repeat.set(4, 4);
  roughnessMap.repeat.set(4, 4);
  const stoneNormal = makeTileableNormalMap({ size: 256, seed: 3, minFreq: 4, maxFreq: 30, strength: 1.6 });
  stoneNormal.repeat.set(4, 4);

  const floorMat = new THREE.MeshStandardMaterial({
    map, roughnessMap, normalMap: stoneNormal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1,
  });
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(14, 14.8, 1.4, 96, 1), floorMat);
  floor.position.y = y0 + 0.2;
  floor.receiveShadow = floor.castShadow = true;
  group.add(floor);

  const step = new THREE.Mesh(new THREE.CylinderGeometry(15.6, 16.4, 0.9, 96, 1), floorMat);
  step.position.y = y0 - 0.25;
  step.receiveShadow = step.castShadow = true;
  group.add(step);

  // glowing rune ring inlaid in the floor
  const runeMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x39c6ff, emissiveIntensity: 7 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.07, 8, 200), runeMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = y0 + 0.92;
  group.add(ring);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.05, 8, 160), runeMat);
  ring2.rotation.x = -Math.PI / 2;
  ring2.position.y = y0 + 0.92;
  group.add(ring2);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const glyph = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.9 + (i % 3) * 0.3), runeMat);
    glyph.position.set(Math.cos(a) * 6.8, y0 + 0.92, Math.sin(a) * 6.8);
    glyph.rotation.y = -a;
    group.add(glyph);
  }

  // standing stones around the rim
  const monolithMat = new THREE.MeshStandardMaterial({
    color: 0x3e3a35, roughness: 0.92, normalMap: stoneNormal, normalScale: new THREE.Vector2(1.2, 1.2),
  });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.13;
    const h = 5 + rand() * 3.5;
    const g = new THREE.BoxGeometry(1.5, h, 0.9, 4, 12, 4);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), yy = p.getY(k), z = p.getZ(k);
      const n = noise3(x * 0.9 + i * 5, yy * 0.6, z * 0.9) * 0.18;
      const taper = 1 - ((yy + h / 2) / h) * 0.25;
      p.setXYZ(k, x * taper + n, yy, z * taper + n * 0.6);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, monolithMat);
    m.position.set(Math.cos(a) * 12.6, y0 + 0.9 + h / 2 - 0.2, Math.sin(a) * 12.6);
    m.rotation.set((rand() - 0.5) * 0.08, -a + Math.PI / 2, (rand() - 0.5) * 0.08);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  // floating crystal: glass with dispersion and iridescence
  const crystalMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.02,
    transmission: 1,
    thickness: 2.5,
    ior: 2.1,
    dispersion: 6,
    iridescence: 0.4,
    iridescenceIOR: 1.6,
    specularIntensity: 1,
    attenuationColor: new THREE.Color(0.7, 0.9, 1.0),
    attenuationDistance: 6,
    envMapIntensity: 1.4,
  });
  const crystalGeo = new THREE.OctahedronGeometry(1.6, 0);
  crystalGeo.scale(1, 2.1, 1);
  const crystal = new THREE.Mesh(crystalGeo, crystalMat);
  crystal.position.set(0, y0 + 5.2, 0);
  crystal.castShadow = true;
  group.add(crystal);

  const coreMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x7fe0ff, emissiveIntensity: 18 });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 3), coreMat);
  core.position.copy(crystal.position);
  group.add(core);

  const coreLight = new THREE.PointLight(0x7fd8ff, 60, 30, 2);
  coreLight.position.copy(crystal.position);
  group.add(coreLight);

  // orbiting shards
  const shardMat = crystalMat.clone();
  shardMat.dispersion = 3;
  shardMat.thickness = 0.8;
  const shards = [];
  for (let i = 0; i < 7; i++) {
    const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.35 + rand() * 0.2, 0), shardMat);
    s.scale.y = 1.8;
    s.userData = { a: (i / 7) * Math.PI * 2, r: 3 + rand() * 0.6, y: rand() * 1.5, sp: 0.3 + rand() * 0.2 };
    s.castShadow = true;
    shards.push(s);
    group.add(s);
  }

  // PBR showcase spheres on pedestals
  const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.35, metalness: 0.2 });
  const showcase = [
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 1, roughness: 0.04 }), // chrome
    new THREE.MeshPhysicalMaterial({ color: 0xffc56b, metalness: 1, roughness: 0.22 }), // gold
    new THREE.MeshPhysicalMaterial({ color: 0x9a0a12, metalness: 0.3, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03 }), // car paint
    new THREE.MeshPhysicalMaterial({ color: 0x2a0c3a, roughness: 0.9, sheen: 1, sheenColor: new THREE.Color(0xc58cff), sheenRoughness: 0.35 }), // velvet
    new THREE.MeshPhysicalMaterial({ color: 0xf2efe8, roughness: 0.18, iridescence: 1, iridescenceIOR: 1.35, iridescenceThicknessRange: [200, 800] }), // pearl
    new THREE.MeshPhysicalMaterial({ color: 0xb87333, metalness: 1, roughness: 0.3, anisotropy: 1, anisotropyRotation: 0.6 }), // brushed copper
  ];
  const pedGeo = new THREE.CylinderGeometry(0.45, 0.6, 1.8, 32);
  const sphereGeo = new THREE.SphereGeometry(0.65, 96, 64);
  showcase.forEach((mat, i) => {
    const a = (i / showcase.length) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * 7.8, z = Math.sin(a) * 7.8;
    const ped = new THREE.Mesh(pedGeo, pedestalMat);
    ped.position.set(x, y0 + 0.9 + 0.9, z);
    ped.castShadow = ped.receiveShadow = true;
    const ball = new THREE.Mesh(sphereGeo, mat);
    ball.position.set(x, y0 + 0.9 + 1.8 + 0.65, z);
    ball.castShadow = ball.receiveShadow = true;
    group.add(ped, ball);
  });

  let power = 0;
  function setPower(p) {
    power = p;
  }

  function update(t) {
    crystal.position.y = y0 + 5.2 + Math.sin(t * 0.8) * 0.35;
    crystal.rotation.y = t * 0.25;
    core.position.y = crystal.position.y;
    coreLight.position.y = crystal.position.y;
    const pulse = 0.75 + 0.25 * Math.sin(t * 2.2);
    coreMat.emissiveIntensity = 18 * pulse * (1 + power * 2);
    coreLight.intensity = 60 * pulse * (1 + power * 1.5);
    runeMat.emissiveIntensity = (5 + 2.5 * Math.sin(t * 1.3 + power * t * 2)) * (1 + power * 2.5);
    for (const s of shards) {
      const d = s.userData;
      const a = d.a + t * d.sp;
      s.position.set(Math.cos(a) * d.r, crystal.position.y - 0.5 + d.y + Math.sin(t + d.a) * 0.3, Math.sin(a) * d.r);
      s.rotation.set(t * 0.7 + d.a, t * 0.9, 0);
    }
  }

  const colliders = [{ x: 0, z: 0, r: 0.9 }];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.13;
    colliders.push({ x: Math.cos(a) * 12.6, z: Math.sin(a) * 12.6, r: 1.0 });
  }
  showcase.forEach((_, i) => {
    const a = (i / showcase.length) * Math.PI * 2 + Math.PI / 6;
    colliders.push({ x: Math.cos(a) * 7.8, z: Math.sin(a) * 7.8, r: 0.8 });
  });

  return { group, update, setPower, colliders, floorTop: y0 + 0.9, crystalPos: new THREE.Vector3(0, y0 + 5.2, 0) };
}
