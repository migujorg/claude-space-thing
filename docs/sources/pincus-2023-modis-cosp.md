# Pincus et al. (2023) MODIS C6.1 COSP cloud histograms (`pincus2023-modis-cosp`): read from a figure

**Citation:** Pincus, R., Hubanks, P. A., Platnick, S., Meyer, K., Holz, R. E., Botambekov, D. & Wall, C. J. (2023). Updated observations of clouds by MODIS for global model assessment. *Earth System Science Data* 15, 2483–2497. DOI [10.5194/essd-15-2483-2023](https://doi.org/10.5194/essd-15-2483-2023). The PDF (`https://essd.copernicus.org/articles/15/2483/2023/essd-15-2483-2023.pdf`, CC BY 4.0) is fetched into data/raw/papers, and its sha256 is in the ledger.

**What it is used for:** the optical thickness of cloud that has no retrieval of its own. In the Earth cloud layer this is the share cloudFraction − tauRetrievedFraction of `surfaces/399/cloudTau` (docs/rendering-earth.md §2), 39 % of the daylit cloud on 2026-09-28. In the MODIS/VIIRS continuity algorithm (Platnick et al. 2017; 2021), most of these pixels are flagged by the clear-sky restoral as partly cloudy or cloud edge (CSR = 1, 3). Their retrievals go into separate `_PCL` fields, which GIBS does not serve and which in the Level-3 files need an Earthdata login.

**Why this source:** it is the only published, measured, global distribution of partly-cloudy optical thickness we found. Fig. 7 shows the global area-weighted mean joint histograms of τ and cloud-top pressure for July 2021 (MCD06COSP_M3: MODIS C6.1, Terra + Aqua): fully cloudy pixels (a, c, e) and partly cloudy pixels (b, d, f), for all phases, ice and liquid. The text sums them up: the vast majority of partly cloudy pixels are "liquid, very low (pc > 800 hPa), and optically thin (τc ≤ 3.6)".

Other candidates do not give a distribution:
- Platnick et al. (2017, IEEE TGRS 55, 502; fetched as `platnick2017-modis-c6`) and the C6 MOD06 user guide describe the PCL population qualitatively. Excluding it raises the monthly mean liquid COT by up to two or more. They also give its failure rate: about 34 % of global over-ocean liquid PCL attempts fail, against about 10 % for overcast pixels.
- Pincus et al. (2012, J. Climate 25, 4699) is from Collection 5, which discarded partly cloudy pixels. It states that their optical thickness "is systematically smaller than from fully cloudy pixels" (citing Chang & Coakley 2007), but gives no distribution.
- The CLDPROP paper (Platnick et al. 2021, Remote Sensing 13, 2) could not be fetched (HTTP 403 from the publisher). Its Level-3 PCL statistics, like MODIS's, are only in login-protected files.

**How it is read** (`pipeline/src/pipeline/cloud_pcl.py`, at build time):
- The figure is embedded in the PDF as a lossless 2067 × 2518 RGB raster: a Flate stream with PNG predictors, wrapped as a PNG and decoded. It is identical to poppler's `pdfimages` output.
- The axes frames and the colour bar's seven ticks are checked at fixed pixel positions, so another PDF version fails instead of being misread.
- Each of the 6 × 49 cells has a flat colour; the most frequent colour is taken, which skips labels such as "(b)". It is inverted through the colour bar, which is linear from 0 to 0.062 cloud fraction (least squares through the ticks).
- One colour step is 0.0002–0.0005 in cloud fraction. The palest cells (below 0.0008) cannot be told from empty and count as 0. The statistics are also given with all of them at 0.0008, as an upper bound that smears mass into high τ.

**Checks** (`pipeline/tests/test_cloud_pcl.py`):
- The bottom (pc ≥ 800 hPa) row is the same in the all-phase and liquid panels.
- All phases ≈ ice + liquid within the reading resolution.
- The distribution is mostly low (> 85 %), liquid (ice share < 10 %) and thin (τ ≤ 3.6 for > 80 %), as the text says.
- The fully cloudy panel reads τ_g = 6.9 with σ(ln τ) = 1.29. Our own VIIRS retrievals of 2026-09-28 (`cloudTau`, area-weighted over the daylit globe) give τ_g = 8.3 with σ = 1.14: a different month and instrument, but the same algorithm and a similar distribution.

**Result** (floor cells 0), stored in `cloudTau.json` under `constants.unmeasuredTau`:
- **Partly cloudy pixels, all heights:** global cloud fraction 0.099. Bin probabilities 0.042 (τ < 0.3), 0.468 (0.3–1.3), 0.335 (1.3–3.6), 0.132 (3.6–9.4), 0.024 (9.4–23), and 0 above. ln τ: mean 0.21, σ = 1.17, so τ_g = 1.24.
- **Low share** (pc ≥ 680 hPa): 0.915. **Ice share:** 0.035.
- **Upper bound** (floor cells at 0.0008): τ_g = 1.77, σ = 1.73.
- **Size of the gap:** the global cloud-mask fraction exceeds the retrieval fraction by ~22 % in the article. Our VIIRS layer has 0.24 of the daylit area cloudy without τ, against 0.10 of successful PCL retrievals in MODIS. The rest is failed retrievals (about 34 % of global over-ocean liquid PCL attempts fail; Platnick et al. 2017, citing Cho et al. 2015), plus pixels restored to clear.

**Label:** `estimated`. The statistic is measured, but it is applied to other samples:
- VIIRS samples on one day, not the MODIS pixels of July 2021;
- failed retrievals and restored pixels, whose τ is not in the histogram;
- with no regional dependence.

At Strict the share stays unknown.

**Why spread a PCL τ over a whole sample:** a partly cloudy pixel's τ is retrieved as if the pixel were overcast. It is therefore the plane-parallel τ that reproduces the pixel's mean reflectance, which is the right quantity for a sample drawn as one plane-parallel layer.
