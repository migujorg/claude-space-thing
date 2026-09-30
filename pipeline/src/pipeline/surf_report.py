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
        h = json.loads(p.read_text())
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
    for (naif, layer), h in sorted(hs.items()):
        g = h.get("diagnostics", {}).get("georeferencing")
        if g and g.get("passed") is not None:
            lines.append(f"- **{h['bodyName']}, {g['feature']}** ({g['latDeg']:.2f}°, {g['lonEastDeg']:.2f}°E; "
                         f"{g['coordinates'].split(':')[0]}): contrast to its surroundings "
                         f"{g['contrastAtFeature']:.2f} vs {g['contrastAtMirroredLongitude']:.2f} at the mirrored "
                         f"longitude (expected {g['expected']}).")
    return lines


def _fmt_mib(b: int) -> str:
    return f"{b / 2**20:.1f}"


BODY_NOTES = {
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

PAN_NOTE = """**Galilean moons, Pluto, Charon: 8-bit panchromatic mosaics (USGS Astrogeology).** Each is calibrated and photometrically normalized by its producer (Lunar-Lambert for the Galilean satellites), matched across image boundaries and delivered as 8-bit numbers. Except for Pluto and Charon, whose FGDC metadata document the linear 8-bit stretch (inverted here), the DN scaling is not documented; we assume DN ∝ normalized reflectance. Brightness pattern and colour are therefore `estimated` (single band: the local colour is the disk colour). Colour composites (`ClrMosaic`, `ClrMerge`, `FalseColor`), the high-pass-filtered Enceladus mosaics (`_HPF`) and the Triton `GlobalFill` mosaic (undocumented fill) are not used. Georeferencing is checked against a named albedo feature from the IAU Gazetteer at its east longitude and at the mirrored longitude (catches W/E mix-ups)."""

EXCLUDED_NOTE = """## Bodies deliberately without a visible surface map

- **Venus:** the eye sees the cloud deck, featureless to a few percent in the visible; the markings in popular images are ultraviolet. Magellan radar maps show a surface no eye can see. Rendered from photometry.json only.
- **Titan:** the eye sees an orange haze ball; the surface maps are 938 nm methane-window (ISS) or infrared (VIMS) products with the haze removed. Rendered from photometry.json only.
- **Saturn's mid-size moons (rejected after checking):** the USGS/CICLOPS Cassini global maps compress large-scale contrast. The Iapetus map implies a leading/trailing brightness ratio of 0.84 (0.18 mag) at zero phase, while Iapetus's leading hemisphere is ~2 mag fainter than its trailing one; the Dione map implies 1.04 and its bright ray crater Creusa does not stand out. Tethys, Rhea and Enceladus come from the same map series and are held back until its brightness scaling is documented or checked (reasons in `surfaces/index.json` → `rejected`).
- **Earth:** out of scope for this stage (needs daily cloud imagery; research note 1c).
- **Triton, Uranian moons, Mimas, small moons:** not built yet (see open issues)."""


def generate() -> str:
    hs = _headers()
    idx = json.loads((OUT / "surfaces" / "index.json").read_text())
    total = sum(h["stats"]["bytes"] for h in hs.values())
    meta = sum((OUT / "surfaces" / str(b) / f"{l}{ext}").stat().st_size for (b, l) in hs for ext in (".json", ".sha256"))
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
        c = h.get("diagnostics", {}).get("color")
        if not c:
            continue
        sp = h["diagnostics"]["interpolationSpread"]
        above = c["integrandFractionAboveLastBand"]
        below = c["integrandFractionBelowFirstBand"]
        colour_rows.append(
            f"| {h['bodyName']} | {', '.join(f'{b:g}' for b in c['bandCentersNm'])} | {c['widestBandGapNm']:.0f} "
            f"| {max(below.values()) * 100:.1f} / {max(above.values()) * 100:.1f} "
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
        "for the giant planets on this machine (~20-40 MB/s).",
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
    for naif in (301, 599, 699, 799, 899, 499, 199):
        if (naif, "albedo") not in hs:
            continue
        h = hs[(naif, "albedo")]
        parts += [f"### {h['bodyName']}", "", BODY_NOTES.get(naif, ""), ""]
        for layer in ("albedo", "height"):
            p = REPO / "docs" / "reports" / "img" / f"surfaces-{naif}-{layer}.png"
            if p.exists():
                parts.append(f"![{h['bodyName']} {layer}](img/{p.name})")
        parts.append("")
    pans = [h for (n, l), h in sorted(hs.items()) if l == "albedo" and h.get("diagnostics", {}).get("dnStatistics")]
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
              "- Galilean moons: DN scaling undocumented (brightness `estimated`). The headers record the leading/trailing "
              "brightness ratio each map implies (`diagnostics.leadingOverTrailing`); comparing it with measured orbital "
              "light curves would confirm or reject the linear-DN assumption, as it rejected the Iapetus map.",
              "- Saturn's mid-size moons: find a documented-brightness source (e.g. the DLR Cassini ISS cartographic "
              "volumes COISS_3001-3007 in PDS) or check the CICLOPS maps against disk photometry.",
              "- Pluto/Charon: New Horizons MVIC colour (PDS composition bundle) not used yet; colour is the disk "
              "colour. The DEMs (encounter hemisphere only) are not exported.",
              "- Not built: Triton (Voyager hemisphere only; the USGS 'GlobalFill' fill is undocumented), Uranian moons, "
              "Mimas (DLR atlas in a zip), Ceres/Vesta (M3), Earth.",
              "- Giant planets: maps are one rotation at their epoch; advecting clouds with measured zonal wind profiles "
              "(research note 1c) is left to the renderer/M2 follow-up and would be `estimated`.",
              "- Moon: normal albedo excludes the opposition surge by definition (see above); the renderer's opposition "
              "effect must come from the disk phase curve or the exported Hapke layer.",
              "- Several bodies (the Galilean moons, Charon) have no photometry.json entry yet, so the renderer has no "
              "absolute colour/brightness for them; their maps are ready for when it does.",
              "- Panchromatic layers are stored as four identical float16 channels to keep one albedo tile format; a "
              "one-channel variant would make them 4x smaller if the renderer accepts it.", ""]
    return "\n".join(parts)


def main() -> None:
    REPORT.write_text(generate())
    print(f"wrote {REPORT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
