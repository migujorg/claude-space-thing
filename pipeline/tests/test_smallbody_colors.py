"""Small-body class colours (photometry/smallbody_colors.py): parsers against known rows, physics checks of the
class colours and albedos, and the product's shape."""

import math

import numpy as np
import pytest

from pipeline.photometry import smallbody_colors as sc, solar
from pipeline.schema import LABEL_ORDER


@pytest.fixture(scope="module")
def product():
    return sc.build(None)


def test_parsers():
    wl, ms = sc.mean_spectra()
    assert wl[0] == 450.0 and wl[-1] == 2450.0 and sorted(ms) == sorted(sc.DEMEO_CLASSES)
    k = int(np.argmin(abs(wl - 550)))
    assert all(v[k] == pytest.approx(1.0, abs=0.011) for v in ms.values())        # normalized at 0.55 µm
    mem = sc.memberships()
    assert mem[1] == {"C"} and mem[4] == {"V"}          # Ceres, Vesta (DeMeo et al. 2009)
    ru, rb = sc.ecas_ratios()[4]                       # Vesta: u-v 0.428, b-v 0.142 (ECAS mean table)
    assert ru == pytest.approx(10 ** (-0.4 * 0.428)) and rb == pytest.approx(10 ** (-0.4 * 0.142))
    lu, lb, lv = sc.ecas_wavelengths()
    assert 335 < lu < 365 and 430 < lb < 450 and 545 < lv < 560
    f, n = sc.sdss_frequencies()
    assert n > 60000 and sum(f.values()) == pytest.approx(1.0)


def test_class_colours_and_albedos(product):
    e = solar.irradiance_xyzs()
    cls = product["classes"]
    xy = {}
    for c, v in cls.items():
        x = v["colour"]["value"]["xyzsPerUnitPV"]
        assert x[1] / e[1] == pytest.approx(1.0, abs=0.03), c           # p_V = 1 ⇒ Y ≈ sunlight's Y
        xy[c] = x[0] / sum(x[:3])
        assert v["colour"]["label"] == "derived" and v["pV"]["label"] in LABEL_ORDER
    assert xy["S"] > xy["C"] + 0.01 and xy["D"] > xy["C"] and xy["A"] > xy["S"]    # S, D, A redder than C
    pv = {c: v["pV"]["value"]["median"] for c, v in cls.items() if v["pV"]["value"]}
    assert pv["C"] < 0.08 < 0.2 < pv["S"] < 0.35 and pv["V"] > pv["S"]            # dark C, bright S and V
    pop = product["population"]
    assert pop["colour"]["label"] == "estimated" and 0.05 < pop["pV"]["value"]["median"] < 0.15


def test_uv_extension_matches_at_450nm():
    wl, r, info = sc.class_spectrum("S")
    assert wl[0] < 360 and wl[2] == 450.0
    # the extension below 450 nm meets the DeMeo mean continuously (by construction) and drops toward the UV
    assert r[0] < r[1] < r[2] * 1.02 and info["ecasN"] >= 3
