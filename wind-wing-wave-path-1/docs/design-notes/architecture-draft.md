# Island-life game: technical architecture

Working folder: `/home/user/sand/isles/`. The display title is not decided. It lives in one constant, `src/content/title.ts`. Storage uses a fixed internal id, `isles-v1`, so renaming the game later never orphans saves.

---

## 0. Decisions at a glance

1. **The world is a layered column grid, not a voxel volume.** Every 2 m × 2 m column stores rock height, loose-sediment thickness, how much of that sediment is soil, molten-lava thickness and lava temperature, plus a few looks (sand colour, rock kind and age).
   - The sandcastle cell sim (`sim.ts`) and voxel store (`world.ts`) are not carried over. Measured: a 20 m pour took 8.3 min of sim time to settle at 1 m cells, so cell-by-cell physics cannot build islands.
   - The surface-nets mesher is reused almost unchanged. The column grid makes up its `fill` data on the fly, so cliffs and steep lava fronts still get real vertical geometry.
   - Trade-off: no overhangs, arches or caves. We accept that and record it in DECISIONS.md. A "two-span column" could add arches later.
2. **Scale.** Cells are 2 m. The zone is 1024 m × 1024 m (512 × 512 columns). Heights run from −32 m to +160 m. Sea level is 0. Islands can reach 150 m.
   - The seabed is a flat −30 m floor with a shallow volcanic ridge crossing it diagonally (crest −6 m, three knolls at −2.5 m).
   - Nothing below −28 m is meshed, because the water is opaque there.
3. **Two physics clocks.**
   - **Real time:** lava, sand sliding, tools, waves, animals, day/night.
   - **Ecology years:** soil, plants, arrivals, animal populations, coast change, reef growth, storm timing.
   - Years start at 0 when land first breaks the surface and run at 0.25 years per second (normal pace). They slow to about 0.01 years per second during a storm's peak.
   - Everything pauses while the game is closed or hidden.
4. **One engine worker** runs geology, meshing and ecology, each with its own time budget. If the worker cannot start, the whole engine runs on the page (inherited fallback).
5. **Lava is drawn as a separate live "lava sheet" mesh,** updated about 12 times per second. Terrain is re-meshed only when lava freezes into rock. This keeps flowing lava smooth without constant tile rebuilds.
6. **Colour comes from textures, never from re-meshing.** Ground looks and plant cover live in world-space data textures that the worker patches:
   - `uGround` (one texel per column): sediment depth, soil, sand colour, rock kind and age.
   - `uCoverA` / `uCoverB` (one texel per 4 m patch): lichen, moss, grass, forest floor, beach vines, reef, seagrass, guano, streams.
   - Ecological change therefore never forces a re-mesh.
7. **Plants are discrete instances** derived from 4 slots per 4 m patch (one canopy, two understorey, one ground).
   - The engine decides which species sits in each slot. The page turns slots into instanced meshes, with a pop-in animation of about 1.2 s and wind sway in real time.
   - Lichen, moss and grass are cover texture only.
8. **Animals are page-side agents moving at real-life speeds.** The engine only supplies populations per island and colony locations.
9. **Tools** (unlimited material; brush size follows zoom):
   - Lava (pour; it flows, cools and turns to rock)
   - Sand (pour; it slides and forms beaches)
   - Rock (raise; rigid, so it holds cliffs)
   - Lower (scoop)
   - Smooth
10. **Undo** covers your strokes plus the sand and lava they set off. A record closes once that settles (at most 40 s). Storms, erosion and plant growth are never undone.
11. **Saves** store the whole column grid quantized (about 11 bytes per column) plus ecology arrays, deflated to about 0.6–1.5 MB. Nothing depends on the seabed formula after a game starts.
12. **One HTML file, no image or sound files.** Everything is procedural: models built in code, sounds made with WebAudio, icons drawn as SVG in code.

---

## 1. World scale

### 1.1 Numbers (`src/config.ts`)

| Constant | Value | Notes |
|---|---|---|
| `CELL` | 2 m | Horizontal and vertical cell size; mesher constants are in cells and carry over unchanged |
| `NX`, `NZ` | 512, 512 | Columns; origin (−512, −512) m |
| `Y_MIN`, `Y_MAX` | −32 m, +160 m | `NY` = 96 cells = 6 chunks tall |
| `SEA_LEVEL` | 0 | Constant; storms add a visual surge of up to +0.6 m |
| `BUILD_MAX`, `BUILD_MIN` | 150 m, −30 m | Tools stop at these heights |
| `CHUNK` | 16 cells (32 m) | Mesh unit only; 32 × 6 × 32 = 6,144 slots |
| `TILE_CHUNKS` | 4 | Render tile is 128 m; 8 × 8 = 64 tiles |
| `MESH_CUT_Y` | −28 m | Chunk columns entirely below this are not meshed |
| `PATCH` | 2 columns (4 m) | Ecology grid 256 × 256 = 65,536 patches |
| `VEG_TILE` | 16 patches (64 m) | Page-side culling unit for plants (16 × 16) |
| `EDGE_MARGIN` | 48 m | Tool strength fades to 0 near the zone edge; lava treats edge columns as walls |
| `WIND_DIR` | from +x (east) | Trade wind; fixed so rain-shadow rows line up with the grid |

### 1.2 Why these numbers

- **Triangle cost.** A heightfield meshed by surface nets measured about 1.34 vertices and 2.2 triangles per column on the lagoon.
  - At 2 m cells, the meshed bank (everything above −28 m) is roughly 60–110 k columns, or about 150–260 k terrain triangles for the whole zone. That fits a Pixel 7a budget without terrain LOD.
  - At 1 m cells the same zone is about 4×, which does not fit.
- **Zone size.** 1 km holds 3–5 islands of 150–350 m across, with lagoons and channels between them, and still leaves open sea.
- **No grid-size limit.** No per-cell queue key is used, so the old 10-bit limit is irrelevant.
- **Floor depth.** −30 m keeps lava volumes reasonable and puts most of the zone below the water's visibility depth, so deep floor costs nothing to draw.
  - An island 250 m across with an 80 m peak, built from the −6 m crest, is about 1.4 M m³. At the large brush (lava about 25 k m³/s, minus runoff) that is roughly 1–3 minutes of pouring: epic, but doable.
  - Building off the ridge in −30 m water takes 3–5× longer, which is a natural gentle constraint.

### 1.3 Starting seabed (`engine/seabed.ts`, `SEABED_VERSION = 1`)

- **Floor:** −30 m with ±1.5 m low-frequency noise. Use hash-based value noise, not the 256-period `Noise2D`, or the pattern tiles visibly.
- **Ridge:**
  - A curved spine from about (−380, −260) to (+400, +300), so it crosses the trade wind and islands get distinct windward and leeward sides.
  - Crest depth about −6 m; the cross-section reaches −28 m at about 130 m from the spine.
  - Three knolls at −2.5 m, about 20%, 50% and 80% along the spine. They hint at where to start.
- **Per game:** each new game uses a random seed that jitters the spine bend and knoll positions by ±60 m. The seed is stored in the save header. The whole column grid is saved, so the formula never touches a loaded game again.
- **Outside the zone:** an analytic deep floor (used only for water colour) slopes to −200 m by 1.5 km.
- **On the horizon:** a hazy upwind silhouette of "the old islands" sits 7–10 km east. It is the story's source of life, and the journal mentions it.

### 1.4 Estimates for a fully built chain of 3–5 islands

| Quantity | Estimate |
|---|---|
| Column arrays (worker) | 262,144 × about 23 B ≈ **6.0 MB** |
| Patch grid (worker) | 65,536 × about 64 B ≈ **4.2 MB** |
| Mesh chunks with surface | about 450–700 (bank plus cliffs) |
| Chunk mesh cache (worker) | about 10 KB per chunk, ≈ **5–8 MB** |
| Undo (worker, capped) | ≤ 24 MB |
| Worker heap peak | ≈ 40–50 MB |
| Terrain triangles, all tiles | ≈ 200–300 k (worst case, whole zone above −28 m: ≈ 600 k; the LOD fallback in §6.2 covers it) |
| Terrain triangles in view (typical) | 120–200 k |
| Plant slots filled (potential) | ≤ 60 k; drawn at once ≤ about 6 k |
| Page GPU memory | terrain buffers ≈ 8 MB; textures ≈ 3 MB (heights 512² half-float 0.5 MB, ground 512² RGBA 1 MB, two cover 256² RGBA 0.5 MB) |
| Save | ≈ 0.6–1.5 MB after deflate |

---

## 2. Materials and per-column state

### 2.1 Why columns instead of a per-cell material channel

In a 2.5D world, material is a function of depth inside a column. Bottom to top, a column is:

1. **Rock:** rigid; includes bedrock, cooled lava, raised rock and reef limestone.
2. **Sediment:** loose, made of sand plus soil. Soil is the top `soil` metres of the sediment.
3. **Lava:** molten, sitting on top.

Per-cell material would need 5–6 arrays of 4,096 bytes per chunk, material-aware mixing and dominant-material meshing. Columns need none of that, and every physics rule becomes a 2D neighbour rule.

### 2.2 `Columns` arrays (index `c = i + k*NX`)

| Array | Type | Meaning |
|---|---|---|
| `rock` | Float32 | Top of rigid rock (m) |
| `sed` | Float32 | Loose sediment thickness on the rock (m) |
| `soil` | Float32 | Soil part of the sediment's top, always ≤ `sed` (m) |
| `lava` | Float32 | Molten lava thickness on top (m) |
| `temp` | Float32 | Lava temperature, 0..1 (1 = fresh, freezes at 0.30) |
| `sandKind` | Uint8 | 0 = black basalt sand, 128 = golden (poured), 255 = white coral sand; blended by mass when sand moves |
| `rockKind` | Uint8 | 0 = lava basalt, 1 = old or raised rock, 2 = reef limestone |
| `rockAge` | Uint8 | Decades since the rock formed (shows weathering: glossy black, then grey-brown) |
| `meshedTop` | Float32 | Surface height when its chunk was last meshed (for the re-mesh threshold) |

**Derived on demand:**
- `top(c) = rock + sed` (solid surface)
- `surface(c) = top + lava`

**Writes and change notification.** All writes go through `Columns.modify(c)` or rectangle helpers. These call:
- the `beforeModify(block)` undo hook. Blocks are 16 × 16 columns (one chunk column), copy-on-first-write.
- `markChanged(i0, k0, i1, k1, flags)`, where flags are `GEOM` (geometry), `LOOK` (ground texture), `BURN` (lava burial) and `SOIL` (soil only). These are routed to the mesh scheduler, the ground-map dirty set and ecology.

**Mesher input.** `Columns.sampleFill(i0, j0, k0, sx, sy, sz, out)` produces the cell fill for the mesher. For each window column it reads `top` once (clamped to ≥ −30 m), then sets `fill = clamp((top − yBottom)/CELL, 0, 1) * 255` for each layer. Outside the zone it uses the analytic deep floor. Molten lava is excluded, because the lava sheet draws it.

### 2.3 Rules that keep the stack simple

- **Rock placed on a column with sediment** buries it: `rock += sed + added`, `sed = soil = 0`. The sediment gets merged into the rock.
- **Lava freezing on sediment** does the same, and also clears that column's plant cover (`BURN`).
  - When the frozen column was below sea level, 30% of it becomes black sand (sediment) and 70% becomes rock. This is how ocean-entry lava makes black-sand beaches.
- **Sand landing on soil** buries the soil: `soil = max(0, soil − deposited)`. Moving sediment carries its soil share: when it moves, the top `min(moved, soil)` metres go first.
- **Soil** grows inside the sediment's thickness (weathering adds to both `sed` and `soil`), up to 1.5 m.

### 2.4 Moisture and packing

- **No wetness or packing per cell.** Wetness of sand at the waterline is done in the shader from height above sea level. Moisture is an ecology field per patch (§5).
- Sand stability depends only on height and setting (above water, at the waterline, underwater), plus root strength from plant cover for soil.

### 2.5 Save format (`engine/save.ts`, `SAVE_FORMAT = 1`)

```
"ISLE" | u16 format | u8 compressed flag (deflate-raw via CompressionStream; 0 = raw)
u32 jsonLen | JSON header
sections: [u32 tag][u32 byteLen][bytes] ...
```

**Header:**
- `savedAt`, `gameVersion`, `seabedVersion`, `seed`
- `dims {nx, nz, cell, originX, originZ, patch}`, checked on load; a mismatch means the save is refused.
- `years`, `firstLandAt`, `dayPhase`, `pace`, `camera[6]`
- `rngState` (ecology and storm RNG)
- `storm`: state and next scheduled year
- `islands` (ids, names, founding years), `speciesState` (arrived or established flags, first-seen years, first locations)
- `journal` (structured entries, §5.8)

**Sections:**

| Tag | Content | Encoding |
|---|---|---|
| `COLS` | Column grid | `rock` u16 = (h − Y_MIN)·256; `sed` u16 at 1/256 m; `soil` u8 cm; `lava` u16 at 1/256 m; `temp` u8; `sandKind` u8; `rockKind` u8; `rockAge` u8 = 11 B/column. Each row is delta-encoded before deflate. |
| `PTCH` | Patch state | Cover (12 groups), seed pressure (12), group species ids (12), nutrients, disturbance age, slots ×4 (Uint8). Zero-heavy at sea, so it compresses well. |
| `FAUN` | Animal populations | Per island × per species, u16 |

**Load safety** (fixes the inherited bug of a failed load breaking the engine):
- Decode into fresh `Columns` and `PatchGrid` objects and swap them in only on success.
- Check that every section's length is exact; a truncated save is rejected.
- On failure, post `loaded{ok:false}` and leave the current game untouched.

**Exactness rule.** `save → load → save` must be byte-identical. Loading leaves the values quantized, so in-memory floats sit on the quantum and stay stable from then on.

---

## 3. Physics (real time, in the worker)

Every column process keeps an **active set**: a Uint8 flag per column plus an `IntList` (reused from `sim.ts:26–107`). Only active columns cost anything. Every loop checks `performance.now()` every 256 columns against its budget. If it runs out of time, the process continues next tick: the physics slows down rather than skipping.

### 3.1 Sand and soil sliding (`engine/geo/sand.ts`)

For each active column, compare it with its 8 neighbours (diagonals at distance 2√2 m). The allowed height step is `d·tanθ`, where θ depends on the band:

| Band | Angle | `tanθ` |
|---|---|---|
| Dry sand, top > +1.2 m | 34° | 0.67 |
| Swash band, −1.5 to +1.2 m (calm) | about 7° (1:8) | 0.125 |
| Swash band during a storm | widens to −4 to +3 m, 1:14 | 0.07 |
| Underwater sand | 28° | 0.53 |
| Soil | 40°; rises to 50° with shrub or tree cover > 50% (roots) | 0.84 → 1.19 |

- **Move rule:** `move = 0.45·(Δ − d·tanθ)/2`, capped at 0.5 m per step per pair and at the column's available sediment. Neighbours are visited in a random order (fixed-seed RNG), and the direction alternates on an integer step counter (fixes the old float drift).
- **Waking:** any column that changes wakes itself and its 8 neighbours.
- **Swash band:** these columns relax at 1/10 rate in real time. That turns poured sand at the shore into a beach face within about 30–60 s instead of a mound.
- **When a storm starts,** the engine wakes every swash-band sediment column (from the shoreline list in §5.3).
- **Columns covered by lava** are skipped.
- **Re-mesh threshold:** a column is re-meshed when `|top − meshedTop| > 0.12 m`. Ecology-driven soil changes use 0.25 m.
- **Cost:** about 80 ns per column-step on desktop. 20 k active columns ≈ 1.6 ms desktop, ≈ 5 ms on Pixel (estimate). Budget: 3 ms desktop, 5 ms Pixel.

### 3.2 Lava (`engine/geo/lava.ts`)

A shallow viscous fluid on the columns, using 8-neighbour flux and 2 substeps per 1/30 s step.

- **Flow:** effective surface `S = top + lava`. For each neighbour with `Δ = S_i − S_n > 0`:
  - Yield thickness `hy(T) = 0.25 + 2.5·(1−T)²` m (Bingham-like: cool lava will not move until it is thick).
  - Mobility `k(T) = 1.2·exp(6·(T−1))`.
  - Flux `q = k(T) · max(0, L_i − hy)² · Δ/d · dt_sub`.
  - Fluxes are computed into a scratch array, then scaled so no column gives away more than its `L` or more than `Δ/3` toward any neighbour. Then they are applied.
  - Heat moves with the lava: temperatures are mixed by mass.
- **Cooling, per second:**
  `dT = −(0.035 + 0.06/max(L, 0.4) + 0.03·exposedEdges/8 + 0.8·[S < SEA_LEVEL+0.3])`
  - Thin 0.5 m sheet: freezes in about 4–5 s.
  - 3 m lobe: about 12 s.
  - 8 m pool: about 16–25 s.
  - Lava entering the sea: under 1.5 s.
  - This matches the brief's "visible over 5–30 s".
- **States:**
  - T < 0.5: crust. The shader turns dark with glowing cracks, and the yield thickness rises sharply.
  - T < 0.30: freeze. `rock += L` (or the 70/30 rock/black-sand split below sea level), `rockKind = basalt`, `rockAge = 0`, then the burial rule (§2.3) and `markChanged(GEOM|LOOK|BURN)`.
- **Steam:** cooling caused by water contact is collected into ≤ 32 emitters per tick (`x, z, strength`), merged on a 16 m grid, and sent in `tick.events.steam`.
- **Lava sheet:** while any lava exists, the engine sends a sheet message at ≤ 12 Hz covering the bounding box of lava columns. It includes columns frozen in the last 1.0 s, marked as cold crust, so the sheet never shows a gap before the terrain tile arrives.
- **Limits:** lava stops at the zone edge (wall). The source adds at most 12 m above the ground at the brush.
- **Cost:** about 0.1 µs per column-neighbour-substep. 10 k active columns ≈ 1.6 ms desktop, ≈ 5 ms Pixel. Budget: 4 ms desktop, 6 ms Pixel.

### 3.3 Rock

Rock is rigid and never enters any active set. Cliffs of any height stay put, with real vertical faces in the mesh. Rock changes only through tools, freezing lava, coastal erosion and reef growth (both on the years clock, §5.6).

### 3.4 Storm-time shaping

Storm-time shaping runs in real time during a storm and is not undoable:
- the widened swash band (§3.1);
- a surge uniform for visuals;
- `coast.stormPulse(level, dt)`: on windward shorelines, moves sand from the berm (+0.5 to +2.5 m) down to −2 to −4 m at a rate proportional to storm level. Calm years later rebuild the berm (§5.6).

### 3.5 Per-tick cost summary

| Process | Clock | Rate | Desktop | Pixel (estimate) |
|---|---|---|---|---|
| Tool application | real | each tick | 0.1 ms | 0.4 ms |
| Lava flow and cooling | real | 30 Hz × 2 substeps | ≤ 2 ms | ≤ 6 ms (capped) |
| Sand sliding | real | 30 Hz | ≤ 1.5 ms | ≤ 5 ms (capped) |
| Meshing | real | rest of budget | 0.25 ms/chunk | about 1 ms/chunk |
| Ecology sweep | years | continuous slice | 2 ms slice | 3 ms slice |
| Global recompute (§5.3) | on change | debounced 2 s, sliced | 10 ms total | 40 ms total |

**Worker tick:** 30 Hz with a total budget of **14 ms** (desktop and Pixel; it runs on its own core). **Page fallback:** 6 ms per frame (45 ms while loading).

---

## 4. Tools

| Tool | Effect at brush centre (r = brush radius in m, w = falloff) | Notes |
|---|---|---|
| **Lava** | `lava += 0.35·r·w·dt` at T = 1 | Fountain and spatter particles at the vent; rumble and hiss |
| **Sand** | `sed += 0.25·r·w·dt`, golden `sandKind` (blends with the target) | A cosmetic stream of falling grains from above the cursor |
| **Rock** | `rock += 0.15·r·w·dt`; sediment rides up on top | Rises from below with a rumble and a dust puff; makes cliffs |
| **Lower** | Removes `0.2·r·w·dt`: lava, then soil and sand, then rock at half speed | Can dredge lagoons and channels; stops at −30 m |
| **Smooth** | Moves the top layer 40%/s toward the 5 × 5-column mean | Works on rock too; keeps material kind |

- **Falloff:** `w = (1 − (d/r)²)²`. Tools write columns directly; there are no particles and no "hand".
- **Brush radius follows zoom:** `r = clamp(K·camDist, 3, 60)` m, with K = 0.035, 0.07 and 0.13 for small, medium and large. A finger covers the same share of the screen at any zoom: zoom out for big landforms, zoom in for details.
- **Unlimited material.** It is a god game, so there is no hand meter.
- **Caps:** strength fades to 0 above 140–150 m and within 48 m of the zone edge.
- **Picking:** the page picks the ground using a shared heightfield raycast (`shared/heightRay.ts`: a step-through along the ray over its height mirror, then 6 bisection steps), and sends `stroke {x, z, radius}`.
  - The engine trusts the x/z and does no hover raycast. This removes the 30 Hz engine hover and the 80 m reach limit.
- **Undo** (`engine/undo.ts`):
  - A record opens on `stroke start`. While it is open, every write by tools, sand sliding or lava snapshots the touched 16 × 16-column blocks: column arrays about 10 KB plus the 8 × 8 patch states about 3 KB.
  - The record closes when the stroke has ended **and** the sand active set has emptied **and** all lava has frozen, or after 40 s at most.
  - Ecology, coast and storm writes run with recording off.
  - Limits: 20 records, 24 MB. An oversized record is dropped on its own; earlier records are kept, which fixes the inherited wipe-all bug.
  - Undo restores the blocks, marks them `GEOM|LOOK`, and re-sends slots and cover for those patches. A lava mistake brings the forest back.
- **Cancel:** a second finger landing mid-stroke cancels it and undoes it, as in the sandcastle game.

---

## 5. Ecology simulation

### 5.1 Placement

Ecology runs **in the same worker**, as `eco/ecology.ts`, with its own budget slice (2 ms desktop, 3 ms Pixel, 1.5 ms in page mode).

A second worker is ruled out:
- Shared memory is unavailable on `file://` (no COOP/COEP headers).
- Copying terrain between workers costs more than it saves.
- The page fallback would need two engines.

Ecology writes soil straight into `Columns`.

### 5.2 Patch grid (`eco/patches.ts`, 256 × 256 patches of 4 m; typed arrays)

**Derived from terrain** (recomputed when dirty):

| Field | Type | Meaning |
|---|---|---|
| `h`, `hMin`, `hMax` | F32 | Mean, minimum and maximum of `top` over the 2 × 2 columns |
| `slope` | U8 | Steepness |
| `windward` | S8 | Facing the east wind: −127 lee to +127 windward |
| `sub` | U8 | Substrate class: sea, fresh lava, old rock, limestone, sand, soil, pond |
| `shoreDist` | U8 | Patches to nearest sea |
| `depth` | U8 | Water depth for sea patches |
| `island` | U16 | Island id (0 = sea) |
| `cliff` | U8 | Largest drop to a neighbour column within 6 m |
| `salt` | U8 | Spray: windward shore exposure, decays inland; boosted during storms |
| `rain` | U8 | Rainfall from the wind march (§5.3) |
| `flow` | U16 | Upstream catchment |
| `pond` | U8 | Pond depth if in a pond |
| `moist` | U8 | Moisture, combined (§5.3) |

**State:**

| Field | Type | Meaning |
|---|---|---|
| `cover[g]` | U8 | Cover for 12 groups: crust (lichen), moss, fern, grass, herb/vine, shrub, tree, palm, mangrove, reed, seagrass, coral |
| `gSpecies[g]` | U8 | Which species represents group g in this patch |
| `seed[g]` | U8 | Seed or spore pressure |
| `nutr` | U8 | Nutrients (guano) |
| `disturb` | U8 | Years since last disturbance |
| `slot[4]` | U8 | Plant slots; high bit = mature, 7 bits = species id |
| `lastYear` | F32 | Year of last update (lets the sweep run at any speed) |

### 5.3 Recomputing fields when terrain changes

- **Local (fast).** `Columns.markChanged` sets patch dirty bits. The next eco slice recomputes `h`, `slope`, `windward`, `sub` and `cliff` for dirty patches only, which is microseconds each.
  - `BURN` sets all covers, seeds, slots and soil to 0 and `disturb = 0` in burned patches, and adds a journal note if notable life was lost.
- **Global (sliced jobs).** These run 2 s after the last terrain change, at most every 3 s, and once at load. Each is a generator on `engine/scheduler.ts` that yields every 1–2 ms:
  1. **Islands:** 8-connected components of patches with `h > 0.2 m` and area ≥ 3 patches.
     - Ids stay stable by overlap matching against the previous labelling: the largest overlap keeps its id, merges keep the older id, splits get new ids.
     - This produces journal events: new island, islands joined, island lost.
  2. **Shore distance:** two-pass chamfer from sea patches.
  3. **Rain:**
     - March each row from the east edge with an air-moisture value `m = 1`.
     - On land: `rain = r0·m·(1 + 8·lift/20m)`, where lift is the height gained over the last 40 m.
     - Above 60 m on the windward side, a "cloud base" bonus grows cloud forest.
     - Air dries by `m −= 0.004·rain` per patch, recovers over the sea, and falling (lee) ground gets a rain-shadow factor.
     - A tall peak ends up with a wet windward side and a dry lee side.
  4. **Ponds and streams:**
     - Priority-flood depression filling over each island's land patches (binary heap, about 20 k patches).
     - A pond forms where the depression is > 0.5 m deep and catchment rain × area exceeds evaporation plus seepage (seepage is high for fresh lava and sand, low for soil and old rock). The water level equals the spill height when inflow allows, otherwise lower.
     - D8 flow accumulation on the filled surface marks streams where `flow·rain > threshold` and `slope > 0`.
     - Output: `ponds[] {id, level, bbox, area}` plus stream bits in cover B's alpha channel.
  5. **Moisture:** `moist = f(rain, flow, near a pond, substrate drainage, canopy retention, −salt)`.
  6. **Shoreline and cliff lists:** columns for storm swash and coast processes; sea-cliff patches for seabird colonies.

### 5.4 Succession sweep (`eco/succession.ts`)

A cursor walks the land and shallow-sea patches (up to about 30 k) within the time slice. Each patch uses `dtY = years − lastYear` (typically 0.1–0.5 years). Per patch:

1. **Capacity per group,** `K_g = Π trapezoid(field; species habitat)`, gated by soil depth:
   - crust needs bare rock above the splash zone;
   - moss: rock or thin soil, moisture ≥ 0.3;
   - ferns: soil ≥ 0.03 m or moist rock cracks;
   - grass: ≥ 0.05 m;
   - shrubs: ≥ 0.15 m;
   - trees: ≥ 0.4 m;
   - palms: sand or soil near the shore, salt-tolerant;
   - mangrove: sheltered shoreline at −0.5 to +0.3 m, stream mouth or low wave exposure;
   - reeds: pond edge;
   - seagrass: sand at −1 to −8 m, calm;
   - coral: −1 to −20 m, not near active lava or a muddy stream mouth.
   - Shade: tree cover reduces the capacity of crust, moss and grass.
2. **Growth:** `cover += r_g·cover·(1 − cover/K_g)·dtY`. If `cover == 0`, `seed[g] > 64` and `K_g > 0`, cover starts at 8.
   - Rates are tuned so that on wet ground, after spores or seeds arrive: crust appears within 3–10 years, moss 10–30, ferns 20–60, grass 40–100, shrubs 80–180, forest 150–350.
   - Dry lee sides are 2–3× slower and top out at dry scrub and grass.
3. **Seed pressure** spreads from neighbours: `seed[g] = max(seed[g]·decay, max over neighbours(cover·disp_g))`. Wind-carried groups spread further per update.
   - When a group first takes hold in a patch, `gSpecies[g]` comes from the strongest neighbour of that group, so species spread in patches with clear fronts.
4. **Soil:**
   `soil += (w_rock·moist·(crust+moss) + organic·(grass+shrub+tree) + guano·nutr − erosion(slope, cover)) · dtY`
   - Typical rates: 0.001 m/yr on bare rock with lichen, up to about 0.01 m/yr under forest, 0.02 m/yr under seabird colonies. Soil is capped at 1.5 m.
   - Written into `Columns.sed` and `soil` with `markChanged(SOIL)`; geometry is re-meshed only past 0.25 m (§3.1).
5. **Slots** (deterministic):
   - The canopy slot is filled when `hash(patch, 0) < cover_tree|palm|mangrove`.
   - The understorey slots come from shrub, fern or tree-fern cover; the ground slot from grass, herb, fern or reed cover.
   - Each slot shows the group's `gSpecies`. The mature bit is set after a per-group maturity time.
   - Only changes are queued as deltas.
6. **Aging:** `rockAge` advances (decades) on exposed rock columns; `disturb++`.

### 5.5 Arrivals, establishment and animals (`eco/arrivals.ts`, `eco/fauna.ts`)

**The catalog** (`content/species.ts`) holds about 45 species, defined as data:

```ts
export interface SpeciesDef {
  id: number; key: string; name: string;
  kind: 'plant' | 'animal' | 'visitor';
  group?: PlantGroup;                 // plants
  model: PlantModel | AnimalModel | null;
  arrival: 'wind' | 'sea' | 'bird' | 'storm';
  carrier?: string;                   // e.g. 'frigatebird' for seeds carried by birds
  baseRate: number;                   // expected arrivals per year at a reference island
  habitat: Habitat;                   // ranges: substrate, soil, moist, elevation, salt, shoreDist, slope, cliff, pond, cover needs
  needs?: string[];                   // species keys that must be established (fig wasp, fig dove, ...)
  spread: number;                     // dispersal strength
  K?: (h: IslandHabitat) => number;   // animals: carrying capacity
  story: { arrive: string[]; fail?: string[]; lost?: string[] }; // template keys
}
```

Example set:
- **Wind:** lichens, mosses, sword fern, tree fern, orchids (need forest), ballooning spiders, moths, dragonflies (need a pond).
- **Sea:** coconut (needs a sand beach), beach morning glory, sea grape, pandanus, mangrove, seagrass, coral larvae, rafting iguana, skink, gecko, hermit and land crabs, green turtle (needs beach plus seagrass).
- **Bird-carried:** fig, flowering tree, berry shrub, grasses and sedges (mud on feet).
- **Birds:** terns (low cays), boobies and tropicbirds (sea cliffs), frigatebirds (shrubs near shore), fruit doves (figs), finches (grass seed), honeycreeper (flowering trees), ducks and herons (ponds), owl (forest plus prey).
- **Mammals:** fruit bats.
- **Visitors (journal only):** passing whales, dolphins, manta at the reef.

**Arrival rolls,** every 0.25 eco-years, per island, for species not yet established there:

`p = baseRate · dtY · area^0.3 · sourceFactor`

- `sourceFactor` is higher for windward islands (nearer the upwind "old islands") and higher still when another island in the zone already has the species (stepping stones).
- During a storm's peak, species arriving by storm get ×6.

**Landing spot by mode:**
- sea: a random shoreline patch, weighted windward;
- wind: weighted by windward exposure;
- bird: a perch (tallest tree or cliff, otherwise the peak).

**Establishment** happens if `suitability(landing patch) ≥ 0.5`. The patch gets that species in its group with cover 24, and a journal "first" entry records the location and slot.

**Failures:** the first failure per species writes a hint entry, e.g. "a coconut washed onto your black rock shore but found no sand to root in". This quietly teaches the player what shapes life needs.

**Animal populations** (per island × species, updated each eco-year):
- Logistic growth toward `K(islandHabitat)`, for example seabirds ∝ sea-cliff patches, turtles ∝ sand beach length × seagrass.
- Flying species disperse between islands.
- Extinction if `K = 0` for 5 years, with a journal "lost" entry ("the ducks left when lava filled the pond").
- **Colonies** `{species, island, x, z, r}` (seabird cliffs, turtle beaches, heron ponds) are sent to the page.

### 5.6 Years-clock geology (`engine/geo/coast.ts`, called from the eco sweep)

- **Calm-year beach building:** move sand from −2 to −4 m back up to the berm on swash columns (undoes storm losses over about 10–20 years).
- **Cliff retreat:** exposed windward rock with `cliff > 4 m` at the sea loses `0.02–0.08 m/yr`, delivered as black sand to the column below the cliff.
- **Reef:** sea patches with coral cover > 50% raise rock as limestone at 0.005 m/yr up to −0.5 m, and add white sand to the nearest leeward beach columns (0.002 m/yr per reef patch). Beaches slowly whiten.
- **Fresh basalt** weathers through `rockAge`.

### 5.7 Storms (`eco/storms.ts`)

**Schedule:**
- No storm in the first 25 years after first land.
- Then one storm per gap drawn from 60–110 eco-years, in the late-summer part of the year.
- At normal pace that is about one storm every 4–7 minutes of play.
- **Squalls** (rain showers crossing the island, light watering only) come every 1–3 real minutes.

**Phases and timing:**
- Gathering, 15 s: clouds and wind rise.
- Peak, 25 s: eco pace × 0.04, heavy rain, waves × 3, surge up to +0.6 m, rare soft thunder.
- Clearing, 15 s: a rainbow arc in the sky shader at sunlit times.

**Effects during the peak, spread over its duration:**
- `coast.stormPulse`
- windward canopy damage: lose `0.3·level·windward·(1 − shelter)` cover
- salt boost
- storm-arrival rolls
- seed scattering, giving larger jumps in spread

The journal writes one summary entry at clearing.

### 5.8 Journal and milestones (`eco/journal.ts`; text from `content/stories.ts`)

```ts
export type JournalKind = 'first-land' | 'new-island' | 'islands-joined' | 'arrival' | 'arrival-failed'
  | 'first-of-group' | 'storm' | 'lost' | 'lava-buried' | 'pond' | 'stream' | 'reef' | 'milestone' | 'visitor';
export interface JournalEntry { id: number; year: number; kind: JournalKind; species?: number; island?: number;
  x?: number; z?: number; patch?: number; slot?: number; params?: Record<string, number | string>; }
```

- **Milestones:** first green, first forest, a living reef, first nesting colony, 10/25/40 species, three islands, a cloud forest.
- **Rate limit:** at most one shown entry per 2 s; the rest wait in a queue.
- **Text** is built page-side by `stories.ts` (template plus parameters), so wording changes never touch the engine.
- **Years appear only in the journal and the life list.** Toasts show the story line without the year.

### 5.9 Messages from the engine to the page

| Message | Content | Rate |
|---|---|---|
| `ground` | Dirty rectangle of the column-resolution RGBA map | ≤ 1 Hz |
| `cover` | Dirty rectangle of cover A and B | ≤ 2 Hz |
| `slots` | `Uint32Array` deltas: `patch<<10 \| slot<<8 \| value` | ≤ 4 Hz |
| `slotsFull` | Full slot array | On ready, load or undo |
| `life` | Islands, ponds, peaks (for cap clouds), animal populations, colonies | On change, ≤ 1 Hz |
| `journal` | New entries | On creation |

---

## 6. Rendering plan and Pixel 7a budgets

### 6.1 Shared world fields (`render/fields.ts`, page)

The page keeps CPU mirrors plus `DataTexture`s. Each frame it uploads only the changed row bands with `texture.addUpdateRange` (three r186 supports row-range uploads):

| Texture | Size and format | Content |
|---|---|---|
| `uHeight` | 512², R half-float (CPU mirror Float32) | Solid surface height. Used by water depth, wave damping, foam, shoreline wetness, plant and animal placement, camera ground. |
| `uGround` | 512², RGBA8 | R: sediment depth (×200, saturates at 1.27 m). G: soil fraction. B: sand kind. A: rock kind × 64 + age. |
| `uCoverA` | 256², RGBA8 | Crust and moss; grass and ferns; shrub and forest floor; beach vines |
| `uCoverB` | 256², RGBA8 | Coral; seagrass; guano; stream or marsh |

**Shared uniforms** (`render/shared.ts`): `uTime`, `uDay`, `uSunDir`, `uSunColor`, `uSkyColor`, `uGroundColor`, `uFogColor`, `uStorm`, `uWind` (direction and strength), `uRain`, `uSurge`, `uNight`, `uCloudShadow`, `uZone` (originX, originZ, sizeX, sizeZ), `uSeaLevel`.

Palette colours become uniforms, not baked GLSL literals, so time of day and storms can tint everything.

### 6.2 Terrain

- **Tiles** (`terrainTiles.ts`, from `sandTiles.ts`): 128 m tiles. The vertex `attrs` become `[ao, 0, 0, 0]`, since all colour comes from textures.
  - Each tile message carries `positions`, `normals`, `attrs`, `indices` and that tile's height patch `{hx0, hz0, hw, hh}` (span sent explicitly; fixes the duplicated-constant bug).
- **Shader** (`terrainMaterial.ts`): Lambert plus `onBeforeCompile`, so shadows and fog come for free.
  1. Steep faces (normal.y < 0.55) are always rock, coloured by rock kind and age: glossy near-black fresh basalt, dark grey-brown old rock, cream limestone.
  2. Flat ground blends rock, then sand (by sand kind: black, golden, white), then soil (by soil fraction), with noise-dithered thresholds for organic edges.
  3. Cover overlays: lichen speckle (grey-green and orange), moss velvet, grass yellow-green, dark forest floor, beach vines, guano streaks on cliffs, glossy stream ribbons. The ribbons animate downhill using the `uHeight` gradient.
  4. Wet darkening within 0.6 m plus surge above sea level.
  5. Underwater: absorption `exp(−d·(0.35, 0.07, 0.03))`, caustics scaled for metres and faded by 12 m, coral and seagrass colours.
  6. Moving cloud-shadow noise.
  7. Detail noise faded with `fwidth` to avoid shimmer at distance.
  8. Debug views under `#debug`: substrate, soil, rain, islands, moisture. These come from an extra debug texture that the engine fills only in debug mode.
- **No terrain LOD in v1.** The budget holds because nothing below −28 m is meshed.
  - **Gated fallback** (WP-C stretch, triggered if the chain fixture shows > 260 k terrain triangles in view or Pixel fps < 40): tiles beyond 450 m get a 2-step mesh (the mesher run at 4 m on averaged columns) plus 4 m skirts hung from boundary vertices to hide cracks.
- **Re-mesh scheduling** (`engine/meshing.ts`):
  - **Priority queue** keyed by distance to the focus point, rebuilt only when the focus moves more than 32 m. This replaces the sort-every-tick.
  - **Tile send throttle:** at most 4 sends per second per tile. A tile is sent when any chunk updated, even if others are still dirty, using their cached meshes. This fixes tile starvation.
  - **Neighbour-dirty band:** use 4 cells (fixes the inherited 3-cell bug).

### 6.3 Lava sheet (`render/lavaSheet.ts`)

- **Mesh:** a dynamic grid over the lava bounding box, stride 1 up to 160 × 160 columns, stride 2 beyond. Only the positions buffer and a heat attribute update, at ≤ 12 Hz. Vertices are interpolated between messages over 80 ms, so flow looks continuous.
- **Edges:** sheet height `= top + L`; columns with `L = 0` sit 0.3 m below the ground, so edges tuck under the terrain.
- **Shader:**
  - Emissive colour from heat: white-yellow, then orange, then red.
  - A crust phase where heat < 0.5: dark with glowing cracks from noise.
  - Flow noise that moves downhill.
  - Not affected by fog at night, so lava glows through the dusk.
- **Light:** one `PointLight` follows the lava centroid. It always exists (intensity 0 when idle) so materials never recompile.

### 6.4 Water

- **Ocean** (`render/ocean.ts`, rewrite of `water.ts`):
  - A 160 × 160 grid (about 51 k triangles) warped from 4 m spacing near the camera target out to 15 km, recentred each frame and snapped to the grid step.
  - Gerstner swell (`waves.ts` code kept): amplitudes 0.25, 0.12 and 0.06 m at wavelengths 70, 34 and 18 m, × `(1 + 2·uStorm)`.
  - Damping and shoaling from `uHeight` (dynamic, so new islands are never swamped by swell).
  - Depth colour: turquoise over white sand (from `uGround` sand kind), darker over coral, deep blue past 25 m. Alpha is fully opaque by 26 m.
  - Shore foam where depth < 1 m, breaker foam on windward shallows under 2 m, crest foam in storms.
  - Sky reflection via uniforms; the camera depth range scales with distance (§6.7).
- **Ponds** (`render/ponds.ts`): one flat mesh per pond over its bounding box at pond level (≤ 8 ponds). The fragment shader discards where `uHeight > level`. Fresh-water tint, ripples, no swell.

### 6.5 Vegetation (`render/vegetation.ts`, `render/models/plants.ts`)

- **Models** (14, each at LOD0 and LOD1), built in code with vertex colours and a sway weight per vertex:
  - coconut palm (from `scenery.ts`), fig, lowland broadleaf, flowering tree, cloud-forest tree, pandanus, mangrove, tree fern;
  - sea-grape shrub, berry shrub;
  - fern clump, grass tuft (from `scenery.ts`), reeds, beach-vine mound.
  - LOD0: 60–160 triangles for trees, 20–60 for small plants. LOD1: 12–30 triangles.
- **Instances:** one `InstancedMesh` per model and LOD. Per-instance attributes:
  - `aBorn`, `aDie` (real-time seconds);
  - `aSeed` (colour jitter and sway phase);
  - `aMature` (scale 0.6 → 1.0, with a soft half-second grow when the mature bit flips).
- **Positions:** `patchCenter + jitter(hash(patch, slot)) ± 1.6 m`; y comes from the height mirror; rotation and scale from the hash.
- **Distance tiers** per 64 m plant tile, measured from the camera:
  - under 70 m: all slots, LOD0;
  - 70–160 m: canopy and understorey, LOD0;
  - 160–450 m: canopy only, LOD1;
  - beyond 450 m: none; the cover texture carries the green.
- **Adaptive density:** if instance triangles exceed the budget, the tier distances shrink by 10% per second until back under budget.
- **Rebuild:** instance buffers are rebuilt at ≤ 4 Hz when the camera crosses a tile tier or slots change. That is about 0.5 ms for 6 k instances.
- **Pop-in:** `scale = easeOutBack(clamp((uTime − aBorn)/1.2))`; the crown lags the trunk by 0.25 s.
  - Births in one delta are spread across 0–2 s by hash, so a spreading forest ripples instead of blinking.
  - Death: lava means quick blacken and collapse (0.8 s); storm means tilt and fall (1.5 s); other causes shrink and sink (2 s).
  - A soft pop sound plays for at most 3 per second, and only within 120 m of the camera.
- **Sway** runs on real `uTime` and `uWind` × (1 + 3·uStorm).
- **Arrival vignettes** (when within view): a coconut bobbing ashore (the floater from `BoatMotion`), a rafting log with an iguana, a bird gliding in to perch, a shimmer of spores on the wind.

### 6.6 Animals (`render/fauna.ts`, `render/models/animals.ts`)

- **Agents** live only within 250 m of the camera; seabirds and frigatebirds out to 600 m. Caps: 40 flying, 40 ground, 12 water, 200 in total.
- **Count per species** = `min(cap, population · visibilityFactor)` for the islands in view.
- **Spawning:** agents spawn and despawn out of view (behind the camera or beyond fog) and never teleport while visible.
- **Behaviours** (state machines with pauses) and real-life speeds:

| Behaviour | Speed |
|---|---|
| Seabirds circling colonies | 8–12 m/s glides, flapping in short bouts |
| Frigatebirds soaring | 6 m/s |
| Small birds hopping between tree instances | 3–6 m/s flight |
| Crabs | 0.2 m/s with long pauses |
| Lizards basking or walking | 0.1–0.5 m/s |
| Turtles crawling up beaches at night | 0.05 m/s |
| Ducks paddling | 0.3 m/s |
| Fish schools over reef | below the water surface |
| Bats | at dusk |
| Whales and dolphins | surfacing offshore (visitors) |

- **Animation:** in the vertex shader, from weight attributes (wings, legs, tail) and a per-instance phase.
- **Models:** 150–400 triangles each. All are instanced; about 10 draw calls.

### 6.7 Sky, clouds, weather and effects (`render/sky.ts`, `clouds.ts`, `weather.ts`, `timeOfDay.ts`, `render/effects.ts`)

- **Sky:** gradient dome that follows the camera, sun and moon discs, stars (≤ 1,500 points) at night, rainbow after storms.
- **Day cycle:** 14 real minutes, of which 3 are night. Moonlight reuses the directional light with a cool tint.
- **Clouds:** instanced puffs (≤ 200 × 80 triangles).
  - Trade cumulus at 350 m drifting west.
  - Cap clouds over peaks above 60 m (from `life.peaks`).
  - A storm deck that thickens with `uStorm`.
  - Clouds fade near the camera.
- **Rain:** instanced streaks in a box around the camera (≤ 2,500 quads).
- **Squalls:** a moving translucent rain shaft.
- **Lightning:** a rare jagged line plus a sky flash.
- **Particles:** steam puffs, sand stream, lava spatter and dust as procedural soft points (≤ 600, ≤ 400, ≤ 300 and ≤ 200), with fog applied (fixes the inherited no-fog bug).
- **Camera depth:**
  - `near = max(0.5, dist·0.004)`, `far = 16 km`.
  - Fog starts at `0.8·dist + 400` and ends 6 km further on.
- **Shadows:**
  - The box follows the focus, half-size `clamp(0.8·dist, 40, 350)` m, sun 600 m back, snapped to texels.
  - Map size 2048 on laptop, 1536 on phone.
  - Vegetation and animals cast shadows. Terrain casts only on "pretty" quality.
- **Precompile:** shaders are compiled during the loading screen with `renderer.compileAsync(scene, camera)`, with dummy instances of every material, to avoid first-use hitches on Mali GPUs.

### 6.8 Budgets (main pass on Pixel 7a; laptop gets 1.5×)

| Item | Draw calls | Triangles |
|---|---|---|
| Terrain tiles in view | ≤ 30 | ≤ 250 k |
| Lava sheet | ≤ 2 | ≤ 50 k |
| Ocean | 1 | 51 k |
| Ponds | ≤ 8 | ≤ 4 k |
| Vegetation | ≤ 28 | ≤ 200 k |
| Animals | ≤ 12 | ≤ 30 k |
| Sky, stars, clouds | ≤ 5 | ≤ 20 k |
| Effects and cursor | ≤ 7 | ≤ 10 k |
| **Main total** | **≤ 90** | **≤ 600 k** |
| Shadow pass | ≤ 30 | ≤ 180 k |

- **Pixel ratio cap:** 1.6 (auto) on touch devices, 2 on laptop.
- **Auto-quality** lowers the pixel ratio after 3 s below 40 fps, then shadows. Unlike the inherited version, it can raise them again after 20 s above 55 fps.
- **Frame-time targets:** steady 60 fps on laptop. On Pixel 7a, 45–60 fps while idle and watching, ≥ 30 fps during a big lava pour.

---

## 7. Time

| Clock | Drives | Rate | Saved |
|---|---|---|---|
| Frame time | Rendering, sway, waves, animals, particles, audio | Real | No |
| Day clock | Sun, moon, sky colours, insects by day, frogs at night, turtles at night | 14 min per day | `dayPhase` |
| Physics time | Lava, sand, tools, storm surf | Real; fixed 1/30 s step; ≤ 2 steps per tick; slows under load | Molten lava saved as is and resumes |
| Eco years | Soil, succession, arrivals, animal populations, coast, reef, storm schedule | Gentle 0.15, **normal 0.25**, swift 0.5 years/s (menu "Pace of years"); × 0.04 at storm peak | `years`, RNG, storm state |

- **Years start at 0 at first land** (the first island component). Before that the clock is frozen at 0.
- **dt limits:** eco-time dt is clamped (`realDt ≤ 0.25 s`), so a stall never jumps decades.
- **Closed or hidden:** everything pauses. `visibilitychange` sends `{t:'pause', on}`, and the worker loop idles. There is no offline progress: the island is exactly as you left it, which is calm and predictable.
- **Debug hook:** `__game.advanceYears(n)` runs the eco sweep synchronously in slices, showing progress. It is used by checks, screenshots and the simulator.

---

## 8. Module plan and work packages

### 8.1 Files in `isles/`

**Copied with changes from `sandcastle-cays/`:**

| File | Treatment |
|---|---|
| `build.mjs` | Output name `isles-v<ver>.html`; optional: one engine bundle for both worker and fallback (saves about 200 KB) |
| `package.json`, `tsconfig.json` | Same pins; name changed |
| `engine/host.ts`, `engine/worker.ts` | Budgets; worker-crash fallback to page mode |
| `engine/noise.ts` | Add hash-based value noise with no 256 period |
| `engine/mesher.ts` | Reads `VoxelSource.sampleFill`; wet/pack averaging removed; attrs = `[ao, 0, 0, 0]`; reused Float32 scratch buffers |
| `storage/storage.ts` | DB `isles-v1`; A/B autosave slots compared by timestamp; save timeouts |
| `ui/icons.ts` | New icons: lava, sand, rock, lower, smooth, journal, life list, eye (watch mode) |
| `render/waves.ts` | Ocean swell wave set |
| `render/terrainTiles.ts` | From `sandTiles.ts` |
| `render/models/plants.ts` | Starts from `scenery.ts` palm, frond, bush, grass tuft, `withSway`, `mergeWithSway`, `paint` |
| `render/geomUtil.ts` | `mergeGeometries`, `mergeMeshes`, `axisCoords`, `boulder` |
| `input/controls.ts`, `input/camera.ts` | New gestures and camera (§8.3 WP-H) |
| `ui/ui.ts`, `src/index.html` | Shell kept; content new |
| `audio/audio.ts` | Core kept (context, master, noise buffers, loop, grain) |
| `e2e/*.mjs` | Harness kept; scenarios new |

**New files:** listed by owning work package in §8.3. The game does not carry over `world.ts`, `sim.ts`, `material.ts`, `terrain.ts`, `tools.ts` (`Hand`), `boat.ts`, `sandMaterial.ts`, the lagoon `scenery.ts` layouts or `sandChecks.ts`.

### 8.2 Contract files the lead writes first (WP0)

```ts
// src/config.ts — constants in §1.1; plus
export type ToolId = 'lava' | 'sand' | 'rock' | 'lower' | 'smooth';
export const BRUSH_K = [0.035, 0.07, 0.13] as const;
export const PACE_YPS = { gentle: 0.15, normal: 0.25, swift: 0.5 } as const;

// src/engine/columns.ts — implemented in full by the lead (small; everyone depends on it)
export const enum Change { GEOM = 1, LOOK = 2, BURN = 4, SOIL = 8 }
export class Columns implements VoxelSource {
  readonly nx: number; readonly nz: number;
  rock: Float32Array; sed: Float32Array; soil: Float32Array; lava: Float32Array; temp: Float32Array;
  sandKind: Uint8Array; rockKind: Uint8Array; rockAge: Uint8Array; meshedTop: Float32Array;
  beforeModify: ((block: number) => void) | null;
  onChange: ((i0: number, k0: number, i1: number, k1: number, flags: number) => void) | null;
  index(i: number, k: number): number;
  top(c: number): number; surface(c: number): number;
  touch(c: number): void;                          // calls beforeModify for its 16x16 block once per record
  markChanged(i0: number, k0: number, i1: number, k1: number, flags: number): void;
  heightAtWorld(x: number, z: number): number;     // bilinear on top()
  sampleFill(i0: number, j0: number, k0: number, sx: number, sy: number, sz: number, out: Uint8Array): void;
  groundRGBA(i0: number, k0: number, w: number, h: number, out: Uint8Array): void; // §6.1 layout
}

// src/eco/patches.ts — data only (arrays from §5.2, index helpers, patchOfColumn, columnsOfPatch)
export class PatchGrid { /* typed arrays; readonly n = 256 */ }

// src/engine/protocol.ts
export type ToEngine =
 | { t: 'init'; save: ArrayBuffer | null; seed: number }
 | { t: 'stroke'; phase: 'start' | 'move' | 'end' | 'cancel'; tool: ToolId; x: number; z: number; radius: number }
 | { t: 'focus'; x: number; y: number; z: number; dist: number }
 | { t: 'undo' } | { t: 'pause'; on: boolean } | { t: 'pace'; pace: keyof typeof PACE_YPS }
 | { t: 'save'; seq: number; header: { camera: number[]; dayPhase: number } }
 | { t: 'load'; save: ArrayBuffer } | { t: 'reset'; seed: number }
 | { t: 'checks'; ids?: string[] }
 | { t: 'debug'; op: 'advanceYears' | 'storm' | 'stats' | 'hash'; years?: number };
export type FromEngine =
 | { t: 'hello' } | { t: 'progress'; done: number; total: number }
 | { t: 'ready'; year: number; firstLand: boolean }
 | { t: 'tile'; tile: number; version: number; positions: Float32Array; normals: Int8Array; attrs: Uint8Array;
     indices: Uint32Array; hx0: number; hz0: number; hw: number; hh: number; heights: Float32Array }
 | { t: 'ground'; x0: number; z0: number; w: number; h: number; rgba: Uint8Array }
 | { t: 'lava'; x0: number; z0: number; w: number; h: number; stride: 1 | 2; surf: Float32Array; heat: Uint8Array } | { t: 'lavaNone' }
 | { t: 'cover'; x0: number; z0: number; w: number; h: number; a: Uint8Array; b: Uint8Array }
 | { t: 'slots'; deltas: Uint32Array } | { t: 'slotsFull'; slots: Uint8Array }
 | { t: 'life'; islands: IslandInfo[]; ponds: PondInfo[]; peaks: PeakInfo[]; pops: FaunaPop[]; colonies: Colony[] }
 | { t: 'journal'; entries: JournalEntry[]; reset?: boolean }
 | { t: 'tick'; year: number; storm: StormState; events: TickEvents; undo: number; perf: PerfStats }
 | { t: 'saved'; seq: number; data: ArrayBuffer | null; error?: string }
 | { t: 'loaded'; ok: boolean; error?: string; camera?: number[]; dayPhase?: number }
 | { t: 'checks'; results: CheckResult[] } | { t: 'debugResult'; data: unknown }
 | { t: 'error'; message: string; context?: string };
export interface StormState { phase: 'none' | 'gathering' | 'peak' | 'clearing'; level: number; rain: number;
  squall: { x: number; z: number; r: number } | null }
export interface TickEvents { steam: Float32Array; pour: { tool: ToolId; x: number; y: number; z: number; r: number } | null;
  rumble: number; hiss: number; arrivals: { species: number; x: number; z: number; mode: string }[]; births: number }
export interface IslandInfo { id: number; area: number; peak: [number, number, number]; centroid: [number, number]; founded: number }

// src/content/species.ts — types + id/key/model list (data filled by WP-D)
export enum PlantModel { Palm, Fig, Broadleaf, Flowering, CloudTree, Pandanus, Mangrove, TreeFern,
  SeaGrape, BerryShrub, Fern, Grass, Reeds, Vine }
export enum AnimalModel { Seabird, Frigate, Tern, SmallBird, Duck, Heron, Bat, Turtle, Crab, Lizard, Iguana,
  Fish, Dolphin, Whale, Dragonfly }

// src/render/shared.ts — WorldUniforms (names in §6.1), WorldFields, page-system lifecycle
export interface FrameCtx { t: number; dt: number; camera: THREE.PerspectiveCamera; cam: OrbitCamera;
  fields: WorldFields; u: WorldUniforms; quality: 'fast' | 'auto' | 'pretty'; storm: StormState; year: number }
export interface PageSystem { onEngine?(m: FromEngine): void; update(f: FrameCtx): void }
export class WorldFields {
  heights: Float32Array; ground: Uint8Array; coverA: Uint8Array; coverB: Uint8Array; slots: Uint8Array;
  heightTex: THREE.DataTexture; groundTex: THREE.DataTexture; coverATex: THREE.DataTexture; coverBTex: THREE.DataTexture;
  apply(m: FromEngine): void;                         // tile heights / ground / cover / slots(+Full)
  heightAt(x: number, z: number): number; coverAt(x: number, z: number, ch: number): number;
  flush(): void;                                      // row-range uploads, once per frame
  onSlotDeltas: ((deltas: Uint32Array) => void) | null;
}

// src/shared/heightRay.ts
export function heightRay(h: Float32Array, nx: number, nz: number, cell: number, ox: number, oz: number,
  o: Vec3, d: Vec3, maxDist: number): { x: number; y: number; z: number; t: number } | null;

// src/checks/registry.ts — each work package registers its checks; vitest and the in-game page run the registry
export function registerChecks(group: string, checks: CheckDef[]): void;
```

**The lead also delivers:**
- **Scaffold and stubs:** a scaffold that builds, an `engine.ts` skeleton that calls stub `Geo`, `Ecology` and `MeshScheduler`, and a `main.ts` skeleton that creates every `PageSystem` (stub files in each package's folder) and routes messages.
- **Docs:** `README.md`, `docs/PLAN.md`, `docs/DECISIONS.md`, `docs/CHANGELOG.md`.
- **Test runner:** `tests/registry.test.ts`.

Each package then edits only its own files. `main.ts` already calls their `update` and `onEngine`.

### 8.3 Parallel work packages

#### WP-B: Geology and tools (worker)

**Files:**
- `engine/seabed.ts`
- `engine/geo/geo.ts`, `geo/sand.ts`, `geo/lava.ts`, `geo/tools.ts`, `geo/coast.ts`
- `checks/geoChecks.ts`, `tests/geo.test.ts`

**Provides:**

```ts
export function generateSeabed(cols: Columns, seed: number): void;
export class Geo {
  constructor(cols: Columns, rng: () => number);
  applyTool(tool: ToolId, x: number, z: number, radius: number, dt: number): void;
  step(dt: number, budgetMs: number): { lavaCols: number; sandCols: number; ms: number };
  readonly steam: Float32Array; steamCount: number;
  setSurf(level: number): void;                 // 0 calm … 1 storm peak; widens swash band
  wakeColumns(list: Int32Array, n: number): void;
  lavaSheet(): { x0: number; z0: number; w: number; h: number; stride: 1 | 2; surf: Float32Array; heat: Uint8Array } | null;
  isSettled(): boolean;                         // used to close undo records
  coastYears(dtYears: number, shoreline: Int32Array, n: number, reef: PatchGrid): void;
  stormPulse(level: number, dt: number, shoreline: Int32Array, n: number): void;
}
```

**Checks:**
- lava runs downhill and spreads;
- on a 10° slope lava runs ≥ 3× further than poured sand spreads;
- a 1 m sheet freezes in 3–10 s and a 5 m lobe in 10–30 s;
- lava entering the sea freezes in < 2 s with steam > 0, and 25–35% of its volume becomes black sand;
- a 30 m rock cliff is unchanged after 600 steps;
- dry sand angle 30–37°, underwater 24–31°;
- sand poured at the shore forms a face ≤ 12° within 60 s;
- sliding conserves volume to 1e-4;
- caps hold at 150 m and −30 m;
- lava freezing over sand buries it into rock;
- speed: 10 k active lava columns ≤ 2 ms per step and 20 k sand columns ≤ 1.5 ms (desktop).

#### WP-C: Engine hub, meshing, save and undo

**Files:**
- `engine/engine.ts`, `engine/scheduler.ts`
- `engine/mesher.ts`, `engine/meshing.ts`
- `engine/undo.ts`, `engine/save.ts`
- `engine/host.ts`, `engine/worker.ts`
- `checks/engineChecks.ts`, `tests/engine.test.ts`

**Provides:**

```ts
export class Engine {
  constructor(post: (m: FromEngine, transfer?: Transferable[]) => void);
  handle(m: ToEngine): void; tick(dt: number, budgetMs: number): void;
  setPageMode(on: boolean): void; get isReady(): boolean;
}
export class MeshScheduler {
  constructor(cols: Columns);
  markDirty(i0: number, k0: number, i1: number, k1: number): void;
  setFocus(x: number, z: number): void;
  work(budgetMs: number): void;
  takeTiles(out: FromEngine[]): void;
}
export class UndoStack {
  constructor(cols: Columns, grid: PatchGrid);
  begin(): void; noteSettled(): void; close(): void; undo(): Rect[]; get count(): number;
}
export function encodeSave(cols: Columns, grid: PatchGrid, eco: EcoSave, header: SaveHeader): Promise<ArrayBuffer>;
export function decodeSave(buf: ArrayBuffer): Promise<{ cols: Columns; grid: PatchGrid; eco: EcoSave; header: SaveHeader }>;
export function* job(...): Generator<void>;  // scheduler.run(jobs, budgetMs)
```

**Tick order:**
1. Input.
2. `geo.step`.
3. Eco clock and `eco.work`.
4. Scheduler jobs.
5. Meshing.
6. Throttled sends.

**Checks:**
- mesh-closed on synthetic heightfields (cone, cliff, ridge, island);
- no chunks meshed below −28 m;
- meshing ≤ 0.6 ms per chunk (desktop);
- undo is exact, by hash of columns and patches after a stroke plus settling;
- ecology writes made after a record closes are not undone;
- save → load → save is byte-identical;
- a truncated or garbage save leaves the game working;
- continuous lava still produces tile updates at ≥ 2 Hz;
- the tick never exceeds its budget + 4 ms on the bench scene.

#### WP-D: Ecology and content

**Files:**
- `eco/ecology.ts`, `eco/derive.ts`, `eco/succession.ts`, `eco/arrivals.ts`, `eco/fauna.ts`, `eco/storms.ts`, `eco/journal.ts`
- `content/species.ts` (data), `content/stories.ts`
- `tools/simulate.mjs`
- `checks/ecoChecks.ts`, `tests/eco.test.ts`

**Provides:**

```ts
export interface EcoSave { years: number; firstLandAt: number | null; rng: number[]; storm: unknown;
  species: unknown; islands: unknown; journal: JournalEntry[]; fauna: Uint16Array }
export class Ecology {
  constructor(cols: Columns, grid: PatchGrid, geo: Pick<Geo, 'coastYears' | 'stormPulse' | 'setSurf' | 'wakeColumns'>, seed: number);
  years: number; readonly storm: StormState;
  onTerrainChanged(i0: number, k0: number, i1: number, k1: number, flags: number): void;
  advance(realDt: number, yps: number): void;   // clock only
  work(budgetMs: number): void;                  // sliced sweep + derive jobs + events
  takeMessages(out: FromEngine[]): void;
  serialize(): EcoSave; restore(s: EcoSave): void;
  debugAdvance(years: number): void;
}
export function entryText(e: JournalEntry, species: SpeciesDef[]): string;  // content/stories.ts, page side
```

**Checks:**
- succession order on a bare-rock test island (crust before moss before fern before grass before shrub before tree);
- no trees where soil is under 0.4 m;
- rain shadow: an 80 m peak gives windward moisture ≥ 1.8× leeward;
- a pond is detected in a crater with a rim;
- island ids stay stable across small edits; merge and split are handled;
- arrivals are deterministic for a given seed;
- a coconut on a rock-only shore fails and writes one hint entry;
- seabirds establish only with sea cliffs;
- lava burial resets cover;
- a storm costs windward cover > 2× leeward;
- animal populations follow capacity;
- each species gets exactly one "first" entry;
- the ecology slice stays ≤ 2.5 ms and a full recompute ≤ 20 ms (desktop).

`tools/simulate.mjs` builds a three-island chain by script, runs 1,500 years headless, prints a timeline (year, species, cover stats) for tuning, and writes the fixture `e2e/fixtures/chain.isle`.

#### WP-E: Ground and water rendering

**Files:**
- `render/fields.ts` (implements the lead's contract)
- `render/terrainTiles.ts`, `render/terrainMaterial.ts`
- `render/lavaSheet.ts`
- `render/ocean.ts`, `render/waves.ts`, `render/ponds.ts`
- `render/effects.ts`, `render/colors.ts`

**Provides `PageSystem`s:** `TerrainSystem`, `LavaSystem`, `OceanSystem`, `PondSystem`, `EffectsSystem` (consumes `tick.events.steam` and `pour`).

**Tests:** CPU and GPU wave heights match; row-range coalescing in fields; a `#stress` scene with synthetic full-chain heights; screenshot set.

#### WP-F: Life rendering

**Files:**
- `render/models/plants.ts`, `render/models/animals.ts`, `render/geomUtil.ts`
- `render/vegetation.ts`, `render/fauna.ts`, `render/vignettes.ts`

**Provides:** `VegetationSystem` (slots to instances: tiers, pop-in, death, sway), `FaunaSystem` (agents from `life.pops` and `colonies`), `VignetteSystem` (arrival scenes).

**Tests:**
- slot-to-instance placement is deterministic;
- per-model triangle limits (LOD0 ≤ 160, LOD1 ≤ 30);
- agents never leave their habitat mask and speeds stay within the table in §6.6;
- a `#gallery` debug scene shows every model and animal.

#### WP-G: Sky, weather, day cycle and sound

**Files:**
- `render/timeOfDay.ts` (owns `WorldUniforms` updates and the lights), `render/sky.ts`, `render/clouds.ts`, `render/weather.ts`
- `audio/audio.ts`, `audio/soundscape.ts`, `audio/voices.ts`

**Soundscape layers:**
- wind (by height and storm);
- surf (by camera distance to shore, from the height mirror);
- insects (by nearby cover and daytime);
- birdsong from FM chirps seeded per species, scaled by nearby bird population;
- frogs at night when ponds and frogs are present;
- seabird calls near colonies;
- rain and soft thunder;
- lava hiss and rumble, steam;
- a soft pop when plants are born.

**Tests:** pure functions only: day colours are continuous, storm phases map to uniforms, layer gains are monotonic in their inputs.

#### WP-H: Shell (camera, controls, UI, journal, storage, checks page, browser checks)

**Owns:**
- `main.ts` (after WP0)
- `render/scene.ts` (renderer, quality, shadow box, fog and near/far), `render/cursor.ts`
- `input/camera.ts`, `input/controls.ts`
- `ui/ui.ts`, `ui/journal.ts`, `ui/lifeList.ts`, `ui/icons.ts`, `index.html`
- `storage/storage.ts`
- `e2e/browser-check.mjs`, `e2e/look.mjs`

**Controls:**
- Touch:
  - one finger uses the tool;
  - two-finger drag pans;
  - pinch zooms toward the fingers;
  - two-finger twist orbits;
  - pitch follows zoom (top-down when far, low and cinematic when near), and a three-finger drag adjusts tilt.
- Trackpad and mouse:
  - click-hold uses the tool;
  - two-finger swipe pans;
  - pinch or the wheel zooms toward the pointer;
  - right-drag orbits and tilts;
  - keys: WASD pans, Q/E orbits, R/F tilts, 1–5 pick tools, `[` `]` change size, Ctrl+Z undoes.

**Camera:** distance 12–1,600 m. A sight-line check lifts the camera when terrain blocks the view. "Watch" mode fades the UI and slowly orbits the island. Tapping a journal entry glides the camera to its location.

**UI:**
- Tool tray: Lava, Sand, Rock, Lower, Smooth, plus size.
- Journal panel with years and pages, and a life list with SVG silhouettes drawn in code.
- Menu: pace of years, sound, quality, save and load file, new world, help, checks.

**Autosave:** every 60 s while years are running, plus on hide and at milestones. Waiters time out after 10 s and reject on `error`.

**`__game` hooks:** `ready`, `stats()` (triangles and draw calls by category), `advanceYears`, `islands`, `journal`, `pour(tool, x, z, s)`, `camera`, `project`, `syncHash()`, `perf`.

**Tests:** gesture classification on synthetic pointer sequences; the e2e scenarios in §9.

### 8.4 Integration order

1. **WP0**, by the lead, first: contracts, scaffold, flat sea that boots, test registry.
2. **WP-B through WP-H** in parallel against stubs.
3. **Integration 1, "Land from the sea":** B, C, E and H, plus a Pixel stress build sent to the owner as a performance probe. That build must include the in-game fps check.
4. **Integration 2, "Life arrives":** D and F.
5. **Integration 3, "Storms, sound and night":** G, plus D's storms.
6. **Integration 4:** tuning with `simulate.mjs`, performance passes, then the owner build saved in `builds/` with CHANGELOG notes and the checks run (per CLAUDE.md).

---

## 9. Testing

**Vitest** runs every registered check (geology, engine, ecology, rendering helpers, controls), seeded and deterministic. Speed targets, measured on desktop in this container:

| Measure | Target |
|---|---|
| Lava step, 10 k active columns | ≤ 2 ms |
| Sand step, 20 k active columns | ≤ 1.5 ms |
| Mesh one chunk | ≤ 0.6 ms |
| Ecology slice | ≤ 2.5 ms |
| Full recompute | ≤ 20 ms (sliced) |
| Encode chain save | ≤ 200 ms |
| Decode | ≤ 300 ms |
| Ready from cold | ≤ 2 s |

**In-game checks page:**
- WebGL2, worker or page mode, storage round trip (writes 1 MB, not 8 bytes);
- a fast subset of geology and ecology checks;
- an fps sample on the owner's own device: ≥ 28 to pass, reported plainly;
- GPU name when available;
- triangle counts against budgets.

**Browser checks** (`e2e/browser-check.mjs`, Playwright with SwiftShader):

1. **Laptop 1280 × 760:**
   - pour lava at the central knoll until `__game.islands.length ≥ 1`;
   - wait for no lava;
   - `advanceYears(300)`, then expect slots > 0 and journal ≥ 3;
   - sand, rock, lower and smooth each change heights;
   - undo restores `syncHash`;
   - a trackpad swipe pans without editing;
   - save, reload, and confirm `year`, `islands` and `syncHash` match. This fixes the old test that only checked the button text.
2. **Pixel-sized profile (412 × 915, DPR 2.625, touch):**
   - one-finger pour;
   - two-finger pan and pinch never edit (heights unchanged);
   - twist orbits;
   - journal opens, and tapping an entry glides the camera.
3. **`#noworker` with 4× CPU throttle** on the chain fixture:
   - pour lava for 20 s while sampling `perf`;
   - no engine work exceeds 12 ms per frame;
   - ready ≤ 8 s.
4. **Budget scenario:** load `chain.isle`, visit 6 camera poses, and assert `stats()` against §6.8.

**Screenshot reviews** (`e2e/look.mjs`, reviewed against a written checklist each integration):
- open sea at the start;
- first island steaming;
- the island after 300 years: green on the windward side, dry lee;
- the chain from above at noon;
- storm peak;
- night with lava glow and stars;
- close-up of a beach with crabs and palms;
- the reef through the water.

**Not testable here:** real Pixel and laptop GPU frame rate, phone storage on `file://` versus `content://`, and the feel of the gestures. These are covered by early owner test builds and the in-game checks page, and stated plainly in every delivery note.

---

## 10. Risks and how to reduce them early

| Risk | Mitigation |
|---|---|
| Pixel GPU cost (water covering the screen, multi-texture terrain, shadows) | Pixel stress build at Integration 1, using synthetic full-chain heights plus maximum vegetation; quality tiers; adaptive plant density; terrain shadow-casting off on phone; gated terrain LOD (§6.2) |
| Ecology too slow, too fast or unreadable | `simulate.mjs` timelines before visuals; species stored as data; failure hints in the journal; `#debug` field views; "Pace of years" setting |
| Lava feels wrong (too runny or too stiff) or re-meshing flickers | Separate lava sheet with interpolation; tuning constants in one table; run-out and freeze-time checks; early lava-only build |
| Re-mesh and upload hitches during big pours | Re-mesh thresholds; tile throttle; focus-ordered priority queue; throttled `#noworker` performance test |
| Gesture conflicts (pan / orbit / tool) on phone and trackpad | Familiar map-app mapping; gesture unit tests; owner tries the stress build early |
| Page mirrors drift from engine state (slots, cover, heights) | Versioned messages; full resync after ready, load and undo; `syncHash()` e2e comparison |
| Damaged saves, storage collisions with the sandcastle game, phone storage | Decode-then-swap; A/B autosave slots with timestamps; storage id `isles-v1`; file save always available; fixture saves from every release kept in tests |
| Heightfield cannot do arches or caves | Accepted and recorded in DECISIONS.md; a two-span-column extension is possible later without a format break (new save section) |
| Shader compile hitches on Mali | `compileAsync` during loading with every material warmed; fixed light count |
| Worker refused on Android `file://` | Page fallback with smaller budgets, verified by the throttled `#noworker` run |
| Scope (a full game, not a demo) | A frozen contract and 8 packages in parallel; species content held as data so it grows without code changes; internal integrations each end in a playable build |

### Inherited bugs fixed by design

| Inherited bug | Fix in this design |
|---|---|
| Failed load breaks the engine | Decode into a temporary world, swap only on success |
| Undo records never close at stroke end | Records close on settle (≤ 40 s); natural processes never recorded |
| Tile starvation under continuous activity | Throttled sends using cached meshes |
| Meshing sorts every dirty chunk every tick | Focus priority queue, rebuilt only when the focus moves |
| Neighbour-dirty band one cell short | 4-cell band |
| Water depth map offset by half a cell | Height map at column resolution, aligned to cell centres |
| Wave damping ignores the editable area | Dynamic damping from `uHeight` |
| Hard-coded tile span (32) | Span carried in the tile message |
| Particles ignore fog | Fog applied to all effects |
| Autosave waiters can hang and switch saving off | Timeouts and rejection on `error` |
| Autosave runs only after edits | Autosave on time while years run |
| False "resumed" message after a failed load | `ready` reports what actually loaded |
| Auto-quality only ever lowers itself | Recovers after 20 s above 55 fps |
| Distant ground picking fails beyond 60 m | Shared heightfield raycast with zone-wide reach |
| Camera assumes a flat world | Sight-line lift |
| No recovery from a worker crash | Falls back to page mode |
| Shared storage names across games | Unique storage id `isles-v1` |