"""Isolated stage worker. The coordinator alone publishes the manifest."""
import json
from pathlib import Path
import sys
import time
import traceback
import faulthandler
import signal

import workstation_pipeline as network
network.install()
from pipeline import build, config, download
from pipeline.schema import BuildContext, SourceRecord

def main():
    faulthandler.register(signal.SIGUSR1)
    job_path = Path(sys.argv[1])
    job = json.loads(job_path.read_text())
    config.export_env(job["params"])
    ctx = BuildContext(job["startEt"], job["endEt"], params=job["params"], plan=tuple(job["plan"]))
    ctx.products = {k: v for k, v in job["products"].items() if v["stage"] != job["stage"]}
    ctx.sources = {k: SourceRecord(**v) for k, v in job["sources"].items()}
    before = {k: v.to_json() for k, v in ctx.sources.items()}
    started = time.monotonic()
    try:
        build.load_stage(job["stage"]).run(ctx)
        result = {"status": "built", "products": {k: v for k, v in ctx.products.items() if v["stage"] == job["stage"]},
                  "sources": {k: v.to_json() for k, v in ctx.sources.items() if before.get(k) != v.to_json()}}
    except BaseException as exc:
        traceback.print_exc()
        result = {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}
    result.update(seconds=round(time.monotonic()-started, 1), downloadedBytes=download.stats()["bytes"])
    job_path.with_suffix(".result.json").write_text(json.dumps(result))
    return 0 if result["status"] == "built" else 1


if __name__ == "__main__":
    sys.exit(main())
