# What changed, version by version (plain language)

## v0.1 (first joined version, "path 1")
The first time all ten parts run together as one game. It is **a first look, not a finished game**, and it has **never been tried on a real phone**.

**What you can do**
- Start the game, touch the glow, pour lava. It flows like honey, glows, crusts and cools into black rock, and steams in the sea.
- Choose Rock, Sand, Hands, Scoop and Look from the tray once the first land has cooled. Undo always works.
- Watch life arrive on its own: first crusts and lichen on the wind, seabirds, beach plants and coconuts on the waves, then ferns, grass, shrubs and the first trees, with animals walking, flying and swimming at real pace.
- Read the story in the journal (every arrival, storm and age), browse the field guide of about 90 real species, and look at the chart of your islands.
- Sit through a storm: a warning (the light turns amber), about a minute of wind, rain and big waves, then clearing. Each storm leaves a line in the journal.
- Save to a file and open it again; your sea also saves itself.

**What is new in this version compared with the parts as first built**
- A new sea starts on a dry day, so the first storm comes after about 16–20 minutes of play (it used to come after about 33). The first 13 minutes have a warmer sky.
- Life arrives a little more slowly, which matches the plan's timeline better.
- Place names on the land no longer print on top of each other, and stay on the screen.
- A dolphin no longer swims faster than a real one when it leaps, and a whale or dolphin leaving a scene fades out smoothly instead of dimming in one jump.

**Checks that passed before sending**
- Types, and 498 tests (land rules, life rules, engine, sky, sound, interface, animals, plants).
- 53 browser checks, played as a laptop and as a Pixel-sized phone: starting, pouring, camera gestures that never edit the land, every tool, the journal (and that it pauses time), cards, Look, settings, photo, save and load, watch mode, the checks page, drawing budgets.
- A 22-step playthrough on both laptop and phone size: pour lava, run about 600 years, life and plants and animals appear, the journal and field guide fill, a storm goes through warning and peak and is written in the journal, the grown island saves to a file and loads back the same, and the drawing budgets hold over the grown island.
- The pacing bench against the plan's timeline: on the main island 13 of 18 beats on time, 4 early, 1 slightly late, none missed; the whale ending is reached.

**Not tested, or known**
- **Speed on a real Pixel is not measured.** Open **Menu → Run the checks on this device** and note the "Smooth" line.
- How the touch gestures feel, how it sounds, and opening the file from the Downloads folder on a phone were not tested.
- Two speed checks (lava step, one year of the life simulation) are slower than their laptop limits on the build machine; they warn there and are not counted as failures. Your phone's own checks page will tell the truth for your phone.
- The first island runs out of new kinds of life at about 27 minutes; the plan wanted 40–50.
- Some beats arrive early (birdsong at about 9 minutes, pond life soon after a pond exists).
- A "Save a copy" reminder can sit over the open journal on a phone.
