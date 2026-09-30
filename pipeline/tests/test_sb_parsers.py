"""Parsers of the small-body inputs: SBDB query pages and sbdb.api model parameters, MPC packed designations and
MPCORB, NEOWISE V2.0 CSV, LCDB summary, Gaia DR3 reflectance spectra. Fixtures: pipeline/tests/fixtures/sb/."""

import gzip
import json
import math
from pathlib import Path

import numpy as np
import pytest

from pipeline import sb_catalog
from pipeline import sb_physical_sources as ps
from pipeline.sb_model import AU_KM, DAY_S

FIX = Path(__file__).parent / "fixtures" / "sb"


def test_unpack_mpc_designations():
    cases = {"00001": "1", "00433": "433", "A0345": "100345", "a0001": "360001", "~0000": "620000", "~000z": "620061",
             "K10A12B": "2010 AB12", "J95X00A": "1995 XA", "K26R34T": "2026 RT34", "PLS2040": "2040 P-L",
             "T1S3138": "3138 T-1", "T3S4101": "4101 T-3"}
    for packed, want in cases.items():
        assert ps.unpack_designation(packed) == want, packed


def test_sbdb_page_parse_and_nongrav():
    cat = sb_catalog.load_orbits([FIX / "orbits.json"])
    assert cat.n == json.loads((FIX / "orbits.json").read_text())["count"]
    assert np.all(np.diff(cat.spkid) > 0)
    ceres = cat.row_of(20000001)
    assert cat.s["pdes"][ceres] == "1" and cat.s["name"][ceres] == "Ceres"
    # full precision: 16 significant digits survive (the API rounds unless full-prec=1)
    raw = next(r for r in json.loads((FIX / "orbits.json").read_text())["data"] if r[0] == 20000001)
    fields = json.loads((FIX / "orbits.json").read_text())["fields"]
    assert cat.f["a"][ceres] == float(raw[fields.index("a")])
    assert len(raw[fields.index("e")].lstrip(".0")) >= 15
    files = {int(p.stem): p for p in (FIX / "nongrav").glob("*.json")}
    sb_catalog.attach_nongrav(cat, files)
    apophis = cat.row_of(20099942)
    assert cat.has_ng[apophis]
    # Apophis: Yarkovsky-type model g = (1 au / r)^2 -> ALN = 1, NM = 2, NK = 0, R0 = 1 au (SBDB model_pars)
    a1, a2, a3, dt, aln, r0, nm, nn, nk = cat.ng[apophis]
    assert aln == 1.0 and nm == 2.0 and nk == 0.0 and r0 == pytest.approx(AU_KM)
    assert a2 == pytest.approx(-2.901766637153165e-14 * AU_KM / DAY_S ** 2, rel=1e-12)
    encke = int(np.nonzero(cat.s["pdes"] == "2P")[0][0])
    assert cat.has_ng[encke] and cat.ng[encke, 4] == pytest.approx(0.1112620426)  # Marsden default ALN
    atlas = int(np.nonzero((cat.s["pdes"] == "2025 N1") & (cat.s["prefix"] == "C"))[0][0])
    assert cat.ng[atlas, 3] == pytest.approx(9.478815 * DAY_S, rel=1e-6)  # DT in s
    bennu = cat.row_of(20101955)
    assert "not modelled" in cat.ng_unsupported[bennu]  # AMRAT / RHO thermal model


def test_time_since_perihelion_uses_mean_anomaly_for_ellipses():
    cat = sb_catalog.load_orbits([FIX / "orbits.json"])
    mu = 1.3271244004127942e11
    dt = sb_catalog.time_since_perihelion(cat, mu)
    e = cat.f["e"]
    ell = (e < 1) & np.isfinite(cat.f["ma"])
    M = np.remainder(np.radians(cat.f["ma"][ell]) + np.pi, 2 * np.pi) - np.pi
    assert np.all(np.abs(M) <= np.pi)
    hyp = e > 1
    assert hyp.any()
    assert np.allclose(dt[hyp], (cat.f["epoch"][hyp] - cat.f["tp"][hyp]) * DAY_S)
    # the elliptic path agrees with epoch - tp modulo the period (both come from one SBDB solution)
    q = cat.f["q"][ell] * AU_KM
    P = 2 * math.pi * np.sqrt((q / (1 - e[ell])) ** 3 / mu)
    diff = np.remainder(dt[ell] - (cat.f["epoch"][ell] - cat.f["tp"][ell]) * DAY_S + P / 2, P) - P / 2
    assert np.max(np.abs(diff)) < 60.0  # seconds (SBDB tp vs ma consistency; GM choice)


def test_lcdb_summary_excerpt():
    rows = ps.parse_lcdb_summary((FIX / "lcdb_summary_excerpt.txt").read_text(encoding="latin-1"))
    by = {(r.number, r.name): r for r in rows}
    ceres = by[(1, "Ceres")]
    assert ceres.period_h == 9.07417 and ceres.u == "3" and ceres.flags == "S"
    assert by[(22, "Kalliope")].period_h == 4.1483
    lim = [r for r in rows if r.flags == ">"]
    assert lim and lim[0].period_h == 120.0
    assert any(r.u == "1" for r in rows) and any(r.u == "2-" for r in rows) and any(r.u == "0" for r in rows)
    assert any(r.number is None and r.desig for r in rows)


def test_neowise_csv(tmp_path):
    text = (
        '     5,"-          ","00005   ", 6.85,+0.15,2455392.0389605,  9, 13, 13, 13,"DVBI",108.293,  3.703,0.274,0.033,0.365,0.030,0.867,0.101,"-","Mas14",""\n'
        '  5311,"1981 GD1   ","05311   ",13.60,+0.15,2455387.2751350,  0,  0, 12, 11,"DVB-",  9.349,  0.332,0.073,0.009,0.110,0.013,1.573,0.074,"-","Mas11",""\n'
        '     0,"2010 AB12  ","K10A12B ",17.10,+0.15,2455300.1000000,  0,  0,  3,  0,"--B-",  1.000,  0.000,0.100,0.000,-.999,-.999,1.000,0.000,"-","Mas11",""\n')
    p = tmp_path / "neowise_test.csv"
    p.write_text(text)
    rows = ps.read_neowise([p])
    assert [r.number for r in rows] == [5, 5311, None]
    assert rows[0].fit_code == "DVBI" and rows[0].D == 108.293 and rows[0].pV == 0.274 and rows[0].nobs == 48
    assert rows[2].prov == "2010 AB12" and ps.unpack_designation(rows[2].packed) == "2010 AB12"
    assert rows[2].fit_code[0] == "-"  # diameter was held fixed: not a measurement


def test_gaia_csv(tmp_path):
    head = ("source_id,solution_id,number_mp,denomination,nb_samples,num_of_spectra,reflectance_spectrum,"
            "reflectance_spectrum_err,wavelength,reflectance_spectrum_flag\n")
    lines = [f"-1,1,9,\"metis\",16,28,{0.5 + 0.03 * k},0.001,{w},{1 if k == 15 else 0}\n"
             for k, w in enumerate(ps.GAIA_WAVELENGTHS_NM)]
    p = tmp_path / "g.csv.gz"
    with gzip.open(p, "wt") as f:
        f.write("# comment\n" + head + "".join(lines))
    g = ps.read_gaia([p])
    assert g.refl.shape == (1, 16) and g.number[0] == 9 and g.name[0] == "metis"
    assert g.refl[0, 4] == pytest.approx(0.62) and g.flag[0, 15] == 1 and g.flag[0, 0] == 0


def _mpc_line(packed, H, G, epoch, M, peri, node, inc, e, n, a, U, name):
    """A record in the MPCORB column layout (https://minorplanetcenter.net/iau/info/MPOrbitFormat.html)."""
    buf = [" "] * 202

    def put(col, s):
        buf[col:col + len(s)] = list(s)

    put(0, packed.ljust(7)); put(8, f"{H:5.2f}"); put(14, f"{G:5.2f}"); put(20, epoch); put(26, f"{M:9.5f}")
    put(37, f"{peri:9.5f}"); put(48, f"{node:9.5f}"); put(59, f"{inc:9.5f}"); put(70, f"{e:9.7f}")
    put(80, f"{n:11.8f}"); put(92, f"{a:11.7f}"); put(105, U); put(166, name)
    return "".join(buf).rstrip() + "\n"


def test_mpcorb_lines(tmp_path):
    ceres = ("00001    3.34  0.15 K2669 274.41935   73.29420   80.24863   10.58803  0.0796923  0.21430445   2.7655526"
             "  0 E2026-SD4  7376 127 1801-2026 0.82 M-v 30k MPCORBFIT  4000      (1) Ceres              20260922\n")
    lines = ["MPCORB header text\n", "-" * 160 + "\n", ceres,
             _mpc_line("K26R34T", 25.4, 0.15, "K2669", 123.45678, 12.34567, 345.6789, 1.23456, 0.394, 0.99, 1.02, "5",
                       "2026 RT34")]
    assert ceres == _mpc_line("00001", 3.34, 0.15, "K2669", 274.41935, 73.2942, 80.24863, 10.58803, 0.0796923,
                              0.21430445, 2.7655526, "0", "")[:106] + ceres[106:]
    p = tmp_path / "MPCORB.DAT.gz"
    with gzip.open(p, "wt", encoding="latin-1") as f:
        f.writelines(lines)
    m = ps.read_mpcorb(p)
    assert list(m.desig) == ["1", "2026 RT34"]
    assert list(m.U) == ["0", "5"]
    assert m.epoch_packed[0] == "K2669"
    assert m.elems[0, 0] == 274.41935 and m.elems[0, 6] == 2.7655526


def test_ssobft_reader_picks_v_band_and_best_spin(tmp_path):
    import pyarrow as pa
    import pyarrow.parquet as pq

    def lst(*v):
        return list(v)

    cols = {
        "number": [1, None], "name": ["Ceres", "2010 AB12"],
        "phase_functions.name_filter": [lst("orange", "V"), lst("r")],
        "phase_functions.H.value": [lst(3.2, 3.5), lst(17.0)],
        "phase_functions.H.error.min": [lst(-0.1, -0.05), lst(-0.3)],
        "phase_functions.H.error.max": [lst(0.1, 0.06), lst(0.2)],
        "phase_functions.G1.value": [lst(0.6, 0.5), lst(0.3)],
        "phase_functions.G1.error.min": [lst(None, -0.02), lst(None)],
        "phase_functions.G1.error.max": [lst(None, 0.03), lst(None)],
        "phase_functions.G2.value": [lst(0.2, 0.25), lst(0.4)],
        "phase_functions.G2.error.min": [lst(None, None), lst(None)],
        "phase_functions.G2.error.max": [lst(None, None), lst(None)],
        "phase_functions.N": [lst(900, 400), lst(50)],
        "phase_functions.phase.min": [lst(1.0, 2.0), lst(3.0)],
        "phase_functions.phase.max": [lst(20.0, 25.0), lst(30.0)],
        "phase_functions.rms": [lst(0.1, 0.2), lst(0.3)],
        "phase_functions.facility": [lst("ATLAS", "MPCATOBS"), lst("ZTF")],
        "spins.RA0.value": [lst(10.0, 291.0), None], "spins.DEC0.value": [lst(20.0, 66.0), None],
        "spins.period.value": [lst(9.07, 9.074), None], "spins.technique": [lst("A-M", "SPACE"), None],
        "taxonomy.class": ["C", None], "taxonomy.scheme": ["Bus-DeMeo", None], "taxonomy.technique": ["Spec", None],
    }
    pq.write_table(pa.table(cols), tmp_path / "bft.parquet")
    b = ps.read_ssobft(tmp_path / "bft.parquet")
    assert b.phase_filter[0] == "V" and b.phase["G1"][0] == 0.5 and b.phase["H_err"][0] == 0.06
    assert b.phase_facility[0] == "MPCATOBS" and b.phase["phase_max"][0] == 25.0 and b.phase["N"][0] == 400
    assert math.isnan(b.phase["G2_err"][0])
    assert b.spin_technique[0] == "SPACE" and b.spin["RA0"][0] == 291.0     # spacecraft pole before the A-M one
    assert b.phase_filter[1] == "r" and math.isnan(b.spin["RA0"][1]) and b.number[1] == 0
    assert b.tax_class[0] == "C" and b.tax_class[1] == ""
