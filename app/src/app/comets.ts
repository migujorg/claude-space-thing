// Comets as they look, in the app shell: which comets are drawn with their coma and tails this frame
// (render/comets/lod.ts), with their actual state from the small-body propagator.
//
// Candidates per frame: the notable comets of the window (comets/list.json: predicted peak m1 from Earth ≤ its
// notableMag) and any comet the view deals with (selection, travel or camera target). Each candidate's light-time
// corrected position and heliocentric state come from SmallBodies (the CPU reference propagator, the same states the
// inspector shows); the ones resolved from the camera become SceneSnapshot.comets and are taken out of the field's
// points. Drawing needs the position and the total-magnitude law admitted at the reality level, and 'estimated'
// (the coma model's label) admitted too.

import type { CometListProduct, CometModelProduct, Label } from '../data/schema';
import { activityOf, type CometInput } from '../render/comets/model';
import { cometLod } from '../render/comets/lod';
import type { SceneComet } from '../render/scene';
import type { CoreFunctions, Vec3 } from './ports';
import { labelAllowed, type ExistsLevel } from './reality';
import { labelOf, numOf, sbId, type SmallBodies } from './smallbodies';

const YEAR_S = 365.25 * 86400;
/** Long-period comets (dust colour population of Jewitt 2015): orbital period above 200 yr, or unbound. */
const LONG_PERIOD_YEARS = 200;
/** Refresh interval of the coarse per-candidate states (s of simulated time). */
const COARSE_S = 3600;

export class CometShell {
  private readonly notableRows: number[];

  constructor(private readonly sb: SmallBodies, readonly model: CometModelProduct, readonly list: CometListProduct | null) {
    this.notableRows = list?.notable.map((n) => n.row) ?? [];
  }

  isComet(row: number): boolean {
    return !this.sb.isSynthetic(row) && this.sb.hasFlag(row, 'comet');
  }

  /** M1, K1 and the label of the total-magnitude law, or null. */
  magnitudeLaw(row: number): { M1: number; K1: number; label: Label } | null {
    const t = this.sb.tables;
    const k = t.cometRow.get(row);
    if (k === undefined || !t.comets) return null;
    const M1 = numOf(t.comets, 'M1', k), K1 = numOf(t.comets, 'K1', k);
    if (!Number.isFinite(M1) || !Number.isFinite(K1)) return null;
    return { M1, K1, label: labelOf(t.comets, 'totalLabel', k) };
  }

  /** The inputs of the physics at et from a camera (SSB km): null if the comet is not drawable. */
  input(row: number, cameraSSB: Vec3, et: number, core: Pick<CoreFunctions, 'apparentPosition'>, level: ExistsLevel): { sc: SceneComet; input: CometInput } | null {
    if (!this.isComet(row) || !labelAllowed('estimated', level)) return null;
    const law = this.magnitudeLaw(row);
    if (!law || !labelAllowed(law.label, level) || !labelAllowed(this.sb.posLabel(row), level)) return null;
    const a = this.sb.apparent(row, cameraSSB, et, core);
    if (!a) return null;
    const h = this.sb.helio(row, a.app.emitEt);
    if (!h) return null;
    const measured = this.list?.measured[String(row)] ?? null;
    const activity = activityOf(this.model, measured);
    const mu = this.model.sun.gmKm3S2;
    const r = Math.hypot(...h.pos), v2 = h.vel[0] ** 2 + h.vel[1] ** 2 + h.vel[2] ** 2;
    const energy = v2 / 2 - mu / r;
    const aKm = energy < 0 ? -mu / (2 * energy) : Infinity;
    const periodYears = Number.isFinite(aKm) ? (2 * Math.PI * Math.sqrt(aKm ** 3 / mu)) / YEAR_S : Infinity;
    const dust = periodYears > LONG_PERIOD_YEARS ? 'longPeriod' : 'shortPeriod';
    const sc: SceneComet = {
      id: sbId(row), name: this.sb.name(row), rel: a.app.rel, helioPos: h.pos, helioVel: h.vel,
      M1: law.M1, K1: law.K1, totalLabel: law.label, activity, dust,
    };
    const observer: Vec3 = [h.pos[0] - a.app.rel[0], h.pos[1] - a.app.rel[1], h.pos[2] - a.app.rel[2]];
    return { sc, input: { M1: law.M1, K1: law.K1, activity, dust, helioPos: h.pos, helioVel: h.vel, observer } };
  }

  /** Coarse states (no light time), refreshed when time moves by more than COARSE_S: a cheap first cut. */
  private coarse = new Map<number, { et: number; ssb: Vec3; pos: Vec3; vel: Vec3 }>();

  private maybeExtended(row: number, cameraSSB: Vec3, et: number, level: ExistsLevel, pixelAngle: number, limitingMag?: number): boolean {
    if (!this.isComet(row) || !labelAllowed('estimated', level)) return false;
    const law = this.magnitudeLaw(row);
    if (!law) return false;
    let c = this.coarse.get(row);
    if (!c || Math.abs(c.et - et) > COARSE_S) {
      // (no state yet, e.g. the propagation worker is still seeding: nothing is cached, asked again next frame)
      const h = this.sb.helio(row, et), sun = this.sb.sunSSB(et);
      if (!h || !sun) return false;
      c = { et, ssb: [sun[0] + h.pos[0], sun[1] + h.pos[1], sun[2] + h.pos[2]], pos: h.pos, vel: h.vel };
      this.coarse.set(row, c);
    }
    const rel: Vec3 = [c.ssb[0] - cameraSSB[0], c.ssb[1] - cameraSSB[1], c.ssb[2] - cameraSSB[2]];
    const observer: Vec3 = [c.pos[0] - rel[0], c.pos[1] - rel[1], c.pos[2] - rel[2]];
    const activity = activityOf(this.model, this.list?.measured[String(row)] ?? null);
    return cometLod(this.model, { M1: law.M1, K1: law.K1, activity, dust: 'shortPeriod', helioPos: c.pos, helioVel: c.vel, observer }, pixelAngle, limitingMag).extended;
  }

  /**
   * This frame's extended comets: candidates resolved from the camera (pixelAngle rad at the centre; limitingMag of
   * the eye if known). Returns the scene entries and their rows (to take out of the field's points).
   */
  frame(inView: number[], cameraSSB: Vec3, et: number, core: Pick<CoreFunctions, 'apparentPosition'>, level: ExistsLevel, pixelAngle: number, limitingMag?: number): { comets: SceneComet[]; rows: number[] } {
    const rows = [...new Set([...this.notableRows, ...inView])];
    const comets: SceneComet[] = [];
    const out: number[] = [];
    for (const row of rows) {
      if (!inView.includes(row) && !this.maybeExtended(row, cameraSSB, et, level, pixelAngle, limitingMag)) continue;
      const got = this.input(row, cameraSSB, et, core, level);
      if (!got) continue;
      if (!cometLod(this.model, got.input, pixelAngle, limitingMag).extended) continue;
      comets.push(got.sc);
      out.push(row);
    }
    return { comets, rows: out };
  }
}
