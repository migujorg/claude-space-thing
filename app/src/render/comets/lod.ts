// Which comets are drawn extended (coma + tails) and which stay points of the small-body field.
//
// A comet is drawn extended when it is resolved from the camera: its coma radius covers COMA_MIN_PX pixels, or its
// dust tail could span TAIL_MIN_PX pixels and the comet is bright enough for the tail to matter (total magnitude
// within TAIL_MAG_MARGIN of the eye's limiting magnitude). Everything else stays a point (its total M1/K1 light in
// one splat, as before): below those sizes the extended drawing would put the same light in the same pixel.

import type { CometModelProduct } from '../../data/schema';
import { coma, dustTailLengthKm, type CometInput } from './model';

export const COMA_MIN_PX = 1.5;
export const TAIL_MIN_PX = 6;
export const TAIL_MAG_MARGIN = 3;
/** Limiting magnitude assumed before the eye model has reported one (dark-adapted naked eye, roughly). */
export const DEFAULT_LIMITING_MAG = 6.5;

export interface CometLod {
  extended: boolean;
  comaPx: number;
  tailPx: number;
  m1: number;
}

export function cometLod(model: CometModelProduct, input: CometInput, pixelAngle: number, limitingMag = DEFAULT_LIMITING_MAG): CometLod {
  const c = coma(model, input);
  const comaPx = c.radiusKm / c.deltaKm / pixelAngle;
  const tailPx = dustTailLengthKm(model, c.rAu) / c.deltaKm / pixelAngle;
  const extended = Number.isFinite(c.m1) && (comaPx >= COMA_MIN_PX || (tailPx >= TAIL_MIN_PX && c.m1 <= limitingMag + TAIL_MAG_MARGIN));
  return { extended, comaPx, tailPx, m1: c.m1 };
}
