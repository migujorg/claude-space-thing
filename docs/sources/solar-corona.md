# Solar corona: K-corona and F-corona near the Sun (sky)

Used by the `sky` stage for `sky/corona.json` (`pipeline/src/pipeline/sky_corona.py`; report: docs/reports/sky.md
§5). SourceRecord ids: `vandehulst-1950`, `inhester-2015`, `silso-sn-ms-v2`, `noaa-swpc-predicted-cycle` (K-corona),
`lamy-2022`, `leinert-1998`, `kelsall-1998` (F-corona), `saito-1977` (independent check), plus `tsis1-hsrs-v2`,
`neckel-labs-1994` and the CIE records for the colour. Numbers from papers are transcribed in
`pipeline/src/pipeline/sky_tables/`, each file headed by its citation and pages; the tests check each transcription
against the paper's own arithmetic.

## van de Hulst 1950: `vandehulst-1950`

- **What:** "The electron density of the solar corona". It is the classic model of the K-corona at solar maximum and
  minimum, from Baumbach's compilation of eclipse photometry (F-corona removed with Grotrian's line-depth measures)
  and new photoelectric absolute totals.
- **Citation:** van de Hulst H. C. 1950, Bull. Astron. Inst. Netherlands 11, 135–150 (No. 410), ADS
  1950BAN....11..135V.
- **Retrieval:** ADS scan through `download.fetch` →
  `data/raw/sky/papers/vandehulst1950_ban11_135.pdf`. ADS delivers pages 135–140, which hold everything used; the
  density table (his Table 5) is on later pages and is not used.
- **Transcribed** (`sky_tables/vandehulst_1950.json`):
  - Eqs. 4–9 (p. 139): K_max, K_min (equatorial), F, K_pole + F and K_pole as sums of power laws in r, in units of
    10⁻⁸ of the mean surface brightness of the Sun.
  - The phase model (p. 138):
    - At minimum, equatorial regions cover 0.7 of the circumference and polar regions 0.3.
    - At maximum, K_max = c K_min, circular, with c = 1.78.
    - The phase is Mitchell's: 0 at minimum, 1 at maximum, linear in time.
    - The polar corona is separated from the equatorial one by a density minimum near 70° latitude (abstract).
  - Table I (p. 138): total brightness of rings.
  - The observed totals (p. 137): visual 0.47–0.72 full moon, i.e. 1.07–1.66 × 10⁻⁶ of the Sun, from minimum to
    maximum.
  - The radii where K = F (p. 140).
- **Checks:**
  - Eq. 10 applied to Eqs. 5–9 reproduces every Table I entry to its rounding (≤ 0.0025).
  - Eq. 8 = Eq. 7 + Eq. 9.
  - K_max/K_min = 1.778 for every term. The laws were made as c^½ and c^−½ times one law (p. 139).
  - K = F falls at 2.24 / 1.92 / 1.28 R⊙, against the paper's 2.24 / 1.93 / 1.28.
- **Label:** the brightness laws are measured; the electron densities inverted from them and the phase interpolation
  are `estimated`.

## Inhester 2015: `inhester-2015`

- **What:** "Thomson scattering in the solar corona", lecture notes (arXiv:1512.00651). App. A gives the closed forms
  of the irradiance integrals of a linearly limb-darkened Sun. These are Minnaert's (1930) A, B, C, D coefficients,
  and the relation to van de Hulst's normalisation to the mean disk brightness, B⊙ = I₀ (1 − u/3).
- **Retrieval:** `https://arxiv.org/pdf/1512.00651v1` → `data/raw/sky/papers/inhester2015_arXiv1512.00651v1.pdf`.
- **Use:** the Thomson kernel in `sky_corona.kernel` and `render/sky/corona.ts`. The tests compare it with a direct
  numerical integration over the limb-darkened disk (agreement 3 × 10⁻⁵).

## Solar-cycle epochs: `silso-sn-ms-v2`, `noaa-swpc-predicted-cycle`

- **SILSO:** the 13-month smoothed monthly total sunspot number, v2.0
  (`https://www.sidc.be/SILSO/DATA/SN_ms_tot_V2.0.csv`, CC BY-NC 4.0).
  - Minimum of cycle 24/25: 2019-12 (1.8).
  - Maximum of cycle 25: 2024-10 (160.9).
  - The epochs of cycle 20 date Saito et al.'s Skylab data (phase 0.33).
- **NOAA SWPC:** `predicted-solar-cycle.json`, predicted smoothed sunspot number per month to 2030-12. It still falls
  at its last month (8.1), so the next minimum is taken as 2030-12 (a lower bound).
  - The 2027-08 value (72.0) gives an activity fraction of 0.44. This is a sensitivity check against the time phase
    0.547.
- Both files update monthly. The copies in `data/raw/sky/solar_cycle/` are kept (sha256 in the ledger); delete them
  to refresh.

## Lamy et al. 2022: `lamy-2022`

- **What:** "Observations of the Solar F-corona from Space", a review with 25 years of LASCO-C2/C3 photometry.
  - The characteristic equatorial and polar profiles are power laws with exponents −2.33 and −2.55 from 5° to 50°
    elongation, connecting to the zodiacal light.
  - Appendix D, Table 5: the LASCO reference map of the F-corona for an observer at 1 AU in the plane of symmetry,
    450–600 nm, uncertainty 5 %.
- **Citation:** Lamy P. L., Gilardy H., Llebaria A., Quémerais E. & Ernandez F. 2022, Space Sci. Rev. 218, 53,
  DOI 10.1007/s11214-022-00914-w; arXiv:2202.11533.
- **Retrieval:** `https://arxiv.org/pdf/2202.11533v2` → `data/raw/sky/papers/lamy2022_arXiv2202.11533v2.pdf`.
- **Transcribed:** `sky_tables/lamy_2022_table5.json` has the two 7 × 7 blocks, 88 values, plus the profile
  exponents and 1 S10⊙ = 4.5 × 10⁻¹⁶ B⊙.
- **Axes:** as printed, the profile along the rows (labelled λ − λ⊙) falls with the polar exponent. The profile along
  the columns (labelled β) is both the shallower and the brighter at equal elongation (0.450 at (1°, 5°), 0.218 at
  (5°, 1°)). The text says the map's major axis is equatorial (Sect. 4.2), gives −2.33 equatorial and −2.55 polar,
  and finds the map in agreement with the Koutchmy–Lamy model and Cox (2000), both brighter along the equator.
  - The pipeline reads the rows as β and the columns as λ − λ⊙.
  - Read that way, the fitted law has local slopes −2.21 (equator) and −2.47 (pole) at 3–7.5°, and a flattening
    that grows with elongation from round at 2 R⊙. The tests assert this orientation.

## Saito, Poland & Munro 1977: `saito-1977`

- **What:** "A study of the background corona near solar minimum". It uses the Skylab HAO coronagraph, May 1973 –
  February 1974, 2.5–5.5 R⊙.
  - Table I: pB and N_e coefficients.
  - Table II: the equatorial background N_e, pB, B_K, B_K+F and B_F, with the Newkirk–Saito densities.
  - Table III: the polar values, spherically symmetric and axisymmetric.
- **Citation:** Solar Phys. 55, 121–134 (1977), DOI 10.1007/BF00150879.
- **Retrieval:** ADS scan → `data/raw/sky/papers/saito1977_soph55_121.pdf`.
- **Transcribed:** `sky_tables/saito_1977.json`. Values in parentheses in the paper are extrapolations and are
  flagged.
  - Check: the Table I coefficients give Table II's N_e to 2 %.
  - Check: B_K + B_F = B_K+F to the tables' 2-digit rounding.
- **Use:** independent measurements for both coronae (docs/reports/sky.md §5.3). Not used to build anything.

## Leinert et al. 1998, Table 23 (`leinert-1998`, existing record)

- Sect. 9 and Table 23 (pp. 52–55): the recommended F-corona approximation. At 4 R⊙ and 500 nm it is
  2.8 × 10⁻² W m⁻² sr⁻¹ µm⁻¹ at the equator (r^−2.5) and 1.8 × 10⁻² at the pole (r^−2.8), with 1 × 10⁻⁹ B⊙ = 2.84 × 10⁻²
  W m⁻² sr⁻¹ µm⁻¹.
- Unit relations (p. 53): 1 B⊙ = 2.22 × 10¹⁵ S10⊙ = 1.47 × 10⁴ F⊙/sr.
- Koutchmy & Lamy's slopes (p. 54).
- Added to `sky_tables/leinert_1998.json` as `f_corona_table23`. The units are checked against Table 2.
- Used only as a comparison. Lamy et al. (2022) find these profiles "clearly off the main trend", and they are
  35–45 % below LASCO, Skylab and van de Hulst.

## Not used

- The Baumbach–Allen density formula. Baumbach's brightness law includes the F-corona (van de Hulst p. 136), so its
  outer electron densities are too high. It is used in van de Hulst's corrected form (Eqs. 5–9).
- Saito (1970), "A non-uniform coronal model": the ADS scan refuses scripted clients (403).
- Allen's *Astrophysical Quantities* (Cox 2000) Tables 14.19 and 13.8: not accessible. Lamy et al. (2022) compare the
  LASCO map with them and find excellent agreement.
- Parker Solar Probe WISPR (Howard et al. 2019; Stenborg et al. 2021): a slope of −2.30 down to 25° from 0.17–0.34 AU,
  and a dust-depletion zone that lowers the F-corona seen from inside ~0.1 AU. The model's F-corona for observers
  that close to the Sun is the zodiacal model alone, without that depletion (docs/reports/sky.md §7).
