"""Small-body photometry inputs: class-colour assignment (sb_class_colours), the sbpy phase-function constants and
spline construction (stages/sbphotometry), and the built products where present."""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from pipeline import sb_class_colours as scc
from pipeline.paths import OUT
from pipeline.stages import sbphotometry as sp

CC = {
    "classes": {k: {"colour": {"value": {"xyzsPerUnitPV": [1.0 + i, 2.0, 3.0, 4.0]}},
                    "pV": {"value": {"median": 0.1 * (i + 1)} if k != "O" else None}}
                for i, k in enumerate(["S", "C", "Xe", "Xk", "B", "Sq", "O"])},
    "population": {"colour": {"value": {"xyzsPerUnitPV": [9.0, 9.0, 9.0, 9.0]}}},
    "aliases": {"bus": {"Sk": "Sq"}, "tholen": {"S": "S", "C": "C", "F": "B", "E": "Xe", "M": "Xk"},
                "mahlke": {"E": "Xe", "M": "Xk"}},
}


def test_resolve_names_and_aliases():
    assert scc.resolve(CC, "Bus-DeMeo", "S") == "S"
    assert scc.resolve(CC, "Bus", "Sk") == "Sq"
    assert scc.resolve(CC, "Tholen", "F") == "B"
    assert scc.resolve(CC, "Tholen", "CX:") == "C"          # multi-letter: first letter; ':' dropped
    assert scc.resolve(CC, "Mahlke", "M") == "Xk"
    assert scc.resolve(CC, "Mahlke", "Z") is None             # not in this test's alias table
    assert scc.resolve(CC, "Bus", "") is None


def test_assign_priority_and_fill():
    n = 5
    is_comet = np.array([False, False, False, False, True])
    bft = np.array([1, 0, 0, 0, 0])          # object 0: SsODNet 'Tholen|F|Phot'
    bus = np.array([0, 1, 0, 0, 0])          # object 1: SMASSII 'Sk'
    tho = np.array([2, 0, 1, 0, 0])          # object 2: Tholen 'E' (object 0 also has one, SsODNet wins)
    cl = scc.assign(CC, n, is_comet, bft, ["", "Tholen|F|Phot"], bus, ["", "Sk"], tho, ["", "E", "M"])
    names = cl.names
    assert [names[k] if k != scc.NO_CLASS else None for k in cl.index] == ["B", "Sq", "Xe", "population", None]
    assert list(cl.method) == [0, 1, 2, 3, 255]
    c = {"colorLabel": np.array([4, 4, 1, 4, 4], dtype=np.uint8), "colorSrc": np.zeros(n, dtype=np.uint8),
         "geometricAlbedoXYZS": np.full((n, 4), np.nan)}
    pv_orbit = np.full(n, 0.2)
    pv_meas = np.array([0.5, np.nan, np.nan, np.nan, np.nan])
    got = scc.fill_physical(c, np.arange(n), cl, pv_orbit, pv_meas, 2, 4, 7)
    assert got == 3                           # object 2 already has a (Gaia) colour, the comet gets none
    assert c["geometricAlbedoXYZS"][0][0] == pytest.approx(0.5 * 5.0)   # measured p_V x B colour
    assert c["geometricAlbedoXYZS"][1][0] == pytest.approx(0.6 * 6.0)   # class median p_V (Sq) x Sq colour
    assert c["geometricAlbedoXYZS"][3][0] == pytest.approx(0.2 * 9.0)   # population: orbit-class median p_V
    assert list(c["colorLabel"]) == [2, 2, 1, 2, 4] and c["colorSrc"][0] == 7


def test_spline_construction_reproduces_nodes_and_end_slopes():
    x = [math.radians(v) for v in (0.0, 0.3, 1.0, 2.0, 4.0, 8.0, 12.0, 20.0, 30.0)]
    y = [1.0, 0.83381185, 0.57735424, 0.42144772, 0.2317423, 0.10348178, 0.061733473, 0.016107006, 0.0]
    dy = [-1.0630097, 0.0]
    coef = sp.spline_coefficients(x, y, dy)
    b = {"nodesRad": x, "values": y, "endDerivatives": dy, "coefficients": coef}
    for xi, yi in zip(x[:-1], y[:-1]):
        assert sp.eval_basis(b, xi) == pytest.approx(yi, abs=1e-12)
    assert coef[0][1] == pytest.approx(dy[0])
    h = x[-1] - x[-2]
    a = coef[-1]
    assert a[1] + 2 * a[2] * h + 3 * a[3] * h * h == pytest.approx(dy[1], abs=1e-9)
    assert sp.eval_basis(b, math.radians(40)) == 0.0   # linear beyond, clipped at 0


@pytest.mark.skipif(not sp.SBPY._dest().exists(), reason="sbpy tarball not downloaded (run the sbphotometry stage)")
def test_sbpy_constants_parse():
    src = sp.sbpy_iau_source()
    hg = sp.hg_constants(src)
    assert hg["A"] == [3.332, 1.862] and hg["B"] == [0.631, 1.218] and hg["C"] == [0.986, 0.238] and hg["W"] == 90.56
    nodes = sp.hg1g2_nodes(src)
    assert nodes["phi1"]["values"][0] == 0.75 and len(nodes["phi3"]["nodesRad"]) == 9
    assert sp.hg_phi(hg, 0.0, 0.15) == pytest.approx(1.0)


@pytest.mark.skipif(not (OUT / "smallbodies/core.json").exists(), reason="smallbodies products not built")
def test_built_class_colours_and_photometry_product():
    core = json.loads((OUT / "smallbodies/core.json").read_text(encoding="utf-8"))
    cc = core["colorClasses"]
    assert cc["classes"][-1]["name"] == "population"
    assert sum(cc["counts"].values()) + core["statistics"]["kinds"]["numberedComets"] \
        + core["statistics"]["kinds"]["unnumberedComets"] == core["count"]
    phot = json.loads((OUT / "smallbodies/photometry.json").read_text(encoding="utf-8"))
    assert phot["vSun"]["value"] == -26.76
    assert 0.97 < phot["colour"]["yOverV"]["p1"] < 1.0 < phot["colour"]["yOverV"]["p99"] < 1.05
