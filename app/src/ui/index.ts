// Mounts the whole UI into a root element and exposes a per-frame update.

import './ui.css';
import type { AppModel } from '../app/model';
import { formatUrlParams } from '../app/url';
import type { RendererStats } from '../render/scene';
import { TopBar } from './badge';
import { DataPanel } from './dataPanel';
import { Dials } from './dials';
import { h, toggleClass } from './dom';
import { EventsPanel } from './events';
import { FirstRunHint } from './hint';
import { Help } from './help';
import { Hud } from './hud';
import { Input } from './input';
import { Inspector } from './inspector';
import { Labels } from './labels';
import { LoadingPill } from './loading';
import { Search } from './search';
import { SourcesPanel } from './sources';
import { Toasts } from './toasts';

export interface Ui {
  root: HTMLElement;
  /** Bind canvas pointer + window keyboard input. */
  attachInput(canvas: HTMLElement): Input;
  update(dt: number, stats: RendererStats | null): void;
  fatal(msg: string): void;
  status(msg: string | null): void;
  /** Open a panel programmatically (dev page, scripted screenshots). */
  openPanel(name: 'data' | 'help' | 'sources' | 'dials' | 'search' | 'events', arg?: string[]): void;
  /** After the first view is set up: the first-run hint, if this is one. */
  started(): void;
}

export function mountUi(container: HTMLElement, model: AppModel, opts: { banner?: string } = {}): Ui {
  const root = h('div', { class: 'st-ui' });
  const sources = new SourcesPanel(model);
  const openSources = (ids: string[], title: string) => sources.show(ids, title);
  const data = new DataPanel(model, { openSources });
  const help = new Help();
  const events = new EventsPanel(model, { openSources });
  const hint = new FirstRunHint(model);
  const copyLink = () => {
    const q = formatUrlParams(model.currentUrlView());
    const url = `${location.origin}${location.pathname}?${q}`;
    history.replaceState(null, '', `?${q}`);
    navigator.clipboard?.writeText(url).then(
      () => model.message('Link to this view copied (and put in the address bar).'),
      () => model.message('Link to this view is in the address bar.'),
    );
  };
  const dials = new Dials(model, { openData: () => data.toggle(true), copyLink });
  const inspector = new Inspector(model, { openSources });
  const search = new Search(model);
  const hud = new Hud(model);
  // Labels avoid the areas covered by panels (evaluated per frame, after everything is mounted).
  const labels = new Labels(model, () => [search.el, dials.el, inspector.el, loading.el, ...Array.from(hud.el.children), ...Array.from(top.el.children)]);
  const top = new TopBar(model, opts.banner);
  top.el.append(hint.el);
  const toasts = new Toasts(model);
  const loading = new LoadingPill(model, () => data.toggle(true));
  const statusEl = h('div', { class: 'st-panel st-fatal', style: 'display:none' });
  const right = h('div', { class: 'st-right' }, dials.el, inspector.el);
  root.append(labels.el, search.el, right, hud.el, loading.el, sources.el, data.el, help.el, events.el, toasts.el, statusEl, top.el);
  const toggleHelp = (on?: boolean) => { help.toggle(on); if (help.open && hint.shown) hint.dismiss(); };
  const toggleEvents = (on?: boolean) => { events.toggle(on); if (events.open && hint.shown) hint.dismiss(); };
  container.appendChild(root);

  const applyHidden = () => toggleClass(root, 'st-hidden', model.uiHidden);
  applyHidden();

  return {
    root,
    attachInput(canvas) {
      return new Input(model, canvas, {
        toggleUi: () => { model.uiHidden = !model.uiHidden; applyHidden(); },
        focusSearch: () => { if (model.uiHidden) { model.uiHidden = false; applyHidden(); } search.focus(); },
        editTime: () => hud.editTime(),
        toggleInspector: () => inspector.toggle(),
        toggleData: () => data.toggle(),
        toggleHelp: () => toggleHelp(),
        toggleEvents: () => toggleEvents(),
        copyLink,
        closeTop: () => {
          if (sources.open) { sources.close(); return true; }
          if (data.open) { data.toggle(false); return true; }
          if (help.open) { help.toggle(false); return true; }
          if (events.open) { events.toggle(false); return true; }
          if (hint.shown) { hint.dismiss(); return true; }
          return false;
        },
      });
    },
    update(_dt, stats) {
      applyHidden();
      if (model.uiHidden) {
        top.update();
        return;
      }
      labels.update();
      hud.update(stats);
      inspector.update(stats);
      top.update();
    },
    fatal(msg) {
      statusEl.textContent = msg;
      statusEl.style.display = '';
      statusEl.classList.add('st-err');
    },
    status(msg) {
      statusEl.textContent = msg ?? '';
      statusEl.style.display = msg ? '' : 'none';
    },
    openPanel(name, arg) {
      if (name === 'data') data.toggle(true);
      else if (name === 'help') toggleHelp(true);
      else if (name === 'events') toggleEvents(true);
      else if (name === 'dials') dials.el.classList.remove('st-collapsed');
      else if (name === 'search') search.focus();
      else if (name === 'sources') sources.show(arg ?? [...(model.data?.sources.keys() ?? [])], 'Sources');
    },
    started() {
      hint.maybeShow();
    },
  };
}
