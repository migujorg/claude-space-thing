import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppModel } from '../src/app/model';
import type { RendererStats } from '../src/render/scene';

// Small DOM double: no browser is needed to exercise alert text, visibility and UI routing.
const dom = vi.hoisted(() => {
  const element = (className = '') => {
    const classes = new Set(className.split(' ').filter(Boolean));
    return {
      children: [] as unknown[], textContent: '', className,
      classList: { contains: (c: string) => classes.has(c), toggle: (c: string, on: boolean) => on ? classes.add(c) : classes.delete(c), add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      style: { setProperty: vi.fn(), display: '' },
      append(...children: unknown[]) { this.children.push(...children); },
      appendChild(child: unknown) { this.children.push(child); },
    };
  };
  class Panel { el = element(); update() {} maybeShow() {} }
  return { element, Panel };
});
vi.mock('../src/ui/dom', () => ({
  h: (_tag: string, attrs?: { class?: string }, ...children: unknown[]) => { const el = dom.element(attrs?.class); el.append(...children); return el; },
  clear: (el: ReturnType<typeof dom.element>) => { el.children = []; },
  setText: (el: ReturnType<typeof dom.element>, text: string) => { el.textContent = text; },
  toggleClass: (el: ReturnType<typeof dom.element>, cls: string, on: boolean) => el.classList.toggle(cls, on),
}));
vi.mock('../src/ui/dataPanel', () => ({ DataPanel: dom.Panel }));
vi.mock('../src/ui/dials', () => ({ Dials: dom.Panel }));
vi.mock('../src/ui/events', () => ({ EventsPanel: dom.Panel }));
vi.mock('../src/ui/hint', () => ({ FirstRunHint: dom.Panel }));
vi.mock('../src/ui/help', () => ({ Help: dom.Panel }));
vi.mock('../src/ui/hud', () => ({ Hud: dom.Panel }));
vi.mock('../src/ui/input', () => ({ Input: dom.Panel }));
vi.mock('../src/ui/inspector', () => ({ Inspector: dom.Panel }));
vi.mock('../src/ui/labels', () => ({ Labels: dom.Panel }));
vi.mock('../src/ui/loading', () => ({ LoadingPill: dom.Panel }));
vi.mock('../src/ui/search', () => ({ Search: dom.Panel }));
vi.mock('../src/ui/sources', () => ({ SourcesPanel: dom.Panel }));
vi.mock('../src/ui/toasts', () => ({ Toasts: dom.Panel }));
import { mountUi } from '../src/ui/index';

function setup(hidden: boolean) {
  const model = {
    uiHidden: hidden, on: vi.fn(), badge: () => [], data: {},
    clock: { snapshot: () => ({ window: {}, stoppedAt: 'end' }) },
  } as unknown as AppModel;
  const ui = mountUi(dom.element() as unknown as HTMLElement, model);
  const root = ui.root as unknown as ReturnType<typeof dom.element>;
  const top = root.children.find((c) => (c as typeof root)?.className === 'st-top') as typeof root;
  const alert = top.children.find((c) => (c as typeof root)?.className === 'st-alert') as typeof root;
  return { ui, alert };
}
const stats = (warnings: string[]): RendererStats => ({ frameMs: 0, adaptationLuminance: 0, starsDrawn: 0, warnings });
afterEach(() => vi.clearAllMocks());
describe('persistent renderer alert', () => {
  it.each([false, true])('receives frame refusals and GPU errors with uiHidden=%s', (hidden) => {
    const { ui, alert } = setup(hidden);
    const refusal = 'Frame cannot be rendered: 8193 × 720 exceeds maxTextureDimension2D 8192.';
    const gpu = 'WebGPU error: invalid bind group';
    ui.update(0, stats([refusal, gpu, 'Earth: photometry unavailable']));
    expect(alert.textContent).toBe(`${refusal} ${gpu} Stopped at the end of the data window.`);
    expect(alert.classList.contains('st-show')).toBe(true);
    // ui.css hides every top child except the badge using !important when UI is hidden.
    expect(alert.style.setProperty).toHaveBeenLastCalledWith('display', 'block', 'important');
    ui.update(0, stats([]));
    expect(alert.textContent).toBe('Stopped at the end of the data window.');
  });
});
