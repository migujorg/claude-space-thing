// Shape models for the scene (docs/rendering-shapes.md): which mesh, if any, replaces a body's ellipsoid at the
// current reality level, and the rotation that places it. Headers (shapes/<id>.json) and the DAMIT table are
// fetched on first need; until they arrive the body stays an ellipsoid.
//
// A mesh is drawn only when its shape label and its orientation label are admitted at the level and a rotation
// can be evaluated. Otherwise the body keeps its ellipsoid (or point) and `status(id)` says why (inspector).
//
// Rotation sources, in order (core/shapeRotation.ts):
//   1. the shape frame's own PCK constants (header orientation.sourceRotation: mission kernels, e.g. Phobos's
//      pck00010 frame, Eros's eros_alex.tpc, Lutetia's Lauriacum frame);
//   2. the app's orientation of the body, when the shape is in the body's IAU frame (moons);
//   3. pck00011 constants in the header (appRotation) or the PDS label's rotation (labelRotation), for small bodies
//      the app has no rotation for;
//   4. a radar spin state (principal-axis rotators only; phase convention assumed → orientation estimated);
//   5. a DAMIT spin state (lightcurve inversion → derived).

import type { BinaryTableHeader, DamitIndexHeader, Label, ShapeIndex, ShapeModelHeader } from '../data/schema';
import { BinaryTable } from '../data/binaryTable';
import type { Mat3, SceneBody, SceneShape, SceneShapeLod } from '../render/scene';
import { bodyToIcrf } from '../core/rotation';
import {
  bodyToIcrfFromConstants, damitBodyToIcrf, iauFromSimple, isPckConstants, radarBodyToIcrf, type DamitSpin, type RadarSpin,
} from '../core/shapeRotation';
import { labelAllowed, worstOf, type ExistsLevel } from './reality';

export interface ShapeStatus {
  /** A mesh replaces the ellipsoid this frame. */
  drawn: boolean;
  /** What was found, or why nothing is drawn. */
  text: string;
  label?: Label;
  orientationLabel?: Label;
  sources?: string[];
}

/** One DAMIT model (the preferred row of an asteroid in shapes/damit-index). */
export interface DamitModel extends DamitSpin {
  modelId: number;
  dataOffset: number;
  vertexCount: number;
  triangleCount: number;
  scale: number;
  equivalentRadius: number;
  closed: boolean;
}

type Loaded<T> = T | 'loading' | 'failed';

export interface ShapeLibraryOptions {
  /** Data root URL with trailing slash (e.g. 'data/'): product paths are relative to it. */
  dataRoot: string;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchBuffer?: (url: string) => Promise<ArrayBuffer>;
  /** UTC calendar → ET (for radar zero epochs); without it radar spin states are not used. */
  utcToEt?: (unixMs: number) => number;
  /** SBDB SPK-ID of an app body id (small bodies: negative ids); null while unknown (the caller asks for it). */
  spkidOf?: (id: number) => number | null;
}

const defaultJson = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const defaultBuffer = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.arrayBuffer();
};

export class ShapeLibrary {
  private readonly headers = new Map<string, Loaded<ShapeModelHeader>>();
  private damit: Loaded<{ header: DamitIndexHeader; byKey: Map<number, DamitModel> }> | null = null;
  private readonly statuses = new Map<number, ShapeStatus>();
  private pending = 0;
  private waiters: (() => void)[] = [];
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly fetchBuffer: (url: string) => Promise<ArrayBuffer>;
  readonly problems: string[] = [];

  constructor(readonly index: ShapeIndex | null, private readonly o: ShapeLibraryOptions) {
    this.fetchJson = o.fetchJson ?? defaultJson;
    this.fetchBuffer = o.fetchBuffer ?? defaultBuffer;
  }

  /** Why a body is or is not drawn from a shape model (last evaluation), or null if it has none. */
  status(id: number): ShapeStatus | null {
    return this.statuses.get(id) ?? null;
  }

  idle(): boolean {
    return this.pending === 0;
  }

  whenIdle(): Promise<void> {
    return this.pending === 0 ? Promise.resolve() : new Promise((res) => this.waiters.push(res));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending++;
    return p.finally(() => {
      this.pending--;
      if (this.pending === 0) this.waiters.splice(0).forEach((f) => f());
    });
  }

  /** The header for an index key, or null (loading, failed or none). */
  private header(key: string): ShapeModelHeader | null {
    const h = this.headers.get(key);
    if (h === undefined) {
      const entry = this.index?.bodies[key];
      if (!entry) return null;
      this.headers.set(key, 'loading');
      void this.track(this.fetchJson(this.o.dataRoot + entry.file).then(
        (j) => { this.headers.set(key, j as ShapeModelHeader); },
        (e: Error) => { this.headers.set(key, 'failed'); this.problems.push(`${entry.file}: ${e.message}`); },
      ));
      return null;
    }
    return typeof h === 'string' ? null : h;
  }

  private damitModel(spkid: number): DamitModel | null | 'loading' {
    if (!this.index?.damit) return null;
    if (this.damit === null) {
      this.damit = 'loading';
      const hp = this.o.dataRoot + this.index.damit.file;
      this.track(
        this.fetchJson(hp).then(async (h) => {
          const header = h as DamitIndexHeader;
          const bin = header.bin.includes('/') ? header.bin : `shapes/${header.bin}`;
          const table = new BinaryTable(header as BinaryTableHeader, await this.fetchBuffer(this.o.dataRoot + bin));
          const byKey = new Map<number, DamitModel>();
          const col = (n: string) => table.column(n);
          const c = Object.fromEntries(['spkid', 'preferred', 'damitModelId', 'dataOffset', 'vertexCount', 'triangleCount', 'scale', 'equivalentRadius',
            'closed', 'lambdaDeg', 'betaDeg', 'periodHours', 'jd0', 'phi0Deg', 'yorpRadPerDay2'].map((n) => [n, col(n)]));
          for (let i = 0; i < table.count; i++) {
            if (c.preferred.get(i) !== 1) continue;
            byKey.set(c.spkid.get(i), {
              modelId: c.damitModelId.get(i), dataOffset: c.dataOffset.get(i), vertexCount: c.vertexCount.get(i), triangleCount: c.triangleCount.get(i),
              scale: c.scale.get(i), equivalentRadius: c.equivalentRadius.get(i), closed: c.closed.get(i) === 1,
              lambdaDeg: c.lambdaDeg.get(i), betaDeg: c.betaDeg.get(i), periodHours: c.periodHours.get(i), jd0: c.jd0.get(i),
              phi0Deg: c.phi0Deg.get(i), yorpRadPerDay2: c.yorpRadPerDay2.get(i) || 0,
            });
          }
          this.damit = { header, byKey };
        }),
      ).catch((e: Error) => { this.damit = 'failed'; this.problems.push(`DAMIT table: ${e.message}`); });
      return 'loading';
    }
    if (this.damit === 'loading') return 'loading';
    if (this.damit === 'failed') return null;
    return this.damit.byKey.get(spkid) ?? null;
  }

  /**
   * Whether a small body (negative id) or a major body has a shape model whose shape and orientation labels are
   * admitted at the level (fetching what is needed; 'loading' meanwhile). Placement is checked by sceneShape.
   */
  available(id: number, level: ExistsLevel): boolean | 'loading' {
    if (!this.index) return false;
    const key = id < 0 ? this.o.spkidOf?.(id) ?? null : id;
    if (key === null) return 'loading';
    if (this.index.bodies[String(key)]) {
      const h = this.header(String(key));
      if (!h) return this.headers.get(String(key)) === 'failed' ? false : 'loading';
      const o = h.orientation;
      const oLabel: Label = o.label === 'unknown' ? 'unknown' : o.spinState && !isPckConstants(o.sourceRotation) ? worstOf([o.label, 'estimated']) : o.label;
      if (labelAllowed(h.provenance.label, level) && oLabel !== 'unknown' && labelAllowed(oLabel, level)) return true;
    }
    if (id >= 0) return false;
    const d = this.damitModel(key);
    if (d === 'loading') return 'loading';
    return d !== null && labelAllowed('derived', level);
  }

  /**
   * The mesh for a scene body at this level and emission epoch, or null (the body keeps its ellipsoid). `sb` must
   * carry the admitted radii (the photometric size) and, for major bodies, the app's orientation.
   */
  sceneShape(sb: SceneBody, level: ExistsLevel, emitEt: number): SceneShape | null {
    const id = sb.id;
    const set = (s: ShapeStatus): null => { this.statuses.set(id, s); return null; };
    if (!this.index) return null;
    let key: number | null = id;
    if (id < 0) {
      key = this.o.spkidOf?.(id) ?? null;
      if (key === null) return set({ drawn: false, text: 'shape model: waiting for the SBDB id of this object' });
    }
    const h = this.index.bodies[String(key)] ? this.header(String(key)) : null;
    const inIndex = !!this.index.bodies[String(key)];
    if (inIndex && !h) {
      const st = this.headers.get(String(key));
      return set({ drawn: false, text: st === 'failed' ? 'shape model could not be loaded' : 'shape model loading' });
    }
    let why: ShapeStatus | null = null;
    if (h) {
      const r = this.fromHeader(h, sb, level, emitEt);
      if ('shape' in r) {
        this.statuses.set(id, r.status);
        return r.shape;
      }
      why = r.status;
    }
    // DAMIT convex model (small bodies), also when a radar/spacecraft model cannot be placed.
    if (id < 0 && key !== null) {
      const d = this.damitModel(key);
      if (d === 'loading') return set({ drawn: false, text: `${why ? why.text + '; ' : ''}DAMIT table loading` });
      if (d) {
        const r = this.fromDamit(d, key, sb, level, emitEt);
        if ('shape' in r) {
          this.statuses.set(id, why ? { ...r.status, text: `${r.status.text} (${why.text})` } : r.status);
          return r.shape;
        }
        why = why ? { ...r.status, text: `${why.text}; ${r.status.text}` } : r.status;
      }
    }
    if (why) set(why);
    else this.statuses.delete(id);
    return null;
  }

  private fromHeader(h: ShapeModelHeader, sb: SceneBody, level: ExistsLevel, et: number): { shape: SceneShape; status: ShapeStatus } | { status: ShapeStatus } {
    const shapeLabel = h.provenance.label;
    const o = h.orientation;
    const src = h.provenance.sources;
    const name = `${h.kind === 'radar' ? 'radar' : 'spacecraft'} shape model (${h.provenance.method})`;
    if (!labelAllowed(shapeLabel, level)) return { status: { drawn: false, text: `${name}: shape is ${shapeLabel}, not admitted at this level`, label: shapeLabel, sources: src } };
    if (!sb.radii) return { status: { drawn: false, text: `${name}: no admitted size for the photometry`, label: shapeLabel, sources: src } };
    let M: Mat3 | null = null;
    let oLabel: Label = o.label;
    let how = '';
    if (o.label === 'unknown') {
      const note = h.notes.find((n) => /rotat|tumbl|spin/i.test(n));
      return { status: { drawn: false, text: `${name}: orientation unknown${note ? ` — ${note}` : ''}`, label: shapeLabel, orientationLabel: 'unknown', sources: src } };
    }
    if (isPckConstants(o.sourceRotation)) {
      M = bodyToIcrfFromConstants(o.sourceRotation, et);
      how = `rotation of its own frame ${o.frame} (mission kernels ${(o.kernels ?? []).join(', ')})`;
    } else if (sb.id > 0 && sb.orient && /^IAU_/.test(o.frame)) {
      M = sb.orient;
      how = 'the body\'s IAU rotation (pck00011)';
    } else if (isPckConstants(o.appRotation)) {
      M = bodyToIcrfFromConstants(o.appRotation, et);
      how = `pck00011 rotation of ${o.frame}`;
    } else if (o.labelRotation && typeof (o.labelRotation as Record<string, unknown>).poleRaDeg === 'number') {
      M = bodyToIcrf(iauFromSimple(o.labelRotation as unknown as Parameters<typeof iauFromSimple>[0]), et);
      how = 'rotation given in the PDS label';
    } else if (o.spinState) {
      const r = radarSpin(o.spinState.fields, this.o.utcToEt);
      if ('error' in r) return { status: { drawn: false, text: `${name}: ${r.error}`, label: shapeLabel, orientationLabel: o.label, sources: src } };
      M = radarBodyToIcrf(r, et);
      oLabel = worstOf([o.label, 'estimated']);
      how = 'radar spin state (pole and period measured; the phase convention of the SHAPE software is assumed → estimated)';
    }
    if (!M) return { status: { drawn: false, text: `${name}: no rotation model to place it`, label: shapeLabel, orientationLabel: oLabel, sources: src } };
    if (!labelAllowed(oLabel, level)) return { status: { drawn: false, text: `${name}: orientation is ${oLabel}, not admitted at this level`, label: shapeLabel, orientationLabel: oLabel, sources: src } };
    const b = h.stats.boundsKm;
    const bound = Math.hypot(Math.max(Math.abs(b[0][0]), Math.abs(b[1][0])), Math.max(Math.abs(b[0][1]), Math.abs(b[1][1])), Math.max(Math.abs(b[0][2]), Math.abs(b[1][2])));
    const lods: SceneShapeLod[] = h.lods.map((l) => ({
      url: this.o.dataRoot + h.bin, offset: l.offset, bytes: l.bytes, triangles: l.triangles, vertices: l.vertices, format: 'shape',
      parts: {
        positions: { offset: l.positions.offset, bytes: l.positions.bytes },
        normals: { offset: l.normals.offset, bytes: l.normals.bytes },
        indices: { offset: l.indices.offset, bytes: l.indices.bytes, type: l.indices.type as 'u16' | 'u32' },
      },
    }));
    const worst = worstOf([shapeLabel, oLabel, 'derived']);
    return {
      shape: { key: `shapes/${h.id}`, orient: M, scaleKm: 1, boundRadiusKm: bound, areaKm2: h.stats.areaKm2, lods, worstLabel: worst },
      status: { drawn: true, text: `${name}, ${h.lods[0].triangles.toLocaleString('en')} triangles finest; placed with the ${how}`, label: shapeLabel, orientationLabel: oLabel, sources: src },
    };
  }

  private fromDamit(d: DamitModel, spkid: number, sb: SceneBody, level: ExistsLevel, et: number): { shape: SceneShape; status: ShapeStatus } | { status: ShapeStatus } {
    const name = `DAMIT lightcurve-inversion model ${d.modelId} (convex${d.closed ? '' : ', not closed'})`;
    const label: Label = 'derived';
    if (!labelAllowed(label, level)) return { status: { drawn: false, text: `${name}: derived, not admitted at this level`, label } };
    if (!sb.radii || !(d.equivalentRadius > 0)) return { status: { drawn: false, text: `${name}: no measured diameter to scale it`, label } };
    const R = Math.cbrt(sb.radii[0] * sb.radii[1] * sb.radii[2]);
    const scaleKm = R / d.equivalentRadius;
    const bin = this.damit && typeof this.damit !== 'string' ? this.damit.header.meshBin : 'shapes/damit.bin';
    const bytes = ((d.vertexCount * 6 + 3) & ~3) + ((d.triangleCount * 6 + 3) & ~3);
    return {
      shape: {
        // (a single level: its area only matters once decoded; 4πR² × 1.1 is a placeholder for the LOD choice)
        key: `damit/${d.modelId}`, orient: damitBodyToIcrf(d, et), scaleKm, boundRadiusKm: d.scale * Math.sqrt(3) * scaleKm, areaKm2: 4.4 * Math.PI * R * R,
        lods: [{ url: this.o.dataRoot + (bin.includes('/') ? bin : `shapes/${bin}`), offset: d.dataOffset, bytes, triangles: d.triangleCount, vertices: d.vertexCount, format: 'damit', quantScale: d.scale }],
        worstLabel: 'derived',
      },
      status: { drawn: true, text: `${name}, scaled to the measured diameter (volume-equivalent), spin state λ ${d.lambdaDeg.toFixed(0)}°, β ${d.betaDeg.toFixed(0)}°, P ${d.periodHours.toPrecision(7)} h (SPK-ID ${spkid})`, label, orientationLabel: 'derived', sources: ['damit'] },
    };
  }
}

/** A principal-axis radar spin state from the header's spin-state fields, or why it cannot be used. */
export function radarSpin(fields: { name: string; value: number | string }[], utcToEt?: (unixMs: number) => number): RadarSpin | { error: string } {
  const f = new Map(fields.map((x) => [x.name, x.value]));
  if ([...f.keys()].some((k) => /Euler|period2|psi/i.test(k))) return { error: 'non-principal-axis (tumbling) rotation: not modelled by this version' };
  const num = (k: string) => (typeof f.get(k) === 'number' ? (f.get(k) as number) : NaN);
  const lam = num('Pole_longitude'), bet = num('Pole_latitude'), P = num('Rotational_period'), phi = num('Rotational_phase_at_t0');
  if (![lam, bet, P, phi].every(Number.isFinite)) return { error: 'spin state incomplete (pole, period or phase missing)' };
  if (!utcToEt) return { error: 'no time scale for the zero epoch' };
  const y = num('year'), mo = num('month'), d = num('day'), h = num('hours'), mi = num('minutes'), s = num('seconds');
  if (![y, mo, d, h, mi, s].every(Number.isFinite)) return { error: 'zero epoch incomplete' };
  const ms = Date.UTC(y, mo - 1, d, h, mi, 0) + s * 1000;
  return { lambdaDeg: lam, betaDeg: bet, periodHours: P, phi0Deg: phi, t0Et: utcToEt(ms) };
}
