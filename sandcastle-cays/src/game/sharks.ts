/**
 * Sharks: where they live, how they swim, and what happens when one comes
 * close. There are three shark waters, each riskier and richer than the last:
 *
 * - the reef gap, where one Caribbean reef shark patrols the channel;
 * - the deep water round the sea buoy, with two reef sharks;
 * - Shark Bank, a sandy shoal where a crowd of nurse sharks rests on the sand.
 *
 * Sharks never hurt you. A curious one circles you, and may come in and bump
 * you with its nose and turn away. If you're in the water, you drop your basket
 * and the sea washes its contents up later. If you're in the dinghy, the bump
 * leaves a dent. Throw a piece of bait and they go after that instead. On the
 * big boat you're out of reach: they just swim by.
 *
 * Everything here is real behaviour, softened. Reef sharks really do come
 * and look at divers, and sometimes bump things to find out what they are.
 * Nurse sharks really do spend the day resting in piles on the sand and hunt
 * at night. No drawing in here.
 */

export type SharkKind = 'reef' | 'nurse';
export type ZoneId = 'gap' | 'buoy' | 'bank';

export interface SharkInfo {
  name: string;
  /** Typical length (metres). */
  length: number;
  /** Swimming speeds (m/s): cruising about, and darting in or away. */
  cruise: number;
  fast: number;
  /** How far away it notices you (metres). */
  notice: number;
  /** How wide it circles you (metres). */
  circle: number;
  /** It keeps to water at least this deep (metres). */
  minDepth: number;
  /** How hard it can turn (radians a second). */
  turn: number;
  fact: string;
}

export const SHARK_INFO: Record<SharkKind, SharkInfo> = {
  reef: {
    name: 'Caribbean reef shark',
    length: 2.2,
    cruise: 0.9,
    fast: 2.6,
    notice: 24,
    circle: 6,
    minDepth: 2.4,
    turn: 0.9,
    fact: 'Caribbean reef sharks patrol the outer edges of coral reefs. They are curious and often come to look at divers, but they very rarely harm anyone.',
  },
  nurse: {
    name: 'nurse shark',
    length: 2.6,
    cruise: 0.45,
    fast: 1.5,
    notice: 8,
    circle: 3.5,
    minDepth: 0.55,
    turn: 0.7,
    fact: 'Nurse sharks hunt at night and spend the day resting on the sand, often piled together in groups. They suck up their food from the sea floor like a vacuum cleaner.',
  },
};

export interface SharkZone {
  id: ZoneId;
  name: string;
  x: number;
  z: number;
  /** How far out from the middle the sharks roam (metres). */
  r: number;
  kind: SharkKind;
  count: number;
  /** 1 (the reef gap) .. 3 (Shark Bank): more sharks, more bumps, better finds and bigger fish. */
  risk: number;
}

export const SHARKS = {
  /** Chance a second, once a shark has noticed you, that it comes over for a look. */
  curious: { reef: 0.22, nurse: 0.05 } as Record<SharkKind, number>,
  /** Seconds it circles you before it decides. */
  circleFor: [9, 18] as [number, number],
  /** Chance it comes in for a bump after circling, by zone risk 1..3. */
  bumpChance: [0, 0.4, 0.55, 0.7],
  /** Walk this close to a resting nurse shark and it startles (metres). */
  startle: 1.6,
  /** A bump: its nose touches you within this distance (metres; from the middle of the dinghy, which is bigger). */
  bumpReach: { swim: 0.7, wade: 0.7, dinghy: 1.5 } as Record<'swim' | 'wade' | 'dinghy', number>,
  /** After a bump it flicks away this sharply (radians), so it doesn't swim through you. */
  veer: 1.4,
  /** After a look (or a bump) it leaves you alone for a while (seconds, shorter in riskier water). */
  cooldown: [70, 120] as [number, number],
  /** A piece of bait keeps them busy this long (seconds), and draws sharks from this far (metres). */
  baitLife: 45,
  baitReach: 60,
  /** How long a nurse shark rests on the sand, and how long it swims between rests (seconds). */
  rest: [40, 140] as [number, number],
  wander: [15, 40] as [number, number],
  /** A curious shark gives up if you get this far beyond the edge of its water (metres). */
  giveUp: 35,
};

export type SharkMood = 'patrol' | 'rest' | 'curious' | 'bump' | 'leave' | 'bait';

export interface Shark {
  id: number;
  kind: SharkKind;
  zone: ZoneId;
  x: number;
  z: number;
  /** Height of its back (metres; negative under the sea). */
  y: number;
  heading: number;
  speed: number;
  /** How hard it's turning right now (radians a second), for the swimming bend. */
  turning: number;
  mood: SharkMood;
  /** Seconds in this mood, and how long it means to stay in it. */
  t: number;
  until: number;
  /** Where it's swimming to. */
  tx: number;
  tz: number;
  /** Seconds before it'll come and look at you again. */
  cool: number;
  /** Which way it circles (1 or -1). */
  side: number;
}

/** Where you are, as far as a shark is concerned. */
export type YouHow = 'swim' | 'wade' | 'dinghy' | 'safe';

export interface SharkWorld {
  /** Sea floor height (negative under water). */
  floorAt(x: number, z: number): number;
  you: { x: number; z: number; how: YouHow };
  /** Bait in the water, with how long ago it was thrown (seconds). */
  bait: { x: number; z: number; age: number }[];
}

export type SharkEvent =
  | { type: 'circling'; shark: Shark }
  | { type: 'bump'; shark: Shark; how: Exclude<YouHow, 'safe'> }
  | { type: 'startled'; shark: Shark }
  | { type: 'baited'; shark: Shark }
  | { type: 'gone'; shark: Shark };

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** The zone you're in (the riskiest one, if two overlap), or null. */
export function zoneAt(zones: SharkZone[], x: number, z: number): SharkZone | null {
  let best: SharkZone | null = null;
  for (const zn of zones) if (Math.hypot(x - zn.x, z - zn.z) <= zn.r && (!best || zn.risk > best.risk)) best = zn;
  return best;
}

/** 0 outside shark waters, else the zone's risk (1..3). */
export function riskAt(zones: SharkZone[], x: number, z: number): number {
  return zoneAt(zones, x, z)?.risk ?? 0;
}

/** Is the water at (x, z) deep enough for this kind? */
function swimmable(w: SharkWorld, kind: SharkKind, x: number, z: number): boolean {
  return -w.floorAt(x, z) >= SHARK_INFO[kind].minDepth;
}

/** A spot in the zone deep enough for this kind (tries a few, else the middle). */
function pickSpot(w: SharkWorld, zn: SharkZone, kind: SharkKind, rand: () => number): { x: number; z: number } {
  for (let i = 0; i < 24; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * zn.r * 0.85;
    const x = zn.x + Math.cos(a) * r;
    const z = zn.z + Math.sin(a) * r;
    if (swimmable(w, kind, x, z)) return { x, z };
  }
  return { x: zn.x, z: zn.z };
}

/** Put the sharks in their waters. */
export function newSharks(zones: SharkZone[], w: SharkWorld, rand: () => number): Shark[] {
  const out: Shark[] = [];
  let id = 1;
  for (const zn of zones) {
    for (let i = 0; i < zn.count; i++) {
      const p = pickSpot(w, zn, zn.kind, rand);
      const t = pickSpot(w, zn, zn.kind, rand);
      const resting = zn.kind === 'nurse' && rand() < 0.7;
      const s: Shark = {
        id: id++,
        kind: zn.kind,
        zone: zn.id,
        x: p.x,
        z: p.z,
        y: 0,
        heading: rand() * Math.PI * 2,
        speed: resting ? 0 : SHARK_INFO[zn.kind].cruise,
        turning: 0,
        mood: resting ? 'rest' : 'patrol',
        t: 0,
        until: resting ? lerp(SHARKS.rest[0], SHARKS.rest[1], rand()) : lerp(SHARKS.wander[0], SHARKS.wander[1], rand()),
        tx: t.x,
        tz: t.z,
        cool: 10 + rand() * 20,
        side: rand() < 0.5 ? 1 : -1,
      };
      s.y = cruiseDepth(w, s);
      out.push(s);
    }
  }
  return out;
}

/** How deep it likes to swim here: reef sharks in mid-water, nurse sharks just over the sand. */
function cruiseDepth(w: SharkWorld, s: Shark): number {
  const floor = w.floorAt(s.x, s.z);
  if (s.kind === 'nurse') return Math.min(-0.3, floor + 0.22);
  return Math.min(-0.9, Math.max(floor + 1.2, -7));
}

function setMood(s: Shark, mood: SharkMood, until: number): void {
  s.mood = mood;
  s.t = 0;
  s.until = until;
}

/** Throwing bait: returns the sharks it will draw (they notice it on the next step). */
export function sharksNear(sharks: Shark[], x: number, z: number, reach: number): Shark[] {
  return sharks.filter((s) => Math.hypot(s.x - x, s.z - z) < reach);
}

/**
 * Advance every shark by dt seconds. Returns what happened, so the game can
 * show it: a shark circling you, a bump, a nurse shark startled off the sand,
 * a shark going for the bait.
 */
export function stepSharks(sharks: Shark[], zones: SharkZone[], w: SharkWorld, dt: number, rand: () => number): SharkEvent[] {
  const ev: SharkEvent[] = [];
  const you = w.you;
  const exposed = you.how !== 'safe';
  const fresh = w.bait.filter((b) => b.age < SHARKS.baitLife);
  for (const s of sharks) {
    const zn = zones.find((z) => z.id === s.zone)!;
    const info = SHARK_INFO[s.kind];
    s.t += dt;
    s.cool = Math.max(0, s.cool - dt);
    const dYou = Math.hypot(you.x - s.x, you.z - s.z);
    const youOut = Math.hypot(you.x - zn.x, you.z - zn.z) - zn.r;

    // Bait in the water beats anything else.
    const bait = fresh.find((b) => Math.hypot(b.x - s.x, b.z - s.z) < SHARKS.baitReach);
    if (bait && s.mood !== 'bait') {
      setMood(s, 'bait', SHARKS.baitLife);
      ev.push({ type: 'baited', shark: s });
    }

    let wantSpeed = info.cruise;
    let wantY = cruiseDepth(w, s);
    switch (s.mood) {
      case 'rest': {
        wantSpeed = 0;
        if (exposed && dYou < SHARKS.startle) {
          // You walked right up to it: it shoots off, and might bump your legs on the way.
          ev.push({ type: 'startled', shark: s });
          if ((you.how === 'swim' || you.how === 'wade') && rand() < SHARKS.bumpChance[zn.risk]) ev.push({ type: 'bump', shark: s, how: you.how });
          s.heading = Math.atan2(s.z - you.z, s.x - you.x);
          away(w, s, zn, you, rand);
          break;
        }
        if (s.t > s.until) {
          const p = pickSpot(w, zn, s.kind, rand);
          s.tx = p.x;
          s.tz = p.z;
          setMood(s, 'patrol', lerp(SHARKS.wander[0], SHARKS.wander[1], rand()));
        }
        break;
      }
      case 'patrol': {
        if (Math.hypot(s.tx - s.x, s.tz - s.z) < 4 || s.t > s.until) {
          if (s.kind === 'nurse' && rand() < 0.6) {
            setMood(s, 'rest', lerp(SHARKS.rest[0], SHARKS.rest[1], rand()));
            break;
          }
          const p = pickSpot(w, zn, s.kind, rand);
          s.tx = p.x;
          s.tz = p.z;
          s.t = 0;
          s.until = lerp(SHARKS.wander[0], SHARKS.wander[1], rand());
        }
        if (exposed && s.cool <= 0 && dYou < info.notice && youOut < 10 && rand() < SHARKS.curious[s.kind] * dt) {
          setMood(s, 'curious', lerp(SHARKS.circleFor[0], SHARKS.circleFor[1], rand()));
          s.side = rand() < 0.5 ? 1 : -1;
          ev.push({ type: 'circling', shark: s });
        }
        break;
      }
      case 'curious': {
        // Circle you, closing in a little, up near the surface so its fin shows.
        const a = Math.atan2(s.z - you.z, s.x - you.x) + s.side * 0.55;
        const r = info.circle * (1 - 0.25 * Math.min(1, s.t / s.until));
        s.tx = you.x + Math.cos(a) * r;
        s.tz = you.z + Math.sin(a) * r;
        wantSpeed = lerp(info.cruise, info.fast, 0.35);
        if (s.kind === 'reef') wantY = -0.2;
        if (!exposed || youOut > SHARKS.giveUp) {
          away(w, s, zn, you, rand);
          break;
        }
        if (s.t > s.until) {
          if (rand() < SHARKS.bumpChance[zn.risk]) setMood(s, 'bump', 8);
          else away(w, s, zn, you, rand);
        }
        break;
      }
      case 'bump': {
        s.tx = you.x;
        s.tz = you.z;
        wantSpeed = info.fast;
        if (s.kind === 'reef') wantY = -0.45;
        if (!exposed || youOut > SHARKS.giveUp) {
          away(w, s, zn, you, rand);
          break;
        }
        const nx = s.x + Math.cos(s.heading) * info.length * 0.45;
        const nz = s.z + Math.sin(s.heading) * info.length * 0.45;
        if (Math.hypot(you.x - nx, you.z - nz) < SHARKS.bumpReach[you.how as Exclude<YouHow, 'safe'>]) {
          ev.push({ type: 'bump', shark: s, how: you.how as Exclude<YouHow, 'safe'> });
          // A flick of the tail and it's away.
          s.heading = wrapAngle(s.heading + s.side * SHARKS.veer);
          away(w, s, zn, you, rand);
        } else if (s.t > s.until) away(w, s, zn, you, rand);
        break;
      }
      case 'leave': {
        wantSpeed = s.t < 4 ? info.fast : info.cruise;
        if (s.t > s.until || Math.hypot(s.tx - s.x, s.tz - s.z) < 4) {
          setMood(s, 'patrol', lerp(SHARKS.wander[0], SHARKS.wander[1], rand()));
          ev.push({ type: 'gone', shark: s });
        }
        break;
      }
      case 'bait': {
        const b = bait ?? fresh.find((bb) => Math.hypot(bb.x - s.x, bb.z - s.z) < SHARKS.baitReach * 1.5);
        if (!b) {
          away(w, s, zn, you, rand, 40);
          break;
        }
        // Nose about round the bait.
        const a = Math.atan2(s.z - b.z, s.x - b.x) + s.side * 0.8;
        s.tx = b.x + Math.cos(a) * 1.8;
        s.tz = b.z + Math.sin(a) * 1.8;
        wantSpeed = Math.hypot(b.x - s.x, b.z - s.z) > 6 ? info.fast * 0.7 : info.cruise * 0.8;
        wantY = s.kind === 'reef' ? -1.2 : wantY;
        break;
      }
    }

    // Steer toward the target, never into water too shallow for it.
    let want = Math.atan2(s.tz - s.z, s.tx - s.x);
    const ahead = Math.max(2.5, s.speed * 2.5);
    if (s.speed > 0.05 && !swimmable(w, s.kind, s.x + Math.cos(s.heading) * ahead, s.z + Math.sin(s.heading) * ahead)) {
      // Shallows ahead: turn whichever way is deeper.
      const l = s.heading + 0.9;
      const r = s.heading - 0.9;
      const dl = -w.floorAt(s.x + Math.cos(l) * ahead, s.z + Math.sin(l) * ahead);
      const dr = -w.floorAt(s.x + Math.cos(r) * ahead, s.z + Math.sin(r) * ahead);
      want = dl > dr ? l : r;
      if (s.mood === 'patrol') {
        const p = pickSpot(w, zn, s.kind, rand);
        s.tx = p.x;
        s.tz = p.z;
      }
    }
    const diff = wrapAngle(want - s.heading);
    const maxTurn = info.turn * (0.4 + 0.6 * Math.min(1, s.speed / info.cruise)) * dt;
    const turn = s.speed > 0.02 ? Math.max(-maxTurn, Math.min(maxTurn, diff)) : 0;
    s.heading = wrapAngle(s.heading + turn);
    s.turning = lerp(s.turning, dt > 0 ? turn / dt : 0, Math.min(1, dt * 3));
    s.speed = lerp(s.speed, wantSpeed, Math.min(1, dt * (wantSpeed > s.speed ? 1.2 : 0.8)));
    const nx = s.x + Math.cos(s.heading) * s.speed * dt;
    const nz = s.z + Math.sin(s.heading) * s.speed * dt;
    if (swimmable(w, s.kind, nx, nz)) {
      s.x = nx;
      s.z = nz;
    } else if (s.mood !== 'rest') s.speed *= 0.5;
    const floorY = w.floorAt(s.x, s.z);
    s.y = lerp(s.y, Math.max(floorY + 0.18, Math.min(-0.2, wantY)), Math.min(1, dt * 0.8));
  }
  return ev;
}

/** Swim off to the far side of the zone and leave you be for a while. */
function away(w: SharkWorld, s: Shark, zn: SharkZone, you: { x: number; z: number }, rand: () => number, cool?: number): void {
  const a = Math.atan2(zn.z - you.z, zn.x - you.x) + (rand() - 0.5) * 1.2;
  let x = zn.x + Math.cos(a) * zn.r * 0.7;
  let z = zn.z + Math.sin(a) * zn.r * 0.7;
  if (!swimmable(w, s.kind, x, z)) ({ x, z } = pickSpot(w, zn, s.kind, rand));
  s.tx = x;
  s.tz = z;
  const risk = Math.max(1, zn.risk);
  s.cool = cool ?? lerp(SHARKS.cooldown[0], SHARKS.cooldown[1], rand()) / (0.7 + 0.3 * risk);
  setMood(s, 'leave', 30);
}

/** For the wake drawing: is its dorsal fin out of the water? (back height + fin height above the sea) */
export function finUp(s: Shark, seaY = 0): boolean {
  const fin = s.kind === 'reef' ? 0.32 : 0.22;
  return s.y + fin > seaY - 0.02;
}

/** Anything to save? Sharks are put back in their waters on loading, so only the cooldowns matter. Nothing kept. */
export function sharkLine(s: Shark): string {
  return `${SHARK_INFO[s.kind].name} (${s.mood})`;
}
