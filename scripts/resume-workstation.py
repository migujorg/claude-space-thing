"""Idempotently restore the workstation's resumable build, server, and bandwidth services."""
from pathlib import Path
import subprocess
import json

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / "pipeline/.venv/bin/python"
LOGS = ROOT / "data/cache/logs"
LOGS.mkdir(parents=True, exist_ok=True)
services = [
    ("space-thing-app", ROOT / "app", ["/home/linuxbrew/.linuxbrew/bin/node", "node_modules/vite/bin/vite.js",
                                      "--host", "127.0.0.1", "--port", "5173", "--strictPort"], "app.log", []),
    ("space-thing-bandwidth", ROOT, [str(PYTHON), "-u", "scripts/workstation_bandwidth.py"], "bandwidth.log", []),
    ("space-thing-bulk-download", ROOT, [str(PYTHON), "-u", "scripts/workstation_bulk_prefetch.py"], "bulk-download.log", []),
    ("space-thing-bulk", ROOT, [str(PYTHON), "-u", "scripts/workstation_bulk.py"], "bulk.log",
     ["PIPELINE_XP_CACHE_BULK=1", "OPENBLAS_NUM_THREADS=1", "OMP_NUM_THREADS=1"]),
    ("space-thing-build", ROOT, [str(ROOT / "run-workstation.sh")], "workstation-setup.log", []),
]
if (ROOT / "data/cache/sky-async-jobs.json").exists():
    # Saved archive job handles must be resumed before starting the final build;
    # a second synchronous worker would repeat the same remote calculations.
    services[-1] = ("space-thing-sky-async", ROOT,
                    [str(PYTHON), "-u", "scripts/workstation_sky_async.py"], "sky-async.log", [])
try:
    data_root = ROOT / "app/public/data"
    manifest = json.loads((data_root / "manifest.json").read_text())
    complete = len(manifest["stages"]) == 13 and all(s["status"] == "built" for s in manifest["stages"].values())
    def present(product):
        path = data_root / product["path"]
        if product["path"].endswith("/"):
            return path.is_dir() and sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) == product["bytes"]
        return path.is_file() and path.stat().st_size == product["bytes"]
    complete = complete and all(present(p) for p in manifest["products"].values())
    if complete:
        services = services[:1]  # finished setup: restore the app without scanning 114 GB of bulk inputs
except (OSError, KeyError, ValueError):
    pass
for name, directory, command, logfile, environment in services:
    if subprocess.run(["systemctl", "--user", "is-active", "--quiet", name]).returncode == 0:
        print(name + ": already active", flush=True)
        continue
    subprocess.run(["systemctl", "--user", "reset-failed", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    loaded = subprocess.run(["systemctl", "--user", "show", name, "--property=LoadState", "--value"],
                            capture_output=True, text=True).stdout.strip()
    if loaded == "loaded":
        subprocess.run(["systemctl", "--user", "start", name], check=True)
        print(name + ": resumed existing unit", flush=True)
        continue
    args = ["systemd-run", "--user", "--unit=" + name, "--property=WorkingDirectory=" + str(directory),
            "--property=StandardOutput=append:" + str(LOGS / logfile),
            "--property=StandardError=append:" + str(LOGS / logfile)]
    args += ["--property=Environment=" + value for value in environment]
    subprocess.run(args + command, check=True)
    print(name + ": resumed", flush=True)
