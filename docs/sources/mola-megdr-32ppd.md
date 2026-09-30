# MGS MOLA MEGDR planetary radius, 32 px/deg (`mola-megdr-32ppd`)

**What:** `MEGR90N000FB.IMG`: Mars planetary radius from the Mars Orbiter Laser Altimeter, 32 px/deg (11520 × 5760), big-endian int16 metres with offset 3,396,000 m, planetocentric latitude, east longitude (0–360, centre longitude 180°), pixel registered. Gaps between tracks interpolated by the producer.

**Citation:** Smith, D. E. et al. (2001). Mars Orbiter Laser Altimeter: experiment summary after the first year of global mapping of Mars. *JGR* 106, 23689–23722. DOI [10.1029/2000JE001364](https://doi.org/10.1029/2000JE001364). Data: Smith, D., Neumann, G., Arvidson, R. E., Guinness, E. A. & Slavney, S. (2003), MGS-M-MOLA-5-MEGDR-L3-V1.0, NASA PDS Geosciences Node, `https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg032/megr90n000fb.img` (+ `.lbl`).

**Use (`surf_mars.py`):** level-4 box means of the radius, minus the pck00011 Mars ellipsoid (3396.19 × 3396.19 × 3376.20 km) at each texel: height above the reference ellipsoid (not the areoid, which is what the `megt` topography files use). Label **measured**.
