"""Stage `stars`: the star field seen from inside the solar system (M1).

Output: stars/bright.json (BinaryTableHeader) + stars/bright.bin (48-byte records, see stars_format.py) and
stars/names.json. Every star brighter than the completeness limit, with

* direction: ICRF unit vector at the window's mid-epoch, from Gaia DR3 or Hipparcos (van Leeuwen 2007)
  astrometry (Tycho-2 for the few stars neither has), propagated by rigorous linear space motion;
* light: illuminance at the observer X, Y (lux), Z, S (scotopic lux), from, in order of preference,
  1. a measured HST/STIS CALSPEC spectrum,
  2. the star's own Gaia DR3 XP spectrophotometry (G >= XP_G_MIN),
  3. Pulkovo ground-based spectrophotometry 320-1080 nm (bright stars Gaia cannot measure well),
  4. measured broadband photometry + colour, converted with an empirical relation calibrated on XP-derived
     stars of the same colour (`estimated`).

See docs/reports/stars.md for the data-driven choices (XP_G_MIN, cross-match radii) and verification.
"""

from __future__ import annotations

import datetime as _dt
import os
import hashlib
import json
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from .. import cie
from .. import stars_astrometry as sa
from .. import stars_catalogs as sc
from .. import stars_format as sf
from .. import stars_gaia as sg
from .. import stars_light as sl
from ..download import record
from ..output import write_bin, write_json
from ..paths import CACHE, RAW
from ..schema import LABEL_ORDER, BuildContext, SourceRecord

DEPENDS: tuple[str, ...] = ()


def _import_astropy() -> None:
    """Import the astropy modules this stage uses, working around colour-science's matplotlib mock.

    When matplotlib is not installed, `import colour` puts a unittest.mock.MagicMock in sys.modules['matplotlib'];
    astropy's optional-dependency probe (importlib.util.find_spec) then raises "matplotlib.__spec__ is not set"
    while importing astropy.time. Hide the mock during the import (other stages may have imported colour first).
    """
    import sys
    mock = sys.modules.get("matplotlib")
    hide = mock is not None and getattr(mock, "__spec__", None) is None
    if hide:
        del sys.modules["matplotlib"]
    try:
        import astropy.coordinates  # noqa: F401
        import astropy.table  # noqa: F401
        import astropy.time  # noqa: F401
    finally:
        if hide:
            sys.modules["matplotlib"] = mock


_import_astropy()

#: Gaia sources brighter than this G are catalogue records. G <= V + 0.1 for every normal star (Riello et al.
#: 2021, Table C.2 relations), so this makes the catalogue complete to V ~ 9.9 wherever Gaia is complete.
G_LIMIT = 10.0
#: Stars Gaia DR3 does not have (Hipparcos- or Tycho-2-only) are included when their V is brighter than this.
V_LIMIT = 10.0
#: Gaia sources fetched for cross-matching go deeper than G_LIMIT so that a Hipparcos/Tycho star near the limit
#: finds its Gaia counterpart instead of being added twice.
G_XMATCH = 10.5
#: Tycho-2 query depth (VT is up to ~1.5 mag fainter than V for red stars... and brighter for none).
VT_QUERY = 11.0
#: Gaia XP spectra are used for G >= XP_G_MIN. Chosen from the data: below it the XP-derived Y departs from the
#: Hipparcos-V prediction and from Pulkovo spectrophotometry (docs/reports/stars.md, "XP bright limit").
XP_G_MIN = 4.0
#: Positional cross-match radii (arcsec) at the Gaia epoch; a match needs G - m < XM_DMAG (Gaia not much fainter).
XM_RADIUS_HIP = 1.5
XM_RADIUS_TYC = 2.0
XM_DMAG = 1.5
#: Second positional pass for Hipparcos stars still unmatched (astrometric binaries whose Hipparcos proper motion is
#: perturbed land 1.5-3" off at J2016): wider radius, two-sided magnitude agreement.
XM_RADIUS_HIP2 = 4.0
XM_DMAG2 = 1.0
#: Hipparcos multiple entries with combined photometry: other catalogue records within max(SYS_MIN_RADIUS,
#: rho + SYS_MARGIN) arcsec of the entry are treated as its components when reconciling the system's light.
#: Orbital motion since J1991.25 and photocentre offsets reach several arcsec (70 Oph: 4"); the chance of an
#: unrelated G < 10.5 star within 10" is ~5e-4 per system (19 such stars per square degree).
SYS_MARGIN = 2.0
SYS_MIN_RADIUS = 10.0
#: Gaia BP/RP windows are 3.5" x 2.1": a source with a neighbour no more than XP_BLEND_DMAG fainter within
#: XP_BLEND_RADIUS has blended XP spectra/BP-RP (each component's spectrum holds both stars' light), so its XP flux
#: is not used; its resolved G (astrometric field) with the blended colour is.
XP_BLEND_RADIUS = 2.0
XP_BLEND_DMAG = 2.5
#: Two Gaia sources closer than this with G within DUP_DMAG, the brighter with G < DUP_GMAX: a spurious duplicate
#: of a very bright star (zeta Her: two sources 0.26" apart, G = 2.76 and 2.72; its companion is 5.5 mag, 1.5" away).
DUP_SEP = 0.4
DUP_DMAG = 0.15
DUP_GMAX = 5.0
#: Spectrophotometric catalogue V must agree with the record's Hipparcos V within this (same light).
SPEC_V_TOL = 0.10

GAIA_EPOCH = 2016.0
TYCHO_EPOCH = 2000.0

SRC_GAIA = "gaia-dr3"
SRC_XP = "gaia-dr3-xp-sampled"
SRC_HIPXM = "gaia-dr3-hipparcos2-xmatch"
SRC_TYC = "tycho-2"
SRC_HIP2 = "hipparcos-2007"
SRC_HIP1 = "hipparcos-1997"
SRC_PULKOVO = "pulkovo-spectrophotometry"
SRC_CALSPEC = "hst-calspec"
SRC_SIMBAD = "simbad-sesame"
SRC_IAU = "iau-wgsn-csn"
SRC_XIDX = "kostjuk-2002-crossindex"


def log(msg: str) -> None:
    print(f"[stars] {msg}", flush=True)


# ============================================================================================ inputs

@dataclass
class Gaia:
    cols: dict[str, np.ndarray]
    paths: list

    def __getitem__(self, k):
        return self.cols[k]

    @property
    def n(self):
        return self.cols["source_id"].size


#: Columns that must be floats even when a CSV slice happens to hold only integers or only nulls.
_FLOAT_COLS = {"ra", "dec", "ra_error", "dec_error", "parallax", "parallax_error", "pmra", "pmdec", "pmra_error",
               "pmdec_error", "radial_velocity", "radial_velocity_error", "ruwe", "phot_g_mean_mag",
               "phot_bp_mean_mag", "phot_rp_mean_mag", "phot_bp_rp_excess_factor", "ipd_frac_multi_peak",
               "ref_epoch", "ra_mdeg", "de_mdeg", "pm_ra", "pm_de", "e_ra_mdeg", "e_de_mdeg", "e_pm_ra", "e_pm_de",
               "ra_deg", "de_deg", "ep_ra1990", "ep_de1990", "bt_mag", "vt_mag", "e_bt_mag", "e_vt_mag",
               "angular_distance"}


def _column(name: str, c) -> np.ndarray:
    """astropy column (possibly masked) from a Gaia archive CSV -> plain numpy array. Nulls: NaN / 0 / ''."""
    kind = c.dtype.kind
    if name in _FLOAT_COLS:
        a = np.ma.asarray(c)
        if a.dtype.kind in "SU":  # an all-null column parses as strings
            a = np.ma.masked_array(np.full(len(a), np.nan), mask=True)
        return np.ma.filled(a.astype(np.float64), np.nan)
    if kind in "SUO":
        a = np.ma.filled(np.ma.asarray(c).astype(str), "")
        a = np.char.strip(a.astype(str))
        low = np.char.lower(a)
        if a.size and np.isin(low, ["true", "false"]).all():
            return low == "true"
        return a
    if kind == "b":
        return np.ma.filled(np.ma.asarray(c), False).astype(bool)
    if kind == "f":
        return np.ma.filled(np.ma.asarray(c), np.nan)
    return np.ma.filled(np.ma.asarray(c), 0)


def load_table(path) -> dict[str, np.ndarray]:
    from astropy.table import Table
    t = Table.read(path, format="ascii.csv")
    return {name: np.asarray(_column(name, t[name])) for name in t.colnames}


def load_gaia(paths) -> Gaia:
    parts = [load_table(p) for p in paths]
    cols = {name: np.concatenate([p[name] for p in parts]) for name in sg.GAIA_COLUMNS}
    o = np.argsort(cols["source_id"])
    cols = {k: v[o] for k, v in cols.items()}
    return Gaia(cols=cols, paths=list(paths))


# ============================================================================================ records

@dataclass
class Records:
    """Column store for the output catalogue (one entry per star)."""
    kind: list = field(default_factory=list)      # 'gaia' | 'hip' | 'tyc'
    gi: list = field(default_factory=list)        # index into Gaia arrays or -1
    hi: list = field(default_factory=list)        # index into HIP2/HIPmain arrays or -1
    ti: list = field(default_factory=list)        # index into Tycho arrays or -1

    def arrays(self):
        return (np.array(self.kind), np.array(self.gi, dtype=np.int64), np.array(self.hi, dtype=np.int64),
                np.array(self.ti, dtype=np.int64))


def nearest(tree_pts: np.ndarray, query_pts: np.ndarray, radius_arcsec: float):
    """Nearest neighbour within radius. Returns (index or -1, separation arcsec)."""
    tree = cKDTree(tree_pts)
    chord = 2.0 * np.sin(np.radians(radius_arcsec / 3600.0) / 2.0)
    d, i = tree.query(query_pts, k=1, distance_upper_bound=chord)
    ok = np.isfinite(d)
    sep = np.where(ok, np.degrees(2.0 * np.arcsin(np.minimum(d, 2.0) / 2.0)) * 3600.0, np.nan)
    return np.where(ok, i, -1), sep


# ============================================================================================ run

def run(ctx: BuildContext) -> None:
    today = _dt.date.today().isoformat()
    epoch = sa.et_to_jyear(0.5 * (ctx.start_et + ctx.end_et))
    epoch_et = 0.5 * (ctx.start_et + ctx.end_et)
    log(f"target epoch J{epoch:.4f} (et {epoch_et:.0f})")
    diag: dict = {"epochJyear": epoch}

    # ---------------------------------------------------------------------------------------- load
    gaia = load_gaia(sg.fetch_gaia_sources(G_XMATCH))
    log(f"Gaia DR3 sources G < {G_XMATCH}: {gaia.n}")
    hipxm = load_table(sg.fetch_hip_xmatch())
    tyc = load_table(sg.fetch_tycho_unmatched(VT_QUERY))
    log(f"Gaia-HIP2 best neighbours: {hipxm['source_id'].size}; Tycho-2 without Gaia neighbour, VT<{VT_QUERY}: "
        f"{tyc['id'].size}")
    hip2 = sc.load_hip2()
    hipm = sc.load_hip_main()
    # Align Hipparcos 1997 rows to HIP2 rows (both keyed by HIP; HIP2 omits a few 1997 entries without astrometry).
    pos_m = {h: i for i, h in enumerate(hipm.hip)}
    m_of_2 = np.array([pos_m.get(h, -1) for h in hip2.hip])
    log(f"Hipparcos 2007: {hip2.hip.size} stars; 1997 main catalogue: {hipm.hip.size}")

    g_sid = gaia["source_id"]
    g_mag = gaia["phot_g_mean_mag"]
    gidx = {int(s): i for i, s in enumerate(g_sid)}
    g_has_pm = np.isfinite(gaia["pmra"]) & np.isfinite(gaia["pmdec"])
    # Gaia positions at J2016.0 (their reference epoch).
    g_u2016 = sa.radec_to_unit(gaia["ra"], gaia["dec"])

    # ------------------------------------------------------------------------ HIP <-> Gaia cross-match
    hip_to_g = np.full(hip2.hip.size, -1)
    xm_how = np.zeros(hip2.hip.size, dtype=np.int8)  # 0 none, 1 Gaia best neighbour table, 2 positional
    hpos = {h: i for i, h in enumerate(hip2.hip)}
    for s, h in zip(hipxm["source_id"], hipxm["original_ext_source_id"]):
        i, j = hpos.get(int(h), -1), gidx.get(int(s), -1)
        if i >= 0 and j >= 0:
            hip_to_g[i] = j
            xm_how[i] = 1
    h_u2016 = sa.propagate(hip2.ra, hip2.dec, hip2.pmra, hip2.pmdec, hip2.EPOCH, GAIA_EPOCH)
    todo = np.nonzero(hip_to_g < 0)[0]
    taken = np.zeros(gaia.n, dtype=bool)
    taken[hip_to_g[hip_to_g >= 0]] = True
    j, sep = nearest(g_u2016, h_u2016[todo], XM_RADIUS_HIP)
    hp = hip2.hpmag[todo]
    okm = (j >= 0)
    # One-sided: the Gaia source must not be much fainter (that would be a faint companion of a star Gaia lacks);
    # it may be much brighter -- G exceeds Hp by 2-3 mag for very red (Mira-type) stars such as R Dor.
    okm[okm] &= (g_mag[j[okm]] - hp[okm] < XM_DMAG) & ~taken[j[okm]]
    hip_to_g[todo[okm]] = j[okm]
    xm_how[todo[okm]] = 2
    taken[j[okm]] = True
    todo2 = np.nonzero(hip_to_g < 0)[0]
    j2, sep2 = nearest(g_u2016, h_u2016[todo2], XM_RADIUS_HIP2)
    ok2 = j2 >= 0
    ok2[ok2] &= (np.abs(g_mag[j2[ok2]] - hip2.hpmag[todo2][ok2]) < XM_DMAG2) & ~taken[j2[ok2]]
    # a Gaia source may be claimed by only one Hipparcos star: keep the closest
    o = np.argsort(np.where(ok2, sep2, np.inf))
    seen = set()
    for i in o:
        if not ok2[i]:
            break
        if j2[i] in seen:
            ok2[i] = False
        seen.add(j2[i])
    hip_to_g[todo2[ok2]] = j2[ok2]
    xm_how[todo2[ok2]] = 3
    # Counterpart check: Gaia's best-neighbour table occasionally pairs a Hipparcos star with a much fainter
    # companion while the primary's own Gaia source is unclaimed nearby (beta Lep, zeta Her). Prefer an unclaimed
    # source within XM_RADIUS_HIP2 whose G agrees with Hp.
    taken = np.zeros(gaia.n, dtype=bool)
    taken[hip_to_g[hip_to_g >= 0]] = True
    tree_g = cKDTree(g_u2016)
    chord2 = 2.0 * np.sin(np.radians(XM_RADIUS_HIP2 / 3600.0) / 2.0)
    reassigned = []
    for i in np.nonzero(hip_to_g >= 0)[0]:
        if abs(g_mag[hip_to_g[i]] - hip2.hpmag[i]) <= XM_DMAG2:
            continue
        cands = [c for c in tree_g.query_ball_point(h_u2016[i], chord2)
                 if not taken[c] and abs(g_mag[c] - hip2.hpmag[i]) < 0.75]
        if cands:
            c = min(cands, key=lambda c: abs(g_mag[c] - hip2.hpmag[i]))
            reassigned.append({"hip": int(hip2.hip[i]), "from": int(g_sid[hip_to_g[i]]), "to": int(g_sid[c]),
                               "Hp": float(hip2.hpmag[i]), "Gfrom": float(g_mag[hip_to_g[i]]), "Gto": float(g_mag[c])})
            taken[hip_to_g[i]] = False
            hip_to_g[i] = c
            taken[c] = True
            xm_how[i] = 4
    diag["hipXmatch"] = {"bestNeighbour": int((xm_how == 1).sum()), "positional": int((xm_how == 2).sum()),
                         "positionalWide": int((xm_how == 3).sum()), "reassigned": int((xm_how == 4).sum()),
                         "unmatched": int((hip_to_g < 0).sum()),
                         "positionalMedianSepArcsec": float(np.nanmedian(sep[okm])) if okm.any() else None}
    diag["hipReassigned"] = reassigned
    log(f"HIP-Gaia: {diag['hipXmatch']}")
    g_to_hip = np.full(gaia.n, -1)
    g_to_hip[hip_to_g[hip_to_g >= 0]] = np.nonzero(hip_to_g >= 0)[0]

    # ----------------------------------------------------------------------- Tycho-2 <-> Gaia/HIP match
    t_has_mean = np.isfinite(tyc["ra_mdeg"]) & np.isfinite(tyc["pm_ra"])
    t_ra = np.where(t_has_mean, tyc["ra_mdeg"], tyc["ra_deg"])
    t_de = np.where(t_has_mean, tyc["de_mdeg"], tyc["de_deg"])
    t_u2016 = sa.propagate(t_ra, t_de, np.where(t_has_mean, tyc["pm_ra"], 0.0),
                           np.where(t_has_mean, tyc["pm_de"], 0.0), TYCHO_EPOCH, GAIA_EPOCH)
    jt, sept = nearest(g_u2016, t_u2016, XM_RADIUS_TYC)
    t_in_gaia = jt >= 0
    t_in_gaia[t_in_gaia] &= (g_mag[jt[t_in_gaia]] - tyc["vt_mag"][t_in_gaia]) < XM_DMAG
    jh, _ = nearest(h_u2016, t_u2016, XM_RADIUS_TYC)
    t_in_hip = (np.asarray(tyc["hip"]) > 0) | (jh >= 0)
    t_bt, t_vt = tyc["bt_mag"], tyc["vt_mag"]
    # V from Tycho photometry (ESA 1997, Vol. 1, Sect. 1.3, Appendix 4: V = VT - 0.090 (BT - VT)), selection only.
    t_v = np.where(np.isfinite(t_bt), t_vt - 0.090 * (t_bt - t_vt), t_vt)
    t_keep = ~t_in_gaia & ~t_in_hip & (t_v < V_LIMIT)
    diag["tychoXmatch"] = {"queried": int(t_vt.size), "positionalGaia": int(t_in_gaia.sum()),
                           "hip": int(t_in_hip.sum()), "added": int(t_keep.sum())}
    log(f"Tycho-2: {diag['tychoXmatch']}")

    # ------------------------------------------------- close Gaia pairs: blended XP, spurious bright duplicates
    pairs = np.array(sorted(tree_g.query_pairs(2.0 * np.sin(np.radians(XP_BLEND_RADIUS / 3600.0) / 2.0))))
    g_blended = np.zeros(gaia.n, dtype=bool)
    g_dup = np.zeros(gaia.n, dtype=bool)
    dup_diag = []
    if pairs.size:
        a_, b_ = pairs[:, 0], pairs[:, 1]
        psep = sa.separation_arcsec(g_u2016[a_], g_u2016[b_])
        for i in np.nonzero((psep < DUP_SEP) & (np.abs(g_mag[a_] - g_mag[b_]) < DUP_DMAG)
                            & (np.minimum(g_mag[a_], g_mag[b_]) < DUP_GMAX))[0]:
            pa, pb = a_[i], b_[i]
            # keep the member Hipparcos is matched to (else the one with an astrometric solution / XP)
            score = lambda j: (g_to_hip[j] >= 0, g_has_pm[j], bool(gaia["has_xp_sampled"][j]))
            drop = pb if score(pa) >= score(pb) else pa
            g_dup[drop] = True
            dup_diag.append({"kept": int(g_sid[pa if drop == pb else pb]), "dropped": int(g_sid[drop]),
                             "sepArcsec": float(psep[i]), "G": [float(g_mag[pa]), float(g_mag[pb])]})
        real = ~g_dup[a_] & ~g_dup[b_]
        g_blended[a_[real & (g_mag[b_] < g_mag[a_] + XP_BLEND_DMAG)]] = True
        g_blended[b_[real & (g_mag[a_] < g_mag[b_] + XP_BLEND_DMAG)]] = True
    diag["gaiaBlendedXP"] = int((g_blended & (g_mag < G_LIMIT)).sum())
    diag["gaiaSpuriousDuplicates"] = dup_diag
    log(f"Gaia sources with a comparably bright neighbour within {XP_BLEND_RADIUS}\" (XP blended): "
        f"{diag['gaiaBlendedXP']}; spurious bright duplicates dropped: {len(dup_diag)}")

    # ------------------------------------------------------------------------------- catalogue records
    recs = Records()
    g_sel = np.nonzero((g_mag < G_LIMIT) & ~g_dup)[0]
    for i in g_sel:
        recs.kind.append("gaia"); recs.gi.append(i); recs.hi.append(g_to_hip[i]); recs.ti.append(-1)
    hv = np.where(m_of_2 >= 0, hipm.vmag[np.maximum(m_of_2, 0)], np.nan)
    h_sel_mag = np.where(np.isfinite(hv), hv, hip2.hpmag)
    h_only = np.nonzero((hip_to_g < 0) & (h_sel_mag < V_LIMIT))[0]
    for i in h_only:
        recs.kind.append("hip"); recs.gi.append(-1); recs.hi.append(i); recs.ti.append(-1)
    for i in np.nonzero(t_keep)[0]:
        recs.kind.append("tyc"); recs.gi.append(-1); recs.hi.append(-1); recs.ti.append(i)
    kind, gi, hi, ti = recs.arrays()
    n = kind.size
    log(f"records: {n} (Gaia {int((kind == 'gaia').sum())}, HIP-only {int((kind == 'hip').sum())}, "
        f"Tycho-only {int((kind == 'tyc').sum())})")

    # ------------------------------------------------------------------------------------ astrometry
    u = np.full((n, 3), np.nan)
    pos_route = np.full(n, -1, dtype=np.int16)
    flags = np.zeros(n, dtype=np.uint8)
    POS = [
        ("derived", [SRC_GAIA], "Gaia DR3 5/6-parameter astrometry (ref. epoch J2016.0) propagated to the epoch by "
         "rigorous linear space motion (ESA 1997, SP-1200 Vol. 1 Sect. 1.5.5); Gaia DR3 radial velocity used for the "
         "perspective term when available."),
        ("derived", [SRC_HIP2, SRC_HIPXM], "Hipparcos new reduction (van Leeuwen 2007; epoch J1991.25) propagated "
         "by rigorous linear space motion; used where Gaia DR3 has no counterpart or a worse propagated position "
         "(2-parameter solution, or RUWE > 1.4 with larger propagated uncertainty)."),
        ("derived", [SRC_TYC], "Tycho-2 mean position (J2000.0) and proper motion propagated linearly; star absent "
         "from Gaia DR3 and Hipparcos."),
        ("estimated", [SRC_GAIA], "Gaia DR3 2-parameter solution: position measured at J2016.0, proper motion not "
         "measured and assumed zero (typical error of that assumption: tens of mas over a decade)."),
        ("estimated", [SRC_TYC], "Tycho-2 observed position (no mean position/proper motion in Tycho-2); proper "
         "motion assumed zero."),
        ("derived", [SRC_GAIA, SRC_TYC], "Gaia DR3 2-parameter solution (position measured at J2016.0, no proper "
         "motion) propagated with the star's Tycho-2 proper motion (Gaia DR3 Tycho-2 best neighbour)."),
        ("estimated", [SRC_GAIA, SRC_HIP2], "Gaia DR3 2-parameter solution (position at J2016.0) propagated with the "
         "proper motion of the Hipparcos star within 10\" (assumed to be the same physical system)."),
    ]
    t_gaia = GAIA_EPOCH
    gsel = np.nonzero(kind == "gaia")[0]
    g = gi[gsel]
    has_h = hi[gsel] >= 0
    dt_g = abs(epoch - t_gaia)
    dt_h = abs(epoch - hip2.EPOCH)
    sig_g = sa.position_sigma_mas(np.hypot(gaia["ra_error"][g], gaia["dec_error"][g]),
                                  np.hypot(gaia["pmra_error"][g], gaia["pmdec_error"][g]), dt_g)
    sig_g = np.where(np.isfinite(sig_g), sig_g * np.maximum(1.0, np.nan_to_num(gaia["ruwe"][g], nan=1.0)), np.inf)
    hh = np.maximum(hi[gsel], 0)
    sig_h = np.where(has_h, sa.position_sigma_mas(np.hypot(hip2.e_ra[hh], hip2.e_dec[hh]),
                                                  np.hypot(hip2.e_pmra[hh], hip2.e_pmdec[hh]), dt_h), np.inf)
    ruwe = np.nan_to_num(gaia["ruwe"][g], nan=0.0)
    use_hip = has_h & ((~g_has_pm[g]) | ((ruwe > 1.4) & (sig_h < sig_g)))
    use_g5 = ~use_hip & g_has_pm[g]
    use_g2 = ~use_hip & ~g_has_pm[g]
    a = gsel[use_g5]
    u[a] = sa.propagate(gaia["ra"][gi[a]], gaia["dec"][gi[a]], gaia["pmra"][gi[a]], gaia["pmdec"][gi[a]], t_gaia,
                        epoch, gaia["parallax"][gi[a]], gaia["radial_velocity"][gi[a]])
    pos_route[a] = 0
    a = gsel[use_g2]
    flags[a] |= sf.FLAG_POS_2016_NO_PM
    tp = load_table(sg.fetch_tycho_pm_for_2p(G_LIMIT))
    okp = np.isfinite(tp["pm_ra"]) & np.isfinite(tp["pm_de"])
    o = np.argsort(np.where(okp, tp["angular_distance"], np.inf))[::-1]  # closest match written last wins
    tyc_pm = {int(tp["source_id"][i]): (tp["pm_ra"][i], tp["pm_de"][i]) for i in o if okp[i]}
    has_tpm = np.array([int(g_sid[gi[k]]) in tyc_pm for k in a], dtype=bool)
    at = a[has_tpm]
    if at.size:
        pm = np.array([tyc_pm[int(g_sid[gi[k]])] for k in at])
        u[at] = sa.propagate(gaia["ra"][gi[at]], gaia["dec"][gi[at]], pm[:, 0], pm[:, 1], t_gaia, epoch)
        pos_route[at] = 5
    rest = a[~has_tpm]
    if rest.size:
        jh2, _ = nearest(h_u2016, g_u2016[gi[rest]], 10.0)
        near = jh2 >= 0
        ar = rest[near]
        if ar.size:
            u[ar] = sa.propagate(gaia["ra"][gi[ar]], gaia["dec"][gi[ar]], hip2.pmra[jh2[near]], hip2.pmdec[jh2[near]],
                                 t_gaia, epoch)
            pos_route[ar] = 6
        a0 = rest[~near]
        u[a0] = g_u2016[gi[a0]]
        pos_route[a0] = 3
    a = np.concatenate([gsel[use_hip], np.nonzero(kind == "hip")[0]])
    u[a] = sa.propagate(hip2.ra[hi[a]], hip2.dec[hi[a]], hip2.pmra[hi[a]], hip2.pmdec[hi[a]], hip2.EPOCH, epoch,
                        hip2.plx[hi[a]], None)
    pos_route[a] = 1
    a = np.nonzero(kind == "tyc")[0]
    tm = t_has_mean[ti[a]]
    u[a[tm]] = sa.propagate(t_ra[ti[a[tm]]], t_de[ti[a[tm]]], tyc["pm_ra"][ti[a[tm]]], tyc["pm_de"][ti[a[tm]]],
                            TYCHO_EPOCH, epoch)
    pos_route[a[tm]] = 2
    obs_ep = 1990.0 + np.nanmean(np.stack([tyc["ep_ra1990"][ti[a[~tm]]], tyc["ep_de1990"][ti[a[~tm]]]]), axis=0)
    u[a[~tm]] = sa.radec_to_unit(t_ra[ti[a[~tm]]], t_de[ti[a[~tm]]])
    pos_route[a[~tm]] = 4
    assert np.isfinite(u).all() and (pos_route >= 0).all()
    diag["posRoutes"] = {f"{k} {POS[k][0]}: {POS[k][2][:60]}": int((pos_route == k).sum()) for k in range(len(POS))}
    diag["tychoObservedEpochs"] = obs_ep.tolist()

    # ---------------------------------------------------------------------------------- photometry keys
    hm_i = np.where(hi >= 0, m_of_2[np.maximum(hi, 0)], -1)          # HIP 1997 row per record
    has_hm = hm_i >= 0
    hmi = np.maximum(hm_i, 0)
    r_V = np.where(has_hm, hipm.vmag[hmi], np.nan)
    r_BV = np.where(has_hm, hipm.bv[hmi], np.nan)
    r_VI = np.where(has_hm, hipm.vi[hmi], np.nan)
    r_BT = np.where(has_hm, hipm.bt[hmi], np.nan)
    r_VT = np.where(has_hm, hipm.vt[hmi], np.nan)
    r_hip_combined = has_hm & ((hipm.combmag[hmi] == "*") | (hipm.ncomp[hmi] > 1))
    r_G = np.where(gi >= 0, g_mag[np.maximum(gi, 0)], np.nan)
    r_blend = (gi >= 0) & g_blended[np.maximum(gi, 0)]
    flags[r_blend] |= sf.FLAG_XP_BLENDED
    r_BPRP = np.where(gi >= 0, gaia["phot_bp_mean_mag"][np.maximum(gi, 0)] - gaia["phot_rp_mean_mag"][np.maximum(gi, 0)],
                      np.nan)
    tt = np.maximum(ti, 0)
    r_BT = np.where(kind == "tyc", tyc["bt_mag"][tt], r_BT)
    r_VT = np.where(kind == "tyc", tyc["vt_mag"][tt], r_VT)
    r_hip = np.where(hi >= 0, hip2.hip[np.maximum(hi, 0)], 0)
    var = has_hm & (hipm.varflag[hmi] > 0)
    var |= (gi >= 0) & (gaia["phot_variable_flag"][np.maximum(gi, 0)] == "VARIABLE")
    flags[var] |= sf.FLAG_VARIABLE
    mult = has_hm & (hipm.multflag[hmi] != "")
    mult |= (gi >= 0) & ((np.nan_to_num(gaia["ruwe"][np.maximum(gi, 0)]) > 1.4) |
                         (gaia["non_single_star"][np.maximum(gi, 0)] > 0))
    flags[mult] |= sf.FLAG_MULTIPLE
    flags[(kind == "hip") & r_hip_combined] |= sf.FLAG_LIGHT_COMBINED

    # ------------------------------------------------------------------------------------------ light
    xyzs = np.full((n, 4), np.nan)
    light_route = np.full(n, -1, dtype=np.int16)
    cie_srcs = cie.register_sources(ctx)
    LIGHT: list[tuple[str, list[str], str]] = []

    def route(label, sources, method):
        LIGHT.append((label, sources, method))
        return len(LIGHT) - 1

    # 1. CALSPEC
    cal, cal_page = sc.load_calspec(V_LIMIT)
    R_CAL = route("derived", [SRC_CALSPEC, SRC_SIMBAD, *cie_srcs],
                  "HST/STIS CALSPEC absolute spectrum (all samples in 360-830 nm observed), linearly interpolated to "
                  "1 nm (vacuum wavelengths used as-is) and integrated against the CIE 1931 2° and 1951 scotopic "
                  "observers.")
    rec_of_hip = {int(h): k for k, h in enumerate(r_hip) if h > 0}
    rec_of_gaia = {int(gaia['source_id'][gi[k]]): k for k in np.nonzero(gi >= 0)[0]}
    cal_diag = []
    for s in cal:
        k = rec_of_gaia.get(s.gaia, rec_of_hip.get(s.hip, -1))
        entry = {"name": s.name, "file": s.file, "V": s.vmag, "hip": s.hip, "gaia": str(s.gaia), "record": int(k)}
        if k >= 0:
            m = (s.wl >= 355) & (s.wl <= 835)
            ok = sl.covers_cie(s.wl, np.isfinite(s.flux) & s.measured)
            vcheck = (not np.isfinite(r_V[k])) or abs(r_V[k] - s.vmag) <= SPEC_V_TOL
            entry.update({"coverageMeasured": bool(ok), "measuredFrac": float(s.measured[m].mean()),
                          "hipV": None if not np.isfinite(r_V[k]) else float(r_V[k])})
            if ok and vcheck:
                entry["xyzs"] = sl.spectrum_xyzs(s.wl, s.flux).tolist()
                xyzs[k] = entry["xyzs"]
                light_route[k] = R_CAL
        cal_diag.append(entry)
    diag["calspec"] = cal_diag
    log(f"CALSPEC: {len(cal)} stars V<{V_LIMIT}, used for {int((light_route == R_CAL).sum())} records")

    # 2. Gaia XP
    xp_wanted = g_sid[(g_mag < G_LIMIT) & gaia["has_xp_sampled"]]
    dev_partial = os.environ.get("STARS_XP_NO_STREAM") == "1"  # development only: use XP files streamed so far
    xp_paths, xp_ledger = sg.stream_xp(xp_wanted, log=log, stream=not dev_partial)
    if dev_partial:
        diag["WARNING"] = "built with a partial XP set (STARS_XP_NO_STREAM=1); not a release product"
    xsid, xflux, xerr = sg.load_xp(xp_paths, xp_wanted)
    W = sl.linear_operator(sg.XP_WAVELENGTHS)
    cov = np.isfinite(xflux[:, (sg.XP_WAVELENGTHS >= 358) & (sg.XP_WAVELENGTHS <= 832)]).all(axis=1)
    xp_xyzs = np.full((xsid.size, 4), np.nan)
    xp_xyzs[cov] = np.nan_to_num(xflux[cov].astype(np.float64)) @ W
    positive = cov & (xp_xyzs > 0).all(axis=1)
    diag["xpNonPositive"] = int((cov & ~positive).sum())
    log(f"XP spectra: {xsid.size} of {xp_wanted.size} wanted; {int(cov.sum())} cover 360-830 nm; "
        f"{diag['xpNonPositive']} integrate to a non-positive X, Y, Z or S (blue flux below zero) and are not used")
    xp_of_rec = np.full(n, -1)
    kg = np.nonzero(gi >= 0)[0]
    pos = np.searchsorted(xsid, g_sid[gi[kg]])
    pos = np.minimum(pos, xsid.size - 1)
    hit = xsid[pos] == g_sid[gi[kg]]
    xp_of_rec[kg[hit]] = pos[hit]
    has_xp = (xp_of_rec >= 0)
    xp_bad = has_xp.copy()
    has_xp[has_xp] &= positive[xp_of_rec[has_xp]]
    xp_bad &= ~has_xp
    flags[xp_bad] |= sf.FLAG_XP_REJECTED
    rec_xp = np.full((n, 4), np.nan)
    rec_xp[has_xp] = xp_xyzs[xp_of_rec[has_xp]]
    R_XP = route("derived", [SRC_XP, *cie_srcs],
                 "Gaia DR3 XP externally calibrated sampled mean spectrum (336-1020 nm, 2 nm; De Angeli et al. 2023, "
                 "Montegriffo et al. 2023), linearly interpolated to 1 nm and integrated against the CIE 1931 2° and "
                 "1951 scotopic observers. Used for G >= %.1f." % XP_G_MIN)
    use = has_xp & ~r_blend & (light_route < 0) & (r_G >= XP_G_MIN)
    xyzs[use] = rec_xp[use]
    light_route[use] = R_XP
    flags[has_xp & (r_G < XP_G_MIN)] |= sf.FLAG_XP_REJECTED

    # 3. Pulkovo
    pk = sc.load_pulkovo()
    R_PK = route("derived", [SRC_PULKOVO, SRC_HIP1, *cie_srcs],
                 "Pulkovo ground-based absolute spectrophotometry 320-1080 nm (10 nm resolution, 2.5 nm steps; "
                 "Alekseeva et al. 1996, 1997), linearly interpolated to 1 nm and integrated against the CIE 1931 2° "
                 "and 1951 scotopic observers. Matched by HD number through the Hipparcos catalogue; used only when "
                 "the catalogue's V agrees with Hipparcos V within %.2f mag (same light) and Gaia shows no comparably "
                 "bright neighbour within 2\". On stars also in HST CALSPEC its scale is a few per cent fainter and "
                 "slightly redder (docs/reports/stars.md)." % SPEC_V_TOL)
    hd_to_rec = {}
    for k in np.nonzero(has_hm)[0]:
        hdn = int(hipm.hd[hm_i[k]])
        if hdn > 0:
            hd_to_rec.setdefault(hdn, k)
    pk_diag = []
    pk_xyzs = np.full((pk.hr.size, 4), np.nan)
    for j in range(pk.hr.size):
        k = hd_to_rec.get(int(pk.hd[j]), -1)
        e = {"hr": int(pk.hr[j]), "hd": pk.hd_str[j], "name": pk.name[j], "V": float(pk.vmag[j]),
             "record": int(k), "combined": bool(pk.combined[j])}
        ok = sl.covers_cie(pk.wl, np.isfinite(pk.flux[j]))
        e["covers"] = ok
        if ok:
            pk_xyzs[j] = sl.spectrum_xyzs(pk.wl, pk.flux[j])
            e["xyzs"] = pk_xyzs[j].tolist()
        if k >= 0:
            e["hipV"] = None if not np.isfinite(r_V[k]) else float(r_V[k])
            e["G"] = None if not np.isfinite(r_G[k]) else float(r_G[k])
            e["xpXyzs"] = rec_xp[k].tolist() if np.isfinite(rec_xp[k]).all() else None
            vok = np.isfinite(r_V[k]) and abs(r_V[k] - pk.vmag[j]) <= SPEC_V_TOL
            e["vConsistent"] = bool(vok)
            if ok and vok and not pk.combined[j] and not r_blend[k] and light_route[k] < 0:
                xyzs[k] = pk_xyzs[j]
                light_route[k] = R_PK
        pk_diag.append(e)
    diag["pulkovo"] = pk_diag
    # Absolute-scale check of the Pulkovo catalogue against HST CALSPEC on the stars both measured (same record,
    # single star, same light).
    cal_by_rec = {e["record"]: e for e in cal_diag if e.get("xyzs")}
    pvc = []
    for e in pk_diag:
        c_ = cal_by_rec.get(e["record"])
        if c_ is not None and e.get("xyzs") and e.get("vConsistent") and not e["combined"]:
            a, b = np.array(e["xyzs"]), np.array(c_["xyzs"])
            (xa, ya), (xb, yb) = sl.chromaticity(a), sl.chromaticity(b)
            pvc.append({"name": c_["name"], "hr": e["hr"], "dY_mag": float(-2.5 * np.log10(a[1] / b[1])),
                        "dx": float(xa - xb), "dy": float(ya - yb), "SY_ratio": float((a[3] / a[1]) / (b[3] / b[1]))})
    diag["pulkovoVsCalspec"] = pvc
    xvc = []
    for e in cal_diag:
        k = e["record"]
        if e.get("xyzs") and k >= 0 and np.isfinite(rec_xp[k]).all() and not r_blend[k]:
            a, b = rec_xp[k], np.array(e["xyzs"])
            (xa, ya), (xb, yb) = sl.chromaticity(a), sl.chromaticity(b)
            xvc.append({"name": e["name"], "G": float(r_G[k]), "dY_mag": float(-2.5 * np.log10(a[1] / b[1])),
                        "dx": float(xa - xb), "dy": float(ya - yb), "SY_ratio": float((a[3] / a[1]) / (b[3] / b[1]))})
    diag["xpVsCalspec"] = xvc
    log(f"Pulkovo: {pk.hr.size} stars with 320-1080 nm spectra, used for {int((light_route == R_PK).sum())}")

    # 4. photometric estimates, calibrated on XP-derived stars (G >= XP_G_MIN)
    calib = has_xp & ~r_blend & (r_G >= XP_G_MIN)
    rel_V = sl.fit_relation("Hipparcos V, B-V", r_V[calib], r_BV[calib], rec_xp[calib])
    rel_G = sl.fit_relation("Gaia G, BP-RP", r_G[calib], r_BPRP[calib], rec_xp[calib])
    rel_T = sl.fit_relation("Tycho VT, BT-VT", r_VT[calib], r_BT[calib] - r_VT[calib], rec_xp[calib])
    rel_VI = sl.fit_relation("Hipparcos V, V-I", r_V[calib], r_VI[calib], rec_xp[calib])
    rels = (rel_V, rel_G, rel_T, rel_VI)
    diag["relations"] = {r.system: r.summary() for r in rels}
    diag["relationTables"] = {r.system: {"c": r.centers.tolist(), "k": r.k.tolist(), "sigmaMag": r.scatter_mag.tolist(),
                                         "n": r.n.tolist()} for r in rels}
    photo_note = ("converted to X, Y, Z, S with the empirical relation XYZS = 10^(-0.4 m) k(c), k = median of "
                  "XYZS 10^(0.4 m) over stars of the same colour whose XYZS is derived from their own Gaia XP spectrum "
                  "(G >= %.1f). Assumption: stars of equal colour index share a spectral shape." % XP_G_MIN)
    R_PV = route("estimated", [SRC_HIP1, SRC_XP, *cie_srcs], "Hipparcos catalogue Johnson V and B-V (ESA 1997) " + photo_note)
    R_PG = route("estimated", [SRC_GAIA, SRC_XP, *cie_srcs], "Gaia DR3 G and BP-RP " + photo_note)
    R_PT = route("estimated", [SRC_TYC, SRC_HIP1, SRC_XP, *cie_srcs], "Tycho VT and BT-VT " + photo_note)
    R_PVI = route("estimated", [SRC_HIP1, SRC_XP, *cie_srcs], "Hipparcos catalogue V and V-I (ESA 1997) " + photo_note)
    median_note = (" alone (no colour measured: typically a companion 1-3\" from a brighter star, no BP/RP) converted with "
                   "the median XYZS 10^(0.4 m) over all stars whose XYZS is derived from their own Gaia XP spectrum "
                   "(G >= %.1f): brightness and colour are those of the population median at that magnitude scale."
                   % XP_G_MIN)
    R_MG = route("estimated", [SRC_GAIA, SRC_XP, *cie_srcs], "Gaia DR3 G" + median_note)
    R_MV = route("estimated", [SRC_HIP1, SRC_XP, *cie_srcs], "Hipparcos catalogue V" + median_note)
    R_MT = route("estimated", [SRC_TYC, SRC_HIP1, SRC_XP, *cie_srcs], "Tycho VT" + median_note)
    R_UNK = route("unknown", [], "No spectrum and no magnitude available.")
    extrap = np.zeros(n, dtype=bool)

    def apply(mask, rel, m, c, rid):
        idx = np.nonzero(mask & (light_route < 0) & np.isfinite(m) & np.isfinite(c))[0]
        if idx.size:
            v, ex = rel.predict(m[idx], c[idx])
            xyzs[idx] = v
            light_route[idx] = rid
            extrap[idx] = ex

    bright = np.isfinite(r_G) & (r_G < XP_G_MIN)
    no_g = ~np.isfinite(r_G)
    # Bright Gaia stars and non-Gaia stars: ground-based Hipparcos V, B-V first (unless it is combined light of a
    # system Gaia resolves). Fainter Gaia stars without XP: their own Gaia photometry first.
    apply((bright | no_g) & ~((kind == "gaia") & (r_hip_combined | r_blend)), rel_V, r_V, r_BV, R_PV)
    apply(kind == "gaia", rel_G, r_G, r_BPRP, R_PG)
    apply(np.ones(n, bool), rel_V, r_V, r_BV, R_PV)
    apply(np.ones(n, bool), rel_T, r_VT, r_BT - r_VT, R_PT)
    apply(np.ones(n, bool), rel_VI, r_V, r_VI, R_PVI)
    # last resort: a measured magnitude without any colour -> population-median colour
    zero = np.zeros(n)
    for m_, sys_, rid in ((r_G, "Gaia G (population median)", R_MG), (r_V, "Hipparcos V (population median)", R_MV),
                          (r_VT, "Tycho VT (population median)", R_MT)):
        rel_m = sl.fit_relation(sys_, m_[calib], zero[calib], rec_xp[calib], per_bin=10 ** 9, max_width=1.0)
        diag["relations"][sys_] = rel_m.summary()
        apply(np.ones(n, bool), rel_m, m_, zero, rid)
    unk = light_route < 0
    light_route[unk] = R_UNK

    # 5. Hipparcos multiple entries whose photometry is the combined light of the system. Gaia may list some
    # components separately (a Hipparcos-only record would then count them twice) or lack some (Gaia DR3 often
    # lists one source for a pair closer than ~2"; Castor A is missing, B is present). Conserve the system's
    # measured light, keeping every Gaia component's own light:
    #   * Hipparcos-only record: its light becomes (system - other records in the system); dropped if ~nothing is
    #     left (the separate records carry the system);
    #   * Gaia record whose Gaia components fall short of the Hipparcos system light by > 20 %: the shortfall is a
    #     component Gaia DR3 does not list, added as its own record at the Hipparcos position (if brighter than the
    #     catalogue limit).
    R_COMB = route("estimated", [SRC_HIP1, SRC_HIP2, SRC_GAIA, SRC_XP, *cie_srcs],
                   "Light of a Hipparcos multiple entry (combined photometry) not carried by any other record: the "
                   "system's light (Hipparcos V, B-V through the photometric relation, or the entry's own spectrum) "
                   "minus the light of the catalogue records within max(%.0f\", rho + %.0f\") (rho = Hipparcos "
                   "component separation). Assumes those records are the entry's components and the remainder has "
                   "the system's colour where it is a missing component." % (SYS_MIN_RADIUS, SYS_MARGIN))
    alive = np.ones(n, dtype=bool)
    tree = cKDTree(u)
    sys_diag = []
    y_lim = [e for e in cal_diag if e["name"] == "ALPHA LYR"][0]["xyzs"][1] * 10 ** (-0.4 * (V_LIMIT - 0.03))
    added = []  # (source record k, light)
    for k in np.nonzero(r_hip_combined & (light_route != R_UNK))[0]:
        rho = hipm.rho[hm_i[k]]
        radius = max(SYS_MIN_RADIUS, (rho if np.isfinite(rho) else 0.0) + SYS_MARGIN)
        chord = 2.0 * np.sin(np.radians(radius / 3600.0) / 2.0)
        others = [o for o in tree.query_ball_point(u[k], chord)
                  if o != k and alive[o] and np.isfinite(xyzs[o]).all()]
        l_oth = xyzs[others].sum(axis=0) if others else np.zeros(4)
        e = {"hip": int(r_hip[k]), "kind": str(kind[k]), "radiusArcsec": float(radius), "others": len(others),
             "othersY": float(l_oth[1]), "ownY": float(xyzs[k][1])}
        if kind[k] == "hip" or light_route[k] == R_PK:
            # the record's light is the whole system's (Hipparcos-only record, or a ground-based spectrum whose
            # aperture held the companions)
            if not others:
                continue
            l_sys = xyzs[k].copy()
            rem = l_sys - l_oth
            e["systemY"] = float(l_sys[1])
            if (rem <= 0).any() or rem[1] < 0.1 * l_sys[1]:
                if kind[k] == "hip":
                    alive[k] = False
                    e["action"] = "dropped Hipparcos-only record (separate records carry the system)"
                else:
                    e["action"] = "unchanged (spectrum; separate records carry nearly all the light)"
            else:
                xyzs[k] = rem
                light_route[k] = R_COMB
                flags[k] |= sf.FLAG_LIGHT_COMBINED
                e["action"] = "Hipparcos-only record reduced to the light not carried by other records"
        else:
            if not (np.isfinite(r_V[k]) and np.isfinite(r_BV[k])):
                continue
            l_sys = rel_V.predict(r_V[k:k + 1], r_BV[k:k + 1])[0][0]
            e["systemY"] = float(l_sys[1])
            rem = l_sys - l_oth - xyzs[k]
            if l_sys[1] <= 1.2 * (xyzs[k][1] + l_oth[1]) or (rem <= 0).any():
                continue  # Gaia's components account for the system light (within 20 %)
            if rem[1] < y_lim:
                e["action"] = "shortfall fainter than the catalogue limit: not added"
            else:
                added.append((k, rem))
                e["action"] = "added a record for the component(s) Gaia DR3 does not list"
        sys_diag.append(e)
    diag["hipSystems"] = sys_diag
    log(f"Hipparcos combined-light systems: {len(sys_diag)} examined, {len(added)} missing components added, "
        f"{int((~alive).sum())} Hipparcos-only records dropped")
    arrays = [kind, gi, hi, ti, u, pos_route, flags, xyzs, light_route, r_V, r_BV, r_G, r_BPRP, rec_xp, has_xp, hm_i,
              hmi, has_hm, r_hip, extrap, mult, var, r_hip_combined, r_blend]
    if added:
        ks = np.array([a[0] for a in added])
        new = [a[ks].copy() for a in arrays]
        (n_kind, n_gi, n_hi, n_ti, n_u, n_pos, n_flags, n_xyzs, n_lr, n_V, n_BV, n_G, n_BPRP, n_xp, n_hasxp, n_hm_i,
         n_hmi, n_has_hm, n_hip, n_ex, n_mult, n_var, n_comb, n_blend) = new
        n_kind[:] = "hip"
        n_gi[:] = -1
        n_ti[:] = -1
        h_ = n_hi
        n_u[:] = sa.propagate(hip2.ra[h_], hip2.dec[h_], hip2.pmra[h_], hip2.pmdec[h_], hip2.EPOCH, epoch,
                              hip2.plx[h_], None)
        n_pos[:] = 1
        n_flags[:] = sf.FLAG_LIGHT_COMBINED | sf.FLAG_MULTIPLE | (n_flags & sf.FLAG_VARIABLE)
        n_xyzs[:] = np.array([a[1] for a in added])
        n_lr[:] = R_COMB
        for a in (n_V, n_BV, n_G, n_BPRP):
            a[:] = np.nan
        n_xp[:] = np.nan
        n_hasxp[:] = False
        n_has_hm[:] = False  # keep these out of the per-star photometric statistics
        n_ex[:] = False
        n_mult[:] = True
        n_blend[:] = False
        arrays = [np.concatenate([a, b]) for a, b in zip(arrays, new)]
        alive = np.concatenate([alive, np.ones(len(added), dtype=bool)])
    keep = np.nonzero(alive)[0]
    (kind, gi, hi, ti, u, pos_route, flags, xyzs, light_route, r_V, r_BV, r_G, r_BPRP, rec_xp, has_xp, hm_i,
     hmi, has_hm, r_hip, extrap, mult, var, r_hip_combined, r_blend) = [a[keep] for a in arrays]
    n = keep.size

    diag["lightRoutes"] = {f"{k} {LIGHT[k][0]}: {LIGHT[k][2][:60]}": int((light_route == k).sum()) for k in range(len(LIGHT))}
    diag["posRoutes"] = {f"{k} {POS[k][0]}: {POS[k][2][:60]}": int((pos_route == k).sum()) for k in range(len(POS))}
    diag["photometricExtrapolatedColour"] = int(extrap.sum())
    log(f"light routes: {diag['lightRoutes']}")

    # ------------------------------------------------------------------------ diagnostics for the report
    # Photopic magnitude scale for binning/reporting only: m_Y = V_Vega - 2.5 log10(Y / Y_Vega), with Y_Vega from
    # Vega's CALSPEC spectrum and V_Vega from Hipparcos.
    vega = [e for e in cal_diag if e["name"] == "ALPHA LYR" and "xyzs" in e]
    if not vega:
        raise RuntimeError("Vega's CALSPEC spectrum is needed as the photometric zero point of the report tables")
    y_zero, v_zero = vega[0]["xyzs"][1], float(vega[0]["hipV"])
    diag["magYZeroPoint"] = {"Y_Vega_lux": y_zero, "V_Vega": v_zero}
    diag.update(_diagnostics(kind, r_G, r_V, r_BV, r_BPRP, rec_xp, has_xp & ~r_blend, rel_V, pk_diag, xyzs, light_route, LIGHT,
                             hipm, hm_i, y_zero, v_zero))
    # Completeness in V: every Gaia source with G < G_LIMIT is included, so stars are included down to
    # V = G_LIMIT - max(G - V). Measured on Hipparcos stars whose V and G refer to the same single, constant
    # star (no Hipparcos multiplicity/variability flag, ground-based V, RUWE < 1.4): 99.9th percentile of G - V.
    clean = (np.isfinite(r_G) & np.isfinite(r_V) & (r_G > XP_G_MIN) & ~mult & ~var & has_hm
             & (hipm.r_vmag[hmi] == "G"))
    gv = (r_G - r_V)[clean]
    q = np.percentile(gv, [50, 99, 99.9])
    gv_all = (r_G - r_V)[np.isfinite(r_G) & np.isfinite(r_V) & (r_G > XP_G_MIN)]
    diag["G_minus_V"] = {"sample": "single, non-variable Hipparcos stars with ground-based V",
                         "median": q[0], "p99": q[1], "p999": q[2], "max": float(gv.max()), "n": int(gv.size),
                         "allStars_p99": float(np.percentile(gv_all, 99)), "allStars_n": int(gv_all.size)}
    diag["completeV"] = float(np.floor((G_LIMIT - max(q[2], 0.0)) * 10) / 10)

    # ------------------------------------------------------------------------------------------ labels
    lab_pos = np.array([sf.label_index(POS[k][0]) for k in pos_route], dtype=np.uint8)
    lab_light = np.array([sf.label_index(LIGHT[k][0]) for k in light_route], dtype=np.uint8)

    # ----------------------------------------------------------------------------------- sources
    src_table = _register_sources(ctx, today, gaia, xp_ledger, tyc_path=None, hip2=hip2, hipm=hipm, pk=pk, cal=cal,
                                  cal_page=cal_page)
    # ----------------------------------------------------------------------------------- write
    order = np.argsort(-np.nan_to_num(xyzs[:, 1], nan=-1.0), kind="stable")
    rec = np.zeros(n, dtype=sf.dtype())
    rec["dir"] = u.astype(np.float32)
    rec["xyzs"] = xyzs.astype(np.float32)
    rec["labelPos"] = lab_pos
    rec["labelFlux"] = lab_light
    rec["labelColor"] = lab_light
    src_idx = {k: i for i, k in enumerate(src_table)}
    rec["src"] = np.array([src_idx[{"gaia": SRC_GAIA, "hip": SRC_HIP2, "tyc": SRC_TYC}[k]] for k in kind], np.uint8)
    rec["posRoute"] = pos_route.astype(np.uint8)
    rec["lightRoute"] = light_route.astype(np.uint8)
    rec["flags"] = flags
    cat = np.zeros((n, 2), dtype=np.uint32)
    kgm = kind == "gaia"
    cat[kgm] = sf.split_id(g_sid[gi[kgm]])
    khm = kind == "hip"
    cat[khm, 0] = hip2.hip[hi[khm]]
    ktm = kind == "tyc"
    cat[ktm, 0] = sf.tycho_id(tyc["tyc1"][ti[ktm]].astype(int), tyc["tyc2"][ti[ktm]].astype(int),
                              tyc["tyc3"][ti[ktm]].astype(int))
    rec["catId"] = cat
    rec["hip"] = r_hip.astype(np.uint32)
    rec = rec[order]
    inv = np.empty(n, dtype=np.int64)
    inv[order] = np.arange(n)

    write_bin(ctx, "stars/bright.bin", sf.encode(rec), "stars")
    header = {
        "bin": "bright.bin",
        "count": int(n),
        "stride": sf.STRIDE,
        "fields": sf.header_fields(),
        "labelEncoding": list(LABEL_ORDER),
        "sourceTable": src_table,
        "epochEt": float(epoch_et),
        "idEncoding": {
            SRC_GAIA: "catId = Gaia DR3 source_id as (lo, hi) uint32 words",
            SRC_HIP2: "catId[0] = HIP number, catId[1] = 0",
            SRC_TYC: "catId[0] = TYC1 * 2^17 + TYC2 * 2^3 + TYC3, catId[1] = 0",
        },
        "flagBits": {"1": "variable (Hipparcos VarFlag or Gaia DR3 phot_variable_flag)",
                     "2": "multiple (Hipparcos MultFlag, Gaia DR3 RUWE > 1.4 or non_single_star)",
                     "4": "Gaia XP spectrum present but not used: G below the XP bright limit, or an integrated X, Y, Z or S not positive",
                     "8": "light is the combined light of a Hipparcos multiple entry (minus any components that are separate records)",
                     "16": "Gaia DR3 2-parameter solution (no Gaia proper motion; posRoute says how it was propagated)",
                     "32": "Gaia BP/RP blended by a neighbour within 2\" (XP spectrum not used)"},
        "routes": {
            "pos": [{"label": l, "sources": s, "method": m} for l, s, m in POS],
            "light": [{"label": l, "sources": s, "method": m} for l, s, m in LIGHT],
        },
        "completeness": {
            "gaiaGLimit": G_LIMIT, "otherVLimit": V_LIMIT,
            "statement": ("All Gaia DR3 sources with G < %.1f, plus Hipparcos and Tycho-2 stars without a Gaia DR3 "
                          "counterpart and V < %.1f. Complete to V = %.1f except where all three catalogues miss a "
                          "star (see docs/reports/stars.md)." % (G_LIMIT, V_LIMIT, diag.get("completeV", V_LIMIT - 0.1))),
        },
        "notes": ("Records sorted by Y (brightest first). Bytes 0-27 of each record are float32 [ux, uy, uz, X, Y, Z, S] "
                  "(ICRF unit vector at epochEt, barycentric, no aberration; illuminance at the observer in lux and "
                  "scotopic lux, before any extinction by the observer's surroundings). labelFlux applies to Y and S, "
                  "labelColor to the X:Y:Z:S ratios; records with label 'unknown' carry NaN. Per-record provenance: "
                  "src -> sourceTable, posRoute -> routes.pos, lightRoute -> routes.light."),
    }
    write_json(ctx, "stars/bright.json", header, "stars")

    names = _names(ctx, r_hip, gi, g_sid, inv, kind)
    write_json(ctx, "stars/names.json", names, "stars")
    (CACHE / "stars").mkdir(parents=True, exist_ok=True)
    (CACHE / "stars" / "diagnostics.json").write_text(json.dumps(_jsonable(diag), indent=1))
    log(f"wrote {n} stars ({n * sf.STRIDE / 1e6:.1f} MB), {len(names['stars'])} named")


# ============================================================================================ helpers

def _jsonable(o):
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.ndarray):
        return _jsonable(o.tolist())
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def _mag(y):
    return -2.5 * np.log10(y)


def _robust(x):
    x = x[np.isfinite(x)]
    if x.size == 0:
        return None, None, 0
    med = float(np.median(x))
    return med, float(1.4826 * np.median(np.abs(x - med))), int(x.size)


def _diagnostics(kind, r_G, r_V, r_BV, r_BPRP, rec_xp, has_xp, rel_V, pk_diag, xyzs, light_route, LIGHT, hipm, hm_i,
                 y_zero, v_zero):
    d: dict = {}
    # XP vs Hipparcos-V prediction as a function of G (decides XP_G_MIN).
    pred, _ = rel_V.predict(r_V, r_BV)
    dm = _mag(rec_xp[:, 1]) - _mag(pred[:, 1])
    xa, ya = sl.chromaticity(rec_xp)
    xb, yb = sl.chromaticity(pred)
    ok = has_xp & np.isfinite(dm) & np.isfinite(r_G)
    rows = []
    for lo in np.arange(1.5, 10.0, 0.5):
        m = ok & (r_G >= lo) & (r_G < lo + 0.5)
        med, sig, cnt = _robust(dm[m])
        mx, sx, _ = _robust((xa - xb)[m])
        my, sy, _ = _robust((ya - yb)[m])
        rows.append({"G": [float(lo), float(lo + 0.5)], "n": cnt, "medianMag": med, "sigmaMag": sig,
                     "median_dx": mx, "sigma_dx": sx, "median_dy": my, "sigma_dy": sy})
    d["xpVsHipV"] = rows
    # XP vs Pulkovo.
    pr = []
    for e in pk_diag:
        if e.get("xpXyzs") and e.get("xyzs") and e.get("G") is not None:
            a, b = np.array(e["xpXyzs"]), np.array(e["xyzs"])
            xa, ya = sl.chromaticity(a)
            xb, yb = sl.chromaticity(b)
            pr.append({"hr": e["hr"], "G": e["G"], "dY_mag": float(_mag(a[1]) - _mag(b[1])),
                       "dx": float(xa - xb), "dy": float(ya - yb), "dSY": float(a[3] / a[1] / (b[3] / b[1]) - 1)})
    d["xpVsPulkovo"] = pr
    rows = []
    for lo, hi in ((0, 3), (3, 4), (4, 5), (5, 6), (6, 7), (7, 10)):
        sel = [p for p in pr if lo <= p["G"] < hi]
        if sel:
            dy = np.array([p["dY_mag"] for p in sel])
            rows.append({"G": [lo, hi], "n": len(sel), "medianMag": float(np.median(dy)),
                         "sigmaMag": float(1.4826 * np.median(np.abs(dy - np.median(dy)))),
                         "median_dx": float(np.median([p["dx"] for p in sel])),
                         "median_dy": float(np.median([p["dy"] for p in sel]))})
    d["xpVsPulkovoBinned"] = rows
    # Counts by photopic magnitude on the Vega scale.
    ymag = v_zero - 2.5 * np.log10(xyzs[:, 1] / y_zero)
    rows = []
    for lo in np.arange(-2, 10.0, 1.0):
        m = (ymag >= lo) & (ymag < lo + 1)
        rows.append({"magY": [float(lo), float(lo + 1)], "n": int(m.sum()),
                     "byRoute": {LIGHT[k][2][:30]: int((m & (light_route == k)).sum()) for k in range(len(LIGHT))}})
    d["countsByMagY"] = rows
    # Chromaticity trend vs B-V and spectral class.
    x, y = sl.chromaticity(xyzs)
    sy = xyzs[:, 3] / xyzs[:, 1]
    rows = []
    for lo in np.arange(-0.4, 2.0, 0.2):
        m = np.isfinite(r_BV) & (r_BV >= lo) & (r_BV < lo + 0.2) & np.isfinite(x)
        if m.sum():
            rows.append({"BV": [round(float(lo), 2), round(float(lo + 0.2), 2)], "n": int(m.sum()),
                         "x": float(np.median(x[m])), "y": float(np.median(y[m])), "SY": float(np.median(sy[m]))})
    d["chromaVsBV"] = rows
    sp = np.array([hipm.sptype[i][:1] if i >= 0 and hipm.sptype[i] else "" for i in hm_i])
    rows = []
    for cls in "OBAFGKM":
        m = (sp == cls) & np.isfinite(x)
        if m.sum():
            rows.append({"class": cls, "n": int(m.sum()), "x": float(np.median(x[m])), "y": float(np.median(y[m])),
                         "SY": float(np.median(sy[m]))})
    d["chromaVsSpClass"] = rows
    # Totals.
    fin = np.isfinite(xyzs).all(axis=1)
    d["totalXYZS"] = xyzs[fin].sum(axis=0).tolist()
    d["cumulativeY"] = []
    for lim in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10):
        m = fin & (ymag < lim)
        d["cumulativeY"].append({"magYlt": lim, "n": int(m.sum()), "Y": float(xyzs[m, 1].sum()),
                                 "S": float(xyzs[m, 3].sum())})
    return d


def _digest(paths) -> str:
    h = hashlib.sha256()
    for p in paths:
        h.update(f"{p.relative_to(RAW)} {record(p)['sha256']}\n".encode())
    return h.hexdigest()


def _files_note(paths) -> str:
    return "; ".join(f"{p.relative_to(RAW)} sha256={record(p)['sha256']} ({record(p)['url'][:200]})" for p in paths)


def _register_sources(ctx, today, gaia, xp_ledger, tyc_path, hip2, hipm, pk, cal, cal_page) -> list[str]:
    gaia_paths = list(gaia.paths)
    xm_path = sg.fetch_hip_xmatch()
    ty_path = sg.fetch_tycho_unmatched(VT_QUERY)
    tp_path = sg.fetch_tycho_pm_for_2p(G_LIMIT)
    rec0 = record(gaia_paths[0])
    queries = " || ".join((p.with_name(p.name + ".adql")).read_text() for p in gaia_paths)
    ctx.add_source(SourceRecord(
        id=SRC_GAIA, title="Gaia Data Release 3, main source catalogue (gaiadr3.gaia_source)",
        citation="Gaia Collaboration, Vallenari A. et al. 2023, Gaia Data Release 3: Summary of the content and survey "
                 "properties, A&A 674, A1, DOI:10.1051/0004-6361/202243940; astrometry: Lindegren L. et al. 2021, "
                 "A&A 649, A2, DOI:10.1051/0004-6361/202039709; photometry: Riello M. et al. 2021, A&A 649, A3, "
                 "DOI:10.1051/0004-6361/202039587.",
        url=sg.TAP_URL, retrieved=rec0["retrieved"], sha256=_digest(gaia_paths), version="Gaia DR3",
        license="ESA/Gaia/DPAC, CC BY-SA 3.0 IGO",
        notes=f"ADQL (async TAP): {queries}. sha256 is over the per-file hashes: {_files_note(gaia_paths)}"))
    digest = sg.stream_ledger_digest(xp_ledger)
    idx = RAW / sg.XP_SUBDIR / "_MD5SUM.txt"
    ctx.add_source(SourceRecord(
        id=SRC_XP, title="Gaia DR3 BP/RP externally calibrated sampled mean spectra (xp_sampled_mean_spectrum)",
        citation="De Angeli F. et al. 2023, Gaia DR3: Processing and validation of BP/RP low-resolution spectral data, "
                 "A&A 674, A2, DOI:10.1051/0004-6361/202243680; Montegriffo P. et al. 2023, Gaia DR3: External "
                 "calibration of BP/RP low-resolution spectroscopic data, A&A 674, A3, DOI:10.1051/0004-6361/202243880.",
        url=sg.XP_BASE, retrieved=min(f["retrieved"] for f in xp_ledger["files"].values()), sha256=digest,
        version="Gaia DR3", license="ESA/Gaia/DPAC, CC BY-SA 3.0 IGO",
        notes=(f"{len(xp_ledger['files'])} bulk ECSV files streamed from the Gaia CDN; each verified against ESA's "
               f"_MD5SUM.txt (sha256 {record(idx)['sha256']}); only rows of the {xp_ledger['wanted_count']} selected "
               f"sources (G < {G_LIMIT}, has_xp_sampled) kept, in data/raw/{sg.XP_SUBDIR}/*.npz. Per-file url/md5/"
               f"sha256/bytes in data/raw/{sg.XP_SUBDIR}/_streamed.json; this record's sha256 is over those per-file "
               "sha256s (sorted by file name).")))
    ctx.add_source(SourceRecord(
        id=SRC_HIPXM, title="Gaia DR3 cross-match with Hipparcos-2 (gaiadr3.hipparcos2_best_neighbour)",
        citation="Gaia Collaboration, Vallenari A. et al. 2023, A&A 674, A1, DOI:10.1051/0004-6361/202243940; "
                 "cross-match algorithm: Marrese P. M. et al. 2019, A&A 621, A144, DOI:10.1051/0004-6361/201834142.",
        url=sg.TAP_URL, retrieved=record(xm_path)["retrieved"], sha256=record(xm_path)["sha256"], version="Gaia DR3",
        notes="ADQL: " + xm_path.with_name(xm_path.name + ".adql").read_text() +
              f". Hipparcos stars not in this table are matched by position at J2016.0 (<= {XM_RADIUS_HIP}\" with "
              f"G - Hp < {XM_DMAG}, then <= {XM_RADIUS_HIP2}\" with |G - Hp| < {XM_DMAG2}); pairings > {XM_DMAG2} "
              f"mag off in G are moved to an unclaimed source within {XM_RADIUS_HIP2}\" that agrees with Hp to 0.75 mag."))
    ctx.add_source(SourceRecord(
        id=SRC_TYC, title="Tycho-2 catalogue (with TDSC merge) as served by the Gaia archive (gaiadr3.tycho2tdsc_merge)",
        citation="Høg E. et al. 2000, The Tycho-2 catalogue of the 2.5 million brightest stars, A&A 355, L27 "
                 "(bibcode 2000A&A...355L..27H); Fabricius C. et al. 2002, The Tycho double star catalogue, A&A 384, "
                 "180, DOI:10.1051/0004-6361:20011822; cross-match: Marrese P. M. et al. 2019, A&A 621, A144.",
        url=sg.TAP_URL, retrieved=record(ty_path)["retrieved"], sha256=_digest([ty_path, tp_path]),
        notes="(1) ADQL: " + ty_path.with_name(ty_path.name + ".adql").read_text() +
              f". Kept only stars with no Gaia DR3 source within {XM_RADIUS_TYC}\" (J2016.0) and no Hipparcos entry. "
              "(2) ADQL: " + tp_path.with_name(tp_path.name + ".adql").read_text() +
              " (proper motions for Gaia 2-parameter sources). " + _files_note([ty_path, tp_path])))
    r = record(hip2.path)
    ctx.add_source(SourceRecord(
        id=SRC_HIP2, title="Hipparcos, the New Reduction of the Raw Data (VizieR I/311)",
        citation="van Leeuwen F. 2007, Validation of the new Hipparcos reduction, A&A 474, 653, "
                 "DOI:10.1051/0004-6361:20078357.",
        url=r["url"], retrieved=r["retrieved"], sha256=r["sha256"], version="I/311 (2007)",
        notes=f"ReadMe sha256 {record(hip2.readme)['sha256']}"))
    r = record(hipm.path)
    ctx.add_source(SourceRecord(
        id=SRC_HIP1, title="The Hipparcos and Tycho Catalogues, Hipparcos main catalogue (VizieR I/239)",
        citation="ESA 1997, The Hipparcos and Tycho Catalogues, ESA SP-1200 (bibcode 1997ESASP1200.....E).",
        url=r["url"], retrieved=r["retrieved"], sha256=r["sha256"], version="I/239",
        notes=f"Used for Johnson V, B-V, BT, VT, HD numbers, spectral types, variability and multiplicity flags. "
              f"ReadMe sha256 {record(hipm.readme)['sha256']}"))
    ctx.add_source(SourceRecord(
        id=SRC_PULKOVO, title="Pulkovo spectrophotometric catalog of bright stars, 320-1080 nm (VizieR III/201)",
        citation="Alekseeva G. A. et al. 1996, Baltic Astronomy 5, 603 (bibcode 1996BaltA...5..603A); Alekseeva G. A. "
                 "et al. 1997, Baltic Astronomy 6, 481 (bibcode 1997BaltA...6..481A).",
        url=CDS_URL("III/201/"), retrieved=record(pk.paths[1])["retrieved"], sha256=_digest(pk.paths),
        notes=_files_note(pk.paths)))
    cal_paths = [c.path for c in cal] + [cal_page]
    ctx.add_source(SourceRecord(
        id=SRC_CALSPEC, title="HST CALSPEC spectrophotometric standards (current_calspec)",
        citation="Bohlin R. C., Gordon K. D., Tremblay P.-E. 2014, Techniques and Review of Absolute Flux Calibration "
                 "from the Ultraviolet to the Mid-Infrared, PASP 126, 711, DOI:10.1086/677655; Bohlin R. C., Hubeny I., "
                 "Rauch T. 2020, New Grids of Pure-hydrogen White Dwarf NLTE Model Atmospheres and the HST/STIS Flux "
                 "Calibration, AJ 160, 21, DOI:10.3847/1538-3881/ab94b4.",
        url=sc.CALSPEC_DIR, retrieved=record(cal_paths[0])["retrieved"], sha256=_digest(cal_paths),
        notes=_files_note(cal_paths)))
    ses = [c.sesame for c in cal]
    ctx.add_source(SourceRecord(
        id=SRC_SIMBAD, title="SIMBAD astronomical database via the CDS Sesame name resolver",
        citation="Wenger M. et al. 2000, The SIMBAD astronomical database, A&AS 143, 9, DOI:10.1051/aas:2000332.",
        url="https://cds.unistra.fr/cgi-bin/nph-sesame/", retrieved=record(ses[0])["retrieved"], sha256=_digest(ses),
        notes="Used only to resolve CALSPEC star names to HIP / Gaia DR3 identifiers. " + _files_note(ses)))
    return [SRC_GAIA, SRC_HIP2, SRC_TYC, SRC_XP, SRC_HIP1, SRC_PULKOVO, SRC_CALSPEC, SRC_HIPXM, SRC_SIMBAD]


def CDS_URL(rel: str) -> str:
    return sc.CDS + rel


_GREEK = {"alf": "α", "bet": "β", "gam": "γ", "del": "δ", "eps": "ε", "zet": "ζ", "eta": "η", "the": "θ", "tet": "θ",
          "iot": "ι", "kap": "κ", "lam": "λ", "mu": "μ", "nu": "ν", "ksi": "ξ", "omi": "ο", "pi": "π", "rho": "ρ",
          "sig": "σ", "tau": "τ", "ups": "υ", "phi": "φ", "khi": "χ", "chi": "χ", "psi": "ψ", "ome": "ω"}
_SUP = str.maketrans("0123456789", "⁰¹²³⁴⁵⁶⁷⁸⁹")


def _designation(code: str, cst: str) -> tuple[str, str] | None:
    """Kostjuk (IV/27A) 'Bayer' column + constellation -> ('bayer', 'θ¹ Eri') or ('variable', 'RR Lyr').

    The column holds Greek Bayer letters as 3-letter codes with optional component index ('the01', 'mu.02'),
    Bayer/Lacaille Latin letters (a-z, A-Q) and, for some stars, variable-star names (R-Z, two letters, V nnn).
    """
    import re
    code = code.strip()
    if not code:
        return None
    if re.match(r"^V\d{3,}$", code):
        return "variable", f"{code} {cst}"
    m = re.match(r"^([A-Za-z]+)\.?(\d*)$", code)
    if not m:
        return None
    base, num = m.group(1), m.group(2)
    sup = str(int(num)).translate(_SUP) if num else ""
    if base.lower() in _GREEK and base.islower():
        return "bayer", f"{_GREEK[base.lower()]}{sup} {cst}"
    if len(base) == 1 and (base.islower() or base <= "Q"):
        return "bayer", f"{base}{sup} {cst}"
    return "variable", f"{base} {cst}"


def _names(ctx, r_hip, gi, g_sid, inv, kind) -> dict:
    iau, iau_path = sc.load_iau_csn()
    xi = sc.load_cross_index()
    r = record(iau_path)
    ctx.add_source(SourceRecord(
        id=SRC_IAU, title="IAU Catalog of Star Names (IAU-CSN), IAU Division C Working Group on Star Names",
        citation="IAU Division C Working Group on Star Names (WGSN), IAU Catalog of Star Names, maintained by "
                 "E. Mamajek (WGSN secretary); official list at https://www.iau.org/public/themes/naming_stars/ .",
        url=r["url"], retrieved=r["retrieved"], sha256=r["sha256"], version="file dated 2022-04-04",
        license="IAU products: Creative Commons Attribution"))
    ctx.add_source(SourceRecord(
        id=SRC_XIDX, title="HD-DM-GC-HR-HIP-Bayer-Flamsteed Cross Index (VizieR IV/27A)",
        citation="Kostjuk N. D. 2002, HD-DM-GC-HR-HIP-Bayer-Flamsteed Cross Index, Institute of Astronomy of the "
                 "Russian Academy of Sciences (VizieR IV/27A).",
        url=CDS_URL("IV/27A/"), retrieved=record(xi.paths[1])["retrieved"], sha256=_digest(xi.paths),
        notes=_files_note(xi.paths)))
    # A Hipparcos number can be carried by two records: a Gaia component and the record added for a component Gaia
    # lacks. The name goes to the brighter one (lower index, records are sorted by Y); the other is listed.
    recs_of_hip: dict[int, list[int]] = {}
    for k in range(r_hip.size):
        if r_hip[k] > 0:
            recs_of_hip.setdefault(int(r_hip[k]), []).append(k)
    rec_of_hip = {h: min(ks, key=lambda k: inv[k]) for h, ks in recs_of_hip.items()}
    stars: dict[str, dict] = {}

    def entry(k):
        h = int(r_hip[k])
        key = f"HIP {h}"
        if key not in stars:
            e = {"index": int(inv[k]), "hip": h}
            if kind[k] == "gaia":
                e["gaiaDr3"] = str(int(g_sid[gi[k]]))
            others = sorted(int(inv[o]) for o in recs_of_hip[h] if o != k)
            if others:
                e["alsoIndex"] = others
            e["sources"] = []
            stars[key] = e
        return stars[key]

    for nm in iau:
        k = rec_of_hip.get(nm.hip, -1)
        if k < 0:
            continue
        e = entry(k)
        e["iau"] = nm.name
        e["sources"].append(SRC_IAU)
    for j in range(xi.hip.size):
        k = rec_of_hip.get(int(xi.hip[j]), -1)
        if k < 0:
            continue
        b = _designation(xi.bayer[j], xi.cst[j])
        f = f"{int(xi.fl[j])} {xi.cst[j]}" if xi.fl[j] > 0 else None
        if not b and not f:
            continue
        e = entry(k)
        if b:
            e[b[0]] = b[1]
        if f:
            e["flamsteed"] = f
        if SRC_XIDX not in e["sources"]:
            e["sources"].append(SRC_XIDX)
    return {"catalog": "stars/bright.json",
            "key": "HIP number; index = record index in stars/bright.bin (brightest record carrying that HIP number); "
                   "alsoIndex = other records of the same Hipparcos entry (components)",
            "sources": [SRC_IAU, SRC_XIDX], "stars": dict(sorted(stars.items(), key=lambda kv: kv[1]["index"]))}
