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
    for n in (199, 301, 399, 501, 601, 701):
        assert spatial.spatial_model_for(n, None) is None


def test_hapke_law_is_physical_for_all_entries():
    """Each Hapke set gives a positive particle phase function over 0-180° (Charon's c > 1 is allowed for small b)."""
    for n in (499, 502, 503, 504, 801, 901, 999):
        v = spatial.spatial_model_for(n, None)["value"]
        for g in np.radians(np.arange(0, 181, 5)):
            b, c = v["b"], v["c"]
            p = ((1 + c) / 2 * (1 - b * b) / (1 - 2 * b * math.cos(g) + b * b) ** 1.5
                 + (1 - c) / 2 * (1 - b * b) / (1 + 2 * b * math.cos(g) + b * b) ** 1.5)
            assert p > 0, (n, g)
