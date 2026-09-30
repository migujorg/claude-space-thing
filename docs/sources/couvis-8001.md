# Saturn ring optical depth: Cassini UVIS HSP occultation (`couvis-8001-betcen-2008-231-i`)

**Data:** NASA PDS Ring-Moon Systems Node, volume COUVIS_8001 (data set `CO-SR-UVIS-HSP-2/4-OCC-V3.0`, version 3.0, 2021-01-08). Product `UVIS_HSP_2008_231_BETCEN_I_TAU10KM.TAB` and its `.LBL`, `https://pds-rings.seti.org/holdings/volumes/COUVIS_8xxx/COUVIS_8001/data/`. Both are fetched, sha256 recorded, and the label is parsed for the geometry.

**Reduction:** Colwell, J. E., Esposito, L. W., Jerousek, R. G., Sremčević, M., Pettis, D. & Bradley, E. T. (2010). Cassini UVIS stellar occultation observations of Saturn's rings. *Astronomical Journal* 140, 1569–1578. DOI [10.1088/0004-6256/140/6/1569](https://doi.org/10.1088/0004-6256/140/6/1569).

**Why this profile:** the volume index (`index/index.tab`) lists 275 profiles at 10 km. The chosen one:
- has one of the steepest lines of sight (ring-plane elevation B = 66.7°), which minimizes the effect of self-gravity wakes and maximizes the measurable optical depth: the median maximum detectable τ⊥ in the B ring is 7.6;
- covers 72 833–151 675 km (C ring to beyond the F ring) with < 1 % unconstrained bins in the main rings;
- is β Cen (2008 day 231, orbit 81, ingress). The label flags "light from two stars" (β Cen is a close binary), which is harmless at 10 km.

**Use** (`rings.json` → `699.opticalDepth`, label **measured**):
- radius, normal optical depth (−1 → null), and the maximum detectable normal optical depth: values at or above it are lower limits;
- the occultation geometry is kept in `observation`.

**Caveats:**
- Wavelength 110–190 nm. Extinction by ring particles much larger than the wavelength is taken to be the same in the visible.
- In the A and B rings the slant optical depth depends on viewing azimuth and elevation (self-gravity wakes; Colwell et al. 2010; Hedman et al. 2007), so τ⊥/|sin B| is approximate for other geometries.
- One cut through the rings: the F ring and the eccentric ringlets vary with longitude.
