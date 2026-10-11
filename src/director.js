import * as THREE from 'three';
import { PLANES } from './air.js';

const rr = (a, b) => a + (b - a) * Math.random();
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export const DIFFICULTY = {
  Recruit: { count: 0.7, hp: 0.85, accuracy: 0.7, gunnery: 0.9, lethality: 0.14, shipDamage: 0.55, assist: true },
  Gunner: { count: 1, hp: 1, accuracy: 1, gunnery: 1, lethality: 0.1, shipDamage: 0.9, assist: true },
  Veteran: { count: 1.3, hp: 1.15, accuracy: 1.25, gunnery: 1.2, lethality: 0.072, shipDamage: 1.25, assist: false },
};

// Each raid: groups attack from the raid bearing plus an offset. The sun sinks raid by raid.
const RAIDS = [
  {
    title: 'First strike',
    sub: 'Dive bombers with fighter escort',
    sun: 38,
    groups: [
      { type: 'val', role: 'dive', count: 6, alt: 2000 },
      { type: 'zero', role: 'strafe', count: 3, alt: 2300, offset: 15 },
    ],
  },
  {
    title: 'Torpedo attack',
    sub: 'Torpedo bombers coming in low',
    sun: 32,
    groups: [
      { type: 'kate', role: 'torpedo', count: 6, alt: 500 },
      { type: 'zero', role: 'strafe', count: 4, alt: 1800, offset: 40, delay: 8 },
    ],
  },
  {
    title: 'Coordinated strike',
    sub: 'Dive and torpedo bombers from two sides',
    sun: 26,
    groups: [
      { type: 'val', role: 'dive', count: 6, alt: 2200 },
      { type: 'kate', role: 'torpedo', count: 6, alt: 450, offset: 110, delay: 5 },
      { type: 'zero', role: 'strafe', count: 5, alt: 2000, offset: -30 },
    ],
  },
  {
    title: 'Special attack unit',
    sub: 'Kamikaze',
    sun: 20,
    groups: [
      { type: 'zero', role: 'kamikaze', count: 5, alt: 2600 },
      { type: 'zero', role: 'kamikaze', count: 4, alt: 30, offset: 80, delay: 10 },
      { type: 'zero', role: 'strafe', count: 4, alt: 2000, offset: -40 },
    ],
  },
  {
    title: 'Land-based bombers',
    sub: 'Bettys making a torpedo run',
    sun: 14,
    groups: [
      { type: 'betty', role: 'torpedo', count: 7, alt: 650 },
      { type: 'zero', role: 'strafe', count: 4, alt: 1800, offset: 25 },
      { type: 'val', role: 'dive', count: 4, alt: 2200, offset: -90, delay: 15 },
    ],
  },
  {
    title: 'All-out attack',
    sub: 'Everything they have left',
    sun: 8,
    groups: [
      { type: 'val', role: 'dive', count: 8, alt: 2300 },
      { type: 'kate', role: 'torpedo', count: 6, alt: 450, offset: 90, delay: 6 },
      { type: 'zero', role: 'kamikaze', count: 6, alt: 2500, offset: -75, delay: 12 },
      { type: 'zero', role: 'strafe', count: 5, alt: 2000, offset: 30 },
    ],
  },
];

// Night action. The Japanese turned to dusk and night torpedo attacks in 1943 because the US day
// air cover and AA had grown too strong: "Bettys, their targets frequently exposed under brilliant
// flares, attacked with considerable effectiveness" (COMINCH Antiaircraft Action Summary, World
// War II, Oct 1945). A snooper shadows the force at dusk and marks its track with float lights;
// flare planes hang parachute flares beyond the ships; the torpedo planes come in low, most from
// one side and a few from another (Intelligence Bulletin, Dec 1943). No fighter escort and no
// strafing by night. The Kates stand in for the B6N Jills and the Vals for the single-engine
// bombers that harassed by flare light. The moon is a waxing crescent setting in the west, as on
// the night of 29 March 1944 when Alabama's group (TG 58.3) fought off a night attack off Palau
// and she shot down one plane on her own (DANFS). `sun` is the sun's elevation (below the horizon).
export const NIGHT_MOON = { dElev: 54, dAz: -16 }; // ~57 degrees from the sun: a crescent, about a quarter lit
const NIGHT_RAIDS = [
  {
    title: 'Evening twilight',
    sub: 'A snooper and torpedo planes out of the darkening east',
    sun: -5,
    fromDark: true, // the attackers come from the dark side, the ships against the afterglow
    groups: [
      { type: 'betty', role: 'flare', count: 1, alt: 1000, drop: 'float', offset: 160 },
      { type: 'kate', role: 'torpedo', count: 5, alt: 450 },
    ],
  },
  {
    title: 'Under the flares',
    sub: 'Bettys attacking by flare light',
    sun: -10,
    groups: [
      { type: 'betty', role: 'flare', count: 2, alt: 1000, offset: 70 },
      { type: 'betty', role: 'torpedo', count: 6, alt: 600, delay: 24 },
      { type: 'betty', role: 'torpedo', count: 2, alt: 600, offset: 110, delay: 28 },
    ],
  },
  {
    title: 'Harassing attack',
    sub: 'Bombers gliding in under the flares',
    sun: -15,
    groups: [
      { type: 'betty', role: 'flare', count: 1, alt: 1000, offset: -60 },
      { type: 'val', role: 'dive', count: 4, alt: 2100, delay: 22 },
      { type: 'kate', role: 'torpedo', count: 4, alt: 450, offset: 140, delay: 20 },
    ],
  },
  {
    title: 'Torpedoes from both beams',
    sub: 'Kates and Bettys from two sides',
    sun: -20,
    groups: [
      { type: 'betty', role: 'flare', count: 2, alt: 1000, offset: 60 },
      { type: 'kate', role: 'torpedo', count: 6, alt: 450, delay: 22 },
      { type: 'betty', role: 'torpedo', count: 5, alt: 600, offset: 160, delay: 28 },
    ],
  },
  {
    title: 'The main strike',
    sub: 'Land-based Bettys in strength',
    sun: -26,
    groups: [
      { type: 'betty', role: 'flare', count: 2, alt: 1000, offset: -70 },
      { type: 'betty', role: 'torpedo', count: 8, alt: 600, delay: 24 },
      { type: 'kate', role: 'torpedo', count: 4, alt: 450, offset: 90, delay: 28 },
    ],
  },
  {
    title: 'Last attack',
    sub: 'Everything they can put in the air',
    sun: -32,
    groups: [
      { type: 'betty', role: 'flare', count: 3, alt: 1000, offset: 60 },
      { type: 'betty', role: 'torpedo', count: 7, alt: 600, delay: 24 },
      { type: 'kate', role: 'torpedo', count: 6, alt: 450, offset: -100, delay: 26 },
      { type: 'val', role: 'dive', count: 3, alt: 2100, offset: 40, delay: 30 },
    ],
  },
];

const ROLE_NAME = { dive: 'dive bombers', torpedo: 'torpedo planes', strafe: 'fighters', kamikaze: 'kamikazes', flare: 'snoopers' };
// "on the port bow", but "dead ahead" / "dead astern" as they are
const onThe = (where) => (where.startsWith('dead') ? where : `on the ${where}`);
const fmtBearing = (deg) => String(Math.round(((deg % 360) + 360) % 360)).padStart(3, '0');

export class Director {
  constructor({ air, fleet, hud, audio, gunner, ordnance, ballistics }) {
    Object.assign(this, { air, fleet, hud, audio, gunner, ordnance, ballistics });
    this.state = 'idle';
    this.t = 0;
    this.raid = -1;
    this.score = 0;
    this.combat = 0;
    this.attract = false;
    this.endless = false;
    this.sunTarget = 38;
    this.sunBearing = 278; // compass bearing of the sun, kept up to date by main
    this.night = false;
    this.raids = RAIDS;
    this.diff = DIFFICULTY.Gunner;
    this.stats = this.freshStats();
    this.events = { end: null };
    this.calledBreak = new Set();
    this.flareCall = -99;
    this.floatCall = -99;
    this.clock = 0;
  }

  /** 'Day' or 'Night': picks the raid schedule (the day one is untouched) and the sky to match. */
  setTimeOfDay(tod) {
    this.night = tod === 'Night';
    this.fleet.night = this.night;
    this.raids = this.night ? NIGHT_RAIDS : RAIDS;
    if (this.state === 'idle' || this.attract) this.sunTarget = this.night ? -9 : 30;
  }

  /** Where the sun should be when a battle (or the title screen) starts. */
  get startSun() {
    return this.attract ? (this.night ? -9 : 30) : this.raids[0].sun + (this.night ? 2 : 4);
  }

  freshStats() {
    return { kills: 0, assists: 0, byType: {}, fleetKills: 0, escaped: 0, hitsTaken: 0, raids: 0, shipsLost: [] };
  }

  applyDifficulty(name) {
    this.diff = DIFFICULTY[name] || DIFFICULTY.Gunner;
    // night torpedo attacks went in fast and low at targets the pilots could barely judge: the T
    // Attack Force's first big night strike off Formosa (12 Oct 1944) hit nothing
    this.air.difficulty.accuracy = this.diff.accuracy * (this.night ? 0.65 : 1);
    this.air.difficulty.hp = this.diff.hp;
    // "night attacks, in which fire control was less accurate" (AA Action Summary): the 5in fired
    // blind on radar, but the 40mm and 20mm directors were optical until the Mk 57 and Mk 63 of 1945
    this.fleet.difficulty.gunnery = this.diff.gunnery * (this.night ? 1.3 : 1);
    this.fleet.difficulty.shipDamage = this.diff.shipDamage;
    this.fleet.difficulty.lethality = this.attract ? 0.18 : this.diff.lethality;
  }

  reset() {
    this.air.clear();
    this.ordnance.clear();
    this.ballistics.clear();
    this.fleet.reset();
    this.raid = -1;
    this.score = 0;
    this.stats = this.freshStats();
    this.endless = false;
    this.calledBreak.clear();
    this.flareCall = this.floatCall = -99;
  }

  /** Title screen: raids keep coming, nothing can sink, nothing is scored. */
  startAttract() {
    this.attract = true;
    for (const s of this.fleet.ships) s.invulnerable = true;
    this.state = 'lull';
    this.t = 4;
    this.sunTarget = this.startSun;
  }

  /** The title screen's practice raids start over (after switching day and night). */
  restartAttract() {
    this.air.clear();
    this.ordnance.clear();
    this.ballistics.clear();
    this.raid = -1;
    this.startAttract();
  }

  start(difficulty, timeOfDay = this.night ? 'Night' : 'Day') {
    this.attract = false;
    this.setTimeOfDay(timeOfDay);
    this.applyDifficulty(difficulty);
    this.reset();
    for (const s of this.fleet.ships) s.invulnerable = false;
    this.state = 'brief';
    this.t = 0;
    this.sunTarget = this.startSun;
    this.hud.setRaid('General quarters', this.night ? 'Darken ship. Man your battle stations' : 'Man your battle stations');
    this.hud.setScore(0);
  }

  get raidCount() {
    return this.raids.length;
  }

  /** A flare lit or a float light hit the water. */
  onFlare(pos, kind) {
    if (this.attract || this.state !== 'raid') return;
    const where = this.relative(pos);
    if (kind === 'para' && this.clock - this.flareCall > 25) {
      this.flareCall = this.clock;
      this.hud.radio(pick([`Flares! Flares ${onThe(where)}. They're lighting us up.`, `Parachute flares, ${where}! Watch the other side for torpedo planes.`]), 'warn');
    } else if (kind === 'float' && this.clock - this.floatCall > 40) {
      this.floatCall = this.clock;
      this.hud.radio(`Float lights on the water, ${where}. They're marking our track.`, 'warn');
    }
  }

  // ---------------------------------------------------------------- events
  onKill(p, { byPlayer, assist }) {
    if (this.attract) return;
    const def = PLANES[p.type];
    if (byPlayer) {
      this.stats.kills++;
      this.stats.byType[p.type] = (this.stats.byType[p.type] || 0) + 1;
      const pts = def.score + (p.role === 'kamikaze' && p.phase === 'terminal' ? 100 : 0) + (p.ordnance ? 50 : 0);
      this.score += pts;
      this.hud.kill(`Splash one ${def.label.toLowerCase()}`, pts);
      this.audio.kill();
    } else if (assist) {
      this.stats.assists++;
      const pts = Math.round(def.score * 0.35);
      this.score += pts;
      this.hud.kill('Assist', pts, true);
    } else this.stats.fleetKills++;
    this.hud.setScore(this.score);
  }

  onEscape() {
    this.stats.escaped++;
  }

  onShipDamaged(ship, kind) {
    if (this.attract) return;
    const own = ship === this.fleet.own;
    const what = kind === 'torpedo' ? 'torpedo' : kind === 'kamikaze' ? 'kamikaze' : kind === 'bomb' ? 'bomb' : null;
    if (!what) return;
    if (own) this.stats.hitsTaken++;
    if (own) this.hud.radio(pick([`We're hit! ${what === 'torpedo' ? 'Torpedo' : what === 'bomb' ? 'Bomb' : 'Kamikaze'} hit, damage control parties away!`, `${what[0].toUpperCase() + what.slice(1)} hit amidships! Fire on the main deck!`]), 'alert');
    else this.hud.radio(`${ship.name} ${what === 'torpedo' ? 'takes a torpedo' : what === 'bomb' ? 'hit by a bomb' : 'hit by a kamikaze'}!`, 'warn');
  }

  onShipSunk(ship) {
    if (this.attract) return;
    this.stats.shipsLost.push(ship.name);
    this.hud.radio(`${ship.name} is going down.`, 'alert');
    if (ship === this.fleet.own) this.finish(false, `${ship.name} is lost`, 'Abandon ship');
    else if (ship === this.fleet.carrier) this.finish(false, `${ship.name} is lost`, 'The carrier went down');
  }

  onTorpedo(t) {
    if (this.attract) return;
    const own = this.fleet.own;
    const rx = own.position.x - t.pos.x, rz = own.position.z - t.pos.z;
    const d = Math.hypot(rx, rz);
    if (d > 2500) return;
    const lateral = Math.abs(rx * t.dir.z - rz * t.dir.x);
    if ((rx * t.dir.x + rz * t.dir.z) > 0 && lateral < 160) this.hud.radio(`Torpedo wake, ${this.relative(t.pos)}! Coming at us!`, 'alert');
  }

  /** "on the starboard bow" style description of a world position relative to our ship */
  relative(pos) {
    const own = this.fleet.own;
    const b = Math.atan2(pos.x - own.position.x, -(pos.z - own.position.z));
    let rel = THREE.MathUtils.radToDeg(b - own.heading);
    rel = ((rel % 360) + 540) % 360 - 180;
    const side = rel >= 0 ? 'starboard' : 'port';
    const a = Math.abs(rel);
    if (a < 15) return 'dead ahead';
    if (a > 165) return 'dead astern';
    if (a < 60) return `${side} bow`;
    if (a < 120) return `${side} beam`;
    return `${side} quarter`;
  }

  // ---------------------------------------------------------------- flow
  spawnRaid(index) {
    const RAIDS = this.raids;
    const r = index < RAIDS.length ? RAIDS[index] : this.endlessRaid(index);
    const own = this.fleet.own;
    // at dusk the attackers come out of the dark half of the sky, opposite the afterglow
    const bearing = r.fromDark ? this.sunBearing + 180 + rr(-50, 50) : rr(0, 360);
    const scale = this.attract ? 0.7 : this.diff.count * (index >= RAIDS.length ? 1 + (index - RAIDS.length) * 0.15 : 1);
    this.sunTarget = r.sun;
    let first = true;
    for (const g of r.groups) {
      // flare planes come in ones and twos whatever the size of the raid
      const count = g.role === 'flare' ? g.count : Math.max(1, Math.round(g.count * scale));
      const brg = bearing + (g.offset || 0);
      // flare planes were already shadowing the force, so they arrive first
      const dist = (g.role === 'flare' ? 5400 : g.role === 'torpedo' ? 7800 : 7200) + rr(-300, 300) + (g.delay || 0) * 110;
      this.air.spawnGroup({
        type: g.type,
        count,
        role: g.role,
        bearing: brg,
        distance: dist,
        altitude: g.alt ?? 1800,
        center: this.fleet.center,
        pickTarget: () => this.fleet.pickTarget(this.attract ? 1 : 1.15),
        drop: g.drop || 'para',
        attackBearing: bearing,
      });
      if (!this.attract) {
        const miles = Math.round(dist / 1852);
        const angels = Math.max(1, Math.round((g.alt ?? 1800) * 3.28 / 1000));
        const low = (g.alt ?? 1800) < 200;
        // by night radar gives a count and a bearing; nobody can see what type they are
        const what = this.night ? (g.role === 'flare' ? (count > 1 ? 'snoopers' : 'snooper') : 'bogeys') : ROLE_NAME[g.role];
        this.hud.radio(
          `Radar: ${count} ${what} bearing ${fmtBearing(brg)}, ${miles} miles, ${low ? 'on the deck' : `angels ${angels}`}.`,
          first ? 'radar' : 'info'
        );
        first = false;
      }
    }
    if (!this.attract) {
      this.hud.setRaid(`Raid ${index + 1}${index < RAIDS.length ? ` of ${RAIDS.length}` : ''}: ${r.title}`, r.sub);
      this.hud.toast(r.title, r.sub, 4200);
      this.audio.radio();
    }
  }

  endlessRaid(index) {
    const RAIDS = this.raids;
    const n = index - RAIDS.length;
    if (this.night) {
      const roles = [
        { type: 'betty', role: 'torpedo', count: 6, alt: 600, delay: 24 },
        { type: 'kate', role: 'torpedo', count: 5, alt: 450, offset: rr(60, 140), delay: 26 },
        { type: 'betty', role: 'torpedo', count: 4, alt: 600, offset: rr(140, 220), delay: 28 },
        { type: 'val', role: 'dive', count: 3, alt: 2100, offset: rr(-100, -40), delay: 30 },
      ];
      const k = 2 + Math.min(2, Math.floor(n / 2));
      const groups = [{ type: 'betty', role: 'flare', count: 2, alt: 1000, offset: rr(40, 80) }, ...roles.sort(() => Math.random() - 0.5).slice(0, k)];
      return { title: `Raid ${index + 1}`, sub: 'They keep coming', sun: Math.max(-40, -32 - n), groups };
    }
    const roles = [
      { type: 'val', role: 'dive', count: 6, alt: 2200 },
      { type: 'kate', role: 'torpedo', count: 6, alt: 450, offset: rr(60, 140) },
      { type: 'zero', role: 'kamikaze', count: 5, alt: 2500, offset: rr(-100, -40) },
      { type: 'betty', role: 'torpedo', count: 5, alt: 650, offset: rr(140, 220) },
      { type: 'zero', role: 'strafe', count: 5, alt: 2000, offset: 20 },
    ];
    const k = 2 + Math.min(3, Math.floor(n / 2));
    const groups = roles.sort(() => Math.random() - 0.5).slice(0, k);
    return { title: `Raid ${index + 1}`, sub: 'They keep coming', sun: Math.max(4, 8 - n), groups };
  }

  finish(victory, title, sub) {
    if (this.state === 'victory' || this.state === 'defeat') return;
    this.state = victory ? 'victory' : 'defeat';
    this.t = 0;
    const hits = this.ballistics.stats.hits, fired = this.ballistics.stats.fired;
    const own = this.fleet.own;
    const bonus = victory ? Math.round(1000 * own.hp / own.maxHp) : 0;
    this.score += bonus;
    if (victory) this.audio.victory();
    else this.audio.defeat();
    this.events.end?.({
      victory,
      title,
      sub,
      score: this.score,
      bonus,
      kills: this.stats.kills,
      assists: this.stats.assists,
      byType: this.stats.byType,
      fleetKills: this.stats.fleetKills,
      accuracy: fired ? hits / fired : 0,
      fired,
      hits,
      hull: Math.max(0, own.hp / own.maxHp),
      shipsLost: this.stats.shipsLost,
      raids: this.stats.raids,
    });
  }

  continueEndless() {
    this.endless = true;
    this.state = 'lull';
    this.t = 0;
  }

  update(dt) {
    this.t += dt;
    this.clock += dt;
    const RAIDS = this.raids;
    const air = this.air;
    const threats = air.planes.filter((p) => p.alive);
    const near = threats.filter((p) => p.pos.distanceTo(this.fleet.center) < 4500).length;
    this.combat += (Math.min(1, near / 6) - this.combat) * (1 - Math.exp(-dt * 0.5));

    // group break callouts
    if (!this.attract) {
      for (const g of air.groups) {
        if (!g.broken || this.calledBreak.has(g.id)) continue;
        this.calledBreak.add(g.id);
        const p = g.planes.find((q) => q.alive);
        if (!p) continue;
        const where = this.relative(p.pos);
        const lines = this.night
          ? {
              dive: [`Bombers gliding in, ${where}! Look for the exhaust.`, `Plane overhead, ${where}, coming down!`],
              torpedo: [`Torpedo planes low ${onThe(where)}! Watch for exhaust flames.`, `Bogeys splitting up, ${where}. They're getting down on the water.`],
              flare: [`Snooper circling, ${where}.`, `Aircraft overhead, ${where}. Stand by for flares.`],
            }
          : {
              dive: [`Dive bombers overhead, ${where}!`, `Vals pushing over, ${where}!`],
              torpedo: [`Torpedo planes low ${onThe(where)}!`, `Torpedo bombers coming in, ${where}!`],
              strafe: [`Fighters strafing, ${where}!`, `Zeros coming in low, ${where}!`],
              kamikaze: [`Kamikaze! ${where}!`, `Suicide planes diving, ${where}!`],
            };
        this.hud.radio(pick(lines[g.role] || lines.torpedo), 'warn');
      }
    }

    switch (this.state) {
      case 'brief':
        // the General Quarters opening sounds the alarm itself; the clock waits for it
        if (this.gq) {
          this.t = 0;
          this.alarmed = true;
          break;
        }
        if (this.t > 2 && !this.alarmed) {
          this.alarmed = true;
          this.audio.alarm();
          this.hud.radio('General quarters, general quarters. All hands man your battle stations.', 'info');
        }
        if (this.t > 9 && !this.briefed) {
          this.briefed = true;
          if (this.night) {
            this.hud.radio('CIC: snoopers have been shadowing us since sunset. Raid closing.', 'radar');
            this.hud.radio('Darken ship. Automatic weapons hold fire until you have a target; the 5-inch will fire on radar.', 'info');
          } else this.hud.radio('CIC: large raid closing. Gunners, stand by.', 'radar');
        }
        if (this.t > 14) {
          this.alarmed = this.briefed = false;
          this.raid = 0;
          this.spawnRaid(0);
          this.state = 'raid';
          this.t = 0;
        }
        break;
      case 'raid': {
        const left = air.planes.filter((p) => p.alive && p.state !== 'egress').length;
        if (!this.attract) this.hud.setRemaining(left);
        if (left === 0 && this.t > 20 && this.ordnance.bombs.length === 0) {
          this.stats.raids++;
          this.state = 'lull';
          this.t = 0;
          if (this.attract) break;
          const own = this.fleet.own;
          // damage control between raids
          for (const s of this.fleet.ships) {
            if (s.sunk) continue;
            s.hp = Math.min(s.maxHp, s.hp + s.maxHp * 0.1);
            for (const f of s.fires) f.life = Math.min(f.life, f.t + rr(4, 12));
          }
          const bonus = Math.round(300 * own.hp / own.maxHp);
          this.score += bonus;
          this.hud.setScore(this.score);
          if (this.raid >= RAIDS.length - 1 && !this.endless) {
            if (this.night) this.finish(true, 'Night attacks beaten off', 'The task group steams on in the dark');
            else this.finish(true, 'Raid repulsed', 'The task group holds');
          } else {
            this.hud.toast('Raid repulsed', `Survival bonus +${bonus}`, 3600);
            const calm = this.night
              ? ['Bogeys opening. Stay darkened, they will be back.', 'Raid is over. Check your ammunition, keep your eyes on the dark side.', 'Bandits retiring. Repair parties, get those fires out, they show for miles.']
              : ['Secure from air defense. Damage control, report.', 'Raid is over. Check your ammunition, stay sharp.', 'Bandits retiring. Repair parties, get those fires out.'];
            this.hud.radio(pick(calm), 'info');
            this.hud.setRaid('Between raids', 'Damage control parties at work');
            this.hud.setRemaining(0);
          }
        }
        break;
      }
      case 'lull': {
        const wait = this.attract ? 6 : 22;
        if (this.t > wait) {
          this.raid++;
          if (this.attract && this.raid >= RAIDS.length) this.raid = 0;
          this.spawnRaid(this.raid);
          this.state = 'raid';
          this.t = 0;
        }
        break;
      }
    }
  }
}
