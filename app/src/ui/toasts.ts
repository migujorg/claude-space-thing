// Transient messages from the model (warnings about URL params, window edges, go-to failures).
// Each 'message' event corresponds to exactly one new message (the last in model.messages).

import type { AppModel } from '../app/model';
import { h } from './dom';

export class Toasts {
  readonly el = h('div', { class: 'st-toasts' });

  constructor(private model: AppModel) {
    model.on('message', () => this.show());
  }

  private show(): void {
    const m = this.model.messages[this.model.messages.length - 1];
    if (!m) return;
    const t = h('div', { class: `st-toast st-${m.level}` }, m.text);
    this.el.appendChild(t);
    while (this.el.children.length > 3) this.el.firstChild!.remove();
    setTimeout(() => { t.style.opacity = '0'; }, 6000);
    setTimeout(() => t.remove(), 6500);
  }
}
