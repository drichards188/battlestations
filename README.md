# MaxGFX: Valley of Wisps

A three.js (WebGL2) game that pushes real-time rendering toward a modern AAA look. Everything is procedural: terrain, trees, creatures, textures, sound and music are all generated at load, so there are no asset downloads.

Beyond three.js it uses [Rapier](https://rapier.rs) for physics, [Yuka](https://mugen87.github.io/yuka/) for creature AI and [miniplex](https://github.com/hmans/miniplex) as a small entity/component registry.

```bash
npm install
npm run dev      # http://localhost:5199
npm run build    # production bundle in dist/
```

## Playing

A cinematic camera tour plays behind the title screen. Click **Begin** to drop into the valley. Seven wisps are scattered around it. Follow their light pillars and the compass markers, and walk into each one to gather it. Each wisp flies back to orbit the crystal, and returning all seven awakens the valley.

**Shades** come out at night, in storms, and once you have gathered two wisps. They prowl toward you, hunt you when you come within about 30 m, and lunge to drain your **light** (the bar at the bottom of the screen). Light comes back slowly on its own and quickly inside the stone circle, which shades cannot enter. If it runs out, the dark takes you back to the crystal. Throw **light orbs** (click or `E`, three charges that recharge) to drive them off: shades won't enter an orb's glow, and a direct hit banishes one. Sprinting outruns them. Awakening the valley banishes them for good.

Herds of **hares** graze in the meadows. They scatter when you come close (sooner when you sprint) or when a shade is near, and burrow at night.

| Key | Action |
|---|---|
| `W A S D` | move |
| `Shift` | sprint |
| `Space` | jump, swim up |
| `Q` | dive (while swimming), descend (fly / photo) |
| `Click` / `E` | throw a light orb |
| `F` | toggle fly mode |
| `P` | photo mode (freezes time, free camera, depth of field) |
| `K` | capture a PNG screenshot (photo mode) |
| `C` | cinematic camera / title screen |
| `V` | cycle weather: Clear, Cloudy, Rain, Storm |
| `T` | toggle the day/night cycle |
| `M` | mute |
| `H` | hide all UI |
| `F3` | FPS, draw calls, triangles, resolution |
| `Esc` | release the mouse (pause, settings panel) |

## Rendering

| Area | Technique |
|---|---|
| Terrain | 1.6 km heightfield (fbm + ridged noise) with a per-pixel splat shader (grass, dirt, sand, rock strata, snow, wet shoreline), rain puddles that turn mirror-flat, and animated caustics on the lake bed |
| Lake bed | Reefs of ridged rock, a drop-off into a deep basin and a sinuous trench, sculpted only below the waterline. Underwater splat layers (rippled sand with analytic ripple normals, gravel, silt, an algae film where the light reaches), water-worn boulders, and lighting that dims and shifts to teal with depth |
| Lake life | Chunked GPU-instanced kelp and eelgrass forests swaying in a slow current, schools of minnows, perch and carp driven by a boids simulation (one draw call, tail beat in the vertex shader, they scatter from the swimmer), reed beds and lily pads along the shore, and, when diving, plankton, bubbles and the underside of the surface with Snell's window and sun glints |
| World shadows | GPU-baked "occlusion height" map raymarched through the heightmap toward the sun, so mountains cast soft shadows across the whole valley, beyond the reach of the shadow map. Moving cloud shadows are projected along the light direction |
| Grass | Up to 1M GPU-instanced blades in a tile that wraps around the camera. Terrain snapping, masking, layered wind gusts, player push-away and backlit translucency all run in the shaders |
| Forest | Leaf-card broadleaf trees and needle-card pines built from canvas-painted atlases, with volumetric canopy normals, wind sway, per-card flutter, sun translucency and mip-aware alpha so canopies don't thin out with distance. Instanced and chunked for frustum culling |
| Sky | Physical Rayleigh/Mie sky with clouds, stars, a Milky Way band, a moon, storm overcast and lightning flashes, plus aurora curtains at night |
| Lighting | Sun/moon directional light with texel-snapped 4096² shadows that follow the view, IBL re-baked from the live sky, and a time-of-day cycle |
| Weather | Smooth transitions between Clear, Cloudy, Rain and Storm: rain streaks, surfaces that darken and turn glossy as they get wet then dry out, rain ripples on the lake, stronger wind and waves, and lightning bolts with delayed thunder |
| Water | Planar HDR reflections, depth-based absorption, see-through shallows, shore foam, HDR sun glints, and an underwater view with absorption fog and light shafts |
| Materials | Glass crystal with transmission, dispersion and iridescence; chrome, gold, clear-coat paint, velvet sheen, pearl iridescence, anisotropic copper |
| Life | Flocks of birds, butterflies, fireflies at night, dust motes in the sunlight, fish in the lake |
| Creatures | Shades (hooded wraiths with billowing, tattered robes, a dissolve-in effect, glowing eyes and a rim glow that flares when they lunge or burn in light) and hopping hares, both GPU-instanced. Each is a Yuka vehicle with a state machine and steering behaviors (wander, pursuit, flee, flocking, arrive, plus custom water, home-range and sanctuary avoidance), moved by a Rapier character controller that slides along trees, rocks and slopes |
| Physics | Rapier world with the terrain as an exact heightfield (it matches the rendered triangles), trees and standing stones as cylinders, rocks and boulders as spheres. Light orbs bounce down slopes and float on the lake |
| Post | Single scene pass with a shared depth buffer, GTAO from that depth, eye-adaptation auto exposure (GPU luminance reduction), bokeh depth of field with autofocus, bloom, god rays, occlusion-aware lens flare, ACES/AgX tone mapping, SMAA, color grade presets, contrast-adaptive sharpening, vignette and grain |
| Performance | Quality presets (Low to Ultra) and dynamic resolution that holds ~60 FPS |

## Audio

Everything is synthesized with WebAudio at runtime:

- **Ambience:** wind that follows gusts and altitude, rain, water lapping at the shore, birdsong placed in 3D around you by day, crickets at night.
- **World sounds:** a positional hum from the crystal, footsteps that change by surface (grass, stone, water), landings and splashes, thunder delayed by the strike's distance, and muffled sound underwater.
- **Music:** a generative ambient score, plus chimes on pickups and a chord swell at the finale.
- **Creatures:** a low beating drone and whispers that rise as shades close in, their blows, banishing chimes, orb throws and bounces.

## Layout

```
src/
  main.js          renderer, quality presets, GUI, game flow, main loop
  shaderlib.js     shared uniforms, GLSL noise, height fog, world shadows, wetness
  noise.js         CPU noise, seeded RNG, tileable normal-map generator
  terrain.js       heightfield, splat shader, caustics, exact height queries
  terrainShadow.js GPU terrain occlusion-height bake
  atmosphere.js    sky, stars, moon, sun/moon light, IBL bake, async fog probe
  weather.js       weather states, rain, lightning
  skyfx.js         aurora, monument beam, shockwave
  water.js         custom water shading on top of three's mirror Water
  underwater.js    kelp forests, fish schools, lake-bed boulders, reeds, lily pads, plankton, surface from below
  grass.js         GPU grass field
  vegetation.js    foliage atlases, tree and rock generation, scattering
  monument.js      stone circle, crystal, PBR showcase
  particles.js     fireflies and dust motes
  fauna.js         birds and butterflies
  quest.js         wisps, pickup bursts, delivery
  physics.js       Rapier world: terrain heightfield, static props, character controllers, orb bodies
  ecs.js           miniplex entity registry, queries, motor and sync systems
  creatures.js     shades and hares: Yuka steering and state machines, instanced visuals
  orbs.js          throwable light orbs, buoyancy, pooled point lights
  audio.js         procedural audio engine and music
  hud.js           title screen, compass, objectives, toasts
  post.js          post-processing chain and custom passes
  player.js        walk/swim/fly controller, cinematic shots, photo camera
```
