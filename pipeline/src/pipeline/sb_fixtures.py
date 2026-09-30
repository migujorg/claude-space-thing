"""Regenerate the small-body verification fixtures: `uv run python -m pipeline.sb_fixtures` (after a build).

Writes
  app/tests/fixtures/smallbody_reference.json   force model, per verification object: SBDB elements, our states at
                                                its epoch and at the common epoch, JPL Horizons positions and our
                                                (Python) positions every FIXTURE_STEP_DAYS across the window.
  pipeline/tests/fixtures/sb/orbits.json        the verification objects' raw SBDB query rows (API page format)
  pipeline/tests/fixtures/sb/nongrav/*.json     their sbdb.api answers (non-gravitational model parameters)
  pipeline/tests/fixtures/sb/horizons.json      Horizons heliocentric states every FIXTURE_STEP_DAYS (+ query URLs)

Horizons answers come from the cached, sha256-recorded downloads of sb_verify (data/raw/horizons/smallbodies/).
"""

from __future__ import annotations

import datetime as _dt
import json
import shutil

import numpy as np

from . import sb_catalog, sb_model, sb_sbdb, sb_verify
from .paths import CACHE, OUT, REPO
from .stages.smallbodies import _tolerance, common_epoch
from .schema import BuildContext
from .sb_table import read_table

APP_FIX = REPO / "app" / "tests" / "fixtures" / "smallbody_reference.json"
PIPE_FIX = REPO / "pipeline" / "tests" / "fixtures" / "sb"
FIXTURE_STEP_DAYS = 20


def main() -> None:
    w = json.loads((CACHE / "window.json").read_text())
    ctx = BuildContext(w["startEt"], w["endEt"])
    common = common_epoch(ctx)
    snap = sb_sbdb.fetch_snapshot()
    cat = sb_catalog.load_orbits(snap.orbit_pages)
    sb_catalog.attach_nongrav(cat, snap.nongrav)
    rows = np.array(sorted(sb_verify.find_row(cat, p) for _, p, _ in sb_verify.OBJECTS))
    sub = cat.subset(rows)
    ep = sb_catalog.epoch_et(sub)
    model = sb_model.build(None, float(ep.min()) - 10 * 86400.0, ctx.end_et + 10 * 86400.0, common)
    core, table = read_table(OUT / "smallbodies" / "core.json")
    if core["epochEt"] != common or table.size != cat.n:
        raise ValueError("the built product does not match this snapshot/window: rebuild the smallbodies stage first")
    states_full = np.concatenate([table["pos"], table["vel"]], axis=1).astype(np.float64)
    horizons_bit = 1 << core["flagBits"]["horizonsState"]
    res = sb_verify.run(cat, model, common, ctx.start_et, ctx.end_et, states_common=states_full)
    stride = int(round(FIXTURE_STEP_DAYS / 2))

    objs = []
    for r in res:
        i = r.row
        k = np.arange(0, r.epochs.size, stride)
        ng = None
        if cat.has_ng[i]:
            a = cat.ng[i]
            ng = dict(zip(("a1", "a2", "a3", "dt", "aln", "r0", "nm", "nn", "nk"), (float(x) for x in a)))
        dt_peri = float(sb_catalog.time_since_perihelion(cat.subset(np.array([i])), model.mu_sun)[0])
        objs.append({
            "label": r.label, "category": r.category, "designation": r.pdes, "spkid": int(cat.spkid[i]),
            "coreRow": i, "orbitId": r.orbit_id, "horizonsSolution": r.horizons_soln, "horizonsQueryUrl": r.horizons_url,
            "elements": {"qKm": float(cat.f["q"][i] * sb_model.AU_KM), "e": float(cat.f["e"][i]),
                         "iRad": float(np.radians(cat.f["i"][i])), "nodeRad": float(np.radians(cat.f["om"][i])),
                         "periRad": float(np.radians(cat.f["w"][i])), "dtPeriS": dt_peri,
                         "epochEt": float(sb_catalog.epoch_et(cat.subset(np.array([i])))[0])},
            "nonGrav": ng,
            "stateAtEpoch": [float(x) for x in r.state_epoch],
            "stateCommon": [float(x) for x in r.state_common],
            "stateCommonFrom": "horizons" if int(table["flags"][i]) & horizons_bit else "integrated",
            "epochs": [float(x) for x in r.epochs[k]],
            "horizons": [[float(v) for v in r.horizons[j, :3]] for j in k],
            "python": [[float(v) for v in r.ours[j, :6]] for j in k],
            "maxErrKm": r.max_err_km, "toleranceKm": _tolerance(cat, r), "maxLevel": r.max_substep_level,
        })
    app = {
        "generatedBy": "uv run python -m pipeline.sb_fixtures", "generated": _dt.date.today().isoformat(),
        "sbdbSnapshot": snap.tag, "epochEt": common, "forceModel": model.to_json(), "objects": objs,
        "description": "stateCommon -> SmallBodyPropagator.propagateOne(grid0 = epochEt) must reproduce `python` (same "
                       "scheme) and stay within toleranceKm of `horizons` (JPL Horizons heliocentric ICRF, TDB).",
    }
    APP_FIX.write_text(json.dumps(app, indent=1))

    PIPE_FIX.mkdir(parents=True, exist_ok=True)
    (PIPE_FIX / "nongrav").mkdir(exist_ok=True)
    fields, data = None, []
    for p in snap.orbit_pages:
        d = json.loads(p.read_text())
        fields = d["fields"]
        want = {int(cat.spkid[i]) for i in rows}
        data += [row for row in d["data"] if int(row[0]) in want]
    data.sort(key=lambda row: int(row[0]))
    (PIPE_FIX / "orbits.json").write_text(json.dumps({"fields": fields, "data": data, "count": len(data)}, indent=0))
    for i in rows:
        spk = int(cat.spkid[i])
        if spk in snap.nongrav:
            shutil.copy(snap.nongrav[spk], PIPE_FIX / "nongrav" / f"{spk}.json")
    hzfix = {"epochEt": common, "stepDays": FIXTURE_STEP_DAYS, "forceModelScheme": model.scheme, "objects": [
        {"designation": r.pdes, "spkid": int(cat.spkid[r.row]), "label": r.label, "horizonsSolution": r.horizons_soln,
         "queryUrl": r.horizons_url, "epochs": [float(x) for x in r.epochs[::stride]],
         "states": [[float(v) for v in r.horizons[j]] for j in range(0, r.epochs.size, stride)],
         "stateCommon": [float(x) for x in r.state_common], "toleranceKm": _tolerance(cat, r),
         "maxErrKm": r.max_err_km} for r in res]}
    (PIPE_FIX / "horizons.json").write_text(json.dumps(hzfix, indent=0))
    print(f"wrote {APP_FIX} and {PIPE_FIX} ({len(objs)} objects)")


if __name__ == "__main__":
    main()
