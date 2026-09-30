# LROC WAC empirically normalized polar mosaics (`lroc-wac-emp-polar`)

**What:** median of 137,400 WAC color images (2010-01-21 to 2013-01-31) normalized to incidence = phase = 30°, emission = 0° with an empirical photometric function and GLD100 topography; the polar tiles are polar stereographic, 200 m/px (152 px/deg), 60°–90° N and S, float32, one file per band and pole (14 files, 347 MB each).

**Citation:** Boyd, A. K., Robinson, M. S. & Sato, H. (2012). Lunar Reconnaissance Orbiter Wide Angle Camera photometry: an empirical solution. 43rd Lunar and Planetary Science Conference, abstract 2795 (https://www.lpi.usra.edu/meetings/lpsc2012/pdf/2795.pdf). Data: LROC RDR archive LROLRC_2001, `DATA/MDR/WAC_EMP/WAC_EMP_<band>NM_P900{N,S}0000_152P.IMG`.

**Why:** the Hapke-normalized mosaic stops at 70°; the WAC_GLOBAL morphology mosaic (643 nm) covers the poles but is a shaded morphology product at ~60° incidence, not an albedo map. The EMP polar tiles are the only 7-band normalized reflectance poleward of 70°.

**Processing (`surf_moon.py`):** 3 × 3-pixel means (600 m), bilinear sampling at level-5 texel centres (spherical polar stereographic equations of the LROC RDR SIS, Appendix B), then one scale factor per band and pole: the median ratio of the Hapke-derived normal albedo to the EMP value over all texels known in both between 62° and 69.5°. The scale is 0.97–1.06 depending on band; its interquartile range and the median ratio in 2.5° latitude bins are in the header (`diagnostics.polarRing`). Used only where the Hapke mosaic has no data (poleward of 70° and any gaps between 60° and 70°). Texels without EMP data stay unknown: coverage falls from > 98 % at 70° to ~30–40 % above 85° (permanent shadow and grazing illumination).

**Label:** brightness and colour **estimated** (the ring scale is assumed to hold poleward; the empirical normalization at high incidence is less reliable than the Hapke one).
