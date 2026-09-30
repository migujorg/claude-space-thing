# gaia-dr3-sso-reflectance: Gaia DR3 reflectance spectra of Solar System objects

- **URL:** https://cdn.gea.esac.esa.int/Gaia/gdr3/Solar_system/sso_reflectance_spectrum/SsoReflectanceSpectrum_{00..19}.csv.gz (20 files, 14 MB; table `gaiadr3.sso_reflectance_spectrum`).
- **Used by:** the `smallbodies` stage (`sb_physical_sources.read_gaia`, `sb_physical._gaia_colors`) → `smallbodies/physical.bin` geometricAlbedoXYZS.
- **Citation:** Gaia Collaboration, Galluccio, L., Delbo, M., De Angeli, F., et al. (2023). Gaia Data Release 3: Reflectance spectra of Solar System small bodies. A&A 674, A35. DOI:10.1051/0004-6361/202243791. Gaia Collaboration, Vallenari, A., et al. (2023), A&A 674, A1, DOI:10.1051/0004-6361/202243940.
- **Licence:** CC BY-NC 3.0 IGO. Fine for this personal, non-commercial project; recheck if that changes.
- **SourceRecord sha256:** SHA-256 over the 20 files' sha256 values in file order.

## What the data are

One row per object and band: 16 bands centred 374, 418, ..., 1034 nm (44 nm apart), reflectance normalised to 1 at 550 nm, with an error and a flag (0 = good, 1-2 = suspect, mostly the edge bands). 60,518 asteroids.

## Colour computation (docs/architecture.md §4.3)

1. Bands 374-858 nm (the last one bounds the interpolation past 830 nm) with flag 0 are kept; the 418-770 nm core must be complete and unflagged or the object gets no colour.
2. R(λ) is linear between band centres on the 1 nm CIE grid and flat from 374 nm down to 360 nm (the CIE observers there weigh < 0.1 % of X and Z).
3. p(λ) = p_V · R(λ) / R_V, with R_V the solar-weighted Bessell V average of R (the filter and sunlight of the `light` stage).
4. geometricAlbedoXYZS = the CIE integrals of p(λ) × TSIS-1 HSRS sunlight at 1 AU (pipeline/src/pipeline/cie.py).

Labels: `derived` when every band 374-858 nm was usable and p_V is measured; `estimated` when p_V is the class statistic (smallbodies-class-albedo) or a band was bridged. Without a Gaia spectrum the colour is unknown (the class-mean-spectrum fill-in the research note lists is not implemented).
