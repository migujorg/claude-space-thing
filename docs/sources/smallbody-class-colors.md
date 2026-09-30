# Small-body class colours and albedos (`smallbody-class-colors.json`)

**Purpose:** a principled `estimated` colour and albedo for the asteroids that have no measured spectrum. That is about 1.5 million objects; 36 000 have Gaia DR3 colours. Produced by the `light` stage (`pipeline/src/pipeline/photometry/smallbody_colors.py`); the `smallbodies` stage consumes it.

## Inputs (NASA PDS Small Bodies Node, PSI archive; sha256-recorded)

| id | data set | used for |
|---|---|---|
| `busdemeo-mean-spectra` (+ `-label`), `busdemeo-classes` | DeMeo, F. E., Binzel, R. P., Slivan, S. M. & Bus, S. J. (2009), *Icarus* 202, 160–180, DOI [10.1016/j.icarus.2009.02.005](https://doi.org/10.1016/j.icarus.2009.02.005); EAR-A-VARGBDET-5-BUSDEMEOTAX-V1.0 | class mean spectra 0.45–2.45 µm (normalized at 0.55 µm); 371 classified asteroids |
| `ecas-mean-colors`, `ecas-filter-curves` | Zellner, B., Tholen, D. J. & Tedesco, E. F. (1985), *Icarus* 61, 355–416; EAR-A-2CP-3-RDR-ECAS-MEAN-V1.0 and ECAS-FILTER-CURVES-V1.0 | u (0.35 µm) and b (0.44 µm) colours, solar colours = 0, of 589 asteroids |
| `pds-asteroid-taxonomy-v6` | Neese, C. (2010), Asteroid Taxonomy V6.0, EAR-A-5-DDR-TAXONOMY-V6.0 | Bus-DeMeo and Bus classes of 2615 asteroids |
| `sdss-taxonomy-carvano2010` | Carvano, J. M. et al. (2010), *A&A* 510, A43, DOI [10.1051/0004-6361/200913322](https://doi.org/10.1051/0004-6361/200913322); EAR-A-I0035-5-SDSSTAX-V1.1 | SDSS colour classes of 63 468 asteroids |
| `neowise-v2` | Mainzer, A. K. et al. (2019), NEOWISE Diameters and Albedos V2.0 (the same download as the `smallbodies` stage) | fitted p_V |

## Method

- **Class spectrum** (24 Bus-DeMeo classes):
  - From 450 nm up, the DeMeo mean.
  - Below 450 nm, the class's mean ECAS u and b colours. For Sr and Sv, which have no ECAS object of their own, the S-complex mean is used; for O, the mean of all classified objects. The field `ultravioletFrom` says which group was used.
  - The extension is scaled so that the ECAS ratio interpolated to 450 nm meets the DeMeo value. It is piecewise linear, and constant below u.
  - The ECAS effective wavelengths are computed from the archived filter × dichroic curves and TSIS-1. The atmosphere, mirrors and photomultiplier are not in the archive, so the true u effective wavelength is somewhat longer than the 345 nm used.
- **xyzsPerUnitPV:** the spectrum scaled to a Bessell-V band average of 1, then integrated against TSIS-1 sunlight and the CIE observers (the same integration as `geometricAlbedoXYZS`, §4.3). The label is **derived**; applying it to an object makes that object's colour **estimated**.
- **pV:** the median, 16th and 84th percentiles and n of the NEOWISE-fitted p_V (per object, the median over its fits whose fit code has V fitted). The sample is the numbered asteroids with that class in DeMeo et al. (2009) or the Neese compilation, where the Bus class is taken when its name is a Bus-DeMeo class. Classes with fewer than 3 such objects are **unknown**: O, R, Sv.
- **sdssClasses:** frequencies over all 63 468 SDSS-classified asteroids, with a two-letter label counting half for each letter, and p_V statistics for the single-letter ones.
- **population** (unclassified objects):
  - Colour: the class spectra weighted by the SDSS frequencies, label **estimated**.
  - p_V: all 128 162 numbered asteroids with a NEOWISE-fitted albedo (median 0.081), label **derived**.
- **aliases:** assumed correspondences from Bus (SMASSII), Tholen and Mahlke et al. (2022) labels to Bus-DeMeo classes, stated in `aliases.rule`.

## Interface for the `smallbodies` stage (not changed here)

For an object without a Gaia colour:
1. **Class.** Take the SsODNet best taxonomy class, else the SBDB SMASSII (Bus) class, else the Tholen class. If the class is a Bus-DeMeo name, use it directly; otherwise map it through `aliases`. If it is still unknown, use `population`.
2. **Albedo.** Use the object's measured p_V if it has one; otherwise the class `pV.median` or, where that is unknown, the stage's current orbit-class median. The class 16th–84th percentiles give the honest spread.
3. **Colour.** geometricAlbedoXYZS = p_V × `xyzsPerUnitPV`, with label **estimated** and source `smallbody-class-colors`.

## Caveats

- **Sampling bias.** The spectroscopic samples favour bright, large, main-belt objects, and NEOWISE favours dark ones.
- **Class spreads.** DeMeo's per-wavelength standard deviations are a few percent in the visible. Cg, O and R rest on single objects.
- **UV extension.** The ECAS u/b colours come from photometry of the brightest asteroids. For V, R, Cg the UV comes from a single object (Vesta for V), and for Q, T, Sa from two. These are flagged by `ecasN`.
