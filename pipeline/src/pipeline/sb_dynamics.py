"""Small-body dynamics: osculating elements -> state, universal-variable Kepler drift, planetary kicks, and the
fixed-grid Kepler-drift + kick integrator (a SABA_n splitting, Laskar & Robutel 2001) used by the `smallbodies`
stage. `app/src/core/smallbody.ts` implements exactly the same scheme in TypeScript; keep the two in step
(the constants they share travel in the product header's `forceModel`, see `sb_model.py`).

Units: km, s, km^3/s^2; heliocentric ICRF (SPICE J2000) positions and velocities.

Scalar numba kernels, one object at a time (the same structure as the TypeScript and, later, the GPU code).

References
- Universal variables and Stumpff functions: Danby, J. M. A. (1988), Fundamentals of Celestial Mechanics,
  2nd ed., Willmann-Bell, ch. 6.9; Laguerre iteration: Conway, B. A. (1986), An improved algorithm due to
  Laguerre for the solution of Kepler's equation, Celestial Mechanics 39, 199, DOI:10.1007/BF01230852.
- Mixed-variable (Kepler drift + kick) maps: Wisdom, J. & Holman, M. (1991), AJ 102, 1528, DOI:10.1086/115978.
  Higher-order positive-step compositions SABA_n: Laskar, J. & Robutel, P. (2001), Celestial Mechanics and
  Dynamical Astronomy 80, 39, DOI:10.1023/A:1012098603882.
- Solar relativistic term (PPN beta = gamma = 1, harmonic gauge, test particle): IERS Conventions (2010), Petit, G.
  & Luzum, B. (eds.), IERS Technical Note 36, Eq. 10.12 (with the Sun as the central body).
- Non-gravitational acceleration: Marsden, Sekanina & Yeomans (1973), AJ 78, 211, DOI:10.1086/111402; delay DT:
  Yeomans & Chodas (1989), AJ 98, 1083, DOI:10.1086/115201.
"""

from __future__ import annotations

import math

import numba as nb
import numpy as np

# Status codes returned per object by the propagators.
OK = 0
COLLIDED = 1        # passed inside a perturber's (or the Sun's) radius: later positions are meaningless
NO_EPHEMERIS = 2    # a kick time fell outside the planetary ephemeris coverage
NO_CONVERGENCE = 3  # universal Kepler equation did not converge (non-physical state)

_LAGUERRE_N = 5.0
_MAX_ITER = 60
_INV_FACT = np.array([1.0 / math.factorial(k) for k in range(28)])


# ---------------------------------------------------------------------------------------------- Kepler
@nb.njit(cache=True)
def stumpff_c2_c3(z: float) -> tuple[float, float]:
    """Stumpff functions c2(z) = (1 - cos sqrt z)/z and c3(z) = (sqrt z - sin sqrt z)/sqrt(z)^3 (and hyperbolic
    continuations for z < 0). Maclaurin series for |z| < 1 (13 terms: error < 1e-19), closed forms elsewhere."""
    if abs(z) < 1.0:
        # c2 = sum (-z)^k / (2k+2)!, c3 = sum (-z)^k / (2k+3)!, Horner from k = 12 down.
        c2 = 0.0
        c3 = 0.0
        for k in range(12, -1, -1):
            c2 = c2 * (-z) + _INV_FACT[2 * k + 2]
            c3 = c3 * (-z) + _INV_FACT[2 * k + 3]
        return c2, c3
    if z > 0.0:
        x = math.sqrt(z)
        h = math.sin(0.5 * x) / (0.5 * x)
        return 0.5 * h * h, (x - math.sin(x)) / (x * z)
    x = math.sqrt(-z)
    h = math.sinh(0.5 * x) / (0.5 * x)
    return 0.5 * h * h, (math.sinh(x) - x) / (x * (-z))


@nb.njit(cache=True)
def solve_universal(r0: float, eta: float, beta: float, mu: float, dt: float, s: float) -> tuple[float, int]:
    """Solve r0*G1(s) + eta*G2(s) + mu*G3(s) = dt for the universal anomaly s (G_n = s^n c_n(beta s^2)), starting at s.
    Laguerre-Conway iteration (n = 5). Returns (s, iterations) with iterations = -1 if not converged."""
    for it in range(_MAX_ITER):
        z = beta * s * s
        c2, c3 = stumpff_c2_c3(z)
        g1 = s * (1.0 - z * c3)
        g2 = s * s * c2
        g3 = s * s * s * c3
        g0 = 1.0 - z * c2
        f = r0 * g1 + eta * g2 + mu * g3 - dt
        fp = r0 * g0 + eta * g1 + mu * g2
        fpp = eta * g0 + (mu - beta * r0) * g1
        disc = (_LAGUERRE_N - 1.0) ** 2 * fp * fp - _LAGUERRE_N * (_LAGUERRE_N - 1.0) * f * fpp
        den = fp + math.copysign(math.sqrt(abs(disc)), fp)
        ds = _LAGUERRE_N * f / den
        s -= ds
        if abs(ds) <= 1e-12 * abs(s) or ds == 0.0:  # cubic convergence: the applied step leaves rounding error
            return s, it + 1
    return s, -1


@nb.njit(cache=True)
def kepler_drift(x: np.ndarray, v: np.ndarray, dt: float, mu: float, s_guess: float) -> int:
    """Advance (x, v) in place along the two-body orbit about mu by dt (any sign, any eccentricity).
    s_guess = NaN -> first-order guess dt/r0. Returns OK or NO_CONVERGENCE."""
    r0 = math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2])
    eta = x[0] * v[0] + x[1] * v[1] + x[2] * v[2]
    v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
    beta = 2.0 * mu / r0 - v2
    s0 = s_guess
    if s0 != s0:
        s0 = dt / r0 - eta * dt * dt / (2.0 * r0 * r0 * r0)
    s, it = solve_universal(r0, eta, beta, mu, dt, s0)
    if it < 0:
        return NO_CONVERGENCE
    z = beta * s * s
    c2, c3 = stumpff_c2_c3(z)
    g1 = s * (1.0 - z * c3)
    g2 = s * s * c2
    g0 = 1.0 - z * c2
    r = r0 * g0 + eta * g1 + mu * g2
    fm1 = -mu * g2 / r0            # f - 1
    g = r0 * g1 + eta * g2
    fd = -mu * g1 / (r * r0)
    gdm1 = -mu * g2 / r            # gdot - 1
    for j in range(3):
        xj = x[j]
        vj = v[j]
        x[j] = xj + (fm1 * xj + g * vj)
        v[j] = vj + (fd * xj + gdm1 * vj)
    return OK


@nb.njit(cache=True)
def _kepler_E(M: float, e: float) -> float:
    """Eccentric anomaly for M in (-pi, pi], 0 <= e < 1 (Newton, Danby's starting value)."""
    E = M + 0.85 * e * (1.0 if math.sin(M) >= 0.0 else -1.0)
    for _ in range(100):
        f = E - e * math.sin(E) - M
        d = f / (1.0 - e * math.cos(E))
        E -= d
        if abs(d) < 1e-15:
            break
    return E


@nb.njit(cache=True)
def _kepler_F(Mh: float, e: float) -> float:
    """Hyperbolic anomaly: e sinh F - F = Mh, e > 1 (Newton from asinh(Mh/e))."""
    F = math.asinh(Mh / e)
    for _ in range(200):
        f = e * math.sinh(F) - F - Mh
        d = f / (e * math.cosh(F) - 1.0)
        F -= d
        if abs(d) <= 1e-15 * max(1.0, abs(F)):
            break
    return F


@nb.njit(cache=True)
def elements_to_state(q: float, e: float, inc: float, node: float, peri: float, dt_peri: float, mu: float,
                      obliquity: float, out: np.ndarray) -> int:
    """Heliocentric ICRF state (out[0:3] km, out[3:6] km/s) from ecliptic-J2000 osculating elements.

    q perihelion distance (km), e eccentricity, inc/node/peri (rad) referred to the ecliptic and equinox J2000,
    dt_peri = time since perihelion passage (s; for e < 1 callers pass M/n with M reduced to (-pi, pi]).
    The state at perihelion is drifted along the universal-variable two-body orbit by dt_peri, so every
    eccentricity (elliptic, parabolic, hyperbolic) takes the same path. The ecliptic -> ICRF rotation is about
    x by the obliquity (IAU 1976 value 84381.448 arcsec, which JPL uses for its ecliptic elements)."""
    cO, sO = math.cos(node), math.sin(node)
    cw, sw = math.cos(peri), math.sin(peri)
    ci, si = math.cos(inc), math.sin(inc)
    P0 = cO * cw - sO * sw * ci
    P1 = sO * cw + cO * sw * ci
    P2 = sw * si
    Q0 = -cO * sw - sO * cw * ci
    Q1 = -sO * sw + cO * cw * ci
    Q2 = cw * si
    vp = math.sqrt(mu * (1.0 + e) / q)
    x = np.empty(3)
    v = np.empty(3)
    x[0], x[1], x[2] = q * P0, q * P1, q * P2
    v[0], v[1], v[2] = vp * Q0, vp * Q1, vp * Q2
    beta = mu * (1.0 - e) / q
    # Starting value for the universal anomaly from the classical anomaly (then polished by the universal solver).
    if e < 1.0:
        n = math.sqrt(beta * beta * beta) / mu
        M = n * dt_peri
        s0 = _kepler_E(M, e) / math.sqrt(beta)
    elif e > 1.0:
        n = math.sqrt((-beta) ** 3) / mu
        s0 = _kepler_F(n * dt_peri, e) / math.sqrt(-beta)
    else:
        # parabola: q s + mu s^3 / 6 = dt (Cardano, one real root)
        p = 6.0 * q / mu
        qq = -6.0 * dt_peri / mu
        d = math.sqrt(qq * qq / 4.0 + p * p * p / 27.0)
        s0 = np.cbrt(-qq / 2.0 + d) + np.cbrt(-qq / 2.0 - d)
    st = kepler_drift(x, v, dt_peri, mu, s0)
    ce, se = math.cos(obliquity), math.sin(obliquity)
    out[0] = x[0]
    out[1] = ce * x[1] - se * x[2]
    out[2] = se * x[1] + ce * x[2]
    out[3] = v[0]
    out[4] = ce * v[1] - se * v[2]
    out[5] = se * v[1] + ce * v[2]
    return st


@nb.njit(cache=True, parallel=True)
def elements_to_states(q, e, inc, node, peri, dt_peri, mu, obliquity):
    n = q.shape[0]
    out = np.empty((n, 6))
    status = np.zeros(n, dtype=np.int8)
    for i in nb.prange(n):
        status[i] = elements_to_state(q[i], e[i], inc[i], node[i], peri[i], dt_peri[i], mu, obliquity, out[i])
    return out, status


# ---------------------------------------------------------------------------------------------- ephemeris
@nb.njit(cache=True)
def _cheb_pos(data: np.ndarray, seg: np.ndarray, t: float, out: np.ndarray) -> bool:
    """Position from one SPK type-2 segment (seg = [offset, n, rsize, ncoef, initEt, intLen, startEt, endEt]),
    SPICE record selection and Clenshaw order (as app/src/core/ephemeris.ts). Adds into out."""
    if t < seg[6] or t > seg[7]:
        return False
    off = int(seg[0])
    n = int(seg[1])
    rsize = int(seg[2])
    nc = int(seg[3])
    r = int(math.floor((t - seg[4]) / seg[5]))
    if r > n - 1:
        r = n - 1
    if r < 0:
        r = 0
    base = off + r * rsize
    xx = (t - data[base]) / data[base + 1]
    x2 = 2.0 * xx
    for comp in range(3):
        c = base + 2 + comp * nc
        w1 = 0.0
        w2 = 0.0
        for j in range(nc - 1, 0, -1):
            w3 = w2
            w2 = w1
            w1 = data[c + j] + (x2 * w2 - w3)
        out[comp] += data[c] + (xx * w1 - w2)
    return True


@nb.njit(cache=True)
def perturber_positions(data, segs, chains, sun_chain, t, out) -> bool:
    """Heliocentric positions of every perturber at t: out[p] = X_p(t) - X_sun(t) (SSB chains of segments)."""
    sun = np.zeros(3)
    for k in range(sun_chain.shape[0]):
        if sun_chain[k] < 0:
            break
        if not _cheb_pos(data, segs[sun_chain[k]], t, sun):
            return False
    for p in range(chains.shape[0]):
        out[p, 0] = 0.0
        out[p, 1] = 0.0
        out[p, 2] = 0.0
        for k in range(chains.shape[1]):
            if chains[p, k] < 0:
                break
            if not _cheb_pos(data, segs[chains[p, k]], t, out[p]):
                return False
        out[p, 0] -= sun[0]
        out[p, 1] -= sun[1]
        out[p, 2] -= sun[2]
    return True


# ---------------------------------------------------------------------------------------------- forces
@nb.njit(cache=True)
def _ng_g(r: float, ng: np.ndarray) -> float:
    """Marsden et al. (1973) g(r) = ALN (r/R0)^-NM (1 + (r/R0)^NN)^-NK. ng = [A1, A2, A3, DT, ALN, R0, NM, NN, NK]."""
    u = r / ng[5]
    return ng[4] * u ** (-ng[6]) * (1.0 + u ** ng[7]) ** (-ng[8])


@nb.njit(cache=True)
def acceleration(x, v, rp, gm, mu_sun, c2inv, gr: bool, j2p, ng, has_ng: bool, a) -> None:
    """Kick acceleration (everything except the solar Kepler term), heliocentric frame, written into a:
    planets direct + indirect, zonal J2 of one perturber (j2p = [index, J2, R_ref, pole_x, pole_y, pole_z];
    index < 0 disables it), solar 1PN, non-gravitational."""
    a[0] = 0.0
    a[1] = 0.0
    a[2] = 0.0
    for p in range(rp.shape[0]):
        dx = rp[p, 0] - x[0]
        dy = rp[p, 1] - x[1]
        dz = rp[p, 2] - x[2]
        d2 = dx * dx + dy * dy + dz * dz
        d3 = d2 * math.sqrt(d2)
        rp2 = rp[p, 0] * rp[p, 0] + rp[p, 1] * rp[p, 1] + rp[p, 2] * rp[p, 2]
        rp3 = rp2 * math.sqrt(rp2)
        a[0] += gm[p] * (dx / d3 - rp[p, 0] / rp3)
        a[1] += gm[p] * (dy / d3 - rp[p, 1] / rp3)
        a[2] += gm[p] * (dz / d3 - rp[p, 2] / rp3)
    jp = int(j2p[0])
    if jp >= 0:
        # a = -(3/2) J2 GM R^2 / d^5 [ (1 - 5 z^2/d^2) d_vec + 2 z k ],  d_vec = x - x_p, z = d_vec . k
        dx = x[0] - rp[jp, 0]
        dy = x[1] - rp[jp, 1]
        dz = x[2] - rp[jp, 2]
        d2 = dx * dx + dy * dy + dz * dz
        z = dx * j2p[3] + dy * j2p[4] + dz * j2p[5]
        f = -1.5 * j2p[1] * gm[jp] * j2p[2] * j2p[2] / (d2 * d2 * math.sqrt(d2))
        c = 1.0 - 5.0 * z * z / d2
        a[0] += f * (c * dx + 2.0 * z * j2p[3])
        a[1] += f * (c * dy + 2.0 * z * j2p[4])
        a[2] += f * (c * dz + 2.0 * z * j2p[5])
    r2 = x[0] * x[0] + x[1] * x[1] + x[2] * x[2]
    r = math.sqrt(r2)
    if gr:
        v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
        rv = x[0] * v[0] + x[1] * v[1] + x[2] * v[2]
        k = mu_sun * c2inv / (r2 * r)
        c1 = 4.0 * mu_sun / r - v2
        c4 = 4.0 * rv
        a[0] += k * (c1 * x[0] + c4 * v[0])
        a[1] += k * (c1 * x[1] + c4 * v[1])
        a[2] += k * (c1 * x[2] + c4 * v[2])
    if has_ng:
        rr = r
        if ng[3] != 0.0:
            # g is evaluated at the heliocentric distance of time t - DT on the osculating two-body orbit.
            xd = x.copy()
            vd = v.copy()
            if kepler_drift(xd, vd, -ng[3], mu_sun, math.nan) == OK:
                rr = math.sqrt(xd[0] * xd[0] + xd[1] * xd[1] + xd[2] * xd[2])
        g = _ng_g(rr, ng)
        hx = x[1] * v[2] - x[2] * v[1]
        hy = x[2] * v[0] - x[0] * v[2]
        hz = x[0] * v[1] - x[1] * v[0]
        hn = math.sqrt(hx * hx + hy * hy + hz * hz)
        nx, ny, nz = hx / hn, hy / hn, hz / hn
        ux, uy, uz = x[0] / r, x[1] / r, x[2] / r
        tx = ny * uz - nz * uy
        ty = nz * ux - nx * uz
        tz = nx * uy - ny * ux
        a[0] += g * (ng[0] * ux + ng[1] * tx + ng[2] * nx)
        a[1] += g * (ng[0] * uy + ng[1] * ty + ng[2] * ny)
        a[2] += g * (ng[0] * uz + ng[1] * tz + ng[2] * nz)


# ---------------------------------------------------------------------------------------------- step control
@nb.njit(cache=True)
def substep_level(x, v, h, rp, rpe, gm, radius, mu_sun, eta_sun, eta_planet, eta_enc, enc_ratio,
                  kmax) -> tuple[int, float]:
    """How many times to halve a step of length h (signed), from the state at its start and the perturber positions
    at its start (rp) and end (rpe):
      tau_sun = sqrt(r_eff^3 / GM_sun), r_eff = max(q_osc, r - |v| |h|)             (perihelion passages)
      tau_p   = min(d_min / u, sqrt(d_min^3 / GM_p)), u = |v_p - v|, v_p = (rpe_p - rp_p) / h,
                d_min = max(closest distance on the straight relative path over the step, R_p)
    h_max = min(eta_sun tau_sun, min_p eta_p tau_p) with eta_p = eta_enc for a planet whose pull reaches enc_ratio
    times the Sun's (GM_p/d_min^2 vs GM_sun/r^2), else eta_planet; in encounter mode (any planet above enc_ratio)
    also h_max <= eta_enc tau_sun. level = ceil(log2(|h| / h_max)) in [0, kmax].
    Also returns the dominance ratio max_p (GM_p / d_min^2) / (GM_sun / r^2): how strongly a planet competes with
    the Sun during the step (the caller switches to the encounter integrator above a threshold)."""
    h_abs = abs(h)
    r = math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2])
    vn = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    hx = x[1] * v[2] - x[2] * v[1]
    hy = x[2] * v[0] - x[0] * v[2]
    hz = x[0] * v[1] - x[1] * v[0]
    h2 = hx * hx + hy * hy + hz * hz
    rv = x[0] * v[0] + x[1] * v[1] + x[2] * v[2]
    # eccentricity vector magnitude -> q = p / (1 + e)
    k1 = vn * vn - mu_sun / r
    ex = (k1 * x[0] - rv * v[0]) / mu_sun
    ey = (k1 * x[1] - rv * v[1]) / mu_sun
    ez = (k1 * x[2] - rv * v[2]) / mu_sun
    ecc = math.sqrt(ex * ex + ey * ey + ez * ez)
    q = (h2 / mu_sun) / (1.0 + ecc)
    r_eff = max(q, r - vn * h_abs)
    tau_sun = math.sqrt(r_eff * r_eff * r_eff / mu_sun)
    hmax = eta_sun * tau_sun
    lo = min(0.0, h)
    hi = max(0.0, h)
    dom = 0.0
    a_sun = mu_sun / (r * r)
    for p in range(rp.shape[0]):
        dx = rp[p, 0] - x[0]
        dy = rp[p, 1] - x[1]
        dz = rp[p, 2] - x[2]
        ux = (rpe[p, 0] - rp[p, 0]) / h - v[0]
        uy = (rpe[p, 1] - rp[p, 1]) / h - v[1]
        uz = (rpe[p, 2] - rp[p, 2]) / h - v[2]
        u2 = ux * ux + uy * uy + uz * uz
        tau_c = 0.0
        if u2 > 0.0:
            tau_c = min(max(-(dx * ux + dy * uy + dz * uz) / u2, lo), hi)
        cx = dx + ux * tau_c
        cy = dy + uy * tau_c
        cz = dz + uz * tau_c
        d_min = max(math.sqrt(cx * cx + cy * cy + cz * cz), radius[p])
        tau = math.sqrt(d_min * d_min * d_min / gm[p])
        if u2 > 0.0:
            tau = min(tau, d_min / math.sqrt(u2))
        dp = gm[p] / (d_min * d_min) / a_sun
        hmax = min(hmax, (eta_enc if dp > enc_ratio else eta_planet) * tau)
        dom = max(dom, dp)
    if dom > enc_ratio:
        # encounter mode integrates the full equations with RK4, which also has to resolve the solar orbit
        hmax = min(hmax, eta_enc * tau_sun)
    if h_abs <= hmax:
        return 0, dom
    lvl = int(math.ceil(math.log2(h_abs / hmax)))
    return min(max(lvl, 0), kmax), dom


# ---------------------------------------------------------------------------------------------- integrator
@nb.njit(cache=True)
def saba_step(x, v, t, h, drift_c, kick_d, data, segs, chains, sun_chain, gm, radius, mu_sun, c2inv, gr, j2p,
              ng, has_ng, rp, a) -> int:
    """One SABA_n step of length h from time t: drift c0 h, kick d0 h, drift c1 h, ..., drift c_n h.
    Kicks are evaluated at the running time (the drifts carry the clock). Returns a status code."""
    tc = t
    nk = kick_d.shape[0]
    for i in range(nk + 1):
        dt = drift_c[i] * h
        if dt != 0.0:
            if kepler_drift(x, v, dt, mu_sun, math.nan) != OK:
                return NO_CONVERGENCE
        tc += dt
        if i == nk:
            break
        if not perturber_positions(data, segs, chains, sun_chain, tc, rp):
            return NO_EPHEMERIS
        r2 = x[0] * x[0] + x[1] * x[1] + x[2] * x[2]
        if r2 < radius[rp.shape[0]] ** 2:
            return COLLIDED
        for p in range(rp.shape[0]):
            dx = rp[p, 0] - x[0]
            dy = rp[p, 1] - x[1]
            dz = rp[p, 2] - x[2]
            if dx * dx + dy * dy + dz * dz < radius[p] * radius[p]:
                return COLLIDED
        acceleration(x, v, rp, gm, mu_sun, c2inv, gr, j2p, ng, has_ng, a)
        k = kick_d[i] * h
        v[0] += k * a[0]
        v[1] += k * a[1]
        v[2] += k * a[2]
    return OK


@nb.njit(cache=True)
def _total_accel(x, v, t, data, segs, chains, sun_chain, gm, radius, mu_sun, c2inv, gr, j2p, ng, has_ng, rp,
                 a) -> int:
    """Full heliocentric acceleration (Sun + kick terms) at (x, v, t) into a; status code."""
    if not perturber_positions(data, segs, chains, sun_chain, t, rp):
        return NO_EPHEMERIS
    r2 = x[0] * x[0] + x[1] * x[1] + x[2] * x[2]
    if r2 < radius[rp.shape[0]] ** 2:
        return COLLIDED
    for p in range(rp.shape[0]):
        dx = rp[p, 0] - x[0]
        dy = rp[p, 1] - x[1]
        dz = rp[p, 2] - x[2]
        if dx * dx + dy * dy + dz * dz < radius[p] * radius[p]:
            return COLLIDED
    acceleration(x, v, rp, gm, mu_sun, c2inv, gr, j2p, ng, has_ng, a)
    k = -mu_sun / (r2 * math.sqrt(r2))
    a[0] += k * x[0]
    a[1] += k * x[1]
    a[2] += k * x[2]
    return OK


@nb.njit(cache=True)
def rk4_step(x, v, t, h, data, segs, chains, sun_chain, gm, radius, mu_sun, c2inv, gr, j2p, ng, has_ng, rp,
             a) -> int:
    """Classical 4th-order Runge-Kutta step on the full equations (encounter mode: a planet competes with the Sun,
    so the Sun-centred splitting loses its advantage)."""
    k1v = np.empty(3)
    k2v = np.empty(3)
    k3v = np.empty(3)
    k4v = np.empty(3)
    xs = np.empty(3)
    vs = np.empty(3)
    st = _total_accel(x, v, t, data, segs, chains, sun_chain, gm, radius, mu_sun, c2inv, gr, j2p, ng, has_ng, rp, k1v)
    if st != OK:
        return st
    for j in range(3):
        xs[j] = x[j] + 0.5 * h * v[j]
        vs[j] = v[j] + 0.5 * h * k1v[j]
    k2x = vs.copy()
    st = _total_accel(xs, vs, t + 0.5 * h, data, segs, chains, sun_chain, gm, radius, mu_sun, c2inv, gr, j2p, ng,
                      has_ng, rp, k2v)
    if st != OK:
        return st
    for j in range(3):
        xs[j] = x[j] + 0.5 * h * k2x[j]
        vs[j] = v[j] + 0.5 * h * k2v[j]
    k3x = vs.copy()
    st = _total_accel(xs, vs, t + 0.5 * h, data, segs, chains, sun_chain, gm, radius, mu_sun, c2inv, gr, j2p, ng,
                      has_ng, rp, k3v)
    if st != OK:
        return st
    for j in range(3):
        xs[j] = x[j] + h * k3x[j]
        vs[j] = v[j] + h * k3v[j]
    k4x = vs.copy()
    st = _total_accel(xs, vs, t + h, data, segs, chains, sun_chain, gm, radius, mu_sun, c2inv, gr, j2p, ng, has_ng,
                      rp, k4v)
    if st != OK:
        return st
    for j in range(3):
        x[j] += h / 6.0 * (v[j] + 2.0 * k2x[j] + 2.0 * k3x[j] + k4x[j])
        v[j] += h / 6.0 * (k1v[j] + 2.0 * k2v[j] + 2.0 * k3v[j] + k4v[j])
    return OK


@nb.njit(cache=True)
def next_boundary(t: float, t1: float, grid0: float, H: float) -> float:
    """End of the next step from t toward t1 on the grid grid0 + m H (H > 0): the next grid point, or t1."""
    if t1 > t:
        m = math.floor((t - grid0) / H)
        g = grid0 + (m + 1.0) * H
        if g <= t:
            g += H
        return min(g, t1)
    m = math.ceil((t - grid0) / H)
    g = grid0 + (m - 1.0) * H
    if g >= t:
        g -= H
    return max(g, t1)


@nb.njit(cache=True)
def propagate_one(x, v, t0, t1, grid0, H, drift_c, kick_d, data, segs, chains, sun_chain, gm, radius, mu_sun,
                  c2inv, gr, j2p, ng, has_ng, eta_sun, eta_planet, eta_enc, kmax, enc_ratio, stats) -> int:
    """Propagate (x, v) in place from t0 to t1: steps end on the grid grid0 + m H (the first and last may be
    partial); each step of length h is split into 2^level equal substeps (substep_level at the step's start):
    SABA substeps, or RK4 substeps when a planet's pull reaches enc_ratio times the Sun's during the step.
    stats[0] += substeps taken, stats[1] = max level used, stats[2] += encounter (RK4) substeps."""
    npert = gm.shape[0]
    rp = np.empty((npert, 3))
    rpe = np.empty((npert, 3))
    a = np.empty(3)
    t = t0
    while t != t1:
        te = next_boundary(t, t1, grid0, H)
        h = te - t
        if not perturber_positions(data, segs, chains, sun_chain, t, rp):
            return NO_EPHEMERIS
        if not perturber_positions(data, segs, chains, sun_chain, te, rpe):
            return NO_EPHEMERIS
        lvl, dom = substep_level(x, v, h, rp, rpe, gm, radius, mu_sun, eta_sun, eta_planet, eta_enc, enc_ratio, kmax)
        nsub = 1 << lvl
        hs = h / nsub
        enc = dom > enc_ratio
        for j in range(nsub):
            ts = t + j * hs
            if enc:
                st = rk4_step(x, v, ts, hs, data, segs, chains, sun_chain, gm, radius, mu_sun, c2inv, gr, j2p, ng,
                              has_ng, rp, a)
            else:
                st = saba_step(x, v, ts, hs, drift_c, kick_d, data, segs, chains, sun_chain, gm, radius, mu_sun,
                               c2inv, gr, j2p, ng, has_ng, rp, a)
            if st != OK:
                return st
        stats[0] += nsub
        if enc:
            stats[2] += nsub
        if lvl > stats[1]:
            stats[1] = lvl
        t = te
    return OK


@nb.njit(cache=True, parallel=True)
def propagate_many(states, t0, t1, grid0, H, drift_c, kick_d, data, segs, chains, sun_chain, gm, radius, mu_sun,
                   c2inv, gr, j2p, ng, has_ng, eta_sun, eta_planet, eta_enc, kmax, enc_ratio):
    """propagate_one for every row of states (N, 6) from t0[i] to t1 (in place). Returns (status, stats (N, 3))."""
    n = states.shape[0]
    status = np.zeros(n, dtype=np.int8)
    stats = np.zeros((n, 3), dtype=np.int64)
    for i in nb.prange(n):
        x = states[i, 0:3].copy()
        v = states[i, 3:6].copy()
        st = propagate_one(x, v, t0[i], t1, grid0, H, drift_c, kick_d, data, segs, chains, sun_chain, gm, radius,
                           mu_sun, c2inv, gr, j2p, ng[i], has_ng[i], eta_sun, eta_planet, eta_enc, kmax, enc_ratio,
                           stats[i])
        status[i] = st
        if st == OK:
            states[i, 0:3] = x
            states[i, 3:6] = v
        else:
            states[i, :] = np.nan
    return status, stats


@nb.njit(cache=True, parallel=True)
def drift_many(states, t0, t1, mu):
    """Two-body (Sun only) drift of every row of states (N, 6) from t0[i] to t1[i], in place; status per row."""
    n = states.shape[0]
    status = np.zeros(n, dtype=np.int8)
    for i in nb.prange(n):
        x = states[i, 0:3].copy()
        v = states[i, 3:6].copy()
        status[i] = kepler_drift(x, v, t1[i] - t0[i], mu, math.nan)
        states[i, 0:3] = x
        states[i, 3:6] = v
    return status
