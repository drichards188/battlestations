import * as THREE from 'three';
import GUI from 'lil-gui';
import Stats from 'three/examples/jsm/libs/stats.module.js';

import { globalUniforms, patchSceneFog } from './shaderlib.js';
import { Atmosphere } from './atmosphere.js';
import { Ocean } from './ocean.js';
import { Islands } from './islands.js';
import { Clouds } from './clouds.js';
import { Weather, WEATHER } from './weather.js';
import { AudioEngine } from './audio.js';
import { HUD } from './hud.js';
import { PostFX, GRADES } from './post.js';
import { FX } from './fx.js';
import { Ballistics, OWNER } from './ballistics.js';
import { Air } from './air.js';
import { Ordnance } from './ordnance.js';
import { Fleet } from './fleet.js';
import { Gunner } from './gunner.js';
import { ShipMap } from './shipmap.js';
import { Director, DIFFICULTY } from './director.js';
import { Cinematic } from './cinematic.js';
import { buildAircraft, createAircraftMaterial } from './models/aircraft.js';

const QUALITY = {
  Low: { pixelRatio: 0.75, shadowMap: 2048, shadowExtent: 110, ao: false, raySamples: 16, dofSamples: 16, fx: 0.5 },
  Medium: { pixelRatio: 1, shadowMap: 2048, shadowExtent: 130, ao: true, raySamples: 32, dofSamples: 32, fx: 0.75 },
  High: { pixelRatio: 1.5, shadowMap: 4096, shadowExtent: 150, ao: true, raySamples: 48, dofSamples: 48, fx: 1 },
  Ultra: { pixelRatio: 2, shadowMap: 4096, shadowExtent: 170, ao: true, raySamples: 64, dofSamples: 64, fx: 1.25 },
};

const hud = new HUD();
const tick = () => new Promise((r) => setTimeout(r, 0));
const step = async (p, msg) => {
  hud.setLoading(p, msg);
  await tick();
};

async function init() {
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY.High.pixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 30000);
  camera.position.set(0, 20, 60);

  const audio = new AudioEngine();

  await step(0.05, 'Painting the sky');
  const atmosphere = new Atmosphere(renderer, scene);

  await step(0.12, 'Raising the swell');
  const ocean = new Ocean(renderer);
  scene.add(ocean.mesh);
  const islands = new Islands(scene);
  ocean.setShallows(islands.shallows);
  const clouds = new Clouds(scene);

  await step(0.22, 'Fitting out the task group');
  const fx = new FX(scene);
  const ballistics = new Ballistics(scene);
  const ordnance = new Ordnance(scene, { fx, audio, ocean });
  const fleet = new Fleet(scene, { fx, audio, ocean, ballistics });

  await step(0.5, 'Fueling the strike');
  const air = new Air(scene, { fx, audio, ordnance });

  // Hellcats spotted on the carrier deck, engines turning
  const parking = fleet.carrier.model.parking || [];
  const hellcat = buildAircraft('hellcat');
  const parked = new THREE.InstancedMesh(hellcat.geometry.clone(), createAircraftMaterial('hellcat'), Math.max(parking.length, 1));
  const parkedState = new Float32Array(Math.max(parking.length, 1) * 4);
  for (let i = 0; i < parking.length; i++) parkedState[i * 4 + 1] = Math.random() * 6;
  parked.geometry.setAttribute('aState', new THREE.InstancedBufferAttribute(parkedState, 4));
  parked.count = parking.length;
  parked.castShadow = parked.receiveShadow = true;
  parked.frustumCulled = false;
  scene.add(parked);
  const parkLocal = parking.map((p) => {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(hellcat.parked?.pitch || 0, p.yaw, 0, 'YXZ'));
    const z = THREE.MathUtils.clamp(p.pos.z, -fleet.carrier.halfLength, fleet.carrier.halfLength);
    m.setPosition(p.pos.x, fleet.carrier.model.deckAt(z) + (hellcat.parked?.height ?? 2), p.pos.z);
    return m;
  });

  await step(0.62, 'Manning the guns');
  const gunner = new Gunner(camera, fleet, { fx, audio, ballistics, dom: renderer.domElement });
  fleet.addCrew();
  const weather = new Weather(scene, audio);
  const director = new Director({ air, fleet, hud, audio, gunner, ordnance, ballistics });
  const cinematic = new Cinematic(camera, fleet, air);

  patchSceneFog(scene);

  await step(0.72, 'Preparing the lens');
  const post = new PostFX(renderer, scene, camera);

  // ---------------------------------------------------------------- settings
  const params = {
    quality: 'High',
    dynamicRes: true,
    difficulty: 'Gunner',
    leadSight: 'Auto',
    brackets: true,
    sensitivity: 1,
    invertY: false,
    elevation: 34,
    azimuth: 262,
    autoSun: true,
    weather: 'Clear',
    exposure: 1.0,
    autoExposure: true,
    exposureKey: 0.17,
    toneMapping: 'ACES Filmic',
    grade: 'Kodachrome',
    ao: true,
    aoIntensity: 1.0,
    bloom: true,
    bloomStrength: 0.32,
    bloomRadius: 0.5,
    bloomThreshold: 3.0,
    godRays: 0.55,
    lensFlare: 0.7,
    chromatic: 0.008,
    vignette: 0.32,
    grain: 0.035,
    sharpen: 0.35,
    fogDensity: 0.00009,
    fogFalloff: 0.0022,
    turbidity: 3.2,
    rayleigh: 1.9,
    fov: 62,
    dofAperture: 0.5,
    dofMaxBlur: 14,
    dofAuto: true,
    dofFocus: 60,
    volume: 0.8,
    music: 0.45,
    capture: () => (captureRequested = true),
  };
  let captureRequested = false;
  let resScale = 1;
  let mode = 'cinematic'; // cinematic | gun | photo
  let paused = false;
  let inGame = false;
  let prevMode = 'cinematic';

  const basePixelRatio = () => Math.min(devicePixelRatio, QUALITY[params.quality].pixelRatio);
  const applyPixelRatio = () => {
    const full = mode === 'photo' || !params.dynamicRes;
    renderer.setPixelRatio(basePixelRatio() * (full ? 1 : resScale));
    post.setSize(innerWidth, innerHeight);
  };
  const applyQuality = (name) => {
    const q = QUALITY[name];
    resScale = 1;
    applyPixelRatio();
    atmosphere.setShadowQuality(q.shadowMap, q.shadowExtent);
    params.ao = q.ao;
    post.gtao.enabled = q.ao;
    post.lens.material.defines.RAY_SAMPLES = q.raySamples;
    post.lens.material.needsUpdate = true;
    post.dof.material.defines.SAMPLES = q.dofSamples;
    post.dof.material.needsUpdate = true;
    fx.budget = q.fx;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  };
  const toneMaps = {
    'ACES Filmic': THREE.ACESFilmicToneMapping,
    AgX: THREE.AgXToneMapping,
    'Khronos Neutral': THREE.NeutralToneMapping,
    Reinhard: THREE.ReinhardToneMapping,
  };

  const gui = new GUI({ title: 'Settings' });
  gui.add(params, 'quality', Object.keys(QUALITY)).name('Quality preset').onChange(applyQuality);
  gui.add(params, 'dynamicRes').name('Dynamic resolution').onChange(() => {
    resScale = 1;
    applyPixelRatio();
  });
  const fPlay = gui.addFolder('Gameplay');
  fPlay.add(params, 'difficulty', Object.keys(DIFFICULTY)).name('Difficulty (next battle)').listen();
  fPlay.add(params, 'leadSight', ['Auto', 'On', 'Off']).name('Lead computing sight');
  fPlay.add(params, 'brackets').name('Target brackets');
  fPlay.add(params, 'sensitivity', 0.2, 3, 0.05).name('Mouse sensitivity').onChange((v) => (gunner.sensitivity = v));
  fPlay.add(params, 'invertY').name('Invert elevation').onChange((v) => (gunner.invertY = v));
  fPlay.add(params, 'fov', 45, 90, 1).name('Field of view');

  const fWorld = gui.addFolder('Time & weather');
  fWorld.add(params, 'autoSun').name('Sun follows the battle');
  fWorld.add(params, 'elevation', -15, 80, 0.1).name('Sun elevation').listen();
  fWorld.add(params, 'azimuth', 0, 360, 0.1).name('Sun azimuth');
  fWorld.add(params, 'weather', Object.keys(WEATHER)).name('Weather').onChange((v) => weather.set(v)).listen();
  fWorld.close();

  const fCam = gui.addFolder('Camera & photo');
  fCam.add(params, 'grade', Object.keys(GRADES)).name('Color grade').onChange((v) => post.setGrade(v));
  fCam.add(params, 'dofAuto').name('DoF autofocus');
  fCam.add(params, 'dofFocus', 1, 2000, 0.5).name('DoF focus distance');
  fCam.add(params, 'dofAperture', 0, 3, 0.01).name('DoF aperture');
  fCam.add(params, 'dofMaxBlur', 2, 30, 1).name('DoF max blur');
  fCam.add(params, 'capture').name('Capture screenshot (K)');
  fCam.close();

  const fPost = gui.addFolder('Post processing');
  fPost.add(params, 'autoExposure').name('Auto exposure');
  fPost.add(params, 'exposureKey', 0.05, 0.6, 0.01).name('Exposure key');
  fPost.add(params, 'exposure', 0.1, 3, 0.01).name('Exposure bias');
  fPost.add(params, 'toneMapping', Object.keys(toneMaps)).name('Tone mapping');
  fPost.add(params, 'ao').name('GTAO').onChange((v) => (post.gtao.enabled = v)).listen();
  fPost.add(params, 'aoIntensity', 0, 2, 0.01).name('AO intensity');
  fPost.add(params, 'bloom').name('Bloom');
  fPost.add(params, 'bloomStrength', 0, 2, 0.01).name('Bloom strength');
  fPost.add(params, 'bloomRadius', 0, 1, 0.01).name('Bloom radius');
  fPost.add(params, 'bloomThreshold', 0, 10, 0.01).name('Bloom threshold');
  fPost.add(params, 'godRays', 0, 3, 0.01).name('God rays');
  fPost.add(params, 'lensFlare', 0, 3, 0.01).name('Lens flare');
  fPost.add(params, 'chromatic', 0, 0.05, 0.001).name('Chromatic aberration');
  fPost.add(params, 'vignette', 0, 1, 0.01).name('Vignette');
  fPost.add(params, 'grain', 0, 0.15, 0.001).name('Film grain');
  fPost.add(params, 'sharpen', 0, 1.5, 0.01).name('Sharpen');
  fPost.close();

  const fAtmo = gui.addFolder('Atmosphere');
  fAtmo.add(params, 'fogDensity', 0, 0.001, 0.00001).name('Haze density');
  fAtmo.add(params, 'fogFalloff', 0.0005, 0.02, 0.0001).name('Haze height falloff');
  fAtmo.add(params, 'turbidity', 0, 20, 0.1).name('Turbidity').onChange(() => (atmosphere.lastEnvKey = ''));
  fAtmo.add(params, 'rayleigh', 0, 4, 0.01).name('Rayleigh').onChange(() => (atmosphere.lastEnvKey = ''));
  fAtmo.close();

  const fAudio = gui.addFolder('Audio');
  fAudio.add(params, 'volume', 0, 1, 0.01).name('Master volume').onChange((v) => audio.setVolume(v));
  fAudio.add(params, 'music', 0, 1, 0.01).name('Music').onChange((v) => audio.setMusicVolume(v));
  fAudio.close();
  audio.setMusicVolume(params.music);
  post.setGrade(params.grade);

  const stats = new Stats();
  stats.dom.classList.add('stats');
  document.body.appendChild(stats.dom);

  // ---------------------------------------------------------------- events between systems
  const nearCam = (p, r) => p.distanceTo(camera.position) < r;
  const blastNear = (p, radius, k = 1) => {
    if (mode !== 'gun') return;
    const d = p.distanceTo(camera.position);
    if (d < radius) {
      const f = 1 - d / radius;
      gunner.shake(f * k);
      gunner.deafen = Math.max(gunner.deafen, f * k * 0.9);
      if (f > 0.3) hud.damageFlash(f * k);
    }
  };
  let splashBudget = 0;

  const ballCtx = {
    planes: air.planes,
    hitPlane: (p, point, kind, owner, dmg) => {
      air.hit(p, point, kind, owner, dmg);
      if (owner === OWNER.PLAYER) {
        hud.hitMarker();
        audio.hitMarker();
      }
    },
    proximity: (point, owner, scale) => air.proximity(point, owner, scale),
    water: (point, kind) => {
      if (splashBudget <= 0 || !nearCam(point, 3500)) return;
      splashBudget--;
      const size = kind === '5in' ? 0.25 : kind === '40mm' ? 0.12 : 0.06;
      fx.splash(point, size);
      ocean.stamp(point.x, point.z, point.x, point.z, 2 + size * 10, 0.7, 0.6, 0.3);
    },
    expire: (point, kind, owner, scale) => {
      if (kind === '5in') air.proximity(point, owner, scale);
      else if (nearCam(point, 5000)) fx.airburst(point);
    },
    shipAt: (p) => fleet.shipAt(p, 0.3),
    hitShip: (ship, p) => {
      fleet.damage(ship, 'strafe', p);
      if (nearCam(p, 1500)) fx.sparks(p, 4, 14);
      if (nearCam(p, 300)) audio.hit(p, 'steel');
      blastNear(p, 25, 0.35);
    },
  };

  air.events.kill = (p, info) => director.onKill(p, info);
  air.events.escape = (p) => director.onEscape(p);
  air.events.crash = (p, ship, alive) => {
    if (ship) {
      const kami = p.role === 'kamikaze' && (alive || p.phase === 'terminal');
      fx.explosion(p.pos, kami ? 1.2 : 0.7);
      audio.explosion(p.pos, kami ? 1 : 0.5);
      fleet.damage(ship, kami ? 'kamikaze' : 'wreck', p.pos);
      blastNear(p.pos, kami ? 90 : 50, 1);
    } else {
      fx.splash(p.pos.clone().setY(0), p.type === 'betty' ? 0.9 : 0.55);
      fx.explosion(p.pos.clone().setY(1), 0.3, { debris: false, fireball: p.ordnance });
      audio.splash(p.pos, 0.6);
      ocean.stamp(p.pos.x, p.pos.z, p.pos.x, p.pos.z, 14, 1, 1, 0.3);
    }
  };
  ordnance.events.bombHit = (ship, pos) => {
    fx.explosion(pos, 1);
    audio.explosion(pos, 0.7);
    fleet.damage(ship, 'bomb', pos);
    blastNear(pos, 90, 1);
  };
  ordnance.events.nearMiss = (pos, ship, dist) => {
    fx.splash(pos, 1);
    audio.splash(pos, 0.9);
    ocean.stamp(pos.x, pos.z, pos.x, pos.z, 18, 1, 1, 0.3);
    if (ship && dist < 22) fleet.damage(ship, 'nearMiss', pos);
    blastNear(pos, 70, 0.6);
  };
  ordnance.events.torpedoHit = (ship, pos) => {
    fx.splash(pos, 1.7);
    fx.explosion(pos.clone().setY(2), 0.8, { fireball: false });
    audio.torpedoHit(pos);
    ocean.stamp(pos.x, pos.z, pos.x, pos.z, 30, 1, 1, 0.3);
    fleet.damage(ship, 'torpedo', pos);
    if (ship === fleet.own) blastNear(camera.position, 10, 0.8);
  };
  ordnance.events.torpedoLaunched = (t) => director.onTorpedo(t);
  fleet.events.damaged = (ship, kind) => director.onShipDamaged(ship, kind);
  fleet.events.sunk = (ship) => director.onShipSunk(ship);
  fx.onWaterHit = (p, size) => {
    if (nearCam(p, 2500)) fx.splash(p.clone().setY(0), size);
  };
  gunner.events.switch = (st) => hud.setStation(st, gunner.index, gunner.stations.length);

  // the ship's plan: hold Ctrl to bring it up with the mouse free, click a mount to man it. The
  // battle runs on while it's up.
  let mapOpen = false;
  const resumeGun = () => renderer.domElement.requestPointerLock()?.catch?.(() => {});
  const shipMap = new ShipMap(renderer, fleet.own, gunner, {
    onPick: (i) => {
      gunner.select(i);
      closeMap();
    },
  });
  const openMap = () => {
    if (mapOpen || mode !== 'gun' || !gunner.active || !inGame || document.body.classList.contains('ended')) return;
    mapOpen = true;
    gunner.firing = false;
    gunner.zoom = false;
    shipMap.show();
    document.exitPointerLock();
  };
  const closeMap = () => {
    if (!mapOpen) return;
    mapOpen = false;
    shipMap.hide();
    resumeGun();
  };
  addEventListener('keyup', (e) => {
    if (e.key === 'Control') closeMap();
  });
  addEventListener('blur', () => {
    if (mapOpen) {
      mapOpen = false;
      shipMap.hide();
    }
  });
  document.addEventListener('pointerlockerror', () => {
    if (inGame && mode === 'gun') hud.hint('Click to take the gun', 2500);
  });
  hud.setStation(gunner.station, 0, gunner.stations.length);

  director.events.end = (report) => {
    setTimeout(() => {
      gunner.setActive(false);
      document.exitPointerLock?.();
      hud.showEnd(report, {
        onRestart: () => {
          hud.hideEnd();
          beginBattle();
        },
        onContinue: () => {
          hud.hideEnd();
          director.continueEndless();
          gunner.setActive(true);
          renderer.domElement.requestPointerLock();
        },
      });
    }, report.victory ? 2500 : 7000);
  };

  // ---------------------------------------------------------------- flow
  const playBtn = document.getElementById('play');
  const diffBtns = [...document.querySelectorAll('#difficulty button')];
  diffBtns.forEach((b) =>
    b.addEventListener('click', () => {
      params.difficulty = b.dataset.d;
      diffBtns.forEach((o) => o.classList.toggle('on', o === b));
    })
  );

  const setMode = (m) => {
    mode = m;
    hud.setMode(m);
    gunner.setActive(m === 'gun' && !paused && inGame && director.state !== 'victory' && director.state !== 'defeat');
    if (m !== 'gun') hud.hideSight();
    applyPixelRatio();
  };

  const beginBattle = () => {
    audio.start();
    hud.blackout(true);
    setTimeout(() => {
      director.start(params.difficulty);
      gunner.newBattle();
      inGame = true;
      document.body.classList.add('in-game');
      paused = false;
      gunner.select(gunner.home);
      setMode('gun');
      hud.showTitle(false);
      hud.blackout(false);
      playBtn.textContent = 'Resume';
      hud.hint('Mouse to train and elevate, hold the left button to fire. Hold Ctrl for the ship plan to change mounts.', 7000);
    }, 900);
  };

  document.getElementById('restart').addEventListener('click', () => {
    renderer.domElement.requestPointerLock();
    beginBattle();
  });

  playBtn.addEventListener('click', () => {
    renderer.domElement.requestPointerLock();
    if (!inGame) beginBattle();
    else {
      audio.start();
      paused = false;
      hud.showTitle(false);
      setMode('gun');
    }
  });

  renderer.domElement.addEventListener('click', () => {
    if (inGame && mode === 'gun' && !document.pointerLockElement && !document.body.classList.contains('ended')) {
      renderer.domElement.requestPointerLock();
      paused = false;
      hud.showTitle(false);
      setMode('gun');
    } else if (mode === 'photo' && !document.pointerLockElement) renderer.domElement.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = !!document.pointerLockElement;
    document.body.classList.toggle('locked', locked);
    if (!locked && mapOpen) return; // the mouse is out for the ship's plan, not to pause
    if (!locked && inGame && mode === 'gun' && !document.body.classList.contains('ended')) {
      // pause the battle while the mouse is released
      paused = true;
      gunner.setActive(false);
      hud.showTitle(true);
    }
  });

  const togglePhoto = () => {
    if (mode === 'photo') {
      cinematic.exitPhoto();
      setMode(prevMode);
      if (prevMode === 'gun' && inGame) renderer.domElement.requestPointerLock();
    } else {
      prevMode = mode;
      cinematic.enterPhoto();
      setMode('photo');
    }
  };

  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const playing = mode === 'gun' && gunner.active;
    switch (e.code) {
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Digit4':
      case 'Digit5':
      case 'Digit6':
      case 'Digit7':
      case 'Digit8':
      case 'Digit9':
        if (playing && !e.ctrlKey) gunner.select(Number(e.code.slice(5)) - 1);
        break;
      case 'ControlLeft':
      case 'ControlRight':
        openMap();
        break;
      case 'KeyQ':
        if (playing) gunner.select((gunner.index + gunner.stations.length - 1) % gunner.stations.length);
        break;
      case 'KeyE':
        if (playing) gunner.select((gunner.index + 1) % gunner.stations.length);
        break;
      case 'KeyR':
        if (playing) gunner.reload();
        break;
      case 'KeyX':
        if (playing && gunner.toggleView()) hud.hint(gunner.view === 'pointer' ? (gunner.ringSight ? "Pointer's ring sight" : "Pointer's sight hood") : 'Centre view', 1500);
        break;
      case 'KeyC':
        if (mode === 'gun' && inGame) {
          setMode('cinematic');
          hud.hint('Watching the battle. Press C to return to your gun.', 4000);
        } else if (mode === 'cinematic' && inGame) {
          setMode('gun');
          renderer.domElement.requestPointerLock();
        }
        break;
      case 'KeyP':
        togglePhoto();
        break;
      case 'KeyK':
        if (mode === 'photo') captureRequested = true;
        break;
      case 'KeyH':
        document.body.classList.toggle('ui-hidden');
        break;
      case 'KeyM':
        hud.hint(audio.toggleMute() ? 'Sound muted' : 'Sound on', 1500);
        break;
      case 'KeyV': {
        const names = Object.keys(WEATHER);
        params.weather = names[(names.indexOf(params.weather) + 1) % names.length];
        weather.set(params.weather);
        hud.hint(`Weather: ${params.weather}`, 1800);
        break;
      }
      case 'F3':
        e.preventDefault();
        document.body.classList.toggle('debug');
        break;
    }
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.setSize(innerWidth, innerHeight);
  });

  const saveCapture = () => {
    renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `maxgfx-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
    const flash = document.getElementById('flash');
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 50);
    hud.hint('Screenshot saved', 1500);
  };

  // ---------------------------------------------------------------- warm up
  await step(0.85, 'Compiling shaders');
  weather.set(params.weather);
  atmosphere.set(params.elevation, params.azimuth);
  director.startAttract();
  cinematic.update(0.016);
  fleet.update(0.016, 0, { air, ordnance, camera });
  await renderer.compileAsync(scene, camera);
  atmosphere.update(new THREE.Vector3(), 0);
  renderer.shadowMap.needsUpdate = true;
  post.render(0.016);
  hud.setLoading(1, '');
  hud.ready();
  playBtn.disabled = false;
  hud.blackout(false);
  hud.setMode('cinematic');

  // ---------------------------------------------------------------- loop
  const timer = new THREE.Timer();
  const sunColorN = new THREE.Color();
  const ambient = new THREE.Color();
  const fwd = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const pm = new THREE.Matrix4();
  let t = 0;
  let sunTimer = 0;
  let hudTimer = 0;
  let shipTimer = 0;
  let resTimer = 0;
  let frameAvg = 16;
  const audioPlanes = [];

  // one frame of the game; forcedDt lets tests step the simulation without real time
  const frame = (forcedDt, draw = true) => {
    timer.update();
    const rawDt = forcedDt ?? THREE.MathUtils.clamp(timer.getDelta(), 0, 0.1);
    frameAvg += (rawDt * 1000 - frameAvg) * 0.05;
    const photo = mode === 'photo';
    const dt = photo || paused ? 0 : Math.min(rawDt, 0.05);
    t += dt;
    globalUniforms.uTime.value = t;
    splashBudget = 6;

    // sun slides toward the director's time of day
    if (params.autoSun && dt > 0) params.elevation += (director.sunTarget - params.elevation) * (1 - Math.exp(-dt * 0.02));
    atmosphere.setStorm(weather.state.storm);
    sunTimer -= rawDt;
    const u = atmosphere.uniforms;
    u.cloudCoverage.value = weather.state.cover * 0.45;
    u.cloudDensity.value = 0.45 + weather.state.storm * 0.4;
    u.turbidity.value = params.turbidity;
    u.rayleigh.value = params.rayleigh;
    const stormKey = weather.state.storm.toFixed(2);
    if (
      sunTimer <= 0 &&
      (Math.abs(params.elevation - atmosphere.elevation) > 0.4 || params.azimuth !== atmosphere.azimuth || atmosphere.lastEnvKey === '' || !atmosphere.lastEnvKey.endsWith(stormKey))
    ) {
      atmosphere.set(params.elevation, params.azimuth);
      sunTimer = 0.25;
    }
    scene.environmentIntensity = atmosphere.baseEnvIntensity * (1 - weather.state.storm * 0.45) + weather.flash * 2.5;

    // the world: ships, aircraft, ordnance, the battle
    fleet.update(dt, t, { air, ordnance, camera });
    if (dt > 0) {
      air.update(dt, t, { fleet, ballistics, camera });
      ordnance.update(dt, fleet, camera);
      const was = director.state;
      director.update(dt);
      // between raids the passers and the hoist restock the ready racks and lockers
      if (was === 'raid' && director.state !== 'raid') gunner.restock();
    }
    gunner.update(dt, rawDt, { air });
    if (mode === 'cinematic') cinematic.update(rawDt);
    else if (mode === 'photo') cinematic.updatePhoto(rawDt);

    // camera field of view (the sight zooms)
    const zoom = mode === 'gun' && gunner.zoom;
    document.body.classList.toggle('zoom', zoom);
    document.body.classList.toggle('ringsight', mode === 'gun' && gunner.ringSight);
    const targetFov = zoom ? 24 : params.fov;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-rawDt * 10));
      camera.updateProjectionMatrix();
    }

    if (dt > 0) ballistics.update(dt, camera, ballCtx);
    else ballistics.render();
    ballistics.mat.uniforms.uPixel.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (innerHeight * renderer.getPixelRatio()) * 1.6;

    // shadows follow what the camera looks at
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    focus.copy(camera.position).addScaledVector(fwd, atmosphere.shadowExtent * 0.4);
    focus.y = 0;
    atmosphere.update(focus, t);
    const light = atmosphere.sun;
    sunColorN.copy(light.color).multiplyScalar(light.intensity / 6.5);
    globalUniforms.uSunDirW.value.copy(atmosphere.lightDir);
    globalUniforms.uSunColorN.value.copy(sunColorN);
    ambient.copy(scene.fog.color).multiplyScalar(0.9 + 0.3 * (1 - weather.state.storm));

    const pixelAngle = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (innerHeight * renderer.getPixelRatio());
    ocean.update(dt, camera, { amp: 1 + weather.state.storm * 1.2, whitecap: 0.22 + weather.state.wind * 0.12, pixelAngle, foam: draw });
    islands.update(camera);
    const lightEnv = { sunDir: atmosphere.lightDir, sunColor: sunColorN, sunIntensity: 6.5, ambient };
    clouds.update(dt, camera, { ...lightEnv, cover: THREE.MathUtils.clamp(0.55 + weather.state.cover * 0.6, 0, 1) });
    fx.wind.set(-5 * weather.state.wind, 0, 2 * weather.state.wind);
    fx.update(dt, camera, lightEnv);
    weather.update(dt, t, camera, atmosphere);

    // parked Hellcats ride the carrier
    for (let i = 0; i < parkLocal.length; i++) {
      pm.multiplyMatrices(fleet.carrier.matrix, parkLocal[i]);
      parked.setMatrixAt(i, pm);
    }
    parked.instanceMatrix.needsUpdate = true;
    parked.visible = !fleet.carrier.gone;

    scene.fog.density = params.fogDensity * weather.state.fog;
    globalUniforms.fogSunColor.value.copy(atmosphere.fogSunBase || globalUniforms.fogSunColor.value).multiplyScalar(1 - 0.9 * weather.state.storm);
    globalUniforms.fogHeightFalloff.value = params.fogFalloff;

    // post
    renderer.toneMapping = toneMaps[params.toneMapping];
    renderer.toneMappingExposure = params.exposure;
    const ex = post.exposure.params;
    ex.auto = params.autoExposure;
    ex.key = params.exposureKey;
    post.gtao.blendIntensity = params.aoIntensity;
    post.bloom.enabled = params.bloom;
    post.bloom.strength = params.bloomStrength;
    post.bloom.radius = params.bloomRadius;
    post.bloom.threshold = params.bloomThreshold;
    const lu = post.lens.uniforms;
    lu.uFlare.value = params.lensFlare * (1 - weather.state.storm);
    lu.uCA.value = params.chromatic + gunner.trauma * 0.01;
    const gu = post.grade.uniforms;
    gu.uVignette.value = params.vignette + (zoom ? 0.35 : 0);
    gu.uGrain.value = params.grain;
    gu.uSharpen.value = params.sharpen;
    gu.uFade.value = mode === 'cinematic' ? cinematic.fade : 0;

    const dofOn = mode === 'cinematic' || photo;
    post.dof.enabled = dofOn;
    if (dofOn) {
      const du = post.dof.uniforms;
      du.uAuto.value = photo && params.dofAuto ? 1 : 0;
      du.uFocus.value = photo ? params.dofFocus : cinematic.focus;
      du.uAperture.value = photo ? params.dofAperture : 0.4;
      du.uMaxBlur.value = params.dofMaxBlur * renderer.getPixelRatio();
    }
    post.update(t, rawDt, atmosphere.sunDir, sunColorN, params.elevation);
    lu.uRays.value *= params.godRays * (1 - weather.state.storm);

    renderer.info.reset();
    renderer.shadowMap.needsUpdate = true;
    if (draw) post.render(rawDt);
    if (captureRequested) {
      captureRequested = false;
      saveCapture();
    }
    stats.update();

    // audio
    audioPlanes.length = 0;
    for (const p of air.planes) {
      if (p.gone) continue;
      const a = p.audio || (p.audio = { id: p.id, type: p.type, pos: p.pos, vel: p.vel });
      a.throttle = p.alive ? 0.8 : 0.4;
      a.dive = Math.max(0, -p.fwd.y);
      a.burning = !p.alive;
      audioPlanes.push(a);
    }
    audio.setAircraft(audioPlanes);
    audio.update(rawDt, camera, {
      wind: weather.state.wind,
      rain: weather.state.rain,
      combat: director.combat,
      raid: director.state === 'raid',
      shipSpeed: fleet.own.speed,
      deafen: mode === 'gun' ? gunner.deafen : 0,
      drive: mode === 'gun' && gunner.active ? gunner.driveLoad : -1,
      zoom,
    });

    // dynamic resolution: keep frame time near 60fps
    resTimer -= rawDt;
    if (params.dynamicRes && !photo && resTimer <= 0) {
      resTimer = 1.5;
      let next = resScale;
      if (frameAvg > 20) next = Math.max(0.5, resScale - 0.1);
      else if (frameAvg < 13.5) next = Math.min(1, resScale + 0.05);
      if (next !== resScale) {
        resScale = next;
        applyPixelRatio();
      }
    }

    // HUD
    if (mode === 'gun' && gunner.active) {
      const assist = params.leadSight === 'On' || (params.leadSight === 'Auto' && DIFFICULTY[params.difficulty].assist);
      hud.updateSight(camera, air.planes, gunner, assist, params.brackets);
      hud.setGun(gunner.station, gunner.blocked && gunner.firing);
      if (mapOpen) shipMap.update();
      const markers = [];
      for (const g of air.groups) {
        const p = g.planes.find((q) => q.alive);
        if (p) markers.push({ pos: p.pos, kind: 'enemy', label: `${g.planes.filter((q) => q.alive).length} ${p.def.label}` });
      }
      if (!fleet.carrier.sunk) markers.push({ pos: fleet.carrier.position, kind: 'friend', label: 'CV' });
      hud.updateCompass(camera, markers);
    }
    shipTimer -= rawDt;
    if (shipTimer <= 0 && inGame) {
      shipTimer = 0.3;
      hud.setShips(
        fleet.ships.map((s) => ({
          name: s.name,
          hp: s.hp,
          maxHp: s.maxHp,
          sunk: s.sunk,
          fires: s.fires.length,
          tag: s === fleet.own ? 'own' : s === fleet.carrier ? 'carrier' : s.cls,
        }))
      );
    }
    hudTimer -= rawDt;
    if (hudTimer <= 0 && document.body.classList.contains('debug')) {
      hudTimer = 0.25;
      const i = renderer.info;
      const c = fx.counts;
      hud.debug(
        `fps        ${(1000 / frameAvg).toFixed(0)} (${frameAvg.toFixed(1)} ms)\n` +
          `mode       ${mode}${paused ? ' (paused)' : ''}  ${director.state} raid ${director.raid + 1}\n` +
          `draw calls ${i.render.calls}\n` +
          `triangles  ${(i.render.triangles / 1e6).toFixed(2)}M\n` +
          `resolution ${Math.round(innerWidth * renderer.getPixelRatio())}x${Math.round(innerHeight * renderer.getPixelRatio())} (${Math.round(resScale * 100)}%)\n` +
          `aircraft   ${air.aliveCount} flying, ${air.planes.length} total\n` +
          `shells     ${ballistics.n}  bombs ${ordnance.bombs.length}  torpedoes ${ordnance.torpedoes.length}\n` +
          `particles  ${c.smoke} smoke, ${c.glow} glow, ${c.debris} debris\n` +
          `own ship   ${fleet.own.hp.toFixed(0)}/${fleet.own.maxHp} hp, ${fleet.own.fires.length} fires\n` +
          `sun        ${params.elevation.toFixed(1)} deg  weather ${params.weather}`
      );
    }
  };
  renderer.setAnimationLoop(() => frame());

  window.__maxgfx = { renderer, scene, camera, params, atmosphere, ocean, islands, clouds, fx, ballistics, ordnance, fleet, air, gunner, director, cinematic, weather, audio, hud, post, get mode() { return mode; }, setMode, frame };
}

init().catch((err) => {
  console.error(err);
  hud.setLoading(0, `Failed to start: ${err.message}`);
});
