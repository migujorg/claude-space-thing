# Pioneer 10/11 Imaging Photopolarimeter sky maps (sky)

Used by the `sky` stage as the absolute anchor of the diffuse sky (`sky/diffuse.json`, layer `diffuse`).
SourceRecord id: `pioneer-ipp-maps`.

- **What:** all-sky blue and red maps co-added from 11 Pioneer 10 and 11 IPP sky maps taken beyond the zodiacal
  dust cloud (> 3.3 AU), so they hold starlight, diffuse galactic light and extragalactic light but no zodiacal
  light. Files `P_all_1_B.fits` and `P_all_1_R.fits` (1st iteration = straight co-add; the 10th iteration of the
  MCM resolution enhancement is also offered, with more structure noise, and is not used): 1440 × 720 float32,
  0.25° pixels in galactic longitude/latitude (CRVAL/CRPIX/CDELT in the header), 0 = no data (9.6 % of the sky,
  mostly one gap region), units S10(G2V) = S10⊙.
- **Bands** (map author's page): B λ = 437.0 nm, Δλ = 82.6 nm; R λ = 644.1 nm, Δλ = 96.8 nm. The pipeline treats
  them as top-hat bands of those widths (the filter curves are in the IPP instrument papers and Gordon et al.
  1998, not retrievable here): an approximation that enters only through the colour of what is subtracted.
- **Citation:** Gordon K. D., Witt A. N. & Friedmann B. C. 1998, ApJ 498, 522, DOI 10.1086/305571 (maps; the
  paper gives the unit conversions); data reduction Weinberg J. L. & Toller G. N. (NSSDC background-sky tapes);
  Toller G. N. 1983, ApJ 266, L79, DOI 10.1086/183982; description in Leinert et al. 1998 Sect. 10.4.
- **Retrieval:** `https://www.stsci.edu/~kgordon/pioneer_ipp/` (`P_all_1_B.fits`, `P_all_1_R.fits`, `README`,
  `Pioneer_10_11_IPP.html`) through `download.fetch` → `data/raw/sky/pioneer_ipp/` (sha256 in the ledger).
  The raw NSSDC-format data linked from the same page are not used.
- **License:** "Copyright © 1997–2014 Karl D. Gordon, All Rights Reserved". Used for this personal project; the
  derived remainder map is published in the app. Ask the author before redistributing the maps themselves.
- **Stars in the maps:** the README says the ASCII measurement files it describes include all stars; the FITS
  maps do not show Sirius or Canopus (the map is ~200–400 S10⊙ there, where Sirius alone would add thousands).
  Leinert 1998 p. 69: "Individually resolved stars, typically those brighter than 6.5 mag, were removed … on the
  basis of a custom made catalog containing 12457 stars." Which stars are still in the maps is therefore measured
  (regression of the high-passed maps on star maps per Hipparcos-V bin, docs/reports/sky.md §3) rather than
  assumed.
- **Units:** 1 S10⊙ = 6.61 × 10⁻¹² F⊙,band / sr (Leinert 1998 p. 4), with F⊙,band the TSIS-1 HSRS solar
  spectrum averaged over the band. The unit assumes V⊙ = −26.74; the S10(G2V) of the IPP calibration (on Vega)
  may differ from it by a few per cent.
- **Errors:** random 2–3 S10⊙, perhaps 5 in the Milky Way and Magellanic Clouds (Leinert 1998 p. 72); spatial
  resolution about 2° (p. 72 and the map author's page).
