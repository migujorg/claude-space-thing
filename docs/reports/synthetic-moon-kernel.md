# Synthetic irregular moons through the catalogue propagator

Code read at `d1b5e33`. The fixed moon trajectories disagreed with NORTH_STAR §3.5; the frame/unit/provenance/light-time contracts were consistent. The physical law follows that contract and the sourced system GMs, not a validation score.

## Model and representation

435 Jupiter and 23 Saturn draws use two system-barycentric instances of `SmallBodyField`. Each reuses the existing step shader, float64 CPU twin, 65-sample ephemeris table, epoch grid, checkpoint planner and partial display step. The central monopole is the host system GM. Perturbers are the Sun and every catalogue perturber except the host (including the Earth/Moon split and Pluto system already in that list). Every kick is differential, direct minus indirect. Solar 1PN, Earth J2 and non-gravitational terms are disabled in this translated frame. Internal satellites are included only through the system monopole; their resolved forces and host J2 remain omissions.

The product stores f64 ICRF epoch states **beside the original f32 elements**, in each population's sourced `integration.initialState.value` array indexed by `firstObject + k`. They are computed from the elements after f32 storage rounding, with the original system GM and obliquity, and serialized as round-trip f64 JSON numbers. The element binary stays unchanged for identities and inspection; this small 21,984-byte numeric payload for 458 states avoids adding six Cartesian columns to three million heliocentric records. Both CPU and GPU use this shared serialized initializer. Identity, ordering, seed, counts, H/attributes, cells and epoch are unchanged. The private rebuild's `objects.bin` SHA256 is `61d7c0a4ef1e6850688588d1308bfd689550b980b87e6ce8218b4dc375411fdc`; `cells.bin` is `215040deedf1a30cdda2b50dbe0fe2e004809628c65edc7f079846876f47e56e`; both equal the shared snapshot captured before this lane's change. Root subsequently rebuilt shared data, so the retained baseline hashes, not the newer shared realization, establish preservation.

The existing free-form `populations[].model.integration` dictionary records version `host-smallbody-v1`, window, translated force model, input product SHA256s and separate budgets. The stage directly depends on ephemeris products so those hashes participate in rebuild decisions. No schema extension or new raw input is needed. Both GPU and CPU consume that product law. Missing metadata, coverage or failed propagation gives unknown motion, never fixed-element fallback. Epoch initialization can still be inspected when the law is missing. Selection, travel and fallback picking use `syntheticState`; GPU picking consumes the same integrated trajectories' shaded records. The existing `syntheticRelativeState` function remains the **osculating ellipse guide** for orbit overlays, not a moon trajectory away from the epoch. Heliocentric synthetic draws still use fixed Kepler; that separate §3.5 defect is unchanged.

The two batches expose their integrated host-relative display states internally, retaining double-single components through camera/centre cancellation before the final f32 direction. The synthetic shade pass preserves original row IDs, H-G law, synthetic labels, Complete gating and first-order SSB-velocity light time. The system barycentre's geometric position and velocity are added, not the physical planet centre's.

## Numerical evidence and limitations

The pinned all-moon fixture copies the landed lane's independently generated **Sun plus external planets** DOP853 endpoint states. Its source realization's rows start at 2969638; the present build starts at 2969636 after a preceding population count change. `referenceRow` and current `row` are both recorded. Every one of the 458 initial states agrees within 1e-7 km / 1e-13 km/s; no reference endpoint was fitted or regenerated to make the implementation pass. Input hashes for the reference ephemerides are in the original landed `synthetic_moon_reference.json` and the new fixture's provenance.

Before the implementation, 916 production edge comparisons had maximum **29,407,853.36 km** fixed-element error. After it, the maximum is **0.042165798 km**. The predeclared CPU numerical regression threshold is **0.1 km**, inherited from the translated candidate's documented 0.042166-km maximum. This checks both edges, not a continuous interval or true astrometry of an undiscovered object.

GPU state/velocity/direction error is **unmeasured for moons**. `smallbodies-gpu-accuracy.json` measured a catalogue maximum GPU/CPU difference of 1.597638 km (and f32 direction rounding 1.277232e-7 rad). Rounding the state maximum upward gives a **provisional 2-km acceptance threshold** for the new device harness, plus the CPU 0.1 km for comparison to DOP853. This is a test threshold, **not a transferred moon certificate**: different central scales, differential-force cancellation and encounters need actual device measurements. The kernel has double-single states and f32 kicks/table acceleration/final directions; “float32 GPU” does not mean all state arithmetic is f32. Initial GPU states are separately checked at 1e-6 km. Direction/pixel error depends on camera distance; a 2-km state budget is insufficient for arbitrarily close views. Failed self-tests retain the existing degraded-device warning.

Inspector text separates numerical checks, historical force increments and unknown individual true-position/covariance/current-view total error. The preceding motion lane measured Sun+host trial increments, independently: Jupiter J2 168.915 km, resolved planet/Galileans 342.042 km; Saturn J2 144.471 km, resolved planet/Titan 762.623 km. These are sourced historical **individual sampled increments**, not their sum or an omitted-force bound on this Sun+external-planet model. Other satellite masses/higher zonals, radiation pressure and relativistic frame effects are unbounded. External catalogue perturbers are now included, so their previously reported omission increments are not charged as current omissions. No own-disk, arbitrary-close-view or interval certification is claimed.

## Cost and device checks

The private in-process CPU benchmark uses `process.cpuUsage`, 100 repetitions: all 458 stored epoch-state reads average **0.22269 ms**, building a new two-day table interval for each of the two hosts averages **0.46348 ms**. Reused intervals need no new ephemeris sampling; this does not assign zero cost to cache lookup/API encoding. These measurements exclude shader compilation, uploads, command encoding, GPU work and catalogue work. The earlier candidate's first full two-day step counts 1,299 RK4 substeps / 5,196 force evaluations. There are eight workgroups across the two hosts. Ordinary frames use one partial display step per host plus any crossed grid steps; jumps/restores and background building add work. `moonBatchInfo` records actual planner steps, restores, state/checkpoint and table bytes, and CPU **wall** time separately.

Root must rebuild `synthetic` after landing. New downloads: **none**. Run the compact real-device harness from `app` (the app's usual server must serve the source fixture):

```bash
node scripts/sb-gpu.mjs --query 'mode=moon-accuracy&timestamps=1&syncam=5&camera=earth' --json out/moons-earth.json
node scripts/sb-gpu.mjs --query 'mode=moon-accuracy&timestamps=1&syncam=5&camera=planet' --json out/moons-jupiter.json
node scripts/sb-gpu.mjs --query 'mode=moon-accuracy&timestamps=1&syncam=6&camera=near' --json out/moons-saturn-10R.json
node scripts/sb-gpu.mjs --query 'mode=moon-accuracy&timestamps=1&syncam=5&camera=close' --json out/moons-close.json
node scripts/sb-gpu.mjs --query 'mode=synthetic&syncam=5' --json out/synthetic-perturbed-jupiter.json
node scripts/sb-gpu.mjs --query 'mode=synthetic&syncam=6' --json out/synthetic-perturbed-saturn.json
npm run e2e
npm run validate
```

The compact harness checks all 458 at the exact window edges, epoch and interior samples, repeated far jumps/restores, initial-state preservation, selection equality, pick identity and below-Complete clearing. It reports host-relative geometric position/velocity independently of apparent direction. It measures submission-completion and encoding wall time, and requests hardware timestamp queries with `timestamps=1` (reports null when unavailable). Sixteen warm repeated display steps and sixteen Best-level baseline samples separate the incremental moon work from the single catalogue record. Hardware timestamp precision and noise must be reported; subtraction measures both gravity and synthetic shading/copy work. The timestamp sample spans the full compact field update. Root should additionally measure per-host steps and shade passes on the RTX device (timestamp queries around those compute passes), compare warm partial-only frames and crossed-grid/jump frames, and record API encoding process CPU time in the browser profiler. Do not call the lane's CPU process benchmark or SwiftShader elapsed time RTX kernel timing. No browser/WebGPU command above was run in this lane.

## Predicted scene changes

At the canonical 1280×720 views and scene dates, **no synthetic moons are in frame**: `smallbodies=0` is the suite default; the two enabled field views (Juno/Bennu) each have zero old and new moon points in the frustum; Lemmon sets `sbfield=0`. Consequently this change predicts no moon-marker/count change in the existing canonical scenes. Catalogue sky-star count and physical-body count do not change; rendered combined point count and glare/eye/culling remain GPU checks, not a CPU certificate.

Supplemental variants explicitly set `smallbodies=1&exists=complete`:

| Existing scene plus override | Old / new moon points in frustum | Median / maximum movement among points in both frames |
|---|---:|---:|
| jupiter-galileans | 96 / 96 | 0.106930 / 0.161157 px |
| saturn-rings | 2 / 2 | 0.017680 / 0.017680 px |

These are geometric/frustum point positions with the app's first-order light time, before photometric detectability, occlusion and overlay decluttering. They are predictions, not rendered-scene passes. Exact before/after pixel positions for all 458, cameras, epoch and all scenario params are in the lane's `scene-predictions.json`, reproduced by `scene-predict.ts`. At the early scene date the motion change is small; broad-window discrepancies were established separately by the independent reference. Counts of physical bodies, catalogue stars and allocated synthetic records remain unchanged; visible combined star/point counts are unknown until the GPU checks.
