# Development

Back to the [README](../README.md).

## Running and sharing

```bash
npm install
npm run dev      # http://localhost:5199 (also reachable from other machines on the LAN)
npm run build    # production bundle in dist/
npm run preview  # serve the built bundle
```

- **Browser.** WebGL2 is required.
- **Sharing.** The build uses relative paths, so `dist/` runs from any folder on a web server: upload it to itch.io as an HTML game, put it on GitHub Pages, or try it locally with `npm run preview`. Keep `licenses.md` (the bundled libraries' licenses) and `audio/CREDITS.md` (the recordings) with it.
- **Not from disk.** Opening `dist/index.html` straight from disk won't work, because browsers block modules and audio loaded from `file://`.

## Testing

- **No test suite.** There are no tests, linter or formatter. Changes are checked on the dev server: `F3` shows frame statistics, and `Esc` opens the settings panel.
- **Headless.** `window.__battlestations` exposes every system plus `frame(dt, draw)`. Stop the loop with `__battlestations.renderer.setAnimationLoop(null)`, then call `frame(0.05, false)` repeatedly to fast-forward a battle without drawing (about 2 ms a step).
- **Capturing a frame.** Call `__battlestations.post.render()` and `renderer.domElement.toDataURL()` in the same evaluation.
- **Starting a battle.** `document.getElementById('play').click()` starts one, and `__battlestations.gq.skip()` skips the General Quarters run.
- **Balance.** After changing guns, shells, VT fuzes or aircraft hit points, fast-forward a few battles and check the fleet doesn't kill most of a raid before it attacks.

## Known polish items

Cloud brightness under flares at night, a gap at the door of Mount 47's tub, and the brightness at the weather door in the General Quarters run.

## Layout

```
index.html         the page: title screen, loading bar, HUD, ship's plan, end screen
public/audio/      the real recordings and their CREDITS.md
docs/              these pages and the README screenshot
src/
  main.js          renderer, quality presets, GUI, game flow, event wiring, main loop
  shaderlib.js     shared uniforms, GLSL noise, height fog, cloud shadows, wetness
  noise.js         CPU noise, seeded RNG, tileable normal-map generator
  atmosphere.js    sky, stars, moon, sun/moon light, IBL bake, async fog probe
  weather.js       weather states, rain, lightning
  ocean.js         Gerstner ocean (GPU and CPU), water material, foam map, wakes
  islands.js       volcanic islands and lagoon shallows
  clouds.js        cumulus billboard clusters
  fleet.js         ships: formation, motion, damage, fires, sinking; AI gun crews
  air.js           aircraft: instanced rendering, formations, attack AI, damage
  ordnance.js      bombs and torpedoes
  ballistics.js    shells, tracers, hit detection, lead computation
  gunner.js        the player's gun stations, power drives, aiming, firing, camera
  feed.js          the quad Bofors' automatic loaders, clips, loaders, racks, spent brass
  gq.js            the general quarters opening: the run from the berthing to Mount 47
  shipmap.js       the ship's plan (hold Ctrl) for changing mounts
  director.js      day and night raids, callouts, scoring, difficulty, win and loss
  cinematic.js     title camera tour, photo-mode camera
  fx.js            smoke, fire, flashes, sparks, spray, debris, blast lights
  flares.js        parachute flares and float lights for the night battle
  audio.js         audio engine: synthesized banks, real recordings (public/audio), music
  hud.js           sight, brackets, radio log, compass, status, end screen
  post.js          post-processing chain and custom passes
  style.css        title screen, HUD and ship's plan styles
  models/
    ships.js       procedural ship builder (bb, cv, cl, dd)
    aircraft.js    procedural aircraft, liveries, bombs and torpedoes
    guns.js        instanced AI mounts and the detailed player guns
    interior.js    the GQ route through the ship: berthing, passageways, doors, hatches, ladders
    runners.js     the running crew: instanced, articulated sailors that run, climb and duck
```
