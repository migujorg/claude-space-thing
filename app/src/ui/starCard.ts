// Star card: what is known about a picked star (bright or deep tier), with provenance, in the inspector's style.
// Opened by clicking a star that no body covers (app/sky.ts attachStarPicking); closed with × or when a body is
// selected.

import type { StarFacts } from '../app/sky';
import { chip } from './chips';
import { append, clear, h, toggleClass } from './dom';

export class StarCard {
  readonly el: HTMLElement;

  constructor(private readonly actions: { openSources(ids: string[], title: string): void } | null = null) {
    this.el = h('div', { class: 'st-panel st-inspector st-star-card' });
  }

  show(f: StarFacts | null): void {
    clear(this.el);
    toggleClass(this.el, 'st-show', !!f);
    if (!f) return;
    const title = f.name ?? f.catalogId;
    const tier = f.tier === 'bright' ? 'bright tier (stars/bright)' : 'deep tier (stars/deep)';
    const [X, Y, Z, S] = f.xyzs;
    const sum = X + Y + Z;
    const row = (name: string, label: StarFacts['labels']['flux'] | null, value: string, tip = '') =>
      [h('div', { title: tip }, name), h('div', null, label ? chip(label) : null, h('span', { class: 'st-mono', style: 'margin-left:6px' }, value))];
    append(this.el, [
      h('div', { class: 'st-title' },
        h('h2', null, title),
        h('span', { class: 'st-muted' }, `star · ${tier}`),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'st-x', title: 'Close', onclick: () => this.show(null) }, '×')),
      h('div', { class: 'st-kv' },
        row('Catalogue', null, f.catalogId, `Record source: ${f.catalog}`),
        row('Brightness', f.labels.flux, `${Y.toExponential(3)} lx · V≈${f.vLike.toFixed(2)}`, 'Photopic illuminance Y at the observer (outside any atmosphere); V-like magnitude from Y (2.54e-6 lx for V = 0)'),
        row('Colour', f.labels.colour, `x ${(X / sum).toFixed(4)}, y ${(Y / sum).toFixed(4)} · S/Y ${(S / Y).toFixed(2)}`, 'CIE 1931 chromaticity and scotopic-to-photopic ratio'),
        row('Direction', f.labels.position, `RA ${f.radecDeg[0].toFixed(4)}°, Dec ${f.radecDeg[1] >= 0 ? '+' : ''}${f.radecDeg[1].toFixed(4)}°`, 'ICRS direction as drawn, at the catalogue epoch of the build')),
      h('h3', null, 'How these values were obtained'),
      h('div', { class: 'st-attr' },
        h('div', { class: 'st-attr-head' }, f.routes.light ? chip(f.routes.light.label) : chip('unknown'), h('span', { class: 'st-attr-name' }, 'Light')),
        h('div', { class: 'st-attr-val st-small' }, f.routes.light?.method ?? 'not stated')),
      h('div', { class: 'st-attr' },
        h('div', { class: 'st-attr-head' }, f.routes.position ? chip(f.routes.position.label) : chip('unknown'), h('span', { class: 'st-attr-name' }, 'Position')),
        h('div', { class: 'st-attr-val st-small' }, f.routes.position?.method ?? 'not stated')),
      f.flags.length ? [h('h3', null, 'Flags'), h('ul', { class: 'st-flags st-small' }, f.flags.map((x) => h('li', null, x)))] : null,
      f.sources.length
        ? h('div', { class: 'st-small', style: 'margin-top:6px' },
          this.actions ? h('button', { onclick: () => this.actions!.openSources(f.sources, title) }, `Sources (${f.sources.length})`) : null,
          h('span', { class: 'st-muted', style: 'margin-left:6px' }, f.sources.join(', ')))
        : null,
    ]);
  }
}
