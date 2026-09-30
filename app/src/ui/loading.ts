// Small indicator for moon systems loading in the background. Hidden once everything is in; click → Data panel.

import type { AppModel } from '../app/model';
import { h, setText, toggleClass } from './dom';

export class LoadingPill {
  readonly el = h('div', { class: 'st-panel st-loading', title: 'Moon systems load in the background; bodies appear when their ephemeris is in. Click for details.' });
  private text = h('span');
  private bar = h('div', { class: 'st-bar' }, h('div'));

  constructor(private model: AppModel, onClick: () => void) {
    this.el.append(this.text, this.bar);
    this.el.addEventListener('click', onClick);
    model.on('loading', () => this.render());
    model.on('data', () => this.render());
    this.render();
  }

  private render(): void {
    const sys = this.model.systems;
    const s = sys?.summary();
    const busy = !!s && (s.active.length > 0 || s.queued > 0);
    const failed = !!s && s.errors.length > 0;
    toggleClass(this.el, 'st-show', busy || failed);
    if (!s) return;
    const act = s.active.map((a) => `${a.title.replace(' system', '')} ${a.progress !== null ? `${Math.round(a.progress * 100)}%` : '…'}`).join(' · ');
    setText(this.text, `Moon systems ${s.loaded}/${s.total}${act ? ` · ${act}` : ''}${failed ? ` · ${s.errors.length} failed` : ''}`);
    const frac = (s.loaded + s.active.reduce((a, x) => a + (x.progress ?? 0), 0)) / Math.max(1, s.total);
    (this.bar.firstChild as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
    toggleClass(this.el, 'st-err', failed && !busy);
  }
}
