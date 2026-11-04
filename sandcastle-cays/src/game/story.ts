/**
 * The notebook: why you're here, and what to do next.
 *
 * The catamaran and Home Cay were left to you by their old owner, Ida, who
 * sailed these cays for thirty years. Ida left a notebook in the chart table.
 * It's written as a series of notes to whoever came next, chapter by chapter:
 * settle in, live aboard, sail further, and at last brave the shark waters.
 * Each note is a set of goals. Finish them all and the chapter's reward is
 * yours (Ida left a few things aboard for you): seeds, a recipe, a boat
 * upgrade.
 *
 * Goals count everything you've ever done, so nothing is lost if you do
 * things out of order: catch a fish on day one and that goal is already
 * ticked when its chapter opens.
 *
 * The tips are short pop-up hints, each shown once, when it's first useful:
 * how to climb down the ladder, how to pick things up, what the basket is
 * for. Together with the "next step" line they walk a new player through
 * the game. No drawing in here.
 */

/** Everything a goal can count. */
export type Fact =
  | 'ashore'
  | 'finds'
  | 'stowed'
  | 'castle'
  | 'slept'
  | 'fish'
  | 'cooked'
  | 'planted'
  | 'harvested'
  | 'made'
  | 'pinkAnchored'
  | 'pinkShells'
  | 'dinghy'
  | 'buoy'
  | 'gap'
  | 'baited'
  | 'bankAshore'
  | 'bankFinds'
  | 'bigFish';

export interface Goal {
  fact: Fact;
  /** How many it takes. */
  n: number;
  /** "Swim ashore to Home Cay" */
  text: string;
  /** How to do it: one or two short sentences. `{use}` and friends are filled in for phone or laptop (see `howTo`). */
  how: string;
}

export type Reward =
  | { kind: 'seeds'; seeds: Record<string, number>; text: string }
  | { kind: 'recipe'; recipe: 'bait'; text: string }
  | { kind: 'upgrade'; upgrade: 'goodSails' | 'strongReel'; text: string };

export interface Chapter {
  id: string;
  title: string;
  /** Ida's note at the top of the chapter. */
  note: string;
  goals: Goal[];
  reward: Reward;
  /** Ida's line when you finish it. */
  done: string;
}

export const CHAPTERS: Chapter[] = [
  {
    id: 'settle',
    title: 'Settling in',
    note: 'Whoever you are: welcome aboard. She’s yours now, and so is Home Cay. Thirty years I sailed these waters, and I never got tired of them. Start small. Get your feet on the sand, see what the sea has left you, and sleep a night aboard. The rest will come.',
    goals: [
      { fact: 'ashore', n: 1, text: 'Go ashore on Home Cay', how: 'Walk to the ladder at the back of the boat and {use} to climb down, then swim to the beach. Or just jump off the side.' },
      { fact: 'finds', n: 3, text: 'Pick up three things the sea left on the beach', how: 'Walk along the beach near the water’s edge. Shells and sea glass glint in the sun. Look at one and {use} to pick it up.' },
      { fact: 'stowed', n: 1, text: 'Stow your finds in the locker aboard', how: 'Swim back and climb the ladder ({use} at the bottom), then {use} at the locker by the cockpit to empty your basket.' },
      { fact: 'castle', n: 1, text: 'Build something on the cove’s sand', how: 'The sandcastle cove is the sheltered beach in the middle of the south shore. Stand on its sand and {build} to kneel and build.' },
      { fact: 'slept', n: 1, text: 'Sleep a night in your bunk', how: 'After sunset (6 pm), with the anchor down, go below to the bunk in the port (left) hull and {use}.' },
    ],
    reward: { kind: 'seeds', seeds: { callaloo: 3, tomato: 3, sweetpotato: 2 }, text: 'Ida’s seed tin: three more callaloo, three tomato and two sweet potato slips.' },
    done: 'There. You’re settled. I left my old seed tin in the galley for you: plant them, and you’ll eat well.',
  },
  {
    id: 'live',
    title: 'Living aboard',
    note: 'The sea will feed you if you let it. Catch a fish and cook it. Plant a few seeds in the pots on deck, or in the garden ashore, and look after them. And keep the old girl in good repair: the workbench is down in the starboard hull.',
    goals: [
      { fact: 'fish', n: 1, text: 'Catch a fish', how: 'Pick up the rod ({rod}). {use} to cast. When the float dips, {use} quickly to strike, then hold {use} to reel in. Let go when the fish runs or the line will snap.' },
      { fact: 'cooked', n: 1, text: 'Cook your catch in the galley', how: 'The galley is in the saloon, through the door from the cockpit. {use} there and choose Cook.' },
      { fact: 'planted', n: 1, text: 'Plant something', how: 'The pots are on the planter shelf at the front of the saloon, and the garden beds are just inland from the cove. Look at an empty one and {use}.' },
      { fact: 'harvested', n: 1, text: 'Harvest something you grew', how: 'Water your plants every day (rain does it for you). Callaloo is ripe in two days. Sleep in your bunk to pass the night.' },
      { fact: 'made', n: 1, text: 'Make or mend something at the workbench', how: 'The workbench is down in the starboard (right) hull. It shows what you can make from the finds in your locker.' },
    ],
    reward: { kind: 'recipe', recipe: 'bait', text: 'A new recipe for the galley: cut a fish into bait. You’ll want it in the shark waters.' },
    done: 'You’ve got the hang of it. One more thing I learned the hard way: in the galley you can cut a fish into bait. Keep some in the bait box. You’ll see why.',
  },
  {
    id: 'further',
    title: 'Further afield',
    note: 'Now take her out. Sail to Pink Sand Cay, where the beaches really are pink, and look for the shells that wash up only there. Lower the dinghy and learn to row it. And when you feel ready, go out through the reef onto the open sea and round the sea buoy.',
    goals: [
      { fact: 'pinkAnchored', n: 1, text: 'Sail to Pink Sand Cay and anchor', how: 'Take the helm on the flybridge. Open the chart ({chart}) and choose Pink Sand Cay to let her sail herself, or steer her there and drop the anchor ({anchor}).' },
      { fact: 'pinkShells', n: 1, text: 'Find a shell that only Pink Sand Cay has', how: 'Netted olives and flamingo tongues wash up on Pink Sand Cay and nowhere else.' },
      { fact: 'dinghy', n: 1, text: 'Lower the dinghy and row it', how: 'The dinghy hangs between the two sterns. Stand on a swim step and {use} to lower it and climb in. {move} rows.' },
      { fact: 'buoy', n: 1, text: 'Sail out round the sea buoy', how: 'The sea buoy is out on the open sea to the south-east. Choose it on the chart, or sail there yourself and round it.' },
    ],
    reward: { kind: 'upgrade', upgrade: 'goodSails', text: 'Ida’s spare sails, heavy cloth: bent on now, and they wear half as fast.' },
    done: 'You can handle her. My spare sails are in the forward locker: heavier cloth than the ones she wore. I’ve had them put on for you.',
  },
  {
    id: 'sharks',
    title: 'The shark waters',
    note: 'Last of all, the shark waters. Don’t worry: in thirty years not one of them hurt me. A reef shark patrols the gap in our reef, and two more cruise the deep water round the sea buoy. Out to the north-west is Shark Bank, a sandbar where the nurse sharks come to sleep. They’re curious, so they bump things, and a bump can make you drop your basket, or dent the dinghy. Throw them a piece of bait and they’ll leave you be. The bank has the best finds in all the cays, and the shark waters the biggest fish.',
    goals: [
      { fact: 'gap', n: 1, text: 'Take the dinghy through the reef gap', how: 'The gap is the channel through the reef, south-west of Home Cay. Row or motor out through it. A reef shark lives there.' },
      { fact: 'baited', n: 1, text: 'Throw bait to a shark', how: 'Cut a fish into bait in the galley. When a shark circles you, {bait} to throw a piece. It goes after the bait instead of you.' },
      { fact: 'bankAshore', n: 1, text: 'Step ashore on Shark Bank', how: 'Sail to Shark Bank (it’s on the chart) and anchor off it: the flats are too shallow for her. Take the dinghy in, and row the last bit over the sand.' },
      { fact: 'bankFinds', n: 2, text: 'Find two things on Shark Bank’s sand', how: 'The sea leaves its rarest finds on the bar: queen conch shells, and sharks’ teeth.' },
      { fact: 'bigFish', n: 1, text: 'Catch a big fish in the shark waters', how: 'Fish from the dinghy or the boat in the shark waters. Fish there run bigger, so they fight harder. Go easy on the line.' },
    ],
    reward: { kind: 'upgrade', upgrade: 'strongReel', text: 'Ida’s strong reel: the line takes much more strain before it snaps.' },
    done: 'So now you know the cays as well as I did. My good reel is in the locker: it’s yours, and so is everything else. The notebook’s pages after this one are empty. Fill them with your own.',
  },
];

/** A big fish: this many kilos or more, caught in shark waters. */
export const BIG_FISH_KG = 3;

export interface StoryState {
  /** Index of the chapter you're on (CHAPTERS.length when the notebook is finished). */
  chapter: number;
  /** Things the game counts itself (everything else is read from the rest of the save). */
  facts: Partial<Record<Fact, number>>;
  /** Tips already shown. */
  seen: string[];
  /** Has the opening page been shown? */
  opened: boolean;
}

export function newStory(): StoryState {
  return { chapter: 0, facts: {}, seen: [], opened: false };
}

const FACTS: Fact[] = ['ashore', 'finds', 'stowed', 'castle', 'slept', 'fish', 'cooked', 'planted', 'harvested', 'made', 'pinkAnchored', 'pinkShells', 'dinghy', 'buoy', 'gap', 'baited', 'bankAshore', 'bankFinds', 'bigFish'];

export function restoreStory(raw: unknown): StoryState {
  const s = newStory();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Partial<StoryState>;
  if (typeof r.chapter === 'number' && Number.isFinite(r.chapter)) s.chapter = Math.max(0, Math.min(CHAPTERS.length, Math.floor(r.chapter)));
  if (r.facts && typeof r.facts === 'object')
    for (const f of FACTS) {
      const v = (r.facts as Record<string, unknown>)[f];
      if (typeof v === 'number' && v > 0 && Number.isFinite(v)) s.facts[f] = Math.floor(v);
    }
  if (Array.isArray(r.seen)) s.seen = r.seen.filter((x) => typeof x === 'string').slice(0, 200);
  s.opened = r.opened === true;
  return s;
}

/** Count something the game noticed (going ashore, sleeping…). */
export function note(s: StoryState, fact: Fact, by = 1): void {
  s.facts[fact] = (s.facts[fact] ?? 0) + by;
}

/** Set a count to at least this much (for facts read from elsewhere in the save). */
export function atLeast(s: StoryState, fact: Fact, n: number): void {
  if (n > (s.facts[fact] ?? 0)) s.facts[fact] = n;
}

export function count(s: StoryState, fact: Fact): number {
  return s.facts[fact] ?? 0;
}

export function goalDone(s: StoryState, g: Goal): boolean {
  return count(s, g.fact) >= g.n;
}

export function chapterNow(s: StoryState): Chapter | null {
  return CHAPTERS[s.chapter] ?? null;
}

/** The first goal of this chapter not done yet (the "next step"), or null. */
export function nextGoal(s: StoryState): Goal | null {
  const c = chapterNow(s);
  if (!c) return null;
  return c.goals.find((g) => !goalDone(s, g)) ?? null;
}

export interface StoryNews {
  /** Goals just ticked off (in the chapter you're on). */
  ticked: Goal[];
  /** A chapter just finished (its reward is yours; the next one has opened). */
  finished: Chapter | null;
}

/**
 * Check for progress. Call whenever something might have changed. Ticks are
 * reported once: `ticked` lists goals of the current chapter that are done
 * now and weren't at the last check.
 */
export function checkStory(s: StoryState, was: Set<string>): StoryNews {
  const news: StoryNews = { ticked: [], finished: null };
  const c = chapterNow(s);
  if (!c) return news;
  for (const g of c.goals) {
    const key = `${c.id}:${g.fact}`;
    if (goalDone(s, g) && !was.has(key)) {
      was.add(key);
      news.ticked.push(g);
    }
  }
  if (c.goals.every((g) => goalDone(s, g))) {
    news.finished = c;
    s.chapter++;
    // Goals of the new chapter already done count as already ticked (no flood of ticks).
    const n = chapterNow(s);
    if (n) for (const g of n.goals) if (goalDone(s, g)) was.add(`${n.id}:${g.fact}`);
  }
  return news;
}

/** The goals already done in the chapter you're on (to seed `checkStory`'s memory after loading). */
export function doneKeys(s: StoryState): Set<string> {
  const out = new Set<string>();
  const c = chapterNow(s);
  if (c) for (const g of c.goals) if (goalDone(s, g)) out.add(`${c.id}:${g.fact}`);
  return out;
}

/** Fill in the keys for this kind of device. */
export function howTo(text: string, touch: boolean): string {
  const keys: Record<string, [string, string]> = {
    use: ['press E', 'tap the hand button'],
    build: ['press B', 'tap Build'],
    rod: ['G', 'the Fish button'],
    chart: ['M', 'the chart button'],
    anchor: ['X', 'the anchor button'],
    move: ['W and S (A and D turn)', 'The stick'],
    bait: ['press Q', 'tap Bait'],
  };
  return sentenceCase(text.replace(/\{(\w+)\}/g, (m, k: string) => (keys[k] ? keys[k][touch ? 1 : 0] : m)));
}

/** A key name filled in at the start of a sentence gets a capital ("Press E to…"). */
function sentenceCase(s: string): string {
  return s.replace(/(^|[.!?:]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

// ---------- tips: one-time pop-up hints ----------

export interface Tip {
  id: string;
  title: string;
  text: string;
}

/** Each tip is shown once, the first time the game asks for it. Keys are filled in by `howTo`. */
export const TIPS: Record<string, Tip> = {
  welcome: { id: 'welcome', title: 'Welcome aboard', text: 'This boat and Home Cay are yours now. The old owner, Ida, left you a notebook ({notebook}). It says what to try next. The line at the top of the screen always shows your next step.' },
  look: { id: 'look', title: 'Getting about', text: 'Look around by {look}. Walk with {walk}.' },
  ladder: { id: 'ladder', title: 'The swim ladder', text: 'This is the ladder down into the water. {use} to climb down. You can climb back up the same way.' },
  swimming: { id: 'swimming', title: 'Swimming', text: 'You’re in the water. Swim to the beach: the island is behind the boat. Back at the boat, swim to the ladder and {use} to climb aboard.' },
  ashore: { id: 'ashore', title: 'Ashore', text: 'Walk along the beach near the water’s edge. When something glints, look at it and {use} to pick it up. Your basket holds a few things at a time.' },
  firstFind: { id: 'firstFind', title: 'Your basket', text: 'Finds go in your basket (top right). When it’s full, take it back aboard and empty it in the locker. The logbook ({logbook}) lists all you’ve found.' },
  locker: { id: 'locker', title: 'The locker', text: 'Empty your basket here. What you keep in the locker you can make things from at the workbench.' },
  dusk: { id: 'dusk', title: 'Evening', text: 'The sun’s going down. When it’s dark, sleep in your bunk (below, in the port hull) and you’ll wake at dawn. New finds wash up every morning.' },
  helm: { id: 'helm', title: 'At the helm', text: 'You’re steering. The chart ({chart}) can sail her for you: pick a place and she’ll go there and anchor. Or sail her yourself: {sailKeys}.' },
  rod: { id: 'rod', title: 'Fishing', text: '{use} to cast. Wait for the float to dip, then {use} straight away to strike. Hold {use} to reel. When the line goes tight (the fish runs), let go, or it snaps.' },
  galley: { id: 'galley', title: 'The galley', text: 'Cook your fish here to fill the larder, and open coconuts for food and water. Your stores (top left) go down a little each day.' },
  garden: { id: 'garden', title: 'Growing things', text: 'Water your plants every day; rain does it for you. Pots aboard take water from the boat’s tank, and the garden ashore has a rain barrel.' },
  dinghyIn: { id: 'dinghyIn', title: 'The dinghy', text: 'You’re in the dinghy. {row} {motor} {use} to climb out: back aboard at the stern, or onto a beach.' },
  shallowMotor: { id: 'shallowMotor', title: 'Too shallow for the outboard', text: 'The propeller would hit the sand, so the outboard tilts up. Row over the shallows. Start it again ({motorKey}) in deeper water.' },
  beached: { id: 'beached', title: 'On the sand', text: 'The dinghy’s nose is on the sand. {use} to climb out and walk. It stays here until you come back for it. To get off, row backwards.' },
  sharkZone: { id: 'sharkZone', title: 'Shark waters', text: 'Sharks live here. They won’t hurt you, but a curious one may bump you. In the water you’d drop your basket; in the dinghy it leaves a dent. Bait ({bait}) keeps them busy.' },
  circling: { id: 'circling', title: 'A shark is circling', text: 'It’s curious. It may come in and bump you, then swim off. Throw it some bait ({bait}), or move on out of its water.' },
  noBait: { id: 'noBait', title: 'No bait', text: 'You have no bait. Cut a fish into bait in the galley (you learn how in Ida’s notebook).' },
  dented: { id: 'dented', title: 'A dented dinghy', text: 'Dents make the dinghy slower. Mend it at the workbench (in the starboard hull) with a piece of driftwood and some rope.' },
  dropped: { id: 'dropped', title: 'Your basket', text: 'Don’t worry about what you dropped: the sea will wash it up on the nearest beach on the next morning’s tide.' },
  bankFlats: { id: 'bankFlats', title: 'Shark Bank', text: 'The flats are knee-deep: too shallow for the catamaran, but fine for the dinghy. Nurse sharks rest on the sand here. Don’t step on one.' },
  chapter: { id: 'chapter', title: 'A new page', text: 'Ida’s notebook has a new chapter for you. Open it ({notebook}) to read it.' },
};

/** Fill in a tip's keys for phone or laptop. */
export function tipText(t: Tip, touch: boolean): string {
  const keys: Record<string, [string, string]> = {
    notebook: ['N', 'the notebook button at the top'],
    logbook: ['L', 'the book button'],
    look: ['moving the mouse (click the game first)', 'dragging on the right of the screen'],
    walk: ['W A S D, hold Shift to run, Space to jump', 'the stick on the left'],
    use: ['press E', 'tap the hand button'],
    chart: ['M', 'the chart button'],
    sailKeys: ['A and D steer, W and S raise and lower the sails, X drops the anchor', 'the stick steers, the buttons work the sails and the anchor'],
    row: ['W and S row, A and D turn.', 'The stick rows and turns.'],
    motor: ['R starts the outboard (then W and S work the throttle), F stops it.', 'Tap Outboard to start it.'],
    motorKey: ['R', 'Outboard'],
    bait: ['Q', 'the Bait button'],
  };
  return sentenceCase(t.text.replace(/\{(\w+)\}/g, (m, k: string) => (keys[k] ? keys[k][touch ? 1 : 0] : m)));
}

/** Show this tip? (Only once, ever.) Marks it seen. */
export function takeTip(s: StoryState, id: string): Tip | null {
  if (s.seen.includes(id)) return null;
  const t = TIPS[id];
  if (!t) return null;
  s.seen.push(id);
  return t;
}
