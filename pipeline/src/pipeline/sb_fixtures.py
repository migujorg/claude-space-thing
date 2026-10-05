"""Regenerate the committed small-body references: `uv run python -m pipeline.sb_fixtures` (after a build).

Writes
  app/tests/fixtures/smallbody_reference.json   force model, per verification object: SBDB elements, our states at
                                                its epoch and at the reference epoch, JPL Horizons positions and our
                                                (Python) positions every RECORD_STEP_DAYS across the window.
  pipeline/tests/fixtures/sb/orbits.json        the verification objects' raw SBDB query rows (API page format)
  pipeline/tests/fixtures/sb/nongrav/*.json     their sbdb.api answers (non-gravitational model parameters)
  pipeline/tests/fixtures/sb/horizons.json      Horizons heliocentric states every RECORD_STEP_DAYS (+ query URLs)

Horizons answers come from the cached, sha256-recorded downloads of sb_verify (data/raw/horizons/smallbodies/).

These files are a reference for stated inputs, not a picture of the current build: stated orbit solutions (SBDB
snapshot, orbit ids), their own reference epoch (`epochEt`, the catalogue epoch of the build they were made from)
and the force model at that epoch. Tests use them with that epoch and model, whatever the epoch, window or SBDB
snapshot of the data they run against; a build only has to supply planetary positions at the reference epochs it
covers. So a rebuild never requires running this. Run it when the force model, the integrator or the verification
set changes, or when the window has moved so far that the tests report most reference epochs as not compared.

What the pipeline computed for the build itself is the stage's build record (verification/smallbodies.json, same
object shape), which the tests read from the build.
"""

from __future__ import annotations

import datetime as _dt
import json
import shutil

import numpy as np

from . import sb_catalog, sb_model, sb_sbdb, sb_verify
from .paths import CACHE, OUT, REPO
from .stages.smallbodies import RECORD_STEP_DAYS, common_epoch, verification_objects
from .schema import BuildContext
from .sb_table import read_table

APP_FIX = REPO / "app" / "tests" / "fixtures" / "smallbody_reference.json"
PIPE_FIX = REPO / "pipeline" / "tests" / "fixtures" / "sb"


def main() -> None:
    w = json.loads((CACHE / "window.json").read_text(encoding="utf-8"))
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
    res = sb_verify.run(cat, model, common, ctx.start_et, ctx.end_et, states_common=states_full)
    objs = verification_objects(cat, model, res, table["flags"])
    app = {
        "generatedBy": "uv run python -m pipeline.sb_fixtures", "generated": _dt.date.today().isoformat(),
        "sbdbSnapshot": snap.tag, "epochEt": common, "forceModel": model.to_json(), "objects": objs,
        "description": "A reference for stated inputs. epochEt is this reference's own epoch (the catalogue epoch of "
                       "the build it was made from), forceModel the model at that epoch, coreRow the row in that "
                       "build's SBDB snapshot: none of them describes the build under test. stateCommon -> "
                       "SmallBodyPropagator.propagateOne(grid0 = epochEt) with forceModel must reproduce `python` "
                       "(same scheme) and stay within toleranceKm of `horizons` (JPL Horizons heliocentric ICRF, "
                       "TDB).",
    }
    APP_FIX.write_text(json.dumps(app, indent=1), encoding="utf-8", newline="\n")

    PIPE_FIX.mkdir(parents=True, exist_ok=True)
    (PIPE_FIX / "nongrav").mkdir(exist_ok=True)
    fields, data = None, []
    for p in snap.orbit_pages:
        d = json.loads(p.read_text(encoding="utf-8"))
        fields = d["fields"]
        want = {int(cat.spkid[i]) for i in rows}
        data += [row for row in d["data"] if int(row[0]) in want]
    data.sort(key=lambda row: int(row[0]))
    (PIPE_FIX / "orbits.json").write_text(json.dumps({"fields": fields, "data": data, "count": len(data)}, indent=0), encoding="utf-8", newline="\n")
    for i in rows:
        spk = int(cat.spkid[i])
        if spk in snap.nongrav:
            shutil.copy(snap.nongrav[spk], PIPE_FIX / "nongrav" / f"{spk}.json")
    stride = int(round(RECORD_STEP_DAYS / 2))
    hzfix = {"epochEt": common, "stepDays": RECORD_STEP_DAYS, "forceModelScheme": model.scheme, "objects": [
        {"designation": r.pdes, "spkid": int(cat.spkid[r.row]), "label": r.label, "horizonsSolution": r.horizons_soln,
         "queryUrl": r.horizons_url, "epochs": [float(x) for x in r.epochs[::stride]],
         "states": [[float(v) for v in r.horizons[j]] for j in range(0, r.epochs.size, stride)],
         "stateCommon": [float(x) for x in r.state_common], "toleranceKm": o["toleranceKm"],
         "maxErrKm": r.max_err_km} for r, o in zip(res, objs)]}
    (PIPE_FIX / "horizons.json").write_text(json.dumps(hzfix, indent=0), encoding="utf-8", newline="\n")
    print(f"wrote {APP_FIX} and {PIPE_FIX} ({len(objs)} objects)")


if __name__ == "__main__":
    main()
