// Names overlay (non-physical, toggleable): body names + distance at projected positions, hidden
// behind other bodies (ray tests against the drawn ellipsoids) and decluttered.
// Also draws two always-available overlay marks (hidden with H):
//   - a hollow ring for bodies whose position is known but which have no admitted shape and no
//     admitted brightness (docs/architecture.md §5.3) — otherwise they would be invisible yet present;
//   - a thin ring around the selected body.

import type { AppModel } from '../app/model';
import { angularRadius, occluded, pixelsPerRadian, project } from '../app/picking';
import { h, setText, toggleClass } from './dom';
import { formatDistance } from './format';
import { estimateWidth, layoutLabels, type LabelItem } from './labelLayout';

const KIND_PRIORITY: Record<string, number> = { star: 50, planet: 40, 'dwarf-planet': 30, moon: 20, barycenter: 0 };

export class Labels {
  readonly el = h('div', { class: 'st-labels' });
  private pool = new Map<number, { el: HTMLElement; name: HTMLElement; d: HTMLElement }>();
  private markers = new Map<number, HTMLElement>();
  private ring = h('div', { class: 'st-selring' });

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

  update(): void {
    const m = this.model;
    const s = m.snapshot;
    const vp = m.cssViewport();
    const shown = new Set<number>();
    const markersShown = new Set<number>();
    let ringShown = false;
    if (s && m.world) {
      const targets = m.pickTargets();
      const ppr = pixelsPerRadian(vp);
      const items: LabelItem[] = [];
      for (const t of targets) {
        const p = project(vp, t.pos);
        if (!p) continue;
        const r = t.radii ? Math.max(t.radii[0], t.radii[1], t.radii[2]) : 0;
        const rpx = r ? Math.tan(angularRadius(r, p.dist)) * ppr : 0;
        const body = m.byId.get(t.id);
        if (!body) continue;
        const occ = occluded(t, targets);
        // hollow marker: nothing photometric can be drawn for this body
        const sb = s.bodies.find((b) => b.id === t.id);
        if (sb && !sb.radii && !sb.albedoXYZS && !occ && inView(p.x, p.y, vp.width, vp.height)) {
          const mk = this.marker(t.id);
          mk.style.transform = `translate(${p.x}px, ${p.y}px)`;
          toggleClass(mk, 'st-sel', t.id === m.selectedId);
          markersShown.add(t.id);
        }
        if (t.id === m.selectedId && !occ && inView(p.x, p.y, vp.width, vp.height)) {
          const rr = Math.max(rpx + 5, 9);
          this.ring.style.width = this.ring.style.height = `${2 * rr}px`;
          this.ring.style.transform = `translate(${p.x - rr}px, ${p.y - rr}px)`;
          ringShown = true;
        }
        if (!m.reality.overlays.labels || occ) continue;
        items.push({
          id: t.id,
          x: p.x,
          y: p.y,
          r: rpx,
          text: `${body.name}  ${formatDistance(p.dist)}`,
          priority: (t.id === m.selectedId ? 1000 : 0) + (KIND_PRIORITY[body.kind] ?? 10) + Math.min(rpx, 500) / 10,
        });
      }
      // Read panel rects before any DOM writes below (avoids layout thrash).
      const origin = this.el.getBoundingClientRect();
      const blocked = this.blockers()
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }));
      const placed = layoutLabels(items, { width: vp.width, height: vp.height, measure: (tx) => estimateWidth(tx), blocked });
      for (const pl of placed) {
        const it = items.find((i) => i.id === pl.id)!;
        const body = m.byId.get(pl.id)!;
        const e = this.labelEl(pl.id);
        setText(e.name, body.name);
        setText(e.d, it.text.slice(body.name.length + 2));
        toggleClass(e.el, 'st-sel', pl.id === m.selectedId);
        e.el.style.transform = `translate(${Math.round(pl.x)}px, ${Math.round(pl.y)}px)`;
        e.el.style.display = '';
        shown.add(pl.id);
      }
    }
    for (const [id, e] of this.pool) if (!shown.has(id)) e.el.style.display = 'none';
    for (const [id, e] of this.markers) if (!markersShown.has(id)) e.style.display = 'none';
    this.ring.style.display = ringShown ? '' : 'none';
  }

  private marker(id: number): HTMLElement {
    let e = this.markers.get(id);
    if (!e) {
      e = h('div', { class: 'st-marker', title: 'Position known; size and brightness not admitted at this level' });
      this.el.appendChild(e);
      this.markers.set(id, e);
    }
    e.style.display = '';
    return e;
  }
}

function inView(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x <= w && y <= h;
}
