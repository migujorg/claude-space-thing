// Provenance label chips and their legend (NORTH_STAR 3.2).

import { LABEL_ORDER, type Label } from '../data/schema';
import { LABEL_TEXT } from '../app/reality';
import { h } from './dom';

export function chip(label: Label): HTMLSpanElement {
  return h('span', { class: `st-chip st-chip-${label}`, title: `${label}: ${LABEL_TEXT[label]}` }, label);
}

/** Label legend; `smallBodies` adds the small-body brightness notes (ui/smallBodyInspect.ts smallBodyLegend). */
export function legend(smallBodies: string[] = []): HTMLElement {
  return h(
    'div',
    { class: 'st-legend' },
    h('h3', null, 'Provenance labels'),
    LABEL_ORDER.map((l) => h('div', null, chip(l), h('span', null, LABEL_TEXT[l]))),
    h('div', null, h('span'), h('span', null, 'A computed value carries the worst label among its inputs, and at least "estimated" if the computation adds an assumption.')),
    smallBodies.length ? [h('h3', null, 'Small-body brightness'), smallBodies.map((t) => h('div', null, h('span'), h('span', null, t)))] : null,
  );
}
