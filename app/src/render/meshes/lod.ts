// Level-of-detail choice for shape meshes (docs/rendering-shapes.md §4): the coarsest level whose typical
// triangle edge, seen from the camera at the nearest point of the body, is at most TARGET_EDGE_PX pixels.
// A numerical choice (finer triangles than ~1.5 px change nothing visible), not a physical constant.

export const TARGET_EDGE_PX = 1.5;

export interface LodChoice {
  /** Triangle counts per level, finest (0) first. */
  triangles: number[];
  /** Surface area of the mesh, km² (after scaling to km). */
  areaKm2: number;
  /** Largest distance of a vertex from the body centre, km. */
  boundRadiusKm: number;
  /** Camera distance to the body centre, km. */
  distKm: number;
  /** Pixels per radian at the image centre (H / (2 tan(fovY/2))). */
  pixelsPerRadian: number;
  targetEdgePx?: number;
}

/** Typical triangle edge (km) of a level: equilateral triangles tiling the surface. */
export function edgeKm(areaKm2: number, triangles: number): number {
  return Math.sqrt((4 * areaKm2) / (Math.sqrt(3) * Math.max(1, triangles)));
}

export function chooseLod(c: LodChoice): number {
  const target = c.targetEdgePx ?? TARGET_EDGE_PX;
  // distance to the nearest surface, never below a twentieth of the body (the camera is never inside it)
  const d = Math.max(c.distKm - c.boundRadiusKm, 0.05 * c.boundRadiusKm);
  for (let k = c.triangles.length - 1; k >= 0; k--) {
    const px = (edgeKm(c.areaKm2, c.triangles[k]) / d) * c.pixelsPerRadian;
    if (px <= target) return k;
  }
  return 0;
}

/**
 * The level to draw now: the wanted one if it is resident, else the nearest finer resident level, else the
 * nearest coarser one; −1 if none is resident.
 */
export function drawableLod(wanted: number, resident: boolean[]): number {
  if (resident[wanted]) return wanted;
  for (let k = wanted - 1; k >= 0; k--) if (resident[k]) return k;
  for (let k = wanted + 1; k < resident.length; k++) if (resident[k]) return k;
  return -1;
}
