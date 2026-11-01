# Sailing: what we can take from the airship game

*Research note (2026-11-01). The owner asked us to look at their airship game (`chriskizer91-ops/airship-game-in-aethermoor-`, read only) for sailing and travel mechanics. Nothing has been copied yet; this is what's there and how it would fit a real sailboat.*

## Where it lives
- **Newest version:** branch `claude/laughing-fermat-ow3rfs`, folder `stage4/`.
- **Movement, wind and damage:** `src/game/flight.js` (about 150 lines, self-contained).
- **Controls:** `src/game/input.js`.
- **Camera, compass, wind display and minimap:** `src/game/main.js`.
- **Gusts and storms:** `src/game/sky.js`.
- **Sounds made in code:** `src/game/sound.js` and `src/audio/thareia/sounds.js`.
- **Wake:** `src/game/wakes.js`.
- **Travel between towns** only exists in an older prototype, `reference/the-magpie-over-aethermoor.html`. It has tap-to-sail on the map, a "Land at X" button, and gliding onto a dock at its fixed heading.

## How the airship sails
- **The sail is a 0–1 throttle.** W/S changes it over about 2 seconds.
- **Speed eases toward sail × top speed.** It speeds up gently and slows down a bit faster. Speed carries over (momentum), but there is no sideways drift.
- **Steering** eases in, like a heavy ship answering her wheel. A nearly stopped ship barely turns.
- **Heel:** the hull leans into turns, and a spring rolls her back upright after a gust.
- **Wind** only adds or takes away up to 14% of speed, depending on the angle. There's no no-go zone and no tacking.
- **Gusts** come every 5–11 seconds in storms.
- **Camera:** third person, a chase camera behind the ship.
- **Screen:** compass, wind arrow with words ("Wind behind: 8% faster"), and a minimap.
- **Damage:** torn sails cut speed and turning. "Patch the worst part, then wait 30 s" is the crew's repair.

## What carries over to Sandcastle Cays
- **The feel:** speed easing, steering easing, speed-dependent turning, the heel spring, gusts.
- **The screen:** compass and wind display, a chart with tap-to-sail for trips between islands, and region names when you arrive.
- **Arriving:** the docking flow, which becomes **"Anchor here"**: glide to a stop and swing bow-to-wind.
- **Sounds:** wind rising with speed, rigging whistle, creaks in turns, the wake.
- **Repair:** "patch the worst part, then wait", now using materials from the beach.

## What a real sailboat needs that the airship doesn't have
- **Points of sail:**
  - no push when pointing within about 45° of the wind (the no-go zone);
  - best on a beam reach (wind from the side);
  - good when broad-reaching, a bit less dead downwind.
  - To go upwind you zig-zag (tacking).
- **Sails** trim themselves by default; trimming by hand comes later as an option. You raise and lower the mainsail and unroll the jib.
- **Drift and heel:** the keel grips, so she slides sideways a little (leeway). She heels with the wind, not just in turns.
- **First person at the helm:** walk to the tiller and take the helm, and the controls switch to steering and sails. You can still look around. A higher "look over the boat" view may help on a phone.
- **Shallows and reef:** the keel touching bottom scrapes the hull, and that's what needs repair. The reef channel matters.
- **Anchor:** walk to the bow or use the helm button. "Weigh anchor" before sailing.
- **Leave out:** altitude, climbing and diving, and the Surge.
