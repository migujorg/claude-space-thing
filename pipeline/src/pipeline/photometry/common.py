"""Shared helpers: table loading, fetch-and-cite, air/vacuum wavelengths, binning onto the CIE grid."""

from __future__ import annotations

import csv
import io
import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import requests

from .. import cie
from ..download import fetch, record, sha256_file
from ..paths import RAW
from ..schema import BuildContext, SourceRecord

TABLES = Path(__file__).parent / "tables"
AU_KM = 149597870.7  # IAU 2012 Resolution B2 (exact definition of the astronomical unit)


def read_table_csv(name: str) -> list[dict[str, str]]:
    """Rows of a transcribed CSV table under tables/ (lines starting with '#' are the citation header)."""
    lines = [ln for ln in (TABLES / name).read_text(encoding="utf-8").splitlines() if ln and not ln.startswith("#")]
    return list(csv.DictReader(io.StringIO("\n".join(lines))))


def read_table_json(name: str) -> dict:
    return json.loads((TABLES / name).read_text(encoding="utf-8"))


BROWSER_AGENT = "Mozilla/5.0"


@lru_cache(maxsize=None)
def _sha256_cached(path: str, mtime_ns: int, size: int) -> str:
    return sha256_file(Path(path))


def file_sha256(path: Path) -> str:
    st = path.stat()
    return _sha256_cached(str(path), st.st_mtime_ns, st.st_size)


def _is_pdf(path: Path) -> bool:
    with path.open("rb") as f:
        return f.read(5) == b"%PDF-"


def _validator(name: str):
    """Content checks by file type: a .pdf must be a PDF (not an HTML bot-check page served with status 200)."""
    return _is_pdf if name.lower().endswith(".pdf") else None


_FAILED: dict[str, str] = {}     # URLs that failed in this process (not retried per call)


@dataclass(frozen=True)
class Download:
    """A dataset to fetch and cite. `fetch()` returns the local path; `source()` the SourceRecord for it.

    Some publishers answer scripted clients with a bot-check page (status 200). For such documents (papers whose
    numbers are transcribed under tables/, not parsed), `sha256`/`retrieved` give the digest and date of the copy the
    transcription was made from. If the scripted download fails, a copy placed by hand at data/raw/<subdir>/<name>
    with that digest is accepted, and `source()` cites the digest (saying it was not re-downloaded).
    Offline, an absent pinned copy uses the same source record without attempting a download."""
    id: str
    url: str
    subdir: str
    name: str | None
    title: str
    citation: str
    version: str | None = None
    license: str | None = None
    notes: str | None = None
    browser_agent: bool = False     # send a browser User-Agent
    sha256: str | None = None       # digest of the hand-retrieved copy (documents behind a bot check only)
    retrieved: str | None = None    # date of that retrieval
    transcribed_only: bool = False  # document cited for existing code/table transcriptions, never parsed as input

    def _dest(self) -> Path:
        return RAW / self.subdir / (self.name or self.url.rstrip("/").split("/")[-1])

    def fetch(self) -> Path:
        dest = self._dest()
        if self.sha256 and dest.exists() and file_sha256(dest) == self.sha256:
            return dest     # the hand-retrieved copy (or an earlier scripted download of the same bytes)
        if self.sha256 and not dest.exists() and os.environ.get("PIPELINE_OFFLINE") == "1":
            # Only a pinned citation can use source()'s existing fallback. Numerical inputs remain required.
            raise RuntimeError(f"{self.id}: pinned document absent and PIPELINE_OFFLINE=1: {dest}")
        if self.url in _FAILED:
            raise RuntimeError(_FAILED[self.url])
        headers = {"User-Agent": BROWSER_AGENT} if self.browser_agent else None
        try:
            path = fetch(self.url, self.subdir, self.name, headers=headers,
                         validate=_validator(self.name or self.url), retries=2 if self.sha256 else 4)
        except (requests.RequestException, ValueError) as e:
            hint = (f" The publisher blocks scripted downloads: fetch it by hand (e.g. curl -A {BROWSER_AGENT!r} -L "
                    f"-o '{dest}' '{self.url}') and check sha256 {self.sha256}." if self.sha256 else "")
            _FAILED[self.url] = f"{self.id}: could not download {self.url}: {e}.{hint}"
            raise RuntimeError(_FAILED[self.url]) from e
        if self.sha256 and file_sha256(path) != self.sha256:
            raise ValueError(f"{self.id}: {path} does not have the expected sha256 {self.sha256}")
        return path

    def source(self) -> SourceRecord:
        try:
            path = self.fetch()
        except RuntimeError:
            if self.transcribed_only and not self.sha256:
                return SourceRecord(id=self.id, title=self.title, citation=self.citation, url=self.url,
                                    retrieved="", version=self.version, license=self.license,
                                    notes=(self.notes or "") + " (Document unavailable in this build. The pipeline "
                                    "uses its existing transcription; no retrieval date or content checksum is claimed.)")
            if not self.sha256:
                raise
            return SourceRecord(id=self.id, title=self.title, citation=self.citation, url=self.url,
                                retrieved=self.retrieved or "", sha256=self.sha256, version=self.version,
                                license=self.license,
                                notes=(self.notes or "") + " (Not re-downloaded in this build: the publisher serves "
                                "a bot check to scripted clients; sha256 is that of the copy retrieved by hand on "
                                f"{self.retrieved}.)")
        try:
            rec = record(path)
            if rec["sha256"] != file_sha256(path):
                raise KeyError(path)
        except KeyError:  # placed by hand: not in the download ledger
            rec = {"url": self.url, "retrieved": self.retrieved or "", "sha256": file_sha256(path)}
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
