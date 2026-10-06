/**
 * Your home: a small cartoon sloop, built from code. It rides the same waves
 * as the water shader, sampling the sea height at its bow, stern and sides.
 */
import * as THREE from 'three';
import { PALETTE } from './colors';
import { mergeGeometries } from './sky';
import { LAGOON_WAVES, waveHeight } from './waves';

const L = 6.4; // length (m)
const B = 2.3; // beam (m)

function halfBeam(t: number): number {
  if (t > 0.42) return (B / 2) * Math.sqrt(Math.max(0, 1 - ((t - 0.42) / 0.58) ** 2));
  return (B / 2) * (1 - 0.22 * ((0.42 - t) / 0.42) ** 2);
}
function sheer(t: number): number {
  return 0.72 + 0.24 * t * t;
}
function depth(t: number): number {
  return 0.42 * Math.pow(Math.max(0, Math.sin(Math.PI * (0.15 + 0.85 * t))), 0.6);
}

const tmp = new THREE.Color();
function lin(hex: number): [number, number, number] {
  tmp.setHex(hex);
  return [tmp.r, tmp.g, tmp.b];
}

function colored(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  const [r, gg, b] = lin(hex);
  for (let v = 0; v < n; v++) {
    c[v * 3] = r;
    c[v * 3 + 1] = gg;
    c[v * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function hull(): THREE.BufferGeometry {
  const N = 28;
  const M = 11;
  const pos: number[] = [];
  const col: number[] = [];
  const white = lin(PALETTE.hullWhite);
  const stripe = lin(PALETTE.hullStripe);
  const bottom = lin(PALETTE.hullBottom);
  const sections: number[][] = [];
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const x = -L / 2 + t * L;
    const b = halfBeam(t);
    const sh = sheer(t);
    const d = depth(t);
    const ring: number[] = [];
    // Half section (starboard), from the deck edge down to the keel line.
    const pts: [number, number][] = [
      [b * 0.97, sh],
      [b, sh * 0.55],
      [b, 0.15],
    ];
    for (let m = 1; m <= M - 3; m++) {
      const th = (m / (M - 3)) * (Math.PI / 2);
      pts.push([b * Math.cos(th), 0.15 - (0.15 + d) * Math.sin(th)]);
    }
    for (const [z, y] of pts) {
      ring.push(pos.length / 3);
      pos.push(x, y, z);
      const c = y < 0.06 ? bottom : y > sh - 0.17 && y < sh - 0.07 ? stripe : white;
      col.push(...c);
    }
    sections.push(ring);
  }
  const idx: number[] = [];
  // Starboard side, then mirror for port.
  const count = pos.length / 3;
  for (let v = 0; v < count; v++) {
    pos.push(pos[v * 3], pos[v * 3 + 1], -pos[v * 3 + 2]);
    col.push(col[v * 3], col[v * 3 + 1], col[v * 3 + 2]);
  }
  for (let s = 0; s < N; s++) {
    for (let m = 0; m < M - 1; m++) {
      const a = sections[s][m];
      const b2 = sections[s + 1][m];
      const c = sections[s][m + 1];
      const d = sections[s + 1][m + 1];
      idx.push(a, c, b2, b2, c, d);
      idx.push(a + count, b2 + count, c + count, b2 + count, d + count, c + count);
    }
  }
  // Transom (flat stern).
  const st = sections[0];
  for (let m = 0; m < M - 1; m++) idx.push(st[m], st[m + 1] + count, st[m + 1], st[m], st[m] + count, st[m + 1] + count);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function deck(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const N = 28;
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const x = -L / 2 + t * L;
    const b = halfBeam(t) * 0.97;
    const y = sheer(t) - 0.02;
    pos.push(x, y, b, x, y, -b);
  }
  for (let s = 0; s < N; s++) {
    const a = s * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return colored(g, PALETTE.deckWood);
}

function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, hex: number, sides = 6): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, sides, 1);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate(mid.x, mid.y, mid.z);
  return colored(g, hex);
}

export function createBoat(): THREE.Group {
  const parts: THREE.BufferGeometry[] = [hull(), deck()];
  // Cabin with a teal roof and round portholes.
  const cabin = new THREE.BoxGeometry(2.3, 0.5, 1.45, 1, 1, 1);
  cabin.translate(-0.55, sheer(0.4) + 0.2, 0);
  parts.push(colored(cabin, PALETTE.hullWhite));
  const roof = new THREE.BoxGeometry(2.45, 0.08, 1.58);
  roof.translate(-0.55, sheer(0.4) + 0.48, 0);
  parts.push(colored(roof, PALETTE.cabinRoof));
  for (const side of [-1, 1]) {
    for (let p = 0; p < 3; p++) {
      const ph = new THREE.CylinderGeometry(0.085, 0.085, 0.04, 12);
      ph.rotateX(Math.PI / 2);
      ph.translate(-1.3 + p * 0.6, sheer(0.4) + 0.24, side * 0.735);
      parts.push(colored(ph, 0x24414f));
    }
  }
  // A potted plant on the cabin top: home comforts.
  const pot = new THREE.CylinderGeometry(0.11, 0.08, 0.16, 10);
  pot.translate(-1.35, sheer(0.4) + 0.6, 0.45);
  parts.push(colored(pot, 0xc56a3d));
  const plant = new THREE.IcosahedronGeometry(0.17, 1);
  plant.translate(-1.35, sheer(0.4) + 0.78, 0.45);
  parts.push(colored(plant, PALETTE.leafLight));
  // Mast, boom, furled sails, stays.
  const deckY = sheer(0.62);
  const mastBase = new THREE.Vector3(0.75, deckY, 0);
  const mastTop = new THREE.Vector3(0.75, deckY + 7.4, 0);
  parts.push(rod(mastBase, mastTop, 0.07, 0xe9edf0, 8));
  const boomA = new THREE.Vector3(0.7, deckY + 1.05, 0);
  const boomB = new THREE.Vector3(-2.3, deckY + 0.95, 0);
  parts.push(rod(boomA, boomB, 0.05, 0xe9edf0, 8));
  const sail = new THREE.CapsuleGeometry(0.15, 2.5, 4, 10);
  sail.rotateZ(Math.PI / 2 - 0.03);
  sail.translate(-0.8, deckY + 1.18, 0);
  parts.push(colored(sail, PALETTE.sailCloth));
  const bow = new THREE.Vector3(L / 2 - 0.05, sheer(1) + 0.02, 0);
  parts.push(rod(mastTop, bow, 0.012, 0x6b7378, 4));
  const jib = new THREE.ConeGeometry(0.12, 4.5, 8);
  const jibDir = bow.clone().sub(new THREE.Vector3(0.75, deckY + 5.6, 0)).normalize();
  jib.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), jibDir));
  const jibMid = bow.clone().add(new THREE.Vector3(0.75, deckY + 5.6, 0)).multiplyScalar(0.5);
  jib.translate(jibMid.x, jibMid.y, jibMid.z);
  parts.push(colored(jib, PALETTE.sailCloth));
  for (const side of [-1, 1]) {
    parts.push(rod(mastTop.clone().add(new THREE.Vector3(0, -0.3, 0)), new THREE.Vector3(0.55, deckY, side * 1.08), 0.01, 0x6b7378, 4));
  }
  parts.push(rod(mastTop, new THREE.Vector3(-L / 2 + 0.1, sheer(0) + 0.02, 0), 0.01, 0x6b7378, 4));
  // Pennant at the masthead.
  const flag = new THREE.BufferGeometry();
  flag.setAttribute('position', new THREE.Float32BufferAttribute([0.75, deckY + 7.38, 0, 0.75, deckY + 7.1, 0, 0.0, deckY + 7.27, 0], 3));
  flag.computeVertexNormals();
  parts.push(colored(flag, PALETTE.flag));
  // Life ring on the stern.
  const ring = new THREE.TorusGeometry(0.22, 0.06, 8, 18);
  ring.rotateY(Math.PI / 2);
  ring.translate(-L / 2 - 0.02, sheer(0) - 0.15, 0.5);
  parts.push(colored(ring, 0xf26a4b));
  // Keel and rudder (you can see them through the clear water).
  const keel = new THREE.BoxGeometry(1.1, 0.75, 0.12);
  keel.translate(0.1, -0.7, 0);
  parts.push(colored(keel, PALETTE.hullBottom));
  const rudder = new THREE.BoxGeometry(0.45, 0.6, 0.06);
  rudder.translate(-2.75, -0.35, 0);
  parts.push(colored(rudder, PALETTE.hullBottom));
  // Anchor line from the bow into the water.
  parts.push(rod(new THREE.Vector3(L / 2 - 0.1, sheer(1) - 0.05, 0), new THREE.Vector3(L / 2 + 2.6, -1.6, 0.3), 0.018, 0x5b4a3a, 4));

  const merged = mergeGeometries(parts.map((p) => (p.getAttribute('uv') ? (p.deleteAttribute('uv'), p) : p)));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

/** Bob and rock the boat on the waves. Call every frame. */
export class BoatMotion {
  private y = 0;
  private pitch = 0;
  private roll = 0;
  constructor(
    private boat: THREE.Object3D,
    private x: number,
    private z: number,
    private heading: number,
    private ampScale: (x: number, z: number) => number,
  ) {
    boat.position.set(x, 0, z);
  }
  update(t: number, dt: number): void {
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    const at = (lx: number, lz: number) => {
      const wx = this.x + lx * ch - lz * sh;
      const wz = this.z + lx * sh + lz * ch;
      return waveHeight(LAGOON_WAVES, wx, wz, t, this.ampScale(wx, wz));
    };
    const hb = at(2.6, 0);
    const hs = at(-2.6, 0);
    const hp = at(0, 1.0);
    const hst = at(0, -1.0);
    const k = 1 - Math.exp(-dt * 4);
    this.y += ((hb + hs + hp + hst) / 4 - this.y) * k;
    this.pitch += (Math.atan2(hb - hs, 5.2) * 1.4 - this.pitch) * k;
    this.roll += (Math.atan2(hst - hp, 2.0) * 1.2 + 0.03 * Math.sin(t * 0.7) - this.roll) * k;
    this.boat.position.set(this.x, this.y - 0.02, this.z);
    this.boat.rotation.set(0, 0, 0);
    this.boat.rotateY(-this.heading);
    this.boat.rotateZ(this.pitch);
    this.boat.rotateX(this.roll);
  }
}
