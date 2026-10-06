# The plan (Wind, Wing & Wave)

**Wind, Wing & Wave** (working name; easy to change) is a calm island-making game. You shape land from the sea with your hands. Life finds it on its own, the way it really reaches new islands: on the **wind**, on **wings**, and on the **waves**. It runs in Chrome on a Pixel 7a and a Windows laptop with a trackpad, and is delivered as one HTML file.

## In six lines
1. You shape the land with lava, rock and sand.
2. Wind, sea and birds bring life on their own. You never place life and never control the weather.
3. The shape decides who stays: tall peaks catch rain, cliffs bring seabirds, beaches bring turtles, rock hollows become ponds.
4. Storms come in the wet season. They knock a few things down and bring castaways.
5. The journal keeps the years and every story.
6. Build more islands to welcome life that can't reach one island alone.

## Two clocks
- **The island's history races:** about 2 years pass every second (settings: 1, 2 or 5). You see years only in the journal and its little arrival notes.
- **Everything you watch moves at real speed:** your lava, the waves, the birds, the crabs. The sky has its own slow, calm day of about 16 minutes, so there is dusk, night (turtles nest, lava glows, bats come out) and dawn.
- When the game is closed, everything waits for you.

## Your hands (the tools)
| Tool | What it does |
| --- | --- |
| **Lava** | Pour molten rock. It flows like thick honey, glows, crusts and cools into black rock in about 10–20 seconds. It bursts into steam in the sea. It is the fastest way to raise land, it burns what it covers, and old lava becomes the richest soil. |
| **Rock** | Pour or place rock. It tumbles from your hands and stays exactly where it lands, so it can make cliffs, sea stacks and pond rims. |
| **Sand** | Pour sand. It slides into soft slopes and makes beaches, dunes, spits and sandbars. |
| **Hands** | Smooth and soften the land. |
| **Scoop** | Carve land away: bays, ponds, channels. |
| **Look** | Tap anything to learn what it is and why it lives there. |

Material is unlimited. **Undo** always works, and it also brings back any life your stroke buried.

## How life comes
- **Wind:** spores, lichens, ferns, tiny spiders on silk threads, insects.
- **Sea:** coconuts and drifting seeds, crabs, turtles, lizards rafting on logs after storms.
- **Wings:** seabirds, then seeds carried inside birds or in mud on their feet.

Life comes in steps, and soil has to build first: bare rock, then lichen, moss, ferns, grasses, shrubs, and forest. Beaches green faster, because seeds float in.

**The heart of the game.** Something visits but can't stay, and the journal says why in one kind line ("A turtle came looking for a beach. Your shore is all rock."). You shape the land. The visitor comes back, and the journal tells that story too.

## What you get for it
- **Arrival notes:** small cards with a soft chime. Tap one to fly there.
- **The journal:**
  - **Story:** every arrival, storm, first and age, with its year.
  - **Life & Places:** a field guide of about 90 real species with true facts. Missing ones show hints that get clearer over time.
  - **Chart:** your islands, which you can name.
- **Firsts and Ages:** stamps and chapters, such as "the Age of Green".
- **The soundscape is your scoreboard:** wind only at first, then insects, birdsong, frogs at night and seabird colonies.
- **An ending:** when three or more forested islands enclose a sheltered sound and life is rich, whales come to raise their calves there. You can keep playing afterwards.

## Storms
Storms come about every 15–25 minutes in the wet season, starting once your island has some plants. You get a short warning (the light changes and birds fly to shelter), then about a minute of wind, rain, big waves and far-off thunder, then a rainbow. A few trees fall and some beach sand washes away, and every storm leaves something behind: driftwood, a raft of lizards, a bird blown off course. Rock never changes. There is a "gentle storms" setting.

## The sea you build in
- A 1 km square of warm sea with a shallow underwater ridge, sandy banks and a few shallow knolls that hint where to start.
- "Old islands" sit on the eastern horizon, upwind. That's where most life comes from.
- The whole area is open from the start.
- Islands closer to the old islands get more visitors. Little islets become seabird cities. A ring of islands makes a lagoon.

## Watching
After a minute without touching, the buttons fade, and the camera drifts gently toward where life is happening. It's a "sit and watch trees pop up" mode. Trees and ferns pop up with a quick springy animation; they never grow slowly.

## What we left out on purpose
Placing life by hand, weather control, money or points, timers or quests, losing, pests, people and buildings (except one small wink), and evolution.

## Things you can change easily
The name, the pace of years, how often storms come, and whether lava can burn forests.

## How you'll know it works
- Automatic checks of the land rules and the life rules (`npm test`), plus the same checks on an in-game page that runs on your own phone.
- Browser tests as a laptop and as a Pixel-sized phone, with screenshots.
- A plain-language note of what changed and what was tested in every version (`CHANGELOG.md`).
