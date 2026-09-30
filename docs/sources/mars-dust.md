# Mars dust: MCD climatology, Wolff et al. dust properties, MSL phase function (`mcd-dust-clim`, `lmd-mars-dust-optprop-tm`, `mcd-6.1-user-manual`, `lmd-dust-climatology-page`, `montabone-2020`, `chen-chen-2019b`, `vincendon-langevin-2010`)

Transcribed facts: `pipeline/src/pipeline/photometry/tables/mars_dust.json`. Code: `photometry/atmo_mars.py`.

## Column dust optical depth
- **Data:** `dust_clim.nc` (19 MB, 2022-01-19) from the LMD Mars Planetary Climate Model data directory `https://web.lmd.jussieu.fr/~lmdz/planets/mars/datadir/`: variable `cdod(Time = 669 sols, latitude = 60, longitude = 120)`, "IR column dust optical depth (absorption) normalized at reference pressure of 610 Pa"; Time is the sol of the Mars year (0.5 … 668.5).
- **What it is:** the dust forcing of the Mars Climate Database "Climatology" scenario. MCD v6.1 User Manual (`user_manual_6.1.pdf`, §1.2): "forced by a dust distribution reconstructed from observations over Mars Years 24 to 35, and thus representative of a standard (i.e.: devoided of a planet-encircling global dust storm) Martian year". The per-year maps are the kriged TES/THEMIS/MCS column dust optical depths of Montabone et al. (2015, *Icarus* 251, 65, DOI [10.1016/j.icarus.2014.12.034](https://doi.org/10.1016/j.icarus.2014.12.034); 2020, *JGR Planets* 125, e2019JE006111, DOI [10.1029/2019JE006111](https://doi.org/10.1029/2019JE006111), text arXiv:1907.08187v1).
- **Visible conversion:** the LMD data-set page (`http://www-mars.lmd.jussieu.fr/mars/dust_climatology/index.html`, "Important notes"): "Equivalent visible column optical depths can be obtained by multiplying the 9.3 µm absorption column dust optical depth by 2.6. See detailed discussion in Montabone et al., Icarus, 2015, Section 2.3.4"; Montabone et al. (2020, Fig. 5 caption) use the same 2.6. The reference wavelength of "visible" is not stated in the accessible text; the product assigns it to 700 nm (Q_ext varies by ±3 % over 600–880 nm for these particles).
- **Processing:** × 2.6; zonal means in 6° bands; L_s of each sol by counting NSSDCA solar days (24.6597 h) from an L_s = 0 epoch computed from DE442 and the IAU pole (atmo_mars.py; the MCD counts sols from L_s = 0); 5° L_s bins; the area-weighted global mean.
- **Result:** annual global mean 0.375 (visible, 610 Pa); minimum 0.20 near L_s 80°, maximum 0.76 near L_s 240°.
- **Use:** `atmospheres.json` Mars `dustColumn` (label **estimated**: a typical non-storm year stands in for the build window) and the normalization of the `dust` component.

## Dust single scattering
- **Data:** `optprop_dustvis_TM.dat` (3 kB, 2011-07-13) from the same LMD directory: 52 wavelengths 0.263–5 µm, one radius 1.5e-6 m; Q_ext, single-scattering albedo, asymmetry factor. No further header.
- **Attribution:** the MCD manual (§1.2) states the non-storm scenarios use "the more recently derived Wolff et al." dust properties (vs Ockert-Bell et al., the `*_ockert*` files); `TM` = T-matrix. Wolff, M. J., et al. (2009), *J. Geophys. Res.* 114, E00D04, DOI [10.1029/2009JE003350](https://doi.org/10.1029/2009JE003350) (not accessible here: Wiley blocks scripted access). The attribution is therefore by the manual's statement and the file naming.
- **Consistency:** SSA 0.967 at 650 nm vs the 0.975 that Chen-Chen et al. (2019) took from Wolff et al. (2009) for the MSL cameras; g 0.691 at 650 nm vs the measured 0.687 (below).
- **Use:** Mars `dust` single-scattering albedo (label **derived**; 0.73 at 388 nm → 0.975 at 700 nm), spectral shape of the extinction, and the `asymmetry` field.

## Dust phase function
- **Paper:** Chen-Chen, H., Pérez-Hoyos, S. & Sánchez-Lavega, A. (2019). Characterisation of Martian dust aerosol phase function from sky radiance measurements by MSL engineering cameras. *Icarus* 330, 16–29, DOI [10.1016/j.icarus.2019.04.004](https://doi.org/10.1016/j.icarus.2019.04.004); text arXiv:1905.01074v1.
- **What:** double Henyey-Greenstein (eq. 1) fitted to Navcam/Hazcam sky radiance in the solar almucantar at Gale crater (MY 32–34, scattering angles ~10–150°, λ_eff ≈ 650 nm): g1 = 0.889 ± 0.098, g2 = 0.094 ± 0.250, α = 0.743 ± 0.106. The abstract gives asymmetry 0.673 ± 0.081, section 4 gives 0.687 ± 0.081; α g1 + (1 − α) g2 = 0.685.
- **Use:** Mars `dust` phaseFunction (label **estimated**: measured at 650 nm, applied at all wavelengths).

## Dust vertical distribution
- Vincendon, M. & Langevin, Y. (2010), *Icarus* 207, 923–931, DOI [10.1016/j.icarus.2009.12.018](https://doi.org/10.1016/j.icarus.2009.12.018), text arXiv:1103.3215v1, abstract: "On Mars, we find the scale height of dust particles to vary between 6 km and 12 km depending on season." The product mixes dust with the gas (NSSDCA scale height 11.0 km) — an **estimate** within that range.

## Caveats
- Interannual variability, regional and global dust storms, detached dust layers and water-ice clouds are not represented.
- The 2.6 conversion and its wavelength carry ~10 %.
