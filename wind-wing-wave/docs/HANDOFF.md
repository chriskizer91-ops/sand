# Handoff: where Wind, Wing & Wave stands

*Written so the next session (or the owner) can pick up exactly here. Plain-language summary first; technical detail after.*

## In plain words (for the owner)
- **The game is designed, and all ten parts have been built by a team of AI builders working in parallel.** Each part was then checked by a separate reviewer and fixed.
- **Status of the parts:** see the merge table below. Every part's work is saved on GitHub, either merged into the main working branch or on its own branch waiting to be merged.
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
| ecology | `wp/ecology` | The life simulation: climate, soil, succession, arrivals, animals, storms, places, journal, director | STATE_ECOLOGY |
| plants | `wp/plants` | Code-made plant archetypes, vegetation instancing, pop and death animations | STATE_PLANTS |
| animals | `wp/animals` | Code-made animal body plans, behaviours at real pace, arrival scenes | STATE_ANIMALS |

## Known issues right now
- **Three engine tests fail since the real geology was merged.** The hub's tests were written against the do-nothing geology stand-in:
  - `tests/engine.test.ts` › "streams quiet ground changes": real sand now slides off the test spikes.
  - `tests/engine.test.ts` › "empty strokes are not counted": real Hands now smooths ground.
  - `checks/engineChecks.ts` › "If the life simulation fails…": the screen copy differs. This may be a real stream-flush issue while lava is still active; investigate.
- **The tray** (shell) is wide while only Lava shows. This was seen before the shell's review fixes; check again.
- **Contract requests are not yet applied.** See `docs/handoff-contract-requests.md`. The main ones:
  - `PondInfo.island`;
  - `PageSaveHeader.dayCount` (so the season and moon survive a reload);
  - units for the steam strength and `sliding`;
  - `FrameCtx.paused` (the sky clock keeps running while the journal is open);
  - the sun light in `FrameCtx` (terrain shadow culling);
  - ARCHITECTURE doc fixes: `lavaStats` shape, `reefSand` meaning, clouds living in `sky.ts`.
- **The local-only `.claude/` folder** holds the builders' old git worktrees. It is ignored via `.git/info/exclude` and is safe to delete with `git worktree prune` after removing the folders. The `wp/*` branches hold everything that matters.

## Next steps (in order)
1. **Join** (one agent, in the main checkout):
   1. Merge any remaining `wp/*` branches.
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
