# Decisions log

Newest at the bottom. Each entry: what we decided, and why.

## 1. Sand is a grid of small cells drawn as a smooth surface ("smooth voxels")
- **What:** the beach is a 3D grid of cells, 3 cm across. Each cell stores three numbers from 0 to 255: `fill` (how much sand), `wet` (moisture) and `pack` (how compacted). The surface is drawn with "surface nets", a method that puts one smooth vertex inside each cell the surface passes through, so no cubes are ever visible.
- **Why:** particles can't hold shapes or scale to a castle on a phone; cubes feel like Lego; a height-map can't do tunnels, arches or overhangs. Cells can do all of these and still run on a phone.
- **Cost:** detail under a few centimetres comes out soft and rounded.

## 2. Sand physics rules (engine/sim.ts, engine/material.ts)
- `cohesion` comes from `wet` and `pack`. Dry sand has none; damp sand has some; packed damp sand has the most; soaked sand loses it again. Packed sand keeps a little strength when it dries.
- **Slumping:** sand slides to a lower neighbour if the slope is steeper than the sand can hold. That's about 33° when dry, steeper when damp, and packed damp sand doesn't slide at all.
- **Overhangs:** cohesive sand can hang sideways off supported sand for a few cells (`span`, up to 8 cells = 24 cm when packed and damp). That's what makes tunnels and arches hold. Anything unsupported breaks off and falls as crumbs.
- **Falling sand:** falling sand becomes particles that land and turn back into cells.
- **Conservation:** sand is never created or destroyed. The total of cells, hands and falling particles is constant, and a check enforces it.
- **Drying:** exposed surfaces dry slowly in the sun. Sand below sea level is soaked, and sand just above the water stays damp from below.

## 3. Only edited parts of the beach are stored ("sparse chunks")
- **What:** the world is cut into chunks of 16×16×16 cells. Untouched chunks are computed from the beach-shape formula when needed, and are only stored once something changes them.
- **Why:** memory grows with how much you build, not with how big the beach is, so whole-beach building and dunes are possible.
- **Note:** the beach-shape formula is versioned (`GENERATOR_VERSION`). Changing the formula changes unedited ground in old saves.

## 4. The sand engine runs on a background thread (Web Worker), with a fallback
- The engine has no browser-page code, so it can run in a worker or on the main thread.
- The single HTML file carries the worker's code as text. If the browser refuses to start a worker (possible when a file is opened straight from a phone's downloads), the game runs the engine on the main thread instead.

## 5. Delivered as one HTML file
- The owner tests by opening a single `.html` file. Everything (code, styles, sounds, models) is inside it, with no internet needed.
- Bundled with esbuild (`build.mjs`). Each release is copied into `builds/`.

## 6. Saving
- Autosave to the browser's storage (IndexedDB, falling back to localStorage) every minute and when the game is hidden.
- "Save to file" / "Load from file" always works as a backup.
- Save format (`engine/save.ts`): a small header, then every changed chunk's raw arrays, compressed with deflate.

## 7. Controls
- Touch: one finger uses the tool. Two fingers drag to orbit, pinch to zoom, and a quick two-finger tap glides the camera to that spot.
  - A stroke only starts after the finger moves a little or ~90 ms passes. If a second finger lands after it started, the stroke is undone, so camera moves never leave marks.
- Trackpad / mouse: click to use the tool; two-finger swipe orbits; pinch (or a mouse wheel) zooms toward the pointer.
  - Right-drag also orbits; a right-click without dragging glides the camera there.
  - Keys: WASD/arrows pan, Q/E rotate, 1-3 tools, Ctrl+Z undo.
- Double-tap was not used for "go there", because tapping twice quickly is a natural way to pat sand.

## 8. Undo
Each stroke opens an undo record. The first time a chunk is changed during that record (by the tool or by sand sliding afterwards), a copy is saved. Undo restores those copies and what was in your hands. Drying doesn't make copies, to save memory.
