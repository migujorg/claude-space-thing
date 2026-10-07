# Architecture and data contracts

This is the engineering companion to [`NORTH_STAR.md`](../NORTH_STAR.md). The north star says *what* and *why*; this file pins down the conventions every part of the system must share. If code disagrees with this file, one of them is a bug.

## 1. System shape

```
 raw downloads ──► pipeline (Python) ──► app/public/data/ ──► app (TypeScript + WebGPU, browser)
 data/raw/          pipeline/src/         manifest + JSON        app/src/
 (gitignored,       one stage per          + binary blobs
  sha256-recorded)  data domain            (gitignored)
```

- **pipeline/** — Python 3.11+, managed with `uv`. `uv run python -m pipeline build` downloads anything missing into `data/raw/`, records a sha256 for every file, and writes processed products into `app/public/data/`. Scientific libraries are allowed and preferred when they are the authoritative implementation (SPICE via `spiceypy`, ESA's `gaiaxpy`, `colour-science` for CIE tables, `astropy`).
- **Builds** (`pipeline/build.py`, `pipeline/config.py`; README "Build profiles") come in profiles (minimal, standard, full) that choose which stages run and set stage parameters (`--set key=value`, e.g. `surfaces.maxLevel`). A profile or parameter may leave products, or the top levels of a surface pyramid, out, and the manifest records that. It never changes what a product that is built means or contains. Builds resume: `manifest.json` records per stage a fingerprint of its code, output parameters, window (if the code reads it) and input products, and only a stage recorded as `built` whose fingerprint and products are unchanged is not rebuilt; runs with `surfaces.bodies`, `surfaces.earthLayers`, `shapes.only` or `shapes.reorient` are recorded as `partial` with those nonempty options in `partialParams`, cannot resume or be adopted as whole-stage completion, and retain no certification of carried-over products under the new code. A stage that fails has its products dropped from the manifest, and the stages that do not need it still run.
- **app/** — TypeScript, Vite, raw WebGPU (no engine). Targets desktop Chromium with a high-end GPU. All positions are computed in float64 on the CPU for "few" objects; large populations are computed on the GPU (see §3.3).
- Nothing in `app/` may contain a physical constant or dataset value that did not come from `app/public/data/` **or** from a documented, cited constant module (`app/src/core/constants.ts`, each entry with its source). No magic numbers that describe the universe.

## 2. Provenance (NORTH_STAR 3.2)

### 2.1 Labels

Ordered from most to least grounded:

| Label | Rule |
|---|---|
| `measured` | Read directly from an observational data product (including fitted products like orbital elements and ephemerides). |
| `derived` | Computed from `measured`/`derived` inputs by established physics with **no assumed inputs**. |
| `estimated` | Computed with at least one assumed input: a population statistic *or* a modeling assumption (e.g. "surface is Lambertian", "albedo typical of its taxonomic class"). |
| `synthetic` | The object itself is sampled from a population model (Phase 2). |
| `unknown` | No value. Never silently replaced by a default. |

**Propagation rule:** a computed value's label is the *worst* label among its inputs, bumped to at least `estimated` if the computation introduces an assumption. Code that combines values must propagate labels; it is a bug to emit `measured` for something computed.

**No placeholders, ever.** If a value is not available, it is `unknown` and the renderer shows it as unknown (§5.3). A fixture or guess must never enter `app/public/data/`. Test fixtures live under `*/tests/` only. A stage's build record (`verification/<stage>.json`, §6) is neither: it holds what that run computed and fetched for the products it wrote, with their sources, and exists so that tests compare a build with itself (§5.4).

### 2.2 JSON shapes (canonical definitions in `app/src/data/schema.ts`)

```ts
type Label = 'measured' | 'derived' | 'estimated' | 'synthetic' | 'unknown';

interface Sourced<T> {
  value: T | null;          // null iff label === 'unknown'
  unit?: string;            // SI-ish unit string, e.g. "km", "km^3/s^2", "lux"
  label: Label;
  sources: string[];        // SourceRecord ids
  method?: string;          // one or two sentences: how the value was obtained/computed
  uncertainty?: string;     // free-form for now, e.g. "±2 km (1σ)"
}

interface SourceRecord {
  id: string;               // stable slug, e.g. "naif-de440s"
  title: string;
  citation: string;         // full reference; papers get authors, year, journal, DOI
  url: string;              // where the raw file was downloaded from
  retrieved: string;        // ISO date of download
  sha256?: string;          // of the raw file(s) as downloaded
  version?: string;
  license?: string;
  notes?: string;
}
```

Every dataset the pipeline touches gets a `SourceRecord` in `sources.json`. Every per-object attribute in JSON is a `Sourced<T>`. Large binary catalogs store labels as a `Uint8` per attribute per object (bitfield enumerated in their header) and a source index per object or per column.

## 3. Space and time

### 3.1 Frames and units

- **Inertial frame:** ICRF (SPICE `J2000`), origin at the **Solar System Barycenter** (NAIF id 0).
- **Units:** km, s, radians inside all code. Degrees/AU/days only at I/O boundaries and in the UI.
- **Body-fixed frames:** IAU rotation models (pole RA/Dec + prime meridian W, including nutation/precession terms) from the NAIF text PCK (`pck00011.tpc`), itself the IAU WGCCRE report in machine-readable form.
- **Body IDs:** NAIF integer ids everywhere (10 Sun, 199 Mercury, 399 Earth, 301 Moon, 5 Jupiter barycenter, 599 Jupiter, …). Small bodies in Phase 1 M3 use their MPC designation plus a derived integer index.

### 3.2 Time

- Canonical time is **TDB seconds past J2000** (`et`, SPICE convention: J2000 = 2000-01-01T12:00:00 TDB).
- The UI shows **UTC**. UTC ↔ TAI uses the leap-second table from the NAIF LSK (`naif0012.tls`), exported to `time.json`. TT = TAI + 32.184 s. TDB − TT uses the LSK's periodic formula (constants `DELTA_T_A, K, EB, M0, M1` from the same file).
- Every time-dependent dataset declares a validity window in `manifest.json`. The app clamps time to the intersection of loaded windows and shows the window in the UI. Scrubbing outside a window must show "no data", never extrapolate silently.
- v1 window: pipeline build time ± ~18 months (configurable). It is fixed by the first build (`data/cache/window.json`) so partial rebuilds stay consistent; `build --new-window` recenters it. The architecture must not assume the window is short.

### 3.3 Precision

- float32 cannot hold solar-system coordinates (1e-7 relative ≈ 450 km at 30 AU). Therefore:
  - CPU objects (Sun, planets, moons, selected objects): positions in float64 JS numbers; each frame the CPU subtracts the camera position in float64 and uploads **camera-relative** float32 positions.
  - GPU populations (asteroids, later): positions stored/computed as double-single (hi + lo float32 pairs) or relative to a local origin, then made camera-relative in-shader.
- Depth: reversed-Z with `depth32float` and an infinite far plane.

### 3.4 Apparent positions

Objects are drawn where their light left them (NORTH_STAR 3.4), using `c` from `constants.ts`. The observer's SSB position is held at the reception epoch throughout the correction; there is no stellar aberration. The CPU path (`core/lighttime.ts`, including selected small bodies via `app/smallbodies.ts`) iterates `τ = |r_obj(t−τ) − r_obs(t)| / c` to a delay change below 10⁻⁹ s, with at most ten iterations (normally 2–3). Missing emission-time coverage or failure to converge gives an unknown position.

**GPU population approximation.** The catalogue shade kernel and the synthetic-object kernel (`gpu/smallbodies/kernels.ts`) use a **first-order** correction, not an iterated emission-time orbit: with `R = r_obj(t) − r_obs(t)`, `D = |R|`, `n = R/D`, they compute `τ₀ = D/c` once and draw `R₁ = R − v_SSB(t) τ₀`. Catalogue heliocentric velocity adds the Sun's SSB velocity; synthetic irregular moons add their planet-system barycentre's SSB velocity. These centre velocities are evaluated by the CPU over ±1 s. The observer's velocity is not subtracted. The photometry geometry also uses a linear back-date of the heliocentric position. This approximation remains the population rendering contract.

For a smooth target trajectory with SSB velocity `v` and acceleration `a`, expansion of the converged delay gives `τ = D/c − (n·v)D/c² + O(c⁻³)`. Thus the leading **first-order minus iterated** position error is

```
δR = −v (n·v) D/c² − a D²/(2c²) + O(c⁻³).
δθ ≈ |δR − n(n·δR)|/D             (radians).
```

Both the uniterated delay and the omitted acceleration matter. In particular, nearest distance alone does not locate the largest angular error: `n·v` uses target SSB velocity, not target–observer relative radial speed. For bounds `|v| ≤ V < c` and `|a| ≤ A` throughout the reception-to-emission interval, Taylor's remainder and `τ ≤ D/(c−V)` give the conservative position bound `B = V²D/[c²(1−V/c)] + AD²/[2c²(1−V/c)²]`; when its argument is below one, the direction difference is at most `asin(B(1+V/c)/D)`.

**Numerically checked domain and regression bounds.** For the built SBDB snapshot 2026-10-03, catalogue epoch 2026-10-04 TDB, and window 2025-04-04 to 2028-04-04, a float64 CPU twin of the shader correction was compared with the converged CPU light-time solve on the *same* orbit model:

| Observer and objects | Largest checked position difference | Largest checked direction difference | Regression bound (position; direction) |
|---|---:|---:|---:|
| Earth centre, selected fast/close catalogue NEAs | 0.10693 km | 0.001750 arcsec | 0.12 km; 0.002 arcsec |
| Host planet centre, all 458 built synthetic irregular moons | 0.06284 km | 0.0002950 arcsec | 0.07 km; 0.00035 arcsec |

The NEA selection screened all 2,812 Earth approaches in the cached JPL CNEOS answer (within 0.05 au during this window), using solar two-body drift from `smallbodies/core.bin`. The union of the twelve largest screening position errors, direction errors, SSB speeds and CNEOS relative speeds, and the twelve nearest CNEOS distances contained 56 approaches. These were then integrated with the product's full `forceModel` and non-gravitational parameters and compared hourly within ±1 day of each approach, restricted to covered epochs (2,721 comparisons). The position maximum was 2025 HA at ET 797265986.9430139 (one day before its listed approach; D = 7,580,830 km, SSB speed 37.608 km/s); the angular maximum was 2025 WV13 at ET 817561808.5025758 (one hour after; D = 42,652 km, SSB speed 39.130 km/s).

The synthetic moons used `synthetic/objects.bin` and `core/smallbodySynthetic.ts`'s fixed Kepler ellipses, adding their barycentre ephemerides. Each was checked from its host **planet centre** every fourteen days through the window; the twenty largest samples for each error metric were refined hourly within ±14 days (63,101 comparisons including repeated samples). Both maxima belonged to Jupiter's population: stream rows 2970041 at ET 817676528 (position) and 2969819 at ET 809256128 (direction). Sun and centre positions came from the built `ephem/de442s` and `ephem/centers` products. The bounds round upward from these measurements; `tests/smallbody-lighttime-bound.test.ts` retains the maxima and deep Earth encounters and guards the twin's correspondence with both generated shaders.

These are bounds for the **checked samples**, not certified maxima over every catalogue object, every instant, synthetic heliocentric populations, or arbitrary observer locations. They isolate the light-time approximation: orbit-solution uncertainty, propagation error, neglected forces in synthetic orbits, float32 shading and GPU execution are separate error budgets. Recheck the numeric survey when the catalogue, window or correction changes.

## 4. Light

### 4.1 Units in the renderer

The HDR scene buffer holds **absolute photometric quantities** in four channels:

| Channel | Meaning |
|---|---|
| R | CIE X (same scaling as Y) |
| G | CIE Y = photopic **luminance, cd/m²** |
| B | CIE Z |
| A | **scotopic luminance**, scotopic cd/m² (V′(λ), K′m = 1700 lm/W) |

The fourth channel exists so the eye model can do mesopic/scotopic vision properly; it cannot be recovered from XYZ. Render target: `rgba32float` with the `float32-blendable` feature (fallback: `rgba16float` with pre-exposure). Point sources (stars, distant bodies) are **illuminance at the eye, in lux** (and scotopic lux), splatted into the buffer by dividing by the solid angle of the pixels they cover so that energy is conserved.

### 4.2 Spectral → tristimulus

All spectral work happens in the pipeline. Standard tables come from the CIE (downloaded, not typed):
- Photopic observer: CIE 1931 2° colour-matching functions (x̄, ȳ, z̄), K_m = 683.002 lm/W.
- Scotopic: CIE 1951 V′(λ), K′_m = 1700.06 lm/W.
- Sampling: 1 nm over 360–830 nm (interpolate source spectra onto this grid; record the interpolation in `method`).

Sunlight is a measured solar spectral irradiance at 1 AU (e.g. TSIS-1 HSRS). From it the pipeline produces `sun.irradianceXYZS_1AU` = (X, Y, Z, S) with Y = illuminance in lux at 1 AU.

### 4.3 Reflected light contract

For a body with a geometric-albedo spectrum p(λ), the pipeline emits

```
geometricAlbedoXYZS = K ∫ p(λ) · E_sun,1AU(λ) · cmf(λ) dλ     (four numbers, "lux at 1 AU")
```

Meaning: at phase angle 0, a body of mean radius R at heliocentric distance d (AU) and observer distance Δ produces illuminance at the observer

```
E_obs(α = 0) = geometricAlbedoXYZS · (1/d²) · (R/Δ)²
E_obs(α)     = E_obs(0) · Φ(α)          with Φ(0) = 1
```

The resolved renderer must use a surface reflectance model whose disk integral reproduces both p and Φ(α) (energy consistency between "point" and "disk" views). A body whose resolved disk is drawn from a physical atmosphere model (Titan: §6 `atmospheres.json`; docs/rendering-earth.md §8 "Titan") is held to this by scaling the model's radiance per channel by the measured p·Φ(α) over the model's own disk integral, computed at run time and reported by the renderer; beyond the measured phase range the factors of its edge are held (`estimated`). The Earth drawn with its layers (docs/rendering-earth.md) is the one exception: its layers carry their own absolute calibration and its disk albedo is the weather of one day, so its disk photometry is the point's light and the model's check, not its scale. The phase function Φ is itself a `Sourced` value (e.g. a published phase curve) — if the only available model is an assumption such as Lambert, it is labeled `estimated`.

Conventions used by the `light` stage: R is the volumetric mean radius (abc)^(1/3) of the body's pck00011 triaxial radii (albedos from sources that used other disk sizes are rescaled by (R_source/R)²). Φ is evaluated only inside its stated domain (`minDeg..maxDeg`, or the table's range); outside it the phase behaviour is unknown. A `poly-mag` whose domain excludes α = 0 may have c0 ≠ 0 (Mercury: the fitted curve starts at 2° and excludes the opposition surge that the zero-phase albedo includes). The reverse also occurs: a surge-free albedo with a curve that includes the surge has Φ > 1 (negative `deltaMag`) near its first node (the Moon: the table starts at 1.55°).

Optional `diskReflectanceModel` (M3: the Moon, kind `rolo-v1`; the Galilean moons, kind `rotation-slices-v1`): when a body's disk-integrated brightness depends on more than α, this model gives it directly per channel. The Moon's depends on which hemisphere is lit (the waxing Moon is ~10 % brighter than the waning Moon at 60°) and on libration (up to 7 % or more). The illuminance is

```
E_obs,c = A_c(g, Φ, θ, φ) · E☉,c(1 AU) · (1/d²) · (radiusKm/Δ)²
```

with A_c from the model's `formula`. The inputs are the phase angle g, the Sun's selenographic longitude Φ, and the observer's selenographic latitude and longitude θ, φ. E☉,c is the solar XYZS in `light.json`. The model applies only inside its stated domain (phase range and observer libration range). There it replaces `geometricAlbedoXYZS · Φ(α)`; outside it, the α-only `phaseFunction` applies (within its own domain). `phaseFunction` equals the model's Y channel at zero libration, averaged over waxing and waning (geometric mean), divided by the albedo's Y.

Shape models ([rendering-shapes.md](rendering-shapes.md)): an irregular body drawn from its mesh (`SceneBody.shape`) keeps this contract on average. The radiance prefactor is scaled by πR² / ⟨A_proj⟩, where ⟨A_proj⟩ is the mesh's rotation-mean projected area, so the rotation-averaged illuminance at small phase is still `geometricAlbedoXYZS · Φ(α) · (1/d²) · (R/Δ)²`. The instantaneous brightness then varies with the shape as it rotates (a lightcurve); that variation is `derived`.

Kind `rotation-slices-v1` (the Galilean moons) adds a measured rotational (orbital-longitude) variation to `geometricAlbedoXYZS · Φ(α)`: a factor F from six longitude slices (Mayorga et al. 2020 Table 4), evaluated at the sub-observer and sub-solar longitudes (the formula is in `schema.ts` `RotationSlicesDiskModel`). F averages to 1 over a rotation, so the albedo and phase function remain the longitude average. As with ROLO, the renderer normalizes a body's surface maps at the viewing geometry when the model applies, so a map's own longitude contrast is not counted twice.

### 4.4 Surface maps (M2)

Disk-integrated photometry (§4.3) is the **absolute** calibration of a body's brightness and color: it is measured from far away with well-understood instruments. Surface maps supply only the **spatial pattern** on top of it. This keeps the two consistent by construction and stops a map's calibration problems from changing how bright a world is.

- **Texel content:** four float16 values (X, Y, Z, S) of *relative* normal reflectance: the ratio of the local normal albedo spectrum, integrated per §4.2 against sunlight, to the body's disk-integrated value. The pipeline normalizes each map so its disk-average (projected-area weighted, as seen at zero phase and averaged over rotation) is 1 in every channel. The renderer multiplies texels by the body's `geometricAlbedoXYZS` and applies its photometric model, then rescales so the disk integral still reproduces p and Φ(α) exactly (§4.3).
- **Color honesty:** a map made from several calibrated bands gives per-channel variation (label per map, usually `derived`). A single-band (panchromatic) map gives the same relative variation in all four channels, so local color is the disk-average color: that assumption makes the *map's color* `estimated`, while its brightness pattern keeps the map's own label.
- **Epoch:** maps of changing surfaces (giant-planet cloud tops, Earth's clouds) carry the observation date. Showing them at another time is `estimated`; the inspector says how far from the map epoch the current time is.
- **Geometry:** planetocentric latitude and east longitude in the body's IAU body-fixed frame (the same frame `bodyToIcrf` uses). Equirectangular tiles: u = (lon_E + 180°)/360°, v = (90° − lat)/180°. Pyramid level L has 2^(L+1) × 2^L tiles of 256 × 256 texels (level 0 = 512 × 256 texels, the whole body). Tiles are raw little-endian float16 RGBA (`.bin`, 512 KiB each), addressed `surfaces/<naifId>/<layer>/<L>/<ty>/<tx>.bin`.
- **Layers:** `albedo` (above) and optionally `height` (one float32 per texel, meters above the reference ellipsoid, same tiling), used for normals and, later, displacement. Each layer has a `surfaces/<naifId>/<layer>.json` header: levels, source ids, label, epoch, notes, per-channel normalization constants, and the valid lat/lon coverage (gaps are `unknown` and rendered as such, never filled).
- **Photometric model:** when a body has a measured spatially-resolved photometric model (e.g. Hapke parameters from LROC for the Moon, MESSENGER for Mercury), photometry.json carries it and the renderer uses it instead of Lambert for the *spatial* distribution; the disk-integrated Φ(α) still governs total brightness. `spatialModel` (photometry/spatial.py, docs/sources/spatial-photometry.md) holds published fits: Minnaert k from the Hubble OPAL READMEs for the giant planets, except Saturn beyond small phase, which has the Barkstrom law with the exponent B(α) measured by Pioneer 11 (Dones et al. 1993; a `{alphaDeg, values}` table); the Akimov disk function for Saturn's mid-sized moons (Filacchione et al. 2022); Hapke sets for Io (Simonelli & Veverka 1986), the icy Galilean moons (Domingue & Verbiscer 1997), Pluto, Charon and Triton (Verbiscer et al. 2022) and Mars (Vincendon 2013). A law is `measured` only if it was fitted to disk-resolved images of that body and is used per channel within the fitted phase range. Every current entry is `estimated`: one law serves all four channels, the laws are used at all phase angles, and the Hapke sets come from disk-integrated fits. The validation cases test these laws independently; none of the laws is fitted to the validation images. Laws are **selected** by the sources' merits and their coverage of the geometry (body, phase, latitude, season, wavelength), never by how they score on the validation cases. Between two published laws, or a law and an approximation of it, the better-supported one is used even if the other scores better. Saturn keeps the exact Barkstrom law although its Minnaert approximation passed a terminator ROI that the exact law fails (docs/reports/validation.md, "Method").

### 4.5 Sky background (M4)

Everything that is not a body is light at the observer, in the same units as the rest of the scene. The renderer's EXT target receives the sky's radiance (XYZS, cd/m² and scotopic cd/m²) wherever no body is in front (render/sky/background.ts, one pass right after the bodies), so the sky takes part in the glare veil, the adaptation measurement and every point source's local background.

- **Stars are points or sky light, never both.** A catalogue star (bright tier, loaded deep-tier record) is a point when its visibility proxy v = max(Y, S/1.408) reaches the point cut E(V_lim + 0.75 mag), V_lim being the renderer's limiting magnitude; every other one is binned (HEALPix order 8) into the background. The light of stars too faint to see individually is therefore still there as glow (it is most of the Milky Way), and nothing is counted twice (app/sky.ts).
- **Deep tiles** (`stars/deep`) are fetched by view direction with HTTP Range requests, only to the prefix (`prefixCounts`) that holds every record that can reach the cut; the light of the records not loaded comes from `deepRemainder` slice k for a tile loaded to prefix k (slice 0: not loaded; nothing when fully loaded). Memory is capped at 3 × 10⁶ records (least recently seen tiles out of view go first), and tiles more than 45° outside the view for 10 s are unloaded anyway.
- **Maps:** `faintStars` + `diffuse` + `deepRemainder` + the binned stars are composed on the GPU into a cube map (rgba16float, µcd/m²), each texel a disc average over about one source pixel, with a mip chain; the background pass samples it at the screen pixel's footprint.
- **Zodiacal light:** the Kelsall cloud with the fitted visible scattering (`sky/zodiacal.json`) is integrated along each line of sight on the GPU, on a grid of one ray per 16 pixels (recomputed when the observer or view changes) and interpolated; its colour is Leinert's f_co at the view direction's solar elongation. The CPU twin (render/sky/zodiacal.ts) is tested against Leinert Table 16.
- **Solar corona:** `sky/corona.json`, near the Sun. The K-corona (Thomson scattering by coronal electrons; the van de Hulst 1950 laws as electron densities, at the date's solar-cycle phase) is integrated per pixel along the line of sight (32 Gauss–Legendre nodes, for any observer) into a full-resolution texture, recomputed when the observer, view or phase changes. The F-corona near the Sun is the LASCO reference map (Lamy et al. 2022) as a smooth law, blended into the zodiacal light between 7.5° and 15° elongation (at 1 AU). Inside the Sun shield's occulting disc the background is black. CPU twin: render/sky/corona.ts (tests against the published laws and totals); docs/reports/sky.md §5.
- **Reality level:** each layer is drawn only if its label is admitted (all are `estimated`, so Strict shows neither glow nor zodiacal light; stars keep their own labels).

## 5. The app

### 5.1 Module layout

```
app/src/
  core/       time scales, ephemeris evaluation, frames, rotation, light-time, constants — pure TS, unit-tested, no DOM/GPU
  data/       schema.ts (the contract), loaders for manifest/sources/bodies/binaries
  render/     WebGPU device, HDR target, passes (stars, bodies, sun, overlays); render/comets: comae and tails (§4.5)
  eye/        human-eye model: adaptation, glare PSF, visibility thresholds, mesopic, display mapping
  ui/         camera controls, time controls, reality dials, inspector, search
  main.ts     wiring
```

### 5.2 Reality settings (NORTH_STAR 3.7)

`RealityState = { exists: 'strict' | 'best' | 'complete', view: 'eye' | 'enhanced', overlays: { labels, orbits, provenance } }`. Every draw path must consult the `exists` level against each attribute's label. Default `best` + `eye`, or `complete` + `eye` once a synthetic layer exists (the manifest lists `synthetic/objects.json` and small bodies are enabled; docs/reports/synthetic-populations.md). A level set by the user or the URL is kept. Any non-default state shows a persistent on-screen badge.

### 5.3 Showing unknowns

When an attribute needed for drawing is below the current `exists` level or `unknown`, the object is still drawn from what *is* allowed, and the missing aspect is visibly marked rather than filled:
- position known, size/brightness not → point at its measured brightness only if brightness is allowed, else a small hollow marker (overlay layer).
- shape known, surface reflectance not → silhouette rendered with a neutral hatched "not measured" material, never a plausible-looking color.

### 5.4 Verification

- `app/tests/` — vitest unit tests; ephemeris and time conversions are checked against independent JPL Horizons outputs saved as test fixtures.
- Two kinds of test reference, never mixed (README "Tests and references"). A **committed reference** (`*/tests/fixtures/`) holds values for stated inputs (orbit solutions, Horizons queries, SPICE on fixed kernel files) at its own epoch and is used with that epoch; no build writes it and no rebuild requires regenerating it. A **build record** (`verification/<stage>.json`, §6) is written by a stage with its products and names their sha256; a test of "the app reads this product as the pipeline wrote it" compares with the record of the build under test. Anything that depends on the day of the build (catalogue epoch and rows, window, SBDB orbit solutions, the Earth orientation kernel) belongs in a build record. A comparison a build cannot make is reported as a skipped test named `NOT COMPARED: …`, never dropped.
- `app/scripts/shot.mjs` — headless Chromium screenshot harness (SwiftShader WebGPU; `--gpu hardware` renders on the machine's GPU, app/e2e/README.md "On the GPU"). Usage: `npm run shot -- --url "/?t=2026-09-30T00:00:00Z&target=399&dist=50000" --out shots/earth.png`. The app sets `window.__frameReady = true` after the first frame with all data loaded.
- The app exposes `window.__app` for tests (read current state, set time, select objects).
- `validation/` — ground-truth cases built from calibrated spacecraft/satellite images (`uv run python -m pipeline.validation build`; types `ValidationCase` etc. in `schema.ts`). Each case gives an explicit view (camera and bodies at the observation epoch) and pixel regions with the absolute XYZS radiance the HDR buffer must hold there, before the eye model, with 2σ tolerances. `cd app && npm run validate` renders every case headless with the real renderer and data (`app/validation.html`, `src/validation/`) and reads the regions from the HDR buffer (`Renderer.readHdrRegion(rect)`, `readHdr()`, render/hdrReadback.ts); results in `app/shots/validation/` (app/e2e/README.md); see docs/reports/validation.md.

### 4.5 Comets (coma and tails)

A comet's total light is the SBDB total-magnitude law m1 = M1 + 5 log Δ + K1 log r, as for its point source (same V_sun and solar XYZS). When it is resolved from the camera (`render/comets/lod.ts`: coma ≥ 1.5 px, or a tail that could span ≥ 6 px on a comet within 3 mag of the eye's limit) the shell sends it in `SceneSnapshot.comets` (with its propagated heliocentric state) and takes it out of the small-body field's points; `render/comets` then splits the light into gas bands and dust (water production from the magnitude, measured composition ratios, fluorescence efficiencies), spreads it (dust 1/ρ with the coma radius where the Afρ coma reaches the M1/K1 flux; projected Haser distributions for the gas) and draws it into EXT in absolute luminance, with the Finson–Probstein dust tail and the CO⁺ ion tail as Gaussian packets (a coma smaller than the eye's Ricco area goes to the point sources instead, with its total light and colour). The rendered coma's pixels sum to the M1/K1 illuminance within 0.5 % (GPU-checked). Labels: the total is the SBDB law's label; the split, colour and shape are estimated (derived where the comet's own composition was measured).

## 6. Data products (app/public/data)

Stages (`config.STAGES`): `time`, `ephemeris`, `light`, `surfaces`, `shapes`, `bodies`, `smallbodies`, `sbphotometry`, `synthetic`, `comets`, `stars`, `deepstars`, `sky`, `nightglow`.

| File | Producer stage | Content |
|---|---|---|
| `manifest.json` | all | build time, validity windows, list of products with sha256 and byte sizes; `stages`: per stage the last run's status and fingerprint (resumable builds); `build`: the last build's profile and, per stage, built / up to date / not built / failed / blocked with the reason |
| `sources.json` | all | `SourceRecord[]` |
| `time.json` | `time` | leap seconds (UTC instants and ΔAT) and TDB formula constants from the LSK |
| `ephem/<name>.json` + `ephem/<name>.bin` | `ephemeris` | SPK segments restricted to the window; bin is float64 little-endian, native SPK type 2/3 record layout (type 17: one 12-double record). `ephem/de442s`: planets; `ephem/centers`: planet centres 499–999 only (bit-identical copies of the sat-* segments; loaded before the first frame); `ephem/sat-{mar,jup,sat,ura,nep,plu}`: planet centres and every moon, one file per system (lazy-loadable) |
| `orient/<name>.json` + `orient/<name>.bin` | `bodies` | Precise body orientation (`OrientationHeader`): binary-PCK Euler-angle records for the window. `orient/earth` (ITRF93), `orient/moon` (DE440 Mean Earth frame); preferred over the IAU model where they cover (`OrientationSet`) |
| `verification/orientation.json` | `bodies` | Build record: SPICE's body-fixed → J2000 matrices (pxform) from the kernel files `orient/earth` and `orient/moon` were copied from, at 16 epochs inside every segment, with the sha256 of those kernels and products. Not read by the app |
| `verification/smallbodies.json` | `smallbodies` | Build record: for the verification objects, their rows and states as written to `smallbodies/core.bin`, the integrator's positions every 20 days through the window next to JPL Horizons' (query URLs, tolerances); the JPL CNEOS Earth and Moon approaches of the window computed from the orbit solutions the catalogue holds (the closest, the first and the last); the sha256 of the products it describes. Not read by the app |
| `bodies.json` | `bodies` | `Body[]` with `Sourced` attributes (geometry, rotation, GM, ephemeris wiring) |
| `photometry.json` | `light` | NAIF id → `BodyPhotometry` (albedo spectra integrated per §4.3, phase functions); merged into bodies by the app loader |
| `light.json` | `light` | Sun spectrum-derived quantities, CIE constants actually used |
| `rings.json` | `light` | planet NAIF id → `RingSystem`: measured radial profiles of normal optical depth (occultations); Saturn: separately labelled cleaned optical-depth estimate, ring I/F model (lit and unlit faces, per channel) and the measured I/F data it is built on; Jupiter, Uranus and Neptune: estimated component models, including Uranus’s outside-support estimates; see below |
| `smallbody-class-colors.json` | `light` | `SmallBodyClassColorsFile`: per Bus-DeMeo class, the colour per unit V-band albedo (`xyzsPerUnitPV`) and NEOWISE p_V statistics, SDSS class frequencies, a population entry and alias tables; for small bodies without a measured spectrum (docs/sources/smallbody-class-colors.md) |
| `atmospheres.json` | `light` | `AtmosphereFile`: per body (Earth, Mars, Titan, Venus, Pluto; scale heights for the giant planets), the components of the atmosphere on an altitude grid at 48 wavelengths 360–830 nm — extinction, single-scattering albedo, phase function (Rayleigh with depolarization, Henyey-Greenstein, double HG, tabulated) and X, Y, Z, S equivalents — plus fold weights from spectral samples to X, Y, Z, S; Mars's seasonal dust columns and L_s over the window; Titan's haze optics, methane absorption and surface reflectance under the haze; see below |
| `smallbodies/core.json` + `.bin` | `smallbodies` | One record per catalogued asteroid/comet: heliocentric ICRF state at the common epoch, magnitude/orbit parameters, flags, labels and source indices; header includes the propagation force model |
| `smallbodies/physical.json` + `.bin` | `smallbodies` | Measured physical attributes, spectra-derived colours, phase fits and spin states, keyed to core rows; absent attributes remain unknown |
| `smallbodies/comets.json` + `.bin` | `smallbodies` | Comet total and nuclear magnitude-law parameters, keyed to core rows |
| `smallbodies/nongrav.json` + `.bin` | `smallbodies` | Non-gravitational model parameters, keyed to core rows |
| `smallbodies/names.json` + `smallbodies/names.txt` | `smallbodies` | Search names and designations: one tab-separated line per core row, with layout in the JSON header |
| `smallbodies/photometry.json` | `sbphotometry` | Solar magnitude/XYZS irradiance, H-G and H-G1-G2 basis functions, colour statistics and label rules for the small-body field |
| `synthetic/objects.json` + `.bin`, `synthetic/cells.json` + `.bin` | `synthetic` | The COMPLETE level: synthetic small bodies, Centaurs and irregular moons (`SyntheticObjectsHeader`: elements at the small-body epoch, heliocentric, or about a planet-system barycentre for a population with a `center`; H, p_V, rotation, colour class, cell and stream index; every attribute labelled `synthetic`) and the cells they fill (`SyntheticCellsHeader`: box, fitted completeness proxy, model and eligible catalogued counts, deficit, seed inputs); conditioned on the exact `smallbodies/core.bin` (sha256 in the header); docs/reports/synthetic-populations.md |
| `comets/model.json` | `comets` | `CometModelProduct`: the physical model of comae and tails — spectral components integrated once against the CIE observers and Bessell V (dust continuum per unit Afρ geometry from measured reddening; gas bands C2 Δv=0/+1, CN, C3, CH, [O I] and the ion tail's CO⁺ per erg cm⁻² s⁻¹), composition ratios log Q(X)/Q(OH) and log Afρ/Q(OH) (population medians), fluorescence efficiencies, Haser enclosed-fraction tables, the water–magnitude relation, grain dynamics (β range, size index, speeds), the dust phase function and the solar-wind speed; the app composes it per comet (render/comets, docs/reports/comets.md) |
| `comets/list.json` | `comets` | `CometListProduct`: every comet's predicted peak m1 from Earth in the window (smallbodies force model, SBDB M1/K1), the comets brighter than `notableMag` (evaluated every frame for coma and tails), the showcase comet, and measured composition per core row where A'Hearn et al. (1995) observed it |
| `stars/bright.json` + `.bin` | `stars` | header + interleaved per-star data |
| `stars/names.json` | `stars` | IAU, Bayer and Flamsteed names keyed by Hipparcos number, with bright-catalogue record indices |
| `stars/deep.json` + `stars/deep-o3-NNN.bin` | `deepstars` | deep star tier (`TiledBinaryTableHeader`): Gaia sources 10 ≤ G < 14 not already in `stars/bright`, same 48-byte record, one file per HEALPix order-3 NESTED (ICRS) pixel, each sorted brightest first; the header lists every tile's centre, radius, count and prefix counts at Y limits, so the app loads tiles by view direction and reads a prefix to a magnitude limit |
| `sky/diffuse.json` + `sky/{faint-stars-o8,diffuse-o6,diffuse-o6-label,deep-aggregate-o8,deep-remainder-o7}.bin` | `sky` | `SkyMapsFile`: HEALPix NESTED (ICRS) float32 XYZS radiance maps (cd/m², scotopic cd/m²): `faintStars` (Gaia G ≥ 14, order 8), `diffuse` (Pioneer 10/11 sky minus all stars = diffuse galactic light + EBL + stars fainter than Gaia, order 6 at 3° resolution, per-pixel method codes), `deepAggregate` (the deep tier summed, for level of detail; not additive), `deepRemainder` (order 7, 4 slices: the deep-tier light not loaded as points when tiles are read to prefix k) |
| `sky/zodiacal.json` | `sky` | `ZodiacalLightModel`: Leinert 1998 zodiacal light at 1 AU (measured), S10sun → XYZS conversion, Kelsall 1998 dust cloud with a visible phase function and albedo fitted to Leinert (for observers away from 1 AU) |
| `sky/corona.json` | `sky` | `CoronaModel`: K-corona electron densities (van de Hulst 1950, minimum and maximum, latitude structure, solar-cycle phase epochs from SILSO/NOAA SWPC), Thomson kernel parameters, the LASCO F-corona law and its join to the zodiacal model, the mean solar disk radiance (all estimated except bSun, derived) |
| `nightglow/airglow.json` | `nightglow` | `AirglowProduct` v2 (resolved as `AirglowModel`): inline physical data in `Sourced.value`; the Earth's airglow from PALACE v1.0 (Noll et al. 2025, measured at Cerro Paranal): per emission class the luminance (XYZS) per rayleigh and per 10 nm sample, the reference zenith intensity and the 12 × 12 month × local-time climatology with solar-cycle slopes; Gaussian layers (altitude above the ellipsoid); the 10.7 cm solar flux (27-day centred means) per day with labels per day; label `estimated` (docs/reports/nightglow.md) |
| `nightglow/aurora.json` + `nightglow/aurora-{ovation,magnetic,emission}.bin` | `nightglow` | `AuroraModel`: OVATION Prime 2010 electron precipitation at 32 coupling nodes × 4 seasons (float16), the hourly Newell coupling from OMNI 2 (`derived`; its climatological median `estimated` where no measured solar wind exists), IGRF-14 AACGM-like coordinates at 110 km on a 1° grid, and the emission model: volume emission of N₂⁺ 1N, O 557.7 nm and O 630/636 nm per unit energy flux vs mean energy and altitude, with each group's luminance per R; label `estimated` |
| `surfaces/<naifId>/<layer>.json` + `<layer>/` tiles + `<layer>.sha256` | `surfaces` | tiled map pyramids per §4.4, with per-tile checksums |
| `surfaces/index.json` | `surfaces` | Bodies → layer headers, plus bodies deliberately without a visible surface map and the reasons |
| `shapes/<id>.json` + `shapes/<id>.bin` | `shapes` | `ShapeModelHeader`: triangle mesh of an irregular body in its own body-fixed frame (km), 1-4 levels of detail (quadric decimation, finest ≤ 2 M triangles), float32 positions, int16 snorm vertex normals, uint16/32 indices. The header states the frame, the rotation model it assumes and its angle to the app's pck00011 frame (or the radar spin state), provenance (spacecraft SPC/SPG/SfM/altimetry and radar → measured; hand-fitted limb models → estimated), integrity and topology (watertight per LOD, components, genus) and a scale check (volume-equivalent radius vs pck00011 or SBDB). id = NAIF id for planetary satellites, SBDB SPK-ID otherwise |
| `shapes/damit-index.json` + `.bin` + `shapes/damit.bin` | `shapes` | `DamitIndexHeader`: every DAMIT lightcurve-inversion model (label derived), one table row per model keyed by SPK-ID with spin state (λ, β, P, t0, φ0, YORP and the IAU form), quality flag, closure and a preferred-model flag; meshes as int16 vertices + uint16 indices, dimensionless unless size-calibrated |
| `shapes/index.json` | `shapes` | `ShapeIndex`: id → name, file, kind, labels, sizes |

Headers (`*.json` next to a `*.bin`) define byte layout explicitly (field name, type, count, stride) so the loader is generic.

`surfaces/399/clouds`, `cloudTau`, `cloudTauEstimated` (the Earth's cloud layers; `SurfaceLayerHeader` kinds `cloud-properties` and `cloud-optical-thickness-moments` in schema.ts; docs/rendering-earth.md §2, docs/sources/satcorps-gcc.md). They are a **mosaic of moments, not one**: each longitude from the hourly file of a cloud composite nearest 13:30 local solar time of one UTC day, in 24 strips of 15° with hard cuts one hour apart and a 24-hour cut at 150° W (`epoch.mosaic`: per strip the file's hour, the satellites with their cell counts and observation times, the cells per class; `epoch.observedSpan`; `epoch.observed` is the sentence shown to a reader; there is no single `start`/`end`). Nothing is blended between hours or carried across a hole; a texel observed over less than half its area is unknown. `clouds` holds [cloudFraction, opticalThickness, cloudTopHeightM, iceFraction], cloudFraction counting every cloud class of the source. The two moments layers hold [tauRetrievedFraction, lnTauMoment1, lnTauMoment2, iceTauFraction] as area-weighted sums: `cloudTau` (label `derived`) over the cloud whose thickness was retrieved from sunlight, `cloudTauEstimated` (label `estimated`) over that cloud together with the cloud whose thickness is the provider's estimate (`constants.geometricTest` states which cells and the evidence). The app binds `cloudTauEstimated` in place of `cloudTau` where the reality level admits its label (Best, Complete) and `cloudTau` at Strict. At every level cloudFraction − tauRetrievedFraction of the layer in use is cloud of unmeasured thickness (`constants.classes`): it is drawn as not measured, and no statistic stands in for it. `diagnostics.areaShares` are the shares of the arrays as written, `diagnostics.cells` the source's cells per class, `constants.pins` the remote files and decoded strips the build was made with.

`synthetic/objects.json`: Jupiter's retrograde irregular moons and Saturn's outer irregular moons use orbit templates from the bright known MPC moons of the modelled class (H_V brighter than the model-comparison completeness limit, inside the grid). The generator assumes that their occupied (a, e, i) cells and cell proportions describe the faint, unseen population; it samples uniformly within each cell and in orbital angles after conditioning on known moons. The orbit templates receive no survey selection correction, so they are an assumption rather than a debiased survey model. This is a documented shortfall against NORTH_STAR §3.3 rule 1's requirement for orbit distributions corrected for survey bias. The `synthetic` labels and `populations[].model.orbitDistribution` method text disclose the assumption; they do not resolve that shortfall. Algorithm and source details: [synthetic-populations.md §12.2](reports/synthetic-populations.md#122-irregular-moons), [mpc-natsats.md](sources/mpc-natsats.md).
The synthetic population metadata uses the existing free-form dictionaries: `populations[].limit.uncertainty` states that the completeness limit is a proxy fitted from a/H bins, not a detection probability; moons fit the whole class over H and copy that limit into each a bin. No pointing history, calibrated efficiency or per-object observation veto is consumed. `model.method` and `model.uncertainty` disclose population assumptions, normalization uncertainty and excluded real objects; `model.motion` describes the actual fixed two-body propagation; `model.positionUncertainty` gives historical C3 sampled drift over the built window while keeping the individual object/viewpoint budget unknown. These strings are displayed as inspector method/uncertainty, including a population row. They add no attribute values or new binary fields. `yieldRule` is aggregate and conditional on fixed model/limits/templates, not one-to-one discovery replacement; refits can change counts and identities. [Audited scope and drift table](reports/synthetic-limitations.md).

Heliocentric synthetic objects currently bypass the catalogue force model, as do the fixed two-body moon elements. That implementation falls short of the motion intention in NORTH_STAR §3.5; a sampled initial orbit can be propagated with gravity, but no measured individual true trajectory or covariance can be supplied for an undiscovered object. The sub-arcsecond light-time arithmetic comparisons above do not certify omitted-force propagation error.



`atmospheres.json` (`AtmosphereFile` in schema.ts; docs/reports/atmospheres.md). Wavelengths are standard-air nm, 360–830 every 10 nm. For each body, altitude 0 is the pck00011 mean radius (`referenceRadiusKm`; `altitudeReference` says what it is physically) and `topRadiusKm` bounds the tabulated atmosphere. Each component gives `extinctionPerKm[altitude][wavelength]` (linear in altitude between levels), `singleScatteringAlbedo[wavelength]` and a `phaseFunction` normalized to a mean of 1 over the sphere; the medium is the sum of its components (β = Σβ_i, ωβ = Σω_iβ_i, ωβP = Σω_iβ_iP_i). Molecular components also give `separable` (number density × cross-section) and pure absorbers (Earth's ozone) have ω = 0 and phase `none`. `foldWeights[c][k]` fold any spectral ratio computed at the samples (e.g. sky radiance per unit solar irradiance) into channel c; multiply by the Sun's XYZS from `light.json` for absolute values, so a renderer needs no solar spectrum (same convention as the surface products' `channelWeights`). `channelEquivalents` are the optically thin per-channel means, for renderers that do not work spectrally. Mars's `dust` component is the annual global mean: scale it by `dustColumn.opticalDepth610Pa(L_s, latitude) / annualGlobalMean610Pa`, with L_s from `solarLongitude` (or the same definition). Quantities labelled `unknown` (the giant planets' limb haze) must not be rendered as if known; `omitted` lists what each body lacks. Titan also carries `surfaceReflectance`, the Lambert reflectance of the surface under its haze (at the 48 samples, and its X, Y, Z, S equivalents), and on its `methane` component the mole-fraction profile and the absorption coefficient at 1 nm. A body with a `surfaceReflectance` has its resolved disk drawn from its atmosphere model, scaled per channel to its disk photometry (§4.3).

`rings.json` (`RingsFile` in schema.ts). Each `RingSystem` uses its planet's equator as its reference plane (IAU pole of the planet in `bodies.json`); component bands may be inclined to it; radii are planet-centred km. `opticalDepth` is a list of `RingProfile`s, each one measured occultation cut: bin-centre radii, normal optical depth τ⊥ (null where unconstrained) and, when the source gives it, the largest measurable τ⊥ (values at or above it are lower limits). This `Sourced<RingProfile[]>` is labelled `measured` and preserves the archived signed/noisy values: no clipping, baseline subtraction or nondetection zeroing. Saturn additionally carries `opticalDepthEstimate`, a separate `Sourced<RingProfile[]>` labelled `estimated`, with the full reconstruction assumptions and parameters in its method. The app prefers that estimate when its label is admitted by the existing reality rule (Best/Complete); Strict uses the measured array, including its smooth outer rise beyond the F ring. Archive τ=-1 or note-flag bit 64 is null for Saturn in both profiles; Neptune's mean signal 0 or opacity lower limit -9 is null, rather than a measured zero. Uranus's raw archive array is unchanged. Null bins retain the renderer's existing unknown-material coverage. Signed footprint means are clamped nonnegative for physical transmission after averaging. Transmission of a ray crossing the ring plane at elevation B is exp(−τ⊥/|sin B|) to first order; in Saturn's A and B rings self-gravity wakes make the true slant optical depth depend on azimuth and elevation by tens of percent, which the profile's `method` text states rather than models. Occultation τ applies at visible wavelengths because the particles are much larger than the wavelength. `reflectance` (`RingReflectance`) is Saturn's ring I/F model (label `estimated`). Jupiter, Uranus and Neptune also carry `components` (`RingComponentModel`, kind `ring-components-v1`, label `estimated`); when admitted at the reality level these replace the classic radial profile for drawing. Strict retains the measured Uranus/Neptune occultation profiles with unknown reflectance; Jupiter has no admitted optical-depth profile at Strict. Saturn's `reflectanceMeasurements` carries the measurements the model is calibrated on (label `measured`), each at its own geometry: the Voyager 2 lit-face and Voyager 1 unlit-face ISS clear-filter radial I/F profiles (PDS VG_2810) and the HST WFPC2 phase curves of the C, B and A rings (Salo & French 2010 Table 4: I/F = a ln α + b in 5 filters, 0.25° ≤ α ≤ 6.3°, six effective elevations).

The model (kind `single-scattering-v1`) is the classical single-scattering reflection and diffuse transmission of a many-particle-thick ring layer (Chandrasekhar 1960; Salo & French 2010 Eq. 6). With μ = |sin B| (observer above the ring plane), μ0 = |sin B′| (Sun), sin Beff = 2μμ0/(μ+μ0) and phase angle α, per CIE channel c (X, Y, Z, scotopic):

- lit face (Sun and observer on the same side): I/F_c = A(r) · W_c(r; α, Beff) · μ0/(4(μ+μ0)) · [1 − exp(−τ⊥(r)(1/μ + 1/μ0))]
- unlit face: I/F_c = A(r) · g_u(r) · W_c(r; α, Beff) · μ0/(4|μ−μ0|) · |exp(−τ_u(r)/μ) − exp(−τ_u(r)/μ0)|; for μ = μ0 this is (τ_u/(4μ)) exp(−τ_u/μ)
- radiance L_c = I/F_c · E☉,c(d)/π (E☉ from `light.json`, scaled to the Sun's distance d), directly comparable with the planets' reflected light of §4.3.

Arrays on the uniform radial grid (`radiusStartKm + i·radiusStepKm`, i < `count`; null = not modelled): τ⊥ = `normalTau` (the cleaned UVIS reconstruction in `opticalDepthEstimate`, retained as the input used to fit the reflectance model; it and the dependent inversions/fits inherit `estimated`), A = `litModulation`, τ_u = `unlitTau`, g_u = `unlitGain`. W_c = ϖP, the particle albedo times phase function, per region in `regions[].amplitudeXYZS[e][p][c]` on the grids `elevationEffDeg` × `phaseDeg`: interpolate bilinearly in (α, Beff), clamping Beff to the grid; inside a region's `radiusKm` use its table, between two regions interpolate linearly in radius from one region's edge to the next, outside all regions use the nearest. The `formula` string in the product states the same.

How the pieces were obtained (the product's `method` has the details):

1. W for α ≤ 6.3°: the HST curves inverted through the lit-face formula with each region's UVIS τ⊥, reconstructed across wavelength piecewise-linearly through the five filters and integrated against sunlight and the CIE observers (like `geometricAlbedoXYZS`).
2. W for 6.3° < α ≤ 47°: a power-law particle phase function (π − α)^n, the Callisto-like form Salo & French use (n = 3.09), with n per region fitted so that the model reproduces the region's mean Voyager 2 lit I/F at 47°. The fits (n ≈ 3.5-3.8) confirm the two independent anchors are consistent. Colour beyond 6.3° is held at its 6.3° value (assumption).
3. A(r): radial structure, fitted so that the model reproduces the Voyager 2 lit profile bin by bin at its geometry. Colour, phase and tilt behaviour away from the three HST regions (e.g. Cassini Division, outer B ring) are interpolated (assumption).
4. τ_u, g_u: fitted so that the model reproduces the Voyager 1 unlit profile bin by bin. In the B ring τ_u ≈ 1 while τ⊥ ≈ 5: light reaches the unlit side by multiple scattering and between self-gravity wakes. The unlit face's colour and phase shape are assumed to follow the lit face's.

Domain: `minPhaseDeg` ≤ α ≤ `maxPhaseDeg` (0.25-47°); outside, ring brightness is unknown in this product (the renderer hatches it). [Published high-phase measurements exist](sources/rings-high-phase.md) but are not yet included in the product. Not modelled: the A ring's azimuthal wake asymmetry, spokes, the F ring (A null beyond 138 700 km). Independent check: the net light the rings add to Saturn matches Mallama & Hilton's (2018) ground photometry within 10 % for ring elevations 15-26° at α = 1-3° (docs/reports/planet-colors.md).


### Ring components

`components` holds sheets between eccentric, inclined, precessing edges with normal modes, longitudinal arcs, and vertically extended dust tori. Radii/heights are planet-centred km; epochs are TDB seconds past J2000. Longitudes increase in the orbital direction from the ascending node of the angular-momentum equator on ICRF; `poleSense` is -1 for Uranus and +1 for Jupiter/Neptune. Geometry, optical depth and reflectance each carry a `Sourced` payload; phase tables do too. Flat fields are compatibility aliases. The model label is the worst known input label; unknown aspects retain null values and explicit labels. A brightness profile with `opticalDepthKnown=false` scatters but cannot absorb or cast shadows.

A component's optional `geometryValidity` carries inclusive `startEt`, `endEt` and `basis` inside its sourced geometry and as a flat alias. `basis` distinguishes source-stated validity from a pipeline policy restricting propagation to supporting observations: a reference epoch alone is not a validity interval. The French 2024 Uranus fits have separate edge rates; their historical component uses each ring's accepted COR observation dates (1977–2006, eta/delta through 2002, lambda 1985–1996). Outside support, Best/Complete may select its separately sourced `outsideSupportEstimate`: an estimated COR ellipse propagated at fitted rates with constant published mean width and historical PPS equivalent depth distributed uniformly. Fitted edges/modes and width variation are omitted; method text names the fit, elapsed years per ring, computed endpoint formal phase-displacement errors, missing covariance and unbounded dynamical change. Static m=0 boundary offsets encode ±W/2 using existing component arithmetic, not observed modes. Reflectance is unchanged. Strict retains the measured occultation profile and unknown-reflectance marking. Neptune's arc mean motion remains restricted to Souami 2022's 1989–2016 anchors, without an outside-support estimate. Neither paper warrants extrapolation. Without an admitted alternative outside support, or at nonpositive/nonfinite local width inside support, geometry is unknown: no light, optical depth, extinction or substitute width. A conservative radial envelope is an annotation, not physical geometry or a predicted arc location. Valid positive widths have no floor. Stationary estimated profiles without a source-stated temporal span retain their dated-profile assumption in provenance; this is no claim that their structure was measured at every date.

Layer and thin terms follow the formulas in the product (`photometry/ring_components.py`); per-channel radiance is I/F times solar irradiance at the ring divided by π. Phase tables interpolate logarithmically within their stated domains. Missing brightness or a term outside its phase domain emits no light; covered material is marked as not measured even at very small optical depth. Uranus λ and Neptune Galle reflectance remain unknown. Digitizations and computations using assumptions are estimated. Components currently omit unresolved point-source light, torus extinction and inclined-plane extinction. Coverage, source epochs and remaining model discrepancies are described in [the ring report](reports/rings.md).
