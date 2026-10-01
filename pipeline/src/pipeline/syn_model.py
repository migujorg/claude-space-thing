"""Synthetic small-body populations: fill what the surveys could not yet detect (M6, NORTH_STAR 3.3).

Algorithm (docs/reports/synthetic-populations.md has the full description and the numbers):

  cells     Each population has a fixed grid of cells (a, e, i, H): a-bin edges, e and i bin widths, H bins of
            H_BIN mag aligned on multiples of H_BIN. The grid does not depend on the catalogue.
  limit     H_lim per a-bin, the magnitude down to which the catalogue is complete there:
              - catalogue-extrapolated populations (main belt, Hungarias, Hildas, Jupiter Trojans): the Hendler &
                Malhotra (2020) model H_lim(a) = -5 log10(a (a - 1)) + C, C refitted to the current catalogue on
                every build (fit_hlim);
              - model-realization populations (NEOs, Kuiper belt): the lower edge of the first H bin (bright to faint)
                whose known count is significantly (2 sigma, Poisson) below the model's count (realization_limit).
            No synthetic object is ever brighter than the H_lim of its a-bin.
  model     Expected number of objects per cell at H >= H_lim:
              - extrapolated: f(e, i | a) N(a, H), where N(a, H) continues the catalogue's own counts in the complete
                reference bin [H_lim - 1, H_lim - 0.5) with the published debiased slope dN/dH ~ 10^(alpha H) (and,
                brighter than a published slope break, the catalogue's own slope measured just above H_lim), and
                f(e, i | a) is the orbit distribution of the complete (H < H_lim) catalogue in that a-bin;
              - realization: the number of model objects in the cell.
  deficit   raw = max(0, model - known) per cell; the (a-bin, H-bin) group's total is max(0, sum model - sum known)
            and is shared among its cells in proportion to raw (removes the upward bias of clipping small Poisson
            counts cell by cell; deficit <= raw always).
  stream    Every cell has its own random stream, seeded from sha256(ALGORITHM | seed | population model | cell
            indices) (PCG64, uniform doubles only), independent of the catalogue. Extrapolated populations draw an
            ordered list of candidates (a, e, i uniform in the cell, H from the slope law within the H bin, angles,
            attribute quantiles); realization populations order the model objects in the cell by random keys.
  yield     The cell shows the first floor(deficit + u0) candidates (u0 from the cell's seed: unbiased rounding) that
            pass the cell's current limits (H >= H_lim, perihelion rule). When the catalogue grows, the known count
            rises, the deficit falls and the list is truncated from the end: the same objects remain, in the same
            places, minus the last ones. Rerunning with the same (algorithm, seed, model files, catalogue snapshot)
            gives byte-identical products.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field

import numpy as np

ALGORITHM = "synthetic-v1"
H_BIN = 0.5
LN10 = math.log(10.0)
_IH0 = -40          # H bins from -20 mag
_NH = 160           # ... to +60 mag
ROW = 10            # uniforms per candidate (extrapolated populations)


# ---------------------------------------------------------------------------------------------- grid
@dataclass(frozen=True)
class Grid:
    a_edges: tuple[float, ...]
    e_width: float
    i_width: float          # deg
    n_e: int
    n_i: int
    h_width: float = H_BIN

    @property
    def n_a(self) -> int:
        return len(self.a_edges) - 1

    def a_bounds(self, ia):
        ed = np.asarray(self.a_edges)
        return ed[ia], ed[np.asarray(ia) + 1]

    def index(self, a, e, i, H):
        """(ia, ie, ii, ih) per object; ia = -1 outside the grid (a, e or i out of range, H not finite)."""
        a, e, i, H = (np.asarray(x, dtype=np.float64) for x in (a, e, i, H))
        ed = np.asarray(self.a_edges)
        ia = np.searchsorted(ed, a, side="right") - 1
        ie = np.floor(e / self.e_width).astype(np.int64)
        ii = np.floor(i / self.i_width).astype(np.int64)
        with np.errstate(invalid="ignore"):
            ih = np.floor(np.where(np.isfinite(H), H, 0.0) / self.h_width).astype(np.int64)
        bad = ((ia < 0) | (ia >= self.n_a) | (ie < 0) | (ie >= self.n_e) | (ii < 0) | (ii >= self.n_i)
               | ~np.isfinite(H) | ~np.isfinite(a) | (ih < _IH0) | (ih >= _IH0 + _NH))
        ia = np.where(bad, -1, ia)
        return ia, ie, ii, ih

    def key(self, ia, ie, ii, ih):
        return (((np.asarray(ia, np.int64) * self.n_e + ie) * self.n_i + ii) * _NH + (np.asarray(ih) - _IH0))

    def unkey(self, key):
        key = np.asarray(key, np.int64)
        ih = key % _NH + _IH0
        r = key // _NH
        ii = r % self.n_i
        r //= self.n_i
        return r // self.n_e, r % self.n_e, ii, ih

    def to_json(self) -> dict:
        return {"aEdgesAu": list(self.a_edges), "eWidth": self.e_width, "iWidthDeg": self.i_width, "nE": self.n_e,
                "nI": self.n_i, "hWidthMag": self.h_width, "hAlignment": "H bins [k w, (k+1) w)"}


def uniform_edges(lo: float, hi: float, step: float) -> tuple[float, ...]:
    n = int(round((hi - lo) / step))
    return tuple(round(lo + k * step, 10) for k in range(n + 1))


# ---------------------------------------------------------------------------------------------- seeds
def cell_seed(prefix: str, ia: int, ie: int, ii: int, ih: int) -> tuple[int, float]:
    """(PCG64 seed, u0 in [0, 1)) of one cell: sha256 of '<prefix>|ia|ie|ii|ih' (seed) and of the same + '|round'."""
    s = f"{prefix}|{ia}|{ie}|{ii}|{ih}"
    seed = int.from_bytes(hashlib.sha256(s.encode()).digest()[:16], "little")
    u0 = int.from_bytes(hashlib.sha256((s + "|round").encode()).digest()[:8], "little") / 2.0 ** 64
    return seed, u0


def stream(seed: int, salt: int = 0) -> np.random.Generator:
    return np.random.Generator(np.random.PCG64([seed & (2 ** 64 - 1), seed >> 64, salt]))


# ---------------------------------------------------------------------------------------------- completeness
def fit_hlim(a: np.ndarray, H: np.ndarray, lo: float, hi: float, *, da: float = 0.01, dh: float = 0.25,
             min_n: int = 50) -> dict:
    """Hendler & Malhotra (2020) completion limit: per a-bin of width da in [lo, hi) the centre of the most populated
    H bin (width dh, bins [k dh, (k+1) dh)) is H_lim; its uncertainty (Hmax - Hmin)/sqrt(n); then the weighted
    least-squares (maximum-likelihood for Gaussian errors) value of C in H_lim = -5 log10(a (a - 1)) + C."""
    bins = []
    nb = int(round((hi - lo) / da))
    for k in range(nb):
        a0, a1 = lo + k * da, lo + (k + 1) * da
        m = (a >= a0) & (a < a1) & np.isfinite(H)
        n = int(m.sum())
        if n < min_n:
            continue
        h = H[m]
        idx = np.floor(h / dh).astype(np.int64)
        lo_i = idx.min()
        cnt = np.bincount(idx - lo_i)
        j = int(np.argmax(cnt))
        hl = (lo_i + j + 0.5) * dh
        ac = 0.5 * (a0 + a1)
        sig = (float(h.max()) - float(h.min())) / math.sqrt(n)
        bins.append((ac, hl, sig, n))
    if not bins:
        raise ValueError(f"fit_hlim: no a-bin in [{lo}, {hi}) has {min_n} objects")
    b = np.array(bins)
    ck = b[:, 1] + 5.0 * np.log10(b[:, 0] * (b[:, 0] - 1.0))
    w = 1.0 / b[:, 2] ** 2
    C = float(np.sum(w * ck) / np.sum(w))
    return {"C": C, "CSigma": float(1.0 / math.sqrt(np.sum(w))), "aRangeAu": [lo, hi], "aBinAu": da, "hBinMag": dh,
            "minPerBin": min_n, "bins": len(bins), "objects": int(b[:, 3].sum()),
            "residualRmsMag": float(np.sqrt(np.mean((ck - C) ** 2))),
            "perBin": [[round(x, 4), round(y, 3), round(s, 4), int(n)] for x, y, s, n in bins]}


def hlim_model(a, C: float):
    a = np.asarray(a, dtype=np.float64)
    return -5.0 * np.log10(a * (a - 1.0)) + C


# ---------------------------------------------------------------------------------------------- slope laws
@dataclass
class SlopeLaw:
    """dN/dH ~ 10^(alpha H): alpha_faint at H >= h_break; at H < h_break alpha_bright[ia] (per a-bin; the catalogue's
    own slope where a published faint-end slope does not apply)."""
    alpha_faint: float
    h_break: float = -math.inf
    alpha_bright: np.ndarray | None = None

    def alpha(self, h, ia):
        h = np.asarray(h, dtype=np.float64)
        if self.alpha_bright is None or not np.isfinite(self.h_break):
            return np.full(np.broadcast(h, ia).shape, self.alpha_faint)
        return np.where(h >= self.h_break, self.alpha_faint, self.alpha_bright[np.asarray(ia)])

    def log_rel(self, h, h_ref, ia) -> float:
        """log10 of dens(h)/dens(h_ref) (piecewise-linear integral of alpha)."""
        hb = self.h_break
        ab = self.alpha_faint if self.alpha_bright is None else float(self.alpha_bright[ia])
        g = lambda x: (ab * (min(x, hb) - hb) + self.alpha_faint * (max(x, hb) - hb)) if np.isfinite(hb) else self.alpha_faint * x
        return g(h) - g(h_ref)

    def integral(self, h1: float, h2: float, h_ref: float, ia: int) -> float:
        """int_{h1}^{h2} 10^(log_rel(h)) dh (h1 <= h2)."""
        if h2 <= h1:
            return 0.0
        pts = [h1, h2]
        if np.isfinite(self.h_break) and h1 < self.h_break < h2:
            pts = [h1, self.h_break, h2]
        tot = 0.0
        for x1, x2 in zip(pts[:-1], pts[1:]):
            al = float(self.alpha(0.5 * (x1 + x2), ia))
            k = al * LN10
            tot += 10.0 ** self.log_rel(x1, h_ref, ia) * (math.expm1(k * (x2 - x1)) / k if k != 0 else x2 - x1)
        return tot


def local_slopes(ia: np.ndarray, H: np.ndarray, hlim_bins: np.ndarray, n_a: int, *, pool: int = 2,
                 fallback: float) -> tuple[np.ndarray, dict]:
    """Catalogue slope per a-bin just above completeness: log-counts in the 0.5-mag bins [H_lim-2, H_lim-0.5)
    (relative to each object's own a-bin H_lim), pooled over +/- `pool` a-bins, weighted least squares."""
    x = H - hlim_bins[ia]
    kb = np.floor((x + 2.0) / 0.5).astype(np.int64)
    ok = (kb >= 0) & (kb < 3)
    cnt = np.zeros((n_a, 3))
    np.add.at(cnt, (ia[ok], kb[ok]), 1)
    out = np.full(n_a, fallback)
    used = np.zeros(n_a, dtype=bool)
    xc = np.array([-1.75, -1.25, -0.75])
    for k in range(n_a):
        c = cnt[max(0, k - pool):k + pool + 1].sum(axis=0)
        if c.min() < 20:
            continue
        y = np.log10(c)
        w = c                       # var(log10 n) ~ 1/n
        A = np.vstack([xc, np.ones(3)]).T * np.sqrt(w)[:, None]
        out[k] = np.linalg.lstsq(A, y * np.sqrt(w), rcond=None)[0][0]
        used[k] = True
    return out, {"window": "[H_lim - 2, H_lim - 0.5) in 0.5-mag bins", "poolABins": pool,
                 "fitted": int(used.sum()), "fallbackBins": int((~used).sum()), "fallback": fallback}


# ---------------------------------------------------------------------------------------------- cells
@dataclass
class Cells:
    """Per-cell table of one population (arrays of equal length)."""
    ia: np.ndarray
    ie: np.ndarray
    ii: np.ndarray
    ih: np.ndarray
    h_lo: np.ndarray        # H range of the cell that is conditioned: [max(bin lo, H_lim), min(bin hi, floor))
    h_hi: np.ndarray
    n_model: np.ndarray
    n_obs: np.ndarray
    raw: np.ndarray = field(default=None)
    deficit: np.ndarray = field(default=None)
    u0: np.ndarray = field(default=None)
    n_shown: np.ndarray = field(default=None)

    @property
    def n(self) -> int:
        return int(self.ia.size)

    def take(self, m) -> "Cells":
        return Cells(**{k: (v[m] if isinstance(v, np.ndarray) else v) for k, v in self.__dict__.items()})


def _group_obs(grid: Grid, known_idx, h_lo_of_group: dict) -> dict:
    """Known objects per (ia, ih) group inside the group's conditioned H range (any e, i)."""
    ia, ie, ii, ih, H = known_idx
    out: dict[tuple[int, int], int] = {}
    for a_, h_, H_ in zip(ia.tolist(), ih.tolist(), H.tolist()):
        r = h_lo_of_group.get((a_, h_))
        if r is not None and r[0] <= H_ < r[1]:
            out[(a_, h_)] = out.get((a_, h_), 0) + 1
    return out


def condition(cells: Cells, group_obs: dict[tuple[int, int], int]) -> dict:
    """raw = max(0, model - known) per cell; each (ia, ih) group's deficit max(0, sum model - known in the group,
    any e and i) shared in proportion to raw. Fills cells.raw and cells.deficit; returns totals."""
    raw = np.maximum(0.0, cells.n_model - cells.n_obs)
    g = cells.ia.astype(np.int64) * _NH + (cells.ih - _IH0)
    ug, inv = np.unique(g, return_inverse=True)
    sum_model = np.bincount(inv, weights=cells.n_model, minlength=ug.size)
    sum_raw = np.bincount(inv, weights=raw, minlength=ug.size)
    obs = np.array([group_obs.get((int(k // _NH), int(k % _NH + _IH0)), 0) for k in ug], dtype=np.float64)
    gdef = np.maximum(0.0, sum_model - obs)
    scale = np.divide(gdef, sum_raw, out=np.zeros_like(gdef), where=sum_raw > 0)
    scale = np.minimum(scale, 1.0)
    cells.raw = raw
    cells.deficit = raw * scale[inv]
    return {"groups": int(ug.size), "model": float(sum_model.sum()), "knownInGroups": float(obs.sum()),
            "rawDeficit": float(raw.sum()), "deficit": float(cells.deficit.sum())}


# ---------------------------------------------------------------------------------------------- extrapolated
@dataclass
class Known:
    a: np.ndarray
    e: np.ndarray
    i: np.ndarray
    H: np.ndarray


def extrapolated_cells(grid: Grid, known: Known, hlim_a: np.ndarray, slope: SlopeLaw, h_floor: float
                       ) -> tuple[Cells, dict, dict]:
    """Model cells of a catalogue-extrapolated population (see the module docstring). hlim_a: H_lim per a-bin."""
    ia, ie, ii, ih = grid.index(known.a, known.e, known.i, known.H)
    inside = ia >= 0
    ia, ie, ii, ih, H = ia[inside], ie[inside], ii[inside], ih[inside], known.H[inside]
    hl_obj = hlim_a[ia]
    ref_n = np.bincount(ia[(H >= hl_obj - 1.0) & (H < hl_obj - 0.5)], minlength=grid.n_a).astype(np.float64)
    comp = H < hl_obj
    f_key = (ia[comp] * grid.n_e + ie[comp]) * grid.n_i + ii[comp]
    fk, fc = np.unique(f_key, return_counts=True)
    fa = fk // (grid.n_e * grid.n_i)
    n_comp = np.bincount(fa, weights=fc, minlength=grid.n_a)
    # model per cell
    rows = []
    for k, c in zip(fk.tolist(), fc.tolist()):
        a_ = k // (grid.n_e * grid.n_i)
        e_ = (k // grid.n_i) % grid.n_e
        i_ = k % grid.n_i
        if ref_n[a_] <= 0:
            continue
        f = c / n_comp[a_]
        hl = float(hlim_a[a_])
        h_ref = hl - 0.75
        dens0 = ref_n[a_] / 0.5
        for h_ in range(int(math.floor(hl / grid.h_width)), int(math.ceil(h_floor / grid.h_width))):
            lo = max(h_ * grid.h_width, hl)
            hi = min((h_ + 1) * grid.h_width, h_floor)
            if hi <= lo:
                continue
            rows.append((a_, e_, i_, h_, lo, hi, f * dens0 * slope.integral(lo, hi, h_ref, a_)))
    cells = cells_from_rows(rows)
    gobs = count_known(grid, cells, (ia, ie, ii, ih, H))
    diag = {"referenceCounts": ref_n.tolist(), "completeSample": n_comp.tolist()}
    return cells, gobs, diag


def cells_from_rows(rows: list[tuple]) -> Cells:
    """Cells from rows (ia, ie, ii, ih, h_lo, h_hi, n_model); n_obs zero."""
    r = np.array(rows, dtype=np.float64).reshape(-1, 7)
    return Cells(ia=r[:, 0].astype(np.int64), ie=r[:, 1].astype(np.int64), ii=r[:, 2].astype(np.int64),
                 ih=r[:, 3].astype(np.int64), h_lo=r[:, 4], h_hi=r[:, 5], n_model=r[:, 6], n_obs=np.zeros(r.shape[0]))


def count_known(grid: Grid, cells: Cells, known_idx) -> dict:
    """Fill cells.n_obs with the known objects (ia, ie, ii, ih, H: in-grid indices) inside each cell's conditioned H
    range; return the known count per (ia, ih) group in the group's conditioned range (any e, i)."""
    ia, ie, ii, ih, H = known_idx
    keys = grid.key(cells.ia, cells.ie, cells.ii, cells.ih)
    if keys.size and ia.size:
        order = np.argsort(keys)
        kk = grid.key(ia, ie, ii, ih)
        pos = np.clip(np.searchsorted(keys[order], kk), 0, keys.size - 1)
        cidx = order[pos]
        m = (keys[cidx] == kk) & (H >= cells.h_lo[cidx]) & (H < cells.h_hi[cidx])
        np.add.at(cells.n_obs, cidx[m], 1.0)
    groups = {}
    for a_, h_, lo, hi in zip(cells.ia.tolist(), cells.ih.tolist(), cells.h_lo.tolist(), cells.h_hi.tolist()):
        groups[(a_, h_)] = (lo, hi)
    return _group_obs(grid, (ia, ie, ii, ih, H), groups)


def sample_extrapolated(grid: Grid, cells: Cells, slope: SlopeLaw, q_min: float,
                        prefix: str) -> dict[str, np.ndarray]:
    """Draw every cell's first floor(deficit + u0) valid candidates. Returns per object: a, e, i (deg), H, the angle
    and attribute uniforms u (N, 4) = (u_angle1, u_angle2, u_angle3, u_branch), u_pv, u_rot, cell (row in cells),
    k (candidate number in the cell's stream)."""
    n = cells.n
    cells.u0 = np.zeros(n)
    cells.n_shown = np.zeros(n, dtype=np.int64)
    out = {k: [] for k in ("a", "e", "i", "H", "u", "u_pv", "u_rot", "cell", "k")}
    a_lo, a_hi = grid.a_bounds(cells.ia)
    for c in range(n):
        seed, u0 = cell_seed(prefix, int(cells.ia[c]), int(cells.ie[c]), int(cells.ii[c]), int(cells.ih[c]))
        cells.u0[c] = u0
        want = int(math.floor(cells.deficit[c] + u0))
        if want <= 0:
            continue
        rng = stream(seed)
        e0, e1 = cells.ie[c] * grid.e_width, (cells.ie[c] + 1) * grid.e_width
        i0, i1 = cells.ii[c] * grid.i_width, (cells.ii[c] + 1) * grid.i_width
        hb0, hb1 = cells.ih[c] * grid.h_width, (cells.ih[c] + 1) * grid.h_width
        al = float(slope.alpha(0.5 * (hb0 + hb1), int(cells.ia[c])))
        kf = al * LN10
        got = []
        base = 0
        while len(got) < want:
            blk = max(16, 2 * (want - len(got)))
            u = rng.random((blk, ROW))
            a = a_lo[c] + u[:, 0] * (a_hi[c] - a_lo[c])
            e = e0 + u[:, 1] * (e1 - e0)
            inc = i0 + u[:, 2] * (i1 - i0)
            H = hb0 + np.log1p(u[:, 3] * math.expm1(kf * (hb1 - hb0))) / kf
            ok = (a * (1.0 - e) >= q_min) & (H >= cells.h_lo[c]) & (H < cells.h_hi[c])
            for j in np.nonzero(ok)[0][: want - len(got)]:
                got.append((base + int(j), a[j], e[j], inc[j], H[j], u[j, 4:10]))
            base += blk
            if base > 10000 * max(want, 1):
                raise RuntimeError(f"cell {c}: candidates rejected too often")
        cells.n_shown[c] = len(got)
        for k, a, e, inc, H, uu in got:
            out["a"].append(a); out["e"].append(e); out["i"].append(inc); out["H"].append(H)
            out["u"].append(uu[:4]); out["u_pv"].append(uu[4]); out["u_rot"].append(uu[5])
            out["cell"].append(c); out["k"].append(k)
    return _arrays(out)


def _arrays(out: dict) -> dict[str, np.ndarray]:
    res = {}
    for k, v in out.items():
        if k == "u":
            res[k] = np.array(v, dtype=np.float64).reshape(-1, 4)
        elif k in ("cell", "k", "member"):
            res[k] = np.array(v, dtype=np.int64)
        else:
            res[k] = np.array(v, dtype=np.float64)
    return res


# ---------------------------------------------------------------------------------------------- realizations
def realization_cells(grid: Grid, known: Known, members: Known, h_floor: float, *, sigma: float = 2.0
                      ) -> tuple[Cells, dict, dict, dict]:
    """Model cells of a model-realization population. H_lim per a-bin: the lower edge of the first H bin whose known
    count (any e, i) is below model - sigma sqrt(model); no synthetic objects in brighter bins. Returns (cells, group
    known counts, member lists per cell key, diagnostics)."""
    mia, mie, mii, mih = grid.index(members.a, members.e, members.i, members.H)
    mem_ok = (mia >= 0) & (members.H < h_floor)
    kia, kie, kii, kih = grid.index(known.a, known.e, known.i, known.H)
    kok = (kia >= 0) & (known.H < h_floor)
    gm = np.zeros((grid.n_a, _NH))
    np.add.at(gm, (mia[mem_ok], mih[mem_ok] - _IH0), 1)
    gk = np.zeros((grid.n_a, _NH))
    np.add.at(gk, (kia[kok], kih[kok] - _IH0), 1)
    hlim = np.full(grid.n_a, np.inf)
    for a_ in range(grid.n_a):
        for j in range(_NH):
            if gm[a_, j] > 0 and gk[a_, j] < gm[a_, j] - sigma * math.sqrt(gm[a_, j]):
                hlim[a_] = (j + _IH0) * grid.h_width
                break
    sel = mem_ok & (members.H >= hlim[np.maximum(mia, 0)])
    mkey = grid.key(mia[sel], mie[sel], mii[sel], mih[sel])
    midx = np.nonzero(sel)[0]
    order = np.lexsort((midx, mkey))
    mkey, midx = mkey[order], midx[order]
    uk, start, cnt = np.unique(mkey, return_index=True, return_counts=True)
    lists = {int(k): midx[s:s + c] for k, s, c in zip(uk, start, cnt)}
    ia, ie, ii, ih = grid.unkey(uk)
    h_lo = ih * grid.h_width
    cells = Cells(ia=ia, ie=ie, ii=ii, ih=ih, h_lo=h_lo.astype(np.float64),
                  h_hi=np.minimum((ih + 1) * grid.h_width, h_floor).astype(np.float64),
                  n_model=cnt.astype(np.float64), n_obs=np.zeros(uk.size))
    ksel = kok & (known.H >= hlim[np.maximum(kia, 0)])
    kkey = grid.key(kia[ksel], kie[ksel], kii[ksel], kih[ksel])
    pos = np.searchsorted(uk, kkey)
    pos = np.clip(pos, 0, max(0, uk.size - 1))
    if uk.size:
        m = uk[pos] == kkey
        np.add.at(cells.n_obs, pos[m], 1.0)
    gobs = {}
    for a_, h_ in zip(kia[ksel].tolist(), kih[ksel].tolist()):
        gobs[(a_, h_)] = gobs.get((a_, h_), 0) + 1
    diag = {"hlimPerABin": [None if not np.isfinite(x) else float(x) for x in hlim],
            "limitRule": f"first H bin with known < model - {sigma:g} sqrt(model) (any e, i)"}
    return cells, gobs, lists, diag


def sample_realization(grid: Grid, cells: Cells, lists: dict, prefix: str) -> dict[str, np.ndarray]:
    """Per cell: model objects ordered by the cell's random keys; the first floor(deficit + u0) are shown. Returns
    member (row in the realization), u_pv, u_rot, cell, k."""
    n = cells.n
    cells.u0 = np.zeros(n)
    cells.n_shown = np.zeros(n, dtype=np.int64)
    out = {k: [] for k in ("member", "u_pv", "u_rot", "cell", "k")}
    keys = grid.key(cells.ia, cells.ie, cells.ii, cells.ih)
    for c in range(n):
        seed, u0 = cell_seed(prefix, int(cells.ia[c]), int(cells.ie[c]), int(cells.ii[c]), int(cells.ih[c]))
        cells.u0[c] = u0
        want = int(math.floor(cells.deficit[c] + u0))
        if want <= 0:
            continue
        mem = lists[int(keys[c])]
        want = min(want, mem.size)
        perm = np.argsort(stream(seed).random(mem.size), kind="stable")
        attr = stream(seed, 1).random((want, 2))
        cells.n_shown[c] = want
        out["member"].extend(mem[perm[:want]].tolist())
        out["u_pv"].extend(attr[:, 0].tolist())
        out["u_rot"].extend(attr[:, 1].tolist())
        out["cell"].extend([c] * want)
        out["k"].extend(range(want))
    return _arrays(out)


# ---------------------------------------------------------------------------------------------- orbits
def state_to_elements(r: np.ndarray, v: np.ndarray, mu: float) -> dict[str, np.ndarray]:
    """Osculating elements from heliocentric states (km, km/s) in the frame of r, v (for ecliptic elements, rotate
    first). Angles in degrees; a in km. Elliptic orbits (e < 1) only; others get NaN."""
    r = np.atleast_2d(r).astype(np.float64)
    v = np.atleast_2d(v).astype(np.float64)
    rn = np.linalg.norm(r, axis=1)
    h = np.cross(r, v)
    hn = np.linalg.norm(h, axis=1)
    ev = np.cross(v, h) / mu - r / rn[:, None]
    e = np.linalg.norm(ev, axis=1)
    en = (v * v).sum(1) / 2.0 - mu / rn
    with np.errstate(invalid="ignore", divide="ignore"):
        a = -mu / (2.0 * en)
        inc = np.degrees(np.arccos(np.clip(h[:, 2] / hn, -1, 1)))
        node = np.degrees(np.arctan2(h[:, 0], -h[:, 1])) % 360.0
        nvec = np.stack([np.cos(np.radians(node)), np.sin(np.radians(node)), np.zeros_like(node)], axis=1)
        # argument of perihelion: angle node -> e vector in the orbital plane
        w = np.degrees(np.arctan2((np.cross(nvec, ev) * h).sum(1) / hn, (nvec * ev).sum(1))) % 360.0
        cosE = (1.0 - rn / a) / e
        sinE = (r * v).sum(1) / (e * np.sqrt(mu * a))
        E = np.arctan2(sinE, cosE)
        M = np.degrees(E - e * np.sin(E)) % 360.0
    bad = ~(e < 1.0) | ~(a > 0)
    for x in (a, e, inc, node, w, M):
        x[bad] = np.nan
    return {"a": a, "e": e, "i": inc, "node": node, "peri": w, "M": M}


def rotate_icrf_to_ecliptic(x: np.ndarray, obliquity_rad: float) -> np.ndarray:
    ce, se = math.cos(obliquity_rad), math.sin(obliquity_rad)
    x = np.atleast_2d(x)
    return np.stack([x[:, 0], ce * x[:, 1] + se * x[:, 2], -se * x[:, 1] + ce * x[:, 2]], axis=1)


def elements_to_icrf(a_au, e, inc, node, peri, M, mu: float, au_km: float, obliquity_rad: float) -> tuple[np.ndarray, np.ndarray]:
    """Heliocentric ICRF position (km) and velocity (km/s) of elliptic ecliptic-J2000 elements (angles deg)."""
    a = np.asarray(a_au, np.float64) * au_km
    e = np.asarray(e, np.float64)
    Mr = np.radians(M)
    E = Mr + e * np.sin(Mr)
    for _ in range(60):
        dE = (E - e * np.sin(E) - Mr) / (1.0 - e * np.cos(E))
        E -= dE
        if np.max(np.abs(dE)) < 1e-15:
            break
    ci, si = np.cos(np.radians(inc)), np.sin(np.radians(inc))
    cO, sO = np.cos(np.radians(node)), np.sin(np.radians(node))
    cw, sw = np.cos(np.radians(peri)), np.sin(np.radians(peri))
    P = np.stack([cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si], axis=-1)
    Q = np.stack([-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si], axis=-1)
    b = a * np.sqrt(1.0 - e * e)
    x = (a * (np.cos(E) - e))[..., None] * P + (b * np.sin(E))[..., None] * Q
    n = np.sqrt(mu / a ** 3)
    edot = n / (1.0 - e * np.cos(E))
    v = (-a * np.sin(E) * edot)[..., None] * P + (b * np.cos(E) * edot)[..., None] * Q
    ce, se = math.cos(obliquity_rad), math.sin(obliquity_rad)
    rot = lambda y: np.stack([y[..., 0], ce * y[..., 1] - se * y[..., 2], se * y[..., 1] + ce * y[..., 2]], axis=-1)
    return rot(x), rot(v)


# ---------------------------------------------------------------------------------------------- attributes
@dataclass
class QuantilePool:
    """Measured values of real objects for quantile draws: per bin a sorted array (ties broken by object id), widened
    to at least `min_n` members by taking neighbouring bins."""
    values: list[np.ndarray]
    extra: list[np.ndarray]
    widened: np.ndarray

    def draw(self, b: np.ndarray, u: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        v = np.empty(b.size)
        x = np.empty(b.size, dtype=np.int64)
        for k in np.unique(b):
            m = b == k
            vals, ex = self.values[k], self.extra[k]
            j = np.minimum((u[m] * vals.size).astype(np.int64), vals.size - 1)
            v[m] = vals[j]
            x[m] = ex[j]
        return v, x


def make_pool(bin_of: np.ndarray, value: np.ndarray, extra: np.ndarray, ident: np.ndarray, n_bins: int,
              min_n: int) -> QuantilePool:
    vals, exs = [], []
    widened = np.zeros(n_bins, dtype=np.int64)
    order_all = np.lexsort((ident, value))
    b_sorted = bin_of[order_all]
    for k in range(n_bins):
        w = 0
        while True:
            m = (b_sorted >= k - w) & (b_sorted <= k + w)
            if m.sum() >= min_n or (k - w <= 0 and k + w >= n_bins - 1):
                break
            w += 1
        idx = order_all[m]
        if idx.size == 0:
            raise ValueError("make_pool: no measured values at all")
        vals.append(value[idx])
        exs.append(extra[idx])
        widened[k] = w
    return QuantilePool(vals, exs, widened)


def diameter_km(H, pv):
    """Pravec & Harris (2007) Eq. 3: D = 1329 km / sqrt(p_V) 10^(-H/5)."""
    return 1329.0 / np.sqrt(pv) * 10.0 ** (-0.2 * np.asarray(H))
