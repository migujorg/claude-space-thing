# Scene regression suite

`npm run e2e` renders the canonical views in [`scenes.json`](scenes.json) with the real app and the real data, then compares them with the committed baseline in [`baseline/`](baseline/).

The suite uses one Vite server and one headless Chromium with SwiftShader WebGPU, and renders at most two scenes at a time. SwiftShader is slow: a scene takes about 1–3 minutes, and the whole suite about 15 minutes.

The suite needs the built data in `app/public/data`. It cannot run in CI, which has no data and no WebGPU; CI runs the unit tests, including `tests/e2e-lib.test.ts` for the comparison logic.

## What it writes

All output goes to `app/shots/e2e/`, which git ignores.

| File | Contents |
|---|---|
| `<id>.png` | Screenshot of the page, with the UI. For people. |
| `<id>.thumb.png` | 64×36 thumbnail of the rendered image only, without UI overlays. Box-averaged in linear light. |
| `report.json` | For each scene: renderer stats, a trimmed `debugState()`, the 16×9 lightness grid, console errors and warnings, and the comparison. |
| `stats.txt` | The stats table that is also printed to the console. |

## What is compared

Each scene is compared with `baseline/stats.json` and `baseline/<id>.png`. The default tolerances are in `DEFAULT_TOLERANCE` in `scripts/e2e-lib.mjs`. A scene can override any of them with a `tolerance` object in `scenes.json`.

**Stats**

- Adaptation luminance, photopic and scotopic: |Δlog10| ≤ 0.15.
- Pupil diameter: ≤ 0.3 mm.
- Limiting magnitude: ≤ 0.3 mag.
- Mesopic coefficient: ≤ 0.1.
- Stars drawn: ≤ 5 %.

**Scene content** (must match exactly)

- Which bodies are in the frame (`debugState().drawn.inView`):
  - bodies at least a pixel across, by name, with their worst provenance label and whether their surface is unknown (hatched);
  - points and overlay markers, by id and label (`601:estimated`, `…:marker`). There are often hundreds of them, for example moons far behind a planet.
- Whether the Sun is drawn.
- The set of renderer warnings. A new warning fails the scene, and so does a warning that went away: accept the baseline if the change is intended.

**Console**

- The scene fails if it has more console errors than in the baseline.

**Coarse image**

- The thumbnail is reduced to a 16×9 grid of display lightness (sRGB-encoded luminance, 0–1).
- The scene fails if the mean |ΔL| over the grid exceeds 0.06, or if any single cell's |ΔL| exceeds 0.35.
- It also fails if the frame went black or white compared with the baseline.

This check catches blank frames and gross regressions such as a missing body, a lost texture or a wrong exposure. It is not a pixel diff.

A scene that fails to render always fails. Examples: a `__frameError`, or a timeout waiting for `__frameReady`. SwiftShader shares the CPU and memory, so on a busy machine a scene can time out, or its GPU process can be killed. A lost GPU device sets `__frameError` at once, with the reason (`WebGPU device lost (unknown): …`), so the run does not wait for the timeout. Either way the scene is rendered once more, on its own, before it counts as failed (`--retries 0` turns that off).

A scene also fails, without a retry, when the page reports a data product that the manifest lists as missing or unusable, for example when a worktree's `public/data` lacks the `shapes`, `comets` or `synthetic` link. Such a scene would silently draw ellipsoids in place of shape models and no comets, and it could not be accepted as a baseline.

## Determinism

A scene renders the same numbers on every run of an unchanged tree. Two runs of the Moments scenes, earth-night
and saturn-rings agree on every stat, stars included. Three things make this so:

- **Instant adaptation.** `defaults` sets `adapt=instant`, so the eye is always adapted to the view. With the
  real-time default, the frames rendered around the settled one would move the pigments by real elapsed time,
  so star counts near threshold depended on timing. Scenes that test the eye's time dependence set
  `adapt=realtime` with an `adaptfrom` history, which defines their past.
- **A settled point cut.** The sky (app/sky.ts) cuts points from background light at the eye's limit, with
  hysteresis while the view changes. Before `__frameReady` the cut is set afresh at the settled limit
  (`SkyController.settleCut`), so it does not depend on the limits the loading frames passed through.
- **Paused time.** A URL with `t` starts paused.

## Running

```sh
cd app
npm run e2e                                   # all scenes, compared with the baseline; exit 1 on a regression
npm run e2e -- --only earth-day,saturn-rings  # some scenes
npm run e2e -- --no-compare                   # render and report only
npm run e2e -- --jobs 1 --timeout 900         # one scene at a time, 15 min per scene (default 2 and 600 s)
npm run e2e -- --base http://localhost:5173   # use a running dev server
```

## Accepting a new baseline

Accept a new baseline when a change is intended. Examples: a renderer improvement, a new data build, or a new or edited scene.

1. Run the suite and read the failures. Look at the screenshots and thumbnails in `app/shots/e2e/` to confirm that the new images are right.
2. Accept, either everything or just some scenes:
   ```sh
   npm run e2e -- --accept
   npm run e2e -- --accept --only saturn-rings
   ```
   This renders again and writes `baseline/stats.json` and `baseline/<id>.png` from that run. With `--only`, the other scenes keep their baseline. Scenes removed from `scenes.json` are dropped.

   To accept the run you just reviewed without rendering it again, use `npm run e2e -- --accept-last`. It takes `--only` too, and reads `app/shots/e2e/report.json` and the thumbnails.

   Nothing is accepted if any scene fails to render.
3. Review `git diff app/e2e/baseline`. The stats diff says what changed, for example a pupil diameter or a set of warnings. Commit the baseline together with the change that caused it, and say why in the commit message.

The baseline records the data build it was made with: the manifest's `generatedAt` and sha256. When you compare against a different data build, the report says so, because differences may then come from the data rather than the code.

## Adding a scene

1. Add an entry to `scenes.json` with an `id`, a `title` and `params`. The params are any URL parameters of the app, see `src/app/url.ts`. The `defaults` block pins the time and switches off small bodies.
2. Small bodies are switched off (`smallbodies=0`) in every scene except those about small bodies, so that loading the 1.6 M-object catalogue does not slow every scene down.
3. Run `npm run e2e -- --accept --only <id>` and commit the new baseline files.

# Validation against calibrated images

`npm run validate` compares the renderer with real, calibrated spacecraft and satellite images. It uses the eleven ground-truth cases in [`validation/`](../../validation), from Cassini, Voyager 2, New Horizons, EPOXI and Himawari-9. How they were made, and what their tolerances mean, is in [docs/reports/validation.md](../../docs/reports/validation.md). Like the scene suite, it needs the built data in `app/public/data` and SwiftShader WebGPU. It is not part of CI.

For each case, the runner (`scripts/validate.mjs`, page `validation.html`, code in `src/validation/`) does three things.

1. **Builds the case's exact view** as a `SceneSnapshot`. The camera orientation, field of view and size, and the bodies' positions, Sun directions and orientations at the observation epoch all come from `case.json`. Nothing is taken from the app's ephemeris, so every case runs, even though most epochs lie outside the app's time window (2025-03 to 2028-03).
   - What is drawn on the bodies is the app's own data at the chosen reality level (`app/snapshot.ts` `sceneBodyOf`): albedo, phase function, disk models, surface maps, rings and atmospheres.
   - Time-dependent content is the app's, not the observation's. Earth's clouds are those of the app's cloud day, and seasonal or volcanic changes are not modelled.
2. **Renders the view** offscreen and lets the renderer settle: tiles loaded, adaptation converged. It then reads the HDR buffer, **before the eye model**, over every region of interest with `Renderer.readHdrRegion(rect)` → `{ mean: [X, Y, Z, S], std, n }`. This is `render/hdrReadback.ts`, reached through a marked hook in `renderer.ts`.
   - The buffer holds the extended light: bodies, rings, atmospheres and the solar disk. Point sources are not in it.
   - The runner loads no stars and no sky background.
3. **Compares each mean** with the case's expected radiance:
   - regions of interest: `|rendered − expected| ≤ tolerance` on each of X, Y, Z and S, where the tolerance is 2σ of the observation's budget;
   - sky regions: `rendered ≤ upper limit`;
   - ratios such as Moon/Earth.

   A failure is a finding about the app's data or the renderer. It is reported with its numbers and never hidden.

| File in `app/shots/validation/` | Contents |
|---|---|
| `report.md` | One table row per case and region of interest: expected Y ± tolerance, rendered Y, rendered/expected, deviation in σ, and the verdict, naming the failing channels. Then the ratios. Then, per case, how each body was drawn (the data used and its worst label), the notes and the renderer warnings. |
| `report.json` | The same, with all four channels, the pixel statistics and the renderer stats. |
| `<id>.hdr.png` | Rendered Y on a square-root scale. Compare it with `validation/cases/<id>/preview.png`. |
| `<id>.display.png` | The eye-model image, as the app would show it. |

```sh
cd app
npm run validate                                   # all cases (about 4 minutes; Himawari is the slowest)
npm run validate -- --only io-nh-lorri-2007        # some cases
npm run validate -- --ss 2                         # 2 × 2 samples per pixel (the references are pixel-area averages)
npm run validate -- --reality strict               # measured and derived data only
npm run validate -- --hdr f16                      # the rgba16float fallback targets
npm run validate -- --strict                       # exit 1 when a region fails (default: only when a case does not render)
```

From a script, the page exposes `window.__validation.run(case, { ss, reality })`. For experiments with a changed scene, it also exposes `window.__validation.debug`, which is `{ renderer, data }`.
