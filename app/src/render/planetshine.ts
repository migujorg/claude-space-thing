// Planetshine (Earthshine on the Moon, Jupiter-shine and Saturn-shine on moons): light reflected by one
// body onto another, from the illuminating body's measured disk-integrated photometry (architecture
// §4.3). The illuminating body is a point source of illuminance
//   E_ij = albedoXYZS_j · (1/d_j²) · (R_j/Δ_ij)² · Φ_j(α_ij)
// at body i (Δ_ij their distance, α_ij body j's phase angle as seen from i). Body i reflects it with a
// Lambert law of albedo A_L = 1.5·p_i (p_i = albedoXYZS_i / E_sun,1AU per channel, its measured geometric
// albedo): L = A_L·E_ij·max(0, cos i')/π, times its surface map. The spatial law and the point-source
// approximation (the Earth seen from the Moon spans 2°) are assumptions: the planetshine is estimated.

import type { SceneBody } from './scene';
import { AU_KM } from './constants';
import { evalPhase, LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO, meanRadius, type XYZS } from './photometry';
import { len, sub, type V3 } from './raycast';

export interface PlanetshineSource {
  /** Unit direction from the lit body's centre to the source. */
  dir: V3;
  /** Radiance prefactor (cd/m² per unit cos i'), XYZS: L = K·max(0, n·dir). */
  K: XYZS;
  sourceId: number;
  /** Illuminance at the body, lux (XYZS). */
  E: XYZS;
}

/** The (up to) `max` strongest planetshine sources for body i. */
export function planetshineSources(i: SceneBody, bodies: SceneBody[], sunIrradianceXYZS_1AU: XYZS | null, max = 2): PlanetshineSource[] {
  if (!i.albedoXYZS || !sunIrradianceXYZS_1AU || !i.radii) return [];
  const pi = i.albedoXYZS.map((a, k) => (sunIrradianceXYZS_1AU[k] > 0 ? a / sunIrradianceXYZS_1AU[k] : 0)) as XYZS;
  const out: PlanetshineSource[] = [];
  for (const j of bodies) {
    if (j === i || !j.radii || !j.albedoXYZS || !j.phase || j.surfaceUnknown) continue;
    const v = sub(j.pos, i.pos);
    const dist = len(v);
    const Rj = meanRadius(j.radii);
    if (!(dist > Rj + meanRadius(i.radii))) continue;
    const back = sub(i.pos, j.pos);
    const sunLen = len(j.toSun);
    if (!(sunLen > 0)) continue;
    const alpha = Math.acos(Math.max(-1, Math.min(1, (back[0] * j.toSun[0] + back[1] * j.toSun[1] + back[2] * j.toSun[2]) / (dist * sunLen))));
    const ph = evalPhase(j.phase, alpha);
    if (!ph.ok || !(ph.phi > 0)) continue;
    const dAU = sunLen / AU_KM;
    const f = ((Rj / dist) ** 2 * ph.phi) / (dAU * dAU);
    const E = j.albedoXYZS.map((a) => a * f) as XYZS;
    const K = E.map((e, k) => (LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO * pi[k] * e) / Math.PI) as XYZS;
    out.push({ dir: [v[0] / dist, v[1] / dist, v[2] / dist], K, sourceId: j.id, E });
  }
  out.sort((a, b) => b.E[1] - a.E[1]);
  return out.slice(0, max).filter((s) => s.E[1] > 0);
}
