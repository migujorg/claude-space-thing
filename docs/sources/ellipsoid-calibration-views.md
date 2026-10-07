# Disk-albedo calibration views for unequal-radii bodies

Audit of the adopted `light` sources against the pck00011 radii (initial continuation code read at `411903e`, then merged `rc` at `e6bfeaf`).
This note adds no observational source. The product's `albedoMeasurementView` cites the actual albedo
sources and distinguishes a compiled mean from a dated observation and an assumed single-observation view.

| Body | Adopted albedo / epoch | Reference view supported by source note |
|---|---|---|
| Mercury | Payne 2026 MASCS composite, global mean, scaled to Mallama 2017 | No single calibration latitude stated; derived orientation mean. |
| Earth | Himawari-9, 2025-03-20 02:30–02:39 UTC | Derived from the actual HSD/CGMS calibration frame and cached solar direction: observer latitude 0°, solar latitude and phase retained. Absolute Earth layers are exempt from disk scaling. |
| Mars | Mallama 2017 / Mallama 2007, rotation and season averaged | No single calibration latitude; derived orientation mean. |
| Jupiter | Karkoschka 1998/PDS, 1995 July 6–10 | Derived DE442s/IAU time-mean view over the five stated UTC dates; sub-observer approximately −2.916°. |
| Saturn | Same dates/source | Derived dated view, approximately −0.587°; the source describes the globe spectrum as zero ring tilt. The small distinction from exact equator-on is retained. |
| Uranus, Neptune | Same dates/source | Derived dated views: Uranus approximately −47.871°, Neptune −26.303°. The 1995 south-hemisphere view is retained. |
| Phobos | Fornasier 2024 HRSC broadband disk-integrated Hapke albedos | A model geometric albedo, not a single viewing latitude. Derived orientation mean; a resident shape mesh keeps the mesh rule. |
| Deimos | Wargnier 2025, 2004–2024 SRC Hapke fit | No single latitude; derived orientation mean. Phase remains unknown, so this change adds no light. |
| Io, Europa | Mayorga 2020, Cassini 2000–2001 phase-curve fits | Longitude slices stated; no single calibration latitude. Derived orientation mean for the α-only reference; in-domain rotation-slices photometry supplies the current-geometry value. Ganymede and Callisto have equal radii and retain the sphere path. |
| Mimas, Enceladus, Tethys, Dione, Rhea | Filacchione 2022 Cassini VIMS spatial fits | Extrapolated zero-phase Akimov coefficient (surface property), no single latitude. Derived orientation mean. |
| Titan | Karkoschka 1998/PDS, 1995 July 6–10 | Derived parent-system observing direction with the Titan IAU pole (approximately −0.753°). The satellite-centre offset is not recovered without a 1995 satellite SPK; this is an explicit accuracy gap. Its physical atmosphere keeps its existing integral calibration. |
| Phoebe | Grav 2015 compiled H/G photometry | No single latitude/epoch stated for compiled H. Derived orientation mean. |
| Ariel | DeColibus 2026 grand average, 2002–2024; Karkoschka 2001 F631N scaling | No single calibration latitude in the adopted note; derived orientation mean. |
| Iapetus, Miranda | No adopted disk albedo | View remains unknown; no invented light. |

The other unequal-radii bodies have no disk photometry record. A source date for a compilation or
fit is not an observation epoch and is not placed in `epoch`. For compiled sources, the product
states the source description in `method`; its lack of a single latitude is deliberate.
The solar direction of dated views is derived; compiled means are references by definition. Validation never selects them.

The five quadrature epochs integrate the 1995 July 6–10 UTC interval; they are not asserted to be the
individual exposure dates. The denominator averages the five integrals with their quadrature weights,
retaining each view's solar tangent (therefore its measured-epoch solar latitude and phase plane).
The product records the Earth-centre/telescope angular parallax bound from the pck00011 Earth radius
and DE442s range. Giant-planet directions use system barycentres, as the validation Sun geometry does;
no planetary centre outside the available satellite excerpts is invented.

**Recoverability limits found by reading the retained papers:** Mayorga 2020 §2.3 explicitly bounds
all spacecraft sub-observer latitudes to ±4°, and its Table 3 has image IDs, phase and longitude,
not latitude or UTC. A true exposure-weighted mean requires those archive geometries, not a uniform
mean over the six-month flyby. Filacchione 2022 §3 fits a global equigonal surface coefficient over
2004–2017 after angular correction; it is not an exposure-weighted disk albedo. The adopted note does
not give a numeric observer latitude distribution. DeColibus's 2002–2024 epochs describe the relative
spectral grand average, while its absolute scale comes from a separate Karkoschka 2001 HST figure;
using the spectral dates as that scale's calibration dates would assign the wrong observations.
These compiled measurements define orientation means; the reference integral is derived by that definition.
They require no exposure-weighted reconstruction. None of the unequal-radii bodies with an adopted
albedo is a single observation lacking both date and view. Unknown albedo remains unknown.


## Sentences establishing compiled means

- Mercury: `payne-2026.md`, “MESSENGER/MASCS global-mean reflectance (Izenberg et al. 2014), ×2 to match Mallama et al. (2017) broadband geometric albedos.”
- Mars: `mallama-2017.md`, “from Mallama 2007's photometry, rotation- and season-averaged”.
- Phobos: `fornasier-2024.md`, Tables 1/2 give disk-integrated Hapke albedos and H–G fits, with data coverage mostly 10–100° phase (Sec. 2.1).
- Deimos: `wargnier-2025.md`, the paper describes “analysis of 20 years of observations (2004–2024)” and Table 4 is the disk-integrated Hapke fit.
- Io, Europa (also spherical Ganymede/Callisto): `mayorga-2020.md`, “The zero-phase value of each fit is the geometric albedo in that filter”; the preceding sentence states 3299 WAC and 329 NAC images from 2000–2001.
- Mimas, Enceladus, Tethys, Dione, Rhea: `filacchione-2022.md`, a single model per wavelength “fitted to all Cassini VIMS pixels … over the whole mission” (specified angular limits retained in the product).
- Phoebe (also spherical Jovian irregulars): `grav-2015.md`, Table 1 H/G were compiled from Luu 1991, Rettig 2001, Grav 2003, Grav & Bauer 2007 and Bauer 2006.
- Ariel (also spherical Umbriel/Titania/Oberon): `decolibus-2026.md`, “The ‘All’ grand-average disk-integrated reflectance spectra … 2002–2024, all longitudes”; recommended absolute level is Karkoschka's HST geometric albedo, not a single spectral exposure.

These are means of the adopted photometry, not assertions of a uniform exposure distribution in the archives. The albedo and law retain their own assumptions and labels.
