/**
 * What you carry, drawn on top of the view: your woven basket, held low on the
 * left, with the finds you've picked up sitting in it; or your fishing rod in
 * your right hand; or a fish you've caught. It sways as you walk and dips out
 * of sight while you swim or climb.
 *
 * The rod casts with a flick, bows as a fish pulls, and its reel handle turns
 * while you reel in. `showCatch` holds a fish up in front of you for a moment.
 * The line itself is drawn in the world (FishingLine, in fishingGear.ts),
 * starting from `rodTipWorld`.
 */
import * as THREE from 'three';
import { basketModel, basketSlots, findModel } from './finds';
import { disposeFish, fishModel, wiggle, type FishKind } from './fish';
import { ROD_GRIP_X, rodModel, type Rod } from './fishingGear';
import type { FindKind } from '../content/finds';

export type Holding = 'basket' | 'rod' | 'fish';

/** How long `showCatch` holds the fish up (seconds). */
export const CATCH_SHOW_TIME = 2.8;
/** Seconds from `cast()` to the moment the line flies (when to launch the float). */
export const CAST_RELEASE_TIME = 0.4;
const CAST_TIME = 0.8;

const ease = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

export class HeldView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.02, 10);
  private basket: THREE.Group;
  private holder = new THREE.Group();
  private slots: THREE.Vector3[];
  private contents: THREE.Object3D[] = [];
  private shownKinds = '';
  private sun = new THREE.DirectionalLight(0xffffff, 2.5);
  private hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.6);
  private sway = 0;
  private dip = 0;
  /** 0 = held up, 1 = out of sight. */
  private hidden = 0;
  private reach = 0;

  // ---- fishing ----
  private holding: Holding = 'basket';
  /** How far each thing is held up (1) or put away (0), eased. */
  private shown: Record<Holding, number> = { basket: 1, rod: 0, fish: 0 };
  private rod: Rod | null = null;
  /** The rod turns about your hand, at the reel seat. */
  private rodPivot = new THREE.Group();
  private fishHolder = new THREE.Group();
  private fish: THREE.Object3D | null = null;
  private fishKind: FishKind = 'grunt';
  private time = 0;
  private castT = -1;
  private bendTarget = 0;
  private bendNow = 0;
  private bendVel = 0;
  private reelSpeed = 0;
  private reelAngle = 0;
  private catchT = -1;
  /** Lowers the rod out of the way while a catch is held up (0..1). */
  private rodLower = 0;
  private tmpQ = new THREE.Quaternion();
  private tmpM = new THREE.Matrix4();

  constructor() {
    this.basket = basketModel();
    this.slots = basketSlots();
    this.holder.add(this.basket);
    this.scene.add(this.holder, this.sun, this.sun.target, this.hemi);
    this.holder.rotation.set(0.55, 0.35, 0.1);
    this.scene.environmentIntensity = 0.55;
    this.rodPivot.visible = false;
    this.fishHolder.visible = false;
    this.scene.add(this.rodPivot, this.fishHolder);
  }

  /** Show these finds in the basket. */
  setContents(kinds: FindKind[]): void {
    const key = kinds.join(',');
    if (key === this.shownKinds) return;
    this.shownKinds = key;
    for (const o of this.contents) this.basket.remove(o);
    this.contents = [];
    kinds.forEach((k, i) => {
      const slot = this.slots[i % this.slots.length];
      const o = findModel(k);
      // Big finds (planks, coconuts) poke out; scale everything so it fits the basket.
      const box = new THREE.Box3().setFromObject(o);
      const size = box.getSize(new THREE.Vector3());
      const s = Math.min(1, 0.17 / Math.max(size.x, size.z, 0.001));
      o.scale.setScalar(s);
      o.position.copy(slot);
      o.position.y += Math.floor(i / this.slots.length) * 0.04;
      o.rotation.y = i * 2.1;
      this.basket.add(o);
      this.contents.push(o);
    });
  }

  /** A quick reach forward when picking something up. */
  pickupNudge(): void {
    this.reach = 1;
  }

  /** What's in your hands: the basket, the fishing rod, or a fish (of this kind). The old one dips away and the new one comes up. */
  setHolding(what: Holding, fishKind?: FishKind): void {
    if (what === 'rod') this.ensureRod();
    if (what === 'fish') this.ensureFish(fishKind ?? this.fishKind);
    this.holding = what;
  }

  /** What you're holding now. */
  get holdingNow(): Holding {
    return this.holding;
  }

  /** Flick the rod forward to cast. Returns the seconds until the line flies (launch the float then). */
  cast(): number {
    this.ensureRod();
    this.castT = 0;
    return CAST_RELEASE_TIME;
  }

  /** How hard a fish is pulling, 0..1: the rod tip bows toward the line. */
  bend(amount: number): void {
    this.bendTarget = Math.min(1, Math.max(0, amount));
  }

  /** Turn the reel's handle at this many turns a second (0 to stop). */
  reelTurn(speed: number): void {
    this.reelSpeed = speed;
  }

  /** Hold up a fish you've caught, in front of you, for a moment (CATCH_SHOW_TIME), wiggling. */
  showCatch(kind: FishKind): void {
    this.ensureFish(kind);
    this.catchT = 0;
  }

  /** Put the fish away now, if `showCatch` is still holding it up. */
  hideCatch(): void {
    this.catchT = -1;
  }

  /** True while `showCatch` is holding a fish up. */
  get showingCatch(): boolean {
    return this.catchT >= 0;
  }

  /** The rod tip in this view's own space (the held camera's view space). */
  rodTipHeld(out = new THREE.Vector3()): THREE.Vector3 {
    const rod = this.ensureRod();
    rod.group.updateWorldMatrix(true, false);
    rod.tipLocal(out);
    return rod.group.localToWorld(out);
  }

  /**
   * The rod tip in WORLD space, for starting the fishing line: the point that
   * sits on screen exactly where the drawn rod tip is, `depth` metres in front
   * of the main camera. Call after `update` (and after the main camera has
   * moved) each frame.
   */
  rodTipWorld(mainCamera: THREE.PerspectiveCamera, out = new THREE.Vector3(), depth = 1.2): THREE.Vector3 {
    const p = this.rodTipHeld(out);
    this.camera.updateMatrixWorld();
    // held view -> screen
    p.applyMatrix4(this.camera.matrixWorldInverse).applyMatrix4(this.camera.projectionMatrix);
    // screen -> the main camera's view, on the near plane, then out to the chosen depth
    mainCamera.updateMatrixWorld();
    p.set(p.x, p.y, -1).applyMatrix4(mainCamera.projectionMatrixInverse);
    p.multiplyScalar(depth / Math.max(1e-6, -p.z));
    return p.applyMatrix4(mainCamera.matrixWorld);
  }

  private ensureRod(): Rod {
    if (!this.rod) {
      this.rod = rodModel();
      this.rod.group.position.set(-ROD_GRIP_X, 0, 0);
      this.rodPivot.add(this.rod.group);
    }
    return this.rod;
  }

  private ensureFish(kind: FishKind): void {
    if (this.fish && this.fishKind === kind) return;
    if (this.fish) {
      this.fishHolder.remove(this.fish);
      disposeFish(this.fish);
    }
    this.fishKind = kind;
    this.fish = fishModel(kind);
    this.fishHolder.add(this.fish);
  }

  update(dt: number, opts: { walking: number; hide: boolean; sunDir: THREE.Vector3; sunColor: THREE.Color; sunIntensity: number; hemiIntensity: number; env: THREE.Texture | null }): void {
    this.time += dt;
    this.sway += dt * (4.5 + opts.walking * 2.5);
    const target = opts.hide ? 1 : 0;
    this.hidden += (target - this.hidden) * (1 - Math.exp(-dt * 6));
    this.reach *= Math.exp(-dt * 5);
    this.dip += (opts.walking - this.dip) * (1 - Math.exp(-dt * 4));
    const a = this.camera.aspect;
    // On a tall (portrait) phone screen, widen the view so the basket isn't huge.
    const fov = a < 1 ? 74 : 50;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // Swap what's in your hands: the old thing goes down before the new one comes up.
    const k = 1 - Math.exp(-dt * 8);
    for (const h of ['basket', 'rod', 'fish'] as Holding[]) {
      const others = Math.max(...(['basket', 'rod', 'fish'] as Holding[]).filter((o) => o !== h).map((o) => this.shown[o]));
      const want = h === this.holding && others < 0.35 ? 1 : 0;
      this.shown[h] += (want - this.shown[h]) * k;
      if (Math.abs(want - this.shown[h]) < 1e-3) this.shown[h] = want;
    }

    // ---- the basket (exactly as before while you hold it) ----
    const basketHidden = Math.max(this.hidden, 1 - this.shown.basket);
    // Bottom-left of the view, a bit further in on narrow (portrait) screens.
    // Smaller and lower on a tall phone screen, so it doesn't fill the view.
    this.holder.scale.setScalar(a < 1 ? 0.62 : 1);
    const x = (a < 1 ? -0.15 : -0.3 * Math.min(1.5, a)) + this.reach * 0.08;
    const y = (a < 1 ? -0.6 : -0.56) - basketHidden * 0.45 + Math.sin(this.sway) * 0.01 * this.dip - this.reach * 0.04;
    const z = -0.95 - this.reach * 0.1;
    this.holder.position.set(x, y + Math.abs(Math.cos(this.sway * 0.5)) * 0.006 * this.dip, z);
    this.holder.rotation.z = 0.1 + Math.sin(this.sway * 0.5) * 0.03 * this.dip;
    this.holder.visible = basketHidden < 0.98;

    this.updateRod(dt, a);
    this.updateFish(dt, a);

    // Light it like the world around you.
    this.sun.position.copy(opts.sunDir).multiplyScalar(5);
    this.sun.color.copy(opts.sunColor);
    this.sun.intensity = opts.sunIntensity * 0.8;
    this.hemi.intensity = opts.hemiIntensity;
    this.scene.environment = opts.env;
  }

  private updateRod(dt: number, aspect: number): void {
    const rod = this.rod;
    const hidden = Math.max(this.hidden, 1 - this.shown.rod);
    this.rodPivot.visible = !!rod && hidden < 0.98;
    if (!rod) return;
    const portrait = aspect < 1;
    // ---- the cast: wind back, flick forward, the tip whips and settles ----
    let pitch = 0;
    let castBend = 0;
    if (this.castT >= 0) {
      this.castT += dt;
      const t = this.castT;
      if (t < 0.28) {
        pitch = 0.95 * ease(t / 0.28);
        castBend = -0.12 * ease(t / 0.28);
      } else if (t < 0.42) {
        const f = (t - 0.28) / 0.14;
        pitch = 0.95 - 1.35 * ease(f);
        castBend = -0.12 - 0.4 * Math.sin(Math.PI * f);
      } else {
        const f = (t - 0.42) / (CAST_TIME - 0.42);
        pitch = -0.4 * (1 - ease(f));
        castBend = 0.32 * Math.exp(-(t - 0.42) * 8) * Math.cos((t - 0.42) * 26);
      }
      if (t >= CAST_TIME) this.castT = -1;
    }
    // ---- a fish pulling: the bend follows on a spring, with a little shudder ----
    const h = Math.min(dt, 0.05);
    this.bendVel += (-60 * (this.bendNow - this.bendTarget) - 11 * this.bendVel) * h;
    this.bendNow += this.bendVel * h;
    const shudder = this.bendTarget * 0.05 * Math.sin(this.time * 23) * Math.sin(this.time * 6.1);
    rod.setBend(this.bendNow + shudder + castBend);
    this.reelAngle += this.reelSpeed * Math.PI * 2 * dt;
    rod.turnHandle(-this.reelAngle);
    // ---- where your hand holds it ----
    this.rodLower += ((this.catchT >= 0 ? 1 : 0) - this.rodLower) * (1 - Math.exp(-dt * 6));
    const sway = this.dip;
    const hx = portrait ? 0.17 : 0.37;
    const hy = (portrait ? -0.45 : -0.32) - hidden * 0.6 - this.rodLower * 0.22 + Math.sin(this.sway) * 0.008 * sway + Math.sin(this.time * 0.9) * 0.004;
    const hz = portrait ? -0.62 : -0.72;
    this.rodPivot.position.set(hx + this.rodLower * 0.08, hy + Math.abs(Math.cos(this.sway * 0.5)) * 0.006 * sway, hz);
    // Pointing ahead and up, toward the middle of the view; the reel hangs under it.
    const dir = new THREE.Vector3(portrait ? -0.08 : -0.13, portrait ? 0.48 : 0.38, -1).normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    const side = new THREE.Vector3().crossVectors(dir, up);
    this.tmpM.makeBasis(dir, up, side);
    this.rodPivot.quaternion.setFromRotationMatrix(this.tmpM);
    // pitch (about the rod's own sideways axis): cast, pulled down by a fish, lowered for a catch
    const lift = pitch - 0.14 * this.bendNow - 0.35 * this.rodLower + Math.sin(this.sway * 0.5) * 0.02 * sway;
    this.rodPivot.quaternion.multiply(this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), lift));
    // and a slight roll, so you see a little of the reel
    this.rodPivot.quaternion.multiply(this.tmpQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.25 + this.bendNow * 0.1));
  }

  private updateFish(dt: number, aspect: number): void {
    const fish = this.fish;
    const portrait = aspect < 1;
    let show = 0;
    if (this.catchT >= 0) {
      this.catchT += dt;
      const t = this.catchT;
      show = ease(t / 0.35) * (1 - ease((t - (CATCH_SHOW_TIME - 0.4)) / 0.4));
      if (t >= CATCH_SHOW_TIME) this.catchT = -1;
    }
    const carry = this.shown.fish * (1 - this.hidden);
    this.fishHolder.visible = !!fish && (show > 0.01 || carry > 0.02);
    if (!fish) return;
    const L = (fish.userData.length as number) ?? 0.3;
    if (show > 0.01 || this.catchT >= 0) {
      // Held up in front of you, side on, head a little up, so you can admire it.
      const d = portrait ? 0.45 + L * 1.15 : 0.42 + L * 0.85;
      this.fishHolder.position.set(0.02, -0.1 - (1 - show) * 0.5 + Math.sin(this.time * 2.2) * 0.006, -d);
      const t = Math.max(0, this.catchT);
      const flap = 0.3 + 0.7 * Math.exp(-t * 1.2) + 0.5 * Math.max(0, Math.sin(t * 2.6)) ** 6;
      // it twists in your hand as it flaps, so you see the tail swing
      this.fishHolder.rotation.set(0.28, -0.12 + 0.28 * flap * Math.sin(this.time * 8.5), 0.18 + Math.sin(this.time * 1.7) * 0.03);
      wiggle(fish, this.time, flap);
      return;
    }
    // Carried in your right hand, held by the jaw, head up.
    const hidden = 1 - carry;
    // (the hand is at the head, so the fish's middle hangs half its length below it)
    this.fishHolder.position.set(portrait ? 0.14 : 0.3, (portrait ? -0.12 : -0.06) - L * 0.5 - hidden * 0.6 + Math.sin(this.sway) * 0.008 * this.dip, -0.62 - L * 0.4);
    this.fishHolder.rotation.set(0.15, -0.5, Math.PI / 2 - 0.12 + Math.sin(this.sway * 0.5) * 0.05 * this.dip);
    const every = this.time % 4.2;
    wiggle(fish, this.time, every < 0.6 ? 0.6 * Math.sin((Math.PI * every) / 0.6) : 0.05);
  }
}
