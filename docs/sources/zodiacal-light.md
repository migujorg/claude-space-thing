# Zodiacal light: Leinert et al. 1998 and Kelsall et al. 1998 (sky)

Used by the `sky` stage for `sky/zodiacal.json`. SourceRecord ids: `leinert-1998`, `kelsall-1998` (plus
`tsis1-hsrs-v2`, `edlen-1966` and the CIE records for the colour conversion).

## Leinert et al. 1998 — `leinert-1998`

- **What:** "The 1997 reference of diffuse night sky brightness" — the standard compilation of zodiacal light,
  integrated starlight, diffuse galactic light, airglow and conversion constants.
- **Citation:** Leinert Ch., Bowyer S., Haikala L. K., Hanner M. S., Hauser M. G., Levasseur-Regourd A.-Ch.,
  Mann I., Mattila K., Reach W. T., Schlosser W., Staude H. J., Toller G. N., Weiland J. L., Weinberg J. L. &
  Witt A. N. 1998, A&AS 127, 1–99, DOI 10.1051/aas:1998105.
- **Retrieval:** the publisher (aas.aanda.org, EDP) answers scripted clients with 403, IOP-hosted copies with a
  bot check, and the ADS scan service did not deliver; the published PDF (journal pagination, 99 pages, with a
  text layer) was fetched through `download.fetch` from the SciSpace mirror
  `https://scispace.com/pdf/the-1997-reference-of-diffuse-night-sky-brightness-2cwpnhnl1d.pdf` with a browser
  User-Agent, sha256 `46244db7c3c9f9dd62f5944ecd6ef2ea16a39bae2d6b5ac7d4b04d95ade412c0` (2026-09-30), stored
  as `data/raw/sky/papers/leinert1998_aas127_1.pdf`. The stage cites that digest if the mirror later refuses.
  VizieR `J/A+AS/127/1` holds only the IRAS maps, not these tables.
- **Transcribed** (pipeline/src/pipeline/sky_tables/, each file headed by its citation and page):
  - `leinert_1998_table16.csv`: Table 16, p. 36 — zodiacal light seen from the Earth, S10⊙ at 500 nm, annual
    average, 19 helioecliptic longitudes (λ − λ⊙ = 0…180°) × 10 latitudes (β = 0…75°), 8 cells blank near the
    Sun. Numbers from the PDF text layer, blank cells placed by column alignment, then checked cell by cell
    against the page image.
  - `leinert_1998_table17.csv`: Table 17, p. 36 — the same in 10⁻⁸ W m⁻² sr⁻¹ µm⁻¹. The tests check
    Table 17 = 1.28 × Table 16 to rounding (max 1.2 %) and identical blanks: a transcription check.
  - `leinert_1998.json`: S10⊙ definition (p. 4: 1 S10⊙ = 6.61 × 10⁻¹² F⊙/sr, V⊙ = −26.74; Table 2, p. 3:
    1.28 × 10⁻⁸ W m⁻² sr⁻¹ µm⁻¹ at 500 nm), ecliptic pole 60 ± 3 S10⊙ and polarisation 0.19 (Eq. 19, p. 37),
    map errors (p. 38), heliocentric dependence R^−2.3±0.1 (Helios, 0.3–1 AU) and R^−2.5±0.2 (Pioneer 10,
    1–3.3 AU) (Eqs. 15, 17, p. 35), the adopted reddening f_co (Eq. 22, p. 41), the Pioneer 10 pole brightnesses
    of Table 34 (p. 75) and the Pioneer star-removal note (Sect. 10.4, p. 69; errors p. 72).
- **Not transcribed:** Tables 35–38 (Pioneer 10 background starlight on a 10° grid) are images of rotated
  tables in this copy; the Pioneer maps themselves (docs/sources/pioneer-ipp.md) are used instead.
- **Label:** Table 16 values are `measured` (smoothed observations). The XYZS conversion is `derived`.

## Kelsall et al. 1998 — `kelsall-1998`

- **What:** the COBE/DIRBE interplanetary dust model: smooth cloud (widened modified fan), three dust-band pairs,
  circumsolar ring and Earth-trailing blob, fitted to 10 months of DIRBE 1.25–240 µm sky maps.
- **Citation:** Kelsall T., Weiland J. L., Franz B. A., Reach W. T., Arendt R. G., Dwek E., Freudenreich H. T.,
  Hauser M. G., Moseley S. H., Odegard N. P., Silverberg R. F. & Wright E. L. 1998, ApJ 508, 44–73,
  DOI 10.1086/306380; preprint arXiv:astro-ph/9806250.
- **Retrieval:** `https://arxiv.org/pdf/astro-ph/9806250v1` through `download.fetch` →
  `data/raw/sky/papers/kelsall1998_astro-ph9806250v1.pdf` (sha256 in the ledger).
- **Transcribed:** `sky_tables/kelsall_1998.json` — Table 1 (all density and geometry parameters with their 68 %
  uncertainties), the near-IR scattering parameters of Table 2 (phase-function C0, C1, C2 and albedos at 1.25,
  2.2, 3.5 µm) and the functional forms of Eqs. 1–9. The preprint's Eq. 4 prints Y′ = X − Y0; Y′ = Y − Y0 is
  used (the only reading consistent with a cloud centre offset (X0, Y0, Z0)).
- **Use:** geometry and density as published (`derived`). The visible scattering is **not** from Kelsall (their
  albedos and phase functions are near-IR): the phase-function form of their Eq. 2 is kept and C0, C1, C2 and one
  albedo are fitted to Leinert Table 16 (docs/reports/sky.md §4) → `estimated` away from 1 AU.
- **Not used:** Hong (1985, A&A 146, 67), the classic visible three-term Henyey–Greenstein phase function, could
  not be retrieved (ADS scan service not delivering); the fitted Kelsall form replaces it. ZodiPy (GPL-3) is not
  used; the model is re-implemented from the paper in `sky_zodi.py`.
