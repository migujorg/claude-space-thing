# Ocean-surface wind speed for Earth's sun glint (`rss-amsr3-l3-daily`, `rss-gmi-bmaps-daily`)

**Use:** `surfaces/399/wind` (`surf_earth.build_wind`), kind `surface-wind`. The renderer uses it for the sun-glint slope variance of Cox & Munk (1954, JOSA 44, 838): σ² = 0.003 + 5.12e-3·U. Cox & Munk measured U at 12.5 m. For a neutral logarithmic profile with a roughness length of ~0.2 mm, U(12.5 m) ≈ 1.02·U(10 m), which is within the scatter of their fit (stated in the header's `constants.coxMunk`).

**Day:** 2026-09-28, the day of the cloud snapshot. NOAA's Blended Sea Winds near-real-time archive ends in 2024, the GIBS AMSR2 wind layers end 2025-09-01, and CCMP 3.1 has not reached this date. So the layer uses two Remote Sensing Systems radiometer products that are open without login.

| Source | File | Product |
|---|---|---|
| AMSR3 on GOSAT-GW, RSS V2.0 L3 daily | `https://data.remss.com/amsr3/ocean/L3/V2.0/daily/2026/RSS_AMSR3_ocean_L3_daily_2026-09-28_v2.0.nc` | `wind_speed_MF`: 10 m wind speed from the 18.7-36.5 GHz channels, 0.25° grid. Two passes: ascending ~13:30 local (the local time of the NOAA-20 cloud overpass) and descending ~01:30 |
| GMI on GPM, RSS v8.2 daily bytemaps | `https://data.remss.com/gmi/bmaps_v08.2/y2026/m09/f35_20260928v8.2.gz` | uint8 [2 passes][7 variables][720 lat from 89.875°S][1440 lon from 0.125°E]. Variable 3 is windMF × 0.2 m/s. Bytes > 250 mean land (255), ice (252), no observation or bad data. Layout from the RSS read routines (`support_v08.2/python`). Coverage ±70° latitude |

**Citations:** Wentz, F., Meissner, T., Ricciardulli, L., Mears, C., Densberger, M. & Nelson, K. (2026). RSS AMSR3 V2.0 Air-Sea Essential Climate Variables on 0.25° grid, version 1.0, Remote Sensing Systems. Wentz, F.J., Draper, D. & RSS (2015, updated daily). RSS GMI daily environmental suite, Version 8.2. Free with attribution.

**Channels (float16, NaN = unknown):**

- `windSpeed10mAscending`: the AMSR3 ascending pass.
- `windSpeed10mDailyMean`: the mean of every AMSR3 and GMI pass that saw the cell that UTC day.
- `passes`: how many passes went into the mean.

Level 2 (0.176°). Each texel takes the nearest 0.25° cell, found through the geodetic latitude of the texel's planetocentric centre. The label is **measured**: these are satellite retrievals, with no analysis or blending model. Land, sea ice, cells within ~50 km of coasts, rain (for the MF algorithm) and gaps between swaths are unknown. The first build covers 59 % of the sphere's area.
