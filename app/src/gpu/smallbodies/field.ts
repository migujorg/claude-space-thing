// SmallBodyField: every catalogued asteroid and comet propagated and lit on the GPU (milestone M3).
//
// Design (numbers in docs/reports/small-bodies.md, "GPU field"):
//  * Same integrator as the float64 reference (core/smallbody.ts, pipeline sb_dynamics): SABA splitting of a Kepler
//    drift about the Sun and kicks from the planets (forceModel of smallbodies/core.json), steps on the grid
//    epochEt + m*H with 2^level substeps chosen per object and step, RK4 substeps in planetary encounters. WGSL in
//    ./kernels.ts, double-single (df64) states; the planets for the kicks come from a table of float64 CPU
//    ephemeris samples (./planetTable.ts), 65 per 2-day interval, filled lazily and uploaded as needed.
//  * Working state W: all objects at one grid point mW. To show time et, the target grid point is m* = the grid
//    point between the epoch and et nearest et; W is advanced step by step to m* (incrementally from the previous
//    frame when time moves on, away from the epoch), or first restored from the nearest checkpoint on the epoch
//    side of m* (a copy on the GPU) when time jumps back or far. The last partial step m* -> et is taken every frame
//    in the shade kernel and not stored; so the state shown at et is exactly what the CPU reference computes for
//    propagateOne(epochEt -> et) (same steps, same substep levels), up to floating-point differences.
//  * Checkpoints: states at every C-th grid point (C from the memory budget), stored when W or a background
//    builder (which walks out from the epoch a few steps per update) passes them; a jump integrates < C steps.
//  * Shade: light time (first order), direction from the camera, and the illuminance (X, Y, Z, S lux) from the
//    magnitude laws and colours of core/smallbodyPhotometry.ts, gated by the reality level; records in the star
//    layout [dir.xyz, X, Y, Z, S, core index (u32 bits)].
//  * Objects are stored in order of perihelion distance, so objects needing many substeps (near-Sun, near-Earth)
//    share workgroups instead of stalling the main belt ones.

import type {
  SmallBodyCoreHeader, SmallBodyForceModel, SmallBodyPhotometry, SmallBodyPhysicalHeader, SmallBodyTableHeader,
} from '../../data/schema';
import type { Vec3 } from '../../core/vec';
import { AU_KM, C_KM_S } from '../../core/constants';
import { SB_OK, SmallBodyPropagator, type NonGrav, type PlanetPositions } from '../../core/smallbody';
import { coreState, readCore, readNonGrav, type SmallBodyCatalog } from '../../core/smallbodyCatalog';
import { LEVEL_CODE, SmallBodyLight, type ExistsLevel } from '../../core/smallbodyPhotometry';
import { PICK_SHADER, SELFTEST_SHADER, WG, shadeShader, stepShader, type KernelConfig } from './kernels';
import { PlanetTable, SAMPLES } from './planetTable';
import { split64 } from './wgslConst';

export type { PlanetPositions };

export interface SmallBodyTables {
  core: ArrayBuffer;
  coreHeader: SmallBodyCoreHeader;
  physical?: ArrayBuffer;
  physicalHeader?: SmallBodyPhysicalHeader;
  comets?: ArrayBuffer;
  cometsHeader?: SmallBodyTableHeader;
  nongrav?: ArrayBuffer;
  nongravHeader?: SmallBodyTableHeader;
  /** smallbodies/photometry.json. Without it no brightness is known: every record has zero illuminance. */
  photometry?: SmallBodyPhotometry;
}

export interface SmallBodyFieldOptions {
  /** GPU memory for checkpoint states (and the background builder), bytes. Default 1 GiB. */
  checkpointBudgetBytes?: number;
  /** Smallest checkpoint spacing in grid steps (default 8). */
  minCheckpointSpacing?: number;
  /** Grid steps the background builder may take per update when the update itself took fewer (default 2; 0 = off). */
  backgroundStepsPerUpdate?: number;
  /** Objects per dispatch (default: all). Smaller chunks keep single dispatches short on slow devices. */
  chunkObjects?: number;
  /** Keep the double-single state at et of every object readable (readDebugStates). Costs 64 bytes per object. */
  debug?: boolean;
  /** Override the self-test's choice of fma() for exact products (tests). */
  useFma?: boolean;
}

export interface PointSourceBuffer {
  buffer: GPUBuffer;
  count: number;
  strideFloats: number;
}

export interface SmallBodyFieldInfo {
  /** 'df64-fma' / 'df64-dekker': double-single arithmetic verified exact on this device; 'degraded': it is not. */
  precision: 'df64-fma' | 'df64-dekker' | 'degraded';
  selfTest: { fmaExact: boolean; dekkerExact: boolean; maxRelError: number; cases: number };
  objects: number;
  /** Objects with no state (position unknown) or not propagated (planetary-ephemeris objects beyond 4). */
  invalid: number;
  /** Objects drawn from the planetary ephemeris instead (flag planetaryEphemeris: Pluto). */
  external: number;
  photometry: boolean;
  checkpointSpacingSteps: number;
  checkpointSlots: number;
  checkpoints: number;
  last: {
    et: number;
    targetStep: number;
    steps: number;
    backgroundSteps: number;
    restoredFrom: number | null;
    tableIntervalsBuilt: number;
    displayStepS: number;
    cpuMs: number;
    hidden: string | null;
  };
}

const STATE_FLOATS = 12;
const STATE_BYTES = 4 * STATE_FLOATS;
const RECORD_FLOATS = 8;
const SLOT = 256;
const FRAME_SLOT = 512;
const PLUTO_IDS = [999, 9];
const MAX_EXTERNAL = 4;

type Op =
  | { kind: 'copy'; from: GPUBuffer; to: 'W' | 'B' }
  | { kind: 'step'; on: 'W' | 'B'; m: number; d: number }
  | { kind: 'store'; from: 'W' | 'B'; m: number; buffer: GPUBuffer };

function dispatchSize(groups: number): [number, number] {
  const gx = Math.min(groups, 65535);
  return [gx, Math.ceil(groups / gx)];
}

/** Heliocentric ICRF state (km, km/s) of every core record at epochEt. */
function readStates(cat: SmallBodyCatalog): Float64Array {
  const n = cat.count;
  const out = new Float64Array(6 * n);
  const pos = cat.table.column('pos');
  const vel = cat.table.column('vel');
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      out[6 * i + k] = pos.get(i, k);
      out[6 * i + 3 + k] = vel.get(i, k);
    }
  }
  return out;
}

export class SmallBodyField {
  readonly pointSources: PointSourceBuffer;
  readonly count: number;
  readonly epochEt: number;
  readonly window: { startEt: number; endEt: number };
  readonly info: SmallBodyFieldInfo;
  readonly model: SmallBodyForceModel;
  readonly light: SmallBodyLight | null;

  private readonly device: GPUDevice;
  private readonly planets: PlanetPositions;
  private readonly cat: SmallBodyCatalog;
  private readonly order: Uint32Array;
  private readonly slot: Uint32Array;
  private readonly external: number[] = [];
  private readonly extFlag: Uint8Array;
  private readonly nongrav: Map<number, NonGrav>;
  private readonly table: PlanetTable;
  private readonly H: number;
  private readonly opts: Required<Omit<SmallBodyFieldOptions, 'useFma'>>;
  private readonly spacing: number;
  private readonly slots: number;

  private readonly fieldUB: GPUBuffer;
  private stepUB: GPUBuffer;
  private stepSlots = 0;
  private frameUB: GPUBuffer;
  private frameSlots = 0;
  private readonly tableBuf: GPUBuffer;
  private readonly infoBuf: GPUBuffer;
  private readonly ngBuf: GPUBuffer;
  private readonly photBuf: GPUBuffer;
  private readonly records: GPUBuffer;
  private readonly debugBuf: GPUBuffer;
  private readonly epochBuf: GPUBuffer;
  private readonly W: GPUBuffer;
  private B: GPUBuffer | null = null;
  private readonly stepPipe: GPUComputePipeline;
  private readonly shadePipe: GPUComputePipeline;
  private readonly pickPipe: GPUComputePipeline;
  private readonly stepLayout: GPUBindGroupLayout;
  private readonly shadeLayout: GPUBindGroupLayout;
  private stepBG: { W: GPUBindGroup; B: GPUBindGroup | null } | null = null;
  private shadeBG: GPUBindGroup | null = null;
  private readonly checkpoints = new Map<number, GPUBuffer>();
  private mW = 0;
  private mB = 0;
  private dB = 1;
  private builderDone = false;
  private retireB = false;
  /** Buffers to destroy once the commands of the update that last used them have run. */
  private pending: GPUBuffer[] = [];
  private readonly propagator: SmallBodyPropagator;
  private readonly stateCache = new Map<number, { m: number; st: Float64Array }>();
  private readonly pickU: [GPUBuffer, GPUBuffer];
  private readonly pickOut: GPUBuffer;
  private readonly pickRead: GPUBuffer;
  private pickBusy: Promise<unknown> = Promise.resolve();

  static async create(
    device: GPUDevice,
    tables: SmallBodyTables,
    planets: PlanetPositions,
    options: SmallBodyFieldOptions = {},
  ): Promise<SmallBodyField> {
    const st = await selfTest(device);
    const useFma = options.useFma ?? st.fmaExact;
    return new SmallBodyField(device, tables, planets, options, st, useFma);
  }

  private constructor(
    device: GPUDevice,
    tables: SmallBodyTables,
    planets: PlanetPositions,
    options: SmallBodyFieldOptions,
    st: SmallBodyFieldInfo['selfTest'],
    useFma: boolean,
  ) {
    this.device = device;
    this.planets = planets;
    const hdr = tables.coreHeader;
    this.model = hdr.forceModel;
    this.cat = readCore(hdr, tables.core);
    this.count = this.cat.count;
    this.epochEt = hdr.epochEt;
    this.window = { ...hdr.window };
    this.H = this.model.grid.baseStepS;
    this.opts = {
      checkpointBudgetBytes: options.checkpointBudgetBytes ?? 2 ** 30,
      minCheckpointSpacing: options.minCheckpointSpacing ?? 8,
      backgroundStepsPerUpdate: options.backgroundStepsPerUpdate ?? 2,
      chunkObjects: Math.max(WG, Math.floor((options.chunkObjects ?? this.count) / WG) * WG),
      debug: options.debug ?? false,
    };
    this.propagator = new SmallBodyPropagator(this.model, planets);
    this.nongrav = tables.nongrav && tables.nongravHeader ? readNonGrav(tables.nongravHeader, tables.nongrav) : new Map();

    // --- order objects by perihelion distance (unknown states last).
    const n = this.count;
    const states = readStates(this.cat);
    const mu = this.model.sun.gm;
    const q = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const o = 6 * i;
      const [x, y, z, vx, vy, vz] = [states[o], states[o + 1], states[o + 2], states[o + 3], states[o + 4], states[o + 5]];
      const r = Math.hypot(x, y, z);
      const hx = y * vz - z * vy, hy = z * vx - x * vz, hz = x * vy - y * vx;
      const h2 = hx * hx + hy * hy + hz * hz;
      const vv = vx * vx + vy * vy + vz * vz;
      const rv = x * vx + y * vy + z * vz;
      const k = vv - mu / r;
      const e = Math.hypot((k * x - rv * vx) / mu, (k * y - rv * vy) / mu, (k * z - rv * vz) / mu);
      q[i] = Number.isFinite(h2) && Number.isFinite(e) ? h2 / mu / (1 + e) : Infinity;
    }
    // Sort on float64 keys q[1000 km] * 2^21 + index (exact below 2^53; n < 2^21).
    if (n >= 2 ** 21) throw new Error('SmallBodyField: more than 2^21 objects');
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = Math.min(Math.floor(q[i] / 1000), 2 ** 31) * 2 ** 21 + i;
    keys.sort();
    this.order = new Uint32Array(n);
    for (let s = 0; s < n; s++) this.order[s] = keys[s] % 2 ** 21;
    this.slot = new Uint32Array(n);
    for (let s = 0; s < n; s++) this.slot[this.order[s]] = s;

    // --- per-slot propagation info and initial states.
    const extBit = Number(Object.entries(hdr.flagBits).find(([, v]) => v === 'planetaryEphemeris')?.[0] ?? 0);
    const flags = this.cat.table.column('flags');
    const ngIndex = new Map<number, number>();
    const ngList = [...this.nongrav.entries()];
    ngList.forEach(([row], k) => ngIndex.set(row, k));
    const info = new Uint32Array(n);
    const init = new Float32Array(n * STATE_FLOATS);
    this.extFlag = new Uint8Array(n);
    let invalid = 0;
    for (let s = 0; s < n; s++) {
      const i = this.order[s];
      const o = 6 * i;
      const ok = Number.isFinite(states[o]) && Number.isFinite(states[o + 3]);
      let w = 0;
      if (extBit && (flags.get(i) & extBit)) {
        this.extFlag[i] = 1;
        if (this.external.length < MAX_EXTERNAL) {
          w = 0x40000000 | (this.external.length << 24);
          this.external.push(i);
        } else w = 0x80000000;
      } else if (!ok) w = 0x80000000;
      const g = ngIndex.get(i);
      if (g !== undefined) w |= g + 1;
      info[s] = w >>> 0;
      if (w & 0x80000000) invalid++;
      const [x0, x1, x2, v0, v1, v2] = [0, 1, 2, 3, 4, 5].map((k) => split64(states[o + k]));
      init.set([x0[0], x1[0], x2[0], v0[0], v1[0], v2[0], x0[1], x1[1], x2[1], v0[1], v1[1], v2[1]], s * STATE_FLOATS);
    }
    const ng = new Float32Array(Math.max(1, ngList.length) * 12);
    ngList.forEach(([, p], k) => ng.set([p.a1, p.a2, p.a3, p.dt, p.aln, p.r0, p.nm, p.nn, p.nk, 0, 0, 0], 12 * k));

    // --- photometry
    this.light = tables.photometry
      ? new SmallBodyLight(tables.photometry, {
        core: tables.core, coreHeader: hdr, physical: tables.physical, physicalHeader: tables.physicalHeader,
        comets: tables.comets, cometsHeader: tables.cometsHeader,
      })
      : null;
    const phot = this.light ? this.light.pack(this.order) : (() => {
      const a = new Uint32Array(n * 8);
      for (let s = 0; s < n; s++) a[8 * s + 6] = this.order[s];
      return a;
    })();

    // --- planet table, checkpoints
    this.table = new PlanetTable(this.model, planets, this.epochEt, this.window);
    const totalSteps = this.table.count;
    const perState = n * STATE_BYTES;
    // Checkpoints (the epoch states included) plus the builder's buffer fit the budget.
    this.slots = Math.max(2, Math.floor(this.opts.checkpointBudgetBytes / perState) - 1);
    this.spacing = Math.max(this.opts.minCheckpointSpacing, Math.ceil(totalSteps / (this.slots - 1)));

    // --- GPU resources
    const d = device;
    const SU = GPUBufferUsage;
    const buf = (size: number, usage: number, label: string) => d.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage, label });
    this.fieldUB = buf(16, SU.UNIFORM | SU.COPY_DST, 'sb field');
    d.queue.writeBuffer(this.fieldUB, 0, new Uint32Array([n, 0, 0, 0]));
    this.stepUB = buf(SLOT * 16, SU.UNIFORM | SU.COPY_DST, 'sb step uniforms');
    this.stepSlots = 16;
    this.frameUB = buf(FRAME_SLOT * 4, SU.UNIFORM | SU.COPY_DST, 'sb frame uniforms');
    this.frameSlots = 4;
    this.tableBuf = buf(this.table.data.byteLength, SU.STORAGE | SU.COPY_DST, 'sb planet table');
    this.infoBuf = buf(info.byteLength, SU.STORAGE | SU.COPY_DST, 'sb info');
    d.queue.writeBuffer(this.infoBuf, 0, info);
    this.ngBuf = buf(ng.byteLength, SU.STORAGE | SU.COPY_DST, 'sb nongrav');
    d.queue.writeBuffer(this.ngBuf, 0, ng);
    this.photBuf = buf(phot.byteLength, SU.STORAGE | SU.COPY_DST, 'sb photometry');
    d.queue.writeBuffer(this.photBuf, 0, phot.buffer as ArrayBuffer, phot.byteOffset, phot.byteLength);
    this.records = buf(n * RECORD_FLOATS * 4, SU.STORAGE | SU.COPY_SRC | SU.COPY_DST, 'sb point sources');
    this.debugBuf = buf(this.opts.debug ? n * 64 : 64, SU.STORAGE | SU.COPY_SRC, 'sb debug states');
    const stateUsage = SU.STORAGE | SU.COPY_SRC | SU.COPY_DST;
    this.epochBuf = buf(perState, stateUsage, 'sb epoch states');
    d.queue.writeBuffer(this.epochBuf, 0, init);
    this.W = buf(perState, stateUsage, 'sb working states');
    d.queue.writeBuffer(this.W, 0, init);
    this.checkpoints.set(0, this.epochBuf);
    this.pointSources = { buffer: this.records, count: n, strideFloats: RECORD_FLOATS };

    const cfg: KernelConfig = { model: this.model, samples: SAMPLES, cKmS: C_KM_S, auKm: AU_KM, photometry: tables.photometry ?? null };
    const ro = { type: 'read-only-storage' as const };
    const C = GPUShaderStage.COMPUTE;
    this.stepLayout = d.createBindGroupLayout({
      label: 'sb step', entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, buffer: ro },
        { binding: 4, visibility: C, buffer: ro },
        { binding: 5, visibility: C, buffer: ro },
      ],
    });
    this.shadeLayout = d.createBindGroupLayout({
      label: 'sb shade', entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 288 } },
        { binding: 2, visibility: C, buffer: ro },
        { binding: 3, visibility: C, buffer: ro },
        { binding: 4, visibility: C, buffer: ro },
        { binding: 5, visibility: C, buffer: ro },
        { binding: 6, visibility: C, buffer: ro },
        { binding: 7, visibility: C, buffer: { type: 'storage' } },
        { binding: 8, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const constants = { USE_FMA: useFma ? 1 : 0 };
    this.stepPipe = d.createComputePipeline({
      label: 'sb step', layout: d.createPipelineLayout({ bindGroupLayouts: [this.stepLayout] }),
      compute: { module: d.createShaderModule({ label: 'sb step', code: stepShader(cfg) }), entryPoint: 'main', constants },
    });
    this.shadePipe = d.createComputePipeline({
      label: 'sb shade', layout: d.createPipelineLayout({ bindGroupLayouts: [this.shadeLayout] }),
      compute: { module: d.createShaderModule({ label: 'sb shade', code: shadeShader(cfg) }), entryPoint: 'main', constants },
    });
    this.pickPipe = d.createComputePipeline({
      label: 'sb pick', layout: 'auto', compute: { module: d.createShaderModule({ label: 'sb pick', code: PICK_SHADER }), entryPoint: 'main' },
    });
    this.pickU = [buf(32, SU.UNIFORM | SU.COPY_DST, 'sb pick 0'), buf(32, SU.UNIFORM | SU.COPY_DST, 'sb pick 1')];
    this.pickOut = buf(16, SU.STORAGE | SU.COPY_SRC | SU.COPY_DST, 'sb pick out');
    this.pickRead = buf(16, SU.MAP_READ | SU.COPY_DST, 'sb pick readback');

    const precision = st.fmaExact && useFma ? 'df64-fma' : st.dekkerExact && !useFma ? 'df64-dekker' : 'degraded';
    this.info = {
      precision, selfTest: st, objects: n, invalid, external: this.external.length, photometry: !!this.light,
      checkpointSpacingSteps: this.spacing, checkpointSlots: this.slots, checkpoints: 1,
      last: { et: NaN, targetStep: 0, steps: 0, backgroundSteps: 0, restoredFrom: null, tableIntervalsBuilt: 0, displayStepS: 0, cpuMs: 0, hidden: null },
    };
    if (precision === 'degraded') console.warn('[SmallBodyField] double-single arithmetic is not exact on this device: positions may be off by tens to hundreds of km');
  }

  /** GPU slot of core record `index` (objects are stored in perihelion-distance order). */
  slotOf(index: number): number {
    return this.slot[index];
  }

  /**
   * Propagate every object to et, then write the point-source records (camera-relative apparent direction and
   * illuminance at the eye) for `cameraSSB` (km, ICRF, SSB). Brightness is gated by `allowed.brightness`.
   * The work is encoded into `encoder`; submit it before the next update().
   */
  update(encoder: GPUCommandEncoder, et: number, cameraSSB: Vec3, allowed: { brightness: ExistsLevel }): void {
    const t0 = performance.now();
    if (this.pending.length) {
      // The previous update's encoder has been submitted by now (see the method comment).
      const p = this.pending.splice(0);
      this.device.queue.onSubmittedWorkDone().then(() => p.forEach((b) => b.destroy()), () => undefined);
    }
    const last = this.info.last;
    last.et = et;
    last.steps = 0;
    last.backgroundSteps = 0;
    last.restoredFrom = null;
    last.tableIntervalsBuilt = 0;
    last.hidden = null;
    const E0 = this.epochEt;
    const H = this.H;
    const sunId = this.model.sun.naifId;
    const sun = this.planets.positionSSB(sunId, et);
    const x = (et - E0) / H;
    const mStar = x >= 0 ? Math.floor(x) : Math.ceil(x);
    const kDisp = et >= E0 ? mStar : mStar - 1;
    const ivDisp = this.table.index(kDisp);
    let hide: string | null = null;
    if (et < this.window.startEt || et > this.window.endEt) hide = 'outside the small-body window';
    else if (!sun) hide = 'no ephemeris for the Sun';
    else if (ivDisp < 0 || !this.ensureInterval(ivDisp)) hide = 'no planetary ephemeris for the display step';

    const ops: Op[] = [];
    if (!hide) {
      const plan = this.plan(mStar, ops);
      if (plan !== null) hide = plan;
    }
    if (!hide) this.planBackground(ops);
    const steps = ops.filter((o) => o.kind === 'step') as Extract<Op, { kind: 'step' }>[];
    const chunks = Math.ceil(this.count / this.opts.chunkObjects);
    this.ensureStepSlots(steps.length * chunks);
    this.ensureFrameSlots(chunks);

    // Step uniforms.
    if (steps.length) {
      const u = new ArrayBuffer(steps.length * chunks * SLOT);
      const f = new Float32Array(u);
      const w = new Uint32Array(u);
      steps.forEach((s, j) => {
        const k = s.d > 0 ? s.m : s.m - 1;
        const [a, b] = split64(s.m * H);
        const [c, e] = split64(s.d * H);
        const [g, h] = split64(k * H);
        for (let ch = 0; ch < chunks; ch++) {
          const first = ch * this.opts.chunkObjects;
          const cnt = Math.min(this.opts.chunkObjects, this.count - first);
          const [gx] = dispatchSize(Math.ceil(cnt / WG));
          const o = ((j * chunks + ch) * SLOT) / 4;
          f[o] = a; f[o + 1] = b; f[o + 2] = c; f[o + 3] = e; f[o + 4] = g; f[o + 5] = h;
          w[o + 6] = this.table.index(k); w[o + 7] = first; w[o + 8] = cnt; w[o + 9] = gx;
        }
      });
      this.device.queue.writeBuffer(this.stepUB, 0, u);
    }

    // Frame uniform (display step, camera, overrides).
    {
      const u = new ArrayBuffer(chunks * FRAME_SLOT);
      const f = new Float32Array(u);
      const w = new Uint32Array(u);
      let flags = this.opts.debug ? 1 : 0;
      if (hide) flags |= 2;
      const sunP = sun ?? [0, 0, 0];
      const sa = this.planets.positionSSB(sunId, et - 1), sb = this.planets.positionSSB(sunId, et + 1);
      const sunV = sa && sb ? [(sb[0] - sa[0]) / 2, (sb[1] - sa[1]) / 2, (sb[2] - sa[2]) / 2] : [0, 0, 0];
      const cam = [0, 1, 2].map((k) => split64(cameraSSB[k] - sunP[k]));
      const hDisp = et - (E0 + mStar * H);
      last.displayStepS = hDisp;
      last.targetStep = mStar;
      const [t0h, t0l] = split64(mStar * H);
      const [hh, hl] = split64(hDisp);
      const [tkh, tkl] = split64(kDisp * H);
      const ov = this.externalStates(et, sunP);
      for (let ch = 0; ch < chunks; ch++) {
        const o = (ch * FRAME_SLOT) / 4;
        const first = ch * this.opts.chunkObjects;
        const cnt = Math.min(this.opts.chunkObjects, this.count - first);
        const [gx] = dispatchSize(Math.ceil(cnt / WG));
        f.set([cam[0][0], cam[1][0], cam[2][0], 0, cam[0][1], cam[1][1], cam[2][1], 0, sunV[0], sunV[1], sunV[2], 0], o);
        f.set([t0h, t0l, hh, hl, tkh, tkl], o + 12);
        w[o + 18] = Math.max(0, ivDisp);
        w[o + 19] = LEVEL_CODE[allowed.brightness] ?? 1;
        w[o + 20] = flags;
        w[o + 21] = first;
        w[o + 22] = cnt;
        w[o + 23] = gx;
        for (let k = 0; k < ov.length; k++) {
          const s = ov[k];
          if (!s) continue;
          const sp = s.map((v) => split64(v));
          f.set([sp[0][0], sp[1][0], sp[2][0], 1], o + 24 + 4 * k);
          f.set([sp[0][1], sp[1][1], sp[2][1], 0], o + 40 + 4 * k);
          f.set([s[3], s[4], s[5], 0], o + 56 + 4 * k);
        }
      }
      this.device.queue.writeBuffer(this.frameUB, 0, u);
    }

    // Encode.
    const bg = this.stepBindGroups();
    let pass: GPUComputePassEncoder | null = null;
    let j = 0;
    for (const op of ops) {
      if (op.kind === 'step') {
        if (!pass) { pass = encoder.beginComputePass({ label: 'sb steps' }); pass.setPipeline(this.stepPipe); }
        const group = op.on === 'W' ? bg.W : bg.B!;
        for (let ch = 0; ch < chunks; ch++) {
          const first = ch * this.opts.chunkObjects;
          const cnt = Math.min(this.opts.chunkObjects, this.count - first);
          pass.setBindGroup(0, group, [(j * chunks + ch) * SLOT]);
          pass.dispatchWorkgroups(...dispatchSize(Math.ceil(cnt / WG)));
        }
        j++;
        if (op.on === 'W') last.steps++; else last.backgroundSteps++;
      } else {
        if (pass) { pass.end(); pass = null; }
        if (op.kind === 'copy') encoder.copyBufferToBuffer(op.from, 0, op.to === 'W' ? this.W : this.B!, 0, this.count * STATE_BYTES);
        else encoder.copyBufferToBuffer(op.from === 'W' ? this.W : this.B!, 0, op.buffer, 0, this.count * STATE_BYTES);
      }
    }
    if (!pass) pass = encoder.beginComputePass({ label: 'sb shade' });
    pass.setPipeline(this.shadePipe);
    const sg = this.shadeBindGroup();
    for (let ch = 0; ch < chunks; ch++) {
      const first = ch * this.opts.chunkObjects;
      const cnt = Math.min(this.opts.chunkObjects, this.count - first);
      pass.setBindGroup(0, sg, [ch * FRAME_SLOT]);
      pass.dispatchWorkgroups(...dispatchSize(Math.ceil(cnt / WG)));
    }
    pass.end();
    if (this.retireB && this.B) {
      this.pending.push(this.B);
      this.B = null;
      this.stepBG = null;
      this.retireB = false;
    }
    last.hidden = hide;
    this.info.checkpoints = this.checkpoints.size;
    last.cpuMs = performance.now() - t0;
  }

  /** Plan W -> m*: returns null, or why it cannot be reached. */
  private plan(mStar: number, ops: Op[]): string | null {
    const usable = (m: number) => m === 0 || (Math.sign(m) === Math.sign(mStar) && Math.abs(m) <= Math.abs(mStar));
    let best: { m: number; src: 'W' | 'B' | GPUBuffer } = { m: 0, src: this.epochBuf };
    const consider = (m: number, src: 'W' | 'B' | GPUBuffer) => {
      if (usable(m) && (Math.abs(m) > Math.abs(best.m) || (Math.abs(m) === Math.abs(best.m) && src === 'W'))) best = { m, src };
    };
    for (const [m, b] of this.checkpoints) consider(m, b);
    if (this.B && !this.builderDone) consider(this.mB, 'B');
    consider(this.mW, 'W');
    const d = Math.sign(mStar - best.m);
    // Every interval on the way must be covered by the ephemeris.
    for (let m = best.m; m !== mStar; m += d) {
      const iv = this.table.index(d > 0 ? m : m - 1);
      if (iv < 0 || !this.ensureInterval(iv)) return 'no planetary ephemeris on the way to et';
    }
    if (best.src !== 'W') {
      ops.push({ kind: 'copy', from: best.src === 'B' ? this.B! : best.src, to: 'W' });
      this.info.last.restoredFrom = best.m;
    }
    for (let m = best.m; m !== mStar; m += d) {
      ops.push({ kind: 'step', on: 'W', m, d });
      this.storeIfCheckpoint(m + d, 'W', ops);
    }
    this.mW = mStar;
    return null;
  }

  private planBackground(ops: Op[]): void {
    const budget = this.opts.backgroundStepsPerUpdate - ops.filter((o) => o.kind === 'step').length;
    if (budget <= 0 || this.builderDone) return;
    for (let k = 0; k < budget; k++) {
      if (!this.B) {
        this.B = this.device.createBuffer({ size: this.count * STATE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'sb builder states' });
        this.stepBG = null;
        ops.push({ kind: 'copy', from: this.epochBuf, to: 'B' });
        this.mB = 0;
      }
      const iv = this.table.index(this.dB > 0 ? this.mB : this.mB - 1);
      const stop = iv < 0 || !this.ensureInterval(iv) || this.checkpoints.size >= this.slots;
      if (stop) {
        if (this.dB > 0) {
          this.dB = -1;
          this.mB = 0;
          ops.push({ kind: 'copy', from: this.epochBuf, to: 'B' });
          continue;
        }
        this.builderDone = true;
        this.retireB = true;
        return;
      }
      ops.push({ kind: 'step', on: 'B', m: this.mB, d: this.dB });
      this.mB += this.dB;
      this.storeIfCheckpoint(this.mB, 'B', ops);
    }
  }

  private storeIfCheckpoint(m: number, from: 'W' | 'B', ops: Op[]): void {
    if (m % this.spacing !== 0 || this.checkpoints.has(m) || this.checkpoints.size >= this.slots) return;
    const buffer = this.device.createBuffer({ size: this.count * STATE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: `sb checkpoint ${m}` });
    this.checkpoints.set(m, buffer);
    ops.push({ kind: 'store', from, m, buffer });
  }

  private ensureInterval(iv: number): boolean {
    if (this.table.isBuilt(iv)) return this.table.fill(iv);
    const ok = this.table.fill(iv);
    if (ok) {
      const s = this.table.stride;
      this.device.queue.writeBuffer(this.tableBuf, iv * s * 4, this.table.data.buffer as ArrayBuffer, iv * s * 4, s * 4);
      this.info.last.tableIntervalsBuilt++;
    }
    return ok;
  }

  private ensureStepSlots(k: number): void {
    if (k <= this.stepSlots) return;
    let s = this.stepSlots;
    while (s < k) s *= 2;
    this.stepUB.destroy();
    this.stepUB = this.device.createBuffer({ size: s * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'sb step uniforms' });
    this.stepSlots = s;
    this.stepBG = null;
  }

  private ensureFrameSlots(k: number): void {
    if (k <= this.frameSlots) return;
    this.frameUB.destroy();
    this.frameUB = this.device.createBuffer({ size: k * FRAME_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'sb frame uniforms' });
    this.frameSlots = k;
    this.shadeBG = null;
  }

  private stepBindGroups(): { W: GPUBindGroup; B: GPUBindGroup | null } {
    if (this.stepBG && (this.stepBG.B || !this.B)) return this.stepBG;
    const mk = (s: GPUBuffer) => this.device.createBindGroup({
      layout: this.stepLayout, entries: [
        { binding: 0, resource: { buffer: this.fieldUB } },
        { binding: 1, resource: { buffer: this.stepUB, size: 48 } },
        { binding: 2, resource: { buffer: s } },
        { binding: 3, resource: { buffer: this.tableBuf } },
        { binding: 4, resource: { buffer: this.infoBuf } },
        { binding: 5, resource: { buffer: this.ngBuf } },
      ],
    });
    this.stepBG = { W: mk(this.W), B: this.B ? mk(this.B) : null };
    return this.stepBG;
  }

  private shadeBindGroup(): GPUBindGroup {
    if (this.shadeBG) return this.shadeBG;
    this.shadeBG = this.device.createBindGroup({
      layout: this.shadeLayout, entries: [
        { binding: 0, resource: { buffer: this.fieldUB } },
        { binding: 1, resource: { buffer: this.frameUB, size: 288 } },
        { binding: 2, resource: { buffer: this.W } },
        { binding: 3, resource: { buffer: this.tableBuf } },
        { binding: 4, resource: { buffer: this.infoBuf } },
        { binding: 5, resource: { buffer: this.ngBuf } },
        { binding: 6, resource: { buffer: this.photBuf } },
        { binding: 7, resource: { buffer: this.records } },
        { binding: 8, resource: { buffer: this.debugBuf } },
      ],
    });
    return this.shadeBG;
  }

  /** Heliocentric states (x, v) at et of the objects drawn from the planetary ephemeris, or null per object. */
  private externalStates(et: number, sun: readonly number[]): (number[] | null)[] {
    return this.external.map(() => {
      for (const id of PLUTO_IDS) {
        const p = this.planets.positionSSB(id, et);
        const a = this.planets.positionSSB(id, et - 60), b = this.planets.positionSSB(id, et + 60);
        const sa = this.planets.positionSSB(this.model.sun.naifId, et - 60), sb = this.planets.positionSSB(this.model.sun.naifId, et + 60);
        if (p && a && b && sa && sb) {
          return [p[0] - sun[0], p[1] - sun[1], p[2] - sun[2],
            (b[0] - sb[0] - a[0] + sa[0]) / 120, (b[1] - sb[1] - a[1] + sa[1]) / 120, (b[2] - sb[2] - a[2] + sa[2]) / 120];
        }
      }
      return null;
    });
  }

  /**
   * Object under a direction: among records within toleranceRad of dirICRF, the brightest (apparent Y) one if any is
   * lit, else the nearest in angle (lit or not, e.g. hidden at this reality level). Core index, or null. Reads the
   * records of the last submitted update().
   */
  async pick(dirICRF: Vec3, toleranceRad: number): Promise<number | null> {
    const run = async (): Promise<number | null> => {
      const d = this.device;
      const l = Math.hypot(dirICRF[0], dirICRF[1], dirICRF[2]);
      const groups = Math.ceil(this.count / 256);
      const [gx, gy] = dispatchSize(groups);
      for (let p = 0; p < 2; p++) {
        const u = new ArrayBuffer(32);
        new Float32Array(u, 0, 4).set([dirICRF[0] / l, dirICRF[1] / l, dirICRF[2] / l, (2 * Math.sin(Math.min(toleranceRad, Math.PI) / 2)) ** 2]);
        new Uint32Array(u, 16, 4).set([this.count, gx, p, 0]);
        d.queue.writeBuffer(this.pickU[p], 0, u);
      }
      d.queue.writeBuffer(this.pickOut, 0, new Uint32Array([0, 0xffffffff, 0xffffffff, 0xffffffff]));
      const enc = d.createCommandEncoder({ label: 'sb pick' });
      for (let p = 0; p < 2; p++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pickPipe);
        pass.setBindGroup(0, d.createBindGroup({
          layout: this.pickPipe.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: this.pickU[p] } },
            { binding: 1, resource: { buffer: this.records } },
            { binding: 2, resource: { buffer: this.pickOut } },
          ],
        }));
        pass.dispatchWorkgroups(gx, gy);
        pass.end();
      }
      enc.copyBufferToBuffer(this.pickOut, 0, this.pickRead, 0, 16);
      d.queue.submit([enc.finish()]);
      await this.pickRead.mapAsync(GPUMapMode.READ);
      const o = new Uint32Array(this.pickRead.getMappedRange().slice(0));
      this.pickRead.unmap();
      if (o[0] > 0 && o[2] !== 0xffffffff) return o[2];
      return o[3] !== 0xffffffff ? o[3] : null;
    };
    const p = this.pickBusy.then(run, run);
    this.pickBusy = p.catch(() => undefined);
    return p;
  }

  /**
   * Geometric SSB state (km, km/s, ICRF) of core record `index` at et from the float64 reference propagator (the
   * same scheme; exact for close-ups and the inspector), or null (unknown position, lost, outside the ephemeris).
   */
  stateOf(index: number, et: number): { pos: Vec3; vel: Vec3 } | null {
    if (!(index >= 0 && index < this.count)) return null;
    const sunId = this.model.sun.naifId;
    const sun = this.planets.positionSSB(sunId, et);
    const sa = this.planets.positionSSB(sunId, et - 1), sb = this.planets.positionSSB(sunId, et + 1);
    if (!sun || !sa || !sb) return null;
    const sv = [(sb[0] - sa[0]) / 2, (sb[1] - sa[1]) / 2, (sb[2] - sa[2]) / 2];
    if (this.extFlag[index]) {
      for (const id of PLUTO_IDS) {
        const p = this.planets.positionSSB(id, et), a = this.planets.positionSSB(id, et - 60), b = this.planets.positionSSB(id, et + 60);
        if (p && a && b) return { pos: [p[0], p[1], p[2]], vel: [(b[0] - a[0]) / 120, (b[1] - a[1]) / 120, (b[2] - a[2]) / 120] };
      }
      return null;
    }
    const s0 = coreState(this.cat, index);
    if (!s0) return null;
    const E0 = this.epochEt;
    const x = (et - E0) / this.H;
    const mStar = x >= 0 ? Math.floor(x) : Math.ceil(x);
    const ng = this.nongrav.get(index) ?? null;
    let from = { m: 0, st: s0 };
    const c = this.stateCache.get(index);
    if (c && (c.m === 0 || (Math.sign(c.m) === Math.sign(mStar) && Math.abs(c.m) <= Math.abs(mStar)))) from = { m: c.m, st: c.st.slice() };
    const st = from.st;
    if (from.m !== mStar && this.propagator.propagateOne(st, 0, E0 + from.m * this.H, E0 + mStar * this.H, E0, ng) !== SB_OK) return null;
    this.stateCache.set(index, { m: mStar, st: st.slice() });
    if (this.stateCache.size > 16) this.stateCache.delete(this.stateCache.keys().next().value as number);
    if (et !== E0 + mStar * this.H && this.propagator.propagateOne(st, 0, E0 + mStar * this.H, et, E0, ng) !== SB_OK) return null;
    return {
      pos: [st[0] + sun[0], st[1] + sun[1], st[2] + sun[2]],
      vel: [st[3] + sv[0], st[4] + sv[1], st[5] + sv[2]],
    };
  }

  /** Test hook (options.debug): heliocentric double-single states at the last update's et, per core index. */
  async readDebugStates(indices: readonly number[]): Promise<Float64Array> {
    if (!this.opts.debug) throw new Error('SmallBodyField: create with { debug: true } to read states');
    const f = await this.readBuffer(this.debugBuf, this.count * 64);
    const a = new Float32Array(f);
    const out = new Float64Array(6 * indices.length);
    indices.forEach((i, k) => {
      const o = 16 * this.slot[i];
      for (let c = 0; c < 3; c++) {
        out[6 * k + c] = a[o + c] + a[o + 4 + c];
        out[6 * k + 3 + c] = a[o + 8 + c] + a[o + 12 + c];
      }
    });
    return out;
  }

  /** Test hook: the point-source records (count * 8 floats), in GPU slot order. */
  async readRecords(): Promise<Float32Array> {
    return new Float32Array(await this.readBuffer(this.records, this.count * RECORD_FLOATS * 4));
  }

  private async readBuffer(src: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const rb = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, rb, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = rb.getMappedRange().slice(0);
    rb.destroy();
    return out;
  }

  destroy(): void {
    for (const b of this.checkpoints.values()) b.destroy();
    for (const b of [this.W, this.B, this.records, this.debugBuf, this.tableBuf, this.infoBuf, this.ngBuf, this.photBuf, this.stepUB, this.frameUB, this.fieldUB, this.pickOut, this.pickRead, ...this.pickU]) b?.destroy();
    this.checkpoints.clear();
  }
}

// ------------------------------------------------------------------------------------------------ device self-test
/**
 * Runs the double-single primitives on the device for random operands and compares them with float64: two_prod and
 * two_sum must be exact (their error terms are the exact rounding errors), dd_mul/add/div/sqrt within 2^-44.
 */
async function selfTest(device: GPUDevice): Promise<SmallBodyFieldInfo['selfTest']> {
  const n = 4096;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const inp = new Float32Array(4 * n);
  const val = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 2; k++) {
      const x = (rnd() < 0.5 ? -1 : 1) * 10 ** (-3 + 14 * rnd()) * (1 + rnd());
      const [hi, lo] = split64(x);
      inp[4 * i + 2 * k] = hi;
      inp[4 * i + 2 * k + 1] = lo;
      val[2 * i + k] = hi + lo;
    }
  }
  const run = async (fma: boolean): Promise<Float32Array> => {
    const mod = device.createShaderModule({ code: SELFTEST_SHADER });
    const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main', constants: { USE_FMA: fma ? 1 : 0 } } });
    const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(u, 0, new Uint32Array([n, 0, 0, 0]));
    const ib = device.createBuffer({ size: inp.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ib, 0, inp);
    const ob = device.createBuffer({ size: n * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rb = device.createBuffer({ size: n * 48, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: u } }, { binding: 1, resource: { buffer: ib } }, { binding: 2, resource: { buffer: ob } },
    ] }));
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    enc.copyBufferToBuffer(ob, 0, rb, 0, n * 48);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    for (const b of [u, ib, ob, rb]) b.destroy();
    return out;
  };
  const check = (o: Float32Array): { exact: boolean; maxRel: number } => {
    let exact = true;
    let maxRel = 0;
    for (let i = 0; i < n; i++) {
      const ah = inp[4 * i], bh = inp[4 * i + 2];
      const a = val[2 * i], b = val[2 * i + 1];
      const p = ah * bh; // exact in float64 (24 + 24 bits)
      const s = ah + bh;
      const r = 12 * i;
      if (o[r] !== Math.fround(p) || o[r] + o[r + 1] !== p) exact = false;
      if (o[r + 2] !== Math.fround(s) || o[r + 2] + o[r + 3] !== s) exact = false;
      const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want);
      maxRel = Math.max(maxRel, rel(o[r + 4] + o[r + 5], a * b), rel(o[r + 8] + o[r + 9], a / b), rel(o[r + 10] + o[r + 11], Math.sqrt(Math.abs(a))));
      const sum = a + b;
      if (Math.abs(sum) > 1e-6 * Math.max(Math.abs(a), Math.abs(b))) maxRel = Math.max(maxRel, rel(o[r + 6] + o[r + 7], sum));
    }
    return { exact, maxRel };
  };
  const dek = check(await run(false));
  let fma = { exact: false, maxRel: Infinity };
  try {
    fma = check(await run(true));
  } catch {
    // fma unsupported: Dekker only
  }
  const maxRelError = fma.exact ? fma.maxRel : dek.maxRel;
  return { fmaExact: fma.exact && fma.maxRel < 2 ** -43, dekkerExact: dek.exact && dek.maxRel < 2 ** -43, maxRelError, cases: n };
}
