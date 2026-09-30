// First-run hint line (opened without URL parameters): what to press. Dismissible; once dismissed (or once the
// help or the Moments panel has been opened) it is not shown again in this browser.

import type { AppModel } from '../app/model';
import { h, toggleClass } from './dom';

export const HINT_TEXT = '? for keys · E for events · click anything to see where it comes from';
export const HINT_KEY = 'st-hint-dismissed';

/** Shown on a first run unless it was dismissed before (storage errors: shown). */
export function shouldShowHint(firstRun: boolean, storage: Storage | null): boolean {
  if (!firstRun) return false;
  try {
    return storage?.getItem(HINT_KEY) !== '1';
  } catch {
    return true;
  }
}

/** Remember the dismissal (no storage: it may show again next time). */
export function rememberHintDismissed(storage: Storage | null): void {
  try {
    storage?.setItem(HINT_KEY, '1');
  } catch {
    // ignore
  }
}

/** Hide by itself after this long (a framing choice), ms. */
const HINT_MS = 30_000;

export class FirstRunHint {
  readonly el: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private model: AppModel, private storage: () => Storage | null = () => (typeof localStorage !== 'undefined' ? localStorage : null)) {
    this.el = h('div', { class: 'st-hint' }, h('span', null, HINT_TEXT), h('button', { class: 'st-x', title: 'Dismiss', onclick: () => this.dismiss() }, '×'));
  }

  /** Show it if this is a first run and it was never dismissed. */
  maybeShow(): void {
    if (!shouldShowHint(this.model.firstRun, this.store())) return;
    toggleClass(this.el, 'st-show', true);
    this.timer = setTimeout(() => this.hide(), HINT_MS);
  }

  get shown(): boolean {
    return this.el.classList.contains('st-show');
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    toggleClass(this.el, 'st-show', false);
  }

  /** Hide and remember (the user dismissed it, or used what it points to). */
  dismiss(): void {
    this.hide();
    rememberHintDismissed(this.store());
  }

  private store(): Storage | null {
    try {
      return this.storage();
    } catch {
      return null;
    }
  }
}
