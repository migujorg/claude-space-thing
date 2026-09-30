"""Writing products into app/public/data and the manifest/sources registry."""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

import numpy as np

from . import __version__
from .download import _retry_io, sha256_file
from .paths import OUT
from .schema import BuildContext


def write_json(ctx: BuildContext, rel: str, obj, stage: str, *, indent: int | None = 1) -> Path:
    """`indent=None` writes compact JSON (for large numeric products)."""
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=indent, allow_nan=False, separators=None if indent else (",", ":")), encoding="utf-8", newline="\n")
    _register(ctx, rel, path, stage)
    return path


def write_bin(ctx: BuildContext, rel: str, arr: np.ndarray | bytes, stage: str) -> Path:
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    data = arr if isinstance(arr, (bytes, bytearray)) else np.ascontiguousarray(arr).astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
    path.write_bytes(data)
    _register(ctx, rel, path, stage)
    return path


def _register(ctx: BuildContext, rel: str, path: Path, stage: str) -> None:
    ctx.products[rel] = {"path": rel, "bytes": path.stat().st_size, "sha256": sha256_file(path), "stage": stage}


def _write_atomic(path: Path, text: str) -> None:
    """Write-then-rename: a reader (or a crash) never sees half a manifest."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    _retry_io(lambda: tmp.replace(path))


def write_manifest(ctx: BuildContext, *, stages: dict | None = None, drop_stage: str | None = None,
                   build: dict | None = None) -> None:
    """Merge with any existing manifest so single-stage rebuilds keep other stages' products.

    `stages` replaces the per-stage build records (pipeline/build.py), `drop_stage` removes a stage's products
    (it failed part-way, so its files may be inconsistent), and `build` is the summary of the last build."""
    mpath, spath = OUT / "manifest.json", OUT / "sources.json"
    old, sources = {}, {}
    if mpath.exists():
        old = json.loads(mpath.read_text(encoding="utf-8"))
    if spath.exists():
        sources = {s["id"]: s for s in json.loads(spath.read_text(encoding="utf-8"))}
    products = old.get("products", {})
    # A stage that ran in this build replaces all of its previous products (no stale entries after a rename).
    ran = {p["stage"] for p in ctx.products.values()} | ({drop_stage} if drop_stage else set())
    products = {k: v for k, v in products.items() if v.get("stage") not in ran}
    products.update({k: v for k, v in ctx.products.items() if v.get("stage") != drop_stage})
    sources.update({k: v.to_json() for k, v in ctx.sources.items()})
    manifest = {
        "generatedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "pipelineVersion": __version__,
        "window": {"startEt": ctx.start_et, "endEt": ctx.end_et},
        "products": dict(sorted(products.items())),
    }
    recs = old.get("stages") if stages is None else stages
    if recs:
        manifest["stages"] = dict(sorted(recs.items()))
    summary = old.get("build") if build is None else build
    if summary:
        manifest["build"] = summary
    _write_atomic(mpath, json.dumps(manifest, indent=1))
    _write_atomic(spath, json.dumps(sorted(sources.values(), key=lambda s: s["id"]), indent=1))
