"""The nightglow stage (airglow and aurora; docs/reports/nightglow.md): the US Standard Atmosphere upper port against
the printed Table VIII, rayleigh -> luminance, the PALACE climatology's normalisation, the solar-flux series labels,
Fang et al. (2008) energy closure, the aurora emission peaks against the measured mean peak heights of Whiter et al.
(2023), the field-line tracing against a pure dipole, the OVATION season weights and the solar-wind coupling.
Tests that need a raw input skip offline when it is not on disk."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import numpy as np
import pytest

from pipeline import cie
from pipeline import nightglow_airglow as ag
from pipeline import nightglow_aurora as na
from pipeline import us76_upper

OUT = Path(__file__).resolve().parents[2] / "app" / "public" / "data" / "nightglow"

# US Standard Atmosphere 1976, Table VIII (number densities, m^-3): N2, O, O2, Ar, He.
TABLE_VIII = {
    86: (1.130e20, 8.600e16, 3.031e19, 1.351e18, 7.582e14),
    100: (9.210e18, 4.298e17, 2.151e18, 9.501e16, 1.133e14),
    120: (3.726e17, 9.275e16, 4.395e16, 1.366e15, 3.888e13),
    150: (3.124e16, 1.780e16, 2.750e15, 5.000e13, 2.106e13),
    200: (2.925e15, 4.050e15, 1.918e14, 1.938e12, 1.310e13),
    320: (5.158e13, 3.800e14, 1.942e12, 6.493e9, 6.901e12),
    900: (5.641e6, 3.989e10, 2.177e4, 7.742e-1, 6.933e11),
}


@pytest.mark.parametrize("z", sorted(TABLE_VIII))
def test_us76_upper_matches_table_viii(z):
    p = us76_upper.profile(np.array([float(z)]))
    for s, want in zip(("N2", "O", "O2", "Ar", "He"), TABLE_VIII[z]):
        assert p[s][0] / want == pytest.approx(1.0, abs=0.01), (z, s)


def test_rayleigh_to_luminance_green_line():
    """1 R of O I 557.7339 nm (air; 557.8887 nm vacuum, NIST ASD): K_m ybar(lambda) hc/lambda 1e10/(4 pi)."""
    g = cie.WAVELENGTHS
    y = np.interp(557.7339, g, cie.cmfs()[:, 1])
    v = np.interp(557.7339, g, cie.scotopic())
    e = 6.62607015e-34 * 299792458.0 / 557.8887e-9
    rad = 1e10 / (4 * np.pi) * e
    got = ag.line_xyzs_air(557.7339, 1.0)
    assert got[1] == pytest.approx(cie.KM_PHOTOPIC * y * rad, rel=1e-5)
    assert got[3] == pytest.approx(cie.KM_SCOTOPIC * v * rad, rel=1e-5)
    assert got[1] == pytest.approx(1.9325e-7, rel=1e-3)
    # The vacuum-wavelength entry point gives the same.
    assert ag.line_xyzs(np.array([557.8887]), np.array([1.0]))[1] == pytest.approx(got[1], rel=1e-5)


def test_limb_ratio_closed_form():
    s = ag.layer_profile(97.0)["sigmaKm"]
    assert s == pytest.approx(8.6 / 2.3548200450309493, rel=1e-9)
    r = ag.gaussian_column_limb_ratio(6371.0 + 97.0, s)
    assert 50.0 < r < 52.5


def test_srf_series_labels():
    d0 = dt.date(2026, 1, 1)
    daily = [(d0 + dt.timedelta(days=k), 100.0 + k) for k in range(60) if k != 40]
    pred = {"2026-03": 150.0}
    s = ag.srf_series(daily, pred, d0 + dt.timedelta(days=13), d0 + dt.timedelta(days=60))
    labels = {g["label"] for g in s["labelSegments"]}
    assert labels == {"derived", "unknown", "estimated"}
    # The first day: 27 observed days centred on it.
    assert s["values"][0] == pytest.approx(100.0 + 13.0)
    # Day 27..53 contain the missing day 40 and no prediction for February: unknown.
    seg = next(g for g in s["labelSegments"] if g["label"] == "unknown")
    assert seg["from"] == (d0 + dt.timedelta(days=27)).isoformat()


@pytest.mark.parametrize("utc", ["2010-09-01T00:00:00", "2026-10-04T00:00:00"])
def test_utc_day_uses_the_leap_second_table(utc):
    import spiceypy as sp
    from pipeline.ephem_kernels import lsk, pool
    from pipeline.stages import nightglow as st
    with pool(lsk()):
        et = sp.str2et(utc)
        assert st._utc_date(et) == dt.date.fromisoformat(utc[:10])


def test_transcribed_paper_keeps_an_honest_source_when_the_publisher_refuses(monkeypatch):
    from pipeline.photometry.common import Download
    from pipeline.stages import nightglow as st

    def refused(self):
        raise RuntimeError("403 Forbidden")

    monkeypatch.setattr(Download, "fetch", refused)
    source = st.ITIKAWA.source()
    assert source.id == "itikawa-2006-n2"
    assert source.retrieved == "" and source.sha256 is None
    assert "unavailable" in source.notes
    assert "transcription" in source.notes


def test_fang2008_energy_closure():
    """The ionisation rate integrates to the energy flux / 35 eV for electrons that stop above 86 km."""
    z = np.arange(86.0, 600.0, 0.5)
    for e_avg in (0.5, 1.0, 3.0):
        q = na.fang2008_ionization(z, 1.0, 0.5 * e_avg)
        pairs = np.trapezoid(q, z * 1e5)                         # cm^-2 s^-1
        energy_erg = pairs * 0.035 / na.KEV_PER_ERG
        assert energy_erg == pytest.approx(1.0, abs=0.08), e_avg


def test_aurora_peaks_against_whiter2023():
    """Whiter et al. (2023, Ann. Geophys. 41, 1) measured mean peak heights of 557.7 and 427.8 nm aurora of 114.8 and
    116.6 km: they lie inside the model's peak heights for mean energies of 2-5 keV (typical discrete aurora)."""
    z = np.arange(86.0, 400.0, 0.5)
    et = na.emission_table(np.array([2.0, 5.0]), z)
    w = na.tables()["whiter2023"]["meanPeakKm"]
    for line in ("OI5577", "N2p4278"):
        hi, lo = et.peak_km[line]
        assert lo - 2.0 <= w[line] <= hi + 2.0, (line, et.peak_km[line], w[line])


def test_dipole_tracing_is_exact_for_a_dipole():
    """With only the dipole terms the traced apex gives the analytic dipole latitude acos(sqrt(R/r_apex))."""
    g = np.zeros((2, 2))
    h = np.zeros((2, 2))
    g[1, 0], g[1, 1], h[1, 1] = -29350.0, -1410.0, 4545.0
    lats = np.array([55.0, 65.0, 75.0])
    mlat, _ = na.aacgm_grid(g, h, 1, lats, np.array([10.0]))
    D = na.dipole_frame(g, h)
    for k, la in enumerate(lats):
        p = np.array([np.cos(np.radians(la)) * np.cos(np.radians(10.0)), np.cos(np.radians(la)) * np.sin(np.radians(10.0)),
                      np.sin(np.radians(la))]) * (na.R_EARTH_AACGM_KM + 110.0)
        q = D @ p
        ld = np.arcsin(q[2] / np.linalg.norm(q))
        r_apex = np.linalg.norm(q) / np.cos(ld) ** 2
        want = np.degrees(np.arccos(np.sqrt(na.R_EARTH_AACGM_KM / r_apex))) * np.sign(ld)
        assert mlat[k, 0] == pytest.approx(want, abs=0.05)


def test_season_weights_sum_to_one():
    for d in np.arange(1.0, 366.0, 3.5):
        w = na.season_weights(float(d))
        assert sum(w.values()) == pytest.approx(1.0, abs=1e-12)
        assert min(w.values()) >= -1e-12
    assert na.season_weights(171.0)["summer"] == pytest.approx(1.0)
    assert na.season_weights(354.0)["winter"] == pytest.approx(1.0)


def test_newell_coupling_and_op_average():
    # Southward 5 nT at 400 km/s: sin^(8/3)(90 deg) = 1.
    assert float(na.newell_coupling(np.array([0.0]), np.array([-5.0]), np.array([400.0]))[0]) == pytest.approx(400 ** (4 / 3) * 5 ** (2 / 3))
    # Northward field: no coupling.
    assert float(na.newell_coupling(np.array([0.0]), np.array([5.0]), np.array([400.0]))[0]) == pytest.approx(0.0, abs=1e-9)
    x = np.full(10, 3000.0)
    out = na.op_weighted_coupling(x)
    assert np.isnan(out[:4]).all() and out[4:] == pytest.approx(3000.0)
    x[4:7] = np.nan
    out = na.op_weighted_coupling(x)
    assert np.isnan(out[8])                    # only 1 of the 4 preceding hours measured
    assert out[9] == pytest.approx(3000.0)     # 2 of 4


def test_palace_reference_is_the_annual_nocturnal_mean():
    """PALACE's reference intensity is the annual nocturnal mean at 100 sfu: the night-weighted climatology averages 1."""
    from pipeline.stages import nightglow as st
    p = ag.read_palace(st.PALACE.fetch())
    for cid in ("Og", "Na", "Or", "FeO", "OH5a"):
        assert ag.annual_nocturnal_mean(p, cid) == pytest.approx(1.0, abs=0.05), cid


@pytest.mark.skipif(not (OUT / "airglow.json").exists(), reason="nightglow products not built")
def test_products_labels_and_layout():
    a = json.loads((OUT / "airglow.json").read_text())
    assert a["version"] == 2 and isinstance(a["value"], dict)
    a = {**a["value"], **{k: a[k] for k in ("label", "sources")}}
    u = json.loads((OUT / "aurora.json").read_text())
    assert a["label"] == "estimated" and u["label"] == "estimated"
    assert {s["label"] for s in a["solarRadioFlux"]["value"]["labelSegments"]} <= {"derived", "estimated", "unknown"}
    assert u["coupling"]["label"] == "derived" and u["coupling"]["value"]["climatology"]["label"] == "estimated"
    assert u["magneticCoordinates"]["label"] == "estimated"
    assert u["ovation"]["label"] == u["emission"]["label"] == "estimated"
    sources = {s["id"] for s in json.loads((OUT.parent / "sources.json").read_text())}
    for refs in (a["sources"], a["solarRadioFlux"]["sources"],
                 *(u[k]["sources"] for k in ("ovation", "coupling", "magneticCoordinates", "emission"))):
        assert refs and set(refs) <= sources
    assert a["limbCheck"]["source"] in sources
    assert u["nowcastCheck"]["source"] in sources
    assert u["emission"]["value"]["checks"]["source"] in sources
    assert "naif-lsk-naif0012" in a["solarRadioFlux"]["sources"]
    assert {"naif-lsk-naif0012", "ovation-prime-2010"} <= set(u["coupling"]["sources"])
    assert set(u["coupling"]["value"]["climatology"]["sources"]) <= sources
    ov = u["ovation"]["value"]
    # OP2010 tabulates probability in dF_AVE / 8 bins: 4421 / 8 = 552.625, not the finer build nodes.
    assert "bins of 552.625" in u["ovation"]["method"]
    n = 4 * 2 * len(ov["couplingNodes"]) * len(ov["mltHours"]) * len(ov["mlatDeg"])
    size = {"float16": 2, "float32": 4}[ov["dtype"]]
    assert (OUT / "aurora-ovation.bin").stat().st_size == n * size
    mag = u["magneticCoordinates"]["value"]
    assert (OUT / "aurora-magnetic.bin").stat().st_size == mag["latDeg"][2] * mag["lonDeg"][2] * 3 * 4
    e = u["emission"]["value"]
    assert (OUT / "aurora-emission.bin").stat().st_size == len(e["averageEnergyNodesKeV"]) * len(e["altitudesKm"]) * 4 * 4
    for g in e["groups"]:
        bs = np.array(e["lines"][g]["xyzsPerRBySample"]).sum(axis=0)
        assert bs == pytest.approx(np.array(e["lines"][g]["xyzsPerR"]), rel=1e-6)
    assert a["limbCheck"]["srfSfu"] > 60
