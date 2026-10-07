"""SPK segments (types 2, 3, 17) and binary-PCK type 2 segments: read, restrict to a window, evaluate, write.

The products in app/public/data/ephem/ keep the native SPK record layout (docs/architecture.md §6):
- type 2/3: each record is MID, RADIUS, then the Chebyshev coefficients of X, Y, Z (type 2), or of X, Y, Z,
  VX, VY, VZ (type 3). Record i covers [initEt + i*intLen, initEt + (i+1)*intLen]; which record serves an epoch
  follows SPICE's SPKR02 rule, floor((et - initEt) / intLen), clamped to the last record.
- type 17 (precessing equinoctial conic, SPICE SPKE17/EQNCPV): one "record" of 12 doubles: EPOCH, A, H, K,
  MEAN LONGITUDE, P, Q, d(LONG. PERIAPSE)/dt, d(MEAN LONGITUDE)/dt, d(NODE)/dt, pole RA, pole DEC.
Binary PCK type 2 (SPICE PCKE02) has the type-2 layout with the three Euler angles in place of X, Y, Z.

Reading uses SPICE's own DAF routines (spiceypy), so byte order and summary layout are handled by the
authoritative implementation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import spiceypy as sp

from .output import write_bin, write_json
from .schema import BuildContext

J2000_FRAME_CODE = 1  # SPICE inertial frame id of J2000 (ICRF-aligned), see SPICE "Frames" required reading
TYPE17_RSIZE = 12


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
    # Coverage declared in the SPK segment summary. It can be narrower than the records' span (de442s: the single
    # Mercury/Venus record spans 1549-2650, the segments declare 1849-2150); SPICE refuses epochs outside it.
    declared: tuple[float, float] | None = None

    @property
    def n(self) -> int:
        return int(self.records.shape[0])

    @property
    def start(self) -> float:
        return max(self.init, self.declared[0]) if self.declared else self.init

    @property
    def end(self) -> float:
        rec_end = self.init + self.n * self.intlen
        return min(rec_end, self.declared[1]) if self.declared else rec_end

    @property
    def ncoef(self) -> int:
        per = 3 if self.type == 2 else 6
        return (self.rsize - 2) // per


def _read_daf(path: Path, ni: int, types: tuple[int, ...], targets: set[int] | None) -> list[Segment]:
    out: list[Segment] = []
    handle = sp.dafopr(str(path))
    try:
        sp.dafbfs(handle)
        while sp.daffna():
            dc, ic = sp.dafus(sp.dafgs(), 2, ni)
            ic = [int(x) for x in ic]
            if ni == 6:
                target, center, frame, typ, begin, end = ic
            else:  # binary PCK: body frame class id, reference frame, type, begin, end
                target, frame, typ, begin, end = ic
                center = 0
            if targets is not None and target not in targets:
                continue
            if typ not in types:
                raise ValueError(f"{path.name}: segment {target} (ref {center}) has type {typ}; supported {types}")
            declared = (float(dc[0]), float(dc[1]))
            if typ == 17:
                data = np.asarray(sp.dafgda(handle, begin, end), dtype=np.float64)
                if data.size != TYPE17_RSIZE:
                    raise ValueError(f"{path.name}: type 17 segment for {target} has {data.size} doubles")
                out.append(Segment(target, center, frame, typ, declared[0], declared[1] - declared[0], TYPE17_RSIZE,
                                   data.reshape(1, TYPE17_RSIZE), declared=declared))
                continue
            init, intlen, rsize, n = sp.dafgda(handle, end - 3, end)
            rsize, n = int(rsize), int(n)
            data = np.asarray(sp.dafgda(handle, begin, begin + rsize * n - 1), dtype=np.float64)
            out.append(Segment(target, center, frame, typ, float(init), float(intlen), rsize, data.reshape(n, rsize),
                               declared=declared))
    finally:
        sp.dafcls(handle)
    return out


def read_spk(path: Path, targets: set[int] | None = None) -> list[Segment]:
    """SPK segments of types 2, 3 and 17 (optionally only for `targets`), with every record."""
    return _read_daf(path, 6, (2, 3, 17), targets)


def read_pck(path: Path) -> list[Segment]:
    """Binary PCK type 2 segments. `target` is the body frame class id, `frame` the reference frame id."""
    return _read_daf(path, 5, (2,), None)


def restrict(seg: Segment, t0: float, t1: float) -> Segment:
    """Keep only the records SPICE would use for any epoch in [t0, t1] (a type 17 segment is kept whole)."""
    # 1 ms slack: jplephem excerpts declare [t0, t1] after a Julian-date round trip (off by ~2e-5 s).
    if seg.start > t0 + 1e-3 or seg.end < t1 - 1e-3:
        raise ValueError(f"segment {seg.target} wrt {seg.center} [{seg.start}, {seg.end}] does not cover [{t0}, {t1}]")
    if seg.type == 17:
        return Segment(seg.target, seg.center, seg.frame, seg.type, seg.init, seg.intlen, seg.rsize, seg.records.copy(),
                       list(seg.sources), seg.label, seg.method, seg.uncertainty, seg.declared)
    i0 = max(0, int(np.floor((t0 - seg.init) / seg.intlen)))
    i1 = min(seg.n - 1, int(np.floor((t1 - seg.init) / seg.intlen)))
    init = seg.init + i0 * seg.intlen
    return Segment(seg.target, seg.center, seg.frame, seg.type, init, seg.intlen, seg.rsize,
                   seg.records[i0:i1 + 1].copy(), list(seg.sources), seg.label, seg.method, seg.uncertainty,
                   seg.declared)


def _clenshaw(c: np.ndarray, s: np.ndarray, deriv: bool) -> tuple[np.ndarray, np.ndarray | None]:
    """Chebyshev series sum_k c[:, k] T_k(s) (and its d/ds) with the recurrence of SPICE CHBINT/CHBVAL.

    For types 2/3, this SPICE operation order is bit-identical when selecting the same record (tested at
    product starts and sampled interior epochs), including the retained source record at a trimmed final
    boundary where full-kernel spkgeo may differ by a few ulps by selecting the neighbouring polynomial.
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


def eqncpv(et: float, rec: np.ndarray) -> np.ndarray:
    """State (km, km/s) from a type 17 record, as SPICE EQNCPV: a conic in equinoctial elements whose longitude
    of periapse and node precess linearly, expressed in the frame of the given pole, rotated to J2000.

    Velocity is the exact time derivative, including the precession of (h, k) and (p, q) (verified against
    spiceypy.eqncpv in pipeline/tests/test_ephem_types.py).
    """
    epoch, a, h, k, ml0, p, q, dlpdt, dmldt, dnodedt, ra, dec = (float(x) for x in rec)
    dt = et - epoch
    lp, nd = dt * dlpdt, dt * dnodedt
    cl, sl, cn, sn = math.cos(lp), math.sin(lp), math.cos(nd), math.sin(nd)
    h1, k1 = h * cl + k * sl, k * cl - h * sl
    p1, q1 = p * cn + q * sn, q * cn - p * sn
    dh, dk, dp, dq = dlpdt * k1, -dlpdt * h1, dnodedt * q1, -dnodedt * p1
    # Reduce dt*dmldt first: it reaches ~1e5 rad, where one ulp times a is ~1 mm (SPICE agrees to <1 mm).
    ml = math.fmod(ml0 + math.fmod(dt * dmldt, 2.0 * math.pi), 2.0 * math.pi)
    # Eccentric longitude F from ml = F + h cos F - k sin F (Newton).
    f = ml
    for _ in range(100):
        g = f + h1 * math.cos(f) - k1 * math.sin(f) - ml
        df = g / (1.0 - h1 * math.sin(f) - k1 * math.cos(f))
        f -= df
        if abs(df) <= 1e-15 * max(1.0, abs(f)):
            break
    sf, cf = math.sin(f), math.cos(f)
    b = 1.0 / (1.0 + math.sqrt(1.0 - h1 * h1 - k1 * k1))
    ra_ = 1.0 - k1 * cf - h1 * sf  # r / a
    fdot = (dmldt - dh * cf + dk * sf) / ra_
    x1 = a * ((1 - b * h1 * h1) * cf + h1 * k1 * b * sf - k1)
    y1 = a * ((1 - b * k1 * k1) * sf + h1 * k1 * b * cf - h1)
    hk = dh * k1 + h1 * dk
    x1d = a * (-2 * b * h1 * dh * cf - (1 - b * h1 * h1) * sf * fdot + b * hk * sf + h1 * k1 * b * cf * fdot - dk)
    y1d = a * (-2 * b * k1 * dk * sf + (1 - b * k1 * k1) * cf * fdot + b * hk * cf - h1 * k1 * b * sf * fdot - dh)
    di = 1.0 / (1.0 + p1 * p1 + q1 * q1)
    vf = di * np.array([1 - p1 * p1 + q1 * q1, 2 * p1 * q1, -2 * p1])
    vg = di * np.array([2 * p1 * q1, 1 + p1 * p1 - q1 * q1, 2 * q1])
    vfd = di * np.array([-2 * p1 * dp + 2 * q1 * dq, 2 * (dp * q1 + p1 * dq), -2 * dp])
    vgd = di * np.array([2 * (dp * q1 + p1 * dq), 2 * p1 * dp - 2 * q1 * dq, 2 * dq])
    pos = x1 * vf + y1 * vg
    vel = x1d * vf + y1d * vg + x1 * vfd + y1 * vgd
    sa, ca, sd, cd = math.sin(ra), math.cos(ra), math.sin(dec), math.cos(dec)
    # Columns: equatorial X = z_J2000 x pole (normalised), Y = pole x X, Z = pole.
    trans = np.array([[-sa, -ca * sd, ca * cd], [ca, -sa * sd, sa * cd], [0.0, cd, sd]])
    return np.concatenate([trans @ pos, trans @ vel])


def evaluate(seg: Segment, et: np.ndarray | float) -> tuple[np.ndarray, np.ndarray]:
    """Position (km) and velocity (km/s) of seg.target relative to seg.center, shape (N, 3) each.

    For a binary PCK segment the three components are the Euler angles (rad) and their rates (rad/s).
    """
    et = np.atleast_1d(np.asarray(et, dtype=np.float64))
    if np.any(et < seg.start) or np.any(et > seg.end):
        raise ValueError("epoch outside segment coverage")
    if seg.type == 17:
        st = np.array([eqncpv(e, seg.records[0]) for e in et])
        return st[:, :3], st[:, 3:]
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
            "startEt": s.start, "endEt": s.end, "sources": list(s.sources),
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
    header = json.loads(header_path.read_text(encoding="utf-8"))
    data = np.fromfile(header_path.parent.parent / header["bin"], dtype="<f8")
    out = []
    for d in header["segments"]:
        recs = data[d["offset"]: d["offset"] + d["n"] * d["rsize"]].reshape(d["n"], d["rsize"])
        out.append(Segment(d["target"], d["center"], J2000_FRAME_CODE, d["type"], d["initEt"], d["intLen"], d["rsize"],
                           recs, d["sources"], d.get("label"), d.get("method"), d.get("uncertainty"),
                           (d["startEt"], d["endEt"]) if "startEt" in d else None))
    return out
