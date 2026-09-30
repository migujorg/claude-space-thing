"""HEALPix, NESTED ordering (Górski et al. 2005, ApJ 622, 759, doi:10.1086/427976), vectorised with numpy.

Only what the sky products need: vec2pix / pix2vec for nside = 2^order. The algorithm is the reference one
(healpix_base: loc2pix / pix2loc for the nested scheme). Gaia's source_id carries the level-12 NESTED index of
the source position in ICRS (source_id >> 35), which the tests use as an independent check.
"""

from __future__ import annotations

import numpy as np

_JRLL = np.array([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4])
_JPLL = np.array([1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7])


def npix(order: int) -> int:
    return 12 * 4 ** order


def _spread(v: np.ndarray) -> np.ndarray:
    """Put the bits of v into the even bit positions (v < 2^29)."""
    v = v.astype(np.int64)
    out = np.zeros_like(v)
    for b in range(30):
        out |= ((v >> b) & 1) << (2 * b)
    return out


def _compress(v: np.ndarray) -> np.ndarray:
    v = v.astype(np.int64)
    out = np.zeros_like(v)
    for b in range(30):
        out |= ((v >> (2 * b)) & 1) << b
    return out


def vec2pix(order: int, vec: np.ndarray) -> np.ndarray:
    """NESTED pixel index of (..., 3) vectors (need not be normalised)."""
    nside = 1 << order
    v = np.asarray(vec, float)
    z = v[..., 2] / np.linalg.norm(v, axis=-1)
    phi = np.arctan2(v[..., 1], v[..., 0])
    za = np.abs(z)
    tt = np.mod(phi, 2 * np.pi) / (0.5 * np.pi)          # [0, 4)
    tt = np.where(tt >= 4.0, 0.0, tt)
    # equatorial region
    t1 = nside * (0.5 + tt)
    t2 = nside * z * 0.75
    jp = np.floor(t1 - t2).astype(np.int64)
    jm = np.floor(t1 + t2).astype(np.int64)
    ifp = jp // nside
    ifm = jm // nside
    face_eq = np.where(ifp == ifm, ifp | 4, np.where(ifp < ifm, ifp, ifm + 8))
    ix_eq = jm & (nside - 1)
    iy_eq = nside - (jp & (nside - 1)) - 1
    # polar caps
    ntt = np.minimum(3, np.floor(tt).astype(np.int64))
    tp = tt - ntt
    tmp = nside * np.sqrt(3.0 * (1.0 - za))
    jp2 = np.minimum(np.floor(tp * tmp).astype(np.int64), nside - 1)
    jm2 = np.minimum(np.floor((1.0 - tp) * tmp).astype(np.int64), nside - 1)
    north = z >= 0
    face_p = np.where(north, ntt, ntt + 8)
    ix_p = np.where(north, nside - jm2 - 1, jp2)
    iy_p = np.where(north, nside - jp2 - 1, jm2)
    eq = za <= 2.0 / 3.0
    face = np.where(eq, face_eq, face_p)
    ix = np.where(eq, ix_eq, ix_p)
    iy = np.where(eq, iy_eq, iy_p)
    return face * nside * nside + _spread(ix) + (_spread(iy) << 1)


def pix2vec(order: int, pix: np.ndarray) -> np.ndarray:
    """Unit vectors of NESTED pixel centres."""
    nside = 1 << order
    pix = np.asarray(pix, np.int64)
    face = pix // (nside * nside)
    ipf = pix % (nside * nside)
    ix = _compress(ipf)
    iy = _compress(ipf >> 1)
    jr = _JRLL[face] * nside - ix - iy - 1
    nr = np.where(jr < nside, jr, np.where(jr > 3 * nside, 4 * nside - jr, nside))
    z = np.where(jr < nside, 1.0 - nr * nr / (3.0 * nside * nside),
                 np.where(jr > 3 * nside, -1.0 + nr * nr / (3.0 * nside * nside),
                          (2 * nside - jr) * 2.0 / (3.0 * nside)))
    kshift = np.where((jr >= nside) & (jr <= 3 * nside), (jr - nside) & 1, 0)
    jp = (_JPLL[face] * nr + ix - iy + 1 + kshift) // 2
    jp = np.where(jp > 4 * nside, jp - 4 * nside, jp)
    jp = np.where(jp < 1, jp + 4 * nside, jp)
    phi = (jp - (kshift + 1) * 0.5) * (0.5 * np.pi / nr)
    s = np.sqrt(np.clip(1.0 - z * z, 0.0, None))
    return np.stack([s * np.cos(phi), s * np.sin(phi), z], axis=-1)


def pixel_radius_deg(order: int) -> float:
    """Upper bound of the angular distance from a pixel centre to any point of the pixel (degrees): measured
    over a dense sample of the sphere (used only for view culling margins)."""
    n = npix(order)
    rng = np.random.default_rng(0)
    v = rng.normal(size=(400 * n if n < 50000 else 2_000_000, 3))
    v /= np.linalg.norm(v, axis=1)[:, None]
    c = pix2vec(order, vec2pix(order, v))
    return float(np.degrees(np.arccos(np.clip((v * c).sum(1), -1, 1))).max())


def ang_to_vec(lon_deg: np.ndarray, lat_deg: np.ndarray) -> np.ndarray:
    lo, la = np.radians(lon_deg), np.radians(lat_deg)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)
