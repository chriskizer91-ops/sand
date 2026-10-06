# Life System Design: how life finds the island

*(Written for the build sessions. One short plain-language summary for the owner comes first.)*

## 0. In plain words

You shape land. The sea, the wind and the birds do the rest. About three years pass every second. Tiny things arrive first: a spider on a silk thread, a dark film of algae, a pale lichen. Ferns, beach flowers and resting seabirds come next. Later come forests, lizards riding in on storm-washed logs, fruit bats and songbirds. The island's shape decides who can stay:
- A tall peak catches clouds. One side becomes rainforest and the other stays dry scrub.
- A flat sandy cay draws turtles and tern colonies.
- A pond brings ducks and dragonflies.
- A ring of islets makes a lagoon where reef sharks raise their pups and the water glows at night.

New arrivals slow down as the island fills up, and speed up again whenever you give life somewhere new to live. Storms knock things back a little, and they also bring new settlers. Everything is written in the field journal, which is the only place where years are shown.

---

## 1. Pillars

1. **Shape is the only lever.** The player never places life and never controls weather. Every ecological outcome comes from land, sea and rock geometry. The game's only hints are the journal's "couldn't stay" stories.
2. **Real ecology, real stories.** Every mechanism has a real-world source, such as Surtsey, Krakatau, Hawaiʻi or Galápagos. Every species has a true fact.
3. **Two clocks.** Plants, soil and populations run on the fast *ecological clock*. Animals on screen run on the *living-moment clock*, at real speed.
4. **Gentle loss.** Nothing is lost for good. Local losses are temporary and are told kindly.
5. **Cheap.** The whole system is typed arrays in a worker, using about 2 MB and less than 1% of one phone core.

---

## 2. Time: two clocks

### 2.1 Ecological clock
- The default is **3 simulated years per real second**. Settings offer Gentle (1 yr/s), Default (3) and Brisk (10).
  - 1 minute = 180 years, 10 minutes = 1,800 years, 1 hour ≈ 10,800 years.
- The clock runs only while the game is visible. While it is hidden the simulation pauses, so nothing is "missed" and there is no worry about leaving.
- During a **great storm** the clock holds (§8.2): for that minute, the year stands still.
- Years appear only in the journal and the field guide. The open journal's header shows "Year 2,316". There is no clock on the main screen.

### 2.2 Living-moment clock
- The visible day/night cycle is about 20 real minutes per day and is purely for looks. Animals act on it:
  - Shearwaters return at dusk and wail at night.
  - Geckos chirp and ghost crabs hunt at night.
  - Turtles nest at night and hatchlings run at dawn.
  - Bats fly at dusk. Spider silk glints at sunrise.
- Animals on screen are *representatives* of their island's population. They are never individuals tracked across centuries, which is why they can move at natural pace while centuries pass.
- Real speeds: tortoise ~0.3 km/h, turtle crawl ~0.5 m/s in short bursts, crabs scuttle, boobies glide.

### 2.3 How real timelines map onto play (default pace)

The default island is **800 km downwind of a mainland**. That puts it between Surtsey/Krakatau (20–44 km offshore) and Galápagos/Hawaiʻi (1,000–4,000 km). Succession runs at real rates. **Arrivals** are the bottleneck that spreads the story across hours.

| Real benchmark | Real time | In play |
|---|---|---|
| Krakatau: one spider, 9 months after 1883 | <1 yr | First arrival within 5–20 s of first land (enforced floor) |
| Stereocaulon lichen covers wet Hawaiian lava | ~4 yr | ~1–2 s after spores land |
| Club moss and uluhe fern dominate wet Mauna Loa lava | ~50 yr | ~17 s |
| ʻŌhiʻa forest on wet lava | 140–400 yr | 1–2 min, once ʻōhiʻa has arrived |
| Dry lee lava stays barren | 75–100+ yr | 30–60 s or more |
| Surtsey: 10 vascular plants | 10 yr (1974) | ~3 min (we are 40× farther away) |
| Rakata: ~26 plant species | 3 yr (1886) | ~10–15 min |
| Reef climbs 10 m at ~3 mm/yr | ~3,300 yr | ~18 min |
| Pioneer tree life / ʻōhiʻa life | 50 / 300–500 yr | 17 s / 2–3 min |
| Great storm on one island | ~1 per 100+ yr | Shown every 8–15 min (§8) |

**Lava cools in real time**, because the player needs to see it:
- glowing → dark crust in 3–5 s
- black rock in 10–20 s (thick piles longer)

When it cools, the life simulation treats the patch as "fresh basalt, age 0". Thick piles stay **warm ground** for 50–200 sim years, with steam wisps; megapodes use it.

### 2.4 Pacing "director" (light touch, disclosed)
- **Floor:** if land exists and nothing has arrived after 20 s, force a wind-borne microbe or spider arrival.
- **Lull guard:** if no journal-worthy event has happened for 90 s and some arrival is *plausible* (its habitat exists), raise that species' rate ×3 until something lands.
- **Spam guard:** at most one headline journal entry every 20 s. Other entries queue or fold into "Also arrived this century…".

On average this keeps the MacArthur–Wilson model intact. It only removes dull stretches and bursts.

---

## 3. The grid: what life reads from the land

### 3.1 Scale
- **Life grid:** 192 × 192 = 36,864 patches over the whole zone.
- **Life-sim reckoning** (separate from voxel render scale): one patch ≈ 52 m.
  - The zone is about 10 km × 10 km of sea.
  - A 400-patch island ≈ 1.1 km², about Surtsey's size.
- **Climatic altitude** = terrain height ÷ max build height × 3,000 m, so a maximum-height peak pokes through the cloud ceiling.
  - Cloud and rain belt: 600–2,200 climatic m.
  - Rain maximum: 600–900 m.
  - Dry alpine zone: above the 2,200 m trade-wind inversion. These are Hawaiian values.
- **Active patches:** only land, water shallower than the reef limit, and a 2-patch ring around them are simulated. That is typically 2k–20k patches. Deep sea is skipped.

### 3.2 Per-patch fields from terrain

The sand engine supplies a surface summary per patch: top height, top material, overhang/tunnel flag, hot-lava flag and water depth.

| Field | Type | How |
|---|---|---|
| `h` | Int16 | Top solid height, plus climatic altitude |
| `slope`, `windward` | Uint8, Int8 | Central differences. Windward = dot(slope normal, −wind) |
| `substrate` | Uint8 enum | DEEP, SHALLOW_SAND, SHALLOW_ROCK, LAVA_HOT, BASALT, CINDER, BLACK_SAND, WHITE_SAND, POND, SALT_POND |
| `subAge` | Uint16 | Years since this surface last changed |
| `island` | Uint8 | Connected-component flood fill on land, ≤15 islands |
| `coastDist` | Uint8 | Two-pass chamfer distance transform, O(n) |
| `flags` | Uint16 | CLIFF, CAVE, BEACH, STREAM, LAGOON, WARM, OVERWASH, SUMMIT, FRESH_LENS, ESTUARY |

### 3.3 Derived climate (O(n) passes, recomputed after terrain settles, throttled to ≤1 per second)

- **Trade wind** is fixed, blowing from the east (very slightly northeast). The mainland and the drift current are also to the east, so windward shores catch flotsam.
- **Rain** uses the orographic "air parcel" sweep:
  - March each row downwind with moisture `q` = 1 offshore.
  - Upslope rain = k·q·max(0, Δh_climatic). Baseline rain = 900 mm·q. The fog belt adds rain between 600 and 2,200 m.
  - Subtract the rain that falls from `q`. Over sea, `q` recovers 2% per patch.
  - Above 2,200 m, rain ×0.15 and no fog.
  - Blur 3×3 twice to remove streaks.
  - Real anchors:
    - windward coast 1,500–3,000 mm
    - rain belt up to 8,000+ mm
    - lee coast 250–500 mm
    - low cays 800–1,200 mm (no lift)
- **Fog:** `q` × wind exposure × belt membership. This drives cloud forest, mosses and epiphytes.
- **Temperature:** 27 °C − 6.5 °C/km × climatic altitude.
- **Salt spray:** exp(−coast distance in m / 60) × (0.4 + 0.6 × windwardness). ×3 during storms.
- **Freshwater lens** (sand islands only). Ghyben–Herzberg: fresh water floats on salt water, reaching about 40 m below sea level for every metre above. In-game, lens quality = clamp((coast distance in m − 40)/100) × rain factor. Narrow islets hold almost none, and wide cays can support trees and ponds.
- **Ponds:** priority-flood depression fill (O(n log n), about 5 ms).
  - A depression above sea level whose catchment rain exceeds evaporation becomes POND.
  - On low dry islands, or within 2 patches of the sea, it becomes SALT_POND.
- **Streams:** D8 flow accumulation weighted by rain, above a threshold. Mark STREAM. Note whether it reaches the sea, because amphidromous gobies and shrimp need that connection.
- **Cliff:** slope > 55° with a drop of more than 1 patch-height. **Cave:** from the engine's overhang/tunnel flag (sea caves, lava tubes, arches).
- **Shelter/lagoon** (water patches): cast 8 rays. If land lies within 300 m on ≥5 rays and upwind fetch is short, mark LAGOON. Exposed reef flats get high wave energy.
- **Reef zone:** water 0–25 m deep, hard or rubble bottom, not within 2 patches of a stream mouth (silt), and not on lava younger than 30 years.

---

## 4. Patch ecology: soil, nutrients, layers, succession

### 4.1 State per patch (about 45 bytes; ~1.7 MB for the full grid)

| Field | Meaning |
|---|---|
| `soil` (Uint8, cm) | Virtual soil depth. The life sim owns it; it is never voxels |
| `N`, `P` (Uint8) | Nitrogen and phosphorus. Fresh basalt starts P≈120, N 0. Coral sand starts P≈20 |
| `moist` (Uint8) | Derived each update; also sent to the renderer for drought tint |
| `guano` (Uint8) | Current input from seabird colonies |
| `ground`, `herb`, `shrub`, `canopy` | Each layer is {species Uint8, cover Uint8}; canopy adds `age` |
| `logs` (Uint8) | Fallen trunks and nurse logs |
| `disturb` (Uint8) | Years since last disturbance (log-scaled) |
| `habitat` (Uint32) | Habitat-class bitmask (§6.1) |

In water patches the same layers mean:
- ground = coralline algae
- herb = seagrass
- shrub = coral cover
- canopy = mangrove

### 4.2 Soil and nutrients (per visit, `dt` = years since last visit)
- **Weathering**, basalt: 0.0005 + 0.004 × rain × warmth cm/yr. Cinder or ash ×3. Sand: 0.
- **Organic build-up:** 0.02 × total cover × moisture cm/yr. Wet basalt gets ~2 cm per century under full cover.
- **Guano:** +0.01–0.05 cm/yr in colonies. Colonies also add N and P, which is how a coral cay grows the phosphate-rich soils under Pisonia.
- **Erosion:** 0.03 × slope² × rain × (1 − cover).
- **Nitrogen** is added by fixers: cyanobacteria crust, Stereocaulon, beach pea, Casuarina, koa, Azolla. Guano and lightning-rain add a little more. Rain leaches it away.
- **Phosphorus** comes from basalt weathering and guano.
- **Resulting timelines:**
  - wet windward lava: 5 cm in ~150 yr, 15 cm in ~500 yr
  - dry lee lava: 5–10× slower
  - sand with a seabird colony: 10 cm in ~200 yr
- **Moisture** = clamp(0.15 + rain × (0.4 + 0.6 × soil water-holding) + 0.35 × fog + 0.4 × lens) × drought multiplier − 0.2 × salt.

### 4.3 Layer update (the succession engine)
Light at each layer = 1 − 0.9 × canopy cover − 0.5 × shrub cover (applied to herb and ground). Update canopy, then shrub, herb, ground.

**Occupied layer:**
- Cover grows by `growRate × suit × dt`.
- If suitability drops below 0.15 (drought, salt, burial), cover dies back.
- At the end of its lifespan the plant "renews": the same species replaces itself with probability `shadeTol × suit`. Late, shade-tolerant species self-replace. Pioneers do not regenerate under their own canopy, so they open a gap.
  - **Visual stability:** same-species renewal is invisible. Only species turnover or disturbance changes what is drawn.

**Empty layer:** gather up to 8 candidates:
1. Species dominant in this layer among the 4 neighbours (local spread, weighted by the species' spread rate).
2. Two or three draws from the island's per-layer alias table:
   - wind-dispersed species: any patch
   - bird- or bat-dispersed species: weighted by the patch's *perch score* (nearby trees, cliffs, colonies) × disperser abundance
   - sea-drift species: BEACH patches only
   - seed-bank species: anywhere they recently grew, for up to 300 years after they were last seen
3. Score = suit × light fit × reach. The best scorer establishes with p = score × dt / years-to-establish.

**Suitability `suit(s, patch)`** is a product of trapezoid terms over:
- substrate mask, minimum soil, moisture range, salt tolerance, altitude band
- N and P need, shade tolerance, maximum slope, required flags (POND, LAGOON, CLIFF, WARM…)
- island-level gates (pollinator present, host present)

That is about 30 operations from a 16-byte packed species record.

**Microsite boosts:**
- Logs or tree ferns ×2 for ʻōhiʻa and fig seedlings (nurse logs).
- Crust or moss ×1.5 for ferns.
- Guano favours sea purslane and Xanthoria and suppresses most trees, except Pisonia, which needs it.

### 4.4 Succession pathways (these emerge from the species envelopes)

- **A. Wet windward basalt:** bare → crust (0–5 yr) → Stereocaulon → Racomitrium moss and ʻamaʻu ferns in cracks → uluhe thickets with first ʻōhiʻa → open ʻōhiʻa forest with tree ferns → closed wet forest (figs, koa, orchids). In the fog belt: cloud forest.
- **B. Dry lee basalt:** barren for 75–100+ yr → lichens → pili grass and ʻaʻaliʻi → dry scrub with tree prickly pear and sandalwood. Tortoise turf forms if tortoises are present.
- **C. Sand beach or cay:** wrack-line sea rocket and purslane → morning glory, beach pea, sea oats (which build dunes) → naupaka and heliotrope scrub → coconut, pandanus, almond, she-oak. **Pisonia** grows only where guano is present.
- **D. Seabird colony:** orange lichen on perches. Heavy guano keeps tern and booby ground open, which those birds want, so the colony sustains itself.
- **E. Fresh pond:** algae → Azolla and sedges → marsh margin. Ducks, dragonflies and herons follow.
- **F. Salt pond:** microbial mat → brine shrimp → flamingos. Black mangrove grows at the margins.
- **G. Sheltered intertidal:** red mangrove on the seaward side, black mangrove on the landward side. They trap mud: optionally, the engine slowly adds sand cells.
- **H. Reef:** coralline algae → coral → framework.
  - Coral cover accretes upward at about 3 mm/yr until it reaches low water. This is an optional terrain feedback: the life worker sends "add rock cell" requests to the engine.
  - It forms a breakwater that cuts wave exposure behind it.
- **I. Seagrass:** sheltered sand shallows → turtle grass meadow.
- **J. Cave:** no plants. Swiftlets and bats roost.
- **K. Alpine** (above the inversion): cinder desert, silversword, and wēkiu bugs eating insects blown up from below.
- **L. Warm ground:** steam vents and megapodes.

---

## 5. Arrivals: the colonization engine

### 5.1 Sources
- **The mainland:** off-map to the east, 800 km away, holding the full species pool.
- **Every island in the zone:** each one becomes a source once its own populations grow.
- **Storm vagrants:** a few species come only when a great storm sweeps them in (cattle egret, some hummingbirds).

### 5.2 Modes and target effects
Codes used in the species table:

| Code | Mode | Lands where | Target size grows with |
|---|---|---|---|
| W | Wind: spores, dust seeds, ballooning spiders, aerial insects | Any land patch, weighted to high and windward ground | √area × (1 + height). Tall islands comb the air |
| S | Sea drift: floating seeds, larvae | Windward or up-current beaches; reef zone for larvae | Coastline facing the current |
| R | Rafting on debris mats: lizards, termites, bees, snails | Windward beach. ×20 during a great storm | Coastline |
| B | Bird-carried: in guts, on feathers, in mud on feet | Perches, colonies, pond margins | Bird visitation (§5.3) |
| F | Own flight or swim: birds, bats, strong insects, turtles, mammals | By habitat | √area × height, plus social attraction |
| V | Storm vagrant | Anywhere downwind | Storm strength |

### 5.3 Rates
Attempts per year for species *s* on island *i*:

```
λ = base_s × target_mode(i) × [ exp(−800/R_s) + Σ_j pop_s,j × exp(−d_ij / r_s) ]
```

- `R_s` is the long-range dispersal length (km): spores ~5,000, seabirds ~10,000, sea-drift seeds ~1,500, land birds ~400, rafting ~300, wingless insects ~150.
- `r_s` is the in-zone hop length: snails 3 km, lizards 2 km, flightless insects 1 km, land birds 8 km, seabirds unlimited.
- **Bird visitation** = 0.3 + 0.7 × √(height) + 0.5 × (existing colonies or roosts). Seabirds are drawn to existing colonies, the "decoy" effect real conservationists use.
- **Bird-carried plant arrivals** scale with the number of frugivore, seabird and duck species present. That reproduces the real shift on Surtsey and Krakatau, from sea- and wind-borne pioneers to mostly bird-brought later arrivals.

**Base-rate guide** (attempts per century, reference 1 km² island):

| Group | Attempts per century |
|---|---|
| Microbes, spores, spiders | 2–10 |
| Wind seeds | 0.3–1 |
| Drift seeds | 0.5–3 |
| Seabird visits | 5–20 |
| Land birds | 0.05–0.3 |
| Rafting vertebrates | 0.02 background; 25–50% chance per great storm |

### 5.4 Establishment, and the "couldn't stay" stories
- **Plants:** sample 4 landing patches by mode and take E = max suit.
- **Animals:** E = (K > minimum) × prerequisites met × founder factor.
  - The founder factor gives parthenogenetic geckos ×1.5. Most birds need two successes within 50 years.
- **On success:** population starts at P = 5% of K, and the journal records the arrival.
- **On failure:** if the species has never established and the missing condition is something the player can build, store a **near-miss**. At most one near-miss story every 3 minutes:
  - "Y412: A coconut washed onto the black rock of the east shore. With no sand to root in, it rotted on the tideline."
  - The field guide marks the species "Visited — couldn't stay: needs a sandy beach."

  Near-miss reasons, in plain words:
  - no sandy beach
  - no cliffs
  - soil too thin to dig a burrow
  - too dry; too salty; too small
  - no fresh water; no sheltered water; no reef
  - too steep or forested for a runway
  - no warm ground
  - needs another island nearby
  - too far: try an island to the east

### 5.5 Equilibrium (MacArthur–Wilson emerges, no scripting)
- Immigration falls as the pool of *absent but suitable* species shrinks.
- Extinction rises as more species share a fixed amount of habitat.
- Adding new habitat turns old near-misses into successes, so the arrival rate visibly rebounds.
- Bigger islands receive more arrivals (the target effect). Nearby islands prevent losses (the rescue effect, §6.3).

**Tuning targets** (checked by a headless run at 1000× speed):

| Island setup | Equilibrium species | Time to 90% of it |
|---|---|---|
| Small low cay alone | 15–25 | ~15 min |
| ~1 km² high island, cloud-belt peak | 45–60 | 25–40 min |
| Large high island with ponds, streams, caves | 65–80 | 40–60 min |
| Full chain: high island + 2 cays + lagoon + salt pond | 95–111 (all) | 2–4 h |

- **Species–area rule:** 10× the area gives ~2× the species (z ≈ 0.3).

---

## 6. Populations, loss and return

### 6.1 Habitat classes
There are 26 bits per patch, recomputed on each visit and summed per island for each full sweep (double-buffered):

BARE_ROCK, CLIFF, CAVE, BEACH, DUNE_STRAND, OPEN_FLAT, BURROW_SOIL (≥20 cm soil, 5–35° slope), GRASS, SCRUB, DRY_FOREST, WET_FOREST, CLOUD_FOREST, ALPINE, POND, MARSH, SALT_POND, STREAM_SEA, MANGROVE, SEAGRASS, REEF, ROCK_SHORE, LAGOON, WARM, FRUIT, FLOWERS, NEST_TREES.

### 6.2 Animal dynamics (per island, every 0.5 s)
- **K** = Σ (weight × class count) × food gates. For example, fruit doves need fig cover, owls need prey abundance, and insectivores scale with an insect index (vegetation cover × insect species).
- **Growth:** dP/dt = r·P·(1 − P) with P measured relative to K. When K shrinks, P > 1 declines smoothly.
- **Extinction hazard:** h = h₀·exp(−P·K/N₀).
- **Catastrophes** multiply P. A storm hitting exposed nests: ×0.7. Overwash of a cay's lizards: ×0.3.

### 6.3 Gentleness rules
- **Rescue effect:** if the species lives on another island within r_s, hazard ×0.3.
- **Seed banks:** pioneer plants stay dormant for 300 years after vanishing and reappear after disturbance.
- **Cap on loss:** no single event removes more than 15% of an island's species.
- **The field guide never loses a page.** Status cycles: Visitor → Resident → Away. Away entries read "not seen since Y2,100", and "Returned" shows when they come back.
- **Tone:** "Y3,040: No shearwaters called this century; the burrows fell quiet. They may yet return — they still nest on Booby Cay."

---

## 7. Webs and feedback loops (the "deeper reward")

1. **Guano loop:**
   - Colonies add N and P to land, with runoff onto the adjacent reef.
   - Reef fish K ×1.5. On rat-free Chagos islands, reef fish grew faster with ~50% more biomass.
   - More fish means more seabirds.
   - Pisonia needs guano, and noddies and white terns nest in Pisonia, so the two sustain each other.
2. **Fig loop:**
   - A fig seeds itself but cannot spread until its fig wasp arrives.
   - Fruiting figs set K for fruit doves, imperial pigeons and flying foxes.
   - Those animals multiply bird- and bat-carried plant arrivals ×2–5, as on Krakatau.
3. **Nitrogen fixers:** lichens, beach pea, she-oak, koa and Azolla gate the nitrogen-hungry later species.
4. **Nurse logs and tree ferns:** storm-felled logs speed the next forest.
5. **Tortoise turf:** grazing keeps grass short. Opuntia and other fruit seeds spread. Cattle egrets follow grazers, and golden plovers like short grass.
6. **Parrotfish sand:**
   - Reef plus parrotfish produce white sand.
   - Optionally, the engine slowly adds sand cells to lee beaches. At minimum, beaches recover faster after storms.
7. **Reef breakwater:** a reef at low-water level lowers wave energy and storm erosion behind it, and helps form lagoons.
8. **Mangroves:**
   - shelter inland from storms
   - reef-fish and shark nursery (K bonus)
   - required for the glowing bay
9. **Land crabs:** leaf litter turns to soil faster, and they eat some seedlings, so forest regrows more slowly where they are dense. This is real on Christmas Island.
10. **Pollinators:** plants spread at ×0.3 until their pollinator group is present:
    - bees for strand flowers
    - hawk moths and bats for night flowers
    - honeycreepers for ʻōhiʻa
11. **Predators:** a water monitor on an island halves ground-nesting seabird and turtle-egg K there. Those species shift to islets, which gives the player a reason to build one.

---

## 8. Drama

### 8.1 Seasons in real time
At 3 years per second, real seasons would flicker, so "seasonal" is expressed on the living-moment clock:
- A **storm season** comes every ~30–40 real minutes and lasts ~10 minutes.
  - Moodier skies, bigger swells, frequent trade-wind showers that drift over the windward slopes, and rainbows.
  - Showers do no harm.
- Background storms are folded into the simulation every year as a small chance of windward canopy loss and salt stress. That is why windward coasts stay wind-pruned scrub, as on real islands.

### 8.2 Great storms (shown, 8–15 real minutes apart)
- The first one comes only after trees exist and at least 10 minutes of play.
- **Warning** (~10 s): birds stream to the lee, the sky bruises, swell builds.
- **Storm** (40–60 s): the ecological clock holds. Wind and rain, bending trees, surge, and engine-driven beach erosion and overwash on low ground. The player can keep sculpting.
- **Effects:**
  - **Blowdown:** p = strength × exposure × tree height × (1 − shelter) × wind-firmness. Palms and pandanus resist; she-oaks snap. Blown patches leave logs, reset disturbance and get a pioneer flush.
  - **Salt burn** out to 3× normal spray reach: −30% cover, which recovers within decades.
  - **Overwash** of low cays: ponds turn salt for 30–80 years, the lens is damaged, ground nests ×0.5, sand forms overwash fans.
  - **Reef:** shallow branching coral −40%, with rubble thrown up into beach ridges. Real storms build cays this way.
  - **Delivery:**
    - 25–50% chance of a **raft**: a visible mat of logs and roots drifts ashore after the storm, sometimes carrying iguanas, anoles, geckos, termites or carpenter bees. This is modelled on Anguilla in 1995.
    - 1–3 vagrant bird attempts that ignore distance.
- **Journal:** "Y2,340: The great storm felled the windward forest from the point to the stream. By Y2,400 young ʻōhiʻa stood in the gap."

### 8.3 Droughts
- One every 600–1,500 sim years, lasting 15–60 years (5–20 real seconds).
- Rain ×0.35 in the lee and ×0.6 on the windward side.
- Ponds shrink and the land browns at its margins. Seabird breeding −20%.
- A green flush follows. "Y3,110–3,150 were the dry decades."

### 8.4 Lava (the player's own drama)
- Covered patches are cleared and their soil reset, and the journal notes "tree molds" where forest burned.
- Surviving vegetation surrounded by new lava is detected as a **kīpuka**: a strong local seed source. "Hawaiians call such a place a kīpuka."
- Lava entering the sea makes steam and **black sand** cells, and kills reef locally.
- Thick flows leave warm ground behind.

### 8.5 Undo
The undo record also stores the life state of the edited patches (small), so undoing a lava pour restores the forest it buried.

---

## 9. The island chain

- **Stepping stones:**
  - Weak dispersers (snails, lizards, wingless insects, small land birds) almost never reach far islands straight from the mainland.
  - Inside the zone, hops are cheap (r_s of 1–8 km).
  - The **upwind (east) island is the gate.** Building one there raises arrivals for the whole chain.
  - The current carries drift from upwind islands to downwind ones.

**Reasons to build more islands:**
1. **Area:** more land means more species (§5.5).
2. **Habitats that conflict on one island:**
   - A tall, wet, forested island cannot also be the flat, open, windy cay that albatross, sooty terns, masked boobies and monk seals need.
   - Black-sand and white-sand beaches: darker sand runs hotter, and turtle sex depends on nest temperature. The journal notes which sand each turtle's nest used.
3. **Predator-free islets:** once monitors live on the big island, ground nesters and turtles move to islets.
4. **Lagoon or atoll:** a ring of islands enclosing water (the LAGOON test) brings:
   - seagrass and spinner dolphins resting by day
   - blacktip shark nurseries and godwits on the flats
   - sheltered mangroves, and with a narrow mouth, the **glowing bay**
   - a milestone entry: "Your islands now hold a lagoon, as an atoll does."
5. **Chain-only species:**
   - imperial pigeon: nests on an islet, feeds on a fruiting island within ~10 km
   - frigatebird: needs quiet islet shrubs plus boobies to rob
   - monk seal: needs a quiet islet beach
   - flamingo: needs a low, dry cay's salt pond
   - glowing plankton: needs an enclosed mangrove lagoon
6. **Islands are named by character** (the player can rename them): "Booby Cay", "the High Island", "Flamingo Pond Cay".

---

## 10. What the player sees and hears

### 10.1 Plants
- The simulation sends deltas (patch, layer, species, cover quantized to 4 levels) at up to 2 Hz.
- The renderer places instances at deterministic per-patch seeds, so trees never shuffle.
- **Appear:** scale up from 0.2 with a slight overshoot over ~1.5 s, fronds unfurling. This is the "pop up" the owner asked for.
- **Die:** fade and sink over ~3 s. After a storm, trees fall and stay as logs.
- **Ground layer** is drawn as terrain vertex tint:
  - crust: dark
  - Stereocaulon: grey-white
  - moss: yellow-green
  - Xanthoria: orange
  - drought: browning
- Models are procedural families: palm, broadleaf, red-pom ʻōhiʻa, tree fern, shrub, grass tuft, dune grass, vine mat, mangrove stilts, cactus, silver rosette, underwater seagrass and coral heads.

### 10.2 Animals
- Agents are spawned near the camera from island populations, at positions sampled from their habitat classes.
- **Caps:**
  - phone: 40 animated agents plus 120 instanced flock birds
  - laptop: 120 plus 300
- When a population falls, agents walk or fly off-screen. They never pop out.
- **Arrival vignettes** when the camera is near:
  - a coconut bobbing ashore
  - silk threads glinting at dawn
  - a raft beaching
  - a duck landing on a new pond
  - a frigatebird settling on the peak

  The journal button gives a soft pulse; the icon is drawn in code.

### 10.3 Sound layers (synthesized)
1. Wind and surf (always).
2. Insect hum by day once the insect index rises; tree crickets at night.
3. Birdsong, one motif per land-bird species present.
4. Colony chatter near colonies.
5. Night layer: shearwater wails, gecko chirps, swiftlet clicks near caves, and frogs (rare).
6. She-oak whistling in wind.
7. Humpback song in the "whale weeks" of the real-time season.

Early on the island sounds like wind only. By the late game it is a full chorus.

### 10.4 Journal and field guide
- Year-stamped entries of under 25 words, filled from the templates in §12 with {Y}, {place}, {isl} and {from}. Highlights view and full log.
- **Field guide page:** name, status, how it came, where it lives, its fact, and the year first seen.
- **Real-island milestones:**
  - "Your island holds 26 kinds of plants — as many as Rakata had three years after Krakatau erupted."
  - "More than Surtsey's 69 known plant species."
  - "Hawaiʻi's native flowering plants grew from roughly 270 colonists, one success every tens of thousands of years. Your island has had a kinder sea."
- "Kinds of life" counts appear in the journal only.

---

## 11. Performance, data, checks

### 11.1 Runtime budget
- **Life worker:** a second worker, or interleaved at low priority in the sand worker, with a main-thread fallback like the engine's.
- **Patch sweep** at 10 Hz in slices: each active patch is visited every ~1.5 s, ~300 operations per patch. That is about 3M operations per second, ~5–10 ms per second on a Pixel 7a.
- **Environment recompute** (rain, distance, flood fill, labels): ~5 ms, only after terrain settles.
- **Island populations:** 111 species × ≤8 islands every 0.5 s. Negligible.

### 11.2 Species data format
```ts
{ id:'ohia', name:'ʻŌhiʻa lehua', layer:'canopy', modes:{W:0.6}, spread:3,
  needs:{ sub:BASALT|CINDER|SOIL, soil:[0.5,15], moist:[0.35,0.6,1], saltMax:0.3,
          alt:[0,2500], shade:0.3, gates:[] },
  gives:{ nectar:3, nestTree:1 }, life:{ estYrs:20, growYrs:40, lifeYrs:400, renew:0.8 },
  show:'P', model:'broadleafPom', fact:'…', journal:['…'] }
```

### 11.3 Saves and determinism
- Patch arrays deflate to ~200–400 KB. Island populations, journal, field guide and seeded xorshift RNG state are saved with them.
- The same seed plus the same edits gives the same history.

### 11.4 Checks (vitest, also on the in-game checks page)
1. A cone island's windward rain is ≥2× its lee rain, and the summit above the inversion is dry.
2. Bare lava gets crust or lichen before any fern, and no tree before the soil threshold.
3. On an untouched medium island the species count levels off: S(t) slope in the last quarter is under 10% of the first quarter's.
4. A 4× larger island ends with ≥1.3× the species.
5. A far downwind island gets fewer weak dispersers until a stepping stone is added.
6. One great storm: under 15% species loss, and vegetation back to ≥80% cover within 300 years.
7. Lava over half the forest: kīpuka detected and recovery happens.
8. A 50k-patch sweep slice runs under 2 ms in headless Chromium.
9. Save → load → identical journal after 1,000 simulated years.
10. No API exists for placing life.

### 11.5 Tuning harness
A headless 1000× run prints the arrival timeline and S(t) curves for each preset island, compared against §5.5.

---

## 12. Species catalogue (111)

**Legend.**
- **By:** W wind · S sea drift · R raft · B bird-carried · F own flight or swim · V storm vagrant.
- **Shown:** P plant model · T ground tint · A animated animal · U underwater animated · S sound · J journal only · E water effect.

Journal lines start with "Y{Y}:".

### Rock pioneers
| Species | By | Needs to stay | Gives | Shown | Real fact | Journal line |
|---|---|---|---|---|---|---|
| Blue-green crust (cyanobacteria) | W | Wet bare rock/ash | +N, holds water; ferns sprout in it | T dark | A blue-green film was the bed for Krakatau's first ferns (1886) | A dark film has crept over the wet rocks of {place}. Alive, if not yet a plant. |
| Lava lichen (Stereocaulon) | W | Basalt, moist, open | +N, first soil | T grey-white | Covers new Hawaiian lava within ~4 years | Pale lichen frosts {place}. Your rock has begun, slowly, to become soil. |
| Orange perch lichen (Xanthoria) | W | Rock + guano | Marks perches | T orange | Thrives on the nitrogen in bird droppings | Orange crusts now mark the rocks where your seabirds sit. |
| Fire moss (Funaria) | W | Moist bare or disturbed ground | Soil | T yellow-green | Surtsey's first moss, 1967, on a sandbank by a lagoon | Moss! A green fuzz by {place}, the island's first. |
| Woolly fringe moss (Racomitrium) | W | Basalt, fog or rain | Spongy mat, soil | T grey-green | Carpets Iceland's lava and young Mauna Loa flows | Woolly moss blankets the windward lava; after rain it glows green. |

### Ferns
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| ʻAmaʻu fern | W | Cracks in wet basalt | Shelter, litter | P red fronds | Among the first ferns on new Hawaiian lava; young fronds unfurl red | Red-tipped ferns unfurl in the cracks of {place}. |
| Uluhe fern | W | Wet, sunny, soil ≥1 cm | Thickets, fast soil | P thicket | Dominates 50-year-old wet Mauna Loa flows | Uluhe has knitted the windward slope into one springy green tangle. |
| Tree fern (hāpuʻu) | W | Wet/fog, soil ≥5 | Nurse trunks for ʻōhiʻa | P | ʻŌhiʻa seedlings often sprout on tree-fern trunks | Tree ferns stand in the mist below the peak like green umbrellas. |

### Strand and dune
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Sea rocket | S | Wrack line on sand | First beach flowers | P | A sea rocket was Surtsey's first flowering plant (1965) | A sea rocket seed rode the waves to {place} and flowered on the tideline. |
| Sea purslane | S | Salty sand/rock; guano OK | Mats in colonies | P red mat | Succulent leaves store fresh water against salt | Fleshy red purslane creeps among the nesting birds. |
| Beach morning glory | S | Beach sand, sun | Binds sand | P pink vines | Seeds float for months; found on tropical beaches worldwide | Pink morning glories trail across {place}, holding the sand. |
| Sea oats | S/W | Dune sand; likes burial | Builds dunes | P | Grows faster when blowing sand buries it | Sea oats nod on the dunes; each storm's sand only makes them taller. |
| Beach pea | S | Sand, sun | +N on sand | P yellow | Root nodules hold nitrogen-fixing bacteria | Yellow beach peas bloom behind the dunes, feeding the sand. |
| Beach naupaka | S | Coastal sand/rock, salt | Shelter, booby nest shrubs | P | Its flowers look cut in half; fruits float | Half-flowered naupaka hedges the shore. |
| Tree heliotrope | S | Coast sand | Frigatebird and noddy nest shrubs | P silvery | Corky fruits float between atolls | A silver heliotrope took root above {place}. |

### Grasses and shrubs
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Wild sugarcane | W | Soil ≥2, sun, moist | Tall grassland | P plumes | Its fluffy seeds made Krakatau a grassland within ~15 years | White plumes of wild cane wave across {place}. |
| Pili grass | W/B | Dry lee, thin soil | Dry grassland, seeds | P tawny | Twisting awns drill its seeds into the ground | Tawny pili grass now covers the dry side. |
| ʻAʻaliʻi | W/S | Poor soil, wind, dry–wet | Hardy shrub | P red capsules | One of the most widespread shrubs on Earth's islands | Red papery seed pods rattle on the ʻaʻaliʻi in the lee. |

### Trees, palms and epiphytes
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Coconut palm | S | Sand coast, some fresh water | Shade, coconuts, wind-firm | P | Stays viable after 110+ days afloat, ~4,800 km | A coconut washed up on {place} and sprouted. Your first palm. |
| Screwpine (Pandanus) | S | Rocky or sandy coast | Stilt roots, fruit | P | Its fruit breaks into floating keys | Screwpines stand on stilt roots along {place}. |
| Tropical almond | S/bat | Coastal soil | Fruit for bats and crabs | P reddening | Corky fruit floats; bats carry it inland | An almond tree grows far inland; a bat must have dropped it. |
| Beach she-oak (Casuarina) | S/W | Sand, poor soil, salt | +N, whistles in wind | P + S | Among the first trees on Krakatau's shores | She-oaks sigh in the wind over {place}. |
| Pisonia | B | Sand cay + guano | Noddy and tern nests, phosphate soil | P | Sticky seeds ride on seabirds; groves die if the birds leave | A Pisonia seed came stuck to a noddy's feathers and grew on {isl}. |
| ʻŌhiʻa lehua | W | Basalt cracks, moist | Canopy, red nectar | P red pompoms | First tree on new Hawaiian lava; its seeds weigh almost nothing | The first ʻōhiʻa has flowered red on the windward lava. |
| Koa | B | Soil ≥10, moist uplands | +N, canopy | P | A koa relative reached Réunion from Hawaiʻi, ~18,000 km, probably via petrels | Koa trees rise on the upper slopes, sickle leaves shining. |
| Strangler fig | B/bat | Forest or rock; fig wasp to spread | Year-round fruit (keystone) | P | Krakatau gained ~24 fig species, mostly via bats and birds | A fig has wrapped its roots around a rock on {place}. |
| Tree prickly pear | B/tortoise | Dry lee rock | Flowers and fruit for finches, doves, tortoises | P | Where tortoises graze, Galápagos Opuntia grows tall trunks | A prickly pear has raised a trunk on the dry side. |
| Sandalwood | B | Dry/mesic soil beside host shrubs | Fruit, scent | P | A root parasite: taps its neighbours' roots for water | Sandalwood grows among the ʻaʻaliʻi, borrowing their roots. |
| Silversword | B | Above the cloud ceiling, cinder | — | P silver globe | Lives for decades, flowers once, then dies | Above the clouds, a silver globe has taken root in the cinders. |
| Dust-seed orchids | W | Epiphyte in wet or cloud forest | Flowers | P small | Seeds fine as dust; they need a fungus partner to sprout | Orchids bloom on the mossy branches below the peak. |

### Wetland and sea plants
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Red mangrove | S | Sheltered intertidal | Traps mud, shelter, nursery | P stilts | Seedlings float for months, sprouting as they go | A mangrove seedling lodged in {place} and stood up on stilt roots. |
| Black mangrove | S | Upper intertidal, salt-pond edge | Breathing roots | P | Its roots poke up like snorkels | Black mangroves ring the salt pond. |
| Sedges | B | Wet pond or stream margins | Marsh | P | Darwin raised 537 seedlings from 3 spoonfuls of pond mud | Sedges came in the mud on a bird's feet; the pond has a green rim. |
| Water fern (Azolla) | B | Still fresh water | +N, duck food | P floating mat | Carries nitrogen-fixing cyanobacteria inside its leaves | A red-green skin of water fern floats on the pond. |
| Turtle grass | S | Sheltered sandy shallows | Turtle food, nursery | U meadow | Fruits float; meadows feed green turtles | A seagrass meadow sways in the shallows off {place}. |
| Coralline algae | S | Shallow hard bottom | Cements reef; cue for coral larvae | T pink (underwater) | Coral larvae prefer to settle on this pink "living cement" | Pink crusts paint the rocks under the water. |
| Reef corals | S | Warm, clear, shallow, hard bottom; no silt | Reef climbs a few mm/yr, breakwater | U | Reefs grow only millimetres a year | Coral has settled off {place}; a reef has begun. |

### Land invertebrates
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Ballooning spiders | W | Any land | — | A silk glints | 9 months after 1883, Krakatau's only life was one tiny spider spinning a web | A spider sailed in on a silk thread. Your island's first animal. |
| Midges and flies | W | Any land, wet spots | Food | J | Surtsey's first insect, a midge, came in 1964 while lava still flowed | Midges dance over the wet rocks of {place}. |
| Lava crickets | R | Fresh bare basalt only | — (leave once plants come) | S night, J | Live on new lava eating wind-blown debris | Lava crickets chirp in the cracks of your newest lava. |
| Golden orb-weaver | W | Shrubs, forest edge | — | A webs | Its silk shines gold | Great golden webs span the shrubs at dawn. |
| Fig wasps | W | Its fig present | Figs fruit and spread | J | Each fig species has its own tiny wasp | Fig wasps found your figs; now they will fruit. |
| Yellow-faced bees | R/W | Flowers | Pollination | A small | Hawaiʻi's only native bees descend from one arrival | Small bees work the beach flowers. |
| Carpenter bees | R | Dead wood + flowers | Pollinates big flowers | A + S | They nest in wood, so whole families float in on logs | A drift log brought carpenter bees; they buzz over the hibiscus. |
| Hawk moths | F | Night flowers | Night pollination | A dusk | Hover like hummingbirds | At dusk, hawk moths hover at the pale flowers. |
| Globe skimmer | F | Fresh pools, even puddles | Eats midges | A | Crosses the Indian Ocean on monsoon winds | Dragonflies patrol the new pond. |
| Drywood termites | R | Dead wood | Wood → soil | J | Can spend their whole lives inside one log, even at sea | Termites came ashore inside a log. |
| Ants | R | Soil/forest, warm | — | J | Hawaiʻi has no native ants at all | Ants arrived on a raft of storm debris. |
| Land snails | B | Moist forest litter | — | A slow | Tiny snails can survive a trip through a bird's gut | Snails no bigger than rice grains glide over the wet leaves. |
| Tree crickets | W/R | Shrubs/forest | Night chorus | S | You can estimate the temperature from snowy tree cricket chirps | The nights now ring with crickets. |
| Wēkiu bug | W | Summit cinders above the clouds | — | J | Lives on Mauna Kea's frozen summit, eating insects blown up from below | Even the summit has a hunter now. |

### Crabs and crustaceans
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Ghost crab | S | Sand beach | Scavenger | A night | Sees all round on stalked eyes | Ghost crabs sprint across {place} at night. |
| Sally Lightfoot crab | S | Splashed rock | Cleans iguanas | A red | Picks ticks off marine iguanas | Red crabs skip over the black rocks of {place}. |
| Land hermit crab | S | Coast with shells and cover | Scavenger | A | Hermit crabs line up by size to swap shells | Hermit crabs trundle in borrowed shells. |
| Red land crab | S | Moist coastal forest | Litter → soil; eats seedlings | A | Tens of millions march to sea on Christmas Island | The red crabs marched to the sea to spawn. |
| Coconut crab | S | Coastal forest with fruit | — | A night | World's largest land arthropod, ~4 kg | A coconut crab climbed a palm in the moonlight. |
| Fiddler crabs | S | Mangrove mud | Aerates mud | A waving | Males wave one giant claw | Fiddler crabs wave among the mangrove roots. |
| Brine shrimp | B | Salt pond | Flamingo food | J/U | Dried eggs can wait years for water | Brine shrimp hatched in the salt pond, ferried as eggs on a bird. |
| Stream shrimp | S | Stream reaching the sea | — | J | Larvae drift to sea, then climb back upstream | Tiny shrimp climbed the stream from the sea. |

### Freshwater animals
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Climbing goby | S | Stream reaching the sea | — | U | Climbs waterfalls with a sucker made of fins | Gobies climbed your stream to its highest pool. |
| Pond snails | B | Fresh pond | Duck food | J | Darwin watched new-hatched snails cling to a duck's feet | Pond snails arrived on a duck's feet. |

### Reptiles and amphibians
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Mourning gecko | R | Shrubs/trees, insects | Insect eater | A + S chirp | All female, so one can start a colony; eggs tolerate seawater | A gecko egg rode a log to {place}; geckos chirp at night now. |
| Anole | R | Shrubs/trees | — | A dewlap | Bahamian anoles rafted between cays after hurricanes | Anoles flash orange throats in the shrubs. |
| Green iguana | R | Warm, leafy, sandy nest ground | Eats leaves, spreads seeds | A | In 1995, 15+ iguanas rafted to Anguilla on storm logs | After the storm, a raft of logs grounded on {place}. Iguanas walked off it. |
| Marine iguana | R | Black rocky shore + algae | — | A basking heaps | The only lizard that feeds in the sea; sneezes salt | Marine iguanas bask in heaps on the lava shore. |
| Lava lizard | R | Warm open rock, insects | — | A push-ups | Males do push-ups to claim ground | A lava lizard does push-ups on a warm rock. |
| Giant tortoise | S | Dry lowland grass/scrub, rain pools | Grazes, spreads seeds | A very slow | An Aldabra tortoise drifted ~740 km to Tanzania (2004) | A barnacled tortoise floated ashore and walked inland. |
| Water monitor | F/R | Large island, coast + streams | Eats eggs | A | A strong swimmer, back on Krakatau within decades | A monitor lizard swam ashore. The ground-nesters grow wary. |
| Green turtle | F | Quiet beach + seagrass | Nutrients to beach | A night nesting, hatchlings | Ascension's turtles swim ~2,000 km from Brazil to nest | A green turtle hauled up {place} to nest. |
| Hawksbill turtle | F | Reef sponges + vegetated beach | — | U/A | Eats sponges; nests under beach shrubs | A hawksbill grazes the reef. |
| Rafted tree frog | R rare | Big wet island, forest + pond | Night chorus | A + S | Frogs almost never reach oceanic islands; salt water dries them | Against all odds, frogs: they sing at the pond tonight. |

### Seabirds
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Black noddy | F | Trees on cays, cliffs | Guano | A | Glues leaf nests together with droppings | Noddies nest in the Pisonia on {isl}. |
| Sooty tern | F | Large open flat ground, few predators | Heavy guano | A flocks + S | Young terns stay aloft for years before first landing | A thousand sooty terns came down on {isl}. |
| White tern | F | Trees | — | A | Lays its egg on a bare branch | A white tern balanced an egg on a bare branch. |
| Brown booby | F | Cliff or beach ground | Guano | A | "Booby" comes from Spanish *bobo*, for its tameness | Boobies nest on the cliffs of {place}. |
| Red-footed booby | F | Coastal shrubs/trees | Guano | A | Nests in trees, unlike its ground-nesting cousins | Red-footed boobies nest in the naupaka. |
| Great frigatebird | F | Quiet islet shrubs, boobies to rob | — | A red pouch | Can stay aloft two months without landing | A frigatebird rested on your peak, then nested on {isl}. |
| Red-tailed tropicbird | F | Cliff ledges and crevices | — | A | Courting pairs loop in vertical circles | Tropicbirds wheel over the cliffs, tails streaming. |
| Wedge-tailed shearwater | F | Burrow soil ≥20 cm on coastal slopes | Guano into soil | A dusk + S | Nicknamed "moaning birds" for their night calls | Shearwaters dug their first burrows; the nights moan softly. |
| Laysan albatross | F | Low, open, windy island with a runway | — | A dance | Wisdom, over 70, is the oldest known wild bird | Albatrosses dance on the open ground of {isl}. |
| Brown pelican | F | Mangroves/shrubs + shallow fish | — | A plunge | Air sacs cushion its headfirst dives | Pelicans plunge in the shallows. |

### Shorebirds and waterbirds
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Ruddy turnstone | F | Rocky or wrack shore | — | A | Flips stones and seaweed for food | Turnstones flip pebbles along {place}. |
| Pacific golden plover | F | Short grass, beaches | — | A | Flies ~4,800 km nonstop, Alaska to Hawaiʻi | A golden plover arrived from the north for the winter. |
| Bar-tailed godwit | F | Lagoon mudflats | — | A | Record nonstop flight: 13,560 km in 11 days | Godwits probe the lagoon flats. |
| Night heron | F | Ponds, streams, mangroves | — | A dusk | One of the world's most widespread herons | A night heron waits motionless at the pond. |
| Cattle egret | V | Grassland with grazers | — | A | Crossed from Africa to South America on its own in the 1800s | A storm blew in a cattle egret; it follows the tortoises. |
| Flamingo | F | Salt pond with brine shrimp | — | A pink flock | Its pink comes from pigments in its food | Flamingos have found the salt pond. |
| Island pintail | F | Fresh pond | Carries seeds and snails | A | Darwin noted ducks carry seed-laden mud on their feet | Ducks landed on the new pond. |
| Rail | F | Dense ground cover, few predators | — | A + S | Rails reach remote islands more often than almost any bird, then often stop flying | A rail scurries under the ferns. |

### Land birds
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Collared kingfisher | F | Coast/forest edge, lizards, crabs | — | A + S | Waits on a perch, then drops on prey | A blue kingfisher watches the shore. |
| Fruit dove | F | Fruiting trees | Brings seeds | A + S coo | Swallows fruit whole and passes seeds unharmed | Fruit doves coo in the figs. |
| Imperial pigeon | F | Islet nest + fruit island within ~10 km | Carries big seeds between islands | A | Pied imperial pigeons commute daily from islets to feed | Pigeons fly each morning from {isl} to the high forest. |
| White-eye | F | Shrubs/forest | Spreads small seeds | A + S | Silvereyes reached New Zealand unaided in 1856 | A flock of white-eyes arrived together, chattering. |
| Hummingbird | F/V | Year-round flowers | Pollination | A | Hovers on wings beating dozens of times a second | A hummingbird sips from the morning glories. |
| Ground finch | F | Dry seeds | — | A + S | Darwin's finches descend from one small flock | Finches crack seeds in the dry scrub. |
| Honeycreeper | F | ʻŌhiʻa flowers, wet forest | Pollinates ʻōhiʻa | A red + S | Hawaiʻi's honeycreepers came from one finch ancestor | Crimson honeycreepers sing in the ʻōhiʻa. |
| Cave swiftlet | F | Caves + insects | — | A + S clicks | Echolocates with clicks you can hear | Swiftlets click in the dark of your cave. |
| Megapode | F | Warm volcanic ground + forest | — | A | Buries its eggs in volcanically warmed ground and leaves them | Megapodes dig into the warm ground by the steam vents. |
| Short-eared owl | F | Open grass + prey | — | A by day | Galápagos short-eared owls hunt by day | An owl quarters the grassland at noon. |

### Mammals
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Flying fox | F | Fruit trees, roosts (islets favoured) | Pollinates, carries big seeds | A dusk + S | Most of Anak Krakatau's first figs were bat-sown | Fruit bats flap over at dusk from {isl}. |
| Hoary bat | F | Insects over ponds/forest | — | A night | Hawaiʻi's only native land mammal | A bat flits over the pond at night. |
| Monk seal | F | Quiet islet beach, reef fish | — | A hauled out | Dives deeper than 500 m | A monk seal sleeps on the sand of {isl}. |
| Spinner dolphin | F | Sheltered bay by deep water | — | A leaps | Rests in calm bays by day, hunts offshore at night | Spinner dolphins rest in your lagoon. |
| Humpback whale | F | Deep water nearby | — | S song, A blows | Males sing songs that change each year | Whale song through the hull of the sea tonight. |

### Reef and sea
| Species | By | Needs | Gives | Shown | Fact | Journal |
|---|---|---|---|---|---|---|
| Parrotfish | S | Living reef | Makes white sand | U | A big parrotfish grinds out hundreds of kg of sand a year | Parrotfish arrived; much of your future beach will be their work. |
| Reef fish | S | Reef | Seabird food | U shoals | Larvae find reefs by their sound | Bright fish swarm the reef. |
| Cleaner wrasse | S | Reef | Cleaning stations | U | Runs cleaning stations for mantas and sharks | A cleaner wrasse opened for business. |
| Sea urchin (Diadema) | S | Reef | Grazes algae so coral settles | U | Caribbean reefs suffered when Diadema died off in 1983 | Urchins keep the reef clean of weed. |
| Manta ray | F | Reef cleaning station | — | U | Largest brain-to-body ratio of any fish | A manta glided in to be cleaned. |
| Blacktip reef shark | F | Lagoon or mangrove shallows | — | U fins | Pups grow up in shallow lagoons | Shark pups patrol the lagoon shallows. |
| Glowing plankton | S | Enclosed mangrove lagoon with a narrow mouth | Water glows at night | E | Puerto Rico's Mosquito Bay glows thanks to mangroves and a narrow mouth | Tonight the lagoon glowed wherever a fish moved. |

---

## Sources
- [Surtsey plant colonization (Magnússon et al., Biogeosciences 2014)](https://bg.copernicus.org/articles/11/5521/2014/) · [Surtsey invertebrates](https://english.surtsey.is/skordyr/)
- [Krakatau plant recolonization](https://pmc.ncbi.nlm.nih.gov/articles/PMC279581) · [Krakatau dispersal case study](https://milliontrees.me/2014/05/26/krakatoa-a-case-study-of-species-dispersal/) · [Thornton et al., figs on Krakatau](https://researchonline.jcu.edu.au/13252/) · [Cotteau's spider](https://microkhan.com/?p=3762)
- [Censky et al., Anguilla iguana raft (Nature 1998)](https://www.nature.com/articles/26886) · [Carnegie Museum account](https://carnegiemuseums.org/magazine-archive/1996/julaug/dept8.htm)
- [Spider ballooning](https://en.wikipedia.org/wiki/Ballooning_(spider)) · [Electric fields and ballooning](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6065530/)
- [Hawaiian native plant colonists](https://www.ctahr.hawaii.edu/UHMG/Oahu/downloads/MG-NativePlantBooklet.pdf) · [Mauna Loa primary succession](https://www.biogeosciences.net/10/5171/2013/) · [HAVO succession history](https://www.nps.gov/parkhistory/online_books/science/5/chap2.htm)
- [Hawaiʻi rainfall patterns](https://rainfall.geography.hawaii.edu/rainfall) · [Hawaiʻi climate and the trade-wind inversion](https://geology.teacherfriendlyguide.org/index.php/climate-w/climate-presenthawaii-w)
- [Seabird guano and reef fish, Chagos (Graham 2018)](https://www.sciencenews.org/article/bird-poop-helps-keep-coral-reefs-healthy-rats-are-messing)
- [Coconut seawater viability](https://palms.org/wp-content/uploads/2016/05/v52n1p19-21.pdf) · [Mangrove propagule flotation](https://www.usgs.gov/publications/influence-propagule-flotation-longevity-and-light-availability-establishment)
- [Parrotfish sand (NOAA)](https://oceanservice.noaa.gov/facts/sand.html) · [ScienceAlert on Hawaiian parrotfish](https://www.sciencealert.com/hawaii-s-white-beaches-are-partly-parrotfish-poop-and-coral-sorry)
- [Aldabra tortoise drift to Tanzania](https://en.wikipedia.org/wiki/Aldabra_giant_tortoise) · [Acacia heterophylla and koa](https://en.wikipedia.org/wiki/Acacia_heterophylla)
- [Lava cricket Caconemobius fori](https://en.wikipedia.org/wiki/Caconemobius_fori) · [Polynesian megapode](https://www.birdguides.com/articles/saving-the-polynesian-megapode-a-clash-between-culture-and/)
- [Gecko saltwater tolerance](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7880474/) · [Mourning gecko](https://www.geckoweb.org/mourning-gecko.html)
- [Pisonia and seabirds](https://daily.jstor.org/the-bird-catching-pisonia-trees) · [Pisonia and guano dependence](https://www.australiangeographic.com.au/nature-wildlife/2018/01/seabird-poo-has-some-island-tree-species-addicted/)