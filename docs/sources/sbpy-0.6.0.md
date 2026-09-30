# sbpy-0.6.0: IAU H-G and H-G1-G2 phase functions (sbpy 0.6.0 source)

- **URL:** https://files.pythonhosted.org/packages/5e/90/a8bb907907a34e0683441f6750a224849cc6b4841f3eb6ed3c2a319d1b23/sbpy-0.6.0.tar.gz (PyPI sdist; cached as `data/raw/sbpy/sbpy-0.6.0.tar.gz`, sha256 3b88a53688a26bc2b572e1f4543fdae4fe2f4fe6c305085432dcc7ff614c6cb7, which equals the digest PyPI publishes). Licence BSD-3-Clause.
- **Citation:** Mommert, M. et al. (2019). sbpy: A Python module for small-body planetary astronomy. Journal of Open Source Software 4(38), 1426. DOI:10.21105/joss.01426.
- **Functions it implements:** Bowell, E. et al. (1989). Application of photometric models to asteroids. In *Asteroids II*, 524–556, Eq. A4 (the IAU H-G system); Muinonen, K. et al. (2010). A three-parameter magnitude phase function for asteroids. Icarus 209, 542–555. DOI:10.1016/j.icarus.2010.04.003 (H-G1-G2).

## What is used

The `sbphotometry` stage (`pipeline/src/pipeline/stages/sbphotometry.py`) reads `sbpy/photometry/iau.py` from the tarball (no sbpy install, no code execution):

- **H-G** (class `HG`, method `_hgphi`): A = [3.332, 1.862], B = [0.631, 1.218], C = [0.986, 0.238], W = 90.56 and the small-phase denominator 0.119 + 1.341 sin α − 0.754 sin² α. They are parsed with regular expressions that also check the expression shapes, so a changed formula fails the build instead of being misread.
- **H-G1-G2** (class `HG12BaseClass`, `_phi1v`, `_phi2v`, `_phi3v`): spline nodes, values and end derivatives, parsed with Python's `ast`. The per-interval cubic coefficients are rebuilt with sbpy's own construction (clamped cubic spline, linear beyond the end nodes, negative values clipped to 0). The build checks the linear pieces against Muinonen et al. (2010) Eqs. 17–18 (Φ1 = 1 − 6α/π, Φ2 = 1 − 9α/(5π) below 7.5°).

All of it goes to `smallbodies/photometry.json` (`hg`, `hg1g2`). `app/tests/smallbody-photometry.test.ts` checks the app's implementation against values the stage computes with the same formulas: they agree to 1e-16.

## Caveat

JPL Horizons' APmag uses the two-exponential approximation of the H-G law, without the small-phase term. The two forms differ by up to 0.02 mag below ~10° phase and by less than 0.006 mag beyond 15° (measured in the test above).
