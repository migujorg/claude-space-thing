# Aerosol climatology MACv2: Kinne (2019) (`kinne-2019-macv2`)

**Paper:** Kinne, S. (2019). The MACv2 aerosol climatology. *Tellus B* 71, 1623639, DOI [10.1080/16000889.2019.1623639](https://doi.org/10.1080/16000889.2019.1623639) (open access, CC BY 4.0). PDF from the journal's proof URL `https://b.tellusjournals.se/articles/89/files/submission/proof/89-1-1569-1-10-20220630.pdf` (sha256 in the download ledger). The gridded MACv2 files (MPI-M ftp) were not reachable through the proxy.

**What it is:** monthly global maps of tropospheric aerosol optical properties whose mid-visible values are anchored to multi-year AERONET and Maritime Aerosol Network sun-photometer statistics, with spatial context from global modelling (abstract).

**Transcribed:** `pipeline/src/pipeline/photometry/tables/kinne_2019_macv2.json`:
- Table 2 (pdf p. 10): global annual mean total AOD 0.144 / 0.122 / 0.081, SSA 0.902 / 0.941 / 0.956 and asymmetry 0.718 / 0.702 / 0.693 at 0.45 / 0.55 / 1.0 µm; coarse and fine AOD.
- Table 3 (pdf p. 11): the MACv2 AOD per layer 0–1, 1–3, 3–6, 6–12 km a.s.l. (0.041, 0.059, 0.015, 0.004) and CALIPSO v3 fractions.

**Use:** `atmospheres.json` Earth `aerosol` component (label **estimated**): AOD log-log interpolated (the 450–550 nm Ångström exponent 0.83 continued below 450 nm), SSA and g linear in ln λ, Henyey-Greenstein phase function, piecewise-constant layers.

**Caveats:** a global annual mean; local AOD spans ~0.02 to > 1; the HG form is an assumption.
