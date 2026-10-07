import { describe, expect, it } from 'vitest';
import type { Body, RingComponent, RingComponentEdge, RingComponentModel, RingPhaseTable, RingsFile } from '../src/data/schema';
import { applyExtras } from '../src/app/extras';
import type { SceneBody } from '../src/render/scene';
import { prepareRings } from '../src/render/rings';
import { DATA_DIR } from './core-data';
import {
  CMP_RECORD_VEC4, DAY_S, arcFactor, bandAt, componentBounds, componentTable, componentsIF, componentsTransmission,
  edgeRadius, gAt, gExact, modeArgument, packComponentRecords, packComponents, phaseValue, ringLongitude,
  tableSegment, torusHalfThickness,
} from '../src/render/ringComponents';

const DEG = Math.PI / 180;
const prov = { label: 'estimated' as const, sources: [], method: 'test' };
const edge = (a: number, extra: Partial<RingComponentEdge> = {}): RingComponentEdge => ({
  a, ae: 0, varpi0Deg: 0, varpiDotDegPerDay: 0, aSinI: 0, node0Deg: 0, nodeDotDegPerDay: 0, modes: [], ...extra,
});
const flat = (name: string, v = 1, max = 180): RingPhaseTable => ({
  name, phaseDeg: [0, 90, 180], valuesXYZS: [[v, v, v, v], [v, v, v, v], [v, v, v, v]], minPhaseDeg: 0, maxPhaseDeg: max,
  label: 'estimated', sources: [], method: 'test',
});

function comp(over: Partial<RingComponent> & { values: number[] }): RingComponent {
  const n = over.values.length;
  return {
    id: over.id ?? 'c', name: over.name ?? 'c', kind: over.kind ?? 'sheet', inner: over.inner ?? edge(1000), outer: over.outer ?? edge(1100),
    profile: { uStart: 0.5 / n, uStep: 1 / n, values: over.values, widthRefKm: 100, widthScaling: false, opticalDepthKnown: true },
    layer: over.layer === undefined ? { phaseFunction: 'flat', scale: 1 } : over.layer,
    thin: over.thin === undefined ? null : over.thin,
    ...(over.arcs ? { arcs: over.arcs } : {}),
    ...(over.vertical ? { vertical: over.vertical } : {}),
    provenance: { geometry: prov, opticalDepth: prov, reflectance: prov },
  };
}

function model(components: RingComponent[], extra: Partial<RingComponentModel> = {}): RingComponentModel {
  return {
    kind: 'ring-components-v1', formula: '', epochEt: 0, longitudeOrigin: '', poleSense: 1,
    phaseFunctions: { flat: flat('flat'), low: flat('low', 1, 15) }, components, notes: '', ...extra,
  };
}

describe('ring components: geometry', () => {
  it('edges are keplerian ellipses with modes; m = 0 is a radial oscillation', () => {
    const e = edge(51000, { ae: 400, varpi0Deg: 30, varpiDotDegPerDay: 1.36 });
    // periapse and apoapse at the precessed ϖ
    const t = 10;
    const pw = (30 + 1.36 * t) * DEG;
    expect(edgeRadius(e, pw, t)).toBeCloseTo(51000 - 400, 6);
    expect(edgeRadius(e, pw + Math.PI, t)).toBeCloseTo(51000 + 400, 6);
    const m0 = { m: 0, amplitudeKm: 5, phaseDeg: 20, patternSpeedDegPerDay: 3 };
    expect(modeArgument(m0, 1.0, 2)).toBeCloseTo(-(3 * 2 + 20) * DEG, 12);
    expect(modeArgument(m0, 2.0, 2)).toBeCloseTo(modeArgument(m0, 1.0, 2), 12);
    const m2 = { m: 2, amplitudeKm: 3, phaseDeg: 10, patternSpeedDegPerDay: 5 };
    expect(modeArgument(m2, 1.0, 1)).toBeCloseTo(2 * (1.0 - 15 * DEG), 12);
    const em = edge(1000, { modes: [m2] });
    expect(edgeRadius(em, 15 * DEG, 1)).toBeCloseTo(1000 - 3, 9);   // argument 0 → r − A
  });

  it('bands scale τ with width and reject crossed edges as unknown', () => {
    const c = comp({ values: [1, 1], inner: edge(1000, { ae: 10 }), outer: edge(1100, { ae: 50 }) });
    c.profile.widthScaling = true;
    const m = model([c]);
    const peri = bandAt(m, c, 0, 0), apo = bandAt(m, c, Math.PI, 0);
    expect(peri.W).toBeCloseTo(1100 - 50 - (1000 - 10), 1);
    expect(apo.W).toBeCloseTo(1100 + 50 - (1000 + 10), 1);
    expect(peri.s * peri.W).toBeCloseTo(100, 9);                    // τ·W conserved
    const crossed = comp({ values: [1], inner: edge(1000), outer: edge(999.9) });
    expect(bandAt(model([crossed]), crossed, 0, 0)).toBeNull();
    const mCrossed = model([crossed]);
    const light = componentsIF(mCrossed, [componentTable(crossed)], 1000, 0, 0, 10, 0.5, 0.5, true, 5);
    expect(light.iof).toEqual([0, 0, 0, 0]);
    expect(light.tau).toBe(0);
    expect(light.unknownCoverage).toBeGreaterThan(0);
    expect(componentsTransmission(mCrossed, [componentTable(crossed)], 1000, 0, 0, 10, 0.5)).toBe(1);
  });

  it('geometry outside its supporting observation span is unknown, hatched and emits no light or extinction', () => {
    const c = comp({ values: [1] });
    Object.assign(c, { geometryValidity: { startEt: -10, endEt: 10, basis: 'test observation span' } });
    const m = model([c]);
    const ts = [componentTable(c)];
    expect(bandAt(m, c, 0, 10)).not.toBeNull();
    for (const et of [-11, 11]) {
      expect(bandAt(m, c, 0, et)).toBeNull();
      const light = componentsIF(m, ts, 1050, 0, et, 10, 0.5, 0.5, true, 5);
      expect(light.iof).toEqual([0, 0, 0, 0]);
      expect(light.tau).toBe(0);
      expect(light.unknownCoverage).toBe(1);
      expect(componentsTransmission(m, ts, 1050, 0, et, 10, 0.5)).toBe(1);
      expect(packComponentRecords(packComponents(m), et)[15] & 16).toBe(16);
    }
  });

  it('a valid sub-kilometre width is retained without a physical floor', () => {
    const c = comp({ values: [1], outer: edge(1000.1) });
    expect(bandAt(model([c]), c, 0, 0)?.W).toBeCloseTo(0.1, 9);
  });

  it('longitudes are measured from the ascending node of the equator on the ICRF equator', () => {
    const P: [number, number, number] = [0, Math.sin(30 * DEG), Math.cos(30 * DEG)];
    const node = [-P[1], P[0], 0];                                   // ẑ × P
    const nl = Math.hypot(node[0], node[1]);
    expect(ringLongitude([node[0] / nl, node[1] / nl, 0], P)).toBeCloseTo(0, 9);
    // 90° further in the direction of motion (P × node)
    const y: [number, number, number] = [P[1] * 0 - P[2] * node[1] / nl, P[2] * node[0] / nl - P[0] * 0, P[0] * node[1] / nl - P[1] * node[0] / nl];
    expect(ringLongitude(y, P)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('arcs move at their mean motion and vanish outside the tabulated range', () => {
    const arcs = { lambda0Deg: 100, epochEt: 0, meanMotionDegPerDay: 820, phiStartDeg: -5, phiStepDeg: 5, factor: [0, 10, 20, 0] };
    const c = comp({ values: [1], arcs });
    expect(arcFactor(c, 105 * DEG, 0)).toBeCloseTo(20, 9);
    expect(arcFactor(c, 102.5 * DEG, 0)).toBeCloseTo(15, 9);
    expect(arcFactor(c, 200 * DEG, 0)).toBe(0);
    // one day later the arcs have advanced by 820° = 100° mod 360
    expect(arcFactor(c, 205 * DEG, DAY_S)).toBeCloseTo(20, 6);
  });
});

describe('ring components: optical depth and light', () => {
  const values = [0.05, 0.3, 1.2, 3.0, 0.8, 0.0, 0.4];
  const c = comp({ values });
  const t = componentTable(c);

  it('G from the tabulated nodes matches the exact integral', () => {
    for (const [ua, ub] of [[0, 1], [0.1, 0.55], [0.33, 0.34], [-0.2, 0.5]]) {
      for (const x of [0.01, 0.2, 0.9, 3.3, 17, 250, 4000]) {
        const g = gAt(t, ua, ub, x)[0], ex = gExact(c, ua, ub, x);
        expect(Math.abs(g - ex)).toBeLessThanOrEqual(0.02 * ex + 1e-9);
      }
    }
    expect(tableSegment(t, 0, 0, 1)).toBeCloseTo(values.reduce((a, b) => a + b, 0) / values.length, 9);
  });

  it('thin and thick limits of the lit layer', () => {
    const thinC = comp({ values: [1e-5, 1e-5] });
    const m = model([thinC]);
    const tt = [componentTable(thinC)];
    const mu = 0.4, mu0 = 0.7;
    // a footprint 4× the band: footprint mean = (W/fw)·L·τ/(4μ) for τ ≪ μ
    const thin = componentsIF(m, tt, 1050, 0, 0, 400, mu, mu0, true, 10);
    expect(thin.iof[1] / ((100 / 400) * (1e-5 / (4 * mu)))).toBeCloseTo(1, 4);
    const thickC = comp({ values: [50, 50] });
    const thick = componentsIF(model([thickC]), [componentTable(thickC)], 1050, 0, 0, 400, mu, mu0, true, 10);
    expect(thick.iof[1]).toBeCloseTo((100 / 400) * (mu0 / (4 * (mu + mu0))), 9);
    // unlit face of a thick ring is dark; of a thin ring, the same as the lit face
    expect(componentsIF(model([thickC]), [componentTable(thickC)], 1050, 0, 0, 400, mu, mu0, false, 10).iof[1]).toBeLessThan(1e-12);
    expect(componentsIF(m, tt, 1050, 0, 0, 400, mu, mu0, false, 10).iof[1]).toBeCloseTo(thin.iof[1], 12);
  });

  it('a phase angle outside a table makes the light unknown, and brightness-only components do not absorb', () => {
    const c2 = comp({ values: [0.2, 0.2], layer: { phaseFunction: 'low', scale: 1 } });
    const m = model([c2]);
    const out = componentsIF(m, [componentTable(c2)], 1050, 0, 0, 50, 0.5, 0.5, true, 40);
    expect(out.iof[1]).toBe(0);
    expect(out.tauUnknown).toBeCloseTo(0.2, 9);
    const b = comp({ values: [1e-4, 1e-4], layer: null, thin: { phaseFunction: 'flat', scale: 4 } });
    b.profile.opticalDepthKnown = false;
    expect(componentsTransmission(model([b]), [componentTable(b)], 1050, 0, 0, 50, 0.5)).toBe(1);
    // its normal I/F integrated over the band is the profile's (NEW = ∫ μ I/F dr)
    const iof = componentsIF(model([b]), [componentTable(b)], 1050, 0, 0, 400, 0.5, 0.5, true, 5).iof[1];
    expect(iof * 0.5 * 400).toBeCloseTo(1e-4 * 100, 9);
  });

  it('transmission through a fully covered uniform band', () => {
    const u = comp({ values: [0.3, 0.3] });
    const T = componentsTransmission(model([u]), [componentTable(u)], 1050, 0, 0, 400, 0.6);
    // exact up to the interpolation of G between its nodes (power law): here 3e-4
    expect(Math.abs(T - (1 - (100 / 400) * (1 - Math.exp(-0.3 / 0.6))))).toBeLessThan(1e-3);
  });

  it('unknown light marks the covered footprint even for a faint ring or a brightness-only band', () => {
    for (const brightnessOnly of [false, true]) {
      const faint = comp({ values: [1e-8, 0, 1e-8, 0], layer: null });
      faint.profile.opticalDepthKnown = !brightnessOnly;
      const m = model([faint]);
      const out = componentsIF(m, [componentTable(faint)], 1050, 0, 0, 400, 0.5, 0.5, true, 5);
      expect(out.iof).toEqual([0, 0, 0, 0]);
      expect(out.unknownCoverage).toBeCloseTo((100 / 400) * 0.5, 9);
      expect(componentsIF(m, [componentTable(faint)], 900, 0, 0, 50, 0.5, 0.5, true, 5).unknownCoverage).toBe(0);
    }
  });
});

describe('ring components: packing', () => {
  it('records carry the per-frame state and point at the static tables', () => {
    const arcs = { lambda0Deg: 100, epochEt: 0, meanMotionDegPerDay: 820, phiStartDeg: -5, phiStepDeg: 5, factor: [0, 10, 20, 0] };
    const a = comp({ values: [0.1, 0.2], arcs, inner: edge(1000, { ae: 5, varpi0Deg: 10, varpiDotDegPerDay: 2 }) });
    const tor = comp({ id: 't', values: [1e-6, 1e-6], kind: 'torus', layer: null, thin: { phaseFunction: 'flat', scale: 1 },
      inner: edge(2000), outer: edge(3000), vertical: { law: 'inclined-orbits', r0Km: 3000, z0Km: 300 } });
    const m = model([a, tor]);
    const p = packComponents(m);
    expect(p.count).toBe(2);
    expect(p.zMax).toBeCloseTo(torusHalfThickness(tor, componentBounds(tor)[1]), 9);
    expect(p.sizeVec4 * 4).toBe(p.count * CMP_RECORD_VEC4 * 4 + p.staticData.length);
    const rec = packComponentRecords(p, 3 * DAY_S);
    expect(rec.length).toBe(2 * CMP_RECORD_VEC4 * 4);
    expect(rec[2]).toBeCloseTo(((10 + 2 * 3) * DEG) % (2 * Math.PI), 6);   // ϖ(t)
    expect(rec[15]).toBe(2 | 4);                                             // flags: τ known (2), arcs (4)
    const lead = (((100 + 820 * 3 - 5) % 360) + 360) % 360;
    expect(rec[20] / DEG).toBeCloseTo(lead, 3);
    expect(rec[CMP_RECORD_VEC4 * 4 + 15]).toBe(2 | 8);                       // torus with optical depth
    expect(rec[CMP_RECORD_VEC4 * 4 + 26]).toBe(1);                           // inclined-orbits law
  });

  it('phase tables interpolate log-linearly inside their domain and are unknown outside', () => {
    const t: RingPhaseTable = { name: 'x', phaseDeg: [0, 10, 20], valuesXYZS: [[1, 1, 1, 1], [4, 4, 4, 4], [2, 2, 2, 2]], minPhaseDeg: 0, maxPhaseDeg: 15, label: 'estimated', sources: [], method: '' };
    expect(phaseValue(t, 5)![0]).toBeCloseTo(2, 9);
    expect(phaseValue(t, 16)).toBeNull();
  });
});

// Actual light-stage products: exercise the shell's reality gate, GPU packing and the unknown-light path together.
const fs = await import(/* @vite-ignore */ 'node:fs' as string);
const rings: RingsFile | null = fs.existsSync(DATA_DIR + 'rings.json')
  ? JSON.parse(fs.readFileSync(DATA_DIR + 'rings.json', 'utf8')) : null;
const hasComponents = ['599', '799', '899'].every((id) => rings?.[id]?.components?.value);
if (!hasComponents) console.warn('[ring tests] Outer-ring components not built; run the light stage.');

describe.skipIf(!hasComponents)('ring components: real light-stage products', () => {
  it.each([599, 799, 899])('system %i is estimated, packs without truncation, and is withheld at Strict', (id) => {
    const sys = rings![String(id)];
    const m = sys.components!.value!;
    expect(sys.components!.label).toBe('estimated');
    const p = packComponents(m);
    expect(p.count).toBe(m.components.length);
    const records = packComponentRecords(p, m.epochEt);
    expect(Array.from(records).every(Number.isFinite)).toBe(true);
    expect(Array.from(p.staticData).every(Number.isFinite)).toBe(true);
    m.components.forEach((c, k) => {
      const o = k * CMP_RECORD_VEC4 * 4;
      expect(records[o + 3] + records[o + 7]).toBe(c.inner.modes.length + c.outer.modes.length);
    });
    for (const level of ['strict', 'best', 'complete'] as const) {
      const sb: SceneBody = {
        id, name: 'test planet', pos: [0, 0, 1e6], toSun: [0, 0, -1e9],
        orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], radii: [1000, 1000, 1000],
        albedoXYZS: null, phase: null, surfaceUnknown: true, worstLabel: 'measured', selected: false,
      };
      applyExtras(sb, { id } as Body, { rings, surfaces: new Map() }, level, false, m.epochEt);
      if (level === 'strict') {
        expect(sb.rings?.components).toBeUndefined();
        if (id === 599) expect(sb.rings).toBeNull();
        else expect(sb.rings?.reflectance).toBeNull();
      } else {
        expect(sb.rings?.components).toBe(m);
        expect(sb.rings?.et).toBe(m.epochEt);
        expect(prepareRings(sb, [1, 1, 1, 1], 1000, 1e-5).draw?.cmp?.packed.count).toBe(m.components.length);
      }
    }
  });

  it('Galle emits no light and retains a not-measured footprint despite its small optical depth', () => {
    const m = rings!['899'].components!.value!;
    const c = m.components.find((c) => c.id === 'neptune-galle')!;
    expect(c.provenance.reflectance.label).toBe('unknown');
    expect(c.layer).toBeNull();
    expect(c.thin).toBeNull();
    const r = 0.5 * (c.inner.a + c.outer.a);
    const out = componentsIF(m, m.components.map(componentTable), r, 0, m.epochEt, 100, 0.5, 0.5, true, 5);
    expect(out.iof).toEqual([0, 0, 0, 0]);
    expect(out.tauUnknown).toBeGreaterThan(0);
    expect(out.tauUnknown).toBeLessThan(0.001);
    expect(out.unknownCoverage).toBeCloseTo(1, 9);
  });
});
