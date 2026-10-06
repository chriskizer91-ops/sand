/**
 * The starting sea floor (WP-B, ARCHITECTURE §1.1). Everything comes from the seed, so the same
 * seed always gives the same sea, and a new game gets a slightly different one.
 *
 *  - The floor: about -30 m, with gentle swells of about ±1.5 m, a little deeper toward the
 *    north-east so the windward side of the zone has a drop-off.
 *  - The ridge: a curved underwater ridge running roughly north-south through the middle. Its
 *    crest is about -7 m and it falls to the floor about 120 m either side (a bit more steeply
 *    on the east, windward, side). Islands built on it get a windward and a lee face.
 *  - Knolls: three or four low hills along the ridge rising to about -2.5 m. They show as paler
 *    water and hint where to start. The one nearest the middle of the zone is "the glow".
 *  - The Shallows: a broad sandy bank (-3 to -6 m, 1-2 m of sand) in the south-west quarter,
 *    for low sand cays and atolls.
 *  - Everywhere: 0.5-2 m of sand over basalt, so scooping the sea floor finds sand first. The
 *    sand is golden, a little darker on the volcanic ridge.
 *
 * The noise is hash-based value noise (no repeating tables), so nothing tiles across the zone.
 */
import { FLOOR_Y, NX, NZ } from '../../config';
import { ChangeFlag, RockKind, type Columns } from '../columns';
import { fbm2, Rng, smoothstep, valueNoise2 } from '../noise';
import { qSed, type Reporter } from './sand';

export interface Knoll {
  x: number;
  z: number;
  /** Height of its top (m). */
  top: number;
  /** Radius where it meets the deep floor (m). Its top stands above the ridge for about a third of that. */
  r: number;
}

/** Where the big features of a sea are (all world metres). Cheap: no columns are touched. */
export interface SeabedLayout {
  /** The ridge line: x = x0 + amp * sin(freq * z + phase) + tilt * z. */
  spine: { x0: number; amp: number; freq: number; phase: number; tilt: number };
  knolls: Knoll[];
  /** The knoll nearest the centre of the zone: the first-minute "Touch the glow" spot. */
  glow: { x: number; z: number };
  /** The Shallows: an ellipse centred at x, z with half-axes rx, rz, turned by `angle`. */
  shallows: { x: number; z: number; rx: number; rz: number; angle: number };
}

/** Ridge crest height (m) before its gentle along-ridge variation. */
const CREST = -7;
/** Distance from the ridge line to its foot on the east (windward) and west (lee) sides (m). */
const RIDGE_EAST = 110;
const RIDGE_WEST = 140;
/** Knolls rise to about this height (m). */
const KNOLL_TOP = -2.5;
/** Height range (m) over which features blend into each other. */
const BLEND = 4;
/** Seed jitter of positions (m). */
const JITTER = 60;

/** Lay out the ridge, knolls and the Shallows for a seed. */
export function seabedLayout(seed: number): SeabedLayout {
  const rng = new Rng(seed ^ 0x5eabed);
  const j = () => rng.range(-JITTER, JITTER);
  const spine = {
    x0: j(),
    amp: rng.range(35, 55),
    freq: (2 * Math.PI) / rng.range(700, 950),
    phase: rng.range(0, 2 * Math.PI),
    tilt: rng.range(-0.1, 0.1),
  };
  const four = rng.next() < 0.5;
  const along = four ? [-330, -110, 110, 330] : [-280, 0, 280];
  const knolls: Knoll[] = along.map((z0) => {
    const z = z0 + j() * 0.8;
    return {
      x: spineX(spine, z) + rng.range(-25, 25),
      z,
      top: KNOLL_TOP + rng.range(-0.4, 0.4),
      r: rng.range(125, 150),
    };
  });
  let glow = knolls[0];
  for (const k of knolls) if (Math.hypot(k.x, k.z) < Math.hypot(glow.x, glow.z)) glow = k;
  const shallows = { x: -270 + j(), z: 265 + j(), rx: rng.range(150, 185), rz: rng.range(115, 145), angle: rng.range(0, Math.PI) };
  return { spine, knolls, glow: { x: glow.x, z: glow.z }, shallows };
}

function spineX(s: SeabedLayout['spine'], z: number): number {
  return s.x0 + s.amp * Math.sin(s.freq * z + s.phase) + s.tilt * z;
}

/**
 * The larger of a and b, but rounded off where they meet (over about `k` metres), so a knoll
 * or bank joins the ridge in a smooth saddle instead of a crease.
 */
function smoothMax(a: number, b: number, k: number): number {
  if (k <= 0) return Math.max(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + (h * h * k) / 4;
}

/** A smooth hump: 1 at t = 0, 0 from t = 1 on, with no kinks (its steepest slope is 1.54 / t-unit). */
function hump(t: number): number {
  if (t >= 1) return 0;
  const u = 1 - t * t;
  return u * u;
}

/**
 * Shape the starting sea floor into every column (rock, sand, kinds; no lava), then report the
 * whole zone as changed. Slopes stay well under what underwater sand can hold (28°), so
 * nothing slides until the player touches it.
 */
export function generateSeabed(cols: Columns, layout: SeabedLayout, seed: number, report: Reporter): void {
  const { spine, knolls, shallows } = layout;
  const ca = Math.cos(shallows.angle);
  const sa = Math.sin(shallows.angle);
  cols.touchRect(0, 0, NX - 1, NZ - 1);
  for (let k = 0; k < NZ; k++) {
    const z = cols.cz(k);
    // Things that depend only on z: the ridge line, its local direction and crest height.
    const sx = spineX(spine, z);
    const dxdz = spine.amp * spine.freq * Math.cos(spine.freq * z + spine.phase) + spine.tilt;
    const across = 1 / Math.sqrt(1 + dxdz * dxdz);
    const crest = CREST + 1.2 * fbm2(z * 0.006, 0.5, 2, seed + 17) - 8 * smoothstep(380, 540, Math.abs(z));
    for (let i = 0; i < NX; i++) {
      const x = cols.cx(i);
      const c = i + k * NX;
      // Floor, deeper toward the north-east (x up, z down).
      const ne = smoothstep(150, 700, (x - z) * Math.SQRT1_2);
      const floor = FLOOR_Y + Math.max(-1.5, Math.min(1.5, 2.2 * fbm2(x * 0.004, z * 0.004, 3, seed))) - 2.5 * ne;
      // The ridge (distance measured across it, east positive).
      const d = (x - sx) * across;
      const ridgeT = d >= 0 ? d / RIDGE_EAST : -d / RIDGE_WEST;
      const ridge = hump(ridgeT);
      let h = floor + (crest - floor) * ridge + 0.6 * ridge * fbm2(x * 0.02, z * 0.02, 2, seed + 29);
      // Knolls: broad seamounts rising from the floor; only their tops stand above the ridge.
      for (const kn of knolls) {
        const t = Math.hypot(x - kn.x, z - kn.z) / kn.r;
        if (t >= 1) continue;
        const w = hump(t);
        h = smoothMax(h, floor + (kn.top - floor) * w, BLEND * w);
      }
      // The Shallows.
      const ex = x - shallows.x;
      const ez = z - shallows.z;
      const st = Math.hypot((ex * ca + ez * sa) / shallows.rx, (-ex * sa + ez * ca) / shallows.rz);
      let bank = 0;
      if (st < 1.6) {
        const level = -4.5 + 1.5 * Math.max(-1, Math.min(1, 1.8 * fbm2(x * 0.007, z * 0.007, 3, seed + 41)));
        bank = 1 - smoothstep(0.7, 1.55, st);
        h = smoothMax(h, floor + (level - floor) * bank, BLEND * bank);
      }
      // Sand over rock: 0.5-2 m, 1-2 m on the Shallows.
      const n1 = valueNoise2(x * 0.008, z * 0.008, seed + 53);
      const sand = Math.max(0.5 + 1.5 * n1, bank > 0.5 ? 1 + n1 + 0.5 * bank : 0);
      cols.sed[c] = qSed(sand);
      cols.rock[c] = h - sand;
      cols.lava[c] = 0;
      cols.temp[c] = 0;
      cols.rockKind[c] = RockKind.Basalt;
      const kind = 150 + 10 * (valueNoise2(x * 0.03, z * 0.03, seed + 61) - 0.5) - 32 * ridge + 18 * bank;
      cols.sandKind[c] = Math.max(0, Math.min(255, Math.round(kind)));
    }
  }
  report(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Look);
}
