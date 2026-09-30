# NOAA ETOPO 2022 global relief, 60″ surface elevation (`noaa-etopo-2022`)

**What:** ETOPO 2022 v1 is a global relief model of bathymetry and topography. We use the 60 arc-second "surface" variant: the ice-sheet surface over Antarctica and Greenland and the ice-shelf surface on floating shelves, bathymetry at sea. Heights are in metres relative to EGM2008, on a WGS84 geographic grid of 21600 × 10800 with latitude ascending from 89.99°S.

**Citation:** NOAA National Centers for Environmental Information (2022). ETOPO 2022 15 Arc-Second Global Relief Model. DOI [10.25921/fd45-gt74](https://doi.org/10.25921/fd45-gt74). Public domain.

**Access:** OPeNDAP at `https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc`, as one DAP2 binary subset `z.z[0:1:1799][0:1:21599]` (90°S–60°S, 156 MB). It is parsed as big-endian XDR after the `Data:` marker, and the DDS dimensions are checked.

**Use (`surf_earth.py`):** only as the land/water mask south of 60°S, where MOD44W has no data: water where elevation ≤ 0 m. Ice shelves count as land (no glint). Land south of 60°S comes out at 13.85 million km², close to Antarctica's area including its ice shelves (≈ 14.0 million km²). This one file is kept in data/raw for rebuilds.
