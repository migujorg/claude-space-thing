# Star names (stars/names.json)

## IAU Catalog of Star Names — `iau-wgsn-csn`

- **What:** the IAU Working Group on Star Names' list of approved proper names (451 entries in the file used),
  with HIP and HD numbers, Bayer designations and component letters.
- **Citation:** IAU Division C Working Group on Star Names (WGSN), IAU Catalog of Star Names (IAU-CSN); official
  list at https://www.iau.org/public/themes/naming_stars/ .
- **URL:** `https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt` (maintained by the WGSN secretary; the
  file's own header asks users to cite the IAU page above). Version: file dated 2022-04-04.
- **Parsing:** fixed-width characters for the first seven columns (the component column can be blank), then
  whitespace-separated fields.
- **Use:** names attached by HIP number; names of stars without a HIP number (mostly exoplanet hosts fainter than
  the catalogue limit) are not used.

## Bayer and Flamsteed designations — `kostjuk-2002-crossindex`

- **What:** HD-DM-GC-HR-HIP-Bayer-Flamsteed Cross Index, VizieR IV/27A (`catalog.dat` + `addendum.dat`,
  3 967 stars).
- **Citation:** Kostjuk N. D. 2002, Institute of Astronomy of the Russian Academy of Sciences (VizieR IV/27A).
- **URL:** `https://cdsarc.cds.unistra.fr/ftp/IV/27A/`.
- **Use:** HIP → Flamsteed number and Bayer letter (+ constellation); Bayer codes (`alf`, `tet1`, …) are
  rendered as Greek letters with superscript indices (α, θ¹, …).
