"""Surface-map pyramid geometry, normalization and tile I/O (docs/architecture.md §4.4).

Geometry (the contract): planetocentric latitude, east longitude in the body's IAU body-fixed frame.
Equirectangular: u = (lon_E + 180°)/360°, v = (90° − lat)/180°. Level L is W × H = 512·2^L × 256·2^L texels in
2^(L+1) × 2^L tiles of 256 × 256. Texel (row j, column i) of level L covers
    lon ∈ [−180 + 360·i/W, −180 + 360·(i+1)/W],  lat ∈ [90 − 180·(j+1)/H, 90 − 180·j/H]
and its value is the average over that cell (texel centres at half-integer texel coordinates).
Tiles are raw little-endian arrays addressed surfaces/<naifId>/<layer>/<L>/<ty>/<tx>.bin, row-major (row 0 = north
edge of the tile), channels interleaved per texel.

Unknown texels: in reflectance and parameter layers a texel whose channels are all exactly 0 has no data (every
real value is > 0; values ≤ 0 in sources are rejected as unphysical). Height layers use NaN.

Normalization (§4.4): the disk average "projected-area weighted, as seen at zero phase and averaged over rotation"
for an observer in the body's equatorial plane. A surface element at latitude φ has projected area ∝ cos(e) with
cos(e) = cos φ cos Δλ on the visible hemisphere; averaged over the rotation phase that is cos φ/π, and the element's
area on the equirectangular grid is ∝ cos φ, so each texel is weighted by cos²φ (integrated exactly over its
latitude band, see `row_weights`). Only known texels enter the average.
"""

from __future__ import annotations

import hashlib
import math
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TILE = 256

# ------------------------------------------------------------------------------------------------ geometry


def level_shape(level: int) -> tuple[int, int]:
    """(H, W) in texels of pyramid level `level`."""
    return TILE << level, (2 * TILE) << level


def tiles_shape(level: int) -> tuple[int, int]:
    """(rows, cols) of tiles at `level`."""
    return 1 << level, 2 << level


def lat_edges(level: int) -> np.ndarray:
    """Latitude of the H+1 row edges, north to south (degrees)."""
    h, _ = level_shape(level)
    return 90.0 - 180.0 * np.arange(h + 1) / h


def lon_edges(level: int) -> np.ndarray:
    """East longitude of the W+1 column edges, −180 → +180 (degrees)."""
    _, w = level_shape(level)
    return -180.0 + 360.0 * np.arange(w + 1) / w


def lat_centers(level: int) -> np.ndarray:
    e = lat_edges(level)
    return 0.5 * (e[1:] + e[:-1])


def lon_centers(level: int) -> np.ndarray:
    e = lon_edges(level)
    return 0.5 * (e[1:] + e[:-1])


def wrap_lon(lon_deg):
    """East longitude into [−180, 180)."""
    return (np.asarray(lon_deg, float) + 180.0) % 360.0 - 180.0


def texel_of(level: int, lat_deg: float, lon_deg: float) -> tuple[int, int]:
    """(row j, column i) of the level-`level` texel containing planetocentric (lat, east lon)."""
    h, w = level_shape(level)
    u = (float(wrap_lon(lon_deg)) + 180.0) / 360.0
    v = (90.0 - float(lat_deg)) / 180.0
    return min(int(v * h), h - 1), min(int(u * w), w - 1)


def tile_of(level: int, lat_deg: float, lon_deg: float) -> tuple[int, int, int, int]:
    """(ty, tx, py, px): tile row/column and the texel row/column inside it."""
    j, i = texel_of(level, lat_deg, lon_deg)
    return j // TILE, i // TILE, j % TILE, i % TILE


def tile_rel_path(naif: int, layer: str, level: int, ty: int, tx: int) -> str:
    return f"surfaces/{naif}/{layer}/{level}/{ty}/{tx}.bin"


def level_for_resolution(circumference_px: float) -> int:
    """Smallest level whose width is ≥ the source's equatorial sampling (never upsample by more than 2×)."""
    level = 0
    while level_shape(level)[1] < circumference_px and level < 12:
        level += 1
    return level


# ------------------------------------------------------------------------------------------------ weights


def row_weights(level: int) -> np.ndarray:
    """Normalization weight of each texel row: ∫ cos²φ dφ over the row's latitude band (exact), per texel."""
    e = np.radians(lat_edges(level))
    # ∫ cos²φ dφ = φ/2 + sin(2φ)/4
    f = e / 2 + np.sin(2 * e) / 4
    return f[:-1] - f[1:]


def disk_mean(arr: np.ndarray, known: np.ndarray, level: int) -> np.ndarray:
    """cos²φ-weighted mean over known texels of an (H, W[, C]) array at `level` (per channel)."""
    wr = row_weights(level)
    if arr.ndim == 2:
        arr = arr[..., None]
    num = np.zeros(arr.shape[-1])
    den = 0.0
    for j0 in range(0, arr.shape[0], 512):
        a = np.asarray(arr[j0:j0 + 512], np.float64)
        k = np.asarray(known[j0:j0 + 512])
        w = wr[j0:j0 + 512, None] * k
        num += np.einsum("jw,jwc->c", w, np.where(k[..., None], a, 0.0))
        den += w.sum()
    return num / den


def known_weight_fraction(known: np.ndarray, level: int) -> float:
    """Fraction of the rotation-averaged zero-phase disk (cos²φ weight) covered by known texels."""
    wr = row_weights(level)
    return float((wr[:, None] * known).sum() / (wr.sum() * known.shape[1]))


def area_fraction(known: np.ndarray, level: int) -> float:
    """Fraction of the sphere's surface area covered by known texels."""
    e = np.radians(lat_edges(level))
    wr = np.sin(e[:-1]) - np.sin(e[1:])
    return float((wr[:, None] * known).sum() / (wr.sum() * known.shape[1]))


# ------------------------------------------------------------------------------------------------ pyramid


def downsample2(arr: np.ndarray, known: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Next-coarser level: mean of the known texels in each 2×2 block (unknown if none is known).

    The four texels are weighted equally (not by their slightly different areas); the difference is < 0.1 % of a
    texel's weight below 89° latitude and only redistributes within one coarse texel."""
    h, w = known.shape
    k = known.reshape(h // 2, 2, w // 2, 2).astype(np.float32)
    n = k.sum(axis=(1, 3))
    if arr.ndim == 2:
        a = np.where(known, arr, 0).reshape(h // 2, 2, w // 2, 2).sum(axis=(1, 3))
        out = np.where(n > 0, a / np.maximum(n, 1), 0).astype(np.float32)
    else:
        c = arr.shape[2]
        a = np.where(known[..., None], arr, 0).reshape(h // 2, 2, w // 2, 2, c).sum(axis=(1, 3))
        out = np.where(n[..., None] > 0, a / np.maximum(n, 1)[..., None], 0).astype(np.float32)
    return out, n > 0


@dataclass
class TileSet:
    """Files written for one layer: relative path -> sha256, plus levels and the tiles left out (all unknown)."""
    files: dict[str, str]
    bytes: int
    missing: dict[int, list[list[int]]]

    def digest(self) -> str:
        h = hashlib.sha256()
        for p in sorted(self.files):
            h.update(f"{self.files[p]}  {p}\n".encode())
        return h.hexdigest()

    def listing(self) -> bytes:
        return "".join(f"{self.files[p]}  {p}\n" for p in sorted(self.files)).encode()


def encode_tile(block: np.ndarray, known: np.ndarray, fmt: str) -> bytes:
    """Encode a (256, 256[, C]) block. fmt 'f16' (reflectance/parameters: unknown -> 0, known clamped to the smallest
    positive normal float16 so that it never collides with the unknown marker) or 'f32' (height: unknown -> NaN)."""
    if fmt == "f16":
        tiny = np.float32(np.finfo(np.float16).tiny)
        k = known[..., None] if block.ndim == 3 else known
        b = np.where(k, np.maximum(block, tiny), 0).astype("<f2")
        if not np.isfinite(b).all():
            raise ValueError("float16 overflow in tile")
        return b.tobytes()
    if fmt == "f32":
        return np.where(known if block.ndim == 2 else known[..., None], block, np.nan).astype("<f4").tobytes()
    raise ValueError(fmt)


def write_pyramid(out_root: Path, naif: int, layer: str, top: np.ndarray, known: np.ndarray, top_level: int,
                  fmt: str, *, min_level: int = 0) -> TileSet:
    """Write levels top_level..min_level of an (H, W[, C]) array (H, W = level_shape(top_level)).

    Levels are built by successive 2×2 known-texel means. Tiles whose texels are all unknown are not written and
    are listed in `missing`. The layer directory is cleared first so no stale tiles survive a rebuild."""
    if known.shape != level_shape(top_level):
        raise ValueError(f"array {known.shape} is not level {top_level} {level_shape(top_level)}")
    layer_dir = out_root / "surfaces" / str(naif) / layer
    if layer_dir.exists():
        shutil.rmtree(layer_dir)
    files: dict[str, str] = {}
    missing: dict[int, list[list[int]]] = {}
    total = 0
    arr, kn = top, known
    for level in range(top_level, min_level - 1, -1):
        ny, nx = tiles_shape(level)
        miss = []
        for ty in range(ny):
            rows = slice(ty * TILE, (ty + 1) * TILE)
            strip = np.asarray(arr[rows], np.float32)
            kstrip = np.asarray(kn[rows])
            for tx in range(nx):
                cols = slice(tx * TILE, (tx + 1) * TILE)
                kb = kstrip[:, cols]
                if not kb.any():
                    miss.append([tx, ty])
                    continue
                data = encode_tile(strip[:, cols], kb, fmt)
                rel = tile_rel_path(naif, layer, level, ty, tx)
                p = out_root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
                files[rel] = hashlib.sha256(data).hexdigest()
                total += len(data)
        if miss:
            missing[level] = miss
        if level > min_level:
            arr, kn = downsample2(np.asarray(arr, np.float32), np.asarray(kn))
    return TileSet(files, total, missing)


def read_level(out_root: Path, naif: int, layer: str, level: int, channels: int, fmt: str) -> np.ndarray:
    """Reassemble a whole level from its tiles (tests, previews). Missing tiles read as unknown."""
    h, w = level_shape(level)
    dt = "<f2" if fmt == "f16" else "<f4"
    fill = 0.0 if fmt == "f16" else np.nan
    out = np.full((h, w, channels), fill, np.float32)
    ny, nx = tiles_shape(level)
    for ty in range(ny):
        for tx in range(nx):
            p = out_root / tile_rel_path(naif, layer, level, ty, tx)
            if p.exists():
                out[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE] = np.frombuffer(
                    p.read_bytes(), dt).reshape(TILE, TILE, channels)
    return out


def tile_bytes(fmt: str, channels: int) -> int:
    return TILE * TILE * channels * (2 if fmt == "f16" else 4)


def pyramid_bytes(top_level: int, fmt: str, channels: int) -> int:
    """Upper bound of a full pyramid's size (all tiles present)."""
    return sum(math.prod(tiles_shape(level)) for level in range(top_level + 1)) * tile_bytes(fmt, channels)
