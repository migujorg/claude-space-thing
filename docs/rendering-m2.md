# Renderer M2: true-colour worlds up close

This is the renderer side of milestone M2. It covers surface maps (virtual texturing), height relief,
measured spatial photometric models, the Moon's ROLO disk model, rings, planetshine, best-estimate phase
extrapolation and GPU timing. The eye model is in [eye-model.md](eye-model.md) and the data contracts
are in [architecture.md](architecture.md) §4.3–4.4 and §6.

Code:

- `app/src/render/spatial.ts`: photometric laws and disk normalization.
- `surface.ts` and `surfaceGpu.ts`: virtual texturing.
- `rings.ts`, `planetshine.ts`: rings and planetshine.
- `photometry.ts`: the reflected-light contract, phase extrapolation, ROLO.
- `frame.ts`: per-frame preparation.
- `shaders-m2.ts` and `shaders.ts`: WGSL.

Tests: `app/tests/render-{spatial,surface,normalization,rings-planetshine,rolo,frame}.test.ts`.

Test scenes, on `app/render-test.html?scene=…`:

- `vt|lowsun|hapke|rings|earthshine`: every number is a TEST FIXTURE, not data.
- `rings-data|moon-data`: the pipeline's products under `/data` (rings.json, photometry.json,
  light.json, bodies.json, surfaces/), seen from a synthetic geometry chosen by URL parameters
  (`src/render-test/dataScenes.ts`).

## 0. What the shell must provide

All new inputs are optional `SceneBody` fields (`app/src/render/scene.ts`). Without them the renderer
behaves exactly as in M1.

| Field | From | Meaning |
|---|---|---|
| `allowPhaseExtrapolation` | reality level | `exists !== 'strict'`. Already set in `app/src/app/snapshot.ts` (one line). |
| `spatialModel` | `photometry.json` → `BodyPhotometry.spatialModel.value`, if admitted at the level | Measured spatial law. Absent → Lambert. No body has one in the current products. |
| `diskReflectanceModel` | `photometry.json` → `BodyPhotometry.diskReflectanceModel.value` (the Moon: ROLO), if admitted | Disk-integrated brightness from the model inside its domain (§4). Needs `orient`. Include its label (`derived`) in `worstLabel`. |
| `surface.albedo` / `surface.height` | `surfaces/index.json` → `surfaces/<id>/<layer>.json` | `{ url: '<data root>', header: <the parsed SurfaceLayerHeader> }`. Example: `{ url: '/data', header }` for `surfaces/301/albedo.json`. The renderer builds tile URLs from `header.tilePath`, skips `header.missingTiles`, and checks `format`, `channels`, `bytesPerTexel`, `tileSize` and `minLevel`. Only used when `orient` is non-null. The `hapke` layer (per-texel parameters) is not used yet. |
| `rings` | `rings.json` → the planet's `RingSystem` | `{ normal: <planet IAU pole, ICRF unit vector>, opticalDepth: rs.opticalDepth.value, reflectance: rs.reflectance.label !== 'unknown' && admitted ? rs.reflectance.value : null, worstLabel }`. For Saturn, `worstLabel` = worst of `opticalDepth.label` (measured) and `reflectance.label` (estimated). Pass `rings: null` when `opticalDepth.value` is null (Jupiter). |

Renderer options:

- `Renderer.create(canvas, { surfaceCacheMiB })` sets the tile budget (default 1024), and
  `renderer.setSurfaceCacheBudget(MiB)` changes it later.
- `RendererStats` gains `surfaceCache`, `gpuPassMs` and `gpuFrameMs`.
- Warnings the renderer adds itself:
  - phase extrapolated beyond measured range;
  - ring reflectance not measured;
  - ring phase angle outside the model's range;
  - ring effective elevation outside the calibrated range;
  - surface layer format not decodable.

Labels: when a phase curve is extrapolated, the renderer raises the provenance-tint label to `estimated`
itself. The shell may also want to lower the inspector's label.

Planetshine needs no input beyond the bodies already in the snapshot and `sun.irradianceXYZS_1AU`.

## 1. Surface maps: virtual texturing

The contract is architecture §4.4 (`SurfaceLayerHeader` in `data/schema.ts`):

- Albedo texels are float16 XYZS relative reflectance (disk average 1). All-zero texels are unknown.
- Height is float32 meters, NaN = unknown.
- Pages are 256² tiles in an equirectangular, planetocentric, east-longitude pyramid:
  - u = (lon + 180)/360, v = (90 − lat)/180;
  - level L has 2^(L+1) × 2^L tiles.

Everything above matches the pipeline's products.

- **Which tiles:** each frame, rays are cast in float64 on the CPU through a grid of screen samples every
  24 px over each body's footprint (`footprintTiles`). Each hit picks the pyramid level whose texel
  matches the pixel's surface footprint, `L = round(log2(2πR / (512·fp)))`, with
  fp = pixel angle × range / √max(μ, 0.05). The shader applies the same rule per pixel. A needed tile
  brings its ancestors, and level 0 is always requested and pinned.
- **Fetching:** asynchronous, at most 8 in flight, most urgent first (coarse levels, then distance from
  the screen centre). The URL is the header's `tilePath` under the data root. A 404 or a tile listed in
  `missingTiles` is never fetched again: its texels are unknown.
- **Cache:** two texture-array atlases, rgba16float for albedo and r32float for height, both 256² pages.
  - A shared u32 page table holds `page + 1` per tile of every layer, level-major. It has a CPU mirror
    and dirty-range uploads.
  - Pages are allocated when a tile arrives. Eviction is LRU among pages not used this frame.
  - When every page is in use, finer requests are *deferred*, reported in
    `stats.surfaceCache.deferredTiles`.
  - The budget is strict. Only whole atlas layers that fit are allocated (2/3 of the budget for albedo,
    1/3 for height), and nothing is allocated before the first map appears.
  - Levels above 10 are not addressed (page table 2.8 M entries per layer; ~40 m/texel on Mars).
- **Shader:** the level to filter at is the finest *resident* level at or below the wanted one, which
  gives a graceful coarse fallback while tiles stream in. Each of the four bilinear taps walks down the
  page table on its own, so filtering continues across tile borders and partially loaded neighbours.
- **Coverage gaps:** unknown texels are shaded at the disk-average reflectance (M = 1, the measured
  average, not an invented pattern) and flagged. The body pass writes a MASK target, and a display-space
  pass draws the "not measured" hatch over exactly those regions (architecture §5.3). Tiles that are
  still loading also use M = 1 but are not hatched.
- **Normalization** (next section) uses the map's level-0 zonal mean, computed once from the level-0
  tiles when they arrive. It never reads back from the GPU. Unknown texels count as 1, as shaded.

With the real products (`scene=moon-data`), LROC albedo and LOLA heights of the Moon stream in and show
relief along the terminator (12 tiles, 91 MiB at 960×540).

## 2. Spatial photometric models and the normalization

Available models (`schema.ts` `SpatialPhotometricModel`; float64 reference in `spatial.ts`, mirrored in WGSL):

- Lambert.
- Lommel–Seeliger.
- lunar-Lambert (McEwen 1991), with L constant or tabulated vs α.
- Minnaert (1941), with k constant or tabulated vs α.
- Hapke (2012): the IMSA form with SHOE, CBOE, double Henyey–Greenstein p(g) (b, c), porosity K,
  Hapke's (1984) macroscopic roughness θ̄, and the Hapke (2002) or (1981) H function.

The design is a per-body constant parameter set. Per-texel parameters, such as the pipeline's `hapke`
layer for the Moon (Sato et al. 2014 at 1°, 7 bands), would need a further layer type (§8).

**Normalization.** A model only distributes light across the disk. The rendered radiance is

  L = pΦ/(π d²) · r(μ0, μ, g) · M / I(α),
  I(α) = (1/πR²) ∫ r(μ0, μ, α) · M̄(lat) dA_proj,

computed per channel. Here pΦ is albedoXYZS·Φ(α), or the disk model's value (§4), and M̄ is the map's
zonal (rotation-averaged) mean. I is integrated in float64 by Gauss–Legendre quadrature over the lit
and visible lune in photometric longitude and latitude, and cached per geometry. The disk integral of
the rendered body then reproduces the measured pΦ·(1/d²)(R/Δ)²:

- exactly, for any model and any map without longitude structure;
- on average over the rotation, for any map. Real rotational light curves survive rather than being
  normalized away.

Tests check this by brute-force integration over the sphere (Lambert and Hapke, a banded map and a
spotted map, < 0.5 %). For plain Lambert without a map, I = (2/3)Φ_L(α) exactly (the M1 formula). The
normalization ignores relief (height maps).

**Verification of the models.**

- Hapke matches the USGS ISIS reference implementation's unit-test truth values (`Hapke.truth`: smooth
  and rough cases, public domain) to 6 digits, using the Hapke (1981) H function as ISIS does.
- lunar-Lambert and Minnaert match ISIS (`LunarLambert.truth`, `Minnaert.truth`).
- The Hapke (2002) H approximation is within 1 % of Chandrasekhar's H. The exact H is solved in the
  test, and the solver itself is checked against the moment identity ∫H dμ = (2/w)(1 − √(1 − w)).
- Disk integrals match closed forms: Lambert (2/3)Φ_L; Lommel–Seeliger ½[1 − sin(α/2)tan(α/2)ln cot(α/4)];
  Minnaert geometric albedo 2/(2k + 1).
- Outside a model's `validPhaseDeg` or its parameter tables, the spatial distribution falls back to
  Lambert, with a warning.

## 3. Height maps: relief normals and self-shadowing

- **Normals:** central differences of the height map at the pixel's level, converted to slopes with the
  local radius. The perturbed normal (east/north tangent frame, body-fixed, then rotated to ICRF) is used
  in the spatial law for μ0, μ and g. Only height differences are used, so the reference surface of the
  layer (sphere for the Moon, pck00011 ellipsoid for Mars and Mercury) does not matter.
- **Self-shadowing:** a horizon search toward the Sun through the height field.
  - There are 40 steps from one texel, growing 15 % each and capped at R/4. Curvature is included as a
    drop of d²/2R.
  - The fraction of the solar disk above the horizon angle gives a soft, physically sized penumbra.
    The disk's angular radius comes from the Sun's radius and distance.
  - Relief catches light beyond the ellipsoid terminator where the horizon allows.
  - Shadows are black: there is no fill light from sunlit terrain (terrain interreflection is not
    modelled). Planetshine still reaches shadowed areas, which is correct for earthshine.
- Displacement of the silhouette is not implemented; limb profiles are those of the ellipsoid.

## 4. The Moon: ROLO disk-integrated brightness

`photometry.json` gives the Moon a `diskReflectanceModel` (kind `rolo-v1`). This is the ROLO lunar model
(Kieffer & Stone 2005, Eq. 10), converted by the pipeline to the CIE channels. It includes the
opposition surge, the waxing/waning asymmetry and libration. The renderer evaluates it per channel
(`photometry.ts roloReflectance`):

  ln A_c = Σ a_i g^i + b1 Φ + b2 Φ³ + b3 Φ⁵ + c1 θ + c2 φ + c3 Φ θ + c4 Φ φ + d1 e^(−g°/p1) + d2 e^(−g°/p2) + d3 cos((g° − p3)/p4)

The inputs:

- g: the phase angle, in radians in the polynomial terms and in degrees (g°) in the exponential and
  cosine terms.
- Φ: the Sun's selenographic longitude (east positive) in radians.
- θ, φ: the sub-observer latitude and longitude in degrees, from the body-fixed frame `orient`.

Inside the domain (1.55° ≤ g ≤ 97°, |θ| ≤ 7°, |φ| ≤ 8°), pΦ = A_c · E☉,c(1 AU) · (radiusKm/R)²
replaces albedoXYZS·Φ(α) in the disk illuminance and in the resolved radiance (§2). Outside it, the
phase curve applies as before. From a spacecraft far off the Earth–Moon line, that is the curve.
Planetshine uses the same value when the Moon is the source (moonshine on Earth).

Tests (`render-rolo.test.ts`):

- The formula is checked term by term.
- The waxing Moon is 10.5 % brighter than the waning Moon at 60°, as the architecture states (~10 %).
- The geometric mean of waxing and waning, divided by p_Y, reproduces the pipeline's own phase curve
  within 0.2 % at 2–90°.
- Outside the domain the model is not applied.
- The frame preparation uses the model in its domain and falls back outside it.

In the real-data scene the disk illuminance at 60° is 0.0750 lx waxing and 0.0679 lx waning.

## 5. Planetshine

For each lit, resolved body i, the two strongest other bodies j act as point sources of illuminance

  E_ij = pΦ_j(α_ij) · (1/d_j²) · (R_j/Δ_ij)²

where α_ij is j's phase angle as seen from i, and pΦ_j is its §4.3 disk photometry (albedo·Φ, or ROLO
for the Moon). Body i reflects it with a Lambert law of albedo A_L = 1.5·p_i, where
p_i = albedoXYZS_i / E_sun,1AU per channel, times its surface map.

So Earthshine on the Moon, Jupiter-shine on the Galilean moons and Saturn-shine on Saturn's moons come
from measured photometry of both bodies. Its colour follows the illuminating body: earthshine is bluish.

What is estimated: the spatial law (Lambert), the point-source approximation (the Earth spans 2° from the
Moon), and the lack of eclipses of the source.

## 6. Rings

Rings are rendered by ray–plane intersection on a screen quad around the ring system, or on the full
screen when the camera is within three outer radii. The plane intersection is conditioned like the
ellipsoids (§3.3 of architecture), so it holds from 1 m to 50 AU.

**Extinction** comes from the measured occultation profiles (`opticalDepth`). A ray crossing the plane at
elevation B is transmitted exp(−τ⊥/|sin B|). This sets:

- the rings' shadow on the planet and on nearby moons (within 10 outer radii), softened by the solar
  disk's footprint in the ring plane;
- bodies seen through the rings.

The raw τ, which can be slightly negative from measurement noise (Uranus: down to −0.23 per 1 km bin),
is averaged over each footprint and then clamped at 0. Clamping each bin first would turn noisy empty
gaps into material.

**Reflectance** is the pipeline's model (`reflectance`, kind `single-scattering-v1`, architecture §6):
the classical single scattering of a many-particle-thick layer, calibrated on Voyager and HST. Per CIE
channel, with μ = |sin B| (observer), μ0 = |sin B′| (Sun) and sin Beff = 2μμ0/(μ+μ0):

- lit face: I/F = A·W·μ0/(4(μ+μ0))·[1 − e^(−τ⊥(1/μ+1/μ0))]
- unlit face: I/F = A·g_u·W·μ0/(4|μ−μ0|)·|e^(−τ_u/μ) − e^(−τ_u/μ0)|
- radiance: L = I/F · E☉(d)/π.

W = ϖP comes from the region tables. It is bilinear in (α, Beff) with Beff clamped, linear in radius
between regions, and takes the nearest region's value outside them.

The domain is the model's phase range (0.25–47°). Outside it, and wherever A is null (the F ring, beyond
138 700 km), the ring material is hatched as "not measured" and gives no light. Where the effective
elevation is below the calibrated 4.5° (Saturn near ring-plane crossing, 2025–26) or above 26.1°, the
particle term is held at the table edge. The renderer then warns: "effective elevation … outside the
calibrated … → particle term held at the table edge (estimated)". Systems without a model (Jupiter,
Uranus, Neptune) absorb and cast shadows. Their material is hatched and they never add light.

**Antialiasing without bias.** A pixel sees the mean over a radial footprint that may cover thousands of
10 km bins, and the photometry is non-linear in τ. Averaging τ first would brighten mixtures of gaps and
ringlets. Instead, the profile stores cumulative sums over radius of functions of τ at fixed geometry
nodes:

- lit face: F_lit(k) = avg(A·e^(−τ⊥k)) at 22 nodes, k = 2·2^(j/2).
  I/F = W·μ0/(4(μ+μ0))·(avg A − F_lit(1/μ+1/μ0)).
- unlit face: H_u(m) = avg(A·g_u·τ_u·e^(−τ_u m)) at 44 nodes, m = 2^(j/4).
  I/F = W/(4μ) · |∫ H_u dm| / |m1 − m0| over [1/μ0, 1/μ], which is exact algebra.
  H_u has no constant part from empty gaps. That part would swamp the small difference of two
  exponentials.

Both are interpolated log-linearly. That is exact when the footprint has a single τ. An offline check
over random mixtures of gaps and ringlets and 300 geometries bounds the error at 1.0 % (lit) and 2.0 %
(unlit) of the exact footprint mean. The unit test checks a 50 % gap / 50 % ringlet footprint to 2 %.
The unlit face needs the denser spacing: √2 spacing for H_u gave up to 10 %, 2^(1/4) gives 2 %. Footprint integrals use per-bin increments of the cumulative sums, so sub-bin footprints keep
float32 precision. The footprint is also kept a few ulps wide, which fixed a 0/0 at the ring plane on
Uranus's 15 750-bin profile.

**Unresolved rings.** Between 1 and 2 pixels of ring diameter the ring pass fades out. The unresolved
part of the rings' light joins the planet's point source. `ringIlluminance` integrates the model over
the ring plane: 200 annuli from the same footprint means, times the fraction of 48 azimuths neither
hidden nor shadowed by the planet's ellipsoid. Saturn's albedo is globe-only ("Globe without rings" in
its photometry), so from Earth the point brightness is now globe + rings. A test checks the integral
against direct quadrature (0.5 %) and shows that the planet's occultation and shadow reduce it.

**Occlusion:** the planet's shadow on the rings uses its ellipsoid, with the solar-disk overlap as
penumbra. The rings depth-test against bodies but do not write depth.

**Not modelled:** self-gravity wakes (azimuth-dependent τ and brightness), spokes, Saturn-shine on the
rings, ringshine on the planet, and ring shadows or occultation of the globe in the *point* brightness
of an unresolved Saturn.

## 7. Best-estimate phase extrapolation

Most moons' phase curves were measured only near opposition from Earth: Titan 0–5.7°, the Uranian
moons 0–3.1°.

- At `exists = strict`, a phase angle outside the measured range leaves the sunlit part hatched as not
  measured and the night side black, as in M1.
- At best or complete (the shell sets `allowPhaseExtrapolation`), Φ continues with the spatial law's own
  phase dependence. It is scaled to be continuous with the measured curve at the nearest end α_e of its
  range (NORTH_STAR 3.2/3.7):

  Φ(α) = Φ_meas(α_e) · I_law(α)/I_law(α_e),  I_law from §2 (Lambert: Φ_L(α)/Φ_L(α_e)).

The result is labelled `estimated`: the provenance tint shows it, and `stats.warnings` says "phase
extrapolated beyond measured range". Code: `photometry.ts extrapolatePhase`; test in
`render-frame.test.ts`. Ring brightness is never extrapolated beyond its model's phase range. Beyond 47°
it depends on forward-scattering dust that nothing measured, and below 0.25° the opposition surge keeps
rising.

## 8. GPU cost and timing

`stats.gpuPassMs` / `gpuFrameMs` come from timestamp queries when the adapter supports `timestamp-query`,
with one begin/end pair per pass: bodies+rings, star cull, points (retina), glare pyramid (retina), glare
pyramid (painted), adaptation, points (display), composite, overlays. The numbers in test screenshots
come from SwiftShader (CPU) and are not representative.

Expected cost on a desktop GPU (RTX 5090 class), by operation count:

- **Resolved bodies with maps:** one page-table walk plus 4 texel fetches per albedo sample. With a
  height map, 5 bilinear height samples for the normal and up to 40 for the horizon search (≤ 180 texel
  fetches per pixel). For a full-screen close-up at 4K that is ~1.5 G fetches: about 1–2 ms.
- **Hapke:** about 60 ALU ops per pixel, negligible.
- **Glare pyramids:** two passes over rgba32float levels, each ~7 full-resolution-equivalent image
  passes. At 4K that is ~1 ms each.
- **Rings:** per pixel, one footprint mean (≤ 6 loads per vec4), 2 lit nodes, or the unlit integral
  over the node segments between 1/μ0 and 1/μ (usually 1–5 segments), plus the W table lookup (grid
  scans, a few dozen loads). Saturn's profile is 7 885 bins × 18 vec4 = 2.3 MB. It is uploaded once, and
  again only when the data object changes.
- **Memory at 4K:** the HDR targets and pyramid are ~1.3 GB (rgba32float). The tile cache is whatever
  the budget says (default 1 GiB).
- **CPU per frame:**
  - The footprint ray casts are ≤ 3 000 rays per body at 4K.
  - The normalization integral (576–1024 law evaluations) is cached per geometry.
  - The unresolved-ring integral is 9 600 ray tests, only while the ring is under 2 px.

At 3840×2160, the test page (`render-test.html?scene=stars`) draws the star field as crisp points.
This needed the glare-fit fix in eye-model.md §3; before it, the unscattered fraction went negative and
every star was black.

## 9. Limitations

- **Surface maps:**
  - Per-texel photometric parameters (the Moon's `hapke` layer) are not used. Only a per-body constant
    model is used, and no body has one in the current products, so every body is Lambert-distributed,
    normalized to its measured disk photometry.
  - The normalization uses the zonal mean of level 0 (512 × 256), and ignores relief and the
    ellipsoid's departure from a sphere.
  - Pyramid levels above 10 are not addressed.
- **Geometry:** silhouettes are ellipsoids (no displacement), and terrain does not occlude terrain along
  the view ray.
- **Planetshine** uses the Lambert law, only two sources per body, and point-source illuminators
  without eclipses.
- **Rings:** see §6 (no wakes or spokes, no Saturn-shine or ringshine, and the unresolved-planet point
  omits ring shadows on the globe).
- **Data:** Saturn's occultation profile has τ ≈ 0.03–0.10 at 145 000–151 700 km, beyond the F ring,
  where the rings are essentially empty. It is probably a background artefact of that occultation. The
  renderer shows it as material of unknown reflectance (a hatched outer band) and it slightly dims
  what lies behind.
- **Eye:** close-ups of a bright body that fills much of a dark frame (the Moon at 0.8° field) adapt to
  the log-average of the retinal image, which the dark sky pulls down (53 cd/m² against ~3 000 cd/m² on
  the Moon). The lit surface then saturates to white with the terminator detail kept. A local
  (spatially varying) adaptation model would fix it (eye-model.md §10).
