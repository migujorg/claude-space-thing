"""NASA GIBS science layers decoded back to physical values through their published colour maps.

GIBS serves many Level-2/3 science parameters (cloud optical thickness, cloud-top height, VIIRS Day/Night Band
radiance, ...) as PNG images whose colours encode value bins. Each layer's colour map XML
(https://gibs.earthdata.nasa.gov/colormaps/v1.3/<map>.xml, linked from the WMTS capabilities) gives, for every
RGB colour, the value interval [lo, hi) (and, for some maps, a class such as the cloud phase). Inverting the map
recovers the value to within one bin: a documented, lossless-up-to-quantization transform, unlike the stretched
true-colour and "GeoColor" products, which are not used.

Images are fetched with WMS GetMap (EPSG:4326) in blocks; the decoded value of a pixel is the centre of its bin
(the lower bound for an open-ended top bin, flagged as censored). Colours that are not in the map (none were seen
in testing) are counted and treated as no data.
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from .download import fetch, record

CAPS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"
WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
SUBDIR = "surfaces/earth/gibs"


def capabilities(day: str | None = None) -> Path:
    """The WMTS capabilities document (5 MB), cached per UTC day (it changes daily)."""
    day = day or _dt.datetime.now(_dt.timezone.utc).date().isoformat()
    return fetch(CAPS, SUBDIR, f"WMTSCapabilities-{day}.xml", timeout=300)


def layer_info(caps: Path, layer: str) -> dict:
    x = caps.read_text(encoding="utf-8")
    blk = next(b for b in re.findall(r"<Layer>(.*?)</Layer>", x, re.S) if f"<ows:Identifier>{layer}</ows:Identifier>" in b)
    title = re.search(r"<ows:Title[^>]*>([^<]+)</ows:Title>", blk).group(1)
    cmaps = re.findall(r"xlink:href='(https://gibs.earthdata.nasa.gov/colormaps/v1.3/[^']+)'", blk)
    default = re.search(r"<Default>([^<]+)</Default>", blk)
    values = re.findall(r"<Value>([^<]+)</Value>", blk)
    tms = re.findall(r"<TileMatrixSet>([^<]+)</TileMatrixSet>", blk)
    return {"layer": layer, "title": title, "colormap": cmaps[0] if cmaps else None,
            "default": default.group(1) if default else None, "periods": values, "tileMatrixSet": tms}


@dataclass
class Colormap:
    url: str
    keys: np.ndarray      # packed RGB (r<<16 | g<<8 | b) of every data entry, sorted
    lo: np.ndarray
    hi: np.ndarray
    value: np.ndarray     # representative value (bin centre; lower bound if the bin is open-ended)
    censored: np.ndarray  # open-ended top bin
    cls: np.ndarray       # index of the <ColorMap> the entry belongs to
    classes: list[str]
    nodata_keys: np.ndarray
    units: str | None


def _interval(s: str) -> tuple[float, float]:
    """'[lo,hi)' → (lo, hi); a single value '[v]' or 'v' → (v, v) (an exact class value)."""
    conv = lambda t: float("inf") if t.strip() in ("+INF", "INF") else float(t)  # noqa: E731
    parts = s.strip("[]()").split(",")
    if len(parts) == 1:
        return conv(parts[0]), conv(parts[0])
    return conv(parts[0]), conv(parts[1])


def parse_colormap(url: str, path: Path) -> Colormap:
    t = path.read_text(encoding="utf-8")
    keys, lo, hi, cls, nod, classes = [], [], [], [], [], []
    units = None
    for m in re.finditer(r"<ColorMap(\s[^>]*)?>(.*?)</ColorMap>", t, re.S):
        attrs = m.group(1) or ""
        title = re.search(r'title="([^"]*)"', attrs)
        u = re.search(r'units="([^"]*)"', attrs)
        if u and not units:
            units = u.group(1)
        ci = len(classes)
        classes.append(title.group(1) if title else f"map{ci}")
        for e in re.findall(r"<ColorMapEntry([^>]*)/>", m.group(2)):
            r, g, b = (int(v) for v in re.search(r'rgb="([^"]+)"', e).group(1).split(","))
            k = (r << 16) | (g << 8) | b
            if 'nodata="true"' in e:
                nod.append(k)
                continue
            val = re.search(r'\svalue="([^"]+)"', e) or re.search(r'sourceValue="([^"]+)"', e)
            a, bnd = _interval(val.group(1))
            keys.append(k)
            lo.append(a)
            hi.append(bnd)
            cls.append(ci)
    keys = np.array(keys, np.int64)
    if np.unique(keys).size != keys.size:
        raise ValueError(f"{url}: colour map has duplicate colours; cannot be inverted")
    lo, hi = np.array(lo), np.array(hi)
    with np.errstate(divide="ignore"):
        censored = ~np.isfinite(hi) | ((lo > 0) & (hi / np.where(lo > 0, lo, 1) > 1000))
    order = np.argsort(keys)
    value = np.where(censored, lo, 0.5 * (lo + np.where(np.isfinite(hi), hi, lo)))
    return Colormap(url, keys[order], lo[order], hi[order], value[order], censored[order], np.array(cls)[order],
                    classes, np.array(nod, np.int64), units)


def colormap(url: str) -> Colormap:
    path = fetch(url, SUBDIR)
    return parse_colormap(url, path)


def decode(rgba: np.ndarray, cm: Colormap) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """(value float32 with NaN = no data, class int8 with -1 = no data, censored bool, number of unmatched pixels)."""
    a = rgba[..., 3]
    k = (rgba[..., 0].astype(np.int64) << 16) | (rgba[..., 1].astype(np.int64) << 8) | rgba[..., 2]
    idx = np.searchsorted(cm.keys, k)
    idx = np.clip(idx, 0, cm.keys.size - 1)
    hit = (cm.keys[idx] == k) & (a > 0)
    nod = np.isin(k, cm.nodata_keys) | (a == 0)
    unmatched = int((~hit & ~nod).sum())
    val = np.where(hit, cm.value[idx], np.nan).astype(np.float32)
    cls = np.where(hit, cm.cls[idx], -1).astype(np.int8)
    cen = hit & cm.censored[idx]
    return val, cls, cen, unmatched


def getmap(layer: str, time: str, bbox: tuple[float, float, float, float], width: int, height: int) -> Path:
    """WMS GetMap PNG of bbox = (lat_min, lon_min, lat_max, lon_max) (WMS 1.3.0 EPSG:4326 axis order)."""
    params = {"SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.3.0", "LAYERS": layer, "STYLES": "",
              "CRS": "EPSG:4326", "BBOX": ",".join(f"{v:g}" for v in bbox), "WIDTH": str(width),
              "HEIGHT": str(height), "FORMAT": "image/png", "TIME": time}
    name = f"{layer}_{time}_{bbox[0]:g}_{bbox[1]:g}_{bbox[2]:g}_{bbox[3]:g}_{width}x{height}.png"
    return fetch(WMS, SUBDIR, name, params=params, timeout=600,
                 validate=lambda p: p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n")


def read_rgba(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA"))


def blocks(n_lon: int = 4, n_lat: int = 4):
    """(bbox, row index, column index) of an n_lat × n_lon partition of the globe, north-west first."""
    for i in range(n_lat):
        for j in range(n_lon):
            lat_max = 90.0 - 180.0 * i / n_lat
            lon_min = -180.0 + 360.0 * j / n_lon
            yield (lat_max - 180.0 / n_lat, lon_min, lat_max, lon_min + 360.0 / n_lon), i, j


def ledger_records(paths: list[Path]) -> dict:
    return {p.name: record(p) for p in paths}
