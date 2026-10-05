// Comets as they would look (render/comets): photometric consistency of the coma, and tail geometry.
//
// Fixture: app/tests/fixtures/comet_reference.json, written by the pipeline's comets stage: the comet model
// (comets/model.json) and the showcase comet C/2025 A6 (Lemmon) at three epochs around its peak — our propagated
// heliocentric state and DE442s Earth, next to JPL Horizons' T-mag (the same M1/K1 law), r, Delta and the position
// angles PsAng (anti-sunward radius vector: the ion-tail indicator) and PsAMV (negative heliocentric velocity: the
// dust-tail indicator).

import { describe, expect, it } from 'vitest';
import type { CometMeasuredActivity, CometModelProduct } from '../src/data/schema';
import {
  activityOf, AU_KM, coma, comaExtentKm, comaLut, dustTail, enclosed, grainPosition, ionTail, ionTailDirection,
  pixelIlluminance, syndyne, synchrone, type CometInput, type V3,
} from '../src/render/comets/model';
import { cometLod } from '../src/render/comets/lod';
import { fixture } from './core-data';

interface Fixture {
  comet: { row: number; designation: string; name: string; M1: number; K1: number };
  horizons: { rows: { dateUt: string; raDeg: number; decDeg: number; tMag: number; rAu: number; deltaAu: number; stoDeg: number; psAngDeg: number; psAmvDeg: number }[]; M1: number; K1: number };
  ours: { et: number; helioKm: V3; helioVelKmS: V3; earthHelioKm: V3; m1: number; rAu: number; deltaAu: number }[];
  measured: CometMeasuredActivity | null;
  model: CometModelProduct;
}

const fx = fixture<Fixture>('comet_reference.json');
const model = fx.model;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

function inputAt(k: number, observer?: V3): CometInput {
  const o = fx.ours[k];
  return {
    M1: fx.comet.M1, K1: fx.comet.K1, activity: activityOf(model, fx.measured), dust: 'longPeriod',
    helioPos: o.helioKm, helioVel: o.helioVelKmS, observer: observer ?? o.earthHelioKm,
  };
}

/** Right ascension and declination (rad) of an ICRF direction. */
function radec(v: V3): [number, number] {
  return [Math.atan2(v[1], v[0]), Math.asin(v[2] / len(v))];
}
/** Position angle (deg, north through east) of direction b as seen from direction a (both ICRF, from the observer). */
function positionAngle(a: V3, b: V3): number {
  const [ra1, de1] = radec(a), [ra2, de2] = radec(b);
  const dra = ra2 - ra1;
  const pa = Math.atan2(Math.sin(dra) * Math.cos(de2), Math.cos(de1) * Math.sin(de2) - Math.sin(de1) * Math.cos(de2) * Math.cos(dra));
  return ((pa * 180) / Math.PI + 360) % 360;
}
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

describe('sourced comet composition', () => {
  it('uses the per-comet payload and retains envelope sources alongside population inputs', () => {
    // Test ratios selected from the real reference model's observed population bounds.
    const p = model.composition.value!.population;
    const measured: CometMeasuredActivity = {
      value: { key: 'test-comet', C2: p.C2.p16, afrho: p.afrho.p84, n: { C2: 1, afrho: 1 }, rRangeAu: [1, 2] },
      label: 'derived', sources: ['test-measured-composition'],
    };
    expect(activityOf(model, measured)).toEqual({
      C2: p.C2.p16, CN: p.CN.median, C3: p.C3.median, afrho: p.afrho.p84,
      label: 'derived', sources: [...new Set([...measured.sources, ...model.composition.sources])],
    });
    expect(activityOf(model, { value: null, label: 'unknown', sources: [] })).toEqual(activityOf(model));
  });
});

describe('coma photometry', () => {
  it('total V light is the M1/K1 law (and our m1 is Horizons T-mag)', () => {
    fx.ours.forEach((_o, k) => {
      const c = coma(model, inputAt(k));
      const h = fx.horizons.rows[k];
      expect(Math.abs(c.m1 - h.tMag)).toBeLessThan(0.01);
      expect(Math.abs(c.rAu - h.rAu)).toBeLessThan(2e-4);
      const vTot = c.components.reduce((s, x) => s + x.v, 0);
      expect(vTot / 10 ** (-0.4 * (c.m1 - model.sun.vMag))).toBeCloseTo(1, 10);
      // Photopic illuminance within the colour spread of a solar-coloured point of the same V (the point source path)
      const pointY = model.sun.irradianceXYZS1Au[1] * 10 ** (-0.4 * (c.m1 - model.sun.vMag));
      expect(c.total[1] / pointY).toBeGreaterThan(0.8);
      expect(c.total[1] / pointY).toBeLessThan(1.25);
      expect(c.radiusKm).toBeGreaterThan(1e3);
      expect(c.radiusKm).toBeLessThan(1e7);
    });
  });

  it('coma radius and gas fraction do not depend on the observer distance', () => {
    const a = coma(model, inputAt(1));
    const far: V3 = [fx.ours[1].earthHelioKm[0] * 3, fx.ours[1].earthHelioKm[1] * 3, fx.ours[1].earthHelioKm[2] * 3];
    const b = coma(model, inputAt(1, far));
    expect(b.radiusKm / a.radiusKm).toBeCloseTo(1, 9);
    expect(b.gasFractionV).toBeCloseTo(a.gasFractionV, 9);
  });

  it('enclosed light reaches the total and is monotone', () => {
    const c = coma(model, inputAt(1));
    let prev = 0;
    for (let lr = 0; lr <= 8; lr += 0.25) {
      const e = enclosed(model, c, 10 ** lr)[1];
      expect(e).toBeGreaterThanOrEqual(prev - 1e-12 * c.total[1]);
      prev = e;
    }
    expect(enclosed(model, c, comaExtentKm(model, c))[1] / c.total[1]).toBeGreaterThan(0.998);
  });

  // The rendered coma: sum over the pixels of what the shader deposits (pixelIlluminance mirrors COMA_SHADER) equals
  // the M1/K1 illuminance, whether the coma is barely resolved or fills the view.
  // (the nucleus at a pixel centre, and off-centre)
  for (const [radiusPx, off] of [[1, 0], [1, 0.4], [2, 0], [2, 0.4], [8, 0.25], [40, 0.4]] as const) {
    it(`rendered coma integrates to the M1/K1 illuminance (coma radius ${radiusPx} px, nucleus offset ${off} px)`, { timeout: 60000 }, () => {
      const c = coma(model, inputAt(1));
      const ext = comaExtentKm(model, c);
      const lut = comaLut(model, c, ext);
      const pix = c.radiusKm / c.deltaKm / radiusPx;          // pixel angle (rad), small-angle tangent plane
      const half = Math.min(Math.ceil(ext / c.deltaKm / pix) + 2, 700);
      let sumY = 0, sumS = 0;
      const omega = pix * pix;
      for (let j = -half; j <= half; j++) {
        for (let i = -half; i <= half; i++) {
          sumY += pixelIlluminance(lut, (i + off) * pix, (j + 0.7 * off) * pix, omega, 1);
          sumS += pixelIlluminance(lut, (i + off) * pix, (j + 0.7 * off) * pix, omega, 3);
        }
      }
      // light beyond the summed square (only when it is clipped), from the model's own enclosed fraction
      const outY = c.total[1] - enclosed(model, c, (half - 1) * pix * c.deltaKm)[1];
      const outS = c.total[3] - enclosed(model, c, (half - 1) * pix * c.deltaKm)[3];
      expect((sumY + Math.max(0, outY)) / c.total[1]).toBeCloseTo(1, 2);   // |error| < 0.5 %
      expect((sumS + Math.max(0, outS)) / c.total[3]).toBeCloseTo(1, 2);
    });
  }
});

describe('coma colour', () => {
  it('gas emission (C2 Swan above all) pulls the coma from the reddened dust toward blue-green', () => {
    const c = coma(model, inputAt(1));
    const dust = c.components.find((k) => k.name === 'dust')!;
    const gas = c.components.filter((k) => k.name !== 'dust').reduce((a, k) => a.map((v, i) => v + k.xyzs[i]), [0, 0, 0, 0]);
    const x = (v: number[]) => v[0] / (v[0] + v[1] + v[2]);
    const y = (v: number[]) => v[1] / (v[0] + v[1] + v[2]);
    expect(c.gasFractionV).toBeGreaterThan(0.05);
    expect(c.gasFractionV).toBeLessThan(0.9);
    expect(x(c.total)).toBeLessThan(x(dust.xyzs));
    // blue-green gas: below the white point in x, above the blue corner in y
    expect(x(gas)).toBeLessThan(0.25);
    expect(y(gas)).toBeGreaterThan(0.2);
    // dust redder than sunlight
    const sun = model.sun.irradianceXYZS1Au;
    expect(x(dust.xyzs)).toBeGreaterThan(x(sun));
  });
});

describe('dust tail geometry (Finson-Probstein)', () => {
  const mu = model.sun.gmKm3S2;

  it('a young syndyne points anti-sunward, displaced by ½ β g τ²', () => {
    const o = fx.ours[1];
    const beta = 0.3, tau = 1800;
    const p = grainPosition(o.helioKm, o.helioVelKmS, mu, beta, tau)!.pos;
    const q = grainPosition(o.helioKm, o.helioVelKmS, mu, 0, tau)!.pos;   // where the nucleus is again (zero offset)
    expect(len(sub(q, o.helioKm))).toBeLessThan(1e-3);
    const d = sub(p, o.helioKm);
    const r = len(o.helioKm);
    const expected = 0.5 * beta * (mu / (r * r)) * tau * tau;
    // leading order in τ (the next terms are of relative order v τ / r ~ 1e-3 here)
    expect(Math.abs(len(d) / expected - 1)).toBeLessThan(2e-3);
    const cos = (d[0] * o.helioKm[0] + d[1] * o.helioKm[1] + d[2] * o.helioKm[2]) / (len(d) * r);
    expect(cos).toBeGreaterThan(0.9999);
  });

  it('syndynes and synchrones through the same grain agree', () => {
    const o = fx.ours[1];
    const taus = [2, 5, 10, 20].map((d) => d * 86400);
    const betas = [0.01, 0.1, 0.5];
    const sd = syndyne(o.helioKm, o.helioVelKmS, mu, 0.1, taus);
    const sc = synchrone(o.helioKm, o.helioVelKmS, mu, betas, 10 * 86400);
    expect(len(sub(sd[2], sc[1]))).toBeLessThan(1e-6 * len(o.helioKm));
  });

  // Published reference: Horizons' PsAng (anti-sunward) and PsAMV (negative orbital velocity) bound the dust tail on
  // the sky; the tail's young, high-β part starts along PsAng and older/larger grains lag toward PsAMV.
  fx.ours.forEach((o, k) => {
    it(`tail directions match Horizons PsAng/PsAMV (${fx.horizons.rows[k].dateUt.slice(0, 11)})`, () => {
      const h = fx.horizons.rows[k];
      const earth = o.earthHelioKm;
      const toComet = sub(o.helioKm, earth);
      // our anti-sunward direction: a point slightly further out along the radius vector
      const r = len(o.helioKm);
      const out: V3 = [o.helioKm[0] * (1 + 1e-4), o.helioKm[1] * (1 + 1e-4), o.helioKm[2] * (1 + 1e-4)];
      expect(Math.abs(angDiff(positionAngle(toComet, sub(out, earth)), h.psAngDeg))).toBeLessThan(0.3);
      const back: V3 = sub(o.helioKm, [o.helioVelKmS[0] * 10, o.helioVelKmS[1] * 10, o.helioVelKmS[2] * 10]);
      expect(Math.abs(angDiff(positionAngle(toComet, sub(back, earth)), h.psAmvDeg))).toBeLessThan(0.3);
      // young high-β grains: along PsAng
      const young = grainPosition(o.helioKm, o.helioVelKmS, mu, 0.5, 0.5 * 86400)!.pos;
      expect(Math.abs(angDiff(positionAngle(toComet, sub(young, earth)), h.psAngDeg))).toBeLessThan(3);
      // every drawn packet lies within the sector from PsAng to PsAMV (the short way round), 5° margin
      const input = inputAt(k);
      const c = coma(model, input);
      const pk = dustTail(model, input, c);
      expect(pk.length).toBeGreaterThan(100);
      const span = angDiff(h.psAmvDeg, h.psAngDeg);
      let flux = 0, inSector = 0;
      for (const p of pk) {
        const pa = positionAngle(toComet, sub(p.pos, earth));
        const t = angDiff(pa, h.psAngDeg) / span;
        flux += p.xyzs[1];
        if (t >= -5 / Math.abs(span) && t <= 1 + 5 / Math.abs(span)) inSector += p.xyzs[1];
      }
      expect(inSector / flux).toBeGreaterThan(0.99);
      void r;
    });
  });

  it('the ion tail points along the aberrated anti-solar direction, within the aberration of PsAng', () => {
    fx.ours.forEach((o, k) => {
      const h = fx.horizons.rows[k];
      const d = ionTailDirection(o.helioKm, o.helioVelKmS, model.solarWind.value!.medianKmS);
      const vPerp = Math.sqrt(Math.max(0, len(o.helioVelKmS) ** 2 - ((o.helioVelKmS[0] * o.helioKm[0] + o.helioVelKmS[1] * o.helioKm[1] + o.helioVelKmS[2] * o.helioKm[2]) / len(o.helioKm)) ** 2));
      const aberr = (Math.atan(vPerp / model.solarWind.value!.medianKmS) * 180) / Math.PI;
      const toComet = sub(o.helioKm, o.earthHelioKm);
      const tip: V3 = [o.helioKm[0] + d[0] * 1e6, o.helioKm[1] + d[1] * 1e6, o.helioKm[2] + d[2] * 1e6];
      const pa = positionAngle(toComet, sub(tip, o.earthHelioKm));
      // projected on the sky the aberration angle can only shrink or be foreshortened; allow a generous 3x
      expect(Math.abs(angDiff(pa, h.psAngDeg))).toBeLessThan(3 * aberr + 1);
      // and it bends toward PsAMV (the comet's motion drags the ion tail behind)
      const span = angDiff(h.psAmvDeg, h.psAngDeg);
      expect(Math.sign(angDiff(pa, h.psAngDeg)) === Math.sign(span) || Math.abs(angDiff(pa, h.psAngDeg)) < 0.5).toBe(true);
      const ions = ionTail(model, inputAt(k), coma(model, inputAt(k)));
      expect(ions.length).toBeGreaterThan(10);
    });
  });
});

describe('level of detail', () => {
  it('a comet near the camera is drawn extended, the same comet from 100 au stays a point', () => {
    const o = fx.ours[1];
    const near: V3 = [o.helioKm[0] + 2e6, o.helioKm[1], o.helioKm[2]];
    const far: V3 = [o.helioKm[0] * 170, o.helioKm[1] * 170, o.helioKm[2] * 170];
    const pix = (60 * Math.PI) / 180 / 1080;
    expect(cometLod(model, inputAt(1, near), pix).extended).toBe(true);
    expect(cometLod(model, inputAt(1, far), pix).extended).toBe(false);
    void AU_KM;
  });
});
