"""Binary layout of stars/<name>.bin and a generic reader for BinaryTableHeader files.

One little-endian record per star (48 bytes). The first 28 bytes are exactly the float32 block the app's
StarCatalog view wants ([ux, uy, uz, X, Y, Z, S]), and the stride is a multiple of 4, so the whole file can
be viewed as a Float32Array with stride 12 floats (the integer fields then read as garbage floats and must be
ignored through that view).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .schema import LABEL_ORDER

#: (name, BinaryField type, count, byte offset). Keep in sync with the header notes below.
FIELDS: tuple[tuple[str, str, int, int], ...] = (
    ("dir", "f32", 3, 0),          # ICRF (BCRS) unit vector at header.epochEt
    ("xyzs", "f32", 4, 12),        # illuminance at the observer: CIE X, Y (lux), Z, scotopic (scotopic lux)
    ("labelPos", "u8", 1, 28),     # index into labelEncoding
    ("labelFlux", "u8", 1, 29),    # label of Y and S (brightness)
    ("labelColor", "u8", 1, 30),   # label of the X/Y, Z/Y, S/Y ratios (colour)
    ("src", "u8", 1, 31),          # index into sourceTable: catalogue the record and catId come from
    ("posRoute", "u8", 1, 32),     # index into header.routes.pos
    ("lightRoute", "u8", 1, 33),   # index into header.routes.light
    ("flags", "u8", 1, 34),        # bitfield, see FLAG_*
    ("catId", "u32", 2, 36),       # catalogue id (lo, hi) as defined per src in header.idEncoding
    ("hip", "u32", 1, 44),         # Hipparcos number of this star, 0 = none
)
STRIDE = 48

FLAG_VARIABLE = 1          # flagged variable by Hipparcos (VarFlag) or Gaia DR3 (phot_variable_flag)
FLAG_MULTIPLE = 2          # Hipparcos double/multiple entry or Gaia DR3 RUWE > 1.4 / non_single_star
FLAG_XP_REJECTED = 4       # Gaia XP spectrum present but not used (too bright, or non-positive integral)
FLAG_LIGHT_COMBINED = 8    # light is a Hipparcos multiple entry's combined light (minus components listed separately)
FLAG_POS_2016_NO_PM = 16   # Gaia DR3 2-parameter solution (no Gaia proper motion)
FLAG_XP_BLENDED = 32       # Gaia BP/RP blended by a neighbour within 2" (XP spectrum not used)

_NP = {"f32": "<f4", "f64": "<f8", "u32": "<u4", "u16": "<u2", "u8": "u1", "i32": "<i4"}


def dtype() -> np.dtype:
    return np.dtype({
        "names": [f[0] for f in FIELDS],
        "formats": [(_NP[t], (c,)) if c > 1 else _NP[t] for _, t, c, _ in FIELDS],
        "offsets": [f[3] for f in FIELDS],
        "itemsize": STRIDE,
    })


def header_fields() -> list[dict]:
    return [{"name": n, "type": t, "count": c, "offset": o} for n, t, c, o in FIELDS]


def label_index(label: str) -> int:
    return LABEL_ORDER.index(label)


def encode(records: np.ndarray) -> bytes:
    """Structured array (dtype()) -> bytes; padding bytes are zeroed."""
    out = np.zeros(records.shape[0], dtype=dtype())
    for n in out.dtype.names:
        out[n] = records[n]
    return out.tobytes()


def read_table(header_path: Path) -> tuple[dict, dict[str, np.ndarray]]:
    """Generic BinaryTableHeader reader (mirrors what the app loader does): header + {field: array}."""
    header = json.loads(Path(header_path).read_text(encoding="utf-8"))
    raw = (Path(header_path).parent / header["bin"]).read_bytes()
    n, stride = header["count"], header["stride"]
    if len(raw) != n * stride:
        raise ValueError(f"{header['bin']}: {len(raw)} bytes, expected {n} x {stride}")
    buf = np.frombuffer(raw, dtype=np.uint8).reshape(n, stride)
    out = {}
    for f in header["fields"]:
        size = np.dtype(_NP[f["type"]]).itemsize
        blk = np.ascontiguousarray(buf[:, f["offset"]:f["offset"] + size * f["count"]])
        arr = blk.view(_NP[f["type"]]).reshape(n, f["count"])
        out[f["name"]] = arr[:, 0] if f["count"] == 1 else arr
    return header, out


def gaia_id(cat_id: np.ndarray) -> np.ndarray:
    """(lo, hi) u32 pair -> int64 source_id."""
    return cat_id[..., 0].astype(np.int64) | (cat_id[..., 1].astype(np.int64) << 32)


def split_id(source_id: np.ndarray) -> np.ndarray:
    s = np.asarray(source_id, dtype=np.int64)
    return np.stack([(s & 0xFFFFFFFF).astype(np.uint32), (s >> 32).astype(np.uint32)], axis=-1)


def tycho_id(tyc1, tyc2, tyc3) -> np.ndarray:
    """TYC1-TYC2-TYC3 packed in one u32: tyc1 * 2^17 + tyc2 * 2^3 + tyc3 (tyc1 <= 9537, tyc2 <= 12121, tyc3 <= 4)."""
    return (np.asarray(tyc1, np.uint32) << 17) | (np.asarray(tyc2, np.uint32) << 3) | np.asarray(tyc3, np.uint32)
