// TEST FIXTURES ONLY. Made-up small-body tables (same layout rules as the pipeline's smallbodies products) for
// unit tests of the app shell. None of these numbers describe real objects.

import type { BinaryField, Label, SmallBodyCoreHeader, SmallBodyForceModel, SmallBodyPhysicalHeader, SmallBodyTableHeader } from '../src/data/schema';
import { BinaryTable } from '../src/data/binaryTable';
import { NO_ROW, type SmallBodyTable, type SmallBodyTables } from '../src/data/smallbodies';
import type { PointSourceBuffer, SmallBodyFieldPort, Vec3 } from '../src/app/ports';

type FieldSpec = [name: string, type: BinaryField['type'], count?: number];
const SIZE: Record<BinaryField['type'], number> = { f32: 4, f64: 8, u32: 4, i32: 4, u16: 2, u8: 1 };
const LABELS: Label[] = ['measured', 'derived', 'estimated', 'synthetic', 'unknown'];
export const L = (l: Label): number => LABELS.indexOf(l);

/** Pack records into a header + buffer (fields aligned to their size; stride a multiple of 8). */
export function makeTable<H extends SmallBodyTableHeader>(specs: FieldSpec[], records: Record<string, number | number[]>[], extra: Partial<H> = {}): SmallBodyTable<H> {
  let off = 0;
  const fields: BinaryField[] = specs.map(([name, type, count = 1]) => {
    const s = SIZE[type];
    off = Math.ceil(off / s) * s;
    const f: BinaryField = { name, type, offset: off, ...(count > 1 ? { count } : {}) } as BinaryField;
    off += s * count;
    return f;
  });
  const stride = Math.ceil(off / 8) * 8;
  const buffer = new ArrayBuffer(stride * records.length);
  const dv = new DataView(buffer);
  records.forEach((r, i) => {
    for (const f of fields) {
      const v = r[f.name];
      const vals = v === undefined ? [f.type.startsWith('f') ? NaN : 0] : Array.isArray(v) ? v : [v];
      vals.forEach((x, k) => {
        const o = i * stride + f.offset + k * SIZE[f.type];
        if (f.type === 'f64') dv.setFloat64(o, x, true);
        else if (f.type === 'f32') dv.setFloat32(o, x, true);
        else if (f.type === 'u32') dv.setUint32(o, x, true);
        else if (f.type === 'i32') dv.setInt32(o, x, true);
        else if (f.type === 'u16') dv.setUint16(o, x, true);
        else dv.setUint8(o, x);
      });
    }
  });
  const header = { bin: 'x.bin', count: records.length, stride, fields, labelEncoding: LABELS, sourceTable: ['src-orbits', 'src-physical', 'src-colour'], ...extra } as unknown as H;
  return { header, buffer, table: new BinaryTable(header, buffer) };
}

export const DAY = 86400;
export const EPOCH = 8.4e8;
export const FAKE_GM = 1.3e11;

/** A two-body force model (no perturbers, no relativity): propagation is exact Kepler motion. */
export const FORCE_MODEL: SmallBodyForceModel = {
  frame: 'fake',
  sun: { naifId: 10, gm: FAKE_GM, radius: 7e5, sources: [] },
  perturbers: [],
  perturberSources: ['src-planets'],
  ephemeris: 'ephem/fake',
  indirect: 'none',
  zonal: { perturber: null, j2: 0, referenceRadiusKm: 1, poleIcrf: [0, 0, 1], source: '', model: '' },
  relativity: { model: 'none', enabled: false, cKmS: 3e5 },
  nonGravitational: 'none',
  scheme: { name: 'LEAPFROG', drift: [0.5, 0.5], kick: [1], order: '2' },
  grid: { baseStepS: 2 * DAY, rule: '' },
  stepControl: { etaSun: 0.3, etaPlanet: 0.3, etaEncounter: 0.01, kmax: 16, encounterRatio: 1e-3, rule: '', encounter: '' },
  obliquityArcsec: 0,
  kepler: '',
};

const CORE_FIELDS: FieldSpec[] = [
  ['pos', 'f64', 3], ['vel', 'f64', 3], ['H', 'f32'], ['G', 'f32'], ['diameterFromH', 'f32'], ['physRow', 'u32'], ['flags', 'u16'],
  ['orbitClass', 'u8'], ['conditionCode', 'u8'], ['mpcU', 'u8'], ['posLabel', 'u8'], ['hLabel', 'u8'], ['gLabel', 'u8'], ['diameterFromHLabel', 'u8'],
  ['orbitSrc', 'u8'], ['hSrc', 'u8'], ['gSrc', 'u8'], ['diameterFromHSrc', 'u8'],
];
const PHYS_FIELDS: FieldSpec[] = [
  ['row', 'u32'], ['diameter', 'f32'], ['diameterSigma', 'f32'], ['albedo', 'f32'], ['albedoSigma', 'f32'], ['geometricAlbedoXYZS', 'f32', 4],
  ['diameterLabel', 'u8'], ['diameterSrc', 'u8'], ['albedoLabel', 'u8'], ['albedoSrc', 'u8'], ['colorLabel', 'u8'], ['colorSrc', 'u8'],
  ['phaseH', 'f32'], ['phaseG1', 'f32'], ['phaseG2', 'f32'], ['phaseLabel', 'u8'], ['phaseSrc', 'u8'],
];

/** Speed of a circular orbit of radius r about FAKE_GM. */
export const vCirc = (r: number): number => Math.sqrt(FAKE_GM / r);

export const R0 = 3e8; // km

/**
 * Four objects: 0 a numbered NEO with a measured diameter, colour and a phase fit (G assumed);
 * 1 an asteroid known only from H (diameter from H, estimated); 2 lost (no position); 3 a comet.
 */
export function fakeTables(): SmallBodyTables {
  const v = vCirc(R0);
  const core = makeTable<SmallBodyCoreHeader>(CORE_FIELDS, [
    { pos: [R0, 0, 0], vel: [0, v, 0], H: 15, G: 0.15, diameterFromH: 5, physRow: 0, flags: 2 | 4, orbitClass: 0, conditionCode: 0, mpcU: 255, posLabel: L('derived'), hLabel: L('measured'), gLabel: L('estimated'), diameterFromHLabel: L('unknown'), orbitSrc: 0, hSrc: 0, gSrc: 255, diameterFromHSrc: 255 },
    { pos: [0, R0, 0], vel: [-v, 0, 0], H: 18, G: 0.15, diameterFromH: 1, physRow: NO_ROW, flags: 0, orbitClass: 1, conditionCode: 3, mpcU: 4, posLabel: L('derived'), hLabel: L('measured'), gLabel: L('estimated'), diameterFromHLabel: L('estimated'), orbitSrc: 0, hSrc: 0, gSrc: 255, diameterFromHSrc: 255 },
    { pos: [NaN, NaN, NaN], vel: [NaN, NaN, NaN], H: 20, G: 0.15, diameterFromH: NaN, physRow: NO_ROW, flags: 128, orbitClass: 1, conditionCode: 9, mpcU: 255, posLabel: L('unknown'), hLabel: L('measured'), gLabel: L('estimated'), diameterFromHLabel: L('unknown'), orbitSrc: 0, hSrc: 0, gSrc: 255, diameterFromHSrc: 255 },
    { pos: [-R0, 0, 0], vel: [0, -v, 0], H: NaN, G: NaN, diameterFromH: NaN, physRow: NO_ROW, flags: 1, orbitClass: 2, conditionCode: 255, mpcU: 255, posLabel: L('derived'), hLabel: L('unknown'), gLabel: L('unknown'), diameterFromHLabel: L('unknown'), orbitSrc: 0, hSrc: 255, gSrc: 255, diameterFromHSrc: 255 },
  ], {
    epochEt: EPOCH,
    epochTdb: 'fake epoch',
    window: { startEt: EPOCH - 400 * DAY, endEt: EPOCH + 400 * DAY },
    forceModel: FORCE_MODEL,
    orbitClasses: [{ code: 'AAA', name: 'fake class A' }, { code: 'BBB', name: 'fake class B' }, { code: 'CCC', name: 'fake comet class' }],
    flagBits: { '1': 'comet', '2': 'numbered', '4': 'neo', '8': 'pha', '128': 'positionLost' },
    classAlbedo: {},
    statistics: { labels: { H: { measured: 3, unknown: 1 }, G: { estimated: 3, unknown: 1 } } },
    columns: {
      pos: { unit: 'km', label: 'posLabel', source: 'orbitSrc', method: 'fake orbit method' },
      vel: { unit: 'km/s', label: 'posLabel', source: 'orbitSrc' },
      H: { unit: 'mag', label: 'hLabel', source: 'hSrc', method: 'fake H method' },
      G: { label: 'gLabel', source: 'gSrc', method: 'fake G method: assumed value, estimated' },
      diameterFromH: { unit: 'km', label: 'diameterFromHLabel', source: 'diameterFromHSrc', method: 'fake D(H) method' },
    },
  } as Partial<SmallBodyCoreHeader>);
  const physical = makeTable<SmallBodyPhysicalHeader>(PHYS_FIELDS, [
    { row: 0, diameter: 10, diameterSigma: 1, albedo: 0.2, albedoSigma: 0.02, geometricAlbedoXYZS: [0.1, 0.2, 0.3, 0.4], diameterLabel: L('measured'), diameterSrc: 1, albedoLabel: L('measured'), albedoSrc: 1, colorLabel: L('derived'), colorSrc: 2, phaseH: 15.1, phaseG1: 0.3, phaseG2: 0.4, phaseLabel: L('measured'), phaseSrc: 1 },
  ], {
    lcdbU: [''], taxonomyB: [''], taxonomyT: [''],
    columns: {
      diameter: { unit: 'km', label: 'diameterLabel', source: 'diameterSrc', method: 'fake diameter method' },
      albedo: { label: 'albedoLabel', source: 'albedoSrc' },
      geometricAlbedoXYZS: { unit: 'lux at 1 AU', label: 'colorLabel', source: 'colorSrc', method: 'fake colour method' },
      phaseH: { unit: 'mag', label: 'phaseLabel', source: 'phaseSrc', method: 'fake phase method' },
    },
  } as Partial<SmallBodyPhysicalHeader>);
  const comets = makeTable([['row', 'u32'], ['M1', 'f32'], ['K1', 'f32'], ['totalLabel', 'u8'], ['nuclearLabel', 'u8'], ['src', 'u8']], [
    { row: 3, M1: 10, K1: 8, totalLabel: L('estimated'), nuclearLabel: L('unknown'), src: 0 },
  ], { columns: { M1: { unit: 'mag', label: 'totalLabel', source: 'src', method: 'fake comet law' } } });
  return {
    core, physical, comets, nongrav: null, namesHeader: null,
    cometRow: new Map([[3, 0]]), nongravRow: new Map(), count: 4,
  };
}

/** Fake GPU field: fixed heliocentric states per row, a scripted pick, and a record of excluded rows. */
export class FakeField implements SmallBodyFieldPort {
  excluded: number[][] = [];
  updates = 0;
  pickResult: number | null = null;
  picks: { dir: Vec3; tol: number }[] = [];
  stats = { drawn: 7, withheld: 3 };
  readonly pointSources: PointSourceBuffer = { buffer: {} as GPUBuffer, count: 0, strideFloats: 8 };
  constructor(private states: Record<number, Vec3>) {}
  update(): void {
    this.updates++;
  }
  async pick(dir: Vec3, tol: number): Promise<number | null> {
    this.picks.push({ dir, tol });
    return this.pickResult;
  }
  stateOf(index: number): { pos: Vec3; vel: Vec3 } | null {
    const p = this.states[index];
    return p ? { pos: p, vel: [0, 0, 0] } : null;
  }
  exclude(indices: number[]): void {
    this.excluded.push([...indices]);
  }
}
