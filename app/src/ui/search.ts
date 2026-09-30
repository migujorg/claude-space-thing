// Search / go-to panel with a body browser: Sun → planets → moons (collapsible, with counts), searching every
// name, designation and NAIF id, and named stars (look toward them) when stars/names.json is loaded.
// Moons whose system is still loading say so; choosing one prioritizes its system and travels once it is in.

import type { AppModel } from '../app/model';
import { len, sub } from '../app/vec';
import { clear, h, toggleClass } from './dom';
import { browseRows, normalize, searchBodies } from './searchModel';

interface Row {
  kind: 'body' | 'star';
  id: number;
  name: string;
  depth: number;
  children: number;
  expanded: boolean;
  note?: string;
}

export class Search {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private list = h('ul');
  private rows: Row[] = [];
  private active = 0;
  private open = false;
  private expanded = new Set<number>();

  constructor(private model: AppModel) {
    this.input = h('input', { type: 'search', placeholder: 'Go to…  (/)', spellcheck: 'false', autocomplete: 'off' });
    this.input.addEventListener('focus', () => this.show(true));
    this.input.addEventListener('blur', () => setTimeout(() => this.show(false), 150));
    this.input.addEventListener('input', () => { this.active = 0; this.render(); });
    this.input.addEventListener('keydown', (e) => {
      const row = this.rows[this.active];
      if (e.key === 'ArrowDown') { this.active = Math.min(this.rows.length - 1, this.active + 1); this.render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.active = Math.max(0, this.active - 1); this.render(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' && row?.children && !row.expanded) { this.expanded.add(row.id); this.render(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' && row?.expanded) { this.expanded.delete(row.id); this.render(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (row) this.choose(row); e.preventDefault(); }
      else if (e.key === 'Escape') { this.input.value = ''; this.input.blur(); }
      e.stopPropagation();
    });
    this.el = h('div', { class: 'st-panel st-search' }, this.input, this.list);
    model.on('data', () => this.render());
    let last = 0;
    model.on('loading', () => {
      const t = Date.now();
      if (this.open && t - last > 300) { last = t; this.render(); }
    });
    model.on('selection', () => {
      // Keep the selected body's system expanded in the browser.
      const id = model.selectedId;
      if (id !== null && model.byId.get(id)?.kind === 'moon') this.expanded.add(model.rootOf(id));
    });
  }

  focus(): void {
    const f = this.model.focusRoot();
    if (f !== null) this.expanded.add(f);
    this.input.focus();
    this.input.select();
  }

  private show(on: boolean): void {
    this.open = on;
    this.render();
  }

  private note(id: number): string {
    const m = this.model;
    const st = m.bodyLoadState(id);
    if (st === 'loading') return 'loading…';
    if (st === 'queued' || st === 'deferred') return 'not loaded yet';
    if (st === 'error') return 'ephemeris failed';
    return m.bodyPos(id) ? m.byId.get(id)!.kind : 'no position now';
  }

  private buildRows(): Row[] {
    const m = this.model;
    const q = this.input.value.trim();
    if (!q) {
      const sunPos = m.sunId !== null ? m.bodyPos(m.sunId) : null;
      const cache = new Map<number, ReturnType<typeof m.bodyPos>>();
      const posOf = (id: number) => {
        if (!cache.has(id)) cache.set(id, m.bodyPos(id));
        return cache.get(id)!;
      };
      const rows = browseRows(
        m.bodies,
        {
          helio: (id) => { const p = posOf(id); return p && sunPos ? len(sub(p, sunPos)) : null; },
          fromParent: (id) => {
            const b = m.byId.get(id);
            const p = posOf(id), pp = b?.parent !== undefined ? posOf(b.parent) : null;
            return p && pp ? len(sub(p, pp)) : null;
          },
        },
        this.expanded,
      );
      return rows.map((r) => ({ ...r, note: this.note(r.id) }));
    }
    const { hits, more } = searchBodies(m.bodies, q);
    const rows: Row[] = hits.map((x) => {
      const b = m.byId.get(x.id)!;
      const parent = b.parent !== undefined ? m.byId.get(b.parent)?.name : undefined;
      return { kind: 'body', id: x.id, name: x.name, depth: 0, children: 0, expanded: false, note: `${parent ? `moon of ${parent}` : b.kind}${x.via ? ` · ${x.via}` : ''} · ${this.note(x.id)}` };
    });
    const nq = normalize(q);
    const stars = (m.data?.starNames ?? []).filter((s) => normalize(s.name).includes(nq)).slice(0, 20);
    for (const s of stars) rows.push({ kind: 'star', id: s.index, name: s.name, depth: 0, children: 0, expanded: false, note: 'star · look toward' });
    if (more) rows.push({ kind: 'body', id: -1, name: `… ${more} more — refine the search`, depth: 0, children: 0, expanded: false });
    return rows;
  }

  private render(): void {
    clear(this.list);
    if (!this.open) return;
    this.rows = this.buildRows();
    this.active = Math.min(this.active, Math.max(0, this.rows.length - 1));
    this.rows.forEach((r, i) => {
      const toggle = r.children
        ? h('span', { class: 'st-twisty', title: r.expanded ? 'Collapse (←)' : 'Expand (→)' }, `${r.expanded ? '▾' : '▸'} ${r.children}`)
        : null;
      const li = h('li', null, h('span', { class: 'st-name', style: `padding-left:${r.depth * 14}px` }, r.name), h('span', { class: 'st-kind' }, toggle, r.note ? ` ${r.note}` : ''));
      toggleClass(li, 'st-nopos', !!r.note && /loading|not loaded|failed|no position/.test(r.note));
      toggleClass(li, 'st-active', i === this.active);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (toggle && (e.target as Node) === toggle) {
          if (r.expanded) this.expanded.delete(r.id); else this.expanded.add(r.id);
          this.active = i;
          this.render();
        } else this.choose(r);
      });
      this.list.appendChild(li);
    });
    if (!this.rows.length) this.list.appendChild(h('li', { class: 'st-muted' }, 'no match'));
    (this.list.children[this.active] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }

  private choose(r: Row): void {
    if (r.id < 0) return;
    if (r.kind === 'body') {
      const res = this.model.goTo(r.id);
      if (typeof res === 'string') this.model.message(res, 'warn');
    } else this.model.lookAtStar(r.id);
    this.input.value = '';
    this.input.blur();
  }
}
