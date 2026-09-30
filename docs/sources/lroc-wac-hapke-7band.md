# LROC WAC Hapke-normalized 7-band mosaic of the Moon (`lroc-wac-hapke-7band`)

**What:** median I/F of ~124,300 LRO Wide Angle Camera images (2010-01-21 to 2013-05-01) in 7 bands (321, 360, 415, 566, 604, 643, 689 nm), each pixel photometrically normalized to incidence = phase = 60°, emission = 0° with the per-1° Hapke parameter maps (`lroc-wac-hapke-parameters`) and the GLD100 terrain model. Equirectangular, 400 m/px (76 px/deg), 70°S–70°N, float32, 8 tiles of 90° × 70° per band (56 files, 145.6 MB each, 8.2 GB).

**Citation:** Sato, H., Robinson, M. S., Lawrence, S. J., Denevi, B. W., Hapke, B., Jolliff, B. L. & Hiesinger, H. (2017). Lunar mare TiO2 abundances estimated from UV/Vis reflectance. *Icarus* 296, 216–238. DOI [10.1016/j.icarus.2017.06.013](https://doi.org/10.1016/j.icarus.2017.06.013).

**Files:** `https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/MDR/WAC_HAPKE/WAC_HAPKE_<band>NM_E350{N,S}{0450,1350,2250,3150}.IMG` (PDS cloud store; listable S3 bucket at `https://pds.mcp.nasa.gov/data/store/img/?list-type=2&prefix=lunar_reconnaissance_orbiter/...`). Georeferencing from the attached PDS3 label (LROC convention: the projection offsets are measured from the centre of the upper-left pixel; the tiles' edges fall exactly on 0/±70° and multiples of 90°). Each file is downloaded through `download.fetch` (sha256 in the ledger), reduced to the level-5 grid, and deleted (`surf_fetch.fetch_transient`), so the 8.2 GB never sit on disk.

**Not used:** `WAC_HAPKE_3BAND_*.TIF` (false colour R=689, G=415, B=321 nm, 8-bit).

**Processing (`surf_moon.py`):** box average to level 5 (0.67 km texels); conversion to normal albedo per 1° cell with the published Hapke model, RADF(0,0,0; B_S0 = 0)/RADF(60,0,60) (bilinear between cell centres). The shadow-hiding opposition surge is excluded from the "normal" value because (a) the disk-integrated albedo the renderer multiplies by (Lane & Irvine 1973) also excludes it, and (b) the surge width h_s sits at its fit bounds (0 or 0.2) in hundreds of cells. The conversion factor has a median ≈ 2.0 and varies by 3–5 % rms across the Moon (per band numbers in the layer header, `diagnostics.normalOver60Factor`).

**Labels:** brightness pattern **derived** (measured mosaic, published fitted photometric model evaluated inside its fitted domain); colour **estimated** (interpolation between band centres, 151 nm gap between 415 and 566 nm; see surf_color criterion).
