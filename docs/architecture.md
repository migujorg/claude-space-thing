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

**No placeholders, ever.** If a value is not available, it is `unknown` and the renderer shows it as unknown (§5.3). A fixture or guess must never enter `app/public/data/`. Test fixtures live under `*/tests/` only.

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

Objects are drawn where their light left them (NORTH_STAR 3.4): for each object, solve the light-time equation against the observer (iterate `τ = |r_obj(t−τ) − r_obs(t)| / c`, 2–3 iterations) using `c` from `constants.ts`. The observer is at rest in the SSB frame (no stellar aberration) unless and until that open question is decided otherwise.

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

The resolved renderer must use a surface reflectance model whose disk integral reproduces both p and Φ(α) (energy consistency between "point" and "disk" views). The phase function Φ is itself a `Sourced` value (e.g. a published phase curve) — if the only available model is an assumption such as Lambert, it is labeled `estimated`.

Conventions used by the `light` stage: R is the volumetric mean radius (abc)^(1/3) of the body's pck00011 triaxial radii (albedos from sources that used other disk sizes are rescaled by (R_source/R)²). Φ is evaluated only inside its stated domain (`minDeg..maxDeg`, or the table's range); outside it the phase behaviour is unknown. A `poly-mag` whose domain excludes α = 0 may have c0 ≠ 0 (Mercury: the fitted curve starts at 2° and excludes the opposition surge that the zero-phase albedo includes). The reverse also occurs: a surge-free albedo with a curve that includes the surge has Φ > 1 (negative `deltaMag`) near its first node (the Moon: the table starts at 1.55°).

Optional `diskReflectanceModel` (M3; so far only the Moon, kind `rolo-v1`): when a body's disk-integrated brightness depends on more than α, this model gives it directly per channel. The Moon's depends on which hemisphere is lit (the waxing Moon is ~10 % brighter than the waning Moon at 60°) and on libration (up to 7 % or more). The illuminance is

```
E_obs,c = A_c(g, Φ, θ, φ) · E☉,c(1 AU) · (1/d²) · (radiusKm/Δ)²
```

with A_c from the model's `formula`. The inputs are the phase angle g, the Sun's selenographic longitude Φ, and the observer's selenographic latitude and longitude θ, φ. E☉,c is the solar XYZS in `light.json`. The model applies only inside its stated domain (phase range and observer libration range). There it replaces `geometricAlbedoXYZS · Φ(α)`; outside it, the α-only `phaseFunction` applies (within its own domain). `phaseFunction` equals the model's Y channel at zero libration, averaged over waxing and waning (geometric mean), divided by the albedo's Y.

### 4.4 Surface maps (M2)

Disk-integrated photometry (§4.3) is the **absolute** calibration of a body's brightness and color: it is measured from far away with well-understood instruments. Surface maps supply only the **spatial pattern** on top of it. This keeps the two consistent by construction and stops a map's calibration problems from changing how bright a world is.

- **Texel content:** four float16 values (X, Y, Z, S) of *relative* normal reflectance: the ratio of the local normal albedo spectrum, integrated per §4.2 against sunlight, to the body's disk-integrated value. The pipeline normalizes each map so its disk-average (projected-area weighted, as seen at zero phase and averaged over rotation) is 1 in every channel. The renderer multiplies texels by the body's `geometricAlbedoXYZS` and applies its photometric model, then rescales so the disk integral still reproduces p and Φ(α) exactly (§4.3).
- **Color honesty:** a map made from several calibrated bands gives per-channel variation (label per map, usually `derived`). A single-band (panchromatic) map gives the same relative variation in all four channels, so local color is the disk-average color: that assumption makes the *map's color* `estimated`, while its brightness pattern keeps the map's own label.
- **Epoch:** maps of changing surfaces (giant-planet cloud tops, Earth's clouds) carry the observation date. Showing them at another time is `estimated`; the inspector says how far from the map epoch the current time is.
- **Geometry:** planetocentric latitude and east longitude in the body's IAU body-fixed frame (the same frame `bodyToIcrf` uses). Equirectangular tiles: u = (lon_E + 180°)/360°, v = (90° − lat)/180°. Pyramid level L has 2^(L+1) × 2^L tiles of 256 × 256 texels (level 0 = 512 × 256 texels, the whole body). Tiles are raw little-endian float16 RGBA (`.bin`, 512 KiB each), addressed `surfaces/<naifId>/<layer>/<L>/<ty>/<tx>.bin`.
- **Layers:** `albedo` (above) and optionally `height` (one float32 per texel, meters above the reference ellipsoid, same tiling), used for normals and, later, displacement. Each layer has a `surfaces/<naifId>/<layer>.json` header: levels, source ids, label, epoch, notes, per-channel normalization constants, and the valid lat/lon coverage (gaps are `unknown` and rendered as such, never filled).
- **Photometric model:** when a body has a measured spatially-resolved photometric model (e.g. Hapke parameters from LROC for the Moon, MESSENGER for Mercury), photometry.json carries it and the renderer uses it instead of Lambert for the *spatial* distribution; the disk-integrated Φ(α) still governs total brightness.

## 5. The app

### 5.1 Module layout

```
app/src/
  core/       time scales, ephemeris evaluation, frames, rotation, light-time, constants — pure TS, unit-tested, no DOM/GPU
  data/       schema.ts (the contract), loaders for manifest/sources/bodies/binaries
  render/     WebGPU device, HDR target, passes (stars, bodies, sun, overlays)
  eye/        human-eye model: adaptation, glare PSF, visibility thresholds, mesopic, display mapping
  ui/         camera controls, time controls, reality dials, inspector, search
  main.ts     wiring
```

### 5.2 Reality settings (NORTH_STAR 3.7)

`RealityState = { exists: 'strict' | 'best' | 'complete', view: 'eye' | 'enhanced', overlays: { labels, orbits, provenance } }`. Every draw path must consult the `exists` level against each attribute's label. Default `best` + `eye`. Any non-default state shows a persistent on-screen badge.

### 5.3 Showing unknowns

When an attribute needed for drawing is below the current `exists` level or `unknown`, the object is still drawn from what *is* allowed, and the missing aspect is visibly marked rather than filled:
- position known, size/brightness not → point at its measured brightness only if brightness is allowed, else a small hollow marker (overlay layer).
- shape known, surface reflectance not → silhouette rendered with a neutral hatched "not measured" material, never a plausible-looking color.

### 5.4 Verification

- `app/tests/` — vitest unit tests; ephemeris and time conversions are checked against independent JPL Horizons outputs saved as test fixtures.
- `app/scripts/shot.mjs` — headless Chromium (SwiftShader WebGPU) screenshot harness. Usage: `npm run shot -- --url "/?t=2026-09-30T00:00:00Z&target=399&dist=50000" --out shots/earth.png`. The app sets `window.__frameReady = true` after the first frame with all data loaded.
- The app exposes `window.__app` for tests (read current state, set time, select objects).

## 6. Data products (app/public/data)

| File | Producer stage | Content |
|---|---|---|
| `manifest.json` | all | build time, validity windows, list of products with sha256 and byte sizes |
| `sources.json` | all | `SourceRecord[]` |
| `time.json` | `time` | leap seconds (UTC instants and ΔAT) and TDB formula constants from the LSK |
| `ephem/<name>.json` + `ephem/<name>.bin` | `ephemeris` | SPK segments restricted to the window; bin is float64 little-endian, native SPK type 2/3 record layout (type 17: one 12-double record). `ephem/de442s`: planets; `ephem/centers`: planet centres 499–999 only (bit-identical copies of the sat-* segments; loaded before the first frame); `ephem/sat-{mar,jup,sat,ura,nep,plu}`: planet centres and every moon, one file per system (lazy-loadable) |
| `orient/<name>.json` + `orient/<name>.bin` | `bodies` | Precise body orientation (`OrientationHeader`): binary-PCK Euler-angle records for the window. `orient/earth` (ITRF93), `orient/moon` (DE440 Mean Earth frame); preferred over the IAU model where they cover (`OrientationSet`) |
| `bodies.json` | `bodies` | `Body[]` with `Sourced` attributes (geometry, rotation, GM, ephemeris wiring) |
| `photometry.json` | `light` | NAIF id → `BodyPhotometry` (albedo spectra integrated per §4.3, phase functions); merged into bodies by the app loader |
| `light.json` | `light` | Sun spectrum-derived quantities, CIE constants actually used |
| `rings.json` | `light` | planet NAIF id → `RingSystem`: measured radial profiles of normal optical depth (occultations); Saturn: ring I/F model (lit and unlit faces, per channel) and the measured I/F data it is built on; see below |
| `smallbody-class-colors.json` | `light` | `SmallBodyClassColorsFile`: per Bus-DeMeo class, the colour per unit V-band albedo (`xyzsPerUnitPV`) and NEOWISE p_V statistics, SDSS class frequencies, a population entry and alias tables; for small bodies without a measured spectrum (docs/sources/smallbody-class-colors.md) |
| `stars/<name>.json` + `.bin` | `stars` | header + interleaved per-star data |
| `surfaces/<naifId>/<layer>.json` + tiles | `surfaces` | tiled map pyramids per §4.4 |

Headers (`*.json` next to a `*.bin`) define byte layout explicitly (field name, type, count, stride) so the loader is generic.

`rings.json` (`RingsFile` in schema.ts). Each `RingSystem` lies in its planet's equatorial plane (IAU pole of the planet in `bodies.json`); radii are planet-centred km. `opticalDepth` is a list of `RingProfile`s, each one measured occultation cut: bin-centre radii, normal optical depth τ⊥ (null where unconstrained) and, when the source gives it, the largest measurable τ⊥ (values at or above it are lower limits). Transmission of a ray crossing the ring plane at elevation B is exp(−τ⊥/|sin B|) to first order; in Saturn's A and B rings self-gravity wakes make the true slant optical depth depend on azimuth and elevation by tens of percent, which the profile's `method` text states rather than models. Occultation τ applies at visible wavelengths because the particles are much larger than the wavelength. `reflectance` (`RingReflectance`) is Saturn's ring I/F model (label `estimated`) and `unknown` for the other systems (a renderer must mark their ring brightness as not measured rather than invent it). Saturn's `reflectanceMeasurements` carries the measurements the model is calibrated on (label `measured`), each at its own geometry: the Voyager 2 lit-face and Voyager 1 unlit-face ISS clear-filter radial I/F profiles (PDS VG_2810) and the HST WFPC2 phase curves of the C, B and A rings (Salo & French 2010 Table 4: I/F = a ln α + b in 5 filters, 0.25° ≤ α ≤ 6.3°, six effective elevations).

The model (kind `single-scattering-v1`) is the classical single-scattering reflection and diffuse transmission of a many-particle-thick ring layer (Chandrasekhar 1960; Salo & French 2010 Eq. 6). With μ = |sin B| (observer above the ring plane), μ0 = |sin B′| (Sun), sin Beff = 2μμ0/(μ+μ0) and phase angle α, per CIE channel c (X, Y, Z, scotopic):

- lit face (Sun and observer on the same side): I/F_c = A(r) · W_c(r; α, Beff) · μ0/(4(μ+μ0)) · [1 − exp(−τ⊥(r)(1/μ + 1/μ0))]
- unlit face: I/F_c = A(r) · g_u(r) · W_c(r; α, Beff) · μ0/(4|μ−μ0|) · |exp(−τ_u(r)/μ) − exp(−τ_u(r)/μ0)|; for μ = μ0 this is (τ_u/(4μ)) exp(−τ_u/μ)
- radiance L_c = I/F_c · E☉,c(d)/π (E☉ from `light.json`, scaled to the Sun's distance d), directly comparable with the planets' reflected light of §4.3.

Arrays on the uniform radial grid (`radiusStartKm + i·radiusStepKm`, i < `count`; null = not modelled): τ⊥ = `normalTau` (UVIS occultation, the same profile as `opticalDepth`), A = `litModulation`, τ_u = `unlitTau`, g_u = `unlitGain`. W_c = ϖP, the particle albedo times phase function, per region in `regions[].amplitudeXYZS[e][p][c]` on the grids `elevationEffDeg` × `phaseDeg`: interpolate bilinearly in (α, Beff), clamping Beff to the grid; inside a region's `radiusKm` use its table, between two regions interpolate linearly in radius from one region's edge to the next, outside all regions use the nearest. The `formula` string in the product states the same.

How the pieces were obtained (the product's `method` has the details):

1. W for α ≤ 6.3°: the HST curves inverted through the lit-face formula with each region's UVIS τ⊥, reconstructed across wavelength piecewise-linearly through the five filters and integrated against sunlight and the CIE observers (like `geometricAlbedoXYZS`).
2. W for 6.3° < α ≤ 47°: a power-law particle phase function (π − α)^n, the Callisto-like form Salo & French use (n = 3.09), with n per region fitted so that the model reproduces the region's mean Voyager 2 lit I/F at 47°. The fits (n ≈ 3.5-3.8) confirm the two independent anchors are consistent. Colour beyond 6.3° is held at its 6.3° value (assumption).
3. A(r): radial structure, fitted so that the model reproduces the Voyager 2 lit profile bin by bin at its geometry. Colour, phase and tilt behaviour away from the three HST regions (e.g. Cassini Division, outer B ring) are interpolated (assumption).
4. τ_u, g_u: fitted so that the model reproduces the Voyager 1 unlit profile bin by bin. In the B ring τ_u ≈ 1 while τ⊥ ≈ 5: light reaches the unlit side by multiple scattering and between self-gravity wakes. The unlit face's colour and phase shape are assumed to follow the lit face's.

Domain: `minPhaseDeg` ≤ α ≤ `maxPhaseDeg` (0.25-47°); outside, ring brightness is unknown (the renderer shows that, e.g. by marking the rings as unmeasured). Not modelled: the A ring's azimuthal wake asymmetry, spokes, the F ring (A null beyond 138 700 km). Independent check: the net light the rings add to Saturn matches Mallama & Hilton's (2018) ground photometry within 10 % for ring elevations 15-26° at α = 1-3° (docs/reports/planet-colors.md).
