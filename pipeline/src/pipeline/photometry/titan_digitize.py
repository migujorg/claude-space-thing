"""Digitize two published figures for Titan from their vector drawings (no pixel tracing):

- Barnes et al. (2018, AJ 156, 247) Fig. 4: Doose et al.'s (2016) haze single-scattering albedo below 80 km and above
  200 km → tables/titan_doose_2016_ssa.csv;
- García Muñoz et al. (2017, Nature Astronomy 1, 0114; arXiv:1704.07460v1) Fig. 1: the Cassini ISS disk-integrated
  phase curves of Titan, A_gΦ(α), one panel per filter → tables/titan_garcia_munoz_2017_iss.csv.

The PDF page is converted to SVG with poppler's pdftocairo (a system tool; only this script needs it), the curves
or markers are read from the SVG paths, and the axes are calibrated on the drawn tick marks by a straight-line
fit (the residuals are reported). Run: `uv run python -m pipeline.photometry.titan_digitize` (writes both tables
and prints the calibration residuals); the tables are committed, so the build does not need pdftocairo.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from . import atmo_sources as src, moons

TABLES = Path(__file__).parent / "tables"
SSA_CSV = TABLES / "titan_doose_2016_ssa.csv"
ISS_CSV = TABLES / "titan_garcia_munoz_2017_iss.csv"


def page_svg(pdf: Path, page: int) -> str:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "page.svg"
        subprocess.run(["pdftocairo", "-svg", "-f", str(page), "-l", str(page), str(pdf), str(out)], check=True)
        return out.read_text()


def _paths(svg: str) -> list[tuple[str | None, str, np.ndarray]]:
    """(stroke colour, command letters, absolute vertices) of every path; Bézier segments sampled every 1/8."""
    out = []
    for p in re.findall(r"<path[^>]*>", svg):
        st = re.search(r'stroke="([^"]*)"', p)
        d = re.search(r' d="([^"]*)"', p)
        if not d:
            continue
        tr = re.search(r'transform="matrix\(([^)]*)\)"', p)
        a = [float(x) for x in tr.group(1).split(",")] if tr else [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        toks = re.findall(r"[MLCZ]|-?[0-9.]+(?:e-?\d+)?", d.group(1))
        pts: list[tuple[float, float]] = []
        cmd, cur, i = None, (0.0, 0.0), 0
        while i < len(toks):
            t = toks[i]
            if t in "MLCZ":
                cmd = t
                i += 1
                continue
            if cmd in ("M", "L"):
                cur = (float(toks[i]), float(toks[i + 1]))
                pts.append(cur)
                i += 2
            elif cmd == "C":
                c = [float(v) for v in toks[i:i + 6]]
                p0, p1, p2, p3 = np.array(cur), np.array(c[0:2]), np.array(c[2:4]), np.array(c[4:6])
                for tt in np.linspace(0.0, 1.0, 9)[1:]:
                    q = (1 - tt) ** 3 * p0 + 3 * (1 - tt) ** 2 * tt * p1 + 3 * (1 - tt) * tt ** 2 * p2 + tt ** 3 * p3
                    pts.append((float(q[0]), float(q[1])))
                cur = (c[4], c[5])
                i += 6
            else:
                i += 1
        if not pts:
            continue
        P = np.array(pts)
        X = a[0] * P[:, 0] + a[2] * P[:, 1] + a[4]
        Y = a[1] * P[:, 0] + a[3] * P[:, 1] + a[5]
        out.append((st.group(1) if st else None, "".join(re.findall("[MLCZ]", d.group(1))), np.stack([X, Y], 1)))
    return out


# ---------------------------------------------------------------------------------- Barnes et al. 2018, Fig. 4

# Tick positions on page 3 (SVG user units) of the five major x ticks (1-5 µm) and six left-axis y ticks (1.0-0.0).
_B18_XT = np.array([373.246, 409.163, 445.08, 481.03, 516.948])
_B18_YT = np.array([70.011, 103.319, 136.63, 169.937, 203.279, 236.588])
_B18_CURVES = {"above_200km": "rgb(52.940369%, 81.176758%, 100%)", "below_80km": "rgb(0%, 0%, 69.018555%)"}


def barnes_2018_fig4(pdf: Path, max_nm: float = 865.0) -> tuple[list[tuple[str, float, float]], dict]:
    svg = page_svg(pdf, 3)
    kx, cx = np.polyfit(_B18_XT, np.arange(1.0, 6.0), 1)
    ky, cy = np.polyfit(_B18_YT, np.linspace(1.0, 0.0, 6), 1)
    res = {"x_um": float(np.abs(kx * _B18_XT + cx - np.arange(1.0, 6.0)).max()),
           "y": float(np.abs(ky * _B18_YT + cy - np.linspace(1.0, 0.0, 6)).max())}
    rows = []
    for name, col in _B18_CURVES.items():
        seen = set()
        for stroke, _, P in _paths(svg):
            if stroke != col or len(P) < 60:
                continue
            for x, y in P:
                lam = round((kx * x + cx) * 1000.0, 1)
                if lam > max_nm or lam in seen:
                    continue
                seen.add(lam)
                rows.append((name, lam, round(float(ky * y + cy), 4)))
    rows.sort(key=lambda r: (r[0] != "above_200km", r[1]))
    return rows, res


# ---------------------------------------------------------------------- García Muñoz et al. 2017, Fig. 1

# Panels, top-left to bottom-right, and their y-axis major tick step (the figure's labels).
_GM_NAMES = [["UV2_CL2", "CL1_UV3", "CL1_BL2"], ["BL1_CL2", "CL1_GRN", "CL1_MT1"], ["CL1_CB1", "RED_CL2", "CL1_CL2"],
             ["CL1_MT2", "CL1_CB2", "IR2_CL2"], ["CL1_MT3", "CL1_IR3", "CL1_CB3"]]
_GM_STEP = {"UV2_CL2": 0.01, "CL1_UV3": 0.02, "CL1_BL2": 0.05, "BL1_CL2": 0.05, "CL1_GRN": 0.10, "CL1_MT1": 0.05,
            "CL1_CB1": 0.10, "RED_CL2": 0.10, "CL1_CL2": 0.05, "CL1_MT2": 0.05, "CL1_CB2": 0.10, "IR2_CL2": 0.05,
            "CL1_MT3": 0.05, "CL1_IR3": 0.05, "CL1_CB3": 0.10}


def garcia_munoz_2017_fig1(pdf: Path) -> tuple[list[tuple[str, float, float]], dict]:
    """The ISS measurements (black diamond markers) of every panel, with each panel's axes calibrated on its own
    major ticks (x: 0, 30, ... 180°; y: 0, step, 2·step, ... from the bottom)."""
    svg = page_svg(pdf, 19)
    black = [(c, P) for s, c, P in _paths(svg) if s == "rgb(0%, 0%, 0%)"]
    dia = np.array([P[:4].mean(0) for c, P in black
                    if c == "MLLLL" and 1.5 < np.ptp(P[:, 0]) < 1.7 and 1.5 < np.ptp(P[:, 1]) < 1.7])
    segs = np.array([(P[0, 0], P[0, 1], P[1, 0], P[1, 1]) for c, P in black if c == "ML"])
    hl = segs[(np.abs(segs[:, 1] - segs[:, 3]) < 0.01) & (np.abs(segs[:, 0] - segs[:, 2]) > 50)]
    vl = segs[(np.abs(segs[:, 0] - segs[:, 2]) < 0.01) & (np.abs(segs[:, 1] - segs[:, 3]) > 50)]
    xs = sorted(set(np.round(vl[:, 0], 2)))
    ys = sorted(set(np.round(hl[:, 1], 2)))
    cols = [(xs[2 * i], xs[2 * i + 1]) for i in range(len(xs) // 2)]
    frames = [(ys[2 * i], ys[2 * i + 1]) for i in range(len(ys) // 2)]
    rows, res = [], {}
    for ri, (y0, y1) in enumerate(frames):
        for ci, (x0, x1) in enumerate(cols):
            nm = _GM_NAMES[ri][ci]
            t = segs[(np.abs(segs[:, 0] - x0) < 0.05) & (np.abs(segs[:, 1] - segs[:, 3]) < 0.01)
                     & (segs[:, 1] > y0 - 0.1) & (segs[:, 1] < y1 + 0.1)]
            ln = np.abs(t[:, 2] - t[:, 0])
            t, ln = t[ln < 10], ln[ln < 10]
            major = np.sort(np.unique(np.round(t[ln > ln.max() * 0.75, 1], 3)))[::-1]
            tx = segs[(np.abs(segs[:, 1] - y1) < 0.05) & (np.abs(segs[:, 0] - segs[:, 2]) < 0.01)
                      & (segs[:, 0] > x0 - 0.1) & (segs[:, 0] < x1 + 0.1)]
            lx = np.abs(tx[:, 3] - tx[:, 1])
            tx, lx = tx[lx < 10], lx[lx < 10]
            majx = np.sort(np.unique(np.round(tx[lx > lx.max() * 0.75, 0], 3)))
            vals = _GM_STEP[nm] * np.arange(len(major))
            ky, cy = np.polyfit(major, vals, 1)
            kx, cx = np.polyfit(majx, 30.0 * np.arange(len(majx)), 1)
            res[nm] = {"y": float(np.abs(ky * major + cy - vals).max()),
                       "x_deg": float(np.abs(kx * majx + cx - 30.0 * np.arange(len(majx))).max()),
                       "y_ticks": int(len(major)), "x_ticks": int(len(majx))}
            sel = (dia[:, 0] > x0) & (dia[:, 0] < x1) & (dia[:, 1] > y0) & (dia[:, 1] < y1)
            for x, y in dia[sel]:
                rows.append((nm, round(float(kx * x + cx), 3), round(float(ky * y + cy), 5)))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    return rows, res


def read_iss(path: Path = ISS_CSV) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """filter → (α degrees, A_gΦ), as digitized."""
    out: dict[str, list[tuple[float, float]]] = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#") or line.startswith("filter,"):
            continue
        f, a, v = line.split(",")
        out.setdefault(f, []).append((float(a), float(v)))
    return {f: (np.array([a for a, _ in r]), np.array([v for _, v in r])) for f, r in out.items()}


_ISS_HEADER = """\
# Titan's Cassini ISS disk-integrated phase curves, A_gΦ(α) (geometric albedo × phase function, reference radius
#   2575 km), as plotted (black diamonds, one per image) in Fig. 1 of García Muñoz, A., Lavvas, P. & West, R. A.
#   (2017), "Titan brighter at twilight than in daylight", Nature Astronomy 1, 0114, DOI:10.1038/s41550-017-0114
#   (arXiv:1704.07460v1, page 19). Filter names as in the figure: NAC filter-wheel pairs (e.g. BL1_CL2, CL1_GRN).
#   The paper's Methods: 5766 calibrated (I/F) NAC images of 2004-2015 from the PDS Ring-Moon Systems Node, all from
#   farther than 1.2 million km, aperture photometry inside 3500 km + 10 px of Titan's centre. The paper gives no
#   uncertainty for the measurements; the CISSCAL User Guide (§5.10.1) puts the absolute calibration at ~10 %.
# Digitized 2026-10-01 from the figure's vector drawing (pipeline/src/pipeline/photometry/titan_digitize.py): the
#   centres of the diamond markers in each panel; each panel's axes calibrated on its own major ticks (x: 30° steps;
#   y: the panel's labelled step); max residuals {res}. Overlapping markers are kept as drawn.
"""


def main() -> None:
    b18 = src.BARNES_2018.fetch()
    gm = moons.GARCIA_MUNOZ.fetch()
    rows, res = barnes_2018_fig4(b18)
    old = [ln for ln in SSA_CSV.read_text().splitlines() if ln and not ln.startswith("#")][1:]
    new = [f"{c},{w:.1f},{v:.4f}" for c, w, v in rows]
    print(f"Barnes et al. 2018 Fig. 4: {len(new)} vertices, residuals x {res['x_um']:.4f} µm, y {res['y']:.4f}; "
          f"{'identical to' if new == old else 'DIFFERS from'} {SSA_CSV.name}")
    rows2, res2 = garcia_munoz_2017_fig1(gm)
    ry = max(r["y"] for r in res2.values())
    rx = max(r["x_deg"] for r in res2.values())
    hdr = _ISS_HEADER.replace("{res}", f"x {rx:.3f}°, y {ry:.2e}")
    ISS_CSV.write_text(hdr + "filter,alpha_deg,AgPhi\n" + "".join(f"{f},{a:.3f},{v:.5f}\n" for f, a, v in rows2))
    for f, r in res2.items():
        n = sum(1 for x in rows2 if x[0] == f)
        print(f"  {f}: {n} points, ticks x {r['x_ticks']} y {r['y_ticks']}, residuals {r['x_deg']:.3f}° {r['y']:.1e}")


if __name__ == "__main__":
    main()
