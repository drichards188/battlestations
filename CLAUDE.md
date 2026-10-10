# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MaxGFX: Battle Stations, a three.js (WebGL2) game/graphics showcase: the player crews the AA guns of a US battleship in a 1944 Pacific carrier task group against Japanese air raids. Plain ES modules, no TypeScript, no framework. Everything (ocean, ships, aircraft, guns, textures, audio, music) is generated procedurally at load; there are no asset files. The only runtime dependencies used are three.js and lil-gui. See README.md for controls, the rendering feature list, and a per-file layout of `src/`.

## Commands

```bash
npm install
npm run dev      # Vite dev server on http://localhost:5199 (--host, so reachable on LAN)
npm run build    # production bundle in dist/
npm run preview  # serve dist/
```

There are no tests, linter, or formatter configured. Verify changes by running the dev server and looking at the result in a browser (F3 shows FPS, draw calls, triangles, aircraft, shells and particles; lil-gui settings panel appears when the mouse is released with Esc).

Headless testing: `window.__maxgfx` exposes every system plus `frame(dt, draw)`. Stop the loop with `renderer.setAnimationLoop(null)` and call `frame(0.05, false)` repeatedly to fast-forward the battle without rendering (about 2 ms per step), then `post.render()` and `renderer.domElement.toDataURL()` in the same evaluate to capture a frame.

## Architecture

### Orchestration lives in `src/main.js`

`init()` builds every subsystem in order (atmosphere, ocean, islands, clouds, fx, ballistics, ordnance, fleet, air, gunner, weather, director, cinematic, post), adds the parked Hellcats, calls `patchSceneFog(scene)`, warms up with `renderer.compileAsync`, and runs `frame()` from `renderer.setAnimationLoop`. Subsystems do not import each other's state: cross-system effects go through callbacks wired in main (`air.events`, `ordnance.events`, `fleet.events`, `director.events`, the `ballCtx` object passed to `ballistics.update`), and the loop pushes state into uniforms and `update()` args. When adding cross-system behavior, wire it in main rather than importing one module into another.

Per frame, in order: sun/sky, `fleet.update` (ships move, AI gun crews aim and fire), `air.update` (aircraft AI), `ordnance.update`, `director.update`, `gunner.update` (player gun and camera) or the cinematic/photo camera, `ballistics.update` (shells, hits), ocean, islands, clouds, fx, weather, post, audio, HUD.

The `params` object in main.js is the single source of truth for user settings (lil-gui binds to it); `QUALITY` presets set pixel ratio, shadow map size/extent, AO, sample counts and the particle budget. Modes: `cinematic` (title tour, also spectating with `C`), `gun`, `photo`. `dt` is 0 in photo mode and while paused (mouse released mid-battle); `rawDt` still drives cameras, post and audio.

### Shared shader state (`src/shaderlib.js`)

- `globalUniforms` holds uniform objects shared by reference across every patched material (time, sun direction/color, cloud shadows, wetness, wind, fog params). Update `.value` once and all programs see it.
- The module **globally overrides three's `ShaderChunk`s** on import: `fog_*` becomes analytic height fog with sun in-scattering and provides `vFogWorldPos`; `lights_fragment_end` multiplies direct light by the cloud shadow; `roughnessmap_fragment` applies rain wetness. These only activate under `USE_FOG`. Define `SKIP_WET` to opt out (the ocean does).
- `patchMaterial(material, key, patch)` injects `globalUniforms` in `onBeforeCompile` and sets `customProgramCacheKey` to `key`. **Each distinct patch needs a unique key.** `patchSceneFog` runs once at init; materials created afterwards must call `patchMaterial` themselves. Custom `ShaderMaterial`s with `fog: true` merge `UniformsLib.fog` and `globalUniforms` into their uniforms (see fx.js, clouds.js).

### Ocean (`src/ocean.js`)

The wave set is built once (seeded) and baked into GLSL constants; `Ocean.displace`/`heightAt` evaluate the same Gerstner sum on the CPU (heightAt inverts the horizontal displacement), so anything floating (ship pose) matches the rendered surface. Don't change one side without the other. The mesh is a radial grid recentred on the camera each frame; short waves fade with distance in the vertex shader and with pixel footprint in the fragment shader (lost slope variance becomes roughness). The water is a patched `MeshPhysicalMaterial`, so IBL, sun specular, shadows and fog come from three.

`FoamMap` is a world-space render target around the camera (2048², 5120 m): each frame a decay/diffusion pass shifts it with the camera, then `ocean.stamp(x0, z0, x1, z1, radius, foam, aerated)` capsules are max-blended in. Ships stamp stern wakes, torpedoes their tracks, splashes and crashes discs. Bow waves and Kelvin arms come from `setShips()` uniforms (up to 16 ships) evaluated in the ocean shader; lagoons from `setShallows()`.

### Fleet, guns and ballistics

`fleet.js` builds the task group from `ORDER` (class, name, camo, formation offset, hull number, variant) using `models/ships.js`. The player's ship is USS Alabama (`variant: 'alabama'`, BB-60 as of June 1944); `models/ships.js` documents the historical sources behind each battleship variant in `BB_VARIANTS`. Ships keep station relative to a moving guide that zig-zags, comb torpedo tracks, and get pitch/roll/heave from `ocean.heightAt` through damped springs. Ship space: bow -Z, starboard +X, waterline y=0; train angles use three's `rotation.y` (0 = bow, + = port). `ship.containsLocal` (hull profile plus `model.boxes`) is the hit test for bombs, torpedoes, kamikazes and strafing; `ship.rayBlocked` gives the player's firing cutouts.

Every gun is a `Mount` (pose, train/elevation, crew state). AI mounts are drawn with one `InstancedMesh` per kind for bases and guns (`models/guns.js`); `fleet.aim()` picks targets, computes lead with the cheap analytic `leadPoint` and fires with a slowly wandering aim error (`GUNS[kind].err`, scaled by `difficulty.gunnery`). AI mounts fire at real rates (`GUNS[kind].interval`); balance comes from `difficulty.lethality` (a damage scale on fleet rounds, 5" rounds weighted 1.8x), the aim error, and a cap of 10 mounts per aircraft. **AI lethality is tuned so the player matters:** the fleet should not kill most of a raid before it attacks. Re-check with a fast-forwarded battle after touching `GUNS`, `SHELLS`, VT radius or aircraft hit points.

Gun crews (`fleet.addCrew()`, sailors from `models/guns.js` `buildSailor`/`crewSpots`) are instanced per pose; spots with `rotates` follow the mount's train, the rest stay on the deck. Crews are hidden on the player's occupied station, on ships more than 1.4 km away, and on sinking ships.

`ballistics.js` simulates all shells (quadratic drag, gravity) in typed arrays and draws all tracers in one instanced mesh. Friendly shells test segment-vs-sphere against aircraft; 5" shells burst on proximity (`vt`) or their timed fuze; enemy machine-gun rounds test against ships.

### Player (`src/gunner.js`)

Every AA mount aboard the player's ship is a station (`Gunner` builds them from `ship.mounts`; battleships build all their 40mm and 20mm on the larger `station-*` foundations via `Parts.playable`, sized to hide under the detailed models). The stations stay ordinary AI mounts drawn by the fleet's instanced meshes; one detailed `buildPlayerGun` model per kind (`gunner.models`) is moved onto whichever mount the player takes (`occupy()`/`release()`): `mount.detailed = true` hides that mount's AI instance in `fleet.renderMounts`, and the mount gets the model's pivot and muzzles (restored from `mount.ai` when released). Per-mount state (heat, 20mm drums, the 5" loading cycle `st.five`, the Bofors racks and lockers `st.supply`) lives on the station; the models only animate for their owner. Unoccupied mounts are crewed by the AI like any other; `mount.manual = true` hands one to the player. Names come from `nameStations()` (5" 1 to 10 per DANFS, 40mm 41 to 52, our own 20mm numbers). Aim is commanded in ship space. Power-driven mounts (`def.drive`: the quad 40mm and the 5") follow the command through `powerDrive()`: real top speeds, acceleration limits from the manuals' braking distances, a hydraulic lag, the command clamped to a lead ahead of the mount and feed-forward from the mouse rate so steady tracking doesn't lag; the Oerlikon swings freely. The camera sits on the gun's `eye` anchor (it moves and rolls with the ship); the quad's centre eye pulls back at low elevation (`eyes.centre` to `eyes.centreHigh`) and eyes under `yaw` (`gun.eyeSpace === 'yaw'`, the enclosed 5") take their orientation from `pitch`. `designate()` picks the aircraft nearest the bore line for the lead computing sight, solved exactly with `solveLead` (it flies a shell through the game's own integrator and corrects the aim by the miss).

The quad 40mm model owns a `BoforsFeed` (`src/feed.js`), modelled on OP 820/TM 9-252/OD 4391: every round, clip, star wheel, feed pawl and spent case is a live instanced object in the gun's pitch or yaw space. Rounds sit on a curved guide arc (`arc()`), clips ride down the column until their lowest round is two from the bottom and are then thrown out the side (`layout.eject`), `take(b)` needs a round on the tray and the loader catch (two rounds left) stops the gun, and the loaders' hold/swing/hang/jam phases carry the human variation. `takeOver(supply)` refills the guides when the model moves to another quad (the AI crew kept it loaded) and `supplyState()` keeps each mount's racks and lockers; `gunner.restock()`/`newBattle()` run between raids and at a new battle. The loaders' clips are only drawn on the mount the player is on (`feed.manual`); elsewhere the AI sailors carry their own.

`src/shipmap.js` is the ship's plan (hold Ctrl): the player's ship rendered once from above as a depth pass into a shaded height map, every station as a button showing its train, tabs by kind and arc-of-fire wedges (SVG in metres over the plan). main.js keeps the battle running (no pause) while the pointer is released for it.

### Aircraft (`src/air.js`, `src/ordnance.js`)

`PLANES` holds gameplay stats; models and liveries come from `models/aircraft.js` (one `InstancedMesh` per type with a per-instance `aState` attribute: damage, prop phase, ordnance attached, hit flash). Raids spawn as groups flying slot formation until they break, then each aircraft runs its role: `dive` (roll-in point, dive, release, pull-out), `torpedo` (beam setup, wave-top run, drop at the intercept, break away or overfly), `strafe` (shallow gun runs, repeated), `kamikaze` (high dive or wave-top run, weaving terminal dive; still lethal when shot down close in). Flight is kinematic: `steer()` turns the velocity toward a desired direction at a limited rate and banks from the yaw rate.

### Game flow (`src/director.js`)

`RAIDS` defines the six raids (groups, bearing offsets, delays, sun elevation). States: `brief`, `raid`, `lull`, `victory`, `defeat`. On the title screen the director runs attract mode (ships invulnerable, nothing scored). Kills are credited to the player when they did the killing blow or at least 40% of the damage; otherwise an assist. Losing the player's ship or the carrier ends the battle.

### Lighting, sky and post

`Atmosphere` owns the sky, the sun/moon light and IBL baked from the live sky; re-baking is throttled to real changes (sun moved more than 0.4°, storm level). The shadow frustum follows a focus point ahead of the camera; `renderer.shadowMap.autoUpdate` is off and the loop sets `needsUpdate`. `PostFX` (`src/post.js`) renders the scene once into an HDR target with a shared depth texture; pass order: scene, GTAO, auto exposure, DoF (cinematic/photo only), bloom, lens, OutputPass, SMAA, grade. `fx.js` keeps a fixed pool of point lights; never add or remove lights at runtime, since a change in light count recompiles every lit shader.
