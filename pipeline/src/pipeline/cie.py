"""CIE observers on the common 1 nm grid, and spectrum -> (X, Y, Z, scotopic) integration.

Every stage that turns a spectrum into something the renderer can show goes through this module, so
all colors in the app share one set of observer tables (docs/architecture.md §4.2).

The tables are the CIE's own machine-readable datasets (CIE 018:2019 data tables, DOIs 10.25039/CIE.DS.*),
downloaded through `download.fetch` and checked against the sha256 checksums and column-sum validations
the CIE publishes in the datasets' `_metadata.json` files. See docs/sources/cie.md.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from .schema import BuildContext, SourceRecord

WAVELENGTHS = np.arange(360.0, 831.0, 1.0)  # nm, in standard air (the CIE tables are "lambda in standard air")
# Maximum luminous efficacies. These two numbers are given in the text of CIE 018:2019 (DOI
# 10.25039/TR.018.2019) and CIE 015:2018, not in the CSV data tables; they follow from the SI definition of the
# candela (K_cd = 683 lm/W at 540e12 Hz) evaluated at the peaks of V(λ) and V'(λ).
KM_PHOTOPIC = 683.002   # lm/W
KM_SCOTOPIC = 1700.06   # lm/W

SOURCE_CMF = "cie-1931-2deg-cmf"
SOURCE_SCOTOPIC = "cie-1951-scotopic"

_BASE = "https://files.cie.co.at/Publications-datasets/"
_DATASETS = {
    SOURCE_CMF: {
        "file": "CIE_xyz_1931_2deg.csv",
        "doi": "10.25039/CIE.DS.xvudnb9b",
        "title": "CIE 1931 colour-matching functions, 2 degree observer (x̄, ȳ, z̄), 360–830 nm, 1 nm",
        "landing": "https://cie.co.at/datatable/cie-1931-colour-matching-functions-2-degree-observer",
        "citation": "CIE (2019). Colour-matching functions of CIE 1931 standard colorimetric observer. International "
                    "Commission on Illumination (CIE), Vienna. Data table, DOI:10.25039/CIE.DS.xvudnb9b. Original "
                    "source: CIE 018:2019 The Basis of Physical Photometry, 3rd ed., Table 6 "
                    "(DOI:10.25039/TR.018.2019); standard: ISO/CIE 11664-1:2019.",
        "ncols": 3,
    },
    SOURCE_SCOTOPIC: {
        "file": "CIE_sle_scotopic.csv",
        "doi": "10.25039/CIE.DS.gr6w4b5g",
        "title": "CIE spectral luminous efficiency for scotopic vision V′(λ), 380–780 nm, 1 nm",
        "landing": "https://cie.co.at/datatable/cie-spectral-luminous-efficiency-scotopic-vision",
        "citation": "CIE (2019). CIE spectral luminous efficiency for scotopic vision. International Commission on "
                    "Illumination (CIE), Vienna. Data table, DOI:10.25039/CIE.DS.gr6w4b5g. Original source: CIE "
                    "018:2019 The Basis of Physical Photometry, 3rd ed., Table 2 (DOI:10.25039/TR.018.2019).",
        "ncols": 1,
    },
}


def _fetch(source_id: str) -> tuple[Path, Path]:
    from .download import fetch
    ds = _DATASETS[source_id]
    csv = fetch(_BASE + ds["file"], "cie")
    meta = fetch(_BASE + ds["file"] + "_metadata.json", "cie")
    return csv, meta


def _validate(csv: Path, meta_path: Path, data: np.ndarray) -> None:
    """Check the file against the checksum and column sums the CIE publishes with it."""
    from .download import sha256_file
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    sums = [c for c in meta.get("checksums", []) if c.get("hashMethod") == "sha256"]
    if sums and sums[0]["checksum"] != sha256_file(csv):
        raise ValueError(f"{csv.name}: sha256 does not match the CIE metadata")
    for v in meta.get("datatableInfo", {}).get("validations", []):
        if v["validationType"] == "sumOfColumns":
            want = np.array(json.loads(v["validationValue"]), dtype=float)
            got = data.sum(axis=0)
            if not np.allclose(got, want, rtol=1e-12, atol=1e-9):
                raise ValueError(f"{csv.name}: column sums {got} != CIE validation {want}")


def _load(source_id: str) -> np.ndarray:
    csv, meta = _fetch(source_id)
    data = np.loadtxt(csv, delimiter=",")
    if data.ndim != 2 or data.shape[1] != 1 + _DATASETS[source_id]["ncols"]:
        raise ValueError(f"unexpected table shape {data.shape} in {csv.name}")
    _validate(csv, meta, data)
    return data


def _on_grid(data: np.ndarray) -> np.ndarray:
    """Place a 1 nm table on WAVELENGTHS. Outside the table's range the CIE metadata specifies
    extrapolationMethod = "zero"; inside, the table is already on the grid (no interpolation)."""
    wl = data[:, 0]
    if not np.allclose(np.diff(wl), 1.0) or wl[0] % 1 or wl[0] < WAVELENGTHS[0] or wl[-1] > WAVELENGTHS[-1]:
        raise ValueError("CIE table is not a 1 nm table inside 360–830 nm")
    out = np.zeros((WAVELENGTHS.size, data.shape[1] - 1))
    i0 = int(wl[0] - WAVELENGTHS[0])
    out[i0:i0 + wl.size] = data[:, 1:]
    return out


@lru_cache(maxsize=1)
def cmfs() -> np.ndarray:
    """(N, 3) array of x̄, ȳ, z̄ on WAVELENGTHS (official CIE data table)."""
    return _on_grid(_load(SOURCE_CMF))


@lru_cache(maxsize=1)
def scotopic() -> np.ndarray:
    """(N,) array of V′(λ) on WAVELENGTHS (official CIE data table; zero outside 380–780 nm per CIE metadata)."""
    return _on_grid(_load(SOURCE_SCOTOPIC))[:, 0]


def resample(wl_nm: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Linear interpolation onto WAVELENGTHS. Outside the input range the result is NaN (caller decides)."""
    out = np.interp(WAVELENGTHS, wl_nm, values, left=np.nan, right=np.nan)
    return out


def xyzs(spectrum_on_grid: np.ndarray) -> np.ndarray:
    """Integrate a spectral quantity (per nm, on WAVELENGTHS) against the observers.

    For spectral irradiance in W m^-2 nm^-1 the result is (X, Y, Z, S) with Y = illuminance in lux and
    S = scotopic illuminance in scotopic lux. Same for radiance -> cd/m^2.
    """
    if np.isnan(spectrum_on_grid).any():
        raise ValueError("spectrum does not cover 360–830 nm; extend or document a cutoff explicitly")
    dl = 1.0
    xyz = KM_PHOTOPIC * (spectrum_on_grid[:, None] * cmfs()).sum(axis=0) * dl
    s = KM_SCOTOPIC * (spectrum_on_grid * scotopic()).sum() * dl
    return np.array([xyz[0], xyz[1], xyz[2], s])


def register_sources(ctx: BuildContext) -> list[str]:
    from .download import record
    ids = []
    for sid, ds in _DATASETS.items():
        csv, meta = _fetch(sid)
        rec, mrec = record(csv), record(meta)
        ctx.add_source(SourceRecord(
            id=sid,
            title=ds["title"],
            citation=ds["citation"],
            url=rec["url"],
            retrieved=rec["retrieved"],
            sha256=rec["sha256"],
            version="CIE 018:2019 data table (2019)",
            license="CC BY-SA 4.0",
            notes=f"Dataset DOI {ds['doi']}; landing page {ds['landing']}. The file's sha256 and column sums were "
                  f"verified against the CIE metadata file {mrec['url']} (sha256 {mrec['sha256']}). "
                  "K_m = 683.002 lm/W and K'_m = 1700.06 lm/W are taken from the text of CIE 018:2019.",
        ))
        ids.append(sid)
    return ids
