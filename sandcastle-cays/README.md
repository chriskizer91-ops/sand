# Sandcastle Cays

A calm game about living aboard a small sailboat in the Caribbean: comb the beaches for what the sea washes up, build sandcastles, sail between islands, and (coming) keep your boat in repair and grow food. Everything (sand, water, sky, boat, finds, sounds) is made in code. See [`docs/PLAN.md`](docs/PLAN.md) for the agreed plan.

**Current version: 0.4, "Blue water"**: the open sea beyond the reefs (stronger wind, a long swell, whitecaps, spray, surfing down waves), squalls you can sail into, the sea buoy with your best time out round it and home, faster sailing and a stronger outboard. 0.3.1 brought the outboard and navigation lights; 0.3 ("First passage") brought sailing with real wind, the chart and "sail there for me", anchoring, the reef and its gap, and a second island, Pink Sand Cay. Before that, 0.2 brought:
- your boat at anchor off Home Cay, seen through your own eyes;
- the new sea and sky from the raft game, with day and night;
- swimming ashore and walking the island;
- beachcombing with a basket, a locker aboard and a logbook;
- kneeling on the cove's sand to build.

## Playing it
**Easiest:** open the game's private link, https://claude.ai/artifact/3F64yxNHrsCbRvwY9mdk3f, which always has the latest version. (For Claude sessions: it's the claude.ai artifact with slug `1229d053-31f1-46e8-be80-cc430658ecc6`; republish `builds/` files to it with each new version.)

Or download the file: `builds/sandcastle-cays-v0.4.html`.
- **Laptop:** download the file and double-click it (opens in Chrome or Edge).
- **Pixel phone:** download the file, then open it from Files > Downloads with Chrome.

| | Phone | Laptop |
| --- | --- | --- |
| Walk | left thumb anywhere on the left (push all the way to run) | W A S D / arrows, Shift to run |
| Look | drag with the right thumb | click once, then move the mouse or trackpad (Esc lets go) |
| Pick up / use | tap the find, or the round button | look at it and press E (or click) |
| Jump / climb | the arrow button | Space |
| Kneel to build (on the cove's sand) | the round button | B |
| Logbook | book button | L or the book button |
| Take the helm (in the cockpit) | the round button | E |
| Steer / sails up and down (take in sail when she's overpowered) | left thumb / "More sail", "Less sail" | A D / W S |
| Outboard motor (ahead / astern) | "Motor" buttons | R / F |
| Anchor | "Drop anchor" button | X |
| Chart (tap a place to sail there, or "Round the sea buoy and come home") | map button | M |
| While building | one finger tool, two fingers swing, pinch zoom | click to use the tool, two-finger swipe to swing, pinch or wheel to zoom |
| Stand up again | "Stand up" button | Esc or B |

The **Menu** has save/load to a file, the drying speed ("sun"), sound, graphics, help, and **Run the checks on this device** (with the frame rate).

## For developers (and future Claude sessions)
```
npm install
npm run typecheck       # TypeScript types
npm test                # sand rules, game rules (island, sea, clock, beachcombing, walking), the boat and the finds
npm run build           # -> dist/index.html (one self-contained file)
npm run browser-check   # headless Chromium as laptop + Pixel: plays aboard, swims, beachcombs, builds; screenshots to e2e/output/
npm run release         # build + copy to builds/sandcastle-cays-v<version>.html
```
- `node e2e/look.mjs <name>` builds a sample castle and screenshots it.
- `node e2e/sloop-look.mjs`, `node e2e/finds-look.mjs` and `node e2e/weather-look.mjs` screenshot the boat, the finds and the weather on their own.
- Add `#debug` to the URL for a performance readout (frame rate, draw calls, triangles), or `#noworker` to force the sand engine onto the page (backup mode).

### Layout
- `src/engine/`: the sand engine (no browser-page code; runs in a Web Worker). Unchanged in v0.2 apart from the save header carrying the game state.
- `src/world/`: `homeCay.ts` and `pinkCay.ts` (each island's shape, reef, tideline and anchorage), `islands.ts` (what islands share), `world.ts` (both on one sea floor) and `ground.ts` (what's underfoot, including your castles).
- `src/game/sailing.ts`: how the boat sails (points of sail, tacking, heel, leeway, overpowering, surfing, running aground, anchoring, the motor, the autopilot).
- `src/game/weather.ts`: the trade wind, the open sea beyond the reefs, and the squalls.
- `src/player/player.ts`: you, in first person (deck, land, swimming, the ladder).
- `src/game/beach.ts`: beachcombing rules (wash-ups, basket, locker, logbook) and the finds on the sand.
- `src/content/finds.ts`: the catalogue of finds with true facts.
- `src/render/`:
  - `ocean.ts`, `sky.ts`, `daylight.ts`, `pipeline.ts`, `paint.ts`: the water, the sky, the light and how each frame is drawn (from the raft game);
  - `island.ts` and `islandLife.ts`: the island's ground, plants and rocks;
  - `sloop.ts`, `boatMotion.ts` and `wake.ts`: the boat (with sails, boom and rudder that move), how it rides the waves, and its wake;
  - `weatherFx.ts` (with `squallFx.ts`, `rainFx.ts`, `sprayFx.ts`, `weatherCommon.ts`): squall clouds and rain curtains, rain around you, spray over the bow;
  - `buoy.ts`: the sea buoy;
  - `finds.ts`: the find and basket models;
  - `held.ts`: the basket in your hand;
  - `scenery.ts`: the cove's own rocks and plants, and the distant islands;
  - the sand material and tiles.
- `src/input/`: `fpInput.ts` (first-person controls), `camera.ts` and `controls.ts` (the building camera).
- `src/ui/`: `hud.ts` (first-person screen and logbook), `sailHud.ts` (the wind dial and helm buttons), `chart.ts` (the chart), `ui.ts` (menus, building tray), `icons.ts`.
- `src/audio/`, `src/storage/`: synthesised sounds, saves.
- `src/checks/sandChecks.ts`: the sand checks, shared by `tests/` and the in-game Checks page.
- `docs/`: plan, decisions log, changelog.
