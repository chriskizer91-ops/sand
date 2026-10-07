# Island-life game: look, animation and sound design

*Art and audio direction for an island-maker game where everything is drawn in code. It builds on the Sandcastle Cays renderer: the sand material with `sandAttr` (wet/pack/AO) and `landTint`, the Gerstner water with depth colouring and shore foam, the sky dome, the merged-geometry palms and bushes with a `sway` attribute, the noise-buffer WebAudio graph, and the adaptive pixel-ratio and shadow fallbacks.*

---

## 0. Mood rules (the tests every choice must pass)

1. **Calm.** Nothing flashes, shakes or nags. Even storms are "weather to watch," not danger.
2. **Readable from far, rewarding up close.** From the god view the island reads like a living map: colour bands of rock, green, beach and reef. Up close there is a crab, a fern uncurling, a bird preening.
3. **Two clocks, never mixed.** Ecology (years) races. Everything you *see moving* (waves, wings, crabs, lava flowing from your hand, clouds) runs at real-world speed. Years show only in the journal and in how the island has changed.
4. **Same family as Sandcastle Cays.** Soft, sunny, cartoon-real Caribbean. Smooth shapes, vertex colours, flat-ish lighting with a warm sun and cool sky fill. No outlines and no noisy realism.
5. **Everything from code.** Geometry is generated, colour comes from vertex colours and shader maths, and sound is synthesised or baked at startup with `OfflineAudioContext`. Journal sketches are drawn live from the same 3D models into a canvas at runtime and never stored as files.

All colours live in one `PALETTE` module, as they do today (sRGB hex, converted with `glslColor`).

---

## 1. Scale and budgets

**Assumed scale (the engine design may change these numbers; the art scales with them):** 1 unit = 1 m. The zone is about 640 × 640 m of sea. The first island is 80–150 m across, and a mature chain spans about 500 m. Peaks reach 40–90 m. Terrain cells are coarse (0.5–1 m), so **all fine detail comes from the shader and from scattered instances**, never from terrain geometry.

**Frame budget on the Pixel 7a (Mali-G710, 60 fps target with a 30 fps floor), "Balanced" tier:**

| Item | Budget |
|---|---|
| Pixel ratio | 1.5 (adaptive 1.0–1.75; laptop up to 2) |
| Draw calls | ≤ 120 |
| Triangles on screen | ≤ 400k (terrain 100k, water 80k, plants 150k, animals 15k, sky/clouds/FX 30k) |
| Plant instances visible | ≤ 150 trees at LOD0, ≤ 700 at LOD1, ≤ 3500 at LOD2, ≤ 1500 grass tufts |
| Animal agents simulated | ≤ 120 (laptop 200), plus far "speck" flocks as one point cloud |
| Particles | ≤ 2500 total (rain 1500, steam 300, spray, leaves, motes) |
| Shadow map | 1024², following the camera; off beyond 150 m camera distance |
| Shader programs | Five main ones (ground, water, plant, creature, FX), all compiled at load with `renderer.compile` so the first lava flow never hitches |
| Audio CPU | < 6% of one core; ≤ 40 live nodes typical, ≤ 90 peak; ≤ 12 new voices per second |

**Quality tiers** (the existing auto-downgrade order still applies: pixel ratio first, then LOD radii, then shadows):

- **High** (laptop): LOD0 radius 40 m, 200 agents, 4000 rain streaks, reverb on.
- **Balanced** (Pixel): LOD0 radius 25 m, 120 agents, 1500 rain streaks, light reverb.
- **Fast**: LOD0 radius 15 m, 60 agents, 800 rain streaks, no shadows, cheap lava cracks (value noise instead of Voronoi).

---

## 2. The ground: one terrain shader

All land and seabed use **one material** (`IslandGround`), extended from `createSandMaterial` through `onBeforeCompile` exactly as today. It is still Lambert, so it gets sun shadows for free.

### 2.1 Data the shader reads

**Per vertex (from the mesher, changes only when you shape the land):**
- `sandAttr` (existing): wet, pack, AO.
- `matAttr` (RGBA8, normalized): weights of **sand / basalt / rubble-rock / spare**, plus a sand-kind byte (0 black, 0.33 grey, 0.66 gold, 1 coral-white).
- `heatAttr` (RG8): lava heat 0–1 at meshing time, and the time it was meshed (`uRealTime` minus `heatAge` gives cooling in the shader without re-meshing).

**Per zone (ecology state, two 256×256 RGBA8 textures at 2.5 m/texel, sampled by world xz):**
- `uEcoA` = R lichen, G moss, B grass/herbs, A forest floor (litter, canopy shade).
- `uEcoB` = R weathering→soil (0 fresh basalt, 0.5 weathered, 1 soil), G guano and salt, B moisture (0 dry season or lee, 1 wet), A char/burn scar.
- A third optional 128² texture for the seabed: R coral cover, G seagrass, B reef crest (foam), A bleaching.

**Smoothing the years:** the ecology simulation writes *target* arrays. The page keeps *display* arrays and eases them toward the targets (about 0.6 s time constant), re-uploading the 256 KB texture at most 4 times a second (amortised row ranges). Fast years therefore look like green *spreading*, never flicker.

### 2.2 Materials

**Sand (four kinds; reuses `sc_sandColor`, grain, sparkle and the wet sheen):**

| Kind | Dry | Damp | Wet | Where it comes from |
|---|---|---|---|---|
| Black (volcanic glass) | `#3a3634` | `#2c2928` | `#1f1c1c` | Lava meeting the sea shatters into black sand. Glints are strong (`spark` threshold 0.975, cool white). |
| Grey (mixed) | `#8f877c` | `#756d63` | `#5b544c` | Black sand mixed with eroded rock over decades |
| Gold | `#e9d6a8` | `#d0b689` | `#b79c72` | Weathered rock plus shell |
| Coral-white | `#f7f1e3` | `#e6dcc5` | `#cdbf9f` | Grows slowly once a reef exists (pink variant `#f2d6cf` if forams appear) |

This gives a big, slow reward: **beaches lighten over centuries, from black to grey to gold to white, as the reef matures.** The shader blends kinds by the sand-kind byte. The ecology simulation nudges that byte on beach cells when reef cover offshore is high.

**Fresh lava (glowing, flowing, crusting).** The branch runs only where `heat > 0.01`, which is coherent on Mali.

```glsl
float heat = vHeat0 * exp(-(uRealTime - vHeatT) / uCoolTau);   // real-time cooling, tau ~ 40 s
vec3 nW = normalize(vNormalW);
float slope = 1.0 - nW.y;
vec2 flow = -normalize(nW.xz + 1e-4) * (0.2 + 1.4 * slope) * heat;   // downhill
// two-phase flow-map so the scroll never stretches
float p0 = fract(uTime * 0.2), p1 = fract(uTime * 0.2 + 0.5);
float n = mix(fbm(vWorld.xz * 0.7 - flow * p0 * 3.0),
              fbm(vWorld.xz * 0.7 - flow * p1 * 3.0), abs(p0 * 2.0 - 1.0));
vec2 v = voronoiF1F2(vWorld.xz * 1.4 - flow * uTime * 0.15);     // crust plates drift downhill
float crackW = mix(0.015, 0.4, heat);                            // cracks narrow as it cools
float crack = 1.0 - smoothstep(0.0, crackW, v.y - v.x);
float molten = smoothstep(0.78, 0.95, heat);                     // fully liquid = no crust
float g = heat * mix(crack, 1.0, molten) * (0.75 + 0.25 * n);
vec3 glow = lavaRamp(g);   // #c21f0e -> #ff5a1a -> #ffb02e -> #fff3c4
diffuseColor.rgb = mix(crustHot, basaltFresh, smoothstep(0.0, 0.35, 1.0 - heat));
// after lighting (in opaque_fragment):
outgoingLight += glow * g * (2.0 + 0.6 * sin(uTime * 1.3 + n * 9.0));  // slow breathing glow
```

- **Crust colours:** hot crust `#3a1712` (reddish black), cooling crust `#1d1a1c`.
- **Texture by slope.** On flat ground the lava sets as *pahoehoe* (smooth, ropy): add `sin(dot(vWorld.xz, flowPerp) * 9.0)` bands to the normal and a glossy highlight (`pow(nh, 60) * 0.35`). On steep ground it sets as *a'a* (clinker): normal noise at 2.5× scale, no gloss. The flow direction is frozen into the mesh when the lava solidifies, so the ropes stay put.
- **Fake bloom (no post-processing on phones):** one warm `PointLight` (`#ff7a2a`, intensity tied to total molten area, range 30 m) sits at the centroid of the hottest lava. At night this lights the steam and nearby rock beautifully. There is also a camera-facing additive "heat halo" quad over large molten areas at 0.15 alpha.
- **Night:** cracks keep a faint glow for about 3× longer after sunset (the eye adapts). Lava is the star of night scenes.

**Steam where lava meets the sea.** The engine reports lava–water contact cells, which spawn **steam puffs**: instanced billboards whose soft round shape is drawn in the fragment shader (`alpha = (1 - r²) * fbm(uv * 3 + seed)`), white `#f4f6f7` tinted warm at the base by the lava glow. They rise at 1.5 m/s, drift downwind, grow to 3× size and fade over 4 s. The cap is 300 on phones, with a spawn rate of up to 40/s scaled by contact. A long white **plume** of 8 big puffs per second leans downwind while contact lasts. The water near hot rock turns **milky jade** (`#b9e3c8`) through a heat term in the water shader, and its foam noise speeds up 4× to look like bubbling.

**Basalt by age** (driven by `uEcoB.R` weathering):
- Fresh glassy basalt `#2b2a2e`, a cool blue-black with a soft specular sheen.
- After about 20–80 years it is matte `#3c3a3a`.
- Weathered rock `#57524c`, gaining rust-ochre streaks `#9a5a3a` where moisture is high (noise along the downhill direction, like rain stains).
- Old rock `#8a7f72` up to the existing `rock #b6ad9c` on sea cliffs, where salt crust `#ece7da` appears in the splash zone (height 0–3 m above sea, on windward faces).

**Soil** (`uEcoB.R > 0.6`, flat-ish ground only): young `#6b4a35`, tropical red laterite `#8c4a2f` on the dry side, dark humus `#3f3024` under forest. Soil shows on bare patches between plants and in a darker ring around tree bases.

**Rubble rock** (the "place rock" tool and cliff talus) uses the existing boulder recipe colours, tinted by weathering like basalt.

### 2.3 Ground cover: tint, not geometry

Cover spreads as **patches that grow outward**, not as a uniform fade. Each layer thresholds its own noise field against its amount:

```glsl
float patchCover(float amt, vec2 xz, float scale, float soft) {
  float nz = sc_noise2(xz * scale) * 0.65 + sc_noise2(xz * scale * 3.7) * 0.35;
  return smoothstep(nz - soft, nz + soft, amt * 1.15 - 0.05);
}
vec4 eA = texture2D(uEcoA, (vWorld.xz - uZone.xy) / uZone.zw);
vec4 eB = texture2D(uEcoB, (vWorld.xz - uZone.xy) / uZone.zw);
float upF  = nW.y;                                              // 1 flat .. 0 cliff
float shade = 1.0 - max(dot(nW, uSunDirW), 0.0);
float lichen = patchCover(eA.r, vWorld.xz, 0.9, 0.06);          // any slope, speckly
float moss   = patchCover(eA.g * (0.6 + 0.6 * shade) * (0.5 + eB.b), vWorld.xz, 0.45, 0.10);
float grass  = patchCover(eA.b, vWorld.xz, 0.25, 0.12) * smoothstep(0.55, 0.8, upF);
float litter = eA.a * smoothstep(0.6, 0.85, upF);
vec3 lichenCol = mix(#c9cbb0, #d9d3a0, nz2);                    // sage to pale yellow
lichenCol = mix(lichenCol, #e09a3a, coastalMask * step(0.7, nz3)); // orange near the sea
col = mix(col, lichenCol, lichen * 0.8);
col = mix(col, mix(#4a6b2a, #7fb03a, eB.b), moss);              // brighter when damp
vec3 grassCol = mix(mix(#6fae4a, #86c45a, nz), mix(#c9b26b, #e2d08f, nz), uDryness * vLee);
col = mix(col, grassCol, grass);
col = mix(col, mix(#7a6a45, #5c4f34, nz), litter);
col *= 1.0 - 0.35 * eA.a;                                       // fake canopy shade under forest
col = mix(col, #f2efe4, eB.g * cliffLedgeMask);                 // guano whitewash below colonies
col = mix(col, #2a2622, eB.a * 0.7);                            // burn scar
// wind waves rolling across grassland (reads beautifully from above)
col *= 1.0 + grass * 0.07 * sin(dot(vWorld.xz, uWindDir) * 0.18 - uTime * (0.8 + uWind));
```

`vLee` is a per-vertex 0–1 "rain shadow" value from the ecology simulation (the lee side of the tallest peak), so in the dry season the **lee side turns golden while the windward side stays green.** Sparkle is suppressed under cover, as today (`1 - sTintA`).

### 2.4 Close-up detail (crab-eye view)

Coarse terrain looks blobby close up, so within 12 m:
- **Detail normal noise** fades in: 2-octave value-noise derivatives at 8 m⁻¹, with amplitude by material (rock 0.35, a'a 0.5, soil 0.2, sand 0.1).
- **Ground clutter instances** are scattered by hash within 15 m of the camera target, one draw call each, 300–800 instances: pebbles (12 tris, rock colours), shells and coral bits on beaches (10 tris, `#f4e6d6`, `#e8b4a6`), leaf-litter discs under forest (2 tris, olive/brown), seed pods along the wrack line, and drift seaweed (`#6b5a2a`) after storms. They fade by distance with a dither so they never pop.

### 2.5 The sea around the islands

The existing water shader stays, with these additions:
- **Bathymetry reads from above** like the Bahamas: pale `#8ff0e4` over white sand, `#4fb8b0` over black sand (the shallow colour mixes with the seabed albedo). Reefs show as mottled darker `#2a9a9a` patches with lighter rims, and seagrass as soft olive smudges (`#4f8a3a` under water). Deep water `#1279b8` grades to open ocean `#0b4f8a` past 40 m depth.
- **Reef crest surf:** where the reef crest channel is high, a second foam line breaks offshore and the lagoon inside calms (the wave amplitude mask multiplies by `1 - reefShelter`).
- **Hot water:** `uHeatTex` gives the milky jade colour and bubbling foam.
- **Caustics** on the seabed already exist and stay. They are lovely over coral.
- **Night bioluminescence** (late reward in mangrove lagoons): foam and the wakes of up to 16 moving creatures (a uniform array of points) glow `#5ff2d0`.

### 2.6 How the island looks at each stage

| Stage | God view | Close up |
|---|---|---|
| **0 Newborn** (year 0) | Black island with orange veins, white steam plume, a milky jade ring in the sea, black sand fringe. Sky slightly hazy downwind. | Glowing cracks, glossy ropes, steam, glints on black sand. No life. |
| **1 Crust** (years 1–30) | Charcoal turns to slate grey. Sage and orange lichen freckles spread on the windward side and the splash zone. | Lichen rosettes, first ferns in cracks (*real: ferns colonise lava cracks first*), a resting tern. |
| **2 Moss and ferns** (30–150) | Green creeps up gullies and the windward slopes. A white guano cap forms where seabirds nest. Beaches show the first strand vines. | Moss cushions, fern rosettes, morning-glory runners with pink flowers, ghost crabs. |
| **3 Grass and strand** (150–400) | A green coat on the windward side and golden grass on the lee. Palms on the beaches, sea purslane mats, seagrass smudges offshore. | Grass tufts rippling, coconuts, the first lizards from a raft, turtles nesting. |
| **4 Shrubs** (400–1000) | A darker green texture of shrub dots. Pandanus on cliffs, scaevola mounds behind beaches, cactus and thorn scrub on the lee. Reef patches appear. | Bees and butterflies at flowers, songbirds, dragonflies if there is a pond. |
| **5 Forest** (1000+) | Deep canopy carpet, a cloud cap on the peak (cloud forest), mangrove fringe in calm bays, a reef ring with a surf line, and beaches turning gold or white. | Fig trees with bats, epiphytes and mist, frogs at night, fireflies, reef fish. |
| **Chain** | Each new island starts at stage 0 beside older ones, so the zone shows **a gradient of ages**, which is the most beautiful god-view picture. | |

---

## 3. Shaping tools: how they look in your hands

The owner asked to "sculpt with your hands," so the design shows **cupped hands made in code**: two low-poly hands (about 220 tris each, built from capsules) in a pale sand-gold translucent material (`#f3e6c8`, 35% opacity with a Fresnel rim). They hover above the brush ring and scale with zoom, so at god view they are giant "maker's hands." This needs a playtest. The fallback is a soft glowing column above the ring.

- **Pour sand:** the existing `SandParticles` stream falls from between the fingers. Its colour follows the sand kind.
- **Place rock:** tumbling boulder instances (the existing boulder recipe, 60–120 tris) drop, bounce once, and merge into terrain with a small dust puff of 6 grey motes.
- **Pour lava:** a viscous glowing ribbon (a tube following a short falling curve, 6 sides × 12 segments) with the lava shader at heat 1. Orange spark points fall off it (40 max, additive), and the hands glow orange from below.
- **Smooth or press:** a soft palm-print shimmer on the surface, using the existing ring cursor.

---

## 4. Plants

### 4.1 Shared construction kit

Every plant is generated at load from six helper shapes, all vertex-coloured and merged (as `palm()` and `bush()` do today):
- `stem(curve, radii, sides)`: a tapered tube, 4–6 sides.
- `strip(len, widthFn, segs)`: a palm frond or strap leaf with a folded midrib (the existing `frond`).
- `blade(h, lean)`: a 1–2 triangle grass blade.
- `blob(r, detail 0/1, noise)`: a crown puff.
- `fan(n, r)`: a round leaf, flower or pad.
- `rosette(n, part)`: radial copies of a part.

Every vertex carries attributes for the animations below:
- `sway` (0–1, trunk bend weight; existing)
- `flutter` (0–1, leaf jitter)
- `part` (0 trunk, 1 leaf, 2 flower, 3 fruit)
- `grow` (0–1, order along the plant from base to tips, used for the reveal)
- `attach` (vec3 Int16-normalized: where this leaf or branch joins its parent, used for the unfurl)

All plants share **one program** (`PlantMaterial`, Lambert with vertex colours, `DoubleSide` for leaves). Each archetype × LOD is one `InstancedMesh`.

Per-instance attributes:
- `iLife` = birth time, death time, death kind, wind phase.
- `iLook` = hue jitter (±4%), value jitter (±8%), size class (0.35 sapling, 0.65 young, 1.0 mature, 1.3 ancient), yaw (used to rotate the wind into local space).

### 4.2 Wind sway (three layers, one function)

```glsl
uniform vec4 uWind;          // xy = direction * strength (0 calm .. 1 gale), z = gust phase, w = storm
vec2 dirL = rot2(-iYaw) * uWind.xy;                 // wind in the plant's own space
float w = length(uWind.xy);
float ph = iLife.w + dot(iWorldPos.xz, normalize(uWind.xy + 1e-4)) * 0.07; // gusts travel across the island
float gust = 0.55 + 0.45 * sin(uTime * 0.6 - ph) * sin(uTime * 0.21 - ph * 0.4);
float h = clamp(position.y / iHeight, 0.0, 1.0);
// 1) trunk bend (quadratic, keeps length roughly)
float bend = h * h * (w * gust * 0.14 + 0.02 * sin(uTime * 0.8 + ph)) * sway;
transformed.xz += dirL * bend * iHeight;
transformed.y  -= bend * bend * iHeight * 0.5;
// 2) branch sway: slower, a phase per branch from attach
float bp = dot(attach, vec3(3.1, 1.7, 2.3));
transformed += vec3(dirL.x, 0.0, dirL.y) * sin(uTime * (1.1 + w) + bp) * 0.03 * (0.3 + w) * sway;
// 3) leaf flutter: fast and tiny, along the normal
transformed += normal * flutter * sin(uTime * (7.0 + 6.0 * w) + bp * 5.0 + position.x * 4.0) * 0.015 * (0.2 + w);
```

In storms, `w` reaches 1 and palms lean about 15° and thrash. Leaves also get a lightened underside colour where `flutter` is high (`col *= 1.0 + 0.15 * flutter * w`), the classic "leaves flipping silver in wind" look. Underwater plants (seagrass, sea fans) use the same function with `uTime * 0.4` and a long sideways surge.

### 4.3 LOD and population

- **LOD0** within 25 m: full model with flutter.
- **LOD1** from 25 to 150 m: about 15% of the triangles (trunk with 4 sides, crown of 1–3 blobs).
- **LOD2** beyond 150 m: a **single shared far-canopy mesh** with per-instance colour and a shape index (squashed icosahedron 20 tris for broadleaf, 6-arm star of 12 tris for palms and tree ferns, 8-tri cone for cactus columns). One draw call covers the whole island's canopy from the god view.
- **Changeover:** a 3 m dithered cross-fade (Bayer `discard`) with 10% hysteresis, so nothing pops.
- Grasses, mosses, lichens and purslane are **tint-only beyond LOD0**.

**Stable population (no flicker, nothing to save).** Each 2.5 m ecology cell has K fixed candidate spots (Poisson positions from a hash of the cell index), each with a hashed threshold. Spot *k* shows a plant when that cell's cover for a plant group exceeds threshold *k*, and hides below threshold − 0.05. Its species is chosen by a stable hash against the cell's species weights. So rising cover only *adds* plants and never shuffles them. Notable individuals ("your first fig") are pinned explicitly by the ecology simulation, which lets the journal point at them.

### 4.4 The 25 archetypes

The triangle columns are LOD0 / LOD1. All LOD2 versions use the shared far-canopy mesh or tint only.

| # | Plant | Where and when | Geometry recipe | Tris | Palette (sRGB) |
|---|---|---|---|---|---|
| 1 | **Crust lichens** | Bare rock, splash zone, stage 1+ | Shader only | 0 | `#c9cbb0` `#d9d3a0` `#e09a3a` `#a7b48d` |
| 2 | **Moss cushions** | Damp, shaded and windward rock | Tint, plus within 12 m 3–6 half-icosahedron domes hugging the slope | 50 / – | `#4a6b2a` `#5f8f2f` `#7fb03a` |
| 3 | **Sword fern** | Lava cracks (the first plant), forest floor | Rosette of 7–11 strips (8 segments, zigzag pinnae edge) arching out and down | 300 / 12 (3 crossed cards) | base `#4f8f36` to tips `#9ccc5a` |
| 4 | **Tree fern** | Wet windward slopes, cloud forest | 6-sided trunk with leaf-scar colour bands; crown of 10 arching 40-tri fronds; skirt of 3 hanging dead fronds | 520 / 40 | trunk `#4a3a2c`, frond `#5aa040` to `#a8d468`, skirt `#8b6a3e` |
| 5 | **Bunchgrass** | Flats, both sides | 12 bent 2-tri blades; tips lighter; seed heads in the dry mood | 24 / – | wet `#6fae4a`/`#9ccc5a`, dry `#c9b26b`/`#e2d08f`, seeds `#b58a5a` |
| 6 | **Sedge / rush** | Pond and stream edges | 16 stiff blades + 3 small cone seed heads | 50 / 8 | `#5e8a3a`, heads `#6b4a2a` |
| 7 | **Beach morning glory** (goat's-foot vine) | Upper beach, stage 2+ | A creeping runner ribbon along the sand (20–40 segments) with paired 6-tri bilobed leaves every 0.3 m and 5-tri trumpet flowers | 400 / tint | leaf `#3f8f3a`, flower `#d35fb7`, throat `#f6d9ef` |
| 8 | **Sea purslane** | Wrack line, salt flats | Mat of 30 fleshy 4-tri leaves on red stems; redder in the dry mood | 150 / tint | `#7fae4f`, stems `#b0473a` |
| 9 | **First wildflowers** (Bidens/Tridax-like) | Grassland, stage 3 | 3 stems, 8-tri discs with 6 petal tris | 80 / – | `#f2c230` centre `#b5761f`; white `#f5f2e6` |
| 10 | **Coconut palm** | Beaches (arrives by sea) | The existing `palm()`, slimmed to 8 fronds × 28 tris + a 6-sided trunk; coconuts as icosahedron detail 0 | 400 / 60 | existing `trunk`, `leaf`, `leafLight`, `coconut` |
| 11 | **Pandanus** (screw pine) | Cliff tops, strand | 4 stilt-root cones, a trunk forking 2–3 times, a spiral tuft of 14 drooping strap leaves per tip, faceted fruit (face colours alternating) | 900 / 120 | leaf `#5d8f4a` edges `#b9c98a`, trunk `#8a7a64`, fruit `#e3812e`/`#c9b23a` |
| 12 | **Sea grape** | Behind beaches | The existing `bush()` reshaped into clusters of round 8-tri leaves with a red midrib, plus hanging grape clusters; old leaves go red in the dry mood | 500 / 50 | `#5f9b44` `#8bc463`, vein `#a8443a`, grapes `#6b2e5a`, old leaf `#b4533a` |
| 13 | **Scaevola** (half-flower) | Dune mounds | 6–9 rosettes of glossy spoon leaves; white fan-shaped half-flowers | 400 / 40 | `#79b65a`, flower `#f6f2ea` |
| 14 | **Red mangrove** | Calm shallow bays, stage 4+ | Short trunk; 8–14 arched prop roots (4-side tubes from 1.3 m down to the mud, darker below waterline with a barnacle band); 4–6 glossy crown blobs; dangling cigar-shaped propagules | 1000 / 120 | crown `#2f6b33`/`#4f8f45`, roots `#4a3a2a`, barnacles `#c9c0aa`, propagules `#7a8f3a` |
| 15 | **Strangler fig / banyan** | Forest (arrives in bird guts) | Trunk as 5–7 twisted fused tubes; wide flat crown of 6–9 squashed blobs; 6–12 thin aerial roots dropping from branches; clusters of 1-tri figs. Scale up to 3× when ancient. | 1400 / 200 | leaf `#3e7a37`/`#5f9b44`, trunk `#9a8f80`, figs `#d8682a` |
| 16 | **Ohia-like flowering tree** | **First tree on young lava** | Gnarled recursive trunk (3 levels, kinked 5-side tubes); small 20-tri crown puffs at tips; red pom-pom flowers (12-tri starbursts) that bloom in pulses | 800 / 120 | leaf `#7a8f6a`, new growth `#b0503a`, flowers `#e0262a` |
| 17 | **Cloud-forest tree** | Peak in the cloud cap | Short twisted trunk with moss on its upper faces; dense dark crown; bromeliad rosettes on branches (6 straps, red heart); hanging beard-lichen ribbons that sway slowly | 1200 / 150 | trunk `#5a4d3d`, moss `#6f9a3a`, crown `#3b6b3f`, bromeliad heart `#c2383a`, beard `#c9d3a8` |
| 18 | **Lowland broadleaf** (gumbo-limbo-like) | General forest filler, 3 tint variants | Smooth copper trunk with peel spots; an open crown of 4–6 blobs | 700 / 100 | trunk `#b0603f`, peel `#6f8a5a`, crowns `#4f8a3e`/`#5f9b44`/`#6b9a3a` |
| 19 | **Prickly pear** | Dry lee side | Chained flat pads (32-tri lenses) 3–4 levels deep; pale areole dots; cup flowers; red fruit. Rigid, no sway. | 400 / 40 | pad `#6f9a5a`, flower `#f5d23a`, fruit `#b0304a` |
| 20 | **Tree cactus** (columnar) | Dry lee side | 3–6 ribbed columns (8-side cylinders with alternating radius) and candelabra arms | 350 / 30 | `#5f8f7f`, rib shadows `#486e60` |
| 21 | **Thorn scrub** (acacia-like) | Dry lee side | Zigzag thin trunk, flat umbrella crown of 2 squashed discs; nearly leafless in the dry mood (crown scale × 0.4, twigs showing) | 300 / 40 | `#8a9a6a`, twigs `#6b5a48` |
| 22 | **Silver bush** (beach heliotrope-like) | Strand | Silvery rosettes with curled white flower spikes | 350 / 40 | `#a9b8a0`, flower `#f4f2ea` |
| 23 | **Seagrass** | Shallow sand flats under water | 8 ribbon blades × 3 segments with slow surge | 48 / tint | `#4f8a3a` |
| 24 | **Corals** (rendered like plants) | Warm shallows once there is hard bottom | Brain coral: noisy hemisphere with groove colouring (80). Staghorn: branching 5-side tubes (200). Sea fan: flat disc with a procedural lattice `discard`, which sways (16). Table coral: plate (60). | 60–200 / 20 | `#e3a36a` `#c86e8a` `#7aa6c2` `#d9c27a`; fan `#8a4fa8`; bleached `#f2f0e8` |
| 25 | **Water lily and duckweed** | Freshwater pond | Notched 8-tri pads; white or pink cup flowers | 30 / tint | pad `#4f8f3a`, flower `#f6f0f4`/`#e7a1c4` |

Extra pieces: **fallen log** (40 tris; gains a moss tint over years; ferns appear beside it as a nurse log), **snag** (bare grey branches of 15–18, `#8f877c`, a favourite frigatebird perch) and **lava-tree mold** (a hollow basalt pillar of 30 tris, left where lava flowed around a trunk; this happens in nature).

### 4.5 How plants appear ("watch them pop up")

The whole sequence runs in the vertex shader from `iLife.x` (birth time): `g = clamp((uRealTime - birth) / 1.5, 0, 1)`. It takes **about 1.5 seconds, real time**:

| Time | What you see |
|---|---|
| 0.00–0.20 s | If a seed was seen arriving, a glint lands, puffs 4 dust motes, and plays a soft "pip". |
| 0.15–0.55 s | **Sprout:** height scales from 0 to 1.15 (ease-out-back) and width from 0.3 to 0.8. Stems reveal bottom-up: each vertex grows out once `g > grow`, via `smoothstep(grow*0.6, grow*0.6+0.3, g)`. |
| 0.45–1.20 s | **Unfurl:** leaf vertices expand from their `attach` points. **Ferns uncurl fiddleheads**: each frond rotates about its own side axis by `(1 - s) * grow * 4 rad`. **Palms open like an umbrella**, fronds starting as an upright spear and falling outward (real palms do this). **Flowers open last**, scaling up with a 20° twist. |
| 1.00–1.50 s | **Settle:** a damped spring brings height from 1.15 to 1.0 (two small wobbles). Six green-gold motes (`#e8f2a0`) drift up and fade. |

- **Maturing is a pop too, not slow growth.** When the ecology simulation moves a plant up a size class, it "breathes" to the new size in 0.6 s with 3% overshoot and a faint rustle.
- **Pacing during fast years:** a *pop queue* plays the animation only for plants that are on screen and within 60 m of the camera, at most 4 per second. First-of-a-species plants and trees jump the queue. Everything else (off screen, far, or over the rate) appears with a quiet 0.6 s scale-fade. So watching a hillside gives a steady, gentle sprinkle of pops, and the rest catches up silently.
- **Flowering** is a per-archetype uniform `uBloom[i]` scaling the `part == 2` vertices, pulsed by the season mood. The ohia flushes red and the morning glory goes pink in the wet mood. The bloom rises over 3 s and the island visibly blushes.

### 4.6 How plants disappear

- **Storm topple:** the plant pivots at its base about the axis across the wind, with angle `(π/2 − 0.1) * easeIn(t / 0.9 s)`, then bounces 0.15 rad and settles. Twelve leaf quads burst downwind. A fallen log replaces it and lasts N years. Palms rarely topple (they lose fronds instead: 3 fronds blow away as particles, and the crown scales to 0.7 then regrows with a "breathe").
- **Buried by lava:** for 1 s leaves curl (flutter amplitude ×3) and tint to char `#2a2420`, with an ember rim (emissive `#ff6a20` on high-`flutter` vertices) and 8 grey smoke puffs plus sparks. For the next 2 s the plant sinks by `height * easeIn` while the crown shrinks. A lava-tree mold remains where the flow was shallow.
- **Wither** (drought, salt, old age, shaded out): over 2 s the colour shifts toward straw `#b8a46a` then brown, leaves scale to 0.4, 4 leaves drop, and the plant dithers away. Old trees may become **snags** first.
- **Buried by your sand:** the plant sinks with the surface and fades. Trees keep their crowns above the new ground.

---

## 5. Animals (real-time pace)

### 5.1 Principles

- **Population comes from the ecology census; behaviour comes from the moment.** The simulation says "a booby colony of 800 on the north cliff." The renderer shows up to about 25 boobies near the camera plus a far "speck flock" (one `Points` draw of up to 400 dots circling) for the god view.
- **Agents live only near the camera** (within 150 m, spawned off-screen or at the horizon and despawned out of view), capped at 120.
- **No skeletons.** Every animation is a vertex deformation driven by per-instance `aAnim` = phase, amplitude, mode, rate. The CPU updates instance matrices for visible species only. The creature program is shared by all species.
- **Behaviours** are built from small parts: `Wander` (noise heading), `Seek/Arrive`, `Orbit` (circle a point, with drifting radius and height), `Perch` (go to a perch point), `FollowShore` (ride a shoreline polyline at an offset), `Boids`, `Burrow`, and a gentle `Startle` (only for the very close camera, for charm).
- **Perch providers** are queried from terrain and plants: cliff ledges (slope > 50°, height > 8 m, near the sea), crown tops of LOD0 trees, snags, rocks, pond edges.
- **Terrain queries** (`heightAt`, `slope`, `isWater`, distance to shore) come from a 2 m distance field recomputed when the land changes.

### 5.2 Animation recipes

- **Birds** (body 10 tris, head 4, tail 2, two-panel wings 4+4 per side; total ≈ 40; far = a 2-tri chevron). Each wing vertex stores its span position `s` (0–1) and side. Flap: `y += s * sin(A * sin(phase) + dihedral) * span`, with the outer panel lagging (`phase − 0.6`) for a natural whip. Gliding sets A → 0.1. The frigatebird has a fixed "M" kink (inner panel +12°, outer −10°). Its tail streamers are 2-tri ribbons that wave in a travelling sine.
- **Fish** (8–16 tris): tail wag `x += sin(phase − z * 4) * z² * 0.25`. A flank glint flashes when the turn rate is high (sun specular on the side), so shoals flash as they turn.
- **Rays** (32 tris): wing wave `y += sin(phase − |x| * 2.5) * |x| * 0.3`.
- **Crabs** (body capsule 30 + 8 legs × 2 + claws 8 ≈ 60): legs alternate in pairs by `sin(phase + legIndex * π / 2)` with lift on the forward stroke. Claws raise in display mode.
- **Turtles** (120): flippers rotate about their shoulder in symmetric "butterfly" strokes, and the body lifts a little each stroke.
- **Lizards** (60): S-curve body wave while running, head-bob, and a dewlap disc (6 tris) that scales from 0 to 1 three times.
- **Butterflies** (6 tris): two wing quads hinge ±70°. The wing pattern is computed from UV in the shader (orange with black veins as `smoothstep` lines along the UV radial, plus white spots by hash).
- **Dragonflies** (14 tris): 4 translucent wing quads that flicker at 25 Hz (alpha jitter) and shimmer pale blue.

### 5.3 Species sheet

| Species | Look (palette) | Behaviour (state machine) | Real-time speeds | Tris |
|---|---|---|---|---|
| **Brown booby** | Brown `#4a3a2e`, white belly `#f4f1ea`, yellow bill and feet `#e8c84a` | Orbit the colony (radius 20–60 m, height 15–40 m) → glide in → flare (pitch up, flap 8 Hz) → land on a ledge → stand and preen (head bob, wing stretch every 10–30 s) → drop off the ledge. Rare **plunge-dive**: fold wings from 12 m with a splash burst. | Cruise 12 m/s, flap 3.5 Hz with glides | 40 |
| **White-tailed tropicbird** | White, black eye stripe, 2 long tail streamers | Pairs display along cliffs: fluttery flight with synchronised glides; nests in cliff holes | 9 m/s, flap 4 Hz | 44 |
| **Frigatebird** | Black `#1e1e22`, male red throat pouch `#e0302a` (inflated while perched in the breeding mood) | Kites at 50–150 m, almost motionless (one flap per 20 s); perches on snags and shrubs; rare chase of a booby (fun, 6 s) | Soar 8 m/s | 40 |
| **Brown noddy / terns** | `#5a4a40` with a pale cap | Hover-dip over the shallows, then a noisy colony on low rocks | 8 m/s, flap 3 Hz | 36 |
| **Sandpipers / turnstones** | `#8a7458` back, white belly, orange legs | Flocks of 4–12 run with the swash (target = shoreline + wave-phase offset), stop and peck; flush and fly low 30 m along shore, then land | Run 1.5 m/s with legs blurring; fly 12 m/s | 30 |
| **Egret / night heron** | White `#f7f7f2`; heron grey `#7a8590` with a yellow crown | Stands still 30–120 s, slow step 0.3 m/s, strikes. Pond and mangrove. A serene focal point. | Walk 0.3 m/s | 50 |
| **Bananaquit / small songbirds** | Black `#262626`, yellow breast `#f4cc2a` | Flit between crowns (bounding flight: flap-flap-glide sine path), perch, hop on the ground (parabolic 0.3 s hops) | 6 m/s, flap 15 Hz (alpha-blurred wings) | 24 |
| **Ground dove** | `#a88f7a`, pinkish | Walks with a head-nod, feeds in grass, bursts off with clattering wings | Walk 0.4 m/s | 26 |
| **Hummingbird** | Green `#3f9a5a`, throat `#c2383a` | Hovers at flowers (wing blur disc), darts between them | 10 m/s darts | 18 |
| **Parrot** (late reward) | Green `#3f9a3a`, red forehead | Pairs fly over the forest at dawn and dusk, loud | 12 m/s | 40 |
| **Butterflies** (fritillary, sulphur) | `#e8742a`, `#f2d33a` | Noise wander biased toward flower instances; landing pauses | 1–2 m/s, flap 8 Hz | 6 |
| **Dragonflies** | Blue body `#3a7fd0` or red `#c23a2a` | Pond only: hover 0.5–2 s, dart 1–3 m in 0.2 s | 3–8 m/s | 14 |
| **Fireflies / click beetles** | Glow `#b8ff7a` | Night in forest: points with 1–2 s pulses drifting 0.2 m/s | – | point |
| **Ghost crab** | Sand-coloured `#e8d8b8`, dark eye stalks | Emerges from a burrow (a dark decal dot), sprints sideways, freezes, sprints, dives back in. Raises claws if the camera is under 1 m away. | Sprint 3 m/s for 0.4 s | 60 |
| **Land crab** | Blue `#3f5f9a`, purple legs | Wet mood and dusk: walks slowly out of forest burrows | 0.3 m/s | 60 |
| **Hermit crab** | Spiral shell (cone with twisted bands `#e8c8a8`/`#a87a5a`), legs `#9a3a5a` | Trundles along the wrack line; pulls into its shell when the camera is near and still | 0.05–0.1 m/s | 60 |
| **Green turtle** | Shell `#5a5a3a` with scute polygons in vertex colour, skin `#6b6a4a` | Nesting compressed to about 4 min: crawl up (60 s, leaving **paired flipper tracks** stamped as a decal) → dig with sand flicks (60 s) → rest (30 s) → cover (30 s) → crawl back. **Hatchlings** (40–80 at 8 tris) dash to the sea at dusk. Underwater: glides near seagrass, surfaces to breathe. | 0.1 m/s on land, 0.5 m/s swimming | 120 |
| **Anole / iguana / skink / gecko** | Anole `#6fae3a`, iguana `#7a8a5a` with orange flush, dewlap `#f0628a` | Basks facing the sun (minutes), head-bob and dewlap display, sprints, climbs trunks along the trunk axis. Geckos come out at night. | Sprint 1.5–2 m/s | 60 |
| **Fruit bats** | `#3a2e2a` silhouettes | Dusk exit from the roost fig, irregular flight between fruiting trees; hangs upside down in crowns | 6 m/s, flap 6 Hz | 24 |
| **Ducks** (pintail) | `#a8865a`, white cheek | Paddle with a small V-wake (particles), upend to feed | 0.3 m/s | 40 |
| **Reef fish shoals** | Chromis `#3a7fd0`, yellowtail `#f0d03a`, sergeant major (stripes from position banding), parrotfish `#3fbfa0` + `#e88aa8` | Boids (20–60 per shoal, grid-bucketed) with the shoal centre wandering inside the reef area; scatter and regroup in storms | 0.5–1.2 m/s | 8–16 |
| **Spotted eagle ray** | Dark `#3a3f4a` with white spots (hash) | Glides over sand flats with a 2–3 s wing wave; very rare leap | 1–2 m/s | 32 |
| **Dolphins** | `#7f8c95`, belly `#d9dde0` | Pods of 3–8 offshore, seen as dark shapes in clear water, porpoising in arcs every 3–6 s with splash particles | 5 m/s | 150 |
| **Humpback whale** | `#3b4048`, white flippers | Winter mood only, 300–800 m offshore: a blow every 30–60 s (50 mist particles rising 4 m and drifting), back arc, fluke-up dive. Very rare **breach**. | 2 m/s | 300 |

**Sightings, not schedules:** rare moments (breach, coral spawning, hatchling dash, frigate chase) roll their chances only when the camera is near the right place, and they become journal entries ("Year 1,804: a whale breached off your southern reef").

---

## 6. Arrival moments

Each arrival is a **short, calm vignette in real time (10–40 s)** that *stands for* something the years produced. The journal records the year. The camera **never moves on its own**: a small glinting marker at the screen edge points to the arrival, and tapping it glides the camera there.

- **By wind: spores and lichen.** A thin stream of 30–60 glinting motes (`#fff6d0`, sparkle as they turn toward the sun) drifts in from the upwind horizon, settles on rock, and a lichen patch blooms outward from a point over 2 s (an ecology texture stamp with a growing radius). Sound: an airy rising 3-note chime.
- **By wind: ballooning spider.** A single silk thread (a 2 px line strip, 8 segments, sagging and catching the light) with a dot at its end floats in on the breeze and lands on a fern.
- **By wind: insects after a storm.** Clouds of tiny specks, then 2–3 butterflies coming in low over the sea.
- **By sea: coconut.** A coconut bobs on the swell (it rides `waveHeight`, like the boat), drifts shoreward over about 20 s, is nudged up the beach by waves, rolls to rest above the swash, then the palm sprout pops in. Sound: a low wooden "tok" as it grounds.
- **By sea: drift seeds.** Several smaller seeds (brown discs, 8 tris) wash up together on the wrack line, and morning glory and sea purslane pop.
- **By sea: raft.** A log with a leafy branch (60 tris) drifts in after a storm with **1–3 lizards on it** (this happened in real life: iguanas reached Anguilla on hurricane debris in 1995). It grounds, and the lizards scamper into scrub.
- **By sea: first turtle.** A dark shape in the shallows, then the full nesting sequence.
- **By wings: seed in a gut.** A bird flies a long straight line in from the horizon (visible as a dot from 600 m), lands on the peak or a snag, preens for a few seconds and leaves. A moment later a seed glint drops, and a fig sapling pops where it fell.
- **By wings: mud on feet.** Ducks land on the pond, paddle, and leave. Sedges and lilies pop at the edges afterwards.
- **First of a kind** gets a slightly longer chime. A **milestone** (new stage reached, e.g. "your first forest") gets a gentle chord swell and the journal icon glows. The toast is a small paper ribbon in the corner (no clock), reading for example "A new page in your journal".

---

## 7. Storms (seasonal, light drama)

A storm takes about 90–120 s of real time whatever the year speed. It happens only in the wet-season mood, at most once per mood cycle, and the sky gives about 20 s of warning.

| Phase | Time | Visuals |
|---|---|---|
| **Build-up** | 20–30 s | Sky blends toward storm colours (zenith `#4d5966`, horizon `#9aa6ad`). Extra dark cumulus (the existing cloud recipe with emissive `#6b7680`) slides in from upwind, plus a flat grey cloud deck (a big low-alpha dome band). The sun drops to 0.6 and the light turns cooler. Fog pulls in (start 60 → 30 m, end 900 → 400 m, colour `#8b969c`). Wind rises 0.2 → 0.8 and grass waves speed up. Birds head to perches and crabs go into burrows. |
| **Peak** | 40–60 s | **Rain:** 1500 camera-attached instanced streaks (2 tris each, `#d8e2ea` at 0.35 alpha), positioned in the vertex shader with `p.y = H - mod(t*speed + seed*H, H)`, wrapped in xz around the camera and slanted by the wind. The water shader gets a rain term (high-frequency ripple noise and dulled reflections). **Sea:** wave amplitude ×4 plus a long swell, whitecaps where crest height and noise exceed a threshold, colour desaturated toward `#4f7c80`, spray particles at rocky shores. **Wind** reaches 1: palms lean and thrash, leaves flip silver, 200 tumbling leaf quads fly. **Lightning:** see below. |
| **Clearing** | 20–30 s | The clouds break from the upwind side. A shaft of light (an additive cone with soft noise, 0.12 alpha) falls through. The rain fades. |
| **Aftermath** | 40 s | `uFresh` boosts saturation by +12% and decays. Rock and sand stay glossy wet (the wetness uniform drains). A **rainbow** appears opposite the sun. New wrack and seaweed lie on the beach, and arrivals often follow (raft, storm-blown birds). Some trees have toppled; nothing is ever wiped out. |

**Lightning** (photosensitivity-safe): at most one flash every 6 s, only during the peak. The sky flash is at most +35% brightness for 0.12 s with one re-strobe at +20%, and there is a setting to turn flashes off. The bolt is a midpoint-displacement polyline (6 levels, 64 segments, plus 2 branches) drawn as camera-facing ribbons: core `#efeaff`, a halo ribbon `#9b8cff` at 0.25 alpha, additive, shown for 0.18 s. It strikes far over the sea, never the island.

**Rainbow** (in the sky shader, no image): `a = acos(dot(d, -uSunDir))`. A primary band at 40.5–42.5° with hue mapped red outside to violet inside, and a faint secondary at 50–53° with the order reversed and 0.3 strength. Masked above the horizon, fading in over 8 s after rain, held for 30 s, then fading.

---

## 8. Light, day and night, and seasons

Because years pass about every second, light **never** follows ecological time. It runs on its own calm real-time cycle.

**The living day cycle is 14 minutes** (an option offers "always golden hour" or "always midday"):
- dawn 1.5 min
- day 7 min (with 1.5 min of golden afternoon at the end)
- dusk 1.5 min
- night 3 min (moonlit and readable, never black; shaping still works)

Animals follow this day: bats at dusk, turtles and crabs at night, fireflies, frogs, the dawn chorus. Real-time animals plus real-time light keep the world coherent.

| Key | Zenith | Horizon | Sun/moon colour | Sun intensity | Hemi sky / ground | Fog |
|---|---|---|---|---|---|---|
| Dawn | `#6f8fc8` | `#f6c7a1` | `#ffd3a0` | 1.4 | `#bcd0f0` / `#c8a88a` | `#f0d2bc` |
| Day | `#3d9be9` | `#d9f1ff` | `#fff2d6` | 2.9 | `#cfe9ff` / `#e8d4a8` | `#d9f1ff` |
| Golden | `#4a86d4` | `#ffe0b0` | `#ffc98a` | 2.2 | `#d6e2f5` / `#e8c89a` | `#f4e2c8` |
| Dusk | `#3b4a8c` | `#f59a7a` | `#ff8a5c` | 0.9 | `#8a90c0` / `#a07a6a` | `#c89a9a` |
| Night | `#0e1a3a` | `#2b3d66` | moon `#c9d8ff` | 0.55 | `#3a4f80` / `#2a2a38` | `#24324f` |
| Storm | `#4d5966` | `#9aa6ad` | `#e0e4e8` | 0.6 | `#9aa6b0` / `#6a6a62` | `#8b969c` |

The night sky shader adds:
- **Stars:** `step(0.9985, hash(floor(d * 300)))` with slow twinkle, plus a faint Milky Way band (noise along a tilted great circle).
- **Moon:** a disc whose phase comes from its angle to the sun.
- **Moonglade:** the existing water reflection term picks up the moon.

The sun's direction also drives the shadow direction, which makes the golden hour lovely.

**Seasons are a mood, not a calendar.** The visible season alternates **wet ↔ dry once per day cycle** (one full year-mood every 28 minutes), blending over about 2 minutes around dawn.
- **Wet mood:** windward greens deepen, the cloud cap thickens on peaks above about 50 m, flowering pulses, frogs, storms possible.
- **Dry mood:** lee grass turns golden through `uDryness`, thorn scrub drops its leaves, sea grape reddens, a clearer sky with warm haze, and the sound of cicadas.

The journal's years are independent. The ecology simulation can still use its real seasons internally; the screen just shows an average, unhurried mood.

**The cloud cap** is the island's signature. When a peak exceeds about 50 m, 6–10 cloud puffs anchor to its windward shoulder and churn slowly. Mist wisps (soft billboard layers, 0.2 alpha, sliding uphill) drift through the cloud forest. From the god view this shows the rain-shadow story at a glance.

---

## 9. Sound

### 9.1 Architecture

```
loops & one-shots -> [bus: ambience] -\
                     [bus: life]     --+-> [altitude/distance LPF] -> master -> compressor(-14 dB, 3:1) -> out
                     [bus: weather]  -/                                   ^
                     [bus: tools]  ------------------------------------- -+
                     [bus: chimes] -> (dry) + send -> [reverb: generated IR, 1.2 s] -/
```

- **Panning:** a `StereoPanner` per voice, from screen-x of the source. Volume falls with `1 / (1 + d/15)`. No HRTF `PannerNode` (too costly on phones).
- **Reverb:** one `ConvolverNode` on a send bus, with an impulse response *generated in code* (exponentially decaying noise, 1.2 s, slightly darker toward the end). It is used for distant birds, thunder and chimes. Fast tier swaps it for a 2-tap feedback delay.
- **Baked beds:** at startup, or lazily when a layer first becomes audible, `OfflineAudioContext` renders 10 s loops of dense textures (cricket chorus, coqui chorus, cicada swell, colony murmur, rain on leaves, distant surf variants), with the last 1 s crossfaded into the start so they loop seamlessly. Each plays as a looping `AudioBufferSource` at a random offset with gain automation. A whole chorus then costs about one node of CPU. Memory is about 1.7 MB per bed, so 8 beds come to under 14 MB. **This is still "made in code": nothing is stored.**
- **Phrases, not notes:** a 20-note bird trill is *one* oscillator plus one gain with scheduled `setValueAtTime` and ramp automation, not 20 nodes. Look-ahead scheduling runs 100 ms ahead.
- **Limits:** ≤ 10 continuous loops; ≤ 12 new one-shot voices per second; ≤ 6 bird phrases at once (the oldest is faded out); ≤ 40 live nodes typical.

### 9.2 The soundscape grows with the island

Each layer's gain = (ecology census near the listener) × (time-of-day curve) × (season) × (weather) × (altitude factor). The **listener** is the camera target. The **altitude factor** fades life layers by `1 - smoothstep(40, 300, camDist)` and opens a high "god view" layer of soft high-altitude air and blended surf, so the whole island hums faintly from above and bursts into detail as you come down.

| Stage | What you hear |
|---|---|
| Newborn | Low wind over rock with whistles through cracks, lava hiss, crackle and rumble, steam roar at the shore, surf on black sand. **No life at all**, which is meaningful. |
| Crust | Wind, surf, the first lone tern calls, occasional gull-like cries passing. |
| Moss / ferns | Seabird colony murmur near cliffs, ghost crab scuttles (tiny ticks), insects begin (a few crickets at night). |
| Grass / strand | Cicadas in the dry mood, crickets in chorus, grass rustle (wind bed with a high-shelf boost by grass cover), shorebird peeps. |
| Shrubs | Songbirds (bananaquit trills, dove coos), bees at flowers, frogs once there is fresh water. |
| Forest | Dawn chorus, coqui-like frog chorus at night, bats squabbling at dusk, parrots at dawn and dusk, leaf rustle, rain on leaves, shearwater wails from cliff burrows at night. |

### 9.3 Synthesis recipes

The notation: `noise`/`brown` are the existing 2 s buffers, `BP` is bandpass, `LP`/`HP` are low/highpass, and `env` is attack/decay.

**Ambience**
- **Wind over bare rock:** brown → LP 300 Hz, gain 0.03 with a 0.05 Hz LFO. Plus a crack whistle: noise → BP 900–1400 Hz (Q 8; centre wanders by LFO 0.03 Hz) → gain 0.006–0.015, tied to gusts. Whistles fade as vegetation cover rises (the land "softens"), and a leaf-rustle layer takes over: noise → BP 2.5 kHz Q 0.6 → gain × wind × forest cover.
- **Surf:** the existing lapping wash. Rocky coasts add thumps (sine 60 → 45 Hz, 0.35 s decay, gain 0.1) and splash (noise → BP 1.8 kHz, 0.4 s). Storm surf: brown → LP opening 400 → 1800 Hz per wave, gain ×3.
- **High-altitude air** (god view): pink-ish noise → LP 600 Hz → gain 0.02, slow swell.

**Lava and steam**
- **Hiss:** noise → HP 3 kHz → BP 5 kHz Q 0.5 → gain = 0.05 × molten area.
- **Crackle:** a Poisson click train (5–30 per second × activity), each click a noise grain 2–8 ms → BP 1–4 kHz Q 2, random gain 0.02–0.08. Uses the existing `grain()`.
- **Glug / rumble while pouring:** brown → LP 150 Hz, AM by a 3–6 Hz LFO → gain 0.12, plus sine 38 Hz at gain 0.05.
- **Steam at the sea:** noise → BP 1.5 kHz Q 0.7 → gain 0.08 × contact, plus sharp hiss bursts (HP 4 kHz, 80 ms) and bubble pops (sine chirp 300 → 900 Hz, 30 ms).
- **Cooling tinkle:** as crust forms, sparse glassy pings: sine 3–6 kHz, 1 ms attack, 80 ms decay, gain 0.01, about 1–3 per second, slowing as it cools. Cooling lava really tinkles, and this is a small magical detail.

**Insects**
- **Cricket:** sine 4.6 kHz (±150 per individual) gated by a pulse train (3–5 pulses at 30 Hz per chirp, a chirp every 0.6 s). Baked as a 10 s chorus of 12 detuned crickets with random timing.
- **Cicada:** noise → BP 5.5 kHz Q 3, amplitude-modulated by a 200 Hz square through a smoothing LP (a rasp), with an envelope that swells over 6 s, holds and drops. Baked, dry mood, daytime.
- **Bee:** sawtooth 220 Hz ±6 Hz vibrato → LP 900 Hz → gain 0.01, near flowers within 6 m.

**Frogs**
- **Coqui-like "ko-KEE":** sine 1150 Hz for 90 ms (env 5/40 ms), gap 30 ms, then sine 1950 → 2450 Hz exponential over 140 ms. Gain 0.02, random pan. Baked into a 10 s chorus of 6–10 frogs, night plus wet mood plus forest.
- **Pond frog "grunk":** square 120 Hz → BP 400 Hz Q 4, AM 25 Hz, 0.25 s, gain 0.03.

**Birds** (one generic `BirdVoice`: sine carrier + optional FM modulator (ratio r, index I) + optional noise → BP → gain; a *song grammar* per species):

| Species | Recipe |
|---|---|
| Bananaquit | Trill: 12–20 notes of 40 ms, carrier jumping randomly among 6.2, 6.8, 7.4, 8.0 kHz, slight upward glide per note, gain 0.012 |
| Ground dove | "coo-oo-oo": sine 520 → 470 Hz glide, 3–5 syllables of 250 ms with soft attack, plus 5% breathy noise BP 600 Hz; LP 1.2 kHz |
| Mockingbird-like (late) | Phrase generator mixing other species' motifs ×2–3 repeats (it mimics the island's own birds) |
| Tropicbird | Shrill "kreek": sine 3.4 → 3.8 kHz, 120 ms, FM r 1.5 I 200 |
| Brown booby | Honk/whistle: square 380 Hz → BP 900 Hz Q 3, 200 ms, pitch drop 15%; colony = baked murmur of 40 overlapping |
| Tern / noddy | "kee-arr": sawtooth 2.2 → 1.4 kHz over 250 ms + 20% noise → BP 2 kHz |
| Frigatebird | Silent in flight; at roost, bill clatter (8–12 noise clicks at 20 Hz); male drumming "puk" (sine 200 Hz, 60 ms, ×6) |
| Shearwater (night) | Eerie wail: sawtooth → two BP formants (600 Hz, 1200 Hz), pitch gliding 300 → 450 → 280 Hz over 1.2 s; through the reverb send |
| Sandpiper | "peep": sine 3.6 → 3.2 kHz, 60 ms, in quick pairs when flushed |
| Parrot | Squawk: sawtooth 900 Hz, FM r 2.3 I 600, noise 30%, BP 1.8 kHz Q 1, 180 ms |
| Owl (late, night) | Soft hoots: sine 380 Hz with 6 Hz vibrato, LP 800 Hz |

**Bats:** squabble chirps (noise → BP 3 kHz Q 6, 25 ms, in bursts of 3–6) plus leathery flaps (noise → LP 400 Hz, 50 ms at the wingbeat rate when within 5 m).

**Whale:** blow "pfffhh" = noise → BP 700 Hz Q 0.8, 0.7 s, gain by distance. Optional, when the camera is low near the sea and a whale is close: a song fragment of sine glides 150–600 Hz with 4 Hz vibrato, LP 1 kHz, heavy reverb send, very quiet.

**Weather**
- **Rain:** noise → HP 1 kHz → LP 9 kHz, gain 0.12 × intensity. Plus surface beds: on rock (brighter, HP 2 kHz), on leaves (baked: 200 random pings per second, sine 1.5–5 kHz with 15 ms decay), on sea (a softer brown wash). These are mixed by what is under the listener.
- **Thunder:** brown → LP sweeping 900 → 90 Hz over 3.5 s, envelope attack 30 ms (near) or 400 ms (far), decay 5 s with 2–3 random re-swells, through the reverb send. A near strike adds a crack first (noise HP 2 kHz, 40 ms). Delay after the flash = distance/343, capped at 8 s.
- **Gusts:** the wind bed's BP centre rises from 700 to 1100 Hz and its gain doubles on gust peaks.

### 9.4 Tool sounds

- **Pour sand:** the existing pour hiss and slump trickle.
- **Place rock:** a clatter of 6–12 grains (BP 400–1500 Hz, Q 3, 40–120 ms decay) plus a landing thud (sine 80 → 50 Hz, 0.2 s). Bigger rocks are lower.
- **Pour lava:** the glug/rumble, hiss and crackle above, plus a sizzle if it touches water.
- **Smooth:** the existing pat and rub grains, softened.

### 9.5 Arrival chimes

All chimes use **one key** (A major pentatonic: A, B, C♯, E, F♯), so overlapping chimes stay consonant with each other and with the bird tones. They sit very quiet (peak around −24 dBFS) with a reverb send.
- **Glass bell voice:** 3 sine partials at ratios 1, 2.756, 5.404 with decays 2.5 / 1.2 / 0.5 s.
- **Wind arrival:** rising 3 notes (E5, F♯5, A5) plus an airy noise breath (BP 4 kHz, 0.6 s).
- **Sea arrival:** a falling 3-note motif an octave lower, played on a soft marimba (sine with a 4× partial and fast decay) plus a bubble pop.
- **Wings arrival:** two quick glides (C♯6 → E6, then E6 → A6) like a call.
- **New species:** a 5-note motif.
- **Milestone:** a slow pad chord (4 detuned sines per note through LP 1.5 kHz, 3 s swell).

There is no music track: the soundscape is the music. An optional "dawn pad" (very soft, about 40 s, at sunrise) could come later if the owner wants it.

---

## 10. Camera

- **Range:** orbit distance from **0.8 m to 900 m**, with exponential zoom (pinch, wheel) toward the point under the fingers (existing behaviour).
  - Pitch 0.04–1.45 rad when close, so the camera can go eye-level with a crab.
  - Above 200 m the minimum pitch rises smoothly to 0.5 rad, so the god view stays map-like and never looks at an empty horizon.
- **Depth range:** near = `clamp(dist * 0.015, 0.02, 3)`, far = 6000. No logarithmic depth (it is costly on Mali).
- **Fog** scales with distance (start `dist * 1.5 + 40`, end 2500), keeping the horizon soft at every zoom.
- **Field of view** is 45° at god view and eases to 55° when close, which makes close-ups feel intimate.
- **Shadows** follow the target, with a frustum of `clamp(dist * 0.9, 3, 60)` and none beyond 150 m. At god view, depth comes from the canopy-shade term, AO and the slope-darkening term instead.
- **Watch a creature:** tap an animal to follow it. The camera eases to keep it framed, without snapping, and the follow ends on any touch.
- **Postcard drift:** after 60 s idle, the camera slowly orbits (0.6°/s) and drifts in altitude. It is a calm screensaver that suits "watching years fly."
- **Journal "show me":** each journal entry can glide the camera to where it happened (a 3–4 s eased glide).
- **No underwater camera** (cost, plus a second scene look). The clear shallows, caustics and low angles show the reef. The camera is clamped 0.3 m above the waves.
- **God-view polish:** a CSS radial vignette (pure code, no image) at 8% that fades out when close, plus +6% saturation, giving a gentle diorama feel without post-processing.

---

## 11. The journal, briefly

A field-notebook panel made in CSS: cream `#f6efdf` with faint ruled lines from `repeating-linear-gradient`, ink `#3b3328`, accents in faded watercolour washes from radial gradients.
- **The year appears only here,** at the top of each page.
- **Each species gets a live "sketch":** its own 3D model rendered once, at runtime, into a small canvas with an ink-style shader (flat cream fill, darkened rim, hatching from screen-space lines). It is drawn fresh each time and never stored as an image file, which respects the no-images rule.
- **Entries** carry short stories ("Year 212: a frigatebird rested on your peak; a seed it carried became your first fig tree"), with a ⌖ button that glides the camera to the place.

---

## 12. Suggested build order (art and audio)

1. Ground shader with eco textures, all four sand kinds, the basalt age ramp and lava. Steam particles and hot water.
2. The plant kit with the shared material, wind, the pop-in and the stable population, starting with ferns, lichen, moss, grass, morning glory, coconut palm and ohia. Then add the other archetypes in batches.
3. The day cycle, the season mood and the cloud cap.
4. The creature kit (birds, crabs, fish shoals), then the remaining species.
5. Arrival vignettes and the chimes.
6. Storms (rain, lightning, rainbow) and the aftermath.
7. The soundscape: baked beds and the bird grammar.
8. Journal sketches.

Profile on the Pixel at every step with the existing `#debug` readout and the adaptive quality ladder.