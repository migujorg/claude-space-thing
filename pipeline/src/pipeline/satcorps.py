"""NASA Langley SatCORPS Global Cloud Composite (GEO-LEO global, V2): reader and reducer for the Earth's clouds.

The product (docs/sources/satcorps-gcc.md): hourly netCDF-4 files on a 1/36° latitude-longitude grid, each cell
holding the cloud retrieval of one satellite chosen by the provider (five geostationary imagers and NOAA-20
VIIRS), with its class (`cloud_phase`), visible optical depth, top height, source (`satellite_ID`), observation
time (`relative_time`) and geometry. Nothing in a file says how a cell's value was obtained, so the groups
below are decided from the class, the solar zenith angle and the viewing geometry.

What the Earth layer takes (surf_earth.build_clouds):

- **Each longitude from the hourly file nearest 13:30 local solar time** of the pinned UTC day (`strips`): 24
  strips of 15°, cut hard at multiples of 15°; the 24-hour cut is at 150° W. Only the strip's columns of nine
  variables are read, by HTTP Range requests (`RangeFile`): every byte range is a raw file with a ledger entry.
- **A class per cell** (`classify`): not observed; clear; cloud with a thickness retrieved from sunlight
  (`MEASURED`); cloud whose thickness is the provider's estimate (`ESTIMATED`: night and twilight, and the
  geometry where the provider's processing is evidently different); "possible" cloud; cloud without a value.
- **Area-overlap aggregation** to the texel grid (`aggregate`, `layers`): shares and ln τ sums per texel, never a
  value across a hole.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field
from pathlib import Path

import h5py
import numpy as np
import scipy.sparse as sp

from . import download

PRODUCT_DIR = "https://satcorps.larc.nasa.gov/prod/GCC-GEO-LEO/visst-pixel-netcdf-v2/"
FILE_NAME = "satcorps-gcc.v02.geoleo.glob-comp.{year}{doy:03d}.{hour:02d}00.3km.nc"
SUBDIR = "surfaces/earth/satcorps"
LOCAL_SOLAR_HOUR = 13.5        # the local time of the product's own polar orbiter and of the Earth's wind layer
META_BLOCK = 1 << 16           # small reads (HDF5 metadata) are fetched in aligned blocks of this size
VARIABLES = ("satellite_ID", "cloud_phase", "relative_time", "solar_zenith", "view_zenith", "relative_azimuth",
             "cloud_optical_depth", "cloud_top_height", "surface_type")

# `satellite_ID` (the file's ID_legend). A source not listed here is an input change, not a default.
GEOSTATIONARY = {52: "Meteosat-9", 53: "Meteosat-10", 190: "GOES-18", 192: "GOES-19", 287: "Himawari-9"}
POLAR = {321: "NOAA-20 VIIRS"}
# `cloud_phase` (the file's legend): 0 clear snow/ice, 1 water cloud, 2 ice cloud, 3 no cloud-property retrieval,
# 4 clear land/water, 5 bad input data, 6 possible water cloud, 7 possible ice cloud, 13 cleaned data.
PHASE_CLEAR, PHASE_CLOUD, PHASE_NO_RETRIEVAL, PHASE_POSSIBLE, PHASE_UNUSABLE = (0, 4), (1, 2), (3,), (6, 7), (5, 13)
PHASE_ICE = 2
WATER_SURFACE = 17             # `surface_type` (CERES surface types): water

# Minnis et al. (2008), Proc. SPIE 7107, §3, p. 4, and Minnis et al. (2021), IEEE TGRS 59, 2744, §III-A, p. 5:
# the solar retrieval (VISST) runs where the solar zenith angle is below 82°; otherwise thermal channels only,
# a thickness for thin cloud alone, thick cloud a default and, in V2, a k-nearest-neighbour extrapolation
# (SatCORPS GCC overview v2, slides 8-9).
DAY_SZA_DEG = 82.0
# Not documented; found in the files (docs/sources/satcorps-gcc.md, "Where the processing differs"). In the
# geostationary cells the provider's "possible" classes stop at a solar zenith angle of 75.25° on every satellite,
# and over water they all but stop within 40° of the Sun's mirror direction in the strips used here. The overview
# (slide 7) lists an extrapolation "from surrounding space/time" for "data products in the solar terminator and
# sun-glint"; no cell is flagged. A thickness in that geometry is therefore taken as the provider's estimate.
GEO_QUALIFIED_SZA_DEG = 75.25
GLINT_CONE_DEG = 40.0

# Classes of a cell.
UNOBSERVED, CLEAR, MEASURED, ESTIMATED, POSSIBLE, NO_THICKNESS = range(6)
CLASS_NAMES = {UNOBSERVED: "notObserved", CLEAR: "clear", MEASURED: "cloudMeasuredThickness",
               ESTIMATED: "cloudEstimatedThickness", POSSIBLE: "possibleCloud", NO_THICKNESS: "cloudWithoutThickness"}


# ------------------------------------------------------------------------------------------------------ strips


@dataclass(frozen=True)
class Strip:
    hour: int            # nominal UTC hour of the file
    url: str
    lon_west: float      # the strip is lon_west < λ ≤ lon_east (degrees east)
    lon_east: float


def file_url(day: str, hour: int) -> str:
    import datetime as _dt
    d = _dt.date.fromisoformat(day)
    return (f"{PRODUCT_DIR}{d.year}/{d.month:02d}/{d.day:02d}/"
            + FILE_NAME.format(year=d.year, doy=d.timetuple().tm_yday, hour=hour))


def strips(day: str) -> list[Strip]:
    """The 24 strips of a UTC day: the file of hour h serves the 15° of longitude whose local solar time at h is
    within half an hour of 13:30 (h + λ/15 = 13.5 at the strip's centre). The 24-hour step is at 150° W, between
    the strips of 23 and 00 UTC."""
    out = []
    for h in range(24):
        west = 15.0 * (LOCAL_SOLAR_HOUR - 0.5 - h)
        if west >= 180.0:
            west -= 360.0
        out.append(Strip(h, file_url(day, h), west, west + 15.0))
    return out


def columns(lon: np.ndarray, strip: Strip) -> slice:
    """The columns of a file whose cell centres lie in the strip (lon ascending)."""
    return slice(int(np.searchsorted(lon, strip.lon_west, side="right")),
                 int(np.searchsorted(lon, strip.lon_east, side="right")))


# ------------------------------------------------------------------------------------------------ range reader


class RangeFile(io.RawIOBase):
    """A remote file read through `download.fetch(byte_range=…)`: h5py opens it and reads only what a slice needs.
    A read larger than META_BLOCK (HDF5 reads each compressed chunk in one call) is fetched as exactly that
    range; smaller reads (metadata) come from aligned META_BLOCK blocks. Every range is a raw file of its own
    with a ledger entry (range, sha256, the remote file's size, ETag and Last-Modified), so a rebuild reads the
    same bytes without the network."""

    def __init__(self, url: str, subdir: str = SUBDIR):
        super().__init__()
        self.url = url
        self.subdir = f"{subdir}/{url.rstrip('/').split('/')[-1]}"
        self.paths: list[Path] = []
        self._blocks: dict[int, bytes] = {}
        self.pos = 0
        first = self._fetch(0, META_BLOCK)
        e = download.record(first)
        if not e.get("remoteBytes"):
            raise OSError(f"{url}: the server did not state the file's size")
        self.size = int(e["remoteBytes"])
        self.remote = {"bytes": self.size, "etag": e.get("etag"), "lastModified": e.get("lastModified")}

    def _fetch(self, start: int, stop: int) -> Path:
        p = download.fetch(self.url, self.subdir, f"{start:012d}-{stop:012d}.bin", byte_range=(start, stop), timeout=300.0)
        if p not in self.paths:
            self.paths.append(p)
        return p

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def _block(self, k: int) -> bytes:
        if k not in self._blocks:
            self._blocks[k] = self._fetch(k * META_BLOCK, min((k + 1) * META_BLOCK, self.size)
                                          if k else META_BLOCK).read_bytes()
        return self._blocks[k]

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        if n > META_BLOCK:
            data = self._fetch(self.pos, self.pos + n).read_bytes()
        else:
            k0, k1 = self.pos // META_BLOCK, (self.pos + n - 1) // META_BLOCK
            data = b"".join(self._block(k) for k in range(k0, k1 + 1))
            off = self.pos - k0 * META_BLOCK
            data = data[off:off + n]
        if len(data) != n:
            raise OSError(f"{self.url}: {len(data)} bytes where {n} were asked at {self.pos}")
        b[:n] = data
        self.pos += n
        return n


@dataclass
class StripData:
    strip: Strip
    lat: np.ndarray                      # cell-centre latitudes of the file, north first
    lon: np.ndarray                      # cell-centre longitudes of the strip's columns
    arrays: dict[str, np.ndarray]        # packed values, (lat, strip columns)
    attrs: dict[str, dict]               # per variable: scale, fill, valid (packed range)
    remote: dict                         # the remote file's bytes, etag, lastModified
    granules: list[str]
    reference_time: str
    version: str
    sources: str
    paths: list[Path]
    digest: str                          # sha256 of the strip's packed arrays (the content pin)
    produced: str = ""                   # the file's `processed_history`
    missing: tuple[str, ...] = ()        # variables asked for that the file does not hold
    n_lon: int = 0                       # columns of the whole file


def _text(x) -> str:
    return x.decode("utf-8", "replace") if isinstance(x, bytes) else str(x)


def read_strip(strip: Strip, pin: dict | None, subdir: str = SUBDIR, variables: tuple[str, ...] = VARIABLES) -> StripData:
    """The strip's columns of the layer variables (those of `variables` the file holds; the others are listed in
    `missing`). `pin` = {bytes, etag, lastModified, sha256}: the remote file and the decoded content this build was
    made with; a difference is an error, never a silent update. None reads unpinned (first acquisition, tests)."""
    rf = RangeFile(strip.url, subdir)
    if pin is not None:
        for k in ("bytes", "etag", "lastModified"):
            if pin.get(k) != rf.remote[k]:
                raise ValueError(f"{strip.url}: the remote file differs from its pin ({k}: {rf.remote[k]!r}, pinned "
                                 f"{pin.get(k)!r}); updating the pin is an explicit input change")
    with h5py.File(rf, "r") as f:
        lat = f["lat"][:].astype(np.float64)
        lon_all = f["lon"][:].astype(np.float64)
        if not (np.all(np.diff(lon_all) > 0) and np.all(np.diff(lat) < 0)):
            raise ValueError(f"{strip.url}: grid is not north-first, west-first")
        cols = columns(lon_all, strip)
        arrays, attrs = {}, {}
        missing = tuple(n for n in variables if n not in f)
        for n in variables:
            if n in missing:
                continue
            ds = f[n]
            arrays[n] = ds[0, :, cols]
            lo, hi = (int(v) for v in ds.attrs["valid_range"])
            attrs[n] = {"scale": float(np.ravel(ds.attrs["scale_factor"])[0]), "fill": int(np.ravel(ds.attrs["_FillValue"])[0]),
                        "valid": (lo, hi)}
        granules = [_text(g) for g in f["granule_name_list"][:]]
        ref, version, sources, produced = (_text(f.attrs.get(k, "")) for k in ("reference_time", "version", "satellite_sources",
                                                                                 "processed_history"))
    h = hashlib.sha256()
    for n in sorted(arrays):
        a = np.ascontiguousarray(arrays[n])
        h.update(f"{n}:{a.dtype.str}:{a.shape}:".encode())
        h.update(a.tobytes())
    digest = h.hexdigest()
    if pin is not None and pin.get("sha256") != digest:
        raise ValueError(f"{strip.url}: the strip's content differs from its pin (sha256 {digest}, pinned {pin.get('sha256')})")
    return StripData(strip, lat, lon_all[cols], arrays, attrs, rf.remote, granules, ref, version, sources, list(rf.paths), digest,
                     produced, missing, int(lon_all.size))


# ------------------------------------------------------------------------------------------------------ classes


def glint_angle_deg(sza_deg, vza_deg, raa_deg):
    """Angle between the view direction and the Sun's mirror direction about the local vertical, from the file's
    own angles: cos Θ = cos θ0 cos θ + sin θ0 sin θ cos φ. The file's relative azimuth φ is 0 on the forward
    (mirror) side: with this sign Θ agrees with the angle computed from the satellite's and the Sun's positions to
    0.4° rms over 7.5 million Himawari-9 cells of the 04:00 UTC file of 2026-09-28; with the other, to 72°."""
    t0, tv, ph = np.radians(sza_deg), np.radians(vza_deg), np.radians(raa_deg)
    return np.degrees(np.arccos(np.clip(np.cos(t0) * np.cos(tv) + np.sin(t0) * np.sin(tv) * np.cos(ph), -1.0, 1.0)))


def _valid(a: dict, attrs: dict, name: str) -> np.ndarray:
    v, at = a[name], attrs[name]
    return (v != at["fill"]) & (v >= at["valid"][0]) & (v <= at["valid"][1])


def _packed(limit: float, scale: float) -> int:
    """A physical limit as a packed integer (the files store angles in hundredths of a degree as float32 factors,
    so the comparison is made on the stored integers)."""
    return int(round(limit / scale))


def geometry(a: dict[str, np.ndarray], attrs: dict[str, dict]) -> dict[str, np.ndarray]:
    """The masks the groups are decided from (packed arrays in, booleans out)."""
    sid = a["satellite_ID"]
    sza = a["solar_zenith"]
    sza_ok = _valid(a, attrs, "solar_zenith")
    scale = attrs["solar_zenith"]["scale"]
    geo = np.isin(sid, list(GEOSTATIONARY))
    angles_ok = sza_ok & _valid(a, attrs, "view_zenith") & _valid(a, attrs, "relative_azimuth")
    theta = glint_angle_deg(sza * scale, a["view_zenith"] * attrs["view_zenith"]["scale"],
                            a["relative_azimuth"] * attrs["relative_azimuth"]["scale"])
    water = a["surface_type"] == WATER_SURFACE
    return {"geo": geo, "water": water, "szaKnown": sza_ok,
            "night": ~sza_ok | (sza >= _packed(DAY_SZA_DEG, scale)),
            "lowSun": geo & sza_ok & (sza >= _packed(GEO_QUALIFIED_SZA_DEG, scale)),
            "inCone": angles_ok & (theta < GLINT_CONE_DEG), "anglesKnown": angles_ok}


def classify(a: dict[str, np.ndarray], attrs: dict[str, dict], g: dict[str, np.ndarray] | None = None) -> np.ndarray:
    """Class of every cell (module constants), from the packed arrays of `VARIABLES`."""
    sid, ph = a["satellite_ID"], a["cloud_phase"]
    covered = _valid(a, attrs, "satellite_ID")
    unknown_source = covered & ~np.isin(sid, list(GEOSTATIONARY) + list(POLAR))
    if unknown_source.any():
        raise ValueError(f"satellite_ID values {np.unique(sid[unknown_source]).tolist()} are not in the product's legend "
                         "as read into this module: a new source is an input change")
    listed = PHASE_CLEAR + PHASE_CLOUD + PHASE_NO_RETRIEVAL + PHASE_POSSIBLE + PHASE_UNUSABLE
    odd = covered & (ph != attrs["cloud_phase"]["fill"]) & ~np.isin(ph, listed)
    if odd.any():
        raise ValueError(f"cloud_phase values {np.unique(ph[odd]).tolist()} have no legend: not assigned to any class")
    observed = covered & np.isin(ph, PHASE_CLEAR + PHASE_CLOUD + PHASE_NO_RETRIEVAL + PHASE_POSSIBLE)
    cls = np.full(ph.shape, UNOBSERVED, np.uint8)
    cls[observed & np.isin(ph, PHASE_CLEAR)] = CLEAR
    cls[observed & np.isin(ph, PHASE_POSSIBLE)] = POSSIBLE
    cls[observed & np.isin(ph, PHASE_NO_RETRIEVAL)] = NO_THICKNESS
    cloud = observed & np.isin(ph, PHASE_CLOUD)
    has_tau = cloud & _valid(a, attrs, "cloud_optical_depth")
    cls[cloud & ~has_tau] = NO_THICKNESS
    # Which thickness is a retrieval from sunlight, and which the provider's estimate: night and twilight (documented);
    # a geostationary cell with the Sun at 75.25° or more from the zenith, or over water within 40° of the Sun's
    # mirror direction (not documented, found in the files; a cell whose angles are missing cannot be shown to lie
    # outside the cone).
    g = g or geometry(a, attrs)
    glint = g["geo"] & g["water"] & (g["inCone"] | ~g["anglesKnown"])
    estimated = g["night"] | g["lowSun"] | glint
    cls[has_tau & ~estimated] = MEASURED
    cls[has_tau & estimated] = ESTIMATED
    return cls


# -------------------------------------------------------------------------------------------------- aggregation


@dataclass
class Mosaic:
    lat: np.ndarray          # cell centres, north first (geodetic, as the product's grid is read)
    lon: np.ndarray          # cell centres, west first
    cls: np.ndarray          # class per cell
    ln_tau: np.ndarray       # ln τ where the cell has a thickness (MEASURED, ESTIMATED), NaN elsewhere
    ice: np.ndarray          # ice phase
    top_m: np.ndarray        # cloud-top height (m) where the cell has one, NaN elsewhere
    info: dict = field(default_factory=dict)


def _centre_edges(c: np.ndarray) -> np.ndarray:
    step = (c[-1] - c[0]) / (c.size - 1)
    if not np.allclose(np.diff(c), step, rtol=0, atol=abs(step) * 1e-3):
        raise ValueError("source grid is not uniform")
    return c[0] - step / 2 + step * np.arange(c.size + 1)


SLIVER = 1e-9


def overlap(src_edges: np.ndarray, dst_edges: np.ndarray) -> sp.csr_matrix:
    """Rows: destination cells; columns: source cells; entries: the share of the destination cell's extent that
    the source cell covers (both edge arrays ascending). A row sums to 1 where the source grid covers the cell.
    Overlaps below SLIVER of the destination cell are rounding at edges that coincide, not area, and are dropped
    (they would leave a texel with a cloud share of 1e-12 that the float16 tiles round to none)."""
    lo = np.maximum(dst_edges[:-1, None], src_edges[None, :-1]) if dst_edges.size * src_edges.size < 4_000_000 else None
    rows, cols, vals = [], [], []
    if lo is not None:
        ov = np.minimum(dst_edges[1:, None], src_edges[None, 1:]) - lo
        r, c = np.nonzero(ov > SLIVER * (dst_edges[1:] - dst_edges[:-1])[:, None])
        rows, cols, vals = r, c, ov[r, c] / (dst_edges[1:] - dst_edges[:-1])[r]
    else:
        first = np.clip(np.searchsorted(src_edges, dst_edges[:-1], side="right") - 1, 0, src_edges.size - 2)
        last = np.clip(np.searchsorted(src_edges, dst_edges[1:], side="left") - 1, 0, src_edges.size - 2)
        for i in range(dst_edges.size - 1):
            k = np.arange(first[i], last[i] + 1)
            ov = np.minimum(dst_edges[i + 1], src_edges[k + 1]) - np.maximum(dst_edges[i], src_edges[k])
            keep = ov > SLIVER * (dst_edges[i + 1] - dst_edges[i])
            rows.append(np.full(int(keep.sum()), i))
            cols.append(k[keep])
            vals.append(ov[keep] / (dst_edges[i + 1] - dst_edges[i]))
        rows, cols, vals = np.concatenate(rows), np.concatenate(cols), np.concatenate(vals)
    return sp.csr_matrix((vals, (rows, cols)), shape=(dst_edges.size - 1, src_edges.size - 1))


def aggregate(m: Mosaic, lat_edges_deg: np.ndarray, lon_edges_deg: np.ndarray,
              extra: dict[str, np.ndarray] | None = None) -> dict[str, np.ndarray]:
    """Area-overlap sums of the cells onto a grid of texels (row edges north first, in the latitude of the
    product's grid; column edges west first). Every output is a share, or a sum per unit area, of the TEXEL:
    `observed` is the share of the texel that has an observation, the classes are shares of the texel, and the
    ln τ, τ, ice and top-height fields are sums over the cells of a group times their share of the texel. All are
    additive: the area-weighted mean of four texels is the value of their union. `extra` holds further per-cell
    fields to sum the same way (diagnostics)."""
    wr = overlap(np.sin(np.radians(_centre_edges(m.lat)[::-1])), np.sin(np.radians(np.asarray(lat_edges_deg, float)[::-1])))[::-1, ::-1]
    wc = overlap(_centre_edges(m.lon), np.asarray(lon_edges_deg, float))
    wr, wct = sp.csr_matrix(wr), sp.csr_matrix(wc).T.tocsr()
    dt = np.float64 if m.cls.size < 5_000_000 else np.float32

    def agg(x) -> np.ndarray:
        return np.asarray((wr @ np.asarray(x, dt)) @ wct, np.float64 if dt is np.float64 else np.float32)

    meas, est = m.cls == MEASURED, m.cls == ESTIMATED
    both = meas | est
    ln = np.where(both, m.ln_tau, 0).astype(dt)
    has_top = both & np.isfinite(m.top_m)
    out = {"observed": agg(m.cls != UNOBSERVED), "clear": agg(m.cls == CLEAR), "measured": agg(meas), "estimated": agg(est),
           "possible": agg(m.cls == POSSIBLE), "noThickness": agg(m.cls == NO_THICKNESS),
           "measuredLnTau": agg(np.where(meas, ln, 0)), "measuredLnTau2": agg(np.where(meas, ln * ln, 0)),
           "measuredTau": agg(np.where(meas, np.exp(ln), 0)), "measuredIce": agg(meas & m.ice),
           "thicknessLnTau": agg(ln), "thicknessLnTau2": agg(ln * ln), "thicknessIce": agg(both & m.ice),
           "topShare": agg(has_top), "topSum": agg(np.where(has_top, m.top_m, 0))}
    for k, v in (extra or {}).items():
        out[k] = agg(v)
    return out


def layers(a: dict[str, np.ndarray], min_observed: float = 0.5) -> dict[str, np.ndarray]:
    """The three layers' top-level arrays from `aggregate`'s sums, and the mask of known texels. A texel observed
    over less than `min_observed` of its area is unknown; otherwise every share is of the OBSERVED area (nothing
    is assumed about the part of a texel that was not observed).

      clouds            [cloud share (every cloud class and the "possible" class), mean τ and ice share of the
                         cells with a measured thickness, mean top height of the cells with a thickness]
      cloudTau          [share, Σ ln τ, Σ (ln τ)², ice share] of the cells with a measured thickness
      cloudTauEstimated the same over the cells with a measured or an estimated thickness
    """
    obs = a["observed"]
    known = obs >= min_observed
    with np.errstate(invalid="ignore", divide="ignore"):
        o = np.where(known, obs, np.nan)
        meas, thick = a["measured"], a["measured"] + a["estimated"]
        cloud = thick + a["possible"] + a["noThickness"]
        none = cloud <= 0

        def in_cloud(num, den):
            return np.where(den > 0, num / den, np.where(none, 0.0, np.nan))

        clouds = np.stack([cloud / o, in_cloud(a["measuredTau"], meas), in_cloud(a["topSum"], a["topShare"]),
                           in_cloud(a["measuredIce"], meas)], axis=-1)
        strict = np.stack([meas / o, a["measuredLnTau"] / o, a["measuredLnTau2"] / o, a["measuredIce"] / o], axis=-1)
        best = np.stack([thick / o, a["thicknessLnTau"] / o, a["thicknessLnTau2"] / o, a["thicknessIce"] / o], axis=-1)
    for x in (clouds, strict, best):
        x[~known] = np.nan
    return {"clouds": clouds.astype(np.float32), "cloudTau": strict.astype(np.float32),
            "cloudTauEstimated": best.astype(np.float32), "known": known}


# ------------------------------------------------------------------------------------------------------ mosaic

#: The remote files and the decoded strips this pipeline was built with, per UTC day and file hour:
#: {bytes, etag, lastModified} of the remote file and the sha256 of the strip's packed arrays (StripData.digest).
#: A file that changes, or a strip that decodes differently, fails the build. `python -m pipeline.satcorps pins
#: <day>` reads a day unpinned and prints this table (an explicit input update, like the other Earth pins).
PINS: dict[str, dict[int, dict]] = {
    "2026-09-28": {
        0: {"bytes": 1416742922, "etag": '"5471c80a-65cb2be2fc640"', "lastModified": "Wed, 30 Sep 2026 12:50:25 GMT",
            "sha256": "03ff65521306f2a03c3e6026af8223a133dcdb5c186996b169d9faa234a215ad"},
        1: {"bytes": 1409019843, "etag": '"53fbefc3-65cb3953d7c40"', "lastModified": "Wed, 30 Sep 2026 13:50:33 GMT",
            "sha256": "e13e37a416649438525464d65fb2aa759be90d0d0d1b5a4408ccb12a279a7e36"},
        2: {"bytes": 1407948239, "etag": '"53eb95cf-65cb46ba35980"', "lastModified": "Wed, 30 Sep 2026 14:50:30 GMT",
            "sha256": "3380b8049b3f2f2f577699638d72cb3260a00b7935a991cff3820f6104d2f94e"},
        3: {"bytes": 1409462580, "etag": '"5402b134-65cb54264c440"', "lastModified": "Wed, 30 Sep 2026 15:50:33 GMT",
            "sha256": "7f5c25d22331e8d79f2e8d50ddcd43f98da0c3409c99093df57832d675e7d080"},
        4: {"bytes": 1396230260, "etag": '"5338c874-65cb619262f00"', "lastModified": "Wed, 30 Sep 2026 16:50:36 GMT",
            "sha256": "7406123b23cd038020fbf4bb0c1a2a84ce6b754d0db7fb55e7f498031413caa6"},
        5: {"bytes": 1433491869, "etag": '"5571599d-65cb6ef4f0340"', "lastModified": "Wed, 30 Sep 2026 17:50:29 GMT",
            "sha256": "398c140870ff3d3a3915f2d2750fafc2b6601a739af39a094e3a31c147b2a517"},
        6: {"bytes": 1432145449, "etag": '"555cce29-65cb7c6012bc0"', "lastModified": "Wed, 30 Sep 2026 18:50:31 GMT",
            "sha256": "685162bdd097175241f8c12ab732a41f9777e2d27b1b85ecd1c45d9454e42384"},
        7: {"bytes": 1420829560, "etag": '"54b02378-65cb89cb35440"', "lastModified": "Wed, 30 Sep 2026 19:50:33 GMT",
            "sha256": "dbdcf2a1da428fafc38cb2dbd29b18975a81d1fcd290ec1b697dab4ccdbe18f6"},
        8: {"bytes": 1256188749, "etag": '"4adfeb4d-65cb97337b600"', "lastModified": "Wed, 30 Sep 2026 20:50:32 GMT",
            "sha256": "196b575da521be93ab09684fc47459f48a2cde3d62adc703c56cc635ca80f7b0"},
        9: {"bytes": 1413467086, "etag": '"543fcbce-65cba49acd580"', "lastModified": "Wed, 30 Sep 2026 21:50:30 GMT",
            "sha256": "0f2a24e89f0f1423d83aa7d38f141cff0dcd7f70362af642a28657079c4747a0"},
        10: {"bytes": 1413342618, "etag": '"543de59a-65cbb204fbbc0"', "lastModified": "Wed, 30 Sep 2026 22:50:31 GMT",
            "sha256": "a83c38c9118e085e6efc08b769449d5274e7e8c791e4d091081761b3ec45972a"},
        11: {"bytes": 1405354364, "etag": '"53c4017c-65cbbf6971480"', "lastModified": "Wed, 30 Sep 2026 23:50:26 GMT",
            "sha256": "35206ebdd4d2a8c09a47b8df3406736d761999c9bb7676f55f1ede49b7f936e8"},
        12: {"bytes": 1396207136, "etag": '"53386e20-65cbccd958840"', "lastModified": "Thu, 01 Oct 2026 00:50:33 GMT",
            "sha256": "811db0fd0c6f3647065c97186d41eb002c79e4eecf93030a8c04783f59c52210"},
        13: {"bytes": 1393075073, "etag": '"5308a381-65cbda3dce100"', "lastModified": "Thu, 01 Oct 2026 01:50:28 GMT",
            "sha256": "3b1c998c5ce656d0245459e3e4ce3d534ca6e327f1650fc29f5aee5eac089288"},
        14: {"bytes": 1391649246, "etag": '"52f2e1de-65cbe7a708500"', "lastModified": "Thu, 01 Oct 2026 02:50:28 GMT",
            "sha256": "91e91098dd6bfd8604e422652bc11a5664e82edc4a25fdcb1d48aa6a8d415119"},
        15: {"bytes": 1405129767, "etag": '"53c09427-65cbf5122ad80"', "lastModified": "Thu, 01 Oct 2026 03:50:30 GMT",
            "sha256": "9f013d923ee63a7d8beb4b3dfc85e4d6a429692fd42cbaf1abec344148f18b17"},
        16: {"bytes": 1397701562, "etag": '"534f3bba-65cc027888ac0"', "lastModified": "Thu, 01 Oct 2026 04:50:27 GMT",
            "sha256": "761c74eb2ec7dfb291eb085566bf55d51a65831a5be0ff1b47a0c13bb7b30845"},
        17: {"bytes": 1303273658, "etag": '"4dae60ba-65cc0fe1c2ec0"', "lastModified": "Thu, 01 Oct 2026 05:50:27 GMT",
            "sha256": "03b3e86f1a57209c465e3b01aba1f4db2ff4265079e09cd990e6a09aa3e8226f"},
        18: {"bytes": 1411424735, "etag": '"5420a1df-65cc1d4afd2c0"', "lastModified": "Thu, 01 Oct 2026 06:50:27 GMT",
            "sha256": "59cb42838a0b19d26adb1e1fe75dcf942613d743bededfb753cf04321b1e0d0d"},
        19: {"bytes": 1413140173, "etag": '"543acecd-65cc2ab24f240"', "lastModified": "Thu, 01 Oct 2026 07:50:25 GMT",
            "sha256": "8841b134e0eedd50a08dcd5348907a2272758a6e089f858e3a2fc0e8a9d3b237"},
        20: {"bytes": 1415119385, "etag": '"54590219-65cc381e65d00"', "lastModified": "Thu, 01 Oct 2026 08:50:28 GMT",
            "sha256": "e01182f8f8327dfd45da3a5837bebedca6743aaa7c9cafe8a8d9770d144fb5f1",
            "surfaceType": {"fileHourUtc": 21, "bytes": 1416354658, "etag": '"546bdb62-65cc458894340"',
                            "lastModified": "Thu, 01 Oct 2026 09:50:29 GMT",
                            "sha256": "b8ef5e376985a7f8d7f29d6b90eb12b002b9cb569aacb0e41b04a172192b04da"}},
        21: {"bytes": 1416354658, "etag": '"546bdb62-65cc458894340"', "lastModified": "Thu, 01 Oct 2026 09:50:29 GMT",
            "sha256": "46ec0ed578284cf5f5859fc09ee9747c377b25b0b4e58163d504d46a88a1d921"},
        22: {"bytes": 1419609868, "etag": '"549d870c-65cc52efe62c0"', "lastModified": "Thu, 01 Oct 2026 10:50:27 GMT",
            "sha256": "a8db527391adb026ee38b4a35c446c97b8e366b8054d422ccc8febda0ac4f3fc"},
        23: {"bytes": 1427024477, "etag": '"550eaa5d-65cc60639df80"', "lastModified": "Thu, 01 Oct 2026 11:50:38 GMT",
            "sha256": "44df75c68509fecbaff21d973601e5c1ef382034144328dc423cb557fbd90052"},
    },
}


def _count(mask: np.ndarray) -> int:
    return int(np.count_nonzero(mask))


def mosaic(day: str, pins: dict[int, dict] | None, subdir: str = SUBDIR) -> Mosaic:
    """The day's 24 strips side by side on the product's grid, classified. `info` holds what the header states:
    per strip the file, its sources with their cell counts and observation times, and the class counts; the
    evidence counts for the geometric test; the ledger entries of every byte range read."""
    lat = None
    info: dict = {"day": day, "localSolarHour": LOCAL_SOLAR_HOUR, "strips": [], "files": {}, "pins": {}}
    names = {**GEOSTATIONARY, **POLAR}
    zero = lambda: {"cells": 0, "possible": 0, "noRetrieval": 0}   # noqa: E731
    ev = {n: {"waterInsideCone": zero(), "waterOutsideCone": zero(), "lowSun": zero(), "sun60toLowSun": zero()}
          for n in GEOSTATIONARY.values()}
    for strip in strips(day):
        if pins is not None and strip.hour not in pins:
            raise ValueError(f"SatCORPS strip of {day} {strip.hour:02d} UTC has no pin")
        pin = None if pins is None else pins[strip.hour]
        d = read_strip(strip, pin, subdir)
        borrowed = None
        if d.missing:
            borrowed = _borrow_surface_type(day, strip, d, pin, subdir)
        if lat is None:
            lat = d.lat
            n_lon = d.n_lon                      # (the files' longitudes are float32: not a source for the step)
            step = 360.0 / n_lon
            lon = -180.0 + step * (np.arange(n_lon) + 0.5)
            cls = np.full((lat.size, n_lon), 255, np.uint8)
            ln_tau = np.full((lat.size, n_lon), np.nan, np.float32)
            top_m = np.full((lat.size, n_lon), np.nan, np.float32)
            ice = np.zeros((lat.size, n_lon), bool)
            info["grid"] = {"rows": int(lat.size), "columns": n_lon, "stepDeg": step, "version": d.version}
        elif not np.array_equal(lat, d.lat):
            raise ValueError(f"{strip.url}: latitude grid differs from the first strip's")
        c0 = int(round((float(d.lon[0]) + 180.0) / step - 0.5))
        cols = slice(c0, c0 + d.lon.size)
        if d.lon.size != lon[cols].size or not np.allclose(lon[cols], d.lon, atol=step * 1e-2) or (cls[:, cols] != 255).any():
            raise ValueError(f"{strip.url}: strip columns do not fit the mosaic")
        a, at = d.arrays, d.attrs
        g = geometry(a, at)
        k = classify(a, at, g)
        thick = (k == MEASURED) | (k == ESTIMATED)
        tau = a["cloud_optical_depth"].astype(np.float64) * at["cloud_optical_depth"]["scale"]
        cls[:, cols] = k
        ln_tau[:, cols] = np.where(thick, np.log(np.where(thick, tau, 1.0)), np.nan)
        ice[:, cols] = thick & (a["cloud_phase"] == PHASE_ICE)
        h_ok = thick & _valid(a, at, "cloud_top_height")
        top_m[:, cols] = np.where(h_ok, a["cloud_top_height"].astype(np.float64) * at["cloud_top_height"]["scale"] * 1000.0, np.nan)
        # what the header says about this strip
        sid, rt = a["satellite_ID"], a["relative_time"]
        rt_ok = _valid(a, at, "relative_time")
        srcs = {}
        for i, name in names.items():
            m = sid == i
            if m.any():
                t = rt[m & rt_ok]
                srcs[name] = {"cells": _count(m), "secondsFromNominal": [int(t.min()), int(t.max())] if t.size else None}
        files = {download.ledger_key(p): download.record(p) for p in d.paths + (borrowed.paths if borrowed else [])}
        info["files"].update(files)
        info["pins"][strip.hour] = {**d.remote, "sha256": d.digest}
        if borrowed:
            info["pins"][strip.hour]["surfaceType"] = {"fileHourUtc": borrowed.strip.hour, **borrowed.remote, "sha256": borrowed.digest}
        info["strips"].append({
            "fileHourUtc": strip.hour, "lonWest": strip.lon_west, "lonEast": strip.lon_east, "url": strip.url,
            "referenceTime": d.reference_time, "version": d.version, "satelliteSources": d.sources, "produced": d.produced,
            **({"surfaceTypeFrom": {
                "fileHourUtc": borrowed.strip.hour, "url": borrowed.strip.url, "sha256": borrowed.digest,
                "why": "this hour's file has no surface_type variable; the same columns of the nearest hourly file that "
                       "has one are read instead (the map is the same in the files that hold it)"}} if borrowed else {}),
            "inputGranules": len(d.granules), "remote": d.remote, "sha256": d.digest,
            "bytesRead": int(sum(e["bytes"] for e in files.values())), "rangesRead": len(files), "sources": srcs,
            "cells": {CLASS_NAMES[c]: _count(k == c) for c in CLASS_NAMES}})
        # the evidence for the geometric test, from the cells of this strip
        ph = a["cloud_phase"]
        poss, nor = np.isin(ph, PHASE_POSSIBLE), np.isin(ph, PHASE_NO_RETRIEVAL)
        sza = a["solar_zenith"]
        s60 = _packed(60.0, at["solar_zenith"]["scale"])
        for i, name in GEOSTATIONARY.items():
            m = (sid == i) & g["szaKnown"]
            for key, sel in (("waterInsideCone", m & g["water"] & ~g["lowSun"] & g["inCone"]),
                             ("waterOutsideCone", m & g["water"] & ~g["lowSun"] & g["anglesKnown"] & ~g["inCone"]),
                             ("lowSun", m & g["lowSun"] & ~g["night"]),
                             ("sun60toLowSun", m & ~g["lowSun"] & (sza >= s60))):
                e = ev[name][key]
                e["cells"] += _count(sel)
                e["possible"] += _count(sel & poss)
                e["noRetrieval"] += _count(sel & nor)
    if (cls == 255).any():
        raise ValueError("the strips do not cover every longitude")
    info["evidence"] = ev
    info["cells"] = {CLASS_NAMES[c]: _count(cls == c) for c in CLASS_NAMES}
    return Mosaic(lat=lat, lon=lon, cls=cls, ln_tau=ln_tau, ice=ice, top_m=top_m, info=info)


def _borrow_surface_type(day: str, strip: Strip, d: StripData, pin: dict | None, subdir: str) -> StripData:
    """`surface_type` (a land/water map on the product's grid; only "water" is used, for the glint test) for a strip
    whose own file lacks it: the same columns of the nearest hourly file of the day that holds it (the next hours
    first). On 2026-09-28 the 20 UTC file, of an earlier processing run, has none; over that strip's columns the
    map is identical, cell for cell, in the 04, 12, 19 and 21 UTC files (docs/sources/satcorps-gcc.md)."""
    if d.missing != ("surface_type",):
        raise ValueError(f"{strip.url}: variables {d.missing} are missing")
    spin = None if pin is None else pin.get("surfaceType")
    if pin is not None and spin is None:
        raise ValueError(f"{strip.url}: no surface_type in the file and no pin for the file it is to be read from")
    order = [spin["fileHourUtc"]] if spin else [(strip.hour + k) % 24 for k in (1, -1, 2, -2, 3, -3)]
    for hd in order:
        b = read_strip(Strip(hd, file_url(day, hd), strip.lon_west, strip.lon_east),
                       None if spin is None else {k: spin[k] for k in ("bytes", "etag", "lastModified", "sha256")},
                       subdir, variables=("surface_type",))
        if not b.missing:
            if b.arrays["surface_type"].shape != d.arrays["satellite_ID"].shape:
                raise ValueError(f"{b.strip.url}: surface_type has another shape than the strip")
            d.arrays["surface_type"], d.attrs["surface_type"] = b.arrays["surface_type"], b.attrs["surface_type"]
            return b
    raise ValueError(f"{strip.url}: no neighbouring hour's file holds surface_type")


if __name__ == "__main__":
    import json
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "pins":
        print(json.dumps({sys.argv[2]: mosaic(sys.argv[2], None).info["pins"]}, indent=1))
    else:
        raise SystemExit("usage: python -m pipeline.satcorps pins <YYYY-MM-DD>")
