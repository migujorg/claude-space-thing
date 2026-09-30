"""Reading one resolution level of a cloud-optimized GeoTIFF with two HTTP Range requests.

A COG keeps all image file directories (IFDs) at the start of the file and stores each overview's tiles
contiguously, so one level is read with (1) a range read of the header and (2) one range read spanning that
level's tiles. Both go through download.fetch (cached, sha256-recorded with the range and the remote file's
size/ETag/Last-Modified). Tiles are decoded here (deflate, optional horizontal predictor), so no GDAL is needed.
"""

from __future__ import annotations

import io
import logging
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import tifffile

from . import download

HEADER_BYTES = 32768
# tifffile warns about every GDAL_NODATA of 32767 on int16 images (not representable); the value is read here
logging.getLogger("tifffile").setLevel(logging.ERROR)


@dataclass
class Level:
    shape: tuple[int, int]
    tile: tuple[int, int]
    dtype: np.dtype
    offsets: list[int]
    counts: list[int]
    compression: int
    predictor: int
    nodata: float | None
    scale: tuple[float, float] | None      # model pixel scale of the full-resolution page
    tiepoint: tuple[float, float] | None   # model x, y of the full-resolution page's upper-left corner
    full_shape: tuple[int, int]


def _parse(buf: bytes, page: int) -> Level:
    with tifffile.TiffFile(io.BytesIO(buf)) as t:
        p0 = t.pages[0]
        p = t.pages[page]
        if t.byteorder != "<":
            raise ValueError("big-endian TIFF not supported")
        for pg in (p0, p):
            if max(tag.valueoffset + tag.valuebytecount for tag in pg.tags.values()) > len(buf):
                raise EOFError("tag data beyond the header read")
        scale = p0.tags.get("ModelPixelScaleTag")
        tie = p0.tags.get("ModelTiepointTag")
        nod = p0.tags.get("GDAL_NODATA")
        nodata = None
        if nod is not None:
            try:
                nodata = float(str(nod.value).strip("\x00 "))
            except ValueError:
                nodata = None
        return Level(shape=tuple(p.shape[:2]), tile=(p.tilelength, p.tilewidth), dtype=np.dtype(p.dtype),
                     offsets=list(p.dataoffsets), counts=list(p.databytecounts), compression=int(p.compression),
                     predictor=int(p.predictor), nodata=nodata,
                     scale=tuple(scale.value[:2]) if scale else None,
                     tiepoint=tuple(tie.value[3:5]) if tie else None, full_shape=tuple(p0.shape[:2]))


def header(url: str, params: dict | None, subdir: str, stem: str, page: int, record_url: str) -> tuple[Level, Path]:
    """Parse the COG header (range read of the first 32 KiB, enlarged if the IFDs do not fit)."""
    n, size = HEADER_BYTES, None
    while True:
        if size is not None:
            n = min(n, size)
        path = download.fetch(url, subdir, f"{stem}.hdr{n}", params=params, byte_range=(0, n), timeout=180.0,
                              record_url=record_url)
        size = download.record(path).get("remoteBytes") or size
        buf = path.read_bytes()
        try:
            return _parse(buf, page), path
        except (EOFError, ValueError, IndexError, tifffile.TiffFileError):
            if n >= 1 << 22 or (size is not None and n >= size):
                raise
            path.unlink(missing_ok=True)
            n *= 4


def read_level(url: str, params: dict | None, subdir: str, stem: str, page: int, record_url: str,
               ) -> tuple[np.ndarray, Level, list[Path]]:
    """(image of overview `page` (0 = full resolution), level info, the two range files)."""
    lv, hpath = header(url, params, subdir, stem, page, record_url)
    if lv.compression not in (8, 32946):
        raise ValueError(f"{record_url}: compression {lv.compression} not supported (deflate only)")
    stored = [(o, c) for o, c in zip(lv.offsets, lv.counts) if c > 0]
    img = np.full(lv.shape, lv.nodata if lv.nodata is not None else 0, dtype=lv.dtype)
    if not stored:
        return img, lv, [hpath]
    start = min(o for o, _ in stored)
    stop = max(o + c for o, c in stored)
    dpath = download.fetch(url, subdir, f"{stem}.p{page}", params=params, byte_range=(start, stop), timeout=300.0,
                           record_url=record_url)
    data = dpath.read_bytes()
    th, tw = lv.tile
    ntx = -(-lv.shape[1] // tw)
    for k, (o, c) in enumerate(zip(lv.offsets, lv.counts)):
        if c == 0:
            continue
        raw = zlib.decompress(data[o - start:o - start + c])
        tile = np.frombuffer(raw, dtype=lv.dtype.newbyteorder("<")).reshape(th, tw)
        if lv.predictor == 2:
            tile = np.cumsum(tile, axis=1, dtype=lv.dtype)
        elif lv.predictor != 1:
            raise ValueError(f"{record_url}: predictor {lv.predictor} not supported")
        ty, tx = divmod(k, ntx)
        r0, c0 = ty * th, tx * tw
        hh, ww = min(th, lv.shape[0] - r0), min(tw, lv.shape[1] - c0)
        img[r0:r0 + hh, c0:c0 + ww] = tile[:hh, :ww]
    return img, lv, [hpath, dpath]
