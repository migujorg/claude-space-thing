"""Moon photometry (photometry/moons.py): transcriptions checked against their papers' own constraints, models
against the papers' own numbers, reconstructions against the band values they must reproduce."""

import csv
import io
import math

import numpy as np
import pytest

from pipeline.photometry import albedo, bodies, diskint, filters, horizons, moons, phase
from pipeline.photometry.common import AU_KM, read_table_csv, read_table_json


@pytest.fixture(scope="module")
def res():
    return bodies.build_all(None, list(moons.MOONS))


# ---------------------------------------------------------------------------------------------- Galilean moons
def test_mayorga_polynomials_satisfy_their_constraint():
    """Mayorga et al. (2020) constrained every fit to f(180°) = 0: a mistyped high-order coefficient (c5·180⁵ ~ 2e11·c5)
    would break this, so it checks the transcription of all 17 polynomials."""
    rows = read_table_csv("mayorga_2020_table5.csv")
    assert len(rows) == 17
    for n in (501, 502, 503, 504):
        for f, c in moons.mayorga_polys(n).items():
            assert abs(moons._poly(c, 180.0)) < 0.002, (n, f)
            assert all(moons._poly(c, a) > 0 for a in range(0, 131)), (n, f)


def test_cassini_wac_curves_reproduce_mayorga_effective_wavelengths():
    """Photon-counting band averages with the SVO WAC curves reproduce the paper's Table 2 solar-weighted effective
    wavelengths, which validates both the curves and the photon weighting."""
    for key, nm in (("VIO", 420), ("GRN", 568), ("RED", 647), ("CB2", 752), ("CB3", 939)):
        assert filters.effective_wavelength(moons.WAC[key]) == pytest.approx(nm, abs=1.5), key


def test_galilean_reconstruction_reproduces_band_albedos(res):
    for n in (501, 502, 503, 504):
        s = res[n].spectrum
        for f, c in moons.mayorga_polys(n).items():
            assert filters.band_average(moons.WAC[f], s.wl, s.p) == pytest.approx(c[0], rel=1e-6), (n, f)


def test_galilean_phase_curves(res):
    for n in (501, 502, 503, 504):
        pf = res[n].entry["phaseFunction"]["value"]
        c = moons.mayorga_polys(n)["GRN"]
        assert phase.delta_mag(pf, 0.0) == 0.0
        assert phase.delta_mag(pf, 60.0) == pytest.approx(-2.5 * math.log10(moons._poly(c, 60.0) / c[0]), abs=1e-4)
        assert phase.delta_mag(pf, 131.0) is None


def test_mayorga_table4_transcription():
    """Table 4: six slice albedos for each moon and filter the paper fitted (Io 5, Europa 4, Ganymede 5, Callisto 3),
    all physical (0 < A < 1) and within a factor 2 of their mean (a digit slip would stand out)."""
    counts = {501: 5, 502: 4, 503: 5, 504: 3}
    for n, k in counts.items():
        s = moons.mayorga_slices(n)
        assert len(s) == k and "GRN" in s
        for f, J in s.items():
            J = np.array(J)
            assert J.shape == (6,) and np.all((J > 0) & (J < 1)), (n, f)
            assert np.all(np.abs(J / J.mean() - 1) < 0.5), (n, f)


def test_rotation_slices_sign_convention():
    """East-positive slices: the leading hemisphere (centred on 90 W = -90 E, slices J0-J2) is brighter than the
    trailing one for Io, Europa and Ganymede and darker for Callisto, in the GRN filter."""
    for n, leading_brighter in ((501, True), (502, True), (503, True), (504, False)):
        J = np.array(moons.mayorga_slices(n)["GRN"])
        assert (J[:3].mean() > J[3:].mean()) == leading_brighter, n


def test_slice_factor_matches_planetslicer():
    """F against PlanetSlicer (Thorngren 2019, slicer.py toPhaseCurve(rel)/toPhaseCurve(1)), Europa GRN; the same
    reference values as the renderer's test (app/tests/render-rotation-slices.test.ts)."""
    J = np.array(moons.mayorga_slices(502)["GRN"])
    rel = J / J.mean()
    for lo, ls, want in ((67.2, 39.2, 0.836156), (-90, -90, 1.158935), (90, 90, 0.878412), (0, 30, 0.874536),
                         (170, -160, 1.056665), (-100, 20, 1.039198)):
        got = moons.slice_factor(moons.SLICE_EDGES_DEG, rel, math.radians(lo), math.radians(ls))
        assert got == pytest.approx(want, abs=2e-6), (lo, ls)
    # uniform body, and the rotation average at small phase
    assert moons.slice_factor(moons.SLICE_EDGES_DEG, np.ones(6), 0.3, 0.9) == pytest.approx(1.0, abs=1e-12)
    lons = np.linspace(-math.pi, math.pi, 721)[:-1]
    assert np.mean([moons.slice_factor(moons.SLICE_EDGES_DEG, rel, x, x + 0.2) for x in lons]) == pytest.approx(1, abs=2e-3)


def test_galilean_rotation_model_entry(res):
    for n in (501, 502, 503, 504):
        e = res[n].entry
        m = e["diskReflectanceModel"]
        assert m["label"] == "estimated" and m["sources"] == ["mayorga-2020"]
        v = m["value"]
        assert v["kind"] == "rotation-slices-v1"
        assert v["albedoXYZS"] == e["geometricAlbedoXYZS"]["value"]
        assert v["phase"] == e["phaseFunction"]["value"]
        assert v["sliceEdgesEastLonDeg"] == [-180, -120, -60, 0, 60, 120, 180]
        assert np.mean(v["relativeAlbedo"]) == pytest.approx(1, abs=1e-6)
    assert "diskReflectanceModel" not in res[601].entry


# ---------------------------------------------------------------------------------------------- Saturnian moons
def test_filacchione_a0_matches_abstract():
    """Abstract values at 0.55 µm (surge excluded): the tabulated 549 nm a0 agree within the quoted errors."""
    abstract = {601: (0.63, 0.02), 602: (0.89, 0.03), 603: (0.74, 0.03), 604: (0.65, 0.03), 605: (0.60, 0.05)}
    for n, (v, err) in abstract.items():
        t = moons.filacchione_rows(n)
        a0 = t["a0"][np.argmin(np.abs(t["wl"] - 549))]
        assert abs(a0 - v) <= err, (n, a0)
        assert len(t["wl"]) == 14 and t["wl"][0] == 350 and t["wl"][-1] == 1010


@pytest.mark.parametrize("alpha", [0.0, 10.0, 30.0, 60.0, 90.0, 120.0, 150.0])
def test_akimov_closed_form_matches_quadrature(alpha):
    num = diskint.integrate(lambda mu0, mu, a, b, g: diskint.akimov_disk(b, g, a), alpha)
    assert diskint.akimov_integral(alpha) == pytest.approx(num, rel=1e-6)


def test_lambert_sphere_quadrature():
    """The disk integrator reproduces the Lambert sphere: p = 2/3 and Φ(α) = (sin α + (π-α) cos α)/π."""
    lam = lambda mu0, mu, a, b, g: mu0  # noqa: E731  (I/F of a Lambert surface with albedo 1)
    p = diskint.integrate(lam, 0.0)
    assert p == pytest.approx(2.0 / 3.0, rel=1e-6)
    for a in (30.0, 90.0, 150.0):
        x = math.radians(a)
        assert diskint.integrate(lam, a) / p == pytest.approx((math.sin(x) + (math.pi - x) * math.cos(x)) / math.pi,
                                                            rel=1e-5)


def test_saturnian_phase_is_disk_integral(res):
    for n in (601, 602, 603, 604, 605):
        t = moons.filacchione_rows(n)
        i = int(np.argmin(np.abs(t["wl"] - 549)))
        a0, a1, a2 = t["a0"][i], t["a1"][i], t["a2"][i]
        pf = res[n].entry["phaseFunction"]["value"]
        for a in (10.0, 45.0, 90.0, 120.0):
            want = -2.5 * math.log10((a0 + a1 * a + a2 * a * a) / a0 * diskint.akimov_integral(a))
            assert phase.delta_mag(pf, a) == pytest.approx(want, abs=1e-4)
        assert res[n].entry["phaseFunction"]["label"] == "estimated"   # 0-10°: surge shape transferred


def test_deau_opposition_fits_are_self_consistent():
    """Deau et al. (2009) Table 3 linear-exponential parameters reproduce their Table 2 A, HWHM, S (Eq. 6), and the
    fit agrees with their logarithmic fit (Table 3) within 6 % over 0.5-6° (a check of the slope's sign; the two forms part below ~0.3°, where the log diverges)."""
    tab = read_table_json("saturnian_opposition.json")["deau_2009"]
    for key, q in tab["linear_exponential"].items():
        assert (q["Ip"] + q["Ib"]) / q["Ib"] == pytest.approx(q["table2_A"], abs=0.01)
        assert 2 * math.log(2) * q["w_deg"] == pytest.approx(q["table2_HWHM_deg"], abs=0.01)
        assert q["slope_abs"] == q["table2_S"]
        lg = tab["log_fit"][key]
        for a in (0.5, 1.0, 3.0, 6.0):
            assert moons.opposition_shape(key, a) == pytest.approx(lg["a0"] + lg["a1"] * math.log(a), rel=0.06)


def test_saturnian_opposition_surge(res):
    """0-10°: the measured surge shape joined continuously to the VIMS curve at 10°; brighter than the surge-free
    albedo at zero phase, monotonic, and still below the HST true-opposition albedos (the level difference is
    reported, not hidden)."""
    hst = read_table_json("saturnian_opposition.json")["verbiscer_2007"]["geometric_albedo"]
    for n in (601, 602, 603, 604, 605):
        pf = res[n].entry["phaseFunction"]["value"]
        a = np.array(pf["alphaDeg"])
        dm = np.array(pf["deltaMag"])
        assert np.all(np.diff(dm) > 0), n
        left, right = phase.delta_mag(pf, 9.99), phase.delta_mag(pf, 10.01)
        assert abs(right - left) < 0.005, n
        phi0 = 10 ** (-0.4 * phase.delta_mag(pf, 0.0))
        assert 1.1 < phi0 < 1.3, n
        assert 1.2 < hst[str(n)] / (res[n].p_v * phi0) < 1.4, n
        assert a[0] == 0.0 and 0.05 in pf["alphaDeg"]
        assert "deau-2009" in res[n].entry["phaseFunction"]["sources"]


# ---------------------------------------------------------------------------------------------- Titan
def test_titan_matches_karkoschka_v_magnitude(res):
    """Karkoschka (1998) Table II: Titan V = -1.25 at 1 AU and 5.7° phase (solar V = -26.74 assumed there). Our
    spectrum divided by the 1.02 zero-phase factor must give the same V."""
    s = res[606].spectrum
    k = read_table_json("karkoschka_disk_radii.json")
    p57 = filters.band_average("V", s.wl, s.p) / s.notes["zero_phase_factor"]
    v = k["solar_V_assumed"] - 2.5 * math.log10(p57 * (k["radius_km"]["606"] / AU_KM) ** 2)
    assert v == pytest.approx(k["titan_V_1995"], abs=0.03)


# ---------------------------------------------------------------------------------------------- Uranian moons
def _phot_mags(name):
    text = moons.decolibus_file(f"photometry/{name}_phot_mags.csv")
    return list(csv.DictReader(io.StringIO(text)))


@pytest.mark.parametrize("name", ["Titania", "Oberon"])
def test_k2001_phase_function_reproduces_decolibus_corrections(name):
    k = read_table_json("karkoschka_2001_uranian_phase.json")
    pf = moons.uranian_phase(703 if name == "Titania" else 704)
    for row in _phot_mags(name):
        a = float(row["phase"])
        for band in "BVR":
            corr = float(row[f"oppmag_{band}"]) - float(row[f"corrmag_{band}"])
            model = k["beta_mag_per_deg"] * a + 0.5 * a / (k["alpha0_deg"] + a)
            assert model == pytest.approx(corr, abs=0.0015), (name, a, band)
            assert phase.delta_mag(pf.function, a) == pytest.approx(corr, abs=0.003)


def test_uranian_spectra_scaled_at_063um(res):
    scale = moons.decolibus_scaling()
    assert scale == {"Ariel": 0.546, "Umbriel": 0.262, "Titania": 0.361, "Oberon": 0.32}
    for n, name in moons.URANIAN.items():
        s = res[n].spectrum
        m = (s.wl >= 628.0) & (s.wl <= 632.2)
        assert np.mean(s.p[m]) == pytest.approx(scale[name], rel=1e-9)


@pytest.mark.parametrize("n,name", [(703, "Titania"), (704, "Oberon")])
def test_uranian_albedos_vs_tmo_photometry(res, n, name):
    """Independent check: the dataset's own TMO B, V, R geometric albedos (all longitudes, K2001 phase function)
    agree with the band averages of the K2001-scaled spectra to within 7 %."""
    text = moons.decolibus_file(f"photometry/{name}_All_TMO_GeoAlbAvg.txt")
    rows = [ln.split() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith(("#", "wl"))]
    tmo = {band: float(r[1]) for band, r in zip("BVR", rows)}
    s = res[n].spectrum
    for band in "BV":
        assert filters.band_average(band, s.wl, s.p) == pytest.approx(tmo[band], rel=0.07), band


# ---------------------------------------------------------------------------------------------- Triton, Charon
def test_bv_reconstructions(res):
    for n in (801, 901):
        s = res[n].spectrum
        p_b = s.notes["p_B"]
        assert filters.band_average("B", s.wl, s.p) == pytest.approx(p_b, rel=1e-9)
        assert res[n].p_v == pytest.approx(s.notes["p_V"], rel=1e-9)
    assert res[801].p_v == pytest.approx(0.86 * (1353.4 / albedo.mean_radius(801)) ** 2, rel=1e-3)


@pytest.mark.parametrize("body,band,want", [("901", "V", 0.2549), ("999", "V", 0.0398), ("999", "B", 0.0434)])
def test_hapke_disk_integral_reproduces_buie_zero_phase_steps(body, band, want):
    """Buie et al. (2010) derived their 1°→0° corrections from the Table 9 Hapke fits; our disk integration of the
    same parameters (no roughness term) must reproduce them."""
    hp = read_table_json("buie_2010a_pluto.json")["hapke_table9"][body][band]
    got = diskint.hapke1986_delta_mag(hp["w"], hp["P"], hp["B0"], hp["h"], 1.0)
    assert got == pytest.approx(want, abs=0.003)


def test_charon_phase_consistent_with_its_albedo(res):
    pf = res[901].entry["phaseFunction"]["value"]
    assert phase.delta_mag(pf, 1.0) == pytest.approx(0.2549, abs=0.003)
    assert phase.delta_mag(pf, 1.8) is None


# ---------------------------------------------------------------------------------------------- Phobos, Deimos
def test_phobos(res):
    s = res[401].spectrum
    t = read_table_json("fornasier_2024_phobos.json")
    for k, v in t["hapke_geometric_albedo"].items():
        assert filters.band_average(moons.HRSC[k], s.wl, s.p) == pytest.approx(v, rel=1e-6)
    # H in the green channel with the pck radius gives an albedo within 5 % of the Hapke value
    p_h = 10 ** (-0.4 * (t["hg"]["Green"]["H"] - albedo.sun_mag("V"))) / (albedo.mean_radius(401) / AU_KM) ** 2
    assert p_h == pytest.approx(t["hapke_geometric_albedo"]["Green"], rel=0.05)
    pf = res[401].entry["phaseFunction"]["value"]
    assert phase.delta_mag(pf, 0.0) == 0.0
    assert phase.delta_mag(pf, 20.0) == pytest.approx(moons.hg_delta_mag(20.0, 0.029), abs=1e-4)


def test_hg_function_reference_values():
    """IAU H-G: G = 0 at 90° gives -2.5 log10(exp(-3.33)) = 3.615 mag; any G gives 0 at opposition."""
    assert moons.hg_delta_mag(90.0, 0.0) == pytest.approx(2.5 * 3.33 / math.log(10), rel=1e-9)
    assert moons.hg_delta_mag(0.0, 0.15) == 0.0


def test_deimos_is_grey_and_phase_unknown(res):
    e = res[402].entry
    assert e["geometricAlbedoXYZS"]["label"] == "estimated" and "ASSUMED grey" in e["geometricAlbedoXYZS"]["method"]
    assert e["phaseFunction"]["label"] == "unknown" and e["phaseFunction"]["method"]


# ---------------------------------------------------------------------------------------------- unknowns
def test_iapetus_and_miranda_are_unknown_with_reasons(res):
    for n in (608, 705):
        for key in ("geometricAlbedoXYZS", "geometricAlbedoV", "phaseFunction"):
            s = res[n].entry[key]
            assert s["label"] == "unknown" and s["value"] is None and len(s["method"]) > 50
    assert "orbital longitude" in res[608].entry["geometricAlbedoXYZS"]["method"]


# ---------------------------------------------------------------------------------------------- Horizons
# Our V(1,0) minus the V(1,0) printed in Horizons' satellite header (JPL's compiled values, 1-2 decimals). Bounds are
# the measured differences plus a margin; the reasons are in docs/reports/planet-colors.md.
V10_EXPECTED = {
    401: (-0.25, -0.15),   # Horizons +11.8; Hapke albedos (surge-inclusive) and the pck radius
    402: (-0.05, 0.05),
    501: (0.0, 0.10), 502: (-0.02, 0.06), 503: (-0.01, 0.07), 504: (0.05, 0.15),
    601: (-0.25, -0.15),   # Filacchione a0 excludes the surge, yet is brighter than JPL's p = 0.6
    602: (0.08, 0.18), 603: (0.17, 0.26), 604: (0.0, 0.08), 605: (0.10, 0.20),   # surge excluded
    606: (-0.03, 0.03),
    701: (-0.50, -0.40), 702: (-0.40, -0.30), 703: (-0.28, -0.20), 704: (-0.29, -0.21),  # K2001 surge-inclusive
    801: (-0.17, -0.10),
}


def test_v10_vs_horizons_header(res):
    texts = horizons.load_fixtures(list(moons.MOONS))
    for n, (lo, hi) in V10_EXPECTED.items():
        h = float(horizons.header_values(texts[n])["V(1,0)"].split()[0])
        d = res[n].v10 - h
        assert lo <= d <= hi, (n, round(d, 3))


def test_horizons_moon_apmag_is_v10_plus_distance(res):
    """Horizons' APmag for these moons is its header V(1,0) + 5 log10(r Δ) with no phase term (so our predictions,
    which include phase curves, differ from it by Δm(α) as well as by V(1,0)); Io and Ganymede are exceptions
    whose implied phase coefficients (~0.45 and ~0.32 mag/deg) are an order of magnitude above Mayorga et al.'s
    curves (see the report)."""
    texts = horizons.load_fixtures(list(moons.MOONS))
    for n in (401, 402, 601, 602, 603, 604, 605, 606, 608, 701, 702, 703, 704, 705, 801):
        h = float(horizons.header_values(texts[n])["V(1,0)"].split()[0])
        for row in horizons.parse(texts[n]):
            assert row.apmag - 5 * math.log10(row.r_au * row.delta_au) == pytest.approx(h, abs=0.002), n
    for n, beta in ((501, 0.45), (503, 0.32)):
        h = float(horizons.header_values(texts[n])["V(1,0)"].split()[0])
        for row in horizons.parse(texts[n]):
            implied = (row.apmag - 5 * math.log10(row.r_au * row.delta_au) - h) / row.phase_deg
            assert implied == pytest.approx(beta, abs=0.02), n


# ---------------------------------------------------------------------------------------------- irregular satellites
def test_irregulars_reproduce_their_absolute_magnitudes(res):
    """Grey reconstructions from H (Grav et al. 2015 Table 1): our V(1,0) equals H exactly and the phase function is
    the H-G curve with the tabulated G. The NEOWISE albedos at the NEOWISE diameters give nearly the same brightness
    (they rest on the same H values)."""
    t = read_table_json("grav_2015_irregulars.json")["satellites"]
    for n in moons.IRREGULAR:
        s = t[str(n)]
        assert res[n].v10 == pytest.approx(s["H"], abs=1e-9)
        assert res[n].entry["geometricAlbedoXYZS"]["label"] == "estimated"
        pf = res[n].entry["phaseFunction"]["value"]
        assert phase.delta_mag(pf, 5.0) == pytest.approx(moons.hg_delta_mag(5.0, s["G"]), abs=1e-4)
        v10_neowise = albedo.sun_mag("V") - 2.5 * math.log10(s["pV_pct"] / 100 * (s["D_km"] / 2 / AU_KM) ** 2)
        assert v10_neowise == pytest.approx(s["H"], abs=0.3), n
