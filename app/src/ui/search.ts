// Search / go-to list: bodies (ordered Sun → outward by current distance from the Sun, moons under
// their parent) and, when names.json is loaded, named stars (look toward them).

import type { AppModel } from '../app/model';
import { isPhysical } from '../app/world';
import { len } from '../app/vec';
import { clear, h, toggleClass } from './dom';

interface Entry {
  kind: 'body' | 'star';
  id: number;
  name: string;
  sub: string;
  child: boolean;
  hasPos: boolean;
}

export class Search {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private list = h('ul');
  private entries: Entry[] = [];
  private active = 0;
  private open = false;

  constructor(private model: AppModel) {
    this.input = h('input', { type: 'search', placeholder: 'Go to…  (/)', spellcheck: 'false', autocomplete: 'off' });
    this.input.addEventListener('focus', () => this.show(true));
    this.input.addEventListener('blur', () => setTimeout(() => this.show(false), 150));
    this.input.addEventListener('input', () => { this.active = 0; this.render(); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { this.active++; this.render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.active = Math.max(0, this.active - 1); this.render(); e.preventDefault(); }
      else if (e.key === 'Enter') { const it = this.filtered()[this.active]; if (it) this.choose(it); e.preventDefault(); }
      else if (e.key === 'Escape') { this.input.value = ''; this.input.blur(); }
      e.stopPropagation();
    });
    this.el = h('div', { class: 'st-panel st-search' }, this.input, this.list);
    model.on('data', () => this.render());
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  private show(on: boolean): void {
    this.open = on;
    this.render();
  }

  private buildEntries(): Entry[] {
    const m = this.model;
    const helio = (id: number): number => {
      if (id === m.sunId) return -1;
      const ts = m.toSunAt(id);
      return ts ? len(ts) : Number.POSITIVE_INFINITY;
    };
    const bodies = m.bodies.filter(isPhysical);
    const ids = new Set(bodies.map((b) => b.id));
    const top = bodies.filter((b) => b.parent === undefined || !ids.has(b.parent)).sort((a, b) => helio(a.id) - helio(b.id));
    const out: Entry[] = [];
    const add = (id: number, child: boolean) => {
      const b = m.byId.get(id)!;
      out.push({ kind: 'body', id, name: b.name, sub: b.kind, child, hasPos: !!m.bodyPos(id) });
      bodies
        .filter((c) => c.parent === id && c.id !== id)
        .sort((a, c) => a.name.localeCompare(c.name))
        .forEach((c) => add(c.id, true));
    };
    top.forEach((b) => add(b.id, false));
    return out;
  }

  private filtered(): Entry[] {
    const q = this.input.value.trim().toLowerCase();
    if (!this.entries.length || !q) this.entries = this.buildEntries();
    if (!q) return this.entries;
    const bodies = this.entries.filter((e) => e.name.toLowerCase().includes(q) || String(e.id) === q).map((e) => ({ ...e, child: false }));
    const stars: Entry[] = (this.model.data?.starNames ?? [])
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map((s) => ({ kind: 'star', id: s.index, name: s.name, sub: 'star · look toward', child: false, hasPos: true }));
    return [...bodies, ...stars];
  }

  private render(): void {
    clear(this.list);
    if (!this.open) return;
    const items = this.filtered();
    this.active = Math.min(this.active, Math.max(0, items.length - 1));
    items.forEach((it, i) => {
      const li = h(
        'li',
        { title: it.hasPos ? '' : 'No ephemeris coverage at the current time' },
        h('span', null, it.name),
        h('span', { class: 'st-kind' }, it.hasPos ? it.sub : `${it.sub} · no position now`),
      );
      toggleClass(li, 'st-child', it.child);
      toggleClass(li, 'st-nopos', !it.hasPos);
      toggleClass(li, 'st-active', i === this.active);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); this.choose(it); });
      this.list.appendChild(li);
    });
    if (!items.length) this.list.appendChild(h('li', { class: 'st-muted' }, 'no match'));
  }

  private choose(it: Entry): void {
    if (it.kind === 'body') {
      const r = this.model.goTo(it.id);
      if (typeof r === 'string') this.model.message(r, 'warn');
    } else this.model.lookAtStar(it.id);
    this.input.value = '';
    this.input.blur();
  }
}
