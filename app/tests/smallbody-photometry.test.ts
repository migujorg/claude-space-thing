// Small-body photometry (core/smallbodyPhotometry.ts): the phase functions against sbpy's definitions (reference
// values computed by the pipeline stage sbphotometry), and H, G -> magnitude and illuminance at JPL Horizons'
// geometry against Horizons' APmag for six asteroids (fixture app/tests/fixtures/smallbody_photometry.json).
// The label rules are checked on the real catalogue when it is built.

import { describe, expect, it } from 'vitest';
import type { SmallBodyCoreHeader, SmallBodyPhotometry, SmallBodyPhysicalHeader, SmallBodyTableHeader } from '../src/data/schema';
import {
  MODEL_HG, MODEL_HG1G2, SmallBodyLight, fromHalf, hg1g2Phi, hgPhi, magnitudeToXYZS, toHalf,
} from '../src/core/smallbodyPhotometry';
import { DATA_DIR, fixture } from './core-data';

interface Fx {
  vSun: number;
  objects: {
    spkid: number; coreRow: number; H: number; G: number; gLabel: string; target: string;
    horizonsH: number; horizonsG: number;
    rows: { dateUt: string; apmag: number; rAu: number; deltaAu: number; phaseDeg: number }[];
  }[];
  hgChecks: { alphaDeg: number; G: number; phi: number }[];
  hg1g2Checks: { alphaDeg: number; G1: number; G2: number; phi: number }[];
}

const fs: { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; readFileSync(p: string, e: 'utf8'): string } =
  await import(/* @vite-ignore */ 'node:fs' as string);

const fx = fixture<Fx>('smallbody_photometry.json');
const photPath = DATA_DIR + 'smallbodies/photometry.json';
const phot: SmallBodyPhotometry | null = fs.existsSync(photPath) ? JSON.parse(fs.readFileSync(photPath, 'utf8')) : null;
if (!phot) console.warn('[smallbody photometry] smallbodies/photometry.json not built; skipping (pipeline stage sbphotometry)');
const rad = (d: number) => (d * Math.PI) / 180;

function bin(name: string): ArrayBuffer {
  const u8 = fs.readFileSync(DATA_DIR + name);
  const b = new ArrayBuffer(u8.byteLength);
  new Uint8Array(b).set(u8);
  return b;
}

describe.skipIf(!phot)('phase functions (sbpy definitions)', () => {
  it('H-G phase function equals the reference values', () => {
    let worst = 0;
    for (const c of fx.hgChecks) worst = Math.max(worst, Math.abs(hgPhi(phot!, rad(c.alphaDeg), c.G) - c.phi));
    console.log(`[photometry] H-G: max |Phi - sbpy| = ${worst.toExponential(2)} over ${fx.hgChecks.length} cases`);
    expect(worst).toBeLessThan(1e-12);
  });
  it('H-G1-G2 phase function equals the reference values (spline pieces and linear ends)', () => {
    let worst = 0;
    for (const c of fx.hg1g2Checks) worst = Math.max(worst, Math.abs(hg1g2Phi(phot!, rad(c.alphaDeg), c.G1, c.G2) - c.phi));
    console.log(`[photometry] H-G1-G2: max |Phi - sbpy| = ${worst.toExponential(2)} over ${fx.hg1g2Checks.length} cases`);
    expect(worst).toBeLessThan(1e-12);
    // Muinonen et al. (2010): Phi = 1 at opposition for any G1, G2 (to the 8 digits of sbpy's slope -6/pi).
    expect(Math.abs(hg1g2Phi(phot!, 0, 0.3, 0.3) - 1)).toBeLessThan(1e-8);
  });
  it('magnitude -> illuminance: V_sun gives the solar illuminance; 5 mag = factor 100', () => {
    const s = phot!.sunIrradianceXYZS1AU.value!;
    const e = magnitudeToXYZS(phot!, phot!.vSun.value!);
    for (let k = 0; k < 4; k++) expect(e[k] / s[k]).toBeCloseTo(1, 12);
    const e5 = magnitudeToXYZS(phot!, phot!.vSun.value! + 5, [1, 2, 1, 1]);
    expect(e5[1] / s[1]).toBeCloseTo(0.02, 12);
  });
  it('half-float packing round-trips to 2^-11 relative', () => {
    for (const x of [0.15, 0.62, 1.017, 180, 0.03, 25.4, -0.08]) expect(Math.abs(fromHalf(toHalf(x)) - x)).toBeLessThanOrEqual(Math.abs(x) * 2 ** -11);
  });
});

describe.skipIf(!phot)('H, G -> apparent magnitude and illuminance vs JPL Horizons APmag', () => {
  it('matches Horizons to 0.025 mag at Horizons geometry (Horizons evaluates the exponential approximation of H-G)', () => {
    let worst = 0;
    let worstFar = 0;
    const lines: string[] = [];
    for (const o of fx.objects) {
      // Our catalogue H, G are the ones Horizons uses.
      expect(o.H).toBeCloseTo(o.horizonsH, 5);
      expect(o.G).toBeCloseTo(o.horizonsG, 5);
      for (const r of o.rows) {
        const v = o.H + 5 * Math.log10(r.rAu * r.deltaAu) - 2.5 * Math.log10(hgPhi(phot!, rad(r.phaseDeg), o.G));
        const d = v - r.apmag;
        worst = Math.max(worst, Math.abs(d));
        if (r.phaseDeg > 15) worstFar = Math.max(worstFar, Math.abs(d));
        // Illuminance at the eye: ours (grey) vs the same law applied to Horizons' magnitude.
        const eOurs = magnitudeToXYZS(phot!, v)[1];
        const eHz = magnitudeToXYZS(phot!, r.apmag)[1];
        expect(Math.abs(eOurs / eHz - 1)).toBeLessThan(0.025);
        lines.push(`${o.target.padEnd(28)} ${r.dateUt.slice(0, 11)} alpha ${r.phaseDeg.toFixed(1).padStart(5)} V ${v.toFixed(3)} APmag ${r.apmag.toFixed(3)} (${d >= 0 ? '+' : ''}${d.toFixed(3)}) E_Y ${eOurs.toExponential(3)} lux`);
      }
    }
    console.log(`[photometry] vs Horizons APmag: max |dV| = ${worst.toFixed(4)} mag (${worstFar.toFixed(4)} beyond 15 deg)\n  ${lines.join('\n  ')}`);
    // The IAU law (Bowell et al. 1989 Eq. A4, with its small-phase term) and the two-exponential approximation
    // differ by up to 0.02 mag below ~10 deg phase.
    expect(worst).toBeLessThan(0.025);
    expect(worstFar).toBeLessThan(0.008);
  });
});

const built = phot !== null && ['core', 'physical', 'comets'].every((n) => fs.existsSync(`${DATA_DIR}smallbodies/${n}.bin`));
describe.skipIf(!built)('label rules on the catalogue', () => {
  it('strict admits measured phase functions only; best adds G = 0.15; colours relative to sunlight are sane', () => {
    const hdr = (n: string) => JSON.parse(fs.readFileSync(`${DATA_DIR}smallbodies/${n}.json`, 'utf8'));
    const light = new SmallBodyLight(phot!, {
      core: bin('smallbodies/core.bin'), coreHeader: hdr('core') as SmallBodyCoreHeader,
      physical: bin('smallbodies/physical.bin'), physicalHeader: hdr('physical') as SmallBodyPhysicalHeader,
      comets: bin('smallbodies/comets.bin'), cometsHeader: hdr('comets') as SmallBodyTableHeader,
    });
    for (const o of fx.objects) {
      const p = light.params(o.coreRow);
      const r = o.rows[1];
      const strict = light.apparent(o.coreRow, r.rAu, r.deltaAu, rad(r.phaseDeg), 'strict', p);
      const best = light.apparent(o.coreRow, r.rAu, r.deltaAu, rad(r.phaseDeg), 'best', p);
      expect(best, o.target).not.toBeNull();
      if (p.model === MODEL_HG) {
        // H-G path: strict only with a fitted G.
        expect(strict === null, o.target).toBe(o.gLabel !== 'measured');
        expect(Math.abs(best!.m - r.apmag), o.target).toBeLessThan(0.025);
      } else {
        expect(p.model).toBe(MODEL_HG1G2);
        // The V-band H-G1-G2 fit (its own H) and Horizons' H-G may differ by a few tenths.
        expect(Math.abs(best!.m - r.apmag), o.target).toBeLessThan(0.5);
      }
      for (const c of p.colour) expect(c).toBeGreaterThan(0.5);
      for (const c of p.colour) expect(c).toBeLessThan(1.5);
      console.log(`[photometry] ${o.target}: model ${p.model === MODEL_HG ? 'H-G' : 'H-G1-G2'} ${p.labelIn}, colour ${p.colourMethod} ${p.colourLabel} [${p.colour.map((c) => c.toFixed(3)).join(', ')}], m(best) ${best!.m.toFixed(3)} vs APmag ${r.apmag.toFixed(3)}, strict ${strict ? strict.m.toFixed(3) : 'hidden'}`);
    }
  }, 60000);
});
