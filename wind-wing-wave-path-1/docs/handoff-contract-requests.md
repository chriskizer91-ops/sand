# Contract requests from the build team (raw, collected for the integration pass)

Each section is one builder or fixer report (workflow run id :: first line). Apply the sensible ones during integration; they are suggestions, not decisions.

## wf_400d008c-874 :: I built the engine hub (WP-C) and committed it as 5f9ee3b on `wp/engine`, then detached so the branch is free. Typecheck
(lead-owned files, unchanged)
1. **Geo (`src/engine/geo/geo.ts`):** geology must notice ground changes it did not make itself (undo, load, demoChain). That means waking its moving lava and sand for any rectangle reported through `cols.markChanged`, for example through its own `cols.addListener`. Or add `wake(i0, k0, i1, k1)`. Also, its constructor must pick up molten lava already in a loaded save.
2. **Geo:** set `seabed.glow` in the constructor from the seed, not only in `generateSeabed()`.
3. **Geo:** report changes in tight rectangles, not one bounding box per step. Otherwise the streams resend unchanged ground.
4. **Ecology (`src/eco/ecology.ts`):** `restore()` runs after the saved life fields are copied in and must not overwrite them. It must rebuild everything derived from the ground itself, because the hub does not call `onTerrainChanged` after a load. And `serialize()` after `restore(s)` must give exactly `s`.
5. **Ecology:** `packEco` must give correct data straight after construction or restore, because the full resend happens before any `work()`. Also, `takeLife()` should return a value on its first call after construction or restore.
6. **Ecology (optional):** add `takeBurned(): number`. Today `events.burned` counts patches under Burn-flagged changes, which includes ground with no life on it.

## wf_400d008c-874 :: WP-C report: I checked all nine review findings and all were real; each is fixed. Type-check, tests (50 of 50) and build
1. `docs/ARCHITECTURE.md` §5.4, Save: change "Sections: `COLS` … and `ECO` …" to "Sections: `COLS` …, `ECO` …, and a final `SUM ` section (u32 CRC-32 of every byte before it), checked before anything is read; deflate-raw has no checksum of its own."
2. `docs/ARCHITECTURE.md` §5.1 / §7: settle whether the phone geo/eco figures are budgets to give (13 ms total) or the expected phone time for the desktop work. If §7's 8 ms is the real limit, the phone budgets in `engine.ts` should drop to about geo 5, eco 2.5, pack 0.5.
3. Optional, `src/engine/protocol.ts`: mark `header` in `{ t: 'save' }` as optional (`header?: PageSaveHeader`) to match the defensive handling, or leave it required and keep the runtime fallback as is.

## wf_400d008c-874 :: I built WP-B geology: the seabed, lava, sand, the five tools and the coast processes. It's committed on `wp/geo` as `b88
1. **ARCHITECTURE §5.2:** it says `lavaStats(): { area; hottest: [x,z] | null }`, but the stub and protocol use `{ area; glow: [x, z, radius, strength] }`. I kept the stub; please update the doc.
2. **ARCHITECTURE §5.2, `coastYears`:** please state that `reefSand[j]` is the white-sand rate (m/yr) for `shore[j]`, a list parallel to the shore list, rather than "per column". I documented it this way in `geo.ts`.
3. **Hub (WP-C), undo/load/demoChain:** whenever the hub writes columns itself, call `cols.markChanged` over that rectangle, as the contract already says. Otherwise molten lava restored by undo or load would never freeze.
4. **Hub (WP-C), per tick:** call `takeSteam`, `lavaStats` and `takeRockPlaced` once per tick.
5. **Save format (WP-C):** the seabed reaches about −33.5 m, below `FLOOR_Y`/`BUILD_MIN` of −30. Rock quantisation must cover that. Sand thickness is kept on a 1/65536 m grid; saving it on a coarser power-of-two step such as 1/256 m keeps sand conservation exact after a load.
6. **Ecology (WP-D):**
   - Shore lists for `stormPulse`/`coastYears` should be waterline columns (top within about ±1 m of sea level, next to water).
   - During storms, call `setStorm(level)` and `stormPulse` every tick.
   - The ecology must make no column writes of its own; all of them go through these coast calls.

## wf_400d008c-874 :: WP-B review fixes report (commit 96902ab on wp/geo; HEAD is now detached)
(lead-owned files)**
1. `docs/ARCHITECTURE.md` §5.2: change `lavaStats()` to `lavaStats(): { area: number; glow: [x, z, radius, strength] }`, which is what the lead's stub and Geo return. Also add `takeRockPlaced(): number`.
2. `docs/ARCHITECTURE.md` §5.2, `coastYears`: state that `reefSand[j]` is metres per year of white coral sand landing at `shore[j]`, and that `shore` may list either the first sea column or the last land column at the water line.
3. `docs/ARCHITECTURE.md` §5.2, `step()`: add the note from the risks list that one call always runs at least one whole lava substep.
4. `docs/ARCHITECTURE.md`: say that Burn rectangles are patch-sized (2 × 2 columns), so ecology can trust them as they are.
5. Optional, `src/checks/registry.ts`: add a third result state such as `skipped?: boolean`, so "could not measure reliably" doesn't have to show as a fail.

## wf_43e4fea3-d34 :: WP-F1 Plants is built and committed as `1a0d3cf` on branch `wp/plants`. The worktree is now detached and I didn't push. 
1. **Pop events for sound and watch mode.** Nothing in the contract lets the vegetation tell other systems that a plant popped, which the sound's woody tick and watch mode's camera drift need. Suggested change: add to `render/shared.ts` an interface `VegetationSystem extends PageSystem { takePops(out: { x: number; y: number; z: number; t: number }[]): void }`, have `createVegetation` return it, and have `main.ts` pass the pops to audio and watch mode. I'll implement `takePops` once this is agreed.
2. **ARCHITECTURE §6.6.** Please record that each instance also carries a third vec4 (the five packed species colours), alongside position and life.
3. **ARCHITECTURE §6.6 caps.** Please also record that the caps are filled nearest-first in 16 m blocks inside each 64 m tile, and that laptops get 1.6× the phone caps.

## wf_43e4fea3-d34 :: WP-F2 is built and committed as `f0f4b03` on branch `wp/animals`, and the worktree is now detached. Typecheck, tests and
1. `.gitignore`: change `node_modules/` to `node_modules`. The worktree's `node_modules` is a symlink, which the trailing-slash rule doesn't match, so `git add -A` would commit it. I staged with `':(exclude)wind-wing-wave/node_modules'` instead.
2. A shared "plant top / crown height" function from vegetation. fauna.ts has its own `PLANT_TOP` table for perches and flowers.
3. Demo fixtures: populations on every island, and Beach habitat on the volcano, so beach animals can be seen without painting.
4. A day-phase override on `__game` (or the daylight stub following `setMode`), so night can be screenshot.
5. `main.ts`: precompile the creature material with `renderer.compileAsync`, to avoid a first-appearance shader stall.
6. Have the arrival-card glide stop about 60–90 m from the spot, so scenes read well (they play within 260 m).
7. WP-D catalogue: follow `SLOT_GUIDE` in animals.ts for the meaning of each of the three species colours per body plan.
8. Integration: the debug hooks listed above exist on the groups named `fauna` and `vignettes`.

## wf_43e4fea3-d34 :: All ten review findings are fixed on `wp/plants` (commit `7e86941`, on top of the interrupted WIP commit `4356974`). Typ
.
9. **Fixed 45/35/20 split of the triangle cap.** Fixed. It is now one shared pool filled nearest first, with 15% kept back for the mid level and 8% for the far canopy.
10. **Every plant drawn double-sided.** Fixed. Closed shapes draw front faces only; thin leaves in those models get a reversed copy, and leafy plants stay double-sided.

## Also fixed, beyond the findings
- **Deaths drawn with the wrong model.** A dying plant now plays its death with the model it was drawn with. Before, deaths near the camera always used the full-detail model, so ferns that were never drawn appeared just to die, and a block that emptied could switch models mid-death.
- **A plant surviving at zero cover.** A spot whose threshold was under 0.05 never hid, even at cover 0. Cover 0 now hides every plant in that layer.
- **Camera inside a tree crown.** The screenshots showed the camera sitting inside fig crowns, filling the screen with flat green. Plants the camera is inside or right against now shrink out of the way; their shadows stay. A camera low over dense forest still sees a wall of canopy, which is a camera question for WP-H.

## How I verified it
- `npx tsc --noEmit`: passes.
- `npx vitest run`: 71 passed, 2 files. New tests cover the death level, the fixed buffer order and the zero-cover hide; every other finding already had a test from the WIP.
- `node build.mjs --out dist/plants.html`: builds, 680 KB.
- Phone budgets, measured in the page for plants only:

| View | Plant triangles | Plant draws | Shadow triangles | Shadow draws |
|---|---|---|---|---|
| Dense forest | 94k–96k | ≤14 | ≤36k | ≤6 |
| Volcano at 120 m | 79k | 9 | 0 | 0 |
| Volcano at 400 m | 42k | 3 | 0 | 0 |
| Cay | 71k | 15 | 21k | 6 |

Budgets: plants 120k of the main pass, shadow pass 100k triangles and 20 draws.

## Screenshots
All in `/home/user/sand/.claude/worktrees/wf_43e4fea3-d34-5/wind-wing-wave/e2e/output/`:
- **Volcano:** `plants-volcano-400.png`, `plants-volcano-400-phone.png`, `plants-volcano-120.png`, `plants-volcano-120-phone.png`, `plants-forest-40.png`, `plants-forest-120.png`.
- **Cloud forest near the peak:** `plants-cloudforest-40.png`, `plants-peak-60.png`.
- **Cay and beach:** `plants-cay-90.png`, `plants-beach-40.png`.
- **Pop sequence:** `plants-pop-a.png`, `plants-pop-b.png`, `plants-pop-c.png`. A pandanus trunk rises, the limbs carry an upright spear, then it opens like an umbrella.
- **Storm:** `plants-storm-topple-a.png`, `plants-storm-topple-b.png`, `plants-storm-logs.png`. Trees topple across the wind and logs linger.

## Known gaps and risks
- Not tested: real Pixel frame time, how sway and cross-fades read in motion, and the dry-season look.
- The screenshot helper uses a target height that pushes cameras into the slope on the high volcano flanks; I framed those views from the downhill side.
- In the demo, the crater pond's level sits well below most of its pond patches, so no reeds show on its rim. That is the demo data, not the rule.

## Contract requests
- **ARCHITECTURE §6.6, pops:** record "Pops within 130 m (full detail, plus trees and shrubs at the simple level), at most 4/s", or tell me to set `POP_RANGE` back to 60.
- **§6.6, instance data:** add the third per-instance `vec4` (five packed species colours). This is the builder's earlier request.
- **§6.6, caps:** record how the caps are filled (one shared pool, nearest first, 15% kept for the mid level and 8% for the far canopy). Also record that cross-fades may briefly exceed the caps by up t

## wf_43e4fea3-d34 :: WP-F2 review fixes: all 10 findings are fixed except that half of finding 7 was wrong (explained below). Committed as `3
None needed. Optionally, `main.ts` could call `renderer.compileAsync(scene, camera)` at load as ARCHITECTURE §7 asks; that would build the lit and points programs even earlier.

## wf_80ff46a6-275 :: WP-D2 is done and committed on `wp/content` as 34c9d29, and the worktree is detached. Typecheck, tests and build all pas
1. **`src/eco/needs.ts`, EcoNeeds:** add `food?: ('fruit' | 'nectar' | 'seeds' | 'insects')[]`, meaning "any species on the island that gives this". At the moment fruit doves, flying foxes and bees have to `requires` one particular plant (fig, naupaka).
2. **`src/eco/needs.ts`, doc comments:** put the semantics from point 2 of the risks above into the field comments.
3. **WP-D1 journal params:** fill the params that stories.ts documents (`reason`, `from`, `great`/`fallen`/`castaway`, `waiting`, `moment`, `milestone`+`count`, `kipuka`, `level`/`text`). The extra First keys need awarding: `first-drift-seed`, `first-fern`, `first-return`, `first-night-chorus`, `first-kipuka`.
4. **`.gitignore`:** change `node_modules/` to `node_modules` so the symlink workers create is ignored.

## wf_80ff46a6-275 :: WP-D2 review fixes are committed as 8bc9de0 on `wp/content`, and HEAD is now detached. I checked each of the 7 findings 
1. `src/eco/needs.ts`, the comment on `EcoNeeds.substrate`, change to: "Plants: substrates it can root in (Substrate values from speciesTypes). For marine plants this is the sea-bottom material under the water (Basalt/Stone/Limestone = hard bottom, Sand = soft bottom; Sea is not used). Default: any land substrate except hot lava (land plants), any bottom (marine plants)."
2. `src/engine/protocol.ts`, or the ecology's journal docs: write down that a `storm` entry carries its castaway in `species`, sets `road` to `'raft'` or `'storm'` when it knows, and uses `params.raft = 1` for a raft that came ashore. `stories.ts` accepts this and the older `params.castaway`.
3. `.gitignore`: add a line `node_modules` without the slash, so the symlinked `node_modules` each builder makes is ignored.

## wf_80ff46a6-275 :: I built the full life simulation and committed it on `wp/ecology` (cb32c01), then detached HEAD. Type checks, all 46 tes
1. **Dirty areas:** let `takeDirty` return several rectangles or 32×32 tiles. With one bounding box, scattered growth across a chain makes every eco send cover the whole chain (up to about 0.8 MB). For now it returns a single inclusive patch box `[x0, z0, x1, z1]`.
2. **ARCHITECTURE §5.3:** add the `species` constructor argument. Also state that the hub must route `markChanged` to `onTerrainChanged` (Ecology doesn't register itself), call `setClock` on focus, pause and settings, and call `restore()` after loading the PatchGrid arrays. Undo should restore patch blocks with `eco.undoMerge`, then call `markChanged` with Geom only (no Tool or Burn).
3. **Geo calls:** for `coastYears`, `reefSand` is one value per entry of `shore`: white-sand supply in m/yr, or null when there is none. For `growReef`, each amount is metres of limestone to add under living coral deeper than 0.6 m. All of these calls come from inside the ecology.
4. **Seasons:** the first storm needs 15 minutes since first land, shrubs, and the wet season. If the page starts a new sea in its wet day, the first storm misses that season and lands at 33–40 minutes, not the beat sheet's 15–20. Either start new seas in the dry season (WP-G) or relax the wet-season rule for the first storm.
5. **For WP-D2 (how I read EcoNeeds):**
   - **Substrate:** for marine species it means the sea bottom (Sea means any bottom).
   - **Plant habitats:** matched against the ground's own habitats plus the vegetation of the patch and its neighbours.
   - **Seabird islets:** colony seabirds count all open ground on an islet.
   - **Places:** `places` are judged from the land's shape, not from life.
   - **Plants count as present:** for `requires`, a plant counts once it has some cover on the island.
   - **Journal keys to write lines for:**
     - firsts: `first-land`, `first-life`, `first-animal`, `first-flower`, `first-seed`, `first-nest`, `first-tree`, `first-storm`, `first-castaway`, `first-forest`, `first-cloud`, `first-pond`, `first-stream`, `first-song`, `first-reef`, `first-turtle-nest`, `second-island`, `first-island-hopper`, `first-seabird-city`, `first-lagoon`, `first-sound`, `first-whale`
     - milestones (`params.key`): `species-10/25/50/75`, `rakata`, `islands-3`
     - moments: `params.moment: 'kipuka'`
     - hints (`params.hint`): `island-east`, `more-islands`, `sound`, or a buildable reason code
     - entry params: `params.first` = 1 on each species' first-arrival entry, `params.reason` on visits, `params.after = 'lost'` on returns after a loss, `params.name` on joined or lost islands
     - storm summary: `{fallen, great, raft, gentle}`

## wf_80ff46a6-275 :: I checked all nine review findings against the real consumer code on the wp/ecology and wp/animals branches. All nine we
). Typecheck, tests (47/47, up from 41) and the build all pass. The work is committed as 4f47332 on wp/content, and the branch is detached for the reviewer.

## What I changed, by finding

**1. Iguana told as "far off its course"** (`stories.ts`, `cameByRaft`). An animal whose roads include none of flight, storm or wind is now always told as rafted in, whatever road the ecology sends. The test now expects "raft of branches" for the iguana on road `storm`. A new check covers the night heron, which follows the ecology's road (storm or raft).

**2. Storm road effectively empty** (`species.ts`). Silvereye, night heron and pea blue butterfly now also arrive by the `storm` road. The cattle egret no longer needs tortoises: it hunts insects in any open grass. Its mainNeed is now `no-grass`, its lines are rewritten, and its rarity is now uncommon. So storms have four castaways that can stay on a young island, three of them birds. I also softened the silvereye fact to "a storm is thought to have swept a flock… in 1856", which is what the sources support.

**3. Lava cricket can't be seen or heard.** It now:
- uses the Spider body (it is wingless and long-legged) with pale legs that show against black rock;
- uses `scuttle` (no wetness gate) and is active at `dusk`;
- shows up to 6 at once instead of 3;
- has a hint that says to look closely at dusk.

I re-checked the facts (wingless, about 9 mm, nocturnal, can arrive within months, gone once plants cover the flow). The new, stricter test also caught the Hawaiian tree snail, which was silent, 2 cm and night-only, so it is now active at `dusk` too. The test rule: a silent animal under 3 cm must be out by day or at dusk, or make its own light.

**4. Bee told "no ripe fruit".** Naupaka no longer gives fruit, so a missing naupaka now reads as `no-flowers`.

**5. Species' own "couldn't stay" lines rarely shown.** I aligned mainNeed with what the ecology actually computes, and rewrote lines to match:

| Species | Old mainNeed | New mainNeed |
|---|---|---|
| Black noddy | no-trees | no-cliff |
| White tern | no-trees | no-forest |
| Shearwater | thin-soil | no-dune |
| Albatross | no-open-ground | too-tall |
| Coquí | too-far | needs-island-nearby |
| Pea blue | no-host | no-flowers (it lays eggs on flower buds) |
| Lava lizard | no-open-ground | no-rock-shore |

The lava lizard was not in the review but had the same problem. A new test checks that every animal's mainNeed is a reason its own needs can produce. That test copies WP-D1's current reason tables, so it needs updating if they change.

**6. Look sentences with double colons.** I rewrote `inspectText`:
- If the ecology's reason names a species, it follows our description after a semicolon, with its own colon turned into a comma.
- Species names are written as they read mid-sentence ("koa", but "Pisonia" and "ʻōhiʻa lehua" keep their capitals).
- The first word is lowercased only when it is a common word.
- If the reason names no species, it is about the ground itself ("Fresh rock: lichens come first…"), so it stands alone instead of repeating our description.

**7. Seabird colonies can't live on an islet.** The sooty tern now fits on an islet (minArea 2,000 m², minPatches 25), and its hints say islet. The albatross deliberately still needs a low, real island, since it needs room for a running take-off.

**8. Odd generated lines.** The Krakatau milestone now reads "Your islands now grow {n} kinds of plants; Krakatau had 26, three years after it er

## wf_80ff46a6-275 :: WP-D1 review-fix pass, finished. I checked all 13 reviewer findings, found every one valid, and fixed them all. The work
1. src/eco/needs.ts: add a ReasonCode `'no-rock'`. Rock-only plants on sand currently get `'no-rock-shore'`, the closest existing code.
2. WP-D2: the island-lost entry text should read `params.name`, or the lead should add an island name field to JournalEntry. It is ignored today.
3. WP-D2: render `params.more` on arrival cards ("...and N more arrived").
4. Optional: a variant of `takeDirty` that returns several rectangles or tiles, so a change on two islands doesn't re-send the sea between them.
5. Notes for WP-D2 and catalogue tuning:
   - The ending entry is `kind 'ending'` with first `'first-whale'`.
   - Milestones come through `params.milestone` ∈ {kinds, rakata, hawaii, half, islands} plus `params.count`.
   - A kīpuka is reported as `'lava-buried'` with `params.kipuka=1`.
   - A visit carries `params.reason`.
   - Suggested catalogue changes: raise the silvereye's scrub threshold, and add late-game needs so the plateau comes later.

## wf_b51588f6-956 :: WP-H (the shell) is built and committed on `wp/shell` (7380c89), and the worktree is now detached. Typecheck, unit tests
1. **`src/engine/protocol.ts`, stroke `phase`:** please document `'cancel'` as "end this stroke and undo it". That is how Sandcastle Cays and `architecture-draft.md` treat it, and the shell relies on it when a second finger lands or a quick tap is taken back.
2. **`src/engine/protocol.ts`, after a load:** please document the order of `loaded`, `clear` and `ready`, and whether `ready` carries `header` after a load. The shell handles any order and applies the header from whichever arrives.
3. **`e2e/lib.mjs`, `openGame`:** there is now a start screen. After `ready`, please add `await page.evaluate(() => window.__game.start?.())` (or give `shot.mjs` a `--start` flag). Otherwise every `shot.mjs` screenshot shows the start card over the world.
4. **`docs/ARCHITECTURE.md`:**
   - §6.9: note that Look comes back after watch mode, and the extra `__game` hooks listed above.
   - §6.5 / §6.8: note that the camera's far plane is never under 16 km, so the sky dome and ocean must fit inside it.
   - §7: the budget checks compare `renderer.info` triangles and calls, which include the shadow pass, against 450k and 100.
5. **`src/content/stories.ts` (WP-D):** the stub `placeLabel` returns lowercase words. The shell capitalises the first letter, so returning "A sea cliff" as written also works.

## wf_b51588f6-956 :: # WP-G report: sky, day and night, weather, sound
.
- **Clouds file:** clouds live in `sky.ts` because `clouds.ts` wasn't in my file list.

## Contract requests
1. **`render/shared.ts` (comment only):** `uSunColor`, `uSkyColor` and `uGroundColor` are light colours scaled so that midday equals `#fff2d6`, `#cfe9ff` and `#e8d4a8`; they dim and tint through the day. `uFogColor` is the horizon haze colour.
2. **`protocol.ts` `PageSaveHeader`:** add `dayCount: number`, or define `dayPhase` as total days, so the season and moon survive a reload. `setPhase(phase, dayCount)` already accepts either.
3. **`protocol.ts` `TickEvents`:** document the units and ranges of `steam[i+2]` and `sliding`.
4. **Optional:** add `FrameCtx.paused` (journal or menu open) so the sky clock can hold too.
5. **ARCHITECTURE §6:** `render/clouds.ts` isn't needed; clouds live in `sky.ts`.

## wf_b51588f6-956 :: WP-H review fixes are committed on `wp/shell` as `353863d`, and the worktree is detached. All 11 findings checked out as
** none.

## wf_b51588f6-956 :: All seven review findings are fixed and committed on wp/sky (commit 6ad3e45, branch now detached). Typecheck, the 53 tes
**
- `src/engine/protocol.ts`, `StormState.level`: pin it as "0 at the start of the warning, rising to 1 as the peak begins; 1 through the peak; falling from 1 to 0 over the clearing".
- `src/config.ts`: export the phase lengths, e.g. `STORM_WARNING_S = 40`, `STORM_PEAK_S = 60`, `STORM_CLEARING_S = 30`. `weather.ts` would then use these instead of its own `WARNING_SECONDS` and `CLEARING_SECONDS`.
- For WP-H, not a lead contract file: `main.ts` should call `renderer.compileAsync(scene, camera)` at load, as ARCHITECTURE §7 requires. My meshes no longer depend on it.

## wf_ecd023a3-d8f :: WP-E2 is done: the sea, the shaping effects, the brush ring and the code-made hands are built, typecheck and tests pass,
1. **`src/engine/protocol.ts`, `TickEvents.steam`:** please define what "strength" means, for example "contact intensity 0..1 per emitter per tick". Until then I map any value with `1 - exp(-2·strength)`.
2. **`src/main.ts` (WP-H):** call `await renderer.compileAsync(scene, camera)` at load, as ARCHITECTURE 7 says. My effect, hand and ring materials stay hidden until first use and would otherwise stall the first pour.
3. **Optional, `src/engine/protocol.ts` `DebugOp` plus the engine:** a debug op such as `'steam'` (x, z, strength) that emits steam events, so browser checks can exercise the engine-reported steam without the full lava physics.
4. **`.gitignore`:** add `node_modules` without the trailing slash, so the worktree symlink is ignored.

## wf_ecd023a3-d8f :: WP-E1 (the land) is built and committed as `ea5e13b` on `wp/terrain`, and HEAD is detached. Typecheck, all tests and the
1. **`render/ocean.ts` (WP-E2):** compute water depth with `tgHeight` from the exported `HEIGHT_GLSL`. Then the sea matches the drawn floor everywhere, including the drop-off outside the zone (−42 m beyond 160 m). The sea must be opaque at that depth, and must be drawn after the terrain.
2. **`render/shared.ts`:** add the sun `DirectionalLight` (or its shadow camera) to `SystemDeps` or `FrameCtx`, so the terrain can cull shadow casters in the same frame.
3. **`engine/protocol.ts`:** add `island: number` to `PondInfo`. The pink and red pond tints currently guess the island from island bounding boxes.
4. **`main.ts`:** call `renderer.compileAsync(scene, camera)` at load to precompile the terrain material, as ARCHITECTURE §7 asks. The terrain's shadow-depth program still compiles on its first shadow pass.
5. **`.gitignore`:** change `node_modules/` to `node_modules`, because the instructed worktree symlink isn't matched and `git add -A` would commit it.
6. **Ecology (WP-D), for the life data:**
   - Mark pond squares with the `Pond`/`SaltPond` habitat codes; the pond fill starts from them.
   - Give old underwater rock some weathering or coralline cover.
   - The ground shader takes the "lee" (rain shadow) from low moisture in `coverB.b`.

## wf_ecd023a3-d8f :: I fixed all three major findings and all seven minor ones on wp/water (commit 021340c), then detached HEAD so the branch
1. **WP-E1 ground shader:** colour every terrain fragment from the full-resolution height map, as wet seabed with absorption wherever that height is below sea level, whatever the mesh height. Only then does the coast follow the height map at coarse levels of detail.
2. **WP-E1 underwater absorption:** keep it to mild darkening in the top few metres. The sea surface now paints the turquoise (ARCHITECTURE 6.4 and 6.5 both claim depth colour). Otherwise decide which side owns it and I'll re-tune the shallow opacity.
3. **WP-H `main.ts`:** set `brush = null` on touch stroke end/cancel, so the brush ring also clears on phones. The hands already fade by themselves.
4. **WP-F (note only):** call `seaHeight()` or `ocean.waveHeight()` after `ocean.update()` in the frame. The current system order already does this.
5. **From the builder's earlier report, still needed:** WP-H's `compileAsync` at load should precompile the hidden effect, hand and ring materials. The reviewer confirmed this works in r186.

## wf_ecd023a3-d8f :: All 10 review findings are fixed on `wp/terrain` (commit 70aa717, HEAD detached afterwards). Typecheck, all tests and th
- `docs/ARCHITECTURE.md` §6.4 says terrain shadows are "on for the Pixel only when performance allows". I now follow `quality.shadows`, so that decision belongs to main.ts. Please confirm, or add an explicit `terrainShadows` flag to `Quality` in `src/render/shared.ts`.
- §7 should note the shadow-pass split for WP-F: on the phone, terrain uses at most 55k triangles, leaving about 45k for plant shadows.
- §6.4 says "detail-normal noise fades in within 15 m". The shader fades it in between 16 and 36 m. Small mismatch, worth aligning the text.

Screenshots are in `/home/user/sand/.claude/worktrees/wf_ecd023a3-d8f-6/wind-wing-wave/e2e/output/`:
- terrain-god.png
- terrain-god-phone.png
- terrain-volcano.png
- terrain-beach.png
- terrain-cliff.png
- terrain-shallows.png
- terrain-ridge.png
- terrain-cay900.png
- terrain-close20.png
- terrain-westshore-phone.png
- terrain-lava.png
- terrain-lava-cooling.png

Before/after comparisons are in `/tmp/claude-0/-home-user-sand/1f8d55eb-7be6-5932-9ec2-19ccc14b5cae/scratchpad/terrain-fix/` (`before/`, `v1/`–`v5/`, `islet-compare.png`, `cmp/westshore-compare.png`).

