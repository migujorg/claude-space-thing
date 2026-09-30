// Data panel: which products loaded (and verified), which are missing, and what that costs.

import type { AppModel } from '../app/model';
import { clear, h, toggleClass } from './dom';
import { formatBytes, sig } from './format';

export class DataPanel {
  readonly el = h('div', { class: 'st-panel st-modal st-data' });

  constructor(private model: AppModel, private actions: { openSources(ids: string[], title: string): void }) {
    model.on('data', () => { if (this.open) this.render(); });
    model.on('smallbodies', () => { if (this.open) this.render(); });
    let last = 0;
    model.on('loading', () => {
      const t = Date.now();
      if (this.open && t - last > 250) { last = t; this.render(); }
    });
  }

  get open(): boolean {
    return this.el.classList.contains('st-show');
  }

  toggle(on = !this.open): void {
    if (on) this.render();
    toggleClass(this.el, 'st-show', on);
  }

  private render(): void {
    const m = this.model;
    const d = m.data;
    clear(this.el);
    this.el.append(h('button', { class: 'st-x', title: 'Close (Esc)', onclick: () => this.toggle(false) }, '×'), h('h2', null, 'Data products'));
    if (!d) {
      this.el.append(h('p', { class: 'st-muted' }, 'Loading…'));
      return;
    }
    const w = m.clock.window;
    const man = d.manifest;
    this.el.append(
      h(
        'div',
        { class: 'st-kv' },
        h('div', null, 'Generated'),
        h('div', null, man ? `${man.generatedAt} (pipeline ${man.pipelineVersion})` : h('span', { class: 'st-warn' }, 'no manifest')),
        h('div', null, 'Data window'),
        h('div', null, w ? `${m.formatTime(w.startEt)} → ${m.formatTime(w.endEt)}` : h('span', { class: 'st-warn' }, 'unknown')),
        h('div', null, 'Bodies'),
        h('div', null, `${d.bodies.length} (${d.bodies.filter((b) => b.photometry).length} with photometry)`),
        h('div', null, 'Ephemerides'),
        h('div', null, d.ephemerides.map((e) => `${e.path} (${e.header.segments.length} segments)`).join(', ') || h('span', { class: 'st-warn' }, 'none')),
        h('div', null, 'Moon systems'),
        h('div', null, this.systemsLine()),
        h('div', null, 'Orientation'),
        h('div', null, d.orientations.length ? d.orientations.map((o) => `${o.path} (${Object.values(o.header.bodies).map((b) => b.frame).join(', ')})`).join(', ') : 'IAU rotation models only'),
        h('div', null, 'Surface maps'),
        h('div', null, d.surfaces.length ? d.surfaces.map((s) => `${m.byId.get(s.bodyId)?.name ?? s.bodyId} ${s.layer} (${s.label}, ${s.tiles.count} tiles)`).join(', ') + ' — not drawn by this renderer version yet' : 'none'),
        h('div', null, 'Stars'),
        h('div', null, this.starsLine()),
        h('div', null, 'Small bodies'),
        h('div', null, this.smallBodiesLine()),
        h('div', null, 'Sources'),
        h('div', null, d.sources.size ? h('span', { class: 'st-link', onclick: () => this.actions.openSources([...d.sources.keys()], 'All sources') }, `${d.sources.size} records`) : h('span', { class: 'st-warn' }, 'none')),
      ),
    );
    const problems = [...m.coreErrors, ...d.report.notes];
    if (problems.length) {
      this.el.append(h('h3', null, 'Problems'), h('ul', { class: 'st-small' }, problems.map((p) => h('li', { class: 'st-warn' }, p))));
    }
    const statusText = { ok: 'loaded', missing: 'missing', error: 'error', unused: 'not used', deferred: 'deferred', loading: 'loading', 'on-demand': 'on demand' } as const;
    this.el.append(
      h('h3', null, 'Products'),
      h(
        'table',
        { class: 'st-table' },
        h('tr', null, h('th', null, 'Product'), h('th', null, 'Status'), h('th', null, 'Size'), h('th', null, 'Integrity / consequence')),
        d.report.products.map((p) =>
          h(
            'tr',
            null,
            h('td', { class: 'st-mono' }, p.path),
            h('td', null, h('span', { class: `st-status st-status-${p.status}` }, statusText[p.status])),
            h('td', { class: 'st-muted' }, formatBytes(p.bytes)),
            h(
              'td',
              { class: 'st-small' },
              p.status === 'ok'
                ? p.hash === 'verified'
                  ? h('span', { class: 'st-ok' }, 'sha256 matches manifest')
                  : h('span', { class: 'st-muted' }, man ? 'not hash-checked' : 'no manifest to check against')
                : [p.message ? h('div', { class: p.status === 'error' ? 'st-err' : 'st-muted' }, p.message) : null, p.consequence ? h('div', { class: 'st-warn' }, p.consequence) : null],
            ),
          ),
        ),
      ),
    );
  }

  private systemsLine(): Node | string {
    const sys = this.model.systems;
    if (!sys) return 'none deferred (everything loaded at start)';
    const list = h('div', { class: 'st-small' });
    for (const s of sys.systems) {
      const st = sys.state(s.path)!;
      const pr = sys.progress(s.path);
      const txt = st === 'loading' && pr !== null ? `loading ${Math.round(pr * 100)}%` : st === 'error' ? `error: ${sys.error(s.path)}` : st;
      const row = h('div', null, `${s.title}: `, h('span', { class: `st-status st-status-${st === 'loaded' ? 'ok' : st === 'error' ? 'error' : 'deferred'}` }, txt), ` · ${s.bodies.length} bodies · ${formatBytes(s.bytes ?? undefined)} `);
      if (st === 'deferred' || st === 'queued') row.append(h('button', { onclick: () => this.model.requestSystem(s.path) }, 'load now'));
      list.append(row);
    }
    return list;
  }

  private smallBodiesLine(): Node | string {
    const m = this.model;
    const s = m.sb;
    const sb = m.smallBodies;
    const n = (x: number) => x.toLocaleString('en-US');
    const names = m.names ? `names: ${m.names.state}${m.names.state === 'ready' ? ` (${n(m.names.count)}${m.names.verified ? ', sha256 matches manifest' : ''})` : m.names.error ? ` — ${m.names.error}` : ' (indexed when search first needs them)'}` : 'names: not available';
    switch (s.status) {
      case 'absent':
        return 'none (no smallbodies/* products)';
      case 'off':
        return 'not loaded (smallbodies=0 in the URL)';
      case 'waiting':
        return h('div', null, `waiting for the moon systems (${formatBytes(s.total)}) `, h('button', { onclick: () => m.requestSmallBodies() }, 'load now'));
      case 'loading':
        return `loading ${s.total ? Math.round((100 * s.got) / s.total) : 0}% of ${formatBytes(s.total)}`;
      case 'error':
        return h('span', { class: 'st-err' }, s.message ?? 'failed');
    }
    if (!sb) return '';
    const c = m.smallBodyCounts();
    const w = sb.window;
    const drawnBy = sb.field ? 'drawn by the GPU small-body field' : 'not drawn: no small-body renderer in this build (search, inspect and go-to work)';
    return h(
      'div',
      { class: 'st-small' },
      h('div', null, `${n(sb.count)} objects${s.ms !== null ? `, usable ${sig(s.ms / 1000, 2)} s after the download began` : ''}; ${drawnBy}.`),
      c ? h('div', null, `At ${m.reality.exists}: ${n(c.drawn)} ${sb.field ? 'drawn' : 'admitted'}, ${n(c.withheld)} withheld, ${n(c.noPosition)} without a position (${c.from === 'field' ? 'counted by the field' : 'by catalogue labels'}).`) : null,
      h('div', null, `Positions propagated within ${m.formatTime(w.startEt)} → ${m.formatTime(w.endEt)}; ${names}.`),
    );
  }

  private starsLine(): string {
    const d = this.model.data;
    if (!d?.stars) return 'none';
    const r = this.model.starCatalog();
    const t = d.stars.table;
    if (!r) return `${t.count} rows (layout not usable — see Problems)`;
    const counts = Object.entries(r.labelCounts).map(([l, n]) => `${n} ${l}`).join(', ');
    return `${t.count} in ${d.stars.path} [${r.layout}]; ${r.catalog.count} drawn at this level${r.withheld ? `, ${r.withheld} withheld` : ''}${counts ? ` (${counts})` : ''}; ${d.starNames.length} names`;
  }
}
