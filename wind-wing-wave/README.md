# Wind, Wing & Wave

A calm island-making game (working name). You shape land from the sea with lava, rock and sand.
Life finds it on its own, on the wind, on wings and on the waves, and the island's shape decides who
stays. Years fly by in the journal; everything you watch moves at real speed. Everything (land, sea,
sky, plants, animals, sounds) is made in code.

- What we're building: [`docs/PLAN.md`](docs/PLAN.md)
- How it's built: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Why: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- What changed in each version: [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

**Status:** in development. No version has been sent to the owner yet.

## For developers (and future Claude sessions)
```
npm install
npm run typecheck       # TypeScript types
npm test                # every registered check (land rules, life rules, engine) - same as the in-game Checks page
npm run build           # -> dist/index.html (one self-contained file)
npm run browser-check   # headless Chromium as a laptop and a Pixel-sized phone, with screenshots in e2e/output/
npm run release         # build + copy to builds/wind-wing-wave-v<version>.html
node e2e/shot.mjs --cam x,z,dist,yaw,pitch --out e2e/output/x.png   # quick screenshot of any view
```

### Layout
- `src/engine/`: the engine (runs in a Web Worker, with a fallback that runs it on the page).
  - `columns.ts`: the ground as 2 m columns (rock, sand, lava).
  - `geo/`: tools, lava, sand, seabed, coast.
  - `engine.ts`: the hub. `protocol.ts`: the messages. `undo.ts`, `save.ts`, `fixtures.ts` (a scripted chain of islands for tests).
- `src/eco/`: the life simulation on 4 m patches (`patches.ts`, `ecology.ts`, …). `needs.ts`: what each species needs.
- `src/content/`: the species catalogue and every line of journal text.
- `src/render/`: three.js. The world data maps (`fields.ts`), the GPU terrain, ocean, plants, animals, sky, weather, effects.
- `src/audio/`, `src/input/`, `src/ui/`, `src/storage/`: sound, camera and controls, interface, saving.
- `src/checks/`: the checks registry (`npm test` and the in-game Checks page run the same checks).
- `docs/design-notes/`: background design research (not the spec).
