// Earth's airglow and aurora as the app evaluates and renders them (app/nightglow.ts, render/nightglow.ts: the CPU
// twin of the shader's quadrature), against physics and published measurements:
//   - rayleigh → luminance from the definition of the rayleigh and the CIE observers (values below from the CIE
//     tables), independent of the pipeline's code;
//   - the layer quadrature against closed forms (a vertical column, the parabolic limb integral);
//   - the green line's limb brightness against SCIAMACHY's monthly mean (Lednyts'kyy et al. 2015, AMT 8, 1021): a
//     test of the model (PALACE at Paranal applied elsewhere), never a tuning target;
//   - the aurora's step integration (exact in altitude for steps of any size), the OVATION grid assembly, the
//     coupling's provenance and the reality gating.
// Skipped when nightglow/*.json is not built.

import { describe, expect, it } from 'vitest';
import type { AirglowModel, AuroraModel } from '../src/data/schema';
import { decodeFloat16 } from '../src/data/nightglow';
import { airglowLayers, auroraGrid, couplingAt, dayOfYear, monthWeights, NightglowSource, seasonWeights, solarRadioFlux } from '../src/app/nightglow';
import { emissionTables, layerBranchIntegral, limbFactor, packTables, PHOTON_RADIANCE_PER_R, sampleBins, slabIntegral, toF16Array } from '../src/render/nightglow';
import { numberToF16 } from '../src/render/surface';
import { nightglowRows } from '../src/ui/inspectModel';
import { DATA_DIR } from './core-data';

interface Fs { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; readFileSync(p: string, enc: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const built = fs.existsSync(DATA_DIR + 'nightglow/airglow.json') && fs.existsSync(DATA_DIR + 'nightglow/aurora.json');
if (!built) console.warn('nightglow: nightglow/*.json not built, skipping');
const json = <T>(p: string): T => JSON.parse(fs.readFileSync(DATA_DIR + p, 'utf8')) as T;
const bin = (p: string): ArrayBuffer => { const u = fs.readFileSync(DATA_DIR + p); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer; };

const H = 6.62607015e-34, C = 299792458;   // SI defining constants
const KM = 683.002, KM_S = 1700.06;        // CIE maximum luminous efficacies (photopic at 555.016 nm, scotopic)

describe('rayleigh to luminance', () => {
  it('1 R has the radiance 10^10/(4π) photons m⁻² s⁻¹ sr⁻¹', () => {
    expect(PHOTON_RADIANCE_PER_R).toBeCloseTo(7.957747e8, -2);
  });
});

describe('float16 upload', () => {
  it('toF16Array rounds like numberToF16 and decodeFloat16 inverts it', () => {
    const v = [0, -0, 1, -1, 65504, 70000, 1e-8, 6.1e-5, 3.14159, 12.56, 0.000123, 40.38, Infinity, -2.5e-7];
    const h = toF16Array(v);
    v.forEach((x, k) => expect(h[k]).toBe(numberToF16(x)));
    const back = decodeFloat16(h.buffer);
    expect(back[8]).toBeCloseTo(3.14159, 2);
    expect(back[9]).toBeCloseTo(12.56, 1);
  });
});

describe('nightglow input provenance', () => {
  const model = (): AuroraModel => ({
    kind: 'auroraModel', version: 1, description: 'test fixture', label: 'estimated',
    coupling: { label: 'derived', sources: [], value: {
      unit: 'test', hourlyStart: '2026-01-01T00:00:00Z', stepHours: 1,
      values: [3000, null], measuredUntil: '2026-01-01T00:00:00Z',
      climatology: { value: 1000, label: 'estimated', method: 'test fixture' },
    } },
    ovation: { label: 'estimated', sources: [], value: null },
    magneticCoordinates: { label: 'synthetic', sources: [], value: null },
    emission: { label: 'estimated', sources: [], value: null, uncertainty: 'uncertainty from the product' },
  });

  it('keeps an exact measured hour even when its next hour is a gap', () => {
    const a = model();
    expect(couplingAt(a, Date.parse(a.coupling.value!.hourlyStart))).toEqual({
      value: 3000, label: 'derived', measured: true,
    });
    expect(couplingAt(a, Date.parse(a.coupling.value!.hourlyStart) + 1800e3).measured).toBe(false);
  });

  it('reports the worst aurora input label in the inspector', () => {
    const src = new NightglowSource(null, model(), null);
    expect(src.info('best', Date.parse('2026-01-01T00:00:00Z')).aurora?.label).toBe('synthetic');
  });

  it('reads aurora uncertainty from the product', () => {
    const src = new NightglowSource(null, model(), null);
    const rows = nightglowRows(src.info('best', Date.parse('2026-01-01T00:00:00Z')), 'best');
    expect(rows.find((r) => r.key === 'aurora')?.uncertainty).toContain('uncertainty from the product');
  });
});

describe.skipIf(!built)('nightglow products (nightglow/*.json)', () => {
  const ag = built ? json<AirglowModel>('nightglow/airglow.json') : (null as unknown as AirglowModel);
  const au = built ? json<AuroraModel>('nightglow/aurora.json') : (null as unknown as AuroraModel);

  it('green line: 1 R → cd/m² from the CIE tables (O I 557.7339 nm air, 557.8887 nm vacuum; NIST ASD)', () => {
    // CIE 1931 ȳ and CIE 1951 V′ at 557 and 558 nm (CIE 018:2019 tables), linear at 557.7339 nm.
    const f = 0.7339;
    const y = 0.9993046 * (1 - f) + 0.9983255 * f;
    const vs = 0.3715 * (1 - f) + 0.3569 * f;
    const radiance = PHOTON_RADIANCE_PER_R * (H * C) / 557.8887e-9;   // W m⁻² sr⁻¹ per R
    const Y = KM * y * radiance, S = KM_S * vs * radiance;
    console.log(`  1 R of 557.7 nm: Y = ${Y.toExponential(4)} cd/m², S = ${S.toExponential(4)} scotopic cd/m²`);
    const green = au.emission.value!.lines.OI5577.xyzsPerR;
    expect(green[1] / Y).toBeCloseTo(1, 3);
    expect(green[3] / S).toBeCloseTo(1, 3);
    const og = ag.classes.find((c) => c.id === 'Og')!;
    expect(og.xyzsPerR[1] / Y).toBeCloseTo(1, 3);
    // Per-sample split sums to the total (spectral attenuation keeps the unattenuated light).
    for (const c of ag.classes) for (let ch = 0; ch < 4; ch++) {
      const sum = c.xyzsPerRBySample.reduce((a, r) => a + r[ch], 0);
      expect(Math.abs(sum - c.xyzsPerR[ch])).toBeLessThanOrEqual(2e-3 * Math.abs(c.xyzsPerR[ch]) + 1e-15);
    }
  });

  it('layer quadrature: a vertical column is 1, the limb follows the parabolic closed form', () => {
    const R = 6371;
    for (const L of ag.layers) {
      // Vertical ray (closest approach at the centre): the whole column, to the 8-node rule's 0.2 %.
      const v = layerBranchIntegral(0, R, L.centreKm, L.sigmaKm, 0, Infinity);
      expect(Math.abs(v - 1)).toBeLessThan(2e-3);
    }
    // Tangent at the layer peak: 2Γ(5/4)(8r²σ²)^¼/(σ√(2π)) for h − h_t = s²/2r (pipeline gaussian_column_limb_ratio).
    const meso = ag.layers.find((l) => l.kind === 'mesopause')!;
    const r = R + meso.centreKm;
    const closed = (2 * 0.9064024770554771 * (8 * r * r * meso.sigmaKm ** 2) ** 0.25) / (meso.sigmaKm * Math.sqrt(2 * Math.PI));
    const q = limbFactor(meso.centreKm, R, meso.centreKm, meso.sigmaKm);
    console.log(`  limb/zenith at the peak of a mesopause layer: quadrature ${q.toFixed(2)}, closed form ${closed.toFixed(2)}`);
    expect(q / closed).toBeGreaterThan(0.99);
    expect(q / closed).toBeLessThan(1.01);
    // Thermospheric layer: same check (σ = 50 km).
    const th = ag.layers.find((l) => l.kind === 'thermosphere')!;
    const rT = R + th.centreKm;
    const cT = (2 * 0.9064024770554771 * (8 * rT * rT * th.sigmaKm ** 2) ** 0.25) / (th.sigmaKm * Math.sqrt(2 * Math.PI));
    expect(limbFactor(th.centreKm, R, th.centreKm, th.sigmaKm) / cT).toBeCloseTo(1, 1);
  });

  it("green-line limb brightness against SCIAMACHY (Lednyts'kyy et al. 2015, Fig. 4b: Sept 2010, 20–25° N, ~22 h)", () => {
    const lc = ag.limbCheck!;
    expect(lc.srfSfu).toBeGreaterThan(50);
    const og = ag.classes.find((c) => c.id === 'Og')!;
    const layer = ag.layers.find((l) => l.classes.includes('Og'))!;
    const lt = lc.localTimeH - 24;   // hours from local midnight
    const nodes = ag.climatology.ltBinCentresHours;
    const j = nodes.findIndex((t, i) => t <= lt && nodes[i + 1] > lt);
    const fl = (lt - nodes[j]) / (nodes[j + 1] - nodes[j]);
    const m = lc.month - 1;
    const f0 = og.f0[m][j] * (1 - fl) + og.f0[m][j + 1] * fl;
    const sce = og.sce[m][j] * (1 - fl) + og.sce[m][j + 1] * fl;
    const zenith = og.referenceR * f0 * (1 + 0.01 * sce * (lc.srfSfu! - ag.climatology.srf0));
    let peak = 0, at = 0;
    for (let h = 80; h <= 110; h += 0.25) {
      const v = zenith * limbFactor(h, 6371, layer.centreKm, layer.sigmaKm);
      if (v > peak) { peak = v; at = h; }
    }
    const ratio = peak / lc.peakLimbR;
    console.log(`  green line, ${lc.year}-${String(lc.month).padStart(2, '0')}, LT ${lc.localTimeH} h, F10.7 ${lc.srfSfu} sfu: zenith ${zenith.toFixed(0)} R, `
      + `model limb peak ${peak.toFixed(0)} R at ${at} km; SCIAMACHY ${lc.peakLimbR} R (${lc.peakLimbRRange.join('–')}) at ${lc.peakTangentKm} km; ratio ${ratio.toFixed(2)}`);
    // Pass band: PALACE's own residual variability of the green line (σ tables, 20–50 %) around the measurement.
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.5);
    // The green line's zenith brightness is in the commonly measured range (100–250 R at moderate solar activity).
    expect(zenith).toBeGreaterThan(100);
    expect(zenith).toBeLessThan(250);
  });

  it('airglow climatology: month weights, solar radio flux labels, layer tables', () => {
    const c = ag.climatology.monthCentreDoy;
    expect(monthWeights(c, c[3])).toEqual([3, 4, 0]);
    const [a, b, w] = monthWeights(c, 5);
    expect([a, b]).toEqual([11, 0]);
    expect(w).toBeGreaterThan(0.5);
    const s = ag.solarRadioFlux.value!;
    const first = solarRadioFlux(ag, Date.parse(s.firstDay + 'T12:00:00Z'))!;
    expect(first.label).toBe('derived');
    const late = solarRadioFlux(ag, Date.parse('2027-06-01T12:00:00Z'))!;
    expect(late.label).toBe('estimated');
    const { layers, zenithY } = airglowLayers(ag, 8, 9, 0.5, 100);
    expect(layers.length).toBe(ag.layers.length);
    // Night-time zenith luminance of the whole airglow near 1e-4 cd/m² (the natural night sky is ~2e-4 cd/m²).
    console.log(`  airglow zenith luminance at midnight, September, 100 sfu: ${zenithY.toExponential(3)} cd/m²`);
    expect(zenithY).toBeGreaterThan(5e-5);
    expect(zenithY).toBeLessThan(3e-4);
  });

  it('table packing: per-bin parts sum to the folded luminance', () => {
    const { layers } = airglowLayers(ag, 0, 1, 0.3, 120);
    const ng = { samplesNm: ag.samplesNm, utHours: 0, airglow: { nightMinSzaDeg: 100, ltNodesH: ag.climatology.ltBinCentresHours, layers }, aurora: null, worstLabel: 'estimated' as const };
    const bins = sampleBins(ag.samplesNm, ag.samplesNm, Array.from({ length: 12 }, (_, k) => 375 + 40 * k));
    expect(Array.from(bins.slice(0, 9))).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2]);
    const { data } = packTables(ng, bins);
    const stride = 17 * 4;
    for (let blk = 0; blk < 12; blk++) {
      const o = blk * stride;
      for (let ch = 0; ch < 4; ch++) {
        let s = 0;
        for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) s += data[o + 4 * (1 + ch * 4 + j) + k];
        expect(Math.abs(s - data[o + ch])).toBeLessThanOrEqual(1e-6 * Math.abs(data[o + ch]));
      }
    }
  });

  it('aurora: the step integration is exact in altitude for coarse steps (vertical and slant paths)', () => {
    const e = au.emission.value!;
    const raw = new Float32Array(bin('nightglow/aurora-emission.bin'));
    const nE = e.averageEnergyNodesKeV.length, z = e.altitudesKm, nA = z.length;
    const { rate, cum } = emissionTables(raw, nE, z);
    const ie = 10;
    const look = (t: Float32Array, g: number) => (h: number) => {
      if (h <= z[0]) return t === cum ? 0 : 0;
      if (h >= z[nA - 1]) return t === cum ? t[(ie * nA + nA - 1) * 4 + g] : 0;
      const a = (h - z[0]) / (z[1] - z[0]), a0 = Math.floor(a), fa = a - a0;
      return t[(ie * nA + a0) * 4 + g] * (1 - fa) + t[(ie * nA + a0 + 1) * 4 + g] * fa;
    };
    for (let g = 0; g < 3; g++) {
      const col = cum[(ie * nA + nA - 1) * 4 + g];
      const name = (e.groups ?? ['N2p4278', 'OI5577', 'OI6300'])[g];
      expect(col / e.lines[name].columnRPerErg[ie]).toBeCloseTo(1, 2);
      // Vertical path from 600 km down to the ground in 5 steps of ~120 km: still the whole column.
      const v = slabIntegral(look(cum, g), look(rate, g), (s) => 600 - s, 0, 600, 5);
      expect(v / col).toBeCloseTo(1, 4);
      // Slant path at 60° from the zenith (flat layer): column / cos.
      const sl = slabIntegral(look(cum, g), look(rate, g), (s) => 600 - s * 0.5, 0, 1200, 7);
      expect(sl / (col / 0.5)).toBeCloseTo(1, 4);
    }
  });

  it('aurora: OVATION grid assembly, season weights, coupling provenance', () => {
    for (let d = 1; d <= 365; d += 7) {
      const w = seasonWeights(d);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(Math.min(...w)).toBeGreaterThanOrEqual(0);
    }
    const ov = au.ovation.value!;
    const o = ov.dtype === 'float16' ? decodeFloat16(bin(ov.file)) : new Float32Array(bin(ov.file));
    const nN = ov.couplingNodes.length, nT = ov.mltHours.length, nL = ov.mlatDeg.length;
    expect(o.length).toBe(4 * 2 * nN * nT * nL);
    // doy 354: northern winter weight 1. At a node, the northern energy flux is the stored winter grid.
    const node = 10;
    const g = auroraGrid(au, o, ov.couplingNodes[node], 354);
    const plane = nT * nL;
    let maxDiff = 0, peak = 0, peakMlat = 0;
    for (let t = 0; t < nT; t++) for (let l = 0; l < nL; l++) {
      const stored = o[((0 * 2 + 0) * nN + node) * plane + t * nL + l];
      maxDiff = Math.max(maxDiff, Math.abs(g[(l * nT + t) * 4] - stored));
      if (t === 0 && g[l * nT * 4] > peak) { peak = g[l * nT * 4]; peakMlat = ov.mlatDeg[l]; }
    }
    expect(maxDiff).toBeLessThan(1e-6);
    // The midnight oval (OP2010 at dΦ/dt ≈ 2760) peaks between 60° and 72° magnetic latitude.
    console.log(`  OP2010 midnight energy-flux peak at coupling ${ov.couplingNodes[node].toFixed(0)}: ${peak.toFixed(2)} erg cm⁻² s⁻¹ at ${peakMlat.toFixed(1)}°`);
    expect(peakMlat).toBeGreaterThan(60);
    expect(peakMlat).toBeLessThan(72);
    const c = au.coupling.value!;
    const t0 = Date.parse(c.hourlyStart);
    const k = c.values.findIndex((v, i) => v !== null && c.values[i + 1] !== null);
    expect(couplingAt(au, t0 + (k + 0.5) * 3600e3).measured).toBe(true);
    expect(couplingAt(au, t0 + (k + 0.5) * 3600e3).label).toBe('derived');
    const after = couplingAt(au, Date.parse(c.measuredUntil) + 30 * 86400e3);
    expect(after.measured).toBe(false);
    expect(after.label).toBe('estimated');
    expect(after.value).toBe(c.climatology.value);
  });

  it('reality gating: nothing at Strict, airglow and aurora at Best estimate', () => {
    const ov = au.ovation.value!;
    const bins = {
      ovation: ov.dtype === 'float16' ? decodeFloat16(bin(ov.file)) : new Float32Array(bin(ov.file)),
      magnetic: new Float32Array(bin(au.magneticCoordinates.value!.file)),
      emission: new Float32Array(bin(au.emission.value!.file)),
    };
    const src = new NightglowSource(ag, au, bins);
    const t = Date.parse('2026-10-15T00:00:00Z');
    expect(src.scene('strict', t)).toBeNull();
    const s = src.scene('best', t)!;
    expect(s.airglow).not.toBeNull();
    expect(s.aurora).not.toBeNull();
    expect(s.worstLabel).toBe('estimated');
    expect(src.scene('complete', t)?.worstLabel).toBe('estimated');
    expect(s.utHours).toBe(0);
    const info = src.info('strict', t);
    expect(info.airglow?.drawn).toBe(false);
    expect(info.aurora?.drawn).toBe(false);
    expect(info.aurora?.coupling.measured).toBe(false);
    expect(dayOfYear(Date.parse('2026-01-01T12:00:00Z'))).toBeCloseTo(1.5, 9);
  });
});
