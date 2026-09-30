# Mallama & Hilton (2018) planetary magnitude equations (`mallama-hilton-2018`) — transcription

**Citation:** Mallama, A. & Hilton, J. L. (2018). Computing apparent planetary magnitudes for The Astronomical Almanac. *Astronomy and Computing* 25, 10–24. DOI [10.1016/j.ascom.2018.08.002](https://doi.org/10.1016/j.ascom.2018.08.002) (arXiv:1808.01973, revised 2018 June 21). Reference code: Ap_Mag V3, `https://sourceforge.net/projects/planetary-magnitudes/` → `Ap_Mag_Current_Version/Ap_Mag_V3.f90` (fetched; the SourceRecord's sha256 is of this file).

**Transcribed:** Eqs. 2–17 (Sec. 3) into `pipeline/src/pipeline/photometry/tables/mallama_hilton_2018.json`: constants, polynomial coefficients, validity ranges, and notes on which pieces are assumptions. `phase.verify_against_code()` (run by the `light` stage and `tests/test_photometry_tables.py`) checks that every coefficient appears verbatim in `Ap_Mag_V3.f90`. One known difference: Saturn Eq. 12 cubic term, paper −1.505e-6, code −1.506e-6 (≤ 0.004 mag at 150°); the paper's value is used.

**Use (phase functions in `photometry.json`):**

| body | representation | label | why |
|---|---|---|---|
| Mercury | poly-mag, 2–170°, c0 = +0.081 | measured | Eq. 2 fits SOHO + ground data; its constant (−0.613) excludes the opposition surge, so it is referred to the surge-inclusive −0.694 |
| Venus | tabulated 0–179° (0.5°) | measured | Eqs. 3–4, piecewise |
| Earth | poly-mag 0–170° | estimated | Eq. 5 is a fit to a radiative-transfer model (Tinetti et al. 2006) |
| Mars | tabulated 0–120° | estimated | Eq. 6 measured to 50°; Eq. 7 beyond is an average of Mercury and Earth (assumption); L(λe), L(Ls) not represented |
| Jupiter | tabulated 0–130° | measured | Eq. 8 ground + Eq. 9 Cassini ISS |
| Saturn (globe) | tabulated 0–150° | estimated | Eq. 11 borrows Jupiter's polynomial; Eq. 12 fits a Pioneer-based model |
| Uranus | poly-mag 0–154° | measured | Eq. 15 phase term (Voyager); applied at all α (Horizons applies it only above 3.1°) |
| Neptune | poly-mag 0–133.14° | measured | Eq. 17 phase term (Voyager); applied at all α (Horizons: only above 1.9°) |

The schema allows one label per phase function, so a curve with any assumed piece is labelled `estimated` as a whole; the method string says which ranges are measured.

**Verification:** with Horizons' own geometry our reimplementation reproduces Horizons APmag to ≤ 0.001 mag for all planets except Mars (Horizons adds L(λe), L(Ls)); see `tests/test_photometry_horizons.py`.
