import * as THREE from 'three';
import GUI from 'lil-gui';
import Stats from 'three/examples/jsm/libs/stats.module.js';

import { globalUniforms, patchSceneFog } from './shaderlib.js';
import { Terrain, PLATEAU_HEIGHT, WATER_LEVEL } from './terrain.js';
import { TerrainShadow } from './terrainShadow.js';
import { Atmosphere } from './atmosphere.js';
import { createWater } from './water.js';
import { Grass } from './grass.js';
import { createVegetation } from './vegetation.js';
import { createMonument } from './monument.js';
import { Particles } from './particles.js';
import { Fauna } from './fauna.js';
import { Weather, WEATHER } from './weather.js';
import { SkyFX } from './skyfx.js';
import { Quest } from './quest.js';
import { AudioEngine } from './audio.js';
import { HUD } from './hud.js';
import { PostFX, GRADES } from './post.js';
import { Player } from './player.js';
import { Underwater } from './underwater.js';
import { Physics, loadRapier } from './physics.js';
import { Creatures, SANCTUARY } from './creatures.js';
import { LightOrbs } from './orbs.js';
import { ecs, queries, motorSystem, syncSystem, collectLights } from './ecs.js';

const QUALITY = {
  Low: { pixelRatio: 0.75, shadowMap: 1024, shadowExtent: 90, grass: 80000, ao: false, raySamples: 16, dofSamples: 16, kelp: 0.3, fish: 70 },
  Medium: { pixelRatio: 1, shadowMap: 2048, shadowExtent: 110, grass: 180000, ao: true, raySamples: 32, dofSamples: 32, kelp: 0.55, fish: 130 },
  High: { pixelRatio: 1.5, shadowMap: 4096, shadowExtent: 140, grass: 340000, ao: true, raySamples: 48, dofSamples: 48, kelp: 0.8, fish: 200 },
  Ultra: { pixelRatio: 2, shadowMap: 4096, shadowExtent: 160, grass: 650000, ao: true, raySamples: 64, dofSamples: 64, kelp: 1, fish: 270 },
};

const hud = new HUD();
const tick = () => new Promise((r) => setTimeout(r, 0));
const step = async (p, msg) => {
  hud.setLoading(p, msg);
  await tick();
};

async function init() {
  loadRapier().catch(() => {}); // start the download now; Physics.create reports failures
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY.High.pixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  if ('transmissionResolutionScale' in renderer) renderer.transmissionResolutionScale = 0.6;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.25, 6000);
  camera.position.set(40, 20, 30);

  const audio = new AudioEngine();

  await step(0.05, 'Sculpting terrain');
  const terrain = new Terrain();
  scene.add(terrain.mesh);

  await step(0.2, 'Building the sky');
  const atmosphere = new Atmosphere(renderer, scene);
  const terrainShadow = new TerrainShadow(renderer, terrain);

  await step(0.3, 'Filling the lake');
  const water = createWater(terrain, { reflectionSize: 1024 });
  scene.add(water);

  await step(0.4, 'Growing the forest');
  const veg = createVegetation(terrain);
  scene.add(veg.group);

  await step(0.6, 'Raising the monument');
  const monument = createMonument();
  scene.add(monument.group);

  await step(0.68, 'Planting grass');
  const grass = new Grass(terrain, { count: QUALITY.High.grass });
  scene.add(grass.mesh);

  await step(0.72, 'Stirring the lake');
  const lakeLife = new Underwater(terrain, { kelp: QUALITY.High.kelp, fish: QUALITY.High.fish });
  scene.add(lakeLife.group);

  await step(0.75, 'Waking the valley');
  const particles = new Particles(terrain);
  scene.add(particles.group);
  const fauna = new Fauna(scene, terrain);
  const weather = new Weather(scene, audio);
  const skyfx = new SkyFX(scene, monument.crystalPos);

  // ---------------------------------------------------------------- quest
  const game = { activated: false, finaleT: -1, light: 1, hurt: 0, sinceHit: 99, dead: false };
  const hinted = {};
  const quest = new Quest(scene, terrain, monument.crystalPos, {
    onCollect: (n, total) => {
      audio.pickup(n);
      hud.toast('Wisp gathered', `${n} of ${total}`);
      updateObjective();
    },
    onDeliver: () => audio.deliver(),
    onComplete: () => startFinale(),
  });

  const updateObjective = () => {
    if (game.activated) {
      hud.setObjective('The valley awakens', 'All wisps returned.<small>Explore freely. Try the night sky, a storm, or photo mode (P).</small>');
    } else if (quest.collected === quest.total) {
      hud.setObjective('Return', 'The wisps are gathering at the <b>monument</b>.');
    } else {
      hud.setObjective(
        'The Valley of Wisps',
        `Gather the wisps <b>${quest.collected} / ${quest.total}</b><small>Follow the pillars of light and the markers on your compass.</small>`
      );
    }
  };
  updateObjective();

  // ---------------------------------------------------------------- creatures
  await step(0.78, 'Summoning the creatures');
  const physics = await Physics.create(terrain, {
    colliders: [...veg.colliders, ...monument.colliders, ...lakeLife.colliders],
    discs: [{ r: 16, top: PLATEAU_HEIGHT + 0.2 }, { r: 14, top: monument.floorTop }],
  });
  const banishColor = new THREE.Color(0.75, 0.6, 1);
  const creatures = new Creatures(scene, terrain, physics, {
    onHit: (e) => shadeHit(e),
    onBanish: (p) => {
      audio.banish();
      quest.burstAt(p, banishColor);
    },
  });
  const orbs = new LightOrbs(scene, physics);

  patchSceneFog(scene);

  // Grass doesn't need to appear in the lake reflection; it is the most expensive draw.
  // Everything under the surface is clipped by the mirror anyway, so skip it too.
  const waterBefore = water.onBeforeRender;
  water.onBeforeRender = function (...args) {
    const g = grass.mesh.visible, r = weather.rain.visible;
    grass.mesh.visible = false;
    weather.rain.visible = false;
    lakeLife.setReflection(true);
    waterBefore.apply(this, args);
    grass.mesh.visible = g;
    weather.rain.visible = r;
    lakeLife.setReflection(false);
  };

  await step(0.82, 'Preparing the lens');
  const post = new PostFX(renderer, scene, camera);

  const player = new Player(camera, renderer.domElement, terrain, {
    colliders: [...veg.colliders, ...monument.colliders, ...lakeLife.colliders],
    groundOverride: (x, z) => {
      const r = Math.hypot(x, z);
      if (r < 14) return monument.floorTop;
      if (r < 16) return PLATEAU_HEIGHT + 0.2;
      return -Infinity;
    },
  });
  player.dynamicColliders = creatures.colliders;
  player.on('step', (surface, k) => audio.footstep(surface, k));
  player.on('land', (k) => audio.land(k));
  player.on('splash', () => audio.splash());
  player.on('jump', () => audio.footstep(player.surfaceAt(player.feet.x, player.feet.z), 0.6));

  // ---------------------------------------------------------------- settings
  const params = {
    quality: 'High',
    dynamicRes: true,
    elevation: 7,
    azimuth: 105,
    dayCycle: false,
    cycleSpeed: 1.5,
    weather: 'Clear',
    exposure: 1.0,
    autoExposure: true,
    exposureKey: 0.16,
    toneMapping: 'ACES Filmic',
    grade: 'Natural',
    ao: true,
    aoIntensity: 1.0,
    bloom: true,
    bloomStrength: 0.35,
    bloomRadius: 0.5,
    bloomThreshold: 3.2,
    godRays: 1,
    lensFlare: 1,
    chromatic: 0.01,
    vignette: 0.35,
    grain: 0.03,
    sharpen: 0.35,
    fogDensity: 0.0008,
    fogFalloff: 0.012,
    turbidity: 4.5,
    rayleigh: 1.6,
    grassCount: QUALITY.High.grass,
    lakeLife: true,
    fov: 62,
    dofAperture: 0.5,
    dofMaxBlur: 14,
    dofAuto: true,
    dofFocus: 20,
    volume: 0.8,
    music: 0.5,
    capture: () => (captureRequested = true),
  };
  let captureRequested = false;
  let resScale = 1;

  const basePixelRatio = () => Math.min(devicePixelRatio, QUALITY[params.quality].pixelRatio);
  const applyPixelRatio = () => {
    const full = player.mode === 'photo' || !params.dynamicRes;
    renderer.setPixelRatio(basePixelRatio() * (full ? 1 : resScale));
    post.setSize(innerWidth, innerHeight);
  };

  const applyQuality = (name) => {
    const q = QUALITY[name];
    resScale = 1;
    applyPixelRatio();
    atmosphere.setShadowQuality(q.shadowMap, q.shadowExtent);
    params.grassCount = q.grass;
    grass.setCount(q.grass);
    lakeLife.setQuality(q.kelp, q.fish);
    params.ao = q.ao;
    post.gtao.enabled = q.ao;
    post.lens.material.defines.RAY_SAMPLES = q.raySamples;
    post.lens.material.needsUpdate = true;
    post.dof.material.defines.SAMPLES = q.dofSamples;
    post.dof.material.needsUpdate = true;
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

  const fWorld = gui.addFolder('Time & weather');
  fWorld.add(params, 'elevation', -20, 80, 0.1).name('Sun elevation').listen();
  fWorld.add(params, 'azimuth', 0, 360, 0.1).name('Sun azimuth');
  fWorld.add(params, 'dayCycle').name('Animate day cycle').listen();
  fWorld.add(params, 'cycleSpeed', 0.1, 10, 0.1).name('Cycle speed');
  fWorld.add(params, 'weather', Object.keys(WEATHER)).name('Weather').onChange((v) => weather.set(v)).listen();

  const fCam = gui.addFolder('Camera & photo');
  fCam.add(params, 'fov', 40, 100, 1).name('Field of view');
  fCam.add(params, 'grade', Object.keys(GRADES)).name('Color grade').onChange((v) => post.setGrade(v));
  fCam.add(params, 'dofAuto').name('DoF autofocus');
  fCam.add(params, 'dofFocus', 1, 300, 0.5).name('DoF focus distance');
  fCam.add(params, 'dofAperture', 0, 3, 0.01).name('DoF aperture');
  fCam.add(params, 'dofMaxBlur', 2, 30, 1).name('DoF max blur');
  fCam.add(params, 'capture').name('Capture screenshot (K)');

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
  fAtmo.add(params, 'fogDensity', 0, 0.005, 0.0001).name('Fog density');
  fAtmo.add(params, 'fogFalloff', 0.001, 0.08, 0.001).name('Fog height falloff');
  fAtmo.add(params, 'turbidity', 0, 20, 0.1).name('Turbidity').onChange(() => (atmosphere.lastEnvKey = ''));
  fAtmo.add(params, 'rayleigh', 0, 4, 0.01).name('Rayleigh').onChange(() => (atmosphere.lastEnvKey = ''));
  fAtmo.add(params, 'grassCount', 0, 1000000, 10000).name('Grass blades').onFinishChange((v) => grass.setCount(v));
  fAtmo.add(params, 'lakeLife').name('Lake life').onChange((v) => lakeLife.setEnabled(v));
  fAtmo.close();

  const fAudio = gui.addFolder('Audio');
  fAudio.add(params, 'volume', 0, 1, 0.01).name('Master volume').onChange((v) => audio.setVolume(v));
  fAudio.add(params, 'music', 0, 1, 0.01).name('Music').onChange((v) => audio.setMusicVolume(v));
  fAudio.close();

  const stats = new Stats();
  stats.dom.classList.add('stats');
  document.body.appendChild(stats.dom);

  // ---------------------------------------------------------------- flow
  const playBtn = document.getElementById('play');
  let saved = null; // walk state while watching the cinematic camera

  const enterGame = () => {
    audio.start();
    player.controls.lock();
    if (player.mode === 'cinematic') {
      hud.blackout(true);
      setTimeout(() => {
        if (saved) {
          player.mode = 'walk';
          player.feet.copy(saved.feet);
          camera.quaternion.copy(saved.quat);
          player.velocity.set(0, 0, 0);
        } else {
          player.startExploring();
          setTimeout(() => {
            hud.toast('Valley of Wisps', 'Seven lights are scattered across the valley', 4200);
            setTimeout(() => hud.hint('Follow the pillars of light and the markers on the compass'), 3500);
          }, 700);
        }
        hud.showTitle(false);
        hud.blackout(false);
      }, 900);
    } else {
      hud.showTitle(false);
    }
  };
  playBtn.addEventListener('click', enterGame);
  const throwOrb = () => {
    if (player.mode !== 'walk' || game.dead || !document.pointerLockElement) return;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const origin = camera.position.clone().addScaledVector(dir, 0.6);
    origin.y -= 0.15;
    if (orbs.throw(origin, dir, player.velocity)) audio.orbThrow();
    else hud.hint('Out of light. Orbs recharge over time', 1500);
  };
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button === 0) throwOrb();
  });

  // a shade's blow drains light; at zero the dark takes you back to the crystal
  const shadeHit = (e) => {
    if (game.dead || player.mode !== 'walk') return;
    game.light = Math.max(0, game.light - 0.34);
    game.sinceHit = 0;
    game.hurt = 1;
    const dx = player.feet.x - e.position.x, dz = player.feet.z - e.position.z, d = Math.hypot(dx, dz) || 1;
    player.knockback((dx / d) * 8, (dz / d) * 8, 4.5);
    audio.shadeHit();
    if (game.light <= 0) fallDark();
    else if (!hinted.hit) {
      hinted.hit = true;
      hud.hint('Shades drain your light. It returns with time, and quickly inside the stone circle', 6000);
    }
  };
  const fallDark = () => {
    game.dead = true;
    audio.fallDark();
    hud.blackout(true);
    setTimeout(() => {
      creatures.scatter(player.feet, 90);
      player.respawn();
      game.light = 1;
      game.hurt = 0;
      game.dead = false;
      hud.blackout(false);
      hud.toast('The dark took you', 'You wake beside the crystal', 3500);
    }, 1500);
  };

  renderer.domElement.addEventListener('click', () => {
    if (player.mode === 'photo' || ((player.mode === 'walk' || player.mode === 'fly') && !document.body.classList.contains('title'))) {
      player.controls.lock();
    }
  });

  player.controls.addEventListener('lock', () => document.body.classList.add('locked'));
  player.controls.addEventListener('unlock', () => {
    document.body.classList.remove('locked');
    if (player.mode === 'walk' || player.mode === 'fly') {
      playBtn.textContent = 'Resume';
      hud.showTitle(true);
    }
  });

  const togglePhoto = () => {
    if (player.mode === 'cinematic') return;
    const on = player.mode !== 'photo';
    player.setPhoto(on);
    applyPixelRatio();
    if (!on && !document.pointerLockElement) {
      playBtn.textContent = 'Resume';
      hud.showTitle(true);
    }
  };

  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyC':
        if (player.mode === 'walk' || player.mode === 'fly') saved = { feet: player.feet.clone(), quat: camera.quaternion.clone() };
        if (player.mode !== 'cinematic') {
          player.setCinematic();
          playBtn.textContent = saved ? 'Resume' : 'Begin';
          hud.showTitle(true);
        }
        break;
      case 'KeyP':
        togglePhoto();
        break;
      case 'KeyE':
        throwOrb();
        break;
      case 'KeyK':
        if (player.mode === 'photo') captureRequested = true;
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
      case 'KeyT':
        params.dayCycle = !params.dayCycle;
        hud.hint(params.dayCycle ? 'Day cycle running' : 'Day cycle paused', 1500);
        break;
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

  function startFinale() {
    game.finaleT = 0;
    audio.finale();
    hud.toast('The valley awakens', 'All seven wisps have returned', 5000);
    const flash = document.getElementById('flash');
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 60);
    skyfx.shockwave();
    game.activated = true;
    creatures.banishAll();
    audio.state.activated = 1;
    updateObjective();
  }

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
  await step(0.9, 'Compiling shaders');
  weather.set(params.weather);
  atmosphere.set(params.elevation, params.azimuth);
  terrainShadow.update(atmosphere.lightDir);
  await renderer.compileAsync(scene, camera);
  atmosphere.update(new THREE.Vector3(), 0);
  renderer.shadowMap.needsUpdate = true;
  post.render(0.016);
  hud.setLoading(1, '');
  hud.ready();
  playBtn.disabled = false;
  hud.blackout(false);

  // ---------------------------------------------------------------- loop
  const timer = new THREE.Timer();
  const sunColorN = new THREE.Color();
  const fwd = new THREE.Vector3();
  const focus = new THREE.Vector3();
  let t = 0;
  let sunTimer = 0;
  let hudTimer = 0;
  let resTimer = 0;
  let frameAvg = 16;
  let wasUnderwater = false;
  let hintedSwim = false;

  renderer.setAnimationLoop(() => {
    timer.update();
    const rawDt = THREE.MathUtils.clamp(timer.getDelta(), 0, 0.1);
    frameAvg += (rawDt * 1000 - frameAvg) * 0.05;
    const photo = player.mode === 'photo';
    const dt = photo ? 0 : Math.min(rawDt, 0.05);
    t += dt;
    globalUniforms.uTime.value = t;

    player.update(Math.min(rawDt, 0.05));
    hud.setMode(player.mode);

    // time of day (and the finale's slide into night)
    if (game.finaleT >= 0) {
      game.finaleT += dt;
      monument.setPower(Math.min(game.finaleT / 3, 1));
      if (params.elevation > -12 && game.finaleT > 2) {
        params.elevation = Math.max(-12, params.elevation - dt * 2.2);
        params.dayCycle = false;
      }
    }
    if (params.dayCycle) {
      params.elevation += dt * params.cycleSpeed;
      if (params.elevation > 80) params.elevation = -20;
    }
    atmosphere.setStorm(weather.state.storm);
    sunTimer -= dt;
    const u = atmosphere.uniforms;
    u.cloudCoverage.value = weather.state.cover;
    u.cloudDensity.value = 0.5 + weather.state.storm * 0.4;
    u.turbidity.value = params.turbidity;
    u.rayleigh.value = params.rayleigh;
    const stormKey = weather.state.storm.toFixed(2);
    if (
      sunTimer <= 0 &&
      (params.elevation !== atmosphere.elevation || params.azimuth !== atmosphere.azimuth || atmosphere.lastEnvKey === '' || !atmosphere.lastEnvKey.endsWith(stormKey))
    ) {
      atmosphere.set(params.elevation, params.azimuth);
      terrainShadow.update(atmosphere.lightDir);
      sunTimer = 0.2;
    }
    scene.environmentIntensity = atmosphere.baseEnvIntensity * (1 - weather.state.storm * 0.45) + weather.flash * 2.5;

    // shadow frustum follows what the camera is looking at
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    focus.copy(camera.position).addScaledVector(fwd, atmosphere.shadowExtent * 0.45);
    focus.y = terrain.getHeight(focus.x, focus.z);
    atmosphere.update(focus, t);

    const light = atmosphere.sun;
    sunColorN.copy(light.color).multiplyScalar(light.intensity / 6.5);
    globalUniforms.uSunDirW.value.copy(atmosphere.lightDir);
    globalUniforms.uSunColorN.value.copy(sunColorN);

    const day = THREE.MathUtils.smoothstep(params.elevation, -4, 8);
    const playing = player.mode === 'walk' || player.mode === 'fly';
    grass.update(camera, playing ? player.feet : null);
    monument.update(t);
    particles.update(t, camera, atmosphere.lightDir, sunColorN, atmosphere.night * (1 - weather.state.rain), renderer.getPixelRatio());
    fauna.update(dt, t, camera.position, day, weather.state.rain);
    weather.update(dt, t, camera, atmosphere);
    skyfx.update(dt, t, atmosphere.night, weather.state.storm, game.activated);
    const q = quest.update(dt, t, playing ? camera.position : new THREE.Vector3(0, -1e4, 0), playing, renderer.getPixelRatio());

    // creatures and physics: AI, then character controllers, then the physics step
    const walking = player.mode === 'walk';
    const threat = game.activated ? 0 : Math.max(atmosphere.night, weather.state.storm * 0.75, quest.collected >= 2 ? 0.3 : 0);
    creatures.think(dt, t, {
      player: walking
        ? {
            pos: player.feet,
            vel: player.velocity,
            sprint: player.keys.ShiftLeft || player.keys.ShiftRight,
            huntable: !game.dead && Math.hypot(player.feet.x, player.feet.z) > SANCTUARY,
          }
        : null,
      camera: camera.position,
      forward: fwd,
      night: atmosphere.night,
      threat,
      lights: collectLights(quest.targets().map((w) => ({ pos: w.pos, r: 6 }))),
    });
    motorSystem(physics, dt, creatures.kcc);
    physics.step(dt);
    syncSystem();
    creatures.render(dt, t);
    orbs.update(dt, t, camera, {
      onBounce: (p, k) => audio.orbBounce(k, p.distanceTo(camera.position)),
      onSplash: (p, k) => p.distanceTo(camera.position) < 40 && audio.footstep('water', k),
    });
    if (creatures.hunting && walking && !hinted.shade) {
      hinted.shade = true;
      hud.hint('A shade is hunting you. Click or press E to throw light. Shades cannot enter the stone circle', 7000);
    }

    // light meter: recovers after a while, quickly inside the stone circle
    if (!game.dead && dt > 0) {
      game.sinceHit += dt;
      const atCrystal = Math.hypot(player.feet.x, player.feet.z) < SANCTUARY;
      if (game.sinceHit > 4 || atCrystal) game.light = Math.min(1, game.light + dt * (atCrystal ? 0.35 : 0.05));
    }
    game.hurt = Math.max(0, game.hurt - rawDt * 1.6);
    if (playing) {
      hud.setVitals(game.light, orbs.charges, orbs.maxCharges, orbs.recharge, creatures.dread > 0.05 || game.light < 1 || orbs.charges < orbs.maxCharges);
      hud.setDread(Math.min(1, creatures.dread * 0.9 + game.hurt * 0.6));
    } else hud.setDread(0);

    const wu = water.material.uniforms;
    wu.time.value = t;
    wu.sunDirection.value.copy(atmosphere.lightDir);
    wu.sunColor.value.copy(sunColorN);
    wu.nightFactor.value = atmosphere.night;
    wu.uRain.value = weather.state.rain;
    wu.uStorm.value = weather.state.storm;

    scene.fog.density = params.fogDensity * weather.state.fog;
    globalUniforms.fogSunColor.value.copy(atmosphere.fogSunBase || globalUniforms.fogSunColor.value).multiplyScalar(1 - 0.9 * weather.state.storm);
    globalUniforms.fogHeightFalloff.value = params.fogFalloff;

    // underwater
    const underwater = camera.position.y < WATER_LEVEL - 0.05 && terrain.getHeight(camera.position.x, camera.position.z) < WATER_LEVEL;
    const uw = post.underwater;
    uw.uUnderwater.value = underwater ? 1 : 0;
    uw.uWaterTint.value.setRGB(0.012, 0.06, 0.07).multiplyScalar(0.3 + 1.2 * sunColorN.g).addScalar(0.002);
    lakeLife.update(dt, t, camera, {
      underwater,
      swimmer: player.swimming && playing ? player.feet : null,
      sunDir: atmosphere.lightDir,
      sunColor: sunColorN,
      skyColor: scene.fog.color,
      tint: uw.uWaterTint.value,
      pixelRatio: renderer.getPixelRatio(),
    });
    if (underwater !== wasUnderwater) {
      if (underwater && !hintedSwim && playing) {
        hintedSwim = true;
        hud.hint('Space to swim up');
      }
      wasUnderwater = underwater;
    }
    if (player.swimming && !hintedSwim && !underwater) {
      hintedSwim = true;
      hud.hint('Swimming: Q to dive, Space to rise');
    }

    // camera
    const targetFov = params.fov + player.fovOffset;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-rawDt * 6));
      camera.updateProjectionMatrix();
    }

    // post
    renderer.toneMapping = toneMaps[params.toneMapping];
    renderer.toneMappingExposure = params.exposure;
    const ex = post.exposure.params;
    ex.auto = params.autoExposure;
    ex.key = params.exposureKey;
    post.gtao.blendIntensity = params.aoIntensity;
    post.bloom.enabled = params.bloom;
    post.bloom.strength = params.bloomStrength * (1 + (game.activated ? 0.3 : 0));
    post.bloom.radius = params.bloomRadius;
    post.bloom.threshold = params.bloomThreshold;
    const lu = post.lens.uniforms;
    lu.uFlare.value = params.lensFlare * (1 - weather.state.storm);
    lu.uCA.value = params.chromatic;
    const gu = post.grade.uniforms;
    gu.uVignette.value = params.vignette + creatures.dread * 0.25;
    gu.uGrain.value = params.grain;
    gu.uSharpen.value = params.sharpen;
    gu.uFade.value = Math.max(player.fade, game.hurt * 0.35);

    const dofOn = player.mode === 'cinematic' || photo;
    post.dof.enabled = dofOn;
    if (dofOn) {
      const du = post.dof.uniforms;
      du.uAuto.value = photo && params.dofAuto ? 1 : 0;
      du.uFocus.value = photo ? params.dofFocus : player.focus;
      du.uAperture.value = photo ? params.dofAperture : 0.45;
      du.uMaxBlur.value = params.dofMaxBlur * renderer.getPixelRatio();
    }

    post.update(t, rawDt, atmosphere.sunDir, sunColorN, params.elevation);
    lu.uRays.value *= params.godRays * (1 - weather.state.storm);

    renderer.info.reset();
    renderer.shadowMap.needsUpdate = true;
    post.render(rawDt);
    if (captureRequested) {
      captureRequested = false;
      saveCapture();
    }
    stats.update();

    // audio
    const hGround = terrain.getHeight(camera.position.x, camera.position.z);
    const shore = THREE.MathUtils.clamp(1 - Math.abs(hGround - 0.3) / 5, 0, 1) * (camera.position.y - WATER_LEVEL < 12 ? 1 : 0);
    audio.update(rawDt, camera, {
      day: day * (1 - weather.state.storm),
      night: atmosphere.night,
      rain: weather.state.rain * (underwater ? 0.2 : 1),
      wind: weather.state.wind,
      water: Math.max(shore, player.swimming ? 1 : 0),
      underwater,
      dread: playing ? creatures.dread : 0,
    }, monument.crystalPos);

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
    if (playing) {
      const markers = quest.targets().map((w) => ({ pos: w.pos, color: `#${w.color.getHexString()}`, kind: 'wisp', showDist: false }));
      if (q.nearest && markers.length) {
        const m = markers.find((mk) => mk.pos === q.nearest.group.position);
        if (m) m.showDist = true;
      }
      markers.push({ pos: monument.crystalPos, kind: 'home', showDist: quest.collected === quest.total && !game.activated });
      hud.updateCompass(camera, markers);
    }
    hudTimer -= rawDt;
    if (hudTimer <= 0 && document.body.classList.contains('debug')) {
      hudTimer = 0.25;
      const i = renderer.info;
      const p = camera.position;
      hud.debug(
        `fps        ${(1000 / frameAvg).toFixed(0)} (${frameAvg.toFixed(1)} ms)\n` +
          `mode       ${player.mode}\n` +
          `draw calls ${i.render.calls}\n` +
          `triangles  ${(i.render.triangles / 1e6).toFixed(2)}M\n` +
          `grass      ${(grass.count / 1000).toFixed(0)}k blades\n` +
          `lake       ${lakeLife.fishActive} fish, ${(lakeLife.kelpTotal * lakeLife.kelpDensity / 1000).toFixed(0)}k plants\n` +
          `resolution ${Math.round(innerWidth * renderer.getPixelRatio())}x${Math.round(innerHeight * renderer.getPixelRatio())} (${Math.round(resScale * 100)}%)\n` +
          `weather    ${params.weather}  wet ${weather.wetness.toFixed(2)}\n` +
          `creatures  ${creatures.shadeCount} shades, ${creatures.hares.filter((e) => !e.asleep).length} hares awake, ${orbs.count} orbs\n` +
          `ecs        ${ecs.entities.length} entities, light ${(game.light * 100).toFixed(0)}%\n` +
          `position   ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`
      );
    }
  });

  window.__maxgfx = { renderer, scene, camera, params, player, atmosphere, post, quest, weather, audio, game, hud, skyfx, terrainShadow, monument, underwater: lakeLife, physics, creatures, orbs, ecs, systems: { queries, motorSystem, syncSystem, collectLights } };
}

init().catch((err) => {
  console.error(err);
  hud.setLoading(0, `Failed to start: ${err.message}`);
});
