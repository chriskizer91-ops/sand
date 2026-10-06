# The plan (agreed with the owner)

**Sandcastle Cays** (working name) is a calm sandcastle game on small Caribbean islands. It runs in Chrome on a Pixel 7a and a Windows laptop with a trackpad. Each version is delivered as a single HTML file. Hosting on GitHub Pages comes later.

## The sand
- A grid of small cells (a few centimetres each), drawn as smooth, soft sand. Each cell knows how much sand it holds, how wet it is, and how packed it is.
- Dry sand slumps, damp sand holds, packed sand is strongest, soaked sand drips, and the sun dries it. Arches and tunnels work.
- Every grain you pile comes from somewhere you dug. Your first moat gives you your first wet sand. You can carry plenty.

## Big builds
- The whole beach is yours. A castle can be as big as the sand you're willing to move, even a whole dune; it just takes time.
- To keep the phone smooth, distant parts of the beach may be drawn in less detail. Details smaller than a few centimetres stay soft and rounded.

## Two kinds of beach
- **The calm lagoon:** no tide. What you build stays.
- **Tidal beaches:** the tide wins wherever it reaches.
  - Near the waves at low tide: gone by high tide.
  - Just below the high-tide line: only lapped, wearing down to a mound you'll find next day if it was big enough.
  - Above the high-tide line: it lasts.

## Saving
Play for hours and come back to the same castle. It saves automatically, plus a "save to file" button as a backup (a file opened straight from a phone's downloads doesn't always keep its saves).

## Controls
- Phone: one finger sculpts, two fingers swing the camera, pinch zooms.
- Trackpad: click to sculpt, two-finger swipe to swing, pinch to zoom.
- Undo is always there. The Pixel gives small buzzes when you pat sand.

## Stages (each tested by the owner)
1. **The calm lagoon**: the sand, the tools (dig, pile, pat, bucket, carve, water, drip), controls, saving, sounds and a photo button. Delivered in two parts:
   - 1a: the sand with dig, pile and pat;
   - 1b: bucket, carve, water and drip.
2. **Tides**: a tidal beach, day and night (about an hour of play per day, two high tides, rest to skip ahead, time pauses while the game is closed), waves that wear castles down, and the logbook.
3. **Finds**: shells, sea glass, driftwood beams, feather flags, and moulds that wash up.
4. **Sailing**: the boat, wind and D-pad/arrow steering, a few islands each with its own sand, and the cabin.
5. **Later**: crabs and birds, messages in bottles, weather, glowing water at night, music, GitHub hosting.

## Ideas agreed along the way
- Finds have jobs: driftwood is a beam (lintels, bridges, longer arches) and floats away in the tide; feathers are flags; rocks anchor walls; shells and sea glass decorate.
- Moulds instead of money: start with the classic castle bucket; others wash up (square keep, cone spire, starfish, brick).
- Sands that play differently: fine white Bahamas sand, pink sand, coarse golden sand, black volcanic sand.
- Little residents: hermit crabs move into towers with a room and a door; sandpipers; gulls on the tallest tower.
- Messages in bottles as the only goals, all optional.
- The boat as a tiny home: logbook, tide clock, one small shelf for finds.
- A little cartoon sailor on the boat; cartoon hands when building.
- Sounds made in code; weather and golden-hour light; works offline once added to the home screen.

## How the owner can trust it works
- Automatic checks of the sand rules.
- Tests in a real browser slowed to phone speed, with screenshots.
- A check page inside the game that runs on the owner's own phone.
- A plain-language note of what changed in every version (`CHANGELOG.md`).
