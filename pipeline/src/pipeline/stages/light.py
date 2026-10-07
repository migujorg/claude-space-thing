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

from ..photometry.albedo import pck_radii

from ..output import write_json
from ..photometry import atmospheres, bodies, phase, rings, smallbody_colors, solar
from ..schema import BuildContext, sourced, unknown

DEPENDS: tuple[str, ...] = ()
# These dates and observer are from Karkoschka 1998 / PDS 1995LOW (source note).
KARKOSCHKA_EPOCH = "1995-07-06/1995-07-10"


def dated_views(naif: int, ctx: BuildContext | None = None) -> dict:
    """Integrate geometry over the source's observing-date interval, not the build window.

    The source does not associate a UTC exposure with each tabulated spectrum. The
    reference is the time mean of the stated five UTC dates; quadrature epochs below
    are numerical nodes, explicitly not claimed exposure timestamps.
    """
    import spiceypy as sp
    from .. import ephem_kernels as ek
    from ..validation.geometry import FRAMES, SUN_FROM
    with ek.pool(ek.lsk(ctx), ek.pck(ctx), ek.planetary(ctx)):
        start, end = sp.str2et("1995-07-06T00:00:00"), sp.str2et("1995-07-11T00:00:00")
        nodes, weights = np.polynomial.legendre.leggauss(5)
        views = []
        for node, weight in zip(nodes, weights):
            et = start + (node + 1) * (end - start) / 2
            pos, lt = sp.spkpos(SUN_FROM[naif], et, "J2000", "LT", "EARTH")
            M = np.asarray(sp.pxform(FRAMES[naif], "J2000", et - lt))
            sun, _ = sp.spkpos("SUN", et - lt, "J2000", "LT", SUN_FROM[naif])
            obs = M.T @ -np.asarray(pos); obs /= np.linalg.norm(obs)
            sun = M.T @ np.asarray(sun); sun /= np.linalg.norm(sun)
            ca = float(np.clip(obs @ sun, -1, 1)); phase = float(np.arccos(ca))
            tangent = (sun - ca * obs) / np.sin(phase)
            # Rotate around the pole to put the observer at longitude zero. Only
            # relative solar longitude matters to a zonal map; no invented W.
            lon = np.arctan2(obs[1], obs[0]); cl, sl = np.cos(lon), np.sin(lon)
            tangent = [cl*tangent[0]+sl*tangent[1], -sl*tangent[0]+cl*tangent[1], tangent[2]]
            views.append({"epoch": sp.et2utc(et, "ISOC", 3), "weight": float(weight/2),
                          "latitudeDeg": float(np.degrees(np.arcsin(obs[2]))),
                          "subSolarLatitudeDeg": float(np.degrees(np.arcsin(sun[2]))),
                          "phaseAngleDeg": float(np.degrees(phase)),
                          "solarTangent": [float(v) for v in tangent],
                          "earthCentreParallaxBoundDeg": float(np.degrees(np.arcsin(
                              max(sp.bodvrd("EARTH", "RADII", 3)[1]) / np.linalg.norm(pos))))})
    mean = {k: sum(v["weight"]*v[k] for v in views)
            for k in ("latitudeDeg", "subSolarLatitudeDeg", "phaseAngleDeg", "earthCentreParallaxBoundDeg")}
    return {"kind": "latitude", "epoch": KARKOSCHKA_EPOCH, **mean, "views": views}


def earth_measurement_view() -> dict:
    """The actual CGMS observer/Sun geometry used to integrate the AHI albedo."""
    from datetime import datetime, timedelta, timezone
    from ..photometry.earth import himawari_disk
    hd=himawari_disk();sun=np.asarray(hd["sun_dir"])
    phase=float(np.arccos(np.clip(sun[0],-1,1)))
    utc=lambda mjd:(datetime(1858,11,17,tzinfo=timezone.utc)+timedelta(days=mjd)).isoformat()
    return {"kind":"latitude","latitudeDeg":0.0,
            "epoch":f"{utc(hd['mjd_start'])}/{utc(hd['mjd_end'])}",
            "subSolarLatitudeDeg":float(np.degrees(np.arcsin(sun[2]))),
            "phaseAngleDeg":float(np.degrees(phase)),
            "solarTangent":[0.0,float(sun[1]/np.sin(phase)),float(sun[2]/np.sin(phase))]}


def view_spread(naif: int, entry: dict, ctx: BuildContext | None = None) -> dict:
    """Informational all-phase single-view spread of the bare ellipsoid.

    A positive law bounds the normalized integral by the extrema of its Gauss-map
    area Jacobian. This is a geometric spread, not an error of a compiled mean.
    """
    from .. import ephem_kernels as ek
    r = np.asarray(pck_radii()[naif]); d = (r / np.cbrt(np.prod(r)))**2
    jac_min, jac_max = float(np.prod(d)/max(d)**2), float(np.prod(d)/min(d)**2)
    z, w = np.polynomial.legendre.leggauss(128)
    phi = 2*np.pi*(np.arange(256)+.5)/256
    normals = np.stack(np.broadcast_arrays(np.sqrt(1-z[:,None]**2)*np.cos(phi),
                      np.sqrt(1-z[:,None]**2)*np.sin(phi), z[:,None]), axis=-1)
    jac = np.prod(d) / np.sum(normals**2*d, axis=-1)**2
    mean = float(np.sum(jac*w[:,None])/512)
    bare = max(abs(jac_min/mean-1), abs(jac_max/mean-1))
    return sourced({"bareMaxRelative": bare}, "derived", [ek.SRC_PCK],
        method="Bare-ellipsoid all-phase positive-weight bound: min/max Gauss-map area Jacobian "
               "divided by its uniform-orientation mean. Describes how a single view can differ "
               "from the mean; neither an albedo error nor a provenance-label criterion.")


# The source note/paper sentence establishing each compiled mean (see
# docs/sources/ellipsoid-calibration-views.md). A new source without this evidence
# must take the estimated branch, rather than acquiring a derived label by default.
ORIENTATION_MEANS = {
    "payne-2026-mercury": "Payne 2026: MESSENGER/MASCS global-mean reflectance (Izenberg et al. 2014), "
        "scaled to Mallama et al. (2017) broadband geometric albedos.",
    "payne-2026-venus": "The absolute level is scaled to Venus's V geometric albedo 0.689 "
        "(Mallama et al. 2017), a compiled broadband albedo; the spectral shape remains estimated.",
    "mallama-2017": "Mars: from Mallama 2007's photometry, rotation- and season-averaged.",
    "kieffer-stone-2005": "ROLO: a fit to 32 bands in more than 1000 observations over phase "
        "and libration, evaluated at zero libration and the geometric mean of waxing and waning.",
    "buie-2010a": "Buie 2010 Tables 8/12 give Fourier mean V at 1 degree; Table 10 gives Charon weighted-mean B-V.",
    "fornasier-2024": "Tables 1 and 2 give disk-integrated Hapke albedos and H-G fits over "
        "Mars Express HRSC observations, mostly the 10-100 degree phase range.",
    "wargnier-2025": "Deimos photometric properties: analysis of 20 years of observations "
        "(2004-2024); Table 4 is the disk-integrated Hapke fit to SRC panchromatic data.",
    "mayorga-2020": "Disk-integrated phase curves from 3299 WAC and 329 NAC images of the "
        "2000-2001 flyby; the zero-phase value of each fit is the geometric albedo in that filter.",
    "filacchione-2022": "A single photometric model per wavelength fitted to all Cassini VIMS "
        "pixels with i, e <=70 degrees and 10<=g<=120 degrees over the whole mission.",
    "grav-2015": "Table 1: V absolute magnitude H and slope G compiled from Luu (1991), "
        "Rettig et al. (2001), Grav et al. (2003), Grav & Bauer (2007) and Bauer et al. (2006).",
    "decolibus-2026-data": "The All grand-average disk-integrated reflectance spectra: "
        "Palomar DBSP and LDT DeVeny, 2002-2024, all longitudes; scaled to Karkoschka's HST geometric albedos.",
    "verbiscer-2022": "Triton's compiled albedo/colour is from Buratti et al. (2011) and "
        "Cruikshank et al. (1993); the phase coefficient covers 2000-2004.",
}


def orientation_mean_description(sources: list[str]) -> str | None:
    return next((ORIENTATION_MEANS[s] for s in sources if s in ORIENTATION_MEANS), None)


def with_measurement_views(photometry: dict, ctx: BuildContext | None = None) -> dict:
    """Keep a dated calibration geometry separate from the measurement's label."""
    for key, entry in photometry.items():
        albedo = entry["geometricAlbedoXYZS"]
        if albedo["value"] is None:
            entry["albedoMeasurementView"] = unknown("No disk albedo is available to calibrate a measurement view.")
            continue
        naif = int(key)
        if naif in (599, 699, 799, 899, 606):
            from .. import ephem_kernels as ek
            entry["albedoMeasurementView"] = sourced(
                dated_views(naif, ctx), "derived",
                ["karkoschka-1998-pds", ek.SRC_PLANETARY, ek.SRC_PCK, ek.SRC_LSK],
                method="Karkoschka 1998/PDS 1995LOW, ESO La Silla, 1995 July 6–10. "
                       "Earth centre observing direction (telescope parallax bounded in degrees in the value), "
                       "DE442s system-barycentre directions with LT and IAU pck00011 at the light-emission epoch. "
                       "Five-node time quadrature over the five stated UTC dates; nodes are not exposure dates. "
                       "Sub-observer and sub-solar latitudes are planetocentric; the solar tangent retains the "
                       "observed relative solar direction as the law's phase changes. "
                       "Planet/satellite-centre offsets from the system barycentre are omitted; for Titan the "
                       "parent-system direction is an approximation, not a recovered Cassini or Titan ephemeris.")
        elif naif == 399 and any("himawari9-ahi" in x for x in albedo["sources"]):
            entry["albedoMeasurementView"] = sourced(earth_measurement_view(), "derived",
                [x for x in albedo["sources"] if "himawari9-ahi" in x],
                method="Himawari-9 AHI calibration geometry from the HSD/CGMS observer frame and "
                       "the solar direction computed by photometry.earth for the actual scan. "
                       "This is the very geometry used to integrate the albedo; sub-observer "
                       "latitude is zero in the CGMS equatorial projection. Absolute Earth "
                       "layers continue to use their independent calibration.")
        else:
            description = orientation_mean_description(albedo["sources"])
            entry["albedoMeasurementView"] = sourced(
                {"kind": "orientation-mean"}, "derived" if description else "estimated", albedo["sources"],
                method=("Source description: " + description + " The reference integral is the mean over "
                        "orientations by the definition of this compiled measurement; the albedo keeps its label."
                        if description else "Single observation without a recoverable date/view in the retained "
                        "inputs. Assumed uniform-orientation reference; section 2.1 propagation applies."))
        if naif in pck_radii():
            spread = view_spread(naif, entry, ctx)
            entry["albedoViewSpread"] = spread
            v = spread["value"]
            text = (f"Single-view bare-ellipsoid spread ≤{100*v['bareMaxRelative']:.6g}% relative "
                    "over all phases/orientations (conservative positive-weight bound); "
                    "informational spread, not the error of the reference mean.")
            for field in ("geometricAlbedoXYZS", "geometricAlbedoV"):
                if field in entry:
                    entry[field]["uncertainty"] = entry[field].get("uncertainty", "") + "; " + text
    return photometry


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
    photometry = with_measurement_views(bodies.photometry_json(results), ctx)
    write_json(ctx, "photometry.json", photometry, "light")
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
