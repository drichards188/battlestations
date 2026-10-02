# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MaxGFX: Valley of Wisps, a three.js (WebGL2) game/graphics showcase. Plain ES modules, no TypeScript, no framework. Everything (terrain, textures, foliage atlases, creatures, audio, music) is generated procedurally at load; there are no asset files. Dependencies beyond three.js: Rapier (`@dimforge/rapier3d-compat`, physics), Yuka (AI steering and state machines) and miniplex (entity registry). See README.md for controls, the rendering feature list, and a per-file layout of `src/`.

## Commands

```bash
npm install
npm run dev      # Vite dev server on http://localhost:5199 (--host, so reachable on LAN)
npm run build    # production bundle in dist/
npm run preview  # serve dist/
```

There are no tests, linter, or formatter configured. Verify changes by running the dev server and looking at the result in a browser (F3 shows FPS, draw calls, triangles, resolution; lil-gui settings panel appears when the mouse is released with Esc).

## Architecture

### Orchestration lives in `src/main.js`

`init()` builds every subsystem in order (terrain, atmosphere, terrain shadow, water, vegetation, monument, grass, lake life (`underwater.js`), particles, fauna, weather, skyfx, quest, physics, creatures, orbs, post, player), then calls `patchSceneFog(scene)`, warms up with `renderer.compileAsync`, and starts `renderer.setAnimationLoop`. Subsystems do not talk to each other directly: the main loop reads state from one (e.g. `weather.state.rain/storm/wind/cover/fog`, `atmosphere.lightDir/night`, `player.mode`) and pushes it into others' uniforms or `update()` args. When adding cross-system behavior, wire it in the loop rather than importing one module into another.

The `params` object in main.js is the single source of truth for user settings (lil-gui binds to it); `QUALITY` presets set pixel ratio, shadow map size/extent, grass count, AO and sample counts. Dynamic resolution adjusts `resScale` from a smoothed frame time, except in photo mode.

Time: `t` stops advancing in photo mode (`dt = 0`), while `rawDt` still drives camera, post and audio.

### Shared shader state (`src/shaderlib.js`)

- `globalUniforms` holds uniform objects shared by reference across every patched material (time, sun direction/color, terrain shadow texture, cloud shadows, wetness, wind, fog params). Update `.value` once and all programs see it. Writers: main.js (time, sun, fog), weather.js (wetness, wind, cloud), terrainShadow.js (shadow texture).
- The module **globally overrides three's `ShaderChunk`s** on import: `fog_*` becomes analytic height fog with sun in-scattering and also provides `vFogWorldPos`; `lights_fragment_end` multiplies direct light by the world (terrain + cloud) shadow; `roughnessmap_fragment` applies rain wetness. These only activate under `USE_FOG`, so materials need fog enabled to get world shadows and wetness. Define `SKIP_WET` on a material to opt out of wetness (grass does this).
- `patchMaterial(material, key, patch)` injects `globalUniforms` in `onBeforeCompile` and sets `customProgramCacheKey` to `key`. **Each distinct patch needs a unique key**, or three will reuse the wrong compiled program. `patchSceneFog` runs once at init over the scene; materials created afterwards must call `patchMaterial` themselves. `ShaderMaterial`s with `fog: true` get the uniforms merged in instead.

### Terrain as the world query API

`terrain.js` exports constants (`TERRAIN_SIZE` 1600, `WATER_LEVEL` 0, `PLATEAU_HEIGHT`, `LAKE_CENTER`) and `heightFunction(x, z)`. `terrain.getHeight(x, z)` gives exact heights and is used by the player controller, scattering (vegetation, quest, particles, lake life), the shadow focus point, and underwater/shore checks. The monument plateau overrides ground height via the player's `groundOverride` callback in main.js. `lakeBedInfo` adds the lake-bed relief (reefs, drop-off, trench) on top of the plain bowl; it is masked by depth so nothing above -1.5 m ever changes, and `lakeReef(x, z)` exposes the reef weight for scattering. Player colliders are `{x, z, r}` cylinders; an optional `top` lets the swimmer pass above submerged boulders.

### Lake life (`src/underwater.js`)

`Underwater` owns everything in and around the lake: chunked instanced kelp/eelgrass (density and a distance LOD via `instanceCount`), one `InstancedMesh` of fish animated by a CPU boids sim (`simulate`), boulders, reeds, lily pads, plankton/bubbles and the water underside, the last two only visible while `underwater`. Its materials share `underwaterLightGLSL` (caustics plus depth attenuation, the same model the terrain shader uses). main.js drives it from the loop with `update(dt, t, camera, state)`, hides the submerged parts during the reflection render through `setReflection`, and scales it with the `kelp`/`fish` fields of `QUALITY` via `setQuality`. Everything sleeps when the camera is more than `ACTIVE_RADIUS` from `LAKE_CENTER`.

### Lighting and shadows

`Atmosphere` owns the sky, the sun/moon directional light, and IBL baked from the live sky. Re-baking is throttled: `atmosphere.set()` and `terrainShadow.update()` only rerun when sun position or storm level changes, at most every 0.2 s. The shadow-map frustum follows a focus point ahead of the camera. `renderer.shadowMap.autoUpdate` is off; the loop sets `needsUpdate` each frame. `TerrainShadow` bakes a GPU occlusion-height map for valley-scale shadows beyond the shadow map.

### Post-processing (`src/post.js`)

`PostFX` wraps an `EffectComposer` with HalfFloat targets. A custom `ScenePass` renders the scene once into a target with a depth texture that is shared by GTAO, DoF and the underwater resolve (`post.underwater` returns the resolve uniforms). Pass order: scene, GTAO, auto exposure, DoF (enabled only in cinematic/photo), bloom, lens (god rays, flare, CA), OutputPass (tone mapping), SMAA, grade (vignette, grain, sharpen, fade). Color grade presets are in `GRADES`.

### Water reflection

The lake uses three's mirror `Water`; main.js wraps `water.onBeforeRender` to hide grass and rain during the reflection render for performance. Hide any other expensive, reflection-irrelevant object the same way.

### Creatures, physics and the ECS

`physics.js` loads Rapier lazily (`loadRapier()` is kicked off at the top of `init()` so the large WASM chunk downloads during world generation). The terrain is a heightfield built by transposing `terrain.heights` (Rapier is column-major); it matches `getHeight` exactly, so don't change one without the other. Static colliders come from the same `{x, z, r}` lists the player uses: `kind: 'rock'` and entries with `top` become spheres, everything else a tall cylinder. Collision groups are in `GROUP`. Creature character controllers collide only with the world (`kcc.*.filterGroups`): a Rapier character controller that starts a move touching another moving body can wedge and never move again. Creature spacing comes from Yuka separation, and the player is kept off creatures by `player.dynamicColliders`, which `Creatures` refreshes every frame.

`ecs.js` holds the miniplex world and queries. Entities are plain objects (`kind`, `position`, `body`, `agent`, `asleep`, `light`, `life`). Per frame, main.js runs: `creatures.think` (Yuka `EntityManager`s update brains and steering), `motorSystem` (turns each vehicle's step into a character-controller move), `physics.step`, `syncSystem` (positions back into entities and vehicles), then `creatures.render` and `orbs.update`. Add new AI creatures by giving them an `agent` and `body` and a controller in `creatures.kcc[kind]`; anything with a `light` component automatically repels shades.

`creatures.js`: each creature is an `Agent` (a Yuka `Vehicle` with a `StateMachine`). States are shared `YUKA.State` objects keyed by name; `agent.go(name)` switches, `agent.use({behavior: weight})` picks the active steering behaviors. `GroundBehavior` is always first (highest priority): it avoids water, keeps hares near their warren and keeps shades out of `SANCTUARY`. The shade count follows a `threat` level computed in main.js (night, storm, wisps gathered, zero after the finale). Parked creatures get the `asleep` component and a disabled rigid body.

`orbs.js` keeps a fixed pool of point lights for the nearest orbs; never add or remove lights at runtime, since a change in light count recompiles every lit shader.

### Game flow

`player.mode` is one of `cinematic` (title screen tour), `walk`, `fly`, `photo`. `Quest` spawns wisps and reports via `onCollect`/`onDeliver`/`onComplete` callbacks; completion triggers the finale in main.js (sky slides to night, monument power-up, shockwave). The player emits `step`/`land`/`splash`/`jump` events consumed by `AudioEngine`. `game.light` is the player's light meter: shade hits drain it (`shadeHit` in main.js), it regenerates over time and fast inside the sanctuary, and at zero `fallDark` respawns the player at the monument.
