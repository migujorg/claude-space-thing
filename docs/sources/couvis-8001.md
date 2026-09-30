# Saturn ring optical depth: Cassini UVIS HSP occultation (`couvis-8001-betcen-2008-231-i`)

**Data:** NASA PDS Ring-Moon Systems Node, volume COUVIS_8001 (data set `CO-SR-UVIS-HSP-2/4-OCC-V3.0`, version 3.0, 2021-01-08). Product `UVIS_HSP_2008_231_BETCEN_I_TAU10KM.TAB` and its `.LBL`, `https://pds-rings.seti.org/holdings/volumes/COUVIS_8xxx/COUVIS_8001/data/`. Both are fetched, sha256 recorded, and the label is parsed for the geometry.

**Reduction:** Colwell, J. E., Esposito, L. W., Jerousek, R. G., Sremčević, M., Pettis, D. & Bradley, E. T. (2010). Cassini UVIS stellar occultation observations of Saturn's rings. *Astronomical Journal* 140, 1569–1578. DOI [10.1088/0004-6256/140/6/1569](https://doi.org/10.1088/0004-6256/140/6/1569).

**Why this profile:** the volume index (`index/index.tab`) lists 275 profiles at 10 km. The chosen one:
- has one of the steepest lines of sight (ring-plane elevation B = 66.7°), which minimizes the effect of self-gravity wakes and maximizes the measurable optical depth: the median maximum detectable τ⊥ in the B ring is 7.6;
- covers 72 833–151 675 km (C ring to beyond the F ring) with < 1 % unconstrained bins in the main rings;
- is β Cen (2008 day 231, orbit 81, ingress). The label flags "light from two stars" (β Cen is a close binary), which is harmless at 10 km.

**Use** (`rings.json` → `699.opticalDepth`, label **measured**):
- radius, normal optical depth (−1 or the "corrupted" flag → null), and the maximum detectable normal optical depth: values at or above it are lower limits;
- the occultation geometry is kept in `observation`.

**Bins consistent with τ⊥ = 0 are set to 0** (`rings.clean_saturn_tau`, since the M3 rendering check; `tests/test_rings.py`). The label documents the calibration: τ⊥ = −|sin B| ln[(S − B)/(I0 − B)], with the mean signal S (background not subtracted), the background model B, the unocculted-star model I0, and N samples per bin.
- **Noise.** The 1σ photon noise per bin is σ_τ = |sin B|·√(S/N)/(I0 − B)/T. It is 0.0010 in the empty regions, where it matches the observed scatter (1.1σ inside the C ring).
- **Main rings** (the C ring inner edge at 74 493 km, the first run of ≥ 3 bins above 5σ, to the A ring outer edge at 136 763 km, the end of the last run of ≥ 200 km with τ⊥ > 0.2): only negative values change. There are 57 of them, 7 below −3σ; those 7 lie in or next to gaps and sharp edges (77 893–77 913, 87 505–87 515, 117 489, 119 900 and 133 432 km), where unmodelled light makes T > 1. They are set to 0, since τ⊥ cannot be negative. Until this fix, every negative bin (343 in the whole profile) was emitted as null ("unconstrained").
- **Outside the main rings:**
  - Inside, 72 833–74 493 km, the archived values are already noise around 0.
  - Outside, beyond the F ring, the archived τ⊥ rises smoothly from 0 at 141 000 km to 0.10 at the profile's end (151 675 km). The ring plane there is empty far below the 0.003 (3σ) detection limit. The same ramp appears with other sizes in other occultations: the other β Cen occultation at the same elevation (2008-343) reaches half of it, and θ Car (2013-141) rises much faster. It is therefore an unmodelled instrumental trend in the star signal, not ring material.
  - Both zones are handled alike. A smooth 2010 km running median is removed (the residual scatter is 1.2σ outside); bins within 3σ, and isolated single bins above 3σ, become 0 (1619 bins); runs of ≥ 2 bins above 3σ are kept as structure with the baseline removed (38 bins: the F ring core and strands, 137 083–140 433 km).
- **Result:** every bin beyond 140 440 km and inside 74 493 km is 0. The profile stays **measured**, meaning no material above the detection limit.

**Caveats:**
- Wavelength 110–190 nm. Extinction by ring particles much larger than the wavelength is taken to be the same in the visible.
- In the A and B rings the slant optical depth depends on viewing azimuth and elevation (self-gravity wakes; Colwell et al. 2010; Hedman et al. 2007), so τ⊥/|sin B| is approximate for other geometries.
- One cut through the rings: the F ring and the eccentric ringlets vary with longitude.
