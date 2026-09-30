import { describe, expect, it } from 'vitest';
import { attributeRows, derivedLabel, ephemerisChain, sunRows, sunWhy } from '../src/ui/inspectModel';
import type { LoadedEphemeris } from '../src/data/load';
import type { EphemSegment } from '../src/data/schema';
import { body, fakeLight } from './app-fakes';

const seg = (target: number, center: number, sources: string[]): EphemSegment => ({ target, center, frame: 'J2000', type: 2, initEt: 0, intLen: 1, rsize: 5, n: 1, offset: 0, sources, label: 'measured' });
const ephs: LoadedEphemeris[] = [
  { name: 'a', path: 'ephem/a.json', header: { bin: 'a.bin', segments: [seg(399, 3, ['s1']), seg(3, 0, ['s1'])] }, data: new Float64Array() },
  { name: 'b', path: 'ephem/b.json', header: { bin: 'b.bin', segments: [seg(301, 3, ['s2'])] }, data: new Float64Array() },
];

describe('inspector model', () => {
  it('follows ephemeris segments to the SSB and collects their sources', () => {
    const c = ephemerisChain(ephs, 301);
    expect(c.links.map((l) => [l.seg.target, l.seg.center])).toEqual([[301, 3], [3, 0]]);
    expect(c.complete).toBe(true);
    expect(c.sources).toEqual(['s2', 's1']);
    expect(ephemerisChain(ephs, 42).links).toHaveLength(0);
  });

  it('lists every attribute with its label, marking values withheld at the level', () => {
    const b = body(301, 'Moon', 'moon', { rLabel: 'estimated', albedo: 'measured', phase: 'estimated' });
    const rows = attributeRows(b, 'strict', ephs);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(Object.keys(by)).toEqual(['position', 'radii', 'gm', 'rotation', 'albedoXYZS', 'albedoV', 'phase']);
    expect(by.position.label).toBe('measured');
    expect(by.position.value).toMatch(/301 → 3 → 0/);
    expect(by.radii.withheld).toBe(true);
    expect(by.phase.withheld).toBe(true);
    expect(by.albedoXYZS.withheld).toBe(false);
    expect(attributeRows(b, 'best', ephs).find((r) => r.key === 'radii')!.withheld).toBe(false);
    const noPhot = attributeRows(body(1, 'X', 'planet'), 'best', []);
    expect(noPhot.find((r) => r.key === 'albedoXYZS')!.label).toBe('unknown');
    expect(noPhot.find((r) => r.key === 'position')!.value).toMatch(/no ephemeris/);
  });

  it('describes the Sun from light.json', () => {
    const rows = sunRows(fakeLight('estimated'), 'strict');
    expect(rows.map((r) => r.key)).toEqual(['irradiance', 'sunRadius', 'limbDarkening']);
    expect(rows[0].withheld).toBe(true);
    expect(sunRows(null, 'best')[0].value).toMatch(/missing/);
    expect(sunWhy(fakeLight(), 'best', true)).toMatch(/light.json/);
    expect(sunWhy(null, 'best', false, 'light.json is missing.')).toMatch(/not drawn/);
  });

  it('derived quantities carry the worst of their inputs', () => {
    expect(derivedLabel('measured')).toBe('derived');
    expect(derivedLabel('estimated')).toBe('estimated');
  });
});
