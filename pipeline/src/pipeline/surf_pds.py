"""Minimal PDS3 (ODL) label reader and raw-image access for map-projected PDS products.

Only what the surface stage needs: nested OBJECT groups, scalar/quoted/sequence values with optional <UNIT>, the
^IMAGE pointer, and the IMAGE / IMAGE_MAP_PROJECTION objects. Attached labels are read from the start of the file
(up to LABEL_RECORDS × RECORD_BYTES); detached labels are separate text files.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np

from .surf_grid import EquirectGrid

_KV = re.compile(r"^\s*(\^?[A-Za-z_][A-Za-z0-9_:]*)\s*=\s*(.*)$")


def parse_odl(text: str) -> dict:
    """Parse ODL into nested dicts. OBJECT/GROUP blocks become dicts keyed by their name (lists if repeated)."""
    lines = text.replace("\r", "").split("\n")
    root: dict = {}
    stack = [root]
    i = 0
    while i < len(lines):
        raw = lines[i]
        i += 1
        line = re.sub(r"/\*.*?\*/", "", raw).strip()
        if not line:
            continue
        if line == "END":
            break
        m = _KV.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        # continuation: quoted strings and parenthesized sequences may span lines
        while (val.count('"') % 2 == 1) or (val.count("(") > val.count(")")) or (val.count("{") > val.count("}")):
            if i >= len(lines):
                break
            val += " " + re.sub(r"/\*.*?\*/", "", lines[i]).strip()
            i += 1
        if key in ("OBJECT", "GROUP"):
            d: dict = {}
            cur = stack[-1]
            name = val.strip('"')
            if name in cur:
                if not isinstance(cur[name], list):
                    cur[name] = [cur[name]]
                cur[name].append(d)
            else:
                cur[name] = d
            stack.append(d)
            continue
        if key in ("END_OBJECT", "END_GROUP"):
            if len(stack) > 1:
                stack.pop()
            continue
        stack[-1][key] = _value(val)
    return root


def _value(v: str):
    v = v.strip()
    if v.startswith('"'):
        return re.sub(r"\s+", " ", v.strip('"')).strip()
    if v.startswith("(") or v.startswith("{"):
        inner = v[1:-1]
        parts = [p.strip() for p in re.findall(r'"[^"]*"|[^,]+', inner)]
        return [_value(p) for p in parts if p]
    m = re.match(r"^([-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)\s*(<[^>]*>)?$", v)
    if m:
        num = m.group(1)
        return float(num) if any(c in num for c in ".eE") else int(num)
    m = re.match(r"^(\d+)#([0-9A-Fa-f]+)#$", v)
    if m:
        return int(m.group(2), int(m.group(1)))
    return v.strip("'")


def find(label: dict, key: str):
    """First value stored under `key` anywhere in the nested label (depth first)."""
    if key in label:
        return label[key]
    for v in label.values():
        for d in (v if isinstance(v, list) else [v]):
            if isinstance(d, dict):
                r = find(d, key)
                if r is not None:
                    return r
    return None


def num(d: dict, key: str) -> float:
    v = d[key]
    if isinstance(v, str):
        v = float(re.match(r"[-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?", v).group(0))
    return float(v)


def read_attached_label(path: Path, max_bytes: int = 1 << 20) -> dict:
    with path.open("rb") as f:
        head = f.read(max_bytes)
    text = head.split(b"\nEND\r\n")[0].split(b"\nEND\n")[0].decode("latin-1")
    return parse_odl(text + "\nEND\n")


def image_offset(label: dict, attached: bool = True) -> int:
    """Byte offset of the IMAGE object: ^IMAGE = n (record number, 1-based) or ("file", n) or n <BYTES>."""
    ptr = label.get("^IMAGE")
    rb = int(label.get("RECORD_BYTES", 0))
    if isinstance(ptr, list):
        ptr = ptr[-1]
    if isinstance(ptr, str):
        m = re.match(r"(\d+)\s*<BYTES>", ptr)
        if m:
            return int(m.group(1)) - 1
        return 0  # detached file pointer without offset: data start at byte 0
    return (int(ptr) - 1) * rb


def equirect_grid(label: dict) -> EquirectGrid:
    """EquirectGrid from IMAGE_MAP_PROJECTION with the PDS3 convention (also stated in the LROC labels): the
    centre of the upper-left pixel is (line, sample) = (1, 1) and LINE/SAMPLE_PROJECTION_OFFSET are the offsets
    from that centre to the projection origin, positive when the origin is below/right of it. So the centre of
    0-based line l is at lat = (L0 − l)/res and of sample s at lon = CENTER_LONGITUDE + (s − S0)/(res·cos φ0), φ0 =
    CENTER_LATITUDE (the standard parallel)."""
    img = find(label, "IMAGE")
    mp = find(label, "IMAGE_MAP_PROJECTION")
    ptype = str(mp["MAP_PROJECTION_TYPE"]).upper()
    if ptype not in ("EQUIRECTANGULAR", "SIMPLE CYLINDRICAL", "SIMPLE_CYLINDRICAL"):
        raise ValueError(f"not equirectangular: {ptype}")
    clat = num(mp, "CENTER_LATITUDE")
    res = num(mp, "MAP_RESOLUTION")
    l0 = num(mp, "LINE_PROJECTION_OFFSET")
    s0 = num(mp, "SAMPLE_PROJECTION_OFFSET")
    clon = num(mp, "CENTER_LONGITUDE")
    if str(mp.get("POSITIVE_LONGITUDE_DIRECTION", "EAST")).upper() != "EAST":
        raise ValueError("west-positive longitudes not supported here")
    # x = R (λ − λ0) cos φ0, y = R φ: with a standard parallel φ0 ≠ 0 the longitude spacing is 1/(res cos φ0)
    dlon = 1.0 / (res * np.cos(np.radians(clat)))
    return EquirectGrid(lat0=l0 / res, lon0=clon - s0 * dlon, dlat=1.0 / res, dlon=dlon,
                        lines=int(img["LINES"]), samples=int(img["LINE_SAMPLES"]))


def polar_stereo_pixel(label: dict, lat_deg: np.ndarray, lon_deg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """0-based (line, sample) of planetocentric (lat, east lon) in a spherical polar stereographic image
    (LROC RDR SIS Appendix B): north x = 2R tan(π/4 − φ/2) sin(λ − λP), y = −2R tan(π/4 − φ/2) cos(λ − λP);
    south x = 2R tan(π/4 + φ/2) sin(λ − λP), y = 2R tan(π/4 + φ/2) cos(λ − λP); line = L0 − y/scale,
    sample = S0 + x/scale (same offset convention as `equirect_grid`)."""
    mp = find(label, "IMAGE_MAP_PROJECTION")
    if "POLAR" not in str(mp["MAP_PROJECTION_TYPE"]).upper():
        raise ValueError("not polar stereographic")
    r = num(mp, "A_AXIS_RADIUS") * 1000.0
    if abs(num(mp, "C_AXIS_RADIUS") * 1000.0 - r) > 1e-6:
        raise ValueError("ellipsoidal polar stereographic not supported")
    scale = num(mp, "MAP_SCALE")
    lat0, lonp = num(mp, "CENTER_LATITUDE"), num(mp, "CENTER_LONGITUDE")
    phi, dl = np.radians(lat_deg), np.radians(np.asarray(lon_deg) - lonp)
    if lat0 > 0:
        rho = 2 * r * np.tan(np.pi / 4 - phi / 2)
        x, y = rho * np.sin(dl), -rho * np.cos(dl)
    else:
        rho = 2 * r * np.tan(np.pi / 4 + phi / 2)
        x, y = rho * np.sin(dl), rho * np.cos(dl)
    return num(mp, "LINE_PROJECTION_OFFSET") - y / scale, num(mp, "SAMPLE_PROJECTION_OFFSET") + x / scale


_DTYPES = {("PC_REAL", 32): "<f4", ("IEEE_REAL", 32): ">f4", ("LSB_INTEGER", 16): "<i2", ("MSB_INTEGER", 16): ">i2",
           ("PC_REAL", 64): "<f8", ("UNSIGNED_INTEGER", 8): "u1", ("MSB_UNSIGNED_INTEGER", 8): "u1",
           ("LSB_UNSIGNED_INTEGER", 16): "<u2", ("MSB_UNSIGNED_INTEGER", 16): ">u2"}


def image_dtype(label: dict) -> np.dtype:
    img = find(label, "IMAGE")
    return np.dtype(_DTYPES[(str(img["SAMPLE_TYPE"]).upper(), int(img["SAMPLE_BITS"]))])


def read_band(path: Path, label: dict, band: int = 0, offset: int | None = None) -> np.ndarray:
    """Memory-map one band (0-based) of a band-sequential IMAGE."""
    img = find(label, "IMAGE")
    lines, samples = int(img["LINES"]), int(img["LINE_SAMPLES"])
    bands = int(img.get("BANDS", 1))
    if bands > 1 and str(img.get("BAND_STORAGE_TYPE", "BAND_SEQUENTIAL")).upper() != "BAND_SEQUENTIAL":
        raise ValueError("only band-sequential storage is supported")
    dt = image_dtype(label)
    off = image_offset(label) if offset is None else offset
    off += band * lines * samples * dt.itemsize
    return np.memmap(path, dtype=dt, mode="r", offset=off, shape=(lines, samples))


def isis_special_mask(a: np.ndarray) -> np.ndarray:
    """True where a float32 value is one of the ISIS/PDS special pixel constants (NULL, LRS, LIS, HIS, HRS:
    0xFF7FFFFB..0xFF7FFFFF, i.e. ≈ −3.4028e38) or not finite."""
    return ~np.isfinite(a) | (a < -3.0e38)
