# Island maker: player experience design

*Working title for now. Names are in section 12.*

---

## 0. The whole game in a few sentences

You make an island. Life finds it on its own, the way it really reaches islands: on the wind, on the sea and on wings. With your hands you pour lava, which cools into rock. You also pour sand, set stone, smooth the land and scoop it away. While you work, centuries pass at about a year a second. You only see the year in a small field journal. Ferns unfurl, palms pop up and seabirds settle on the cliffs you built. A turtle swims to your rocky shore, finds no sand and leaves, and the journal says why. You pour a beach. Two hundred years later she comes back and nests.

The shape of the land decides who stays. A tall peak catches clouds, so rainforest grows on the windward side (the side the wind blows onto) and dry scrub grows on the lee side (the sheltered side). A cliff brings nesting seabirds. A hollow in solid rock fills with rain and becomes a pond. A calm lagoon grows a reef. Storms come now and then. They are a little dramatic, never cruel, and they bring castaways: lizards on driftwood rafts, seeds and birds blown off course.

One island grows. Then the mist lifts and the sea floor warms elsewhere, so a chain of islands grows. The game builds to a quiet ending, when whales come to raise their calves in the sheltered water your islands enclose. After that you can keep playing as long as you like.

---

## 1. Design pillars

Every feature should serve at least one of these. Anything that fights one of them gets cut.

1. **Your hands shape the land; the world decides the life.** You never place a plant or an animal and never control the weather. What you shape changes the odds, and the world answers.
2. **Two clocks.** Land, life and history run fast, about a year a second. Animals, waves and your own pouring run at real, calm speed. You see the centuries in what has changed, never on a ticking clock.
3. **Every shape asks a question, and the island answers it.** "If I build a cliff, who comes?" The answer always arrives, sometimes as an animal that visits and leaves, with a reason.
4. **Nothing is lost for good.** There are no fail states, timers, currencies or bars to fill. A species you have found stays in your field guide forever, even if it leaves your island.
5. **Quiet screen, plain words.** One short sentence at a time. No numbers on screen except years in the journal. The island is the interface.

---

## 2. Time: the two clocks

### What the player experiences
- **Island time** covers plants, soil, arrivals, populations, ages and storms. It runs at **about 1 year per second** by default (the owner's "years a second"). The settings offer Slow (1 year every 3 s), Steady (1 a second, the default) and Swift (3 a second). There is no speed button on the main screen.
- **Hand time** covers lava flowing and cooling, sand sliding, waves, wind and the animals walking, flying and swimming. It is real time. A crab takes three seconds to cross a rock. Fresh lava glows, crusts and turns black over about 8 seconds.
- **The sky keeps its own slow clock.** Years go too fast to show real seasons or days, so the sky shows one gentle "representative" day of about 24 real minutes: 16 minutes of daylight, 2 of golden dusk, 4 of night and 2 of dawn. Night matters because some life only shows itself then: frogs, fireflies, turtles nesting, bats, glowing water. The moon changes a little each night, which matters for one rare event (coral spawning).

### Where years appear
- On **arrival cards** ("Year 212").
- In the **journal**: on every entry, and on the cover ("Year 3,412 since your first stone").
- Nowhere else. There is no clock, counter or calendar on the main screen.

### When time stops
- **Journal or menu open:** time pauses, so reading never makes you miss anything.
- **Game closed:** time pauses. Nothing is lost by being away, and there is no reason to feel you must check in.
- **While building:** time keeps flowing. Ground you touched in the last 10 seconds counts as fresh, and life leaves it alone until it settles, so seedlings never pop up under your finger.

### How "years" feel
Ecology is tuned so that in the first hour a lot changes in a few minutes: bare rock, then lichen, moss, ferns, grass, shrubs and forest within about 15 to 25 minutes on good ground. Later the island is mature and changes are rarer and grander: a new colony, a gap in the forest after a storm filling with new trees. The year numbers grow into the thousands, which feels deep and earned ("Year 9,880: the albatross came").

---

## 3. Your hands: the shaping tools

### 3.1 The tool set (five tools)

| Tool | What it does | How it behaves | Typical use |
|---|---|---|---|
| **Lava** | Hold to pour molten rock from above. A glowing ribbon falls from the sky to your fingertip. | Flows downhill like thick honey, spreads, then crusts and cools into black rock in about 8 s. In the sea it bursts into steam, cools at once into lumpy rock and pushes the coast out. Hold still and it piles into a cone; drag and it spreads into a lava field. Holds slopes up to about 35°. | The big builder: raising islands from the sea and building peaks. The first thing you ever do. |
| **Stone** | Press to push up a boulder, drag to raise a ridge. Ready at once; nothing to wait for. | Stays exactly where you put it. Can be vertical and can overhang. Never slides or cools. | Cliffs, sea stacks (pillars of rock standing in the sea), arches, headlands, breakwaters, the rim of a pond. |
| **Sand** | Hold to pour a stream of sand. | Uses the sandcastle engine as it is: dry sand slides into ~34° cones; wet sand near the sea holds steeper. Under water it spreads into shallow banks. Colour matches its surroundings: black near lava coasts, white near reefs, gold elsewhere. | Beaches, dunes, sandbars, shallow lagoons, the spits that join islands. |
| **Hands** | Drag to smooth; press and hold to flatten to the height where you started. | Softens bumps and evens out slopes. On sand it also packs the sand firm, like Pat in the sandcastle game. Gentle on rock: slow, like weathering. | Shaping turtle beaches, terraces, the floor of a pond, tidy coastlines. |
| **Scoop** | Drag to carve land away; hold to go deeper. | Fast on sand, slow on rock. Can carve sideways into a cliff, so caves and overhangs work. Below sea level it digs channels and bays. What you scoop goes back to the sea; nothing piles up in your hand. | Bays, harbours, ponds, crater lakes, channels between islands, caves, waterfall notches. |

Plus **Undo**, always on screen (see 3.5), and **Look**. Tap the active tool again to put your hands away; then tapping identifies a plant or animal (section 4.6).

There is no water tool. **Rain fills ponds**, and the island's own weather does it. A hollow above sea level on rock fills with rain and becomes a pond. On sand it drains away, as it does in the real world. You learn this naturally, the journal points it out once, and it becomes a satisfying little puzzle: "my pond needs a stone floor".

### 3.2 Brush sizes
There are three sizes on a single button that cycles through them, sized in game metres for an island scale where one engine cell is about 1 metre:
- **Pinch** (about 3 m across): sea stacks, cave mouths, waterfall notches, a turtle beach's slope.
- **Handful** (about 10 m): most building.
- **Armful** (about 30 m): raising whole headlands, peaks and lagoons.

How fast things build: with Armful, Lava raises a 60 m-wide island above the sea in about 30 seconds and a 150 m peak in a few minutes of patient pouring. That is fast enough to feel powerful and slow enough to feel like sculpting rather than stamping.

### 3.3 How it feels on phone and on trackpad

| | Pixel 7a (touch) | Laptop (trackpad) |
|---|---|---|
| Use the tool | one finger: hold to pour, drag to pour along a path | click and hold / drag |
| Swing the camera | two fingers drag | two-finger swipe |
| Zoom | pinch (all the way out shows the whole chain) | pinch, or mouse wheel |
| Glide to a spot | quick two-finger tap | right-click |
| Look / identify | put tools away, then tap | same, or hold Space |
| Tools / size | tray at the bottom / size dot | keys 1-5 / [ and ] |
| Undo | ↶ button | Ctrl+Z |
| Journal | book button | J |

These are the same gestures as Sandcastle Cays, on purpose. The rule from that game, that a stroke is undone if a second finger lands, carries over, so camera moves never leave marks.

**Feel touches:**
- The pour stream is always visible from sky to fingertip, so you can see where material is going even with your finger in the way. A brush ring on the ground is coloured by tool: ember orange, stone grey, sand gold, soft white for Hands, sea blue for Scoop.
- **Haptics on the Pixel:** a low, rolling buzz while lava pours; a single thunk when a stone sets; a tiny tick for sand; nothing for Hands. All can be turned off.
- Lava makes the best sounds: a deep rumble while pouring, a hiss and a burst of steam where it meets the sea, then a quiet tick-crackle as it cools. Cooling lava is satisfying to watch and gives the hands a natural rhythm: pour, wait, pour.
- Animals notice your hands. Birds lift off when you work near them and come back when you stop, and crabs duck into burrows. This keeps life feeling alive and shows the player that the animals are real things, not decoration.

### 3.4 Materials, and what life thinks of them

| Ground | Looks like | Life's view |
|---|---|---|
| **Fresh lava rock** | glassy black, warm at first | Sterile for a few decades. Then lichens, then moss in the cracks. Over centuries it **weathers into the richest soil in the game** (red-brown). Forests grow best on old lava. |
| **Stone** | grey, crisp ledges | Weathers slowly and makes thin soil. It is the land of **cliffs, ledges and caves** and the only ground that holds a pond. |
| **Sand** | gold, white or black | Few nutrients, drains fast. Beach and dune life, crabs, turtles, coconuts. Roots slowly bind it. |
| **Soil** *(not a tool; life makes it)* | brown, darker with age | Builds from lichen, moss, fallen leaves, **seabird droppings** (guano) and weathering. Without soil there are no shrubs or trees. |
| **Reef** *(not a tool; life makes it)* | living colour under clear water | Grows by itself in warm, calm, shallow water and creeps up toward the surface. Parrotfish grind coral into **white sand**, so a reef slowly whitens your beaches, and very late it can even build a tiny sand islet on its own. |

The ground's colour is the main progress display. Grey turns speckled with lichen, then velvety green with moss, then brown with soil, then green in many shades. You can read an island's age from across the sea.

### 3.5 How shaping touches life
- **Sand over plants** buries small ones such as moss and grasses. Trees half buried stand on. **Beach grasses like a little burial**, as real dune grasses do, so a beach you keep topping up stays grassy.
- **Lava over life burns it.** Plants go up in a soft puff of smoke and fade. Animals always move away calmly before the lava reaches them; no animal ever dies on screen. The journal treats it as renewal: *"Year 3,104: You sent fire through the old fig grove. The ground will remember it as rich soil."*
- **Stone, Hands and Scoop:** plants ride along on small changes and are removed by big ones.
- **Undo** reaches back over your last 10 strokes and restores the land *and the life those strokes touched*, so an accidental lava splash over a forest is never a heartbreak. Beyond that window, things just are.
- **Careful hands** (a setting, off by default): tools flow around established plants and animals instead of over them, for players who never want to harm anything.

### 3.6 What life does back to the land
Shaping goes both ways, and the player should feel it:
- **Roots hold sand.** A grassy dune keeps steeper slopes and survives storms; a bare one is pulled down by the waves. (This plugs straight into the sandcastle engine's stickiness: plants add to it.)
- **Seabirds whiten their cliffs** and feed the soil downwind, so a colony makes the slope behind it bloom.
- **Mangroves trap sediment** and very slowly extend calm shores.
- **Reefs make white sand** and calm the water behind them.
- **Fallen trees after storms** become logs that lizards and beetles use.

---

## 4. How life arrives (the heart of the game)

### 4.1 Three roads, plus storms

| Road | What really arrives this way | How it looks and sounds |
|---|---|---|
| **Wind** | Lichen and moss spores, fern spores, orchid seeds (fine as dust), tiny insects, **ballooning spiders** (baby spiders that float on silk threads) | A shimmer of motes on the breeze; a silver thread catching the light; an airy, flute-like chime |
| **Sea** | Coconuts, beach morning glory, sea grape, pandanus and mangrove seeds; coral larvae; turtles; crabs; **lizards rafting on driftwood** | Something bobbing in the surf and rolling onto sand; a low wooden marimba note under the waves |
| **Wings** | Seabirds, then **seeds in their bellies** (figs) or **in mud on their feet** (pond plants and snail eggs, which Darwin proved by growing 82 plants from a few spoonfuls of pond mud) | A bird circling, landing and settling; a two-note bird-like chime |
| **Storms** *(see section 7)* | Castaways: rafts of tangled branches carrying lizards, snails and beetles; birds blown off course; butterflies | Comes with the storm's aftermath |

Every arrival comes from somewhere. Most life drifts in from **the mainland**, a soft blue silhouette on the far western horizon of the zone. The trade wind (the steady wind that always blows one way in the tropics) blows from the east.

Two real-world rules from the study of island life quietly run things:
- **Closer and bigger islands get more arrivals.** Islands nearer the mainland, or near other islands, get more visitors. Big, tall islands are easier to find.
- **Weak travellers need stepping stones.** Frogs, land snails, tortoises and some lizards rarely cross open sea. A chain of islands leading toward the mainland lets them come. This is what makes building a chain matter (section 8).

### 4.2 Arriving is not the same as staying
Every arrival checks whether the island suits it, and that check is the game's main teacher:
- **It stays:** an arrival card with a chime (section 6.1). The species joins your life list.
- **It visits and leaves:** a quieter "Seen" card with no chime and one plain sentence of why:
  - *"Year 290: A green turtle came looking for a beach. Your shore is all rock."*
  - *"Year 610: A booby circled your island looking for a high ledge, and flew on."*
  - *"Year 1,140: Ducks rested on the sea nearby. There is no fresh water here yet."*
- **It comes back:** once you've fixed the reason, that species is much more likely to return soon. When it does, the card says so: *"Year 455: The turtle came back. She dug her nest in your new beach."*

**Notice, then shape, then the visitor returns with a story.** That is the core loop. It gives the player real goals without a single task list.

### 4.3 What your shape decides
The island constantly reads its own shape and works out these things. All of them come from your land; you never set them directly.
- **Height:** a peak above the cloud line (about 120 game metres) **catches the trade-wind clouds**. You see clouds actually pile against your peak and rain fall on the windward side. Everything changes: rainforest on the windward side, dry scrub in the lee. Above about 200 m the peak sits in mist and grows **cloud forest**. Seeing your mountain grab its first cloud is a big "aha" in the first hour.
- **Wetness:** rain (windward, under the clouds), ponds and streams.
- **Salt:** near the sea and on the windward shore, spray stunts plants. Salt-loving beach plants thrive there and forest stays back.
- **Steepness:** gentle slopes for beaches and soil; steep faces of 10 m or more facing the sea for cliffs and nesting ledges.
- **Shelter:** calm water behind headlands or reefs is where reefs, seagrass and mangroves grow.
- **Distance:** how far it is to the mainland and to your other islands.
- **What already lives there:** fruit trees bring fruit-eating birds, which bring more seeds. Insects bring lizards; lizards bring kestrels. Figs need fig wasps before they fruit (a true story, and a lovely journal entry). **Seabirds prefer islands with no lizards or other egg-eaters**, so a small separate islet can become a seabird city.

### 4.4 Life moves in steps
Life moves in steps, and soil has to build first:

**bare rock → lichen → moss → ferns → grasses and herbs → shrubs → forest** (on rock and lava)
**bare sand → beach vines and grasses → beach shrubs and palms → coastal forest** (on sand)

Each step needs a little more soil and moisture than the last. Rough timings at the default pace, all to be tuned:
- Lichen on new lava after about 20 to 60 years.
- Moss after about 100.
- Ferns after about 200.
- Shrubs after about 400.
- First real forest after about 700 to 1,000 years.

That is roughly 12 to 17 real minutes on good ground. Beach plants come much faster, within decades, because seeds float in.

### 4.5 How plants "pop"
The owner asked for trees to pop up without slow growth. The approach:
- Plants grow in **3 or 4 visible stages** (sprout, young, grown, old). Each change is a quick, springy 1.5-second animation: the plant swells with a soft overshoot and settles, like a breath.
- Each kind has its own flourish. **Ferns unfurl from a curled fiddlehead. Palm fronds fan open. Trees rise and their crowns bloom open. Flowers open their petals.** A few green motes drift up.
- A tiny soft **woody tick** sounds, pitched to the plant's size and tuned to a calm five-note scale. When many plants grow at once it sounds like light rain on a marimba (Townscaper's trick). Sounds are thinned out when too many happen together.
- **Dying is gentle too.** Old plants brown, sink and become leaf litter, which darkens the soil. Fallen trees become logs.
- In the first hour, pops are lively, like popcorn: the island is filling. Later they become occasional events: a gap filling after a storm, a new grove spreading.

### 4.6 Animals at a real, calm pace
- All animals move at their **natural, real-world speed**. Crabs scuttle sideways and pause. Lizards dart, stop and bask. Turtles row slowly through seagrass. Boobies dive and splash. Frigatebirds hang motionless on the wind. Butterflies wander. Dragonflies hover over ponds. Fireflies blink in step at night.
- Individual animals **don't age**. Each one stands for its population. When a population grows, more animals are visible: birds fly in from offscreen and crabs pop out of burrows. When it shrinks, they leave the same quiet way. You never see a death.
- **Look:** with your tools put away, tap any creature or plant to see its name and one line ("Brown booby: nesting on your north cliff since Year 812").
- **Follow:** in Look, tap and hold a creature and the camera drifts after it, like a nature documentary, until you touch the screen. Following a turtle along the reef or a frigatebird over the peak is the serene heart of the game.
- **Phone budget:** about 150 moving animals near the camera at most. Distant flocks and colonies are drawn more cheaply.

---

## 5. The player's journey

### 5.1 The first 60 seconds
| Time | What happens | The player's hands |
|---|---|---|
| 0-5 s | The screen fades in to a dawn ocean, only sea and wind. The game's name appears softly and fades. | nothing |
| 5-10 s | An orange glow pulses beneath the water. Three words: **"Touch the glow."** | finger goes to the glow |
| 10-30 s | Holding: rumble and a gentle buzz, bubbles and steam. Lava spreads, glowing, on the sea floor (seen through the water), then **breaks the surface** with a hiss and a burst of steam. A low chime: the first land. | holding, maybe dragging |
| 30-45 s | Finger lifts. The lava crusts and cracks, then cools to black with tiny ticks. **"Your island."** The tool tray slides up with only Lava in it. | pouring more and watching it cool |
| 45-90 s | **"Keep building, or just watch."** The island keeps growing. A faint shimmer drifts in on the wind. | building |
| ~90 s | First card: *"Year 41. The first life: lichen, blown here as dust on the wind."* Grey-green speckles bloom across the oldest rock. The journal button appears with a soft glow. | taps the card or carries on |

In 90 seconds the player has felt the magic of making land, the rhythm of pour and cool, and the promise that life will come.

### 5.2 The first 10 minutes: "I'm being answered"
- **About 2 min:** the waves start grinding your shore. **Sand** joins the tray: *"Waves are breaking your rock into sand. Pour some to make a beach."*
- **About 3 min:** **Stone** joins: *"Set stone where you want land to stand tall."* Cliffs become possible.
- **About 4 min:** the first animal, a **ballooning spider** glinting on its silk thread. The card: *"Year 190. A tiny spider, floating on a silk thread. On Krakatoa, after the great eruption, a spider was the first animal found too."*
- **About 5 min:** **Hands** and **Scoop** join, and all tools are now there. A seabird lands on your highest rock to rest.
- **About 5 to 8 min:** moss and the first ferns. If there is a beach, morning glory vines creep across it and maybe the first coconut washes up and sprouts. **The first "Seen" card**, usually the turtle with no beach or the booby with no cliff, gives the first real goal.
- **About 10 min:** the island is green in patches with a handful of species. Plants are popping, the sound is no longer just wind, and the player has made their first change *because the island told them something*.

**Hands:** switching tools, building a beach and a cliff, tapping cards, the first glide of the camera around the island.

### 5.3 The first hour: "my island has a climate"
- **10-20 min:** grasses and shrubs; the **first tree**, often a fig from a frigatebird's belly or a palm. The age changes: *"The Age of Green begins."* A gentle prompt offers to name the island (with a suggested name you can keep). There is a quiet note to save a copy (section 10.4).
- **15-25 min:** **the first storm** (section 7): a gentle first one with a single calm line of reassurance. In its aftermath, the first lizards arrive on a raft.
- **20-35 min:** if the player has built tall, the **peak catches its first cloud**. Rain falls on one side and the island splits into lush and dry. The journal opens a "Places" entry for each. A rock basin fills with rain, and **dragonflies** and then **ducks** arrive, the ducks bringing water plants in the mud on their feet.
- **30-45 min:** forest on the windward slopes, the **first birdsong**, the first **frogs** calling at night if there is a pond. A reef starts in any calm, shallow lagoon.
- **40-60 min:** the turtle nests, and if the player watches at dawn, **hatchlings race to the sea**: the first "Moment" (section 6.6). By now the player has **20 to 30 species and 6 to 8 places**.
- **About 45 to 75 min**, depending on richness, not time: **the mist lifts to the east.** A new glow sits under the water: *"Year 3,060. Far to the east, the sea floor has warmed."* The chain begins.

**Hands:** purposeful landform. Raising a peak *to catch clouds*, scooping a basin *for a pond*, setting a headland *to calm a lagoon*. Also more watching and following, and the first browses of the journal's hints.

### 5.4 Hours 1 to 5 and beyond: "a world, not an island"
- **New island sites keep appearing**, each with its own character (section 8). The player learns that a remote site gets few but special visitors, that a site near the mainland gets frogs and tortoises, and that a small rock islet becomes a seabird city.
- **Weak travellers island-hop.** *"Year 4,410. A gecko from your first island rafted across to the second."* Chains feel alive.
- **Moments** start to show up, and the player chases them by building the right conditions (coral spawning under a full moon, a bat stream at dusk, a glowing mangrove bay).
- **"The Sound":** when three or more islands enclose sheltered deep water, dolphins move in. Later come whales, and the epilogue (section 6.8).
- **Late play:** fine detailing (waterfalls, caves, arches), photo mode, completing the life list, and trying ideas ("what if I make a crater lake?").
- **After the epilogue:** play goes on. You can start **a new sea** with a different starting layout (section 6.8).

**A realistic pace:** a relaxed player reaches the epilogue in about 6 to 10 hours. Completing everything takes 12 to 20.

### 5.5 Why they keep playing, stage by stage
| Stage | The pull |
|---|---|
| 60 s | "I made land!" and "something's coming" |
| 10 min | "That turtle left because of me, so I can fix it." |
| 1 hour | "My mountain makes rain." The first Moment. The mist lifting: "there's more sea." |
| 5 hours | Island personalities, the stepping-stone puzzle, Moments to chase, the journal turning into a real natural history of a place *you* made |
| Beyond | The ending, the full life list, a new sea, and simply wanting to sit and watch |

---

## 6. Rewards and goals (deeper than "I built an island")

### 6.1 Arrival moments, presented calmly
- **The chime** has its own colour per road: airy for wind, wooden for sea, a two-note call for wings, and warmer for a first.
- **The card** is small and slides in at the top of the screen, away from your thumbs. It holds a **sketch drawn in code** (each species' own 3D model drawn as an ink line sketch, so there are no image files), the name, the year and one short story line of at most 25 words. It fades after about 8 seconds. Tap it to open its journal page; swipe it away to dismiss.
- **The Look button on the card** glides the camera to the spot. In the world, a soft rise of glowing motes marks the place for about 30 seconds. If the spot is off screen, a small soft arrow sits at the screen edge while the card shows.
- **Pacing guards:** one card at a time, at least 30 seconds apart. Small news bundles: *"3 more arrivals: see the journal."* "Seen" cards are smaller and silent.

### 6.2 The journal (pages)
A field notebook drawn in code: paper tone, ink lines, a serif italic voice.
1. **Story:** the island's history, newest first. Every arrival, sighting, storm, age and Moment, each with year, line and sketch. Filters: All, Firsts, Storms, Moments. The cover shows the current year and the age's name.
2. **Life list:** the field guide (6.3).
3. **Places:** the habitats (6.4).
4. **Chart:** a map of the zone drawn in code. Islands can be renamed by tapping the name; tap an island to fly there. Unrevealed sea shows as soft mist.
5. **Firsts:** a page of stamp-like badges (6.5).

### 6.3 Life list and hints
- **About 120 species** in five groups: Plants (~40), Birds (~25), Sea life (~22), Small creatures (insects, spiders, snails, crabs: ~18), Reptiles, frogs and mammals (~15). Each group shows a modest count ("17 of 40").
- **Found entries** show the sketch, the name, how it came (wind, sea, wings or storm), where it lives now, the year first seen, and **one true real-world fact**. Some examples:
  - Frigatebirds can stay in the air for weeks.
  - Green iguanas reached Anguilla in 1995 on a raft of logs after hurricanes.
  - Giant tortoises float and have crossed oceans.
  - Hawaii has gobies that climb waterfalls.
  - Parrotfish make white sand.

  The player learns real island science without a lecture.
- **Unfound entries** show a silhouette and a hint written as a gentle riddle about *the place*, not a task:
  - *"Something that dives for fish wants a high ledge above the sea."*
  - *"A wanderer of the open ocean wants a long, gentle beach of soft sand."*
- **Hints sharpen** after a "Seen" visit. The silhouette fills in, and the reason it left is noted.
- **Species that leave your islands** stay in the guide, marked "Not seen on your islands since Year X". They can come back.

**Sample species** (the full list gets written once the engine's habitat checks exist):

| Species | Road | Needs |
|---|---|---|
| Crust lichen | wind | any bare rock |
| Ballooning spider | wind | any land |
| Lava cricket | wind | lava field (eats insects blown in on the wind) |
| Bracken fern | wind | thin soil |
| Tree fern | wind | rainforest |
| Orchid | wind | cloud forest |
| Sea rocket / morning glory | sea | sand beach |
| Coconut palm | sea | beach above the waves |
| Red mangrove | sea | calm, shallow, sheltered shore |
| Corals | sea | warm, clear, calm, shallow water |
| Green turtle | sea | long gentle beach plus seagrass |
| Anole lizard | storm raft | shrubs and insects |
| Giant tortoise | sea (late) | dry scrub, island near the mainland |
| Brown booby | wings | sea cliff |
| Frigatebird | wings | sea stack or tall trees, no egg-eaters |
| Strangler fig | wings (bird belly) | soil, shrubs, fig wasps to fruit |
| Fig wasp | wind | fig trees |
| Mallard-type duck | wings | pond (brings water plants on its feet) |
| Kestrel | wings | grassland with lizards |
| Fruit bat | wings | fruiting forest; streams out at dusk |
| Swiftlet | wings | cave |
| Albatross | wings | remote, windy, grassy islet with nothing that eats eggs |

### 6.4 Places (habitats)
Sixteen places, each with a "where" hint until discovered:

| Place | What makes it | Who it brings |
|---|---|---|
| Lava field | fresh, cooled lava | lichens, lava crickets, spiders |
| Sea cliff | rock face 10 m or taller facing the sea | boobies, tropicbirds, noddies |
| Sea stack | rock pillar standing alone in the sea | frigatebirds, terns |
| Sandy beach | sand at the waterline, gentle slope | crabs, shorebirds, beach plants, coconuts |
| Turtle beach | long, gentle, wide sandy beach | sea turtles (nesting at night) |
| Dunes | sand piled behind a beach | dune grasses, burrowing shearwaters |
| Rocky shore | rock shelves at the waterline | sally lightfoot crabs, herons, octopus |
| Lagoon reef | calm, warm water 1-10 m deep | corals, reef fish, rays, parrotfish |
| Seagrass meadow | calm, sandy, shallow sea floor | grazing turtles, seahorses |
| Mangrove shore | calm, shallow, sheltered shore | mangroves, fiddler crabs, young fish |
| Dry scrub | lee side, in the rain shadow | grasses, lizards, kestrels, tortoises |
| Lowland forest | soil, moderate rain | figs, pigeons, geckos, fruit bats |
| Rainforest | windward slopes below a cloud-catching peak | tree ferns, frogs, tree snails, parrots |
| Cloud forest | peak above about 200 m, in mist | mosses, orchids, a tiny hummingbird |
| Pond and stream | rain-filled basin on rock; overflow running to the sea | reeds, dragonflies, ducks, frogs, climbing gobies |
| Cave | hollow under rock (Scoop sideways, or an overhang) | swiftlets, bats, cave crickets |
| **The Sound** *(chain only)* | deep, sheltered water enclosed by 3+ islands | dolphins, then whales (the ending) |

### 6.5 Firsts (about 24 stamps)
First land, first life, first animal, first seed, first flower, first nesting bird, first tree, first forest, first cloud on your peak, first rain, first pond, first song, first night chorus, first reef, first turtle nest, first storm weathered, first castaway (storm raft), first cave dweller, first island-hopper, second island, first seabird city, first waterfall, first whale sighting, the whole chain alive. Each first gets a slightly grander chime and a stamp on the Firsts page with its year.

### 6.6 Moments (rare spectacles to chase)
About 12 rare, beautiful events that only happen when conditions are right. They are hinted at in the journal ("Some nights, under a full moon, the reef…"):
- **Hatchlings at dawn:** dozens of baby turtles racing to the sea.
- **Coral spawning:** a full-moon night over the reef, the water filled with drifting pink specks.
- **Bat stream:** fruit bats pour out of the forest at dusk.
- **Frigatebird courtship:** red throat pouches puffed out on your sea stack.
- **Glowing bay:** a calm mangrove lagoon at night that glows where fish move.
- **Firefly night:** fireflies in the rainforest blinking in step.
- **Storm rainbow:** a double rainbow over the lee after a great storm.
- **Gathering of birds:** migrating shorebirds rest on your beaches for one evening.
- **Waterfall mist** at sunrise.
- **Albatross dance:** paired albatrosses bowing and clacking on a remote islet.
- **Whale breach** in the Sound.
- **The old boat:** once, a small sailboat (the one from Sandcastle Cays) anchors in your calmest bay for a night and is gone by morning. A wink between the two games.

### 6.7 Ages (chapters)
The island's story is split into ages that name themselves as life passes thresholds: **Age of Stone → Age of Lichen → Age of Green → Age of Wings → Age of Forests → Age of the Chain → Age of Song**. Each opens a new chapter in the journal with a soft musical swell. This gives a feeling of progress without levels.

### 6.8 An ending that doesn't stop play
- **The trigger:** whales choose your Sound to raise their calves. This needs the Sound place, plus at least 4 islands with forest, plus about 70 species.
- **The epilogue:** a quiet sequence that night. Whale song comes up through the water, and the camera rises slowly over the whole lit chain at dusk. The journal writes its last chapter: *"You made the land. The world brought the life."*
- **The credits are a roll call:** every species, with the year it arrived and how, scrolling like a list of thank-yous.
- **Afterwards:** *"The sea is yours. Keep going."* Nothing locks.
- **A new sea** becomes available from the menu: a fresh zone with a different layout, such as a sea of shallow banks for atolls or a far sea with fewer arrivals but rarer life. You can keep a saved file of the old one forever.

### 6.9 What we deliberately leave out
Leaving these out makes the game calmer:
- placing life by hand
- weather control
- money, points or crafting
- timers or quests
- fail states or extinction alarms
- humans or buildings (except the old boat)
- evolution: the owner said colonisation, not evolution
- invasive pests

---

## 7. Seasonal storms: a little drama

**How often:** the first storm comes only after the island has some plants, at about 15 to 25 minutes. After that, roughly every 12 to 20 real minutes, with a **great storm** every third or fourth one. The journal calls each one by its year ("the storm of Year 1,412"); each stands for that era's storm season.

**Warning signs (about 90 seconds):** the light turns amber, then grey. Long high clouds streak in from the windward horizon and the swell grows taller. **Seabirds fly in and settle on the lee side.** Insects go quiet and thunder rolls far away. One calm card: *"A storm is coming."* The first time only, a second line: *"Storms are part of island life. Nothing you love will be lost for good."*

**The storm (about 2 minutes):** rain sheets drift across, palms bend and whip, and big waves break white on windward shores. Lightning is soft and far off, and a setting reduces flashes. Animals take shelter: crabs in burrows, birds pressed into the lee. **Your tools still work.** Pouring lava in the rain makes huge clouds of steam, which is great fun.

**What changes:**
- Bare, exposed sand on windward shores gets pulled seaward. (This is the sandcastle game's "the tide wins" rule used gently.) Grassy dunes hold.
- A few trees on exposed ridges fall and become logs.
- Exposed coral loses a little.
- Ponds fill and streams run.
- **Rock never changes.** Sheltered places barely change at all.

**What the player can do:** nothing is required. The thoughtful answer is landform: a ridge or headland that breaks the wind, or a reef or stone breakwater that calms a lagoon. The game rewards shelter quietly: mangroves, seagrass, coral and tern colonies flourish behind it. No storm defence is ever demanded.

**After the storm (about 1 minute), the silver lining:**
- Sunbeams break through, a rainbow arcs over the lee side, everything glistens and birdsong bursts out.
- Seedlings pop up in the gaps where trees fell, and a line of washed-up seaweed and driftwood marks the beach.
- **Storms are the main road for castaways:** lizards and iguanas on rafts, land snails, beetles, butterflies, birds blown off course (a heron, an owl).
- The journal entry ties it together: *"Year 1,412. The great storm. Three palms fell on the windward shore. On a raft of tangled branches, the first anole lizards came ashore."*

The settings offer Storms: Gentle (rarer, softer, fewer flashes) or Normal. There is deliberately no "off". The owner wants a little drama, and storms carry life that comes no other way. This is easy to revisit if the owner disagrees.

---

## 8. The island chain zone

**The zone** is a round stretch of sea about 1.6 km across, ringed by a distant outer reef where surf breaks white. That ring is the soft edge: the camera eases to a stop there and the brush fades. Beyond it is open ocean to the horizon, with the **mainland** as a soft blue silhouette in the far west. The trade wind blows from the east. The sea floor varies, with deep blue water, pale shallow banks (cheap to build on) and the warm glows.

**Reveal by mist:** at first, a soft sea mist hides everything except **the First Sea**, a clear circle about 500 m across. That is room for one island to grow very big. Tools work anywhere in clear water. When your life grows richer (species count and places, never time), the mist parts over a new area with its own warm glow. That happens five times, for **six island sites**, each with a character the player discovers:

| Site | Character | What it's good for |
|---|---|---|
| 1. The First Sea | deep water, middle of the zone | your first big volcano island |
| 2. Windward Bank | far east, takes the full wind | rain on every slope, crashing cliffs, seabird ledges |
| 3. The Shallows | wide sandy bank in warm water | atolls, reefs, white-sand cays, seagrass, turtles |
| 4. Cold Current | a cool current runs past | surprises from cooler seas, such as sea lions and penguins (true of the Galápagos at the equator) |
| 5. Mainland Steps | close to the mainland | stepping stones: frogs, tortoises, land snails, bats |
| 6. The Far Reef | most remote, at the edge of the zone | few arrivals but special ones: albatross and a predator-free seabird city |

Islands can be joined with sand spits, moved toward each other or left apart. All of them stay editable forever. Pouring is never limited to the glows; the glows are an invitation.

**Moving the camera between islands:**
- **Pinch out all the way** and the camera rises smoothly to an overview of the whole chain, tilting toward straight down.
- **Tap an island** in the overview to glide down to it.
- A **two-finger tap** (or right-click) glides to any spot.
- The **Chart** page in the journal flies you to any named island.
- Flights are slow, high, smooth arcs: never a cut, never fast enough to cause motion sickness.

---

## 9. Onboarding without walls of text

- **One short line at a time, only when it's needed**, each shown once:
  - "Touch the glow."
  - "Your island."
  - "Keep building, or just watch."
  - One line per tool as it joins the tray.
  - One line for the journal ("Everything that happens here is written down.").
  - One for the first "Seen" card.
  - One for the first storm.
- **Gesture hints** are tiny animated hand drawings, made in code. "Two fingers to look around" appears after about 30 seconds if the player hasn't moved the camera yet, and disappears the moment they do.
- **Tools arrive one at a time** over the first 5 minutes, so nobody faces five buttons at second one.
- **The journal teaches ecology** through the "why it left" lines and the place hints. There is never a tutorial page.
- **The first journal page** reads like the player wrote it: *"Year 0. There was only the sea. Then there was a stone."*
- **Help** in the menu is a single illustrated card of the controls, plus "Show the hints again".

---

## 10. Screen, menus, settings, saving

### 10.1 On screen (the minimum)
- **Bottom:** the tool tray (Lava, Stone, Sand, Hands, Scoop), a size dot and Undo, all within thumb reach. On a landscape phone it moves to the side. A left-handed setting mirrors it.
- **Top left:** the journal (book icon), with a soft dot when there are new entries.
- **Top right:** the menu (three lines).
- **Top centre:** arrival cards, appearing only when there is news.
- **Nothing else.** No year, no counters, no meters, no mini-map.
- **Watch mode:** after 60 seconds without touching, all UI fades out. If the setting is on, the camera begins a very slow drift around the island. Any touch brings the UI back. This is the "sit and watch trees pop up" mode the owner described, and it doubles as a living screensaver.
- **Photo:** a camera button in the menu (and the P key). It hides the UI, adds a soft focus and saves a picture the player made.

### 10.2 The journal
See 6.2. It opens as a full-screen notebook (time pauses), with tabs along the edge: Story, Life, Places, Chart, Firsts. A back arrow returns to the island.

### 10.3 Menu and settings
- **Menu:** Back to the island, Journal, Photo, Settings, Save to file, Load from file, Help, Run the checks on this device, Begin a new sea (after a warning, with an offer to save first), About.
- **Settings:**
  - Time pace (Slow / Steady / Swift)
  - Storms (Gentle / Normal) and Fewer flashes
  - Careful hands
  - Camera drift when idle
  - Sound levels for sea, wind, life and music
  - Vibration
  - Graphics (Auto / Lighter / Richer)
  - Left-handed tray
  - Larger text

### 10.4 Saving
This matches Sandcastle Cays, plus one important addition:
- **Autosave** every minute and whenever the game is hidden. The save holds the land, life, journal and settings.
- **Save to file / Load from file** always works. This is critical, because a page opened straight from Downloads on a phone may not keep its storage.
- **Gentle backup nudge:** each time a new age begins, the bottom of the journal shows *"Keep a copy of your sea"* with a Save button. It never interrupts, but losing ten hours of island would be the one real heartbreak this game could cause.

---

## 11. Sound: the island's voice grows

- **At the start:** open sea, wind and the lava rumble only.
- **Then, as life arrives**, layers are added: the rustle of grass, insect buzz in daylight, crickets at dusk, a different **code-made call for each bird species** (so the player learns to hear who lives there), frogs and the night chorus, rain on leaves, a waterfall's hush, and whale song from the Sound.
- The soundscape becomes **the scoreboard you hear**: the richer the life, the richer the sound. Hearing birdsong for the first time is a quiet milestone of its own.
- **Music:** optional and sparse. Soft notes on the same five-note scale, played in response to arrivals and pops. Off is perfectly fine; nature sound is the main score.
- **Everything is made in code,** as in Sandcastle Cays.

---

## 12. Names

1. **Wind, Wing & Wave**
2. **Landfall**
3. **Lava & Lichen**
4. **Cradle Cays** (a sister name to Sandcastle Cays)
5. **Seedfall**
6. **Driftseed**
7. **First Green**
8. **The Arrivals**
9. **Castaway Isles**
10. **Spore & Stone**
11. **Fern & Fire**
12. **Hotspot Isles** (island chains really form over hot spots in the sea floor)
13. **Many Years Island**
14. **Tidecradle**

**Top 3:**
1. **Wind, Wing & Wave.** It says exactly what the game is about: the three roads life takes to reach your island. It sounds calm, it's memorable, and the journal could even group arrivals under those three words.
2. **Landfall.** One word with three meanings in this game: land rising from the sea, life finally making landfall, and storms making landfall. A simple search shows a game studio called Landfall Games, so a clash check is needed.
3. **Lava & Lichen.** The game's first tool and its first life, which together are its whole first minute. It's warm, a little playful, and fits the hand-made feel.

Honourable mention: **Cradle Cays**, if the owner wants the two games to sound like a family.

---

## 13. Notes for building it (brief; engineering sessions decide the details)

- **What carries over from the sandcastle engine:** the cell grid, the sliding-sand rules and stickiness, smooth meshing, the background-thread engine with its fallback, three.js, code-made sound, the one-file build, checks, undo and save/load.
- **Scale:** go from 3 cm cells to about **1 m cells**. Store chunks that are entirely solid rock as a single flag, so memory grows with surface detail, not with island volume. Far islands are drawn in less detail.
- **New per-cell data:** what the material is (sand, stone, lava rock, soil, reef) and how hot lava is. Lava is a thick, flowing material that cools into stone. Stone never slides. Plants add stickiness to the sand beneath them.
- **Ecology runs on a coarse surface map** (about 4 m squares) with height, slope, rain, salt, shelter, soil, ground type and what grows there. It updates once per island-year on the background thread, which is cheap.
- **Plants are drawn as thousands of low-poly models in batches.** Animals are simple code-built creatures with simple behaviours, capped at about 150 near the camera.
- **Suggested build stages, each a playable file for the owner:**
  1. Shaping: the five tools, sea, sky and day cycle, the storm visuals.
  2. Life: steps on rock and sand, about 40 species, cards, journal.
  3. Climate: clouds on peaks, rain shadow, ponds, reef, Moments.
  4. The chain: mist, six sites, stepping stones, all ~120 species.
  5. Ending, polish, phone performance pass, names and text.

  Each stage still runs the game's checks and phone tests before it is sent.

---

## 14. Questions for the owner (with my suggested answers)

The repo rule is to talk first and build second, so these need answers before building.

1. **Time pace:** is one year per second right by default, with Slow and Swift in the settings? *Suggest: yes.*
2. **Storms:** always on, with a Gentle option (no "off")? *Suggest: yes, because storms bring some life that comes no other way.*
3. **Should your tools be able to bury or burn living things** (with undo, plus a "Careful hands" setting that is off by default)? *Suggest: yes. It makes lava meaningful, and the journal treats it as renewal.*
4. **Real species and true facts** in the field guide (turtles, figs, frigatebirds), rather than made-up creatures? *Suggest: real. It's where the deeper reward lives.*
5. **Phone held upright, sideways, or both?** *Suggest: both, with the tray moving to the side when sideways.*
6. **Music, or only nature sounds?** *Suggest: sparse optional music, nature sounds first.*
7. **Which name** do you like, or would you like more in one direction (calm, playful, poetic)?