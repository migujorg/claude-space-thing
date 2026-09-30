# smallbodies-class-albedo, bowell-1989: population values behind `estimated` small-body attributes

Two attributes of most asteroids are not measured, and the products fill them only as separate, `estimated` values.

## Diameter from H (`core.diameterFromH`)

- **Formula:** D = 1329 km / √p_V · 10^(−H/5). Pravec, P. & Harris, A. W. (2007). Binary asteroid population 1. Angular momentum content. Icarus 190, 250-259. DOI:10.1016/j.icarus.2007.02.023, Eq. 3.
- **p_V:** the object's own measured albedo when it has one (then the diameter has no assumed input and is labelled `derived`); otherwise the **median measured p_V of its SBDB orbit class**, computed by the stage from every measured albedo in the product (jpl-sbdb-physical and neowise-v2). Classes with fewer than 20 measured albedos use the median over all classes. The medians, 16th/84th percentiles and sample sizes are written to `smallbodies/core.json` → `classAlbedo`; the 16th-84th range is the honest uncertainty of an estimated diameter (roughly ±40 % in D).
- **Not for comets:** a comet's total magnitude is not a nucleus magnitude.
- **Caveats:** the measured sample is biased (thermal-infrared surveys detect dark objects more readily than optical surveys do, and albedo correlates with size and family), and catalogue H values have H-dependent offsets of a few tenths of a magnitude (Pravec et al. 2012, Icarus 221, 365).

## Slope parameter G (`core.G`)

- **Value:** G = 0.15 where the SBDB has no fitted G (only 120 objects have one).
- **Citation:** Bowell, E., Hapke, B., Domingue, D., Lumme, K., Peltoniemi, J. & Harris, A. W. (1989). Application of photometric models to asteroids. In Asteroids II, University of Arizona Press, 524-556 (the IAU H-G system; G = 0.15 is the value the MPC and JPL adopt when none is fitted).
- **Label:** `estimated` (a population value). Fitted G (and the G1/G2 of later surveys, not yet ingested) would be `measured`.
