"""rings.json: planetary ring systems (docs/architecture.md §6, schema `RingsFile` in app/src/data/schema.ts).

Per planet, the ring plane is the planet's equator (IAU pole in bodies.json) and radii are planet-centred, in km.

  Saturn   Normal optical depth vs radius from one Cassini UVIS HSP stellar occultation (PDS Rings Node COUVIS_8001):
           β Cen, 2008 day 231 (orbit 81), ingress, 10 km bins, ring-plane elevation of the line of sight 66.7°,
           the steepest-angle, best-sampled class of occultation (Colwell et al. 2010, AJ 140, 1569). Its maximum
           detectable τ (7-8 in the B ring) is carried alongside: values at or above it are lower limits.
  Uranus   Voyager 2 PPS β Per egress occultation (PDS VG_2801), whole ring system at 1 km.
  Neptune  Voyager 2 PPS σ Sgr ingress occultation (PDS VG_2801), whole ring system at 5 km.
  Jupiter  unknown (τ ~ 1e-6 dust ring; no machine-readable profile).

Reflectance: Saturn's is a single-scattering ring model calibrated on Voyager ISS radial I/F profiles (lit and unlit
faces) and HST phase curves (Salo & French 2010), with those measurements alongside (ring_reflectance.py). Jupiter's,
Uranus's and Neptune's are unknown: no calibrated machine-readable reflectance measurement was found.

Occultation optical depth is wavelength independent for particles much larger than the wavelength (the 110-190 nm UVIS
and 264 nm PPS profiles apply in the visible). In the A and B rings self-gravity wakes make the line-of-sight optical
depth depend on the viewing azimuth and elevation, so τ⊥/|sin B| is only an approximation (Colwell et al. 2010;
Hedman et al. 2007); the profile given is the one measured along this occultation's geometry.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from ..schema import BuildContext, sourced, unknown
from .common import Download

_COUVIS = "https://pds-rings.seti.org/holdings/volumes/COUVIS_8xxx/COUVIS_8001/data/"
_VG2801 = "https://pds-rings.seti.org/holdings/volumes/VG_28xx/VG_2801/EASYDATA/"

UVIS_PRODUCT = "UVIS_HSP_2008_231_BETCEN_I_TAU10KM"
UVIS_CITATION = ("Colwell, J. E., Esposito, L. W., Jerousek, R. G., Sremčević, M., Pettis, D. & Bradley, E. T. (2010). "
                 "Cassini UVIS stellar occultation observations of Saturn's rings. Astronomical Journal 140, 1569-1578. "
                 "DOI:10.1088/0004-6256/140/6/1569. Data: Cassini UVIS HSP ring stellar occultation profiles, data set "
                 "CO-SR-UVIS-HSP-2/4-OCC-V3.0, NASA PDS Ring-Moon Systems Node volume COUVIS_8001 (version 3.0, "
                 "2021-01-08).")
VG_CITATION = ("Voyager 2 Photopolarimeter Subsystem (PPS) ring occultation profiles, data set "
               "VG2-SR/UR/NR-PPS-2/4-OCC-V1.0, NASA PDS Ring-Moon Systems Node volume VG_2801 (EASYDATA resampled "
               "profiles, 2003). Uranus: Lane, A. L. et al. (1986), Photometry from Voyager 2: initial results from the "
               "uranian atmosphere, satellites, and rings, Science 233, 65-70, DOI:10.1126/science.233.4759.65.")


def _pair(id_: str, base: str, stem: str, title: str, citation: str, notes: str) -> tuple[Download, Download]:
    lbl = Download(id=f"{id_}-label", url=f"{base}{stem}.LBL", subdir="rings", name=f"{stem}.LBL",
                   title=title + " (PDS label)", citation=citation, notes=notes)
    tab = Download(id=id_, url=f"{base}{stem}.TAB", subdir="rings", name=f"{stem}.TAB", title=title,
                   citation=citation, notes=notes)
    return lbl, tab


UVIS = _pair("couvis-8001-betcen-2008-231-i", _COUVIS, UVIS_PRODUCT,
             "Saturn ring normal optical depth, Cassini UVIS HSP β Cen occultation 2008-231 ingress, 10 km bins",
             UVIS_CITATION,
             "Columns: ring radius (km), ring longitude, ring occultation φ, mean signal, normal optical depth "
             "(-1 = unconstrained), maximum detectable normal optical depth (25 % photon-noise uncertainty), times, "
             "star and background models, samples per bin, note flag (16: light from two stars).")
VG_URANUS = _pair("vg2801-pu2-epsilon-system", _VG2801 + "KM001/", "PU2P01XE",
                  "Uranus ring system normal opacity, Voyager 2 PPS β Per egress 1986-01-24, 1 km resampled",
                  VG_CITATION,
                  "Columns: radius (km), mean signal, signal standard deviation, normal optical depth, lower and upper "
                  "limits of its 68 % confidence interval. Wavelength 264 nm.")
VG_NEPTUNE = _pair("vg2801-pn1-system", _VG2801 + "KM005/", "PN1P01",
                   "Neptune ring system normal opacity, Voyager 2 PPS σ Sgr ingress 1989-08-24/25, 5 km resampled",
                   VG_CITATION.replace("Uranus: Lane, A. L. et al. (1986), Photometry from Voyager 2: initial "
                                       "results from the uranian atmosphere, satellites, and rings, Science 233, 65-70, "
                                       "DOI:10.1126/science.233.4759.65.",
                                       "Neptune: Lane, A. L. et al. (1989), Photometry from Voyager 2: initial results "
                                       "from the Neptunian atmosphere, satellites, and rings, Science 246, 1450-1454, "
                                       "DOI:10.1126/science.246.4936.1450."),
                   "Columns: radius (km), mean signal, signal standard deviation, normal optical depth, lower and "
                   "upper limits of its 68 % confidence interval. Neptune's rings are azimuthally variable (the Adams "
                   "ring arcs); this is one cut through them.")


def _label(dl: Download) -> dict[str, str]:
    text = dl.fetch().read_text(errors="replace")
    return {m.group(1): m.group(2).strip().strip('"') for m in re.finditer(r"^\s*([A-Z_]+)\s*=\s*(.+?)\s*$", text,
                                                                           flags=re.M)}


def _radii(r: np.ndarray, step: float) -> list[float]:
    """Bin-centre radii as archived (nominally `step` apart; UVIS bins can be up to 0.4 % wider)."""
    d = np.diff(r)
    if d.min() <= 0 or not np.all(np.abs(d - step) <= 0.01 * step):
        raise ValueError(f"radii are not increasing at ~{step} km (spacing {d.min()}..{d.max()})")
    return [round(float(x), 2) for x in r]


@dataclass
class Profile:
    json: dict
    radius: np.ndarray
    tau: np.ndarray
    noise: float | None = None     # median half-width of the 68 % interval of τ⊥ (Voyager profiles)


def saturn_profile(ctx: BuildContext | None) -> tuple[dict, list[str], Profile]:
    lbl, tab = UVIS
    meta = _label(lbl)
    d = np.loadtxt(tab.fetch(), delimiter=",")
    r, tau, tmax, flag = d[:, 0], d[:, 4], d[:, 5], d[:, 11].astype(int)
    radii = _radii(r, 10.0)
    tau_out = [None if t < 0 or (f & 64) else round(float(t), 4) for t, f in zip(tau, flag)]
    tmax_out = [None if t < 0 else round(float(t), 3) for t in tmax]
    js = {
        "name": "main rings",
        "radiusKm": radii,
        "normalTau": tau_out, "maxTau": tmax_out,
        "observation": {
            "instrument": "Cassini UVIS HSP", "star": "β Cen", "direction": meta["RING_OCCULTATION_DIRECTION"].lower(),
            "start": meta["START_TIME"], "stop": meta["STOP_TIME"], "wavelengthNm": [110, 190],
            "ringElevationDeg": float(meta["OBSERVED_RING_ELEVATION"]),
            "ringLongitudeDeg": [float(meta["MINIMUM_RING_LONGITUDE"]), float(meta["MAXIMUM_RING_LONGITUDE"])],
            "observedRingAzimuthDeg": [float(meta["MINIMUM_OBSERVED_RING_AZIMUTH"]),
                                       float(meta["MAXIMUM_OBSERVED_RING_AZIMUTH"])],
        },
    }
    srcs = [lbl.register(ctx) if ctx else lbl.id, tab.register(ctx) if ctx else tab.id]
    return js, srcs, Profile(js, r, np.where(tau < 0, np.nan, tau))


def voyager_profile(pair, name: str, ctx: BuildContext | None, step: float) -> tuple[dict, list[str], Profile]:
    lbl, tab = pair
    meta = _label(lbl)
    d = np.loadtxt(tab.fetch(), delimiter=",")
    r, tau, lo, hi = d[:, 0], d[:, 3], d[:, 4], d[:, 5]
    js = {
        "name": name,
        "radiusKm": _radii(r, step),
        "normalTau": [round(float(t), 4) for t in tau],
        "observation": {
            "instrument": "Voyager 2 PPS", "star": meta["STAR_NAME"].title(),
            "direction": meta["RING_OCCULTATION_DIRECTION"].lower(),
            "start": meta["START_TIME"], "stop": meta["STOP_TIME"],
            "wavelengthNm": [round(float(meta["WAVELENGTH"].split()[0]) * 1000.0)] * 2,
            "ringElevationDeg": round(90.0 - float(meta["INCIDENCE_ANGLE"]), 3),
        },
    }
    srcs = [lbl.register(ctx) if ctx else lbl.id, tab.register(ctx) if ctx else tab.id]
    return js, srcs, Profile(js, r, tau, float(np.median(0.5 * (hi - lo))))


URANUS_REFLECTANCE_UNKNOWN = (
    "No machine-readable measurement of the Uranian rings' reflectance (I/F vs radius, colour, phase) was available: "
    "the PDS Ring-Moon Systems Node's Voyager ring-profile volumes (VG_28xx) hold imaging I/F profiles for Saturn "
    "only, and Karkoschka's (2001, Icarus 151, 51) HST ring photometry is not openly accessible here.")


def rings_json(ctx: BuildContext | None = None) -> tuple[dict, dict]:
    out, diag = {}, {}
    js, srcs, prof = saturn_profile(ctx)
    ob = js["observation"]
    out["699"] = {
        "planet": 699,
        "opticalDepth": sourced(
            [js], "measured", srcs,
            method=f"Normal optical depth τ⊥ per 10 km radial bin as archived (Colwell et al. 2010 reduction: "
                   f"-ln(I/I0)·|sin B| with modelled unocculted-star and background signals) from the Cassini UVIS "
                   f"HSP occultation of {ob['star']} on {ob['start'][:8]} ({ob['direction']}), ring-plane elevation "
                   f"B = {ob['ringElevationDeg']}°, inertial ring longitudes {ob['ringLongitudeDeg'][0]:.1f}-"
                   f"{ob['ringLongitudeDeg'][1]:.1f}°. Chosen among the 275 archived profiles for the steepest "
                   "line of sight (least affected by self-gravity wakes and the highest maximum detectable τ, 7-8 in "
                   "the B ring) and complete C-to-F ring coverage. null = unconstrained or corrupted bin. Values at "
                   "or above maxTau are lower limits. Extinction by the (≫ λ) ring particles is taken to be the same "
                   "at 110-190 nm and in the visible.",
            uncertainty="photon noise: 25 % at maxTau, much smaller where τ⊥ is well below it; in the A and B rings "
                        "the line-of-sight optical depth varies with viewing azimuth and elevation by tens of percent "
                        "(self-gravity wakes), which a single τ⊥ profile does not capture"),
    }
    from . import ring_reflectance
    refl, model = ring_reflectance.model_json(ctx)
    out["699"].update(refl)
    out["699"]["reflectanceMeasurements"] = ring_reflectance.measurements_json(ctx)
    diag["699"] = prof
    diag["699-model"] = model
    js, srcs, prof = voyager_profile(VG_URANUS, "ring system (6, 5, 4, α, β, η, γ, δ, λ, ε)", ctx, 1.0)
    ob = js["observation"]
    out["799"] = {
        "planet": 799,
        "opticalDepth": sourced(
            [js], "measured", srcs,
            method=f"Normal optical depth per 1 km bin from the Voyager 2 PPS occultation of {ob['star']} "
                   f"({ob['direction']}, {ob['start'][:10]}; 264 nm; ring-plane elevation {ob['ringElevationDeg']}°), "
                   "as resampled in the PDS archive (boxcar). The narrow rings are unresolved or barely resolved at "
                   "1 km except ε; their optical depths vary around each ring (eccentric, width-varying rings), so "
                   "this is one cut.",
            uncertainty=f"median half-width of the archived 68 % confidence interval ±{prof.noise:.3f} in τ⊥ per "
                        "1 km bin (the archive gives the interval per bin)"),
        "reflectance": unknown(URANUS_REFLECTANCE_UNKNOWN),
    }
    diag["799"] = prof
    js, srcs, prof = voyager_profile(VG_NEPTUNE, "ring system", ctx, 5.0)
    ob = js["observation"]
    out["899"] = {
        "planet": 899,
        "opticalDepth": sourced(
            [js], "measured", srcs,
            method=f"Normal optical depth per 5 km bin from the Voyager 2 PPS occultation of {ob['star']} "
                   f"({ob['direction']}, {ob['start'][:10]}; 264 nm; ring-plane elevation {ob['ringElevationDeg']}°), "
                   "as resampled in the PDS archive (boxcar). The Adams ring arcs and the other faint rings vary "
                   "with longitude and time; this is one cut in 1989.",
            uncertainty=f"median half-width of the archived 68 % confidence interval ±{prof.noise:.3f} in τ⊥ per "
                        "5 km bin: most of the rings are near the noise level"),
        "reflectance": unknown("No machine-readable measurement of Neptune's ring reflectance was available."),
    }
    diag["899"] = prof
    out["599"] = {
        "planet": 599,
        "opticalDepth": unknown("Jupiter's faint dust rings (normal optical depth of order 1e-6; Throop et al. 2004, "
                                "Icarus 172, 59) have no machine-readable radial profile available to this pipeline."),
        "reflectance": unknown("Jupiter's rings are seen mainly in forward-scattered light; no machine-readable "
                               "brightness profile was available."),
    }
    return out, diag
