/**
 * Turning fingers, mouse, trackpad and keys into tool strokes and camera moves.
 *
 * Touch: one finger uses the tool; two fingers drag to swing around, pinch to
 * zoom, quick two-finger tap to glide there. A stroke only starts once the
 * finger moves a little or ~90 ms pass, and is undone if a second finger lands,
 * so camera moves never leave marks.
 *
 * Mouse/trackpad: click to use the tool, right-drag or two-finger swipe to swing,
 * pinch or wheel to zoom, right-click to glide there.
 */
import * as THREE from 'three';
import type { Ray } from '../engine/protocol';
import type { OrbitCamera } from './camera';

export interface ControlsHost {
  ray(x: number, y: number): Ray;
  /** Point on the ground under a screen position (for camera moves). */
  pickGround(x: number, y: number): THREE.Vector3 | null;
  stroke(phase: 'begin' | 'move' | 'end' | 'cancel', ray: Ray | null): void;
  hover(ray: Ray | null): void;
  undo(): void;
  selectTool(index: number): void;
  cycleSize(dir: number): void;
  home(): void;
  /** Called on first interaction (to start audio, hide hints). */
  interacted(): void;
}

interface Pt {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  type: string;
}

type Mode = 'idle' | 'pending' | 'stroke' | 'camera' | 'rightdrag' | 'pan';

export class Controls {
  private pts = new Map<number, Pt>();
  private mode: Mode = 'idle';
  private pendingTimer = 0;
  private strokeId = -1;
  private camStart = { cx: 0, cy: 0, dist: 0, t0: 0, moved: 0, maxPts: 0 };
  private keys = new Set<string>();
  private hoverPos: { x: number; y: number } | null = null;
  private hoverDirty = false;
  private lastTrackpad = 0;
  enabled = true;

  constructor(
    private el: HTMLElement,
    private cam: OrbitCamera,
    private host: ControlsHost,
  ) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        this.hoverPos = null;
        this.host.hover(null);
      }
    });
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Stop the browser from scrolling or zooming the page.
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ---------- pointers ----------

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    this.host.interacted();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const p: Pt = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(), type: e.pointerType };
    this.pts.set(e.pointerId, p);
    if (e.pointerType === 'mouse') {
      if (e.button === 0) {
        this.mode = 'stroke';
        this.strokeId = e.pointerId;
        this.host.stroke('begin', this.host.ray(e.clientX, e.clientY));
      } else if (e.button === 2) {
        this.mode = 'rightdrag';
        this.camStart.moved = 0;
      } else if (e.button === 1) {
        this.mode = 'pan';
      }
      return;
    }
    // Touch or pen.
    if (this.pts.size === 1) {
      this.mode = 'pending';
      this.strokeId = e.pointerId;
      clearTimeout(this.pendingTimer);
      this.pendingTimer = window.setTimeout(() => {
        if (this.mode === 'pending') this.startStroke();
      }, 90);
    } else {
      if (this.mode === 'pending') clearTimeout(this.pendingTimer);
      else if (this.mode === 'stroke') this.host.stroke('cancel', null);
      this.mode = 'camera';
      this.beginCamera();
    }
  }

  private startStroke(): void {
    const p = this.pts.get(this.strokeId);
    if (!p) return;
    this.mode = 'stroke';
    this.host.stroke('begin', this.host.ray(p.sx, p.sy));
    if (p.x !== p.sx || p.y !== p.sy) this.host.stroke('move', this.host.ray(p.x, p.y));
  }

  private beginCamera(): void {
    const c = this.centroid();
    this.camStart = { cx: c.x, cy: c.y, dist: c.d, t0: performance.now(), moved: 0, maxPts: Math.max(this.pts.size, 2) };
  }

  private centroid(): { x: number; y: number; d: number } {
    let x = 0;
    let y = 0;
    const list = [...this.pts.values()];
    for (const p of list) {
      x += p.x;
      y += p.y;
    }
    x /= list.length || 1;
    y /= list.length || 1;
    let d = 0;
    if (list.length >= 2) d = Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
    return { x, y, d };
  }

  private move(e: PointerEvent): void {
    const p = this.pts.get(e.pointerId);
    if (e.pointerType === 'mouse' && this.mode === 'idle') {
      this.hoverPos = { x: e.clientX, y: e.clientY };
      this.hoverDirty = true;
      return;
    }
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    switch (this.mode) {
      case 'pending':
        if (Math.hypot(p.x - p.sx, p.y - p.sy) > 8) {
          clearTimeout(this.pendingTimer);
          this.startStroke();
        }
        break;
      case 'stroke':
        if (e.pointerId === this.strokeId) this.host.stroke('move', this.host.ray(p.x, p.y));
        break;
      case 'camera': {
        if (this.pts.size < 2) break;
        const c = this.centroid();
        const mdx = c.x - this.camStart.cx;
        const mdy = c.y - this.camStart.cy;
        this.camStart.moved += Math.hypot(mdx, mdy) + Math.abs(c.d - this.camStart.dist);
        this.cam.orbit(-mdx * 0.0065, mdy * 0.005);
        if (this.camStart.dist > 10 && c.d > 10) {
          const f = this.camStart.dist / c.d;
          this.cam.zoom(f, this.host.pickGround(c.x, c.y) ?? undefined);
        }
        this.camStart.cx = c.x;
        this.camStart.cy = c.y;
        this.camStart.dist = c.d;
        break;
      }
      case 'rightdrag':
        this.camStart.moved += Math.abs(dx) + Math.abs(dy);
        this.cam.orbit(-dx * 0.006, dy * 0.005);
        break;
      case 'pan': {
        const s = this.cam.dist * 0.0018;
        this.cam.pan(-dx * s, dy * s);
        break;
      }
    }
  }

  private up(e: PointerEvent, cancelled = false): void {
    const p = this.pts.get(e.pointerId);
    this.pts.delete(e.pointerId);
    if (!p) return;
    switch (this.mode) {
      case 'pending':
        clearTimeout(this.pendingTimer);
        if (!cancelled) {
          // A quick tap: one small action.
          this.pts.set(e.pointerId, p);
          this.startStroke();
          this.pts.delete(e.pointerId);
          this.host.stroke('end', null);
        }
        this.mode = 'idle';
        break;
      case 'stroke':
        if (e.pointerId === this.strokeId) {
          this.host.stroke(cancelled ? 'cancel' : 'end', cancelled ? null : this.host.ray(p.x, p.y));
          this.mode = 'idle';
        }
        break;
      case 'camera':
        if (this.pts.size === 0) {
          const quick = performance.now() - this.camStart.t0 < 320 && this.camStart.moved < 24;
          if (quick && this.camStart.maxPts === 2) {
            const g = this.host.pickGround(p.x, p.y);
            if (g) this.cam.glideTo(g);
          }
          this.mode = 'idle';
        } else {
          this.beginCamera();
        }
        break;
      case 'rightdrag':
        if (this.camStart.moved < 5) {
          const g = this.host.pickGround(p.x, p.y);
          if (g) this.cam.glideTo(g);
        }
        this.mode = 'idle';
        break;
      case 'pan':
        this.mode = 'idle';
        break;
    }
  }

  // ---------- wheel / trackpad ----------

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.enabled) return;
    const now = performance.now();
    const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * px;
    const dy = e.deltaY * px;
    if (e.ctrlKey) {
      // Trackpad pinch (browsers send it as ctrl + wheel).
      this.cam.zoom(Math.exp(dy * 0.01), this.host.pickGround(e.clientX, e.clientY) ?? undefined);
      this.lastTrackpad = now;
      return;
    }
    const looksLikeMouse = e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy));
    if (looksLikeMouse && now - this.lastTrackpad > 500) {
      this.cam.zoom(Math.exp(Math.sign(dy) * Math.min(Math.abs(dy), 200) * 0.0018), this.host.pickGround(e.clientX, e.clientY) ?? undefined);
      return;
    }
    // Two-finger swipe on a trackpad: swing around.
    this.lastTrackpad = now;
    this.cam.orbit(dx * 0.004, dy * 0.003);
  }

  // ---------- keys ----------

  private key(e: KeyboardEvent, down: boolean): void {
    const k = e.key.toLowerCase();
    if (down && (e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      this.host.undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (down) {
      if (k === '1' || k === '2' || k === '3') this.host.selectTool(Number(k) - 1);
      else if (k === '[') this.host.cycleSize(-1);
      else if (k === ']') this.host.cycleSize(1);
      else if (k === 'h') this.host.home();
      else if (k === 'u') this.host.undo();
    }
    const movement = ['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '+', '=', '-'];
    if (movement.includes(k)) {
      if (down) this.keys.add(k);
      else this.keys.delete(k);
      e.preventDefault();
    }
  }

  /** Per-frame: keyboard movement and mouse hover. */
  update(dt: number): void {
    const k = this.keys;
    if (k.size) {
      const speed = Math.max(0.6, this.cam.dist * 0.6) * dt;
      let r = 0;
      let f = 0;
      if (k.has('a') || k.has('arrowleft')) r -= speed;
      if (k.has('d') || k.has('arrowright')) r += speed;
      if (k.has('w') || k.has('arrowup')) f += speed;
      if (k.has('s') || k.has('arrowdown')) f -= speed;
      if (r || f) this.cam.pan(r, f);
      if (k.has('q')) this.cam.orbit(-1.6 * dt, 0);
      if (k.has('e')) this.cam.orbit(1.6 * dt, 0);
      if (k.has('r')) this.cam.orbit(0, 0.9 * dt);
      if (k.has('f')) this.cam.orbit(0, -0.9 * dt);
      if (k.has('+') || k.has('=')) this.cam.zoom(Math.exp(-1.6 * dt));
      if (k.has('-')) this.cam.zoom(Math.exp(1.6 * dt));
    }
    if (this.mode === 'idle' && this.hoverPos && this.hoverDirty) {
      this.hoverDirty = false;
      this.host.hover(this.host.ray(this.hoverPos.x, this.hoverPos.y));
    }
  }

  /** Is a camera gesture or stroke in progress? */
  get busy(): boolean {
    return this.mode !== 'idle';
  }
}
