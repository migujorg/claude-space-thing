"""SPK exact-state comparison helpers, their endpoint rules, and type 17 vs SPICE EQNCPV."""

import math

import numpy as np
import pytest
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


# Scan of all 14 de442s and 464 satellite type 2/3 product endpoints: maximum 8 ulps
# in position, 3 in velocity (satellite excerpts: 0); 10 allows a small margin.
# Only a trimmed final record boundary may use this bound: full-kernel SPICE selects
# the neighbouring polynomial, while the product retains the polynomial ending there.
ENDPOINT_ULPS = 10


def bit_mismatches(actual, expected, ets, context):
    """Collect every unequal state component, including signed-zero differences."""
    a, b = actual.view(np.uint64), expected.view(np.uint64)
    return [
        f"{context}, et {ets[i]!r}, {'pos' if j < 3 else 'vel'}[{j % 3}]: "
        f"ours 0x{a[i, j]:016x}, reference 0x{b[i, j]:016x}"
        for i, j in np.argwhere(a != b)
    ]


def compare_spice(s, source, ets, spice, context, failures):
    """Exact states except where full-kernel SPICE selects an omitted following record.

    At the final endpoint, independently evaluate the source's retained ending record
    and require all six bits to match, even when the SPICE comparison is bounded.
    Append failures so callers check every segment before failing.
    """
    from dataclasses import replace

    from pipeline.ephem_spk import evaluate

    pos, vel = evaluate(s, ets)
    actual = np.concatenate([pos, vel], axis=1)
    dp = np.linalg.norm(pos - spice[:, :3], axis=1).max()
    dv = np.linalg.norm(vel - spice[:, 3:], axis=1).max()
    if not dp < 1e-6 or not dv < 1e-9:
        failures.append(f"{context}: max |dpos| {dp!r} km, |dvel| {dv!r} km/s")
    if s.type not in (2, 3):
        return dp, dv

    final = ets == s.end
    i0 = (s.init - source.init) / s.intlen
    if i0 != int(i0) or not 0 <= i0 or int(i0) + s.n > source.n:
        failures.append(f"{context}: product records do not align with the source")
        return dp, dv
    last = int(i0) + s.n - 1
    switches = s.end == s.init + s.n * s.intlen and last + 1 < source.n
    bounded = final & switches
    failures.extend(bit_mismatches(actual[~bounded], spice[~bounded], ets[~bounded], context + ' vs SPICE'))

    if np.any(final):
        # One source record forces the same clamped endpoint selection as the product;
        # evaluating source whole would select its following record at this boundary.
        ending = replace(source, init=source.init + last * source.intlen, records=source.records[last:last + 1])
        p, v = evaluate(ending, ets[final])
        failures.extend(bit_mismatches(actual[final], np.concatenate([p, v], axis=1), ets[final],
                                       context + ' vs source ending record'))
    if np.any(bounded):
        a, b = actual[bounded], spice[bounded]
        # Each component's ulp is the spacing at max(|ours|, |SPICE|), including zero.
        ulps = np.abs(a - b) / np.spacing(np.maximum(np.abs(a), np.abs(b)))
        for i, j in np.argwhere(~(ulps <= ENDPOINT_ULPS)):
            failures.append(f"{context}, et {ets[bounded][i]!r}, component {j}: "
                            f"endpoint difference {ulps[i, j]!r} ulps > {ENDPOINT_ULPS}")
    return dp, dv


# These records are synthetic test inputs, never data products. Exercise both the
# permitted neighbouring polynomial and rejection of interior/same-record errors.
@pytest.mark.parametrize('typ', [2, 3])
def test_exact_comparison_distinguishes_retained_and_following_records(typ):
    from dataclasses import replace

    from pipeline.ephem_spk import Segment, evaluate

    fields = 3 if typ == 2 else 6
    records = np.zeros((2, 2 + fields * 2))
    records[:, :2] = [[0.5, 0.5], [1.5, 0.5]]
    records[:, 2] = [1.0, np.nextafter(1.0, np.inf)]
    source = Segment(1, 0, 1, typ, 0.0, 1.0, records.shape[1], records)
    product = replace(source, records=records[:1])
    ets = np.array([0.0, 0.5, 1.0])
    p, v = evaluate(source, ets)
    spice = np.concatenate([p, v], axis=1)
    failures = []
    compare_spice(product, source, ets, spice, 'test', failures)
    assert failures == []

    wrong = spice.copy()
    wrong[:2, 0] = np.nextafter(wrong[:2, 0], np.inf)
    compare_spice(product, source, ets, wrong, 'test', failures)
    assert len(failures) == 2  # both start and interior failures collected
    assert '0.0' in failures[0] and '0.5' in failures[1]

    corrupt = records[:1].copy()
    corrupt[0, 2] = np.nextafter(1.0, np.inf)
    failures = []
    compare_spice(replace(product, records=corrupt), source, ets, spice, 'test', failures)
    assert any('source ending record' in f for f in failures)  # bounded SPICE agreement cannot hide corruption

    # A final endpoint without an omitted following record remains bit-exact.
    failures = []
    wrong = np.concatenate(evaluate(product, ets), axis=1)
    wrong[-1, 0] = np.nextafter(wrong[-1, 0], np.inf)
    compare_spice(product, product, ets, wrong, 'test', failures)
    assert len(failures) == 1 and 'vs SPICE' in failures[0]

    # The endpoint bound is enforced, rather than accepting any small absolute error.
    failures = []
    wrong = spice.copy()
    for _ in range(ENDPOINT_ULPS + 1):
        wrong[-1, 0] = np.nextafter(wrong[-1, 0], np.inf)
    compare_spice(product, source, ets, wrong, 'test', failures)
    assert len(failures) == 1 and 'endpoint difference' in failures[0]
