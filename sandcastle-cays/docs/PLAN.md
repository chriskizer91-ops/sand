# The plan (agreed with the owner)

**Sandcastle Cays** (working name) is a calm game about living aboard a small sailboat in the Caribbean. You comb beaches for what the sea washes up, build sandcastles, keep your boat in good repair, grow a little food, and sail between small islands. It runs in Chrome on a Pixel 7a and on a Windows laptop with a trackpad. Each version is one HTML file.

*Changed on 2026-11-01 (see DECISIONS 9–15):* sandcastle building used to be the whole game. Now it is one of the main things you do in a bigger, peaceful sailboat life. The owner's raft survival game is the source for the water, the sky, gathering, the shark, tools and upkeep, made gentle.

## The feel
- **Peaceful, but with something to look after.** You manage things rather than fight to survive. Nothing kills you, and you never lose your save.
- **Realistic water and light; a slightly storybook boat, sailor and objects.** The mix should look like one style, not two.
- **Seen through your own eyes** (first person), on the phone and on the laptop.
- **Everything is made in code:** models, sounds, sky, water. Code may paint textures such as wood grain and water ripples when the game starts (agreed 2026-11-01).

## What you do
- **Beachcombing.** Finds wash up along the tideline: shells, sea glass, driftwood, rope, coconuts, fishing floats, the odd crate, bottles with notes. You carry them in a basket and stow them aboard. A logbook keeps every kind you have found, with a true fact about it.
- **Sandcastles.** Kneel on a beach to build with the sand engine: dig, pile, pat, then bucket, carve, water and drip. Finds can decorate castles (driftwood beams, shells, feather flags).
- **Living aboard.** Your boat is your home. You keep rations of food and water, about a month's worth when the stores are full. They run down slowly, so they are something to plan around, not a hunger meter. Running low is the worst that can happen. Fishing, fruit from islands, and rain water top them up.
- **Upkeep.** The boat occasionally needs repair: a worn sail, a leak, a scraped dinghy. Repairs use what you find.
- **Gardening.** Pots of herbs and vegetables on deck, and a garden at your home anchorage on Home Cay.
- **The shark.** It isn't always there: it shows up now and then, in certain waters (reef edges, channels). It can make you drop your basket of finds or bump the dinghy so it needs repairs. Bait lures it away.
- **Sailing, the heart of it.** Real wind: you steer, the sails trim themselves (with an option to trim by hand), and you can't sail straight into the wind. A chart of the islands you've found. Sheltered water inside the reefs; out on the open sea, more wind, bigger waves and squalls for an exciting sail. A small outboard for tight spots, always much slower than sailing.

## How we build it: one small piece at a time, finished properly
First a **vertical slice**: a small piece of the game made to finished quality, played by the owner on the phone and the laptop, and adjusted until it feels right. Only then do we add more islands and features.

**The slice is Home Cay**, delivered in parts:
1. **v0.2, Aboard and ashore:**
   - first person on phone and laptop;
   - the new sea and sky (from the raft game), with day and night;
   - your sloop at anchor off Home Cay: walk the deck, swim ashore, walk the island;
   - beachcombing with a basket, a locker aboard and the logbook;
   - kneel on the cove beach to build sandcastles.
2. **v0.3, First passage** (moved up by the owner, 2026-11-01):
   - sailing with real wind: take the helm, raise the sails, steer;
   - you can't sail straight into the wind; tack (zig-zag) to go upwind;
   - the chart, with "sail there for me";
   - anchoring;
   - the reef and its channel (running aground scrapes the hull);
   - a second cay (Pink Sand Cay) with its own sand and finds.
3. **v0.4, Blue water** (added by the owner, 2026-11-03, to make sailing the main thing):
   - a stronger outboard (about 5 knots), and sailing that is always much faster;
   - the open sea beyond the reefs: stronger wind, a long ocean swell, whitecaps, spray over the bow, surfing down waves;
   - squalls you can see coming and sail into: rain, a burst of wind that shifts as you pass through;
   - too much sail in a strong wind and she's overpowered: take in sail (reef) to stay in control;
   - the sea buoy out on the open sea, with your fastest run out round it and home in the logbook.
4. **v0.5, Living aboard** (built first, 2026-11-03):
   - food and water stores, counted in days;
   - fishing with a rod, the cool box and the galley;
   - rain caught in an awning to fill the water tank;
   - coconuts from the palms;
   - repairs at a workbench with materials from the beaches (driftwood, planks, rope, sailcloth, net, bottles), with recipes that appear as you find new materials;
   - sail wear, and a leaking hull you pump out.
5. **v0.6, The garden:** deck pots and the Home Cay garden.
6. **v0.7, A bigger boat** (the owner's choice, 2026-11-04): a 45 ft catamaran you can walk around inside:
   - a saloon with the galley and chart table;
   - a cabin in each hull (sleep in your bunk until morning) and a workshop;
   - a flybridge helm with a big wheel and an all-round view;
   - a trampoline at the bow and swim steps at the sterns.
7. **v0.8, The dinghy and the reef:**
   - rowing the dinghy;
   - the shark, now and then, off the reef;
   - dropped finds that wash up later;
   - dinghy repairs.
8. **v0.9, Polish:** a full pass on look, sound, feel, text and phone speed. This is the finished slice.

## After the slice (ideas agreed along the way)
- **Tides:** the tide wins wherever it reaches. Castles near the waves are gone by high tide; castles above the high-tide line last.
- **Sands that play differently:** fine white Bahamas sand, pink sand, coarse golden sand, black volcanic sand.
- **Finds have jobs:** driftwood is a beam (lintels, bridges, longer arches); feathers are flags; rocks anchor walls; shells and sea glass decorate.
- **Moulds instead of money:** start with the classic castle bucket; others wash up (square keep, cone spire, starfish, brick).
- **Little residents:** hermit crabs move into towers with a room and a door; sandpipers; gulls on the tallest tower.
- **Messages in bottles:** a gentle story told in notes.
- **Weather:** rain, storms with a warning, golden-hour light, glowing water at night.
- **More:** music; snorkelling for finds; hosting on GitHub Pages; working offline once added to the home screen.

## The sand (unchanged)
- A grid of small cells (3 cm each), drawn as smooth, soft sand. Each cell knows how much sand it holds, how wet it is, and how packed it is.
- Dry sand slumps, damp sand holds, packed sand is strongest, soaked sand drips, and the sun dries it. Arches and tunnels work.
- Every grain you pile comes from somewhere you dug.

## Saving
Play for hours and come back to the same boat, island and castles. It saves automatically, and a "save to file" button is there as a backup.

## How the owner can trust it works
- Automatic checks of the sand rules and the game rules.
- Tests in a real browser as a laptop and as a Pixel-sized phone, with screenshots.
- A checks page inside the game that runs on the owner's own phone, including the frame rate.
- A plain-language note of what changed in every version (`CHANGELOG.md`).
