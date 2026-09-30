"""`light` stage: sunlight, CIE constants and planet photometry (docs/architecture.md §4).

Writes
  light.json       LightData: Sun (X, Y, Z, S) at 1 AU from TSIS-1 HSRS, IAU 2015 B3 radius, per-channel limb
                   darkening from Neckel & Labs (1994); the CIE constants used.
  photometry.json  PhotometryFile: NAIF id -> BodyPhotometry for Mercury..Pluto, the Moon and the major moons.
  rings.json       RingsFile: planet NAIF id -> RingSystem (radial optical-depth profiles from occultations).

All inputs are fetched through pipeline.download.fetch (sha256-recorded) or transcribed published tables under
pipeline/src/pipeline/photometry/tables/ (see docs/sources/). Diagnostics are printed and summarized in
docs/reports/planet-colors.md (regenerate with `uv run python -m pipeline.photometry.report`).
"""

from __future__ import annotations

import numpy as np

from ..output import write_json
from ..photometry import bodies, phase, rings, solar
from ..schema import BuildContext

DEPENDS: tuple[str, ...] = ()


def run(ctx: BuildContext) -> None:
    problems = phase.verify_against_code()
    if problems:
        raise ValueError("Mallama & Hilton transcription does not match Ap_Mag_V3.f90: " + "; ".join(problems))

    light, diag = solar.light_json(ctx)
    write_json(ctx, "light.json", light, "light")
    X, Y, Z, S = diag["xyzs"]
    print(f"[light] sun at 1 AU: X={X:.0f} Y={Y:.0f} lux Z={Z:.0f} S={S:.0f} scotopic lux; "
          f"xy=({diag['xy'][0]:.4f}, {diag['xy'][1]:.4f})")
    t = diag["tsi"]
    print(f"[light] HSRS integral {t['range_nm'][0]:.0f}-{t['range_nm'][1]:.0f} nm = {t['total_W_m2']:.2f} W/m2 "
          f"({100 * t['total_W_m2'] / 1361.0:.1f} % of the IAU nominal TSI 1361 W/m2); 360-830 nm = "
          f"{t['visible_360_830_W_m2']:.2f} W/m2")
    print(f"[light] limb darkening: refit residual {diag['limb']['fit_residual_max']:.1e}, F/I per channel "
          + ", ".join(f"{v:.4f}" for v in diag["limb"]["F_over_I"]))

    results = bodies.build_all(ctx)
    write_json(ctx, "photometry.json", bodies.photometry_json(results), "light")
    for n, r in results.items():
        labels = (f"albedo:{r.entry['geometricAlbedoXYZS']['label']} phase:{r.entry['phaseFunction']['label']}")
        if r.xyzs is None:
            print(f"[light] {r.name:9s} albedo and colour unknown; {labels}")
            continue
        x, y = r.xyzs[0] / r.xyzs[:3].sum(), r.xyzs[1] / r.xyzs[:3].sum()
        pub = f"{r.v10_published:+.3f}" if r.v10_published is not None else "   n/a"
        print(f"[light] {r.name:9s} p_V={r.p_v:.4f} xy=({x:.4f}, {y:.4f}) V(1,0)={r.v10:+.3f} (published {pub}) "
              f"{labels}")

    rj, rdiag = rings.rings_json(ctx)
    write_json(ctx, "rings.json", rj, "light", indent=None)
    for n, prof in rdiag.items():
        tau = prof.tau[np.isfinite(prof.tau)]
        print(f"[light] rings {n}: {prof.radius[0]:.0f}-{prof.radius[-1]:.0f} km, {prof.radius.size} bins, "
              f"max normal tau {tau.max():.2f}")
