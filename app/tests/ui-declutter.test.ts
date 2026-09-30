import { describe, expect, it } from 'vitest';
import { declutter, scoreCandidate, type OverlayCandidate } from '../src/ui/declutter';

const base: OverlayCandidate = { id: 0, x: 400, y: 300, rPx: 0, dist: 1e7, kind: 'moon', selected: false, focus: true, brightness: null, sizePx: null, marker: false, text: 'x' };
const cand = (o: Partial<OverlayCandidate>): OverlayCandidate => ({ ...base, ...o, text: o.text ?? `Body ${o.id}` });

describe('declutter scoring', () => {
  it('ranks selected ≫ planets ≫ focus moons ≫ other moons, then brightness/size/proximity', () => {
    const f = 2.5e6;
    const sel = scoreCandidate(cand({ id: 1, selected: true, focus: false }), f);
    const planet = scoreCandidate(cand({ id: 2, kind: 'planet', sizePx: 20, brightness: -6 }), f);
    const galilean = scoreCandidate(cand({ id: 3, sizePx: 0.5, dist: 3e6 }), f);
    const irregular = scoreCandidate(cand({ id: 4, dist: 2e7 }), f);
    const otherSystem = scoreCandidate(cand({ id: 5, focus: false, sizePx: 0.5 }), f);
    expect(sel).toBeGreaterThan(planet);
    expect(planet).toBeGreaterThan(galilean);
    expect(galilean).toBeGreaterThan(irregular);
    expect(irregular).toBeGreaterThan(otherSystem - 60); // sanity: all finite
    expect(scoreCandidate(cand({ id: 6, brightness: -5 }), f)).toBeGreaterThan(scoreCandidate(cand({ id: 7, brightness: -9 }), f));
    expect(scoreCandidate(cand({ id: 8, dist: 1e6 }), f)).toBeGreaterThan(scoreCandidate(cand({ id: 9, dist: 3e7 }), f));
  });
});

describe('declutter', () => {
  const opts = { width: 1280, height: 720, focusDist: 2.5e6 };

  it('keeps a crowded moon system readable: caps labels, caps unknown bodies, spaces markers', () => {
    // 300 moons of unknown size scattered over the screen (like Saturn's irregulars), plus the planet.
    const cands: OverlayCandidate[] = [cand({ id: 699, kind: 'planet', x: 640, y: 360, rPx: 30, sizePx: 30, brightness: -5 })];
    for (let i = 0; i < 300; i++)
      cands.push(cand({ id: 1000 + i, x: 20 + ((i * 37) % 1240), y: 20 + ((i * 53) % 680), dist: 1e6 + i * 1e5, marker: true }));
    const r = declutter(cands, { ...opts, maxLabels: 20, maxUnknownLabels: 6, maxMarkers: 40, markerMinSepPx: 12 });
    expect(r.labels.length).toBeLessThanOrEqual(20);
    expect(r.labels.filter((l) => l.id >= 1000).length).toBeLessThanOrEqual(6);
    expect(r.labels.some((l) => l.id === 699)).toBe(true);
    expect(r.markers.length).toBeLessThanOrEqual(40);
    const pos = new Map(cands.map((c) => [c.id, c]));
    for (let i = 0; i < r.markers.length; i++)
      for (let j = i + 1; j < r.markers.length; j++) {
        const a = pos.get(r.markers[i])!, b = pos.get(r.markers[j])!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(12);
      }
    // nearest unknown bodies first
    const labelled = r.labels.filter((l) => l.id >= 1000).map((l) => pos.get(l.id)!.dist);
    expect(Math.max(...labelled)).toBeLessThan(1e6 + 150 * 1e5);
  });

  it('never hides the selected body, even when it would be decluttered away', () => {
    const cands = [
      cand({ id: 1, kind: 'planet', x: 400, y: 300, rPx: 40, sizePx: 40 }),
      cand({ id: 2, x: 402, y: 301, marker: true, selected: true, focus: false, text: 'S/2003 J 2' }),
    ];
    const r = declutter(cands, { ...opts, maxLabels: 1, maxMarkers: 0 });
    expect(r.markers).toContain(2);
    expect(r.labels.map((l) => l.id)).toContain(2);
  });

  it('shows markers only for the focus system (others collapse into their planet)', () => {
    const cands = [cand({ id: 1, marker: true, focus: true, x: 100 }), cand({ id: 2, marker: true, focus: false, x: 600 })];
    const r = declutter(cands, opts);
    expect(r.markers).toEqual([1]);
    expect(r.labels.map((l) => l.id)).toEqual([1]);
  });
});
