"""Writing a surface layer: tiles + tile listing + header (SurfaceLayerHeader in app/src/data/schema.ts).

A layer is registered in the manifest as three products: the header `surfaces/<id>/<layer>.json`, the tile
listing `surfaces/<id>/<layer>.sha256` (one "sha256  path" line per tile, so every tile is hash-recorded without a
manifest entry each), and an aggregate entry `surfaces/<id>/<layer>/` whose bytes are the tiles' total and whose
sha256 is the sha256 of the listing file.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
from dataclasses import dataclass, field

import numpy as np

from . import surf_tiles as st
from .output import write_bin, write_json
from .paths import OUT
from .schema import LABEL_ORDER, BuildContext

STAGE = "surfaces"


@dataclass
class Provenance:
    label: str
    sources: list[str]
    method: str
    uncertainty: str | None = None

    def to_json(self) -> dict:
        d = {"label": self.label, "sources": list(dict.fromkeys(self.sources)), "method": self.method}
        if self.uncertainty:
            d["uncertainty"] = self.uncertainty
        return d


@dataclass
class Region:
    """A lat/lon box of the layer with its own provenance (e.g. a different source for the polar caps)."""
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float
    brightness: Provenance
    color: Provenance | None = None
    note: str | None = None

    def to_json(self) -> dict:
        d = {"latMin": self.lat_min, "latMax": self.lat_max, "lonMin": self.lon_min, "lonMax": self.lon_max,
             "brightness": self.brightness.to_json()}
        if self.color:
            d["color"] = self.color.to_json()
        if self.note:
            d["note"] = self.note
        return d


def worst(*labels: str) -> str:
    return max(labels, key=LABEL_ORDER.index)


@dataclass
class LayerSpec:
    naif: int
    body: str
    layer: str                       # 'albedo' | 'height' | other
    kind: str                        # 'relative-reflectance' | 'height' | 'photometric-parameters'
    fmt: str                         # 'f16' | 'f32'
    channels: list[str]
    frame: dict
    sources: list[str]
    brightness: Provenance
    color: Provenance | None = None
    regions: list[Region] = field(default_factory=list)
    epoch: dict | None = None
    normalization: dict | None = None
    units: str | None = None
    constants: dict | None = None
    diagnostics: dict | None = None
    notes: list[str] = field(default_factory=list)
    min_level: int = 0
    nodata: str = "zero"             # 'zero' (all channels 0 = unknown) or 'nan' (NaN per channel = unknown)
    coarse: str = "any"              # rule for coarser levels (surf_tiles.COARSE_RULES)


def write_layer(ctx: BuildContext, spec: LayerSpec, top: np.ndarray, known: np.ndarray, top_level: int) -> dict:
    """Write tiles, listing and header; register the products; return the header dict."""
    cap = ctx.param("surfaces.maxLevel")
    written = top_level if cap is None else max(spec.min_level, min(top_level, cap))
    ts = st.write_pyramid(OUT, spec.naif, spec.layer, top, known, top_level, spec.fmt, min_level=spec.min_level,
                          nodata=spec.nodata, coarse=spec.coarse, max_level=written)
    listing_rel = f"surfaces/{spec.naif}/{spec.layer}.sha256"
    write_bin(ctx, listing_rel, ts.listing(), STAGE)
    ctx.products[f"surfaces/{spec.naif}/{spec.layer}/"] = {
        "path": f"surfaces/{spec.naif}/{spec.layer}/", "bytes": ts.bytes,
        "sha256": hashlib.sha256(ts.listing()).hexdigest(), "stage": STAGE, "files": len(ts.files)}
    lvl0 = spec.min_level
    kn0 = known
    for _ in range(top_level - lvl0):
        kn0 = kn0.reshape(kn0.shape[0] // 2, 2, kn0.shape[1] // 2, 2).any(axis=(1, 3))
    header = {
        "body": spec.naif,
        "bodyName": spec.body,
        "layer": spec.layer,
        "kind": spec.kind,
        "format": {"f16": "float16", "f32": "float32"}[spec.fmt],
        "channels": spec.channels,
        "bytesPerTexel": len(spec.channels) * (2 if spec.fmt == "f16" else 4),
        "tileSize": st.TILE,
        "minLevel": spec.min_level,
        "maxLevel": written,
        "levels": [{"level": L, "width": st.level_shape(L)[1], "height": st.level_shape(L)[0],
                    "tilesX": st.tiles_shape(L)[1], "tilesY": st.tiles_shape(L)[0],
                    "texelDeg": 180.0 / st.level_shape(L)[0]} for L in range(spec.min_level, written + 1)],
        "tilePath": f"surfaces/{spec.naif}/{spec.layer}/{{level}}/{{ty}}/{{tx}}.bin",
        "tileListing": listing_rel,
        "coarseLevels": st.COARSE_RULES[spec.coarse],
        "missingTiles": {str(k): v for k, v in sorted(ts.missing.items())},
        "noData": ("texels whose channels are all exactly 0 are unknown (no data); tiles listed in missingTiles are "
                   "entirely unknown and not stored") if (spec.fmt == "f16" and spec.nodata == "zero") else
                  ("NaN marks an unknown value (per channel; a texel with all channels NaN has no data at all); "
                   "tiles listed in missingTiles are entirely unknown and not stored"),
        "geometry": {"projection": "equirectangular", "latitude": "planetocentric", "longitude": "east",
                     "u": "(lonE + 180) / 360", "v": "(90 - lat) / 180",
                     "texelValue": "average over the texel's lat/lon cell"},
        "frame": spec.frame,
        "coverage": {"areaFraction": round(st.area_fraction(known, top_level), 5),
                     "diskWeightFraction": round(st.known_weight_fraction(known, top_level), 5),
                     "regions": [r.to_json() for r in spec.regions]},
        "brightness": spec.brightness.to_json(),
        "sources": list(dict.fromkeys(spec.sources)),
        "generated": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "stats": {"tiles": len(ts.files), "bytes": ts.bytes},
    }
    if written < top_level:
        header["levelCap"] = {
            "sourceMaxLevel": top_level,
            "note": f"Built with the level cap surfaces.maxLevel={cap} (build profile or --set): levels "
                    f"{written + 1}-{top_level} exist in the source but were not written. Levels "
                    f"{spec.min_level}-{written} are identical to an uncapped build's; coverage is that of the "
                    f"source level {top_level}."}
    if spec.color:
        header["color"] = spec.color.to_json()
    if spec.epoch:
        header["epoch"] = spec.epoch
    if spec.normalization:
        header["normalization"] = spec.normalization
    if spec.units:
        header["units"] = spec.units
    if spec.constants:
        header["constants"] = spec.constants
    if spec.diagnostics:
        header["diagnostics"] = spec.diagnostics
    if spec.notes:
        header["notes"] = spec.notes
    write_json(ctx, f"surfaces/{spec.naif}/{spec.layer}.json", header, STAGE)
    print(f"[surfaces] {spec.body} {spec.layer}: levels {spec.min_level}-{written}"
          f"{f' (of {top_level}: surfaces.maxLevel={cap})' if written < top_level else ''}, {len(ts.files)} tiles, "
          f"{ts.bytes / 2**20:.1f} MiB, coverage {header['coverage']['areaFraction']:.3f}")
    return header


def register_dataset(ctx: BuildContext, sid: str, title: str, citation: str, url: str, files: dict[str, dict], *,
                     version: str | None = None, license: str | None = None, notes: str = "") -> str:
    """SourceRecord for a (possibly multi-file) dataset from download-ledger entries {name: entry}."""
    from .schema import SourceRecord
    from .surf_fetch import combined_digest
    if not files:
        raise ValueError(f"{sid}: no files")
    dates = sorted(e["retrieved"] for e in files.values())
    if len(files) == 1:
        (name, e), = files.items()
        sha = e["sha256"]
        extra = f" File {name}" + (f", byte range {e['range']} of a {e.get('remoteBytes')}-byte file"
                                   if e.get("range") else "") + "."
    else:
        sha = combined_digest((n, e["sha256"]) for n, e in files.items())
        ranged = sum(1 for e in files.values() if e.get("range"))
        extra = (f" {len(files)} files ({sum(e['bytes'] for e in files.values()) / 1e9:.2f} GB downloaded"
                 + (f"; {ranged} of them byte-range reads" if ranged else "")
                 + "); sha256 above is the digest of the sorted 'sha256  name' lines, per-file hashes are in "
                   "data/raw/_downloads.json.")
    rec = SourceRecord(id=sid, title=title, citation=citation, url=url, retrieved=dates[-1], sha256=sha,
                       version=version, license=license, notes=(notes + extra).strip())
    return ctx.add_source(rec)


def ellipsoid_radius_m(naif: int, level: int) -> np.ndarray:
    """(H, W) radius in metres of the pck00011 triaxial ellipsoid at each texel centre (planetocentric lat, east
    lon): r = 1/sqrt(cos²φ cos²λ/a² + cos²φ sin²λ/b² + sin²φ/c²)."""
    from .photometry.albedo import pck_radii
    a, b, c = (1000.0 * x for x in pck_radii()[naif])
    phi = np.radians(st.lat_centers(level))[:, None]
    lam = np.radians(st.lon_centers(level))[None, :]
    return 1.0 / np.sqrt((np.cos(phi) * np.cos(lam) / a) ** 2 + (np.cos(phi) * np.sin(lam) / b) ** 2
                         + (np.sin(phi) / c) ** 2)


def pck_radii_km(naif: int) -> list[float]:
    from .photometry.albedo import pck_radii
    return list(pck_radii()[naif])


def normalize_bands(bands: list[np.ndarray], known: np.ndarray, level: int) -> list[float]:
    """Disk means ⟨A_b⟩ (cos²φ weight, known texels) of each band map at `level`."""
    return [float(st.disk_mean(b, known, level)[0]) for b in bands]


def xyzs_from_ratios(ratios: list[np.ndarray], W: np.ndarray, known: np.ndarray, out: np.ndarray) -> None:
    """out[..., c] = Σ_b W[c, b]·ratios[b] on known texels (0 elsewhere), strip by strip."""
    h = known.shape[0]
    for j0 in range(0, h, 256):
        s = slice(j0, j0 + 256)
        k = np.asarray(known[s])
        acc = np.zeros(k.shape + (W.shape[0],), np.float32)
        for b, r in enumerate(ratios):
            rb = np.asarray(r[s], np.float32)
            acc += rb[..., None] * W[:, b].astype(np.float32)[None, None, :]
        out[s] = np.where(k[..., None], acc, 0)
