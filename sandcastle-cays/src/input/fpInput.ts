/**
 * First-person controls, on a laptop and on a phone.
 *
 * Laptop: W A S D or the arrow keys to move, Shift to run, Space to jump or
 * climb. Click once and the pointer is captured, so the mouse or trackpad
 * turns your head; Esc lets it go. While captured, a click (or E) uses what
 * you're looking at. If the browser won't capture the pointer, drag to look.
 *
 * Phone: the left thumb moves (a stick appears wherever it lands), the right
 * thumb drags to look, and a quick tap uses whatever you tap on. Buttons on
 * screen do the rest (see ui/hud.ts).
 */
import { PLAYER } from '../config';

const MOVE: Record<string, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
};

interface StickTouch {
  id: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
}
interface LookTouch {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  moved: number;
}

export interface Tap {
  x: number;
  y: number;
}

export class FpInput {
  enabled = false;
  /** Look change since the last frame (radians). */
  lookYaw = 0;
  lookPitch = 0;
  /** Movement from the stick or keys: x right, y forward, each -1..1. */
  move = { x: 0, y: 0 };
  running = false;
  locked = false;
  /** Pointer capture was refused: drag with the mouse to look instead. */
  dragLook = false;
  /** One-shot presses, cleared at the end of each frame. */
  private pressed = new Set<string>();
  private keys = new Set<string>();
  private stick: StickTouch | null = null;
  private look: LookTouch | null = null;
  private mouseDrag: { x: number; y: number; moved: number } | null = null;
  private taps: Tap[] = [];
  /** Where the stick is drawn (CSS pixels), for the HUD. */
  stickView: { ox: number; oy: number; x: number; y: number } | null = null;
  /** Called when the pointer capture changes. */
  onLockChange: (locked: boolean) => void = () => {};
  /** Called on any first touch or key (to start the sound). */
  onInteract: () => void = () => {};
  readonly isTouch: boolean;
  /** How long the last right-thumb touch lasted (ms), for the checks. */
  lastPressMs = 0;

  constructor(private el: HTMLElement) {
    this.isTouch = matchMedia('(pointer: coarse)').matches;
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.onInteract();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());

    el.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.moveEv(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.dragLook = true;
    });
  }

  /** Try to capture the pointer (laptop). */
  async lock(): Promise<void> {
    if (this.isTouch || this.locked) return;
    try {
      const r = (this.el as HTMLCanvasElement).requestPointerLock({ unadjustedMovement: false } as never) as unknown;
      if (r && typeof (r as Promise<void>).then === 'function') await r;
      this.dragLook = false;
    } catch {
      this.dragLook = true;
    }
  }

  unlock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Forget held keys and touches (when a panel opens). */
  clear(): void {
    this.keys.clear();
    this.stick = null;
    this.look = null;
    this.stickView = null;
    this.mouseDrag = null;
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    this.onInteract();
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      if (this.locked) {
        this.pressed.add('Use');
        return;
      }
      // First click captures the pointer; if that's refused, drag to look and click to use.
      if (!this.dragLook) {
        void this.lock();
        return;
      }
      this.mouseDrag = { x: e.clientX, y: e.clientY, moved: 0 };
      return;
    }
    // Touch (or pen): left part of the screen moves, the rest looks.
    e.preventDefault();
    const w = window.innerWidth;
    if (e.clientX < w * 0.42 && !this.stick) {
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
    } else if (!this.look) {
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: e.timeStamp, moved: 0 };
    }
    try {
      this.el.setPointerCapture?.(e.pointerId);
    } catch {
      /* not a live pointer (synthetic events): fine without capture */
    }
  }

  private moveEv(e: PointerEvent): void {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse') {
      if (this.locked) {
        // Some browsers report one huge jump when the capture starts; ignore it.
        if (Math.abs(e.movementX) < 300 && Math.abs(e.movementY) < 300) {
          this.lookYaw -= e.movementX * PLAYER.mouseLook;
          this.lookPitch -= e.movementY * PLAYER.mouseLook;
        }
      } else if (this.mouseDrag) {
        const dx = e.clientX - this.mouseDrag.x;
        const dy = e.clientY - this.mouseDrag.y;
        this.mouseDrag.moved += Math.abs(dx) + Math.abs(dy);
        this.mouseDrag.x = e.clientX;
        this.mouseDrag.y = e.clientY;
        this.lookYaw -= dx * PLAYER.mouseLook * 1.4;
        this.lookPitch -= dy * PLAYER.mouseLook * 1.4;
      }
      return;
    }
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick.x = e.clientX;
      this.stick.y = e.clientY;
    } else if (this.look && e.pointerId === this.look.id) {
      const dx = e.clientX - this.look.x;
      const dy = e.clientY - this.look.y;
      this.look.moved += Math.abs(dx) + Math.abs(dy);
      this.look.x = e.clientX;
      this.look.y = e.clientY;
      this.lookYaw -= dx * PLAYER.touchLook;
      this.lookPitch -= dy * PLAYER.touchLook;
    }
  }

  private up(e: PointerEvent, cancel = false): void {
    if (e.pointerType === 'mouse') {
      if (this.mouseDrag && this.mouseDrag.moved < 6 && !cancel) this.taps.push({ x: e.clientX, y: e.clientY });
      this.mouseDrag = null;
      return;
    }
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick = null;
      this.stickView = null;
    } else if (this.look && e.pointerId === this.look.id) {
      // Event times (not handling times), so a busy frame can't turn a tap into a hold.
      this.lastPressMs = e.timeStamp - this.look.t0;
      const quick = this.lastPressMs < 450 && this.look.moved < 14;
      if (quick && !cancel) this.taps.push({ x: e.clientX, y: e.clientY });
      this.look = null;
    }
  }

  /** Read this frame's input. Call once per frame, before endFrame(). */
  update(): void {
    let x = 0;
    let y = 0;
    if (this.keys.size) {
      if (MOVE.forward.some((k) => this.keys.has(k))) y += 1;
      if (MOVE.back.some((k) => this.keys.has(k))) y -= 1;
      if (MOVE.right.some((k) => this.keys.has(k))) x += 1;
      if (MOVE.left.some((k) => this.keys.has(k))) x -= 1;
    }
    this.running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (this.stick) {
      const R = 55;
      let dx = (this.stick.x - this.stick.ox) / R;
      let dy = (this.stick.y - this.stick.oy) / R;
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        // Drag past the edge and the stick follows the thumb.
        this.stick.ox = this.stick.x - (dx / l) * R;
        this.stick.oy = this.stick.y - (dy / l) * R;
        dx /= l;
        dy /= l;
      }
      const dead = 0.12;
      const m = Math.min(1, Math.hypot(dx, dy));
      if (m > dead) {
        const k = (m - dead) / (1 - dead) / m;
        x += dx * k;
        y -= dy * k;
      }
      // Pushing the stick all the way runs.
      if (m > 0.97) this.running = true;
      this.stickView = { ox: this.stick.ox, oy: this.stick.oy, x: this.stick.x, y: this.stick.y };
    }
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    this.move.x = x;
    this.move.y = y;
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Press a virtual button (from the on-screen buttons). */
  press(code: string): void {
    this.pressed.add(code);
  }

  takeTaps(): Tap[] {
    const t = this.taps;
    this.taps = [];
    return t;
  }

  endFrame(): void {
    this.pressed.clear();
    this.lookYaw = 0;
    this.lookPitch = 0;
  }
}
