"""NAIF generic kernels used by the time/ephemeris/bodies stages: URLs, downloads, SourceRecords, pool access.

Text kernels (LSK, PCK) are read through SPICE's own kernel-pool parser (spiceypy), which is the reference
implementation of the NAIF text-kernel format (\\begindata blocks, D exponents, @dates, += assignments).
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import spiceypy as sp
from spiceypy.utils.exceptions import NotFoundError

from .download import fetch, record
from .schema import BuildContext, SourceRecord

NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
LSK_URL = f"{NAIF}/lsk/naif0012.tls"
# Planetary ephemeris (NAIF spk/planets/<PLANETARY>.bsp); also the product name ephem/<PLANETARY>. DE442 exists and
# differs from DE440 by up to ~1400 km for Uranus (docs/sources/naif-de440s.md); switching means changing this name
# and the SourceRecord text in planetary(), then rerunning the build and pipeline.ephem_fixtures.
PLANETARY = "de440s"
PLANETARY_URL = f"{NAIF}/spk/planets/{PLANETARY}.bsp"
PCK_URL = f"{NAIF}/pck/pck00011.tpc"
GM_URL = f"{NAIF}/pck/gm_de440.tpc"

SRC_LSK = "naif-lsk-naif0012"
SRC_PLANETARY = f"naif-{PLANETARY}"
SRC_PCK = "naif-pck00011"
SRC_GM = "naif-gm-de440"

_NAIF_CITE = ("Acton, C. H. (1996). Ancillary data services of NASA's Navigation and Ancillary Information Facility. "
              "Planetary and Space Science 44(1), 65-70. DOI:10.1016/0032-0633(95)00107-7")
_LICENSE = "NAIF/JPL public data (U.S. Government work); see https://naif.jpl.nasa.gov/naif/rules.html"


def _rec(path: Path) -> dict:
    return record(path)


def lsk(ctx: BuildContext | None = None) -> Path:
    path = fetch(LSK_URL, "naif/lsk")
    if ctx is not None:
        r = _rec(path)
        ctx.add_source(SourceRecord(
            id=SRC_LSK,
            title="NAIF generic leapseconds kernel naif0012.tls",
            citation="NAIF leapseconds kernel naif0012.tls (NAIF/JPL, 2016-07-14), leap seconds through 2017-01-01 as "
                     "announced in IERS Bulletin C; TDB-TT formula and constants from Moyer, T. D. (1981), "
                     "Transformation from proper time on Earth to coordinate time in solar system barycentric "
                     "space-time frame of reference, Celestial Mechanics 23, 33-56 and 57-68. " + _NAIF_CITE,
            url=LSK_URL, retrieved=r["retrieved"], sha256=r["sha256"], version="naif0012", license=_LICENSE,
            notes="Still the current NAIF LSK: no leap second has been announced since 2017-01-01. A new LSK must "
                  "be adopted when IERS announces one.",
        ))
    return path


def planetary(ctx: BuildContext | None = None) -> Path:
    path = fetch(PLANETARY_URL, "naif/spk")
    if ctx is not None:
        r = _rec(path)
        ctx.add_source(SourceRecord(
            id=SRC_PLANETARY,
            title="JPL planetary and lunar ephemeris DE440 (short-span SPK de440s.bsp)",
            citation="Park, R. S., Folkner, W. M., Williams, J. G., Boggs, D. H. (2021). The JPL Planetary and Lunar "
                     "Ephemerides DE440 and DE441. The Astronomical Journal 161(3), 105. DOI:10.3847/1538-3881/abd414. "
                     "SPK file de440s.bsp distributed by NAIF. " + _NAIF_CITE,
            url=PLANETARY_URL, retrieved=r["retrieved"], sha256=r["sha256"], version="DE440 (de440s.bsp, 1849-2150)",
            license=_LICENSE,
            notes="Contains barycenters 1-9 and the Sun (10) wrt the SSB, Mercury 199 wrt 1, Venus 299 wrt 2, "
                  "Moon 301 and Earth 399 wrt the Earth-Moon barycenter 3. Planet centers 499-999 wrt their "
                  "system barycenters are NOT in this file (see jpl-horizons-center-*).",
        ))
    return path


def pck(ctx: BuildContext | None = None) -> Path:
    path = fetch(PCK_URL, "naif/pck")
    if ctx is not None:
        r = _rec(path)
        ctx.add_source(SourceRecord(
            id=SRC_PCK,
            title="NAIF generic text PCK pck00011.tpc (IAU WGCCRE rotational elements and radii)",
            citation="Archinal, B. A., Acton, C. H., A'Hearn, M. F., et al. (2018). Report of the IAU Working Group on "
                     "Cartographic Coordinates and Rotational Elements: 2015. Celestial Mechanics and Dynamical "
                     "Astronomy 130, 22. DOI:10.1007/s10569-017-9805-5; and its published correction (reference [2] in pck00011.tpc). "
                     "Earth and Moon orientation from the 2009 report: Archinal, B. A., et al. (2011), Celestial "
                     "Mechanics and Dynamical Astronomy 109, 101-135, DOI:10.1007/s10569-010-9320-4. Machine-readable form: NAIF pck00011.tpc "
                     "(N. Bachman, NAIF, 2022-12-27). " + _NAIF_CITE,
            url=PCK_URL, retrieved=r["retrieved"], sha256=r["sha256"], version="pck00011", license=_LICENSE,
            notes="NAIF cautions that the IAU_EARTH model has a prime-meridian error of at least 150 arcsec "
                  "(pck00011.tpc, 'Earth orientation'); high-precision Earth orientation needs a binary Earth PCK.",
        ))
    return path


def gm(ctx: BuildContext | None = None) -> Path:
    path = fetch(GM_URL, "naif/pck")
    if ctx is not None:
        r = _rec(path)
        ctx.add_source(SourceRecord(
            id=SRC_GM,
            title="NAIF GM kernel gm_de440.tpc (mass parameters consistent with DE440)",
            citation="gm_de440.tpc (B. Semenov, NAIF, 2022-12-14), derived from JPL Horizons gm_Horizons.pck "
                     "(J. D. Giorgini, SSD/JPL, 2022-11-28). GMs of barycenters 1-10, 199, 299, 301, 399 from DE440: "
                     "Park, R. S., et al. (2021), AJ 161, 105, DOI:10.3847/1538-3881/abd414; planet GMs 499-999 from "
                     "the JPL natural-satellite ephemeris releases (https://ssd.jpl.nasa.gov/ftp/sats/). " + _NAIF_CITE,
            url=GM_URL, retrieved=r["retrieved"], sha256=r["sha256"], version="gm_de440 (2022-12-14)",
            license=_LICENSE,
        ))
    return path


@contextmanager
def pool(*paths: Path) -> Iterator[None]:
    """Temporarily load text kernels into the SPICE kernel pool."""
    for p in paths:
        sp.furnsh(str(p))
    try:
        yield
    finally:
        for p in paths:
            sp.unload(str(p))


def gd(name: str) -> list[float] | None:
    """Numeric kernel-pool variable, or None if absent."""
    try:
        return [float(x) for x in sp.gdpool(name, 0, 10000)]
    except NotFoundError:
        return None


def gi(name: str) -> int | None:
    v = gd(name)
    return None if v is None else int(v[0])
