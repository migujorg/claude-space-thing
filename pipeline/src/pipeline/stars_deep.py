"""Deep star tiers (Gaia G up to ~14): per-star light from the bulk XP files reduced on the fly, and the tiling.

The 34.5 M Gaia DR3 XP sampled spectra (114 GB of bulk files) are streamed once and every spectrum is reduced to
a few linear functionals (`XP_OPERATOR`): CIE X, Y, Z and scotopic S through `stars_light.linear_operator` (the
same resample∘xyzs as the bright tier) plus top-hat means over the Pioneer 10/11 IPP B and R bands, which the sky
stage needs to subtract rendered stars from the Pioneer maps. Only the reductions are kept (data/cache).
"""

from __future__ import annotations

import numpy as np

from . import stars_gaia as sg
from . import stars_light as sl

# Pioneer 10/11 IPP bands as given by the map author (K. D. Gordon, Pioneer_10_11_IPP.html, data/raw/sky/pioneer_ipp):
# B: lambda = 4370 A, dlambda = 826 A; R: lambda = 6441 A, dlambda = 968 A. Used as top-hat bands (an approximation:
# the filter curves are in Gordon et al. 1998 / the IPP instrument papers, which are not retrievable here).
PIONEER_BANDS = {"B": (437.0, 82.6), "R": (644.1, 96.8)}

XP_TAG = "xyzs_pioneerBR_v1"
XP_COLUMNS = ("X", "Y", "Z", "S", "pioneerB", "pioneerR")


def xp_operator() -> tuple[np.ndarray, np.ndarray]:
    """(W, cover): W is 343 x 6 (flux in W m^-2 nm^-1 -> X,Y,Z,S in the cie units, then band means in
    W m^-2 nm^-1); `cover` marks the samples that must all be finite (360-830 nm, as `stars_light.covers_cie`)."""
    wl = sg.XP_WAVELENGTHS
    cols = [sl.linear_operator(wl)]
    for c, w in PIONEER_BANDS.values():
        cols.append(sl.band_operator(wl, c - w / 2, c + w / 2)[:, None])
    W = np.hstack(cols)
    cover = (wl >= 360.0 - 1e-9) & (wl <= 830.0 + 1e-9)
    return W, cover


def stream_deep_xp(*, workers: int = 4, log=print):
    """The deep tiers' XP reductions (cached; the stars stage fills the cache in its own pass when the build runs
    the deep tiers too, see stars_gaia.stream_xp)."""
    W, cover = xp_operator()
    return sg.stream_xp_reduced(W, cover, XP_TAG, workers=workers, log=log)
