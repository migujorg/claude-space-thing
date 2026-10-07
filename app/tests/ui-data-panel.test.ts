import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModel } from '../src/app/model';
import type { ExistsLevel } from '../src/app/reality';
import type { SyntheticPopulation } from '../src/data/schema';
import { DataPanel } from '../src/ui/dataPanel';

// Minimal DOM for text rendering and source clicks; runs the panel and its real DOM helpers without a browser.
class TestNode {
  children: TestNode[] = [];
  className = '';
  listeners = new Map<string, EventListener>();
  constructor(readonly tagName = '', private text = '') {}
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(''); }
  get firstChild(): TestNode | null { return this.children[0] ?? null; }
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, on: boolean) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      if (on) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    },
  };
  appendChild(child: TestNode): void { this.children.push(child); }
  append(...children: TestNode[]): void { this.children.push(...children); }
  removeChild(child: TestNode): void { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(): void {}
  addEventListener(name: string, listener: EventListener): void { this.listeners.set(name, listener); }
  find(tag: string): TestNode[] {
    return [...(this.tagName === tag ? [this] : []), ...this.children.flatMap((c) => c.find(tag))];
  }
}

const method = 'Fixture population method: conditional model deficit, with sampled orbital angles.';
const uncertainty = 'Fixture population uncertainty: individual existence and orbit are unknown.';
const proxy = 'Fixture completeness proxy fitted from a/H bins, not a detection probability; no per-object observation veto.';
const yieldRule = 'Fixture yield is aggregate, not one-to-one discovery replacement; fixed model/limits/templates only, refits can change counts and identities.';

function population(): SyntheticPopulation {
  return {
    name: 'mainbelt', code: 2, modelId: 'fixture-model', sources: ['fixture-source'], prefix: 'fixture',
    grid: { aEdgesAu: [2, 3], eWidth: 0.1, iWidthDeg: 1, nE: 1, nI: 1, hWidthMag: 1, hAlignment: '' },
    hFloor: 20, limit: { uncertainty: proxy },
    model: { method, uncertainty, motion: 'Fixture motion.', positionUncertainty: 'Fixture position budget unknown.' },
    firstCell: 0, cells: 1, firstObject: 0, objects: 3, knownInGrid: 2,
    totals: { model: 5, knownInGroups: 2, rawDeficit: 3, deficit: 3, shown: 3, groups: 1 },
  };
}

function setup(level: ExistsLevel = 'complete', populations = [population()], syntheticCount = 3) {
  const header = { populations, yieldRule };
  const openSources = vi.fn();
  const model = {
    on: vi.fn(), data: { bodies: [], ephemerides: [], orientations: [], surfaces: [], sources: new Map(),
      starNames: [], report: { products: [], notes: [] } },
    clock: { window: null }, coreErrors: [], systems: null, reality: { exists: level },
    sb: { status: 'ready', ms: null },
    smallBodies: { count: 2, syntheticCount, synthetic: { header }, window: { startEt: 0, endEt: 1 } },
    smallBodyCounts: () => ({ drawn: 2, withheld: 0, noPosition: 0, from: 'catalogue',
      synthetic: { drawn: level === 'complete' ? syntheticCount : 0 } }),
    formatTime: (et: number) => `fixture time ${et}`,
  };
  const panel = new DataPanel(model as unknown as AppModel, { openSources });
  panel.toggle(true);
  return { panel, header, model, el: panel.el as unknown as TestNode, openSources };
}

beforeEach(() => vi.stubGlobal('document', {
  createElement: (tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('', text),
}));
afterEach(() => vi.unstubAllGlobals());

describe('data panel synthetic statements', () => {
  it.each(['strict', 'best', 'complete'] as const)('discloses product limitations at %s', (level) => {
    const { el } = setup(level);
    const text = el.textContent;
    expect(text).toContain('statistical objects standing in for conditional model deficits');
    expect(text).toContain('drawn at Complete only');
    expect(text).toContain(`— ${level === 'complete' ? 3 : 0} drawn now`);
    for (const statement of [method, uncertainty, proxy, yieldRule, 'Fixture motion.', 'Fixture position budget unknown.']) {
      expect(text).toContain(statement);
    }
    expect(text).not.toMatch(/undiscovered ones|only (?:what|objects) surveys (?:could not|couldn't) have seen|never contradicts? an observation/i);
  });

  it('reads new wording from the product when rendered again', () => {
    const { panel, header, el } = setup();
    header.yieldRule = 'Updated fixture yield statement.';
    header.populations[0].limit.uncertainty = 'Updated fixture completeness statement.';
    header.populations[0].model.method = 'Updated fixture method.';
    panel.toggle(true);
    expect(el.textContent).toContain(header.yieldRule);
    expect(el.textContent).toContain(String(header.populations[0].limit.uncertainty));
    expect(el.textContent).toContain(String(header.populations[0].model.method));
    expect(el.textContent).not.toContain(yieldRule);
  });

  it('shows unknowns when older population metadata lacks limitations', () => {
    const p = population();
    p.limit = {};
    p.model = {};
    const { el } = setup('complete', [p]);
    expect(el.textContent).toContain('Completeness proxy; detection probability unknown.');
    expect(el.textContent).toContain('Population count and template-selection uncertainty are unknown');
    expect(el.textContent).toContain('Motion metadata unavailable.');
    expect(el.textContent).toContain('Individual position budget unknown.');
  });

  it('keeps zero-object population limitations available', () => {
    const p = population();
    p.name = 'irregular-uranus';
    p.objects = 0;
    const { el } = setup('complete', [p], 0);
    expect(el.textContent).toContain('irregular-uranus: 0 synthetic objects');
    expect(el.textContent).toContain(proxy);
    expect(el.textContent).toContain(yieldRule);
    expect(el.textContent).not.toContain('Synthetic layer:');
  });

  it('opens the population sources', () => {
    const { el, openSources } = setup();
    const sources = el.find('button').find((b) => b.textContent === 'Sources');
    expect(sources).toBeDefined();
    sources!.listeners.get('click')!({} as Event);
    expect(openSources).toHaveBeenCalledWith(['fixture-source'], 'mainbelt');
  });
});
