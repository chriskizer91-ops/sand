# Feasibility review: island game on Pixel 7a and laptop, single HTML file

## Bottom line

The game can be built on a Pixel 7a, but not from these four designs as they are written. Three things block it:

1. **The designs contradict each other** on almost every number that sets cost: cell size, zone size, years per second, plant triangle counts, camera range and caves.
2. **The god view has no budget.** The architecture removes terrain level-of-detail (LOD) "for v1". The art design's plant models are 5–10× heavier than the architecture allows.
3. **The ecology numbers won't hold up as written.** Byte-sized accumulators stall, simple step-by-step growth overshoots when the time step is large, and the determinism claims don't fit time-sliced work.

Most per-frame CPU estimates are fine. Two areas aren't: the mesher costs about 2× what the plan assumes, and the plan never accounts for Android putting the worker on a slow core or the phone slowing down as it heats up.

**There is no Pixel data at all yet.** CHANGELOG v0.1 says "Speed on a real Pixel is not measured yet." Every "Pixel ≈ 3× desktop" figure in the designs is a guess.

---

## 1. What I measured in the existing code

- **Mesher cost.** I ran `src/engine/mesher.ts` unchanged on a synthetic 2.5D column heightfield (a cone with a cliff ring, filled the way `Columns.sampleFill` proposes). Scratch bench: `/tmp/claude-0/-home-user-sand/1f8d55eb-7be6-5932-9ec2-19ccc14b5cae/scratchpad/bench/bench.ts`.
  - **0.52–0.64 ms per chunk that has a surface, and 0.20–0.24 ms per chunk with no surface,** on this container's desktop-class CPU. Sampling the fill is only 0.05 ms of that; the 22³ distance-field and blur passes plus the ambient-occlusion (AO) samples are the cost.
  - **About 2.95 triangles per column** on varied terrain, against the architecture's 2.2 measured on the flat lagoon.
  - The architecture assumes 0.25 ms per chunk on desktop and about 1 ms on a Pixel, and its own check asks for ≤ 0.6 ms. That check would barely pass today. A realistic sustained Pixel figure is **2.5–4 ms per surface chunk**.
- **Allocation churn in the inherited code** (garbage-collection pressure, on the hot path):
  - `sendTick` allocates a new `Float32Array` every tick.
  - `meshSome` does `Array.from(dirty)` plus a new `Map` plus a sort every tick.
  - `mergeMeshes` allocates new arrays per tile.
  - `SandTiles.update` creates a new `BufferGeometry` per tile update, which means a full GPU buffer reallocation.
  - Each `meshChunk` call allocates four `Float32Array(8)`.
  - The architecture fixes the sort, but not the geometry reallocation or the other allocations.
- **Water.** It is transparent with `depthWrite:false`, a 200×200 grid (80k triangles), and an ALU-heavy fragment shader: 6 trig ripples, `pow`, and 2 value noises at 4 `sin`-hashes each. It draws over terrain that has already been fully shaded, and that terrain shader runs the 4-iteration `sc_caustics` loop underwater.
- **three r186 details:**
  - `PCFSoftShadowMap` has been removed and silently falls back to `PCFShadowMap` (see `WebGLShadowMap.js:99`).
  - `Texture.addUpdateRange` exists, so uploading only changed rows is real.
  - `main.ts` turns shadows off at runtime with `renderer.shadowMap.enabled = false`. That changes every program's cache key and triggers a recompile storm on Mali, which is exactly the moment the device is already struggling.

## 2. Settle these numbers before WP0

The designs disagree as follows. Every package's budget depends on these, so they have to be one table in WP0 and DECISIONS.md.

| Quantity | Ecology | Player experience | Look | Architecture | Recommend |
|---|---|---|---|---|---|
| Cell size | n/a | ~1 m | 0.5–1 m | 2 m | **2 m** (1 m is 4× the terrain and simulation cost) |
| Zone | 10 km (life reckoning) | 1.6 km round | 640 m | 1024 m | **1024 m** |
| Life grid | 192² at 52 m | ~4 m | 256² at 2.5 m | 256² at 4 m | **256² at 4 m**; ecology keeps a scale constant for species–area |
| Years per second | 3 | 1 | "~1" | 0.25 | Pick one. It changes succession rates, storm spacing and time-step sizes (§4) |
| Day cycle | 20 min | 24 min | 14 min | 14 min | one |
| Plant LOD0 triangles | n/a | n/a | palm 400, fig 1400, mangrove 1000 | ≤ 160 | **≤ 250 per tree (one 400-tri hero fig), ≤ 60 small** |
| Camera minimum distance | n/a | n/a | 0.8 m (crab's-eye view) | 12 m | **≈ 5 m.** At 2 m cells the ground is blobby below that |
| Caves, arches, overhangs | CAVE flag, swiftlets, lava tubes | Scoop sideways for caves and arches | n/a | **impossible** (2.5D) | Cut. Fake "cave" as a flag for a steep cliff at the waterline, drawn as a dark decal |
| Animated agents | 40 + 120 flock | 150 | 120 | 200 | **Phone 60 + one Points flock**, laptop 120 |
| Lava heat | n/a | n/a | per-vertex `heatAttr` (RG8 with a timestamp, which is meaningless in 8 bits) | separate lava sheet | Sheet. Show "recently frozen" warmth through a `uGround` channel, not vertex attributes |
| Ecology texture layout | n/a | n/a | uEcoA/B: lichen, moss, grass, litter / weathering, guano+salt, moisture, char, plus `vLee` | coverA/B: different channels; no moisture, burn or lee | One layout, frozen in WP0 |
| Species count | 111 | ~120 | n/a | ~45 | **45 for v1**, kept as data so more can be added without code changes |

## 3. Rendering: where the budgets break

### 3.1 Terrain at god view: LOD is required in v1, not a stretch goal

- **Pixel count.** On a portrait Pixel at a pixel ratio of 1.5 the canvas is about 618 px wide. The whole 1 km zone therefore puts 1.6 m on each pixel, so 2 m cells become triangles under 1 px².
- **Why that hurts on Mali.** Mali shades in 2×2 pixel blocks and bins triangles per tile, so very small triangles are its worst case: up to 4× wasted shading plus heavy tiler load.
- **Triangle counts.** The architecture's own estimate is 150–260k terrain triangles for the whole zone, with 600k as the worst case. The underwater ridge alone (−6 to −28 m, about 130 m half-width, about 1.1 km long) is about 70k columns, roughly **200k triangles before any island exists.**
- **Cut:**
  - Tiles beyond about 250 m: mesh at 4 m. Beyond 500 m: 8 m. Neither needs surface nets; a plain heightfield grid from averaged columns with skirts is enough.
  - The seabed below −10 m gets a fixed 8 m grid.
  - Budget for terrain in view: **≤ 150k triangles**.
- **Mesher speedups.** Because the input is a heightfield, the distance field can be built from the column tops: `clamp(top − y, ±2.5)` per cell instead of three 3D passes. Skip any chunk whose column min/max top cannot reach its y range; today an empty chunk still costs 0.2 ms. AO can come from a 2D horizon test instead of 14 trilinear samples. Expect 3–5× faster.
- **Alternative worth one spike.** Displace a single clipmap grid in the vertex shader from the `uHeight` texture (texture fetch in the vertex shader works on Mali in WebGL2). Terrain cost stays fixed whatever is built, and freezing lava becomes a texture row update with no re-mesh or tile transfer. All shading is world-space procedural, so there are no UVs to stretch on cliffs.
  - The cost: cliffs become one-cell, 86° ramps, which read as cliffs from any normal camera distance; and some mesher and tile code is thrown away.
  - Decide this by the Pixel spike in §8. Don't decide it by preference.

### 3.2 Fragment shader cost

- **Noise cost.** The ground shader in the look design calls `sc_noise2` about 6 times for cover patches, plus fbm and Voronoi, plus detail-normal noise. Each `sc_noise2` is 4 `sin` hashes, so that is roughly 40–60 transcendental ops per pixel on full-screen terrain.
- **Fix: one RGBA noise texture made at startup** (for example 256², 4 octaves in 4 channels), computed in code. It belongs with the other data textures already planned (uHeight, uGround, cover). It replaces almost all of the per-pixel noise maths and is the biggest single shader saving.
  - CLAUDE.md says "no generated … textures". The intent appears to be files, since uHeight, uGround and the audio beds are also generated at runtime. **Get the owner's confirmation and record it in DECISIONS.md.**
- **Hash precision.** `sc_hash2` is `sin(dot(p,…))*43758`. At 1 km coordinates times a frequency of 260–420 (`floor(vWorld*420.)`), the `sin` argument reaches about 1e8. In fp32 that is garbage, and some Mali chips reduce the range of `sin`, which shows up as stripes and banding.
  - Use a sin-free hash (`uint`-based PCG in WebGL2, or the Hoskins fract hash).
  - Shade from coordinates taken relative to the tile or camera.
- **Caustics.** These are a 4-iteration trig loop, run on every underwater terrain pixel, which the water then covers.
  - Gate them to depth under 6 m and distance under 60 m from the camera.
  - Better: put an animated caustics pattern into the startup texture and sample it twice.
  - Add an early cheap path for seabed deeper than 8 m: no cover, no detail, no caustics.
- **Time precision.** `uTime` grows without limit, and play sessions run for hours. After 10 hours fp32 steps are about 0.004 s, so leaf flutter at about 13 rad/s jitters by about 0.05 rad and Gerstner waves stutter. The CPU wave code runs in doubles, so floaters such as the coconut and the boat drift out of step with the visible waves.
  - Wrap every periodic time uniform, for example `mod(t, 600·2π/ω)` per band, or wrap at 1 hour with a crossfade.
  - Pass ages such as `uRealTime − birth` as small numbers relative to a rebased epoch.

### 3.3 Plants

- **Look design.** It totals about 280k plant triangles (150 LOD0 trees at about 800 each, plus 700 LOD1, 3,500 LOD2 and 1,500 grass) against its own 150k budget, before the shadow pass.
- **Architecture tiers.** "Under 70 m: all four slots at LOD0" means about 2,400 instances at about 80 triangles, roughly 190k, right at its 200k limit. Vegetation also casts shadows, which adds about 190k to a 180k shadow-pass budget.
- **Cuts:**
  - Size the tiers on screen-space size, with hard per-tier instance caps on phone: **LOD0 ≤ 600, LOD1 ≤ 2,500**.
  - Ground slots (grass tufts) only within 30 m.
  - **Only LOD0 trees within 40 m cast shadows.** Everything further away gets its shade from the cover texture (`coverA` canopy darkening).
  - At god view, draw no plant geometry; use the texture only. The look design's LOD2 "far canopy mesh" is 3,500 instances of sub-pixel triangles.
- **Animate in a separate mesh.** Unfurl, pop-in, burn and topple run per vertex every frame for every instance, even though at most about 8 plants are animating at once.
  - Keep the bulk instanced mesh on a shader that only does sway.
  - Move a plant into a small "animating" instanced mesh with the full shader for 1.5–3 s, then move it back.
- **Avoid `discard` on opaque foliage.** The look design's Bayer-dither LOD crossfade and its lattice discard turn off Mali's early depth test and Forward Pixel Kill for the whole draw. Use scale-to-zero transitions instead.
- **Custom shadow materials.** Any vertex-animated material (sway, pop, topple, creature flaps) needs a matching `customDepthMaterial`. Without it, shadows don't move with the plant, and compiling those depth variants adds programs that must be warmed up at load.
- **Instance data.** Write position plus yaw, scale and seed into a single `vec4` (16 B) using `InstancedBufferGeometry`, instead of a 64 B `instanceMatrix`. Rebuild only the plant tiles that changed. Rebuilding 6k matrices four times a second takes 2–3 ms of main-thread time on a Pixel.

### 3.4 Overdraw and transparency

- **Steam.** 300 billboards with fbm per pixel cover the whole screen when the camera is close to lava meeting the sea.
  - Phone cap: ≤ 100 puffs.
  - Clamp screen-space size, fade puffs near the camera, and replace fbm with one noise-texture read.
- **Cloud caps and mist wisps** stack up when the camera sits in a peak's cloud cap. Fade them by camera distance (the architecture already says this) and cap the number of layers at 3.
- **Lava "heat halo" and fake bloom:** cut on phone.
- **Lava light.** Use a `uLavaGlow` (position, radius, colour) term inside the ground and plant shaders rather than a three `PointLight`. That term costs the same everywhere, and it can't cause a recompile if someone removes the light later.

### 3.5 Frame pacing, heat and laptop assumptions

- **The Pixel 7a screen runs at 90 Hz.** `requestAnimationFrame` fires every 11.1 ms, and a 60 fps target doesn't divide evenly into that, so frames judder.
  - Target **45 fps** (every second frame) in normal play.
  - Use **30 fps** in watch mode and in a "battery saver" setting.
  - Use dynamic resolution (pixel ratio 1.0–1.5) driven by GPU frame time, not by fps alone.
- **Sustained play matters more than peak.** This is a game for hours of watching, and Tensor G2 phones slow down noticeably within about 10 minutes of sustained GPU load. Any frame-rate check must sample after 10 minutes. The architecture's "45–60 fps idle" claim needs that qualifier.
- **Shadows.** Precompile both the shadows-on and shadows-off variants during loading. Better still, lower the shadow-map size or cull casters instead of switching shadows off. Turning off `shadowMap.enabled` or a light's `castShadow` at runtime forces every program to recompile.
- **The laptop is not "1.5× the Pixel".** An integrated Intel GPU driving 1920×1080 at a pixel ratio of 1.5–2 (3–4 megapixels) can be fill-limited below the Pixel. Use the same dynamic resolution with a laptop cap of 1.5.
- **Screen sleep.** Watch mode needs `navigator.wakeLock` or the phone sleeps. When it sleeps the page is hidden and the game pauses, which defeats "watching trees pop up". Whether wake lock works for a page opened from Downloads (`file://` or `content://`) is **untested**; add it to the checks page.

### 3.6 Proposed Pixel budgets (sustained, Balanced tier)

| Item | Budget |
|---|---|
| Main pass | ≤ 350k triangles, ≤ 80 draw calls (terrain 150k, plants 120k, water 40k, animals 15k, sky and effects 15k) |
| Shadow pass | ≤ 100k triangles, ≤ 20 draws, 1024² map, nearby casters only |
| Full-screen shaders | no loops; ≤ 3 noise-texture reads per pixel for ground and water |
| Transparent overdraw | ≤ 2.5× in the worst view |
| Main-thread JS | ≤ 4 ms per frame |
| GPU uploads | ≤ 1 MB per frame peak, ≤ 3 MB/s sustained |
| Worker | ≤ 8 ms per 33 ms tick while physics is active; ≤ 2 ms per 100 ms while idle |
| Memory | worker ≤ 60 MB, page heap ≤ 120 MB, audio ≤ 16 MB |
| HTML file | ≤ 1.5 MB |

## 4. Worker, simulation and messages

- **Real Pixel CPU cost.** "Pixel ≈ 3× desktop" assumes the worker sits on a fast core. Android's scheduler starts bursty threads on the A55 little cores, which are 4–5× slower than the fast X1 cores, and heat cuts the fast cores' clock speed. **Budget for 4–6× desktop.** With the measured mesher, a 128 m tile (16–32 surface chunks) takes about 50–120 ms to re-mesh on a Pixel. Cold load of a full chain (450–700 surface chunks) takes **3–5 s** in the worker, against the architecture's "≤ 2 s", and longer on the page fallback.
- **Duty cycle.** A 30 Hz tick with a 14 ms budget is about 40% of a core while lava is active, and the phone heats up. When no sand or lava is active, drop the worker to 10 Hz with an ecology slice of about 2 ms. Most of the game is watching, so idle cost is what matters.
- **Terrain tile uploads.** Each update reallocates a tile of about 200 KB (positions, normals, attributes, indices). Several tiles at 4 Hz during a pour gives GPU buffer reallocation stalls plus large backing-store garbage.
  - Use pooled geometries with spare capacity, `setDrawRange` and update ranges.
  - Send emptied buffers back to the worker for reuse (ping-pong).
  - Consider 64 m tiles for a 4× smaller upload per edit.
- **Lava sheet: send per chunk, not one bounding box.** Two pours 800 m apart give one box spanning most of the zone (stride 2, 65k vertices, 300 KB+ at 12 Hz).
  - Send only the 32 m chunks that contain lava.
  - Lift the sheet by a minimum thickness or use `polygonOffset`; thin lava sitting on terrain will flicker against it at a distance.
- **Lava flow model.** The flux has a scaling clamp ("≤ L, ≤ Δ/3 per neighbour"). That is the standard virtual-pipe outflow scaling, which is stable but tends to produce a checkerboard pattern if the scaling ignores what flows in that step. Add a check that a symmetric cone pour stays symmetric to 1%.
  - Tool rates scale with radius (lava `0.35·r` gives 21 m/s at the centre at r = 60 m), so volume scales with r³. Cap the volume per second instead, or large-brush pours will be governed by the clamp and depend on the grid.
- **Page fallback.** In 6 ms per frame, lava, sand, meshing and ecology cannot all fit, so lava visibly moves in slow motion.
  - Define a "page mode" feature set: smaller brush cap, lava at stride 2, ecology 1 ms.
  - Ask the owner to run the v0.1 checks page on the Pixel now, which costs nothing. It reports whether the worker started and a frame rate.

## 5. Ecology maths that will break

1. **Byte-sized fields stop changing.** At 0.25 years per second with each patch visited about every second, `cover += r·c·(1−c/K)·dtY` gives an increment of about 0.16 Uint8 units, which rounds to 0 forever. Soil in Uint8 cm gains 0.002–0.02 cm per visit, also 0.
   - Keep live state in Float32 or in Uint16 fixed-point.
   - Quantize only in the save file and the render textures.
   - Or use stochastic rounding with the seeded random generator.
2. **Big time steps overshoot.** At 3–10 years per second with visits every ~1.5 s, dt is 5–15 years per visit. Simple step-by-step (explicit Euler) growth overshoots once r·dt > 1 and can turn negative when K drops.
   - Use the exact logistic solution `K/(1+(K/c−1)e^{−r·dt})` for growth.
   - Use exponential relaxation for decline.
   - Use `p = 1 − exp(−λ·dt)` for every arrival, establishment and extinction roll. `λ·dt` and `score·dt/estYrs` exceed 1.
   - `debugAdvance` and "1000× headless" runs must sub-step, with a maximum dt of about 2 years.
3. **Determinism is not achievable as designed.** How many patches a slice covers depends on frame timing, and each patch's dt depends on when it was visited. So "same seed + same edits = same history" and "arrivals deterministic" fail whenever the work is budget-sliced.
   - Advance ecology in **fixed year steps** (for example 0.5 years).
   - Each step processes the whole active set in a fixed order; the work is spread over frames but behaves as one step, with double-buffered state.
   - The visible year waits until the sweep has caught up.
   - Edits are stamped with the step they landed in.
4. **Skip settled patches.** Mark patches whose cover equals K and whose soil change is under ε as quiescent, and revisit them every 8th step. Late-game cost drops by about 80%.
5. **One impossible check.** "A 50k-patch sweep slice under 2 ms" means 40 ns per patch, but each patch does about 1,000 operations (8 candidates × 4 layers × a 30-op suitability test). Restate it as **≤ 4 µs per patch on desktop**.
6. **Rain units.** The march formula `m −= 0.004·rain`, with rain in millimetres, drives moisture negative at once. Normalize the units and clamp.
7. **Islands flickering in and out.** Sand bars near sea level will appear and disappear and spam the journal. Add hysteresis: create an island above +0.5 m, lose it below 0 m, and require it to persist for N years.
8. **Display smoothing belongs on the GPU.** Easing 256²×8 B "display" arrays toward their targets on the CPU every frame takes 1–2 ms on a Pixel. Upload "previous" and "next" textures and blend them in the shader with a `uBlend` uniform.
9. **Undo against ecology.** A record stays open up to 40 s, which is 10–120 years. Restoring the snapshotted patches rewinds life in those patches only. Journal "firsts" established there are left dangling, and populations computed from them are wrong.
   - Undo restores geometry.
   - Cover is restored only where the stroke **burned** it, taking the maximum of the snapshot and the current value.
   - The journal is append-only ("the figs returned").

## 6. Where the parallel work packages will collide

- **`PatchGrid` fields** are read by C (undo snapshots, the PTCH save section) but changed by D. Give `PatchGrid` a generic `arrays[]` list so C can snapshot and serialize it without knowing the fields, and let D own encoding of its save section.
- **Cover-channel meaning** is used by E (terrain shader), F (slots and vegetation), G (sound census) and D (writer). It has to be frozen in WP0, including moisture, burn, lee and weathering, which the architecture currently leaves out.
- **G's soundscape** needs life "near the listener", but `life` only carries totals per island. Either add a coarse life-density field (32 m cells) to the contract or derive it from the cover texture on the page.
- **`main.ts` and `shared.ts`.** Every package needs new uniforms, quality hooks and wiring. A single quality object and a uniform registry in WP0 (owned by the lead, changed only by pull request) avoids merge fights.
- **The `chain.isle` fixture** comes from D's `simulate.mjs`, but E's stress scene and H's budget tests need it on day one. The lead should ship a synthetic generator for the full-chain heightfield and maximum slots in WP0.
- **Soil writes from D can wake B's sand slide.** Soil growth that keeps slope under the limit must not wake sand columns, or the ecology will keep the sand simulation permanently busy.
- **Browser checks run on SwiftShader** (software graphics), so their frame rates mean nothing. Only triangle and draw-call assertions are valid there. Frame-rate testing exists only on the owner's devices.

## 7. Effort is underestimated

Each of these is underscoped:
- 111 species, each with habitat envelopes, journal lines, near-miss reasons, facts, and tuning toward S(t) targets. The tuning alone is weeks of serial iteration.
- 25 plant archetypes, each with LOD0/LOD1/LOD2 plus unfurl, burn, topple and wither.
- About 25 animal species with separate behaviour state machines.
- Arrival vignettes, 12 Moments, storms (rain, lightning, rainbow, sky deck), the mist reveal across six sites, the ending and its credits, journal sketches, photo mode.

Tuning pacing, phone speed and feel happens one owner download at a time and can't be split across parallel packages.

**Cuts for v1:**
- 45 species, ~10 plant archetypes recoloured into variants.
- 8 animal body plans (glider bird, small bird, wader, crab, lizard, turtle, fish shoal, cetacean) built from 6 reusable behaviours. Other species are journal-only or sound-only.
- About 6 vignettes and about 4 Moments.
- Journal sketches as projected silhouette outlines, or a single offscreen render at load kept as `ImageBitmap`s. Not a live ink-shader renderer.
- Ground clutter (pebbles, shells) only on the Richer tier.
- No caves or arches.

## 8. What to prototype first, in order

1. **Get Pixel ground truth today.** Have the owner run v0.1's "Run the checks on this device" and report worker or page mode, frame rate and GPU name.
2. **"God-view probe" build.** No gameplay:
   - a synthetic full chain of 5 islands plus the ridge, rendered two ways: surface-net tiles with LOD, and a displaced clipmap;
   - water at full complexity, 6k plant instances with sway, shadows on and off, a 45 fps cap;
   - a 10-minute heat run that logs frame time, the resolution scale chosen, and triangles and draws per category.
   
   This decides the terrain approach and the real budgets.
3. **Lava feel and the hand-off from lava to rock.** Column lava with per-chunk sheet messages and freeze-triggered re-mesh on the Pixel worker:
   - no gaps or flicker between the sheet and the terrain tile;
   - a lava pour on two islands at once;
   - the page-mode fallback under 4× CPU throttle.
4. **Headless ecology numerics.** Fixed-step Float32 state, exact integration, rolls of the form 1−e^{−λdt}, the quiescence skip. Run at all three paces and at dt from 0.1 to 10 years, and confirm the S(t) curves match each other within 10%. Do this before any ecology visuals exist.
5. **Plant density and animation split.** Pop-in on the separate animating mesh, shadow casters only within 40 m, `customDepthMaterial`, tier caps. Measure instance-buffer rebuild time on the Pixel main thread.
6. **Undo semantics against the year clock** (§5.9), written up in DECISIONS.md before C and D build to it.