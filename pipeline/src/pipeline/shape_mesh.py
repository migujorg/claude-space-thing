"""Triangle meshes of small bodies: readers (SPICE DSK type 2, PDS plate tables, OBJ, lat/lon radius grids),
cleaning (vertex welding, outward orientation), integrity (watertightness, volume, area), quadric decimation and the
binary layout of the `shapes` products (ShapeModelHeader in app/src/data/schema.ts).

Units are km in the body-fixed frame of the source throughout.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class Mesh:
    v: np.ndarray   # (n, 3) float64, km
    f: np.ndarray   # (m, 3) int64, 0-based, counter-clockwise seen from outside after `orient_outward`

    @property
    def nv(self) -> int:
        return int(self.v.shape[0])

    @property
    def nf(self) -> int:
        return int(self.f.shape[0])


# ---------------------------------------------------------------------------------------------- readers


def read_dsk(path: Path) -> tuple[Mesh, dict]:
    """All type-2 (plate model) segments of a DSK file as one mesh; info = segment descriptors and comments."""
    import spiceypy as sp
    h = sp.dasopr(str(path))
    try:
        verts, faces, segs, off = [], [], [], 0
        dla = sp.dlabfs(h)
        while True:
            d = sp.dskgd(h, dla)
            if d.dtype != 2:
                raise ValueError(f"{path.name}: DSK data type {d.dtype} (only type 2 plate models are supported)")
            nv, npl = sp.dskz02(h, dla)
            v = _chunked(lambda s, n: sp.dskv02(h, dla, s, n), nv)
            p = _chunked(lambda s, n: sp.dskp02(h, dla, s, n), npl).astype(np.int64) - 1 + off
            verts.append(v)
            faces.append(p)
            off += nv
            segs.append({"surfaceId": int(d.surfce), "center": int(d.center), "frameId": int(d.frmcde),
                         "coordinateSystem": int(d.corsys), "vertices": int(nv), "plates": int(npl)})
            try:
                dla = sp.dlafns(h, dla)
            except sp.stypes.NotFoundError:
                break
        comments = []
        for _ in range(100):                      # dasec continues where the previous call stopped
            n, lines, done = sp.dasec(h, 2000, 400)
            comments += list(lines[:n])
            if done:
                break
    finally:
        sp.dascls(h)
    return Mesh(np.vstack(verts).astype(np.float64), np.vstack(faces)), {"segments": segs, "comments": comments}


def _chunked(read, n: int, step: int = 200_000) -> np.ndarray:
    out = [np.asarray(read(s + 1, min(step, n - s))) for s in range(0, n, step)]
    return np.vstack(out)


def read_plate_table(path: Path) -> Mesh:
    """PDS plate model table: a line 'nv nf', nv vertex lines ('x y z' or 'i x y z'), nf plate lines ('i j k' or
    'n i j k'); indices 1-based."""
    rows = [ln.split() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    nv, nf = int(rows[0][0]), int(rows[0][1])
    vr = rows[1:1 + nv]
    fr = rows[1 + nv:1 + nv + nf]
    if len(vr) != nv or len(fr) != nf:
        raise ValueError(f"{path.name}: expected {nv} vertices and {nf} plates, got {len(vr)} and {len(fr)}")
    v = np.array([[float(x) for x in r[-3:]] for r in vr])
    f = np.array([[int(x) for x in r[-3:]] for r in fr], np.int64) - 1
    return Mesh(v, f)


def read_obj(path: Path) -> Mesh:
    v, f = [], []
    for ln in path.read_text(encoding="utf-8").splitlines():
        s = ln.split()
        if not s:
            continue
        if s[0] == "v":
            v.append([float(x) for x in s[1:4]])
        elif s[0] == "f":
            idx = [int(t.split("/")[0]) for t in s[1:]]
            for k in range(1, len(idx) - 1):            # fan-triangulate polygons
                f.append([idx[0], idx[k], idx[k + 1]])
    return Mesh(np.array(v), np.array(f, np.int64) - 1)


def from_radius_grid(lat_deg: np.ndarray, lon_deg: np.ndarray, radius: np.ndarray) -> Mesh:
    """Mesh of a star-shaped body given on a regular lat/lon grid (east longitude, planetocentric latitude, radius
    in km). Rows at ±90° collapse to single pole vertices; longitude wraps."""
    lats = np.unique(np.round(lat_deg, 6))[::-1]            # north to south
    lons = np.unique(np.round(np.mod(lon_deg, 360.0), 6))
    grid = {}
    for la, lo, r in zip(np.round(lat_deg, 6), np.round(np.mod(lon_deg, 360.0), 6), radius):
        grid[(la, lo)] = r
    verts, index = [], {}

    def vid(i, j):
        la = lats[i]
        if abs(la) == 90.0:
            key = ("pole", la)
            if key not in index:
                rs = [grid[(la, lo)] for lo in lons if (la, lo) in grid]
                index[key] = len(verts)
                verts.append(_sph(la, 0.0, float(np.mean(rs))))
            return index[key]
        key = (i, j % len(lons))
        if key not in index:
            lo = lons[j % len(lons)]
            if (la, lo) not in grid:
                raise ValueError(f"grid point {la}, {lo} missing")
            index[key] = len(verts)
            verts.append(_sph(la, lo, grid[(la, lo)]))
        return index[key]

    faces = []
    for i in range(len(lats) - 1):
        for j in range(len(lons)):
            a, b = vid(i, j), vid(i, j + 1)
            c, d = vid(i + 1, j), vid(i + 1, j + 1)
            for tri in ((a, c, d), (a, d, b)):
                if len(set(tri)) == 3:
                    faces.append(tri)
    return Mesh(np.array(verts), np.array(faces, np.int64))


def _sph(lat, lon, r):
    la, lo = np.radians(lat), np.radians(lon)
    return [r * np.cos(la) * np.cos(lo), r * np.cos(la) * np.sin(lo), r * np.sin(la)]


# ---------------------------------------------------------------------------------------------- cleaning


def weld(m: Mesh, tol_km: float = 0.0) -> Mesh:
    """Merge coincident vertices (exactly equal, or within tol_km on a grid), drop degenerate faces, zero-volume
    back-to-back face pairs (`cancel_fins`), repeated faces and unused vertices. DSK ICQ models repeat the vertices
    along cube-face seams."""
    v = m.v
    key = np.round(v / tol_km).astype(np.int64) if tol_km > 0 else v
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    f = inv[m.f]
    ok = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])
    f = cancel_fins(f[ok])          # faces repeating a vertex set: back-to-back pairs cancel, repeats keep one
    used = np.unique(f)
    remap = np.full(first.size, -1, np.int64)
    remap[used] = np.arange(used.size)
    return Mesh(v[first][used], remap[f])


def signed_volume(m: Mesh) -> float:
    a, b, c = m.v[m.f[:, 0]], m.v[m.f[:, 1]], m.v[m.f[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def orient_outward(m: Mesh) -> Mesh:
    """Flip all faces if the (consistently oriented) mesh has negative signed volume."""
    return m if signed_volume(m) >= 0 else Mesh(m.v, m.f[:, ::-1].copy())


def edge_report(m: Mesh) -> dict:
    """Closed-surface check: every undirected edge must belong to exactly two faces, traversed in opposite
    directions (consistent orientation). Returns counts of boundary, non-manifold and inconsistent edges."""
    f = m.f
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    key = np.sort(e, axis=1)
    k = key[:, 0] * (m.nv + 1) + key[:, 1]
    order = np.argsort(k, kind="stable")
    ks = k[order]
    uniq, start, counts = np.unique(ks, return_index=True, return_counts=True)
    boundary = int((counts == 1).sum())
    nonmanifold = int((counts > 2).sum())
    two = counts == 2
    i0 = order[start[two]]
    i1 = order[start[two] + 1]
    inconsistent = int((e[i0, 0] == e[i1, 0]).sum())   # same direction twice
    euler = m.nv - uniq.size + m.nf
    # connected components (faces joined through shared edges)
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    fid = np.tile(np.arange(m.nf), 3)
    same = ks[1:] == ks[:-1]
    g = coo_matrix((np.ones(int(same.sum())), (fid[order][:-1][same], fid[order][1:][same])), shape=(m.nf, m.nf))
    ncomp = int(connected_components(g, directed=False)[0])
    watertight = boundary == 0 and nonmanifold == 0 and inconsistent == 0
    out = {"boundaryEdges": boundary, "nonManifoldEdges": nonmanifold, "inconsistentEdges": inconsistent,
           "eulerCharacteristic": int(euler), "components": ncomp, "watertight": watertight}
    if watertight:
        out["genus"] = (2 * ncomp - int(euler)) // 2      # handles (tunnels) summed over components
    return out


def area(m: Mesh) -> float:
    a, b, c = m.v[m.f[:, 0]], m.v[m.f[:, 1]], m.v[m.f[:, 2]]
    return float(0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())


def centroid(m: Mesh) -> np.ndarray:
    """Volume centroid (uniform density) of a closed mesh."""
    a, b, c = m.v[m.f[:, 0]], m.v[m.f[:, 1]], m.v[m.f[:, 2]]
    vol = np.einsum("ij,ij->i", a, np.cross(b, c)) / 6.0
    return ((a + b + c) / 4.0 * vol[:, None]).sum(axis=0) / vol.sum()


def principal_axes(m: Mesh) -> tuple[np.ndarray, np.ndarray]:
    """Second moments of the enclosed volume about its centroid (uniform density): eigenvalues (km⁵, largest
    first) and unit eigenvectors as columns. Column 0 is the long axis, column 2 the short axis (for a principal-
    axis rotator, the spin axis)."""
    a, b, c = m.v[m.f[:, 0]], m.v[m.f[:, 1]], m.v[m.f[:, 2]]
    vol = np.einsum("ij,ij->i", a, np.cross(b, c)) / 6.0
    s = a + b + c
    # ∫ r rᵀ dV over the tetrahedron (0, a, b, c) = V/20 · (a aᵀ + b bᵀ + c cᵀ + s sᵀ)
    mom = np.einsum("i,ij,ik->jk", vol, a, a) + np.einsum("i,ij,ik->jk", vol, b, b) \
        + np.einsum("i,ij,ik->jk", vol, c, c) + np.einsum("i,ij,ik->jk", vol, s, s)
    mom /= 20.0
    V = vol.sum()
    g = (s / 4.0 * vol[:, None]).sum(axis=0) / V
    mom -= V * np.outer(g, g)
    w, vec = np.linalg.eigh(mom)
    return w[::-1], vec[:, ::-1]


def equivalent_radius(volume_km3: float) -> float:
    return float(np.cbrt(3.0 * volume_km3 / (4.0 * np.pi)))


def vertex_normals(m: Mesh) -> np.ndarray:
    """Area-weighted vertex normals (unit)."""
    a, b, c = m.v[m.f[:, 0]], m.v[m.f[:, 1]], m.v[m.f[:, 2]]
    fn = np.cross(b - a, c - a)                    # length = 2·area
    n = np.zeros_like(m.v)
    for k in range(3):
        for j in range(3):
            n[:, j] += np.bincount(m.f[:, k], weights=fn[:, j], minlength=m.nv)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.where(ln > 0, ln, 1.0)


def cancel_fins(f: np.ndarray) -> np.ndarray:
    """Remove zero-volume 'fins': faces that repeat the vertex set of another face. An edge collapse can fold two
    triangles onto each other back to back; the pair then shares all three edges with each other and with the
    surrounding surface (non-manifold edges). A back-to-back pair cancels (both removed, which closes the surface
    again); same-direction repeats keep one copy."""
    s = np.sort(f, axis=1)
    _, inv, cnt = np.unique(s, axis=0, return_inverse=True, return_counts=True)
    inv = inv.reshape(-1)
    if cnt.max(initial=1) == 1:
        return f
    keep = cnt[inv] == 1
    # parity of each face's winding relative to its sorted vertex order (+1 even permutation, -1 odd)
    par = np.where(((f[:, 0] == s[:, 0]) & (f[:, 1] == s[:, 1])) | ((f[:, 0] == s[:, 1]) & (f[:, 1] == s[:, 2]))
                   | ((f[:, 0] == s[:, 2]) & (f[:, 1] == s[:, 0])), 1, -1)
    net = np.bincount(inv, weights=par, minlength=cnt.size)          # windings that do not cancel
    dup = np.flatnonzero(~keep)
    seen = set()
    for i in dup:                                                     # keep one face with the surviving winding
        g = inv[i]
        n = int(net[g])
        if n != 0 and g not in seen and par[i] == np.sign(n):
            keep[i] = True
            seen.add(g)
    return f[keep]


def decimate(m: Mesh, target_faces: int, agg: float = 7.0) -> Mesh:
    """Quadric-error decimation (Garland & Heckbert 1997, fast_simplification implementation) to ~target_faces,
    followed by fin cancellation and welding."""
    import fast_simplification
    if target_faces >= m.nf:
        return m
    v, f = fast_simplification.simplify(m.v, m.f.astype(np.int32), target_count=int(target_faces), agg=agg)
    f = np.asarray(f, np.int64)
    f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
    return weld(Mesh(np.asarray(v, np.float64), cancel_fins(f)))


def decimate_closed(m: Mesh, target_faces: int) -> tuple[Mesh, int]:
    """Decimate, keeping a closed input closed where possible: retry with gentler aggressiveness and slightly
    different targets until the result is watertight. If no attempt is watertight, the attempt with the fewest
    defective edges is returned (its LOD entry then says watertight: false). Every attempt reduces the mesh to
    within a few per cent of the target. Returns (mesh, attempts)."""
    closed = edge_report(m)["watertight"]
    best, best_bad, tries = None, None, 0
    for agg in (7.0, 5.0, 3.0):
        for t in (target_faces, int(target_faces * 1.01), int(target_faces * 0.99)):
            tries += 1
            d = orient_outward(decimate(m, t, agg))
            rep = edge_report(d)
            if not closed or rep["watertight"]:
                return d, tries
            bad = rep["boundaryEdges"] + rep["nonManifoldEdges"] + rep["inconsistentEdges"]
            if d.nf <= 1.05 * target_faces and (best is None or bad < best_bad):
                best, best_bad = d, bad
    if best is None:
        raise RuntimeError(f"decimation to {target_faces} triangles failed ({m.nf} input triangles)")
    return best, tries


# ---------------------------------------------------------------------------------------------- binary layout


def pack_lod(m: Mesh) -> tuple[bytes, dict]:
    """positions float32 xyz (km) | normals int16 snorm xyz (n = value / 32767) | indices uint16 or uint32, each
    part padded to 4 bytes. Returns the bytes and the part descriptors relative to the LOD start."""
    pos = m.v.astype("<f4")
    nrm = np.clip(np.round(vertex_normals(m) * 32767), -32767, 32767).astype("<i2")
    itype = "u16" if m.nv <= 65535 else "u32"
    idx = m.f.astype("<u2" if itype == "u16" else "<u4")
    parts, desc, off = [], {}, 0
    for name, arr, typ in (("positions", pos, "f32"), ("normals", nrm, "i16"), ("indices", idx, itype)):
        b = arr.tobytes()
        pad = (-len(b)) % 4
        desc[name] = {"offset": off, "bytes": len(b), "type": typ, "components": 3,
                      "count": int(arr.shape[0])}
        parts.append(b + b"\0" * pad)
        off += len(b) + pad
    desc["normals"]["encoding"] = "snorm16 (value / 32767), area-weighted vertex normals"
    return b"".join(parts), desc


def unpack_lod(buf: bytes, lod: dict) -> Mesh:
    base = lod["offset"]
    p = lod["positions"]
    v = np.frombuffer(buf, "<f4", p["count"] * 3, base + p["offset"]).reshape(-1, 3).astype(np.float64)
    i = lod["indices"]
    dt = "<u2" if i["type"] == "u16" else "<u4"
    f = np.frombuffer(buf, dt, i["count"] * 3, base + i["offset"]).reshape(-1, 3).astype(np.int64)
    return Mesh(v, f)
