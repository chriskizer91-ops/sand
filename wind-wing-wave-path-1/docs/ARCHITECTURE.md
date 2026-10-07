# Architecture (for builders and future Claude sessions)

This is the technical contract for **Wind, Wing & Wave**. The owner-facing summary is `PLAN.md`; the reasons are in `DECISIONS.md`.

Everything the game shows or plays is made in code: no image, texture, sprite or sound files. Runtime `DataTexture`s that hold **world data** (heights, ground, ecology cover) are maps of the simulation, not pictures, and are allowed. Do **not** precompute noise or pattern textures: shader noise is computed arithmetically with cheap sin-free hashes.

---

## 1. World

| Constant (`src/config.ts`) | Value | Notes |
|---|---|---|
| `CELL` | 2 m | One column is 2 m × 2 m |
| `NX`, `NZ` | 512, 512 | Columns; the zone is 1024 m square |
| `ORIGIN_X`, `ORIGIN_Z` | −512, −512 | World x/z of the corner of column (0,0) |
| `SEA_LEVEL` | 0 | Constant |
| `FLOOR_Y` | −30 m | Flat deep floor (with gentle noise) |
| `BUILD_MAX` | 180 m | Tool strength fades to 0 between 170 m and 180 m |
| `BUILD_MIN` | −30 m | Scoop stops here |
| `EDGE_FADE` | 40 m | Tool strength fades to 0 within this distance of the zone edge |
| `PATCH` | 2 | Columns per patch side. A patch is 4 m. |
| `NP` | 256 | Patches per side |
| Wind | from +x (east) toward −x | The trade wind. The "old islands" (source of life) are east, upwind, 8 km away. |

- **World axes:** x is east (+), z is south (+), y is up. Column `(i, k)` has centre `x = ORIGIN_X + (i + 0.5)·CELL`, `z = ORIGIN_Z + (k + 0.5)·CELL`. Patch `(pi, pk)` covers columns `2pi..2pi+1`, `2pk..2pk+1`.
- **Index:** `c = i + k·NX` for columns; `p = pi + pk·NP` for patches.

### 1.1 Starting seabed (`engine/geo/seabed.ts`, deterministic from `seed`)
- **Floor:** −30 m with ±1.5 m low-frequency noise. Use hash value noise, not a 256-period table.
- **Ridge:** a curved ridge running roughly north–south through the middle of the zone (so islands built on it have an east, windward, face and a west, lee, face). Crest about −7 m, falling to the floor about 120 m either side.
- **Knolls:** three to four knolls rising to about −2.5 m along the ridge. The one nearest the centre is the **glow**: the first-minute "Touch the glow" spot (`seabed.glow = {x, z}`).
- **The Shallows:** a broad sandy bank (−3 to −6 m, sand sediment 1–2 m deep) in the south-west quarter, for low cays and atolls.
- **Deeper water** in the north-east, so the windward side of the zone has a drop-off.
- The seed jitters positions by ±60 m. Everything below the ridge is **sand sediment over rock** (sediment 0.5–2 m), so scooping the seabed finds sand first.

---

## 2. The column grid (`engine/columns.ts`, lead-owned)

The world is **2.5D**: every 2 m column is a stack. **Bottom to top:**
1. **Rock:** rigid. Includes the seabed bedrock, cooled lava (basalt), placed rock, and reef limestone.
2. **Sediment:** loose sand.
3. **Lava:** molten, flowing, cooling. It sits on top.

| Array | Type | Meaning |
|---|---|---|
| `rock` | Float32 | Height of the rock top (m) |
| `sed` | Float32 | Sediment thickness on the rock (m), ≥ 0 |
| `lava` | Float32 | Molten lava thickness on top (m), ≥ 0 |
| `temp` | Float32 | Lava temperature, 0..1 (1 = fresh; freezes below `LAVA_FREEZE` = 0.3) |
| `sandKind` | Uint8 | 0 black (volcanic) … 128 golden … 255 coral-white; mixed by mass when sand moves |
| `rockKind` | Uint8 | `RockKind.Basalt` = 0, `Stone` = 1 (placed), `Limestone` = 2 (reef) |

**Derived:**
- `top(c) = rock + sed` (solid surface)
- `surf(c) = top + lava` (what you see)

**Changes.**
- Every write goes through `touch(c)`, which calls `beforeModify(block)` once per undo record for its 16 × 16 block.
- After a write, the writer calls `markChanged(i0, k0, i1, k1, flags)` with `ChangeFlag.Geom | Look | Burn`. The engine routes these to:
  - the `cols` stream (dirty rectangles sent to the page);
  - ecology (`onTerrainChanged`), where `Burn` means lava covered living ground.

**Page textures** (built from these arrays by `Columns.packGround`):
- `surf` → `R32F` 512² `heightTex`.
- `ground` → `RGBA8` 512² `groundTex`:
  - R = lava thickness ×20 (0.05 m units, saturates at 12.75 m)
  - G = lava temperature ×255
  - B = sediment thickness ×50 (0.02 m units, saturates at 5.1 m)
  - A = `(sandKind >> 2) << 2 | rockKind` (the top 6 bits are sand kind, the low 2 bits are rock kind)

There are **no caves, arches or overhangs** (see DECISIONS 2).

---

## 3. Two clocks

| Clock | Drives | Rate |
|---|---|---|
| Frame time | Rendering, waves, sway, animals, particles, audio | Real |
| Physics | Lava, sand sliding, tools | Real; fixed 1/30 s steps, at most 2 per tick, slows down under load (never skips) |
| Day | Sun, moon, sky, night animals, season mood | 16 real minutes per day: dawn 1.5, day 9, dusk 1.5, night 4 |
| Eco years | Soil, plants, arrivals, populations, coast, reef, storm schedule | `PACE_YPS`: gentle 1, **normal 2**, brisk 5 years per second |

- **Years start at 0** when the first land breaks the surface. Before that the year clock stays at 0.
- **Paused** whenever the page is hidden or the journal/menu is open (the page sends `{t:'pause'}`).
- **Storm peak** slows the year clock to 10%.
- **Season:**
  - A 2-day cycle (32 minutes): the **wet season** (day A) and the **dry season** (day B).
  - Storms happen only in the wet season: one per wet season, plus a 40% chance of a second.
  - The first storm waits until at least 15 minutes after first land **and** shrubs exist.
  - The ecology owns the storm schedule. The page owns the day clock and sends `dayPhase` and `season` with `focus` messages at 2 Hz, so the engine's storms line up with the sky.
- **Ecology steps** are fixed-size, `ECO_STEP_YEARS` = 1 year:
  - The whole active patch set advances one step per sweep. The work is spread over ticks within a time budget, but semantically it is one step.
  - Live state is Float32. Use exact logistic solutions and `p = 1 − exp(−λ·dt)` for every roll.
  - The visible year is the last completed step.

---

## 4. Beat sheet (the real-time pacing contract at normal pace)

These are tuning targets, checked by `tools/simulate.ts` against scripted islands.

| When (after first land) | What should have happened |
|---|---|
| ≤ 20 s | First wind arrival: a spider or spores. The first card appears. |
| ~1 min | Lichen visibly frosting the oldest rock |
| 2–3 min | A seabird visits; if there are no cliffs or beach, a "couldn't stay" card |
| 3–5 min | With any beach: sea rocket or morning glory, then a coconut within ~5 min of the beach existing |
| 4–6 min | Moss and first ferns in wet windward cracks |
| ≤ 8 min | First "couldn't stay" story about something the player can build |
| 5–10 min | Ghost crabs on any beach (something walking) |
| 6–10 min | Grass, first shrubs |
| 8–12 min | First tree (palm on a beach, or ʻōhiʻa on wet lava) |
| 15–20 min | Visible forest on the wet side; first storm (if shrubs exist) |
| 20–35 min | If built for it: cloud cap on a peak ≥ 60 m, a pond in a rock basin, ducks and dragonflies, birdsong |
| 40–50 min | The first island plateaus; hints start pointing outward ("an island to the east would help…") |
| ~4 h | The ending is reachable with 3+ forested islands enclosing a sound and ~60% of species |

**Feedback guarantees** (tested):
1. **Places are recognised within 3 s of land settling.** A soft label appears on the land ("A sea cliff", "A rock basin: it will hold rain"), and the journal logs it once.
2. **Visitors come back.** A species that "couldn't stay" returns within 30–90 real seconds of its need being met, using the pity timer.
3. **Look explains anything.** Look on any ground gives one plain sentence explaining it.
4. **First visits always tell their story.** A species' first failed visit always produces its "couldn't stay" story. At most one such card per 60 s; the rest go to the journal only.
5. **Never stuck.** Once a species' needs are met somewhere, it arrives within 5 real minutes (common) or 15 (rare).

---

## 5. Engine (worker) modules

```
engine/
  config (src/config.ts)       shared constants (lead)
  columns.ts                   Columns (lead)
  protocol.ts                  messages (lead)
  engine.ts                    hub: message handling, tick order, streams, ready/progress (WP-C)
  host.ts, worker.ts           worker start with page fallback (WP-C)
  undo.ts                      undo records over Columns blocks + PatchGrid blocks (WP-C)
  save.ts                      save/load: header + sections, decode-then-swap (WP-C)
  streams.ts                   dirty-rect batching and throttles for cols/eco messages (WP-C)
  geo/seabed.ts                starting seabed (WP-B)
  geo/geo.ts                   Geo facade: tools, step, steam, sheet stats (WP-B)
  geo/lava.ts, sand.ts, tools.ts, coast.ts  (WP-B)
eco/
  patches.ts                   PatchGrid: named typed arrays (lead)
  ecology.ts                   Ecology facade (WP-D)
  derive.ts, climate.ts, succession.ts, arrivals.ts, fauna.ts, storms.ts, journal.ts, director.ts (WP-D)
content/
  speciesTypes.ts              SpeciesDef presentation contract (lead)
  species.ts                   the catalogue (WP-D)
  stories.ts                   journal text, place names, inspect sentences (WP-D)
```

### 5.1 Tick order (`Engine.tick(dt, budgetMs)`)
1. Apply queued input (stroke samples).
2. `geo.step(STEP)`: up to 2 fixed steps, with a geo budget.
3. `eco.advance(realDt, yps)`, then `eco.work(budget)`.
4. Flush streams:
   - `cols` dirty rects: ≤ 15 Hz while lava or sand is active, ≤ 4 Hz otherwise;
   - `eco` dirty rects: ≤ 2 Hz;
   - `life`: on change, ≤ 1 Hz;
   - `journal`: on creation;
   - `tick`: every tick.
5. **Budgets** (desktop / Pixel estimate):
   - geo ≤ 4 / 8 ms;
   - eco ≤ 2 / 4 ms;
   - stream packing ≤ 1 ms.
   - The worker ticks at 30 Hz while physics is active and 10 Hz when idle (no lava, no sliding, no stroke).

### 5.2 Geo (WP-B) contract
```ts
class Geo {
  constructor(cols: Columns, seed: number)
  readonly seabed: { glow: { x: number; z: number } }
  applyTool(tool: ToolId, x: number, z: number, radius: number, dt: number, strength: number): ToolResult
  step(dt: number, budgetMs: number): GeoStepStats   // lava flow+cooling, sand sliding
  isSettled(): boolean                               // no lava, nothing sliding
  takeSteam(out: number[]): void                      // x, z, strength triples since last call
  lavaStats(): { area: number; hottest: [number, number] | null }
  setStorm(level: number): void                       // widens the swash band; 0..1
  stormPulse(level: number, dt: number, shore: Int32Array, n: number): void // real-time beach erosion
  coastYears(dtYears: number, shore: Int32Array, n: number, reefSand: Float32Array | null): void // calm-year berm rebuild, cliff retreat
  growReef(cols: Int32Array, amounts: Float32Array, n: number): void  // limestone accretion from ecology
}
```

**Physics rules:**
- **Lava** is a viscous shallow fluid with 8-neighbour flux.
  - Yield thickness rises as it cools. Mobility falls as it cools.
  - Cooling: thin sheets freeze in ~4–6 s, thick lobes in ~12–25 s, and lava in the sea in < 2 s with steam.
  - Freezing turns lava into rock (`rockKind = Basalt`). Below sea level, ~30% becomes black sand sediment.
  - Lava covering a column with life sets `Burn`.
  - Fluxes must be scaled so a symmetric cone pour stays symmetric.
  - Pour rate is capped by **volume per second**, not by radius.
- **Sand:**
  - Slides to an angle of repose: about 34° dry above +1.2 m and about 28° underwater.
  - In the swash band (−1.5 to +1.2 m) it relaxes toward about 1:8, which turns a poured mound at the shore into a beach face within 30–60 s.
  - Volume is conserved exactly (to float precision).
- **Rock:**
  - Rigid; never in an active set.
  - Placing rock on sediment buries the sediment into the rock.
- **Tools** (`radius` in m; a smooth falloff; strength fades near `BUILD_MAX` and the zone edge):
  - **Lava:** pours molten lava at `T = 1`.
  - **Rock:** raises rock steeply. Holding builds a column or cliff; dragging builds a wall. The page shows tumbling boulders.
  - **Sand:** adds sediment. Its sand kind blends with the target: golden by default, black near basalt shores.
  - **Hands:** relaxes the top toward the local mean. It keeps material and only moves sediment and lava; on rock it is slow (weathering speed).
  - **Scoop:** removes lava first, then sediment, then rock at half speed. It stops at `BUILD_MIN`.
- **Waves:** in calm years-time, sand rebuilds beaches. In storms, windward swash sand is pulled down to −2..−4 m, and calm years rebuild it.

### 5.3 Ecology (WP-D) contract
```ts
class Ecology {
  constructor(cols: Columns, grid: PatchGrid, geo: GeoForEco, seed: number)
  readonly year: number
  readonly storm: StormState
  onTerrainChanged(i0: number, k0: number, i1: number, k1: number, flags: number): void
  setClock(info: { paused: boolean; yps: number; dayPhase: number; season: 'wet' | 'dry'; gentleStorms: boolean }): void
  advance(realDt: number): void          // moves the target year; storms run on real time
  work(budgetMs: number): void           // sliced derive + climate + sweep + arrivals + fauna + journal
  isDirtyRect(): Rect | null             // patch rect changed since last take (for the eco stream)
  takeDirty(): Rect | null
  packEco(x0: number, z0: number, w: number, h: number, out: EcoPack): void   // fills cover/plants/habitat bytes
  takeLife(): LifeInfo | null            // when changed
  takeJournal(out: JournalEntry[]): void
  takeArrivals(out: ArrivalEvent[]): void
  takePlaces(out: PlaceEvent[]): void
  inspect(x: number, z: number): InspectInfo
  serialize(): EcoSave; restore(s: EcoSave): void
  debugAdvance(years: number): void      // sub-steps; used by checks and e2e
  debugStormNow(): void
}
```
`PatchGrid` is a bag of named typed arrays. Ecology registers every live array, so undo and save can snapshot and serialise them generically.

### 5.4 Engine hub (WP-C) contract
- The `Engine` class keeps the same shape as Sandcastle Cays: `handle(msg)`, `tick(dt, budgetMs)`, `setPageMode(on)`, `isReady`.
- **`init`** builds `Columns`, then `Geo` (generates the seabed), then `PatchGrid` and `Ecology`. With a save it builds into fresh objects and swaps only on success. Then it sends the full `cols` and `eco` streams in rows (progress messages), then `ready`.
- **Undo:**
  - A record opens at stroke `start`. It snapshots Column blocks (16 × 16 columns) and PatchGrid blocks (8 × 8 patches) on first touch.
  - It closes when the stroke has ended **and** `geo.isSettled()`, or after 40 s at most.
  - Ecology writes during an open record that are not caused by the stroke are allowed; undo restores patches with `max(snapshot, current)` cover only where the stroke burned or buried them.
  - Limits: 20 records or 32 MB; the oldest records are dropped.
  - The journal is append-only.
- **Save:**
  - Format: `"WWWS" | u16 format | u32 headerLen | header JSON | sections`.
  - Sections: `COLS` (quantised column arrays) and `ECO` (the ecology serialisation plus PatchGrid arrays).
  - Deflate via `CompressionStream`.
  - `save → load → save` must be byte-identical.
- **Messages:** see `protocol.ts`. Large arrays are transferred, not copied.

---

## 6. Page modules

```
main.ts                 boot, renderer, scene, frame loop, routing (lead skeleton; WP-H owns afterwards)
render/shared.ts        FrameCtx, PageSystem, WorldUniforms, quality (lead)
render/fields.ts        WorldFields: CPU mirrors + DataTextures, row-range uploads, height queries (lead)
render/terrain.ts       GPU-displaced CDLOD terrain (WP-E)
render/terrainMaterial.ts  ground shader (WP-E)
render/ocean.ts, waves.ts, ponds.ts   water (WP-E)
render/effects.ts       steam, pour streams, sparks, spray, dust (WP-E)
render/cursor.ts, hands.ts   brush ring and the code-made cupped hands (WP-E)
render/models/*.ts      plant kit, plant archetypes, animal body plans (WP-F)
render/vegetation.ts    plants from the patch layers: instancing, LOD, pop/die animation (WP-F)
render/fauna.ts         animal agents (WP-F)
render/vignettes.ts     arrival scenes: coconut, raft, bird, spores, silk (WP-F)
render/daylight.ts      day/season clock → lights, sky colours, fog, WorldUniforms (WP-G)
render/sky.ts, clouds.ts, weather.ts   sky dome, stars, moon, clouds and cap clouds, rain, lightning, rainbow (WP-G)
audio/*.ts              soundscape, voices, chimes, tool sounds (WP-G)
input/camera.ts, controls.ts   (WP-H)
ui/*.ts                 tray, cards, journal, guide, chart, menu, settings, onboarding, watch mode, look (WP-H)
storage/storage.ts      autosave A/B, settings, files (WP-H)
```

### 6.1 Page systems
Every page system implements:
```ts
interface PageSystem { name: string; onEngine?(m: FromEngine): void; update(f: FrameCtx): void; dispose?(): void }
```
`main.ts` calls `update` once per rendered frame in this order:

daylight → weather → terrain → ocean → ponds → vegetation → fauna → vignettes → effects → cursor/hands → sky/clouds → audio.

`FrameCtx` carries:
- `t` (seconds since start, wrapped into a 0..3600 range for shaders through `u.uTime`), `dt`
- `camera`, `cam` (orbit state: target, distance, yaw, pitch)
- `fields`, `u` (shared uniforms), `quality`, `year`, `storm`, `life`
- `day` (phase 0..1 and season), `isTouch`

### 6.2 WorldFields (lead)
- **Mirrors:**
  - `surf` Float32 512²
  - `ground` RGBA8 512²
  - `coverA` / `coverB` / `coverC` RGBA8 256²
  - `plants` Uint8 256² × 6, as `[canopySp, canopyCov, shrubSp, shrubCov, herbSp, herbCov]`
  - `habitat` Uint8 256²
- **Textures:**
  - `heightTex` (R32F, NEAREST; sample with `texelFetch` and manual bilinear filtering)
  - `groundTex` (RGBA8, LINEAR)
  - `coverATex` / `coverBTex` / `coverCTex` (RGBA8, LINEAR)
- `apply(msg)` copies rectangles into the mirrors and marks row ranges.
- `flush()` uploads only changed rows, once per frame, through `texture.addUpdateRange`.
- `heightAt(x, z)` gives the bilinear surface. `solidAt(x, z)` subtracts the lava. `waterDepthAt(x, z)`. `raycast(origin, dir, maxDist)` marches the heightfield and refines with bisection.
- `onPlants` / `onHabitat` callbacks fire with the changed patch rectangle (vegetation and fauna diff against their own state).

### 6.3 Shared uniforms (`WorldUniforms`, written by daylight and weather, read by everyone)

| Uniform | Meaning |
|---|---|
| `uTime` | Wrapped real time (s) |
| `uSunDir` (world), `uSunColor`, `uSkyColor`, `uGroundColor`, `uFogColor`, `uFogNear`, `uFogFar` | Light, sky and fog |
| `uNight` | 0..1 |
| `uStorm` | 0..1 |
| `uWind` | vec4: xy = direction × strength, z = gust, w = storm |
| `uRain` | 0..1 |
| `uWet` | Surface wetness after rain, 0..1 |
| `uDry` | 0..1 dry-season mood |
| `uZone` | vec4: originX, originZ, sizeX, sizeZ |
| `uSeaLevel` | Sea level |
| `uCamPos` | Camera position |
| `uLavaGlow` | vec4: x, z, radius, strength (biggest molten area) |

Colours are uniforms, not baked literals, so time of day and storms tint everything consistently. Each material's `onBeforeCompile` adds these uniforms by reference from the shared object.

### 6.4 Terrain rendering (WP-E): GPU-displaced CDLOD
- **No meshing in the worker.** Terrain geometry is a fixed grid patch (`N = 32` quads per side) drawn as instances. Each instance is a quadtree node: attribute `aNode = (x0, z0, size, level)`.
- **Vertex shader:**
  - reads `heightTex` with manual bilinear `texelFetch`;
  - morphs odd vertices toward the coarser grid near each node's range end (CDLOD geomorph);
  - adds **skirts** on node edges.
- **Fragment shader:** computes normals from `heightTex` with central differences (at full resolution, so lighting stays crisp at every LOD), then does all shading. There are no UVs: shading is world-space, and steep faces use x/z-projected noise.
- **LOD:** level 0 node = 64 m (2 m vertex spacing); levels up to 1024 m. Ranges come from the camera position, with a screen-space error target. Each frame, nodes are selected on the CPU with frustum culling and written into one `InstancedBufferAttribute` (one draw call for terrain, one for its shadow).
- **Shadow casting** uses a matching `customDepthMaterial` with the same displacement. Terrain shadows are on for laptop/Richer, and on for the Pixel only when performance allows.
- **Budget:** ≤ 150k terrain triangles in view on the Pixel.

**Ground shader** (Lambert with `onBeforeCompile`):
- **Materials:**
  - rock coloured by kind and weathering (`coverB.r`): fresh basalt is glossy blue-black, then matte, then grey-brown, then rusty;
  - placed stone is grey;
  - limestone is cream;
  - sand by kind (black, grey, gold, white), with wetness near the waterline;
  - soil (`coverB.r` high, on flat ground).
- **Lava:**
  - glow from the `groundTex` heat, with flow noise moving downhill, a crust with glowing cracks below 0.5 heat, and a breathing glow;
  - `uLavaGlow` lights nearby ground.
- **Cover** (`coverA`) spreads as patches that grow outward (noise thresholds): lichen speckle, moss velvet (brighter when wet), grass (golden in the lee during the dry season), forest-floor darkening (fake canopy shade).
  - `coverB.g` adds guano whitewash on cliffs and orange lichen nearby.
  - `coverB.a` is burn char.
  - `coverC.a` is streams and marsh: glossy ribbons animated downhill.
- **Underwater:** depth absorption; caustics only within 6 m depth and 80 m of the camera; coral and seagrass colours from `coverC`.
- **Detail:** detail-normal noise fades in within 15 m. All hashes are sin-free and use coordinates relative to the camera.

### 6.5 Water (WP-E)
- **Ocean:** a camera-centred grid (≤ 160 × 160) with fine spacing near the camera that grows outward to the horizon, snapped to its grid step.
  - Gerstner swell from `waves.ts` (CPU and GPU agree), amplitude × (1 + 2·`uStorm`).
  - Shoaling and damping come from `heightTex` (the water depth), so new islands are never swamped.
  - Depth colours: turquoise over white sand, teal over black sand, darker over coral, deep blue past 25 m. Opaque by 30 m.
  - Shore foam under 1 m depth, breaker foam on windward shallows, whitecaps in storms.
- **Ponds:** one flat mesh per pond (`life.ponds`) at pond level; fresh or salt tint; discards where the ground is higher.

### 6.6 Plants (WP-F)
- Built at load from a code plant kit. Archetypes are listed in `PlantModel` (`speciesTypes.ts`). Each archetype has LOD0 and LOD1, plus a shared far "canopy blob" (LOD2). Species colours come from `SpeciesDef.look`.
- **Placement is stable and deterministic.** Each patch has fixed candidate spots per layer: canopy 1, shrub 2, herb 3. Each spot has a hashed position and a hashed threshold. A spot shows a plant when that layer's cover ≥ its threshold, and hides below threshold − 0.05. Its species is the layer's species, so rising cover only adds plants. A species change in a layer makes the old plants die and the new ones pop.
- **Distance tiers** (per 64 m vegetation tile, from the camera):
  - < 60 m: all layers at LOD0.
  - 60–180 m: canopy and shrub at LOD1.
  - 180–500 m: canopy only, as LOD2 blobs.
  - Beyond: cover tint only.
  - Hard caps on the phone: LOD0 ≤ 600, LOD1 ≤ 2,500, LOD2 ≤ 4,000.
- **Pop:** about 1.5 s (sprout, unfurl, settle). Ferns uncurl, palms open like an umbrella, flowers open last. It runs on a small separate "animating" instanced mesh. At most 4 pops per second near the camera; the rest fade in over 0.6 s.
- **Death:** lava (char and sink), storm (topple, leaving a log), wither (fade to straw), burial (sink).
- Only LOD0 within 40 m casts shadows. Instance data is packed as `vec4` (x, y, z, yaw·scale) plus a `vec4` life, never 64-byte matrices.

### 6.7 Animals (WP-F)
- Agents live only near the camera (within 250 m; birds within 600 m).
- **Caps:** phone 60 agents plus one `Points` "speck flock"; laptop 120 agents.
- **Count** per species = f(island population (`life.pops`), visibility). Spawn points are sampled from the `habitat` mirror near the camera that match the species' `where`. Agents spawn and leave out of view or by walking or flying off. They never pop.
- Behaviours come from `AnimalLook.behaviour` (see `speciesTypes.ts`) and run at real-world speeds. Vertex-shader animation uses per-instance phase; there are no skeletons. One shared creature material.

### 6.8 Sky, weather, sound (WP-G)
- **Day cycle and season mood:** see §3. Night stays readable. Stars, moon phase, moonglade.
- **Cap clouds** form over peaks ≥ 60 m (`life.peaks`). Trade cumulus drift west. A storm deck thickens with `uStorm`. Clouds fade near the camera.
- **Storm sequence:**
  - **Warning**, 30–45 s: the light turns amber then grey, swell rises, birds head to the lee.
  - **Peak**, ~60 s: rain streaks around the camera, gusts, whitecaps, far lightning (photosensitivity-safe, with a "fewer flashes" setting).
  - **Clearing**, ~30 s: sunbeams and a rainbow.
  - Fog scales with camera distance, so the island stays visible from above.
- **Soundscape layers:**
  - wind (by exposure and storm), surf, lava and steam, rain, thunder;
  - insects by day and night, frogs at night, birdsong per species voice, colony murmur;
  - a whale song fragment near the Sound.
  - Layer gains come from the ecology census near the listener (camera target), read from the plants and habitat mirrors plus `life.pops`.
- **Chimes** are pentatonic (A major pentatonic), one voice per road: wind, sea, wings.
- **Tool sounds:** lava rumble, hiss and cooling tinkle; rock clatter; sand pour hiss; smooth rub; scoop.

### 6.9 Shell (WP-H)
- **Gestures, map-style** (one plain line tells the owner the change from Sandcastle Cays).
  - **Touch:**
    - one finger uses the tool;
    - two-finger drag **pans**; pinch zooms toward the fingers; two-finger twist rotates;
    - pitch follows zoom (top-down when far, low when close);
    - a quick two-finger tap glides to a spot.
    - A second finger landing cancels and undoes the stroke.
  - **Trackpad and mouse:**
    - click-drag uses the tool;
    - two-finger swipe pans; pinch or wheel zooms toward the pointer;
    - right-drag rotates and tilts; right-click glides to a spot.
    - Keys: WASD/arrows pan, Q/E rotate, R/F tilt, 1–6 tools, `[` `]` size, Ctrl+Z undo, J journal, Space look.
- **Camera:** distance 8–1,600 m. A sight-line lift keeps it above the terrain. Near and far planes scale with distance. Glides are slow eased arcs.
- **Watch mode:** after 60 s idle the UI fades. The camera drifts toward recent activity (arrivals, pops, colonies), framing at 60–120 m. Any touch brings the UI back. It requests a screen wake lock. The frame rate is capped at 30 in watch mode and 45 otherwise on touch devices.
- **UI:**
  - **Tray:** Lava, Rock, Sand, Hands, Scoop, Look, Size, Undo.
  - **Cards:** journal slips with a small ink year stamp, the story line, and a code-drawn icon per road. Tap a card to glide there.
  - **Journal:** Story (with Firsts and Ages as stamps), Life & Places (the field guide with hints that sharpen: riddle → plain need → direct line), Chart (the zone map drawn on a canvas from the height mirror; tap to fly; rename islands).
  - **Menu and settings:** pace, storms gentle/normal, fewer flashes, sound, graphics (auto/lighter/richer), camera drift, vibration, save/load file, new sea, help, run the checks.
  - **Onboarding:** "Touch the glow." → "Your island." → "Keep building, or just watch." Then one line the first time each tool is chosen.
- **Storage:** IndexedDB `wind-wing-wave` with A/B autosave slots (timestamped), localStorage fallback, and files `.wwwsave`. Autosave every 60 s while years run, on hide, and at each new Age, with a "keep a copy" nudge.

---

## 7. Budgets (Pixel 7a, sustained)

| Item | Budget |
|---|---|
| Main pass | ≤ 350k triangles, ≤ 80 draw calls (terrain 150k, plants 120k, water 40k, animals 15k, sky/FX 25k) |
| Shadow pass | ≤ 100k triangles, ≤ 20 draws, 1024² (laptop 2048²) |
| Fragment shaders | No loops over 4 iterations; ground noise ≤ 6 hash evaluations per pixel at close range, ≤ 2 far |
| Transparent overdraw | ≤ 2.5× worst view; steam ≤ 100 puffs on phone |
| Main-thread JS | ≤ 4 ms per frame |
| Texture uploads | ≤ 1 MB per frame peak, ≤ 3 MB/s sustained |
| Worker | ≤ 8 ms per 33 ms tick while physics is active; ≤ 3 ms per 100 ms while idle |
| Memory | worker ≤ 60 MB, page heap ≤ 150 MB |
| HTML file | ≤ 2 MB |

- **Rendering setup:** three r186. `PCFShadowMap` (soft is gone). Never toggle `shadowMap.enabled` at runtime; lower the map size or cull casters instead. Precompile every material at load (`renderer.compileAsync`).
- **Dynamic resolution:** pixel ratio between 1.0 and the cap, driven by frame time.

---

## 8. Checks
- **`npm test`** (vitest) runs the shared checks registry (`checks/registry.ts`). Each package registers its checks; the in-game checks page runs a fast subset.
- **`npm run browser-check`** (Playwright, SwiftShader) runs:
  - a laptop pass and a Pixel-sized pass;
  - building an island, `advanceYears`, plants, journal, undo, save/reload and gestures.
  - Only triangle and draw-call budgets are asserted, never fps, because SwiftShader frame rates mean nothing.
- **`node e2e/look.mjs`** takes screenshots for the visual review checklist.
- **Not testable here:** real Pixel and laptop frame rate, phone storage when opened from Downloads, and how the gestures feel. Every delivery note says so plainly.

---

## 9. Corrections and additions found while joining the parts ("path 1")

The sections above are the contract the ten parts were built against. Where the built code differs, the code wins; the differences the builders reported, and what joining added, are here.

**Geology (§5.2)**
- `lavaStats()` returns `{ area, glow: [x, z, radius, strength] }` (not `hottest`). `takeRockPlaced(): number` exists (rock volume since the last call, for clatter).
- `coastYears(dt, shore, n, reefSand)`: `reefSand[j]` is metres per year of white coral sand landing at `shore[j]` (parallel to the shore list), or `null` for none. `shore` may list either the first sea column or the last land column at the waterline.
- One `step()` call always runs at least one whole lava substep. Burn rectangles are patch-sized (2 × 2 columns), so the ecology can trust them as they are.
- The geology listens for ground changes it did not make (undo, load) through `cols.addListener`, and `seabed.glow` is known from the seed alone.

**Ecology and hub (§5.3, §5.4)**
- Constructor: `new Ecology(cols, grid, geo, seed, species)`.
- The hub (not the ecology) wires it up: its columns listener calls `eco.onTerrainChanged`; `eco.setClock` is called on focus, pause and settings; `eco.restore()` runs after the PatchGrid arrays are loaded; undo restores life blocks through `eco.undoMerge`, then reports the restored blocks with `markChanged(Geom | Look)`.
- Save format: `"WWWS" | u16 format | u32 headerLen | header JSON | sections`, sections `COLS`, `ECO` and a final `SUM ` (CRC-32 of every byte before it, checked before anything is read; deflate-raw has no checksum of its own). Ground heights are stored to 1/128 m (rock), 1/256 m (sand, lava), so a loaded ground differs from the live one by up to about 1 cm, and an island's recorded peak can move one patch on a flat cay. `save → load → save` is identical for the file itself.
- Years only run while an island exists; the first seconds after new land go to the life simulation recognising its shape (the year clock moves in bursts), then it runs at about 85% of the asked pace.
- With years running, beaches and cliffs keep shifting a few centimetres a year (`geo.coastYears`), so the engine stays on its 30 Hz tick while years run. With years held, the ground is still after about 12 seconds and the engine drops to its 10 Hz idle tick.

**Sky (§3, §6.8)**
- A new sea starts on sky day 1, a dry day (`NEW_SEA_DAY`), so the first wet season opens about 13 minutes in and the first storm lands at 15–20 minutes (DECISIONS 13).
- `render/clouds.ts` does not exist: clouds live in `render/sky.ts`.

**Plants and animals (§6.6, §6.7)**
- Each plant instance carries a third `vec4`: the five packed species colours. Caps are filled nearest-first in 16 m blocks inside each 64 m tile; laptops get 1.6× the phone caps. Pops are played within 130 m, at most 4 a second.
- A plant that pops is not reported to sound (`takePops` was asked for and not built); watch mode notices new cover through the eco stream instead.

**Page and shell (§6.9)**
- Look comes back by itself after watch mode.
- The camera's far plane is never under 16 km, so the sky dome and sea must fit inside it.
- Test hooks on `window.__game` (browser checks only): `holdYears(on)`, `engineStats()`, `storm`, `holdQuality(on)`, `pour`, `advanceYears`, `stormNow`, `openJournal`, `openMenu`, `heightHash`, `lastSent`, `wake`, `goIdle`, `stats`, `project`, `selectTool`, `send`.

**Budgets (§7)**
- The browser budget checks compare `renderer.info` (main and shadow pass measured separately) with 350k / 80 draws and 100k / 20 draws.
- Shadow pass split: the land gets 55k on the phone and 70k on a laptop; plants and animals share the rest.
- Time-limit checks (`timing: true` in the checks registry) warn instead of failing under `npm test` on a slow machine (DECISIONS 15).
