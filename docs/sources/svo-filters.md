# Broadband passbands from the SVO Filter Profile Service (`bessell-1990-*`, `svo-johnson-*`)

**Service:** Rodrigo, C., Solano, E. & Bayo, A. (2012), *SVO Filter Profile Service Version 1.0*, IVOA Working Draft (ADS 2012ivoa.rept.1015R); Rodrigo, C. & Solano, E. (2020), XIV.0 Scientific Meeting of the Spanish Astronomical Society, 182. Files: `https://svo2.cab.inta-csic.es/theory/fps/getdata.php?format=ascii&id=<filter id>` (Å, transmission; SVO lists them as energy-counter responses).

- `Generic/Bessell.{U,B,V,R,I}` — Bessell, M. S. (1990). UBVRI passbands. *PASP* 102, 1181–1199, DOI [10.1086/132749](https://doi.org/10.1086/132749). R, I are Cousins. Used for p_V (`geometricAlbedoV` = solar-weighted Bessell V band average of p(λ)), Pluto's B/V reconstruction, and comparisons.
- `Generic/Johnson.{U,B,V,R,I}` — Johnson-system curves as distributed by SVO; the SVO entry does not name the publication they were digitized from. Used only to reconstruct Mars from Mallama et al.'s Johnson-system albedos (Johnson R and I differ from Cousins Rc, Ic).

Band averages weight by T(λ)·E☉(λ) on the TSIS-1 HSRS air-wavelength grid (`photometry/filters.py`).
