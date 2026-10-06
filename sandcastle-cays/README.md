# Sandcastle Cays

A calm sandcastle-building game. You live on a small sailboat and visit Caribbean island beaches. Everything (sand, water, sky, boat, sounds) is made in code. See [`docs/PLAN.md`](docs/PLAN.md) for the agreed plan.

**Current version: 0.1, "The Calm Lagoon"** (stage 1, part 1): one beach, no tide, with Dig, Pile and Pat.

## Playing it
The game is one file: `builds/sandcastle-cays-v0.1.html`.
- **Laptop:** download the file and double-click it (opens in Chrome or Edge).
- **Pixel phone:** download the file, then open it from Files > Downloads with Chrome.

Controls:
| | Phone | Laptop |
| --- | --- | --- |
| Use the tool | one finger | click and drag |
| Swing around | two fingers drag | two-finger swipe on the trackpad, or right-drag |
| Zoom | pinch | pinch, or mouse wheel |
| Go to a spot | quick two-finger tap | right-click |
| Move | (zoom and swing) | W A S D / arrows, Q E to turn |
| Undo | ↶ button | Ctrl+Z |

The **Menu** has save/load to a file, the drying speed ("sun"), sound, graphics, help, and **Run the checks on this device**.

## For developers (and future Claude sessions)
```
npm install
npm run typecheck       # TypeScript types
npm test                # the sand-rule checks (same ones as the in-game Checks page)
npm run build           # -> dist/index.html (one self-contained file)
npm run browser-check   # opens the build in headless Chromium as laptop + Pixel, plays, screenshots to e2e/output/
npm run release         # build + copy to builds/sandcastle-cays-v<version>.html
```
`node e2e/look.mjs <name>` builds a sample castle and screenshots it from a few angles (for judging the look).
Add `#debug` to the URL for a performance readout, or `#noworker` to force the sand engine onto the page (backup mode).

### Layout
- `src/engine/`: the sand engine (no browser-page code; runs in a Web Worker).
  - `world.ts`: sparse 3 cm cell grid in 16³ chunks, with untouched ground computed from `terrain.ts`.
  - `sim.ts`: physics (settling, slumping, overhang support, falling crumbs, drying, draining).
  - `material.ts`: how moisture and packing turn into stickiness, slope and overhang reach.
  - `tools.ts`: raycast, dig, pile, pat.
  - `mesher.ts`: surface nets over a signed-distance reconstruction (smooth, no terraces).
  - `undo.ts`, `save.ts`, `engine.ts` (the message-driven hub), `worker.ts`, `host.ts` (worker or page fallback).
- `src/render/`: three.js scene (sand material, water, sky, scenery, boat, particles, brush ring).
- `src/input/`: orbit camera and touch/trackpad/keyboard controls.
- `src/ui/`, `src/audio/`, `src/storage/`: buttons and panels, synthesised sounds, saves.
- `src/checks/sandChecks.ts`: the checks, shared by `tests/` and the in-game Checks page.
- `docs/`: plan, decisions log, changelog.
