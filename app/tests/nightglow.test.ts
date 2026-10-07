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
import type { AirglowModel, AirglowProduct, AuroraModel } from '../src/data/schema';
import { decodeAirglowProduct, decodeFloat16 } from '../src/data/nightglow';
import { airglowLayers, auroraGrid, couplingAt, dayOfYear, monthWeights, NightglowSource, seasonWeights, solarRadioFlux } from '../src/app/nightglow';
import { emissionTables, layerBranchIntegral, limbFactor, nightDomainWeight, packTables, PHOTON_RADIANCE_PER_R, screenTextureUv, KEV_PER_ERG_PER_1E8, nightglowRay, sampleBins, slabIntegral, toF16Array } from '../src/render/nightglow';
import { numberToF16 } from '../src/render/surface';
import { nightglowRows } from '../src/ui/inspectModel';
import { DATA_DIR, loadBodies, loadTimeData, loadEphemerisSet, loadOrientation } from './core-data';
import type { LightData, BodyPhotometry, AtmosphereFile, SurfaceLayerHeader } from '../src/data/schema';
import type { SceneSnapshot, SceneBody } from '../src/render/scene';
import { TimeScale } from '../src/core/time';
import { sunFrame, dirFromAzEl, lookRotation, azElFromDir } from '../src/app/camera';
import { add, sub, scale, dot, normalize, type V3 } from '../src/render/raycast';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { prepareRendererFrame } from '../src/render/renderer';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { cie146 } from '../src/eye/glare';
import { atmosphereModelFromData, precomputeAtmosphere, ProfileGrid, viewPath } from '../src/render/atmosphere';
import { nearHit, prepareBody, worldNormal, mulMtV, mulMV } from '../src/render/raycast';
import { LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO } from '../src/render/photometry';
import { uvOf } from '../src/render/surface';
import { planetshineSources } from '../src/render/planetshine';
import { bodyToIcrf } from '../src/core/rotation';

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

describe('nightglow screen reconstruction', () => {
  it('never interpolates across the opposite screen edge with the periodic magnetic sampler', () => {
    for (const pixel of [0.5, 1279.5]) {
      const texel = screenTextureUv(pixel, 1280, 640) * 640 - 0.5;
      expect(Math.floor(texel)).toBeGreaterThanOrEqual(0);
      expect(Math.ceil(texel)).toBeLessThanOrEqual(639);
    }
    expect(screenTextureUv(640, 1280, 640)).toBe(0.5);
  });
});

describe('nightglow input provenance', () => {
  const model = (): AuroraModel => ({
    kind: 'auroraModel', version: 1, description: 'test fixture', label: 'estimated',
    coupling: { label: 'derived', sources: [], value: {
      unit: 'test', hourlyStart: '2026-01-01T00:00:00Z', stepHours: 1,
      values: [3000, null], measuredUntil: '2026-01-01T00:00:00Z',
      climatology: { value: 1000, label: 'estimated', method: 'test fixture', sources: [] },
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
  const ag = built ? decodeAirglowProduct(json<AirglowProduct>('nightglow/airglow.json'))! : (null as unknown as AirglowModel);
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

  it('PALACE has no emission outside its measured night domain, including just below the SZA limit', () => {
    const limit = ag.climatology.nightMinSolarZenithDeg!;
    const cos = (deg: number) => Math.cos(deg * Math.PI / 180);
    expect(nightDomainWeight(cos(limit - 0.1), cos(limit))).toBe(0);
    expect(nightDomainWeight(cos(limit), cos(limit))).toBe(0);
    expect(nightDomainWeight(cos(limit + 0.1), cos(limit))).toBe(1);
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

  it('whole-ray twin preserves a uniform vertical aurora column and stops at the ground', () => {
    const ov = au.ovation.value!, em = au.emission.value!, mag = au.magneticCoordinates.value!;
    const raw = new Float32Array(bin(em.file)), ie = 10, E = em.averageEnergyNodesKeV[ie], flux = 2;
    const grid = new Float32Array(ov.mlatDeg.length * ov.mltHours.length * 4);
    for (let k = 0; k < grid.length; k += 4) grid.set([flux, KEV_PER_ERG_PER_1E8 * flux / E, flux, KEV_PER_ERG_PER_1E8 * flux / E], k);
    // TEST FIXTURE: uniform precipitation and magnetic coordinates isolate the ray integrator.
    const magnetic = new Float32Array(mag.latDeg[2] * mag.lonDeg[2] * 3);
    for (let k = 0; k < magnetic.length; k += 3) magnetic.set([65, 1, 0], k);
    const ng = { samplesNm: ag.samplesNm, utHours: 0, airglow: null, worstLabel: 'estimated' as const, aurora: {
      grid, mltHours: ov.mltHours, mlatDeg: ov.mlatDeg,
      magnetic: { data: magnetic, latDeg: mag.latDeg, lonDeg: mag.lonDeg },
      dipoleFrameRows: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [number[], number[], number[]],
      emission: { data: raw, energiesKeV: em.averageEnergyNodesKeV, altitudesKm: em.altitudesKm },
      groupsBySample: em.groups!.map(g => em.lines[g].xyzsPerRBySample!),
    } };
    const ray = nightglowRay(ng, [0, 0, 6971], [0, 0, -1], [6371, 6371, 6371], [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, -1]);
    expect(ray.ground).toBe(true);
    const C = emissionTables(raw, em.averageEnergyNodesKeV.length, em.altitudesKm).cum;
    for (let c = 0; c < 4; c++) {
      const column = em.groups!.reduce((a, g, k) => a + C[(ie * em.altitudesKm.length + em.altitudesKm.length - 1) * 4 + k] * em.lines[g].xyzsPerR[c] * flux, 0);
      expect(ray.aurora[c] / column).toBeCloseTo(1, 4);
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

// A far-observer disk law must not create a crescent behind a close observer's horizon.
describe.skipIf(!built)('night-side horizon glare', () => {
  it('has no reflected Earth glare when the entire visible surface is in shadow', () => {
    const b = loadBodies()!.find((b) => b.id === 399)!;
    const t = new TimeScale(loadTimeData()!);
    const eph = loadEphemerisSet(['ephem/de442s'])!;
    const orient = loadOrientation('orient/earth')!;
    const earth = json<Record<string, BodyPhotometry>>('photometry.json')['399'];
    const light = json<LightData>('light.json');
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, new AdaptationState(), 'eye', 0, null);
    for (const el of [0, 10, 30, 50, 55]) {
      const et = t.utcMsToEt(Date.parse('2026-10-15T00:00:00Z'));
      const S = sub(eph.positionSSB(10, et)!, eph.positionSSB(399, et)!);
      const up = dirFromAzEl(sunFrame(S), Math.PI, el * Math.PI / 180);
      const R = orient.bodyToIcrf(399, et)!;
      const pole: V3 = [R[2], R[5], R[8]];
      const north = normalize(sub(pole, scale(up, dot(pole, up))));
      const fwd = add(scale(north, Math.cos(-15 * Math.PI / 180)), scale(up, Math.sin(-15 * Math.PI / 180)));
      const snap: SceneSnapshot = { et, camera: { orient: lookRotation(fwd, up), width: 1280, height: 720, fovY: Math.PI / 3 },
        sun: { pos: sub(S, scale(up, 6771)), radius: light.sun.radius.value!, irradianceXYZS_1AU: light.sun.irradianceXYZS_1AU.value!, limbDarkening: null },
        bodies: [{ id: 399, name: 'Earth', pos: scale(up, -6771), toSun: S, orient: R, radii: b.radii!.value! as V3,
          albedoXYZS: earth.geometricAlbedoXYZS.value!, phase: earth.phaseFunction.value!, surfaceUnknown: false, worstLabel: 'estimated', selected: false, allowPhaseExtrapolation: true }],
        view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [] };
      const g = cameraGeom(snap, 1280, 720, 1e-7);
      const old = prepareFrame(snap, g, eye, 1e-8);
      const veil = old.glare.reduce((v, s) => v + s.E[1] * cie146(Math.max(s.minDeg, Math.acos(Math.min(1, dot(s.dir, fwd))) * 180 / Math.PI), 25, 0.5), 0);
      console.log('old Earth analytic veil', el, veil);
      const prep = prepareRendererFrame(snap, g, eye, 1e-8);
      expect(prep.glare.filter((s) => s.E[1] > 0)).toEqual([]);
    }
  });
});


describe.skipIf(!built)('GPU investigation CPU evidence', () => {
  it('bounds emission on the reported centre and ground rays, with actual ephemeris/magnetic geometry', () => {
    const ag = decodeAirglowProduct(json<AirglowProduct>('nightglow/airglow.json'))!;
    const au = json<AuroraModel>('nightglow/aurora.json');
    const ov = au.ovation.value!;
    const src = new NightglowSource(ag, au, { ovation: decodeFloat16(bin(ov.file)), magnetic: new Float32Array(bin(au.magneticCoordinates.value!.file)), emission: new Float32Array(bin(au.emission.value!.file)) });
    const earth = loadBodies()!.find((b) => b.id === 399)!;
    const time = new TimeScale(loadTimeData()!), eph = loadEphemerisSet(['ephem/de442s'])!, ori = loadOrientation('orient/earth')!;
    const light = json<LightData>('light.json');
    const atm = json<AtmosphereFile>('atmospheres.json');
    const photometry = json<Record<string, BodyPhotometry>>('photometry.json');
    const phot = photometry['399'];
    const bodies = loadBodies()!;
    const moonOrientation = loadOrientation('orient/moon')!;
    const got = atmosphereModelFromData({ wavelengthsNm: atm.wavelengthsNm, foldWeights: atm.foldWeights.value!, body: atm.bodies['399'] },
      phot.geometricAlbedoXYZS.value!.map((x, c) => LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO * x / light.sun.irradianceXYZS_1AU.value![c]));
    if ('error' in got) throw new Error(got.error);
    const model = got.model, tables = precomputeAtmosphere(model), G = new ProfileGrid(model);
    const nh = json<SurfaceLayerHeader>('surfaces/399/night.json');
    for (const [iso, el, az, elev] of [
      ['2026-10-15T00:00:00Z', 0, 0, -15], ['2026-10-15T00:00:00Z', 10, 0, -15],
      ['2026-10-15T00:00:00Z', 30, 0, -15], ['2026-10-15T00:00:00Z', 50, 0, -15],
      ['2025-11-12T01:00:00Z', 50, 0, -15], ['2025-11-12T01:00:00Z', 55, 180, -15],
      ['2026-10-15T00:00:00Z', 55, 180, -15], ['2026-10-15T00:00:00Z', 50, 0, -89],
    ] as [string, number, number, number][]) {
      const ms = Date.parse(iso), et = time.utcMsToEt(ms), R = ori.bodyToIcrf(399, et)!;
      const sun = normalize(sub(eph.positionSSB(10, et)!, eph.positionSSB(399, et)!));
      const up = dirFromAzEl(sunFrame(sun), Math.PI, el * Math.PI / 180), camera = scale(up, 6771);
      const pole: V3 = [R[2], R[5], R[8]], north = normalize(sub(pole, scale(up, dot(pole, up))));
      const east: V3 = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
      const horizontal = add(scale(north, Math.cos(az * Math.PI / 180)), scale(east, Math.sin(az * Math.PI / 180)));
      const sources: SceneBody[] = bodies.flatMap(b => {
        const pos = eph.positionSSB(b.id, et), ph = photometry[String(b.id)];
        if (!pos || !ph || !b.radii?.value || !ph.geometricAlbedoXYZS.value || !ph.phaseFunction.value) return [];
        return [{ id: b.id, name: b.name, pos: sub(pos, eph.positionSSB(399, et)!), toSun: sub(eph.positionSSB(10, et)!, pos),
          orient: (b.id === 301 ? moonOrientation.bodyToIcrf(301, et) : null) ?? (b.rotation?.value ? bodyToIcrf(b.rotation.value, et) : null),
          radii: b.radii.value as V3, albedoXYZS: ph.geometricAlbedoXYZS.value, phase: ph.phaseFunction.value,
          diskReflectanceModel: ph.diskReflectanceModel?.value ?? undefined,
          surfaceUnknown: false, worstLabel: 'estimated', selected: false }];
      });
      const earthSource = sources.find(b => b.id === 399)!;
      const shine = planetshineSources(earthSource, sources, light.sun.irradianceXYZS_1AU.value!);
      const results = [];
      for (const [name, elevation] of [['centre', elev], ['ground', elev === -89 ? -89 : el === 0 ? -24 : -32]] as [string, number][]) {
        const dir = add(scale(horizontal, Math.cos(elevation * Math.PI / 180)), scale(up, Math.sin(elevation * Math.PI / 180)));
        const ray = nightglowRay(src.scene('best', ms)!, camera, dir, earth.radii!.value! as V3, R, sun);
        expect(ray.airglow[1]).toBeLessThan(0.02);
        expect(ray.aurora[1]).toBeLessThan(0.2);
        const bf = prepareBody(scale(camera, -1), earth.radii!.value! as V3, R);
        const hit = nearHit(bf, dir);
        let inScatterY = 0, planetshineUpperY = 0, nightSurfaceY: number | null = null;
        if (ray.ground) {
          const p = add(camera, scale(dir, hit.t)), h = worldNormal(bf, hit.h);
          planetshineUpperY = shine.reduce((a, s) => a + s.E[1] / Math.PI * Math.max(0, dot(h, s.dir)), 0);
          expect(dot(h, sun)).toBeLessThan(0); // direct surface and cloud sunlight is exactly zero
          const sphericalPoint = scale(normalize(p), model.bottomKm);
          const path = viewPath(model, tables, G, sphericalPoint, scale(dir, -1), sun, -1, 32);
          inScatterY = model.weights[1].reduce((a, w, k) => a + w * path.L[k], 0) * light.sun.irradianceXYZS_1AU.value![1];
          const [u, v] = uvOf(mulMtV(R, p));
          const W = 512 << nh.maxLevel, H = 256 << nh.maxLevel;
          const x = Math.floor(u * W), y = Math.floor(v * H);
          const tile = nh.tilePath.replace('{level}', String(nh.maxLevel)).replace('{tx}', String(x >> 8)).replace('{ty}', String(y >> 8));
          if (fs.existsSync(DATA_DIR + tile)) {
            const data = nh.format === 'float16' ? decodeFloat16(bin(tile)) : new Float32Array(bin(tile));
            const value = data[((y & 255) * 256 + (x & 255)) * nh.channels.length];
            const factor = (nh.constants!.toXYZS as Record<string, number[]> )['HP1'][1];
            if (Number.isFinite(value)) nightSurfaceY = value * factor;
          }
        }
        expect(inScatterY).toBeLessThan(1e-5);
        expect(planetshineUpperY).toBeLessThan(0.1);
        if (nightSurfaceY !== null) expect(nightSurfaceY).toBeLessThan(0.01);
        results.push({ name, elevationDeg: elevation, airglowY: ray.airglow[1], auroraY: ray.aurora[1], inScatterY, directSurfaceY: 0, planetshineUpperY,
          nightSurfaceY, nightSurfaceNote: 'nearest stored level-4 texel before cloud/path attenuation; null = unknown or sky; planetshineUpperY assumes unit diffuse reflectance',
          ground: ray.ground, tangentKm: ray.tangentAltitudeKm });
      }
      console.log('CPU-RAYS', JSON.stringify({ iso, el, look: `${az},${elev}`, rays: results }));
    }
  });
  it('places storm and quiet views at the same magnetic-midnight oval point, entirely in shadow', () => {
    const ag = decodeAirglowProduct(json<AirglowProduct>('nightglow/airglow.json'))!;
    const au = json<AuroraModel>('nightglow/aurora.json');
    const raw = { ovation: decodeFloat16(bin(au.ovation.value!.file)), magnetic: new Float32Array(bin(au.magneticCoordinates.value!.file)), emission: new Float32Array(bin(au.emission.value!.file)) };
    const src = new NightglowSource(ag, au, raw);
    const time = new TimeScale(loadTimeData()!), eph = loadEphemerisSet(['ephem/de442s'])!, ori = loadOrientation('orient/earth')!;
    const earth = loadBodies()!.find(b => b.id === 399)!;
    const ms = Date.parse('2025-11-12T01:00:00Z'), et = time.utcMsToEt(ms), R = ori.bodyToIcrf(399, et)!;
    const sun = normalize(sub(eph.positionSSB(10, et)!, eph.positionSSB(399, et)!));
    const D = au.magneticCoordinates.value!.dipoleFrameRows;
    const sunB = mulMtV(R, sun);
    const lonSun = Math.atan2(dot(D[1] as V3, sunB), dot(D[0] as V3, sunB));
    // Select the model's midnight energy-flux peak (scene choice only, not a choice of physical law).
    const ng = src.scene('best', ms)!, o = ng.aurora!;
    let peakL = 0, peakFlux = 0;
    const midnight = o.mltHours.indexOf(0);
    for (let l = 0; l < o.mlatDeg.length; l++) if (o.grid[(l * o.mltHours.length + midnight) * 4] > peakFlux) {
      peakFlux = o.grid[(l * o.mltHours.length + midnight) * 4]; peakL = l;
    }
    const targetLat = o.mlatDeg[peakL];
    const m = au.magneticCoordinates.value!;
    let best = Infinity, atLat = 0, atLon = 0;
    for (let y = 0; y < m.latDeg[2]; y++) for (let x = 0; x < m.lonDeg[2]; x++) {
      const k = (y * m.lonDeg[2] + x) * 3, lat = raw.magnetic[k];
      if (!Number.isFinite(lat) || lat < 0) continue;
      const lon = Math.atan2(raw.magnetic[k + 2], raw.magnetic[k + 1]);
      const delta = Math.atan2(Math.sin(lon - lonSun - Math.PI), Math.cos(lon - lonSun - Math.PI)) * 180 / Math.PI;
      const score = (lat - targetLat) ** 2 + delta ** 2;
      if (score < best) { best = score; atLat = m.latDeg[0] + y * m.latDeg[1]; atLon = m.lonDeg[0] + x * m.lonDeg[1]; }
    }
    const lat = atLat * Math.PI / 180, lon = atLon * Math.PI / 180;
    const fixed: V3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const outputs = [];
    for (const iso of ['2025-11-12T01:00:00Z', '2025-11-14T01:00:00Z']) {
      const ms = Date.parse(iso), et = time.utcMsToEt(ms), R = ori.bodyToIcrf(399, et)!;
      const S = sub(eph.positionSSB(10, et)!, eph.positionSSB(399, et)!), sun = normalize(S);
      const up = mulMV(R, fixed), camera = scale(up, 6771);
      const pole: V3 = [R[2], R[5], R[8]], north = normalize(sub(pole, scale(up, dot(pole, up))));
      const fwd = add(scale(north, Math.cos(-89 * Math.PI / 180)), scale(up, Math.sin(-89 * Math.PI / 180)));
      const pose = lookRotation(fwd, up);
      const ae = azElFromDir(sunFrame(S), up);
      let peakY = 0, peakAt = [0, 0], peakAirglowY = 0, centreY = 0;
      const ty = Math.tan(Math.PI / 6), tx = ty * 1280 / 720;
      for (let y = 0; y <= 28; y++) for (let x = 0; x <= 48; x++) {
        const dx = (2 * x / 48 - 1) * tx, dy = (1 - 2 * y / 28) * ty;
        const dir = normalize([0, 1, 2].map(k => pose[3*k] * dx + pose[3*k+1] * dy - pose[3*k+2]) as V3);
        const ray = nightglowRay(src.scene('best', ms)!, camera, dir, earth.radii!.value! as V3, R, sun);
        const b = prepareBody(scale(camera, -1), earth.radii!.value! as V3, R), hit = nearHit(b, dir);
        expect(ray.ground).toBe(true);
        expect(dot(worldNormal(b, hit.h), sun)).toBeLessThan(0);
        if (x === 24 && y === 14) centreY = ray.aurora[1];
        if (ray.aurora[1] > peakY) { peakY = ray.aurora[1]; peakAt = [x / 48, y / 28]; peakAirglowY = ray.airglow[1]; }
      }
      const samePixel = outputs[0]?.peakAt ?? peakAt;
      const dx = (2 * samePixel[0] - 1) * tx, dy = (1 - 2 * samePixel[1]) * ty;
      const sameDir = normalize([0, 1, 2].map(k => pose[3*k] * dx + pose[3*k+1] * dy - pose[3*k+2]) as V3);
      const sameRay = nightglowRay(src.scene('best', ms)!, camera, sameDir, earth.radii!.value! as V3, R, sun);
      outputs.push({ iso, geographic: [atLat, atLon], targetMlat: targetLat,
        params: { target: '399', dist: '6771', az: String(ae.az * 180 / Math.PI), el: String(ae.el * 180 / Math.PI), look: '0,-89', fov: '60' },
        coupling: couplingAt(au, ms), centreAuroraY: centreY, peakAuroraY: peakY, peakAirglowY, peakAt, atStormPeakAuroraY: sameRay.aurora[1], atStormPeakXYZS: sameRay.aurora });
    }
    console.log('CPU-OVAL', JSON.stringify(outputs));
    expect(outputs[0].peakAuroraY).toBeGreaterThan(5 * outputs[1].peakAuroraY);
  });

});
