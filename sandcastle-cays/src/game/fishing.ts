/**
 * Fishing with a rod, from the deck or from the shore.
 *
 * Cast, and the float settles on the water. After a while (sooner with a
 * lure) a fish bites: the float dips and you have a moment to strike. Then
 * reel it in: hold to reel, but when the fish runs the line tightens, so ease
 * off or the line snaps. What bites depends on where the float lands:
 * shallow sand flats, the lagoon and reef, or the open sea.
 *
 * Every fish here is real and common in the Bahamas and Caribbean; the facts
 * are true. No drawing in here.
 */

export type FishKind = 'grunt' | 'snapper' | 'jack' | 'bonefish' | 'mahi';

export interface FishInfo {
  name: string;
  /** Days of food once cooked (0 = you let it go). */
  food: number;
  /** How hard it fights, 0..1. */
  strength: number;
  fact: string;
  /** Let go once caught (a sport fish). */
  release?: boolean;
}

export const FISH: Record<FishKind, FishInfo> = {
  grunt: {
    name: 'blue-striped grunt',
    food: 0.3,
    strength: 0.35,
    fact: 'Grunts are named for the noise they make: they grind their teeth together, and the swim bladder makes the sound louder.',
  },
  snapper: {
    name: 'yellowtail snapper',
    food: 0.5,
    strength: 0.5,
    fact: 'Unlike most snappers, yellowtails swim in loose schools well above the reef, and they do most of their feeding at night.',
  },
  jack: {
    name: 'bar jack',
    food: 0.5,
    strength: 0.7,
    fact: 'Bar jacks often follow stingrays as they dig in the sand, snapping up the little animals the rays stir out.',
  },
  bonefish: {
    name: 'bonefish',
    food: 0,
    strength: 0.85,
    release: true,
    fact: 'Bonefish feed on sand flats so shallow their tails break the surface. They are fast, bony and prized for the chase, so anglers almost always let them go.',
  },
  mahi: {
    name: 'mahi-mahi',
    food: 1.5,
    strength: 1,
    fact: 'Mahi-mahi are one of the fastest-growing fish in the sea, and the vivid blue and gold on a freshly caught one fades within minutes.',
  },
};

export const FISH_KINDS = Object.keys(FISH) as FishKind[];

export const FISHING = {
  /** Seconds before a bite: at least this, plus up to `waitSpread` more; a lure shortens both. */
  waitMin: 8,
  waitSpread: 22,
  lure: 0.6,
  /** Seconds you have to strike once the float dips. */
  strikeWindow: 1.3,
  /** Reeling: progress per second while holding, slowed by the fish's strength. */
  reelRate: 0.24,
  /** Line tension: builds while you reel against a running fish, eases when you let go. */
  tensionRun: 0.95,
  tensionPull: 0.2,
  tensionEase: 0.9,
  /** How far the float lands from you (metres). */
  castDistance: 9,
};

/** What's likely to bite where the float lands. */
export function fishHere(place: { depth: number; open: number }, r: number): FishKind {
  let table: [FishKind, number][];
  if (place.open >= 0.5 && place.depth > 8) table = [['mahi', 0.45], ['jack', 0.35], ['snapper', 0.2]];
  else if (place.depth < 1.6) table = [['bonefish', 0.25], ['grunt', 0.45], ['jack', 0.15], ['snapper', 0.15]];
  else table = [['grunt', 0.45], ['snapper', 0.3], ['jack', 0.25]];
  let acc = 0;
  for (const [k, w] of table) {
    acc += w;
    if (r < acc) return k;
  }
  return table[table.length - 1][0];
}

export type Phase = 'idle' | 'waiting' | 'bite' | 'reeling';

export interface FishingState {
  phase: Phase;
  /** Seconds spent in this phase. */
  t: number;
  /** Seconds to wait for a bite. */
  wait: number;
  kind: FishKind;
  /** Reeling: 0 (just hooked) .. 1 (landed); line tension 0..1 (1 snaps). */
  progress: number;
  tension: number;
  /** Is the fish running right now, and for how much longer (or until its next run). */
  running: boolean;
  runT: number;
}

export function newFishing(): FishingState {
  return { phase: 'idle', t: 0, wait: 0, kind: 'grunt', progress: 0, tension: 0, running: false, runT: 0 };
}

/** Cast out: the float is on the water and you wait for a bite. */
export function cast(s: FishingState, kind: FishKind, lure: boolean, rand: () => number): void {
  s.phase = 'waiting';
  s.t = 0;
  s.kind = kind;
  s.wait = (FISHING.waitMin + FISHING.waitSpread * rand()) * (lure ? FISHING.lure : 1);
  s.progress = 0;
  s.tension = 0;
  s.running = false;
  s.runT = 0;
}

/** Reel in without a fish (or give up): back to idle. */
export function reelIn(s: FishingState): void {
  s.phase = 'idle';
  s.t = 0;
}

export type FishingEvent = 'bite' | 'missed' | 'hooked' | 'run' | 'caught' | 'snapped' | null;

/**
 * Advance by dt seconds. `strike` is true on the frame you press (tap) to
 * strike; `reel` is true while you hold to reel.
 */
export function stepFishing(s: FishingState, dt: number, input: { strike: boolean; reel: boolean }, rand: () => number): FishingEvent {
  s.t += dt;
  switch (s.phase) {
    case 'idle':
      return null;
    case 'waiting':
      if (s.t >= s.wait) {
        s.phase = 'bite';
        s.t = 0;
        return 'bite';
      }
      return null;
    case 'bite':
      if (input.strike) {
        s.phase = 'reeling';
        s.t = 0;
        s.progress = 0.05;
        s.tension = 0.1;
        s.running = true;
        s.runT = 0.5 + rand() * (0.6 + FISH[s.kind].strength);
        return 'hooked';
      }
      if (s.t > FISHING.strikeWindow) {
        // Too slow: it took the bait and went. Another nibble before long.
        s.phase = 'waiting';
        s.t = 0;
        s.wait = 4 + rand() * 10;
        return 'missed';
      }
      return null;
    case 'reeling': {
      const st = FISH[s.kind].strength;
      // The fish runs for a moment, then rests, then runs again.
      s.runT -= dt;
      let ev: FishingEvent = null;
      if (s.runT <= 0) {
        s.running = !s.running;
        s.runT = s.running ? 0.5 + rand() * (0.6 + st) : 0.9 + rand() * 1.6 * (1.2 - st);
        if (s.running) ev = 'run';
      }
      if (input.reel) {
        s.progress += FISHING.reelRate * (1 - 0.55 * st * (s.running ? 1 : 0.3)) * dt;
        // Small fish barely strain the line; a big one running can snap it.
        s.tension += (s.running ? 0.15 + FISHING.tensionRun * st * st : FISHING.tensionPull * st) * dt;
      } else {
        s.tension = Math.max(0, s.tension - FISHING.tensionEase * dt);
        // Not reeling, a running fish takes line back.
        if (s.running) s.progress = Math.max(0, s.progress - 0.07 * st * dt);
      }
      if (s.tension >= 1) {
        s.phase = 'idle';
        s.t = 0;
        return 'snapped';
      }
      if (s.progress >= 1) {
        s.phase = 'idle';
        s.t = 0;
        return 'caught';
      }
      return ev;
    }
  }
}
