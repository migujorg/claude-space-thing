# neowise-v2: NEOWISE Diameters and Albedos V2.0

- **URL:** https://sbnarchive.psi.edu/pds4/non_mission/neowise_diameters_albedos_V2_0/data/ (files `neowise_mainbelt.csv`, `neowise_neos.csv`, `neowise_jupiter_trojans.csv`, `neowise_hildas.csv`, `neowise_centaurs.csv`, `neowise_ambos.csv`; PDS4 labels alongside).
- **Used by:** the `smallbodies` stage (`sb_physical_sources.read_neowise`, `sb_physical.build`) → `smallbodies/physical.bin` columns diameter/albedo where the SBDB has none.
- **Citation:** Mainzer, A. K., Bauer, J. M., Cutri, R. M., Grav, T., Kramer, E. A., Masiero, J. R., Sonnett, S. & Wright, E. L. (2019). NEOWISE Diameters and Albedos V2.0. NASA Planetary Data System, urn:nasa:pds:neowise_diameters_albedos::2.0, DOI:10.26033/18S3-2Z54. Per-row fits from Mainzer et al. 2011 (ApJ 743, 156), Masiero et al. 2011 (ApJ 741, 68), 2012, 2014, 2017, Grav et al. 2011/2012, Nugent et al. 2015/2016 (column `Reference`).
- **Licence:** NASA PDS, public.
- **SourceRecord sha256:** SHA-256 over the six files' sha256 values, in the order above.

## Rules

- One row per thermal-model fit; an object can have several (different epochs).
- `Fit_code` (four characters D, V, B/F, I or `-`) says which parameters were fitted. The label of the file states that an unfitted column holds an "assumed value if not fitted". So a diameter is used only when the code's first character is `D`, and p_V only when its second is `V`; everything else is not a measurement.
- Several usable fits are combined by inverse-variance weighting; the uncertainty kept is the larger of the formal error of the mean and the scatter of the fits.
- The fitted p_V depends on the H the fit used (column `Absolute_mag`), which carries the catalogue-H systematics of Pravec et al. (2012).
- Rows are matched to the SBDB by number, else by the MPC packed designation unpacked, else by the provisional designation (numbered objects are also reachable by the principal provisional designation of their SBDB full name).
- Precedence: the SBDB compilation first (it includes spacecraft, radar and occultation sizes), NEOWISE where the SBDB has no value. Where both exist the report compares them.
