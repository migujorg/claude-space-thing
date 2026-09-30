"""Per-attribute provenance rules for small-body physical properties (sb_physical) on a synthetic catalogue."""

import math

import numpy as np
import pytest

from pipeline import sb_catalog, sb_physical
from pipeline.paths import RAW
from pipeline.sb_physical_sources import GAIA_WAVELENGTHS_NM, GaiaSpectra, LcdbEntry, NeowiseFit
from pipeline.sb_table import LABEL_CODE

M, D, E, U = (LABEL_CODE[k] for k in ("measured", "derived", "estimated", "unknown"))
SRC = {"sbdb": 1, "neowise": 3, "lcdb": 4, "gaia": 5, "stat": 7}
HAVE_LIGHT = (RAW / "solar").exists() and (RAW / "cie").exists() and (RAW / "filters").exists()


def _catalog(rows):
    """rows: (spkid, pdes, kind, class, H, full_name); kept in spkid order like the SBDB pages."""
    rows = sorted(rows)
    n = len(rows)
    f = {k: np.full(n, np.nan) for k in sb_catalog.FLOAT_FIELDS}
    s = {k: np.full(n, None, dtype=object) for k in sb_catalog.STR_FIELDS}
    for i, (spk, pdes, kind, cls, H, fn) in enumerate(rows):
        s["pdes"][i], s["kind"][i], s["class"][i], s["full_name"][i] = pdes, kind, cls, fn
        f["H"][i] = H
    return sb_catalog.Catalog(np.array([r[0] for r in rows]), f, s, np.zeros(n, bool), np.zeros(n, bool),
                              np.zeros(n, int))


def _fit(num, D, Derr, pv, pverr, code, prov=None, packed="00000"):
    return NeowiseFit(num, prov, packed, 15.0, 0.15, 2455300.0, 40, code, D, Derr, pv, pverr, "Mas11", "", "t.csv")


def _no_gaia():
    return GaiaSpectra(np.zeros(0, int), np.zeros(0, object), np.zeros((0, 16)), np.zeros((0, 16)),
                       np.zeros((0, 16), int), GAIA_WAVELENGTHS_NM)


def _base():
    # 30 main-belt objects with measured albedo 0.1 (to form the class statistic) + the objects under test
    rows = [(20000001 + k, str(1 + k), "an", "MBA", 10.0 + 0.1 * k, f"{1 + k} X") for k in range(30)]
    rows += [
        (20000100, "100", "an", "MBA", 12.0, "100 Hekate (A868 NA)"),   # SBDB diameter + NEOWISE fit
        (20000101, "101", "an", "MBA", 12.0, "101 Helena"),              # NEOWISE only, D fitted
        (20000102, "102", "an", "MBA", 12.0, "102 Miriam"),              # NEOWISE only, D held fixed
        (3000001, "2010 AB12", "au", "APO", 20.0, "(2010 AB12)"),        # nothing measured: estimate from H
        (1000001, "1P", "cn", "HTC", 5.5, "1P/Halley"),                  # comet: never a diameter from H
    ]
    cat = _catalog(rows)
    phys = {20000001 + k: {"diameter": None, "diameter_sigma": None, "albedo": "0.1", "rot_per": None, "BV": None,
                           "UB": None, "IR": None, "spec_B": None, "spec_T": None} for k in range(30)}
    phys[20000100] = {"diameter": "89.0", "diameter_sigma": "2.0", "albedo": "0.05", "rot_per": "27.0", "BV": "0.7",
                      "UB": None, "IR": None, "spec_B": "C", "spec_T": None}
    return cat, phys


def test_diameter_albedo_precedence_and_fit_codes():
    cat, phys = _base()
    fits = [_fit(100, 95.0, 3.0, 0.04, 0.01, "DVBI"),
            _fit(101, 10.0, 1.0, 0.2, 0.05, "DVB-"), _fit(101, 12.0, 1.0, 0.25, 0.05, "DVB-"),
            _fit(102, 7.0, 0.0, 0.1, 0.0, "--B-")]
    ph = sb_physical.build(cat, phys, fits, [], _no_gaia(), SRC)
    c = ph.cols
    i100, i101, i102 = cat.row_of(20000100), cat.row_of(20000101), cat.row_of(20000102)
    # SBDB value wins; NEOWISE only fills gaps
    assert c["diameter"][i100] == 89.0 and c["diameterLabel"][i100] == M and c["diameterSrc"][i100] == SRC["sbdb"]
    # two D-fitted NEOWISE fits: inverse-variance mean, sigma = max(formal, scatter)
    assert c["diameter"][i101] == pytest.approx(11.0) and c["diameterSrc"][i101] == SRC["neowise"]
    assert c["diameterSigma"][i101] == pytest.approx(np.std([10.0, 12.0], ddof=1))
    assert c["albedoLabel"][i101] == M
    # fit code without D: the listed diameter is an assumed value, not a measurement
    assert c["diameterLabel"][i102] == U and math.isnan(c["diameter"][i102])
    assert ph.stats["sbdbOverNeowiseDiameterRatio"]["n"] == 1


def test_estimated_diameter_only_where_unmeasured_and_never_for_comets():
    cat, phys = _base()
    ph = sb_physical.build(cat, phys, [], [], _no_gaia(), SRC)
    c = ph.cols
    neo, comet, i100 = cat.row_of(3000001), cat.row_of(1000001), cat.row_of(20000100)
    assert math.isnan(c["diameterEst"][i100]) and c["diameterEstLabel"][i100] == U   # measured D exists
    assert c["diameterEstLabel"][comet] == U and math.isnan(c["diameterEst"][comet])
    # APO has no measured albedos here -> the all-class median (0.1 from the 30 MBAs), labelled estimated
    assert ph.class_albedo["MBA"]["median"] == pytest.approx(0.1) and "APO" not in ph.class_albedo
    assert c["diameterEstLabel"][neo] == E and c["diameterEstSrc"][neo] == SRC["stat"]
    assert c["diameterEst"][neo] == pytest.approx(1329.0 / math.sqrt(0.1) * 10 ** (-20.0 / 5))
    # an MBA with a measured albedo but no diameter: D from H and its own p_V (the stage labels this derived)
    i0 = cat.row_of(20000001)
    assert c["albedoAssumed"][i0] == pytest.approx(0.1) and c["diameterEstSrc"][i0] == SRC["sbdb"]


def test_lcdb_reliability_codes():
    cat, phys = _base()
    lc = [LcdbEntry(100, "Hekate", "", 27.07, "3", ""), LcdbEntry(101, "Helena", "", 23.08, "1+", ""),
          LcdbEntry(102, "Miriam", "", 15.0, "2", ">"), LcdbEntry(1, "X", "", 9.0, "0", ""),
          LcdbEntry(None, "2010 AB12", "2010 AB12", 3.3, "2-", "")]
    ph = sb_physical.build(cat, phys, [], lc, _no_gaia(), SRC)
    c = ph.cols
    i100, i101, i102 = cat.row_of(20000100), cat.row_of(20000101), cat.row_of(20000102)
    assert c["rotPeriod"][i100] == 27.07 and c["rotLabel"][i100] == M and c["rotSrc"][i100] == SRC["lcdb"]
    assert sb_physical.LCDB_U_CODES[c["rotQuality"][i100]] == "3"
    assert c["rotLabel"][i101] == E and sb_physical.LCDB_U_CODES[c["rotQuality"][i101]] == "1+"
    assert c["rotLabel"][i102] == U                                 # a period limit is not a period
    assert c["rotLabel"][cat.row_of(20000001)] == U                 # U = 0: proven wrong, not used
    assert c["rotLabel"][cat.row_of(3000001)] == M                  # matched by provisional designation
    assert ph.stats["lcdb"] == {"measured": 2, "estimated": 1, "limit": 1, "U0": 1, "unmatched": 0}


@pytest.mark.skipif(not HAVE_LIGHT, reason="solar spectrum / CIE / filter downloads missing (run the light stage)")
def test_gaia_colour_labels():
    cat, phys = _base()
    refl = np.tile(np.linspace(0.9, 1.2, 16), (2, 1))
    flag = np.zeros((2, 16), int)
    flag[1, 0] = 1  # 374 nm band flagged -> bridged -> estimated
    g = GaiaSpectra(np.array([100, 0]), np.array(["hekate", "2010 AB12"], dtype=object), refl, refl * 0.01, flag,
                    GAIA_WAVELENGTHS_NM)
    ph = sb_physical.build(cat, phys, [], [], g, SRC)
    c = ph.cols
    i100, neo = cat.row_of(20000100), cat.row_of(3000001)
    assert c["colorLabel"][i100] == D and c["colorSrc"][i100] == SRC["gaia"]   # measured spectrum x measured p_V
    assert c["colorLabel"][neo] == E                                         # assumed p_V (and a bridged band)
    xyz = c["geometricAlbedoXYZS"][i100]
    # Y / (Y of sunlight) ~ p_V times the spectrum's V-weighted mean relative to V (=1 by construction) -> ~0.05
    from pipeline.photometry import solar
    y_sun = solar.irradiance_xyzs()[1]
    assert xyz[1] / y_sun == pytest.approx(0.05, rel=0.03)
    assert xyz[0] > 0 and xyz[2] > 0 and xyz[3] > 0


def test_ssobft_phase_function_constraints_and_spin():
    from pipeline.sb_physical_sources import SsoBft
    cat, phys = _base()
    nan = float("nan")
    ph_cols = {k: np.array(v, dtype=float) for k, v in {
        "H": [7.0, 20.0], "G1": [0.7, 0.9], "G2": [0.2, 0.3], "H_err": [0.1, 0.2], "G1_err": [nan, nan],
        "G2_err": [nan, nan], "phase_min": [1.0, 2.0], "phase_max": [25.0, 20.0], "rms": [0.1, 0.1]}.items()}
    ph_cols["N"] = np.array([120, 30])
    b = SsoBft(np.array([100, 0]), np.array(["hekate", "2010 AB12"], dtype=object), ph_cols,
               np.array(["V", "orange"], dtype=object), np.array(["MPCATOBS", "ATLAS"], dtype=object),
               {"RA0": np.array([10.0, nan]), "DEC0": np.array([-5.0, nan]), "period": np.array([27.07, nan])},
               np.array(["LCI", ""], dtype=object), np.array(["C", ""], dtype=object),
               np.array(["Mahlke", ""], dtype=object), np.array(["Spec", ""], dtype=object))
    ph = sb_physical.build(cat, phys, [], [], _no_gaia(), dict(SRC, bft=9), bft=b)
    c = ph.cols
    i100, neo = cat.row_of(20000100), cat.row_of(3000001)
    assert c["phaseLabel"][i100] == M and c["phaseG1"][i100] == 0.7 and c["phaseSrc"][i100] == 9
    assert ph.phase_filters[c["phaseFilter"][i100]] == "V" and c["phaseMaxDeg"][i100] == 25.0
    assert c["phaseLabel"][neo] == U                      # G1 + G2 = 1.2 > 1: not a valid H-G1-G2 phase function
    assert ph.stats["ssobft"]["phaseOutsideConstraints"] == 1
    assert c["spinLabel"][i100] == M and c["poleRA"][i100] == 10.0
    assert ph.spin_techniques[c["spinTechnique"][i100]] == "LCI"
    assert ph.taxonomy_bft[c["taxonomyBft"][i100]] == "Mahlke|C|Spec"
