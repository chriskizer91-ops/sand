/**
 * Touch, trackpad, mouse and keyboard (WP-H). Map-style gestures (ARCHITECTURE §6.9).
 * STUB (lead): mouse only (left = tool, right-drag = rotate/tilt, middle/shift-drag = pan, wheel = zoom)
 * and one-finger tool / two-finger pan+pinch. WP-H replaces the body; keep the callback API.
 */
import type { OrbitCamera } from './camera';

export interface ControlCallbacks {
  /** Tool stroke at a screen point (CSS px). */
  stroke(phase: 'start' | 'move' | 'end' | 'cancel', sx: number, sy: number): void;
  /** Pointer moved without a stroke (desktop hover). */
  hover(sx: number, sy: number): void;
  /** A tap (no drag) at a screen point, used by Look. */
  tap(sx: number, sy: number): void;
  /** Glide request to a screen point (two-finger tap, right-click). */
  glideTo(sx: number, sy: number): void;
  /** Ground point under a screen point (for panning in world units). */
  pick(sx: number, sy: number): { x: number; y: number; z: number } | null;
  undo(): void;
  selectTool(index: number): void;
  cycleSize(delta: number): void;
  journal(): void;
  /** Any user input (resets the watch-mode idle timer). */
  interacted(): void;
}

export class Controls {
  private pointers = new Map<number, { x: number; y: number; button: number }>();
  private stroking = false;
  private lastPinch = 0;
  private lastMid: { x: number; y: number } | null = null;

  constructor(
    private el: HTMLElement,
    private cam: OrbitCamera,
    private cb: ControlCallbacks,
  ) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        cb.interacted();
        this.cam.zoom(Math.exp(e.deltaY * 0.0015));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      cb.interacted();
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') cb.undo();
      else if (e.key >= '1' && e.key <= '6') cb.selectTool(Number(e.key) - 1);
      else if (e.key === 'q') this.cam.rotate(-0.1);
      else if (e.key === 'e') this.cam.rotate(0.1);
    });
  }

  get busy(): boolean {
    return this.stroking;
  }

  private down(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    this.cb.interacted();
    if (this.pointers.size === 1 && e.button === 0 && !e.shiftKey) {
      this.stroking = true;
      this.cb.stroke('start', e.clientX, e.clientY);
    } else if (this.pointers.size === 2 && this.stroking) {
      this.stroking = false;
      this.cb.stroke('cancel', e.clientX, e.clientY);
    }
    this.lastMid = null;
    this.lastPinch = 0;
  }

  private move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      this.cb.hover(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.stroking) {
      this.cb.stroke('move', e.clientX, e.clientY);
      return;
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const pinch = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.lastMid) this.panScreen(mid.x - this.lastMid.x, mid.y - this.lastMid.y);
      if (this.lastPinch > 0) this.cam.zoom(this.lastPinch / Math.max(1, pinch));
      this.lastMid = mid;
      this.lastPinch = pinch;
    } else if (p.button === 2) {
      this.cam.rotate(-dx * 0.005);
      this.cam.tilt(dy * 0.004);
    } else if (p.button === 1 || e.shiftKey) {
      this.panScreen(dx, dy);
    }
  }

  private panScreen(dx: number, dy: number): void {
    const s = (this.cam.dist / Math.max(300, this.el.clientHeight)) * 1.2;
    const c = Math.cos(this.cam.yaw);
    const sn = Math.sin(this.cam.yaw);
    this.cam.pan((-dx * c - dy * sn) * s, (dx * sn - dy * c) * s);
  }

  private up(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.stroking && this.pointers.size === 0) {
      this.stroking = false;
      this.cb.stroke('end', e.clientX, e.clientY);
    }
    if (e.button === 2) this.cb.glideTo(e.clientX, e.clientY);
  }
}
