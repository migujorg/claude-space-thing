"""Resampling source rasters onto the pyramid grid (surf_tiles), without inventing values.

Equirectangular sources are resampled separably with sparse linear operators, one per axis:
  - where a target texel is at least as large as a source pixel (downsampling): the exact area overlap of the
    texel with each source pixel (box filter; the texel value is the mean of the source over the texel);
  - where it is smaller (upsampling): linear interpolation between the two nearest source pixel centres
    (nearest pixel within half a pixel of the source's outer edge).
Unknown source pixels carry zero weight: the result is Σw·v / Σw over known pixels, and a texel is known only when
the known weight is at least `min_cover` of the texel (so coverage edges are not extended). Longitude is periodic.

Other projections (polar stereographic) are sampled with `bilinear` at texel centres after the caller has
box-averaged the source to about the texel size.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp

from . import surf_tiles as st


@dataclass(frozen=True)
class EquirectGrid:
    """A raster in simple cylindrical projection: pixel (line l, sample s), 0-based, has its centre at
    lat = lat0 − l·dlat, lon = lon0 + s·dlon (degrees, east longitude, planetocentric latitude)."""
    lat0: float      # centre latitude of line 0
    lon0: float      # centre east longitude of sample 0
    dlat: float      # degrees per line (> 0; lines go north → south)
    dlon: float      # degrees per sample (> 0; samples go west → east)
    lines: int
    samples: int

    def lat_edges(self) -> np.ndarray:
        return self.lat0 + self.dlat / 2 - self.dlat * np.arange(self.lines + 1)

    def lon_edges(self) -> np.ndarray:
        return self.lon0 - self.dlon / 2 + self.dlon * np.arange(self.samples + 1)

    @property
    def is_global_lon(self) -> bool:
        return abs(self.samples * self.dlon - 360.0) < 1e-6 * 360


@dataclass(frozen=True)
class EdgeGrid:
    """A raster with explicit pixel edges: lat_e (lines+1, decreasing, planetocentric degrees) and lon_e
    (samples+1, increasing, east degrees). Used for maps on planetographic latitude, which are uniform in
    planetographic but not in planetocentric latitude."""
    lat_e: tuple
    lon_e: tuple

    def lat_edges(self) -> np.ndarray:
        return np.asarray(self.lat_e, float)

    def lon_edges(self) -> np.ndarray:
        return np.asarray(self.lon_e, float)

    @property
    def lines(self) -> int:
        return len(self.lat_e) - 1

    @property
    def samples(self) -> int:
        return len(self.lon_e) - 1

    @property
    def is_global_lon(self) -> bool:
        return abs(self.lon_e[-1] - self.lon_e[0] - 360.0) < 1e-6


def _box_or_linear(src_e: np.ndarray, dst_e: np.ndarray) -> sp.csr_matrix:
    """(n_dst × n_src) weights for increasing edge arrays (non-periodic). Rows sum to the covered fraction."""
    ns, nd = src_e.size - 1, dst_e.size - 1
    src_w = np.diff(src_e).mean()
    dst_w = np.diff(dst_e)
    rows, cols, vals = [], [], []
    down = dst_w >= src_w * (1 - 1e-9)
    # box overlap for downsampled cells
    idx = np.nonzero(down)[0]
    if idx.size:
        lo, hi = dst_e[idx], dst_e[idx + 1]
        j0 = np.clip(np.searchsorted(src_e, lo, side="right") - 1, 0, ns - 1)
        j1 = np.clip(np.searchsorted(src_e, hi, side="left") - 1, 0, ns - 1)
        span = int((j1 - j0).max()) + 1 if idx.size else 0
        for k in range(span):
            j = np.minimum(j0 + k, ns - 1)
            ok = (j0 + k) <= j1
            ov = np.minimum(hi, src_e[j + 1]) - np.maximum(lo, src_e[j])
            ok &= ov > 0
            rows.append(idx[ok])
            cols.append(j[ok])
            vals.append(ov[ok] / (hi - lo)[ok])
    # linear interpolation at centres for upsampled cells
    idx = np.nonzero(~down)[0]
    if idx.size:
        c = 0.5 * (dst_e[idx] + dst_e[idx + 1])
        centres = 0.5 * (src_e[1:] + src_e[:-1])
        inside = (c >= src_e[0]) & (c <= src_e[-1])
        idx, c = idx[inside], c[inside]
        t = np.interp(c, centres, np.arange(ns, dtype=float))  # clamps to [0, ns-1] (nearest at the outer edge)
        j = np.minimum(np.floor(t).astype(int), ns - 1)
        f = t - j
        j2 = np.minimum(j + 1, ns - 1)
        rows += [idx, idx]
        cols += [j, j2]
        vals += [1 - f, f]
    if not rows:
        return sp.csr_matrix((nd, ns))
    m = sp.coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(nd, ns))
    m.sum_duplicates()
    m.eliminate_zeros()
    return m.tocsr()


def lat_operator(grid: EquirectGrid, level: int) -> tuple[sp.csr_matrix, slice]:
    """Operator from the source's lines to the level's texel rows it touches (row slice of the level)."""
    # work in "degrees south of the north pole" so both axes increase
    src_e = 90.0 - grid.lat_edges()
    dst_all = 90.0 - st.lat_edges(level)
    h = dst_all.size - 1
    r0 = max(int(np.searchsorted(dst_all, src_e[0], side="right")) - 1, 0)
    r1 = min(int(np.searchsorted(dst_all, src_e[-1], side="left")), h)
    op = _box_or_linear(src_e, dst_all[r0:r1 + 1])
    return op, slice(r0, r1)


def lon_operator(grid: EquirectGrid, level: int) -> sp.csr_matrix:
    """Operator from the source's samples to all W texel columns (periodic in longitude)."""
    src_e = grid.lon_edges()
    dst_e = st.lon_edges(level)
    if grid.is_global_lon:
        # extend the source by one period on each side and fold the columns back
        ext = np.concatenate([src_e[:-1] - 360.0, src_e[:-1], src_e + 360.0])
        op = _box_or_linear(ext, dst_e).tocoo()
        cols = op.col % grid.samples
        out = sp.coo_matrix((op.data, (op.row, cols)), shape=(dst_e.size - 1, grid.samples))
        out.sum_duplicates()
        return out.tocsr()
    # regional: shift the source's longitudes by a multiple of 360 so that they overlap the target range
    parts = []
    for shift in (-360.0, 0.0, 360.0):
        e = src_e + shift
        if e[-1] <= -180.0 or e[0] >= 180.0:
            continue
        parts.append(_box_or_linear(e, dst_e))
    return sum(parts[1:], parts[0]).tocsr() if parts else sp.csr_matrix((dst_e.size - 1, grid.samples))


def accumulate(num: np.ndarray, den: np.ndarray, data: np.ndarray, valid: np.ndarray, grid: EquirectGrid,
               level: int) -> None:
    """Add one source raster's contribution to full-level accumulators num (Σ w·v) and den (Σ w), float32 (H, W).

    Several tiles of one mosaic can be accumulated into the same arrays; their contributions to a texel that
    straddles tile edges add up exactly."""
    R, rows = lat_operator(grid, level)
    C = lon_operator(grid, level)
    if R.shape[0] == 0:
        return
    cols = np.unique(C.nonzero()[0])
    if cols.size == 0:
        return
    Cs = C[cols]
    v = valid.astype(np.float32)
    x = np.where(valid, data, 0).astype(np.float32)
    for src, acc in ((x, num), (v, den)):
        t = np.asarray(R @ src, np.float32)                       # (rows, samples)
        out = np.asarray((Cs @ t.T).T, np.float32)                # (rows, cols)
        block = acc[rows]
        block[:, cols] += out
        acc[rows] = block


def accumulate_chunked(num: np.ndarray, den: np.ndarray, data: np.ndarray, grid: EquirectGrid, level: int,
                       valid_fn, transform=None, chunk_lines: int = 2048) -> dict:
    """`accumulate` a large (memory-mapped) raster in blocks of source lines; contributions add up exactly.
    valid_fn(block) -> bool mask of usable pixels; transform(block) -> values (e.g. DN scaling). Returns counts."""
    n_valid = n_total = 0
    for l0 in range(0, grid.lines, chunk_lines):
        blk = np.asarray(data[l0:l0 + chunk_lines])
        v = valid_fn(blk)
        x = transform(blk) if transform is not None else blk.astype(np.float32)
        sub = EquirectGrid(grid.lat0 - l0 * grid.dlat, grid.lon0, grid.dlat, grid.dlon, blk.shape[0], grid.samples)
        accumulate(num, den, x, v, sub, level)
        n_valid += int(v.sum())
        n_total += v.size
    return {"validPixels": n_valid, "totalPixels": n_total}


def finish(num: np.ndarray, den: np.ndarray, min_cover: float = 0.5, out: np.ndarray | None = None
           ) -> tuple[np.ndarray, np.ndarray]:
    """(value, known) from accumulators: known where den ≥ min_cover."""
    known = np.asarray(den) >= min_cover
    if out is None:
        out = np.zeros(num.shape, np.float32)
    for j0 in range(0, num.shape[0], 1024):
        s = slice(j0, j0 + 1024)
        d = np.asarray(den[s])
        out[s] = np.where(known[s], np.asarray(num[s]) / np.where(d > 0, d, 1), 0)
    return out, known


def bilinear(src: np.ndarray, valid: np.ndarray, line: np.ndarray, sample: np.ndarray,
             periodic_samples: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear sample at fractional 0-based pixel-centre coordinates. Returns (value, known weight in [0, 1]).

    Unknown neighbours get zero weight and the others are renormalized; points outside the raster by more than
    half a pixel have zero weight."""
    h, w = src.shape
    l0 = np.floor(line).astype(np.int64)
    s0 = np.floor(sample).astype(np.int64)
    fl = line - l0
    fs = sample - s0
    num = np.zeros(line.shape, np.float64)
    den = np.zeros(line.shape, np.float64)
    for dl, wl in ((0, 1 - fl), (1, fl)):
        for ds, ws in ((0, 1 - fs), (1, fs)):
            ll = l0 + dl
            ss = s0 + ds
            if periodic_samples:
                ss = ss % w
            inb = (ll >= 0) & (ll < h) & (ss >= 0) & (ss < w)
            llc = np.clip(ll, 0, h - 1)
            ssc = np.clip(ss, 0, w - 1)
            ok = inb & valid[llc, ssc]
            wt = np.where(ok, wl * ws, 0.0)
            num += wt * np.where(ok, src[llc, ssc], 0.0)
            den += wt
    near = (line >= -0.5) & (line <= h - 0.5) & (periodic_samples | ((sample >= -0.5) & (sample <= w - 0.5)))
    den = np.where(near, den, 0.0)
    val = np.where(den > 0, num / np.where(den > 0, den, 1), 0.0)
    return val, den


def block_mean(src: np.ndarray, valid: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Mean of known pixels in k×k blocks (edges cropped to a multiple of k). Returns (mean, known fraction)."""
    h, w = (src.shape[0] // k) * k, (src.shape[1] // k) * k
    v = valid[:h, :w].reshape(h // k, k, w // k, k).astype(np.float32)
    x = np.where(valid[:h, :w], src[:h, :w], 0).astype(np.float32).reshape(h // k, k, w // k, k)
    n = v.sum(axis=(1, 3))
    s = x.sum(axis=(1, 3))
    return np.where(n > 0, s / np.maximum(n, 1), 0).astype(np.float32), n / (k * k)
