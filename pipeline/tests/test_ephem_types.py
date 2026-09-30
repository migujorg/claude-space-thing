"""SPK type 17 (precessing equinoctial conic) evaluation vs SPICE's EQNCPV, on random elements (no data needed)."""

import math

import numpy as np
import spiceypy as sp

from pipeline.ephem_spk import eqncpv


def test_eqncpv_matches_spice_on_random_elements():
    rng = np.random.default_rng(3)
    wp = wv = 0.0
    for _ in range(500):
        a = rng.uniform(1e4, 2e7)
        e = rng.uniform(0, 0.85)
        inc = rng.uniform(0, 3.0)
        node, argp, m0 = rng.uniform(0, 2 * np.pi, 3)
        dargp, dnode = rng.uniform(-1e-7, 1e-7, 2)
        dmdt = rng.uniform(1e-8, 1e-3)
        eqel = [a, e * math.sin(argp + node), e * math.cos(argp + node), m0 + argp + node,
                math.tan(inc / 2) * math.sin(node), math.tan(inc / 2) * math.cos(node),
                dargp + dnode, dargp + dmdt + dnode, dnode]
        ra, dec = rng.uniform(0, 2 * np.pi), rng.uniform(-1.5, 1.5)
        epoch = rng.uniform(-1e8, 1e8)
        et = epoch + rng.uniform(-3e8, 3e8)
        ref = np.array(sp.eqncpv(et, epoch, eqel, ra, dec))
        mine = eqncpv(et, np.array([epoch] + eqel + [ra, dec]))
        wp = max(wp, np.linalg.norm(mine[:3] - ref[:3]) / a)
        wv = max(wv, np.linalg.norm(mine[3:] - ref[3:]) / np.linalg.norm(ref[3:]))
    print(f"eqncpv vs SPICE: max relative position {wp:.2e}, velocity {wv:.2e}")
    assert wp < 1e-10 and wv < 1e-10
