"""The build runner: which stages run, in which order, what is skipped and why, and resuming.

`pipeline build --profile standard` runs the profile's stages in STAGES order. Each stage that finishes is recorded
in manifest.json under `stages` with a *fingerprint*: a hash of
  - the source of every pipeline module the stage imports (static import closure, plus data tables next to them),
  - the stage's output parameters (config.stage_params),
  - the time window, if any of that code reads it,
  - the products of the stages it DEPENDS on (their manifest sha256s).
A later build skips a stage whose record matches its current fingerprint and whose products are all on disk
("up to date"), so re-running the same command after a failure or Ctrl-C resumes where it stopped; downloads resume
too (download.py). A stage that fails is reported, its partial products are dropped from the manifest, and the
build goes on with every stage that does not depend on it; the exit code is then 1.

`--only a,b` runs exactly those stages, whether up to date or not (development). `--force` reruns everything.
Products are written by the stages themselves; nothing here changes what a product contains.
"""

from __future__ import annotations

import ast
import contextlib
import datetime as _dt
import hashlib
import importlib
import json
import os
import re
import shutil
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from . import config, download
from .output import write_manifest
from .paths import CACHE, OUT, RAW
from .schema import BuildContext

PKG_ROOT = Path(__file__).resolve().parent
PKG = __package__ or "pipeline"
# Modules that never change what a stage writes (the build machinery, how files are downloaded and where they are
# stored); left out of fingerprints, so improving them does not rebuild everything.
NOT_CODE = {"config", "build", "__main__", "doctor", "download", "paths"}

# ------------------------------------------------------------------------------------------------ fingerprints


def _module_file(mod: str) -> Path | None:
    """File of a pipeline module given as a dotted name relative to the package ('stages.sky', 'photometry')."""
    base = PKG_ROOT.joinpath(*mod.split(".")) if mod else PKG_ROOT
    if base.with_suffix(".py").is_file():
        return base.with_suffix(".py")
    if (base / "__init__.py").is_file():
        return base / "__init__.py"
    return None


def _rel_module(path: Path) -> str:
    rel = path.relative_to(PKG_ROOT).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _resolve(current: str, is_pkg: bool, level: int, module: str | None) -> str | None:
    """Absolute (package-relative) name of `from <level dots><module> import ...` inside module `current`."""
    if level == 0:
        if not module or not (module == PKG or module.startswith(PKG + ".")):
            return None
        return module[len(PKG) + 1:] if module != PKG else ""
    parts = current.split(".") if current else []
    if not is_pkg:
        parts = parts[:-1]
    up = level - 1
    if up > len(parts):
        return None
    base = parts[:len(parts) - up] if up else parts
    return ".".join(base + ([module] if module else []))


_WINDOW = re.compile(r"\b(start_et|end_et)\b")


def code_closure(stage: str) -> tuple[list[Path], bool]:
    """(files, uses_window): every pipeline module stages/<stage>.py can import, data files in the directories the
    modules name (e.g. sky_tables), and whether any of that code reads the build window.

    Imports are followed statically. A module that imports by name at run time (importlib, e.g. surfaces'
    BUILDERS) also pulls in the top-level pipeline modules its string constants name."""
    seen: set[Path] = set()
    data: set[Path] = set()
    uses_window = False
    todo = [_module_file(f"stages.{stage}")]
    while todo:
        path = todo.pop()
        if path is None or path in seen:
            continue
        seen.add(path)
        src = path.read_text(encoding="utf-8")
        name = _rel_module(path)
        is_pkg = path.name == "__init__.py"
        if name not in ("schema", "output") and _WINDOW.search(src):
            uses_window = True
        dynamic = "import_module" in src
        for n in ast.walk(ast.parse(src)):
            targets: list[str] = []
            if isinstance(n, ast.ImportFrom):
                base = _resolve(name, is_pkg, n.level, n.module)
                if base is None:
                    continue
                targets.append(base)
                targets += [f"{base}.{a.name}" if base else a.name for a in n.names]
            elif isinstance(n, ast.Import):
                targets += [a.name[len(PKG) + 1:] for a in n.names if a.name.startswith(PKG + ".")]
            elif isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value.isidentifier():
                if dynamic and (PKG_ROOT / f"{n.value}.py").is_file():
                    targets.append(n.value)
                for d in {path.parent, PKG_ROOT}:
                    if (d / n.value).is_dir() and not (d / n.value / "__init__.py").exists():
                        data.update(p for p in (d / n.value).rglob("*") if p.is_file() and "__pycache__" not in p.parts)
            for t in targets:
                f = _module_file(t)
                if f is not None and t.split(".")[-1] not in NOT_CODE:
                    todo.append(f)
    files = sorted(p for p in seen | data if p.stem not in NOT_CODE or p.suffix != ".py")
    return files, uses_window


def code_hash(files: list[Path]) -> str:
    h = hashlib.sha256()
    for p in files:
        b = p.read_bytes().replace(b"\r\n", b"\n")   # the same on a Windows checkout with CRLF line endings
        h.update(f"{p.relative_to(PKG_ROOT).as_posix()}\0{len(b)}\0".encode())
        h.update(b)
    return h.hexdigest()


def products_digest(products: dict[str, dict], stage: str) -> str:
    """sha256 over a stage's manifest entries (path + sha256): changes whenever its products do."""
    h = hashlib.sha256()
    for rel, e in sorted(products.items()):
        if e.get("stage") == stage:
            h.update(f"{rel}\0{e.get('sha256')}\n".encode())
    return h.hexdigest()


def fingerprint(stage: str, depends: tuple[str, ...], params: dict, window: tuple[float, float],
                products: dict[str, dict], code: tuple[list[Path], bool] | None = None) -> dict:
    files, uses_window = code or code_closure(stage)
    module = load_stage(stage)
    digest = code_hash(files)
    extra = getattr(module, "CODE_INPUTS", ())
    if extra:
        repo = PKG_ROOT.parents[2]
        digest = hashlib.sha256(json.dumps({
            "python": digest,
            "other": {p: hashlib.sha256((repo / p).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
                      for p in sorted(extra)},
        }, sort_keys=True).encode()).hexdigest()
    parts = {
        "code": digest,
        "params": config.stage_params(params, stage),
        "window": list(window) if uses_window else None,
        "inputs": {d: products_digest(products, d) for d in depends},
    }
    parts["fingerprint"] = hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()
    return parts


# ------------------------------------------------------------------------------------------------ manifest state


def _partial_params(stage: str, ctx: BuildContext) -> dict:
    """Operations that retain products built by an earlier run, not complete profile output.

    Level caps and DAMIT omission define complete output for their fingerprinted configuration. Body/layer
    filters and orientation-only updates instead leave some products uncertified by this run's code hash.
    """
    keys = {
        "surfaces": ("surfaces.bodies", "surfaces.earthLayers"),
        "shapes": ("shapes.only", "shapes.reorient"),
    }.get(stage, ())
    return {k: v for k in keys if (v := ctx.param(k))}


def read_manifest() -> dict:
    p = OUT / "manifest.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return {}


def products_present(products: dict[str, dict], stage: str) -> tuple[bool, str]:
    """Every product the manifest lists for `stage` exists with its recorded size (files; 'dir/' entries: the
    directory exists). Hashes are not recomputed here (6 GB); the app verifies them when it loads."""
    mine = {k: v for k, v in products.items() if v.get("stage") == stage}
    if not mine:
        return False, "no products in the manifest"
    for rel, e in mine.items():
        p = OUT / rel
        if rel.endswith("/"):
            if not p.is_dir():
                return False, f"{rel} missing"
        elif not p.is_file():
            return False, f"{rel} missing"
        elif e.get("bytes") is not None and p.stat().st_size != e["bytes"]:
            return False, f"{rel} has {p.stat().st_size} bytes, manifest {e['bytes']}"
    return True, ""


# ------------------------------------------------------------------------------------------------ plan


@dataclass
class Plan:
    stages: list[str]                     # to consider, in STAGES order
    forced: set[str]                      # run even if up to date
    left_out: dict[str, str]              # stage -> why it is not part of this build
    profile: str | None
    explicit: bool                        # --only


def make_plan(profile: str | None, only: list[str], skip: list[str], force: bool) -> Plan:
    for s in only + skip:
        if s not in config.STAGES:
            raise config.ConfigError(f"unknown stage {s!r}; known: {', '.join(config.STAGES)}")
    if only:
        chosen = [s for s in config.STAGES if s in only and s not in skip]
        left = {s: "not in --only" for s in config.STAGES if s not in only}
        return Plan(chosen, set(chosen), {**left, **{s: "--skip" for s in skip if s in only}}, profile, True)
    name = profile or config.DEFAULT_PROFILE
    prof = config.PROFILES[name]
    chosen = [s for s in config.STAGES if s in prof.stages and s not in skip]
    left = {s: f"not in profile {name}" for s in config.STAGES if s not in prof.stages}
    left.update({s: "--skip" for s in skip})
    return Plan(chosen, set(chosen) if force else set(), left, name, False)


# ------------------------------------------------------------------------------------------------ output helpers


def fmt_bytes(n: float | None) -> str:
    return "-" if not n else download._fmt_bytes(n)


def fmt_s(s: float | None) -> str:
    return "-" if s is None else download._fmt_s(s)


class _Tee:
    """Copy of everything written to stdout/stderr into the build log."""

    def __init__(self, stream, log):
        self.stream, self.log = stream, log

    def write(self, s):
        self.stream.write(s)
        with contextlib.suppress(ValueError):
            self.log.write(s)
        return len(s)

    def flush(self):
        self.stream.flush()
        with contextlib.suppress(ValueError):
            self.log.flush()

    def __getattr__(self, k):
        return getattr(self.stream, k)


@dataclass
class Outcome:
    status: str                  # built | up to date | not built | failed | blocked | no space | would run
    reason: str = ""
    seconds: float | None = None
    downloaded: int = 0
    product_bytes: int = 0
    products: int = 0


# ------------------------------------------------------------------------------------------------ disk space

SPACE_MARGIN_GB = 0.5


def _dir_bytes(path: Path) -> int:
    total = 0
    stack = [path]
    while stack:
        p = stack.pop()
        try:
            with os.scandir(p) as it:
                for e in it:
                    if e.is_dir(follow_symlinks=False):
                        stack.append(Path(e.path))
                    elif e.is_file(follow_symlinks=False):
                        total += e.stat(follow_symlinks=False).st_size
        except OSError:
            continue
    return total


def space_needed(stage: str, cost: config.Cost | None, products: dict) -> float:
    """GB of free space a stage may still need: its cold-build disk peak (raw downloads kept, transient files,
    cache, products) less what is already on disk and will be reused or overwritten (its raw files, its products),
    plus a margin. Files streamed and never stored (the 114 GB of Gaia XP) need no space and are not counted."""
    if cost is None:
        return 0.0
    have_raw = sum(_dir_bytes(RAW / d) for d in config.RAW_DIRS.get(stage, ())) / 1e9
    have = min(have_raw, cost.raw_gb) + _stage_bytes(products, stage) / 1e9
    return max(cost.peak_gb - have, 0.0) + SPACE_MARGIN_GB


def free_space() -> tuple[float, Path]:
    """(GB, path): the least free space among the drives holding data/raw, data/cache and app/public/data."""
    best = None
    for p in (RAW, CACHE, OUT):
        q = p
        while not q.exists() and q.parent != q:
            q = q.parent
        f = shutil.disk_usage(q).free / 1e9
        if best is None or f < best[0]:
            best = (f, p)
    return best


# ------------------------------------------------------------------------------------------------ adopt


def _json_refs(obj) -> list[str]:
    """String values of a JSON document that look like product paths (relative, with a known extension)."""
    out = []
    if isinstance(obj, dict):
        for v in obj.values():
            out += _json_refs(v)
    elif isinstance(obj, list):
        for v in obj:
            out += _json_refs(v)
    elif isinstance(obj, str) and "/" in obj and "{" not in obj and " " not in obj and not obj.startswith(
            ("http", "/", ".")) and obj.endswith((".json", ".bin", ".sha256", ".txt")):
        out.append(obj)
    return out


class _Hashing:
    """Progress lines while product files are hashed (a full build is ~6 GB)."""

    def __init__(self, stage: str, n: int):
        self.stage, self.n, self.done, self.bytes, self.t0 = stage, n, 0, 0, time.time()
        self.last = self.t0

    def tick(self, nbytes: int) -> None:
        self.done += 1
        self.bytes += nbytes
        if time.time() - self.last > 20:
            self.last = time.time()
            print(f"   {self.stage}: verified {self.done}/{self.n} files, {fmt_bytes(self.bytes)}", flush=True)


def verify_products(stage: str, products: dict) -> tuple[list[str], dict[str, dict], list[str]]:
    """Check a stage's products on disk against its manifest entries, by content.

    Returns (problems, refreshed entries, notes). A file whose sha256 matches its entry is fine. A JSON file that
    differs from its (stale) entry, e.g. a header or index rewritten after the manifest was merged by hand, is
    accepted when it parses and every product path it names is in the manifest or on disk; its entry is then
    refreshed from the file. Any other difference, or a missing file, is a problem. Tile directories ('dir/'
    entries) are checked through their listing: the listing's sha256, the tile count and total size, and every
    tile's sha256."""
    mine = {k: v for k, v in products.items() if v.get("stage") == stage}
    problems, refreshed, notes = [], {}, []
    if not mine:
        return ["no products in the manifest"], {}, []
    tiles = 0
    for rel, e in mine.items():
        if rel.endswith("/"):
            listing = OUT / (rel.rstrip("/") + ".sha256")
            tiles += int(e.get("files", 0))
            if not listing.is_file():
                problems.append(f"{rel}: its tile listing {listing.name} is missing")
    prog = _Hashing(stage, len(mine) + tiles)
    for rel, e in sorted(mine.items()):
        p = OUT / rel
        if rel.endswith("/"):
            listing = OUT / (rel.rstrip("/") + ".sha256")
            if not listing.is_file():
                continue
            text = listing.read_bytes()
            if hashlib.sha256(text).hexdigest() != e.get("sha256"):
                problems.append(f"{rel}: tile listing differs from the manifest's digest")
                continue
            lines = [ln.split("  ", 1) for ln in text.decode("utf-8").splitlines() if ln.strip()]
            if e.get("files") is not None and len(lines) != e["files"]:
                problems.append(f"{rel}: listing has {len(lines)} tiles, manifest {e['files']}")
                continue
            size = 0
            for sha, tile in lines:
                tp = OUT / tile
                if not tp.is_file():
                    problems.append(f"{tile} missing")
                    break
                size += tp.stat().st_size
                if download.sha256_file(tp) != sha:
                    problems.append(f"{tile}: sha256 differs from its listing")
                    break
                prog.tick(tp.stat().st_size)
            else:
                if e.get("bytes") is not None and size != e["bytes"]:
                    problems.append(f"{rel}: tiles total {size} B, manifest {e['bytes']} B")
            continue
        if not p.is_file():
            problems.append(f"{rel} missing")
            continue
        sha = download.sha256_file(p)
        prog.tick(p.stat().st_size)
        if sha == e.get("sha256") and p.stat().st_size == e.get("bytes", p.stat().st_size):
            continue
        what = (f"{rel}: on disk {p.stat().st_size} B sha256 {sha[:12]}, manifest {e.get('bytes')} B sha256 "
                f"{str(e.get('sha256'))[:12]}")
        if not rel.endswith(".json"):
            problems.append(f"{what} (not JSON, so it cannot be checked by content)")
            continue
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
        except ValueError as err:
            problems.append(f"{what}; and it does not parse: {err}")
            continue
        dangling = [r for r in _json_refs(doc) if r not in products and not (OUT / r).exists()]
        if dangling:
            problems.append(f"{what}; and it names products that do not exist: {', '.join(dangling[:5])}")
            continue
        refreshed[rel] = {**e, "bytes": p.stat().st_size, "sha256": sha}
        notes.append(f"refreshed {what}")
    return problems, refreshed, notes


DEV_PARAMS = ("surfaces.bodies", "surfaces.earthLayers", "shapes.only", "smallbodies.limit", "synthetic.params",
              "stars.xpNoStream")


def param_problem(stage: str, params: dict, products: dict) -> str | None:
    """Why the products on disk do not match the parameters this build would record for the stage."""
    dev = [k for k in DEV_PARAMS if k.startswith(stage + ".")
           and params.get(k, config.PARAMS[k].default) != config.PARAMS[k].default]
    if dev:
        return f"development parameter(s) set ({', '.join(dev)}): adopt without them"
    if stage == "surfaces":
        cap = params.get("surfaces.maxLevel")
        for rel in sorted(k for k in products if k.startswith("surfaces/") and k.count("/") == 2 and k.endswith(".json")
                          and products[k].get("stage") == "surfaces"):
            try:
                h = json.loads((OUT / rel).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            src_max = h.get("levelCap", {}).get("sourceMaxLevel", h.get("maxLevel"))
            want = src_max if cap is None else max(h.get("minLevel", 0), min(src_max, cap))
            if h.get("maxLevel") != want:
                return (f"{rel} has levels up to {h.get('maxLevel')}, but surfaces.maxLevel="
                        f"{'none' if cap is None else cap} means {want}: use the profile the products were built with")
    if stage == "shapes":
        has = "shapes/damit.bin" in products
        if has != bool(params.get("shapes.damit")):
            return (f"the products {'include' if has else 'lack'} DAMIT but shapes.damit={params.get('shapes.damit')}: "
                    "use the profile the products were built with")
    return None


def adopt(ctx: BuildContext, plan: Plan) -> int:
    """Record the stages whose existing products can be trusted as built, without running or downloading
    anything. Per stage: adopted / already up to date / not adoptable, with the exact reason. Exit code 0 if every
    stage of the plan is adopted or up to date, else 1."""
    started = _now()
    window = (ctx.start_et, ctx.end_et)
    manifest = read_manifest()
    records: dict[str, dict] = dict(manifest.get("stages", {}))
    products: dict[str, dict] = dict(manifest.get("products", {}))
    mwin = manifest.get("window") or {}
    print(f"== adopt ({'profile ' + str(plan.profile) if not plan.explicit else '--only'}): nothing is run or "
          f"downloaded; products are hashed and checked against manifest.json. {env_summary()}")
    rows: list[tuple[str, str, str]] = []
    changed = False
    for name in config.STAGES:
        if name not in plan.stages:
            rows.append((name, "not considered", plan.left_out.get(name, "")))
            continue
        mod = load_stage(name)
        deps = tuple(getattr(mod, "DEPENDS", ()))
        rec = records.get(name, {})
        code = code_closure(name)
        fp = fingerprint(name, deps, ctx.params, window, products, code)
        partial = _partial_params(name, ctx)
        if partial:
            rows.append((name, "NOT ADOPTABLE", f"partial build parameter(s) set ({', '.join(partial)}): "
                         "adopt without them"))
            continue
        if rec:
            if rec.get("status") == "built" and rec.get("fingerprint") == fp["fingerprint"]:
                rows.append((name, "up to date", "already recorded"))
            else:
                diff = [k for k in ("code", "params", "window", "inputs") if k in rec and rec[k] != fp[k]]
                rows.append((name, "NOT ADOPTABLE", f"already recorded as {rec.get('status')}" +
                             (f" with a different {', '.join(diff)}" if diff else "") +
                             "; `build` decides whether it reruns"))
            continue
        missing_deps = [d for d in deps if not _has_products(products, d)]
        if missing_deps:
            rows.append((name, "NOT ADOPTABLE", f"needs {', '.join(missing_deps)}, which has no products"))
            continue
        if code[1] and mwin and (mwin.get("startEt"), mwin.get("endEt")) != window:
            rows.append((name, "NOT ADOPTABLE", f"products are for the window {mwin.get('startEt')}..{mwin.get('endEt')} "
                         f"ET, this build's window is {window[0]:.0f}..{window[1]:.0f} (data/cache/window.json)"))
            continue
        why = param_problem(name, ctx.params, products)
        if why:
            rows.append((name, "NOT ADOPTABLE", why))
            continue
        problems, refreshed, notes = verify_products(name, products)
        if problems:
            more = f" (+{len(problems) - 3} more)" if len(problems) > 3 else ""
            rows.append((name, "NOT ADOPTABLE", "; ".join(problems[:3]) + more))
            continue
        if refreshed:
            products.update(refreshed)
            fp = fingerprint(name, deps, ctx.params, window, products, code)   # its own entries changed
        for k, v in products.items():   # register the stage's entries so write_manifest keeps (refreshed) them
            if v.get("stage") == name:
                ctx.products[k] = v
        records[name] = {"status": "built", "adoptedAt": started, "finishedAt": manifest.get("generatedAt"),
                         "profile": None if plan.explicit else plan.profile,
                         **{k: fp[k] for k in ("fingerprint", "code", "params", "window", "inputs")}}
        changed = True
        n = _stage_count(products, name)
        rows.append((name, "adopted", f"{n} products verified" + (f"; {'; '.join(notes)}" if notes else "")))
    if changed:
        write_manifest(ctx, stages=records, build={
            "profile": None if plan.explicit else plan.profile, "adopt": True, "startedAt": started,
            "finishedAt": _now(), "stages": {n: {"status": s, "reason": r} for n, s, r in rows}})
    w0, w1 = max(len(r[0]) for r in rows), max(len(r[1]) for r in rows)
    print("\nAdoption:")
    for n, s, r in rows:
        print(f"  {n.ljust(w0)}  {s.ljust(w1)}  {r}")
    bad = [n for n, s, _ in rows if s == "NOT ADOPTABLE"]
    print(f"\n{sum(1 for _, s, _ in rows if s == 'adopted')} stage(s) recorded as built"
          + (" (manifest.json updated)." if changed else "; manifest.json unchanged."))
    if bad:
        print(f"Not adoptable: {', '.join(bad)}. `python -m pipeline plan` shows what a build would then run and "
              "what it costs; nothing has been run.")
    return 1 if bad else 0


# ------------------------------------------------------------------------------------------------ run


def load_stage(name: str) -> ModuleType:
    return importlib.import_module(f".stages.{name}", PKG)


def _why(name: str, plan: Plan, rec: dict, fp: dict, present: bool, why_not: str) -> str:
    if name in plan.forced:
        return "forced" if not plan.explicit else "--only"
    if not rec:
        return "no completed build recorded"
    if rec.get("status") == "failed":
        return "the previous run failed"
    if rec.get("status") == "partial":
        return "the previous run was partial"
    if not present:
        return f"products incomplete: {why_not}"
    changed = [k for k in ("code", "params", "window", "inputs") if k in rec and rec[k] != fp[k]]
    return "changed: " + ", ".join(changed) if changed else "inputs changed"


def run(ctx: BuildContext, plan: Plan, *, keep_going: bool = True, dry_run: bool = False, force_space: bool = False,
        log_path: Path | None = None) -> int:
    """Run the plan; print progress and a summary; record stage state in the manifest. Returns the exit code
    (0 ok, 1 a stage failed, was blocked or lacked disk space, 130 interrupted).

    Before a stage runs, its disk need (`space_needed`) is compared with the free space on the data drives; a stage
    that may not fit is not started (status "no space") unless `force_space`."""
    t_build = time.time()
    started = _now()
    window = (ctx.start_et, ctx.end_et)
    manifest = read_manifest()
    records: dict[str, dict] = dict(manifest.get("stages", {}))
    products: dict[str, dict] = dict(manifest.get("products", {}))
    outcomes: dict[str, Outcome] = {}
    what = f"profile {plan.profile}" if not plan.explicit else "--only " + ",".join(plan.stages)
    overrides = [f"{k}={v}" for k, v in ctx.params.items()
                 if v != config.PARAMS[k].default and k != "build.writeRepoFiles"]
    print(f"== build ({what}{'; ' + ', '.join(overrides) if overrides else ''}): {env_summary()}")
    if log_path:
        print(f"   log: {log_path}")
    n_total = len(plan.stages)
    stop = None   # why the remaining stages are not run
    user_interrupt = False
    for name in config.STAGES:
        if name not in plan.stages:
            outcomes[name] = Outcome("not built", plan.left_out.get(name, ""))
            continue
        tag = f"[{plan.stages.index(name) + 1}/{n_total}] {name}"
        if stop:
            outcomes[name] = Outcome("not built", stop)
            continue
        try:
            mod = load_stage(name)
        except ModuleNotFoundError as e:
            if e.name and e.name.endswith(f"stages.{name}"):
                outcomes[name] = Outcome("not built", "not implemented")
                continue
            raise
        deps = tuple(getattr(mod, "DEPENDS", ()))
        blocked, after = [], []
        for d in deps:
            od = outcomes.get(d)
            st = od.status if od else "not built"
            if st in ("failed", "blocked", "no space"):
                blocked.append(f"{d} {st}")
            elif st == "not built" and not _has_products(products, d):
                blocked.append(f"{d} not built" + (f" ({od.reason})" if od and od.reason else ""))
            elif st == "would run":
                after.append(d)
        if blocked:
            outcomes[name] = Outcome("blocked", "needs " + "; ".join(blocked))
            print(f"\n== {tag}: blocked, needs {'; '.join(blocked)}", flush=True)
            continue
        cost = config.stage_cost(name, ctx.params)

        def no_space() -> bool:
            """Refuse to start a stage that may not fit on the disk (unless --force-space)."""
            need = space_needed(name, cost, products)
            free, where = free_space()
            if need <= free or force_space:
                return False
            msg = (f"may need ~{need:.1f} GB of disk and {free:.1f} GB is free (drive of {where}). A cold {name} build "
                   f"uses up to {cost.peak_gb:g} GB at once; what is already downloaded or built counts as available. "
                   "Free space, move data/raw and data/cache with PIPELINE_RAW / PIPELINE_CACHE, or pass --force-space")
            outcomes[name] = Outcome("no space", msg)
            print(f"\n== {tag}: NOT STARTED: {msg}", flush=True)
            return True

        if after:   # dry run: a dependency would be rebuilt first, so this stage would run too
            if not no_space():
                outcomes[name] = Outcome("would run", f"after {', '.join(after)}")
            continue
        fp = fingerprint(name, deps, ctx.params, window, products)
        partial = _partial_params(name, ctx)
        rec = records.get(name, {})
        present, why_not = products_present(products, name)
        if name not in plan.forced:
            if (not partial and rec.get("fingerprint") == fp["fingerprint"]
                    and rec.get("status") == "built" and present):
                outcomes[name] = Outcome("up to date", f"built {rec.get('finishedAt', '?')}",
                                         product_bytes=_stage_bytes(products, name),
                                         products=_stage_count(products, name))
                continue
        why = _why(name, plan, rec, fp, present, why_not)
        if no_space():
            continue
        if dry_run:
            outcomes[name] = Outcome("would run", why)
            continue
        est = f"; typical cold build: {cost.describe()}" if cost else ""
        print(f"\n== {tag}: running ({why}{est})", flush=True)
        before = download.stats()["bytes"]
        t0 = time.time()
        keys_before = {k for k, v in ctx.products.items() if v.get("stage") != name}
        sources_before = set(ctx.sources)
        try:
            mod.run(ctx)
        except BaseException as e:   # KeyboardInterrupt too: record the stage as failed, summarize, then stop
            secs = time.time() - t0
            # Drop what the stage registered: its files on disk may be half rewritten.
            for k in [k for k in ctx.products if k not in keys_before]:
                del ctx.products[k]
            for k in [k for k in ctx.sources if k not in sources_before]:
                del ctx.sources[k]
            products = {k: v for k, v in products.items() if v.get("stage") != name}
            msg = f"{type(e).__name__}: {e}".strip().rstrip(":")
            first = msg.splitlines()[0][:200] if msg else type(e).__name__
            records[name] = {"status": "failed", "failedAt": _now(), "error": msg[:1000], "seconds": round(secs, 1)}
            outcomes[name] = Outcome("failed", first, secs, download.stats()["bytes"] - before)
            if isinstance(e, KeyboardInterrupt):
                print(f"\n== {name}: interrupted after {fmt_s(secs)}", flush=True)
                stop, user_interrupt = "build interrupted", True
            else:
                traceback.print_exc()
                print(f"\n== {name}: FAILED after {fmt_s(secs)}: {first}", flush=True)
                if not keep_going:
                    stop = f"stopped after {name} failed (--stop-on-error)"
            _save(ctx, records, drop_stage=name)
            continue
        secs = time.time() - t0
        got = download.stats()["bytes"] - before
        mine = {k: v for k, v in ctx.products.items() if v.get("stage") == name}
        products = {k: v for k, v in products.items() if v.get("stage") != name}
        products.update(mine)
        # The record keeps the fingerprint of the inputs as they were when the stage started.
        records[name] = {"status": "partial" if partial else "built",
                         "finishedAt": _now(), "seconds": round(secs, 1), "downloadedBytes": got,
                         "profile": None if plan.explicit else plan.profile,
                         **({"partialParams": partial} if partial else {}),
                         **{k: fp[k] for k in ("fingerprint", "code", "params", "window", "inputs")}}
        _save(ctx, records)
        o = outcomes[name] = Outcome("built", "", secs, got, sum(v.get("bytes", 0) for v in mine.values()), len(mine))
        print(f"== {name}: built in {fmt_s(secs)} ({o.products} products, {fmt_bytes(o.product_bytes)}; "
              f"downloaded {fmt_bytes(got)})", flush=True)
    if not dry_run:
        _save(ctx, records, build={
            "profile": None if plan.explicit else plan.profile, "only": plan.stages if plan.explicit else None,
            "startedAt": started, "finishedAt": _now(),
            "stages": {k: {"status": o.status, "reason": o.reason} for k, o in outcomes.items()}})
    print_summary(outcomes, time.time() - t_build, plan, log_path, dry_run, ctx.params)
    if user_interrupt:
        return 130
    return 1 if any(o.status in ("failed", "blocked", "no space") for o in outcomes.values()) else 0


def _has_products(products: dict, stage: str) -> bool:
    return any(e.get("stage") == stage for e in products.values())


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _stage_bytes(products: dict, stage: str) -> int:
    return sum(v.get("bytes", 0) for v in products.values() if v.get("stage") == stage)


def _stage_count(products: dict, stage: str) -> int:
    return sum(1 for v in products.values() if v.get("stage") == stage)


def _save(ctx: BuildContext, records: dict, drop_stage: str | None = None, build: dict | None = None) -> None:
    write_manifest(ctx, stages=records, drop_stage=drop_stage, build=build)


def print_summary(outcomes: dict[str, Outcome], seconds: float, plan: Plan, log_path: Path | None,
                  dry_run: bool, params: dict | None = None) -> None:
    if dry_run:
        rows = [("stage", "status", "cold time", "cold download", "products", "note")]
    else:
        rows = [("stage", "status", "time", "downloaded", "products", "note")]
    est_dl = est_min = 0.0
    for name in config.STAGES:
        o = outcomes.get(name)
        if o is None:
            continue
        status = o.status.upper() if o.status in ("failed", "blocked", "no space") else o.status
        if dry_run:
            c = config.stage_cost(name, params or {}) if o.status == "would run" else None
            if c:
                est_dl, est_min = est_dl + c.download_gb, est_min + c.cold_min
            rows.append((name, status, config._min(c.cold_min) if c else "-", config._gb(c.download_gb) if c else "-",
                         fmt_bytes(o.product_bytes) if o.products else "-", o.reason))
        else:
            rows.append((name, status, fmt_s(o.seconds), fmt_bytes(o.downloaded),
                         fmt_bytes(o.product_bytes) if o.products else "-", o.reason))
    w = [max(len(r[k]) for r in rows) for k in range(5)]
    what = f"profile {plan.profile}" if not plan.explicit else "--only"
    print(f"\nPlan ({what}):" if dry_run else f"\nBuild summary ({what}, {fmt_s(seconds)}):")
    for r in rows:
        print("  " + "  ".join(r[k].ljust(w[k]) for k in range(5)) + "  " + r[5])
    if dry_run:
        if not any(o.status == "would run" for o in outcomes.values()):
            print("Nothing would run: every stage of the plan is up to date (or blocked, see above).")
        else:
            print(f"Cold, the stages that would run download about {config._gb(est_dl)} and take about "
                  f"{config._min(est_min)} (README \"Build profiles\"); files already in data/raw are not fetched again.")
        return
    total = sum(v.get("bytes", 0) for v in read_manifest().get("products", {}).values())
    print(f"Products: {fmt_bytes(total)} in {OUT}. Raw downloads: {RAW}; intermediates: {CACHE}.")
    if any(o.status in ("failed", "blocked", "no space") for o in outcomes.values()):
        print("Some stages did not finish. Fix the cause above (`python -m pipeline doctor` checks the usual ones) and "
              "rerun the same command: completed stages are skipped and interrupted downloads resume.")
    if log_path:
        print(f"Full log: {log_path}")


@contextlib.contextmanager
def build_log():
    """Tee stdout/stderr into data/cache/logs/build-<UTC time>.log."""
    d = CACHE / "logs"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"build-{_dt.datetime.now(_dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}.log"
    with path.open("w", encoding="utf-8", newline="\n") as f:
        out, err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = _Tee(out, f), _Tee(err, f)
        try:
            yield path
        finally:
            sys.stdout, sys.stderr = out, err


def env_summary() -> str:
    return (f"python {sys.version.split()[0]} on {sys.platform}; raw {RAW}; cache {CACHE}; out {OUT}; "
            f"pid {os.getpid()}")
