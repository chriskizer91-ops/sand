/**
 * Fingers, trackpad, mouse and keys, turned into tool strokes and camera moves.
 * Map-style gestures (docs/DECISIONS.md 9, ARCHITECTURE §6.9).
 *
 * Touch:
 *   - one finger uses the tool. The stroke only starts after the finger moves a little or
 *     about 90 ms pass, so a tap or the start of a two-finger gesture never leaves a mark;
 *   - a second finger landing cancels the stroke (the engine undoes it);
 *   - two fingers drag to pan, pinch to zoom toward the fingers, twist to turn;
 *   - a quick two-finger tap glides there.
 * Trackpad and mouse:
 *   - click-drag uses the tool;
 *   - two-finger swipe (wheel without ctrl) pans; pinch (ctrl + wheel) or a mouse wheel zooms
 *     toward the pointer;
 *   - right-drag turns and tilts; right-click glides there.
 * Keys: W A S D / arrows pan, Q E turn, R F tilt (R looks down more), + - zoom, 1-6 tools, [ ] size, Ctrl+Z undo,
 *   J journal, hold Space to look, H home, P photo, Esc closes panels.
 *
 * The decisions live in GestureTracker, which has no DOM and is unit-tested with synthetic
 * pointer sequences (tests/controls.test.ts). Controls wires it to the page and the camera.
 */
import type { OrbitCamera } from './camera';

// ---------- gesture classification (pure) ----------

export type PointerKind = 'mouse' | 'touch' | 'pen';

export interface PointerSample {
  id: number;
  kind: PointerKind;
  /** CSS pixels. */
  x: number;
  y: number;
  /** 0 left / main, 1 middle, 2 right. */
  button: number;
  /** Milliseconds (performance.now()). */
  t: number;
}

export interface WheelSample {
  dx: number;
  dy: number;
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode). */
  mode: number;
  /** Browsers report a trackpad pinch as a wheel event with ctrl held. */
  ctrl: boolean;
  x: number;
  y: number;
  t: number;
}

/** What the tracker decides. Screen positions are CSS pixels. */
export interface GestureSink {
  stroke(phase: 'start' | 'move' | 'end' | 'cancel', x: number, y: number): void;
  /** A quick touch tap that never became a stroke (Look uses it). */
  tap(x: number, y: number): void;
  /** Drag the ground: the point under (fromX, fromY) should end up under (toX, toY). */
  pan(fromX: number, fromY: number, toX: number, toY: number): void;
  /** Zoom by a factor (< 1 = closer) toward a screen point. */
  zoom(factor: number, x: number, y: number): void;
  /** Turn (radians; positive turns the world clockwise on screen). */
  rotate(radians: number): void;
  /** Tilt (radians; positive looks more steeply down). */
  tilt(radians: number): void;
  glideTo(x: number, y: number): void;
}

/** A finger must move this far (CSS px) before it counts as a stroke rather than a tap. */
export const STROKE_SLOP = 8;
/** ...or be held this long (ms). */
export const STROKE_DELAY = 90;
/** A two-finger touch shorter than this, moving less than TAP_SLOP, is a "glide there" tap. */
export const TWO_TAP_MS = 320;
export const TWO_TAP_SLOP = 22;
/** Twisting must pass this angle before the view starts turning, so pinches don't wobble. */
export const TWIST_UNLOCK = 0.14;
/** A right-click moving less than this is a click (glide), not a drag. */
export const RIGHT_CLICK_SLOP = 5;

type Mode = 'idle' | 'pending' | 'stroke' | 'multi' | 'mouse-tool' | 'right-drag' | 'mid-pan' | 'swallow';

interface Finger {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
}

const wrapAngle = (a: number) => (a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a);

export class GestureTracker {
  private fingers = new Map<number, Finger>();
  private mode: Mode = 'idle';
  private strokeId = -1;
  // Two-finger state.
  private cx = 0;
  private cy = 0;
  private span = 0;
  private angle = 0;
  private twist = 0;
  private twistOn = false;
  private multiT0 = 0;
  private multiMoved = 0;
  /** The current touch stroke was started by holding still (not by moving). */
  private strokeByTime = false;
  /** Where the two fingers were centred (a quick two-finger tap glides here). */
  private tapX = 0;
  private tapY = 0;
  private maxFingers = 0;
  // Mouse state.
  private rightMoved = 0;
  private lastX = 0;
  private lastY = 0;
  // Wheel classification.
  private lastTrackpad = -1e9;
  private lastMouseWheel = -1e9;

  constructor(private sink: GestureSink) {}

  /** Is a stroke or camera gesture in progress? */
  get busy(): boolean {
    return this.mode !== 'idle';
  }
  get stroking(): boolean {
    return this.mode === 'stroke' || this.mode === 'mouse-tool';
  }
  /** A finger is down but hasn't yet decided between tap and stroke (time to call tick). */
  get pendingSince(): number | null {
    if (this.mode !== 'pending') return null;
    return this.fingers.get(this.strokeId)?.t0 ?? null;
  }

  /**
   * A pointer went down that must do nothing (it only woke the screen from watch mode).
   * Everything is ignored until all fingers and buttons are up.
   */
  swallow(p: PointerSample): void {
    this.fingers.set(p.id, { x: p.x, y: p.y, sx: p.x, sy: p.y, t0: p.t });
    if (this.mode === 'stroke' || this.mode === 'mouse-tool') this.sink.stroke('cancel', this.lastX, this.lastY);
    this.mode = 'swallow';
  }

  down(p: PointerSample): void {
    this.lastX = p.x;
    this.lastY = p.y;
    if (p.kind === 'mouse') {
      this.fingers.set(p.id, { x: p.x, y: p.y, sx: p.x, sy: p.y, t0: p.t });
      if (this.mode !== 'idle') return; // a second button during a drag changes nothing
      if (p.button === 0) {
        this.mode = 'mouse-tool';
        this.strokeId = p.id;
        this.sink.stroke('start', p.x, p.y);
      } else if (p.button === 2) {
        this.mode = 'right-drag';
        this.rightMoved = 0;
      } else if (p.button === 1) this.mode = 'mid-pan';
      return;
    }
    this.fingers.set(p.id, { x: p.x, y: p.y, sx: p.x, sy: p.y, t0: p.t });
    if (this.mode === 'swallow') return;
    const n = this.fingers.size;
    if (n === 1 && this.mode === 'idle') {
      this.mode = 'pending';
      this.strokeId = p.id;
      return;
    }
    if (this.mode === 'stroke') this.sink.stroke('cancel', p.x, p.y);
    if (this.mode === 'pending' || this.mode === 'stroke' || this.mode === 'idle') {
      this.mode = 'multi';
      this.multiT0 = p.t;
      this.multiMoved = 0;
      this.maxFingers = 0;
      this.twist = 0;
      this.twistOn = false;
    }
    this.maxFingers = Math.max(this.maxFingers, n);
    this.baseline();
  }

  move(p: PointerSample): void {
    const f = this.fingers.get(p.id);
    if (!f) return;
    const dx = p.x - f.x;
    const dy = p.y - f.y;
    f.x = p.x;
    f.y = p.y;
    this.lastX = p.x;
    this.lastY = p.y;
    switch (this.mode) {
      case 'pending':
        if (Math.hypot(f.x - f.sx, f.y - f.sy) > STROKE_SLOP) this.beginStroke(false);
        break;
      case 'stroke':
      case 'mouse-tool':
        if (p.id === this.strokeId) this.sink.stroke('move', p.x, p.y);
        break;
      case 'multi':
        this.moveMulti();
        break;
      case 'right-drag':
        this.rightMoved += Math.abs(dx) + Math.abs(dy);
        if (this.rightMoved > RIGHT_CLICK_SLOP) {
          this.sink.rotate(-dx * 0.006);
          this.sink.tilt(dy * 0.005);
        }
        break;
      case 'mid-pan':
        this.sink.pan(p.x - dx, p.y - dy, p.x, p.y);
        break;
      default:
        break;
    }
  }

  up(p: PointerSample, cancelled = false): void {
    const f = this.fingers.get(p.id);
    if (!f) return;
    this.fingers.delete(p.id);
    this.lastX = p.x;
    this.lastY = p.y;
    switch (this.mode) {
      case 'pending':
        // Lifted before it became a stroke: a tap, which never shapes the land.
        if (!cancelled) this.sink.tap(f.sx, f.sy);
        this.mode = 'idle';
        break;
      case 'stroke':
      case 'mouse-tool':
        if (p.id === this.strokeId) {
          // A busy page can run the hold timer late, after a quick tap has already ended:
          // the finger's own timestamps say it was a tap, so take the stroke back.
          const wasTap = this.mode === 'stroke' && this.strokeByTime && p.t - f.t0 < STROKE_DELAY && Math.hypot(f.x - f.sx, f.y - f.sy) <= STROKE_SLOP;
          if (wasTap && !cancelled) {
            this.sink.stroke('cancel', p.x, p.y);
            this.sink.tap(f.sx, f.sy);
          } else this.sink.stroke(cancelled ? 'cancel' : 'end', p.x, p.y);
          this.mode = this.fingers.size ? 'swallow' : 'idle';
        }
        break;
      case 'multi':
        if (this.fingers.size === 0) {
          const quick = p.t - this.multiT0 < TWO_TAP_MS && this.multiMoved < TWO_TAP_SLOP;
          if (!cancelled && quick && this.maxFingers === 2) this.sink.glideTo(this.tapX, this.tapY);
          this.mode = 'idle';
        } else this.baseline();
        break;
      case 'right-drag':
        if (p.kind === 'mouse' && p.button === 2) {
          if (!cancelled && this.rightMoved <= RIGHT_CLICK_SLOP) this.sink.glideTo(p.x, p.y);
          this.mode = 'idle';
        }
        break;
      case 'mid-pan':
        if (p.button === 1) this.mode = 'idle';
        break;
      case 'swallow':
        if (this.fingers.size === 0) this.mode = 'idle';
        break;
      default:
        break;
    }
    if (p.kind === 'mouse' && this.fingers.size === 0 && this.mode !== 'idle' && this.mode !== 'multi') this.mode = 'idle';
  }

  /** Call regularly while a finger is pending: after STROKE_DELAY a held finger starts a stroke. */
  tick(now: number): void {
    if (this.mode !== 'pending') return;
    const f = this.fingers.get(this.strokeId);
    if (f && now - f.t0 >= STROKE_DELAY) this.beginStroke(true);
  }

  /**
   * Wheel and trackpad. Ctrl + wheel is a trackpad pinch. A mouse wheel moves in big whole
   * steps (or in lines); a trackpad swipe sends small, often fractional, two-axis deltas.
   * Once a gesture is recognised it keeps its meaning for half a second, so one swipe never
   * flips between panning and zooming.
   */
  wheel(w: WheelSample): void {
    if (this.mode === 'swallow') return;
    const px = w.mode === 1 ? 16 : w.mode === 2 ? 400 : 1;
    const dx = w.dx * px;
    const dy = w.dy * px;
    if (w.ctrl) {
      this.lastTrackpad = w.t;
      this.sink.zoom(Math.exp(Math.max(-60, Math.min(60, dy)) * 0.01), w.x, w.y);
      return;
    }
    const mouseLike = w.mode !== 0 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy));
    const recentPad = w.t - this.lastTrackpad < 500;
    const recentMouse = w.t - this.lastMouseWheel < 500;
    if ((mouseLike && !recentPad) || (recentMouse && dx === 0)) {
      this.lastMouseWheel = w.t;
      this.sink.zoom(Math.exp(Math.sign(dy) * Math.min(Math.abs(dy), 240) * 0.0016), w.x, w.y);
      return;
    }
    this.lastTrackpad = w.t;
    this.sink.pan(w.x, w.y, w.x - dx, w.y - dy);
  }

  private beginStroke(byTime: boolean): void {
    const f = this.fingers.get(this.strokeId);
    if (!f) return;
    this.mode = 'stroke';
    this.strokeByTime = byTime;
    this.sink.stroke('start', f.sx, f.sy);
    if (f.x !== f.sx || f.y !== f.sy) this.sink.stroke('move', f.x, f.y);
  }

  /** The first two fingers (in the order they landed) drive two-finger gestures. */
  private pair(): [Finger, Finger] | null {
    const it = this.fingers.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? [a, b] : null;
  }

  private baseline(): void {
    const pr = this.pair();
    if (pr) {
      const [a, b] = pr;
      this.cx = (a.x + b.x) / 2;
      this.cy = (a.y + b.y) / 2;
      this.span = Math.hypot(b.x - a.x, b.y - a.y);
      this.angle = Math.atan2(b.y - a.y, b.x - a.x);
      this.tapX = this.cx;
      this.tapY = this.cy;
    } else {
      const one = this.fingers.values().next().value;
      if (one) {
        this.cx = one.x;
        this.cy = one.y;
      }
      this.span = 0;
    }
  }

  private moveMulti(): void {
    const pr = this.pair();
    if (!pr) {
      // One finger left after a two-finger gesture: it keeps panning until it lifts.
      const one = this.fingers.values().next().value;
      if (!one) return;
      this.sink.pan(this.cx, this.cy, one.x, one.y);
      this.multiMoved += Math.hypot(one.x - this.cx, one.y - this.cy);
      this.cx = one.x;
      this.cy = one.y;
      return;
    }
    const [a, b] = pr;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (cx !== this.cx || cy !== this.cy) this.sink.pan(this.cx, this.cy, cx, cy);
    if (this.span > 12 && span > 12 && span !== this.span) this.sink.zoom(this.span / span, cx, cy);
    const dA = wrapAngle(angle - this.angle);
    this.twist += dA;
    if (!this.twistOn && Math.abs(this.twist) > TWIST_UNLOCK) this.twistOn = true;
    else if (this.twistOn && dA !== 0) this.sink.rotate(dA);
    this.multiMoved += Math.hypot(cx - this.cx, cy - this.cy) + Math.abs(span - this.span);
    this.cx = cx;
    this.cy = cy;
    this.tapX = cx;
    this.tapY = cy;
    this.span = span;
    this.angle = angle;
  }
}

// ---------- wiring to the page ----------

export interface ControlCallbacks {
  /** Tool stroke at a screen point (CSS px). */
  stroke(phase: 'start' | 'move' | 'end' | 'cancel', sx: number, sy: number): void;
  /** Mouse moved with no button down (the brush ring follows it). */
  hover(sx: number, sy: number): void;
  /** Mouse left the view. */
  leave(): void;
  /** A quick touch tap (no stroke). */
  tap(sx: number, sy: number): void;
  /** Glide request to a screen point (two-finger tap, right-click). */
  glideTo(sx: number, sy: number): void;
  /** The ground point under a screen point (zoom pulls toward it). */
  pick(sx: number, sy: number): { x: number; y: number; z: number } | null;
  undo(): void;
  /** Tools by number: 0 lava, 1 rock, 2 sand, 3 hands, 4 scoop, 5 look. */
  selectTool(index: number): void;
  cycleSize(delta: number): void;
  journal(): void;
  /** Space held (true) or released (false): look while held. */
  lookHold(on: boolean): void;
  home(): void;
  photo(): void;
  escape(): void;
  /**
   * Any player input (moving the mouse counts too). Return true to swallow this gesture: in
   * watch mode the first touch only brings the buttons back and must not pour lava.
   */
  interacted(kind: 'pointer' | 'wheel' | 'key' | 'hover'): boolean;
  /** True while a full-screen panel (journal, menu) covers the view: keys stay with the panel. */
  blocked(): boolean;
}

const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '+', '=', '-']);

export class Controls {
  readonly tracker: GestureTracker;
  private keys = new Set<string>();
  private hoverX = 0;
  private hoverY = 0;
  private hoverDirty = false;
  private rect = { left: 0, top: 0, width: 1, height: 1 };
  private readonly a = { x: 0, z: 0 };
  private readonly b = { x: 0, z: 0 };
  private pendingTimer = 0;
  private spaceDown = false;

  constructor(
    private el: HTMLElement,
    private cam: OrbitCamera,
    private cb: ControlCallbacks,
  ) {
    this.tracker = new GestureTracker({
      stroke: (phase, x, y) => cb.stroke(phase, x, y),
      tap: (x, y) => cb.tap(x, y),
      pan: (fx, fy, tx, ty) => this.pan(fx, fy, tx, ty),
      zoom: (f, x, y) => {
        const p = cb.pick(x, y);
        this.cam.zoomAt(f, p);
      },
      rotate: (r) => this.cam.rotate(r),
      tilt: (r) => this.cam.tiltBy(r),
      glideTo: (x, y) => cb.glideTo(x, y),
    });
    this.measure();
    window.addEventListener('resize', () => this.measure());
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e, false));
    el.addEventListener('pointercancel', (e) => this.onUp(e, true));
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.tracker.busy) cb.leave();
    });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keep the browser from scrolling or zooming the page under our gestures.
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      if (this.spaceDown) {
        this.spaceDown = false;
        cb.lookHold(false);
      }
    });
  }

  get busy(): boolean {
    return this.tracker.busy;
  }
  get stroking(): boolean {
    return this.tracker.stroking;
  }

  private measure(): void {
    const r = this.el.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }

  private sample(e: PointerEvent): PointerSample {
    const kind: PointerKind = e.pointerType === 'mouse' ? 'mouse' : e.pointerType === 'pen' ? 'pen' : 'touch';
    return { id: e.pointerId, kind, x: e.clientX, y: e.clientY, button: e.button, t: e.timeStamp || performance.now() };
  }

  private onDown(e: PointerEvent): void {
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
    this.el.focus({ preventScroll: true });
    if (this.cb.interacted('pointer')) this.tracker.swallow(this.sample(e));
    else this.tracker.down(this.sample(e));
    if (this.tracker.pendingSince !== null) {
      clearTimeout(this.pendingTimer);
      // Check on the next frame after the delay, so a lift already waiting in the queue is seen first.
      this.pendingTimer = window.setTimeout(() => requestAnimationFrame(() => this.tracker.tick(performance.now())), STROKE_DELAY + 2);
    }
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && !this.tracker.busy) {
      // Browsers also send "moves" when the page changes under a resting mouse: only real movement counts.
      if (Math.abs(e.clientX - this.hoverX) + Math.abs(e.clientY - this.hoverY) < 2) return;
      this.hoverX = e.clientX;
      this.hoverY = e.clientY;
      this.hoverDirty = true;
      this.cb.interacted('hover');
      return;
    }
    this.tracker.move(this.sample(e));
  }

  private onUp(e: PointerEvent, cancelled: boolean): void {
    this.tracker.up(this.sample(e), cancelled);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.cb.interacted('wheel')) return;
    this.tracker.wheel({ dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, ctrl: e.ctrlKey, x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now() });
  }

  /** Drag the ground so the point under one screen spot moves under another. */
  private pan(fx: number, fy: number, tx: number, ty: number): void {
    const r = this.rect;
    const ndc = (x: number, y: number, out: { x: number; z: number }) =>
      this.cam.planePoint(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1, this.cam.target.y, out);
    if (ndc(fx, fy, this.a) && ndc(tx, ty, this.b)) {
      let dx = this.a.x - this.b.x;
      let dz = this.a.z - this.b.z;
      const len = Math.hypot(dx, dz);
      const cap = this.cam.dist * 0.6;
      if (len > cap) {
        dx *= cap / len;
        dz *= cap / len;
      }
      this.cam.panWorld(dx, dz);
    } else {
      // Near the horizon the plane is too far away to use: pan by a screen-sized step instead.
      const s = (this.cam.dist / r.height) * 1.4;
      this.cam.panView(-(tx - fx) * s, (ty - fy) * s);
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const k = e.key.toLowerCase();
    const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
    if (typing) return;
    if (down && k === 'escape') {
      this.cb.escape();
      return;
    }
    if (down && k === 'j' && !e.ctrlKey && !e.metaKey) {
      this.cb.interacted('key');
      this.cb.journal();
      return;
    }
    if (this.cb.blocked()) {
      this.keys.clear();
      return;
    }
    if (down && (e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      if (!this.cb.interacted('key')) this.cb.undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === ' ') {
      e.preventDefault();
      if (down && !e.repeat && !this.spaceDown) {
        this.spaceDown = true;
        this.cb.interacted('key');
        this.cb.lookHold(true);
      } else if (!down && this.spaceDown) {
        this.spaceDown = false;
        this.cb.lookHold(false);
      }
      return;
    }
    if (down && !e.repeat) {
      if (this.cb.interacted('key')) return;
      if (k >= '1' && k <= '6') this.cb.selectTool(Number(k) - 1);
      else if (k === '[') this.cb.cycleSize(-1);
      else if (k === ']') this.cb.cycleSize(1);
      else if (k === 'h') this.cb.home();
      else if (k === 'p') this.cb.photo();
    }
    if (MOVE_KEYS.has(k)) {
      if (down) {
        this.keys.add(k);
        this.cb.interacted('key');
      } else this.keys.delete(k);
      e.preventDefault();
    }
  }

  /** Per frame: held keys move the camera; the mouse hover updates once per frame at most. */
  update(dt: number): void {
    const k = this.keys;
    if (k.size) {
      const speed = Math.max(4, this.cam.dist * 0.7) * dt;
      let right = 0;
      let fwd = 0;
      if (k.has('a') || k.has('arrowleft')) right -= speed;
      if (k.has('d') || k.has('arrowright')) right += speed;
      if (k.has('w') || k.has('arrowup')) fwd += speed;
      if (k.has('s') || k.has('arrowdown')) fwd -= speed;
      if (right || fwd) this.cam.panView(right, fwd);
      if (k.has('q')) this.cam.rotate(-1.3 * dt);
      if (k.has('e')) this.cam.rotate(1.3 * dt);
      if (k.has('r')) this.cam.tiltBy(0.8 * dt);
      if (k.has('f')) this.cam.tiltBy(-0.8 * dt);
      if (k.has('+') || k.has('=')) this.cam.zoomAt(Math.exp(-1.5 * dt));
      if (k.has('-')) this.cam.zoomAt(Math.exp(1.5 * dt));
    }
    if (this.hoverDirty && !this.tracker.busy) {
      this.hoverDirty = false;
      this.cb.hover(this.hoverX, this.hoverY);
    }
  }
}
