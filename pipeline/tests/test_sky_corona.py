"""The solar corona model (sky_corona.py, sky/corona.json): transcriptions, Thomson kernel, density inversion, totals
against van de Hulst (1950), the LASCO F-corona fit and the solar-cycle phase. Offline: everything is in the repo's
sky_tables."""

from __future__ import annotations

import json

import numpy as np
import pytest

from pipeline import sky_corona as sc
from pipeline import sky_zodi as zl

U = 0.5865   # photopic u of the Neckel & Labs law (light.json): 3 (1 - 0.8045)


@pytest.fixture(scope="module")
def model():
    return sc.build_model(U)


# ------------------------------------------------------------------------------------------------ transcriptions

def test_vandehulst_table1_follows_from_the_laws():
    """Eq. 10 on Eqs. 5-9 reproduces every entry of Table I to its rounding: a check of the transcribed laws."""
    v = sc.vandehulst()
    t = v["table1"]
    laws = {"K_max": "K_max", "K_min": "K_min", "K_pole": "K_pole", "F": "F"}
    for law_name, col in laws.items():
        for (a, b), want in zip(t["ranges"], t[col]):
            got = sc.ring_total(v["laws"][law_name]["coeffs"], a, b if b else np.inf) * 1e-8 * 1e6
            assert got == pytest.approx(want, abs=0.0025), (law_name, a, b)
    for (a, b), want, kmin, kpole in zip(t["ranges"], t["K_min_weighted"], t["K_min"], t["K_pole"]):
        assert 0.7 * kmin + 0.3 * kpole == pytest.approx(want, abs=0.0015)
    for i in range(4):
        assert t["K_max"][i] + t["F"][i] == pytest.approx(t["K_max_plus_F"][i], abs=0.0015)


def test_vandehulst_laws_are_consistent():
    L = sc.vandehulst()["laws"]
    c = sc.vandehulst()["model"]["c"]
    for n in ("17", "7", "2.5"):
        # K_max = c K_min (the laws were made by multiplying one law by c^(1/2) = 1.33 and c^(-1/2) = 0.75, p. 139)
        assert L["K_max"]["coeffs"][n] / L["K_min"]["coeffs"][n] == pytest.approx(c, abs=0.003)
    kpf = L["K_pole_plus_F"]["coeffs"]
    assert kpf["7"] == pytest.approx(L["K_pole"]["coeffs"]["7"] + L["F"]["coeffs"]["7"], abs=1e-9)  # Eq. 8 = 7 + 9
    # K = F where the paper says (p. 140)
    r = np.linspace(1.05, 4.0, 30001)
    for law_name, want in (("K_max", 2.24), ("K_min", 1.93), ("K_pole", 1.28)):
        k = sc.law(law_name, r) - sc.law("F", r)
        assert r[np.argmin(np.abs(k))] == pytest.approx(want, abs=0.02), law_name   # the paper rounds (Table 2)


def test_saito1977_transcription():
    s = sc.saito1977()
    c = s["table1"]["background_equator"]
    for row in s["table2"]:
        if row.get("extrapolated"):
            continue
        ne = c["c1"] * row["r"] ** -c["d1"] + c["c2"] * row["r"] ** -c["d2"]
        assert ne == pytest.approx(row["N_e"], rel=0.02)
        assert row["B_K"] + row["B_F"] == pytest.approx(row["B_KF"], rel=0.06)   # 2-digit rounding
    for row in s["table3_spherical"] + s["table3_axisymmetric"]:
        if "B_F" in row and not row.get("extrapolated_K"):
            assert row["B_K"] + row["B_F"] == pytest.approx(row["B_KF"], rel=0.06)


def test_leinert_table23_units():
    t = zl.leinert_constants()["f_corona_table23"]
    s10 = zl.leinert_constants()["s10_sun"]
    # 1e-9 B_sun in W m^-2 sr^-1 um^-1 = 1e-9 x 2.22e15 S10 x 1.28e-8
    assert 1e-9 * t["B_sun_in_S10sun"] * s10["W_m2_sr_um_at_500nm"] == pytest.approx(t["B_sun_1e-9_in_W_m2_sr_um"], rel=0.01)
    assert t["B_sun_in_F_sun_per_sr"] == pytest.approx(t["B_sun_in_S10sun"] * s10["per_sr_of_solar_flux"], rel=0.01)


# ------------------------------------------------------------------------------------------------ physics

def _brute_kernel(r, chi, u, n=600):
    """Thomson scattering of the limb-darkened disk, integrated directly (units of pi r_e^2 / 2 I0)."""
    om = np.arcsin(1 / r)
    th = (np.arange(n)[:, None] + 0.5) * om / n
    ph = (np.arange(2 * n)[None, :] + 0.5) * np.pi / n
    kin = np.stack([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th) * np.ones_like(ph)], -1)
    mu = np.sqrt(np.maximum(1 - (r * np.sin(th)) ** 2, 0)) * np.ones_like(ph)
    d_om = np.sin(th) * (om / n) * (np.pi / n)
    cos_t = kin @ np.array([np.sin(chi), 0, np.cos(chi)])
    return float(np.sum((1 + cos_t ** 2) * (1 - u + u * mu) * d_om) / np.pi)


@pytest.mark.parametrize("r", [1.01, 1.3, 3.0, 25.0])
@pytest.mark.parametrize("chi", [0.4, np.pi / 2, 2.6])
def test_kernel_equals_direct_integration(r, chi):
    for u in (0.0, U):
        k = sc.kernel(np.array([r]), np.array([np.sin(chi) ** 2]), u)[0]
        assert k == pytest.approx(_brute_kernel(r, chi, u), rel=3e-5)


def test_kernel_far_limit_is_thomson():
    """Far from the Sun: (pi r_e^2 / 2) I0 Omega^2 (1 - u/3)(1 + cos^2 chi), i.e. the point-source Thomson law."""
    r, chi = 25.0, 1.0
    om2 = np.arcsin(1 / r) ** 2
    k = sc.kernel(np.array([r]), np.array([np.sin(chi) ** 2]), U)[0]
    assert k == pytest.approx(om2 * (1 - U / 3) * (1 + np.cos(chi) ** 2), rel=3e-3)


def test_line_of_sight_quadrature_converges():
    n = lambda r, t: 1e8 * r ** -16 + 1e6 * r ** -2.5   # noqa: E731
    rho = np.array([1.02, 1.5, 4.0, 20.0])
    a = sc.los_distant(n, rho, U, nodes=48)
    b = sc.los_distant(n, rho, U, nodes=400)
    assert np.allclose(a, b, rtol=2e-4)


# ------------------------------------------------------------------------------------------------ model

def test_densities_reproduce_the_brightness_laws(model):
    m, info = model
    rho = np.geomspace(1.01, 6.0, 25)
    assert np.allclose(sc.brightness_distant(m, rho, 90.0, 0.0), sc.law("K_min", rho), rtol=0.03)
    assert np.allclose(sc.brightness_distant(m, rho, 90.0, 1.0), sc.law("K_max", rho), rtol=0.03)
    rp = np.geomspace(1.01, 1.5, 12)                                  # the polar fit range (to 23 %)
    assert np.allclose(sc.brightness_distant(m, rp, 0.0, 0.0), sc.law("K_pole", rp), rtol=0.25)
    assert all(v > 0 for v in m.eq.values()) and all(v > 0 for v in m.pole.values())
    assert 45.0 < info["beltLatitudeDeg"] < 63.0


def test_totals_match_table1(model):
    """Fitted: the minimum-phase total. Independent: the maximum-phase total and the 1.03-6 rings."""
    m, _ = model
    t = sc.vandehulst()["table1"]
    assert sc.ring_total_model(m, 1.0, sc.R_MAX, 0.0) * 1e6 == pytest.approx(t["K_min_weighted"][3], rel=0.005)
    assert sc.ring_total_model(m, 1.0, sc.R_MAX, 1.0) * 1e6 == pytest.approx(t["K_max"][3], rel=0.02)
    assert sc.ring_total_model(m, 1.03, 6.0, 0.0) * 1e6 == pytest.approx(t["K_min_weighted"][1], rel=0.03)
    assert sc.ring_total_model(m, 1.03, 6.0, 1.0) * 1e6 == pytest.approx(t["K_max"][1], rel=0.03)


def test_minimum_corona_is_flattened(model):
    """At minimum the equatorial corona is brighter than the polar one; at maximum the corona is circular."""
    m, _ = model
    rho = np.array([1.5, 2.5])
    assert np.all(sc.brightness_distant(m, rho, 90.0, 0.0) > 3 * sc.brightness_distant(m, rho, 0.0, 0.0))
    assert np.allclose(sc.brightness_distant(m, rho, 90.0, 1.0), sc.brightness_distant(m, rho, 0.0, 1.0), rtol=1e-9)


# ------------------------------------------------------------------------------------------------ F-corona

def test_lasco_table_reading_puts_the_major_axis_on_the_equator():
    """With the table's rows read as beta (sky_tables/lamy_2022_table5.json), the equatorial direction is the bright
    one and the polar profile the steep one, as the paper's text and every other source say."""
    f = sc.fit_f_corona()
    r = np.array([5.0, 10.0, 20.0])
    assert np.all(f.b(r, 0 * r) > 1.3 * f.b(r, 1 + 0 * r))
    r1, r2 = sc.AU_RSUN * np.sin(np.radians([3.0, 7.5]))
    slope = lambda sp: (f.log10b(r2, sp) - f.log10b(r1, sp)) / np.log10(r2 / r1)  # noqa: E731
    assert -2.4 < slope(0.0) < -2.1 and -2.65 < slope(1.0) < -2.4        # paper: -2.33, -2.55
    assert f.rms_dex < np.log10(1.05)                                      # within the map's 5 %


def test_lasco_fit_joins_leinert_table16_at_15_deg():
    f = sc.fit_f_corona()
    r15 = sc.AU_RSUN * np.sin(np.radians(15.0))
    s10 = sc.lamy2022()["S10_in_B_sun"]
    lam, beta, tab = zl.leinert_table(16)
    assert f.b(r15, 0.0) / s10 == pytest.approx(tab[list(lam).index(15.0), list(beta).index(0.0)], rel=0.15)
    assert f.b(r15, 1.0) / s10 == pytest.approx(tab[list(lam).index(0.0), list(beta).index(15.0)], rel=0.30)


def test_lasco_fit_against_skylab_and_vandehulst():
    f = sc.fit_f_corona()
    refs = sc.f_corona_references()
    for key, sp in (("equator", 0.0), ("pole", 1.0)):
        r, b = refs["saito1977_skylab"][key]
        assert np.all(np.abs(np.log(f.b(r, sp + 0 * r) / b)) < np.log(1.3)), key
        r, b = refs["vandehulst1950_eq7"][key]
        sel = (r >= 2.0) & (r <= 10.0)
        assert np.all(np.abs(np.log(f.b(r[sel], sp + 0 * r[sel]) / b[sel])) < np.log(1.7)), key


# ------------------------------------------------------------------------------------------------ phase

def test_cycle_phase():
    assert sc.cycle_phase(2019.958, 2019.958, 2024.791, 2030.958) == 0.0
    assert sc.cycle_phase(2024.791, 2019.958, 2024.791, 2030.958) == 1.0
    assert sc.cycle_phase(2027.5846, 2019.958, 2024.791, 2030.958) == pytest.approx(1 - 2.7936 / 6.167, abs=1e-3)
    assert sc.cycle_phase(2022.3745, 2019.958, 2024.791, 2030.958) == pytest.approx(0.5, abs=1e-3)
    assert sc.decimal_year(sc.et_of_iso("2027-08-02T10:07:50")) == pytest.approx(2027.585, abs=0.002)


def test_silso_and_swpc_parsing(tmp_path):
    rows = []
    for k in range(12 * 12):
        y = 2016 + k / 12
        sn = 100 + 90 * np.cos(2 * np.pi * (y - 2024.8) / 11.0)
        rows.append(f"{int(y)};{k % 12 + 1:02d};{int(y) + (k % 12 + 0.5) / 12:.3f};{sn:6.1f}; 5.0; 900;1")
    p = tmp_path / "sn.csv"
    p.write_text("\n".join(rows) + "\n", encoding="utf-8")
    mn, mx = sc.silso_extrema(p, 2015.0)
    assert abs(mn[0] - 2019.3) < 0.2 and abs(mx[0] - 2024.8) < 0.1
    q = tmp_path / "p.json"
    q.write_text(json.dumps([{"time-tag": "2030-11", "predicted_ssn": 9.0}, {"time-tag": "2030-12", "predicted_ssn": 8.1}]))
    y, sn, month, at_end = sc.swpc_next_minimum(q)
    assert month == "2030-12" and at_end and sn == 8.1 and y == pytest.approx(2030.958, abs=1e-3)
    assert sc.swpc_value(q, "2030-11") == 9.0
