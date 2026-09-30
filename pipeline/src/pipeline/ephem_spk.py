"""SPK type 2/3 (Chebyshev) segments: read from a DAF, restrict to a window, evaluate, fit, write.

The products in app/public/data/ephem/ keep the native SPK record layout (docs/architecture.md §6):
each record is MID, RADIUS, then the Chebyshev coefficients of X, Y, Z (type 2), or of X, Y, Z, VX,
VY, VZ (type 3). Record i of a segment covers [initEt + i*intLen, initEt + (i+1)*intLen]; which record
serves an epoch follows SPICE's SPKR02 rule, floor((et - initEt) / intLen), clamped to the last record.

Reading uses SPICE's own DAF routines (spiceypy), so byte order and summary layout are handled by the
authoritative implementation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import spiceypy as sp

from .output import write_bin, write_json
from .schema import BuildContext

J2000_FRAME_CODE = 1  # SPICE inertial frame id of J2000 (ICRF-aligned), see SPICE "Frames" required reading


@dataclass
class Segment:
    target: int
    center: int
    frame: int
    type: int
    init: float
    intlen: float
    rsize: int
    records: np.ndarray  # (n, rsize) float64
    sources: list[str] = field(default_factory=list)
    label: str | None = None
    method: str | None = None
    uncertainty: str | None = None

    @property
    def n(self) -> int:
        return int(self.records.shape[0])

    @property
    def start(self) -> float:
        return self.init

    @property
    def end(self) -> float:
        return self.init + self.n * self.intlen

    @property
    def ncoef(self) -> int:
        per = 3 if self.type == 2 else 6
        return (self.rsize - 2) // per


def read_spk(path: Path) -> list[Segment]:
    """All type 2/3 segments of an SPK file, with every record (the caller restricts them)."""
    out: list[Segment] = []
    handle = sp.dafopr(str(path))
    try:
        sp.dafbfs(handle)
        while sp.daffna():
            dc, ic = sp.dafus(sp.dafgs(), 2, 6)
            target, center, frame, typ, begin, end = (int(x) for x in ic)
            if typ not in (2, 3):
                raise ValueError(f"{path.name}: segment {target} wrt {center} has SPK type {typ}; only 2/3 supported")
            init, intlen, rsize, n = sp.dafgda(handle, end - 3, end)
            rsize, n = int(rsize), int(n)
            data = np.asarray(sp.dafgda(handle, begin, begin + rsize * n - 1), dtype=np.float64)
            out.append(Segment(target, center, frame, typ, float(init), float(intlen), rsize, data.reshape(n, rsize)))
    finally:
        sp.dafcls(handle)
    return out


def restrict(seg: Segment, t0: float, t1: float) -> Segment:
    """Keep only the records SPICE would use for any epoch in [t0, t1]."""
    i0 = max(0, int(np.floor((t0 - seg.init) / seg.intlen)))
    i1 = min(seg.n - 1, int(np.floor((t1 - seg.init) / seg.intlen)))
    if i1 < i0:
        raise ValueError(f"segment {seg.target} wrt {seg.center} does not cover [{t0}, {t1}]")
    init = seg.init + i0 * seg.intlen
    return Segment(seg.target, seg.center, seg.frame, seg.type, init, seg.intlen, seg.rsize,
                   seg.records[i0:i1 + 1].copy(), list(seg.sources), seg.label, seg.method, seg.uncertainty)


def _clenshaw(c: np.ndarray, s: np.ndarray, deriv: bool) -> tuple[np.ndarray, np.ndarray | None]:
    """Chebyshev series sum_k c[:, k] T_k(s) (and its d/ds) with the recurrence of SPICE CHBINT/CHBVAL.

    Same operation order as SPICE, so results are bit-identical to spkgeo; that matters at 30 AU, where one
    float64 ulp is ~1 mm.
    """
    s2 = 2.0 * s
    w1 = w2 = w3 = np.zeros_like(s)
    d1 = d2 = d3 = np.zeros_like(s)
    for j in range(c.shape[1] - 1, 0, -1):
        w3, w2 = w2, w1
        w1 = c[:, j] + (s2 * w2 - w3)
        if deriv:
            d3, d2 = d2, d1
            d1 = w2 * 2.0 + d2 * s2 - d3
    p = c[:, 0] + (s * w1 - w2)
    dp = (w1 + s * d1 - d2) if deriv else None
    return p, dp


def evaluate(seg: Segment, et: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
    """Position (km) and velocity (km/s) of seg.target relative to seg.center, shape (N, 3) each."""
    et = np.atleast_1d(np.asarray(et, dtype=np.float64))
    if np.any(et < seg.start) or np.any(et > seg.end):
        raise ValueError("epoch outside segment coverage")
    idx = np.minimum(np.floor((et - seg.init) / seg.intlen).astype(np.int64), seg.n - 1)
    rec = seg.records[idx]
    mid, rad = rec[:, 0], rec[:, 1]
    s = (et - mid) / rad
    nc = seg.ncoef
    pos = np.empty((et.size, 3))
    vel = np.empty((et.size, 3))
    for j in range(3):
        p, dp = _clenshaw(rec[:, 2 + j * nc: 2 + (j + 1) * nc], s, seg.type == 2)
        pos[:, j] = p
        if seg.type == 2:
            vel[:, j] = dp / rad
        else:
            vel[:, j] = _clenshaw(rec[:, 2 + (j + 3) * nc: 2 + (j + 4) * nc], s, False)[0]
    return pos, vel


def fit_type2(t: np.ndarray, xyz: np.ndarray, init: float, intlen: float, n: int, degree: int) -> np.ndarray:
    """Least-squares Chebyshev fit of positions sampled at epochs t into n type-2 records.

    Each record is fitted independently to the samples inside [start, end] (both ends included), which
    is how the record will be evaluated. Requires at least 2*(degree+1) samples per record.
    """
    ncoef = degree + 1
    rec = np.empty((n, 2 + 3 * ncoef))
    for i in range(n):
        a = init + i * intlen
        b = a + intlen
        m = (t >= a) & (t <= b)
        if m.sum() < 2 * ncoef:
            raise ValueError(f"record {i}: only {m.sum()} samples for {ncoef} coefficients")
        mid, rad = a + 0.5 * intlen, 0.5 * intlen
        V = np.polynomial.chebyshev.chebvander((t[m] - mid) / rad, degree)
        coef, *_ = np.linalg.lstsq(V, xyz[m], rcond=None)  # (ncoef, 3)
        rec[i, 0], rec[i, 1] = mid, rad
        rec[i, 2:] = coef.T.reshape(-1)
    return rec


def write_product(ctx: BuildContext, name: str, segments: list[Segment], stage: str, notes: str | None = None) -> dict:
    """Write ephem/<name>.json (EphemHeader) and ephem/<name>.bin (float64 LE records, concatenated)."""
    offset = 0
    seg_json, blobs = [], []
    for s in segments:
        if s.frame != J2000_FRAME_CODE:
            raise ValueError(f"segment {s.target} wrt {s.center} is in frame {s.frame}, expected J2000")
        if not s.sources:
            raise ValueError(f"segment {s.target} wrt {s.center} has no sources")
        d = {
            "target": s.target, "center": s.center, "frame": "J2000", "type": s.type,
            "initEt": s.init, "intLen": s.intlen, "rsize": s.rsize, "n": s.n, "offset": offset,
            "sources": list(s.sources),
        }
        for k in ("label", "method", "uncertainty"):
            if getattr(s, k) is not None:
                d[k] = getattr(s, k)
        seg_json.append(d)
        blobs.append(np.ascontiguousarray(s.records, dtype="<f8").reshape(-1))
        offset += s.records.size
    header = {"bin": f"ephem/{name}.bin", "segments": seg_json}
    if notes:
        header["notes"] = notes
    write_bin(ctx, f"ephem/{name}.bin", np.concatenate(blobs), stage)
    write_json(ctx, f"ephem/{name}.json", header, stage)
    return header


def load_product(header_path: Path) -> list[Segment]:
    """Read a product written by write_product back into Segments (used by tests and the bodies stage)."""
    import json
    header = json.loads(header_path.read_text())
    data = np.fromfile(header_path.parent.parent / header["bin"], dtype="<f8")
    out = []
    for d in header["segments"]:
        recs = data[d["offset"]: d["offset"] + d["n"] * d["rsize"]].reshape(d["n"], d["rsize"])
        out.append(Segment(d["target"], d["center"], J2000_FRAME_CODE, d["type"], d["initEt"], d["intLen"], d["rsize"],
                           recs, d["sources"], d.get("label"), d.get("method"), d.get("uncertainty")))
    return out
