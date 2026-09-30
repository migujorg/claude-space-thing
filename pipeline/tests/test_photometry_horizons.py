"""Cross-check against JPL Horizons APmag (which implements Mallama & Hilton 2018 for the planets).

Uses Horizons responses saved under tests/fixtures/horizons/ (2026-09-30, 2027-01-15, 2027-06-01 00:00 UT; Earth
observed from Mars, everything else from the geocentre). Regenerate with
`uv run python -c "from pipeline.photometry import horizons; horizons.save_fixtures()"`.
"""

import pytest

from pipeline.photometry import bodies, horizons


@pytest.fixture(scope="module")
def comparisons():
    ids = list(bodies.PLANETS)     # the moons are checked in test_photometry_moons.py
    return horizons.compare(bodies.build_all(None, ids), horizons.load_fixtures(ids))


def test_mh_reimplementation_reproduces_horizons(comparisons):
    """Our reimplementation of the Mallama & Hilton equations + Horizons' own geometry reproduces APmag. Mars differs
    by Horizons' rotational/seasonal L(λe), L(Ls) terms, which we do not model (≤ 0.08 mag here)."""
    for c in comparisons:
        if c.mh is None or c.horizons is None:
            continue
        tol = 0.1 if c.naif == 499 else 0.0015
        assert abs(c.mh - c.horizons) <= tol, (c.name, c.row.date, c.mh, c.horizons)


# Our prediction minus Horizons, per body: (min, max) over the three epochs. These are the measured, reported
# differences (docs/reports/planet-colors.md), bounded to catch regressions.
EXPECTED = {
    "Mercury": (0.00, 0.05),    # p_V 0.137 vs 0.142 (Mallama et al. 2017)
    "Venus": (-0.02, 0.02),
    "Earth": (0.58, 0.70),      # Himawari-9 measured albedo (p_V 0.24) vs Mallama's EPOXI + model-phase-curve V1(0) = -3.99
    "Moon": (0.0, 0.12),        # ROLO level (to 97°, Lane & Irvine shape beyond) vs Horizons' lunar law
    "Mars": (0.0, 0.10),        # Horizons adds L(λe), L(Ls)
    "Jupiter": (-0.04, 0.0),
    "Saturn": (0.10, 0.32),     # Horizons includes the rings (α < 6.5°); we give the globe
    "Uranus": (-0.05, 0.0),
    "Neptune": (0.0, 0.06),     # 1995 spectrum; Neptune brightened until ~2000
    "Pluto": (0.10, 0.25),      # Horizons' Pluto+Charon law vs HST 2002-3 photometry + Charon
}


def test_predictions_vs_horizons(comparisons):
    seen = set()
    for c in comparisons:
        if c.ours is None or c.horizons is None:
            continue
        lo, hi = EXPECTED[c.name]
        d = c.ours - c.horizons
        assert lo <= d <= hi, (c.name, c.row.date, round(d, 3))
        seen.add(c.name)
    assert seen == set(EXPECTED)
