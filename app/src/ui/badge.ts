// Top-center: persistent reality badge (whenever the pixels are not at default settings, so a
// screenshot never misleads — it stays visible even with the UI hidden), plus the data-window alert.

import type { AppModel } from '../app/model';
import { clear, h, setText, toggleClass } from './dom';

export class TopBar {
  readonly el: HTMLElement;
  private badge: HTMLElement;
  private alert: HTMLElement;
  private lastBadge = '';

  constructor(private model: AppModel, banner?: string) {
    this.badge = h('div', { class: 'st-badge', title: 'Reality settings differ from the default (naked eye, default level). Shown so a screenshot never misleads.' });
    this.alert = h('div', { class: 'st-alert' });
    this.el = h('div', { class: 'st-top' }, banner ? h('div', { class: 'st-banner' }, banner) : null, this.badge, this.alert);
    model.on('reality', () => this.renderBadge());
    this.renderBadge();
  }

  private renderBadge(): void {
    const parts = this.model.badge();
    const key = parts.join('|');
    if (key === this.lastBadge) return;
    this.lastBadge = key;
    clear(this.badge);
    for (const p of parts) this.badge.appendChild(h('span', null, p));
    toggleClass(this.badge, 'st-show', parts.length > 0);
  }

  update(): void {
    const c = this.model.clock.snapshot();
    let msg = '';
    if (!c.window && this.model.data) msg = 'No data window: no manifest or ephemeris loaded — nothing can be positioned.';
    else if (c.outside)
      msg = `Requested ${this.model.formatTime(c.outside.requestedEt)} is outside the data window — showing its ${c.outside.edge}. Nothing is extrapolated.`;
    else if (c.stoppedAt) msg = `Stopped at the ${c.stoppedAt} of the data window.`;
    setText(this.alert, msg);
    toggleClass(this.alert, 'st-show', msg !== '');
  }
}
