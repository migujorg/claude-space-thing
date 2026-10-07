# Saturn main-ring measurements beyond the product's 47° limit

The app's `single-scattering-v1` reflectance model is calibrated only over 0.25–47°.
Brightness outside that domain is **unknown in this product**. Published high-phase
measurements exist; they have not yet been admitted to the product. The coverage
examples below do not establish a model for every radius, both faces and all four
solar-weighted XYZS channels.

These references were obtained and inspected by `ring-high-phase-research` on
2026-10-07 (its report's source index S3–S6). Only the parts listed here support
these statements; unread supplementary material and coefficient tables are not
claimed as evidence.

- **Porco et al. (2005)**, *Science* 307, 1226–1236,
  DOI:10.1126/science.1108056. [Published NASA PDF](https://www.giss.nasa.gov/pubs/docs/2005/2005_Porco_po01100t.pdf),
  pp. 1228–1229, Figs. 2–3: lit-face ISS observations at 66° in UV3, BL1, GRN,
  RED and IR2, with spectra for twelve main-ring regions. These are multicolour
  measurements at a selected high-phase geometry, not a 47–175° phase law.
- **Filacchione et al. (2014)**, *Icarus* 241, 45–65,
  DOI:10.1016/j.icarus.2014.06.001. [Published author PDF](https://mmhedman.github.io/papers_published/Filacchione_specs_Icarus_2014.pdf),
  §§2–3, Table 1, Figs. 2–4: ten VIMS radial spectrograms, including lit-face
  mosaics with reference phases 96.0° and 132.4° (Table 1's B-ring geometry).
  Visible spectra span 0.35–1.05 µm; 400 km radial bins need not equal native
  resolution. These samples do not establish both-face coverage.
- **Ciarniello et al. (2019)**, *Icarus* 317, 242–265,
  DOI:10.1016/j.icarus.2018.07.010. [Published author PDF](https://mmhedman.github.io/papers_published/Ciarniello_VIMS_Icarus_2019.pdf),
  §§2–6, Fig. 3, Figs. 6–17: spectral Monte Carlo fits using those ten mosaics
  at four C/B/A-ring radii. The fits depend on particle phase, albedo and packing;
  they do not establish unlit-face or 175° support.
- **Porco et al. (2008)**, *AJ* 136, 2172–2200,
  DOI:10.1088/0004-6256/136/5/2172. [Published author PDF](https://pages.astro.umd.edu/~dcr/reprints/porco_aj136,2172.pdf),
  §§2–3, Figs. 14–15: selected lit-face CLEAR measurements and ray-tracing
  comparisons at high phase. The total fits include higher scattering orders;
  a CLEAR curve alone does not measure visible/scotopic colour. The research
  lane found discrepancies between some caption frame IDs and OPUS geometries;
  those must be reconciled before importing individual frames or fit inputs.

Using this evidence requires qualified geometry, radial and spectral support,
and scattering transport, including multiple scattering, packing and dust where
applicable. This is an implementation requirement inferred from the differing
coverage and model assumptions above, not a claim that high-phase brightness
has never been measured. No high-phase calibration or model extension is made
by this documentation correction.
