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
import type { IslandId, TidePoint } from '../world/islands';

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
export const MAX_ON_SAND = 64;

export type PickResult = { ok: true; first: boolean; kind: FindKind } | { ok: false; reason: 'full' | 'gone' };

export class Beach {
  state: BeachState;

  constructor(
    private tideline: TidePoint[],
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

  /** The sea leaves new things along each island's tideline. Returns how many arrived. */
  washUp(day: number, count?: number): number {
    const st = this.state;
    if (!this.tideline.length) return 0;
    const rand = mulberry32(day * 7919 + 17);
    const islands: IslandId[] = [...new Set(this.tideline.map((p) => p.island))];
    let added = 0;
    for (const island of islands) {
      const line = this.tideline.filter((p) => p.island === island);
      // Home Cay's long beaches get the most; a small cay gets fewer.
      const n = count ?? (island === 'home' ? 11 + Math.floor(rand() * 5) : 6 + Math.floor(rand() * 3));
      const kinds = FIND_KINDS.filter((k) => !FINDS[k].islands || FINDS[k].islands!.includes(island));
      const total = kinds.reduce((a, k) => a + FINDS[k].rarity, 0);
      const pick = (): FindKind => {
        let r = rand() * total;
        for (const k of kinds) {
          r -= FINDS[k].rarity;
          if (r <= 0) return k;
        }
        return kinds[0];
      };
      let here = 0;
      for (let i = 0; i < n * 4 && here < n; i++) {
        const p = line[Math.floor(rand() * line.length)];
        // Scatter a little up and down the beach from the wrack line.
        const along = (rand() - 0.5) * 1.4;
        const across = (rand() - 0.5) * 1.6;
        const x = p.x - p.nz * along - p.nx * across;
        const z = p.z + p.nx * along - p.nz * across;
        // Not on top of another find.
        if (st.ground.some((g) => Math.abs(g.x - x) < 0.5 && Math.abs(g.z - z) < 0.5)) continue;
        st.ground.push({ id: st.nextId++, kind: pick(), x, z, rot: rand() * Math.PI * 2, day });
        here++;
      }
      added += here;
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

const MAX_GLINTS = 64;

/**
 * Glints: now and then the sun catches a find on the sand and it sparkles,
 * which is how you spot a shell or a piece of sea glass from a few steps away.
 */
function makeGlints(): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_GLINTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('phase', new THREE.BufferAttribute(new Float32Array(MAX_GLINTS), 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uBright: { value: 1 }, uScale: { value: 300 } },
    vertexShader: /* glsl */ `
attribute float phase;
uniform float uTime, uScale;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // A brief flash every few seconds, at a different moment for each find.
  float s = sin(uTime * 1.3 + phase * 6.2831);
  float flash = pow(max(0.0, s), 40.0);
  float dist = -mv.z;
  vA = flash * (1.0 - smoothstep(12.0, 20.0, dist));
  gl_PointSize = uScale * (0.05 + 0.07 * flash) / max(0.5, dist);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */ `
uniform float uBright;
varying float vA;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  // A little four-pointed star.
  float star = max(0.0, 1.0 - abs(p.x) * 6.0) * max(0.0, 1.0 - abs(p.y) * 1.2) + max(0.0, 1.0 - abs(p.y) * 6.0) * max(0.0, 1.0 - abs(p.x) * 1.2);
  float core = smoothstep(0.45, 0.0, length(p));
  float a = clamp(star * 0.9 + core, 0.0, 1.0) * vA * uBright;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(1.0, 0.98, 0.9) * a, a);
}`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  return pts;
}

export class BeachView {
  readonly group = new THREE.Group();
  readonly glints = makeGlints();
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

  /** Keep finds sitting on the sand (it can change under them), and make the near ones glint. */
  update(near: THREE.Vector3, time = 0, daylight = 1, viewHeight = 800): void {
    const pos = this.glints.geometry.getAttribute('position') as THREE.BufferAttribute;
    const phase = this.glints.geometry.getAttribute('phase') as THREE.BufferAttribute;
    let n = 0;
    for (const s of this.shown.values()) {
      const p = s.obj.position;
      if (Math.abs(p.x - near.x) > 25 || Math.abs(p.z - near.z) > 25) continue;
      p.y = this.groundAt(p.x, p.z) - 0.004;
      if (n < MAX_GLINTS) {
        pos.setXYZ(n, p.x, p.y + Math.max(0.03, s.radius * 0.5), p.z);
        phase.setX(n, (s.find.id * 0.618) % 1);
        n++;
      }
    }
    this.glints.geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
    phase.needsUpdate = true;
    const u = (this.glints.material as THREE.ShaderMaterial).uniforms;
    u.uTime.value = time;
    u.uBright.value = 0.25 + 0.75 * daylight;
    u.uScale.value = viewHeight;
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
