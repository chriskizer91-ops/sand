/**
 * Beachcombing: what the sea leaves along the high-tide line each morning,
 * your basket, the locker aboard, and the logbook of what you've found.
 *
 * `Beach` is the rules and the saved state (no drawing, so the checks can run
 * it). `BeachView` puts the finds on the sand and works out which one you're
 * looking at.
 */
import * as THREE from 'three';
import { BASKET_CAPACITY } from '../config';
import { FINDS, FIND_KINDS, type FindKind } from '../content/finds';
import { mulberry32 } from '../engine/noise';

export interface GroundFind {
  id: number;
  kind: FindKind;
  x: number;
  z: number;
  /** Turn on the sand (radians). */
  rot: number;
  /** The day it washed up. */
  day: number;
}

export interface BeachState {
  ground: GroundFind[];
  basket: FindKind[];
  locker: Partial<Record<FindKind, number>>;
  /** How many of each kind you have ever picked up. */
  found: Partial<Record<FindKind, number>>;
  /** The last day the sea left new finds. */
  lastWash: number;
  nextId: number;
}

/** Most finds lying about at once; the tide takes the oldest back. */
export const MAX_ON_SAND = 48;

export type PickResult = { ok: true; first: boolean; kind: FindKind } | { ok: false; reason: 'full' | 'gone' };

export class Beach {
  state: BeachState;

  constructor(
    private tideline: { x: number; z: number; nx: number; nz: number }[],
    state?: BeachState,
  ) {
    this.state = state ?? Beach.fresh();
  }

  static fresh(): BeachState {
    return { ground: [], basket: [], locker: {}, found: {}, lastWash: 0, nextId: 1 };
  }

  /** Load a saved state, ignoring anything this version doesn't know. */
  static restore(raw: unknown): BeachState {
    const s = Beach.fresh();
    if (!raw || typeof raw !== 'object') return s;
    const r = raw as Partial<BeachState>;
    const known = (k: unknown): k is FindKind => typeof k === 'string' && k in FINDS;
    if (Array.isArray(r.ground)) {
      for (const g of r.ground) if (g && known(g.kind) && Number.isFinite(g.x) && Number.isFinite(g.z)) s.ground.push({ ...g });
    }
    if (Array.isArray(r.basket)) s.basket = r.basket.filter(known).slice(0, BASKET_CAPACITY);
    for (const key of ['locker', 'found'] as const) {
      const m = r[key];
      if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) if (known(k) && Number.isFinite(v)) s[key][k] = Math.max(0, Math.floor(v as number));
    }
    s.lastWash = Number.isFinite(r.lastWash) ? (r.lastWash as number) : 0;
    s.nextId = Math.max(Number.isFinite(r.nextId) ? (r.nextId as number) : 1, ...s.ground.map((g) => g.id + 1), 1);
    return s;
  }

  /** The sea leaves new things along the tideline. Returns how many arrived. */
  washUp(day: number, count?: number): number {
    const st = this.state;
    if (!this.tideline.length) return 0;
    const rand = mulberry32(day * 7919 + 17);
    const n = count ?? 11 + Math.floor(rand() * 5);
    const total = FIND_KINDS.reduce((a, k) => a + FINDS[k].rarity, 0);
    const pick = (): FindKind => {
      let r = rand() * total;
      for (const k of FIND_KINDS) {
        r -= FINDS[k].rarity;
        if (r <= 0) return k;
      }
      return FIND_KINDS[0];
    };
    let added = 0;
    for (let i = 0; i < n * 4 && added < n; i++) {
      const p = this.tideline[Math.floor(rand() * this.tideline.length)];
      // Scatter a little up and down the beach from the wrack line.
      const along = (rand() - 0.5) * 1.4;
      const across = (rand() - 0.5) * 1.6;
      const x = p.x - p.nz * along - p.nx * across;
      const z = p.z + p.nx * along - p.nz * across;
      // Not on top of another find.
      if (st.ground.some((g) => Math.abs(g.x - x) < 0.5 && Math.abs(g.z - z) < 0.5)) continue;
      st.ground.push({ id: st.nextId++, kind: pick(), x, z, rot: rand() * Math.PI * 2, day });
      added++;
    }
    // The tide takes the oldest back.
    if (st.ground.length > MAX_ON_SAND) st.ground.splice(0, st.ground.length - MAX_ON_SAND);
    st.lastWash = day;
    return added;
  }

  pickUp(id: number): PickResult {
    const st = this.state;
    const i = st.ground.findIndex((g) => g.id === id);
    if (i < 0) return { ok: false, reason: 'gone' };
    if (st.basket.length >= BASKET_CAPACITY) return { ok: false, reason: 'full' };
    const g = st.ground[i];
    st.ground.splice(i, 1);
    st.basket.push(g.kind);
    const first = !st.found[g.kind];
    st.found[g.kind] = (st.found[g.kind] ?? 0) + 1;
    return { ok: true, first, kind: g.kind };
  }

  /** Put everything in the basket into the locker aboard. Returns how many. */
  emptyBasket(): number {
    const st = this.state;
    const n = st.basket.length;
    for (const k of st.basket) st.locker[k] = (st.locker[k] ?? 0) + 1;
    st.basket = [];
    return n;
  }

  get basketFull(): boolean {
    return this.state.basket.length >= BASKET_CAPACITY;
  }
}

// ---------- on screen ----------

const tmpV = new THREE.Vector3();
const tmpW = new THREE.Vector3();

export class BeachView {
  readonly group = new THREE.Group();
  private shown = new Map<number, { obj: THREE.Object3D; find: GroundFind; radius: number }>();

  constructor(
    private beach: Beach,
    private model: (kind: FindKind) => THREE.Object3D,
    private groundAt: (x: number, z: number) => number,
  ) {}

  /** Match what's drawn to the state (after a wash-up, a pick-up or loading). */
  sync(): void {
    const ids = new Set(this.beach.state.ground.map((g) => g.id));
    for (const [id, s] of this.shown) {
      if (!ids.has(id)) {
        this.group.remove(s.obj);
        this.shown.delete(id);
      }
    }
    for (const g of this.beach.state.ground) {
      if (this.shown.has(g.id)) continue;
      const obj = this.model(g.kind);
      obj.rotation.y = g.rot;
      // Small things are drawn a little larger than life, so you can spot them from standing height.
      const sz = FINDS[g.kind].size;
      obj.scale.setScalar(sz < 0.05 ? 1.6 : sz < 0.1 ? 1.35 : 1);
      obj.position.set(g.x, this.groundAt(g.x, g.z) - 0.004, g.z);
      obj.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      this.group.add(obj);
      this.shown.set(g.id, { obj, find: g, radius: Math.max(0.12, FINDS[g.kind].size * obj.scale.x * 0.55) });
    }
  }

  /** Keep finds sitting on the sand (it can change under them). */
  update(near: THREE.Vector3): void {
    for (const s of this.shown.values()) {
      const p = s.obj.position;
      if (Math.abs(p.x - near.x) > 25 || Math.abs(p.z - near.z) > 25) continue;
      p.y = this.groundAt(p.x, p.z) - 0.004;
    }
  }

  /** The find a ray points at within reach of the eye (or null). */
  pick(ray: THREE.Ray, eye: THREE.Vector3, reach: number): GroundFind | null {
    let best: GroundFind | null = null;
    let bestT = Infinity;
    for (const s of this.shown.values()) {
      const p = s.obj.position;
      tmpV.copy(p);
      tmpV.y += s.radius * 0.4;
      if (tmpV.distanceTo(eye) > reach + s.radius) continue;
      // Generous: a little bigger than the find, so small shells are easy to tap.
      const r = s.radius + 0.1;
      const t = tmpW.copy(tmpV).sub(ray.origin).dot(ray.direction);
      if (t < 0) continue;
      const d2 = tmpW.copy(ray.direction).multiplyScalar(t).add(ray.origin).distanceToSquared(tmpV);
      if (d2 < r * r && t < bestT) {
        bestT = t;
        best = s.find;
      }
    }
    return best;
  }

  /** Where a find is drawn (for effects). */
  positionOf(id: number): THREE.Vector3 | null {
    const s = this.shown.get(id);
    return s ? s.obj.position.clone() : null;
  }
}
