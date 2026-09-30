// Keyboard/mouse reference overlay (? key).

import { h, toggleClass } from './dom';

export const KEYS: [string, string][] = [
  ['Space', 'play / pause'],
  ['1 … 6', 'rate: real time … 30 days/s'],
  [', / .', 'slower / faster'],
  ['R', 'reverse time'],
  ['N', 'now'],
  ['T', 'type a time (UTC)'],
  ['/', 'search / go to'],
  ['G', 'go to selected'],
  ['Esc', 'close / deselect / stop travel'],
  ['F', 'orbit ↔ free flight'],
  ['drag', 'orbit (orbit) · look (free)'],
  ['wheel', 'zoom (log distance)'],
  ['W / S', 'zoom (orbit) · forward / back (fly)'],
  ['A / D  ← / →', 'orbit / fly sideways'],
  ['↑ / ↓  PgUp / PgDn', 'orbit up-down / fly up-down'],
  ['Z / C', 'roll'],
  ['Shift / Alt', 'faster / slower flight'],
  ['click', 'select · double-click: go to'],
  ['[ / ]', 'narrower / wider field of view'],
  ['X', 'cycle Strict / Best / Complete'],
  ['V', 'naked eye ↔ enhanced'],
  ['− / =', 'exposure boost (enhanced)'],
  ['L / O / P', 'labels / orbits / provenance tint'],
  ['E', 'Moments: eclipses, transits, oppositions, close approaches'],
  ['I', 'inspector'],
  ['M', 'data products'],
  ['U', 'copy link to this view'],
  ['H', 'hide all UI (badge stays if not default)'],
  ['?', 'this help'],
];

export class Help {
  readonly el: HTMLElement;
  constructor() {
    this.el = h(
      'div',
      { class: 'st-panel st-modal st-help' },
      h('button', { class: 'st-x', title: 'Close (Esc)', onclick: () => this.toggle(false) }, '×'),
      h('h2', null, 'Keys'),
      h('div', { class: 'st-keys' }, KEYS.flatMap(([k, d]) => [h('div', null, h('span', { class: 'st-kbd' }, k)), h('div', null, d)])),
      h('p', { class: 'st-muted st-small' }, 'Every value on screen comes from the data products (see M); click any body, then any source, to see where a number came from. E lists real events in the data window (eclipses, transits, oppositions, close approaches) with a camera placed to see each.'),
    );
  }
  get open(): boolean {
    return this.el.classList.contains('st-show');
  }
  toggle(on = !this.open): void {
    toggleClass(this.el, 'st-show', on);
  }
}
