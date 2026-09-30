"""Transcribed tables must satisfy the identities of their source papers (catches transcription errors)."""

import math

import numpy as np
import pytest

from pipeline.photometry import phase, solar
from pipeline.photometry.common import read_table_csv, read_table_json


def test_neckel_labs_rows_satisfy_eqs_5_and_6():
    wl, a, fi = solar.neckel_labs_table(apply_errata=True)
    assert wl.size == 30 and wl[0] == pytest.approx(303.327) and wl[-1] == pytest.approx(1098.950)
    # Eq. 5: sum A_n = 1 (coefficients are printed to 5 decimals: rounding allows 3e-5).
    assert np.max(np.abs(a.sum(axis=1) - 1.0)) < 3.5e-5
    # Eq. 6: F/I = 2 (A0/2 + A1/3 + ... + A5/7), printed to 4 decimals.
    assert np.max(np.abs(2.0 * (a / np.arange(2, 8)).sum(axis=1) - fi)) < 7e-5


def test_neckel_labs_printed_row_365_is_inconsistent():
    """The printed A2 at 365.875 nm fails both identities by exactly the amount the erratum fixes."""
    wl, a, fi = solar.neckel_labs_table(apply_errata=False)
    i = int(np.argmin(np.abs(wl - 365.875)))
    assert a[i].sum() - 1.0 == pytest.approx(-0.002, abs=2e-5)
    assert 2.0 * (a[i] / np.arange(2, 8)).sum() - fi[i] == pytest.approx(-0.002 / 2, abs=1e-4)


def test_lane_irvine_tables_vii_and_viii_agree_via_eq2():
    """log10 p = 0.4 (m_sun - m(1,0)) - 2 log10 sin(sigma) (paper Eq. 2). Narrow-band colours are relative to the
    Sun, so m_sun = V_sun = -26.81 there; for B the paper takes (B-V)_sun = 0.65. U is skipped (the paper does
    not state the (U-B)_sun it used)."""
    for r in read_table_csv("lane_irvine_1973.csv"):
        if r["band"] == "U":
            continue
        m_sun = -26.81 + (0.65 if r["band"] == "B" else 0.0)
        p = 10 ** (0.4 * (m_sun - float(r["m10"])) - 2 * math.log10(math.sin(0.0045216)))
        assert p == pytest.approx(float(r["p"]), abs=0.0011), r["band"]
        assert float(r["p"]) * float(r["q"]) == pytest.approx(float(r["A"]), abs=0.0011), r["band"]


def test_lane_irvine_phase_table_is_monotonic():
    rows = read_table_csv("lane_irvine_1973_phase.csv")
    for col in rows[0]:
        if col == "phase_deg":
            continue
        v = [float(r[col]) for r in rows]
        assert v[0] == 0 and all(b > a for a, b in zip(v, v[1:])), col


def test_mallama_hilton_coefficients_appear_in_reference_code():
    assert phase.verify_against_code() == []


def test_mallama_hilton_equation_joins_are_continuous():
    # The authors adjusted constants so that pieces join (paper Secs. 3.4-3.6).
    for naif, at in ((599, 12.0), (499, 50.0), (699, 6.5)):
        b = phase.MH["bodies"][str(naif)]
        p0, p1 = b["pieces"][0], b["pieces"][1]
        assert phase._piece_mag(p0, at) == pytest.approx(phase._piece_mag(p1, at), abs=0.003), naif


def test_buie_pluto_numbers():
    t = read_table_json("buie_2010a_pluto.json")["pluto"]
    # B - V at 1 deg from the two a0 terms agrees with the published weighted mean colour (0.9540 +- 0.0010)
    # within the light-curve fit uncertainties.
    assert t["B_a0_1deg"] - t["V_a0_1deg"] == pytest.approx(t["B_minus_V_weighted_mean"], abs=0.005)


def test_wang_saturn_digitization():
    """Wang et al. (2024) Fig. 7: the digitized curves are smooth four-order polynomials (as fitted in the paper),
    pass the ESO points at 5.7 deg, fall monotonically to 150 deg, and the three filters agree within a few percent."""
    rows = read_table_csv("wang_2024_saturn_fig7.csv")
    assert {r["filter"] for r in rows} == {"RED", "GRN", "BL1"}
    eso = {"RED": 0.562, "GRN": 0.509, "BL1": 0.373}          # the digitized ESO dots
    for f in ("RED", "GRN", "BL1"):
        a = np.array([float(r["alpha_deg"]) for r in rows if r["filter"] == f])
        y = np.array([float(r["reflectance"]) for r in rows if r["filter"] == f])
        assert a.min() < 3 and a.max() > 175 and len(a) > 300
        c = phase.wang_saturn_poly(f)
        assert np.sqrt(np.mean((np.polyval(c, a) - y) ** 2)) < 0.0015, f
        assert np.polyval(c, 5.7) == pytest.approx(eso[f], rel=0.03), f     # the fit need not pass the dot
        r = [phase.saturn_iss_ratio(f, x) for x in np.arange(5.7, 150.1, 1.0)]
        assert r[0] == pytest.approx(1.0) and all(q < p for p, q in zip(r, r[1:])), f
    for x in (20.0, 54.6, 90.0):
        g = phase.saturn_iss_ratio("GRN", x)
        assert phase.saturn_iss_ratio("RED", x) == pytest.approx(g, rel=0.07)
        assert phase.saturn_iss_ratio("BL1", x) == pytest.approx(g, rel=0.08)
    assert phase.saturn_iss_ratio("GRN", 54.6) == pytest.approx(0.424, abs=0.01)


def test_saturn_phase_joins_eq11_at_the_eso_angle():
    p = phase.phase_for(699)
    a = np.array(p.function["alphaDeg"])
    m = np.array(p.function["deltaMag"])
    z = phase.MH["bodies"]["699"]["V10_zero_phase"]
    a0 = phase.SATURN_ESO_PHASE_DEG
    assert a0 in a and a.max() == phase.SATURN_ISS_MAX_DEG
    for x in a[a <= a0]:
        assert np.interp(x, a, m) == pytest.approx(phase.mh_reduced_mag(699, x) - z, abs=1e-5)
    # continuous at the join (Eq. 11 is flat there, the ISS curve falls ~0.02 mag/deg)
    assert abs(np.interp(a0 + 0.3, a, m) - np.interp(a0, a, m)) < 0.01
    assert p.label == "estimated" and p.sources == ["mallama-hilton-2018", "wang-2024"]
    # the ISS curve is fainter than Eq. 12 (the Pioneer red model) at intermediate phase
    assert 10 ** (-0.4 * np.interp(54.6, a, m)) < 0.8 * 10 ** (-0.4 * (phase.mh_reduced_mag(699, 54.6) - z))
