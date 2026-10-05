"""Resume sky sums as persistent archive jobs instead of long HTTP connections."""
import concurrent.futures as cf
import hashlib
import json
import threading
import time
import subprocess
import re
import argparse
from urllib.parse import urljoin

import workstation_pipeline as network
network.install()
from pipeline import download as d, stars_gaia as sg
from pipeline.paths import CACHE, RAW
from pipeline.stages import sky

STATE = CACHE / "sky-async-jobs.json"
LOCK = threading.Lock()


def query_name(query, base):
    return f"{base}_{hashlib.sha256(query.encode()).hexdigest()[:10]}.fits"


def gavo_query(query):
    """PostgreSQL bigint division exactly extracts the source-ID HEALPix bits."""
    query = query.replace("gaiadr3.gaia_source_lite", "gaia.dr3lite")
    query = query.replace("gaiadr3.gaia_source", "gaia.dr3lite")
    return re.sub(r"GAIA_HEALPIX_INDEX\((\d+), source_id\)",
                  lambda m: f"(source_id/{2 ** (35 + 2 * (12 - int(m[1])) )})", query)


def plan():
    """Use the pipeline's exact query selection, including all cache variants."""
    original_order, original_fits, original_csv = sg._in_order, sg.tap_query_fits, sg.tap_query
    def capture(select, table, where, subdir, base, **kwargs):
        query = f"SELECT {select} FROM {table} WHERE {where}"
        return {"query": query, "name": query_name(query, base), "subdir": subdir, "base": base}
    try:
        sg._in_order = lambda fn, items, workers: [fn(item) for item in items]
        sg.tap_query_fits = capture
        sg.tap_query = lambda *args, **kwargs: None  # already-verified CSV
        jobs = sg.fetch_faint_sums(sky.FAINT_G_MIN, sky.FAINT_ORDER, 1)
        jobs += sg.fetch_faint_colour_sums(sky.FAINT_G_MIN, sky.COLOUR_ORDER, 1)
    finally:
        sg._in_order, sg.tap_query_fits, sg.tap_query = original_order, original_fits, original_csv
    ledger = d._load_ledger()
    return [j for j in jobs if j and not cached(j, ledger)]


def cached(job, ledger=None):
    path = RAW / job["subdir"] / job["name"]
    ledger = d._load_ledger() if ledger is None else ledger
    return path.exists() and d.ledger_key(path) in ledger and sg._fits_table_ok(path, sg.TAP_MAXREC)


def save(jobs):
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(jobs, indent=2))
    temporary.replace(STATE)


def advance(job, jobs):
    if cached(job):
        job["phase"] = "SAVED"
        return
    if not job.get("url"):
        provider = job.get("provider", "ari")
        params = {"REQUEST": "doQuery", "LANG": "PostgreSQL" if provider == "aip" else "ADQL", "FORMAT": "fits",
                  "MAXREC": sg.TAP_MAXREC, "PHASE": "RUN", "QUERY": job["query"]}
        if provider == "aip":
            params["QUEUE"] = "2h"
        endpoint = {"gavo": "https://dc.g-vo.org/tap", "aip": "https://gaia.aip.de/tap"}.get(provider, sg.TAP_URL)
        response = d.session().post(endpoint + "/async", data=params,
                                    allow_redirects=False, timeout=30)
        response.raise_for_status()
        if response.status_code != 303 or not response.headers.get("Location"):
            raise ValueError(f"Job submission did not return a job URL: {response.status_code}")
        job["url"] = urljoin(endpoint + "/async", response.headers["Location"])
        job["submittedAt"] = time.time()
        with LOCK:
            save(jobs)  # persist handle before polling or downloading
    response = d.session().get(job["url"] + "/phase", timeout=30)
    response.raise_for_status()
    phase = response.text.strip()
    if phase == "PENDING":
        response = d.session().post(job["url"] + "/phase", data={"PHASE": "RUN"}, timeout=30)
        response.raise_for_status()
        phase = "SUBMITTED"
    job["phase"] = phase
    job["checkedAt"] = time.time()
    if phase == "ABORTED" and job.get("provider", "ari") == "ari":
        job["originalJobUrl"] = job.pop("url")
        job.setdefault("logicalQuery", job["query"])
        job["query"] = gavo_query(job["query"]).replace("gaia.dr3lite", "gaiadr3.gaia_source_lite")
        job["provider"] = "aip"
        job["phase"] = "SUBMITTING"
        return
    if phase in {"ERROR", "ABORTED"}:
        error = d.session().get(job["url"] + "/error", timeout=30)
        raise RuntimeError(f"Archive job {phase}: {error.text[:500]}")
    if phase == "COMPLETED":
        path = d.fetch(job["url"] + "/results/result", job["subdir"], job["name"],
                       timeout=120, validate=lambda p: sg._fits_table_ok(p, sg.TAP_MAXREC))
        path.with_name(path.name + ".adql").write_text(job["query"], encoding="utf-8")
        job["phase"] = "SAVED"


def share_provider(jobs, provider, all_waiting=False, move_running=False):
    """Move half the waiting jobs to the independently validated Gaia mirror."""
    if not all_waiting and any(j.get("provider") == provider for j in jobs.values()):
        return
    phases = {"QUEUED", "EXECUTING"} if move_running else {"QUEUED"}
    candidates = [j for j in jobs.values() if j.get("provider", "ari") != provider
                  and (all_waiting or j.get("provider", "ari") == "ari")
                  and j.get("phase") in phases and not cached(j)]
    def move(job):
        response = d.session().get(job["url"] + "/phase", timeout=30)
        response.raise_for_status()
        if response.text.strip() not in phases:
            return
        response = d.session().post(job["url"] + "/phase", data={"PHASE": "ABORT"}, timeout=30)
        response.raise_for_status()
        job["originalJobUrl"] = job.pop("url")
        job.setdefault("logicalQuery", job["query"])
        job["query"] = gavo_query(job["query"])
        if provider == "aip":
            job["query"] = job["query"].replace("gaia.dr3lite", "gaiadr3.gaia_source_lite")
        job["provider"] = provider
        job["phase"] = "SUBMITTING"
        job.pop("lastError", None)
        with LOCK:
            save(jobs)
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        for result in pool.map(move, candidates if all_waiting else candidates[::2]):
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--share-gavo", action="store_true")
    parser.add_argument("--share-aip", action="store_true")
    parser.add_argument("--prefer-aip", action="store_true")
    parser.add_argument("--move-stragglers-to-aip", action="store_true")
    args = parser.parse_args()
    sg.set_tap_service("ari")
    jobs = json.loads(STATE.read_text()) if STATE.exists() else {}
    for item in plan():
        jobs.setdefault(item["name"], item)
    probe = CACHE / "sky-async-probe.json"
    if probe.exists():
        item = json.loads(probe.read_text())
        name = query_name(item["query"], item["base"])
        if name in jobs and not jobs[name].get("url"):
            jobs[name].update(item)
    save(jobs)
    if args.share_gavo:
        share_provider(jobs, "gavo")
    if args.share_aip:
        share_provider(jobs, "aip")
    if args.prefer_aip:
        share_provider(jobs, "aip", all_waiting=True)
    if args.move_stragglers_to_aip:
        share_provider(jobs, "aip", all_waiting=True, move_running=True)
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        while True:
            pending = [j for j in jobs.values() if not cached(j)]
            if not pending:
                print("[sky-async] All missing sky answers saved.", flush=True)
                subprocess.run(["./run-workstation.sh"], check=True)
                return
            futures = {pool.submit(advance, j, jobs): j for j in pending}
            for future in cf.as_completed(futures):
                job = futures[future]
                try:
                    future.result()
                    job.pop("lastError", None)
                except Exception as exc:
                    job["lastError"] = str(exc)
                    print(f"[sky-async] {job['base']}: {exc}", flush=True)
                with LOCK:
                    save(jobs)
            counts = {}
            for j in jobs.values():
                phase = j.get("phase", "SUBMITTING")
                counts[phase] = counts.get(phase, 0) + 1
            print("[sky-async]", counts, flush=True)
            time.sleep(10)


if __name__ == "__main__":
    main()
