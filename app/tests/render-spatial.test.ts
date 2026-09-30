// Spatial photometric models (Hapke, Lommel–Seeliger, lunar-Lambert, Minnaert) against published
// worked values and closed forms, and the disk-integral normalization that keeps a surface map and a
// spatial law consistent with the measured disk-integrated photometry (architecture §4.3/§4.4).
import { describe, expect, it } from 'vitest';
import {
  gaussLegendre, hapkeRadf, hFunction1981, hFunction2002, LAMBERT_LAW, LAW, lawDiskIntegral, lawRadf,
  lommelSeeligerPhase, resolveLaw, type ResolvedLaw, type ZonalProfile,
} from '../src/render/spatial';
import { lambertPhase } from '../src/render/photometry';

const deg = (d: number) => (d * Math.PI) / 180;
const law = (m: Parameters<typeof resolveLaw>[0], a = 0): ResolvedLaw => {
  const r = resolveLaw(m, a);
  if ('error' in r) throw new Error(r.error);
  return r.law;
};

/** Chandrasekhar's H function for isotropic scattering, solved from its integral equation by iteration. */
function hExact(mu: number, w: number): number {
  const { x, w: gw } = gaussLegendre(64);
  const nodes = Array.from(x, (v) => (v + 1) / 2);
  const wts = Array.from(gw, (v) => v / 2);
  let H = nodes.map(() => 1);
  for (let it = 0; it < 500; it++) {
    // 1/H(μ) = sqrt(1 − w) + (w/2) ∫ μ' H(μ')/(μ + μ') dμ'  (Chandrasekhar 1960, Eq. V.(10)–(11) form)
    H = nodes.map((m) => 1 / (Math.sqrt(1 - w) + (w / 2) * nodes.reduce((s, mp, j) => s + (wts[j] * mp * H[j]) / (m + mp), 0)));
  }
  return 1 / (Math.sqrt(1 - w) + (w / 2) * nodes.reduce((s, mp, j) => s + (wts[j] * mp * H[j]) / (mu + mp), 0));
}

describe('Chandrasekhar H function', () => {
  it('the reference solver satisfies the exact moment identity ∫H dμ = (2/w)(1 − √(1 − w)) (Chandrasekhar 1960)', () => {
    const { x, w: gw } = gaussLegendre(48);
    for (const w of [0.2, 0.6, 0.9, 0.99]) {
      let a0 = 0;
      for (let i = 0; i < x.length; i++) a0 += (gw[i] / 2) * hExact((x[i] + 1) / 2, w);
      expect(a0 / ((2 / w) * (1 - Math.sqrt(1 - w)))).toBeCloseTo(1, 4);
    }
  });
  it('Hapke (2002) approximation is within 1 % of the exact H for all w, μ (as Hapke states)', () => {
    for (const w of [0.1, 0.3, 0.5, 0.7, 0.9, 0.99])
      for (const mu of [0.05, 0.2, 0.5, 0.8, 1]) {
        expect(Math.abs(hFunction2002(mu, w) / hExact(mu, w) - 1)).toBeLessThan(0.01);
      }
  });
  it('Hapke (1981) approximation is the cruder one (a few %)', () => {
    let worst = 0;
    for (const w of [0.5, 0.9, 0.99]) for (const mu of [0.2, 0.5, 1]) worst = Math.max(worst, Math.abs(hFunction1981(mu, w) / hExact(mu, w) - 1));
    expect(worst).toBeGreaterThan(0.01);
    expect(worst).toBeLessThan(0.05);
  });
});

describe('Hapke model vs the USGS ISIS reference implementation (Hapke/Hapke.truth, public domain)', () => {
  // ISIS "HapkeHen": Hapke (1981/1984) with the (1 + 2x)/(1 + 2γx) H function; Hg2 = (1 + c)/2.
  // CalcSurfAlbedo(phase, incidence, emission) returns the radiance factor.
  const isis = (w: number, b0: number, hh: number, theta: number, hg1: number, hg2: number): ResolvedLaw =>
    law({ kind: 'hapke', w, b: hg1, c: 2 * hg2 - 1, bs0: b0, hs: hh, thetaBarDeg: theta, hFunction: 'hapke1981' });
  it('defaults (w 0.5, smooth, no opposition effect)', () => {
    const l = isis(0.5, 0, 0, 0, 0, 0);
    expect(hapkeRadf(0, 0, 0, l)).toBeCloseTo(0.0965097, 6);
    expect(hapkeRadf(deg(45), deg(30), deg(60), l)).toBeCloseTo(0.0832883, 6);
    expect(hapkeRadf(deg(90), deg(90), deg(180), l)).toBe(0);
  });
  it('w 0.52, B0 1, h 1, θ̄ 30°, Hg1 0.213, Hg2 1 (rough surface, opposition surge)', () => {
    const l = isis(0.52, 1, 1, 30, 0.213, 1);
    expect(hapkeRadf(0, 0, 0, l)).toBeCloseTo(0.286048, 5);
    expect(hapkeRadf(deg(45), deg(30), deg(60), l)).toBeCloseTo(0.1342, 4);
  });
});

describe('lunar-Lambert and Minnaert vs ISIS (LunarLambert.truth, Minnaert.truth; normalised to 1 at i = e = 0)', () => {
  const at = (l: ResolvedLaw) => lawRadf(l, Math.cos(deg(45)), Math.cos(deg(30)), deg(60)) / lawRadf(l, 1, 1, 0);
  it('lunar-Lambert L = 1, 0, 0.5, 2', () => {
    expect(at(law({ kind: 'lunar-lambert', L: 1 }))).toBeCloseTo(0.898979, 6);
    expect(at(law({ kind: 'lunar-lambert', L: 0 }))).toBeCloseTo(0.707107, 6);
    expect(at(law({ kind: 'lunar-lambert', L: 0.5 }))).toBeCloseTo(0.803043, 6);
    expect(at(law({ kind: 'lunar-lambert', L: 2 }))).toBeCloseTo(1.09085, 5);
  });
  it('Minnaert k = 1, 0, 0.5, 2', () => {
    expect(at(law({ kind: 'minnaert', k: 1 }))).toBeCloseTo(0.707107, 6);
    expect(at(law({ kind: 'minnaert', k: 0 }))).toBeCloseTo(1.1547, 4);
    expect(at(law({ kind: 'minnaert', k: 0.5 }))).toBeCloseTo(0.903602, 6);
    expect(at(law({ kind: 'minnaert', k: 2 }))).toBeCloseTo(0.433013, 6);
  });
});

describe('model parameters', () => {
  it('tabulated parameters interpolate and are never extrapolated', () => {
    const m = { kind: 'minnaert' as const, k: { alphaDeg: [10, 50], values: [0.6, 1.0] } };
    expect(law(m, deg(30)).p).toBeCloseTo(0.8, 12);
    expect('error' in resolveLaw(m, deg(5))).toBe(true);
    expect('error' in resolveLaw({ kind: 'lommel-seeliger', validPhaseDeg: [0, 90] }, deg(120))).toBe(true);
  });
  it('the smooth Hapke limit (θ̄ → 0) is continuous', () => {
    const base = { kind: 'hapke' as const, w: 0.3, b: 0.25, c: 0.3, bs0: 1.5, hs: 0.05 };
    const smooth = hapkeRadf(deg(40), deg(20), deg(35), law({ ...base, thetaBarDeg: 0 }));
    const tiny = hapkeRadf(deg(40), deg(20), deg(35), law({ ...base, thetaBarDeg: 0.01 }));
    expect(tiny / smooth).toBeCloseTo(1, 3);
  });
});

describe('disk integrals', () => {
  it('Lambert: I(α) = (2/3)·Φ_L(α) (the exact M1 formula)', () => {
    for (const a of [0, 10, 45, 90, 135, 170]) {
      expect(lawDiskIntegral(LAMBERT_LAW, deg(a))[1] / ((2 / 3) * lambertPhase(deg(a)))).toBeCloseTo(1, 5);
    }
  });
  it('Lommel–Seeliger: I(α) = ½·[1 − sin(α/2)tan(α/2)ln cot(α/4)] (closed form)', () => {
    const ls = law({ kind: 'lommel-seeliger' });
    for (const a of [0, 20, 60, 100, 150]) {
      expect(lawDiskIntegral(ls, deg(a))[1] / (0.5 * lommelSeeligerPhase(deg(a)))).toBeCloseTo(1, 4);
    }
  });
  it('Minnaert: geometric albedo I(0) = 2/(2k + 1) of the scale factor', () => {
    for (const k of [0.5, 0.7, 1, 1.3]) {
      expect(lawDiskIntegral(law({ kind: 'minnaert', k }), 0)[1]).toBeCloseTo(2 / (2 * k + 1), 4);
    }
  });
  it('Hapke: brighter limb than Lambert (flatter disk), as observed on the Moon', () => {
    const h = law({ kind: 'hapke', w: 0.25, b: 0.25, c: 0.4, bs0: 1.8, hs: 0.07, thetaBarDeg: 23.657 });
    // Radiance at the limb relative to the disk centre at small phase.
    const ratio = (l: ResolvedLaw) => lawRadf(l, Math.cos(deg(80)), Math.cos(deg(80)), deg(2)) / lawRadf(l, 1, 1, deg(2));
    expect(ratio(LAMBERT_LAW)).toBeCloseTo(Math.cos(deg(80)), 6);
    expect(ratio(h)).toBeGreaterThan(3 * ratio(LAMBERT_LAW));
  });
  it('a zonal map profile weights the integral; a uniform profile changes nothing', () => {
    const rows = 64;
    const ones: ZonalProfile = { rows, mean: new Float64Array(rows * 4).fill(1) };
    const I0 = lawDiskIntegral(LAMBERT_LAW, deg(40));
    const I1 = lawDiskIntegral(LAMBERT_LAW, deg(40), { profile: ones, pole: [0, 1, 0] });
    expect(I1[1] / I0[1]).toBeCloseTo(1, 12);
    // Dark southern hemisphere, bright north, pole along +y (in the sky plane): the channel ratio follows.
    const nb: ZonalProfile = { rows, mean: new Float64Array(rows * 4) };
    for (let j = 0; j < rows; j++) for (let k = 0; k < 4; k++) nb.mean[4 * j + k] = j < rows / 2 ? 1.5 : 0.5;
    const up = lawDiskIntegral(LAMBERT_LAW, deg(40), { profile: nb, pole: [0, 1, 0] });
    expect(up[1] / I0[1]).toBeCloseTo(1, 3); // symmetric about the equator seen edge-on
    const tilted = lawDiskIntegral(LAMBERT_LAW, deg(0), { profile: nb, pole: [0, 0, 1] }); // north pole toward observer
    expect(tilted[1] / lawDiskIntegral(LAMBERT_LAW, 0)[1]).toBeCloseTo(1.5, 3);
  });
  it('law codes are stable (shared with WGSL)', () => {
    expect(LAW).toEqual({ lambert: 0, lommelSeeliger: 1, lunarLambert: 2, minnaert: 3, hapke: 4 });
  });
});
