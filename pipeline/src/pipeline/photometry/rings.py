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

import math
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
    noise: float | None = None     # median half-width of the 68 % interval of τ⊥ (Voyager), 1σ photon noise (UVIS)
    cleaning: dict | None = None   # what clean_saturn_tau changed (UVIS)


EDGE_SIGMAS, EDGE_BINS = 5.0, 3        # the C ring inner edge: the first run of ≥ 3 bins above 5σ
A_RING_MIN_TAU, A_RING_MIN_BINS = 0.2, 20    # the A ring: the last run of ≥ 200 km with τ⊥ > 0.2 (the F ring is narrower)
BASELINE_BINS = 201                                   # running-median window outside the main rings (2010 km)
NOISE_SIGMAS = 3.0


def photon_sigma(sig, bg, i0, n, mu) -> np.ndarray:
    """1σ photon-counting uncertainty of τ⊥ per bin: the mean signal of N samples is Poisson, σ_T = √(S/N)/(I0 − B),
    σ_τ = μ σ_T / T (columns: mean signal S, background B and unocculted-star models I0, samples per bin N)."""
    T = (sig - bg) / (i0 - bg)
    return mu * np.sqrt(np.clip(sig, 0.0, None) / np.maximum(n, 1)) / (i0 - bg) / np.clip(T, 1e-3, None)


def clean_saturn_tau(r, tau, sigma) -> tuple[np.ndarray, dict]:
    """Bins consistent with τ⊥ = 0 within their photon noise are set to 0; genuine structure is kept.

    * Inside the main rings (from the C ring inner edge, the first run of ≥ 3 bins above 5σ, to the A ring outer
      edge, the end of the last run of ≥ 200 km with τ⊥ > 0.2) only negative values change: -1 < τ⊥ < 0 (noise, or unmodelled light near sharp edges;
      τ⊥ cannot be negative) -> 0.
    * Outside them (the D ring region inside, the F ring region and beyond outside) a smooth baseline — the
      2010 km running median of these bins — is removed first. Beyond the F ring this occultation's τ⊥ rises
      smoothly to 0.10 at its outer end while the region is empty (other occultations at the same geometry show
      different ramps: an unmodelled instrumental trend, not ring material). A bin whose baseline-removed τ⊥ is
      within 3σ, or an isolated bin above 3σ, is set to 0; runs of ≥ 2 bins above 3σ are structure (the F ring
      and its strands) and keep τ⊥ − baseline (≥ 0)."""
    out = tau.copy()
    stats = {"negative_in_rings": 0, "zeroed_outside": 0, "kept_outside": 0}
    def runs(mask, min_len):
        out, start = [], None
        for i, b in enumerate(np.append(mask, False)):
            if b and start is None:
                start = i
            elif not b and start is not None:
                if i - start >= min_len:
                    out.append((start, i - 1))
                start = None
        return out
    with np.errstate(invalid="ignore"):
        i_in = runs(tau > EDGE_SIGMAS * sigma, EDGE_BINS)[0][0]
        i_out = runs(tau > A_RING_MIN_TAU, A_RING_MIN_BINS)[-1][1]
    stats["main_rings_km"] = (float(r[i_in]), float(r[i_out]))
    inside = np.zeros(tau.size, bool)
    inside[i_in:i_out + 1] = True
    neg = inside & (tau > -1) & (tau < 0)
    stats["negative_in_rings"] = int(neg.sum())
    stats["negative_beyond_3sigma"] = int((neg & (-tau > NOISE_SIGMAS * sigma)).sum())
    out[neg] = 0.0
    from scipy.ndimage import median_filter
    for sl in (slice(0, i_in), slice(i_out + 1, tau.size)):
        seg, sg = tau[sl], sigma[sl]
        if seg.size == 0:
            continue
        base = median_filter(seg, size=min(BASELINE_BINS, seg.size | 1), mode="nearest")
        res = seg - base
        hi = res > NOISE_SIGMAS * sg
        run = hi & (np.roll(hi, 1) | np.roll(hi, -1))
        run[0] = hi[0] & hi[1] if seg.size > 1 else False
        run[-1] = hi[-1] & hi[-2] if seg.size > 1 else False
        new = np.where(run, np.clip(res, 0.0, None), 0.0)
        out[sl] = new
        stats["zeroed_outside"] += int((~run).sum())
        stats["kept_outside"] += int(run.sum())
        key = "inner" if sl.start == 0 else "outer"
        stats[f"{key}_baseline_max"] = float(base.max())
        stats[f"{key}_residual_rms_sigma"] = float(np.std(res[~run] / sg[~run]))
        stats[f"{key}_sigma_median"] = float(np.median(sg))
    return out, stats


def saturn_profile(ctx: BuildContext | None) -> tuple[dict, list[str], Profile]:
    lbl, tab = UVIS
    meta = _label(lbl)
    d = np.loadtxt(tab.fetch(), delimiter=",")
    r, tau, tmax, flag = d[:, 0], d[:, 4], d[:, 5], d[:, 11].astype(int)
    radii = _radii(r, 10.0)
    mu = abs(math.sin(math.radians(float(meta["OBSERVED_RING_ELEVATION"]))))
    sigma = photon_sigma(d[:, 3], d[:, 9], d[:, 8], d[:, 10], mu)
    missing = (tau == -1) | ((flag & 64) != 0)
    clean, stats = clean_saturn_tau(r, np.where(missing, np.nan, tau), sigma)
    tau = np.where(missing, -1.0, clean)
    tau_out = [None if m else round(float(v), 4) for v, m in zip(tau, missing)]
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
    return js, srcs, Profile(js, r, np.where(missing, np.nan, tau), float(np.median(sigma)), stats)


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
                   "at 110-190 nm and in the visible. Bins consistent with τ⊥ = 0 are set to 0 (criterion: 1σ photon "
                   "noise from the archived mean signal, background and unocculted-star models and samples per bin — "
                   f"{prof.cleaning['outer_sigma_median']:.4f} in the empty regions, where it matches the observed "
                   f"scatter): {prof.cleaning['negative_in_rings']} "
                   f"negative values inside the main rings ({prof.cleaning['main_rings_km'][0]:.0f}-"
                   f"{prof.cleaning['main_rings_km'][1]:.0f} km; {prof.cleaning['negative_beyond_3sigma']} of them "
                   "below -3σ, near sharp edges) -> 0; outside them, after removing a smooth 2010 km running-median "
                   "baseline, bins within 3σ and isolated single bins above it -> 0 "
                   f"({prof.cleaning['zeroed_outside']} bins), runs of ≥ 2 bins above 3σ kept as structure "
                   f"({prof.cleaning['kept_outside']} bins, the F ring and its strands) with the baseline removed. "
                   "Beyond the F ring this occultation's archived τ⊥ rises smoothly to "
                   f"{prof.cleaning['outer_baseline_max']:.2f} at its outer end (151 675 km) where the ring plane is "
                   "empty to far below this detection limit; the other β Cen occultation at the same elevation "
                   "(2008-343) shows a ramp of half that size and θ Car (2013-141) a steeper one: an unmodelled "
                   "instrumental trend, which the baseline removes (residual scatter "
                   f"{prof.cleaning['outer_residual_rms_sigma']:.2f}σ). Inside the C ring (72 833-"
                   f"{prof.cleaning['main_rings_km'][0]:.0f} km) the archived values are already consistent with 0 "
                   f"(scatter {prof.cleaning['inner_residual_rms_sigma']:.2f}σ).",
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
