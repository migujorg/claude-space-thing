// Names/markers overlay (non-physical, toggled with the Labels overlay): body names + distance at projected
// positions, hollow markers for bodies with nothing drawable (docs/architecture.md §5.3), hidden behind other
// bodies (ray tests against the drawn ellipsoids) and decluttered (declutter.ts). A thin ring marks the
// selected body whenever the UI is visible.

import type { AppModel } from '../app/model';
import { angularRadius, occluded, pixelsPerRadian, project, type PickTarget } from '../app/picking';
import { len } from '../app/vec';
import { declutter, type OverlayCandidate } from './declutter';
import { h, setText, toggleClass } from './dom';
import { formatDistance } from './format';
import { AU_KM } from './units';

export class Labels {
  readonly el = h('div', { class: 'st-labels' });
  private pool = new Map<number, { el: HTMLElement; name: HTMLElement; d: HTMLElement }>();
  private markers = new Map<number, HTMLElement>();
  private ring = h('div', { class: 'st-selring' });
  /** Last frame's counts (debug/tests). */
  stats = { candidates: 0, labels: 0, markers: 0 };

  constructor(private model: AppModel, private blockers: () => Element[] = () => []) {
    this.el.appendChild(this.ring);
  }

  private labelEl(id: number) {
    let e = this.pool.get(id);
    if (!e) {
      const name = h('span');
      const d = h('span', { class: 'st-d' });
      const el = h('div', { class: 'st-label' }, name, d);
      el.addEventListener('click', (ev) => { ev.stopPropagation(); this.model.select(id); });
      el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); void this.model.goTo(id); });
      this.el.appendChild(el);
      e = { el, name, d };
      this.pool.set(id, e);
    }
    return e;
  }

  private marker(id: number): HTMLElement {
    let e = this.markers.get(id);
    if (!e) {
      e = h('div', { class: 'st-marker', title: 'Position known; size and brightness not admitted at this level' });
      this.el.appendChild(e);
      this.markers.set(id, e);
    }
    return e;
  }

  update(): void {
    const m = this.model;
    const s = m.snapshot;
    const vp = m.cssViewport();
    const shownLabels = new Set<number>();
    const shownMarkers = new Set<number>();
    let ringShown = false;
    if (s && m.world) {
      const ppr = pixelsPerRadian(vp);
      const targets = m.pickTargets();
      const snapById = new Map(s.bodies.map((b) => [b.id, b]));
      const overlayOnly = new Set(m.overlayOnly.map((b) => b.id));
      // Occluders: bodies drawn at least a pixel across.
      const rPxOf = (t: PickTarget, d: number) => (t.radii ? Math.tan(angularRadius(Math.max(t.radii[0], t.radii[1], t.radii[2]), d)) * ppr : 0);
      const occluders = targets.filter((t) => rPxOf(t, len(t.pos)) >= 1);
      const focus = m.focusRoot();
      const focusGeom = focus !== null ? m.world.bodies.get(focus) : undefined;
      const focusDist = focusGeom?.app ? len(focusGeom.app.rel) : null;
      const cands: OverlayCandidate[] = [];
      const margin = 40;
      for (const t of targets) {
        const p = project(vp, t.pos);
        if (!p || p.x < -margin || p.y < -margin || p.x > vp.width + margin || p.y > vp.height + margin) continue;
        const body = m.byId.get(t.id);
        if (!body) continue;
        const rPx = rPxOf(t, p.dist);
        if (occluded(t, occluders)) continue;
        const selected = t.id === m.selectedId;
        if (selected) {
          const rr = Math.max(rPx + 5, 9);
          this.ring.style.width = this.ring.style.height = `${2 * rr}px`;
          this.ring.style.transform = `translate(${p.x - rr}px, ${p.y - rr}px)`;
          ringShown = true;
        }
        if (!m.reality.overlays.labels) continue;
        // Brightness for ranking only: reflected light at zero phase from the admitted albedo and size.
        const sb = snapById.get(t.id);
        let brightness: number | null = null;
        if (sb?.albedoXYZS && sb.radii) {
          const R = (sb.radii[0] + sb.radii[1] + sb.radii[2]) / 3;
          const dSun = len(sb.toSun) / AU_KM;
          const E = sb.albedoXYZS[1] * (R / p.dist) ** 2 / Math.max(dSun * dSun, 1e-12);
          if (E > 0) brightness = Math.log10(E);
        }
        cands.push({
          id: t.id, x: p.x, y: p.y, rPx, dist: p.dist, kind: body.kind, selected,
          focus: focus !== null && m.rootOf(t.id) === focus,
          brightness,
          sizePx: t.radii ? Math.tan(angularRadius(Math.max(t.radii[0], t.radii[1], t.radii[2]), p.dist)) * ppr : null,
          marker: overlayOnly.has(t.id),
          text: `${body.name}  ${formatDistance(p.dist)}`,
        });
      }
      // Read panel rects before any DOM writes below (avoids layout thrash).
      const origin = this.el.getBoundingClientRect();
      const blocked = this.blockers()
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }));
      const r = declutter(cands, { width: vp.width, height: vp.height, focusDist, blocked });
      const byId = new Map(cands.map((c) => [c.id, c]));
      for (const id of r.markers) {
        const c = byId.get(id)!;
        const mk = this.marker(id);
        mk.style.transform = `translate(${c.x}px, ${c.y}px)`;
        toggleClass(mk, 'st-sel', c.selected);
        shownMarkers.add(id);
      }
      for (const pl of r.labels) {
        const c = byId.get(pl.id)!;
        const body = m.byId.get(pl.id)!;
        const e = this.labelEl(pl.id);
        setText(e.name, body.name);
        setText(e.d, c.text.slice(body.name.length + 2));
        toggleClass(e.el, 'st-sel', c.selected);
        e.el.style.transform = `translate(${Math.round(pl.x)}px, ${Math.round(pl.y)}px)`;
        e.el.style.display = '';
        shownLabels.add(pl.id);
      }
      this.stats = { candidates: cands.length, labels: r.labels.length, markers: r.markers.length };
    }
    for (const [id, e] of this.pool) if (!shownLabels.has(id)) e.el.style.display = 'none';
    for (const [id, e] of this.markers) e.style.display = shownMarkers.has(id) ? '' : 'none';
    this.ring.style.display = ringShown ? '' : 'none';
  }
}
