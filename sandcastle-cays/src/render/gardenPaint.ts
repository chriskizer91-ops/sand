/**
 * Code-painted textures for the garden (DECISIONS 14): small DataTextures,
 * painted once on first use and shared. No canvas, so they also build in
 * Node for the tests (the sign's lettering is the one canvas texture; it
 * lives in garden.ts).
 *
 *   leafAtlas   512 x 256, 4 x 2 cells of 128 px, with alpha for the leaf
 *               shapes (alpha-tested): callaloo leaf (green and red-veined),
 *               tomato compound leaf, sweet potato heart leaf (plain and
 *               lobed with purple veins), tomato flower, seedling leaf, and
 *               a solid cell (stems above, the callaloo plume's florets below).
 *   soil        128 x 128, tiles: dark crumbly earth with grit.
 *   terracotta  256 x 128, wraps around the pot: clay with white mineral
 *               bloom, drip stains, a damp foot and a little moss.
 *   wood        256 x 256 in three bands across v (u repeats): driftwood grain
 *               (v 0..0.5), rusty iron (0.5..0.75), tarp canvas (0.75..1).
 *   spangle     128 x 128, tiles: galvanised zinc crystals (watering can).
 *   stream      16 x 64, tiles: streaks of falling water (alpha).
 */
import * as THREE from 'three';
import { TAU, clamp, fbm, fract, hash, mixC, mulC, noise, paintTexture, smooth, srgb, type C3 } from './finds';

const cache = new Map<string, THREE.DataTexture>();
function once(key: string, make: () => THREE.DataTexture): THREE.DataTexture {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

/** Frees every garden texture (they are painted again on next use). */
export function disposeGardenTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

/** Periodic 2D cellular noise: distance to the nearest jittered point and that point's id. */
function cells2(x: number, y: number, seed: number, px: number, py: number): [number, number] {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ci = xi + i;
      const cj = yi + j;
      const wi = ((ci % px) + px) % px;
      const wj = ((cj % py) + py) % py;
      const cx = ci + 0.1 + 0.8 * hash(wi, wj, seed);
      const cy = cj + 0.1 + 0.8 * hash(wi, wj, seed + 1);
      const d = Math.hypot(x - cx, y - cy);
      if (d < best) {
        best = d;
        id = hash(wi, wj, seed + 2);
      }
    }
  }
  return [best, id];
}

// ---------------------------------------------------------------------------
// The leaf atlas
// ---------------------------------------------------------------------------

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
/** Which atlas cell holds what. */
export const CELL = {
  callaloo: 0,
  callalooRed: 1,
  tomato: 2,
  heart: 3,
  heartLobed: 4,
  flower: 5,
  seedling: 6,
  solid: 7,
} as const;
/**
 * Share of each leaf cell's length (from v = 0) that is bare stalk before the
 * blade (or the first leaflets) starts; the leaf's geometry keeps that part straight.
 */
export const STALK: Record<number, number> = { 0: 0.3, 1: 0.3, 2: 0.18, 3: 0, 4: 0, 5: 0, 6: 0.2, 7: 0 };
/** Width over length of each leaf cell's painted shape, so a leaf quad of length L is this x L wide. */
export const ASPECT: Record<number, number> = { 0: 0.62, 1: 0.62, 2: 0.75, 3: 0.74, 4: 0.74, 5: 1, 6: 0.5, 7: 1 };
/** The heart leaves are blades only (their stalks are drawn as stems): where the stalk joins, as a share of the length. */
export const HEART_JOIN = 0.27;

/** Atlas uv of a point (lu, lv in 0..1) inside a cell. */
export function cellUV(cell: number, lu: number, lv: number): [number, number] {
  const cx = cell % ATLAS_COLS;
  const cy = Math.floor(cell / ATLAS_COLS);
  return [(cx + lu) / ATLAS_COLS, (cy + lv) / ATLAS_ROWS];
}

const EDGE = 1 / 128;
const cover = (d: number): number => smooth(-EDGE, EDGE, d);
/** Well outside a shape: skip the colour work (the colour still matters a little for mipmaps, so keep it leafy). */
const OUT = -4 * EDGE;

/** Callaloo (amaranth) leaf: long stalk, an ovate-rhombic blade with a blunt point, pinnate veins. */
function callalooLeaf(lu: number, lv: number, red: boolean): number[] {
  const x = (lu - 0.5) * ASPECT[0];
  const ax = Math.abs(x);
  // the stalk
  const pw = 0.0115 - 0.004 * lv;
  let d = Math.min(pw - ax, lv - 0.02, 0.36 - lv);
  const t = (lv - 0.28) / 0.69;
  let w = 0;
  if (t > 0 && t < 1) {
    // ovate, widest a little below the middle, tapering to a blunt point
    w = 0.215 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.8) * (1 + 0.12 * smooth(0.25, 0.0, t));
    // a slightly wavy margin
    w *= 1 + 0.025 * Math.sin(t * 31 + (x > 0 ? 1 : 0));
    d = Math.max(d, Math.min(w - ax, (1 - t) * 0.2));
  }
  let c: C3 = red ? srgb(0x3f7430) : srgb(0x468331);
  if (d < OUT) return [...c, 0];
  if (lv < 0.3) {
    c = red ? srgb(0xa84a5c) : srgb(0x8dba5a);
    return [...mulC(c, 0.9 + 0.2 * smooth(pw, 0, ax)), cover(d)];
  }
  const rel = w > 0 ? Math.min(1, ax / w) : 1;
  // lighter in the middle, darker at the margin, gently mottled
  c = mulC(c, (1.1 - 0.22 * rel * rel) * (0.9 + 0.2 * noise(lu * 5, lv * 5, 5)));
  if (red) {
    // a wine-red blush up the middle from the base (like many Caribbean callaloo)
    const blush = smooth(0.55, 0.05, rel) * smooth(0.75, 0.15, t) * 0.75;
    c = mixC(c, srgb(0x6d2a3a), blush);
  }
  // veins: the midrib, and side veins sweeping toward the tip
  const mid = smooth(0.0085 - 0.005 * t, 0.002, ax);
  const s = (lv - 0.28) - 1.1 * ax + 2.2 * ax * ax;
  const q = s / 0.1;
  const dist = Math.abs(q - Math.round(q)) * 0.1;
  const side = 0.6 * smooth(0.009, 0.003, dist) * smooth(0.9, 0.55, rel) * smooth(0.004, 0.02, ax) * smooth(-0.02, 0.03, s);
  // puckering between the veins: a little darker beside them
  const pucker = smooth(0.02, 0.006, dist) * (1 - side) * 0.12;
  c = mulC(c, 1 - pucker);
  const vein = red ? srgb(0xb3324f) : srgb(0xa6cf72);
  c = mixC(c, vein, Math.max(mid, side * 0.75));
  return [...c, cover(d)];
}

/** Tomato leaf: a rachis with three pairs of toothed leaflets, two tiny ones between, and an end leaflet. */
const TOMATO_LEAFLETS: [number, number, number, number, number][] = [
  // [y on the rachis, side, angle from the rachis, length, half-width]
  [0.21, -1, 1.05, 0.23, 0.08],
  [0.25, 1, 1.0, 0.23, 0.08],
  [0.43, -1, 0.95, 0.26, 0.09],
  [0.47, 1, 0.92, 0.26, 0.09],
  [0.63, -1, 0.8, 0.22, 0.08],
  [0.66, 1, 0.78, 0.22, 0.08],
  [0.77, 0, 0, 0.2, 0.085],
  [0.34, -1, 1.25, 0.075, 0.028],
  [0.37, 1, 1.2, 0.07, 0.026],
  [0.56, -1, 1.15, 0.065, 0.025],
];
function tomatoLeaf(lu: number, lv: number): number[] {
  const X = (lu - 0.5) * ASPECT[2];
  const Y = lv;
  const rw = 0.009 * (1 - 0.5 * Y);
  let d = Math.min(rw - Math.abs(X), Y - 0.02, 0.8 - Y);
  let best = -1;
  let ba = 0;
  let bb = 0;
  let bl = 1;
  for (let k = 0; k < TOMATO_LEAFLETS.length; k++) {
    const [yb, side, ang, len, hw] = TOMATO_LEAFLETS[k];
    const dx = side === 0 ? 0 : side * Math.sin(ang);
    const dy = Math.cos(ang);
    const bx = side * 0.008;
    const px = X - bx;
    const py = Y - yb;
    const a = px * dx + py * dy;
    const b = px * dy - py * dx;
    const tn = a / len;
    if (tn <= 0 || tn >= 1) continue;
    const prof = hw * Math.pow(Math.sin(Math.PI * Math.pow(tn, 0.72)), 0.75) * (1 + 0.13 * Math.sin(tn * 27 + k * 1.7) * smooth(0.1, 0.3, tn));
    const dl = Math.min(prof - Math.abs(b), (1 - tn) * len * 0.6, tn * len * 2);
    if (dl > d) {
      d = dl;
      best = k;
      ba = tn;
      bb = b;
      bl = prof;
    }
  }
  let c = srgb(0x3b6d2b);
  if (d < OUT) return [...c, 0];
  if (best < 0) {
    // the rachis (or outside)
    return [...srgb(0x6f9a45), cover(d)];
  }
  const rel = Math.min(1, Math.abs(bb) / Math.max(1e-4, bl));
  // mottled and crinkled (savoyed)
  c = mulC(c, (1.08 - 0.2 * rel * rel) * (0.86 + 0.28 * noise(lu * 9, lv * 9, 9)) * (0.92 + 0.12 * noise(lu * 40, lv * 40, 13)));
  const mid = smooth(0.004, 0.001, Math.abs(bb)) * smooth(0.95, 0.6, ba);
  const s = ba * 6 - Math.abs(bb) * 40;
  const side = smooth(0.12, 0.03, Math.abs(fract(s) - 0.5) * 2 - 0.85) * smooth(0.9, 0.5, rel) * 0.4;
  c = mixC(c, srgb(0x8ab35a), Math.max(mid * 0.8, side * 0.5));
  return [...c, cover(d)];
}

/** Sweet potato leaf: heart-shaped on a long stalk, palmate veins; `lobed` has shallow side lobes and purple veins. */
function heartLeaf(lu: number, lv: number, lobed: boolean): number[] {
  const X = (lu - 0.5) * ASPECT[3];
  const Y = lv;
  const dy = Y - HEART_JOIN;
  const r = Math.hypot(X, dy);
  const th = Math.atan2(Math.abs(X), dy);
  const phi = th / Math.PI;
  let R = 0.7 * (0.47 + 0.53 * Math.exp(-((phi / 0.2) ** 2))) * (1 - smooth(0.8, 1.0, phi));
  if (lobed) R *= 1 - 0.28 * Math.exp(-(((phi - 0.36) / 0.06) ** 2));
  R *= 1 + 0.02 * Math.sin(phi * 40);
  const blade = R - r;
  const d = Math.min(blade, Y - 0.025, 0.985 - Y);
  let c = lobed ? srgb(0x4f8337) : srgb(0x4a8a35);
  if (d < OUT) return [...c, 0];
  const rel = R > 0 ? Math.min(1, r / R) : 1;
  c = mulC(c, (1.08 - 0.18 * rel * rel) * (0.9 + 0.2 * noise(lu * 5, lv * 5, 21)));
  if (lobed) c = mixC(c, srgb(0x6a4a3a), smooth(0.75, 1.0, rel) * 0.45); // bronze edge on young leaves
  // palmate veins from where the stalk joins
  let vein = 0;
  for (const tk of [0, 0.55, 1.15, 1.85, 2.45]) {
    const da = Math.abs(th - tk);
    if (da > Math.PI / 2) continue;
    const dist = r * Math.sin(da);
    const wv = (tk === 0 ? 0.005 : 0.0035) * (1 - 0.5 * rel);
    vein = Math.max(vein, smooth(wv + 0.0055, wv * 0.2, dist) * smooth(0.95, 0.6, rel) * (tk === 0 ? 1 : 0.75));
  }
  const vc = lobed ? mixC(srgb(0x8a4a72), srgb(0x9fc56e), smooth(0.15, 0.6, rel)) : srgb(0x9fc56e);
  c = mixC(c, vc, vein * 0.65);
  return [...c, cover(d)];
}

/** Tomato flower: five pointed yellow petals round an orange cone, green sepals showing between. */
function flower(lu: number, lv: number): number[] {
  const X = lu - 0.5;
  const Y = lv - 0.5;
  const r = Math.hypot(X, Y);
  const th = Math.atan2(Y, X);
  const P = TAU / 5;
  const a = (fract(th / P) - 0.5) * P;
  const b = (fract(th / P + 0.5) - 0.5) * P;
  const rp = 0.07 + 0.36 * Math.pow(1 - Math.abs(a) / (P / 2), 1.5);
  const rs = 0.05 + 0.27 * Math.pow(1 - Math.abs(b) / (P / 2), 3);
  const dp = rp - r;
  const ds = rs - r;
  const d = Math.max(dp, ds);
  let c: C3;
  if (r < 0.08) c = mixC(srgb(0xd49a1c), srgb(0xb9801a), smooth(0.04, 0.0, r));
  else if (dp > -EDGE * 0.5) c = mulC(mixC(srgb(0xe8b51e), srgb(0xf7d847), smooth(0.08, 0.25, r)), 1 - 0.12 * smooth(0.012, 0, Math.abs(a) * r));
  else c = srgb(0x5d8a37);
  return [...c, cover(d)];
}

/** A seedling's first leaf (cotyledon): a smooth oval on a short stalk. */
function seedlingLeaf(lu: number, lv: number): number[] {
  const X = (lu - 0.5) * ASPECT[6];
  const Y = lv;
  let d = Math.min(0.009 - Math.abs(X), Y - 0.02, 0.24 - Y);
  const e = Math.hypot(X / 0.2, (Y - 0.58) / 0.38);
  d = Math.max(d, (1 - e) * 0.18);
  let c = srgb(0x6aa646);
  if (Y < 0.21 && e > 1) c = srgb(0x9bc66a);
  c = mulC(c, 1.08 - 0.2 * Math.min(1, e) ** 2);
  c = mixC(c, srgb(0xa8d27a), smooth(0.006, 0.002, Math.abs(X)) * 0.7);
  return [...c, cover(d)];
}

/** Solid cell: a fine-grained plain area for stems (upper half) and the plume's florets (lower half). */
function solidCell(lu: number, lv: number): number[] {
  if (lv >= 0.5) {
    const g = 0.88 + 0.12 * noise(lu * 24, lv * 24, 31);
    return [g, g, g, 1];
  }
  // tiny round florets packed together, with dark gaps
  const [dd, id] = cells2(lu * 30, lv * 2 * 24, 33, 30, 48);
  const k = (0.45 + 0.55 * smooth(0.62, 0.05, dd)) * (0.8 + 0.4 * id);
  return [k, k * 0.96, k, 1];
}

/**
 * Mipmaps for an alpha-tested texture that keep the same share of texels
 * passing the test (alpha > 0.5) at every size, so thin leaves don't fade
 * away in the distance. Each level is a 2 x 2 box filter; its alpha is then
 * scaled, with the scale found from a histogram (one pass per level).
 */
function coverageMipmaps(t: THREE.DataTexture): void {
  const w0 = t.image.width;
  const h0 = t.image.height;
  const base = t.image.data as Uint8Array;
  let want = 0;
  for (let i = 3; i < base.length; i += 4) if (base[i] > 127) want++;
  want /= w0 * h0;
  const levels: { data: Uint8Array; width: number; height: number }[] = [{ data: base, width: w0, height: h0 }];
  let src = base;
  let sw = w0;
  let sh = h0;
  const hist = new Uint32Array(256);
  while (sw > 1 || sh > 1) {
    const dw = Math.max(1, sw >> 1);
    const dh = Math.max(1, sh >> 1);
    const dst = new Uint8Array(dw * dh * 4);
    hist.fill(0);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.min(sh - 1, y * 2);
      const y1 = Math.min(sh - 1, y * 2 + 1);
      for (let x = 0; x < dw; x++) {
        const x0 = Math.min(sw - 1, x * 2);
        const x1 = Math.min(sw - 1, x * 2 + 1);
        const a = (y0 * sw + x0) * 4;
        const b = (y0 * sw + x1) * 4;
        const c = (y1 * sw + x0) * 4;
        const d = (y1 * sw + x1) * 4;
        const o = (y * dw + x) * 4;
        for (let k = 0; k < 4; k++) dst[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
        hist[dst[o + 3]]++;
      }
    }
    // the alpha threshold t that the same share of texels lies above; then scale alpha so t lands on 0.5
    const n = dw * dh;
    let above = 0;
    let th = 255;
    while (th > 1 && above + hist[th] <= want * n) above += hist[th--];
    const scale = 127.5 / Math.max(1, th - 0.5);
    for (let i = 3; i < dst.length; i += 4) dst[i] = Math.min(255, Math.round(dst[i] * scale));
    levels.push({ data: dst, width: dw, height: dh });
    src = dst;
    sw = dw;
    sh = dh;
  }
  t.mipmaps = levels as unknown as typeof t.mipmaps;
  t.generateMipmaps = false;
  t.needsUpdate = true;
}

/** The leaf atlas (see the header). Built once; about 130k texels, so some tens of milliseconds. */
export function leafAtlas(): THREE.DataTexture {
  return once('leaves', () => {
    const t = paintTexture(
      'garden:leaves',
      512,
      256,
      (u, v) => {
        const cx = Math.min(ATLAS_COLS - 1, Math.floor(u * ATLAS_COLS));
        const cy = Math.min(ATLAS_ROWS - 1, Math.floor(v * ATLAS_ROWS));
        const lu = u * ATLAS_COLS - cx;
        const lv = v * ATLAS_ROWS - cy;
        switch (cy * ATLAS_COLS + cx) {
          case CELL.callaloo:
            return callalooLeaf(lu, lv, false);
          case CELL.callalooRed:
            return callalooLeaf(lu, lv, true);
          case CELL.tomato:
            return tomatoLeaf(lu, lv);
          case CELL.heart:
            return heartLeaf(lu, lv, false);
          case CELL.heartLobed:
            return heartLeaf(lu, lv, true);
          case CELL.flower:
            return flower(lu, lv);
          case CELL.seedling:
            return seedlingLeaf(lu, lv);
          default:
            return solidCell(lu, lv);
        }
      },
      { samples: 1 },
    );
    coverageMipmaps(t);
    return t;
  });
}

// ---------------------------------------------------------------------------
// Soil, clay, wood, zinc and water
// ---------------------------------------------------------------------------

/** Dark crumbly garden soil with a little coral grit and bits of old leaf; tiles both ways. */
export function soilTex(): THREE.DataTexture {
  return once('soil', () =>
    paintTexture(
      'garden:soil',
      128,
      128,
      (u, v) => {
        const [d, id] = cells2(u * 20, v * 20, 101, 20, 20);
        const [d2] = cells2(u * 44 + 0.5, v * 44 + 0.5, 111, 44, 44);
        // crumbs: lighter on their tops, dark in the gaps between
        let k = 0.45 + 0.55 * smooth(0.75, 0.15, d) * (0.75 + 0.35 * id);
        k *= 0.75 + 0.35 * smooth(0.6, 0.2, d2);
        k *= 0.85 + 0.3 * fbm(u * 6, v * 6, 107, 3, 6, 6);
        let c = mixC(srgb(0x2e2017), srgb(0x5a4330), clamp(k, 0, 1.2));
        // grit and bits of dead leaf
        const h = hash(Math.floor(u * 128), Math.floor(v * 128), 109);
        if (h > 0.985) c = mixC(c, srgb(0xcfc3a8), 0.75);
        else if (h > 0.975) c = mixC(c, srgb(0x8a6a3a), 0.6);
        return c;
      },
      { wrapU: true, wrapV: true, samples: 1 },
    ),
  );
}

/**
 * Terracotta, wrapping round the pot: u goes round, v runs up the outside
 * (0 = bottom, 0.82..0.95 = the rim band) and over the top into the inside (1).
 */
export function terracottaTex(): THREE.DataTexture {
  return once('terracotta', () =>
    paintTexture(
      'garden:terracotta',
      256,
      128,
      (u, v) => {
        const n = fbm(u * 6, v * 3, 201, 3, 6, 0);
        let c = mixC(srgb(0xb4603a), srgb(0xd0845a), n);
        // fine sandy grain and faint throwing rings
        c = mulC(c, 0.96 + 0.05 * noise(u * 180, v * 60, 203, 180, 0) + 0.012 * Math.sin(v * 140 + 3 * n));
        // a damp, darker foot with a little moss
        const foot = smooth(0.16, 0.0, v);
        c = mulC(c, 1 - 0.28 * foot);
        if (foot > 0) c = mixC(c, srgb(0x5f6a34), foot * smooth(0.55, 0.75, fbm(u * 14, v * 10, 207, 3, 14, 0)) * 0.85);
        // white mineral bloom: most on the rim band and low on the wall, in soft patches
        const where = 0.15 + 0.85 * Math.max(smooth(0.78, 0.9, v) * smooth(1.0, 0.93, v), smooth(0.4, 0.08, v));
        const bloom = smooth(0.5, 0.78, fbm(u * 7, v * 5, 211, 3, 7, 0)) * where * (0.6 + 0.4 * noise(u * 40, v * 20, 215, 40, 0));
        c = mixC(c, srgb(0xe3d8c4), bloom * 0.5);
        // drips running down from the rim
        const drip = smooth(0.62, 0.85, noise(u * 46, v * 1.5, 213, 46, 0)) * smooth(0.95, 0.4, v) * smooth(0.1, 0.4, v);
        c = mixC(c, mulC(c, 0.8), drip * 0.6);
        // the inside, above the soil, is in shade and darker
        c = mulC(c, 1 - 0.35 * smooth(0.95, 0.99, v));
        return c;
      },
      { wrapU: true, samples: 1 },
    ),
  );
}

/**
 * Weathered wood grain, 0..1 brightness: u runs along the grain (repeats
 * every 1), w across the board (0..1, with worn darker edges).
 */
export function grainAt(u: number, w: number, edges = true): number {
  const warp = 0.5 * fbm(u * 3, w * 2, 47, 2, 3, 0);
  const q = fract(w * 5 + warp);
  let g = 0.82 + 0.18 * fbm(u * 4, w * 14, 41, 3, 4, 0) + 0.06 * (noise(u * 64, w * 40, 43, 64, 0) - 0.5);
  g *= 1 - 0.2 * smooth(0.12, 0.02, Math.abs(q - 0.5));
  const crack = smooth(0.8, 0.9, noise(u * 6, w * 8, 53, 6, 0)) * smooth(0.035, 0.0, Math.abs(fract(w * 3 + warp * 2) - 0.5));
  g *= 1 - 0.5 * crack;
  if (edges) g *= 1 - 0.3 * smooth(0.1, 0.0, w) - 0.3 * smooth(0.9, 1.0, w);
  return g;
}

/** v ranges of the wood texture's three bands (with a little padding inside each). */
export const WOOD_BAND = { grain: [0.01, 0.49], iron: [0.51, 0.74], canvas: [0.76, 0.99] } as const;

/** Driftwood grain, rusty iron and tarp canvas, in bands across v; u repeats (see WOOD_BAND). */
export function woodTex(): THREE.DataTexture {
  return once('wood', () =>
    paintTexture(
      'garden:wood',
      256,
      256,
      (u, v) => {
        if (v < 0.5) {
          const g = grainAt(u, v / 0.5);
          return [g, g * 0.985, g * 0.96];
        }
        if (v < 0.75) {
          const w = (v - 0.5) / 0.25;
          const n = fbm(u * 24, w * 3, 61, 3, 24, 0);
          let c = mixC(srgb(0x4a2c20), srgb(0x8f4d27), smooth(0.3, 0.75, n));
          c = mixC(c, srgb(0xb0652e), smooth(0.7, 0.85, noise(u * 90, w * 8, 63, 90, 0)) * 0.6);
          c = mulC(c, 1 - 0.3 * smooth(0.15, 0.0, w) - 0.3 * smooth(0.85, 1.0, w));
          return c;
        }
        const w = (v - 0.75) / 0.25;
        const weave = 0.5 + 0.5 * Math.sin(u * TAU * 96) * Math.sin(w * TAU * 24);
        let g = 0.86 + 0.07 * weave + 0.12 * (fbm(u * 6, w * 2, 71, 3, 6, 0) - 0.5);
        g *= 0.95 + 0.05 * noise(u * 128, w * 32, 73, 128, 0);
        return [g, g, g];
      },
      { wrapU: true, samples: 1 },
    ),
  );
}

/** Galvanised zinc spangle: big flat crystals, each a slightly different grey; tiles. */
export function spangleTex(): THREE.DataTexture {
  return once('spangle', () =>
    paintTexture(
      'garden:spangle',
      128,
      128,
      (u, v) => {
        const [d, id] = cells2(u * 14, v * 14, 301, 14, 14);
        const [, id2] = cells2(u * 14 + 0.37, v * 14 + 0.61, 303, 14, 14);
        const g = 0.86 + 0.1 * id + 0.04 * (id2 - 0.5) + 0.03 * smooth(0.05, 0.0, Math.abs(d - 0.5)) + 0.04 * (fbm(u * 3, v * 3, 305, 3, 3, 3) - 0.5);
        const fern = 0.02 * Math.sin((u * 14 + v * 14 * (id - 0.5)) * 40);
        return [g + fern, g + fern, g * 1.01 + fern];
      },
      { wrapU: true, wrapV: true, samples: 1 },
    ),
  );
}

/** Streaks of falling water: white, with alpha in broken lines along v; tiles. */
export function streamTex(): THREE.DataTexture {
  return once('stream', () =>
    paintTexture(
      'garden:stream',
      16,
      64,
      (u, v) => {
        const lane = Math.floor(u * 4);
        const x = fract(u * 4) - 0.5;
        const ph = hash(lane, 0, 401);
        const along = fract(v * 3 + ph);
        const seg = smooth(0.0, 0.08, along) * smooth(1.0, 0.75, along);
        const a = smooth(0.45, 0.12, Math.abs(x)) * (0.35 + 0.65 * seg);
        return [1, 1, 1, clamp(a, 0, 1)];
      },
      { wrapU: true, wrapV: true },
    ),
  );
}

