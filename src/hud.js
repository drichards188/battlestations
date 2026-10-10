import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
const COMPASS_W = 560;
const COMPASS_FOV = 190;
const MAX_BRACKETS = 24;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class HUD {
  constructor() {
    this.compass = $('compass-strip');
    this.ticks = [];
    for (let d = 0; d < 360; d += 15) {
      const el = document.createElement('div');
      el.className = CARDINALS[d] ? 'tick major' : 'tick';
      el.textContent = CARDINALS[d] || (d % 45 === 0 ? '' : '');
      this.compass.appendChild(el);
      this.ticks.push({ el, deg: d });
    }
    this.markers = [];
    this.brackets = [];
    const layer = $('brackets');
    for (let i = 0; i < MAX_BRACKETS; i++) {
      const el = document.createElement('div');
      el.className = 'bracket';
      el.innerHTML = '<span></span>';
      layer.appendChild(el);
      this.brackets.push(el);
    }
    this.toastTimer = null;
    this.radioLines = [];
    this.lastHeat = -1;
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
    b.toggle('playing', mode === 'gun');
  }

  showTitle(show) {
    document.body.classList.toggle('title', show);
  }

  setRaid(title, sub) {
    $('obj-title').textContent = title;
    $('obj-text').textContent = sub;
  }

  setRemaining(n) {
    $('obj-count').textContent = n > 0 ? `${n} enemy aircraft inbound` : '';
  }

  setScore(s) {
    $('score').textContent = s.toLocaleString('en-US');
  }

  toast(msg, sub = '', ms = 3200) {
    const el = $('toast');
    $('toast-main').textContent = msg;
    $('toast-sub').textContent = sub;
    el.classList.remove('show');
    void el.offsetWidth;
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

  /** A line in the radio log. kind: info | radar | warn | alert */
  radio(text, kind = 'info') {
    const log = $('radio');
    const el = document.createElement('div');
    el.className = `line ${kind}`;
    el.textContent = text;
    log.appendChild(el);
    this.radioLines.push({ el, t: performance.now() });
    while (this.radioLines.length > 6) this.radioLines.shift().el.remove();
    requestAnimationFrame(() => el.classList.add('in'));
  }

  kill(text, pts, assist = false) {
    const el = $('kill');
    el.querySelector('.k-main').textContent = text;
    el.querySelector('.k-pts').textContent = `+${pts}`;
    el.classList.toggle('assist', assist);
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  hitMarker() {
    const el = $('hitmark');
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  blackout(on) {
    $('blackout').classList.toggle('on', on);
  }

  damageFlash(k = 1) {
    const el = $('dmg');
    el.style.transition = 'none';
    el.style.opacity = String(Math.min(1, k));
    void el.offsetWidth;
    el.style.transition = 'opacity 1.6s ease-out';
    el.style.opacity = '0';
  }

  setStation(st, index, count) {
    $('station-name').textContent = st.spec.name;
    $('station-index').textContent = `${index + 1}/${count}`;
    document.body.classList.toggle('twenty', !!st.ammo);
    document.body.classList.toggle('five', !!st.five);
  }

  /** Gun status: barrel heat or magazines, and the cutout/overheat/reload state. */
  setGun(st, blocked) {
    const heat = st.heat;
    $('heat-fill').style.width = `${Math.round(heat * 100)}%`;
    $('gun').classList.toggle('hot', heat > 0.75 || st.overheated);
    let status = '';
    if (st.overheated) status = 'Barrels overheated';
    else if (st.reload > 0) status = 'Changing drums';
    else if (blocked) status = 'Firing cutout';
    else if (st.feed && st.feed.jammed >= 0) status = `Gun ${st.feed.jammed + 1} jammed, loader clearing it`;
    else if (st.dry) status = 'Waiting on the loaders';
    $('gun-status').textContent = status;
    if (st.ammo) $('ammo').textContent = st.ammo.map((a) => String(a).padStart(2, '0')).join('  ');
    if (st.five) {
      // where each gun's loading crew is: the case out, projectile and powder on the tray, rammed
      const stage = (g) => {
        const k = g.t / (g.dur || 1);
        return k >= 1 ? 'READY' : k < 0.2 ? 'CASE OUT' : k < 0.5 ? 'PROJECTILE' : k < 0.75 ? 'POWDER' : 'RAMMING';
      };
      const text = `L ${stage(st.five[0])}   R ${stage(st.five[1])}`;
      if (text !== this.fiveText) $('ammo').textContent = this.fiveText = text;
    }
    if (st.feed) this.setFeed(st.feed, st.dry);
  }

  /**
   * Each gun's loader as the crew sees it: the round on the rammer tray, the seven the guides
   * hold above it, and the clip the first loader has ready; then the ready supply behind them.
   */
  setFeed(feed, dry) {
    const guns = feed.hudState;
    const key = JSON.stringify(guns) + feed.rack + '|' + feed.lockers + dry;
    if (key === this.feedKey) return;
    this.feedKey = key;
    const pips = (n, on) => Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
    $('feed').innerHTML = guns
      .map((g) => {
        const cls = ['g', g.stopped ? 'dry' : '', g.jam ? 'jam' : ''].join(' ');
        const hand = g.hand ? `<div class="c ${g.hand === 'ready' ? 'in' : 'go'}">${pips(4, 4)}</div>` : '<div class="c in"></div>';
        return `<div class="${cls}"><i class="tray${g.tray ? ' on' : ''}"></i><div class="c">${pips(feed.cap, g.rounds)}</div>${hand}</div>`;
      })
      .join('');
    const sup = $('supply');
    sup.innerHTML = `ready racks <b>${feed.rack}</b> clips · lockers <b>${feed.lockers}</b>`;
    sup.classList.toggle('low', feed.rack === 0);
  }

  setShips(list) {
    const el = $('ships');
    if (!this.shipEls) {
      this.shipEls = list.map((s) => {
        const row = document.createElement('div');
        row.className = `ship ${s.tag}`;
        row.innerHTML = `<span class="n"></span><div class="bar"><i></i></div>`;
        row.querySelector('.n').textContent = s.name;
        el.appendChild(row);
        return row;
      });
    }
    list.forEach((s, i) => {
      const row = this.shipEls[i];
      const k = Math.max(0, s.hp / s.maxHp);
      row.querySelector('i').style.width = `${Math.round(k * 100)}%`;
      row.classList.toggle('low', k < 0.35);
      row.classList.toggle('sunk', s.sunk);
      row.classList.toggle('burning', s.fires > 0);
    });
  }

  updateCompass(camera, markers) {
    const f = camera.getWorldDirection(_v);
    const heading = (Math.atan2(f.x, -f.z) * 180) / Math.PI;
    $('heading').textContent = String(Math.round((heading + 360) % 360)).padStart(3, '0');
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
      el.querySelector('span').textContent = m.label || '';
    });
  }

  /**
   * Sight overlay: brackets on aircraft in view, the designated target with range,
   * the lead pip and the commanded aim point.
   */
  updateSight(camera, planes, gunner, assist, showBrackets) {
    const w = innerWidth, h = innerHeight;
    const proj = (p, out) => {
      out.copy(p).project(camera);
      if (out.z > 1 || out.z < -1) return false;
      out.x = (out.x * 0.5 + 0.5) * w;
      out.y = (-out.y * 0.5 + 0.5) * h;
      return out.x > -40 && out.x < w + 40 && out.y > -40 && out.y < h + 40;
    };
    let n = 0;
    for (const p of planes) {
      if (!p.alive || n >= MAX_BRACKETS) continue;
      const d = camera.position.distanceTo(p.pos);
      const designated = p === gunner.target;
      if (!designated && (!showBrackets || d > 5000)) continue;
      if (!proj(p.pos, _v)) continue;
      const el = this.brackets[n++];
      const size = THREE.MathUtils.clamp((p.radius * 2 * h) / (d * 2 * Math.tan((camera.fov * Math.PI) / 360)), 14, 90);
      el.style.display = '';
      el.style.transform = `translate(${_v.x - size / 2}px, ${_v.y - size / 2}px)`;
      el.style.width = el.style.height = `${size}px`;
      el.className = designated ? 'bracket on' : 'bracket';
      el.firstChild.textContent = designated ? `${p.def.label}  ${(d / 1000).toFixed(1)} km` : '';
    }
    for (let i = n; i < MAX_BRACKETS; i++) this.brackets[i].style.display = 'none';

    const pip = $('lead');
    if (assist && gunner.leadValid && proj(gunner.lead, _v)) {
      pip.style.display = '';
      pip.style.transform = `translate(${_v.x}px, ${_v.y}px)`;
    } else pip.style.display = 'none';

    const cmd = $('command');
    const dir = gunner.commandDir(_w);
    const far = _v.copy(camera.position).addScaledVector(dir, 1000);
    if (proj(far, _v) && Math.hypot(_v.x - w / 2, _v.y - h / 2) > 6) {
      cmd.style.display = '';
      cmd.style.transform = `translate(${_v.x}px, ${_v.y}px)`;
    } else cmd.style.display = 'none';
  }

  hideSight() {
    for (const b of this.brackets) b.style.display = 'none';
    $('lead').style.display = 'none';
    $('command').style.display = 'none';
  }

  /** After-action report. */
  showEnd(r, { onRestart, onContinue }) {
    const el = $('end');
    $('end-title').textContent = r.victory ? 'Raid repulsed' : r.title;
    $('end-sub').textContent = r.victory ? 'The task group holds' : r.sub;
    const types = Object.entries(r.byType).map(([k, v]) => `${v} ${k[0].toUpperCase() + k.slice(1)}${v > 1 ? 's' : ''}`).join(', ') || 'none';
    $('end-stats').innerHTML = `
      <div><span>Score</span><b>${r.score.toLocaleString('en-US')}</b></div>
      <div><span>Your kills</span><b>${r.kills}</b><small>${types}</small></div>
      <div><span>Assists</span><b>${r.assists}</b></div>
      <div><span>Shot down by the fleet</span><b>${r.fleetKills}</b></div>
      <div><span>Rounds fired</span><b>${r.fired}</b><small>${(r.accuracy * 100).toFixed(1)}% hits</small></div>
      <div><span>Hull integrity</span><b>${Math.round(r.hull * 100)}%</b></div>
      <div><span>Ships lost</span><b>${r.shipsLost.length || 'none'}</b><small>${r.shipsLost.join(', ')}</small></div>`;
    el.classList.toggle('victory', r.victory);
    $('end-continue').style.display = r.victory ? '' : 'none';
    $('end-restart').onclick = onRestart;
    $('end-continue').onclick = onContinue;
    document.body.classList.add('ended');
  }

  hideEnd() {
    document.body.classList.remove('ended');
  }

  debug(text) {
    $('hud').textContent = text;
  }
}
