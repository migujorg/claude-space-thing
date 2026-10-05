"""Refresh only the SPICE orientation reference using this checkout's downloaded kernels."""
import datetime as dt
import json
from pathlib import Path

from pipeline import ephem_fixtures
from pipeline.download import record
from pipeline.paths import RAW

root = Path(__file__).resolve().parents[1]
fixture = root / "app/tests/fixtures/core_spice_orient.json"
old = json.loads(fixture.read_text())
epochs = sorted({c["et"] for b in old["bodies"] for c in b["cases"]})
pck = RAW / "naif/pck"
kernels = [sorted(pck.glob("earth_*_predict.bpc"))[-1], sorted(pck.glob("earth_000101_*.bpc"))[-1],
           pck / "moon_pa_de440_200625.bpc", RAW / "naif/fk-satellites/moon_de440_250416.tf"]
ephem_fixtures._orientation({
    "generatedBy": "pipeline/.venv/bin/python scripts/refresh-orientation-fixture.py",
    "generated": dt.datetime.now(dt.timezone.utc).date().isoformat(),
    "kernelSha256": {k.name: record(k)["sha256"] for k in kernels},
}, epochs)
