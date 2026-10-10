import * as THREE from 'three';
import { fbm, mulberry32, noise3 } from './noise.js';

const EARTH_2R = 12742000;

// Volcanic islands on the horizon: jungle-covered cones with sandy shores and fringing reefs.
const ISLANDS = [
  { x: 5200, z: -9800, r: 1900, h: 420, seed: 3 },
  { x: 14500, z: 2600, r: 2600, h: 610, seed: 7 },
  { x: -7400, z: 6200, r: 1300, h: 260, seed: 11 },
  { x: 19500, z: -8800, r: 3200, h: 760, seed: 19 },
  { x: -2500, z: -15500, r: 1100, h: 180, seed: 23 },
];

function islandGeometry({ r, h, seed }) {
  const rings = 56, segs = 120;
  const rand = mulberry32(seed);
  const pos = [], col = [];
  const lobes = Array.from({ length: 4 }, () => ({ a: rand() * Math.PI * 2, k: 0.15 + rand() * 0.25, w: 0.6 + rand() * 0.8 }));
  const radiusAt = (a) => {
    let k = 1 + fbm(Math.cos(a) * 1.3 + seed, Math.sin(a) * 1.3, 3, seed) * 0.35;
    for (const l of lobes) k += l.k * Math.exp(-Math.pow(Math.atan2(Math.sin(a - l.a), Math.cos(a - l.a)) / l.w, 2));
    return r * k;
  };
  const sand = new THREE.Color(0.72, 0.64, 0.47), jungle = new THREE.Color(0.07, 0.16, 0.05), jungle2 = new THREE.Color(0.13, 0.22, 0.07);
  const rock = new THREE.Color(0.27, 0.24, 0.21), c = new THREE.Color();
  for (let i = 0; i <= rings; i++) {
    const u = i / rings; // 0 at the peak, 1 out on the reef flat
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const R = radiusAt(a) * 1.15;
      const rad = u * R;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const s = rad / (R / 1.15);
      let y;
      if (s < 1) {
        const ridge = Math.abs(noise3(x * 0.0022, seed, z * 0.0022));
        y = h * Math.pow(1 - s, 1.7) * (0.75 + 0.5 * ridge) + fbm(x * 0.004, z * 0.004, 4, seed) * h * 0.12 * (1 - s) + 3 * (1 - s * s);
      } else y = -3 - (s - 1) * 30;
      pos.push(x, y, z);
      const slope = h / r;
      const n = fbm(x * 0.01, z * 0.01, 3, seed + 5) * 0.5 + 0.5;
      if (y < 4) c.copy(sand);
      else if (y > h * 0.75 && slope > 0.25) c.copy(rock).lerp(jungle, n * 0.6);
      else c.copy(jungle).lerp(jungle2, n);
      if (y > 2 && y < 7) c.lerp(sand, (7 - y) / 5);
      col.push(c.r, c.g, c.b);
    }
  }
  const idx = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * segs + j, b = i * segs + ((j + 1) % segs), cc = (i + 1) * segs + j, d = (i + 1) * segs + ((j + 1) % segs);
      idx.push(a, b, cc, b, d, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, reach: radiusAt(0) };
}

export class Islands {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'islands';
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.items = ISLANDS.map((d) => {
      const { geometry } = islandGeometry(d);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.position.set(d.x, 0, d.z);
      mesh.receiveShadow = false;
      this.group.add(mesh);
      return { ...d, mesh };
    });
    scene.add(this.group);
  }

  /** Lagoon shallows for the ocean shader. */
  get shallows() {
    return this.items.map((d) => ({ x: d.x, z: d.z, shore: d.r * 1.05, reef: d.r * 1.45 }));
  }

  update(camera) {
    // sink with the curvature of the earth, like the ocean surface does
    for (const d of this.items) {
      const dist = Math.hypot(d.x - camera.position.x, d.z - camera.position.z);
      d.mesh.position.y = -(dist * dist) / EARTH_2R;
    }
  }
}
