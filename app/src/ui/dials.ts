// Reality dials (NORTH_STAR 3.7): what exists × how it is shown, overlays, field of view, share link.

import type { AppModel } from '../app/model';
import { EXISTS_LEVELS, EXISTS_TEXT, VIEW_MODES, VIEW_TEXT, type ExistsLevel, type ViewMode } from '../app/reality';
import { DEG } from '../app/vec';
import { h, setText, toggleClass } from './dom';

export const BOOST_RANGE = { min: -4, max: 20, step: 0.5 };

export class Dials {
  readonly el: HTMLElement;
  private existsBtns = new Map<ExistsLevel, HTMLButtonElement>();
  private viewBtns = new Map<ViewMode, HTMLButtonElement>();
  private existsBlurb = h('div', { class: 'st-blurb' });
  private viewBlurb = h('div', { class: 'st-blurb' });
  private boost: HTMLInputElement;
  private boostVal = h('span', { class: 'st-mono' });
  private fov: HTMLInputElement;
  private fovVal = h('span', { class: 'st-mono' });
  private checks: Record<'labels' | 'orbits' | 'provenanceTint', HTMLInputElement>;
  private summary = h('span', { class: 'st-summary' });

  constructor(private model: AppModel, actions: { openData(): void; copyLink(): void }) {
    const seg = <T extends string>(values: readonly T[], text: Record<T, { name: string; blurb: string }>, map: Map<T, HTMLButtonElement>, set: (v: T) => void) =>
      h('div', { class: 'st-seg' }, values.map((v) => {
        const b = h('button', { title: text[v].blurb, onclick: () => set(v) }, text[v].name);
        map.set(v, b);
        return b;
      }));
    this.boost = h('input', { type: 'range', min: BOOST_RANGE.min, max: BOOST_RANGE.max, step: BOOST_RANGE.step, title: 'Extra exposure in stops (Enhanced only)' });
    this.boost.addEventListener('input', () => model.setReality({ exposureBoostStops: Number(this.boost.value) }));
    this.fov = h('input', { type: 'range', min: 5, max: 120, step: 1, title: 'Vertical field of view' });
    this.fov.addEventListener('input', () => model.setFovDeg(Number(this.fov.value)));
    const check = (key: 'labels' | 'orbits' | 'provenanceTint') => {
      const c = h('input', { type: 'checkbox' });
      c.addEventListener('change', () => model.setReality({ overlays: { [key]: c.checked } }));
      return c;
    };
    this.checks = { labels: check('labels'), orbits: check('orbits'), provenanceTint: check('provenanceTint') };

    const header = h('header', { title: 'Reality settings (click to expand/collapse)' }, h('h2', null, 'Reality'), this.summary);
    header.addEventListener('click', () => this.el.classList.toggle('st-collapsed'));
    this.el = h(
      'div',
      { class: 'st-panel st-dials st-collapsed' },
      header,
      h(
        'div',
        { class: 'st-body' },
        h('h3', null, 'What exists ', h('span', { class: 'st-kbd' }, 'X')),
        seg(EXISTS_LEVELS, EXISTS_TEXT, this.existsBtns, (v) => model.setReality({ exists: v })),
        this.existsBlurb,
        h('h3', null, 'How it is shown ', h('span', { class: 'st-kbd' }, 'V')),
        seg(VIEW_MODES, VIEW_TEXT, this.viewBtns, (v) => model.setReality({ view: v })),
        this.viewBlurb,
        h('div', { class: 'st-row' }, h('span', { class: 'st-muted' }, 'Boost'), this.boost, this.boostVal),
        h('h3', null, 'Overlays'),
        h(
          'div',
          { class: 'st-overlays' },
          h('label', { title: 'Names and distances (L)' }, this.checks.labels, 'Labels'),
          h('label', { title: 'Orbit lines relative to the parent body (O)' }, this.checks.orbits, 'Orbits'),
          h('label', { title: 'Tint every object by its worst provenance label (P)' }, this.checks.provenanceTint, 'Provenance tint'),
        ),
        h('h3', null, 'Camera'),
        h('div', { class: 'st-row' }, h('span', { class: 'st-muted' }, 'FOV'), this.fov, this.fovVal),
        h(
          'div',
          { class: 'st-row' },
          h('button', { onclick: () => actions.copyLink(), title: 'Copy a URL that reproduces this view (U)' }, 'Copy link'),
          h('button', { onclick: () => actions.openData(), title: 'Loaded data products and what is missing (M)' }, 'Data'),
        ),
      ),
    );
    model.on('reality', () => this.render());
    model.on('camera', () => this.render());
    this.render();
  }

  render(): void {
    const r = this.model.reality;
    for (const [v, b] of this.existsBtns) toggleClass(b, 'st-on', v === r.exists);
    for (const [v, b] of this.viewBtns) toggleClass(b, 'st-on', v === r.view);
    setText(this.existsBlurb, EXISTS_TEXT[r.exists].blurb + (r.exists === this.model.realityDefaults.exists ? ' (default)' : ''));
    setText(this.viewBlurb, VIEW_TEXT[r.view].blurb + (r.view === 'eye' ? ' (default)' : ''));
    this.boost.disabled = r.view !== 'enhanced';
    if (Number(this.boost.value) !== r.exposureBoostStops) this.boost.value = String(r.exposureBoostStops);
    setText(this.boostVal, `${r.exposureBoostStops > 0 ? '+' : ''}${r.exposureBoostStops} st`);
    for (const k of ['labels', 'orbits', 'provenanceTint'] as const) this.checks[k].checked = r.overlays[k];
    const fov = Math.round(this.model.fovY / DEG);
    if (Number(this.fov.value) !== fov) this.fov.value = String(fov);
    setText(this.fovVal, `${fov}°`);
    const boost = r.view === 'enhanced' && r.exposureBoostStops ? ` ${r.exposureBoostStops > 0 ? '+' : ''}${r.exposureBoostStops}` : '';
    setText(this.summary, `${EXISTS_TEXT[r.exists].name} · ${VIEW_TEXT[r.view].name}${boost} · ${fov}° ▾`);
  }
}
