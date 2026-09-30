"""Binary tables in the BinaryTableHeader layout (app/src/data/schema.ts): one fixed-stride little-endian record per
object, each field with a type, element count and byte offset. Fields are laid out in the order given, each aligned
to its element size, and the stride is padded to the largest element size (so typed-array views work in the app).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .output import write_bin, write_json
from .schema import LABEL_ORDER, BuildContext

_TYPES = {"f64": "<f8", "f32": "<f4", "u32": "<u4", "i32": "<i4", "u16": "<u2", "u8": "u1"}
_SIZE = {"f64": 8, "f32": 4, "u32": 4, "i32": 4, "u16": 2, "u8": 1}
LABEL_CODE = {lab: i for i, lab in enumerate(LABEL_ORDER)}


@dataclass
class Field:
    name: str
    type: str
    count: int = 1
    doc: dict = field(default_factory=dict)   # unit, method, label/source column names ... (header "columns")


def layout(fields: list[Field]) -> tuple[list[dict], int, np.dtype]:
    off = 0
    out = []
    maxsize = 1
    for f in fields:
        size = _SIZE[f.type]
        maxsize = max(maxsize, size)
        off = (off + size - 1) // size * size
        out.append({"name": f.name, "type": f.type, "count": f.count, "offset": off})
        off += size * f.count
    stride = (off + maxsize - 1) // maxsize * maxsize
    dt = np.dtype({"names": [f.name for f in fields],
                   "formats": [(_TYPES[f.type], (f.count,)) if f.count > 1 else _TYPES[f.type] for f in fields],
                   "offsets": [d["offset"] for d in out], "itemsize": stride})
    return out, stride, dt


def pack(fields: list[Field], columns: dict[str, np.ndarray], n: int) -> tuple[np.ndarray, list[dict], int]:
    fl, stride, dt = layout(fields)
    rec = np.zeros(n, dtype=dt)
    for f in fields:
        if f.name not in columns:
            raise KeyError(f"no data for field {f.name}")
        rec[f.name] = columns[f.name]
    return rec, fl, stride


def write_table(ctx: BuildContext, rel_stem: str, fields: list[Field], columns: dict[str, np.ndarray], n: int,
                stage: str, *, source_table: list[str] | None = None, notes: str | None = None,
                extra: dict | None = None) -> dict:
    """Write <rel_stem>.bin and <rel_stem>.json (BinaryTableHeader + `columns` docs + extra keys)."""
    rec, fl, stride = pack(fields, columns, n)
    write_bin(ctx, f"{rel_stem}.bin", rec.view(np.uint8).reshape(-1), stage)
    header = {"bin": f"{rel_stem}.bin", "count": n, "stride": stride, "fields": fl,
              "labelEncoding": list(LABEL_ORDER)}
    if source_table is not None:
        header["sourceTable"] = source_table
    if notes:
        header["notes"] = notes
    header["columns"] = {f.name: f.doc for f in fields if f.doc}
    if extra:
        header.update(extra)
    write_json(ctx, f"{rel_stem}.json", header, stage)
    return header


def read_table(header_path: Path) -> tuple[dict, np.ndarray]:
    """Read a table written by write_table back (for tests)."""
    header = json.loads(header_path.read_text())
    root = header_path.parent
    while not (root / header["bin"]).exists() and root != root.parent:
        root = root.parent
    fields = [Field(f["name"], f["type"], f["count"]) for f in header["fields"]]
    fl, stride, dt = layout(fields)
    if stride != header["stride"] or [d["offset"] for d in fl] != [f["offset"] for f in header["fields"]]:
        raise ValueError("header layout is not the canonical packing")
    data = np.fromfile(root / header["bin"], dtype=dt)
    if data.size != header["count"]:
        raise ValueError(f"{header['bin']}: {data.size} records, header says {header['count']}")
    return header, data
