# Broadband passbands from the SVO Filter Profile Service (`bessell-1990-*`, `svo-johnson-*`)

**Service:** Rodrigo, C., Solano, E. & Bayo, A. (2012), *SVO Filter Profile Service Version 1.0*, IVOA Working Draft (ADS 2012ivoa.rept.1015R); Rodrigo, C. & Solano, E. (2020), XIV.0 Scientific Meeting of the Spanish Astronomical Society, 182. Files: `https://svo2.cab.inta-csic.es/theory/fps/getdata.php?format=ascii&id=<filter id>` (Å, transmission; SVO lists them as energy-counter responses).

- `Generic/Bessell.{U,B,V,R,I}` — Bessell, M. S. (1990). UBVRI passbands. *PASP* 102, 1181–1199, DOI [10.1086/132749](https://doi.org/10.1086/132749). R, I are Cousins. Used for p_V (`geometricAlbedoV` = solar-weighted Bessell V band average of p(λ)), Pluto's B/V reconstruction, and comparisons.
- `Generic/Johnson.{U,B,V,R,I}` — Johnson-system curves as distributed by SVO; the SVO entry does not name the publication they were digitized from. Used only to reconstruct Mars from Mallama et al.'s Johnson-system albedos (Johnson R and I differ from Cousins Rc, Ic).

Band averages weight by T(λ)·E☉(λ) on the TSIS-1 HSRS air-wavelength grid (`photometry/filters.py`).

**Spacecraft cameras (M2, photon counters, SVO DetectorType 1)**:
- `Cassini/ISS_WAC.{VIO,BL1,GRN,RED,CB2,CB3}`: filter + CCD + optics. The SVO profile reference is the Cassini ISS Data User's Guide (2016); instrument paper: Porco, C. C. et al. (2004), *Space Science Reviews* 115, 363–497, DOI [10.1007/s11214-004-1456-7](https://doi.org/10.1007/s11214-004-1456-7). They are used for the Galilean moons (Mayorga et al. 2020). With photon weighting they reproduce that paper's effective wavelengths to 1 nm.
- `MEX/HRSC.{Blue,Green,Red,NIR}`: filter + CCD + instrument (Jaumann, R. et al. 2007, *Planetary and Space Science* 55, 928–952, DOI [10.1016/j.pss.2006.12.003](https://doi.org/10.1016/j.pss.2006.12.003)). They are used for Phobos (Fornasier et al. 2024).

For these, band averages weight by T(λ)·E☉(λ)·λ, which is how a photon-counting detector integrates (Mayorga et al. 2020, Eq. 7).

**Ring photometry (M3)**:
- `HST/WFPC2-PC.{F336W,F439W,F555W,F675W,F814W}` (`svo-hst-wfpc2-pc-*`): filter + CCD + instrument throughput as tabulated by STScI synthetic photometry and distributed by SVO. These are photon counters (SVO DetectorType 1), weighted by T·E☉·λ. Effective wavelengths for sunlight: 337.6, 434.4, 548.5, 671.9 and 797.5 nm. They are used to integrate Salo & French's (2010) HST ring phase curves to CIE channels (salo-french-2010.md). The PC and WF curves differ by < 1 nm in effective wavelength.
- `Voyager/ISS-NAC.Clear` (`svo-voyager-iss-nac-clear`): the Voyager narrow-angle camera's clear-filter relative response (Smith, B. A. et al. 1977, *Space Science Reviews* 21, 103–127, DOI [10.1007/BF00200847](https://doi.org/10.1007/BF00200847)). SVO lists it as an energy counter; its effective wavelength for sunlight is 474.5 nm. It is used to put the HST-derived ϖP into the band of the Voyager ring profiles (voyager-iss-ring-profiles.md).
