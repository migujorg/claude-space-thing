# Shape models: irregular bodies as meshes

Moons such as Phobos and asteroids such as Bennu are not ellipsoids. When a body has a shape model whose shape and orientation labels are admitted at the reality level, the renderer draws that triangle mesh instead of the triaxial ellipsoid. The shape models are the `shapes` stage's products (architecture §6):

- `shapes/<id>.json` and `.bin`: spacecraft and radar meshes with levels of detail (`ShapeModelHeader`);
- `shapes/damit-index` and `shapes/damit.bin`: DAMIT's lightcurve-inversion models (`DamitIndexHeader`).

Code:

| File | Role |
|---|---|
| `app/src/app/shapes.ts` | Which mesh a body gets at a level, and the rotation that places it (`ShapeLibrary`). |
| `app/src/core/shapeRotation.ts` | Frame rotations: PCK constants, DAMIT and radar spin states. |
| `app/src/render/meshes/format.ts` | Decoding a level. |
| `app/src/render/meshes/area.ts` | Mean projected area. |
| `app/src/render/meshes/lod.ts` | Level choice. |
| `app/src/render/meshes/store.ts` | Range fetches and the GPU cache. |
| `app/src/render/meshes/meshBodies.ts` | Per-frame drawing. |
| `app/src/render/meshes/shaders.ts` | WGSL. |

Tests:

- `app/tests/render-mesh-orientation.test.ts`: frames against SPICE and DAMIT's own IAU conversion.
- `app/tests/render-mesh.test.ts`: decoding, mean projected area, levels of detail.
- `app/tests/app-shapes.test.ts`: the label filter, rotation sources and fallbacks.

## 1. Contract

`SceneBody.shape?: SceneShape` (`app/src/render/scene.ts`) holds:

- `key`: the cache key;
- `orient`: mesh frame → ICRF at the body's light-emission epoch;
- `scaleKm`: model units → km;
- `boundRadiusKm` and `areaKm2`;
- the levels (`url`, byte range, triangle and vertex counts, part layout or the DAMIT quantization);
- `worstLabel`.

The shell sets it in `snapshot.ts` `sceneBodyOf` through `ShapeLibrary.sceneShape`:

- major bodies are looked up by NAIF id;
- small bodies by their SBDB SPK-ID. A small body's close-up has a negative id, `sbId(row)`; the name index gives its SPK-ID.

The body keeps its radii, albedo and phase function: they still carry the photometry. The mesh only changes how that light is spread over the image.

The renderer fetches the levels itself. It keeps drawing the ellipsoid until the model's coarsest level and a drawable level are resident, so a view never waits on a mesh.

## 2. Orientation

A mesh is placed with the rotation of the frame it was built in. That frame is not always the app's frame for the body:

| Source | Used when | Label |
|---|---|---|
| `orientation.sourceRotation`: the shape frame's own PCK constants (mission kernels), with nutation/precession terms where the kernel has them | the header has it (Phobos and Deimos: pck00010; Eros: `eros_alex.tpc`; Vesta, Ceres, Bennu, Ryugu, Itokawa, Arrokoth, Didymos, Donaldjohanson; Lutetia: evaluated from the Rosetta frame kernels) | header's (measured) |
| the app's orientation of the body (bodies.json, pck00011) | the shape is in the body's IAU frame and the app has a rotation (Saturn's small moons, Amalthea, Thebe, Phoebe, Larissa, Proteus) | header's |
| `orientation.appRotation` (pck00011 constants) or `labelRotation` (PDS label) | small bodies the app has no rotation for (Tempel 1, Gaspra, Ida) | header's |
| radar spin state: pole (λ, β), period, phase at a zero epoch | principal-axis rotators among the radar models | **estimated**: pole and period are measured, but the data labels do not define the phase angle. The SHAPE software's Euler angles (λ + 90°, 90° − β, φ) are assumed |
| DAMIT spin state: r_ecl = Rz(λ)·Ry(90° − β)·Rz(φ0 + 2π(t − t0)/P + ½υ(t − t0)²) | small bodies without a spacecraft or radar model that can be placed | derived |

These matter. At 2026-10-01, the shape frame is this far from the app's pck00011 frame:

- Phobos: 2.5°;
- Eros: 6.2°, from the difference in spin rate;
- Lutetia: 164.5°. Its shape frame puts the crater Lauriacum on the prime meridian; pck00011's does not.

Without nutation terms, Phobos would be off by up to 2° more.

The tests check the conversions against:

- SPICE `pxform` with the mission kernels (Phobos, Deimos, Eros, Lutetia, Vesta, Bennu), to 1e-5°;
- DAMIT's own IAU-form conversion of the same models, where its rates agree;
- the published pole convention.

No mesh is drawn, and the inspector says why, when the orientation is unknown:

- Hyperion: chaotic rotation;
- 67P: no rotation model valid in 2026;
- tumbling radar models (Toutatis, Apophis): non-principal-axis rotation, not modelled;
- radar models without a spin state;
- Dimorphos: its frame is a two-vector dynamic frame.

## 3. Photometry and energy

The mesh is shaded with the same chain as the ellipsoid (architecture §4.3; `frame.ts`, `spatial.ts`). Per pixel:

  L = K · s · r(μ0, μ, g) · V_sun · T_ring · S_self + planetshine

- **K**: the body's radiance prefactor. It combines the albedo, the phase function, the spatial-law normalization and the resolved fraction.
- **r**: the body's spatial law, evaluated with the mesh's interpolated vertex normal. Lambert applies where no spatial law is measured.
- **V_sun and T_ring**: the eclipse and ring-shadow factors. They are the same as for the ellipsoid, with other bodies as spherical occluders.
- **S_self**: the self-shadow map (§5).
- **Planetshine**: Lambert, as for the ellipsoid.

**Energy normalization, s = πR² / ⟨A_proj⟩.**

- R is the photometric reference radius: the mean of the admitted radii, or the measured diameter / 2 for small bodies.
- ⟨A_proj⟩ is the mesh's rotation-mean projected area. It is rasterized from 48 directions of the coarsest level (`area.ts`, about 1 %).

The disk photometry says how bright a body is on average: a geometric albedo p with reference area πR², and a phase function Φ(α). Mean brightness (H magnitudes and lightcurve means) is what those measurements describe. A mesh of the same volume has a larger mean projected area: area/4 for a convex body (Cauchy). With s, the mesh's rotation-averaged disk-integrated brightness at small phase equals the photometry. The rotational lightcurve then comes from the shape.

The drawn brightness distribution is labelled **derived**, because it is computed from the measured photometry and the shape. It is part of the body's worst label.

Caveats:

- A measured phase function already contains the average effect of the body's large-scale shadows. The mesh adds its own resolved shadows on top. At the resolutions drawn, this counts large-scale shading twice by a small amount.
- Meshes carry no surface maps. The albedo is uniform over the mesh, from the disk photometry.

## 4. Levels of detail and memory

- **Level choice.** The renderer takes the coarsest level whose typical triangle edge, seen from the nearest point of the body, is at most 1.5 px (`lod.ts`). While that level loads, it draws the nearest resident level, finer first.
- **Fetching.** Each level is one HTTP range request (206) into the model's `.bin`; a 200 answer is sliced. The coarsest level is fetched first, because it carries the energy normalization.
- **GPU cache.** Levels live in GPU buffers under a 512 MiB budget (`Renderer.meshCacheMiB`), least recently used first out. A level drawn this frame is never evicted, and neither is a model's coarsest level.
- **Settling.** `Renderer.settled()` waits for mesh levels, up to 300 s. `bootstrap.ts` waits for shape headers before `__frameReady`.

## 5. Depth, precision and shadows

- **Transforms.** Vertices stay in their own frame, in km or model units. The model → camera matrix is the camera-relative body position composed with orient × scale, in float64 on the CPU. The shader receives only camera-relative float32 rows.
- **Depth.** Depth is the same reversed-Z infinite projection as the ellipsoids' `depthOf` (near / −z). Meshes and ellipsoids occlude each other correctly.
- **Self-shadowing.** The two largest lit meshes on screen get a 2048² depth map, if at least 48 px across. It is drawn from the Sun direction orthographically over the bounding sphere, from a level of at most 500 k triangles. It is sampled with a 3×3 percentage-closer filter, with constant and slope bias.
- **Eclipses.** Eclipses of and by meshes use the bodies' radii as spheres, as on the ellipsoid path. An example is Phobos in Mars's shadow at 2026-10-15T04:40Z, which renders dark.

## 6. Reality filter

The shape label (`provenance.label`) and the orientation label must both be admitted:

- **Strict** (measured + derived) draws the spacecraft meshes (Phobos, Bennu, Arrokoth …) and DAMIT models. A small body's surface is hatched there (§8).
- **Best** adds Stooke's hand-fitted limb models (Amalthea, Thebe, Proteus, Larissa: estimated) and radar models placed by their spin state (orientation estimated).

The renderer never sees what is not admitted.

## 7. Renderer hooks (the only changes outside `meshes/`)

- **`renderer.ts`:**
  - field `meshes` and `meshCacheMiB`;
  - `meshes.prepare(prep, g)` after `prepareFrame`, which returns the resolved-body indices drawn as meshes;
  - `encodeShadows(enc)` before the bodies pass;
  - in the bodies pass, the ellipsoid loop skips those indices and `meshes.draw(pass, …)` follows it;
  - overlays: mesh bodies are left out of the ellipsoid hatch/tint overlay; their hatch comes through MASK, and their tint from `meshes.encodeTint(…)` after the overlay pass;
  - `settled()` waits for mesh levels;
  - `stats.meshes` and warnings.
- **`frame.ts`:** `behind` / in-view culling uses `max(radii, shape.boundRadiusKm)` (`extentOf`).
- **`shaders.ts`:** `BODY_STRUCT` and `BODY_LIGHT_WGSL` (sunVisible, ringShadowT, ringViewT) are exported for the mesh shader. This moves code without changing it.

## 8. Limitations

- Mesh edges are aliased: no MSAA or analytic coverage, unlike the ellipsoid's analytic edge.
- A small body's photometry still comes from its pseudo-body: a measured diameter and a Lambert-sphere phase function, which is estimated. With an admitted shape model, the pseudo-body's radii keep the diameter's own label, because the shape is no longer assumed. At Strict the mesh is therefore drawn, but its surface is hatched as not measured, because the phase function is not admitted there. At Best it is lit.
- Occluders for eclipses are spheres.
- Dimorphos's dynamic frame (+x towards Didymos) and tumblers are not evaluated.
