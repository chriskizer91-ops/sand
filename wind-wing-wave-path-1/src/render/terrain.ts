/**
 * The land (ARCHITECTURE §6.4, DECISIONS 3): drawn by the graphics chip straight from the height map.
 *
 * How it works, in plain words:
 * - There is ONE small grid patch (32 x 32 squares). The land is that same patch drawn many times
 *   ("instances"), each copy stretched over one square of a quadtree: 64 m squares near the camera
 *   (one vertex per 2 m column, the full detail of the world), 128 m, 256 m and 512 m squares further
 *   out, and 1024 m squares far away. Every copy has the same number of triangles, so the detail on
 *   screen stays about even: near things get small triangles, far things big ones.
 * - The graphics chip lifts every vertex to the height it reads from the height map, so nothing is
 *   rebuilt when the land changes: the engine only sends new heights (a few kilobytes for lava).
 * - The grid's little squares are cut into triangles like a chessboard (the diagonal alternates), so a
 *   sheer step between two columns looks the same whichever way it runs, rather than turning into a
 *   row of sharp fins along one diagonal direction.
 * - Toward the far end of each level's range, every in-between vertex slides smoothly onto the next
 *   coarser grid ("geomorphing", from the CDLOD method), ending exactly on that grid's own triangles,
 *   so detail never pops; where squares of different sizes meet, both put their edge vertices in
 *   exactly the same places, so no crack can open (tests/terrain.test.ts replays both on the CPU).
 * - Every square also hangs a short curtain ("skirt") below its edges, a safety net against any
 *   hairline gap from rounding.
 * - Beyond the 1 km zone the edge of the world falls gently into the deep, under the (opaque) sea,
 *   and flat deep floor carries on to the horizon (a ring of eight huge flat squares).
 *
 * Each frame the CPU picks the squares (no allocation), culls those outside the view and writes them
 * into one instance buffer: the whole land is one draw call. A second, shadow-only copy of the same
 * geometry draws the squares inside the sun's shadow box, so hills behind the camera still cast
 * shadows into view (one more draw in the shadow pass, none in the main pass).
 */
import * as THREE from 'three';
import { CELL, NX, NZ } from '../config';
import type { FrameCtx, PageSystem, Quality, SystemDeps } from './shared';
import { DEEP_Y, FALL, GRID_N, GRID_X0, GRID_Z0, createTerrainDepthMaterial, createTerrainMaterial, type TerrainUniforms } from './terrainMaterial';

export { DEEP_Y, FALL, GRID_N, GRID_X0, GRID_Z0 };

// ---------- the quadtree's shape ----------

/** Levels: 0 (64 m nodes, 2 m vertex spacing) .. 4 (one node covers the whole 1024 m zone). */
export const LEVELS = 5;
/** Size of a level-0 node (m): one vertex per column. */
export const LEAF_SIZE = GRID_N * CELL;
/** Size of a top-level node (m): the whole zone. */
export const ROOT_SIZE = LEAF_SIZE * (1 << (LEVELS - 1));
/** The flat deep floor beyond the apron: eight squares this big (m) around the 3 x 3 top-level ones. */
export const OUTER_SIZE = 3 * ROOT_SIZE;
/**
 * The level those squares are drawn with. They are flat and their grid doesn't line up with the
 * quadtree's, so they must never morph: at this level the morph would only start r0 x 2^24 metres
 * away (thousands of kilometres), far beyond any far plane.
 */
export const NO_MORPH_LEVEL = 24;
/** Level-0 nodes per zone side. */
const LEAVES = NX / GRID_N;
/** World x/z of the last column centre (the far edge of the height samples). */
const SAMPLES_X1 = GRID_X0 + (NX - 1) * CELL;
const SAMPLES_Z1 = GRID_Z0 + (NZ - 1) * CELL;
/** Triangles in one drawn node: the grid plus its four edge skirts. */
export const TRIS_PER_NODE = GRID_N * GRID_N * 2 + 4 * GRID_N * 2;
/** The morph toward the coarser grid starts at this fraction of each level's range. */
export const MORPH_START = 0.7;

/** Decides whether a box can be seen (by the camera, or by the sun for shadows). */
export interface NodeCuller {
  visible(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean;
}

/** Where the selection is written: per node (x0, z0, size, level) and the skirt depth. */
export interface NodeList {
  readonly nodes: Float32Array;
  readonly skirts: Float32Array;
  count: number;
  /** More nodes were wanted than fit (the caller should coarsen the ranges). */
  overflow: boolean;
}

export function makeNodeList(capacity: number): NodeList {
  return { nodes: new Float32Array(capacity * 4), skirts: new Float32Array(capacity), count: 0, overflow: false };
}

/**
 * The CPU half of the terrain: a min/max height pyramid over the zone (for bounding boxes) and the
 * per-frame node selection. Pure data, no WebGL, so it is unit-tested directly.
 */
export class TerrainLod {
  /** Per level: lowest and highest height inside each node (with a one-sample border). */
  private readonly minH: Float32Array[] = [];
  private readonly maxH: Float32Array[] = [];
  private readonly dirty = new Uint8Array(LEAVES * LEAVES);
  private anyDirty = true;
  /** Highest height on the zone's outer edge (bounds the land falling away outside). */
  private borderMax = DEEP_Y;
  /** Range of each level (m): a node of level L is used out to ranges[L] from the camera. */
  readonly ranges = new Float64Array(LEVELS);

  // Selection state (fields, so the recursion allocates nothing).
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private culler: NodeCuller | null = null;
  private out: NodeList = makeNodeList(0);

  constructor() {
    for (let l = 0; l < LEVELS; l++) {
      const n = (LEAVES >> l) * (LEAVES >> l);
      this.minH.push(new Float32Array(n));
      this.maxH.push(new Float32Array(n));
    }
    this.dirty.fill(1);
  }

  /** Columns in this rectangle changed: their level-0 nodes need new bounds. */
  markCols(x0: number, z0: number, w: number, h: number): void {
    // A node owns samples 32i .. 32i+32 (the last one shared with its neighbour).
    const i0 = Math.max(0, Math.floor((x0 - 1) / GRID_N));
    const k0 = Math.max(0, Math.floor((z0 - 1) / GRID_N));
    const i1 = Math.min(LEAVES - 1, Math.floor((x0 + w - 1) / GRID_N));
    const k1 = Math.min(LEAVES - 1, Math.floor((z0 + h - 1) / GRID_N));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) this.dirty[i + k * LEAVES] = 1;
    this.anyDirty = true;
  }

  /** Recompute the bounds of changed nodes from the height mirror. */
  refresh(surf: Float32Array): void {
    if (!this.anyDirty) return;
    this.anyDirty = false;
    let border = false;
    const mn0 = this.minH[0];
    const mx0 = this.maxH[0];
    for (let k = 0; k < LEAVES; k++) {
      for (let i = 0; i < LEAVES; i++) {
        const leaf = i + k * LEAVES;
        if (!this.dirty[leaf]) continue;
        this.dirty[leaf] = 0;
        if (i === 0 || k === 0 || i === LEAVES - 1 || k === LEAVES - 1) border = true;
        let lo = Infinity;
        let hi = -Infinity;
        const ze = Math.min(NZ - 1, k * GRID_N + GRID_N);
        const xe = Math.min(NX - 1, i * GRID_N + GRID_N);
        for (let z = k * GRID_N; z <= ze; z++) {
          const row = z * NX;
          for (let x = i * GRID_N; x <= xe; x++) {
            const v = surf[row + x];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        mn0[leaf] = lo;
        mx0[leaf] = hi;
      }
    }
    // Upper levels: a parent spans its four children.
    for (let l = 1; l < LEVELS; l++) {
      const n = LEAVES >> l;
      const mn = this.minH[l];
      const mx = this.maxH[l];
      const cmn = this.minH[l - 1];
      const cmx = this.maxH[l - 1];
      for (let k = 0; k < n; k++) {
        for (let i = 0; i < n; i++) {
          const c = 2 * i + 2 * k * 2 * n;
          const c2 = c + 2 * n;
          mn[i + k * n] = Math.min(cmn[c], cmn[c + 1], cmn[c2], cmn[c2 + 1]);
          mx[i + k * n] = Math.max(cmx[c], cmx[c + 1], cmx[c2], cmx[c2 + 1]);
        }
      }
    }
    if (border) {
      let b = DEEP_Y;
      for (let x = 0; x < NX; x++) b = Math.max(b, surf[x], surf[x + (NZ - 1) * NX]);
      for (let z = 0; z < NZ; z++) b = Math.max(b, surf[z * NX], surf[NX - 1 + z * NX]);
      this.borderMax = b;
    }
  }

  /** Height bounds of a zone node (lowest, highest). */
  bounds(level: number, ix: number, iz: number): [number, number] {
    const n = LEAVES >> level;
    return [this.minH[level][ix + iz * n], this.maxH[level][ix + iz * n]];
  }

  /**
   * Pick the nodes to draw for a camera at (cx, cy, cz): the CDLOD selection. A node is split while
   * the camera is within the next finer level's range of its bounding box, so each level covers a
   * band of distances and triangles keep about the same size on screen. `r0` is the range of the
   * finest level (each coarser level doubles it). Nodes are written nearest first (cheaper drawing).
   */
  select(cx: number, cy: number, cz: number, r0: number, culler: NodeCuller | null, out: NodeList): void {
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.culler = culler;
    this.out = out;
    out.count = 0;
    out.overflow = false;
    for (let l = 0; l < LEVELS; l++) this.ranges[l] = r0 * (1 << l);
    const top = LEVELS - 1;
    // The zone first (nearest to most views), then the apron of eight squares around it, then the
    // flat deep floor out to the horizon.
    this.visit(top, GRID_X0, GRID_Z0, 0, 0, true);
    for (let rz = -1; rz <= 1; rz++) {
      for (let rx = -1; rx <= 1; rx++) {
        if (rx === 0 && rz === 0) continue;
        this.visit(top, GRID_X0 + rx * ROOT_SIZE, GRID_Z0 + rz * ROOT_SIZE, 0, 0, false);
      }
    }
    for (let rz = -1; rz <= 1; rz++) {
      for (let rx = -1; rx <= 1; rx++) {
        if (rx === 0 && rz === 0) continue;
        const x0 = GRID_X0 - ROOT_SIZE + rx * OUTER_SIZE;
        const z0 = GRID_Z0 - ROOT_SIZE + rz * OUTER_SIZE;
        if (!culler || culler.visible(x0, DEEP_Y, z0, x0 + OUTER_SIZE, DEEP_Y, z0 + OUTER_SIZE)) this.emit(x0, z0, OUTER_SIZE, NO_MORPH_LEVEL, 2);
      }
    }
    this.culler = null;
  }

  /**
   * select(), coarsening every range in 15% steps until at most maxNodes are chosen (the triangle
   * budget). Returns the finest level's range actually used (the shader must morph with the same).
   */
  selectWithin(cx: number, cy: number, cz: number, r0: number, culler: NodeCuller | null, out: NodeList, maxNodes: number): number {
    let r = r0;
    this.select(cx, cy, cz, r, culler, out);
    for (let tries = 0; tries < 8 && (out.overflow || out.count > maxNodes); tries++) {
      r *= 0.85;
      this.select(cx, cy, cz, r, culler, out);
    }
    // Last resort (never reached at sane budgets): keep the nearest nodes, which were chosen first.
    if (out.count > maxNodes) out.count = maxNodes;
    return r;
  }

  private visit(level: number, x0: number, z0: number, ix: number, iz: number, zone: boolean): void {
    const size = LEAF_SIZE * (1 << level);
    const x1 = x0 + size;
    const z1 = z0 + size;
    let lo: number;
    let hi: number;
    let flat = false;
    if (zone) {
      const n = LEAVES >> level;
      lo = this.minH[level][ix + iz * n];
      hi = this.maxH[level][ix + iz * n];
    } else {
      // Outside the zone: the edge heights falling toward DEEP_Y; flat once FALL away from the zone.
      const ox = Math.max(GRID_X0 - x1, 0, x0 - SAMPLES_X1);
      const oz = Math.max(GRID_Z0 - z1, 0, z0 - SAMPLES_Z1);
      flat = ox * ox + oz * oz >= FALL * FALL;
      lo = DEEP_Y;
      hi = flat ? DEEP_Y : this.borderMax;
    }
    if (this.culler && !this.culler.visible(x0, lo, z0, x1, hi, z1)) return;
    const dx = Math.max(x0 - this.cx, 0, this.cx - x1);
    const dy = Math.max(lo - this.cy, 0, this.cy - hi);
    const dz = Math.max(z0 - this.cz, 0, this.cz - z1);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (level === 0 || flat || d2 > this.ranges[level - 1] * this.ranges[level - 1]) {
      // Neighbours meet exactly (see the shader's geomorph), so the skirt only has to hide hairline
      // gaps; a few grid squares deep is plenty, and keeps the hidden curtains cheap to draw.
      this.emit(x0, z0, size, level, flat ? 2 : Math.min(hi - lo, (4 * size) / GRID_N) + 1);
      return;
    }
    // Children, nearest first: the quadrant holding the camera, then its neighbours, then the far one.
    const half = size / 2;
    const qx = this.cx >= x0 + half ? 1 : 0;
    const qz = this.cz >= z0 + half ? 1 : 0;
    const l = level - 1;
    this.visit(l, x0 + qx * half, z0 + qz * half, ix * 2 + qx, iz * 2 + qz, zone);
    this.visit(l, x0 + (1 - qx) * half, z0 + qz * half, ix * 2 + 1 - qx, iz * 2 + qz, zone);
    this.visit(l, x0 + qx * half, z0 + (1 - qz) * half, ix * 2 + qx, iz * 2 + 1 - qz, zone);
    this.visit(l, x0 + (1 - qx) * half, z0 + (1 - qz) * half, ix * 2 + 1 - qx, iz * 2 + 1 - qz, zone);
  }

  private emit(x0: number, z0: number, size: number, level: number, skirt: number): void {
    const out = this.out;
    if (out.count * 4 >= out.nodes.length) {
      out.overflow = true;
      return;
    }
    const o = out.count * 4;
    out.nodes[o] = x0;
    out.nodes[o + 1] = z0;
    out.nodes[o + 2] = size;
    out.nodes[o + 3] = level;
    out.skirts[out.count] = skirt;
    out.count++;
  }
}

/** A culler from a view-projection matrix (camera or sun), with an optional safety margin (m). */
export class FrustumCuller implements NodeCuller {
  readonly frustum = new THREE.Frustum();
  margin = 0;
  private box = new THREE.Box3();

  setFromMatrix(viewProjection: THREE.Matrix4): void {
    this.frustum.setFromProjectionMatrix(viewProjection);
  }

  visible(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const m = this.margin;
    this.box.min.set(x0 - m, y0 - m, z0 - m);
    this.box.max.set(x1 + m, y1 + m, z1 + m);
    return this.frustum.intersectsBox(this.box);
  }
}

// ---------- the shared patch ----------

/**
 * Which way grid square (i, j) is cut into two triangles. Squares alternate like a chessboard: even
 * squares from their (i, j) corner to (i+1, j+1), odd squares the other way. With every square cut the
 * same way, a sheer step running along that one diagonal became a row of sharp fins; alternating
 * treats both diagonal directions alike. Around the middle of every 2 x 2 block the four cuts form an
 * X, which is what lets a fully morphed grid become exactly the coarser chessboard (the shader's
 * geomorph rule; tests/terrain.test.ts replays it). Square indices count from the zone's grid origin;
 * every node starts on a multiple of 32 squares, so a node's own indices have the same parity.
 */
export function cutsForward(i: number, j: number): boolean {
  return ((i + j) & 1) === 0;
}

/**
 * The one grid patch every node draws: (N+1)^2 vertices at (u, 0, v) for u, v in 0..1, plus a ring of
 * skirt vertices (y = 1 marks "hang below the edge"). Triangles face up (counter-clockwise seen from
 * above), cut in the chessboard pattern of cutsForward(). Skirts face outward.
 */
export function buildPatchGeometry(): { positions: Float32Array; index: Uint16Array } {
  const N = GRID_N;
  const side = N + 1;
  const ringCount = 4 * N;
  const positions = new Float32Array((side * side + ringCount) * 3);
  let p = 0;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      positions[p++] = i / N;
      positions[p++] = 0;
      positions[p++] = j / N;
    }
  }
  // The edge, walked once around: (i, j) grid coordinates of each ring vertex.
  const ring: number[] = [];
  for (let i = 0; i < N; i++) ring.push(i, 0); // north edge, west to east
  for (let j = 0; j < N; j++) ring.push(N, j); // east edge, north to south
  for (let i = N; i > 0; i--) ring.push(i, N); // south edge, east to west
  for (let j = N; j > 0; j--) ring.push(0, j); // west edge, south to north
  const skirtBase = side * side;
  for (let r = 0; r < ringCount; r++) {
    positions[p++] = ring[r * 2] / N;
    positions[p++] = 1;
    positions[p++] = ring[r * 2 + 1] / N;
  }
  const index = new Uint16Array(N * N * 6 + ringCount * 6);
  let q = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      // a b    (i grows to the east, j to the south)
      // c d
      const a = i + j * side;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      if (cutsForward(i, j)) {
        // Cut a-d.
        index[q++] = a;
        index[q++] = c;
        index[q++] = d;
        index[q++] = a;
        index[q++] = d;
        index[q++] = b;
      } else {
        // Cut b-c.
        index[q++] = a;
        index[q++] = c;
        index[q++] = b;
        index[q++] = b;
        index[q++] = c;
        index[q++] = d;
      }
    }
  }
  // Each skirt quad joins two neighbouring edge vertices to their copies below.
  for (let r = 0; r < ringCount; r++) {
    const r2 = (r + 1) % ringCount;
    const top0 = ring[r * 2] + ring[r * 2 + 1] * side;
    const top1 = ring[r2 * 2] + ring[r2 * 2 + 1] * side;
    const bot0 = skirtBase + r;
    const bot1 = skirtBase + r2;
    // The ring runs clockwise seen from above, so (top0, top1, bot0) faces outward.
    index[q++] = top0;
    index[q++] = top1;
    index[q++] = bot0;
    index[q++] = top1;
    index[q++] = bot1;
    index[q++] = bot0;
  }
  return { positions, index };
}

// ---------- the page system ----------

/** Most nodes the instance buffers can hold (the triangle budget usually stops far sooner). */
const CAPACITY = 512;

/** Triangle budget for the land in the main view, by device and quality (ARCHITECTURE §7). */
export function triangleBudget(q: Quality): number {
  if (q.phone) return 150_000;
  return q.tier === 2 ? 360_000 : q.tier === 1 ? 240_000 : 150_000;
}
/**
 * The land's share of the shadow pass (ARCHITECTURE §7 allows 100k triangles in all on the Pixel).
 * On the phone the land takes about half, leaving the rest for the plants near the camera (WP-F);
 * laptops take 70k, leaving 30k for the plants and animals that cast shadows up close. (At the
 * whole 100k the pass reached 103k in a low close-up over a grown island, past its budget.)
 */
export function shadowTriangleBudget(q: Quality): number {
  return q.phone ? 55_000 : 70_000;
}

/**
 * Range of the finest level (m), from the wanted on-screen size of one grid square at the far end of
 * its range (smaller is sharper but costs triangles), the screen height in pixels and the field of
 * view: so the land looks equally detailed on any screen, and every coarser level (double the
 * spacing, double the range) keeps the same on-screen size.
 */
export function finestRange(q: Quality, screenPx: number, fovDeg: number): number {
  const squarePx = q.phone ? (q.tier === 2 ? 13 : q.tier === 1 ? 16 : 22) : q.tier === 2 ? 10 : q.tier === 1 ? 14 : 20;
  const pxPerRadian = screenPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  return Math.max(48, Math.min(480, (CELL * pxPerRadian) / squarePx));
}

/** Live numbers for checks and screenshots (read through scene.getObjectByName('terrain').userData.lod). */
export interface TerrainStats {
  nodes: number;
  triangles: number;
  shadowNodes: number;
  shadowTriangles: number;
  /** Range of the finest level (m) this frame. */
  r0: number;
  /** Below 1 when the budget forced coarser ranges. */
  rangeScale: number;
}

export function createTerrain(deps: SystemDeps): PageSystem {
  const { scene, fields, u, renderer } = deps;

  const lod = new TerrainLod();
  const onCols = (x0: number, z0: number, w: number, h: number): void => lod.markCols(x0, z0, w, h);
  fields.onCols.push(onCols);

  // Geometry: one patch shared by the main and the shadow-only copies.
  const patch = buildPatchGeometry();
  const position = new THREE.BufferAttribute(patch.positions, 3);
  const index = new THREE.BufferAttribute(patch.index, 1);
  const makeGeometry = (list: NodeList): { geo: THREE.InstancedBufferGeometry; node: THREE.InstancedBufferAttribute; skirt: THREE.InstancedBufferAttribute } => {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', position);
    geo.setIndex(index);
    const node = new THREE.InstancedBufferAttribute(list.nodes, 4);
    node.setUsage(THREE.DynamicDrawUsage);
    const skirt = new THREE.InstancedBufferAttribute(list.skirts, 1);
    skirt.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aNode', node);
    geo.setAttribute('aSkirt', skirt);
    geo.instanceCount = 0;
    // Never culled by three (we cull per node); the sphere (everything drawn) is only for tools that ask.
    const half = ROOT_SIZE / 2 + OUTER_SIZE;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(GRID_X0 + ROOT_SIZE / 2, 0, GRID_Z0 + ROOT_SIZE / 2), half * Math.SQRT2);
    return { geo, node, skirt };
  };

  const mainList = makeNodeList(CAPACITY);
  const shadowList = makeNodeList(CAPACITY);
  const main = makeGeometry(mainList);
  const shadow = makeGeometry(shadowList);

  const tu: TerrainUniforms = {
    uLod: { value: new THREE.Vector2(160, MORPH_START) },
    uLodShadow: { value: new THREE.Vector2(160, MORPH_START) },
    uNoiseOrigin: { value: new THREE.Vector3() },
  };
  const material = createTerrainMaterial(u, tu);
  const depthMaterial = createTerrainDepthMaterial(u, tu);

  const mesh = new THREE.Mesh(main.geo, material);
  mesh.name = 'terrain';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false; // the land is drawn in world coordinates
  scene.add(mesh);

  // The shadow-only copy: nothing in the main pass (zero instances), the sun's selection in the shadow pass.
  const shadowMesh = new THREE.Mesh(shadow.geo, material);
  shadowMesh.name = 'terrain-shadow';
  shadowMesh.frustumCulled = false;
  shadowMesh.castShadow = true;
  shadowMesh.receiveShadow = false;
  shadowMesh.matrixAutoUpdate = false;
  shadowMesh.customDepthMaterial = depthMaterial;
  scene.add(shadowMesh);

  const stats: TerrainStats = { nodes: 0, triangles: 0, shadowNodes: 0, shadowTriangles: 0, r0: 0, rangeScale: 1 };
  mesh.userData.lod = stats;

  // The sun's view from the last shadow pass (the light belongs to daylight; we just watch it).
  const sunCuller = new FrustumCuller();
  sunCuller.margin = 24; // one frame late, so leave room
  const sunViewProj = new THREE.Matrix4();
  let sunKnown = false;
  shadowMesh.onBeforeShadow = (_r, _o, _c, shadowCamera) => {
    sunViewProj.multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
    sunKnown = true;
    shadow.geo.instanceCount = shadowList.count;
  };
  shadowMesh.onBeforeRender = () => {
    shadow.geo.instanceCount = 0;
  };

  const viewCuller = new FrustumCuller();
  const viewProj = new THREE.Matrix4();
  let rangeScale = 1;

  // Upload a selection only when it changed (a still camera re-sends nothing). The arrays are small
  // (a few kilobytes), so a changed one simply goes up whole.
  const sent = { main: makeNodeList(CAPACITY), shadow: makeNodeList(CAPACITY) };
  const upload = (list: NodeList, last: NodeList, node: THREE.InstancedBufferAttribute, skirt: THREE.InstancedBufferAttribute): void => {
    let same = list.count === last.count;
    for (let i = 0; same && i < list.count * 4; i++) same = list.nodes[i] === last.nodes[i];
    for (let i = 0; same && i < list.count; i++) same = list.skirts[i] === last.skirts[i];
    if (same) return;
    last.nodes.set(list.nodes.subarray(0, list.count * 4));
    last.skirts.set(list.skirts.subarray(0, list.count));
    last.count = list.count;
    node.needsUpdate = true;
    skirt.needsUpdate = true;
  };

  return {
    name: 'terrain',
    update(f: FrameCtx) {
      const { camera, quality } = f;
      lod.refresh(fields.surf);

      camera.updateMatrixWorld();
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      viewCuller.setFromMatrix(viewProj);
      const cp = camera.position;

      // The screen's own pixel height (not the drawing buffer, which dynamic resolution keeps
      // changing: that would make far-off vertices breathe in and out of their morphs).
      const canvas = renderer.domElement;
      const screenPx = canvas.clientHeight > 0 ? canvas.clientHeight * Math.min(window.devicePixelRatio || 1, 2) : canvas.height;
      const baseR0 = finestRange(quality, screenPx, camera.fov);
      const maxNodes = Math.min(CAPACITY, Math.floor(triangleBudget(quality) / TRIS_PER_NODE));

      // Over budget, the ranges shrink at once; well under it, they creep back slowly, so the
      // morphs never visibly swim.
      const r0 = lod.selectWithin(cp.x, cp.y, cp.z, baseR0 * rangeScale, viewCuller, mainList, maxNodes);
      rangeScale = r0 / baseR0;
      if (rangeScale < 1 && mainList.count < maxNodes * 0.8) rangeScale = Math.min(1, rangeScale * 1.003);
      tu.uLod.value.set(r0, MORPH_START);
      main.geo.instanceCount = mainList.count;
      upload(mainList, sent.main, main.node, main.skirt);

      // Shadow casters, chosen by the sun's box: the same ranges as the view (so casters match what
      // is drawn) unless that is over the shadow budget, then coarser (safe: shadows are cast by the
      // ground's sun-averted faces, which coarser ground barely moves). Whether there are shadows at
      // all is main.ts's call (quality.shadows), made from the setting and the measured frame time.
      const casts = quality.shadows;
      shadowMesh.visible = casts;
      shadowList.count = 0;
      if (casts && sunKnown) {
        sunCuller.setFromMatrix(sunViewProj);
        const r0s = lod.selectWithin(cp.x, cp.y, cp.z, r0, sunCuller, shadowList, Math.floor(shadowTriangleBudget(quality) / TRIS_PER_NODE));
        tu.uLodShadow.value.set(r0s, MORPH_START);
        upload(shadowList, sent.shadow, shadow.node, shadow.skirt);
      }

      // Hash noise is computed relative to a point near the camera (snapped to 256 m, so the
      // pattern never shifts) to keep full float precision anywhere in the zone.
      tu.uNoiseOrigin.value.set(Math.floor(cp.x / 256) * 256, 0, Math.floor(cp.z / 256) * 256);

      stats.nodes = mainList.count;
      stats.triangles = mainList.count * TRIS_PER_NODE;
      stats.shadowNodes = shadowList.count;
      stats.shadowTriangles = shadowList.count * TRIS_PER_NODE;
      stats.r0 = r0;
      stats.rangeScale = rangeScale;
    },
    dispose() {
      const i = fields.onCols.indexOf(onCols);
      if (i >= 0) fields.onCols.splice(i, 1);
      scene.remove(mesh, shadowMesh);
      main.geo.dispose();
      shadow.geo.dispose();
      material.dispose();
      depthMaterial.dispose();
    },
  };
}
