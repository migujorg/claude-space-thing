# Ground- and space-based spectrophotometry of bright stars (stars)

Stars too bright for Gaia's XP spectra get their colour and brightness from measured absolute spectra where one
exists. Both products below are integrated with `cie.resample` + `cie.xyzs` (label `derived`) only when every
sample between 360 and 830 nm is measured.

## HST CALSPEC — `hst-calspec`

- **What:** HST/STIS absolute spectra of flux standards, `current_calspec` directory (files `<star>_stis_NNN.fits`,
  wavelength in Å (vacuum), F_λ in erg s⁻¹ cm⁻² Å⁻¹). Includes Sirius (`sirius_stis_005`) and Vega
  (`alpha_lyr_stis_012`) plus ~45 other stars with V < 10.
- **Citation:** Bohlin R. C., Gordon K. D., Tremblay P.-E. 2014, PASP 126, 711, DOI 10.1086/677655; Bohlin R. C.,
  Hubeny I., Rauch T. 2020, AJ 160, 21, DOI 10.3847/1538-3881/ab94b4.
- **URLs:** star list from the CALSPEC page
  (`https://www.stsci.edu/hst/instrumentation/reference-data-for-calibration-and-tools/astronomical-catalogs/calspec`,
  saved as `data/raw/stars/calspec/calspec.html`), spectra from
  `https://archive.stsci.edu/hlsps/reference-atlases/cdbs/current_calspec/`.
- **Identification:** star names resolved to HIP / Gaia DR3 ids with CDS Sesame (SIMBAD; SourceRecord
  `simbad-sesame`, Wenger M. et al. 2000, A&AS 143, 9, DOI 10.1051/aas:2000332).
- **Coverage rule:** only samples with `TOTEXP > 0` (observed, not model-filled) count; the spectrum must be
  observed throughout 360–830 nm. The CALSPEC V listed on the page must agree with Hipparcos V within 0.10 mag.
- **Caveat:** Gaia's XP calibration itself was anchored on CALSPEC-based standards, so CALSPEC vs XP is a
  consistency check, not an independent validation.

## Pulkovo spectrophotometric catalogue — `pulkovo-spectrophotometry`

- **What:** VizieR III/201. Absolute spectral energy distributions of bright stars from Pulkovo observers at
  several sites; `table5.dat` holds 273 stars covering 320–1080 nm (10 nm resolution, 2.5 nm steps), in
  W m⁻² m⁻¹ (converted × 10⁻⁹ to W m⁻² nm⁻¹). Stated accuracy 1.5–2 %. `stars.dat` gives HR, HD, V and B − V
  from the Bright Star Catalogue.
- **Citation:** Alekseeva G. A. et al. 1996, Baltic Astronomy 5, 603 (1996BaltA...5..603A); Alekseeva G. A.
  et al. 1997, Baltic Astronomy 6, 481 (1997BaltA...6..481A).
- **URL:** `https://cdsarc.cds.unistra.fr/ftp/III/201/` (`ReadMe`, `stars.dat`, `table5.dat`).
- **Parsing notes:** blocks are headed by HR numbers, combined entries written as `2890/1` (HR 2890 + 2891; not
  used, since they are two stars' light); a lone `.` marks a missing sample; negative V is written with its
  sign in byte 65 (inside the SpType field).
- **Matching:** HD number (leading digits) → Hipparcos main catalogue → star. Used only when the catalogue V
  agrees with Hipparcos V within 0.10 mag (same light, not a different component mix or variability phase), Gaia
  shows no comparably bright neighbour within 2″, and only for stars whose Gaia XP spectrum is absent or brighter
  than the XP limit (G < 4). For Hipparcos multiple entries the spectrum is treated as the system's light, minus
  components that are separate records.
- **Absolute scale:** on six stars also in CALSPEC, Pulkovo Y is 3–7 % fainter and ~0.005 redder in x, y than
  HST/STIS; against Gaia XP at 4 < G < 5 it is 2 % fainter and Δx ≈ +0.007 (docs/reports/stars.md §2–3). Not
  corrected; it is the systematic uncertainty of the ~200 stars lit this way.
- **Not used:** `table6.dat` (320–735 nm only): its range stops short of 830 nm, so integrating it would need
  an assumed red tail.

## Sternberg spectrophotometric catalogues — `sternberg-spectrophotometry`

- **What:** VizieR III/208 (866 stars, 322.5–762.5 nm) and III/207 (223 stars, 597.5–1082.5 nm), absolute energy
  distributions in 5 nm steps from the Crimean station of the Sternberg Astronomical Institute (48 and 60 cm
  reflectors, 1970–1984), standards calibrated on Hayes' (1985) Vega; stated mean accuracy 3.2 %. Units
  erg cm⁻² s⁻¹ cm⁻¹ (× 10⁻¹⁰ → W m⁻² nm⁻¹). Ground-based, so wavelengths are in air (as the CIE tables).
- **Citation:** Glushneva I. N., Doroshenko V. T., Fetisova T. S., Khruzina T. S., Kolotilov E. A.,
  Mossakovskaya L. V., Ovchinnikov S. L. & Voloshina I. B. 1998, VizieR catalogues III/208 and III/207
  (1998yCat.3208....0G, 1998yCat.3207....0G), from Trudy Gosud. Astron. Inst. Shternberga 53, 50 (1983) and 54, 3
  (1984).
- **URL:** `https://cdsarc.cds.unistra.fr/ftp/III/208/` and `.../III/207/` (`ReadMe`, `catalog.dat.gz`).
- **Parsing notes:** 8-character E fields from byte 89; III/208 writes an absent sample with exponent `E-12`
  (e.g. `103.E-12`), III/207 as `0.E+00` — both read as missing (anything below 10⁻⁹ in file units). HR written
  `0361/2` is the combined light of two HR stars (not used).
- **Splice:** a star needs both catalogues to cover 360–830 nm. The spectrum is III/208 below 597.5 nm, the mean
  of both in the 597.5–762.5 nm overlap and III/207 above. The two were observed and calibrated separately, so a
  star is used only when the median III/207 / III/208 ratio in the overlap is within 5 % of 1 and its rms about
  the median ≤ 5 % (170 Hipparcos stars have both; 53 fail this).
- **Matching:** as Pulkovo (HD → Hipparcos, V within 0.10 mag, no blend), and only when no CALSPEC, XP or
  Pulkovo spectrum applies. 50 records use it, among them Aldebaran, Spica and Polaris (previously photometric
  estimates).
- **Absolute scale:** on 58 stars also measured by Pulkovo, Sternberg Y is 0.7 % brighter (median; rms 0.048 mag)
  and slightly bluer (Δx −0.004, Δy −0.005) — docs/reports/sky.md §2.
