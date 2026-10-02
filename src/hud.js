const $ = (id) => document.getElementById(id);
const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
const COMPASS_W = 560;
const COMPASS_FOV = 190;

export class HUD {
  constructor() {
    this.compass = $('compass-strip');
    this.ticks = [];
    for (let d = 0; d < 360; d += 15) {
      const el = document.createElement('div');
      el.className = CARDINALS[d] ? 'tick major' : 'tick';
      if (CARDINALS[d]) el.textContent = CARDINALS[d];
      this.compass.appendChild(el);
      this.ticks.push({ el, deg: d });
    }
    this.markers = [];
    this.toastTimer = null;
  }

  setLoading(p, msg) {
    $('load-bar-fill').style.width = `${Math.round(p * 100)}%`;
    $('status').textContent = msg;
  }

  ready() {
    document.body.classList.add('ready');
    $('status').textContent = '';
  }

  setMode(mode) {
    const b = document.body.classList;
    b.toggle('cinematic', mode === 'cinematic');
    b.toggle('photo', mode === 'photo');
    b.toggle('playing', mode === 'walk' || mode === 'fly');
  }

  showTitle(show) {
    document.body.classList.toggle('title', show);
  }

  setObjective(title, text) {
    $('obj-title').textContent = title;
    $('obj-text').innerHTML = text;
  }

  toast(msg, sub = '', ms = 3200) {
    const el = $('toast');
    $('toast-main').textContent = msg;
    $('toast-sub').textContent = sub;
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  hint(msg, ms = 5000) {
    const el = $('hint');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  blackout(on) {
    $('blackout').classList.toggle('on', on);
  }

  updateCompass(camera, markers) {
    const f = camera.getWorldDirection(this._f || (this._f = camera.position.clone()));
    const heading = (Math.atan2(f.x, -f.z) * 180) / Math.PI;
    const px = COMPASS_W / COMPASS_FOV;
    const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
    for (const t of this.ticks) {
      const d = wrap(t.deg - heading);
      const vis = Math.abs(d) < COMPASS_FOV / 2;
      t.el.style.display = vis ? '' : 'none';
      if (vis) {
        t.el.style.transform = `translateX(${COMPASS_W / 2 + d * px}px)`;
        t.el.style.opacity = String(1 - Math.pow(Math.abs(d) / (COMPASS_FOV / 2), 3));
      }
    }
    while (this.markers.length < markers.length) {
      const el = document.createElement('div');
      el.className = 'marker';
      el.innerHTML = '<i></i><span></span>';
      this.compass.appendChild(el);
      this.markers.push(el);
    }
    this.markers.forEach((el, i) => {
      const m = markers[i];
      if (!m) {
        el.style.display = 'none';
        return;
      }
      const dx = m.pos.x - camera.position.x, dz = m.pos.z - camera.position.z;
      const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      const d = wrap(bearing - heading);
      const clamped = Math.max(-COMPASS_FOV / 2, Math.min(COMPASS_FOV / 2, d));
      el.style.display = '';
      el.style.transform = `translateX(${COMPASS_W / 2 + clamped * px}px)`;
      el.className = `marker ${m.kind}${Math.abs(d) > COMPASS_FOV / 2 ? ' edge' : ''}`;
      el.style.setProperty('--c', m.color || '#fff');
      el.querySelector('span').textContent = m.showDist ? `${Math.round(Math.hypot(dx, dz))}m` : '';
    });
  }

  /** Light meter (0..1), orb charges and the recharge progress of the next one. */
  setVitals(light, charges, max, recharge, active) {
    const v = $('vitals');
    $('light-fill').style.width = `${Math.round(light * 100)}%`;
    v.classList.toggle('low', light < 0.35);
    v.classList.toggle('active', active);
    const pips = $('orb-pips');
    while (pips.children.length < max) pips.appendChild(Object.assign(document.createElement('div'), { className: 'pip' }));
    [...pips.children].forEach((p, i) => {
      p.classList.toggle('full', i < charges);
      p.style.setProperty('--fill', i === charges ? `${Math.round(recharge * 100)}%` : '0%');
    });
  }

  /** Dark edges that close in while shades are near. */
  setDread(k) {
    $('dread').style.opacity = k.toFixed(3);
  }

  debug(text) {
    $('hud').textContent = text;
  }
}
