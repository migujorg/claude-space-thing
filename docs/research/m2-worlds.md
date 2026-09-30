# M2 research: true-color worlds up close

Status: research notes for M2 ("Surface maps, major moons, Saturn's rings, measured photometric models, shadows, eclipses, planetshine"). Written 2026-09-30.

**How this was verified.** Every URL below was fetched or HEAD-requested on 2026-09-30 through the session proxy with TLS verification on. Sizes come from `Content-Length`, directory listings or S3 bucket listings. Where a file is larger than 50 MB it was not downloaded: its structure was read with HTTP range requests (DAF headers of SPK/PCK files, TIFF IFDs, FITS headers). DOIs were resolved through the Crossref or DataCite APIs. Anything I could not verify is marked **unverified**.

Label shorthand used below: **M** measured, **D** derived, **E** estimated, **U** unknown (architecture.md §2.1).

---

## 1a. Moon ephemerides for now ± 18 months

### Finding: Horizons *is* the NAIF kernels, and the kernels can be excerpted remotely

- JPL Horizons reports its source kernel for each moon. Checked 2026-09-30: Io `jup365_merged`, Titan and Mimas `sat441l`, Janus `sat415_merged_DE437`, Triton and Nereid `nep098_merged`, Miranda and S/2023 U 1 `ura184_merged`, Charon `plu060_merged`, Phobos `mar099`, S/2009 S 2 `sat480`, S/2023 S 60 `sat459_merged_DE440`, S/2021 J 8 `jup349_merged_DE442`, S/2021 N 1 `nep104_merged`. Horizons vectors therefore add nothing in accuracy over the NAIF files. They only add API calls and a resampling step.
- `naif.jpl.nasa.gov` answers HTTP `Range` requests (`Accept-Ranges: bytes`, returns 206). Every moon segment in the kernels below is SPK type 2 or 3 (Chebyshev), except one segment noted below. A type 2/3 segment's records are fixed-length and time-indexed, so a ±18-month slice is a contiguous byte range.
- **jplephem 2.24** (MIT, PyPI) implements exactly this: `python -m jplephem excerpt --targets <ids> <start> <end> <URL> out.bsp` fetches only the needed records. Tested: `jup365.bsp` (1.14 GB) for 2025-03-30 to 2028-03-31 with targets 501–505, 514–516 and 599 produced a **5.63 MB** file in 54 s. Io's position relative to the Jupiter barycenter at 2026-09-30 00:00 TDB from the excerpt matched Horizons' vector to all printed digits (sub-millimetre).

### Kernel inventory (`https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/`)

Excerpt sizes are for 2025-03-30 to 2028-03-31, **moons and planet centres only**. I computed them from each segment's directory record (INIT, INTLEN, RSIZE) read by range request, with each body counted once. All the files are little-endian (LTL-IEEE) DAF/SPK.

| Kernel (date) | Full size | Moons / contents | Type, record length | ±18 mo excerpt |
|---|---|---|---|---|
| jup365.bsp (2021-03) | 1.14 GB | 501–505, 514–516, 599; 1600–2200 | 2; 0.375–2.25 d | 5.55 MB |
| jup347.bsp (2025-05) | 921 MB | 90 irregulars (506–513, 517–572, 55501–55526) | 2; 6 d | 6.62 MB |
| jup348.bsp (2026-03) | 60 MB | 55527–55530 | 2; 9 d | 0.11 MB |
| jup349.bsp (2026-04) | 97 MB | 14 new (55531–55544) | 2; 9 d | 0.40 MB |
| mar099s.bsp (2025-06) | 67 MB | Phobos, Deimos, 499; 1995–2050 | 2; 0.25–0.5 d | 3.55 MB |
| sat441.bsp (2022-01) | 662 MB | 601–609, 612–614, 632, 634, 699 | 2; 0.75–9 d | 3.84 MB |
| sat415.bsp (2022-03) | 624 MB | 610, 611, 615–618, 633, 649, 653 | **3**; 0.375–0.75 d | 17.21 MB |
| sat455.bsp (2025-04) | 291 MB | 127 irregulars (65158+…) | 2 | 1.84 MB |
| sat456.bsp (2025-08) | 121 MB | 42 named irregulars (619–664) | 2 | 0.54 MB |
| sat457.bsp (2025-08) | 199 MB | 79 irregulars | 2 | 1.12 MB |
| sat459.bsp (2026-04) | 84 MB | 17 newest (65286–65303); supersedes sat458 | 2 | 0.26 MB |
| sat480.bsp (2026-07) | 12.6 MB | S/2009 S 2 (65304; a = 117,061 km, outer B ring, per `sat480.cmt`) | **17** (equinoctial) | take whole file |
| ura184_part-3.bsp (2025-09) | 387 MB | 701–705, 716–724, 75051, 799 | 2 | 1.32 MB |
| ura184_part-1.bsp | 2.06 GB | 706–712 | 2; **0.1 d** | 30.72 MB |
| ura184_part-2.bsp | 2.06 GB | 713–715, 725–727, 75052 | 2; 0.1 d | 30.72 MB |
| nep098_part-1.bsp (2026-07) | 822 MB | Triton, Nereid, Naiad, 899 | 2; 0.1–2 d | 6.03 MB |
| nep098_part-2.bsp | 1.79 GB | 804–806 | 2; 0.1 d | 13.17 MB |
| nep098_part-3.bsp | 1.79 GB | 807, 808, 814 | 2; 0.1 d | 13.17 MB |
| nep104.bsp (2024-09) | 333 MB | 809–813, 85051, 85052 | 2; 2 d | 1.08 MB |
| plu060.bsp (2024-04) | 135 MB | 901–905, 999 | 2; 3 d | 0.88 MB |
| **Total** | **13.66 GB** | **464 bodies** | | **138 MB** |

- **Coverage vs Horizons.** Horizons' major-body list (`COMMAND='MB'`, 828 entries) contains 2 Mars, 115 Jupiter, 292 Saturn, 28 Uranus, 16 Neptune and 5 Pluto satellites. Every one of them is in the kernels above. The kernels also carry 55524 (S/2025 J 1, not in Horizons' list) and a 75052 segment in ura184 that is absent from NAIF's `aa_summaries.txt`.
- **Superseded files.** `nep105` (Nereid) and `nep097` are superseded by `nep098`. `sat458` exists only on SSD (`https://ssd.jpl.nasa.gov/ftp/eph/satellites/bsp/`) and is superseded by `sat459`. Use the `*_nameid.tf` files in `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/` for names of 5-digit IDs.
- **Documented interpolation error.** The kernel comments give the Chebyshev interpolation error: 0.8 m for ura184 and 1.0 m for nep098. The orbit-determination uncertainty is **not** given in any kernel. Label positions `measured` and set `uncertainty` to "not published in kernel; see the ephemeris paper". For ura184 the paper is Jacobson & Park 2025, AJ 169, 65, doi:10.3847/1538-3881/ad99d1. For recently discovered irregular moons, expect the uncertainty to be far above 1 km.
- **Citation for all kernels.** The planetary part is Park et al. 2021, AJ 161, 105, doi:10.3847/1538-3881/abd414. Kernels are public domain as a NASA/JPL product; cite the kernel name and version.

### The three options compared

| | NAIF SPK via range excerpt (**recommended**) | Horizons API vectors | Horizons-generated SPK |
|---|---|---|---|
| Moons | all 464 | same set (same source) | **not allowed for moons**: "Binary SPK file generation is restricted to small-bodies only" |
| Download | 138 MB total, about 1 request per few records | ~460 serial requests. Inner moons (Pan, P≈14 h) need ≲0.1 d sampling, and you then fit the Chebyshev yourself (a label downgrade from `measured` to `derived`) | n/a |
| Rules | none | Fair-use policy (https://ssd-api.jpl.nasa.gov/): **one request at a time**, an application-specific `User-Agent` with contact info, back off on errors, and **no embedding in websites (CORS)**. The browser app must never call it. | same |
| Accuracy | native (m-level interpolation) | same plus your fit error | small bodies: type 21, e.g. Eros for 3 years = 125 KB |

**Recommendation.** Add a new pipeline stage `satellites` that runs `jplephem excerpt --targets <moon and planet-centre IDs>` per kernel against the build window. Write the native type 2/3 records into `ephem/moons.{json,bin}` in the same layout as M1's `ephem` product (architecture §6).

Gotchas to handle in code:

1. **Always pass `--targets`.** Every satellite kernel also embeds DE copies of segments 3, 10, 399 and the planet barycentre. The comments of the newer ones (ura184, nep098, sat480) say DE442, and Horizons tags jup349 `_DE442`. In SPICE, the last-loaded segment wins, so loading them would silently override M1's DE440s for the Sun, Earth and barycentres.
2. **The excerpter only understands types 2 and 3.** It reads the last four doubles as INIT/INTLEN/RSIZE/N. sat480's type-17 segment (S/2009 S 2) must be evaluated directly. Type 17 is a precessing equinoctial conic and the elements are in `sat480.cmt`. Alternatively, sample it from Horizons.
3. **Segment boundaries.** `jplephem excerpt` labels every output segment as covering the full requested window, even when the source segment ends inside it. For today's kernels no body has a segment boundary inside 2025–2028; I checked every segment. Add a build-time assertion.
4. **Planetary ephemeris choice: consider DE442s.** DE442s (`…/spk/planets/de442s.bsp`, 31 MB, 2025-02) is the planetary ephemeris the newest satellite kernels were fitted against. I compared DE440s with DE442s over 2025–2028. The barycentre differences are Uranus **1,371 km**, Neptune **376 km**, Jupiter 15 km, Pluto 1.9 km, and ≤0.3 km for everything else. Moon-to-planet geometry is unaffected, but absolute positions of the Uranus and Neptune systems shift. Recommend M1 move to `de442s.bsp` (citation: Park et al. 2021 plus `de442_tech-comments.txt`).
5. **Trans-Neptunian and asteroid moons (for M3).** SSD publishes `tnosat_v001_*.bsp` for Eris/Dysnomia, Haumea/Hi'iaka/Namaka and others (168–284 MB each) at `https://ssd.jpl.nasa.gov/ftp/eph/satellites/bsp/`, and Horizons lists them (e.g. `120136199` Dysnomia). The same excerpt approach applies (type not checked).

---

## 1b. Orientation beyond the IAU models

| Body | Kernel (URL base `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`) | Size, coverage | Why it matters |
|---|---|---|---|
| Moon | `pck/moon_pa_de440_200625.bpc` (DAF/PCK, type 2 Chebyshev Euler angles, 8-day records) | 12 MB; 1549-12-31 to 2650-01-25. The ±18-month slice is 35 KB, but jplephem's excerpter is SPK-only, so download the whole file. | The DE440 physical libration solution |
| Moon frames | `fk/satellites/moon_de440_250416.tf` (19 KB). The name in `pck/aareadme.txt`, `moon_de440_220930.tf`, now returns **404**. | defines `MOON_PA_DE440` (31008) and `MOON_ME_DE440_ME421` (31009, a fixed rotation 67.8526″/78.6944″/0.2785″, axes 3-2-1) | LROC and LOLA maps are in the **mean-Earth (ME)** frame. PA and ME differ by 0.02886°, about **875 m** on the surface. `IAU_MOON` (pck00011) differs from DE440 ME by an amplitude of about **155 m** (mean 72 m) over 2000–2040. DE440-ME vs DE421-ME: ≤0.53 m. |
| Earth | `pck/earth_latest_high_prec.bpc` (4.9 MB, 2000-01-01 to **2026-12-26**; epoch of last EOP datum 2026-09-29; regenerated as new EOP arrive) + `pck/earth_2026_260806_2126_predict.bpc` (18 MB, 2026–2126, "low accuracy long-term predict") or `pck/earth_1962_260806_2126_combined.bpc` (30 MB) + `fk/planets/earth_assoc_itrf93.tf` | ITRF93 (frame 3000), referenced to ECLIPJ2000 | `IAU_EARTH` omits nutation (up to ~17″, about 0.5 km at the surface), UT1−UTC (up to 0.9 s, 0.42 km at the equator) and polar motion (~0.3″, ~10 m). Registering 250 m cloud imagery needs ITRF93. |
| Earth (raw EOP) | IERS `https://datacenter.iers.org/data/9/finals2000A.all` (3.77 MB, updated 2026-09-24), mirror `https://maia.usno.navy.mil/ser7/finals2000A.all`, `…/finals2000A.daily` (34 KB, 2026-09-29), EOP 20 C04 `https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now` (5.2 MB) | | Only needed if you build your own ITRF93 rotation. The NAIF bpc already encodes it. |

**Label rule for Earth orientation.** Rotation before the last EOP datum (2026-09-29 in today's file) is `measured`. After it, UT1 is an IERS prediction and should be labelled `estimated`, with the prediction horizon in `method`. Rebuilds pick up new data automatically.

Other bodies stay on IAU WGCCRE 2015 (Archinal et al. 2018, CMDA 130, 22, doi:10.1007/s10569-017-9805-5; `pck00011.tpc`). One caveat for the giant planets: OPAL maps are in System III longitudes, and cloud features drift relative to System III. See 1c.

---

## 1c. Surface maps: what the eye would see, and the best calibrated source for it

The general rule: **a map says where the brightness varies; a disk-integrated spectrum says what colour and brightness the body has.** Mission mosaics are usually radiometrically calibrated but photometrically normalised to a stated geometry. Some are high-pass filtered or colour-stretched. Only a few are multiband in the visible. "Colour" products named `ClrMosaic`, `EnhancedColor`, `3BAND` or `MD3` are almost always false colour.

Most per-body mosaics come from USGS Astrogeology, `https://planetarymaps.usgs.gov/mosaic/<file>`, which redirects to the public S3 bucket `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/`. The bucket is listable (`?list-type=2&prefix=mosaic/`, 18,844 objects) and range-capable. These are **uncompressed, stripped GeoTIFFs with 1 row per strip, not COGs**. You can therefore decimate by reading every Nth row with range requests. That scales download with 1/N, but not 1/N², because each row is still read in full. USGS products are public domain (US government).

### Mercury

- **Eye sees:** dark, slightly brownish-grey, low-contrast regolith.
- **Sources:**
  - `Mercury_MESSENGER_MDIS_Basemap_BDR_Mosaic_Global_166m.tif` (4.25 GB, monochrome 750 nm-class basemap).
  - `…_MD3Color_Mosaic_Global_665m.tif` (797 MB). USGS states its bands are **1000, 750 and 430 nm**, reflectance normalised to i=30°, e=0°, g=30°, and that it is "not what Mercury would look like to the human eye".
  - `…_EnhancedColor_…_665m.tif` (797 MB; false colour, a PCA stretch; do not use).
  - Calibration: Denevi et al. 2018, SSR 214, 2, doi:10.1007/s11214-017-0440-y.
- **Method:** Use MD3 **ratios** 430/750/1000 as the spatial colour modulation (430 and 750 roughly bracket the visible). Anchor the absolute spectrum to the disk-integrated phase curve and colours (Mallama & Hilton 2018, doi:10.1016/j.ascom.2018.08.002, already in M1). Photometry per 1d.
- **Labels:** spatial brightness M; colour E (interpolation between 430 and 750 nm).

### Venus

- **Eye sees:** clouds only. A nearly featureless, pale yellow-white cloud deck. Visible contrast is a few percent; the famous markings are ultraviolet, from the "unknown UV absorber" (Pérez-Hoyos et al. 2018, JGR Planets 123, 145, doi:10.1002/2017JE005406).
- **Surface data:** `Venus_Magellan_C3-MDIR_ClrTopo_Global_Mosaic_6600m.tif` and `Venus_Magellan_Topography_Global_4641m*` are radar and **invisible to the eye**: overlay mode only.
- **Method:** a uniform cloud-top reflectance with the measured disk-integrated phase function (Mallama et al. 2006, Icarus 182, 10, doi:10.1016/j.icarus.2005.12.014, which includes the glory and forward-scattering surge) and the disk spectrum (Pérez-Hoyos 2018).
- **Labels:** colour and brightness D. Any resolved BRDF that reproduces the disk phase curve is fitted, so E. Spatial texture U (render none).

### Earth: three layers, one of which is genuinely "now"

1. **Clouds and surface now: NASA GIBS.**
   - WMTS capabilities: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml` (5.3 MB, 1,319 layers).
   - Layers: `VIIRS_NOAA20_CorrectedReflectance_TrueColor`, `VIIRS_NOAA21_…`, `VIIRS_SNPP_…`, `MODIS_Terra_/Aqua_CorrectedReflectance_TrueColor`. Daily (`P1D`), `image/jpeg`, on the 250 m tile matrix: 512-px tiles; level 8 is 320×160 tiles, i.e. 163,840×81,920 px.
   - Tile URL: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{Layer}/default/{YYYY-MM-DD}/250m/{z}/{row}/{col}.jpg`.
   - Single-shot WMS: `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=4096&HEIGHT=2048&FORMAT=image/jpeg&TIME=2026-09-29` returned a 2.2 MB 4096×2048 JPEG.
   - Latency: at 08:30 UTC the default date was already 2026-09-30, and the `*_Granule` layers (6-minute swaths, ~90-day retention) had data to 05:42 UTC, about 3 h.
   - No login needed. NASA imagery, no restrictions; cite GIBS/Worldview.

   **Caveats that decide the label (and that GIBS does not advertise):**
   - The images are **Rayleigh-corrected** (CREFL removes molecular scattering and gas absorption). That is actually convenient, because we add our own Rayleigh sky in 1f. They are also **non-linearly stretched 8-bit JPEGs**. The MODIS Rapid Response enhancement maps reflectance −0.01…1.10 to 0…255, then applies the piecewise-linear curve [0,30,60,120,190,255]→[0,110,160,210,240,255] (Gumley et al., `https://www.earthdata.nasa.gov/s3fs-public/2022-02/MODIS_True_Color.pdf`). Invert it. Bright clouds land in the 240–255 codes, so cloud reflectance precision is poor.
   - The bands are MODIS 645/555/469 nm or VIIRS M5/M4/M3 (~672/555/488 nm). Reconstructing a spectrum from three bands is E.
   - The daily mosaic is a patchwork of ~13:30 local-time overpasses, not a snapshot. The night side has no visible data.
   - **Label: `measured`, with a per-pixel acquisition time (use the Granule layers to get times). Reflectance after inverting the stretch: E. Cloud state at a time other than acquisition: E, or show it as stale.**

2. **Geostationary, every 10 minutes.**
   - GIBS layers: `GOES-East_ABI_Band2_Red_Visible_1km`, `GOES-West_ABI_Band2_Red_Visible_1km`, `Himawari_AHI_Band3_Red_Visible_1km` (0.64 µm reflectance, `PT10M`), and `*_Band13_Clean_Infrared` at 2 km (10.3 µm cloud-top brightness temperature, day and night).
   - There is **no Meteosat/MTG in GIBS**, so Europe, Africa and the Indian Ocean need the EUMETSAT Data Store, which requires registration.
   - `*_GeoColor` blends a synthetic green channel and static city lights: **do not use it as data.**
   - Use Band 2/3 to update cloud reflectance at the current hour inside the disk (M, red band only). IR Band 13 gives cloud presence and cloud-top height on the night side (E for visible reflectance).

3. **Surface reflectance and BRDF under the clouds.**
   - MODIS **MCD43C1 v061**: daily, 0.05° CMG, RossThick-LiSparse BRDF kernel weights for 7 bands including 469/555/645 nm (Schaaf et al. 2002, RSE 83, 135, doi:10.1016/S0034-4257(02)00091-3). The latest granule `MCD43C1.A2026257…hdf` is 266 MB. Find granules with CMR `https://cmr.earthdata.nasa.gov/search/granules.json?short_name=MCD43C1&version=061`. Downloads from `data.lpdaac.earthdatacloud.nasa.gov` **require a free Earthdata Login** (verified: 302 to urs.earthdata.nasa.gov).
   - Oceans: Cox & Munk 1954 glint (JOSA 44, 838, doi:10.1364/JOSA.44.000838) driven by the current wind (GFS/ERA5, see 1f), plus water-leaving reflectance from an ocean-colour climatology (OB.DAAC, Earthdata Login).
   - Snow and ice: MODIS snow and AMSR sea-ice layers in GIBS.
   - `BlueMarble_NextGeneration` (GIBS, 500 m, monthly 2004) is an **enhanced composite**: reference only, never data.
   - **Night lights:** `VIIRS_Black_Marble` (GIBS, 500 m, annual 2016). The daily product VNP46A2 needs Earthdata Login (Román et al. 2018, RSE 210, 113, doi:10.1016/j.rse.2018.03.017). A dark-adapted eye sees city lights, so this matters.

### Moon: the best-calibrated body we have

- **Primary source: LROC WAC Hapke-normalised 7-band mosaic**, MDR `WAC_HAPKE`, now served from PDS cloud storage.
  - Base: `https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/MDR/WAC_HAPKE/`. The old `pds.lroc.asu.edu` redirects there, and the store is an S3 bucket listable with `?list-type=2&prefix=…`.
  - Bands 321, 360, 415, 566, 604, 643 and 689 nm. Photometrically normalised I/F at i = g = 60°, e = 0°, using per-pixel Hapke maps and the GLD100 DTM. Median of ~40 months of repeats. 400 m/px, 70°S–70°N.
  - Tiles `WAC_HAPKE_<band>NM_E350{N,S}{0450,1350,2250,3150}.IMG`: 8 tiles per band, raw float32 6841×5321, 145.6 MB each, so 1.17 GB per band and 8.2 GB for all 7.
  - `WAC_HAPKE_3BAND_*.TIF` (109 MB per tile) is **false colour** (R=689, G=415, B=321).
  - Citation: Sato et al. 2017, Icarus 296, 216, doi:10.1016/j.icarus.2017.06.013.
- **Hapke parameter maps.** `…/DATA/SDP/WAC_HAPKEPARAMMAP/WAC_HAPKEPARAMMAP_7BAND.IMG` (12.7 MB): 1°×1°, 9 parameters (w, b, c, Bc0, hc, Bs0, hs, θ̄, φ) × 7 bands. Bc0, hc, θ̄ = 23.657° and φ are fixed. Citation: Sato et al. 2014, JGR Planets 119, 1775, doi:10.1002/2013JE004580.
- **Poles and monochrome base.** `…/DATA/BDR/WAC_GLOBAL/WAC_GLOBAL_E000N0000_{004,008,016,032,064}P.IMG`, 643 nm float32: 016P is 66 MB, 032P 265 MB, 064P 1.06 GB. Caution: this is a **morphology mosaic with shading at ~60° incidence, not an albedo map.** Use it only for the >70° caps, or better, use the LOLA 1064 nm normal albedo `Lunar_LRO_LOLA_Albedo_Global_10ppd.tif` (13 MB).
- **Topography:** `Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif` (8.5 GB) or `Lunar_LRO_LOLA_DEM_Global_128ppd_v04.cub` (2.1 GB).
- **Red end beyond 689 nm:** Kaguya MI `mosaic/Lunar_MI_multispectral_maps/Lunar_Kaguya_MIMap_Band2_MV2_749nm_65N65S_512ppd.tif` (23 GB; decimate by rows) or Clementine UVVIS 750 nm (4.2 GB).
- **Disk-integrated check:** ROLO lunar irradiance model (Kieffer & Stone 2005, AJ 129, 2887, doi:10.1086/430185).
- **Labels:** colour D at the band centres, E between them. The 321–750 nm range brackets the CIE functions except the extreme red. Photometry M, per pixel. Topographic shading D, from the LOLA DEM.

### Mars

- **Eye sees:** butterscotch dust surface under a dusty sky. Absolute surface colour is genuinely uncertain because the atmosphere's transparency varies. Michael et al. 2025 say this explicitly.
- **Best colour: HRSC global colour mosaic.** Michael et al. 2025, Icarus 425, 116350, doi:10.1016/j.icarus.2024.116350. Data DOI 10.17169/refubium-40624.
  - Files at `https://hrscteam.dlr.de/public/data/global_mosaic/extra/{00-nd,01-re,02-gr,03-bl,04-ir}-eqc.tif`: equirectangular, 2 km/px, 10669×5334 **float32**, 228 MB each. `globalmosaic.rgb.tif` is 683 MB.
  - It is colour-referenced to a globally self-consistent colour model built from high-altitude imagery, so relative colour is good and absolute level less so.
  - Credit "ESA/DLR/FU Berlin". **License not stated on the page (unverified; ESA imagery is usually CC BY-SA 3.0 IGO).**
- **Absolute anchor:** TES albedo `Mars_MGS_TES_Albedo_mosaic_global_7410m.tif` (16.6 MB; bolometric Lambert albedo, M) and the disk-integrated magnitude/albedo (Mallama 2007, Icarus 192, 404, doi:10.1016/j.icarus.2007.07.011).
- **Not true colour:** `Mars_Viking_MDIM21_ClrMosaic_global_232m.tif` (12.7 GB) and `Mars_Viking_ClrMosaic_global_925m.tif` (798 MB) are colourised Viking images. Use them only as high-resolution panchromatic detail (the MDIM21 greyscale is 4.2 GB).
- **Topography:** `Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif` (11.4 GB).
- **Frames:** pck has `mars_iau2000_v1.tpc`. Check which Mars frame each map uses.
- **Labels:** colour E (HRSC ratios anchored to TES and disk values); dust sky E (1f).

### Jupiter, Saturn, Uranus, Neptune: OPAL is the dated, calibrated answer

- **Source:** Hubble OPAL. MAST HLSP `https://archive.stsci.edu/hlsps/opal/cycleNN/<planet>/`, DOI 10.17909/T9G593. The FITS header says `LICENSE='CC BY 4.0'`. Citations: Simon et al. 2015, ApJ 812, 55, doi:10.1088/0004-637X/812/1/55; Wong et al. 2020, ApJS 247, 58, doi:10.3847/1538-4365/ab775f.
  - Each `hlsp_opal_hst_wfc3-uvis_<planet>-<YYYYx>_<filter>_v1_globalmap.fits` is 3600×1800 (0.1°/px) float32, **25.9 MB**. Two rotations per year (the letter suffix).
  - The per-cycle README gives, **per filter, the Minnaert k used to remove limb darkening and the FITS→I/F scale factor**, so you get a measured photometric model with every map.
- **Latest epochs (checked):**

| Planet | Latest | Filters |
|---|---|---|
| Jupiter | cycle 32, 2025-12-11/12 (`jupiter-2025a/b`) | F275W, F343N, F395N, F467M, F502N, F631N, F658N, FQ889N. For F631N: k = 0.999, I/F scale = 0.00383. |
| Saturn | cycle 32 (`saturn-2025a/b`) | F225W, F395N, F467M, F502N, F631N, F763M, FQ727N, FQ889N |
| Uranus | **cycle 33** (`uranus-2025a/b`, plus north-polar `n-pole` products) | F467M, F547M, F657N, F763M, F845M, FQ619N, FQ727N |
| Neptune | cycle 32 (`neptune-2025b/c`) | same filters as Uranus |

- **Colour.** The visible bands bracket 395–658 nm (Jupiter/Saturn) and 467–657 nm (ice giants). For the in-between wavelengths, anchor to the disk-integrated geometric-albedo spectra: Karkoschka 1994, Icarus 111, 174, doi:10.1006/icar.1994.1139, and 1998, doi:10.1006/icar.1998.5913 (Jupiter, Saturn, Uranus, Neptune, Titan). For Uranus/Neptune also Irwin et al. 2024 (MNRAS 527, 11521, doi:10.1093/mnras/stad3761), already the M1 reference.
- **Time.** The map is measured at its epoch; the Jupiter map is ~10 months old at "now". Belts persist, but spots drift with zonal winds of ≳150 m/s at the strongest jets.
  - Honest options: show the map as `measured@2025-12-11` with an age badge, or advect it with the measured zonal wind profile (Tollefson et al. 2017, Icarus 296, 163, doi:10.1016/j.icarus.2017.06.007), labelled E.
  - Saturn: the rotation of the interior is not System III (ring seismology: Mankovich et al. 2019, ApJ 871, 1, doi:10.3847/1538-4357/aaf798). Cloud longitudes still drift, so the same treatment applies.

### Galilean moons

- **Sources (USGS):**
  - `Io_GalileoSSI-Voyager_Global_Mosaic_1km.tif` (65.5 MB) and `…_ClrMerge_1km.tif` (197 MB).
  - `Europa_Voyager_GalileoSSI_global_mosaic_500m.tif` (193 MB).
  - `Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif` (137 MB) and `…_Global_ClrMosaic_1435m.tif` (199 MB).
  - `Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif` (115 MB).
  - The colour products are composites of Galileo SSI and Voyager filters (violet, green, red/756 nm or 1 µm), **not calibrated true colour**. `Io_…_FalseColor_1km` is explicitly false colour.
- **Disk spectra and phase curves:**
  - Calvin et al. 1995 (icy Galileans, 0.2–5 µm compilation), JGR 100, 19041, doi:10.1029/94JE03349.
  - Mayorga et al. 2020, Cassini ISS phase curves, AJ 160, 238, doi:10.3847/1538-3881/abb8df.
  - Hapke parameters: Domingue & Verbiscer 1997, Icarus 128, 49, doi:10.1006/icar.1997.5730.
- **Labels:** brightness M; colour E (pan map × disk spectrum; ratio-modulated where Galileo colour exists).

### Titan

- **Eye sees:** an orange, featureless haze ball with a bluish detached haze at the limb in forward scatter.
- **Not visible:** `Titan_ISS_P19658_Mosaic_Global_4km.tif` (8.2 MB) and `Titan_ISS_Globe_65Sto45N_450M_AvgMos.tif` (1.58 GB) are **938 nm methane-window** images, flat-fielded to remove haze. USGS metadata says so. They are invisible to the eye, so overlay only.
- **Visible data:** disk spectrum from Karkoschka 1994/1998. Haze structure: Tomasko et al. 2008, PSS 56, 669, doi:10.1016/j.pss.2007.11.019, and Doose et al. 2016, Icarus 270, 355, doi:10.1016/j.icarus.2015.09.039.

### Saturn's mid-size icy moons

- **Sources (USGS):**
  - `Mimas/Cassini_DLR_Mimas.zip` (39.7 MB).
  - Enceladus: `Enceladus_Cassini_mosaic_global_110m.tif` (104 MB). **Avoid `…_100m_HPF.tif`: HPF is high-pass filtered, which removes large-scale albedo.**
  - `Tethys_Cassini_mosaic_global_293m.tif` (66 MB), `Dione_Cassini_Voyager_mosaic_global_154m.tif` (266 MB), `Rhea_Cassini_Voyager_mosaic_global_417m.tif` (66 MB), `Iapetus_Cassini_Voyager_mosaic_global_783m.tif` (16.6 MB).
  - Underlying archive: Cassini ISS cartographic volumes `https://planetarydata.jpl.nasa.gov/img/data/carto/coiss_3001/`…`coiss_3007/` (DLR; clear and green filters).
- **Colour:** the three-colour (UV3/GRN/IR3) global maps of Schenk et al. 2011 (Icarus 211, 740, doi:10.1016/j.icarus.2010.08.016) exist; **archive location unverified**.
- **Photometry:** Ciarniello et al. 2011, Hapke from VIMS for Rhea, Icarus 214, 541, doi:10.1016/j.icarus.2011.05.010.

### Uranian and Neptunian moons

- Voyager 2 imaged only about one hemisphere of each. USGS has `Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif` (300 MB): **"GlobalFill" means the gaps are filled; find out what with before use.** Areas without data stay U.
- Uranian moon disk photometry: Karkoschka 2001, Icarus 151, 51, doi:10.1006/icar.2001.6596.

### Pluto and Charon

- **Maps (USGS):** `Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif` (310 MB) and `Charon_…_300m_Jul2017_8bit.tif` (81 MB). LORRI+MVIC panchromatic. The far hemisphere is at much lower resolution. Cartography: Schenk et al. 2018, Icarus 314, 400, doi:10.1016/j.icarus.2018.06.008.
- **PDS SBN derived bundles:**
  - `https://pds-smallbodies.astro.umd.edu/holdings/pds4-nh_derived:plutosystem_geophysics-v1.0/albedo/nh_pluto_bond.img` (1 MB Bond-albedo map; also Charon).
  - `…plutosystem_composition-v1.0/color/` (MVIC colour cubes).
  - Albedo reference: Buratti et al. 2017, Icarus 287, 207, doi:10.1016/j.icarus.2016.11.012.
- **Phase curves** for Pluto, Charon, Arrokoth and large KBOs: Verbiscer et al. 2022, PSJ 3, 95, doi:10.3847/PSJ/ac63a6.

### Other mapped bodies (also useful in M3)

- `Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif` (27 MB)
- `Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd.tif` (357 MB)
- `Phobos_ME_SRC_Mosaic_Global_16ppd.tif` (16.6 MB)
- `Bennu/…ROLOphase_ALBEDO_8bit_v6.tif` (316 MB)

### Combining a panchromatic map with a measured disk spectrum honestly

Let M_b(x) be the map's normalised reflectance in band b, and p(λ) the measured disk-integrated geometric albedo spectrum (the M1 `photometry.json` input). Let ⟨·⟩ be the disk average with the α = 0 weighting of the body's photometric function.

1. **Pan only.** r(x,λ) = p(λ) · M_b(x)/⟨M_b⟩. Spatial brightness is M. Spatial colour variation is **assumed zero**, so colour is E. The inspector should say "colour variations not measured".
2. **Multiband.** Form the ratio ρ_b(x) = M_b(x)/⟨M_b⟩ at each band centre λ_b. Interpolate ρ in λ (piecewise-linear; report the PCHIP-vs-linear spread as `uncertainty`), hold it flat outside the outermost bands, then set r(x,λ) = p(λ)·ρ(x,λ).
   - This keeps the absolute spectrum measured, takes only relative spatial variation from the maps (what mosaics measure best), and makes the disk integral reproduce p(λ) by construction. That is the architecture §4.3 energy-consistency requirement.
   - Values are D at the band centres and E elsewhere. The final XYZ is E, but typically with a small uncertainty.
3. **Pansharpening** (colour at low resolution, pan at high resolution) adds an assumption: colour varies only on the coarse scale. Label E.
4. **Never use** stretched, HPF or "enhanced colour" products as radiometry. Never use radar or near-IR maps (Magellan, Titan 938 nm) in naked-eye mode.

---

## 1d. Photometric (BRDF) models from measurements

| Body | Model and source | Label |
|---|---|---|
| Moon | Per-pixel Hapke maps, 7 bands (Sato 2014, above). Theory: Hapke 2012, *Theory of Reflectance and Emittance Spectroscopy*, doi:10.1017/CBO9781139025683 | M |
| Mercury | Hapke and other models fitted to MDIS (Domingue et al. 2016, Icarus 268, 172, doi:10.1016/j.icarus.2015.11.040) | M (global parameters) |
| Venus | Disk phase curve only (Mallama 2006). A resolved BRDF must be fitted to it. | E |
| Earth land | MODIS MCD43 RossThick-LiSparse kernels | M |
| Earth ocean | Cox–Munk plus wind | D |
| Earth clouds | Radiative transfer (libRadtran, Emde et al. 2016, GMD 9, 1647, doi:10.5194/gmd-9-1647-2016) | E |
| Mars | Disk: Mallama 2007. Resolved: no global Hapke map; use Minnaert/Hapke fits. | D (disk), E (resolved) |
| Giant planets | Per-filter Minnaert k from each OPAL map (README). Disk: Mallama & Hilton 2018. | M |
| Galilean icy moons | Domingue & Verbiscer 1997; Mayorga 2020 phase curves | M |
| Rhea (and VIMS analogues) | Ciarniello 2011 | M |
| Pluto, Charon, Arrokoth | Buratti 2017; Verbiscer 2022; Hofgartner et al. 2021 (Arrokoth, Icarus 356, 113723, doi:10.1016/j.icarus.2020.113723) | M |
| Vesta | Li et al. 2013, Icarus 226, 1252, doi:10.1016/j.icarus.2013.08.011 | M |
| Ceres | Li et al. 2019, Icarus 322, 144, doi:10.1016/j.icarus.2018.12.038 | M |
| Bennu | Golish et al. 2021, Icarus 357, 113724, doi:10.1016/j.icarus.2020.113724 | M |
| Ryugu | Tatsumi et al. 2020, A&A 639, A83, doi:10.1051/0004-6361/201937096 | M |
| Eros | Clark et al. 2002, doi:10.1006/icar.2001.6748; Domingue et al. 2002, disk-integrated, doi:10.1006/icar.2001.6764 | M |
| 67P | Fornasier et al. 2015, A&A 583, A30, doi:10.1051/0004-6361/201525901 | M |
| Saturn's rings | Salo & French 2010, HST opposition and tilt effects, Icarus 210, 785, doi:10.1016/j.icarus.2010.07.002 | M |

When a body has only a disk phase curve, a resolved BRDF that integrates to that curve is a model choice: label it E and record which family was fitted.

---

## 1e. Rings

### Saturn geometry and optical depth (PDS Ring-Moon Systems Node, `https://pds-rings.seti.org/holdings/volumes/`)

- **UVIS stellar occultations, the best for visible light.** `COUVIS_8xxx/COUVIS_8001/data/UVIS_HSP_<date>_<star>_{I,E}_TAU{01,10}KM.TAB`: **277 occultation profiles** (ingress and egress counted separately), 2004–2017, about 10 MB (1 km bins) and 1 MB (10 km bins) of ASCII each.
  - Columns: ring radius, inertial longitude, `RING OCC PHI`, normal optical depth, maximum detectable τ, and TDB times. Each label gives `LIGHT_SOURCE_INCIDENCE_ANGLE` (the star's elevation B).
  - Citation: Colwell et al. 2010, AJ 140, 1569, doi:10.1088/0004-6256/140/6/1569.
  - The 110–190 nm wavelength does not matter: ring particles are ≫ λ, so extinction is geometric and the same in the visible.
- **Radio occultations.** `CORSS_8xxx/CORSS_8001/data/Rev*/…/RSS_*_TAU_01KM.TAB` (50 MB each at 1 km; `TAU_10KM` 5 MB; 3.6 and 13 cm and Ka band; Marouf et al. 1986, doi:10.1016/0019-1035(86)90078-3). Radio τ **differs from optical τ** where cm-sized particles dominate. Use it for sharp edges only.
- **VIMS stellar occultations:** `COVIMS_8xxx/COVIMS_8001`.
- **Self-gravity wakes.** In the A and B rings, line-of-sight τ depends on the viewing azimuth φ and elevation B, not just 1/|μ| (Hedman et al. 2007, AJ 133, 2624, doi:10.1086/516828; Nicholson & Hedman 2010, Icarus 206, 410, doi:10.1016/j.icarus.2009.07.028). The UVIS set samples many (B, φ). Fit the published "granola bar" wake parameters per radius (D), or interpolate between occultations. **Plain exp(−τ/μ) is wrong by tens of percent in the A ring.**

### Saturn ring colour and brightness

- **Spectra:** HST-STIS radially resolved spectra (Cuzzi et al. 2018, Icarus 309, 363, doi:10.1016/j.icarus.2018.02.025) are the best **visible** ring spectra. Cassini VIMS radial variability: Filacchione et al. 2012, Icarus 220, 1064, doi:10.1016/j.icarus.2012.06.040.
- **Phase and tilt:** Salo & French 2010.
- **Rendering physics:**
  - Lit face: single scattering from a many-particle-thick layer, I/F = (ϖ₀P(α)/4)·μ₀/(μ+μ₀)·[1−exp(−τ(1/μ+1/μ₀))]. Fit ϖ₀P(α) per radius to the measured I/F (D/E), then add multiple scattering if needed.
  - Unlit face: the same with transmission geometry, plus forward-scattering dust.
  - Ring shadow on the planet: transmission along the Sun ray through τ(r, B′, φ) (D).
  - Saturnshine on the rings and ringshine on the planet fall out of a two-way illumination pass.
  - Note: Saturn's equinox was in May 2025, so the solar elevation B′ is still low during the window; compute it from the ephemeris. Lit-face brightness is therefore low, and the wake-dependent transmission matters a lot for how the rings look.

### Uranus, Neptune and Jupiter rings

- **Uranus:** Voyager 2 PPS and UVS occultations `VG_28xx/VG_2801` and `VG_2802` (σ Sgr and β Per at Uranus); orbits from French et al. 1988, Icarus 73, 349, doi:10.1016/0019-1035(88)90104-2; photometry (very dark rings) from Karkoschka 2001.
- **Neptune:** `VG_2801/2802` (σ Sgr at Neptune). The Adams arcs evolve, so their current state is E.
- **Jupiter:** a faint dust ring, τ ~10⁻⁶, visible only in forward scatter (Throop et al. 2004, Icarus 172, 59, doi:10.1016/j.icarus.2003.12.020).

---

## 1f. Atmospheres at the limb: data for physically based rendering

- **Earth.**
  - Rayleigh cross-section: Bodhaine et al. 1999, doi:10.1175/1520-0426(1999)016<1854:ORODC>2.0.CO;2. This is physics from the refractive index (D).
  - Profiles: NOAA GFS analysis (0.25°, 6-hourly, no login, includes ozone mixing ratio) for **now**; ERA5 (Hersbach et al. 2020, doi:10.1002/qj.3803; ~5-day latency; CDS login) for reanalysis.
  - Ozone Chappuis absorption, which makes the twilight limb blue: Serdyuchenko et al. 2014, AMT 7, 625, doi:10.5194/amt-7-625-2014.
  - Aerosols: MERRA-2 (Gelaro et al. 2017, doi:10.1175/JCLI-D-16-0758.1; Earthdata Login) or CAMS.
  - Renderer: precomputed scattering (Bruneton & Neyret 2008, CGF 27, 1079, doi:10.1111/j.1467-8659.2008.01245.x) in spectral form, fed with the above.
  - Labels: gas profiles M (reanalysis), limb radiance D, aerosol microphysics E.
- **Mars:**
  - Column dust optical depth climatology from MCS: Montabone et al. 2015, Icarus 251, 65, doi:10.1016/j.icarus.2014.12.034, and 2020 (MY34), doi:10.1029/2019JE006111.
  - Dust single-scattering properties: Wolff et al. 2009, doi:10.1029/2009JE003350.
  - There is no public "now" dust product, so use the climatology at the current Ls (E).
- **Venus:** cloud and haze per Pérez-Hoyos 2018 (disk). Vertical structure from VIRA-type models (E).
- **Titan:** Tomasko 2008 and Doose 2016 aerosol models, derived from Huygens DISR measurements (D/E).
- **Pluto:** layered haze, blue in forward scatter (Cheng et al. 2017, Icarus 290, 112, doi:10.1016/j.icarus.2017.02.024).
- **Uranus/Neptune:** aerosol model of Irwin et al. 2022, JGR 127, e2022JE007189, doi:10.1029/2022JE007189 (the basis of the 2024 colours).

---

## Top recommendations

1. **Moons:** add a `satellites` stage using `jplephem excerpt --targets` against the NAIF satellite kernels (all 464 bodies for 138 MB instead of 13.7 GB; bit-identical to Horizons). Special-case sat480's type-17 moonlet, and never load the DE segments embedded in the satellite files.
2. **Move M1 to DE442s.** The newest moon kernels are fit to DE442, and DE440/442 differ by 1,371 km at Uranus and 376 km at Neptune.
3. **Orientation:** the Moon via `moon_pa_de440_200625.bpc` plus `moon_de440_250416.tf`, with maps in MOON_ME. The Earth via `earth_latest_high_prec.bpc` plus the long-term predict file, with the post-EOP part labelled E.
4. **The Moon is the showcase:** LROC WAC Hapke 7-band I/F plus per-pixel Hapke maps gives measured colour and measured photometry. Start M2 surfaces there.
5. **Giant planets:** OPAL cycle 32/33 FITS (CC BY 4.0, 26 MB/filter, Minnaert k included), each map stamped with its epoch.
6. **Earth now:** GIBS VIIRS CorrectedReflectance (daily, 250 m grid, with the stretch inverted and Rayleigh re-added by our atmosphere) plus GOES/Himawari 10-min red-band updates. Label by acquisition time; never use GeoColor or Blue Marble as data.
7. **Rings:** build τ(r, B, φ) from the 277 UVIS occultation profiles with a wake model; colour from HST-STIS (Cuzzi 2018).
8. **Colour rule for every body:** relative spatial variation from maps × absolute disk-integrated spectrum, with the disk integral preserved. Pan-only colour is E; bands are D; stretched products are banned.

## Open issues

- The Schenk 3-colour icy-moon maps: archive location not found.
- Triton "GlobalFill": the fill method needs checking.
- HRSC mosaic licence text is not on the page.
- Whether sat480's type-17 moonlet (a = 117,061 km) matters visually; its size is not given in the kernel.
