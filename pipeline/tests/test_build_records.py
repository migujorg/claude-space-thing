"""Build records (verification/<stage>.json): what a stage computed for the products it wrote in the same run.

They are the reference for "another implementation reads this product as the pipeline wrote it" (the app's tests),
so that such a check never compares a build with a file made from another build. Here: the functions that make
them, on small inputs; the bodies stage run whole on the kernels already downloaded; and the records of the built
data when there are any.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pytest

from pipeline import ephem_orient, output, sb_catalog, sb_verify
from pipeline.paths import OUT, RAW
from pipeline.schema import BuildContext
from pipeline.stages import bodies
from pipeline.stages import smallbodies as sbs

FIX = Path(__file__).parent / "fixtures" / "sb"
DAY = 86400.0
CAD_FIELDS = ["des", "orbit_id", "jd", "cd", "dist", "dist_min", "dist_max", "v_rel", "v_inf", "t_sigma_f", "body", "h"]
START, END = 800000000.0, 880000000.0   # a window of the test (TDB s past J2000)


@pytest.fixture(scope="module")
def cat():
    c = sb_catalog.load_orbits([FIX / "orbits.json"])
    sb_catalog.attach_nongrav(c, {int(p.stem): p for p in (FIX / "nongrav").glob("*.json")})
    return c


def _flags(cat) -> np.ndarray:
    f = np.zeros(cat.n, dtype=np.uint16)
    f[cat.has_ng] |= np.uint16(1 << sbs.FLAGS["nonGravitational"])
    for i in cat.ng_unsupported:
        f[i] |= np.uint16((1 << sbs.FLAGS["unsupportedModelTerms"]) | (1 << sbs.FLAGS["horizonsState"]))
    return f


def _row(cat, pdes: str, et: float, dist: float, body: str = "Earth", orbit: str | None = None) -> list[str]:
    """A CNEOS cad.api row for a catalogue object, on the orbit solution the catalogue holds unless `orbit` is given."""
    i = sb_verify.find_row(cat, pdes) if pdes in cat.s["pdes"] else None
    oid = orbit if orbit is not None else re.sub(r"^JPL[ #]*", "", str(cat.s["orbit_id"][i]))
    return [pdes, oid, repr(sbs.J2000_JD + et / DAY), "cal", repr(dist), "0", "0", "10.5", "10.4", "< 00:01", body, "20"]


def test_close_approach_cases_keep_only_what_our_propagation_must_reproduce(cat):
    flags = _flags(cat)
    plain = [p for p in ("1", "2", "4", "153", "624", "433", "1566", "3200") if not cat.has_ng[sb_verify.find_row(cat, p)]]
    assert len(plain) >= 6
    t = lambda k: START + (k + 1) * 10 * DAY   # noqa: E731
    # Earth, 0.01 .. 0.06 au, the farthest first in time; two Moon rows; a late, distant Earth row.
    rows = [_row(cat, p, t(10 - k), 0.01 * (k + 1)) for k, p in enumerate(plain[:6])]
    rows += [_row(cat, plain[0], t(20), 0.002, "Moon"), _row(cat, plain[1], t(21), 0.001, "Moon")]
    rows += [_row(cat, plain[3], t(30), 0.5)]
    rows += [
        _row(cat, plain[2], START - 60.0, 1e-5),                 # the query is by calendar date: before the window
        _row(cat, plain[2], END + 60.0, 1e-5),                   # and after it
        _row(cat, "2099 ZZ99", t(3), 1e-5, orbit="1"),           # not in the catalogue
        _row(cat, plain[3], t(4), 1e-5, orbit="999999"),         # CNEOS used another orbit solution
        _row(cat, "99942", t(5), 1e-5),                          # fitted non-gravitational terms
        _row(cat, "101955", t(6), 1e-5),                         # model terms the propagator does not have
        _row(cat, plain[4], t(7), 1e-6, "Venus"),                # another planet: not a case for the Earth-Moon finder
    ]
    assert cat.has_ng[sb_verify.find_row(cat, "99942")] and sb_verify.find_row(cat, "101955") in cat.ng_unsupported
    rec = {"url": "https://example.invalid/cad", "sha256": "0" * 64, "retrieved": "2026-10-03"}
    out = sbs.close_approach_cases({"fields": CAD_FIELDS, "data": rows}, rec, cat, flags, START, END)

    assert out["label"] == "derived" and out["sources"] == ["jpl-cneos-cad"]
    out, counts = out["value"], out["counts"]
    assert counts == {"earthMoonRows": 15, "outsideWindow": 2, "notInCatalogue": 1, "otherOrbitSolution": 1,
                             "otherForceModel": 2, "comparable": 9}
    I = {k: n for n, k in enumerate(out["fields"])}
    kept = {(r[I["des"]], r[I["body"]], float(r[I["dist"]])) for r in out["rows"]}
    # the three closest to the Earth, the closest to the Moon, the first and the last in time
    assert kept == {(plain[0], "Earth", 0.01), (plain[1], "Earth", 0.02), (plain[2], "Earth", 0.03),
                    (plain[1], "Moon", 0.001), (plain[5], "Earth", 0.06), (plain[3], "Earth", 0.5)}
    assert [r[I["et"]] for r in out["rows"]] == sorted(r[I["et"]] for r in out["rows"])
    for r in out["rows"]:
        assert START <= r[I["et"]] <= END and r[I["et"]] == (float(r[I["jd"]]) - sbs.J2000_JD) * DAY
        assert str(cat.s["pdes"][r[I["coreRow"]]]) == r[I["des"]]
        assert sb_verify.same_solution(cat.s["orbit_id"][r[I["coreRow"]]], r[I["orbit_id"]])
    json.dumps(out, allow_nan=False)


def test_close_approach_cases_with_nothing_comparable(cat):
    out = sbs.close_approach_cases({"fields": CAD_FIELDS, "data": [_row(cat, "1", START - 1.0, 0.01)]},
                                   {"url": "u", "sha256": "s", "retrieved": "r"}, cat, _flags(cat), START, END)
    assert out["value"]["rows"] == [] and out["counts"]["comparable"] == 0 and out["counts"]["outsideWindow"] == 1
    assert (out["url"], out["sha256"]) == ("u", "s")


def _result(cat, pdes: str, category: str, epochs: np.ndarray, bad: bool = False) -> sb_verify.Result:
    row = sb_verify.find_row(cat, pdes)
    rng = np.random.default_rng(row)
    hz = rng.normal(size=(epochs.size, 6)) * 1e8
    ours = hz + 1.0
    if bad:
        ours[10:] = np.nan   # a propagation that stopped: sb_verify.propagate_along leaves the rest NaN
    return sb_verify.Result(pdes, category, row, pdes, str(cat.s["orbit_id"][row]), "soln", True, f"https://h/{pdes}",
                            epochs, hz, ours, np.zeros(epochs.size, dtype=np.int8), float(cat.f["q"][row]),
                            float(cat.f["e"][row]), 0, np.arange(6.0), np.arange(6.0) + 10 * row)


def test_verification_objects_shape_rows_and_sampling(cat):
    class Model:
        mu_sun = 1.3271244004127942e11
    epochs = START + 2 * DAY * np.arange(31)
    res = [_result(cat, "1", "main belt", epochs), _result(cat, "99942", "NEO (Aten), Yarkovsky A2", epochs),
           _result(cat, "101955", "NEO (Apollo), Yarkovsky A2", epochs), _result(cat, "2P", "comet", epochs),
           _result(cat, "3200", "NEO (Apollo), q = 0.14 au", epochs), _result(cat, "2026 RT34", "NEO, Earth flyby", epochs)]
    objs = sbs.verification_objects(cat, Model, res, _flags(cat))
    assert [o["designation"] for o in objs] == ["1", "99942", "101955", "2P", "3200", "2026 RT34"]
    for o, r in zip(objs, res):
        assert o["coreRow"] == r.row and o["spkid"] == int(cat.spkid[r.row])
        assert o["epochs"] == [float(x) for x in epochs[::10]]            # one in ten of the 2-day grid: 20 days
        assert o["python"] == [list(map(float, r.ours[j])) for j in (0, 10, 20, 30)]
        assert o["horizons"] == [list(map(float, r.horizons[j, :3])) for j in (0, 10, 20, 30)]
        assert o["stateCommon"] == list(map(float, r.state_common))
        assert o["elements"]["epochEt"] == float(sb_catalog.epoch_et(cat.subset(np.array([r.row])))[0])
    by = {o["designation"]: o for o in objs}
    assert by["1"]["nonGrav"] is None and by["99942"]["nonGrav"]["nm"] == 2.0
    assert by["101955"]["stateCommonFrom"] == "horizons" and by["1"]["stateCommonFrom"] == "integrated"
    assert [by[k]["toleranceKm"] for k in ("1", "2P", "3200", "2026 RT34")] == [
        sbs.TOL_DEFAULT_KM, sbs.TOL_COMET_NG_KM, sbs.TOL_LOW_Q_KM, sbs.TOL_ENCOUNTER_KM]
    assert by["1"]["maxErrKm"] == pytest.approx(np.sqrt(3.0))
    json.dumps(objs, allow_nan=False)

    # In the build record the states are Sourced values with the label and source of the row's position.
    rec = sbs._record_object(by["99942"], "derived", "jpl-sbdb-orbits")
    assert rec["name"] == "99942" and rec["coreRow"] == by["99942"]["coreRow"] and "label" not in rec
    assert rec["stateCommon"] == {"value": by["99942"]["stateCommon"], "label": "derived", "sources": ["jpl-sbdb-orbits"],
                                  "unit": "km, km/s", "method": rec["stateCommon"]["method"]}
    assert rec["python"]["value"] == by["99942"]["python"] and rec["python"]["label"] == "derived"
    assert rec["python"]["sources"][:2] == ["jpl-sbdb-orbits", "jpl-sbdb-nongrav"]       # fitted A2: its source too
    assert rec["horizons"]["value"] == by["99942"]["horizons"] and rec["horizons"]["sources"] == ["jpl-horizons-sb-states"]
    est = sbs._record_object(by["1"], "estimated", "jpl-sbdb-orbits")
    assert est["python"]["label"] == "estimated" and "jpl-sbdb-nongrav" not in est["python"]["sources"]

    # States a failed propagation left undefined are null in the record, never a number.
    bad = sbs.verification_objects(cat, Model, [_result(cat, "1", "main belt", epochs, bad=True)], _flags(cat))[0]
    assert bad["python"][0] == objs[0]["python"][0] and bad["python"][1:] == [[None] * 6] * 3
    json.dumps(bad, allow_nan=False)


# ---------------------------------------------------------------------------------------------- the bodies stage
def _latest_downloaded(pattern: str, key) -> str:
    names = sorted({p.name for p in (RAW / "naif" / "pck").glob("*.bpc") if re.fullmatch(pattern, p.name)}, key=key)
    if not names:
        pytest.skip(f"no Earth orientation kernel matching {pattern} downloaded (run the bodies stage)")
    return names[-1]


@pytest.mark.skipif(not (OUT / "ephem" / "centers.json").exists(), reason="ephemeris products not built")
def test_bodies_stage_writes_spice_on_the_kernels_it_copied(tmp_path, monkeypatch):
    """The stage, whole, into an empty output directory. NAIF's directory listing (its one network call) is answered
    from the kernels already downloaded, so the run needs no network and uses the files a build here used."""
    (tmp_path / "ephem").symlink_to(OUT / "ephem")
    for mod in (bodies, output):
        monkeypatch.setattr(mod, "OUT", tmp_path)
    monkeypatch.setattr(ephem_orient, "_latest", _latest_downloaded)
    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    ctx = BuildContext(manifest["window"]["startEt"], manifest["window"]["endEt"])
    bodies.run(ctx)

    rec = json.loads((tmp_path / bodies.VERIFICATION).read_text(encoding="utf-8"))
    assert ctx.products[bodies.VERIFICATION]["stage"] == "bodies"
    assert rec["products"] == {k: ctx.products[k]["sha256"] for k in ("orient/earth.json", "orient/earth.bin",
                                                                       "orient/moon.json", "orient/moon.bin")}
    assert [k["source"] for k in rec["kernels"]] == [ephem_orient.SRC_EARTH_PRED, ephem_orient.SRC_EARTH_HP,
                                                     ephem_orient.SRC_MOON_PA, ephem_orient.SRC_MOON_FK]
    for k in rec["kernels"]:
        assert k["sha256"] == ctx.sources[k["source"]].sha256 and k["file"] == ctx.sources[k["source"]].version
    assert {(b["id"], b["frame"]) for b in rec["bodies"]} == {(399, "ITRF93"), (301, "MOON_ME_DE440_ME421")}
    for b in rec["bodies"]:
        header = json.loads((tmp_path / f"{b['product']}.json").read_text(encoding="utf-8"))
        data = np.fromfile(tmp_path / header["bin"], dtype="<f8")
        segs = [n for n, s in enumerate(header["segments"]) if s["body"] == b["id"]]
        assert sorted(c["segment"] for c in b["cases"]) == sorted(segs * bodies.RECORD_SAMPLES)
        worst = 0.0
        for c in b["cases"]:
            s, m = header["segments"][c["segment"]], c["bodyToJ2000"]
            assert s["startEt"] < c["et"] < s["endEt"] and m["label"] == s["label"] and m["sources"] == s["sources"]
            ours = ephem_orient.body_to_j2000(header, data, b["id"], c["et"])
            worst = max(worst, float(np.abs(ours.reshape(-1) - np.array(m["value"])).max()))
        print(f"{b['frame']}: max |product - record| = {worst:.2e} over {len(b['cases'])} epochs")
        assert worst < 1e-12   # the product holds the kernel's own records: rounding only


# ---------------------------------------------------------------------------------------------- built records
def _built(rel: str) -> dict:
    p = OUT / rel
    if not p.exists():
        pytest.skip(f"{rel} not built (the build predates the stage's build record: rebuild the stage)")
    return json.loads(p.read_text(encoding="utf-8"))


def test_built_records_name_the_products_of_the_same_build():
    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))["products"] \
        if (OUT / "manifest.json").exists() else {}
    for rel in (sbs.VERIFICATION, bodies.VERIFICATION):
        rec = _built(rel)
        assert manifest[rel]["stage"] == rec["stage"]
        for product, sha in rec["products"].items():
            assert manifest[product]["sha256"] == sha, f"{rel} was written for another {product}"


def test_built_smallbody_record_holds_the_states_of_core_bin():
    from pipeline.sb_table import read_table
    rec = _built(sbs.VERIFICATION)
    core, table = read_table(OUT / "smallbodies" / "core.json")
    assert rec["epochEt"] == core["epochEt"] and rec["window"] == core["window"] and rec["snapshot"] == core["snapshot"]
    names = (OUT / "smallbodies" / "names.txt").read_text(encoding="utf-8").split("\n")
    assert len(rec["objects"]) == len(sb_verify.OBJECTS)
    for o in rec["objects"]:
        i = o["coreRow"]
        assert names[i].split("\t")[0] == str(o["spkid"])
        assert o["stateCommon"]["value"] == [*map(float, table["pos"][i]), *map(float, table["vel"][i])]
        assert o["stateCommon"]["label"] == core["labelEncoding"][int(table["posLabel"][i])]
        assert o["maxErrKm"] <= o["toleranceKm"] and o["orbitId"]
        assert len(o["epochs"]) == len(o["python"]["value"]) == len(o["horizons"]["value"])
        assert all(core["window"]["startEt"] <= t <= core["window"]["endEt"] for t in o["epochs"])
    ca = rec["closeApproaches"]["value"]
    I = {k: n for n, k in enumerate(ca["fields"])}
    for r in ca["rows"]:
        assert core["window"]["startEt"] <= r[I["et"]] <= core["window"]["endEt"]
        assert names[r[I["coreRow"]]].split("\t")[1] == r[I["des"]]
