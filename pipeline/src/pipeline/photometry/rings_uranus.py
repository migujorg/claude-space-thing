"""Uranus's rings as components (rings.json "799".components; ring_components.py for the model).

Geometry (derived): the nine main rings' inner and outer edges (IER, OER) from French et al. (2024, Table 5): precessing,
inclined keplerian ellipses at epoch TDB 1986 Jan 19 12:00 with the normal modes of their Table 6; the λ ring as a
circle at its fitted semimajor axis. Positions at any time are propagated with the fitted precession and pattern speeds.

Optical depth: the Voyager 2 PPS occultation profiles of each ring (PDS VG_2801, 1 km; β Per ingress and egress for all
nine rings, σ Sgr ingress and egress for δ, ε and λ), each placed at its cut with the PPS geometry files (ring
longitude and time of each sample) and the French et al. edges, mapped to u = (r − r_in)/(r_out − r_in) and combined.
Measured at the cuts; elsewhere τ is scaled by W_ref/W(λ) (estimated: the material per unit length of an eccentric
streamline flow is conserved, τ taken proportional to surface density; the ε ring's τ then ranges 0.4-2 between apoapse
and periapse, as observed).

Reflectance (estimated): macroscopic particles with the Callisto-like particle phase function Φ ∝ ((180° − α)/180°)^n,
n = 3.09 (Salo & French 2010, as for Saturn), spectrally flat, one particle albedo for all nine rings calibrated so
that the model reproduces the ε ring's JWST NIRCam F140M normal equivalent width (Hedman et al. 2025: 1117.6 m at
α = 2.81°, ring opening 64.1°); plus a dust term (thin, the G-ring scattering phase function of Hedman & Stark 2015)
scaled per ring to the Voyager 2 normal equivalent widths at α ≈ 172.4° (Hedman & Chancia 2021). The secure unnamed
dusty ringlets of Hedman & Chancia (2021) and the ζ ring (Hedman et al. 2023, profile at α ≈ 146.5°) are dust-only
components. The λ ring is a dust ring whose brightness was not quantified in an openly available source: optical depth
only, reflectance unknown.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from ..schema import BuildContext
from . import ring_components as rc
from .common import Download, read_table_csv
from .ring_reflectance import SALO_FRENCH

_VG2801 = "https://pds-rings.seti.org/holdings/volumes/VG_28xx/VG_2801/"
EPOCH_ET = rc.et_of_tdb_calendar(1986, 1, 19, 12.0)       # French et al. (2024) Table 5 epoch, TDB
POLE_RA_DEC = (77.311327, 15.172795)                      # French et al. (2024) Table 13 fit 1 (angular momentum)
RINGS = ("6", "5", "4", "alpha", "beta", "eta", "gamma", "delta", "lambda", "epsilon")
PPS_CODE = {"6": "6", "5": "5", "4": "4", "alpha": "A", "beta": "B", "eta": "N", "gamma": "G", "delta": "D",
            "lambda": "L", "epsilon": "E"}
NAMES = {"alpha": "α ring", "beta": "β ring", "eta": "η ring", "gamma": "γ ring", "delta": "δ ring",
         "lambda": "λ ring", "epsilon": "ε ring"}
# Margins (km) of the profile window beyond the model edges: the 1 km PPS bins smear narrow rings; the η ring has a
# ~50 km low-optical-depth extension outward and the δ ring a ~10 km one inward (Gresh et al. 1989; French et al.
# 1991; Hedman & Chancia 2021).
MARGIN_IN = {"delta": 15.0}
MARGIN_OUT = {"eta": 60.0}
MARGIN_DEFAULT = 3.0               # km (ε ring window beyond its edges)
LAMBDA_HALF_WINDOW = 8.0          # km: the λ ring (~2 km wide) has only a centreline in French et al. (2024)
SATURATED = 10.0                  # archived τ at or above this is the "no signal" sentinel (99), treated as unknown
MAX_SHIFT = 5.0                   # km: largest radius-scale offset searched between the PPS geometry and the model
CORE_PAD = 1.5                    # km: the core window extends this far beyond the model edges (1 km bins)
OPAQUE_FRACTION = 0.995           # an equivalent width at or above this fraction of W means "opaque": τ capped

PPS_CITATION = ("Voyager 2 Photopolarimeter Subsystem (PPS) ring occultation profiles and footprint geometry, data set "
                "VG2-SR/UR/NR-PPS-2/4-OCC-V1.0, NASA PDS Ring-Moon Systems Node volume VG_2801 (2003; geometry: "
                "French et al. 1988, Icarus 73, 349). Lane, A. L. et al. (1986), Photometry from Voyager 2: initial "
                "results from the uranian atmosphere, satellites, and rings, Science 233, 65-70, "
                "DOI:10.1126/science.233.4759.65.")
FRENCH = Download(
    id="french-2024-uranus", url="https://arxiv.org/pdf/2401.04634v1", subdir="papers", name="arXiv-2401.04634v1.pdf",
    title="Uranus ring orbits (keplerian elements and normal modes, Tables 5-6) and pole (Table 13)",
    citation="French, R. G., Hedman, M. M., Nicholson, P. D., Longaretti, P.-Y. & McGhee-French, C. A. (2024). The "
             "Uranus system from occultation observations (1977-2006): Rings, pole direction, gravity field, and "
             "masses of Cressida, Cordelia, and Ophelia. Icarus 411, 115957. DOI:10.1016/j.icarus.2024.115957 "
             "(manuscript arXiv:2401.04634v1).",
    notes="Tables 5 and 6 transcribed to photometry/tables/french_2024_uranus_ring_{orbits,modes}.csv "
          "(docs/sources/uranus-rings.md).")
HEDMAN_CHANCIA = Download(
    id="hedman-chancia-2021", url="https://arxiv.org/pdf/2104.14482v2", subdir="papers", name="arXiv-2104.14482v2.pdf",
    title="Uranus's narrow dusty ringlets in Voyager 2 high-phase images (Table 3: peak normal I/F, NEW)",
    citation="Hedman, M. M. & Chancia, R. O. (2021). Uranus' hidden narrow rings. Planetary Science Journal 2, 107. "
             "DOI:10.3847/PSJ/abfdb6 (arXiv:2104.14482v2).",
    notes="Table 3 transcribed to photometry/tables/hedman_chancia_2021_table3.csv.")
HEDMAN_ZETA = Download(
    id="hedman-2023-zeta", url="https://arxiv.org/pdf/2305.07190v2", subdir="papers", name="arXiv-2305.07190v2.pdf",
    title="Uranus's ζ ring in Voyager 2 WAC images (Table 5: normal I/F profile at ~146° phase)",
    citation="Hedman, M. M., Regan, I., Becker, T., Brooks, S. M., de Pater, I. & Showalter, M. (2023). Examining "
             "Uranus' ζ ring in Voyager 2 Wide-Angle-Camera observations: quantifying the ring's structure in 1986 and "
             "its modifications prior to the year 2007. Planetary Science Journal 4, 104. DOI:10.3847/PSJ/acd53f "
             "(arXiv:2305.07190v2).",
    notes="Table 5 transcribed to photometry/tables/hedman_2023_zeta_ring_146deg.csv; the 90° and 16° peak values "
          "(text) are used as checks.")
HEDMAN_JWST = Download(
    id="hedman-2025-jwst", url="https://arxiv.org/pdf/2506.18650v2", subdir="papers", name="arXiv-2506.18650v2.pdf",
    title="JWST NIRCam normal equivalent widths of the rings of Uranus and Neptune (Table 3) and geometry (Table 1)",
    citation="Hedman, M. M., de Pater, I., Cartwright, R. J., El Moutamid, M., DeColibus, R., Showalter, M. R., "
             "Tiscareno, M. S., Rowe-Gurney, N., Roman, M. T., Fletcher, L. N. & Hammel, H. B. (2025). Spectral trends "
             "across the rings and inner moons of Uranus and Neptune from JWST NIRCam images. Planetary Science "
             "Journal 6, 204. DOI:10.3847/PSJ/adf325 (arXiv:2506.18650v2).",
    notes="Table 3 (with Table 1's geometry) transcribed to photometry/tables/hedman_2025_jwst_ring_new.csv.")
HEDMAN_STARK = Download(
    id="hedman-stark-2015", url="https://arxiv.org/pdf/1508.00261v2", subdir="papers", name="arXiv-1508.00261v2.pdf",
    title="Measured scattering phase functions of Saturn's G ring and D68 (Table 7: Henyey-Greenstein fits)",
    citation="Hedman, M. M. & Stark, C. C. (2015). Saturn's G and D rings provide nearly complete measured "
             "scattering phase functions of nearby debris disks. Astrophysical Journal 811, 67. "
             "DOI:10.1088/0004-637X/811/1/67 (arXiv:1508.00261v2).",
    notes="Table 7, G ring 3-component fit (g, w) = (0.995, 0.643), (0.665, 0.176), (0.035, 0.181) in "
          "photometry/ring_components.py.")
MOLTER = Download(
    id="molter-2019", url="https://arxiv.org/pdf/1905.12566v1", subdir="papers", name="arXiv-1905.12566v1.pdf",
    title="Thermal emission from the Uranian ring system (quotes the ε ring particle albedo of Karkoschka 1997)",
    citation="Molter, E. M., de Pater, I., Roman, M. T. & Fletcher, L. N. (2019). Thermal emission from the Uranian "
             "ring system. Astronomical Journal 158, 47. DOI:10.3847/1538-3881/ab258c (arXiv:1905.12566v1). Quotes Karkoschka, E. (1997), Icarus 125, "
             "348, DOI:10.1006/icar.1996.5631 (ε ring particle albedo 0.061 ± 0.006, HST; not openly accessible) and "
             "Karkoschka (2001c) (ε ring widths 19.7 and 96.4 km at periapse and apoapse).",
    notes="Used only for checks (tests/test_rings_outer.py, docs/reports/rings.md).")
OCKERT = Download(
    id="ockert-1987-ntrs", url="https://ntrs.nasa.gov/api/citations/19880039584", subdir="papers",
    name="NTRS-19880039584.json",
    title="NASA NTRS record (abstract) of Ockert et al. (1987), Uranian ring photometry: results from Voyager 2",
    citation="Ockert, M. E., Cuzzi, J. N., Porco, C. C. & Johnson, T. V. (1987). Uranian ring photometry: Results "
             "from Voyager 2. Journal of Geophysical Research 92, 14969-14978. DOI:10.1029/JA092iA13p14969 (full "
             "text behind the publisher's bot check; the abstract via NASA NTRS record 19880039584).",
    notes="Abstract: average particle Bond albedo 0.014 ± 0.004 (Voyager clear filter); used as a check only.")
SVITEK = Download(
    id="svitek-danielson-1987-ntrs", url="https://ntrs.nasa.gov/api/citations/19880039585", subdir="papers",
    name="NTRS-19880039585.json",
    title="NASA NTRS record (abstract) of Svitek & Danielson (1987), Uranian ring albedo and azimuthal brightness",
    citation="Svitek, T. & Danielson, G. E. (1987). Azimuthal brightness variation and albedo measurements of the "
             "Uranian rings. Journal of Geophysical Research 92, 14979-14986. DOI:10.1029/JA092iA13p14979 (abstract "
             "via NASA NTRS record 19880039585).",
    notes="Abstract: ε ring particle single-scattering albedo 0.039 ± 0.006 (Lambert) or 0.023 ± 0.004 (lunar-type "
          "phase function); ε ring optical depth at apoapse 0.40 ± 0.05; used as checks only.")

N_MACRO = 3.09    # Salo & French (2010) Sec. 3.2: Callisto-like power law, "a good match to the phase function of Callisto"


def _pps(stem: str, kind: str) -> tuple[Download, Download]:
    sub = "EASYDATA/KM001/" if kind == "profile" else "GEOMETRY/"
    title = (f"Uranus ring occultation, Voyager 2 PPS {stem}" +
             (" (1 km normal optical depth profile)" if kind == "profile" else " (footprint geometry)"))
    mk = lambda ext: Download(id=f"vg2801-{stem.lower()}-{ext.lower()}" + ("-km001" if kind == "profile" else ""),  # noqa: E731
                              url=f"{_VG2801}{sub}{stem}.{ext}", subdir="rings",
                              name=f"{stem}_KM001.{ext}" if kind == "profile" else f"{stem}.{ext}",
                              title=title + (" (PDS label)" if ext == "LBL" else ""), citation=PPS_CITATION)
    return mk("LBL"), mk("TAB")


# ---------------------------------------------------------------------------------------------- orbits
@lru_cache(maxsize=1)
def orbits() -> dict[str, dict[str, dict]]:
    """ring -> feature (IER/COR/OER) -> edge dict (ring_components.edge) with the normal modes of Table 6."""
    modes: dict[tuple[str, str], list[dict]] = {}
    for r in read_table_csv("french_2024_uranus_ring_modes.csv"):
        modes.setdefault((r["ring"], r["feature"]), []).append(
            {"m": int(r["m"]), "amplitudeKm": float(r["A_km"]), "phaseDeg": float(r["delta_deg"]),
             "patternSpeedDegPerDay": float(r["patternspeed_deg_d"])})
    out: dict[str, dict[str, dict]] = {}
    for r in read_table_csv("french_2024_uranus_ring_orbits.csv"):
        num = lambda k: float(r[k]) if r.get(k) not in (None, "", "fixed") else 0.0   # noqa: E731
        out.setdefault(r["ring"], {})[r["feature"]] = rc.edge(
            float(r["a_km"]), num("ae_km"), num("varpi0_deg"), num("varpidot_deg_d"), num("asini_km"),
            num("node0_deg"), num("nodedot_deg_d"), modes.get((r["ring"], r["feature"]), []))
    return out


def edges(ring: str) -> tuple[dict, dict]:
    o = orbits()[ring]
    if ring == "lambda":
        a = o["COR"]["a"]
        return rc.edge(a - LAMBDA_HALF_WINDOW), rc.edge(a + LAMBDA_HALF_WINDOW)
    return o["IER"], o["OER"]


def width_mean(ring: str) -> float:
    """Mean width over longitude (km)."""
    lam = np.arange(0.0, 360.0, 0.25)
    i, o = edges(ring)
    return float(np.mean(rc.edge_radius(o, lam, 0.0) - rc.edge_radius(i, lam, 0.0)))


# ---------------------------------------------------------------------------------------------- PPS cuts
def _label(dl: Download) -> dict[str, str]:
    text = dl.fetch().read_text(errors="replace", encoding="utf-8")
    return {m.group(1): m.group(2).strip().strip('"') for m in
            re.finditer(r"^\s*([A-Z_0-9]+)\s*=\s*(.+?)\s*$", text, flags=re.M)}


@dataclass
class Cut:
    ring: str
    stem: str
    star: str
    direction: str
    r: np.ndarray
    tau: np.ndarray            # NaN = saturated / unknown
    sigma: np.ndarray          # half-width of the archived 68 % interval
    lam_deg: float             # ring longitude of the cut at the ring
    t_days: float              # TDB days from the French et al. epoch
    r_in: float
    r_out: float
    shift_km: float            # PPS radius scale − French et al. (2024), from matching the ring
    mu_occ: float              # |sin| of the line of sight's elevation above the ring plane (cos incidence)
    sources: list[str]


def _utc_to_et(utc: str) -> float:
    from ..validation.geometry import utc_to_et
    return utc_to_et(utc)


def load_cut(ring: str, star: str, direction: str, ctx: BuildContext | None = None,
             shift: float | None = None) -> Cut | None:
    exp = "PU2" if star == "beta" else "PU1"
    code = PPS_CODE[ring] + ("I" if direction == "ingress" else "E")
    plbl, ptab = _pps(f"{exp}P01{code}", "profile")
    glbl, gtab = _pps(f"{exp}G01{code}", "geometry")
    try:
        d = np.loadtxt(ptab.fetch(), delimiter=",")
        g = np.loadtxt(gtab.fetch(), delimiter=",", usecols=(1, 2, 3))
    except RuntimeError:
        return None
    meta = _label(plbl)
    if "0:00:00 UTC on\n24 January, 1986" not in glbl.fetch().read_text(errors="replace"):
        raise ValueError(f"{glbl.id}: unexpected RING_INTERCEPT_TIME origin")
    r, tau, lo, hi = d[:, 0], d[:, 3].copy(), d[:, 4], d[:, 5]
    tau[tau >= SATURATED] = np.nan
    sigma = 0.5 * (hi - lo)
    gr, gt, glon = g[:, 1], g[:, 0], g[:, 2]
    order = np.argsort(gr)
    lon_unwrapped = np.unwrap(np.radians(glon[order]))
    t0 = _utc_to_et("1986-01-24T00:00:00")     # RING_INTERCEPT_TIME origin (GEOMETRY/*.LBL)
    i_e = edges(ring)

    def model_at(radius: float) -> tuple[float, float, float, float]:
        lam = float(np.degrees(np.interp(radius, gr[order], lon_unwrapped)) % 360.0)
        t_days = (t0 + float(np.interp(radius, gr[order], gt[order])) - EPOCH_ET) / rc.DAY
        return lam, t_days, float(rc.edge_radius(i_e[0], lam, t_days)), float(rc.edge_radius(i_e[1], lam, t_days))

    lam, t_days, r_in, r_out = model_at(float(np.mean(r)))
    lam, t_days, r_in, r_out = model_at(0.5 * (r_in + r_out))
    # Radius-scale offset of the PPS geometry (French et al. 1988) from French et al. (2024): slide a box of the model
    # width over the profile within +-MAX_SHIFT km to the largest integrated tau (the archives agree within ~2 km).
    if shift is None:
        best, shift = -np.inf, 0.0
        for s in np.arange(-MAX_SHIFT, MAX_SHIFT + 1e-6, 0.25):
            m = (r >= r_in + s - 0.5) & (r <= r_out + s + 0.5)
            v = np.nansum(tau[m])
            if v > best:
                best, shift = v, s
    lam, t_days, r_in, r_out = model_at(0.5 * (r_in + r_out) + shift)
    mu_occ = math.cos(math.radians(float(meta["INCIDENCE_ANGLE"])))
    srcs = [x.register(ctx) if ctx else x.id for x in (plbl, ptab, glbl, gtab)]
    return Cut(ring, f"{exp}P01{code}", meta.get("STAR_NAME", star).title(), direction, r, tau, sigma, lam,
               t_days, r_in, r_out, shift, mu_occ, srcs)


def _plan(ring: str) -> list[tuple[str, str]]:
    return [("sigma", "ingress"), ("sigma", "egress")] if ring == "lambda" else \
        [("beta", "ingress"), ("beta", "egress")] + ([("sigma", "ingress"), ("sigma", "egress")]
                                                     if ring in ("delta", "epsilon") else [])


@lru_cache(maxsize=None)
def occultation_shifts() -> dict[tuple[str, str], float]:
    """Radius-scale offset per occultation cut (star, direction): the median of the rings' individual best offsets
    (one ring's own offset is noise-limited for the faint narrow rings)."""
    per: dict[tuple[str, str], list[float]] = {}
    for ring in RINGS:
        if ring == "lambda":
            continue
        for star, direction in _plan(ring):
            c = load_cut(ring, star, direction)
            if c is not None:
                per.setdefault((star, direction), []).append(c.shift_km)
    return {k: float(np.median(v)) for k, v in per.items()}


def ring_cuts(ring: str, ctx: BuildContext | None = None) -> list[Cut]:
    shifts = occultation_shifts()
    out = []
    for star, direction in _plan(ring):
        c = load_cut(ring, star, direction, ctx, shift=shifts.get((star, direction)))
        if c is not None:
            out.append(c)
    return out


@dataclass
class RingProfile:
    ring: str
    u: np.ndarray
    tau_ref: np.ndarray        # normal optical depth at width w_ref
    w_ref: float
    cuts: list[Cut]
    ed_cuts: list[float]       # per cut: normal equivalent depth (km) of the core (square well) or profile
    ed: float                  # integral of tau_ref du * w_ref (km)
    noise: float               # cut-to-cut scatter of the equivalent depth (km)
    method: str


def _mapped(cuts: list[Cut], u: np.ndarray, w_ref: float, lo_km: float, hi_km: float) -> np.ndarray:
    """Mean over cuts (equal weights) of tau*W/W_ref at u, where u lies within [-lo_km/W, 1 + hi_km/W] of each cut."""
    num, den = np.zeros_like(u), np.zeros_like(u)
    for c in cuts:
        w = c.r_out - c.r_in
        rr = c.r_in + c.shift_km + u * w
        t = np.interp(rr, c.r, c.tau)
        ok = (u >= -lo_km / w) & (u <= 1.0 + hi_km / w) & (rr >= c.r[0]) & (rr <= c.r[-1]) & np.isfinite(t)
        num[ok] += t[ok] * w / w_ref
        den[ok] += 1.0
    return np.where(den > 0, num / np.where(den > 0, den, 1.0), 0.0)


def combine(ring: str, cuts: list[Cut]) -> RingProfile:
    """One normal optical-depth profile in u at the reference (mean) width W_ref, from all cuts (tau*W conserved).

    * epsilon (resolved, 20-97 km at 1 km bins): each cut's tau mapped to u and scaled by W_cut/W_ref, averaged with
      equal weights (bins without signal, archived tau = 99, are skipped).
    * The other rings are 1-10 km wide, only partly resolved by the 1 km bins: smoothing conserves the slant
      equivalent width EW = int(1 - exp(-tau/mu_occ)) dr, not int tau dr. Each cut gives a square well over the French
      et al. edges with W(1 - exp(-tau_sq/mu_occ)) = EW (the square-well model French et al. use for the edges),
      EW summed in the core window [r_in - 1.5 km, r_out + 1.5 km]; the eta ring's outer and the delta ring's inner
      low-optical-depth shoulders are kept from the mapped profiles.
    * lambda: the sigma Sgr profiles within +-8 km of the centreline, as archived (tau <= 0.1, unsaturated)."""
    w_ref = width_mean(ring) if ring != "lambda" else 2 * LAMBDA_HALF_WINDOW
    if ring in ("epsilon", "lambda"):
        widths = [c.r_out - c.r_in for c in cuts]
        du = max(min(0.5 / max(w, 0.5) for w in widths), 0.004)
        m = MARGIN_DEFAULT if ring == "epsilon" else 0.0
        u = np.arange(-m / min(widths), 1.0 + m / min(widths) + 0.5 * du, du)
        tau_ref = _mapped(cuts, u, w_ref, m, m)
        eds = []
        for c in cuts:
            win = (c.r >= c.r_in + c.shift_km - m) & (c.r <= c.r_out + c.shift_km + m)
            eds.append(float(np.nansum(c.tau[win]) * (c.r[1] - c.r[0])))
        ed_raw = float(np.sum(tau_ref) * du * w_ref)
        clipped = np.clip(tau_ref, 0.0, None)
        if clipped.sum() > 0 and ed_raw > 0:
            clipped *= ed_raw / (np.sum(clipped) * du * w_ref)   # negative noise clipped, int tau dr kept
        return RingProfile(ring, u, clipped, w_ref, cuts, eds, ed_raw, float(np.std(eds)),
                           "mapped profiles, equal weights, negative noise clipped with the integral kept")
    m_in = MARGIN_IN.get(ring, 0.0)
    m_out = MARGIN_OUT.get(ring, 0.0)
    eds, taus = [], []
    for c in cuts:
        # A cut where the fitted edges nearly touch (the γ ring's m = 0 mode can bring them within the 1 km
        # resolution) is treated as 1 km wide about their mean.
        w = max(c.r_out - c.r_in, 1.0)
        mid = 0.5 * (c.r_in + c.r_out) + c.shift_km
        win = (c.r >= mid - 0.5 * w - CORE_PAD) & (c.r <= mid + 0.5 * w + CORE_PAD)
        trans = np.where(np.isfinite(c.tau[win]), np.exp(-np.nan_to_num(c.tau[win]) / c.mu_occ), 0.0)
        ew = float(np.sum(1.0 - trans) * (c.r[1] - c.r[0]))
        frac = min(ew / w, OPAQUE_FRACTION)
        tau_sq = -c.mu_occ * math.log(1.0 - frac) if frac > 0 else 0.0
        taus.append(tau_sq)
        eds.append(tau_sq * w)
    ed_core = float(np.mean(eds))
    lo = m_in / w_ref
    hi = m_out / w_ref
    du = max(1.0 / 64, (1.0 + lo + hi) / 200)
    u = np.arange(-math.ceil(lo / du) * du, 1.0 + math.ceil(hi / du) * du + 0.5 * du, du)
    tau_ref = np.where((u >= 0.0) & (u <= 1.0), ed_core / w_ref, 0.0)
    if m_in > 0 or m_out > 0:
        sh = _mapped(cuts, u, w_ref, m_in, m_out)
        shoulder = ((u < -CORE_PAD / w_ref) & (u >= -lo)) | ((u > 1.0 + CORE_PAD / w_ref) & (u <= 1.0 + hi))
        sh_ed = float(np.sum(sh[shoulder]) * du * w_ref)
        sh = np.clip(sh, 0.0, None)
        if sh_ed > 0 and sh[shoulder].sum() > 0:
            sh *= sh_ed / (np.sum(sh[shoulder]) * du * w_ref)
            tau_ref = np.where(shoulder, sh, tau_ref)
    ed = float(np.sum(tau_ref) * du * w_ref)
    method = ("square-well core (per-cut tau " + ", ".join(f"{t:.2f}" for t in taus) +
              " from the slant equivalent widths)" + ("; shoulder from the mapped profiles" if (m_in or m_out) else ""))
    return RingProfile(ring, u, tau_ref, w_ref, cuts, eds, ed, float(np.std(eds)), method)


# ---------------------------------------------------------------------------------------------- photometry
def macro_phi(alpha):
    return rc.power_law(alpha, N_MACRO)


def lit_new(prof: RingProfile, mu: float, mu0: float, n_lon: int = 720) -> float:
    """Longitude-averaged normal equivalent width per unit layer amplitude L (I/F = L·μ0/(4(μ+μ0))·[1−e^{−τm}]): km."""
    i_e, o_e = edges(prof.ring)
    lam = np.arange(n_lon) * 360.0 / n_lon
    w = rc.edge_radius(o_e, lam, 0.0) - rc.edge_radius(i_e, lam, 0.0)
    m = 1.0 / mu + 1.0 / mu0
    du = prof.u[1] - prof.u[0]
    tot = 0.0
    for wi in w:
        tau = prof.tau_ref * prof.w_ref / wi
        tot += wi * np.sum(1.0 - np.exp(-tau * m)) * du
    return mu * mu0 / (4.0 * (mu + mu0)) * tot / n_lon


@dataclass
class Calibration:
    p: float                    # particle geometric albedo implied (W(0)/4)
    layer_scale: float          # L(α) = layer_scale·Φ(α)
    new_eps_model: float
    new_6_delta_model: float
    new_6_delta_measured: float
    new_eps_measured: float
    bond: float
    mu: float
    mu0: float
    alpha: float


def jwst_sun_elevation() -> float:
    """Elevation of the Sun above Uranus's ring plane at the JWST observation (2023-09-04, DD 2739 obs. 11)."""
    import spiceypy as sp
    from ..validation.geometry import kernels
    ra, dec = (math.radians(x) for x in POLE_RA_DEC)
    pole = np.array([math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)])
    with kernels():
        et = sp.str2et("2023-09-04T12:00:00")
        s, _ = sp.spkpos("10", et, "J2000", "LT", "7")
        e, _ = sp.spkpos("399", et, "J2000", "LT", "7")
    s, e = np.asarray(s), np.asarray(e)
    b_sun = math.degrees(math.asin(abs(pole @ s) / np.linalg.norm(s)))
    b_earth = math.degrees(math.asin(abs(pole @ e) / np.linalg.norm(e)))
    alpha = math.degrees(math.acos(s @ e / np.linalg.norm(s) / np.linalg.norm(e)))
    return b_sun, b_earth, alpha


def calibrate(profiles: dict[str, RingProfile]) -> Calibration:
    rows = {(r["planet"], r["filter"], r["feature"]): r for r in read_table_csv("hedman_2025_jwst_ring_new.csv")}
    eps = rows[("uranus", "F140M", "epsilon")]
    six = rows[("uranus", "F140M", "6-delta")]
    b_obs, alpha = float(eps["ring_opening_deg"]), float(eps["phase_deg"])
    b_sun, b_earth, alpha_eph = jwst_sun_elevation()
    mu, mu0 = math.sin(math.radians(b_obs)), math.sin(math.radians(b_sun))
    k_eps = lit_new(profiles["epsilon"], mu, mu0)
    phi = float(macro_phi(alpha))
    new_eps = float(eps["new_m"]) / 1000.0
    layer_scale = new_eps / (k_eps * phi)
    k6 = sum(lit_new(profiles[r], mu, mu0) for r in ("6", "5", "4", "alpha", "beta", "eta", "gamma", "delta"))
    q = rc.phase_integral(macro_phi)
    p = layer_scale / 4.0
    return Calibration(p, layer_scale, k_eps * layer_scale * phi * 1000.0, k6 * layer_scale * phi * 1000.0,
                       float(six["new_m"]), float(eps["new_m"]), p * q, mu, mu0, alpha)


# ---------------------------------------------------------------------------------------------- dust
def g_spf(alpha):
    return rc.g_ring_vs_phase(alpha) / rc.g_ring_vs_phase(90.0)


@lru_cache(maxsize=1)
def voyager_dust() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in read_table_csv("hedman_chancia_2021_table3.csv"):
        out.setdefault(r["feature"], []).append(r)
    return out


def dust_scale(ring: str, prof: RingProfile, cal: Calibration) -> tuple[float, str] | None:
    """thin.scale so that D(α)·ED/4 reproduces the Voyager NEW at the image's phase (mean over images)."""
    rows = voyager_dust().get(ring)
    if not rows:
        return None
    new = np.mean([float(r["new_m"]) for r in rows]) / 1000.0
    alpha = np.mean([float(r["phase_deg"]) for r in rows])
    # The macroscopic term at this geometry (unlit face, nearly normal view) is < 1e-4 of the measured NEW: ignored.
    scale = 4.0 * new / (float(g_spf(alpha)) * prof.ed)
    imgs = ", ".join(sorted({r["image"] for r in rows}))
    return scale, (f"NEW {new * 1000:.3f} m at α = {alpha:.1f}° (Voyager 2 NAC {imgs}; mean of {len(rows)} "
                   f"image{'s' if len(rows) > 1 else ''})")


# ---------------------------------------------------------------------------------------------- JSON
def build(ctx: BuildContext | None = None) -> tuple[dict, dict]:
    reg = (lambda dl: dl.register(ctx)) if ctx else (lambda dl: dl.id)
    s_french, s_hc, s_zeta, s_jwst, s_hs, s_sf = (reg(d) for d in (FRENCH, HEDMAN_CHANCIA, HEDMAN_ZETA, HEDMAN_JWST,
                                                                    HEDMAN_STARK, SALO_FRENCH))
    checks = {"karkoschka-1997 (via molter-2019)": reg(MOLTER), "ockert-1987": reg(OCKERT),
              "svitek-danielson-1987": reg(SVITEK)}
    profiles = {ring: combine(ring, ring_cuts(ring, ctx)) for ring in RINGS}
    cal = calibrate(profiles)
    tables = {
        "uranus-macro": rc.phase_table(
            "macroscopic ring particles (Callisto-like power law, spectrally flat)",
            macro_phi(np.asarray(rc.PHASE_GRID)), "estimated", [s_sf, s_jwst],
            f"Φ(α) = ((180° − α)/180°)^{N_MACRO} (Salo & French 2010 Sec. 3.2, after Dones et al. 1993), Φ(0) = 1, the "
            "same in X, Y, Z and scotopic (no visible colour measurement of the Uranian ring particles was openly "
            "available: reflectance assumed spectrally flat from the JWST 1.4 µm calibration into the visible)."),
        "g-ring-spf": rc.phase_table(
            "dust (Saturn's G-ring scattering phase function)", g_spf(np.asarray(rc.PHASE_GRID)), "estimated", [s_hs],
            "Three-component Henyey-Greenstein fit to Saturn's G-ring scattering phase function measured by Cassini "
            "at scattering angles 0.5-170° (Hedman & Stark 2015, Table 7), normalized to 1 at α = 90°, spectrally "
            "flat. Used as the analog for Uranus's dusty rings: Hedman et al. (2023) find the ζ ring's three Voyager "
            "phase points follow it within the scatter of other dusty rings.", domain=(0.0, 179.5)),
    }
    comps: list[rc.Component] = []
    diag: dict = {"calibration": cal, "profiles": profiles, "checks": {}}
    geo_method = ("Inner and outer edges from French et al. (2024) Table 5 keplerian elements (IER, OER) and Table 6 "
                  "normal modes at epoch TDB 1986-01-19 12:00, propagated with the fitted apsidal, nodal and pattern "
                  "speeds; the band lies in the ring's inclined plane (a sin i of its centreline).")
    for ring in RINGS:
        prof = profiles[ring]
        i_e, o_e = edges(ring)
        cor = orbits()[ring]["COR"]
        o_e = dict(o_e, aSinI=cor["aSinI"], node0Deg=cor["node0Deg"], nodeDotDegPerDay=cor["nodeDotDegPerDay"])
        i_e = dict(i_e, aSinI=cor["aSinI"], node0Deg=cor["node0Deg"], nodeDotDegPerDay=cor["nodeDotDegPerDay"])
        cuts = ", ".join(f"{c.star} {c.direction} (λ = {c.lam_deg:.1f}°, W = {c.r_out - c.r_in:.2f} km, PPS radius "
                         f"scale {c.shift_km:+.2f} km)" for c in prof.cuts)
        srcs = sorted({s for c in prof.cuts for s in c.sources})
        layer = None if ring == "lambda" else {"phaseFunction": "uranus-macro", "scale": round(cal.layer_scale, 6)}
        ds = None if ring == "lambda" else dust_scale(ring, prof, cal)
        thin = {"phaseFunction": "g-ring-spf", "scale": float(f"{ds[0]:.5g}")} if ds else None
        if ring == "lambda":
            refl = rc.Prov("unknown", [], "The λ ring is a dust ring (brightest in Voyager's high-phase images); no "
                           "openly available measurement quantifies its brightness: optical depth only, reflectance "
                           "not measured.")
        else:
            refl = rc.Prov("estimated", [s_jwst, s_sf] + ([s_hc, s_hs] if ds else []),
                           f"Macroscopic particles: layer amplitude L(α) = {cal.layer_scale:.4f}·Φ(α) (particle "
                           f"geometric albedo {cal.p:.4f}) from the ε ring's JWST F140M NEW (1117.6 m at α = 2.81°) "
                           "with the occultation optical depths, assumed spectrally flat into the visible. " +
                           (f"Dust: D(α) = {ds[0]:.4g}·SPF(α), the G-ring phase function scaled to the Voyager "
                            f"{ds[1]}, distributed like τ." if ds else
                            "Dust: no peak at this ring in Voyager's high-phase images (Hedman & Chancia 2021): none."))
        comps.append(rc.Component(
            id=f"uranus-{ring}", name=NAMES.get(ring, f"ring {ring}"), inner=i_e, outer=o_e,
            u_start=float(prof.u[0]), u_step=float(prof.u[1] - prof.u[0]), profile=prof.tau_ref,
            width_ref_km=prof.w_ref, width_scaling=ring != "lambda", optical_depth_known=True,
            geometry=rc.Prov("derived", [s_french], geo_method if ring != "lambda" else
                             f"Circular band ±{LAMBDA_HALF_WINDOW} km about the λ ring's fitted semimajor axis (French "
                             "et al. 2024 Table 5; its eccentricity and inclination were held at 0)."),
            optical_depth=rc.Prov(
                "estimated", srcs,
                f"Normal optical depth from the Voyager 2 PPS (264 nm, 1 km) cuts {cuts}, each mapped to u = (r − "
                f"r_in)/(r_out − r_in) with the French et al. edges at the cut's longitude and time, scaled to the "
                f"mean width {prof.w_ref:.2f} km (τ·W conserved) and averaged with inverse-variance weights; "
                f"negative noise clipped with ∫τ dr kept ({prof.ed:.3f} km). Measured at the cuts; at other "
                "longitudes τ = τ_ref·W_ref/W(λ) (estimated: streamline mass conservation)."),
            reflectance=refl, layer=layer, thin=thin))
        diag["checks"][ring] = {"ed_km": prof.ed, "ed_cuts": prof.ed_cuts, "noise": prof.noise,
                                "shifts": [c.shift_km for c in prof.cuts]}
    # Dust-only ringlets (circular, Gaussian of the measured FWHM and NEW) and the ζ ring.
    for feat, rows in voyager_dust().items():
        if not feat.startswith("U"):
            continue
        r0 = float(np.mean([float(r["observed_radius_km"]) for r in rows]))
        fwhm = float(np.mean([float(r["fwhm_km"]) for r in rows]))
        new = float(np.mean([float(r["new_m"]) for r in rows])) / 1000.0
        alpha = float(np.mean([float(r["phase_deg"]) for r in rows]))
        half = 2.0 * fwhm
        u = np.linspace(0.0, 1.0, 41)
        x = (u - 0.5) * 2 * half
        sig = fwhm / 2.3548
        g = np.exp(-0.5 * (x / sig) ** 2)
        prof_v = g * new / (np.sum(g) * (u[1] - u[0]) * 2 * half)
        comps.append(rc.Component(
            id=f"uranus-{feat.lower()}", name=f"dusty ringlet {feat}", inner=rc.edge(r0 - half), outer=rc.edge(r0 + half),
            u_start=0.0, u_step=float(u[1] - u[0]), profile=prof_v, width_ref_km=2 * half, width_scaling=False,
            optical_depth_known=False,
            geometry=rc.Prov("estimated", [s_hc], f"Circle at the observed radius {r0:.0f} km (Voyager 2, 1986); its "
                             "eccentricity and inclination are not measured."),
            optical_depth=rc.Prov("unknown", [], "Not detected in occultations; brightness only."),
            reflectance=rc.Prov("estimated", [s_hc, s_hs],
                                f"Gaussian of FWHM {fwhm:.1f} km with normal equivalent width {new * 1000:.3f} m at α = "
                                f"{alpha:.1f}° (Hedman & Chancia 2021 Table 3, mean of {len(rows)} image(s); ±25 %), "
                                "scaled to other phase angles with the G-ring phase function."),
            thin={"phaseFunction": "g-ring-spf", "scale": float(f"{4.0 / float(g_spf(alpha)):.6g}")}))
    zrows = read_table_csv("hedman_2023_zeta_ring_146deg.csv")
    zr = np.array([float(r["radius_km"]) for r in zrows])
    zv = np.array([float(r["normal_iof_1e6"]) for r in zrows]) * 1e-6
    keep = (zr >= 33300.0) & (zr <= 41500.0)
    zr, zv = zr[keep], np.clip(zv[keep], 0.0, None)
    z_alpha = float(np.mean([147.07, 146.69, 145.76]))
    comps.append(rc.Component(
        id="uranus-zeta", name="ζ ring", inner=rc.edge(float(zr[0])), outer=rc.edge(float(zr[-1])),
        u_start=0.0, u_step=float((zr[1] - zr[0]) / (zr[-1] - zr[0])), profile=zv, width_ref_km=float(zr[-1] - zr[0]),
        width_scaling=False, optical_depth_known=False,
        geometry=rc.Prov("measured", [s_zeta], "Circular, 33,300-41,500 km (Voyager 2 WAC, 1986; Hedman et al. "
                         "2023 Table 5). Its 2007 form (de Pater et al. 2007) differs: the 1986 profile is shown."),
        optical_depth=rc.Prov("unknown", [], "Below the occultation detection limit; brightness only."),
        reflectance=rc.Prov("estimated", [s_zeta, s_hs],
                            f"Normal I/F profile at α ≈ {z_alpha:.1f}° (Hedman et al. 2023 Table 5, 1986, negative "
                            "values clipped), scaled to other phase angles with the G-ring phase function (their Fig. "
                            "10: the three Voyager phase points follow it within the scatter of other dusty rings)."),
        thin={"phaseFunction": "g-ring-spf", "scale": float(f"{4.0 / float(g_spf(z_alpha)):.6g}")}))
    diag["zeta"] = {"alpha": z_alpha, "peak": float(zv.max())}
    notes = (f"Particle albedo from the ε ring JWST NEW: p = {cal.p:.4f} (Bond {cal.bond:.4f} with the power law); "
             f"6-δ rings predicted {cal.new_6_delta_model:.0f} m vs JWST {cal.new_6_delta_measured:.0f} m "
             f"(F140M). Ring-plane elevations at the JWST observation: observer {math.degrees(math.asin(cal.mu)):.1f}°, "
             f"Sun {math.degrees(math.asin(cal.mu0)):.2f}° (de442s). Checks: docs/reports/rings.md.")
    model = rc.model_json(comps, tables, EPOCH_ET, notes, pole_sense=-1)
    label = rc.components_label(comps, tables)
    diag["checks_sources"] = checks
    return {"model": model, "label": label, "sources": sorted({s for c in comps for s in
                                                              c.geometry.sources + c.optical_depth.sources +
                                                              c.reflectance.sources} | {s_hs, s_sf})}, diag
