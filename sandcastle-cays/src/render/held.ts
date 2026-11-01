/**
 * What you carry, drawn on top of the view: your woven basket, held low on the
 * left, with the finds you've picked up sitting in it. It sways as you walk
 * and dips out of sight while you swim or climb.
 */
import * as THREE from 'three';
import { basketModel, basketSlots, findModel } from './finds';
import type { FindKind } from '../content/finds';

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

  constructor() {
    this.basket = basketModel();
    this.slots = basketSlots();
    this.holder.add(this.basket);
    this.scene.add(this.holder, this.sun, this.sun.target, this.hemi);
    this.holder.rotation.set(0.55, 0.35, 0.1);
    this.scene.environmentIntensity = 0.55;
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

  update(dt: number, opts: { walking: number; hide: boolean; sunDir: THREE.Vector3; sunColor: THREE.Color; sunIntensity: number; hemiIntensity: number; env: THREE.Texture | null }): void {
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
    // Bottom-left of the view, a bit further in on narrow (portrait) screens.
    // Smaller and lower on a tall phone screen, so it doesn't fill the view.
    this.holder.scale.setScalar(a < 1 ? 0.62 : 1);
    const x = (a < 1 ? -0.15 : -0.3 * Math.min(1.5, a)) + this.reach * 0.08;
    const y = (a < 1 ? -0.6 : -0.56) - this.hidden * 0.45 + Math.sin(this.sway) * 0.01 * this.dip - this.reach * 0.04;
    const z = -0.95 - this.reach * 0.1;
    this.holder.position.set(x, y + Math.abs(Math.cos(this.sway * 0.5)) * 0.006 * this.dip, z);
    this.holder.rotation.z = 0.1 + Math.sin(this.sway * 0.5) * 0.03 * this.dip;
    this.holder.visible = this.hidden < 0.98;
    // Light it like the world around you.
    this.sun.position.copy(opts.sunDir).multiplyScalar(5);
    this.sun.color.copy(opts.sunColor);
    this.sun.intensity = opts.sunIntensity * 0.8;
    this.hemi.intensity = opts.hemiIntensity;
    this.scene.environment = opts.env;
  }
}
