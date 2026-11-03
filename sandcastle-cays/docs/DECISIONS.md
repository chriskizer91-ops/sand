# Decisions log

Newest at the bottom. Each entry: what we decided, and why.

## 1. Sand is a grid of small cells drawn as a smooth surface ("smooth voxels")
- **What:** the beach is a 3D grid of cells, 3 cm across. Each cell stores three numbers from 0 to 255: `fill` (how much sand), `wet` (moisture) and `pack` (how compacted). The surface is drawn with "surface nets", a method that puts one smooth vertex inside each cell the surface passes through, so no cubes are ever visible.
- **Why:** particles can't hold shapes or scale to a castle on a phone; cubes feel like Lego; a height-map can't do tunnels, arches or overhangs. Cells can do all of these and still run on a phone.
- **Cost:** detail under a few centimetres comes out soft and rounded.

## 2. Sand physics rules (engine/sim.ts, engine/material.ts)
- `cohesion` comes from `wet` and `pack`. Dry sand has none; damp sand has some; packed damp sand has the most; soaked sand loses it again. Packed sand keeps a little strength when it dries.
- **Slumping:** sand slides to a lower neighbour if the slope is steeper than the sand can hold. That's about 33° when dry, steeper when damp, and packed damp sand doesn't slide at all.
- **Overhangs:** cohesive sand can hang sideways off supported sand for a few cells (`span`, up to 8 cells = 24 cm when packed and damp). That's what makes tunnels and arches hold. Anything unsupported breaks off and falls as crumbs.
- **Falling sand:** falling sand becomes particles that land and turn back into cells.
- **Conservation:** sand is never created or destroyed. The total of cells, hands and falling particles is constant, and a check enforces it.
- **Drying:** exposed surfaces dry slowly in the sun. Sand below sea level is soaked, and sand just above the water stays damp from below.

## 3. Only edited parts of the beach are stored ("sparse chunks")
- **What:** the world is cut into chunks of 16×16×16 cells. Untouched chunks are computed from the beach-shape formula when needed, and are only stored once something changes them.
- **Why:** memory grows with how much you build, not with how big the beach is, so whole-beach building and dunes are possible.
- **Note:** the beach-shape formula is versioned (`GENERATOR_VERSION`). Changing the formula changes unedited ground in old saves.

## 4. The sand engine runs on a background thread (Web Worker), with a fallback
- The engine has no browser-page code, so it can run in a worker or on the main thread.
- The single HTML file carries the worker's code as text. If the browser refuses to start a worker (possible when a file is opened straight from a phone's downloads), the game runs the engine on the main thread instead.

## 5. Delivered as one HTML file
- The owner tests by opening a single `.html` file. Everything (code, styles, sounds, models) is inside it, with no internet needed.
- Bundled with esbuild (`build.mjs`). Each release is copied into `builds/`.

## 6. Saving
- Autosave to the browser's storage (IndexedDB, falling back to localStorage) every minute and when the game is hidden.
- "Save to file" / "Load from file" always works as a backup.
- Save format (`engine/save.ts`): a small header, then every changed chunk's raw arrays, compressed with deflate.

## 7. Controls
- Touch: one finger uses the tool. Two fingers drag to orbit, pinch to zoom, and a quick two-finger tap glides the camera to that spot.
  - A stroke only starts after the finger moves a little or ~90 ms passes. If a second finger lands after it started, the stroke is undone, so camera moves never leave marks.
- Trackpad / mouse: click to use the tool; two-finger swipe orbits; pinch (or a mouse wheel) zooms toward the pointer.
  - Right-drag also orbits; a right-click without dragging glides the camera there.
  - Keys: WASD/arrows pan, Q/E rotate, 1-3 tools, Ctrl+Z undo.
- Double-tap was not used for "go there", because tapping twice quickly is a natural way to pat sand.

## 8. Undo
Each stroke opens an undo record. The first time a chunk is changed during that record (by the tool or by sand sliding afterwards), a copy is saved. Undo restores those copies and what was in your hands. Drying doesn't make copies, to save memory.

---

## Decisions from 2026-11-01: from a sandcastle game to sailboat living

## 9. Sandcastle building becomes one part of a sailboat-living game
- **What:** the game is now about living aboard a small sailboat: beachcombing, sandcastles, boat upkeep, rations, gardening and sailing. Sandcastle building stays a main activity, reached by kneeling on a beach.
- **Source material:** the owner's raft survival game (shared as a zip in this session). Its water, sky, gathering, tools, upkeep, planters and shark are the starting point, made peaceful. Code taken from it is marked "from the raft game" in comments.
- **Also useful:** Wind, Wing & Wave (branch `claude/jolly-pascal-d3lqs6`) has plants, birds, turtles, storms and a field-guide journal made in code.

## 10. First person, on both the phone and the laptop
- **What:** you see through your own eyes, like the raft game.
  - Laptop: W A S D to move, the mouse or trackpad to look (the pointer is captured after a click; Esc lets it go), E or a click to use, Space to jump or climb.
  - Phone: the left thumb moves (a stick appears where it lands), the right thumb drags to look, a tap uses what you're looking at, and buttons show for jump and actions.
- **Building is the exception:** kneeling to build switches to the sandcastle camera (swing, zoom), because castles need to be seen from all sides.
- **Why:** the owner prefers it. Showing a character on screen would not make it cheaper to draw. The camera is simpler, and the water looks best from eye level.

## 11. Rations: something to manage, not a hunger meter
- **What:** food and water are stores measured in days. Full stores last about a month of game days, so you never feel hungry minute to minute. Running low is the worst that can happen. Fishing, island fruit and rain top the stores up. It should not be trivially easy.
- **Not decided yet:** what happens at zero. The leaning is that your sailor tires (slower, shorter trips) and nothing worse. To settle in v0.4.

## 12. The shark is occasional and never deadly
- **What:** it is only around sometimes, and only in certain waters (reef edges, channels). It can make you drop your basket of finds (they wash up later) or bump the dinghy so it needs repair. Bait lures it away. It never kills you.

## 13. The look: realistic water and light, slightly storybook everything else
- **What:** the sea, sky and light follow the raft game (see-through water, reflections, sun glints, foam, tone mapping, bloom). The boat, sailor, finds and plants are simple, rounded and warm. They should feel like one world, not two styles side by side.

## 14. Code may paint textures
- **What:** textures such as wood grain, rope, woven baskets and water ripples may be painted pixel by pixel by code when the game starts, as the raft game does. There are still no picture, texture or sound files in the repo.
- **Why:** the owner agreed (2026-11-01). The rule against images was about files, not about code-made detail.

## 15. A finished vertical slice before anything else
- **What:** build Home Cay (boat, island, beachcombing, sandcastles, dinghy, shark, rations, upkeep, garden, one passage) to finished quality, in parts v0.2–v0.6, each played by the owner. More islands and features come after.
- **Why:** the owner wants a well-built game. Finishing a small piece shows what "finished" means before the game grows.

---

## Decisions from building v0.2 (technical; each is easy to change)

## 16. The sea, sky and frame drawing come from the raft game
- **What:** the water, sky, day/night light and frame pipeline are TypeScript ports of the raft game (`render/ocean.ts`, `sky.ts`, `daylight.ts`, `pipeline.ts`).
  - Each frame first draws a small picture of everything except the water, so the water can show what's beneath it.
  - The waves are one sum of sines, shared by the screen and by anything that floats.
  - Filmic tone mapping and a soft glow (bloom).
- **Changed for the islands:**
  - The swell is scaled by the depth of the sea floor: nothing over the beach (so holes dug in the cove hold still water), gentle in the lagoon, full beyond the reef.
  - The water colours are Caribbean turquoise.
  - The sand's own under-water darkening was reduced, so it isn't darkened twice.
- **Quality levels:** Pretty, Balanced (laptop default), Phone (phone default: sharper than "Fast" and with shadows, but no glow), and Fast.
  - "Auto" steps down by itself when the frame rate stays under 40: glow off, then lower sharpness, then shadows off.

## 17. Home Cay wraps around the old cove exactly
- **What:** `world/homeCay.ts` is an island of about 125 × 62 m, with a fringing reef about 95 m off the coast and a channel to the south-west. Inside the cove's editable sand (and 1 m around it), the ground is the old lagoon formula, unchanged.
- **Why:** the sand engine and v0.1 saves keep working, and the generator version stays 1.
- **Drawing:** the island's ground is meshed in 16 m squares.
  - Spacing is 0.8 m where you walk, 0.25 m around the cove's edge, 2–2.7 m in the lagoon and 8 m in the deep.
  - Short skirts hide cracks between different levels of detail.
  - Squares that are all dry land are skipped in the under-water picture.

## 18. Far-away untouched cove sand is drawn by a stand-in
- **What:** more than 22 m from you, any 1.9 m tile of the cove that you haven't changed (no spot differs from the untouched beach by more than 4.5 cm) is hidden. A simple copy of the untouched beach shows in its place.
- **Why:** the full-detail sand is about 440,000 triangles, which is too many to draw from the boat on a phone. Anything you have built always shows.
- **Known cost:** from the boat, a hole or moat dug in a tile you've built on looks filled in.

## 19. One save holds everything
- **What:** the clock, where you are, and every find (on the sand, in your basket, in the locker, in the logbook) are stored in the save file's header, next to the sand. It is still one file.
- **Old v0.1 saves:** they load with the sand as it was. You start aboard on the morning of day 1.

## 20. The day, and the finds
- **The day:** about 24 real minutes. Daylight runs 6 am–8 pm and nights pass about twice as fast.
- **Wash-ups:** new finds wash up along the high-tide line at 5:30 each morning, 11–15 of them. At most 48 lie about; the tide takes the oldest back.
- **Your basket:** holds 12.
- **Small finds are drawn larger than life:** under 5 cm at 1.6×, under 10 cm at 1.35×, so you can spot them from standing height.

## 21. The boat
- **What:** an 8.4 m sloop (`render/sloop.ts`) with a walkable-deck description:
  - cockpit sole 0.40 m and side decks 0.80 m above the water;
  - the cabin top is a step up;
  - lifelines keep you aboard unless you jump;
  - the gap at the starboard stern leads to the swim ladder.
- **Rocking:** your view moves with the boat. It leans with 60% of the boat's roll, so it feels like a boat without being queasy.
- **At anchor:** 31 m off the cove, bow to the east wind, in about 3 m of water. It swings gently on its anchor.

## 22. Sailing comes next (v0.3), before upkeep and the dinghy
- **What:** the owner moved sailing up: v0.3 is sailing and a second cay, v0.4 repairs and living aboard, v0.5 the dinghy and the shark.
- **Why:** sailing is the heart of the game. Scrapes from sailing (on the reef or a beach) give the repairs in v0.4 a reason.
- **Source:** the feel comes from the owner's airship game: speed and steering that ease in, turning that needs speed, heel, gusts, the compass and wind display, a chart you tap to set a course, and anchoring as the "land here" step. Real-sailboat rules are added on top (see `design-notes/sailing-from-the-airship-game.md`).

## 23. How sailing works (v0.3; numbers in `src/game/sailing.ts`)
- **Speed:**
  - top speed 3.4 m/s (about 6.6 knots) on a beam reach with full sail in the usual 6.5 m/s trade wind;
  - speed builds at rate 0.3 and fades at 0.45 per second; it fades slower while luffing, so she carries way through a tack.
- **Points of sail:** no drive within 38° of the wind; close-hauled from 50°; best at about 95°; a little less running downwind.
- **Turning:** up to 0.36 rad/s at speed, about a third of that when stopped, so you can always bear away out of irons.
- **The wind:** it blows from the east, shifts up to about ±14°, and gusts up to 28%. It's a smooth function of time, so it's the same after loading and in the checks.
- **Running aground:** the keel draws 1.45 m (less at the bow and stern). Touching bottom stops her. A real knock (over 0.5 m/s) scrapes the hull once; scrapes are at least 4 s apart.
- **Unattended:** with sails up and nobody steering, she rounds up into the wind and stops, as a real sloop does.
- **The autopilot ("Sail to …"):** follows waypoints through the reef gap, beats upwind at 52° off the wind, tacks when the other tack is 25° better, then heads into the wind, lowers sail and anchors. The checks confirm the passage legs are deep enough all the way.
- **The world:** Home Cay owns the open sea floor. Pink Sand Cay sits on its own shelf at (−210, −300), fading into that floor at the edge of its area. Its anchorage is on the sheltered north-west side.
- **Controls at the helm:** you stay at the tiller and look around freely; the walking keys and stick become steering and sails.

## 24. A small outboard motor (v0.3.1; numbers in `src/game/sailing.ts`)
- **What:** a tiny outboard (about 3.5 hp) on the stern, for getting in and out of tight spots when the wind is wrong. The owner asked for it after trying v0.3.
- **How fast:** about 2.3 m/s (4.5 knots) flat out ahead, about 1 m/s astern. It eases in and out over about half a second. With the sails drawing as well it adds less, and the two together never beat the boat's top speed by more than a little.
- **Steps:** full astern, slow astern, off, slow ahead, half ahead, full ahead (R for faster, F for slower, or the two "Motor" buttons).
- **Steering:** the motor pushes water past the rudder, so you can steer at low speed and even when stopped. Going astern, the steering reverses, as on a real boat.
- **Anchor:** starting the motor raises the anchor for you. Dropping the anchor stops the motor. Letting go of the helm stops the motor too, unless she is sailing herself somewhere.
- **The autopilot uses it:** to motor the last stretch into an anchorage, to motor a short way straight upwind instead of tacking, and to get out of irons.
- **The model:** it tilts down into the water when running and tilts up out of the water when stopped. Its propeller spins and the cowl shakes a little.
- **Navigation lights** came with it. At anchor the masthead light is on; under way the red and green sidelights and the white sternlight are on. They glow at night and are plain coloured lenses by day.
- **Not yet:** fuel. It could join the rations in v0.4 as one more thing to manage.

## 25. Blue water comes next (v0.4), before upkeep
- **What:** the owner asked for a stronger motor, sailing that is always much faster than motoring, and something that makes sailing more exciting, "either a button, or if you sail into a certain area". v0.4 is now "Blue water". Upkeep moves to v0.5, the dinghy to v0.6 and polish to v0.7.
- **Chosen:** an area, not a button. Sailing out past the reefs takes you onto the open sea, with more wind and bigger waves. Squalls drift across it, and you can choose to sail into one. That way the excitement is part of the world, and a sheltered sail is always there when you want a calm one. A button can still be added if the owner wants a quick way in.

## 26. How the open sea and squalls work (numbers in `src/game/weather.ts`)
- **Where:** the water is sheltered within about 60 m beyond each cay's reef. Further out it becomes open sea, fully open about 380 m beyond the reef. Between the two cays it stays sheltered.
- **Wind:** half as strong again on the open sea (about 19 knots instead of 13), with harder gusts.
- **Waves:** a long ocean swell rolls in from the east (wavelengths of 21–52 m, up to about 1.8 m from trough to crest). Whitecaps appear once the wind passes about 15 knots.
- **Squalls:** a new one forms about every 200 s far to the east. Each drifts west at 6 m/s, lives about 9 minutes, and has rain 120–240 m across. Under one, the wind gusts up to about 30 knots and blows out from its middle, so it shifts as you pass through. It rains, the light dims and the haze closes in. Inside the reef a squall's wind is less than half as strong. Squalls follow a fixed timetable, so loading a save brings back the same weather.
- **Where you can sail:** up to 1,050 m from the middle of the chart. The far islands drift part of the way with you, so you never quite reach them.

## 27. Faster sailing, a stronger motor, and handling a blow (numbers in `src/game/sailing.ts`)
- **Motor:** about 6 hp, up to about 5 knots ahead (2.5 astern), and most of that within 4 seconds.
- **Sails:** about 8.4 knots on a beam reach in the usual trade wind. That's quicker than a real boat this size, so sailing always beats the motor by a long way (the owner's wish). More wind adds a little more speed, less and less as it builds.
- **Heel:** grows faster than the wind does. Past about 24° she's **overpowered**: she slows, her steering weakens, and she turns herself up into the wind ("rounds up"). Steer off the wind or take in sail; half sail keeps her steady and faster in a squall.
- **Surfing:** on a broad reach or a run, going fast, a wave lifting her stern sends her down its face. That's worth up to about 5 extra knots, so 12–13 knots out on the open sea.
- **The autopilot** reefs to half sail when the wind passes about 16 knots.
- **The sea buoy:** a red-and-white "safe water" mark at (560, −820). From the reef gap it's a close-hauled sail out and a broad reach, surfing, home. The run is timed from raising the anchor at Home Cay to dropping it there again after rounding the buoy. The logbook keeps the count and your best time.

## 28. Never stuck aground; dev tools (v0.4.1)
- **Why:** the owner got stuck aground in v0.4. The old rule only let the boat move to a spot where she wasn't touching. If she was already in water shallower than her keel, every spot nearby touched too, so she couldn't move at all. Turning while touching, and swinging at anchor, could put her there.
- **The rule now:**
  - aground, she may move anywhere that is no shallower for her keel than where she is, at up to 0.5 m/s (dragging);
  - turning and swinging at anchor may not push the keel deeper into the bottom;
  - one scrape when she first hits, as before.
- **Push off:** the anchor button (X) becomes "Push off" while she's aground. It searches outward (up to 60 m) for the nearest spot with at least 35 cm to spare under the keel, heading away from the shallows, and eases her there over 2.5 s. A check confirms it finds deep water close by from shallow spots all round both cays.
- **Dev tools:** the owner asked for a dev tool window toggled with T. On the phone it's in the Menu. It doesn't pause the game, so you can watch numbers change while sailing. Its settings (wind strength, squalls off, game speed) aren't saved; they reset when the game is reloaded.

## 29. No rain sound (v0.5)
- **What:** the rain hiss is gone. The owner said made-up rain sounds like static, and recordings aren't allowed (everything is made in code). The strong-wind moan stays.

## 30. Living aboard (v0.5; numbers in `src/game/aboard.ts` and `src/game/fishing.ts`)
- **Order:** upkeep and living aboard comes first. The garden is v0.6, the dinghy and shark v0.7 and polish v0.8, so each part can be played sooner.
- **Stores:**
  - food and water are counted in days; you use one day of each per game day (about 24 real minutes);
  - the larder holds 30 days and the tank 20 (water jugs add 5 each, up to two sets);
  - a new game starts with 10 days of food and 8 of water, so topping up matters early;
  - warnings come at 3 days. When one runs out, you're slower and can't run. Nothing worse happens.
- **Food:**
  - fish, cooked in the galley: blue-striped grunt 0.3 days, yellowtail snapper and bar jack 0.5, mahi-mahi 1.5. A bonefish is let go;
  - fresh fish keeps 1.5 days in the cool box;
  - a coconut is 0.2 days of food and 0.3 of water.
- **Water:** rain fills the tank:
  - at anchor under the awning: about a day of water per minute of heavy rain, twice that with the bigger catcher;
  - under sail, off the mainsail: half that;
  - otherwise only a little off the deck.

  Squalls are the main source, so sailing to meet one and anchoring under it pays.
- **Fishing:**
  - cast from the deck (not at the helm, and slower than 1.5 m/s) or from the shore;
  - a bite comes in 8–30 s (a lure shortens it), and you have 1.3 s to strike;
  - reel by holding; when the fish runs the line tightens, so ease off before it snaps;
  - what bites depends on where the float lands: bonefish on the shallow flats, grunts, snappers and jacks in the lagoon, and mahi-mahi only out on the open sea.
- **Coconuts:** shake a palm and one or two fall; each palm has ripe ones again after two days.
- **Upkeep:**
  - below 60% the hull leaks into the bilge (it fills in 5 minutes at 0%);
  - a bilge more than 40% full slows her (by up to a quarter when full);
  - each pump stroke empties 5%;
  - the sails wear when she's badly overpowered or flogging in a strong wind, and worn sails drive her less (down to 55% when torn).
- **Workbench recipes** (each appears once you've found every material it needs; it uses finds from the locker):
  - caulk the seams: 2 driftwood + 1 pumice, hull +15%;
  - patch the hull: 1 plank + 1 rope, +35%;
  - patch the sails: 1 sailcloth + 1 rope, +40%;
  - bigger rain catcher: 2 sailcloth + 1 rope;
  - water jugs: 3 bottles + 1 rope;
  - feather lure: 1 feather + 1 fishing float;
  - fish trap: 1 net + 3 driftwood. At anchor overnight it catches one or two fish by morning.
- **New finds** for the recipes: a scrap of sailcloth, a piece of fishing net, an empty glass bottle.
- **No fuel** for the outboard yet: there's nowhere to get more on deserted cays.

