# What changed, version by version (plain language)

## v0.4.1, Never stuck aground (and dev tools)
**What changed**
- **You can't get stuck aground any more.** Before, if the boat ended up in water shallower than her keel (for example by turning while touching bottom, or swinging at anchor onto a shallow patch), she couldn't move in any direction. Now:
  - when she's aground, she can always move toward deeper water, slowly, as if dragging over the bottom. Motor astern, or steer and motor for deeper water;
  - she can't drive further onto the shallows, and turning can't swing her keel further into the bottom;
  - at anchor, she swings with the wind but never onto the shallows;
  - **Push off:** while she's aground, the "Drop anchor" button becomes "Push off" (X on the laptop). You push her off into the nearest water deep enough, turned away from the shallows. It always works.
  - If you're stuck for a few seconds, a card tells you how to get off.
- **Dev tools**, for trying things out: press **T** on the laptop, or Menu → "Dev tools" on the phone. It shows:
  - the frame rate and how much is drawn;
  - where you and the boat are, her speed, heel, sails, motor and hull;
  - the wind, rain and squalls, the clock and the sea buoy record.

  It has buttons to:
  - move the boat (with you aboard) to Home Cay, Pink Sand Cay, the reef gap, the open sea or the sea buoy;
  - push off, mend the hull, or stop her;
  - call up a squall right here or one coming from the east, or switch squalls off;
  - set light, normal or strong wind;
  - set dawn, noon, sunset, night or the next morning (new finds), and stop or start the clock;
  - run the game at ×1, ×2 or ×4;
  - show the frame rate on screen.

  The game keeps running while it's open.

**Checks before sending**
CHECKS_PLACEHOLDER

**Not tested**
- Whatever got you stuck: I couldn't see exactly where you were, so I fixed every way I found of getting stuck. If it happens again, open the dev tools (T) and tell me the boat's position from the readout.

## v0.4, Blue water
Sailing is now the main event. Out past the reefs is the open sea, with more wind and bigger waves, and squalls drift across it that you can sail into.

**What's new**
- **Faster sailing, a stronger motor.**
  - She now sails at about 8 knots with the wind on the side, and 10 or more out on the open sea.
  - The outboard is stronger (about 5 knots, and it gets her moving within seconds), but sailing is always much faster.
- **The open sea**, once you're well past the reefs:
  - the wind is half as strong again (about 19 knots instead of 13) and gusts harder;
  - a long ocean swell rolls in from the east and the boat rides up and over it;
  - whitecaps on the water, and spray over the bow (with a slap) when she drives into a wave;
  - with the wind behind you, a wave can pick her up and **surf** her down its face, at 12 knots or more. The dial says "surfing!".
  - A card tells you when you first reach it.
- **Too much sail in a strong wind:** she leans hard, slows, and turns herself up into the wind. The dial says "overpowered". Take in sail ("Less sail", or S) or steer away from the wind. Half sail is faster and steadier in a blow.
- **Squalls**: dark clouds with grey rain hanging under them.
  - They drift west across the sea, about one every few minutes, and you can see them coming from a long way off.
  - Sail into one for a burst of wind (up to about 30 knots) that shifts as you pass through, with rain, dark rough water and the light closing in. It passes in a minute or two.
  - You get a warning when one is heading your way. Inside the reef they're much gentler.
  - The chart shows them as grey patches.
- **The sea buoy**: a red-and-white buoy out on the open sea to the south-east, with a light that flashes at night.
  - Sail out round it and back to anchor at Home Cay, and the logbook keeps your best time.
  - It's a close-hauled beat out and a downwind run, surfing, home.
  - "Round the sea buoy and come home" on the chart lets her sail it herself.
- **The chart** now shows all the water you can sail, out to about a kilometre, with the open sea a deeper blue.
- **Sounds**: rain, a strong wind's moan, the bow slapping into waves, and the rush of surfing.
- The view leans with the boat a little less when she heels hard.

**Checks before sending**
- **181 automatic checks** passed, including 23 new ones:
  - the open sea: it's sheltered at both anchorages and between the cays and opens up beyond the reefs, and the wind is about half as strong again out there;
  - squalls: at most four at a time, drifting west, growing and fading; under one there's strong wind, rain and a wind shift, and they're milder inside the reef;
  - the motor gets her moving within seconds, and sailing on a reach is much faster than motoring;
  - with full sail in a squall she's overpowered and turns up into the wind, while half sail keeps her steady and faster;
  - surfing down a wave takes her past 11 knots;
  - the autopilot reefs in strong wind;
  - the squall, rain and spray drawing stays within its budget (3 draw calls).
- **Browser checks, as a laptop and as a Pixel-sized phone: 51 of 52 passed**, including 4 new ones:
  - open sea: 18 knots of wind instead of 11 at home, waves 1.7 m instead of 0.2 m;
  - surfing: up to 12.4 knots;
  - in a squall: 24 knots and rain; full sail overpowers her, half sail doesn't;
  - "Round the sea buoy and come home": she rounded it and anchored 8 m from the spot at home with the hull untouched, in 11 min 28 s, and the time went in the logbook.
- **The one miss** was the sand engine's speed check at simulated phone speed in backup mode: its busiest step took 23.2 ms against a 20 ms safety line (the real limit is 33 ms). This shared build machine was busy today. Run back to back three times each, the old v0.3.1 took 19–28 ms and v0.4 took 18–22 ms, so it isn't the new version. No sand code changed.
- **Drawing budgets** measured on the laptop are the same as v0.3: about 640,000 triangles looking from the boat, 350,000–375,000 ashore.

**Not tested, or known**
- How the open sea and squalls feel to sail, and whether they're exciting enough (or too much). Tell me.
- Speed on your Pixel out on the open sea and inside a squall (the test browser has no real graphics chip).
- Inside a squall, a hill more than 30 m away gets a little more rain haze than it should.
- Sails don't get damaged yet; sail repairs could come with the upkeep in v0.5.

## v0.3.1, A little outboard (and a polish pass)
**What changed**
- **A small outboard motor** on the stern, for when the wind isn't helping: getting out of an anchorage, through the reef gap, or out of irons.
  - At the helm: R for more motor, F for less (or the two "Motor" buttons on the phone).
  - Six steps: full astern, slow astern, off, slow ahead, half ahead, full ahead. Flat out ahead is about 4.5 knots; astern is slow.
  - You can steer with it even when you're barely moving. Going astern, the steering is reversed, as on a real boat.
  - Starting it raises the anchor for you. Dropping the anchor or letting go of the tiller stops it.
  - You can see it: it tilts down into the water when it runs and back up when it stops, with a spinning propeller. It putters, too.
  - "Sail to …" uses it as well: to motor the last bit into the anchorage, to go a short way straight into the wind, and to get unstuck.
- **Navigation lights:** a white masthead light at anchor; red, green and a white stern light when you're under way. They glow at night.
- **Polish:**
  - finds on the beach catch the sun with a little sparkle, so they're easier to spot from a distance;
  - the basket is out of your hand while you're steering;
  - a tip if you sit "in irons" (pointing into the wind) for a while;
  - the chart draws a dashed line showing the way she's sailing herself;
  - warmer light at sunrise and sunset;
  - tip cards no longer cover the wind dial;
  - the helm buttons are tidier (the chart is on the top bar).
  - a fix: the chart's "Sail to …" buttons were being rebuilt several times a second, which could swallow a tap. Now they only change when they need to.

**Checks before sending**
- **158 automatic checks**, including 11 new ones:
  - the motor: pushing her into the wind, steering at low speed, going astern with reversed steering, getting off when aground, the anchor stopping it, and "Sail to …" motoring a short way upwind and anchoring;
  - the motor model: tilted up out of the water when off, down with the propeller under water when running, tilting gradually, the propeller spinning, and clearing the rudder and ladder;
  - the navigation lights.
- **Browser checks, as a laptop and as a Pixel-sized phone: 47 of 48 passed** in the full run, including 2 new ones:
  - R and F on the laptop: 2.9 knots ahead under motor, then 2.0 knots astern;
  - the "Motor ahead" button on the phone.

  "Sail to Pink Sand Cay" still works: she anchored 3 m from the anchorage with the hull untouched.
- **The one miss** was the sand engine's speed check at simulated phone speed in backup mode: its busiest step took 21.5 ms against a 20 ms safety line (the real limit is 33 ms). Run on its own three more times, it passed each time (12–19 ms). It's a timing measurement that varies on this shared build machine, and no sand code has changed.
- **Drawing budgets** measured on the laptop: about 640,000 triangles looking from the boat, 350,000–375,000 ashore (the same as v0.3).

**Not tested, or known**
- How the motor feels with your thumbs, and whether it's too strong or too weak. Tell me.
- How the lights look on your Pixel at night (the test browser has no real graphics chip).
- There's no fuel yet; it could join the rations in v0.4.

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
