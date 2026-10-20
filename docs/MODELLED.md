# What's modelled

Back to the [README](../README.md).

Nearly everything is generated in code at load: the ocean, the ships, the aircraft, the guns, the textures, the music and most of the sound. The only asset files are a handful of real sound recordings.

## Rendering

### Ocean

- **One wave set, two places.** A Gerstner wave spectrum (a long swell plus a spread wind sea) is evaluated identically on the GPU and the CPU, so ships ride the same waves you see.
- **To the horizon.** A radial grid follows the camera out to 24 km with earth curvature, so distant hulls sink below the horizon.
- **No glint shimmer.** Per-pixel wave normals with footprint-based filtering move unresolved slope into roughness, over rotated ripple layers.
- **The water.** A physically based material reflects the live sky, with light through thin wave crests, whitecaps, and turquoise lagoons around the islands.

### Wakes

- **The foam map.** A 5 km world-space foam map around the camera (ping-pong render targets, max-blended stamps, diffusion and decay) takes stamps from ships, torpedoes, splashes and crashes: turbulent stern wakes, aerated turquoise water, torpedo tracks.
- **Per ship.** Bow waves, hull churn and Kelvin wake arms are computed per ship in the ocean shader.

### Ships

- **The battleships.** Procedural South Dakota class battleships built to their mid-1944 fit: USS Alabama (ten twin 5"/38s, twelve quad Bofors, Measure 21 overall Navy Blue with blue-stained decks), USS South Dakota with her flagship conning tower and eight 5" mounts, and USS Indiana in Measure 32 dazzle.
- **The rest of the group.** An Essex class carrier with Hellcats spotted on deck, Cleveland class cruisers and Fletcher class destroyers.
- **Detail.** Lofted hulls with sheer and flare, superstructures, main battery turrets, directors, radars, railings, teak and steel decks, Measure 21/22 paint and Measure 32 dazzle camouflage, weathering and rust.
- **Motion.** Ships keep formation stations, zig-zag, heel in turns, pitch, roll and heave on the waves, list after torpedo hits, burn and sink.

### Guns

- **The whole fleet.** Every 5"/38, 40mm and 20mm mount is instanced, crewed by posed sailors and individually aimed, firing at real rates: about 18 rounds a minute per 5"/38 gun, 120 per Bofors barrel, 450 per Oerlikon with drum changes.
- **Your gun.** The mount you man is swapped for a detailed model: the Mk 28 twin 5"/38 gunhouse with its roof hatch, telescope windows and recoiling barrels; the Mk 2 quad Bofors, whose feed runs every round, clip, star wheel and spent case as a live object; and the single Oerlikon with its shield, 60-round drum and ring sight.

### Everything else

- **Interior.** The General Quarters route through the ship: berthing, passageways, watertight doors, hatches and inclined ladders, with instanced, articulated sailors that run, climb and duck.
- **Aircraft.** Zero, Val, Kate, Betty and Hellcat built from parametric pieces, instanced per type with procedural liveries (hinomaru, IFF strips, US star-and-bar), spinning props and blur discs, scorch damage and hit flashes.
- **Combat effects.** Thousands of simulated shells drawn as HDR tracers, proximity-fuzed 5" flak bursts that leave black puffs, lit and depth-sorted smoke (flak, burning aircraft trails, ship fires that tower downwind), water columns, fireballs, sparks, debris and a fixed pool of point lights for blasts.
- **Sky.** A physical sky with a twilight afterglow, stars and a moon whose phase follows from where the sun is; trade-wind cumulus built from lit, sorted billboard clusters; volcanic islands on the horizon; IBL re-baked from the live sky; a time of day that slides toward evening (or into the night) across the battle.
- **Night.** Parachute flares are analytic point lights evaluated in every lit material's own BRDF and on the cloud bases (a fixed set of four, so nothing recompiles), with their glare and smoke trails. Also float lights on the water, radial exhaust flames, faint phosphorescence in the wakes, eye adaptation down to moonlight and a Purkinje shift in the grade.
- **Post.** A single scene pass with a shared depth buffer, GTAO, eye-adaptation auto exposure, bokeh depth of field (cinematic and photo), bloom, god rays, lens flare, ACES/AgX tone mapping, SMAA, color grades (Kodachrome, Newsreel and more), sharpening, vignette and grain.
- **Performance.** Quality presets (Low to Ultra) and dynamic resolution that holds ~60 FPS.

## Simulation

- **Shells** fly with gravity and quadratic air drag. Friendly rounds are tested against every aircraft along their path; the 5" burst on proximity (VT) or on their timed fuze; Japanese machine-gun rounds are tested against the ships.
- **The lead computing sight** solves the lead exactly, by flying a shell through the game's own ballistics and correcting the aim by the miss.
- **Ships** keep station on a guide that zig-zags, turn to comb torpedo tracks, and ride the waves through damped springs. Bombs, torpedoes, kamikazes and strafing are tested against each hull's profile and the boxes of its superstructure.
- **AI gunners.** Every AI gun in the fleet picks a target, leads it and fires at its real rate with a slowly wandering aim error. A gun holds fire when its line of fire crosses its own ship's superstructure or a friendly ship. The light guns prefer aircraft fewer guns are on; the 5" are limited to eight mounts per aircraft.
- **Aircraft** fly in formation until the group breaks, then each runs its role: dive bombing, torpedo runs, strafing, kamikaze dives, and by night the flare and float-light drops. Flight is kinematic, with limited turn rates and bank from the turn.
- **Kill credit.** A kill is yours when you fire the killing blow or do at least 40% of the damage; otherwise it counts as an assist.

## Sound

- **Real recordings** carry the sounds that matter most up close: the 5" fire (a US Navy cannon and Finnish 76mm shots), the flak bursts and explosions, the brass on the deck, the bow wave along the hull, and the real US Navy general alarm and "General quarters" call on the 1MC.
- **The light guns.** A period automatic-gun recording and a .50 cal are laid over the synthesized 40mm and 20mm, whose deep "pom" stays procedural; no free recording of a real Bofors or Oerlikon exists.
- **Your gun.** Its thump and auto-loader clatter, with brass casings on the deck.
- **The fleet.** Positional 5", 40mm and 20mm fire across the fleet, delayed by the speed of sound; flak cracks and distant crumps.
- **The aircraft.** Radial engines with Doppler for the nearest aircraft and a drone for the rest of the raid; falling bomb whistles.
- **Hits.** Explosions, water columns, torpedo hits, bullet strikes on steel, ringing ears after a near miss.
- **The ship.** Alabama's whistle (one short blast, one long) as each raid opens, the general quarters gong and radio squelch, ocean, wind and machinery ambience.
- **Music.** A generative score that builds with the fighting.

Everything but the recordings is synthesized with WebAudio at runtime.
