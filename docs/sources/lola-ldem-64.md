# LOLA gridded topography LDEM_64 (`lola-ldem-64`)

**What:** lunar radius from the Lunar Orbiter Laser Altimeter, gridded at 64 px/deg (473.8 m/px at the equator), pixel registered, int16 heights × 0.5 m relative to a 1737.4 km sphere, MEAN EARTH/POLAR AXIS OF DE421 frame. Version V3.1 (2019-03-15), LOLA data through mission phase LRO_ES_52, geolocated with the GRGM900C gravity field. 23040 × 11520 samples, 531 MB (`LDEM_64.IMG` + detached `LDEM_64.LBL`).

**Citation:** Smith, D. E. et al. (2010). The Lunar Orbiter Laser Altimeter investigation on the Lunar Reconnaissance Orbiter mission. *Space Science Reviews* 150, 209–241. DOI [10.1007/s11214-009-9512-y](https://doi.org/10.1007/s11214-009-9512-y). Data: LRO-L-LOLA-4-GDR-V1.0, PDS Geosciences Node, `https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img`.

**Caveat (from the label):** between laser tracks the grid is interpolated by the producer (GMT `surface`, tension 0.5). At low latitudes the track spacing is ~1–2 km, so the level-4 height layer (1.33 km texels) roughly matches the real sampling there; poleward the data are much denser.

**Processing:** box mean over each level-4 texel; height above the 1737.4 km sphere, which is also the pck00011 radius of the Moon. Label **measured**.
