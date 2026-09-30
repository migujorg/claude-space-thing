// Inspector: everything known about the selected body, with provenance for every value.

import type { AppModel } from '../app/model';
import { EXISTS_TEXT, LABEL_TEXT, labelAllowed, whyLine } from '../app/reality';
import { angularRadius, rayEllipsoid } from '../app/picking';
import { dot, len, scale } from '../app/vec';
import type { Label } from '../data/schema';
import { chip, legend } from './chips';
import { clear, h, setText, toggleClass } from './dom';
import { formatAngle, formatDistance, formatDuration } from './format';
import { attributeRows, derivedLabel, shapeRow, sunRows, sunWhy, type AttrRow } from './inspectModel';
import { buildSun } from '../app/snapshot';
import { sbRow } from '../app/smallbodies';
import { brightnessInputs, smallBodyFacts, smallBodyLegend, smallBodyWhy } from './smallBodyInspect';
import { syntheticFacts, syntheticWhy } from './syntheticInspect';

interface LiveCell {
  value: HTMLElement;
  chip: HTMLElement;
}

export class Inspector {
  readonly el: HTMLElement;
  private live = new Map<string, LiveCell>();
  private why = h('div', { class: 'st-why' });
  private lastLive = 0;
  private id: number | null = null;
  /** What the attribute rows were built from; a change (load state, orientation source) triggers a rebuild. */
  private builtKey = '';

  constructor(private model: AppModel, private actions: { openSources(ids: string[], title: string): void }) {
    this.el = h('div', { class: 'st-panel st-inspector' });
    model.on('selection', () => this.build());
    model.on('reality', () => this.build());
    model.on('data', () => this.build());
    model.on('time', () => { this.lastLive = 0; });
    model.on('loading', () => { if (this.id !== null && this.stateKey(this.id) !== this.builtKey) this.build(); });
    model.on('smallbodies', () => { if (this.id !== null && this.id < 0 && this.stateKey(this.id) !== this.builtKey) this.build(); });
  }

  get visible(): boolean {
    return this.el.classList.contains('st-show');
  }

  toggle(): void {
    if (this.model.selectedId === null) return;
    toggleClass(this.el, 'st-show', !this.visible);
  }

  private build(): void {
    const m = this.model;
    const id = m.selectedId;
    const body = id !== null ? m.bodyOf(id) : undefined;
    const reopen = id !== this.id;
    this.id = id;
    clear(this.el);
    this.live.clear();
    if (!body) {
      toggleClass(this.el, 'st-show', false);
      return;
    }
    if (reopen) toggleClass(this.el, 'st-show', true);
    const level = m.reality.exists;
    const f = m.filtered(body.id)!;
    const parent = body.parent !== undefined ? m.byId.get(body.parent) : undefined;
    const sb = body.id < 0 ? m.smallBodies : null;
    const sbRowId = sb ? sbRow(body.id) : null;
    const sbSummary = sb && sbRowId !== null ? sb.summary(sbRowId) : null;
    const synthetic = !!sb && sbRowId !== null && sb.isSynthetic(sbRowId);
    const spkid = sbRowId !== null && !synthetic ? m.names?.spkidOf(sbRowId) ?? null : null;
    const subtitle = synthetic
      ? `synthetic ${sbSummary?.orbitClass?.name ?? 'object'} · not a real object`
      : sbSummary
        ? `${sbSummary.comet ? 'comet' : 'asteroid'}${sbSummary.orbitClass ? ` · ${sbSummary.orbitClass.name} (${sbSummary.orbitClass.code})` : ''}${spkid !== null ? ` · SPK-ID ${spkid}` : ''}`
        : `${body.kind}${parent ? ` of ${parent.name}` : ''} · NAIF ${body.id}`;

    const liveRow = (key: string, name: string, tip: string) => {
      const cell = { value: h('span', { class: 'st-mono' }), chip: h('span', { class: 'st-chip st-chip-unknown', style: 'min-width:0;margin-right:6px' }) };
      this.live.set(key, cell);
      return [h('div', { title: tip }, name), h('div', null, cell.chip, cell.value)];
    };

    this.el.append(
      h(
        'div',
        { class: 'st-title' },
        h('h2', null, body.name),
        h('span', { class: 'st-muted' }, subtitle),
        h('span', { style: 'flex:1' }),
        h('button', { title: 'Travel here (G)', onclick: () => void m.goTo(body.id) }, 'Go to'),
        h('button', { class: 'st-x', title: 'Close (Esc)', onclick: () => m.select(null) }, '×'),
      ),
      h(
        'div',
        { class: 'st-kv' },
        liveRow('dist', 'From camera', 'Distance from the camera to the center, at the time the light you see left it'),
        liveRow('alt', 'Above surface', 'Distance to the nearest point of the admitted shape'),
        liveRow('sun', 'From the Sun', 'Center-to-center, at the light-emission epoch'),
        liveRow('size', 'Apparent size', 'Angular diameter from the admitted radius and the distance'),
        liveRow('phase', 'Phase angle', 'Sun–body–observer angle at the light-emission epoch'),
        liveRow('lt', 'Light time', 'You see the body as it was this long ago'),
        liveRow('seen', 'Seen as of', 'UTC when the light you see left the body'),
      ),
      this.why,
    );
    const isSun = body.id === m.sunId;
    // The Sun's and small bodies' lines depend on this frame: set in updateLive.
    const shape = m.shapeStatus(body.id);
    const shapeWhy = !shape ? '' : shape.drawn ? ` Drawn from its shape model instead of the ellipsoid: ${shape.text}.` : ` Its shape model is not drawn: ${shape.text}.`;
    this.setWhy(isSun || sb ? '' : whyLine(f, level) + shapeWhy);

    this.builtKey = this.stateKey(body.id);
    if (sb && sbRowId !== null && synthetic) {
      const f = syntheticFacts(sb.synthetic!, sb.syntheticIndex(sbRowId), level, sb.tables.core.header.epochTdb);
      this.el.append(
        h('div', { class: 'st-attr' }, h('div', { class: 'st-attr-head' }, chip('synthetic'), h('span', { class: 'st-attr-name' }, 'What this is')), h('div', { class: 'st-attr-val' }, f.what)),
        h('h3', null, `Attributes (at ${EXISTS_TEXT[level].name})`),
      );
      this.appendRows(f.rows, body.name);
      this.appendSourcesButton(f.rows, body.name);
      this.lastLive = 0;
      this.updateLive(true);
      return;
    }
    if (sb && sbRowId !== null) {
      const facts = smallBodyFacts(sb.tables, sbRowId, level);
      const sr = shapeRow(m.shapeStatus(body.id), level);
      if (sr) facts.rows.push(sr);
      this.el.append(h('h3', null, `Attributes (at ${EXISTS_TEXT[level].name})`));
      this.appendRows(facts.rows, body.name);
      if (facts.unknown.length)
        this.el.append(h('div', { class: 'st-attr' }, h('div', { class: 'st-attr-head' }, chip('unknown'), h('span', { class: 'st-attr-name' }, 'Not known for this object')), h('div', { class: 'st-attr-val' }, facts.unknown.join(' · '))));
      if (facts.flags.length)
        this.el.append(
          h('h3', null, 'Flags'),
          h('ul', { class: 'st-flags st-small' }, facts.flags.map((x) => h('li', null, h('b', null, x.name), ' — ', x.text))),
        );
      this.appendSourcesButton(facts.rows, body.name);
      const det = h('details', null, h('summary', { class: 'st-muted st-small' }, 'Legend'), legend(smallBodyLegend(sb.tables)));
      this.el.append(det);
      this.lastLive = 0;
      this.updateLive(true);
      return;
    }
    const st = m.bodyLoadState(body.id);
    const loading = st === 'loaded' ? null : st === 'error' ? 'its ephemeris file failed to load (see Data)' : 'its ephemeris file is still loading';
    let rows = attributeRows(body, level, [...(m.data?.ephemerides ?? []), ...(m.data?.deferred ?? [])], {
      orientation: m.orientationSource(body.id),
      loading,
      surfaces: m.data?.surfaces.filter((x) => x.bodyId === body.id) ?? [],
      shape: m.shapeStatus(body.id),
    });
    // The Sun is drawn from light.json, not from reflectance data.
    if (isSun) rows = [...rows.filter((r) => !['albedoXYZS', 'albedoV', 'phase'].includes(r.key)), ...sunRows(m.light, level)];
    this.el.append(h('h3', null, `Attributes (at ${EXISTS_TEXT[level].name})`));
    this.appendRows(rows, body.name);
    this.appendSourcesButton(rows, body.name);
    const det = h('details', null, h('summary', { class: 'st-muted st-small' }, 'Legend'), legend());
    this.el.append(det);
    this.lastLive = 0;
    this.updateLive(true);
  }

  private appendRows(rows: AttrRow[], owner: string): void {
    const level = this.model.reality.exists;
    for (const r of rows) {
      this.el.append(
        h(
          'div',
          { class: 'st-attr' },
          h(
            'div',
            { class: 'st-attr-head' },
            chip(r.label),
            h('span', { class: 'st-attr-name' }, r.name),
            r.withheld ? h('span', { class: 'st-withheld', title: `Not admitted at ${EXISTS_TEXT[level].name}: the renderer does not use this value.` }, `withheld at ${EXISTS_TEXT[level].name}`) : null,
          ),
          h('div', { class: 'st-attr-val' }, r.value),
          r.method ? h('div', { class: 'st-attr-meta' }, h('b', null, 'Method: '), r.method) : null,
          r.uncertainty ? h('div', { class: 'st-attr-meta' }, h('b', null, 'Uncertainty: '), r.uncertainty) : null,
          r.sources.length
            ? h(
                'div',
                { class: 'st-attr-meta' },
                h('b', null, 'Sources: '),
                r.sources.map((s, i) => [i ? ', ' : '', h('span', { class: 'st-link', onclick: () => this.actions.openSources([s], `${owner}: ${r.name}`) }, s)]),
              )
            : null,
        ),
      );
    }
  }

  private appendSourcesButton(rows: AttrRow[], owner: string): void {
    const allSources = [...new Set(rows.flatMap((r) => r.sources))];
    if (allSources.length)
      this.el.append(h('div', { class: 'st-row' }, h('button', { onclick: () => this.actions.openSources(allSources, `${owner}: all sources`) }, `All ${allSources.length} sources`)));
  }

  /** Load state + orientation source of a body: when this changes, the rows must be rebuilt. */
  private stateKey(id: number): string {
    if (id < 0) {
      const m = this.model;
      return `sb|${m.sb.status}|${!!m.smallBodies?.field}|${m.reality.exists}|${m.names?.spkidOf(sbRow(id)) ?? ''}|${m.shapeStatus(id)?.text ?? ''}`;
    }
    const o = this.model.orientationSource(id);
    return `${this.model.bodyLoadState(id)}|${o ? `${o.kind}:${o.label}:${o.frame}` : '-'}|${this.model.reality.exists}|${this.model.shapeStatus(id)?.text ?? ''}`;
  }

  private setWhy(line: string): void {
    const enh = this.model.reality.view === 'enhanced' ? ' View is ENHANCED: brighter than an eye would see.' : '';
    setText(this.why, `Why does it look like this? ${line}${enh}`);
  }

  update(): void {
    if (!this.visible) return;
    const now = performance.now();
    if (now - this.lastLive < 200) return;
    this.lastLive = now;
    this.updateLive(false);
  }

  private updateSmallBodyWhy(id: number): void {
    const m = this.model;
    const sb = m.smallBodies;
    if (!sb) return;
    const row = sbRow(id);
    const level = m.reality.exists;
    if (sb.isSynthetic(row)) {
      this.setWhy(syntheticWhy(level, !!sb.field, !!sb.field?.syntheticCount));
      return;
    }
    const closeup = !!m.snapshot?.bodies.some((b) => b.id === id);
    this.setWhy(
      smallBodyWhy({
        level,
        positionLabel: sb.posLabel(row),
        drawn: closeup ? 'closeup' : 'point',
        field: !!sb.field,
        inputs: brightnessInputs(sb.tables, row),
        filtered: closeup ? m.filtered(id) : null,
        hasDiameter: !!sb.measuredDiameter(row),
        shape: m.shapeStatus(id),
      }),
    );
  }

  private updateLive(_force: boolean): void {
    const m = this.model;
    const id = this.id;
    if (id === null) return;
    // The shape-model status arrives asynchronously (app/shapes.ts): rebuild when it changes.
    if (m.shapeStatus(id) && this.stateKey(id) !== this.builtKey) { this.build(); return; }
    const g = m.world?.bodies.get(id);
    const set = (k: string, v: string, label: Label | null = null) => {
      const c = this.live.get(k);
      if (!c) return;
      setText(c.value, v);
      const cls = `st-chip st-chip-${label ?? 'unknown'}`;
      if (c.chip.className !== cls) c.chip.className = cls;
      setText(c.chip, label ?? '—');
      c.chip.title = label ? `${label}: ${LABEL_TEXT[label]}` : 'not available';
    };
    if (this.stateKey(id) !== this.builtKey) {
      // e.g. Earth's orientation turning from measured to a prediction as time passes 2026-09-29
      this.build();
      return;
    }
    if (id < 0) this.updateSmallBodyWhy(id);
    if (!g?.app) {
      const st = m.bodyLoadState(id);
      if (st !== 'loaded') {
        for (const k of this.live.keys()) set(k, '—');
        set('dist', st === 'error' ? 'no position: its ephemeris failed to load' : id < 0 ? (m.sb.status === 'ready' ? 'propagating its orbit…' : 'loading the small-body catalogue…') : 'loading its moon system…');
        return;
      }
      for (const k of this.live.keys()) set(k, '—');
      set('dist', id < 0 ? 'no position now (position unknown, or outside the small-body window)' : 'no position now (outside ephemeris coverage)');
      return;
    }
    const body = g.body;
    const d = len(g.app.rel);
    set('dist', formatDistance(d), 'derived');
    // The Sun's disk is drawn with light.json's photospheric radius; other bodies use their radii.
    const sunR = id === m.sunId ? m.light?.sun.radius : undefined;
    const radii: [number, number, number] | null = sunR?.value ? [sunR.value, sunR.value, sunR.value] : body.radii?.value ?? null;
    const rLabel = sunR?.value ? sunR.label : body.radii?.label ?? 'unknown';
    if (!radii) {
      set('alt', 'unknown (size unknown)');
      set('size', 'unknown (size unknown)');
    } else if (!labelAllowed(rLabel, m.reality.exists)) {
      set('alt', `withheld at ${EXISTS_TEXT[m.reality.exists].name}`, rLabel);
      set('size', `withheld at ${EXISTS_TEXT[m.reality.exists].name}`, rLabel);
    } else {
      const drawn = m.snapshot?.bodies.find((b) => b.id === id);
      const t = rayEllipsoid(scale(g.app.rel, 1 / d), g.app.rel, radii, drawn?.orient ?? null);
      set('alt', t !== null ? formatDistance(t) : '—', derivedLabel(rLabel));
      const rMean = (radii[0] + radii[1] + radii[2]) / 3;
      set('size', formatAngle(2 * angularRadius(rMean, d)), derivedLabel(rLabel));
    }
    const isSun = id === m.sunId;
    if (isSun && m.world) {
      const r = buildSun(m.world, m.light, m.reality.exists);
      this.setWhy(sunWhy(m.light, m.reality.exists, !!r.sun, r.reason));
    }
    set('sun', isSun ? '—' : g.toSun ? formatDistance(len(g.toSun)) : 'unknown (no Sun position)', !isSun && g.toSun ? 'derived' : null);
    if (g.toSun && len(g.toSun) > 0) {
      const c = -dot(g.toSun, g.app.rel) / (len(g.toSun) * d);
      set('phase', formatAngle(Math.acos(Math.max(-1, Math.min(1, c)))), 'derived');
    } else set('phase', '—');
    set('lt', formatDuration(g.app.lightTime), 'derived');
    set('seen', m.formatTime(g.app.emitEt), 'derived');
  }
}
