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
