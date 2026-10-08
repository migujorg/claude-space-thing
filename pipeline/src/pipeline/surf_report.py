"""docs/reports/surfaces.md — review report of the surface maps, generated from the built layer headers and tiles.

`uv run python -m pipeline.surf_report` (after `build --only surfaces` and `python -m pipeline.surf_preview`).
All numbers are computed from app/public/data; the prose is written by hand in this file.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import subprocess

import numpy as np

from . import surf_tiles as st
from .paths import OUT, RAW, REPO

REPORT = REPO / "docs" / "reports" / "surfaces.md"


def _headers() -> dict[tuple[int, str], dict]:
    out = {}
    for p in sorted((OUT / "surfaces").glob("*/*.json")):
        h = json.loads(p.read_text(encoding="utf-8"))
        out[(h["body"], h["layer"])] = h
    return out


def _km_per_texel(naif: int, level: int) -> float:
    from .photometry.albedo import pck_radii
    a = pck_radii()[naif][0]
    return 2 * math.pi * a / st.level_shape(level)[1]


def _ring(arr, level, lat0, lon0, r0, r1, radius):
    lat = np.radians(st.lat_centers(level))[:, None]
    lon = np.radians(st.lon_centers(level))[None, :]
    p0, l0 = math.radians(lat0), math.radians(lon0)
    c = np.sin(p0) * np.sin(lat) + np.cos(p0) * np.cos(lat) * np.cos(lon - l0)
    d = radius * np.arccos(np.clip(c, -1, 1))
    sel = (d >= r0) & (d < r1) & np.isfinite(arr) & (arr != 0)
    return float(arr[sel].mean())


def verification(hs: dict) -> list[str]:
    lines = []
    if (301, "height") in hs:
        h = hs[(301, "height")]
        z = st.read_level(OUT, 301, "height", h["maxLevel"], 1, "f32")[..., 0]
        floor = _ring(z, h["maxLevel"], -43.2958, -11.2153, 0, 15, 1737.4)
        rim = _ring(z, h["maxLevel"], -43.2958, -11.2153, 38, 48, 1737.4)
        lines.append(f"- **Moon, Tycho (43.30°S, 11.22°W, IAU Gazetteer), height layer level {h['maxLevel']}:** mean "
                     f"height within 15 km of the centre {floor:.0f} m, on the 38–48 km rim ring {rim:.0f} m: the crater "
                     f"is {rim - floor:.0f} m deep at the right place (test: > 3000 m; published floor-to-rim depth "
                     "≈ 4.8 km, smoothed by 1.3 km texels).")
    if (301, "albedo") in hs:
        y = st.read_level(OUT, 301, "albedo", 4, 4, "f16")[..., 1]
        t_in = _ring(y, 4, -43.2958, -11.2153, 0, 60, 1737.4)
        t_out = _ring(y, 4, -43.2958, -11.2153, 200, 400, 1737.4)
        c_in = _ring(y, 4, 17.0, 59.1, 0, 150, 1737.4)
        c_out = _ring(y, 4, 17.0, 59.1, 350, 550, 1737.4)
        lines.append(f"- **Moon albedo (level 4, Y):** Tycho's ejecta (≤ 60 km) are {t_in / t_out:.2f}× their "
                     f"200–400 km surroundings; Mare Crisium (17.0°N, 59.1°E) is {c_in / c_out:.2f}× the highlands "
                     "350–550 km from its centre (tests: > 1.15 and < 0.8).")
        d = hs[(301, "albedo")]["diagnostics"]
        if "hapkeModelCheck" in d:
            mc = d["hapkeModelCheck"]
            lines.append("- **Moon, our Hapke implementation vs the product:** mosaic I/F ÷ model RADF(60°,0°,60°) "
                         "per 1° cell, median by band: " + ", ".join(
                             f"{b} nm {mc[b]['median']:.3f}" for b in mc if b != "what")
                         + " (5–95 % ranges within ±5 %). The few-percent, band-dependent offset is common to all "
                           "cells of a band, so it cancels in the relative texels; the per-cell conversion factor "
                           "depends only on the parameter ratios.")
    if (599, "albedo") in hs:
        from scipy.ndimage import uniform_filter
        h = hs[(599, "albedo")]
        L = h["maxLevel"]
        a = st.read_level(OUT, 599, "albedo", L, 4, "f16")
        known = (a != 0).any(axis=2)
        r = np.where(known, a[..., 0] / np.where(known, a[..., 2], 1), 0)
        k = uniform_filter(known.astype(float), (24, 48), mode="wrap")
        s = uniform_filter(r, (24, 48), mode="wrap") / np.maximum(k, 1e-6)
        lat = st.lat_centers(L)
        s[~((lat < -10) & (lat > -35))] = -np.inf
        s[k < 0.9] = -np.inf
        j, i = np.unravel_index(np.argmax(s), s.shape)
        lon = st.lon_centers(L)[i]
        jc = h["diagnostics"]["longitudeDirectionCheck"]
        lines.append(f"- **Jupiter, Great Red Spot:** the reddest (max X/Z) large feature between 10°S and 35°S is at "
                     f"{-lat[j]:.1f}°S planetocentric, {(-lon) % 360:.0f}°W System III (east {lon:.0f}°); expected "
                     "19.6°S planetocentric (≈ 22.2°S planetographic; e.g. Simon et al. 2018, AJ 155, 151), test tolerance "
                     f"1.5°. **Longitude direction:** the 23.7°N prograde jet moved {jc['eastwardShiftDeg']:+.1f}° east "
                     f"between the two December 2025 rotations ({jc['hoursBetweenMaps']} h), as it must if east "
                     "longitude increases to the right in the converted maps.")
    for naif, hemi in ((799, "north"), (899, "south")):
        if (naif, "albedo") in hs:
            h = hs[(naif, "albedo")]
            reg = h["coverage"]["regions"][0]
            lines.append(f"- **{h['bodyName']}:** data from {reg['latMin']:.0f}° to {reg['latMax']:.0f}° "
                         f"(planetocentric): the {hemi} pole faces Earth in 2025, as expected (test).")
    if (399, "albedo") in hs and (399, "water") in hs:
        L = hs[(399, "albedo")]["maxLevel"]
        y = st.read_level(OUT, 399, "albedo", L, 4, "f16")[..., 1] * hs[(399, "albedo")]["normalization"][
            "absoluteDiskMean"]["Y"]
        w = st.read_level(OUT, 399, "water", L, 2, "f16", nodata="nan")[..., 0]
        lat, lon = st.lat_centers(L), st.lon_centers(L)
        land, sea = (y > 0) & (w < 0.01), (y > 0) & (w > 0.99)
        sah = y[(lat > 20) & (lat < 28)][:, (lon > 0) & (lon < 20)]
        ama = y[(lat > -10) & (lat < 0)][:, (lon > -70) & (lon < -55)]
        wd = hs[(399, "water")]["diagnostics"]
        lines.append(f"- **Earth albedo (level {L}, absolute Y):** median land {np.median(y[land]):.3f}, open water "
                     f"{np.median(y[sea]):.4f}; Sahara (20–28°N, 0–20°E) {np.median(sah[sah > 0]):.3f}, Amazon "
                     f"forest (0–10°S, 55–70°W) {np.median(ama[ama > 0]):.3f} (tests: land > 2.5× water, Sahara > 1.5× "
                     f"land median). Water covers {wd['waterAreaFraction'] * 100:.1f} % of the area (ocean ≈ 70.8 % + "
                     "inland water); MOD44W land samples that have a MUR sea-ice value (coastline mismatch) "
                     f"{wd['maskAgreement']['mod44wLandSamplesWithSeaIceValue'] * 100:.3f} %.")
    if (399, "wind") in hs:
        h = hs[(399, "wind")]
        L = h["maxLevel"]
        u = st.read_level(OUT, 399, "wind", L, 3, "f16", nodata="nan")
        lat = st.lat_centers(L)
        wgt = np.broadcast_to(np.cos(np.radians(lat))[:, None], u.shape[:2])
        ok = np.isfinite(u[..., 1])
        trades = u[(lat > 10) & (lat < 25), :, 1]
        south = u[(lat > -60) & (lat < -45), :, 1]
        lines.append(f"- **Earth wind (level {L}, U10 daily mean, {h['epoch']['start'][:10]}):** known on "
                     f"{wgt[ok].sum() / wgt.sum() * 100:.0f} % of the sphere's area, area-weighted mean "
                     f"{np.average(u[..., 1][ok], weights=wgt[ok]):.1f} m/s; trade-wind belt (10–25°N) median "
                     f"{np.nanmedian(trades):.1f} m/s, Southern Ocean (45–60°S) median {np.nanmedian(south):.1f} m/s.")
    if (399, "night") in hs:
        h = hs[(399, "night")]
        L = h["maxLevel"]
        r = st.read_level(OUT, 399, "night", L, 2, "f16", nodata="nan")[..., 0]
        lat, lon = st.lat_centers(L), st.lon_centers(L)

        def peak(la, lo):
            i, j = int(np.argmin(abs(lat - la))), int(np.argmin(abs(lon - lo)))
            return float(np.nanmax(r[i - 3:i + 4, j - 3:j + 4]))
        lines.append(f"- **Earth night lights (level {L}):** peak radiance near Paris {peak(48.86, 2.35):.1f}, New York "
                     f"{peak(40.71, -74.0):.1f}, Cairo {peak(30.04, 31.24):.1f}, central Sahara {peak(23.0, 12.0):.2f} "
                     "nW cm⁻² sr⁻¹ (texel means; samples ≥ 38.2 are lower bounds).")
    for (naif, layer), h in sorted(hs.items()):
        g = h.get("diagnostics", {}).get("georeferencing")
        if g and g.get("passed") is not None:
            lines.append(f"- **{h['bodyName']}, {g['feature']}** ({g['latDeg']:.2f}°, {g['lonEastDeg']:.2f}°E; "
                         f"{g['coordinates'].split(':')[0]}): contrast to its surroundings "
                         f"{g['contrastAtFeature']:.2f} vs {g['contrastAtMirroredLongitude']:.2f} at the mirrored "
                         f"longitude (expected {g['expected']}).")
    return lines


def _short(v):
    if isinstance(v, float):
        return f"{v:.4g}"
    if isinstance(v, list):
        return "[" + ", ".join(_short(x) for x in v) + "]"
    return v


def earth_numbers(hs: dict) -> str:
    """Computed Earth facts: absolute calibration, composition, epochs."""
    h = hs[(399, "albedo")]
    n, d = h["normalization"], h["diagnostics"]
    a = n["absoluteDiskMean"]
    lam = n["lambertSphereGeometricAlbedo"]
    try:
        phot = json.loads((OUT / "photometry.json").read_text(encoding="utf-8"))["399"]
        pv = phot["geometricAlbedoV"]["value"]
        sun = json.loads((OUT / "light.json").read_text(encoding="utf-8"))["sun"]["irradianceXYZS_1AU"]["value"]
        pc = [p / s for p, s in zip(phot["geometricAlbedoXYZS"]["value"], sun)]
    except (FileNotFoundError, KeyError):
        pv, pc = None, None
    lines = [f"**Absolute calibration implied by the albedo map.** Disk-mean surface reflectance (cos²φ, known texels) "
             f"X {a['X']:.4f}, Y {a['Y']:.4f}, Z {a['Z']:.4f}, S {a['S']:.4f}. A Lambertian sphere with this surface "
             f"would have a geometric albedo of {lam['Y']:.4f} (Y); Earth's disk photometry "
             + (f"(photometry.json, a radiative-transfer model with clouds and atmosphere) has p_V = {pv:.3f}, so "
                f"the bare surface is ~{lam['Y'] / pv * 100:.0f} % of the disk's brightness and clouds plus Rayleigh "
                "scattering make up the rest. Per channel (X, Y, Z, S), the model disk's geometric albedo is "
                + ", ".join(f"{v:.3f}" for v in pc) + " against the bare-surface Lambert values "
                + ", ".join(f"{lam[c]:.4f}" for c in "XYZS") + ". " if pv else "is not available here. ")
             + f"Disk weight: ocean {d['diskWeightShare']['ocean'] * 100:.1f} %, land "
             f"{d['diskWeightShare']['land'] * 100:.1f} %, MODIS-measured water "
             f"{d['diskWeightShare']['modisWater'] * 100:.1f} %; {h['coverage']['diskWeightFraction'] * 100:.1f} % of "
             f"the disk weight is known ({d['mcd43Tiles']} MODIS tiles; negative texels clipped: "
             f"{d['negativeTexelsClipped']})."]
    for layer in ("clouds", "cloudTau", "cloudTauEstimated", "night", "water"):
        if (399, layer) in hs:
            x = hs[(399, layer)]
            ep = x.get("epoch", {})
            lines.append(f"**{layer}:** {x['brightness']['method']} Epoch: {ep.get('observed', '')}. Coverage "
                         f"{x['coverage']['areaFraction']:.3f} of the area; diagnostics "
                         + ", ".join(f"{k} {_short(v)}" for k, v in x.get("diagnostics", {}).items()
                                     if isinstance(v, (int, float)) or k == "daylitLatitudeRange") + ".")
    return "\n\n".join(lines)


def _fmt_mib(b: int) -> str:
    return f"{b / 2**20:.1f}"


BODY_NOTES = {
    399: """**Sources.** Land: MODIS MCD43A4 v061 nadir BRDF-adjusted reflectance, pinned to A2026257 (centre day 2026-09-14; 16-day window 2026-09-06–2026-09-21), bands 469/555/645 nm. The 315 granule identities and three band URLs are pinned by `MCD_GRANULES_SHA256` in `surf_earth.py`, including their processing stamps; a different catalogue selection fails instead of silently replacing them. It comes from the Microsoft Planetary Computer's cloud-optimized copies: the 926 m overview is read by byte range and box-averaged exactly from the sinusoidal grid. Water: ESA OC-CCI v6.0 monthly remote-sensing reflectance (412–665 nm, 4 km), ρw = π·Rrs, for the same season one year earlier (September 2025). Land/water split: MOD44W v6 (250 m), pinned to 2015-01-01, north of 60°S. MOD44W does not map Antarctica, and GIBS draws its no-data value in the water colour, so south of 60°S we use ETOPO 2022 surface elevation ≤ 0 m (ice shelves count as land). Clouds: the SatCORPS GEOSat+LEO composite, a mosaic of 2026-09-28 (UTC) near 13:30 local solar time in 24 longitude strips; wind follows the same day. The three layers retain cloud fraction/phase/top height and separate retrieved from provider-estimated optical-thickness moments. Night lights: NASA GIBS science layers decoded through their published colour maps, using the cached capabilities snapshot pinned to 2026-10-04 and its SHA-256 in `surf_gibs.py` (never the build date). Night lights are Black Marble VJ146A2 at-surface radiance, pinned to 2026-10-02. Sea ice: GHRSST MUR, pinned to 2026-10-02. These module pins are part of the surfaces code fingerprint. The headers report the pinned dates in `epoch` and/or `constants`; GIBS defaults and MODIS “latest” are never rebuild selectors. Notes: `docs/sources/modis-mcd43a4-v061.md`, `esa-oc-cci-v6-rrs.md`, `satcorps-gcc.md`, `nasa-gibs.md`, `night-lights-luminance.md`.

**What we avoided.** GIBS "Corrected Reflectance" true colour is Rayleigh-corrected and contrast-stretched, and GeoColor is partly synthetic, so neither is used. Every value here is a documented physical quantity: reflectance factor, optical thickness, height, or radiance.

**What the renderer does with it.** Surface = albedo × absoluteDiskMean (diffuse; NBAR is the nadir-view reflectance with the Sun at local noon, and land BRDF effects must come from the photometric model). Water adds Fresnel reflection and sun glint on waterFraction × (1 − seaIceFraction). Clouds are shaded from optical-thickness moments, phase and top height in the mosaic. Strict admits retrieved thickness; Best/Complete also admit provider estimates. Cloud without admitted thickness is drawn as not measured; no partly-cloudy statistic fills it. Rayleigh scattering and aerosols belong to the atmosphere model, not to these maps. Night side: radiance × `toXYZS` for an assumed lamp spectrum (colour `estimated`).

**Known issues.** Sea ice has no reflectance (neither product retrieves it) and is unknown in the albedo. The land colour is estimated from three MODIS bands, and the flat hold beyond 645 nm misses vegetation's red edge. The clouds are a mosaic of one UTC day's 13:30 local hours (SatCORPS composite: 24 strips of 15° cut one hour apart, a 24-hour seam at 150° W; the cuts are real discontinuities in the weather shown), and cloud without a thickness retrieved from sunlight is drawn as not measured at Strict (docs/rendering-earth.md §2). Night-light radiances ≥ 38.2 nW cm⁻² sr⁻¹ are lower bounds (censoredFraction). The lamp-spectrum factors are upper limits, because the CIE tables stop at 780 nm while the Day/Night Band reaches ~900 nm.""",
    999: """**Source.** New Horizons MVIC global colour map (PDS SBN `nh_derived:plutosystem_composition`). Calibrated MVIC scans were converted to normal albedo with a lunar-Lambert function (L(15°) = 0.65), registered to the LORRI base map, and merged with it to full resolution. Blue 475, Red 625 and NIR 870 nm are used; CH4 895 nm is not. This replaces the USGS 8-bit panchromatic mosaic, whose brightness was an inverted display stretch and whose colour was the disk colour. The brightness is now `measured` and the colour varies per texel (`estimated`: two visible bands 150 nm apart). The MVIC map covers less than the panchromatic mosaic did (area 0.72 vs 0.77); the rest is unknown.""",
    901: """**Source.** New Horizons MVIC global colour map, as for Pluto (1 km/px cube). Brightness `measured`, colour `estimated`. Coverage 0.60 of the area, against 0.74 for the USGS panchromatic mosaic it replaces: the sub-Pluto hemisphere is well covered, and the far side and the dark south are unknown.""",
    301: """**Source.** LROC WAC Hapke-normalized 7-band mosaic (Sato et al. 2017) for 70°S–70°N; LROC WAC empirically normalized polar mosaics (Boyd et al. 2012) poleward, tied to the Hapke product per band in the 62–69.5° ring; LOLA LDEM_64 for height; the LROC per-cell Hapke parameter maps (Sato et al. 2014) exported as the `hapke` layer. Notes: `docs/sources/lroc-wac-hapke-7band.md`, `lroc-wac-hapke-parameters.md`, `lroc-wac-emp-polar.md`, `lola-ldem-64.md`.

**What a texel is.** Normal albedo *without* the shadow-hiding opposition surge, relative to its disk mean, per band, then XYZS. The WAC product is I/F at i = g = 60°, e = 0; we multiply by RADF(0,0,0; B_S0 = 0)/RADF(60,0,60) from the same published per-1°-cell Hapke model that produced the normalization. The surge is left out because the disk albedo the renderer multiplies by (Lane & Irvine 1973) also leaves it out, and because h_s sits at a fit bound (0 or 0.2) in hundreds of cells; keeping it would change texels by the amounts in `diagnostics.surgeSensitivity`. The disk-mean normal albedo in each band (header `normalization.bandNormalAlbedoDiskMean`, 0.074 at 566 nm) is lower than Lane & Irvine's p ≈ 0.12 because their linear extrapolation from 6° keeps part of the broad Hapke surge; only the ratios are used.

**689–830 nm.** The bands end at 689 nm. Beyond it the band ratio is held at its 689 nm value. That range carries 0.32 % of X, 0.12 % of Y and nothing of Z and S in the Moon's sunlight-weighted integrand, so even a ±10 % error in the red ratio moves X by < 0.04 %. It does not change the label: the colour is already `estimated` because of the 151 nm gap between 415 and 566 nm (criterion below).

**Poles.** The Hapke product stops at 70°. The WAC_GLOBAL morphology mosaic is a shaded image, not albedo, and is not used. The polar EMP tiles give 7-band normalized reflectance to the poles where the Sun ever lit the ground; per-band scale factors to the Hapke-derived albedo are 0.97–1.07 (header `diagnostics.polarScale`), with an interquartile spread of ~6 % and a trend of ≤ 1 % across the ring. Their coverage falls from > 98 % at 70° to ~30–40 % above 85° (permanently shadowed floors); those texels are unknown.

**Known issues.** 1° Hapke cells are interpolated bilinearly; the conversion factor varies 3–5 % rms, so any error in a cell's parameters shows up as a soft 1° pattern of that size. The polar caps are `estimated`. The LROC/LOLA frame is DE421 mean-Earth; the app's IAU_MOON differs by ~0.1–0.2 km, below one level-5 texel.""",
    599: """**Source.** Hubble OPAL global maps (Simon et al. 2015; MAST HLSP doi:10.17909/T9G593, CC BY 4.0), cycle 32, second rotation of 2025 December 11–12. Continuum filters F395N, F467M, F502N, F631N, F658N; F275W and F343N are below 360 nm, FQ889N is a methane band. The OPAL team removed limb darkening with a Minnaert law per filter (k and the I/F scale are parsed from the cycle README).

**Geometry.** 3600 × 1800 cell-registered maps, System III west longitude with 0° W at the left edge decreasing to the right (east longitude increasing to the right), planetographic latitude on the 71492 × 66854 km ellipsoid → converted to planetocentric. Level 3 (4096 × 2048, 0.088°) slightly oversamples the 0.1° maps (linear interpolation).

**Epoch.** Cloud features drift relative to System III (the strongest jets move features by several degrees per rotation, the GRS drifts slowly west). The header carries the observation window; rendering the map at another time is `estimated`.

**Limb cut.** The Minnaert correction diverges towards the limb, and the OPAL maps show filter-dependent artefacts there. Latitudes seen at emission > 72.5° even at central-meridian passage (sub-Earth latitude at the map epoch from DE442s + pck00011; `diagnostics.limbCut`) are left unknown — for Jupiter everything poleward of about 71°S/74°N planetographic. The same rule applies to all four giant planets.

**Known issues.** Colour: the 502–631 nm gap straddles the peak of ȳ.""",
    699: """**Source.** OPAL cycle 32, second rotation of 2025 August 29 (F395N, F467M, F502N, F631N, F763M; FQ727N and FQ889N are methane bands, F225W is UV). 1800 × 900 maps (0.2°), System III, planetographic on 60268 × 54364 km → planetocentric; level 2.

**Known issues.** The README warns that moons and their shadows crossing the disk are in the maps. In 2025 the rings are nearly edge-on (Earth crossed the ring plane in March 2025), so ring obscuration and the ring shadow are confined to the equator but may affect equatorial texels. Large linear-vs-cubic colour spread in Z (see table) comes from the few texels with extreme blue/red ratios.""",
    799: """**Source.** OPAL cycle 33 (2025 October 23–24), second rotation: F467M, F547M, F657N, F763M (all Minnaert-corrected); F845M has no limb correction, FQ619N/FQ727N are methane bands. 721 × 361 node-registered maps at 0.5° ("this oversamples the data"); east longitude increasing to the left (reversed here). Level 1 (0.35°).

**Coverage.** Uranus's north pole faces the Sun and Earth before the 2030 solstice (sub-Earth latitude +71°): with the limb cut, data run from about the equator to the north pole; the south is unknown.""",
    899: """**Source.** OPAL cycle 32, rotation `2025c` (2025 August 24–25): F467M, F547M, F657N. F763M, F845M, FQ619N and FQ727N have no Minnaert correction in this cycle ("none" in the README) and are not used. 721 × 361 node-registered, W longitude like Jupiter. Level 1.

**Colour.** Only three bands, 467–657 nm: most of the Z integrand lies below 467 nm, where the ratio is held flat (table above). The disk colour is the measured one from photometry.json; the per-texel colour variation is the weakest of all maps here. Before the limb cut, the northern edge (seen at grazing emission, sub-Earth latitude −19°) showed strongly coloured artefacts; north of ~53°N planetographic is now unknown.""",
    499: """**Source.** Mars Express HRSC global colour mosaic from high-altitude images (Michael et al. 2025; data doi:10.17169/refubium-40624, CC BY 4.0 per its DataCite record — this resolves the licence question in the research note). Bands blue 440, green 530, nadir 675 (broad panchromatic) and red 750 nm; 970 nm unused. 2 km/px → level 4 (2.6 km). Height: MOLA MEGDR 32 px/deg radius minus the pck00011 ellipsoid.

**Known issues.** The colour model removes image-to-image atmospheric changes but not the campaign-average dust haze; Michael et al. state that absolute surface colour is uncertain for that reason (only relative colour is used here). Mars's albedo features change with dust storms: the map is a multi-year composite.""",
    199: """**Source.** MESSENGER MDIS 8-colour MDR v4 (Denevi et al. 2018), 64 px/deg, I/F normalized to i = g = 30°, e = 0 with a global Kaasalainen–Shkuratov correction; bands 430, 480, 560, 630, 750, 830 nm read by byte range (6 of 17 bands per cube, 54 tiles). Polar tiles are polar stereographic; a gap-fill south-polar tile (2.7 km/px images) is used only where the nominal tile has none. Height: USGS global MESSENGER stereo DEM v2 (Becker et al. 2016) re-referenced from its 2439.4 km sphere to the pck00011 ellipsoid.

**Not used.** The USGS `EnhancedColor` (PCA stretch) and `MD3Color` (1000/750/430 nm false colour) mosaics, and the single-band basemaps.""",
}

PAN_NOTE = """**Galilean moons: 8-bit panchromatic mosaics (USGS Astrogeology).** Decode their GeoTIFF band scale/offset before box averaging and cos²-weighted normalization. Io, Europa and Ganymede encode value = DN × 0.0059055141 − 0.0029527571 (confirmed by detached ISIS labels); Callisto is identity. Brightness pattern and colour remain `estimated`: tone matching, mixed filters and topographic shading prevent a calibrated normal-reflectance claim at either large or small scales. The source review supplies no scale at which a low-order subtraction would isolate only processing artifacts, so no such filter is applied. [Source review and numerical audit](../sources/usgs-panchromatic-mosaics.md) distinguish the map-only diagnostic from the rendered disk ratio and state the missing slice-ratio uncertainty. Feature georeferencing is unchanged; existing thumbnails below predate this small encoding correction."""

EXCLUDED_NOTE = """## Bodies deliberately without a visible surface map

- **Venus:** the eye sees the cloud deck, featureless to a few percent in the visible; the markings in popular images are ultraviolet. Magellan radar maps show a surface no eye can see. Rendered from photometry.json only.
- **Titan:** the eye sees an orange haze ball; the surface maps are 938 nm methane-window (ISS) or infrared (VIMS) products with the haze removed. Rendered from photometry.json only.
- **Saturn's mid-size moons (rejected after checking):** the USGS/CICLOPS Cassini global maps compress large-scale contrast. The Iapetus map implies a leading/trailing brightness ratio of 0.84 (0.18 mag) at zero phase, while Iapetus's leading hemisphere is ~2 mag fainter than its trailing one. The Dione map implies 1.04, and its bright ray crater Creusa does not stand out. We also tested the DLR Cassini ISS cartographic atlas maps in PDS (COISS_3001–3007: Phoebe, Enceladus, Dione, Tethys, Iapetus, Mimas, Rhea). They are 8-bit simple-cylindrical mosaics with a Hapke photometric correction but no documented DN scaling, and they are the source of the USGS maps. They give the same ratios (Iapetus 0.844, Mimas 0.93, Tethys 1.08, Rhea 1.17), so none is used (reasons in `surfaces/index.json` → `rejected`).
- **Triton:** the USGS products are the 1989 Voyager display colour composite (orange/violet/UV shown as RGB; "GlobalFill" adds synthetic fill) or an 8-bit clear-channel orthographic mosaic without documented scaling. No calibrated Triton map was found. Rejected.
- **Uranian moons:** no global map product exists in the USGS mosaic archive or PDS; a map would have to be built from calibrated Voyager 2 images (southern hemispheres only). Not built.
- **Small moons:** not built."""


def generate() -> str:
    hs = _headers()
    idx = json.loads((OUT / "surfaces" / "index.json").read_text(encoding="utf-8"))
    total = sum(h["stats"]["bytes"] for h in hs.values())
    meta = sum((OUT / "surfaces" / str(b) / f"{lay}{ext}").stat().st_size for (b, lay) in hs
               for ext in (".json", ".sha256"))
    raw = sum(p.stat().st_size for p in (RAW / "surfaces").rglob("*") if p.is_file()) if (RAW / "surfaces").exists() else 0
    rows = []
    for (naif, layer), h in sorted(hs.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        L = h["maxLevel"]
        wh = st.level_shape(L)
        col = h.get("color", {}).get("label", "–")
        epoch = h.get("epoch", {})
        ep = (epoch.get("start", "")[:10] + (" → " + epoch["end"][:10] if epoch.get("end") else "")) if epoch.get("start") \
            else epoch.get("observed", "")
        regs = h["coverage"]["regions"]
        blabels = "/".join(dict.fromkeys(r["brightness"]["label"] for r in regs)) or h["brightness"]["label"]
        rows.append(f"| {h['bodyName']} ({naif}) | {layer} | {', '.join(h['sources'][:2])}{'…' if len(h['sources']) > 2 else ''} "
                    f"| {h['minLevel']}–{L} ({wh[1]}×{wh[0]}, {_km_per_texel(naif, L):.2f} km) "
                    f"| {h['coverage']['areaFraction']:.3f} / {h['coverage']['diskWeightFraction']:.3f} "
                    f"| {blabels} | {col} | {ep} | {_fmt_mib(h['stats']['bytes'])} |")
    colour_rows = []
    for (naif, layer), h in sorted(hs.items()):
        d = h.get("diagnostics", {})
        for ck, sk, tag in (("color", "interpolationSpread", ""), ("colorLand", "interpolationSpreadLand", " (land)"),
                            ("colorWater", "interpolationSpreadWater", " (water)")):
            c = d.get(ck)
            if not c:
                continue
            sp = d[sk]
            above = c["integrandFractionAboveLastBand"]
            below = c["integrandFractionBelowFirstBand"]
            colour_rows.append(
                f"| {h['bodyName']}{tag} | {', '.join(f'{b:g}' for b in c['bandCentersNm'])} | "
                f"{c['widestBandGapNm']:.0f} | {max(below.values()) * 100:.1f} / {max(above.values()) * 100:.1f} "
                f"| {' / '.join('%.1f' % (sp[k]['p99'] * 100) for k in ('X', 'Y', 'Z', 'S'))} | {h['color']['label']} |")
    secs = idx.get("buildSeconds", {})
    git = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
    parts = [
        "# Surface maps: review report",
        "",
        f"Generated {_dt.date.today().isoformat()} (commit {git}) by `cd pipeline && uv run python -m pipeline.surf_report`, from "
        "the layer headers and tiles in `app/public/data/surfaces/`. Numbers are computed; prose is hand-written in "
        "`pipeline/src/pipeline/surf_report.py`. Contract: docs/architecture.md §4.4; header type `SurfaceLayerHeader` "
        "in app/src/data/schema.ts.",
        "",
        "## What the tiles contain",
        "",
        "- **albedo** (float16 X, Y, Z, S): local normal reflectance relative to the body's disk average, per channel. "
        "The disk average — cos²(latitude)-weighted, i.e. projected area at zero phase for an equatorial observer, "
        "averaged over rotation — is 1 in every channel (checked per level by `tests/test_surf_products.py`). The "
        "renderer multiplies by `geometricAlbedoXYZS` from photometry.json and rescales so the disk integral keeps p "
        "and Φ(α). Unknown texels are exactly 0 in all channels; wholly unknown tiles are not stored and are listed "
        "in `missingTiles`.",
        "- **height** (float32, metres above the pck00011 reference ellipsoid named in the header; NaN = unknown).",
        "- **hapke** (Moon only; float16 × 35: w, b, c, B_S0, h_s per LROC band; constants and the model in the header).",
        "- **Earth only** (float16, NaN = unknown per channel, all dated): **clouds** (cloudFraction, opticalThickness, "
        "cloudTopHeightM, iceFraction), **cloudTau** and **cloudTauEstimated** (from the same cells: the share of "
        "cloud with a thickness and the ln τ sums and ice share of it, for the cloud with a measured thickness and "
        "for that with a measured or an estimated one; area-weighted, exact at every level; docs/rendering-earth.md "
        "§2), **night** (Day/Night-Band radiance in nW cm⁻² sr⁻¹ and the censored share; "
        "`constants.toXYZS` converts to luminance for two lamp spectra), **water** (waterFraction, seaIceFraction). "
        "Earth's **albedo** is absolute-calibrated: `normalization.absoluteDiskMean` × texel = surface reflectance, "
        "because Earth's disk photometry includes clouds and atmosphere.",
        "- Every header has per-region provenance (`coverage.regions`), a brightness and a colour label, sources, the "
        "observation epoch and the normalization constants.",
        "",
        "## Summary",
        "",
        "| body | layer | sources | levels (top: texels, km/texel at equator) | coverage: area / disk weight | brightness | colour | epoch | MiB |",
        "|---|---|---|---|---|---|---|---|---|",
        *rows,
        "",
        f"**Product size:** {total / 2**20:.0f} MiB of tiles ({total / 1e9:.2f} GB) + {meta / 2**20:.1f} MiB of "
        f"headers and tile listings. **Raw downloads kept** in data/raw/surfaces: {raw / 1e9:.2f} GB (the LROC "
        "mosaics — 8.2 GB Hapke + 4.9 GB polar — and the 4.3 GB of Mercury band ranges are reduced and deleted right "
        "after download; their sha256 stays in the ledger). **Stage time** per module (last full run: "
        "" + ", ".join(f"{k.removeprefix('surf_')} {v:.0f} s" for k, v in secs.items()) + "; "
        "the Moon and Mercury from their cached reductions). A cold build downloads ~20 GB and took 1096 s for the "
        "Moon (13 GB of LROC mosaics), 431 s for Mercury (4.3 GB of band ranges + the DEM), 106 s for Mars and 35 s "
        "for the giant planets on this machine (~20-40 MB/s). Earth, all four layers, cold: 1509 s for 1.8 GB "
        "(GIBS renders the 8192 × 4096 WMS blocks slowly; 1890 MODIS byte ranges, 766 MB; OC-CCI 324 MB; ETOPO "
        "156 MB); only the ETOPO subset, the colour maps and the STAC responses are kept. Pluto and Charon: 42 s "
        "for 1.27 GB of band ranges, deleted after use.",
        "",
        "## Colour: when is it `derived`?",
        "",
        "Band ratios are interpolated linearly between band centres and held flat outside, then multiplied by the "
        "body's measured disk spectrum and integrated per CIE observer (surf_color.py). This keeps the disk colour "
        "exactly the measured one and takes only relative variation from the map. The interpolation is an assumption. "
        "Criterion for `derived`: the bands must bracket ≥ 99 % of every channel's sunlight-weighted observer "
        "integrand and be no further apart than half the narrowest observer-function FWHM (27 nm, from the CIE tables) "
        "inside the range that holds the central 98 % of the integrands — sampling at the Nyquist rate of the eye's "
        "own spectral resolution. No mission map meets it, so every map colour here is `estimated`; the spread "
        "between linear and monotone-cubic interpolation over 4000 random texels shows how much it matters.",
        "",
        "| body | band centres (nm) | widest gap (nm) | integrand below first / above last band (%, worst channel) | lin-vs-cubic p99 |Δ| X/Y/Z/S (%) | colour |",
        "|---|---|---|---|---|---|",
        *colour_rows,
        "",
        "## Per body",
        "",
    ]
    for naif in (399, 301, 599, 699, 799, 899, 499, 199, 999, 901):
        if (naif, "albedo") not in hs:
            continue
        h = hs[(naif, "albedo")]
        parts += [f"### {h['bodyName']}", "", BODY_NOTES.get(naif, ""), ""]
        if naif == 399:
            parts += [earth_numbers(hs), ""]
        for layer in ("albedo", "height", "water", "clouds", "night"):
            p = REPO / "docs" / "reports" / "img" / f"surfaces-{naif}-{layer}.png"
            if p.exists():
                parts.append(f"![{h['bodyName']} {layer}](img/{p.name})")
        parts.append("")
    pans = [h for (n, lay), h in sorted(hs.items()) if lay == "albedo" and h.get("diagnostics", {}).get("dnStatistics")]
    if pans:
        parts += ["### Panchromatic mosaics", "", PAN_NOTE, "",
                  "| body | source | observed | DN p1 / median / p99 | georeferencing check | leading/trailing (mag) | notes |",
                  "|---|---|---|---|---|---|---|"]
        for h in pans:
            d = h["diagnostics"]
            g = d["georeferencing"]
            gtxt = (f"{g['feature']}: {g['contrastAtFeature']:.2f} vs mirrored {g['contrastAtMirroredLongitude']:.2f}"
                    if g.get("passed") is not None else "none selected")
            dn = d["dnStatistics"]
            lt = d.get("leadingOverTrailing")
            lttxt = f"{lt['ratio']:.3f} ({lt['magnitudes']:+.2f})" if lt else "–"
            parts.append(f"| {h['bodyName']} | {h['sources'][0]} | {h['epoch']['observed']} | {dn['p1']} / {dn['median']} / "
                         f"{dn['p99']} | {gtxt} | {lttxt} | {' '.join(h.get('notes', []))} |")
        parts.append("")
        for h in pans:
            p = REPO / "docs" / "reports" / "img" / f"surfaces-{h['body']}-albedo.png"
            if p.exists():
                parts.append(f"![{h['bodyName']}](img/{p.name})")
        parts.append("")
    parts += ["Previews: display renderings of relative reflectance × the body's disk colour, disk mean at display "
              "luminance 0.30, adapted to sunlight (Bradford → D65), 256-colour palette; heights: grey = height plus "
              "a 10× exaggerated hillshade. Magenta/black checkerboard = unknown. `uv run python -m "
              "pipeline.surf_preview`.", "", EXCLUDED_NOTE, "", "## Verification", "",
              "`uv run pytest tests/test_surf_tiles.py tests/test_surf_pds.py tests/test_surf_color_hapke.py "
              "tests/test_surf_products.py`: PDS label conventions (LROC tile edges, standard-parallel equirectangular, "
              "polar stereographic orientation), "
              "pyramid/tiling math and texel addressing (Tycho → level-5 tile 23/30, texel 178/2), exact box and linear "
              "resampling (no coverage extension, periodic longitude, regional tiles), float16/float32 tile and header "
              "round trips with sha256 listings, band→XYZS weights (rows sum to 1, disk mean preserved), the colour "
              "criterion, the Hapke model (Chandrasekhar H, neutral roughness at normal geometry, smooth-surface limit); "
              "on the built products: every tile present or listed as missing, sampled sha256, no NaN / negative / "
              "infinite albedo texels at any level, disk mean 1 ± 0.01 per channel at every level, and:", "",
              *verification(hs), "", "## Open issues", "",
              "- Galilean moons: pixel scale/offset are decoded, while per-frame tone corrections and reference geometry "
              "remain unavailable (brightness `estimated`). `diagnostics.leadingOverTrailing` records the map-only "
              "ratio and the fitted rotation slices with identical projected-area weights, plus the renderer's "
              "different Lambert-kernel disk ratio. Slice-ratio uncertainty is unknown: Mayorga Table 4 has no "
              "numerical errors/covariance, and Table 7 modulation errors are a different statistic. The nominal "
              "Ganymede/Callisto discrepancy persists; it does not establish a unique contrast correction.",
              "- Saturn's mid-size moons: both public map series (USGS/CICLOPS, DLR COISS_3xxx) fail the brightness "
              "check. A usable map needs mosaics built from calibrated Cassini ISS images (COISS_2xxx) with a "
              "published photometric model, or a published albedo map.",
              "- Pluto/Charon: the MVIC colour maps cover less than the old panchromatic mosaics (Pluto 0.72 vs 0.77, "
              "Charon 0.60 vs 0.74 of the area). The rest could be filled from the LORRI panchromatic mosaic tied to "
              "MVIC in the overlap (brightness `estimated` there). The DEMs (encounter hemisphere only) are not "
              "exported.",
              "- Not built: Triton, Uranian moons (no calibrated product), Ceres/Vesta (M3), Earth height (ETOPO 2022 "
              "would need lake surfaces; optional).",
              "- Earth: the cloud layers are a mosaic of one day's 13:30 local hours, not an instant (hard cuts every "
              "15° of longitude, one hour apart; a 24-hour seam at 150° W); a renderer at another time should label "
              "clouds `estimated`. The provider's values at night and twilight, and in the geostationary imagers' "
              "sun-glint cone, are admitted only as estimates (the cloudTauEstimated layer). The albedo has no sea-ice reflectance (unknown). The MCD43A4 fill share over the 315 tiles "
              "includes their ocean pixels.",
              "- Giant planets: maps are one rotation at their epoch; advecting clouds with measured zonal wind profiles "
              "(research note 1c) is left to the renderer/M2 follow-up and would be `estimated`.",
              "- Moon: normal albedo excludes the opposition surge by definition (see above); the renderer's opposition "
              "effect must come from the disk phase curve or the exported Hapke layer.",
              "- The Galilean moons have `photometry.json` entries, including `rotation-slices-v1`; the renderer normalizes "
              "their maps at the actual viewing geometry and leaves disk-integrated rotational brightness to "
              "those fitted slices.",
              "- Panchromatic layers are stored as four identical float16 channels to keep one albedo tile format; a "
              "one-channel variant would make them 4x smaller if the renderer accepts it.", ""]
    return "\n".join(parts)


def main() -> None:
    REPORT.write_text(generate(), encoding="utf-8", newline="\n")
    print(f"wrote {REPORT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
