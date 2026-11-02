# What changed, version by version (plain language)

## v0.3, First passage
You can sail now. Take the helm, raise the sails, find your way out through the gap in the reef, and sail to a second island, Pink Sand Cay.

**What you can do**
- **Take the helm** in the cockpit:
  - steer: A/D, or your left thumb on the phone;
  - raise and lower the sails: W/S, or "More sail" and "Less sail";
  - drop or raise the anchor: X;
  - let go: E.
  The mainsail goes up the mast and the jib unrolls. The boom swings out on the side away from the wind, and the sails flap when you point too close to it.
- **Real sailing rules:**
  - you can't sail within about 40° of the wind (the boat stops "in irons");
  - you're fastest with the wind from the side, and she leans away from it;
  - she slips a little sideways;
  - to go upwind you zig-zag.

  A small dial shows where the wind comes from, with a red wedge where you can't sail, plus your speed in knots and your point of sail.
- **The reef matters.** Home Cay's reef has one gap, to the south-west. Run onto the reef (or a beach) and she's aground: the hull is scraped (that's for the repairs coming next), and you steer for deeper water to get off.
- **Anchor anywhere** shallow enough (under 16 m) and slow enough.
- **The chart** (M, or the map button) shows both cays, the reef, the gap, your boat and the wind. Tap "Sail to …" and she sails there by herself: through the gap in the reef, tacking if she must, then anchors. You can walk around the deck while she sails, or take the helm back at any time.
- **Pink Sand Cay:** a small island beyond the reef with pink beaches. It has its own finds: a netted olive and a rare flamingo tongue shell. Drift pumice can turn up on either island.
- **A wake** of white water behind you, and new sounds: water rushing past the hull, wind in the rigging, flapping sails, the anchor chain, a thud when you hit bottom.

**Checks that passed before sending**
- **147 automatic checks**, including new ones for:
  - the sailing rules: the no-go zone, the best point of sail, speed, turning, heel and leeway, rounding up when left alone, running aground and getting off, anchoring;
  - the autopilot: downwind, beating upwind by tacking, following waypoints;
  - Pink Sand Cay;
  - the passage through the reef gap (deep enough for the keel all the way) and the reef blocking you elsewhere;
  - island-only finds;
  - the moving sails, boom, rudder and anchor.
- **All 46 browser checks**, as a laptop and as a Pixel-sized phone, including new ones:
  - taking the helm, raising sail, steering and picking up speed (6.1 knots);
  - the chart and "Sail to Pink Sand Cay": through the reef gap, anchored 18 m from the anchorage with no scrapes;
  - finds on Pink Sand Cay;
  - running onto the reef scrapes the hull;
  - on the phone, taking the helm with the round button, "More sail", and steering with the thumb.
- **Drawing budgets** measured on the laptop: about 640,000 triangles looking from the boat, 350,000–375,000 ashore.

**Not tested, or known**
- How it feels to steer with your thumb, and whether the sailing feels right. Tell me if it's too slow, too fast, too twitchy, or confusing.
- Speed on your Pixel while sailing (more is drawn when both islands are in view).
- You can't build sandcastles on Pink Sand Cay yet; only Home Cay's cove has building sand.
- The hull condition is tracked but there's nothing to repair it with yet (that's v0.4).

## v0.2.2, Overboard fix
**What changed**
- **Jumping off the side works.** Before, jumping over the lifelines could leave you stuck against the side of the boat. Now you fly out clear of the hull and land in the sea. If you ever end up pressed against the boat, it eases you away, and swimming away from it always works.
- If you land on the narrow edge of the deck outside the lifelines, walking off it drops you into the sea.

**Checks that passed before sending**
- 107 automatic checks, including new ones: jumping off either side of the boat (also when it has swung round), and swimming away from the hull.
- All 38 browser checks, as a laptop and as a Pixel-sized phone, including a new one: jump over the side, land in the sea and swim away.

**Not tested**
- How it feels with your thumbs on the phone.

## v0.2.1, Play from a link
The same game as v0.2, now also playable from a private claude.ai link, so you don't have to download each version. Every new version replaces what's behind the same link; the downloadable files stay in `builds/` as before.

**What changed**
- "Are you sure?" questions (smoothing the sand, starting over) now appear as boxes inside the game. The link blocks the browser's own pop-ups.
- Inside the link, "Save to a file" and the photo button go through Claude's own save prompt. Saves made there come out as a small `.json` file, and "Load from a file" opens either kind.

**Inside the link, good to know**
- Your game saves itself in that browser as usual, but the link may not keep saves as reliably as the downloaded file. Use "Save to a file" now and then.
- The link keeps your saved game when it's updated to a new version.

**Checks that passed before sending**
- 103 automatic checks (one new: save files made inside the link open again).
- In the full browser run, 36 of 37 checks passed.
  - The one miss was the sand engine's speed check at simulated phone speed in backup mode: its busiest step took 24.6 ms against a 20 ms safety line. The real limit is 33 ms.
  - Run on its own three more times, it passed each time (12–19 ms).
  - It's a timing measurement that varies on this shared build machine, and no sand code has changed since v0.1.

**Not tested**
- The game inside the claude.ai link itself: the tests can only open the file directly. Please tell me if anything doesn't work there.

## v0.2, Aboard and ashore (Home Cay slice, part 1)
The game is now about living aboard your boat. You see the world through your own eyes, on the phone and on the laptop. This is the first piece of the Home Cay slice (see PLAN.md).

**What you can do**
- **Wake up aboard** your sloop at anchor off Home Cay. Walk the deck, step up onto the cabin top, look around. The boat rocks on the waves and you feel it.
- **Go ashore:** walk to the swim ladder at the back (stern) and climb down, or jump over the side. Swim, wade into the shallows and walk up the beach. Climb back aboard by the ladder.
- **Walk the island:** beaches on the south and west, rocky ironshore on the windward east, palms and sea-grape scrub, a low hill, a turquoise lagoon inside a reef.
- **Beachcomb:** every morning (5:30 am) the sea leaves new things along the high-tide line. There are 17 kinds:
  - shells: cowrie, calico scallop, sand dollar, bleeding tooth nerite, sunrise tellin, West Indian top shell;
  - sea glass in white, green, brown and a rare cobalt blue;
  - driftwood, a weathered plank, old rope, a coconut, a sea bean, a fishing float and a seabird feather.

  Pick them up into your basket (it holds 12). You see the basket in your hand with your finds in it.
- **Stow your finds** in the locker in the cockpit.
- **The logbook** keeps every kind you've found, with a true fact about each, and what's aboard.
- **Build sandcastles:** on the cove's sand, kneel down (B, or the round button) and you get the building camera and tools from v0.1. Stand up to walk on.
- **Day and night:** a day is about 24 minutes. There is golden light in the evening, stars and a moon at night, and the water glows where it's disturbed in the dark.

**The look**
- The sea and sky come from your raft game: see-through water that shows the sand and coral beneath, reflections, sun sparkle, foam where the water meets the beach and the hull, and drifting clouds.
- The new sloop, the finds and the basket are made in code at storybook-but-real quality.

**Checks that passed before sending**
- **102 automatic checks**, in four groups:
  - the 14 sand rules from v0.1;
  - island shape (the cove is unchanged), sea, clock, beachcombing, and walking, swimming and climbing the real boat's ladder;
  - the boat;
  - all 17 finds and the basket.
- **37 browser checks**, as a laptop and as a Pixel-sized phone. They cover:
  - starting aboard, looking and walking;
  - the ladder down and up, swimming ashore;
  - picking up with E and by tapping;
  - kneeling to build (dig, pile, pat, undo, camera), standing up;
  - emptying the basket into the locker, the logbook;
  - drawing budgets in three views, the in-game sand checks;
  - closing and reopening (everything comes back);
  - backup mode at 4× slower speed.
- **Drawing budgets** measured on the laptop: about 610,000 triangles looking from the boat, about 330,000–360,000 ashore.

**Not tested, or known**
- **Speed on your Pixel is not measured.** The phone draws about 450,000 triangles looking from the boat and about 570,000 in the cove. If it's not smooth, the game lowers its own graphics. Please open **Menu → Run the checks on this device** and tell me the "Smooth" number.
- How the thumb controls feel, and how it sounds, can only be judged by you.
- From the boat, a hole dug in a part of the beach you've built on looks filled in (the far-away stand-in). Up close it's right.
- Your v0.1 castles are kept, but you start aboard on day 1.
- Not yet: the dinghy, the shark, rations, repairs, gardening, sailing. They come in v0.3–v0.5.

## v0.1, The Calm Lagoon (stage 1, part 1)
The first playable piece: one beach, to feel whether building is fun.

**What you can do**
- **Dig:** drag on the sand to scoop it into your hands (up to 40 litres). Sand near the water is wet; a few centimetres down the beach is damp; the surface is sun-dried.
- **Pile:** drag to pour what you hold. Wet sand drains and holds its shape; dry sand slides into soft cones.
- **Pat:** tap to pack sand firm (packed damp sand stands tall and holds tunnels); rub to smooth it.
- **Small / medium / large** hands.
- **Undo**, a **photo** button, and a **frame the beach** button.
- Holes dug below sea level fill with water. The sun slowly dries the outside of what you build; dried edges crumble unless patted firm. The Menu lets you change the drying speed or turn it off.
- Your beach saves by itself (every minute and when you leave), and you can **save to a file / load from a file** from the Menu.

**The world**
A curved lagoon cove with rocky ends, palms and sea-grape bushes, distant islands, clouds, and your sailboat at anchor, rocking on the same waves you see. Sounds: lapping waves, breeze, distant gulls, rigging, and the sand itself (dig crunch, pour hiss, pats, trickles). All made in code.

**Checks that passed before sending**
- 14 sand-rule checks (cones at about 34°, damp heaps steeper, packed walls stand, dry walls slump, tunnels hold or cave in, overhang limits, nothing created or lost, exact undo, exact save/load, drying from the outside in, a gap-free surface, physics and surface speed).
- Browser tests as a laptop and as a Pixel-sized phone: loading, dig/pile/pat, two-finger camera without accidental digging, pinch zoom, trackpad swipe, saving and reopening, and backup mode (no background thread) at 4× slower speed.

**Not yet / known**
- No bucket, carving, water or drip yet (part 2).
- Speed on a real Pixel is not measured yet. The in-game Checks page measures it on the phone itself.
- A faint glassy patch can show in the water near the far rocks.
