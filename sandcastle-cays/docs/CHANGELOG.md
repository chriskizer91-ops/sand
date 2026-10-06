# What changed, version by version (plain language)

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
