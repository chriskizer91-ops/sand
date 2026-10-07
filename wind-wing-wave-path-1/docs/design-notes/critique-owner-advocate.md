# Owner's-advocate critique of the four designs

## Bottom line

Taken together, the four designs cover what the owner asked for: shaping with lava, sand and rock; life that arrives on its own; storms; a chain of islands; years shown only in a journal; and animals moving at real speed. The **player-experience** design follows the owner's words most closely. The **ecology** design gives the "deeper reward" real substance. The **look** design is the only one that takes "sculpt with your hands" literally.

The **technical** design is the one most likely to drift from the owner without anyone noticing. It runs years at a quarter of a year per second, removes the hands, makes rock rise from below instead of being poured or placed, schedules storms every 4–7 minutes, and makes caves and arches impossible even though the other three designs promise them. These problems can all be fixed, but they have to be settled before building starts. Below, the issues are ranked by how much they would bother the owner.

---

## 1. Where the designs contradict the owner

### 1.1 "Years a second": the technical design runs time 4× too slow (high)
The owner's words were "years a second type thing" and "years fly by on their own". The three designs set three different default speeds:

| Design | Default pace | One hour of play |
|---|---|---|
| Ecology | 3 years/s | ~10,800 years |
| Player experience | 1 year/s | ~3,600 years |
| Technical | **0.25 years/s** (one year every 4 seconds) | ~900 years |

The technical design's normal speed is the opposite of what the owner asked for, and its "swift" setting (0.5) is still under one year per second.
- **Recommendation:** default to **2–3 years per second** (the owner said "years", plural), with settings of 1 / 3 / 10.
- Use the ecology design's real-world rates. The journal's real-history comparisons (Krakatau, Surtsey, Rakata) only stay honest if simulated years roughly match real years.
- Tune the minute-by-minute pacing through arrival rates (the ecology design's approach), not by slowing the clock.

### 1.2 Years shown on screen outside the journal (medium)
The owner said "maybe you see years somewhere in a journal or something like that."
- The player-experience design puts "Year 212" on the arrival cards that slide across the main screen. That is a clock under another name.
- The technical design gets this right: toasts show the story line with no year, and the year appears only when you open the journal.
- The ecology design agrees with the technical one.
- **Recommendation:** arrival cards carry no year. The journal cover and its entries carry the years.

### 1.3 Too much drama (high)
The owner asked for "a little bit of drama: seasonal storms." Added up, the designs give far more than that:
- **Technical:** a storm every 60–110 eco-years, which it calculates as **every 4–7 minutes**, plus squalls every 1–3 minutes.
- **Ecology:** at its own 3 years/s, a drought every 600–1,500 years arrives **every 3–8 minutes**. On top of that come great storms every 8–15 minutes and a 10-minute storm season every 30–40 minutes.
- **Player experience:** a storm every 12–20 minutes, with a great storm every third or fourth one.
- **Look:** at most one storm per wet-season mood, which is about every 28 minutes.

A calm, serene game with an event every five minutes stops being calm. **Recommendation:**
- Set a single drama budget: no storm in the first ~15 minutes, then roughly one storm per wet season, about every 15–25 real minutes.
- Make every storm in the wet season; turn "great storm" into an occasional stronger version rather than a separate schedule.
- Droughts become rare and quiet: brown edges, plus a journal line like "the dry decades". No warning card.
- Drop the technical design's squalls every 1–3 minutes, or make them pure scenery: a passing shower with no announcement.

### 1.4 "Sculpt with your hands" and "pour rock / place rock" (high)
The owner's exact words: "sculpt with your hands, like you can pour sand or pour rock… lava and sand… lava has to cool to become rock. Or place rock."
- **Technical:** "Tools write columns directly; there are no particles and no 'hand'." Its Rock tool *rises from below with a rumble*, which is neither pouring nor placing.
- **Player experience:** Stone is "press to push up a boulder", which is also rising from below.
- **Look:** the only design with **cupped hands made in code** and **boulders that tumble down and settle**. It also offers a fallback (a glowing column) "if the hands don't playtest well".
- **Recommendation:**
  - Keep the code-made hands as the default way your hands appear on screen. They are the owner's own idea, so don't quietly fall back to a glowing column.
  - Make Rock literally **pour or place**: boulders tumble from the hands, lock where they land, and stack steeply. Holding still builds a pillar or cliff; dragging builds a wall. That satisfies both "pour rock" and "place rock" with one tool.
  - Name the smoothing tool **Hands** (the player-experience name), not "Smooth" (the technical name).

### 1.5 The sandcastle engine, and caves (high, and it must be told to the owner plainly)
The owner's first message said "I want to use the sandcastle game engine system."
- The technical design keeps that engine's backbone: the background thread with its fallback, the smooth-surface drawing, the one-file build, the sound engine, saving and the checks.
- It **replaces the 3 cm sand grid** with a map of columns. It has a measured reason: a 20 m pour took 8.3 minutes to settle.
- The cost is **no caves, arches or overhangs.**

The other two designs depend on those features:
- **Player experience:** Stone "can overhang", Scoop "can carve sideways into a cliff, so caves work", there is a Cave place, and there is a "first cave dweller" stamp.
- **Ecology:** a CAVE flag, a cave pathway, swiftlets, and "sea caves, lava tubes, arches".

If this isn't reconciled, the owner gets promises the game can't keep.

**Recommendation:** accept the column map for the first full version, which seems the right call for phone speed. Then:
- remove caves and arches from the life list, the Places page and the Firsts page;
- give swiftlets and bats a cave-free home, such as deep, narrow cliff crevices;
- record the trade-off in DECISIONS.md in plain words. For example: "We kept the sandcastle engine's foundations but changed how the ground is stored, because the 3 cm sand grid would take minutes to settle each pour at island size. The cost: no caves or arches yet."

The owner should hear this before the build, not find it in a changelog.

### 1.6 Locking parts of the zone behind mist (medium)
The owner said "one island that you can grow bigger and bigger and then chains of islands, like one zone, and you can pile the sand or the rock however."
- The player-experience design hides most of the zone under mist until the number of species reaches a threshold (45–75 minutes for the first reveal, five reveals in all). That is a level gate, and it limits "however".
- The technical design opens the whole zone from the start, with underwater knolls hinting at good places to build.
- **Recommendation:** open water everywhere from minute one. The ecology design already supplies the *reasons* to build a second island: near-miss stories such as "too far: try an island to the east" and "needs another island nearby", stepping stones, islet-only seabirds, and lagoons. If the mist is kept at all, it should be scenery that shows *where* something interesting waits, never a lock.

### 1.7 Tools that unlock on a timer (low–medium)
In the player-experience design, Sand arrives at about 2 minutes, Stone at about 3, and Hands and Scoop at about 5. The owner asked to pour sand and rock.
- Unlocking on a timer will feel like a demo's tutorial, or a bug, when the owner opens the file wanting to pour sand.
- **Recommendation:** start with Lava only for the first ~30 seconds ("Touch the glow" is lovely). The full tray appears when the first land cools. Introduce each tool with one line the first time it is chosen, not on a schedule.

### 1.8 Delivering in stages (medium)
The owner said "I don't want a demo, I want a game." The player-experience design proposes five stages, each sent to the owner as a playable file. The technical design proposes a performance-probe build at its first integration point.
- A shaping-only build is exactly a demo.
- **Recommendation:**
  - Do those stages internally, checked with the vitest and browser checks.
  - The first file the owner plays should contain the **whole loop**: shaping, life arriving, a storm, the journal, the chain and the ending, even if tuning continues afterwards.
  - The one acceptable early file is a **phone speed test**, labelled plainly as such ("this checks your Pixel can run it; it is not the game"), because real Pixel speed cannot be tested here.

---

## 2. What the owner asked for that is missing or thin

- **Trees popping up within the first session.** The owner pictures "watching trees pop up". First-tree timing varies: about 10–20 minutes in the player-experience design, forest at 150–350 years in the technical one (10–23 minutes at its own speed), and 1–2 minutes after arrival in the ecology design.
  - If the owner plays for 5 minutes and sees only grey rock and lichen, it will read as a demo.
  - **Targets:** first green within ~1 minute, a ballooning spider and a resting seabird within ~3 minutes, a coconut sprouting on any beach within ~3–5 minutes, the first real tree within ~8 minutes, and visible forest within ~15–20 minutes.
  - Beach plants arriving by sea really are fast, so this stays truthful.
- **"Life walking around" early on.** Most walking animals in the designs come late (tortoises, iguanas, turtles at 40–60 minutes). Make sure something walks in the first 10 minutes: ghost crabs on the first beach, a booby waddling on a ledge, a heron on a rocky shore. The ecology design's sea-drift crabs make this realistic.
- **A season you can see, if storms are "seasonal".** Neither the ecology nor the technical design shows a season on screen. The look design's **wet/dry mood** solves it:
  - the lee goes golden and the windward side stays green;
  - flowering pulses come in the wet mood;
  - storms happen only in the wet mood.

  Adopt it, and tie the storm schedule to it (see 1.3).
- **Lava cooling that you can see.** All designs have it, but the timings disagree:
  - ecology: crust in 3–5 s, black in 10–20 s;
  - player experience: about 8 s;
  - technical: 4–25 s depending on thickness;
  - look: its shader uses a 40 s cooling time.

  The owner needs one coherent "pour, watch it glow, crust, go black" rhythm. The display must follow the engine's real temperature, not a separate shader timer. That rhythm is about 3–5 s to crust and 10–20 s to black rock, longer for thick piles.
- **A clear "deeper reward" path that actually reaches the ending.** The player-experience ending (whales in a Sound enclosed by 3 or more islands) needs about 70 species. The technical catalog has only **45**, so the ending cannot be reached.
  - Many of the ecology design's 111 species need no 3D model: they show as journal-only, ground tint or sound. A catalog of 100 or more is therefore cheap.
  - Ship about 100 species as data, with roughly 14 plant models and 15 animal body shapes, varied by colour.
- **A wide enough area of the field guide is reachable on one island.** With the mist removed and the chain open (1.6), the owner can always pursue new species without waiting for a reveal.

---

## 3. Where the designs disagree: which serves the owner

| Topic | Options | Pick for the owner |
|---|---|---|
| Pace of years | 3 / 1 / 0.25 per second | **2–3 years/s** (1.1) |
| Year on screen | on cards / journal only | **Journal only** (technical, ecology) |
| Tool set | Lava, Stone, Sand, Hands, Scoop / Lava, Sand, Rock, Lower, Smooth | **Lava, Rock (poured or placed), Sand, Hands, Scoop**: the owner's verbs |
| Hands visual | look: cupped hands / technical: none | **Cupped hands** |
| Brush size | three sizes (player) / follows zoom (technical) | Both: three sizes that also **scale with zoom**. Explain as "zoom out for big land, zoom in for detail" |
| Camera gestures | **same as Sandcastle Cays** (player) / two-finger pan, twist to orbit, three-finger tilt (technical) | **Same as Sandcastle Cays.** The owner already knows them. Three-finger gestures are awkward on a phone and add a new thing to learn |
| Chain | gated by mist (player) / open zone (technical) | **Open zone**; story reasons to build more islands |
| Storm cadence | 4–7 / 8–15 / 12–20 / ~28 min | **About one per wet season, 15–25 min**, first after ~15 min |
| Storm "off" | none (player) | Agree: Gentle / Normal, no Off. The owner asked for drama, and storms carry life |
| Day length | 14 / 20 / 24 min | **About 14–16 min**, so a normal session sees dusk and night (bats, turtles, glowing lava) |
| Where life comes from | mainland **west** with wind from the **east** (player) / mainland or "old islands" **east**, upwind (ecology, technical) | **East, upwind.** The player-experience version sends wind-borne spores *away* from the island. Show a hazy silhouette on the eastern horizon as the story's source |
| Cloud-catching height | 120 m cloud line, 200 m cloud forest (player) / cap clouds above 50–60 m (look, technical) / height scaled up for the climate maths (ecology) | The technical design's build limit is **150 m**, so the player-experience cloud forest at 200 m is unbuildable. Use **cap clouds from about 50–60 m**, cloud forest from about 90 m, and the ecology design's scaling for the rain maths |
| Zone size | 10 km (ecology reckoning) / 1.6 km / 640 m / 1,024 m | **The technical design's 1 km.** The ecology design's tuning targets assume islands of about 1 km², so it needs a "reckoning scale" and retuning. That is an engineering detail; the owner never needs to see it |
| Phone budget | 400k triangles (look) / 600k plus 180k for shadows (technical) | **Target the look design's 400k on the Pixel**, with the technical 600k as a hard ceiling. Agents: the technical design's caps (about 120 on the phone) |
| Ecology model | per-species, 4 layers, 26 habitat bits (ecology) / 12 cover groups plus 4 plant slots per patch (technical) | **The technical design's structure** (it fits the renderer and saves), filled with the ecology design's species needs, arrival maths, near-miss stories and a chosen set of food-web loops (section 4) |
| Undo | last 10 strokes (player) / 20 records within 24 MB (technical) | Either works. **Undo must bring back the life a lava pour buried**, and all three designs that mention it agree |
| Ending | whales in the Sound (player) | Keep it. It turns a toy into a game with an arc, and play continues afterwards |

---

## 4. Too complex: for the owner, and for the build

### Things the owner should never need to understand
These terms from the ecology and technical designs should stay inside the code and docs: MacArthur–Wilson, Ghyben–Herzberg lens, priority flood, D8 flow, alias tables, Bingham yield, columns versus voxels, active sets, row-range uploads.

The owner-facing README and PLAN need only these lines:
1. You shape the land with lava, rock and sand.
2. Wind, sea and birds bring life on their own.
3. The shape decides who stays: tall peaks catch rain, cliffs bring seabirds, beaches bring turtles, rock hollows become ponds.
4. Storms come in the wet season and bring castaways.
5. The journal keeps the years and every story.
6. Build more islands to welcome life that can't reach one alone.

The **two clocks** idea is explainable and worth stating: "The island's history races; the animals don't."

### Hidden helpers worth one honest sentence each
- **The ecology design's pacing helper:** "If nothing has happened for a while, the game nudges along a visitor that could plausibly arrive."
- **Brush size scaling with zoom.**
- **Storm damage is never undoable:** "Storms are nature; undo is only for your own hands."

### Ecology mechanisms likely to sink the schedule without a visible payoff
Keep the food-web loops that produce a **story the player can see or read**:
- seabird droppings → Pisonia trees → noddies;
- fig → fig wasp → fruit doves and bats → more bird-brought seeds;
- nurse logs after storms;
- reef → parrotfish → beaches turning white over centuries (a lovely slow reward);
- stepping stones between islands;
- lava-ringed forest patches ("kīpuka") as a seed source;
- warm ground and megapodes.

Defer or simplify:
- separate nitrogen and phosphorus (use one "fertility" value);
- the freshwater-lens physics (use "wide sandy islands hold fresh water");
- pollinator gating for every plant;
- land crabs eating seedlings;
- the monitor-lizard predator rule.

The monitor rule creates a "pest" feeling the player-experience design deliberately excludes. If it stays, the journal must never sound alarmed: drop "the ground-nesters grow wary".

### The player-experience design's systems
Ages, Firsts, Moments, Places, the life list, "Seen" cards, the Chart and the Story are what make this a game rather than a demo, so keep them. But:
- give each one a single explanatory line the first time it appears;
- keep the settings list short and plainly named.

---

## 5. Things to keep exactly as designed (they serve the owner directly)

- **The life-arrival core loop:** a visitor arrives, can't stay, the journal says why in one kind line, you reshape the land, and the visitor returns with a story ("The turtle came back. She dug her nest in your new beach"). This is the deeper reward the owner asked for, and it needs no task list.
- **"Touch the glow"** first minute; first land breaking the surface with steam.
- **Plants popping up:** the look design's 1.5 s sprout, unfurl and settle (ferns uncurling, palm fronds opening like an umbrella), a pop queue so a hillside sprinkles gently, and same-species renewal staying invisible so trees never shuffle.
- **Animals at real speed** standing in for whole populations, leaving off-screen rather than dying on screen; the Follow camera; watch mode with the UI fading and the camera slowly drifting. Turn watch mode **on by default**, because it is the owner's "watching trees pop up".
- **The soundscape as the scoreboard you hear:** wind only at the start, a full chorus by the end, all made in code.
- **Storms with a silver lining:** rafts bringing lizards, a rainbow, seedlings filling the gaps, a cap on how much life one storm can remove, and rock never changing.
- **No life-placing API** (ecology check #10), no weather control, no currencies, timers or failure states.
- **Save safety:** load into a temporary world and swap only on success; save-to-file always works; the backup nudge at each new age. Losing hours of an island is the one real heartbreak this game can cause.

---

## 6. Rules check

- **No image or sound files:** all four designs comply. Journal sketches are drawn live from the 3D models, icons are SVG made in code, and the baked sound loops are synthesized at startup. The photo button saves a picture the player takes, which Sandcastle Cays already does, so that is fine.
- **One HTML file, opened from Downloads:** all comply. Keep the page fallback for a refused background thread, the in-game checks page with the fps sample on the owner's own Pixel, and the plain "what we couldn't test" note (real phone speed, phone storage when the file is opened from Downloads, how the gestures feel).
- **Own folder:** the technical design's `isles/` is fine. The game's display name stays in one constant. The storage id must stay separate from Sandcastle Cays so the two games' saves never collide.
- **Talk first, build second:** the owner has effectively said go ("complete this game from start to finish"). Don't block on the player-experience design's seven questions. Build with the defaults above, record them in DECISIONS.md, and list the few real choices in the delivery note so the owner can change them:
  1. pace of years;
  2. whether lava can burn forests (with undo and "Careful hands");
  3. storms Gentle or Normal by default;
  4. the name.

  For the name, offer three: **Wind, Wing & Wave**, **Lava & Lichen**, **Cradle Cays**. Drop **Landfall**, because a game studio already uses that name.