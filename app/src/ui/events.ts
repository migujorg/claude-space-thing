// Moments panel (E): notable real configurations in the data window, found by the event finder from the loaded
// ephemerides, each with its time, what happens, how it was computed, what it rests on, and "go there" views.

import type { AppModel } from '../app/model';
import type { Category } from '../app/events/engine';
import type { EventView, SkyEvent } from '../app/events/finder';
import { eventBookmarks, staticBookmarks, type Bookmark } from '../app/events/curated';
import type { CategoryState } from '../app/events/service';
import { sbRow } from '../app/smallbodies';
import { chip } from './chips';
import { clear, h, toggleClass } from './dom';
import { around, eventProvenance, eventTime, eventTitle, JOVIAN_TYPES } from './eventsModel';

const LIST_N = 12;

export class EventsPanel {
  readonly el = h('div', { class: 'st-panel st-modal st-events' });
  private jovType = 'all';
  /** Jovian list: index of the first shown event in the filtered list (null: around the current time). */
  private jovFirst: number | null = null;
  private neoSort: 'distance' | 'time' = 'distance';
  private readonly showAll = new Set<Category>();
  private readonly expanded = new Set<string>();
  private statics: { key: string; list: Bookmark[] } | null = null;
  private namesAsked = new Set<number>();
  private scroll = 0;

  constructor(private model: AppModel, private actions: { openSources(ids: string[], title: string): void }) {
    let last = 0, timer: ReturnType<typeof setTimeout> | null = null;
    const rerender = () => {
      if (!this.open) return;
      const t = Date.now();
      if (t - last > 300) { last = t; this.render(); return; }
      if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); if (this.open) this.render(); }, 300);
    };
    model.on('events', rerender);
    model.on('data', () => { this.statics = null; rerender(); });
  }

  get open(): boolean {
    return this.el.classList.contains('st-show');
  }

  toggle(on = !this.open): void {
    if (on) {
      this.model.events?.start();
      this.render();
    }
    toggleClass(this.el, 'st-show', on);
  }

  private go(v: EventView, et: number, title: string): void {
    const m = this.model;
    const r = m.showView(v, et);
    if (typeof r === 'string') {
      m.message(r, 'warn');
      return;
    }
    this.toggle(false);
    m.message(`${title} — ${v.label}.${v.note ? ` ${v.note}` : ''}`);
  }

  private render(): void {
    const m = this.model;
    this.scroll = this.el.scrollTop;
    clear(this.el);
    this.el.append(h('button', { class: 'st-x', title: 'Close (Esc)', onclick: () => this.toggle(false) }, '×'), h('h2', null, 'Moments'));
    const svc = m.events, w = m.clock.window;
    if (!svc || !w) {
      this.el.append(h('p', { class: 'st-muted' }, 'No ephemerides are loaded: nothing to compute from.'));
      return;
    }
    this.el.append(
      h(
        'p',
        { class: 'st-muted st-small' },
        `Real configurations between ${eventTime(m, w.startEt)} and ${eventTime(m, w.endEt)}, found by this app from the loaded ephemerides, radii and orientation models (nothing is copied from event catalogues). Each entry says how it was computed and what it rests on. "Go" jumps there (time paused) with a camera placed to see it.`,
      ),
    );
    this.renderCurated();
    for (const s of svc.states()) this.renderCategory(s);
    if (svc.errors.length) this.el.append(h('h3', null, 'Problems'), h('ul', { class: 'st-small' }, svc.errors.map((e) => h('li', { class: 'st-warn' }, e))));
    this.el.scrollTop = this.scroll;
  }

  private renderCurated(): void {
    const m = this.model;
    const now = m.nowEt() ?? m.clock.et;
    const key = `${m.data?.manifest?.generatedAt ?? ''}:${Math.round(now / 86400)}`;
    if (!this.statics || this.statics.key !== key) {
      const inp = m.finderInput();
      let list: Bookmark[] = [];
      try {
        list = inp ? staticBookmarks(inp, now) : [];
      } catch (e) {
        console.error(e);
      }
      this.statics = { key, list };
    }
    const list = [...eventBookmarks(m.events?.all() ?? [], now), ...this.statics.list];
    this.el.append(h('h3', null, 'Curated views'));
    if (!list.length) {
      this.el.append(h('p', { class: 'st-muted st-small' }, 'Computing…'));
      return;
    }
    this.el.append(
      h(
        'div',
        { class: 'st-evlist' },
        list.map((b) =>
          h(
            'div',
            { class: 'st-ev st-ev-curated' },
            h('div', { class: 'st-ev-head' }, h('span', { class: 'st-ev-time' }, eventTime(m, b.et)), h('span', { class: 'st-ev-title' }, b.title), h('button', { class: 'st-ev-go', onclick: () => this.go(b.view, b.et, b.title) }, 'Go')),
            h('div', { class: 'st-ev-detail' }, b.detail),
          ),
        ),
      ),
    );
  }

  private statusLine(s: CategoryState): HTMLElement {
    const t = (x: string, cls = 'st-muted') => h('span', { class: `st-small ${cls}` }, x);
    switch (s.status) {
      case 'idle':
      case 'queued': return t('queued');
      case 'waiting': return t(s.message ?? 'waiting for its data');
      case 'running': return h('span', { class: 'st-small st-muted' }, `computing ${s.progress !== null ? `${Math.round(100 * s.progress)} %` : '…'}`, h('span', { class: 'st-evbar' }, h('span', { style: `width:${Math.round(100 * (s.progress ?? 0))}%` })));
      case 'ready': return t(`${s.events.length.toLocaleString('en-US')} found${s.cached ? ' (computed earlier for this data build)' : s.ms !== null ? ` in ${(s.ms / 1000).toFixed(1)} s` : ''}`);
      case 'error': return t(`failed: ${s.message}`, 'st-err');
      case 'unavailable': return t(`not available: ${s.message}`, 'st-warn');
    }
  }

  private renderCategory(s: CategoryState): void {
    const m = this.model;
    this.el.append(h('h3', { class: 'st-evcat' }, s.title, ' ', this.statusLine(s)));
    if (s.status !== 'ready' || !s.events.length) return;
    let list: SkyEvent[];
    const controls: HTMLElement[] = [];
    const now = m.clock.et;
    if (s.key === 'jovian') {
      const filtered = s.events.filter((e) => this.jovType === 'all' || e.subtype === this.jovType).sort((a, b) => a.et - b.et);
      const sel = h('select', { onchange: (e: Event) => { this.jovType = (e.target as HTMLSelectElement).value; this.jovFirst = null; this.render(); } },
        JOVIAN_TYPES.map(([k, label]) => {
          const n = k === 'all' ? s.events.length : s.events.filter((e) => e.subtype === k).length;
          const o = h('option', { value: k }, `${label} (${n.toLocaleString('en-US')})`);
          if (k === this.jovType) o.selected = true;
          return o;
        }));
      const a = this.jovFirst === null ? around(filtered, now, LIST_N) : { list: filtered.slice(this.jovFirst, this.jovFirst + LIST_N), first: this.jovFirst };
      list = a.list;
      const shift = (d: number) => { this.jovFirst = Math.max(0, Math.min(Math.max(0, filtered.length - LIST_N), a.first + d)); this.render(); };
      controls.push(h('div', { class: 'st-row st-small' }, sel,
        h('button', { onclick: () => shift(-LIST_N), disabled: a.first === 0 }, '‹ earlier'),
        h('button', { onclick: () => { this.jovFirst = null; this.render(); } }, 'from the current time'),
        h('button', { onclick: () => shift(LIST_N), disabled: a.first + LIST_N >= filtered.length }, 'later ›'),
        h('span', { class: 'st-muted' }, filtered.length ? `${a.first + 1}–${a.first + list.length} of ${filtered.length.toLocaleString('en-US')}` : 'none')));
    } else if (s.key === 'neo') {
      const sorted = [...s.events].sort((a, b) => (this.neoSort === 'distance' ? Number(a.data?.distKm) - Number(b.data?.distKm) : a.et - b.et));
      list = this.showAll.has(s.key) ? sorted : sorted.slice(0, LIST_N);
      controls.push(h('div', { class: 'st-row st-small' },
        h('span', { class: 'st-muted' }, 'sorted by'),
        h('button', { class: this.neoSort === 'distance' ? 'st-on' : '', onclick: () => { this.neoSort = 'distance'; this.render(); } }, 'distance'),
        h('button', { class: this.neoSort === 'time' ? 'st-on' : '', onclick: () => { this.neoSort = 'time'; this.render(); } }, 'time')));
      this.askNames(list);
    } else {
      const sorted = [...s.events].sort((a, b) => a.et - b.et);
      list = this.showAll.has(s.key) ? sorted : sorted.length > LIST_N ? around(sorted, now, LIST_N, 2).list : sorted;
    }
    this.el.append(...controls, h('div', { class: 'st-evlist' }, list.map((e) => this.eventRow(e))));
    if (s.key !== 'jovian' && s.events.length > LIST_N) {
      const all = this.showAll.has(s.key);
      this.el.append(h('div', { class: 'st-small' }, h('span', { class: 'st-link', onclick: () => { all ? this.showAll.delete(s.key) : this.showAll.add(s.key); this.render(); } }, all ? 'show fewer' : `show all ${s.events.length.toLocaleString('en-US')}`)));
    }
  }

  private askNames(list: SkyEvent[]): void {
    const m = this.model, sb = m.smallBodies;
    if (!m.names || !sb) return;
    const rows = list.flatMap((e) => e.bodies.filter((id) => id < 0).map(sbRow)).filter((r) => !sb.knownName(r) && !this.namesAsked.has(r));
    if (!rows.length) return;
    rows.forEach((r) => this.namesAsked.add(r));
    m.names.display(rows).then((names) => {
      names.forEach((n, i) => n && sb.setName(rows[i], n));
      if (this.open) this.render();
    }, () => undefined);
  }

  private eventRow(e: SkyEvent): HTMLElement {
    const m = this.model;
    const prov = eventProvenance(m, e);
    const open = this.expanded.has(e.id);
    const title = eventTitle(m, e);
    const toggle = () => { open ? this.expanded.delete(e.id) : this.expanded.add(e.id); this.render(); };
    const span = e.startEt !== undefined && e.endEt !== undefined ? ` (${eventTime(m, e.startEt)} – ${eventTime(m, e.endEt).replace(/^\d{4}-\d{2}-\d{2} /, '')})` : '';
    return h(
      'div',
      { class: 'st-ev' },
      h('div', { class: 'st-ev-head' },
        h('span', { class: 'st-ev-time', title: `greatest / central moment${span}` }, eventTime(m, e.et)),
        h('span', { class: 'st-ev-title st-link', onclick: toggle, title: 'How was this computed?' }, title),
        chip(prov.label)),
      h('div', { class: 'st-ev-detail' }, e.detail),
      h('div', { class: 'st-ev-views' }, e.views.map((v) => h('button', { onclick: () => this.go(v, v.et ?? e.et, title), title: v.note ?? '' }, `Go: ${v.label}`))),
      open
        ? h('div', { class: 'st-ev-how st-small' },
            h('div', null, h('b', null, 'How: '), e.method),
            e.startEt !== undefined && e.endEt !== undefined ? h('div', null, h('b', null, 'From–to: '), `${eventTime(m, e.startEt, true)} – ${eventTime(m, e.endEt, true)}`) : null,
            h('div', null, h('b', null, 'Seen from: '), e.observer),
            h('div', null, h('b', null, 'Rests on: '), prov.parts.map((p, i) => [i ? '; ' : '', `${p.what} `, chip(p.label), p.files.length ? ` (${p.files.join(', ')})` : ''])),
            prov.sources.length ? h('div', null, h('b', null, 'Sources: '), h('span', { class: 'st-link', onclick: () => this.actions.openSources(prov.sources, `${title}: sources`) }, `${prov.sources.length} record${prov.sources.length === 1 ? '' : 's'}`)) : null,
            prov.label !== 'derived' ? h('div', { class: 'st-warn' }, `Labelled ${prov.label}: at least one input is ${prov.label} (see above).`) : null,
            e.views.some((v) => v.note) ? h('div', { class: 'st-muted' }, e.views.filter((v) => v.note).map((v) => `${v.label}: ${v.note}`).join(' ')) : null,
          )
        : null,
    );
  }
}
