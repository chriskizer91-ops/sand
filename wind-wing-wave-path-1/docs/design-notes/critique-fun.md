# Critique: combined island-maker design

## Verdict in brief

- The core idea is strong and deeper than most god games. You shape the land, life arrives by real routes, and the journal tells you why a species stayed or left. The first 60 seconds in the player-experience doc (touch the glow, lava breaks the surface, "Your island.") is the best part of the four designs. Keep it.
- The four documents are not one design yet. They disagree on the year pace (12× apart), the size of the world, which side the mainland is on, whether caves can exist, how often storms come, and how long a day lasts. Several game beats break once the numbers are put together. Section 1 must be settled before any build work starts.
- The biggest design risk is **delay between action and answer**, not missing features. Shaping happens in seconds, but life answers decades later, at random, often off screen. If those two halves are not joined on purpose, the player will feel the island ignoring them.
- The second risk is the **middle and late game**. Real island ecology slows down as it fills up (MacArthur–Wilson), so the game naturally gets less eventful over time. The chain and the hints have to be built to work against that.

---

## 1. Contradictions the lead must settle first

| Topic | Ecology | Player experience | Look & sound | Tech |
|---|---|---|---|---|
| Years per second | 3 | 1 | – | 0.25 |
| Zone size | "10 km" life scale | 1.6 km | 640 m | 1,024 m |
| Cloud-catch height | ~30 m (exaggerated climate height) | 120 m | 50 m | 60 m |
| Mainland side | east (upwind) | **west** | – | east |
| Caves, arches, overhangs | yes (cave species, lava tubes) | yes (Scoop carves sideways) | – | **no** (heightfield) |
| Storm spacing | great storm every 8–15 min | every 12–20 min, great every 3rd–4th | at most 1 per 28 min | every 4–7 min |
| Day length | 20 min | 24 min | 14 min | 14 min |
| Species | 111 | ~120 | – | ~45 |
| Closest camera | – | follow-cam implies close | 0.8 m | 12 m |
| Gap between cards | 20 s | 30 s | – | 2 s |
| Two-finger drag | – | orbit (as in Sandcastle) | – | pan |
| Time to the ending | full chain in 2–4 h | 6–10 h | – | – |

The player-experience doc puts the mainland in the west with the wind from the east. That breaks the whole stepping-stone and windward-flotsam logic. The mainland has to be upwind.

Some species appear only in the player-experience or look docs: kestrel, parrot, penguin, sea lion, bracken. Others appear only in the ecology catalogue. A "Cold Current" site promising penguins and sea lions has nothing behind it in the simulation. There must be one catalogue.

---

## 2. Where it would get boring or run out

### 2.1 The curve is front-loaded and then sags
- At 3 years per second, ʻōhiʻa forest forms in 1–2 minutes once it arrives, and lichen covers rock in 1–2 seconds. Arrivals are the only bottleneck, so play swings between dead waiting and sudden bursts that the 4-per-second pop queue cannot even show.
- At 0.25 years per second (tech), a reef needs about 4 hours to reach the surface, which is longer than most sessions.
- Under any pace, arrivals fall as the first island fills. Around minutes 25–45 the first island plateaus. That is exactly before the player-experience doc's mist reveal at 45–75 minutes. **This is the most likely place the owner puts the phone down.**

**Fix:** gate each new site's reveal on **saturation**, not on species count. When the first island's arrival rate drops below a threshold for about 3 minutes (or at 45 minutes, whichever comes first), the mist lifts. The near-miss stories should also start pointing outward ("too far from the mainland: an island to the east would help") during the plateau, so the slowdown itself becomes the hint for what to do next.

### 2.2 The second island repeats the first
If island 2 runs the same bare rock → lichen → moss → fern climb at the same speed, the chain becomes grind.

**Fixes:**
1. Use the ecology doc's in-zone sources properly. Every species already living on island 1 reaches island 2 several times faster, so a new island greens in about 8–10 minutes instead of 25. This is also true to life, and it pays the player back for island 1.
2. Each site must change the *mechanics*, not just the label:
   - Shallows: low sand building and a lagoon puzzle.
   - Windward Bank: cliffs and storm exposure.
   - Mainland Steps: weak dispersers only.
   - Far Reef: no predators, so few but special arrivals.

   Cut sites that are only flavour, such as Cold Current unless its species get built.

### 2.3 The late game turns into completion grind
- The full catalogue includes "almost never" arrivals: rafted frogs, storm vagrants and land birds at 0.05 attempts per century.
- The player-experience doc's hints are riddles.
- Together that means the last 10 species could take hours of guessing.

**Fixes:**
- A **per-species pity timer**: once a species' needs are met, it is guaranteed to arrive within N minutes (about 5 for common species, 15 for rare ones).
- **Escalating hints**: riddle → after one "Seen" visit, the plain need → after 20 more minutes, a direct line ("needs a salt pond on a low, dry cay").

A calm game should never leave the player stuck.

### 2.4 Watch mode shows the wrong thing
From the god view, trees past 160–450 m are only colour tint, so "watching trees pop up" needs a middle zoom.

**Fix:** the idle camera should drift *toward activity*: the edge where succession is advancing, a recent arrival, a colony at dusk. It should frame things at 60–120 m, where pops are visible. This is the owner's "sit and watch" mode and needs real direction, not a fixed orbit at 0.6° per second.

---

## 3. Where cause and effect would be invisible

### 3.1 The delay between shaping and answer
A beach poured now gets a turtle "two hundred years later". Even at 1 year per second that is about 3 minutes, and it is random. The player can't be sure the beach caused it.

**Fix: three guaranteed feedback beats.**
1. **Instant recognition (real time).** When the land settles, the island names what you made on the spot: a soft label and chime ("A sea cliff", "A sheltered lagoon", "A rock basin: it will hold rain"). The journal logs it. If a turned-away species is waiting for exactly this, add one line: "Something that circled here before may come back."
2. **Guaranteed return.** A species that "couldn't stay" comes back within 30–90 real seconds of its need being met, with a vignette near the camera if possible. This is the main payoff of the core loop and must not be left to random rates.
3. **Visible spread afterwards.** Its population grows on screen through the following minutes.

### 3.2 Hidden fields
Soil depth, N and P, moisture, salt, the freshwater lens, perch score and target effects are all invisible. The player can't tell why ferns won't come.

**Fixes:**
- **Look at the ground, not only at creatures.** Tapping land in Look gives one plain sentence: "Windward slope. Lava about 80 years old. Wet. Lichen and moss; soil still too thin for ferns."
- **Merge N and P into one "richness" value.** Two nutrients the player can never see add tuning work and no experience.

### 3.3 Invisible simulation loops
Cut or hide any loop that never produces something visible or audible.

**Keep**, because you can see or hear the result:
- guano whitening the cliff and greening the slope below
- fig → wasp → fruit → doves → more seedlings (show the figs ripening orange)
- reef → white sand (beaches visibly lighten)
- rain shadow (cloud cap, green and gold sides)
- storm logs as nurse logs (ferns appear beside the logs)

**Cut** or keep internal only:
- land crabs eating seedlings
- the pollinator ×0.3 spread gate (except figs)
- turtle sex by sand temperature
- the guano-to-reef-fish ×1.5 bonus, unless fish shoals visibly thicken

### 3.4 Journal-only species
The ecology catalogue has many "J" species: midges, termites, ants, brine shrimp, stream shrimp, pond snails, wēkiu bug.

**Rule:** every species needs a visible or audible sign, or a visible effect on another species. Brine shrimp can turn the salt pond pink-orange. Termites can make logs crumble. Otherwise cut the species. A list of names you can't see is the "shallow" feeling the owner is afraid of.

### 3.5 Ponds that never fill
- A player who scoops a basin on the dry lee side, or in sand, gets nothing and doesn't know why.
- Ponds should visibly fill during the next passing shower, and showers should be visible rain shafts.
- Look on a dry basin should say why: "The rain falls on the far side of your peak", or "Sand drains; a stone floor would hold water."

---

## 4. Where the player has no meaningful decisions

Unlimited material, undo, and a world that only grows make building **expressive, not strategic**. That suits a calm game, and no currencies should be added. But a few real tensions should be sharpened so choices matter:

1. **Wet or dry.** Where the peak sits relative to the wind decides which side becomes rainforest. You can't have both everywhere.
2. **Tall or flat.** A high forested island cannot also be the open, windy cay that albatross, sooty terns and monk seals need.
3. **Join or separate (new).** A sand spit lets lizards and monitors walk across. Separate islets stay predator-free seabird cities. This is a real, readable trade-off, and spits are something the owner will naturally build.
4. **Renew or keep.** Growing the island with lava burns mature life, but leaves fertile ground, kīpuka, warm ground and returning pioneers. **This only works if lava is the main way to add land mass.**
5. **Exposed or sheltered.** Headlands and reefs make lagoons, mangroves and storm shelter.
6. **Near or far.** Stepping stones toward the mainland, or a remote site for rare species.

**Tool redundancy kills decision 4.** The player-experience doc's Stone is instant, rigid, unlimited, holds any slope and burns nothing. Nobody would use lava after minute one. The owner was unsure here ("pour rock... or place rock, I don't know"), so the lead has to settle it:
- **Lava** is fast bulk land. It holds at most ~35°, burns what it covers, and becomes the richest soil.
- **Stone** is slow, uses a small brush only, is barren, and is for cliffs, sea stacks and pond rims.
- Anything that raises ground over plants buries them.

**Smoothing should not reset succession.** The ecology doc's `subAge` resets on any surface change. A player who keeps tidying the island would keep it bare forever without understanding why. Only changes larger than about 0.5 m, or a change of material, should reset life.

---

## 5. Rewards too fast or too slow

- **Cards.** A 2-second gap (tech) is spam, and 20 seconds is still busy. Use 30–45 seconds for headline cards, fold the rest into "3 more arrivals", and make "couldn't stay" stories fire on a species' *first* visit, at most one every 60–90 seconds. The ecology doc's one-per-3-minutes limit starves the core loop.
- **Storms.** Every 4–7 minutes (tech) will feel like nagging, and once per 28 minutes (look) is too rare for "a little drama". About every 12–18 minutes, with every third one great, is right. During a storm, fog must scale with camera distance. The look doc's 30 m fog start would hide the whole island from the god view, the one moment the player wants to watch.
- **Night and Moments.**
  - A 3-minute night (look and tech) cannot hold a 4-minute turtle nesting.
  - Hatchlings run at dawn in one doc and at dusk in another.
  - Coral spawning at full moon, with the moon "changing a little each night" on a 14-minute day, gives a full moon every ~7 real hours.
  - **Fix:** every Moment must fit its window (nesting starts at dusk, hatchlings at dawn), and the full moon comes every 4th night.
- **The ending.** 6–10 hours to the epilogue is too long for a phone game delivered as one file opened from Downloads, where storage may not persist. 2–4 hours only works at 3 years per second. Aim for about 4 hours of active play.

---

## 6. Things that would confuse the owner

- **Gestures.** The tech doc switches two-finger drag to *pan*. The owner learned *orbit* in Sandcastle Cays. In a 1 km world, panning is the more common need, so map-style gestures (drag pans, twist rotates, pinch zooms) are the right call. Tell the owner in one plain line rather than switching silently.
- **Brush size.** The tech doc's "size follows zoom" is clever but invisible: the same tool does different things at different zooms. Show the ring at all times, and keep three named sizes that scale with zoom.
- **Look needs the tools put away first.** That friction will make Look rarely used, yet it carries the legibility fixes in section 3. Make Look (an eye icon) the first tray item, and make it the default after watch mode.
- **Five journal tabs** (Story, Life, Places, Chart, Firsts) is a lot for a non-gamer. Use three: Story (with Firsts and Ages as stamps), Life & Places, and Chart.
- **Year on cards.** The tech doc says no year on toasts. The player-experience doc says yes. A small ink year stamp on a card that looks like a journal slip is "the journal speaking", not a ticking clock, and it is what makes years feel like they fly. Keep it.
- **Phone heat.** This game invites hour-long, screen-on watching sessions on a Pixel 7a, whose chip is known to run hot. Watch mode should cap at 30 fps and drop shadows.

---

## 7. The ten decisions the lead must make

1. **Pace.** Write tuning in real minutes and treat years as a label. *Recommend:* 1 year per second by default (Gentle 0.5, Brisk 3), with a written beat sheet as the contract:
   - first life by 1:30
   - first sea arrival and first "couldn't stay" by 5–8 min
   - first fix-and-return by ~10 min
   - first tree 12–18 min
   - first storm and raft 15–20 min
   - cloud cap, pond and ducks 20–35 min
   - plateau and mist lift 40–50 min

   Use real-world rates for journal facts, not as tuning targets.

2. **Scale and height tiers.** *Recommend:* the tech doc's 1,024 m zone with 2 m columns and 4 m patches. Climate uses three readable height tiers:
   - ~25 m: windward showers
   - ~60 m: cloud cap and rain shadow
   - ~120 m: the peak pokes above the clouds (alpine zone, silversword)

   Each tier is shown on screen by the cap cloud forming or breaking.

3. **Heightfield and caves.** *Recommend:* accept the heightfield, which is right for phone performance and sculpting speed. Generate caves by rule instead of carving them:
   - a sea cave where a ≥8 m windward sea cliff has faced surf for a century
   - a lava tube where a thick flow cooled on a slope

   Draw them as dark arch props. Cut freestanding arches. Sea stacks still work. Record this in DECISIONS.md and tell the owner plainly.

4. **Tool set.** *Recommend:* Lava, Sand, Stone, Smooth, Scoop, each with a clear job:
   - Lava: fast bulk, fertile, burns.
   - Stone: slow, small, vertical, barren.
   - Raising ground over plants buries them.
   - Small smoothing never resets life.

   Material is unlimited. Keep the "Careful hands" setting.

5. **The feedback contract.** *Recommend* these as hard, tested guarantees:
   - the Place is recognised on screen within 3 s of the land settling
   - a turned-away species returns within 30–90 s of its need being met
   - Look on any ground explains it in one sentence
   - each species' first visit always produces its "couldn't stay" story

6. **The species catalogue.** *Recommend:* one merged list of about 70 species (roughly 30 plants, 15 sea and shore birds, 10 land birds and animals, 10 sea life, a few insects and crabs). Every one has a visible or audible sign. The list is stored as data so it can grow later. Resolve the extras (penguin, sea lion, kestrel, parrot) on purpose. Seventy species fully shown makes a finished game; 111 half-shown does not.

7. **Chain structure.** *Recommend:*
   - The mainland is upwind (east).
   - Five sites in total, revealed by mist when the current island plateaus (or after ~45 min), at least 20 minutes apart.
   - Each site changes one mechanic.
   - New islands fill about 2× faster because of in-zone sources.
   - Spits are allowed and let predators cross.

8. **Storms.** *Recommend:*
   - The first comes 15–20 minutes in, after shrubs exist. Then every 12–18 minutes, with every third one great.
   - Each lasts about 2 minutes, with 30–60 seconds of warning.
   - The ecology clock holds during the storm. Losses are capped and visibly recover within about 2 minutes.
   - Every storm leaves something behind: wrack, a raft or a blown-in bird.
   - Fog scales with camera distance, flashes are photosensitivity-safe, and there is a Gentle setting but no "off".

9. **Day, night, moon and Moments.** *Recommend:*
   - a 16-minute day: about 9.5 minutes of daylight, 1.5-minute dusk and dawn, 4 minutes of night
   - a full moon every 4th night
   - every Moment fits its window
   - the wet/dry season mood lines up with storm season
   - watch mode capped at 30 fps for phone heat

10. **Length and ending.** *Recommend:*
    - The epilogue comes at about 4 hours of active play: whales in the enclosed Sound, with roughly 75% of the catalogue and 3 or more forested islands. Nothing is locked.
    - After that, "Begin a new sea".
    - Time pauses while the game is hidden (all four docs agree; keep it).
    - Add a hidden test pace so the owner and the checks can reach the ending in minutes.
    - Show the "keep a copy" nudge at each new age, because losing hours of island to phone storage is the one real heartbreak this game could cause.