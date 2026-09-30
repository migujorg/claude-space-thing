"""photometry/spatial.py: published disk-resolved photometric laws (photometry.json spatialModel)."""

import math

import numpy as np
import pytest

from pipeline.photometry import spatial
from pipeline.photometry.common import read_table_csv


def test_domingue_verbiscer_transcription():
    """Tables 2.5-2.7 of Belgacem (2019): two hemispheres × two wavelengths per moon, physical ranges, and the two
    Europa trailing rows with h and B0 restored to their columns (the opposition effect is the same on both
    hemispheres, B0 ~ 0.5)."""
    rows = read_table_csv("domingue_verbiscer_1997_hapke.csv")
    assert len(rows) == 12
    for r in rows:
        assert 0 < float(r["w"]) < 1 and 0 <= float(r["b"]) < 1 and -1 <= float(r["c"]) <= 1, r
        assert 0 <= float(r["theta_deg"]) < 60 and 0 < float(r["h"]) < 1 and 0 < float(r["B0"]) <= 1, r
    eu = [r for r in rows if r["naif"] == "502"]
    assert {r["h"] for r in eu} == {"0.0016"} and all(float(r["B0"]) >= 0.45 for r in eu)
    assert [r["swapped"] for r in eu] == ["0", "0", "1", "1"]


def test_dv1997_mean_law():
    m = spatial.dv1997_hapke(503)
    assert m["label"] == "estimated" and m["sources"] == ["belgacem-2019-thesis"]
    v = m["value"]
    assert v["kind"] == "hapke" and v["hFunction"] == "hapke1981" and v["K"] == 1.0
    assert v["w"] == pytest.approx((0.945 + 0.81) / 2) and v["thetaBarDeg"] == pytest.approx(32.0)
    assert v["c"] == pytest.approx((0.427 + 0.962) / 2)


def test_verbiscer_table14_and_porosity():
    """K from hS reproduces the porosity and K ranges of Verbiscer et al. (2022) Table 16."""
    rows = {r["object"]: r for r in read_table_csv("verbiscer_2022_table14.csv")}
    assert len(rows) == 10 and rows["Pluto"]["naif"] == "999"
    # object: (K range, porosity % nominal)
    table16 = {"Pluto": ((1.00, 1.54), 92), "Triton": ((2.15, 2.31), 41), "Charon": ((1.30, 1.71), 66)}
    for name, ((k0, k1), por) in table16.items():
        K, f = spatial.porosity_k_from_hs(float(rows[name]["hS"]))
        assert k0 <= K <= k1, name
        assert 100 * (1 - f) == pytest.approx(por, abs=2), name
    v = spatial.verbiscer_hapke(999)["value"]
    assert v["w"] == 0.917 and v["c"] == -0.77 and v["bc0"] == 0.18 and v["hFunction"] == "hapke2002"


def test_vincendon_convention():
    v = spatial.vincendon_mars()["value"]
    assert v["c"] == pytest.approx(2 * 0.6 - 1) and v["w"] == 0.85 and v["thetaBarDeg"] == 17.0


def test_minnaert_k_interpolation():
    t = {"F467M": 0.85, "F547M": 0.80, "F657N": 0.57}
    assert spatial.k_at(t, 547.0) == pytest.approx(0.80)
    assert spatial.k_at(t, 602.0) == pytest.approx(0.80 + (0.57 - 0.80) * 55 / 110)
    assert spatial.k_at(t, 400.0) == 0.85 and spatial.k_at(t, 800.0) == 0.57


def test_y_effective_wavelength_grey():
    lam = spatial.y_effective_wavelength(np.ones_like(spatial.cie.WAVELENGTHS, dtype=float))
    assert 550 < lam < 575


def test_no_law_without_a_source():
    for n in (199, 301, 399, 606, 701):
        assert spatial.spatial_model_for(n, None) is None


def test_hapke_law_is_physical_for_all_entries():
    """Each Hapke set gives a positive particle phase function over 0-180° (Charon's c > 1 is allowed for small b)."""
    for n in (499, 501, 502, 503, 504, 801, 901, 999):
        v = spatial.spatial_model_for(n, None)["value"]
        for g in np.radians(np.arange(0, 181, 5)):
            b, c = v["b"], v["c"]
            p = ((1 + c) / 2 * (1 - b * b) / (1 - 2 * b * math.cos(g) + b * b) ** 1.5
                 + (1 - c) / 2 * (1 - b * b) / (1 + 2 * b * math.cos(g) + b * b) ** 1.5)
            assert p > 0, (n, g)


def test_barkstrom_transcription():
    """Dones et al. (1993) Table V as reproduced by Dyudina et al. (2016) Table 3: 0-150° measured, 180° not."""
    rows = read_table_csv("dones_1993_saturn_barkstrom.csv")
    assert len(rows) == 14
    for band, B0, B150 in (("red", 1.48, 1.34), ("blue", 1.11, 1.41)):
        rs = [r for r in rows if r["band"] == band]
        assert [int(r["alpha_deg"]) for r in rs] == [0, 30, 60, 90, 120, 150, 180]
        assert [r["measured"] for r in rs] == ["1"] * 6 + ["0"]
        assert float(rs[0]["B"]) == B0 and float(rs[5]["B"]) == B150
    used = spatial._barkstrom()
    assert len(used["red"]) == len(used["blue"]) == 6


def test_saturn_b_table():
    """Pioneer B interpolated linearly in wavelength between the blue and red passbands (held outside), 0-150°."""
    alphas, Bs = spatial.saturn_b_table(540.0)
    assert alphas == [0, 30, 60, 90, 120, 150]
    assert Bs[0] == pytest.approx((1.11 + 1.48) / 2) and Bs[-1] == pytest.approx((1.41 + 1.34) / 2)
    assert spatial.saturn_b_table(700.0)[1] == pytest.approx([1.48, 1.48, 1.46, 1.42, 1.36, 1.34])
    assert spatial.saturn_b_table(400.0)[1] == pytest.approx([1.11, 1.11, 1.15, 1.18, 1.20, 1.41])


def test_io_simonelli_veverka():
    m = spatial.io_hapke()
    assert m["label"] == "estimated" and m["sources"] == ["simonelli-veverka-1987"]
    v = m["value"]
    assert (v["w"], v["hs"], v["thetaBarDeg"], v["b"], v["c"]) == (0.68, 0.24, 25.0, 0.14, 1.0)
    assert v["bs0"] == pytest.approx(math.exp(-0.68 ** 2 / 2), abs=1e-4) and v["hFunction"] == "hapke1981"
    assert spatial.spatial_model_for(501, None) == m


def test_saturn_entry_layout(monkeypatch):
    """Barkstrom B(α): B = 2k_OPAL at 0° (exact equivalence there), Pioneer B at 30-150°, held at 180° (the paper's 180°
    column is an extrapolation and is not used); two sources; still 'estimated'."""
    monkeypatch.setattr(spatial, "opal_k", lambda naif, lam, ctx=None: (0.72, {"F547M": 0.72}, "opal-readme-x"))
    grey = np.ones_like(spatial.cie.WAVELENGTHS, dtype=float)
    m = spatial.giant_minnaert(699, grey)
    v = m["value"]
    assert v["kind"] == "barkstrom" and set(v) == {"kind", "B"}
    B = v["B"]
    assert B["alphaDeg"] == [0, 30, 60, 90, 120, 150, 180] and B["values"][0] == pytest.approx(1.44)
    lam = spatial.y_effective_wavelength(grey)
    assert B["values"][1:6] == pytest.approx(spatial.saturn_b_table(lam)[1][1:], abs=1e-4)
    assert B["values"][-1] == B["values"][-2]
    assert m["label"] == "estimated" and m["sources"] == ["opal-readme-x", "dyudina-2016"]
    j = spatial.giant_minnaert(599, grey)
    assert j["value"]["k"] == 0.72 and j["sources"] == ["opal-readme-x", "dyudina-2016"]
    u = spatial.giant_minnaert(799, grey)
    assert u["value"]["k"] == 0.72 and u["sources"] == ["opal-readme-x"]


def test_akimov_for_saturns_midsized_moons():
    for n in (601, 602, 603, 604, 605):
        m = spatial.spatial_model_for(n, None)
        assert m["value"] == {"kind": "akimov"} and m["label"] == "estimated" and m["sources"] == ["filacchione-2022"]
    assert spatial.spatial_model_for(606, None) is None and spatial.spatial_model_for(608, None) is None
