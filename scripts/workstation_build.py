"""Concurrent dependency-aware build with isolated workers and a single manifest writer."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import time

os.environ["PIPELINE_NETWORK_METRICS"] = "1"
from pipeline import build, config
from pipeline.__main__ import _build_args, _window
from pipeline.paths import CACHE
from pipeline.schema import BuildContext, SourceRecord

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
_build_args(parser)
parser.add_argument("--jobs", type=int, default=4)
args = parser.parse_args()
if args.jobs < 1:
    parser.error("--jobs must be positive")
core = ["time", "ephemeris", "bodies", "light", "stars"]
config.STAGES[:] = core + [s for s in config.STAGES if s not in core]
split = lambda text: [s.strip() for s in text.split(",") if s.strip()]
plan = build.make_plan(args.profile, split(args.only), split(args.skip), args.force)
params = config.resolve(plan.profile, config.parse_sets(args.set), only=plan.explicit)
config.export_env(params)
ctx = BuildContext(*_window(args.new_window, args.window_days), params=params, plan=tuple(plan.stages))
if args.adopt:
    sys.exit(build.adopt(ctx, plan))
if args.dry_run:
    sys.exit(build.run(ctx, plan, dry_run=True, force_space=args.force_space))
manifest = build.read_manifest()
ctx.products = manifest.get("products", {})
source_path = ROOT / "app/public/data/sources.json"
if source_path.exists():
    ctx.sources = {s["id"]: SourceRecord(**s) for s in json.loads(source_path.read_text())}
records = dict(manifest.get("stages", {}))
pending = list(plan.stages)
finished = {}
running = {}
started_at = dt.datetime.now(dt.timezone.utc).isoformat()
run_dir = CACHE / "parallel" / dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
run_dir.mkdir(parents=True, exist_ok=True)
status_path = CACHE / "parallel-status.json"

def publish_status():
    status_path.write_text(json.dumps({"running": list(running), "pending": pending, "finished": finished,
                                      "startedAt": started_at, "jobs": args.jobs}, indent=2))

print(f"[parallel] {args.jobs} stage workers; logs {run_dir}; one manifest writer", flush=True)
try:
    while pending or running:
        for name in list(pending):
            if len(running) >= args.jobs:
                break
            mod = build.load_stage(name)
            deps = tuple(getattr(mod, "DEPENDS", ()))
            if any(finished.get(d) in {"failed", "blocked", "no space"} for d in deps):
                pending.remove(name)
                finished[name] = "blocked"
                print(f"[parallel] BLOCKED {name}: dependency failed", flush=True)
                continue
            if any(d in pending or d in running for d in deps):
                continue
            if any(not build._has_products(ctx.products, d) for d in deps):
                pending.remove(name)
                finished[name] = "blocked"
                continue
            fp = build.fingerprint(name, deps, params, (ctx.start_et, ctx.end_et), ctx.products)
            present, _ = build.products_present(ctx.products, name)
            old = records.get(name, {})
            if name not in plan.forced and old.get("status") == "built" and old.get("fingerprint") == fp["fingerprint"] and present:
                pending.remove(name)
                finished[name] = "up to date"
                continue
            need = build.space_needed(name, config.stage_cost(name, params), ctx.products)
            free, _ = build.free_space()
            reserved = sum(item["space"] for item in running.values())
            if need + reserved > free and not args.force_space:
                if running:
                    continue
                pending.remove(name)
                finished[name] = "no space"
                continue
            path = run_dir / f"{name}.json"
            path.write_text(json.dumps({"stage": name, "startEt": ctx.start_et, "endEt": ctx.end_et,
                                        "params": params, "plan": plan.stages, "products": ctx.products,
                                        "sources": {k: v.to_json() for k, v in ctx.sources.items()}}))
            log = (run_dir / f"{name}.log").open("w")
            env = os.environ.copy()
            env.setdefault("OPENBLAS_NUM_THREADS", "4")
            env.setdefault("OMP_NUM_THREADS", "4")
            proc = subprocess.Popen([sys.executable, "-u", str(ROOT / "scripts/workstation_stage.py"), str(path)],
                                    stdout=log, stderr=subprocess.STDOUT, cwd=ROOT, env=env)
            running[name] = {"process": proc, "log": log, "path": path, "fingerprint": fp, "space": need}
            pending.remove(name)
            print(f"[parallel] START {name}, pid {proc.pid}; active: {', '.join(running)}", flush=True)
        completed_this_pass = False
        for name, item in list(running.items()):
            if item["process"].poll() is None:
                continue
            completed_this_pass = True
            item["log"].close()
            result_path = item["path"].with_suffix(".result.json")
            result = json.loads(result_path.read_text()) if result_path.exists() else {"status": "failed", "error": "worker exited without result"}
            finished[name] = result["status"]
            ctx.products = {k: v for k, v in ctx.products.items() if v["stage"] != name}
            if result["status"] == "built":
                ctx.products.update(result["products"])
                ctx.sources.update({k: SourceRecord(**v) for k, v in result["sources"].items()})
                records[name] = {"status": "built", "finishedAt": build._now(), "profile": plan.profile,
                                 **item["fingerprint"], "seconds": result["seconds"], "downloadedBytes": result["downloadedBytes"]}
                build._save(ctx, records)
            else:
                records[name] = {"status": "failed", "failedAt": build._now(), "error": result["error"]}
                build._save(ctx, records, drop_stage=name)
                if args.stop_on_error:
                    pending.clear()
            print(f"[parallel] {result['status'].upper()} {name}: {result.get('seconds', '?')}s {result.get('error', '')}", flush=True)
            del running[name]
        publish_status()
        if pending and not running:
            if completed_this_pass:
                continue  # A completed dependency can make a pending stage ready on the next pass.
            raise RuntimeError(f"No ready stages; unresolved dependencies: {pending}")
        if running:
            time.sleep(1)
finally:
    for item in running.values():
        item["process"].terminate()
        item["process"].wait()
        item["log"].close()
build._save(ctx, records, build={"profile": plan.profile, "startedAt": started_at, "finishedAt": build._now(),
                               "stages": {name: {"status": status} for name, status in finished.items()}})
print(f"[parallel] COMPLETE {finished}", flush=True)
sys.exit(1 if any(s in {"failed", "blocked", "no space"} for s in finished.values()) else 0)
