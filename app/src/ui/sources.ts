// Sources panel: the full SourceRecord behind every value (NORTH_STAR 3.2 "how do we know that?").

import type { AppModel } from '../app/model';
import { clear, h, toggleClass } from './dom';

export class SourcesPanel {
  readonly el = h('div', { class: 'st-panel st-modal st-sources' });

  constructor(private model: AppModel) {}

  get open(): boolean {
    return this.el.classList.contains('st-show');
  }

  close(): void {
    toggleClass(this.el, 'st-show', false);
  }

  show(ids: string[], title: string): void {
    const srcs = this.model.data?.sources ?? new Map();
    clear(this.el);
    this.el.append(
      h('button', { class: 'st-x', title: 'Close (Esc)', onclick: () => this.close() }, '×'),
      h('h2', null, title),
      h('div', { class: 'st-muted st-small' }, `${ids.length} source${ids.length === 1 ? '' : 's'} — from sources.json, written by the pipeline when it downloaded each dataset.`),
    );
    for (const id of ids) {
      const s = srcs.get(id);
      if (!s) {
        this.el.append(h('div', { class: 'st-source' }, h('div', { class: 'st-mono' }, id), h('div', { class: 'st-warn' }, 'Not found in sources.json.')));
        continue;
      }
      const kv = (k: string, v: string | Node | undefined) => (v ? [h('div', null, k), h('div', null, v)] : []);
      this.el.append(
        h(
          'div',
          { class: 'st-source' },
          h('div', { style: 'color:var(--hi);font-weight:600' }, s.title),
          h(
            'div',
            { class: 'st-kv' },
            kv('id', h('span', { class: 'st-mono' }, s.id)),
            kv('citation', s.citation),
            kv('url', h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.url)),
            kv('version', s.version),
            kv('retrieved', s.retrieved),
            kv('sha256', s.sha256 ? h('span', { class: 'st-mono' }, s.sha256) : undefined),
            kv('license', s.license),
            kv('notes', s.notes),
          ),
        ),
      );
    }
    toggleClass(this.el, 'st-show', true);
  }
}
