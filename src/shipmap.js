import * as THREE from 'three';

// The ship's plan for changing stations: hold Ctrl and it comes up with the mouse released;
// click a mount to take it over. The silhouette is the ship model itself, rendered once from
// directly above in flat white; every gun mount aboard is marked on it, the ones the player can
// man as labelled buttons, each showing which way its guns are trained.

const KIND = { '5in-twin': '5"/38', '40mm-quad': '40mm', '20mm': '20mm', '20mm-twin': '20mm' };

export class ShipMap {
  constructor(renderer, ship, gunner, { onPick }) {
    this.renderer = renderer;
    this.ship = ship;
    this.gunner = gunner;
    this.onPick = onPick;
    this.el = document.getElementById('shipmap');
    this.plan = this.el.querySelector('.plan');
    this.img = this.el.querySelector('.plan img');
    this.marks = this.el.querySelector('.marks');
    this.isOpen = false;
    this.built = false;
    const L = ship.model.length, B = ship.model.beam;
    // plan bounds in ship space: bow (-z) to the right, port (-x) up, as a ship's plan is drawn
    this.zMin = -L / 2 - 3;
    this.zMax = L / 2 + 3;
    this.xMin = -B / 2 - 3;
    this.xMax = B / 2 + 3;
  }

  // ship-space (x, z) to percentages across and down the plan
  toPlan(x, z) {
    return [((this.zMax - z) / (this.zMax - this.zMin)) * 100, ((x - this.xMin) / (this.xMax - this.xMin)) * 100];
  }

  // The plan: the model seen from directly above as a height map (a depth pass with an
  // orthographic camera), shaded by level and outlined where the height steps, so the hull,
  // turrets, superstructure and gun tubs read as they do on a ship's plan.
  silhouette() {
    const r = this.renderer;
    const W = 2400;
    const H = Math.round((W * (this.xMax - this.xMin)) / (this.zMax - this.zMin));
    const TOP = 46; // the camera's height; the plan shades from the waterline up to here
    const g = this.ship.group;
    const parent = g.parent;
    const pos = g.position.clone();
    const quat = g.quaternion.clone();
    const scene = new THREE.Scene();
    scene.overrideMaterial = new THREE.MeshDepthMaterial();
    scene.add(g);
    g.position.set(0, 0, 0);
    g.quaternion.identity();
    scene.updateMatrixWorld(true);
    // looking straight down with port (-x) up, so screen right is the bow (-z)
    const w = (this.zMax - this.zMin) / 2, h = (this.xMax - this.xMin) / 2;
    const cam = new THREE.OrthographicCamera(-w, w, h, -h, 0.5, TOP);
    cam.position.set((this.xMin + this.xMax) / 2, TOP, (this.zMin + this.zMax) / 2);
    cam.up.set(-1, 0, 0);
    cam.lookAt(cam.position.x, 0, cam.position.z);
    const rt = new THREE.WebGLRenderTarget(W, H);
    const prevTarget = r.getRenderTarget();
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(scene, cam);
    const px = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, px);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevAlpha);
    rt.dispose();
    scene.overrideMaterial.dispose();
    parent.add(g);
    g.position.copy(pos);
    g.quaternion.copy(quat);
    g.updateMatrixWorld(true);

    // height (0 at the waterline, 1 at TOP) per pixel, flipped: GL rows run bottom up
    const ht = new Float32Array(W * H);
    const on = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        on[i] = px[src + x * 4 + 3] > 0 ? 1 : 0;
        ht[i] = px[src + x * 4] / 255;
      }
    }
    const big = document.createElement('canvas');
    big.width = W;
    big.height = H;
    const ctx = big.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!on[i]) continue;
        const k = ht[i];
        // outlines where the height steps (or at the deck edge)
        let edge = 0;
        for (const j of [i - 1, i + 1, i - W, i + W]) edge = Math.max(edge, on[j] ? Math.abs(ht[j] - k) : 1);
        const line = edge > 0.012 ? 1 : 0;
        const t = Math.pow(k, 0.8);
        d[i * 4] = 52 + 120 * t + 60 * line;
        d[i * 4 + 1] = 66 + 128 * t + 56 * line;
        d[i * 4 + 2] = 84 + 132 * t + 44 * line;
        d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const small = document.createElement('canvas');
    small.width = W / 2;
    small.height = Math.round(H / 2);
    small.getContext('2d').drawImage(big, 0, 0, small.width, small.height);
    this.img.src = small.toDataURL('image/png');
    this.plan.style.aspectRatio = `${W} / ${H}`;
  }

  build() {
    this.built = true;
    this.silhouette();
    this.marks.textContent = '';
    // arcs of fire, drawn in metres on the plan (the plan keeps the ship's proportions)
    const W = this.zMax - this.zMin, H = this.xMax - this.xMin;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.classList.add('arcs');
    this.arcCur = document.createElementNS(this.svg.namespaceURI, 'path');
    this.arcHover = document.createElementNS(this.svg.namespaceURI, 'path');
    this.arcCur.classList.add('cur');
    this.arcHover.classList.add('hover');
    this.svg.append(this.arcCur, this.arcHover);
    this.marks.appendChild(this.svg);
    // any gun aboard the player can't man, as a dot
    const manned = new Set(this.gunner.stations.map((s) => s.mount));
    for (const m of this.ship.mounts) {
      if (manned.has(m)) continue;
      const [u, v] = this.toPlan(m.pos.x, m.pos.z);
      const d = document.createElement('i');
      d.className = `dot k${m.kind.replace(/[^a-z0-9]/gi, '')}`;
      d.style.left = `${u}%`;
      d.style.top = `${v}%`;
      this.marks.appendChild(d);
    }
    // every station: a button on the mount, labelled (the 20mm only on hover or under its tab)
    this.buttons = this.gunner.stations.map((st, i) => {
      const m = st.mount;
      const [u, v] = this.toPlan(m.pos.x, m.pos.z);
      const b = document.createElement('button');
      const side = m.pos.x < -0.5 ? 'port' : m.pos.x > 0.5 ? 'stbd' : 'centre';
      const k = st.spec.kind.replace(/[^a-z0-9]/gi, '');
      b.className = `st ${side} k${k}`;
      b.dataset.kind = st.spec.kind.startsWith('20') ? '20' : st.spec.kind.startsWith('40') ? '40' : '5';
      b.style.left = `${u}%`;
      b.style.top = `${v}%`;
      b.innerHTML = `<span class="ring"><span class="bore"></span></span><span class="lbl"><b>${st.label}</b><em>${KIND[st.spec.kind] || st.spec.kind}</em></span>`;
      b.title = st.spec.name;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onPick(i);
      });
      b.addEventListener('mouseenter', () => this.drawArc(this.arcHover, st));
      b.addEventListener('mouseleave', () => this.arcHover.setAttribute('d', ''));
      this.marks.appendChild(b);
      return { b, u, side, kind: b.dataset.kind };
    });
    // labels that would run into a neighbour's on the same side step out a row (the 20mm, whose
    // labels only show under their own tab, are laid out among themselves)
    for (const group of [['5', '40'], ['20']]) {
      for (const side of ['port', 'stbd', 'centre']) {
        const rows = [];
        for (const it of this.buttons.filter((o) => o.side === side && group.includes(o.kind)).sort((a, c) => a.u - c.u)) {
          let row = 0;
          while (rows[row] !== undefined && it.u - rows[row] < (it.kind === '20' ? 3.2 : 4.6)) row++;
          rows[row] = it.u;
          it.b.style.setProperty('--row', row);
        }
      }
    }
    this.buttons = this.buttons.map((o) => o.b);
    // the filter tabs
    for (const tab of this.el.querySelectorAll('.tabs button')) {
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        this.filter(tab.dataset.f);
      });
    }
    this.filter('all');
  }

  filter(f) {
    this.el.dataset.filter = f;
    for (const tab of this.el.querySelectorAll('.tabs button')) tab.classList.toggle('on', tab.dataset.f === f);
  }

  // a mount's arc of fire as a wedge: train 0 is the bow (right on the plan), positive to port (up)
  drawArc(path, st) {
    const m = st.mount;
    const cx = this.zMax - m.pos.z, cy = m.pos.x - this.xMin;
    const R = st.spec.kind === '5in-twin' ? 34 : st.spec.kind === '40mm-quad' ? 26 : 16;
    const [a0, a1] = m.arc;
    const p = (a) => `${(cx + R * Math.cos(a)).toFixed(2)} ${(cy - R * Math.sin(a)).toFixed(2)}`;
    if (a1 - a0 >= Math.PI * 2 - 1e-3) {
      path.setAttribute('d', `M ${cx - R} ${cy} a ${R} ${R} 0 1 0 ${2 * R} 0 a ${R} ${R} 0 1 0 ${-2 * R} 0`);
      return;
    }
    const large = a1 - a0 > Math.PI ? 1 : 0;
    path.setAttribute('d', `M ${cx} ${cy} L ${p(a0)} A ${R} ${R} 0 ${large} 0 ${p(a1)} Z`);
  }

  show() {
    if (!this.built) this.build();
    this.isOpen = true;
    this.el.classList.add('on');
    document.body.classList.add('mapopen');
    this.update();
  }

  hide() {
    this.isOpen = false;
    this.el.classList.remove('on');
    document.body.classList.remove('mapopen');
  }

  /** While open: the current station, and which way every station's guns are trained. */
  update() {
    if (!this.isOpen || !this.buttons) return;
    const cur = this.gunner.index;
    this.gunner.stations.forEach((st, i) => {
      const b = this.buttons[i];
      b.classList.toggle('on', i === cur);
      // train 0 is the bow (right on the plan), positive to port (up)
      b.firstChild.firstChild.style.transform = `rotate(${-st.mount.train}rad)`;
    });
    const st = this.gunner.station;
    if (this.curName !== st.spec.name) {
      this.curName = st.spec.name;
      this.el.querySelector('.cur').textContent = st.spec.name;
      this.drawArc(this.arcCur, st);
    }
  }
}
