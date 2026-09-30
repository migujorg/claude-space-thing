"""Writing products into app/public/data and the manifest/sources registry."""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

import numpy as np

from . import __version__
from .download import sha256_file
from .paths import OUT
from .schema import BuildContext


def write_json(ctx: BuildContext, rel: str, obj, stage: str, *, indent: int | None = 1) -> Path:
    """`indent=None` writes compact JSON (for large numeric products)."""
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=indent, allow_nan=False, separators=None if indent else (",", ":")))
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


def write_manifest(ctx: BuildContext) -> None:
    """Merge with any existing manifest so single-stage rebuilds keep other stages' products."""
    mpath, spath = OUT / "manifest.json", OUT / "sources.json"
    products, sources = {}, {}
    if mpath.exists():
        products = json.loads(mpath.read_text()).get("products", {})
    if spath.exists():
        sources = {s["id"]: s for s in json.loads(spath.read_text())}
    # A stage that ran in this build replaces all of its previous products (no stale entries after a rename).
    ran = {p["stage"] for p in ctx.products.values()}
    products = {k: v for k, v in products.items() if v.get("stage") not in ran}
    products.update(ctx.products)
    sources.update({k: v.to_json() for k, v in ctx.sources.items()})
    manifest = {
        "generatedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "pipelineVersion": __version__,
        "window": {"startEt": ctx.start_et, "endEt": ctx.end_et},
        "products": dict(sorted(products.items())),
    }
    mpath.write_text(json.dumps(manifest, indent=1))
    spath.write_text(json.dumps(sorted(sources.values(), key=lambda s: s["id"]), indent=1))
