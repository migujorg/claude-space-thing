// Bottom HUD: UTC time (click to type), play/pause, rate presets, reverse, now, data-window scrubber,
// renderer frame stats and camera status.

import type { AppModel } from '../app/model';
import { activePreset, RATE_PRESETS } from '../app/clock';
import { EXISTS_TEXT } from '../app/reality';
import type { RendererStats } from '../render/scene';
import { h, setText, toggleClass } from './dom';
import { formatDistance, formatLuminance, formatRate } from './format';

export class Hud {
  readonly el: HTMLElement;
  private time: HTMLElement;
  private timeInput: HTMLInputElement;
  private play: HTMLButtonElement;
  private rev: HTMLButtonElement;
  private nowBtn: HTMLButtonElement;
  private rateBtns: HTMLButtonElement[] = [];
  private rateText = h('span', { class: 'st-muted st-small', style: 'min-width:64px' });
  private scrub: HTMLInputElement;
  private scrubStart = h('span');
  private scrubEnd = h('span');
  private stats = h('div');
  private cam = h('div');
  private sbLine = h('div', { title: 'Asteroids and comets drawn by the small-body field, and those whose position or brightness inputs are not admitted at this level (see the legend in the inspector).' });
  private scrubbing = false;

  constructor(private model: AppModel) {
    this.time = h('span', { class: 'st-time', title: 'UTC. Click (or T) to type a time.' });
    this.time.addEventListener('click', () => this.editTime());
    this.timeInput = h('input', { class: 'st-time-input', spellcheck: 'false', placeholder: 'YYYY-MM-DDTHH:MM:SSZ or now' });
    this.timeInput.style.display = 'none';
    this.timeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const err = model.setTimeText(this.timeInput.value);
        if (err) {
          this.timeInput.setCustomValidity(err);
          this.timeInput.reportValidity();
          return;
        }
        this.endEdit();
      } else if (e.key === 'Escape') this.endEdit();
      e.stopPropagation();
    });
    this.timeInput.addEventListener('input', () => this.timeInput.setCustomValidity(''));
    this.timeInput.addEventListener('blur', () => this.endEdit());

    this.play = h('button', { title: 'Play / pause (Space)', onclick: () => { model.clock.toggle(); model.emit('time'); } });
    this.rev = h('button', { title: 'Reverse time (R)', onclick: () => { model.clock.reverse(); model.emit('time'); } }, '⇆');
    this.nowBtn = h('button', { title: 'Jump to the current time (N)', onclick: () => { if (model.goNow()) { model.clock.setRateMagnitude(1); model.clock.play(); model.emit('time'); } } }, 'Now');
    for (const [i, p] of RATE_PRESETS.entries()) {
      const b = h('button', { title: `${p.label} (${i + 1})`, onclick: () => { model.clock.setRateMagnitude(p.rate); model.emit('time'); } }, p.label.replace(' time', ''));
      this.rateBtns.push(b);
    }
    this.scrub = h('input', { type: 'range', min: 0, max: 10000, step: 1, title: 'Scrub through the data window' });
    this.scrub.addEventListener('input', () => {
      const w = model.clock.window;
      if (!w) return;
      this.scrubbing = true;
      model.setEt(w.startEt + (Number(this.scrub.value) / 10000) * (w.endEt - w.startEt));
    });
    this.scrub.addEventListener('change', () => (this.scrubbing = false));

    this.el = h(
      'div',
      { class: 'st-hud' },
      h('div', { class: 'st-panel' }, this.time, this.timeInput, this.play, this.rev, h('div', { class: 'st-rates' }, this.rateBtns), this.rateText, this.nowBtn),
      h('div', { class: 'st-panel st-scrub' }, this.scrub, h('div', { class: 'st-ends' }, this.scrubStart, h('span', null, 'data window'), this.scrubEnd)),
      h('div', { class: 'st-panel st-stats' }, this.stats, this.sbLine, this.cam),
    );
    model.on('time', () => this.renderControls());
    model.on('data', () => this.renderControls());
    this.renderControls();
  }

  editTime(): void {
    this.timeInput.value = this.model.utcMs() !== null ? new Date(this.model.utcMs()!).toISOString() : String(this.model.clock.et);
    this.time.style.display = 'none';
    this.timeInput.style.display = '';
    this.timeInput.focus();
    this.timeInput.select();
  }

  private endEdit(): void {
    this.timeInput.style.display = 'none';
    this.time.style.display = '';
    this.timeInput.blur();
  }

  private renderControls(): void {
    const c = this.model.clock;
    setText(this.play, c.playing ? '❚❚' : '▶');
    toggleClass(this.play, 'st-on', c.playing);
    toggleClass(this.rev, 'st-on', c.reversed);
    const act = activePreset(c.rate);
    this.rateBtns.forEach((b, i) => toggleClass(b, 'st-on', RATE_PRESETS[i] === act));
    setText(this.rateText, formatRate(c.rate, act?.label));
    this.nowBtn.disabled = !this.model.timeScale;
    const w = c.window;
    this.scrub.disabled = !w;
    const day = (et: number) => (this.model.utcMs(et) !== null ? new Date(this.model.utcMs(et)!).toISOString().slice(0, 10) : `ET ${et.toFixed(0)}`);
    setText(this.scrubStart, w ? day(w.startEt) : 'no window');
    setText(this.scrubEnd, w ? day(w.endEt) : '');
  }

  update(stats: RendererStats | null): void {
    const m = this.model;
    setText(this.time, m.formatTime());
    this.time.title = `UTC. TDB ${m.clock.et.toFixed(3)} s past J2000. Click (or T) to type a time.`;
    const f = m.clock.fraction();
    if (f !== null && !this.scrubbing) {
      const v = String(Math.round(f * 10000));
      if (this.scrub.value !== v) this.scrub.value = v;
    }
    if (m.clock.playing !== (this.play.textContent === '❚❚')) this.renderControls();
    setText(
      this.stats,
      stats
        ? `frame ${stats.frameMs.toFixed(1)} ms · adapt ${formatLuminance(stats.adaptationLuminance)} · stars ${stats.starsDrawn}`
        : 'renderer stats unavailable',
    );
    setText(this.sbLine, smallBodyHudText(m));
    toggleClass(this.sbLine, 'st-hide', this.sbLine.textContent === '');
    const cam = m.cam;
    const tgt = m.travel ? m.bodyName(m.travel.target) : cam.mode === 'orbit' ? m.bodyName(cam.target) : cam.anchor !== null ? m.bodyName(cam.anchor) : 'SSB';
    const dist = cam.mode === 'orbit' ? ` · ${formatDistance(cam.dist)}` : '';
    setText(this.cam, `${m.travel ? 'traveling to' : cam.mode === 'orbit' ? 'orbiting' : 'free, riding with'} ${tgt ?? '?'}${dist}`);
  }
}

const n = (x: number): string => x.toLocaleString('en-US');

/** HUD line: "N small bodies drawn / M withheld at this level" (or where the catalogue stands). */
export function smallBodyHudText(m: AppModel): string {
  const s = m.sb;
  if (s.status === 'loading') return `small bodies loading ${s.total ? Math.round((100 * s.got) / s.total) : 0}%`;
  if (s.status === 'error') return 'small bodies unavailable (see Data)';
  if (s.status !== 'ready') return '';
  const c = m.smallBodyCounts();
  if (!c) return '';
  const level = EXISTS_TEXT[m.reality.exists].name;
  if (m.smallBodies?.field) return `${n(c.drawn)} small bodies drawn / ${n(c.withheld)} withheld at ${level}`;
  return `small bodies not drawn (no small-body renderer): ${n(c.drawn)} admitted / ${n(c.withheld)} withheld at ${level}`;
}
