"""Reference radiative transfer for an atmosphere of atmospheres.json: a forward Monte Carlo model of a spherical,
spherically symmetric atmosphere over a Lambert sphere, giving the disk-integrated reflectance A_gΦ(α) at every phase
angle α. It is the yardstick for the renderer's approximations (docs/reports/atmospheres.md, "Titan"): exact
multiple scattering with the tabulated phase functions in spherical geometry, no plane-parallel or isotropic
assumption, noise only.

Method (e.g. Marchuk et al. 1980, The Monte Carlo Methods in Atmospheric Optics; Garcia Munoz & Mills 2015 use
the backward variant for Titan's phase curves): photons enter uniformly over the disk of the top sphere, travelling
along −z (Sun at +z). Free paths by delta tracking with a majorant per altitude band (the band's largest extinction;
a path that reaches a band boundary restarts there). At a real collision the weight is multiplied by the single-
scattering albedo (implicit capture), the scattering species is drawn by its share of the scattering coefficient,
and the new direction from that species' phase function (inverse CDF of the tabulated function; Rayleigh by rejection).
At the bottom sphere the photon is reflected by a Lambert surface (weight × albedo, cosine-weighted direction).
Russian roulette below a weight of 1e-3. A photon leaving the top sphere is tallied by the angle α between its
direction and the Sun (+z):

    A_gΦ(α) = (π R_top² / R²) · ΣW / (N · ΔΩ),   ΔΩ = 2π (cos α_lo − cos α_hi)

with R the reference (bottom) radius, as the geometric-albedo convention of architecture §4.3.
"""

from __future__ import annotations

import math

import numpy as np
from numba import njit


def phase_cdf(angles_deg: np.ndarray, values: np.ndarray, n: int = 4001) -> tuple[np.ndarray, np.ndarray]:
    """Inverse-CDF tables (cos θ grid, cumulative probability) of tabulated phase functions values[k][angle] (linear in
    angle between nodes, mean 1 over the sphere): returns (mu[k][n], cdf[k][n]) with cdf from 0 at μ = 1."""
    th = np.radians(np.linspace(0.0, 180.0, n))
    mus, cdfs = [], []
    for row in np.atleast_2d(values):
        p = np.interp(np.degrees(th), angles_deg, row)
        f = p * np.sin(th)
        c = np.concatenate([[0.0], np.cumsum(0.5 * (f[1:] + f[:-1]) * np.diff(th))])
        cdfs.append(c / c[-1])
        mus.append(np.cos(th))
    return np.array(mus), np.array(cdfs)


@njit(cache=True)
def _sample_tab(mu_t, cdf_t, u):
    lo, hi = 0, cdf_t.size - 1
    while hi - lo > 1:
        m = (lo + hi) >> 1
        if cdf_t[m] <= u:
            lo = m
        else:
            hi = m
    d = cdf_t[hi] - cdf_t[lo]
    f = (u - cdf_t[lo]) / d if d > 0 else 0.0
    return mu_t[lo] + f * (mu_t[hi] - mu_t[lo])


@njit(cache=True)
def _sample_rayleigh(rho):
    # P ∝ (1 + ρ) + (1 − ρ) μ²: rejection from the uniform distribution in μ.
    pmax = 2.0
    while True:
        mu = 2.0 * np.random.random() - 1.0
        if np.random.random() * pmax <= (1.0 + rho) + (1.0 - rho) * mu * mu:
            return mu


@njit(cache=True)
def _rotate(ux, uy, uz, mu):
    """New direction at scattering-angle cosine mu and a uniform azimuth around (ux, uy, uz)."""
    phi = 2.0 * math.pi * np.random.random()
    st = math.sqrt(max(1.0 - mu * mu, 0.0))
    cp, sp = math.cos(phi), math.sin(phi)
    if abs(uz) > 0.99999:
        s = 1.0 if uz > 0 else -1.0
        return st * cp, st * sp, s * mu
    d = math.sqrt(1.0 - uz * uz)
    nx = st * (ux * uz * cp - uy * sp) / d + ux * mu
    ny = st * (uy * uz * cp + ux * sp) / d + uy * mu
    nz = -st * cp * d + uz * mu
    n = math.sqrt(nx * nx + ny * ny + nz * nz)
    return nx / n, ny / n, nz / n


@njit(cache=True)
def _sphere_exit(px, py, pz, ux, uy, uz, R):
    """Distance along u to the sphere of radius R from inside (largest root), or −1."""
    b = px * ux + py * uy + pz * uz
    c = px * px + py * py + pz * pz - R * R
    d = b * b - c
    if d < 0:
        return -1.0
    return -b + math.sqrt(d)


@njit(cache=True)
def _sphere_enter(px, py, pz, ux, uy, uz, R):
    """Distance along u to the sphere of radius R from outside it (smallest positive root), or −1 if missed."""
    b = px * ux + py * uy + pz * uz
    c = px * px + py * py + pz * pz - R * R
    d = b * b - c
    if d < 0:
        return -1.0
    t = -b - math.sqrt(d)
    return t if t > 1e-9 else -1.0


@njit(cache=True)
def _interp(alt, tab, h):
    n = alt.size
    if h <= alt[0]:
        return tab[0]
    if h >= alt[n - 1]:
        return tab[n - 1]
    lo, hi = 0, n - 1
    while hi - lo > 1:
        m = (lo + hi) >> 1
        if alt[m] <= h:
            lo = m
        else:
            hi = m
    t = (h - alt[lo]) / (alt[hi] - alt[lo])
    return tab[lo] + t * (tab[hi] - tab[lo])


@njit(cache=True)
def _run(n_photons, seed, R, Rt, alt, ext, sca, band_r, band_max, kind, rho, mu_t, cdf_t, surf, nbins):
    """ext[alt], sca[species][alt]; kind[species]: −1 Rayleigh, ≥ 0 index into the phase CDF tables."""
    np.random.seed(seed)
    tally = np.zeros((2, nbins))
    nb = band_r.size - 1
    ns = sca.shape[0]
    for _ in range(n_photons):
        # uniform over the top disk, entering along −z
        while True:
            x = (2.0 * np.random.random() - 1.0) * Rt
            y = (2.0 * np.random.random() - 1.0) * Rt
            if x * x + y * y < Rt * Rt:
                break
        z = math.sqrt(Rt * Rt - x * x - y * y) * (1.0 - 1e-12)
        ux, uy, uz = 0.0, 0.0, -1.0
        w = 1.0
        alive = True
        while alive:
            r = math.sqrt(x * x + y * y + z * z)
            # band of r
            b = 0
            while b < nb - 1 and r >= band_r[b + 1]:
                b += 1
            smax = band_max[b]
            # distances to the band's boundaries along u
            d_out = _sphere_exit(x, y, z, ux, uy, uz, band_r[b + 1])
            d_in = _sphere_enter(x, y, z, ux, uy, uz, band_r[b]) if b >= 0 else -1.0
            dmax = d_out
            hit_inner = False
            if d_in > 0 and d_in < d_out:
                dmax = d_in
                hit_inner = True
            t = -math.log(1.0 - np.random.random()) / smax if smax > 0 else 1e30
            if t >= dmax:
                # move to the boundary
                x += ux * dmax
                y += uy * dmax
                z += uz * dmax
                if hit_inner:
                    if b == 0:
                        # the surface: Lambert reflection
                        w *= surf
                        rr = math.sqrt(x * x + y * y + z * z)
                        nx, ny, nz = x / rr, y / rr, z / rr
                        mu = math.sqrt(np.random.random())
                        # cosine-weighted direction around the normal
                        phi = 2.0 * math.pi * np.random.random()
                        st = math.sqrt(1.0 - mu * mu)
                        # basis around n
                        if abs(nz) < 0.9:
                            ax, ay, az = 0.0, 0.0, 1.0
                        else:
                            ax, ay, az = 1.0, 0.0, 0.0
                        e1x, e1y, e1z = ay * nz - az * ny, az * nx - ax * nz, ax * ny - ay * nx
                        l1 = math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z)
                        e1x, e1y, e1z = e1x / l1, e1y / l1, e1z / l1
                        e2x, e2y, e2z = ny * e1z - nz * e1y, nz * e1x - nx * e1z, nx * e1y - ny * e1x
                        ux = st * math.cos(phi) * e1x + st * math.sin(phi) * e2x + mu * nx
                        uy = st * math.cos(phi) * e1y + st * math.sin(phi) * e2y + mu * ny
                        uz = st * math.cos(phi) * e1z + st * math.sin(phi) * e2z + mu * nz
                        x += nx * 1e-6
                        y += ny * 1e-6
                        z += nz * 1e-6
                    else:
                        # nudge inward across the boundary
                        rr = math.sqrt(x * x + y * y + z * z)
                        x -= x / rr * 1e-6
                        y -= y / rr * 1e-6
                        z -= z / rr * 1e-6
                else:
                    rr = math.sqrt(x * x + y * y + z * z)
                    if b == nb - 1:
                        # escaped through the top
                        mu = uz
                        k = int((1.0 - mu) * 0.5 * nbins)
                        if k >= nbins:
                            k = nbins - 1
                        if k < 0:
                            k = 0
                        # disk (the exit ray's impact parameter |p × u| below R) or the air beyond its edge
                        cx, cy, cz = y * uz - z * uy, z * ux - x * uz, x * uy - y * ux
                        part = 0 if cx * cx + cy * cy + cz * cz < R * R else 1
                        tally[part, k] += w
                        alive = False
                    else:
                        x += x / rr * 1e-6
                        y += y / rr * 1e-6
                        z += z / rr * 1e-6
                continue
            x += ux * t
            y += uy * t
            z += uz * t
            h = math.sqrt(x * x + y * y + z * z) - R
            e = _interp(alt, ext, h)
            if np.random.random() * smax > e:
                continue        # null collision
            # real collision: implicit capture, species, direction
            st_tot = 0.0
            for s in range(ns):
                st_tot += _interp(alt, sca[s], h)
            w *= st_tot / e
            u = np.random.random() * st_tot
            s = 0
            acc = _interp(alt, sca[0], h)
            while acc < u and s < ns - 1:
                s += 1
                acc += _interp(alt, sca[s], h)
            if kind[s] < 0:
                mu = _sample_rayleigh(rho[s])
            else:
                mu = _sample_tab(mu_t[kind[s]], cdf_t[kind[s]], np.random.random())
            ux, uy, uz = _rotate(ux, uy, uz, mu)
            if w < 1e-3:
                if np.random.random() < 0.1:
                    w *= 10.0
                else:
                    alive = False
    return tally


def disk_phase_curve(R: float, alt: np.ndarray, ext: np.ndarray, sca: list[np.ndarray], kinds: list[int],
                     rhos: list[float], phase_tables: list[tuple[np.ndarray, np.ndarray]], surface: float,
                     n_photons: int = 200_000, nbins: int = 180, seed: int = 1, n_bands: int = 12) -> dict:
    """A_gΦ(α) of the sphere (radius R km, atmosphere on `alt` km above it, extinction ext[alt] km⁻¹, scattering per
    species sca[s][alt]) at one wavelength. kinds[s] = −1 for Rayleigh (depolarization rhos[s]) or an index into
    phase_tables [(anglesDeg, values)]. Bins are uniform in cos α (nbins over −1..1): returns bin centres in degrees,
    A_gΦ per bin and its 1σ (Poisson on the per-bin weights is not exact for weighted tallies; the error comes from
    eight independent batches)."""
    alt = np.asarray(alt, float)
    Rt = R + alt[-1]
    ext = np.asarray(ext, float)
    sca_a = np.array([np.asarray(s, float) for s in sca])
    edges = R + np.linspace(alt[0], alt[-1], n_bands + 1)
    # majorant per band: the band's largest extinction (linear between levels: the max is at a level or an edge)
    bmax = np.empty(n_bands)
    for i in range(n_bands):
        hs = np.concatenate([alt[(alt >= edges[i] - R) & (alt <= edges[i + 1] - R)], [edges[i] - R, edges[i + 1] - R]])
        bmax[i] = np.interp(hs, alt, ext).max() * 1.0000001 + 1e-30
    mus, cdfs = [], []
    for ang, vals in phase_tables:
        m, c = phase_cdf(np.asarray(ang, float), np.atleast_2d(np.asarray(vals, float)))
        mus.append(m[0])
        cdfs.append(c[0])
    mu_t = np.array(mus) if mus else np.zeros((1, 2))
    cdf_t = np.array(cdfs) if cdfs else np.zeros((1, 2))
    batches = 8
    per = max(1, n_photons // batches)
    tallies = np.array([_run(per, seed * 1000 + j, R, Rt, alt, ext, sca_a, edges, bmax,
                             np.array(kinds, np.int64), np.array(rhos, float), mu_t, cdf_t, float(surface), nbins)
                        for j in range(batches)])
    mu_edges = 1.0 - 2.0 * np.arange(nbins + 1) / nbins           # cos α from +1 (α = 0) down to −1
    dOmega = 2.0 * math.pi * (mu_edges[:-1] - mu_edges[1:])
    scale = math.pi * Rt * Rt / (R * R) / per
    parts = tallies * scale / dOmega[None, None, :]
    ag = parts.sum(axis=1)
    alpha = np.degrees(np.arccos(0.5 * (mu_edges[:-1] + mu_edges[1:])))
    return {"alphaDeg": alpha, "AgPhi": ag.mean(axis=0), "sigma": ag.std(axis=0, ddof=1) / math.sqrt(batches),
            "muEdges": mu_edges, "shell": parts[:, 1, :].mean(axis=0)}


def body_inputs(entry: dict, k: int) -> dict:
    """disk_phase_curve arguments for sample k of a body of atmospheres.json (all components; a body without a
    surfaceReflectance gets a black surface)."""
    alt = np.array(entry["altitudesKm"], float)
    ext = np.zeros(alt.size)
    sca, kinds, rhos, tables = [], [], [], []
    for c in entry["components"]:
        b = np.array(c["extinctionPerKm"]["value"], float)[:, k]
        w = c["singleScatteringAlbedo"]["value"][k]
        ext += b
        ph = c["phaseFunction"]["value"]
        if ph["kind"] == "none" or w == 0:
            continue
        sca.append(b * w)
        if ph["kind"] == "rayleigh":
            kinds.append(-1)
            rhos.append(ph["depolarization"][k])
        elif ph["kind"] == "tabulated":
            kinds.append(len(tables))
            rhos.append(0.0)
            tables.append((np.array(ph["anglesDeg"], float), np.array(ph["values"][k], float)))
        else:
            raise ValueError(f"phase kind {ph['kind']} not handled")
    sr = entry.get("surfaceReflectance")
    surf = sr["value"]["reflectance"][k] if sr and sr.get("value") else 0.0
    return {"R": float(entry["referenceRadiusKm"]), "alt": alt - alt[0], "ext": ext, "sca": sca, "kinds": kinds,
            "rhos": rhos, "phase_tables": tables, "surface": float(surf)}


def bin_phase(curve: dict, lo_deg: float, hi_deg: float) -> tuple[float, float]:
    """Solid-angle-weighted mean of A_gΦ over the bins whose centres lie in [lo, hi] degrees."""
    a = curve["alphaDeg"]
    s = (a >= lo_deg) & (a <= hi_deg)
    w = curve["muEdges"][:-1][s] - curve["muEdges"][1:][s]
    v = float((curve["AgPhi"][s] * w).sum() / w.sum())
    e = float(math.sqrt(((curve["sigma"][s] * w) ** 2).sum()) / w.sum())
    return v, e


def main(argv: list[str] | None = None) -> None:
    """Run the reference for every spectral sample of one body of a built atmospheres.json and write its curves:
    `python -m pipeline.photometry.titan_rt [atmospheres.json] [out.json] [--photons N] [--body 606]` (defaults: the
    repository's app/public/data/atmospheres.json, docs/reports/titan-mc.json, 400000 photons per sample, Titan).
    Deterministic (a fixed seed per sample); a few minutes per sample."""
    import argparse
    import json

    from ..paths import REPO

    ap = argparse.ArgumentParser()
    ap.add_argument("atmospheres", nargs="?", default=str(REPO / "app" / "public" / "data" / "atmospheres.json"))
    ap.add_argument("out", nargs="?", default=str(REPO / "docs" / "reports" / "titan-mc.json"))
    ap.add_argument("--photons", type=int, default=400_000)
    ap.add_argument("--body", default="606")
    ap.add_argument("--samples", default="all", help="comma-separated sample indices, or 'all'")
    a = ap.parse_args(argv)
    with open(a.atmospheres) as f:
        af = json.load(f)
    entry = af["bodies"][a.body]
    wl = af["wavelengthsNm"]
    ks = list(range(len(wl))) if a.samples == "all" else [int(x) for x in a.samples.split(",")]
    curves, mu_edges, alpha = [], None, None
    for k in ks:
        c = disk_phase_curve(**body_inputs(entry, k), n_photons=a.photons, nbins=180, seed=1 + k)
        mu_edges, alpha = c["muEdges"], c["alphaDeg"]
        curves.append({"sample": k, "wavelengthNm": wl[k], "AgPhi": [round(float(v), 6) for v in c["AgPhi"]],
                       "sigma": [round(float(v), 6) for v in c["sigma"]],
                       "shell": [round(float(v), 6) for v in c["shell"]]})
        print(f"{wl[k]:.0f} nm: A_gPhi(0-9 deg) = {bin_phase(c, 0.0, 9.0)[0]:.4f}", flush=True)
    out = {"what": "Monte Carlo A_gΦ(α) of the body's atmosphere model over its surface (pipeline/src/pipeline/"
                   "photometry/titan_rt.py): exact multiple scattering in spherical geometry, the reference for the "
                   "renderer's approximations. Bins uniform in cos α (alphaDeg: centres); sigma: 1σ from eight "
                   "batches; shell: the part from rays whose impact parameter exceeds the reference radius.",
           "body": a.body, "photonsPerSample": a.photons,
           # What the curves were computed from, to tell a stale reference (the product rebuilt since).
           "inputs": {"columnOpticalDepth": {c["id"]: [round(float(v), 6) for v in c["columnOpticalDepth"]]
                                             for c in entry["components"]},
                      "singleScatteringAlbedo": {c["id"]: c["singleScatteringAlbedo"]["value"]
                                                 for c in entry["components"]},
                      "surfaceReflectance": (entry.get("surfaceReflectance") or {}).get("value", {}).get("reflectance")},
           "alphaDeg": [round(float(v), 4) for v in alpha], "muEdges": [round(float(v), 6) for v in mu_edges],
           "curves": curves}
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")


if __name__ == "__main__":
    main()
