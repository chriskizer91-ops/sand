# Decisions log

Newest at the bottom. Each entry says what we decided and why.

## 1. Built from Sandcastle Cays, in its own folder
- **What:** a new game in `wind-wing-wave/`. It keeps the Sandcastle Cays foundations:
  - the engine on a background thread with a page fallback;
  - the message protocol style;
  - save and load with compression, and undo by copy-on-first-write blocks;
  - autosave plus file backup;
  - the one-file esbuild build;
  - the checks run both by vitest and by the in-game checks page;
  - the Playwright browser checks;
  - the WebAudio synthesis core and the code-drawn SVG icons;
  - the water and sky style, and the palm and bush models made in code.
- **Why:** the owner asked to reuse the sandcastle engine system.

## 2. The ground is a grid of stacked columns, not tiny 3D cells (no caves or arches)
- **What:** each 2 m column stores rock height, sand thickness, molten lava thickness and temperature, and the kinds of sand and rock. The sandcastle 3D cell grid and its cell-by-cell physics are not used.
- **Why:**
  - Measured on the sandcastle engine scaled up, a 20 m pour took 57 seconds (2 m cells) to 8 minutes (1 m cells) to settle.
  - Drawing the whole zone at 1 m cells is about 2.6 million triangles, far beyond a phone.
  - Columns make lava, sand and the life simulation simple 2D rules that run in a few milliseconds.
- **Cost:** no caves, arches or overhangs. Cliffs, sea stacks and headlands work. Cave-dwelling species were left out of the catalogue.
- **Told to the owner** before building.

## 3. Terrain is drawn by the graphics chip from a height map
- **What:**
  - The worker sends height and ground rows, not meshes.
  - The page draws the land with one shared grid patch, raised by the graphics chip from the height map.
  - The grid has more detail near the camera and less far away (CDLOD, with smooth blending between levels).
- **Why:**
  - It makes no meshing work in the worker.
  - It sends tiny messages (lava updates are a few kilobytes).
  - The triangle count stays fixed whatever you build.
  - It needs one draw call.
- **Cost:** a cliff is a very steep 2 m ramp rather than a perfectly vertical face. From normal viewing distances it reads as a cliff.

## 4. Scale
- Columns are 2 m.
- The zone is 1024 m square.
- The seabed is at −30 m, and you can build up to 180 m.
- The life grid uses 4 m patches (256 × 256).
- The trade wind blows from the east, where the "old islands", the source of most life, sit on the horizon.

## 5. Two clocks
- About 2 years pass per real second by default (settings 1 / 2 / 5).
- Lava, sand, waves, animals and the sky run in real time.
- The sky has its own calm 16-minute day and a 2-day wet/dry season cycle. Storms come only in the wet season.
- Years appear only in the journal and on the journal-slip arrival cards.
- Everything pauses while the game is hidden or the journal is open.
- **Why:** this is the owner's "years a second" and "life moving at a normal slow pace". A literal day/night at years-per-second speed would strobe.

## 6. Ecology is a fixed-step simulation with exact maths
- One-year steps.
- Float32 live state.
- Exact logistic growth.
- Probabilities computed as `1 − e^(−λ·dt)`.
- **Why:** byte-sized state stops changing at small time steps, and simple step-by-step growth overshoots at large ones. Fixed steps also make the same seed plus the same edits give the same history.

## 7. Pacing is a contract in real minutes
The beat sheet in ARCHITECTURE §4, plus five feedback guarantees:
- places are recognised at once;
- visitors return soon after their need is met;
- Look explains anything;
- first visits always tell why;
- no species stays stuck once its needs are met.

**Why:** the biggest risk in this kind of game is that the player can't see their building making a difference.

## 8. Tools
- **The set:** Lava, Rock, Sand, Hands (smooth) and Scoop, plus Look.
- **Unlimited material:** this is a god game, so there is no hand meter.
- **Rock** is "pour or place": boulders tumble from code-made hands and lock where they land.
- **Lava** is the fast way to raise land. It burns what it covers, and old lava makes the richest soil.
- **Small smoothing never resets life.** Only changes larger than about 0.5 m, or a change of material, do.
- **Undo** restores the life a stroke buried.

## 9. Gestures are map-style
- Two-finger drag pans, pinch zooms, twist rotates, and the tilt follows the zoom.
- **Why:** in a 1 km world, moving around is the most common need, and every phone user knows map gestures.
- This differs from Sandcastle Cays, where two-finger drag swings the camera. The owner is told in one line.

## 10. The whole zone is open from the start
- No mist or locks.
- The reasons to build more islands are life's own: stepping stones, seabird islets, lagoons, area, and the Sound.

## 11. Species
- About 90 real species, stored as data.
- **Every species has something you can see or hear:**
  - a plant model;
  - a ground tint;
  - an animal;
  - a sound;
  - or a water effect.

  Species that would only be a name in a list were cut.

## 12. Performance targets and guards
These are as in ARCHITECTURE §7:
- 45 fps target on the Pixel (its 90 Hz screen) and 30 fps in watch mode;
- dynamic resolution;
- shaders precompiled at load;
- shadows never toggled at runtime.

Real Pixel speed can't be measured here, so the in-game checks page reports it on the owner's phone.
