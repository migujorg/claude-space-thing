# Disk-albedo calibration views for unequal-radii bodies

Audit of the adopted `light` sources against the pck00011 radii (code initially read at `4727d3a`).
This note adds no observational source. The product's `albedoMeasurementView` cites the actual albedo
sources and distinguishes a measured reference from an explicit normalization assumption.

| Body | Adopted albedo / epoch | Reference view supported by source note |
|---|---|---|
| Mercury | Payne 2026 MASCS composite, global mean, scaled to Mallama 2017 | No single calibration latitude stated; estimated orientation mean. |
| Earth | Himawari-9, 2025-03-20 02:30–02:39 UTC | The satellite-centred hemisphere is stated, but no numeric sub-observer latitude is given in the adopted note; orientation-mean fallback is recorded. Earth drawn with its absolute layers is exempt from disk scaling. |
| Mars | Mallama 2017 / Mallama 2007, rotation and season averaged | No single calibration latitude; estimated orientation mean. |
| Jupiter | Karkoschka 1998/PDS, 1995 July 6–10 | Equator-on reference represented by the equal-area radius; exact latitude 0° is an estimated reference approximation, not a measured observing latitude. |
| Saturn | Same dates/source | Zero ring tilt, equator-on globe; measured reference. |
| Uranus, Neptune | Same dates/source | Phase and epoch stated; calibration latitude unstated. Estimated orientation mean. |
| Phobos | Fornasier 2024 HRSC broadband disk-integrated Hapke albedos | A model geometric albedo, not a single viewing latitude. Estimated orientation mean; a resident shape mesh keeps the mesh rule. |
| Deimos | Wargnier 2025, 2004–2024 SRC Hapke fit | No single latitude; estimated orientation mean. Phase remains unknown, so this change adds no light. |
| Io, Europa | Mayorga 2020, Cassini 2000–2001 phase-curve fits | Longitude slices stated; no single calibration latitude. Estimated orientation mean for the α-only reference; in-domain rotation-slices photometry supplies the current-geometry value. Ganymede and Callisto have equal radii and retain the sphere path. |
| Mimas, Enceladus, Tethys, Dione, Rhea | Filacchione 2022 Cassini VIMS spatial fits | Extrapolated zero-phase Akimov coefficient (surface property), no single latitude. Estimated orientation mean. |
| Titan | Karkoschka 1998/PDS, 1995 July 6–10 | Latitude unstated; estimated orientation mean. Its physical atmosphere model keeps the existing model integral calibration; this lane does not change that model. |
| Phoebe | Grav 2015 compiled H/G photometry | No single latitude/epoch stated for compiled H. Estimated orientation mean. |
| Ariel | DeColibus 2026 grand average, 2002–2024; Karkoschka 2001 F631N scaling | No single calibration latitude in the adopted note; estimated orientation mean. |
| Iapetus, Miranda | No adopted disk albedo | View remains unknown; no invented light. |

The other unequal-radii bodies have no disk photometry record. A source date for a compilation or
fit is not an observation epoch and is not placed in `epoch`. For view-less sources, the product
states the fallback in `kind`, `label`, `sources`, and `method`; its lack of latitude is deliberate.
The Sun-displacement and rotation-average conventions are model assumptions independent of validation.
