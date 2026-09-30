"""Shared helpers: table loading, fetch-and-cite, air/vacuum wavelengths, binning onto the CIE grid."""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .. import cie
from ..download import fetch, record
from ..schema import BuildContext, SourceRecord

TABLES = Path(__file__).parent / "tables"
AU_KM = 149597870.7  # IAU 2012 Resolution B2 (exact definition of the astronomical unit)


def read_table_csv(name: str) -> list[dict[str, str]]:
    """Rows of a transcribed CSV table under tables/ (lines starting with '#' are the citation header)."""
    lines = [ln for ln in (TABLES / name).read_text().splitlines() if ln and not ln.startswith("#")]
    return list(csv.DictReader(io.StringIO("\n".join(lines))))


def read_table_json(name: str) -> dict:
    return json.loads((TABLES / name).read_text())


@dataclass(frozen=True)
class Download:
    """A dataset to fetch and cite. `fetch()` returns the local path; `source()` the SourceRecord for it."""
    id: str
    url: str
    subdir: str
    name: str | None
    title: str
    citation: str
    version: str | None = None
    license: str | None = None
    notes: str | None = None

    def fetch(self) -> Path:
        return fetch(self.url, self.subdir, self.name)

    def source(self) -> SourceRecord:
        rec = record(self.fetch())
        return SourceRecord(id=self.id, title=self.title, citation=self.citation, url=rec["url"],
                            retrieved=rec["retrieved"], sha256=rec["sha256"], version=self.version,
                            license=self.license, notes=self.notes)

    def register(self, ctx: BuildContext) -> str:
        return ctx.add_source(self.source())


# ---------------------------------------------------------------------------------------------- wavelengths
# The CIE tables are "lambda in standard air" (dry air, 15 degC, 101 325 Pa, 0.03 % CO2), which is exactly the
# "standard air" of Edlén (1966). Spectra given in vacuum wavelengths are converted with Edlén's dispersion
# formula for standard air (Metrologia 2, 71, Eq. 1):
#   (n_s - 1) 1e8 = 8342.13 + 2406030 / (130 - s^2) + 15997 / (38.9 - s^2),   s = 1 / lambda_vac  [um^-1]
# (s is the vacuum wavenumber; Edlén's formula is stated in terms of it).

def air_index_edlen1966(wl_vac_nm: np.ndarray) -> np.ndarray:
    s2 = (1e3 / np.asarray(wl_vac_nm, float)) ** 2
    return 1.0 + (8342.13 + 2406030.0 / (130.0 - s2) + 15997.0 / (38.9 - s2)) * 1e-8


def vacuum_to_air(wl_vac_nm: np.ndarray) -> np.ndarray:
    return np.asarray(wl_vac_nm, float) / air_index_edlen1966(wl_vac_nm)


def spectral_density_to_air(wl_vac_nm: np.ndarray, per_nm_vac: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Re-express a spectral density per nm of vacuum wavelength as a density per nm of air wavelength
    (energy conserved: E_air dλ_air = E_vac dλ_vac)."""
    wl_air = vacuum_to_air(wl_vac_nm)
    jac = np.gradient(np.asarray(wl_vac_nm, float), wl_air)  # dλ_vac / dλ_air
    return wl_air, np.asarray(per_nm_vac, float) * jac


# ---------------------------------------------------------------------------------------------- grids
GRID_EDGES = np.concatenate([cie.WAVELENGTHS - 0.5, [cie.WAVELENGTHS[-1] + 0.5]])


def bin_average(wl_nm: np.ndarray, values: np.ndarray, edges: np.ndarray = GRID_EDGES) -> np.ndarray:
    """Average of a finely sampled spectrum over each 1 nm bin [λ_i - 0.5, λ_i + 0.5] of the CIE grid, computed as
    the exact integral of the piecewise-linear interpolant divided by the bin width. NaN where the input does not
    cover the whole bin."""
    wl = np.asarray(wl_nm, float)
    v = np.asarray(values, float)
    order = np.argsort(wl)
    wl, v = wl[order], v[order]
    # cumulative trapezoid integral, then evaluate at the edges by linear interpolation of the integrand
    cum = np.concatenate([[0.0], np.cumsum(0.5 * (v[1:] + v[:-1]) * np.diff(wl))])

    def integral_at(x):
        i = np.clip(np.searchsorted(wl, x) - 1, 0, wl.size - 2)
        t = (x - wl[i])
        slope = (v[i + 1] - v[i]) / (wl[i + 1] - wl[i])
        return cum[i] + v[i] * t + 0.5 * slope * t * t

    out = (integral_at(edges[1:]) - integral_at(edges[:-1])) / np.diff(edges)
    out[(edges[:-1] < wl[0]) | (edges[1:] > wl[-1])] = np.nan
    return out
