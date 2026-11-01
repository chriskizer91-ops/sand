# What changed, version by version (plain language)

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
