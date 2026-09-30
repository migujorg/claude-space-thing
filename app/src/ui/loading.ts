// Small indicator for background loading: moon systems, then the small-body catalogue, and the small-body name
// index when search needs it. Hidden once everything is in; click → Data panel.

import type { AppModel } from '../app/model';
import { h, setText, toggleClass } from './dom';

export class LoadingPill {
  readonly el = h('div', { class: 'st-panel st-loading', title: 'Moon systems and the small-body catalogue load in the background; bodies appear when their data is in. Click for details.' });
  private text = h('span');
  private bar = h('div', { class: 'st-bar' }, h('div'));

  constructor(private model: AppModel, onClick: () => void) {
    this.el.append(this.text, this.bar);
    this.el.addEventListener('click', onClick);
    model.on('loading', () => this.render());
    model.on('data', () => this.render());
    model.on('smallbodies', () => this.render());
    this.render();
  }

  private render(): void {
    const m = this.model;
    const s = m.systems?.summary();
    const sysBusy = !!s && (s.active.length > 0 || s.queued > 0);
    const sysFailed = !!s && s.errors.length > 0;
    const sb = m.sb;
    const sbBusy = sb.status === 'loading';
    const ns = m.names?.state;
    const namesBusy = ns === 'loading' || ns === 'indexing';
    const failed = sysFailed || sb.status === 'error' || ns === 'error';
    const busy = sysBusy || sbBusy || namesBusy;
    toggleClass(this.el, 'st-show', busy || failed);
    const parts: string[] = [];
    let frac: number | null = null;
    if (s && (sysBusy || sysFailed)) {
      const act = s.active.map((a) => `${a.title.replace(' system', '')} ${a.progress !== null ? `${Math.round(a.progress * 100)}%` : '…'}`).join(' · ');
      parts.push(`Moon systems ${s.loaded}/${s.total}${act ? ` · ${act}` : ''}${sysFailed ? ` · ${s.errors.length} failed` : ''}`);
      if (sysBusy) frac = (s.loaded + s.active.reduce((a, x) => a + (x.progress ?? 0), 0)) / Math.max(1, s.total);
    }
    const sbFrac = sb.total ? sb.got / sb.total : 0;
    if (sbBusy) {
      parts.push(`Small bodies ${Math.round(sbFrac * 100)}%`);
      frac ??= sbFrac;
    } else if (sb.status === 'error') parts.push('Small bodies failed');
    if (namesBusy) parts.push(ns === 'indexing' ? 'Small-body names: indexing…' : 'Small-body names: loading…');
    else if (ns === 'error') parts.push('Small-body names failed');
    setText(this.text, parts.join(' · '));
    (this.bar.firstChild as HTMLElement).style.width = `${Math.round((frac ?? (namesBusy ? 1 : 0)) * 100)}%`;
    toggleClass(this.el, 'st-err', failed && !busy);
  }
}
