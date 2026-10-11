# MaxGFX: Battle Stations

A three.js (WebGL2) game that pushes real-time rendering toward a modern AAA look. You crew the anti-aircraft guns of USS Alabama (BB-60), screening a fast carrier task group in the Western Pacific in June 1944, while Japanese strikes come in: Val dive bombers, Kate and Betty torpedo bombers, strafing Zeros and kamikazes. Nearly everything is procedural: the ocean, the ships, the aircraft, the guns, textures, music and most of the sound are generated at load. The only downloads are a handful of real sound recordings (see Audio).

```bash
npm install
npm run dev      # http://localhost:5199
npm run build    # production bundle in dist/
```

## Playing

A cinematic camera tours the task group behind the title screen while the fleet fights off a practice raid. Pick a difficulty, **Day** or **Night**, and click **Man your station**. (Switching Day and Night on the title screen changes the sky and the practice raids behind it at once; during a battle it applies to the next one.)

The battle opens below decks with the general alarm and the 1MC call to general quarters. You turn out of your rack in a second-deck berthing compartment and run with your shipmates "up and forward to starboard": through the watertight door, up the inclined ladders and hatches to the main deck and the 01 level, out of the weather door, up the ladder to the sponson and into Mount 47's tub, where the camera settles onto the gun. The men ahead keep their distance on the ladders and peel off aft to their own stations once you are out on deck; the raid waits until you are on the gun. Mouse-look works on the way; `Space` skips to the gun, and the settings panel can turn the opening off. The compartments are our own reconstruction: their markings follow the Navy's pre-1949 compartment numbering, but we could not find Alabama's actual compartment numbers or plans, so the layout is ours (sources in `src/models/interior.js`).

You start on the starboard quad 40mm Bofors amidships. Raids are called out by radar with their bearing, range and altitude, and show up as red markers on the compass. Train and elevate with the mouse: you are working the pointer's and trainer's handwheels, and the mount's electro-hydraulic power drives follow at their real speed (26 degrees a second in train, 24 in elevation for the Mk 2 quad), accelerating and braking no harder than the drive's gear allows and a moment late, so the mount is heavy and you can't whip it round; a small circle shows where you are commanding it to point, and it can't run more than about 30 degrees ahead of the guns. Hold the left button to fire. The rounds take seconds to reach a target, so lead it: on Recruit and Gunner the **lead computing sight** puts a diamond where you need to aim at the aircraft nearest your bore line. The quad fires at its real rate, each gun cycling about every half second; the guns of each twin slide alternate through their delay gear, so one gun of each pair fires at the same moment. Barrels heat up under long bursts and lock out until they cool. Tracers follow the period ammunition: every 40mm round the Navy fired in 1944 carried a tracer, one round in five in a 20mm drum (its tracer burns out after about 3.75 s while the round flies on), and the 5" fired none. `X` switches between the centre view and the pointer's seat behind his ring sight. The guns stop firing (**firing cutout**) rather than shoot through your own superstructure.

The Bofors' ammunition is live and works as the manuals describe it (OP 820, TM 9-252, OD 4391). Each gun's automatic loader is a pair of curved guides above the rammer tray holding seven rounds, noses forward, fanning toward the muzzle, with an eighth on the tray. Each shot, the feed pawls force the column down one round, the star wheels turn a quarter turn and the lowest round drops onto the tray; the empty case goes out of the breech into the deflector and down through the carriage to the deck. Loaders drop 4-round clips into the feed lips; each clip rides down with its rounds until it is cammed off two rounds from the bottom and thrown out through the side of the slide. With two rounds left the loader catch stops the gun, and it fires again by itself the moment a clip goes in. The loaders aren't machines: they tire, a crooked clip has to be rocked into the lips, and now and then one jams and has to be cleared with the tools while that gun runs dry. Behind them, second loaders work out of the ready racks, passers restock the racks from the lockers and the hoist refills the lockers; hold the trigger long enough and you outrun them (the HUD shows each gun's tray round, its seven in the guides and the loader's next clip, plus the ready supply).

Every anti-aircraft gun aboard Alabama can be manned: her ten twin 5"/38 mounts, twelve quad 40mm Bofors and thirty-three single 20mm Oerlikons. Hold `Ctrl` for the ship's plan: Alabama seen from above with every mount marked, pointing the way it is trained; hover one to see its arc of fire, use the tabs to pick out the 5", 40mm or 20mm, and click a mount to take it over (the battle doesn't stop while the plan is up). Let go of `Ctrl` to go back to your gun. Whatever you aren't on is crewed by the AI, like every gun in the fleet. You start on Mount 47, the starboard quad on the 02 level. The 5" mounts are enclosed, slow to train (25 degrees a second, 15 in elevation), each gun hand-loaded from the hoists and firing as its breech closes, about 15 to 20 rounds a minute a gun, with VT-fuzed shells that burst on proximity; `X` moves you from the mount captain's hatch to the pointer's telescope window. In 1944 they were numbered 1 to 10 (Alabama's war history records "5-inch mount no. 9 accidentally fired into mount no. 5"). The 40mm quads carry the numbers 41 to 52 as we have them, and the 20mm numbers are our own. The Oerlikons are fast and light, with 60-round drums (`R` to change drums); Alabama never carried the forecastle 40mms planned for her, they were too wet. `1`-`9`, `Q` and `E` also change mounts.

### Day

Six raids escalate through the afternoon into golden hour: dive bombers, a torpedo attack, a coordinated strike from two sides, the special attack unit (kamikazes), land-based Bettys, then everything at once. Dive bombers push over from about 2 km and release around 450 m. Torpedo planes drop to wave-top height on a ship's beam, drop about a kilometre out, then break away or roar across the formation; torpedo tracks show as white wakes and ships turn to comb them. Zeros make strafing runs and pull up over the deck. Kamikazes weave in and keep coming even when they are on fire. Bombs and kamikazes start fires; damage control parties restore some hull integrity between raids. Lose your own ship or the carrier and the battle is over. Survive all six for the after-action report, then keep fighting in an endless mode if you like.

### Night

The Japanese turned to dusk and night torpedo attacks in 1943 because the US fighters and AA had made daylight attacks too costly; by the Navy's own wartime summary, "Bettys, their targets frequently exposed under brilliant flares, attacked with considerable effectiveness." The night battle follows the pattern of the attacks on the fast carriers in 1943 and 1944. A snooper shadows the force at dusk and drops a line of float lights on the water to mark its track. Flare planes then hang parachute flares beyond the ships, so the torpedo planes see them in silhouette; the torpedo planes (Bettys, with Kates standing in for the newer Jills) come in low, most from one side and a few from another, with a few bombers gliding in by flare light. There is no fighter escort and nobody strafes. The first attack comes out of the darkening east while the afterglow still silhouettes the ships to the west; the rest come after dark under a waxing crescent moon setting in the west, the moon Alabama's task group had on the night of 29 March 1944, when a night attack off Palau came at the ships near her and she shot one plane down on her own.

The ships are darkened. Radar calls the raids as bogeys (nobody can see what type they are); the radar-directed 5" fire with VT fuzes as by day, but the 40mm and 20mm directors were optical (blind-firing light AA directors only reached the fleet in 1945), so the fleet's gunnery is worse (the 40mm and 20mm hold fire at aircraft beyond about 1.2 km unless a flare lights them up or they are already burning), and so is the attackers' aim (the T Attack Force's first big night strike off Formosa in October 1944 hit nothing). You find the aircraft by their exhaust flames, by flare light, and by the tracers going up at them. Parachute flares light the ships, the sea and the cloud bases, and burn for a couple of minutes while they drift down; the sea's wakes glow faintly. Your eyes adapt: the exposure follows the scene, and the darks lose their colour toward blue as night vision does. Survive all six for the after-action report.

Sources: COMINCH, *Antiaircraft Action Summary, World War II* (October 1945); USS North Carolina's report of the night air action of 25 November 1943 (float lights, flares "silhouetted the force from a sector astern"); *Intelligence Bulletin*, December 1943, "Notes on Air Tactics Used by Japanese"; DANFS for Alabama (BB-60), Lexington (CV-16) and Canberra (CA-70). Not confirmed, and so game values: the Japanese flares' burn time, brightness and drop height, and how far away a gunner could see an exhaust flame.

| Key | Action |
|---|---|
| Mouse | train and elevate the gun |
| Left button | fire |
| Right button | zoom the sight |
| hold `Ctrl` | the ship's plan: click a mount to man it |
| `1`-`9`, `Q` / `E` | change mount |
| `R` | change drums (20mm) |
| `X` | centre view or the pointer's sight |
| `C` | watch the battle from the cinematic camera (and back) |
| `P` | photo mode (freezes time, free camera, depth of field) |
| `K` | capture a PNG screenshot (photo mode) |
| `V` | cycle weather: Clear, Cloudy, Rain, Storm |
| `M` | mute |
| `H` | hide all UI |
| `F3` | FPS, draw calls, triangles, aircraft, shells, particles |
| `Esc` | release the mouse (pauses the battle, settings panel) |

## Rendering

| Area | Technique |
|---|---|
| Ocean | Gerstner wave spectrum (a long swell plus a spread wind sea) evaluated identically on the GPU and the CPU, so ships ride the same waves you see. A radial grid that follows the camera out to 24 km with earth curvature, so distant hulls sink below the horizon. Per-pixel wave normals with footprint-based filtering that moves unresolved slope into roughness (no glint aliasing), rotated ripple layers, a physically based water material reflecting the live sky, light through thin wave crests, whitecaps, and turquoise lagoons around the islands |
| Wakes | A 5 km world-space foam map around the camera (ping-pong render targets, max-blended stamps, diffusion and decay) that ships, torpedoes, splashes and crashes write into: turbulent stern wakes, aerated turquoise water, torpedo tracks. Bow waves, hull churn and Kelvin wake arms are computed per ship in the ocean shader |
| Ships | Procedural South Dakota class battleships built to their mid-1944 fit: USS Alabama (ten twin 5"/38s, twelve quad Bofors, Measure 21 overall Navy Blue with blue-stained decks), USS South Dakota with her flagship conning tower and eight 5" mounts, and USS Indiana in Measure 32 dazzle; an Essex class carrier with Hellcats spotted on deck, Cleveland class cruisers and Fletcher class destroyers: lofted hulls with sheer and flare, superstructures, main battery turrets, directors, radars, railings, teak and steel decks, Measure 21/22 paint and Measure 32 dazzle camouflage, weathering and rust. Ships keep formation stations, zig-zag, heel in turns, pitch, roll and heave on the waves, list after torpedo hits, burn and sink |
| Guns | Every 5"/38, 40mm and 20mm mount in the fleet is instanced, crewed by posed sailors and individually aimed, firing at real rates: about 18 rounds a minute per 5"/38 gun, 120 per Bofors barrel, 450 per Oerlikon with drum changes. Your own quad Bofors and twin Oerlikon are detailed models with recoiling barrels, loader clips and drum magazines |
| Aircraft | Zero, Val, Kate, Betty and Hellcat built from parametric pieces, instanced per type with procedural liveries (hinomaru, IFF strips, US star-and-bar), spinning props and blur discs, scorch damage and hit flashes |
| Combat effects | Thousands of simulated shells with drag and gravity drawn as HDR tracers, proximity-fuzed 5" flak bursts that leave black puffs, lit and depth-sorted smoke (flak, burning aircraft trails, ship fires that tower downwind), water columns from bombs and shells, fireballs, sparks, debris and a fixed pool of point lights for blasts |
| Sky | Physical sky with a twilight afterglow, stars and a moon whose phase follows from where the sun is, trade-wind cumulus built from lit, sorted billboard clusters, volcanic islands on the horizon, sun and moon light, IBL re-baked from the live sky, a time of day that slides toward evening (or into the night) across the battle |
| Night | Parachute flares as analytic point lights evaluated in every lit material's own BRDF and on the cloud bases (a fixed set of four, so nothing recompiles), with their glare and smoke trails; float lights on the water; radial exhaust flames; faint phosphorescence in the wakes; eye adaptation down to moonlight and a Purkinje shift in the grade |
| Post | Single scene pass with a shared depth buffer, GTAO, eye-adaptation auto exposure, bokeh depth of field (cinematic and photo), bloom, god rays, lens flare, ACES/AgX tone mapping, SMAA, color grades (Kodachrome, Newsreel and more), sharpening, vignette and grain |
| Performance | Quality presets (Low to Ultra) and dynamic resolution that holds ~60 FPS |

## Audio

Real recordings carry the sounds that matter most up close: the 5" fire (a US Navy cannon and Finnish 76mm shots), the flak bursts and explosions, the brass on the deck, the bow wave along the hull, and the real US Navy general alarm and "General quarters" call on the 1MC. A period automatic-gun recording and a .50 cal are laid over the synthesized 40mm and 20mm, whose deep "pom" stays procedural; no free recording of a real Bofors or Oerlikon exists. They are free recordings from Freesound (CC0, and one CC BY) and the US Navy (public domain); sources, authors and licenses are in [public/audio/CREDITS.md](public/audio/CREDITS.md). The rest is synthesized with WebAudio at runtime: your gun's thump and auto-loader clatter with brass casings on the deck, positional 5", 40mm and 20mm fire across the fleet delayed by the speed of sound, flak cracks and distant crumps, radial engines with Doppler for the nearest aircraft and a drone for the rest of the raid, falling bomb whistles, explosions, water columns, torpedo hits, bullet strikes on steel, ringing ears after a near miss, the general quarters gong and radio squelch, ocean, wind and machinery ambience, and a generative score that builds with the fighting.

## Layout

```
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
  models/
    ships.js       procedural ship builder (bb, cv, cl, dd)
    aircraft.js    procedural aircraft, liveries, bombs and torpedoes
    guns.js        instanced AI mounts and the detailed player guns
    interior.js    the GQ route through the ship: berthing, passageways, doors, hatches, ladders
    runners.js     the running crew: instanced, articulated sailors that run, climb and duck
```
