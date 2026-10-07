# Handoff: where Wind, Wing & Wave stands

*Written so the next session (or the owner) can pick up exactly here. Plain-language summary first; technical detail after.*

## In plain words (for the owner)
- **The game is designed, and all ten parts have been built by a team of AI builders working in parallel.** Each part was then checked by a separate reviewer and fixed.
- **Status of the parts:** all ten are merged into the main working branch and saved on GitHub. The whole game typechecks and builds into one file (about 1.7 MB).
- **Not done yet:**
  - **Joining.** All ten parts haven't been joined into one playable game yet. This is the next big step.
  - **Pacing.** How fast life arrives hasn't been tuned.
  - **Testing and delivery.** Nothing has been play-tested on phone and laptop sizes, and no version has been sent to you.
- **What's already working:**
  - The start screen and the lava you pour.
  - The real land and sea rendering, the sky, and the interface.
  - The first-minute flow: "Touch the glow", then land breaking the surface, then "Your island."
- **What to say to restart:** something like *"Continue Wind, Wing & Wave from docs/HANDOFF.md."*

## Where everything is
- **Working branch:** `claude/eager-johnson-ij9j8z`, pushed to GitHub. All merged work lives here.
- **Game folder:** `wind-wing-wave/`.
- **Read first:**
  - `README.md`
  - `docs/PLAN.md` (what we're building, owner-facing)
  - `docs/ARCHITECTURE.md` (the technical contract every part was built against)
  - `docs/DECISIONS.md`
- **Background research:** `docs/design-notes/` holds the four design pitches and three critiques. They are not the spec.
- **Raw contract requests from the builders:** `docs/handoff-contract-requests.md` (to apply during joining).
- **How the parts were built:** `docs/handoff-build-workflow.js`. This is the exact brief each builder, reviewer and fixer got, and it is reusable as a template.

## The ten parts (work packages)
Each part was built on its own branch `wp/<name>`, then reviewed and fixed on that branch.

| Part | Branch | What it is | State |
|---|---|---|---|
| geo | `wp/geo` | Seabed, lava flow and cooling, sand sliding, the 5 tools, coast and storm surf | **Merged** |
| engine | `wp/engine` | Engine hub on a background thread, streams to the page, undo, save/load (checksummed) | **Merged** |
| sky | `wp/sky` | 16-minute day and night, seasons, sky, clouds and cap clouds, storms, rain, rainbow, all sound | **Merged** |
| shell | `wp/shell` | Camera, map-style gestures, tray, cards, 3-tab journal, Look, menu, settings, autosave, browser checks | **Merged** |
| terrain | `wp/terrain` | GPU-displaced CDLOD land and ground shader (rock, sand, soil, lava glow, cover), ponds | **Merged** |
| water | `wp/water` | Ocean, waves (`seaHeight`), steam and pour effects, brush ring, code-made hands | **Merged** |
| content | `wp/content` | About 90 real species with facts, hints and needs, plus every journal line and the Look sentences | **Merged** |
| ecology | `wp/ecology` | The life simulation: climate, soil, succession, arrivals, animals, storms, places, journal, director | **Merged** |
| plants | `wp/plants` | Code-made plant archetypes, vegetation instancing, pop and death animations | **Merged** |
| animals | `wp/animals` | Code-made animal body plans, behaviours at real pace, arrival scenes | **Merged** |

## Known issues right now
The last test run had **470 tests passing and 24 failing** (`npx vitest run`). All 24 are joining issues, expected at this stage; no part is known to be broken on its own.
- **17 arrival-scene tests in `tests/fauna.test.ts`.** They look up the stand-in species keys (`anole`, `booby`, `palm`, …). The real catalogue (`content/species.ts`) uses different keys. Point the tests at real species, or have the tests build their own small catalogue.
- **4 engine tests in `tests/engine.test.ts`.** They were written against the do-nothing geology and ecology stand-ins:
  - "streams quiet ground changes": real sand now slides off the test spikes; set their sediment to 0.
  - "empty strokes are not counted": real Hands now smooths ground; use a stroke at the zone edge, where tools fade to nothing.
  - "pause…": check against the real ecology clock.
  - one more.
- **2 engine checks (`checks/engineChecks.ts`):**
  - "A saved sea reloads exactly…": now includes real ecology state.
  - "If the life simulation fails…": the screen copy differs. This may be a real stream-flush issue while lava is still active; investigate.
- **The full list of failing tests:**
```
tests/checks.test.ts > checks > engine: A saved sea reloads exactly, with the same ground, life and years
tests/checks.test.ts > checks > engine: If the life simulation fails, the ground keeps updating and undo still works exactly
tests/engine.test.ts > engine messages > pause: the year clock stops when paused, physics stops when hidden, pace follows settings
tests/engine.test.ts > engine messages > streams quiet ground changes to the page copy
tests/engine.test.ts > undo records > through messages: empty strokes are not counted, and cancelling one keeps the stroke before it
tests/fauna.test.ts > arrival scenes > a coconut that stays rolls up onto the beach; one that cannot stay washes back out
tests/fauna.test.ts > arrival scenes > a far arrival plays when the camera glides there while its marker still glows
tests/fauna.test.ts > arrival scenes > anole by raft (leaves) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > anole by raft (stays) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > arrival actors never pop: each starts out of sight or fades in, fades only gradually, and goes only unseen
tests/fauna.test.ts > arrival scenes > booby by flight (leaves) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > booby by flight (stays) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > butterfly by flight (stays) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > ghostcrab by sea (stays) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > palm by sea (leaves) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > palm by sea (stays) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > turtle by sea (stays) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > vine by sea (stays) plays a calm scene that ends quietly
tests/fauna.test.ts > arrival scenes > whale by flight (leaves) plays a calm scene that ends quietly
tests/fauna.test.ts > fauna simulation > cliff day laptop: speeds stay within each species' range
tests/fauna.test.ts > fauna simulation > forest day laptop: speeds stay within each species' range
tests/fauna.test.ts > fauna simulation > night brings bats and fireflies; day birds are gone and seabirds roost
tests/fauna.test.ts > fauna simulation > overview day laptop: speeds stay within each species' range
tests/fauna.test.ts > fauna simulation > reef day laptop: speeds stay within each species' range
```
- **Contract requests are not yet applied.** See `docs/handoff-contract-requests.md`. The main ones:
  - Engine and ecology:
    - `takeDirty` should return several rectangles or tiles, not one big box.
    - The hub must route `markChanged` to `ecology.onTerrainChanged`, call `setClock` on focus, pause and settings, call `restore()` after loading the PatchGrid arrays, and follow undo with `undoMerge` and then `markChanged(Geom)`.
    - New seas should start in the dry season, so the first storm lands at 15–20 minutes, not 33–40.
  - Protocol and frame data:
    - `PondInfo.island`;
    - `PageSaveHeader.dayCount` (so the season and moon survive a reload);
    - units for the steam strength and `sliding`;
    - `FrameCtx.paused` (the sky clock keeps running while the journal is open);
    - the sun light in `FrameCtx` (terrain shadow culling).
  - Plants: a `takePops()` event so plant pops can reach the sound and watch mode.
  - ARCHITECTURE doc fixes: the `lavaStats` shape, the `reefSand` meaning, clouds living in `sky.ts`, the plant instance layout and caps, and the ecology constructor's `species` argument.
- **Pacing with the real catalogue is uneven.** The life builder reports 16 of 44 beats arriving early. Tune with `npm run simulate`, which takes `--catalogue real` (see `tools/simulate.ts`), and `RATE_SCALE` in `src/eco/arrivals.ts`.
- **Phone speed has never been measured.** Each piece was built to the budgets in ARCHITECTURE §7, but the parts haven't been measured running together.
- **The local-only `.claude/` folder** holds the builders' old git worktrees. It is ignored via `.git/info/exclude` and is safe to delete with `git worktree prune` after removing the folders. The `wp/*` branches hold everything that matters, and all of them are merged.

## Next steps (in order)
1. **Join** (one agent, in the main checkout):
   1. All `wp/*` branches are already merged.
   2. Apply the sensible contract requests.
   3. Fix the failing tests.
   4. Make `npx tsc --noEmit`, `npx vitest run`, `node build.mjs` and `npm run browser-check` all pass.
   5. Play it for real through Playwright: Begin, pour lava on the glow, `advanceYears`, and check that plants pop, animals appear and the journal fills. Then a storm, and save/load.
2. **Tune pacing** with `npm run simulate` and the real catalogue, against the beat sheet in ARCHITECTURE §4. Targets: first life ≤ 20 s, first tree ≈ 8–12 min, first storm ≈ 15–20 min, plateau ≈ 40–50 min.
3. **Review the joined game in parallel**, through four lenses: playtest/pacing, visual quality (screenshot tour), seam bugs and performance budgets, and owner-friendliness. Then fix and repeat until clean.
4. **Release v0.1:**
   1. `npm run release` (it copies to `builds/`).
   2. Write the CHANGELOG entry: what passed, what failed, what couldn't be tested (real Pixel speed, phone storage when opened from Downloads, how the gestures feel).
   3. Commit, push, and tell the owner how to open it on the Pixel.

## Owner preferences to keep
- The owner doesn't code: plain language, short replies, details in docs.
- **No image, texture, sprite or sound files, ever.** Everything is made in code.
- A full game, not a demo. Calm and serene. Life arrives on its own; no weather control. Seasonal storms are light drama. Years show only in the journal and on cards. Animals move at real pace. Trees pop up.
- **Open decisions the owner can change:**
  - the name (working name "Wind, Wing & Wave");
  - pace (2 years per second);
  - storm frequency;
  - whether lava burns forests (it does; undo restores them);
  - map-style gestures (they differ from Sandcastle Cays).
- **Still useful from the owner:** run Sandcastle Cays' "Run the checks on this device" on the Pixel 7a and report the frame rate (real phone speed has never been measured).
