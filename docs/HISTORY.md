# History and sources

Back to the [README](../README.md).

**The short version:** the ship, the guns, their drives, rates of fire, ammunition and feed follow the period manuals and records, and the attacks follow wartime reports. Damage, accuracy and balance are game values.

## The ship

- **As of June 1944.** Alabama is built as she was then: Measure 21, ten twin 5"/38, twelve quad 40mm and single 20mm only.
- **No forecastle 40mms.** She never carried the ones planned for her; they were too wet.
- **Sources.** Each battleship's sources are listed in `BB_VARIANTS` in `src/models/ships.js`.

## The guns

- **Bofors.** The feed, loading and drives follow OP 820, TM 9-252 and OD 4391, with NavWeaps for speeds and rates.
- **5"/38.** It follows NavWeaps and *Naval Ordnance and Gunnery* (NAVPERS 10797-A). No source gives the 5" drives' acceleration, so their braking is estimated from the Bofors mount's.
- **Tracers.** Every 40mm round the Navy fired in 1944 carried a tracer.
- **Mount numbers.** The 5" numbers 1 to 10 are from Alabama's war history, which records "5-inch mount no. 9 accidentally fired into mount no. 5". The 40mm numbers 41 to 52 are as we have them, and the 20mm numbers are our own.

## General Quarters

- **A reconstruction.** The compartments are our own. Their markings follow the Navy's pre-1949 compartment numbering, but we could not find Alabama's actual compartment numbers or plans, so the layout is ours.
- **Sources** are in `src/models/interior.js`.

## The night battle

- **Why night.** The Japanese turned to dusk and night torpedo attacks in 1943 because US fighters and AA had made daylight attacks too costly. By the Navy's own wartime summary, "Bettys, their targets frequently exposed under brilliant flares, attacked with considerable effectiveness."
- **The moon** is the one Alabama's task group had on the night of 29 March 1944, when a night attack off Palau came at the ships near her and she shot one plane down on her own.
- **Optical light AA.** Blind-firing light AA directors only reached the fleet in 1945.
- **Poor Japanese aim.** The T Attack Force's first big night strike, off Formosa in October 1944, hit nothing.
- **Sources.** COMINCH, *Antiaircraft Action Summary, World War II* (October 1945); USS North Carolina's report of the night air action of 25 November 1943 (float lights, flares "silhouetted the force from a sector astern"); *Intelligence Bulletin*, December 1943, "Notes on Air Tactics Used by Japanese"; DANFS for Alabama (BB-60), Lexington (CV-16) and Canberra (CA-70).

## Game values

- **Not confirmed by any source we found:** the Japanese flares' burn time, brightness and drop height, and how far away a gunner could see an exhaust flame.
- **Tuned so the player matters:** damage, hit points and the AI's accuracy. The fleet should not kill most of a raid before it attacks.
