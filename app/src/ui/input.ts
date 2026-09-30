// Pointer and keyboard input → model actions. Held keys are sampled once per frame (flyInput()).

import type { AppModel, FlyInput } from '../app/model';
import { EXISTS_LEVELS } from '../app/reality';
import { RATE_PRESETS, activePreset } from '../app/clock';
import { BOOST_RANGE } from './dials';
import { DEG } from '../app/vec';
import { isTypingTarget } from './dom';

export interface InputActions {
  toggleUi(): void;
  focusSearch(): void;
  editTime(): void;
  toggleInspector(): void;
  toggleData(): void;
  toggleHelp(): void;
  copyLink(): void;
  /** Close the topmost panel; returns false if nothing was open. */
  closeTop(): boolean;
}

const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyZ', 'KeyC', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class Input {
  private held = new Set<string>();
  private detach: (() => void)[] = [];

  constructor(private model: AppModel, private canvas: HTMLElement, private actions: InputActions) {
    this.bindPointer();
    this.bindKeys();
  }

  dispose(): void {
    this.detach.forEach((f) => f());
  }

  private on<K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(ev, fn as EventListener, opts);
    this.detach.push(() => t.removeEventListener(ev, fn as EventListener, opts));
  }

  private bindPointer(): void {
    const c = this.canvas;
    let down: { x: number; y: number; lastX: number; lastY: number; id: number; dragged: boolean } | null = null;
    this.on(c, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, id: e.pointerId, dragged: false };
    });
    this.on(c, 'pointermove', (e) => {
      if (!down || e.pointerId !== down.id) return;
      if (!down.dragged && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) down.dragged = true;
      if (down.dragged) this.model.drag(e.clientX - down.lastX, e.clientY - down.lastY);
      down.lastX = e.clientX;
      down.lastY = e.clientY;
    });
    const up = (e: PointerEvent) => {
      if (!down || e.pointerId !== down.id) return;
      const wasClick = !down.dragged;
      down = null;
      if (wasClick) {
        const r = c.getBoundingClientRect();
        // Major bodies first; else the small-body field's GPU pick (asynchronous).
        void this.model.pickAtAsync(e.clientX - r.left, e.clientY - r.top).then((id) => {
          if (id !== null) this.model.select(id);
        });
      }
    };
    this.on(c, 'pointerup', up);
    this.on(c, 'pointercancel', () => (down = null));
    this.on(c, 'dblclick', (e) => {
      const r = c.getBoundingClientRect();
      void this.model.pickAtAsync(e.clientX - r.left, e.clientY - r.top).then((id) => {
        if (id === null) return;
        const res = this.model.goTo(id);
        if (typeof res === 'string') this.model.message(res, 'warn');
      });
    });
    this.on(
      c,
      'wheel',
      (e) => {
        e.preventDefault();
        const notches = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100;
        this.model.wheel(Math.max(-10, Math.min(10, notches)));
      },
      { passive: false },
    );
    this.on(c, 'contextmenu', (e) => e.preventDefault());
  }

  private bindKeys(): void {
    this.on(window, 'keydown', (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'k') { e.preventDefault(); this.actions.focusSearch(); }
        return;
      }
      if (FLY_KEYS.has(e.code)) this.held.add(e.code);
      if (this.handleKey(e)) e.preventDefault();
    });
    this.on(window, 'keyup', (e) => this.held.delete(e.code));
    this.on(window, 'blur', () => this.held.clear());
  }

  private handleKey(e: KeyboardEvent): boolean {
    const m = this.model;
    const c = m.clock;
    const time = () => m.emit('time');
    switch (e.key) {
      case ' ': c.toggle(); time(); return true;
      case 'h': case 'H': this.actions.toggleUi(); return true;
      case '/': this.actions.focusSearch(); return true;
      case '?': this.actions.toggleHelp(); return true;
      case 'Escape':
        if (this.actions.closeTop()) return true;
        if (m.travel) { m.cancelTravel(); return true; }
        m.select(null);
        return true;
      case 'f': case 'F': m.toggleMode(); return true;
      case 'g': case 'G':
        if (m.selectedId !== null) { const r = m.goTo(m.selectedId); if (typeof r === 'string') m.message(r, 'warn'); }
        return true;
      case 'n': case 'N': if (m.goNow()) { c.setRateMagnitude(1); c.play(); time(); } return true;
      case 'r': case 'R': c.reverse(); time(); return true;
      case 't': case 'T': this.actions.editTime(); return true;
      case ',': case '.': {
        const i = RATE_PRESETS.indexOf(activePreset(c.rate) ?? RATE_PRESETS[0]);
        const j = Math.max(0, Math.min(RATE_PRESETS.length - 1, i + (e.key === '.' ? 1 : -1)));
        c.setRateMagnitude(RATE_PRESETS[j].rate);
        time();
        return true;
      }
      case '[': m.setFovDeg(Math.round(m.fovY / DEG) - 5); return true;
      case ']': m.setFovDeg(Math.round(m.fovY / DEG) + 5); return true;
      case 'x': case 'X': {
        const i = EXISTS_LEVELS.indexOf(m.reality.exists);
        m.setReality({ exists: EXISTS_LEVELS[(i + 1) % EXISTS_LEVELS.length] });
        return true;
      }
      case 'v': case 'V': m.setReality({ view: m.reality.view === 'eye' ? 'enhanced' : 'eye' }); return true;
      case '-': case '=': case '+':
        if (m.reality.view !== 'enhanced') { m.message('Exposure boost applies in Enhanced view (V).', 'info'); return true; }
        m.setReality({ exposureBoostStops: Math.max(BOOST_RANGE.min, Math.min(BOOST_RANGE.max, m.reality.exposureBoostStops + (e.key === '-' ? -1 : 1))) });
        return true;
      case 'l': case 'L': m.setReality({ overlays: { labels: !m.reality.overlays.labels } }); return true;
      case 'o': case 'O': m.setReality({ overlays: { orbits: !m.reality.overlays.orbits } }); return true;
      case 'p': case 'P': m.setReality({ overlays: { provenanceTint: !m.reality.overlays.provenanceTint } }); return true;
      case 'i': case 'I': this.actions.toggleInspector(); return true;
      case 'm': case 'M': this.actions.toggleData(); return true;
      case 'u': case 'U': this.actions.copyLink(); return true;
    }
    if (/^[1-6]$/.test(e.key)) {
      c.setRateMagnitude(RATE_PRESETS[Number(e.key) - 1].rate);
      time();
      return true;
    }
    return FLY_KEYS.has(e.code);
  }

  /** Per-frame: free-flight input, or keyboard orbiting/zooming in orbit mode. */
  flyInput(dt: number): FlyInput | null {
    const k = (c: string) => (this.held.has(c) ? 1 : 0);
    const x = k('KeyD') - k('KeyA') + k('ArrowRight') - k('ArrowLeft');
    const y = k('KeyE') - k('KeyQ');
    const z = k('KeyS') - k('KeyW') + k('ArrowDown') - k('ArrowUp');
    const roll = k('KeyC') - k('KeyZ');
    const mod = this.held.has('ShiftLeft') || this.held.has('ShiftRight') ? 'fast' : this.held.has('AltLeft') || this.held.has('AltRight') ? 'slow' : 'normal';
    if (this.model.cam.mode === 'orbit') {
      if (x || y) this.model.drag(-x * 400 * dt, y * 400 * dt);
      if (z) this.model.wheel(z * 6 * dt * (mod === 'fast' ? 3 : mod === 'slow' ? 0.3 : 1));
      if (roll) this.model.roll(roll * dt);
      return null;
    }
    if (!x && !y && !z && !roll) return null;
    return { move: [x, y, z], roll, mod };
  }
}
