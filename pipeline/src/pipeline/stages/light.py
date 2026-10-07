"""`light` stage: sunlight, CIE constants and planet photometry (docs/architecture.md §4).

Writes
  light.json       LightData: Sun (X, Y, Z, S) at 1 AU from TSIS-1 HSRS, IAU 2015 B3 radius, per-channel limb
                   darkening from Neckel & Labs (1994); the CIE constants used.
  photometry.json  PhotometryFile: NAIF id -> BodyPhotometry for Mercury..Pluto, the Moon and the major moons.
  rings.json       RingsFile: planet NAIF id -> RingSystem (radial optical-depth profiles from occultations).
  smallbody-class-colors.json  SmallBodyClassColorsFile: per Bus-DeMeo class, the colour per unit p_V and p_V
                   statistics, for small bodies without a measured spectrum (photometry/smallbody_colors.py).
  atmospheres.json AtmosphereFile: per body, extinction / single-scattering albedo / phase function of each
                   atmospheric component on an altitude grid at 360-830 nm, for sky and limb rendering
                   (photometry/atmospheres.py; docs/reports/atmospheres.md, regenerate with
                   `uv run python -m pipeline.photometry.atmo_report`).

All inputs are fetched through pipeline.download.fetch (sha256-recorded) or transcribed published tables under
pipeline/src/pipeline/photometry/tables/ (see docs/sources/). Diagnostics are printed and summarized in
docs/reports/planet-colors.md (regenerate with `uv run python -m pipeline.photometry.report`).
"""

from __future__ import annotations

import numpy as np

from ..output import write_json
from ..photometry import atmospheres, bodies, phase, rings, smallbody_colors, solar
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
        if n.endswith("-components"):
            continue
        tau = prof.tau[np.isfinite(prof.tau)]
        print(f"[light] rings {n}: {prof.radius[0]:.0f}-{prof.radius[-1]:.0f} km, {prof.radius.size} bins, "
              f"max normal tau {tau.max():.2f}")
    for key in ("599", "799", "899"):
        comp = rj[key].get("components") or {}
        if comp.get("value"):
            m = comp["value"]
            print(f"[light] rings {key} components: {len(m['components'])} ({comp['label']}), phase functions "
                  f"{', '.join(m['phaseFunctions'])}")

    sbc = smallbody_colors.build(ctx)
    write_json(ctx, "smallbody-class-colors.json", sbc, "light")
    pop = sbc["population"]["pV"]["value"]
    print(f"[light] small-body class colours: {len(sbc['classes'])} Bus-DeMeo classes, population p_V median "
          f"{pop['median']} (n = {pop['n']})")

    atm, _ = atmospheres.build(ctx)
    write_json(ctx, "atmospheres.json", atm, "light", indent=None)
    for e in atm["bodies"].values():
        comps = ", ".join(f"{c['id']} τ(550)={c['columnOpticalDepth'][19]:.4g}" for c in e["components"])
        print(f"[light] atmosphere {e['name']:8s} {comps or 'scale height ' + str(e['scaleHeightKm']['value']) + ' km'}")
