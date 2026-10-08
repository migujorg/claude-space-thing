# Scene regression suite

`npm run e2e` renders the canonical views in [`scenes.json`](scenes.json) with the real app and the real data, then compares them with the committed baseline in [`baseline/`](baseline/).

The reference renderer is the workstation's GPU: the project is built for that machine (NORTH_STAR §2), and the committed baseline was accepted there. On the workstation run `npm run e2e -- --gpu hardware`: the suite now has 36 scenes. Historical timings are below. See [On the GPU](#on-the-gpu---gpu-hardware).

Without `--gpu` the suite renders with SwiftShader WebGPU, the fallback for a machine without a GPU. It uses one Vite server and one headless Chromium and renders at most two scenes at a time. SwiftShader is slow: on a 4-vCPU cloud workspace a scene takes about 1–3 minutes and the whole suite about 15 minutes; on the 32-thread workstation a scene takes 7–86 s and the suite 6 minutes. A SwiftShader run is compared with the same GPU baseline and says so in a note; historical adapter differences are measured below. Those measurements do not certify later code or data.

The suite needs the built data in `app/public/data`. It cannot run in CI, which has no data and no WebGPU; CI runs the unit tests, including `tests/e2e-lib.test.ts` for the comparison logic.


## What it writes

All output goes to `app/shots/e2e/`, which git ignores.

| File | Contents |
|---|---|
| `<id>.png` | Screenshot of the page, with the UI. For people. |
| `<id>.thumb.png` | 64×36 thumbnail of the rendered image only, without UI overlays. Box-averaged in linear light. |
| `report.json` | For each scene: renderer stats, a trimmed `debugState()`, the 16×9 lightness grid, console errors and warnings, the WebGPU adapter and HDR target format it rendered with, and the comparison, `readyMs` from navigation to observed `__frameReady`, the distinct `starsDrawnFrames` over 16 sampled animation frames and `starsDrawnVaried` (whether more than one count was seen), and `timings` (sample counts, median and maximum in ms of CPU preparation, CPU frame submission work, GPU pass time when available, and CPU-start-to-GPU-completion `frameMs`). For the run: `gpu`, the mode asked for and the adapter, and `timingPolicy`. |
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

## Frame cost

Every rendered scene, on either adapter, is sampled over 60 animation frames after `__frameReady`, before the screenshot. The console and `stats.txt` show `ready ms` and the median/maximum of `cpuPrepMs`, `cpuFrameMs` and `gpuFrameMs` (shown as `none` without timestamp queries); `report.json` also records `frameMs`. CPU preparation covers photometry, rings, tiles and meshes; CPU frame time covers render work through command encoding before submission. `frameMs` includes GPU completion, while GPU timestamps sum GPU passes and arrive asynchronously. With backpressure, multiple animation frames can observe the same last render; these are 60 rAF observations, not 60 distinct submissions. Sampling also keeps a 16-frame star census on both adapters. SwiftShader therefore needs 60 more animation frames per scene than before.

`TIMING_POLICY` in `scripts/e2e-lib.mjs` states the budgets and their evidence. Median CPU preparation above **50 ms** fails the scene, including with `--no-compare`, and cannot be accepted with `--accept` or `--accept-last`. Missing/incomplete CPU measurements also fail. Normal preparation is 1–3 ms; at load average 9 on 7 October, fixed scenes measured 0.8–1.6 ms and regressed Pluto/Charon 758–1007 ms. The ceiling is over an order of magnitude from both; medians tolerate isolated scheduler/GC pauses, and maximum CPU/GPU times are recorded without gates. Readiness has **no hard performance ceiling**: fixed scenes took 5324–7932 ms under that load, regressions 17951/18047 ms, but earlier healthy GPU runs reached 17 s. Hardware readiness above **12000 ms**, or readiness above **twice a same-mode baseline**, prints a `WARNING` naming the scene, current time and baseline time/ratio when available. Warnings stay in each scene's `performance` report and do not change the exit code. Frame timing distributions are excluded from baseline acceptance; the existing baseline `readyMs` is retained only for these advisory comparisons, never compared exactly. A legacy `--accept-last` report without the 60-frame CPU measurements must be rerendered.

## Held eye clock

`adapttime=<nonnegative seconds>` requires an `adaptfrom=<cd/m²>,<exposure seconds>,<elapsed seconds>` history
and real-time adaptation (`adapt=realtime`, or the interactive default). It overrides the history's elapsed value.
For example, `adapt=realtime&adaptfrom=10000,600,60&adapttime=60` means ten minutes of daylight followed by
exactly sixty seconds in the current view. Zero is valid. Invalid values, missing histories, and instant adaptation
are reported and ignored. The app badges this fixed instant; omitting the parameter preserves the interactive clock.

As light measurements arrive, the CPU eye evaluates that same history from regenerated pigments under the current
measured light and pupil. No loading, settling, sample or screenshot frame adds elapsed seconds. “Settled” means
the data, tiles, sky point cut and light measurement have converged at that instant, not that the observer has waited
longer or become fully dark-adapted. The frame read is at the stated instant, including through offscreen presentation.

More than one `starsDrawn` value over the sampled frames fails a held-clock scene on either adapter, including
`--no-compare`, `--accept`, and `--accept-last`. A held-clock report without star samples cannot be accepted.
The suite retains the same count-stability gate for instant adaptation; unheld real-time scenes may gain stars.
`stats.txt` prints `stars varied` as yes/no (none if sampling was unavailable).

## Determinism

A scene renders the same numbers on every run of an unchanged tree. Two runs of the Moments scenes, earth-night
and saturn-rings agree on every stat, stars included. Four things make this so:

- **Instant adaptation.** `defaults` sets `adapt=instant`, so the eye is always adapted to the view. With the
  real-time default, the frames rendered around the settled one would move the pigments by real elapsed time,
  so star counts near threshold depended on timing. Scenes that test the eye's time dependence set
  `adapt=realtime` with an `adaptfrom` history and `adapttime=<elapsed seconds>`, which holds the eye at
  exactly 60, 120, 720 or 1800 seconds after that exposure.
- **A settled point cut.** The sky (app/sky.ts) cuts points from background light at the eye's limit, with
  hysteresis while the view changes. Before `__frameReady` the cut is set afresh at the settled limit
  (`SkyController.settleCut`), so it does not depend on the limits the loading frames passed through.
- **Paused time.** A URL with `t` starts paused.
- **A point image that holds every source.** A star is judged against the veil of the frame before, less its own
  light. That veil is made from the physical point image, which holds every point source in the frame, whether
  the eye can pick it out or not (`render/shaders.ts` `CULL_SHADER`: the visible and the unseen list). So the
  veil, and with it every verdict, follows from the scene alone. Until 7 October 2026 only the stars that had
  passed were in that image: a star at threshold was judged against a veil that held its light on some frames and
  not on others, and was drawn every other frame (388 stars in pluto-charon; 9 of the suite's 26 scenes then), and which frame
  a script read depended on how the page had loaded.

The settled frame of a scene with `adapt=instant` is therefore one frame. Checked on the GPU by reading back which
stars the cull kept on 300 consecutive frames of each of the then 33 scenes: none changed in the 29 scenes
with instant adaptation, and after a pass is skipped for one to three frames (no star light in the veil, no stars drawn, an
older veil) the same set comes back. Before the held clock, the four `adapt=realtime` scenes stayed as they were or gained stars as their
pigments regenerated; their counts included machine-dependent loading time. The committed GPU baseline now includes the held-clock scenes; its acceptance record is below.

The check is a script, to be run after any change to the cull, the point path or the veil:

```sh
cd app
node scripts/point-census.mjs --gpu hardware --perturb   # every scene: 300 frames, then seven perturbations
node scripts/point-census.mjs --frames 40 --only pluto-charon   # SwiftShader, where a frame takes seconds
node scripts/point-census.mjs --gpu hardware --lone --only starfield,pluto-charon   # a source alone: none of its own light in its background
```

It compares the lists by identity, not by count. A scene with instant adaptation fails if any star's verdict
differs between two consecutive frames, or if the settled set after a perturbation is not the first one. A
real-time scene fails only if a star goes back and forth. Exit 1 on a failure.

The own-light term is the discrete splat/pyramid response at the stored source centre: N Σ w_k ρ_k(x)ρ_k(y) divided by that pixel's solid angle (`eye/points.ts` `ownVeilExact`, mirrored in WGSL). It accounts for clipped splat samples, downsampling, blur taps and upsampling; a continuous Gaussian kernel at zero is not this term.

`--lone` checks the own-light term (docs/eye-model.md §6): the scene's stars are replaced by one source at a
time, and what is left of its light in the background it is judged against must be under 10⁻⁶ of it (10⁻³ where
the HDR targets are half float).

### The veil at the edges

`node scripts/veil-edges.mjs --gpu hardware` checks that the veil pyramid holds, inside the frame, what it holds on
an unbounded dark canvas (docs/eye-model.md §3 "The frame's edge"). It runs the renderer's own pyramid passes on the
frame's input at the frame's size and again on a canvas with a dark margin as wide as the coarsest weighted texel,
for a uniform frame at 1280 × 720 and 1283 × 723 and for three scenes of the suite (`--scenes a,b` for others). The
two must agree within 10⁻⁶ of the peak veil in every pixel; on the GPU they agree to the bit. Run it after any
change to the pyramid, its textures or their readers. Exit 1 on a failure.

## Running

```sh
cd app
npm run e2e                                   # all scenes, compared with the baseline; exit 1 on a regression
npm run e2e -- --only earth-day,saturn-rings  # some scenes
npm run e2e -- --no-compare                   # render and report only
npm run e2e -- --jobs 1 --timeout 900         # one scene at a time, 15 min per scene (default 2 and 600 s)
npm run e2e -- --base http://127.0.0.1:5173   # use a running dev server
npm run e2e -- --gpu hardware                 # on the machine's GPU instead of SwiftShader (see below)
```

## The scripts' own server

Without `--base`, `e2e.mjs`, `validate.mjs`, `shot.mjs`, `sb-gpu.mjs`, `sky-shots.mjs` and `corona-shots.mjs` start their own Vite server through `scripts/local-server.mjs`: on `127.0.0.1`, at a free port the operating system assigns, and Vite must take exactly that port. They never use 5173. (Asking Vite for port 0 does not give a free port: Vite then takes its default, 5173, on `localhost`, which is `[::1]` where IPv6 comes first. A script run would sit on `[::1]:5173` beside a dev server on `127.0.0.1:5173`, and a browser that opens `http://localhost:5173` would be served the script's tree.)

`e2e.mjs`, `validate.mjs` and `shot.mjs` start it without the file watcher and without hot reloading (`runServerOptions` in `scripts/e2e-lib.mjs`), so a source edit or a data rebuild under way does not reload the page of the scene being measured. A module or a data file is still read when a scene first asks for it, so a run made while either changes is not a run of one state.

## On the GPU (`--gpu hardware`)

`e2e.mjs`, `validate.mjs` and `shot.mjs` take `--gpu swiftshader|hardware`. The default is `swiftshader`, with the browser arguments the scripts always used. `hardware` launches the same headless Chromium on the system's Vulkan drivers (`gpuLaunchArgs` in `scripts/e2e-lib.mjs`):

```
--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --disable-vulkan-surface --ignore-gpu-blocklist
```

- `--use-angle=vulkan` and `--enable-features=Vulkan` are both needed. With either one alone the adapter is still SwiftShader.
- No display, X11 or environment variable is needed. The app asks for the `high-performance` adapter and gets the discrete GPU.
- Chromium falls back to SwiftShader without a word when Vulkan does not initialize. A `hardware` run therefore checks the adapter the page got and fails if it is a software one: every scene in `e2e`, the whole run in `validate`, exit 1 in `shot`. `DEBUG=pw:browser` shows the browser's own log.
- To pin a driver, set `VK_DRIVER_FILES` to its ICD file. This works only because of `--disable-vulkan-surface`: without it, `VK_DRIVER_FILES=/usr/share/vulkan/icd.d/nvidia_icd.x86_64.json` makes `vkCreateInstance` fail (`-7`, extension not present) and the run falls back to SwiftShader.

Measured on the workstation (RTX 5090, NVIDIA driver 615.71, Playwright's Chromium 141 headless shell, data built 2026-10-05, `rc` at 08c1941 and again at a1204ae):

| | SwiftShader | GPU |
|---|---|---|
| Adapter (`vendor architecture`) | `google swiftshader` | `nvidia blackwell` |
| `float32-blendable`, so HDR targets | yes, `rgba32float` | yes, `rgba32float` |
| `npm run e2e`, 26 scenes, wall time | 5 min 2 s to 5 min 49 s (three runs) | 63–91 s (seven runs) |
| Time to `__frameReady` per scene | 7–86 s, median 16–20 s | 3–17 s, median 4–5 s |
| The frame in the stats (`renderer.stats.frameMs`), median over the scenes | 1.6–1.9 s | 9–16 ms |
| `npm run validate`, 11 cases, wall time | 66–77 s (three runs) | 58–59 s (three runs) |
| Render and settle per validation case, without Himawari and Pluto | 0.09–1.7 s | 25–440 ms |
| Pluto case | 2.3–4.3 s | 1.4–2.0 s |
| Himawari case (nearly the same on both: its time is not GPU time) | 55–60 s | 52 s |

How the numbers differ between the two adapters, same tree and data:

- **Validation (HDR readback):** the same 39 pass, 25 fail, 5 not compared, with the same failing channels. Of the 276 channel means (69 regions × X, Y, Z, S), 92 are identical and 184 differ, by 3 × 10⁻⁶ to 6 × 10⁻³ relative (median 5 × 10⁻⁴; the largest are a sky-near and a terminator region), against tolerances of 5 % and more. Two runs on the same adapter are bit-identical, on either adapter.
- **Scene stats:** over seven GPU runs against a SwiftShader run, adaptation luminance within 0.005 dex (1.1 %), pupil within 0.001 mm, limiting magnitude within 0.007 mag, the same bodies, points, labels and warnings, and the coarse image within 0.003 lightness. Every scene passes against the SwiftShader baseline on all of these.
- **Stars drawn is one number.** A `hardware` run records the values `starsDrawn` takes over 16 animation frames in `starsDrawnFrames`. In a scene with `adapt=instant` they must all be the same: if not, the scene fails ("starsDrawn changes from frame to frame"), and it is not accepted as a baseline. In an unheld scene with `adapt=realtime` a changing count is a note; a held `adapttime` scene has the same stability gate as instant adaptation, on either adapter. Until the cull fix of 7 October 2026 ([Determinism](#determinism)) the count alternated between two values on consecutive frames in 9 of the 26 scenes (pluto-charon 889 ↔ 1120, 908 ↔ 1101, 965 ↔ 1043 or 994 ↔ 1014 depending on the run; jupiter-galileans 179 ↔ 186; the others by 2 % or less), and in seven GPU runs pluto-charon failed the 5 % star tolerance three times. SwiftShader had the same alternation (pluto-charon 996 ↔ 1014), but its frames take about a second, so a script read the same frame on almost every run. Since the shared test of 7 October 2026 `starsDrawn` is the number of stars displayed: the cull applies the display's test (`pointBackground` in `render/shaders.ts`) and the point shader does not judge a star again. Before, it counted the stars that passed a looser test, about twice those shown under a dark sky (3400 against 1668 in `starfield`), while the picture was the same. A star behind a body is not counted either: occlusion is decided per source in the cull.
- **The sky cube** is 512² on a hardware adapter and 256² on a software one, so the sky background is not the same computation on the two. `SkyController` decides it from the adapter's name (`src/app/sky.ts`: `swiftshader`, `llvmpipe` or `software` in the vendor, architecture or description gives 256²). Measured on 7 October 2026 by forcing 256² on the GPU, same tree and data: the adaptation luminance falls by 1.1 % in starfield-dark-2min, 1.0 % in starfield-dark-12min, 0.2 % in starfield, starfield-dark-30min and hyperion-fallback, and by under 0.03 % elsewhere; the limiting magnitude moves by at most 0.002 mag, the star count by at most 3, a cell of the coarse image by at most 0.003. That is the whole difference between a SwiftShader run and a GPU run in the dark-sky scenes (1.1 %, 0.9 %, 0.2 %). The tolerances (0.15 dex, 0.3 mag, 5 %, 0.35) are ten to a hundred times wider, so no scene can tell the two cubes apart: the suite does not test the cube's size.

The committed baseline records acceptance on the workstation's GPU (`nvidia blackwell`, `--gpu hardware`) at 2026-10-08T01:37:20Z (7 October PDT), git `a9277cd`, with the data build of 2026-10-08T01:23:42Z: all 36 scenes in one run, after `starsDrawn` came to mean the stars displayed (see "Stars drawn is one number" above; the star counts of the earlier baseline are not comparable with these). A baseline records the mode and the adapter it was accepted with, and comparing a run with a baseline of the other kind prints a note. A scene accepted on its own later records its own acceptance (below), and the note then names the scenes it is about.

## Accepting a new baseline

Accept a new baseline when a change is intended. Examples: a renderer improvement, a new data build, or a new or edited scene.

1. Run the suite and read the failures. Look at the screenshots and thumbnails in `app/shots/e2e/` to confirm that the new images are right.
2. Accept, either everything or just some scenes:
   ```sh
   npm run e2e -- --accept
   npm run e2e -- --accept --only saturn-rings
   ```
   This renders again and writes `baseline/stats.json` and `baseline/<id>.png` from that run. With `--only`, the other scenes keep their baseline. Scenes removed from `scenes.json` are dropped.

   The header of `stats.json` (`acceptedAt`, `git`, `data`, `gpu`) says what the whole suite was last accepted with, and changes only when every scene is accepted. A scene accepted with `--only` carries its own `accepted` record (date, commit, data build, adapter).

   To accept the run you just reviewed without rendering it again, use `npm run e2e -- --accept-last`. It takes `--only` too, and reads `app/shots/e2e/report.json` and the thumbnails.

   Nothing is accepted if any scene fails to render.
3. Review `git diff app/e2e/baseline`. The stats diff says what changed, for example a pupil diameter or a set of warnings. Commit the baseline together with the change that caused it, and say why in the commit message.

The baseline records the data build it was made with: the manifest's `generatedAt` and sha256. When you compare against a different data build, the report says so, because differences may then come from the data rather than the code.

## Adding a scene

1. Add an entry to `scenes.json` with an `id`, a `title` and `params`. The params are any URL parameters of the app, see `src/app/url.ts`. The `defaults` block pins the time and switches off small bodies.
2. Small bodies are switched off (`smallbodies=0`) in every scene except those about small bodies, so that loading the 1.6 M-object catalogue does not slow every scene down.
3. Run `npm run e2e -- --accept --only <id>` and commit the new baseline files.

# Validation against calibrated images

`npm run validate` compares the renderer with real, calibrated spacecraft and satellite images. It uses the eleven ground-truth cases in [`validation/`](../../validation), from Cassini, Voyager 2, New Horizons, EPOXI and Himawari-9. How they were made, and what their tolerances mean, is in [docs/reports/validation.md](../../docs/reports/validation.md). Like the scene suite, it needs the built data in `app/public/data` and WebGPU: SwiftShader by default, the machine's GPU with `--gpu hardware` ([On the GPU](#on-the-gpu---gpu-hardware)). It is not part of CI.

For each case, the runner (`scripts/validate.mjs`, page `validation.html`, code in `src/validation/`) does three things.

1. **Builds the case's exact view** as a `SceneSnapshot`. The camera orientation, field of view and size, and the bodies' positions, Sun directions and orientations at the observation epoch all come from `case.json`. Nothing is taken from the app's ephemeris, so every case runs, even though most epochs lie outside the app's time window (2025-04-04 to 2028-04-04).
   - What is drawn on the bodies is the app's own data at the chosen reality level (`app/snapshot.ts` `sceneBodyOf`): albedo, phase function, disk models, surface maps, rings and atmospheres.
   - Time-dependent content is the app's, not the observation's. Earth's clouds are those of the app's cloud day, and seasonal or volcanic changes are not modelled.
2. **Renders the view** offscreen and lets the renderer settle: tiles loaded, adaptation converged. It then reads the HDR buffer, **before the eye model**, over every region of interest with `Renderer.readHdrRegion(rect)` → `{ mean: [X, Y, Z, S], std, n }`. This is `render/hdrReadback.ts`, reached through a marked hook in `renderer.ts`.
   - The buffer holds the extended light: bodies, rings, atmospheres and the solar disk. Point sources are not in it.
   - The runner loads no stars and no sky background.
3. **Compares each mean** with the case's expected radiance:
   - regions of interest: `|rendered − expected| ≤ tolerance` on each of X, Y, Z and S, where the tolerance is 2σ of the observation's budget;
   - sky regions: `rendered ≤ upper limit`;
   - ratios such as Moon/Earth, plus same-frame limb, terminator and other body/ring regions divided by disk or illuminated-ring means. Their budgets cancel shared calibration, retain differential spectral/noise/registration terms, and state the assumed independence where covariance is unmeasured.

   A failure is a finding about the app's data or the renderer. It is reported with its numbers and never hidden. Scene-dependent rows identify cloud epochs or unmatched moon-shadow geometry; their existing tolerances do not acquire an invented scene-variation term.

| File in `app/shots/validation/` | Contents |
|---|---|
| `report.md` | One table row per case and region of interest: expected Y ± tolerance, rendered Y, rendered/expected, deviation in σ, and the verdict, naming the failing channels. Then the ratios. Then, per case, how each body was drawn (the data used and its worst label), the notes and the renderer warnings. |
| `report.json` | The same, with all four channels, the pixel statistics and the renderer stats. |
| `<id>.hdr.png` | Rendered Y on a square-root scale. Compare it with `validation/cases/<id>/preview.png`. |
| `<id>.display.png` | The eye-model image, as the app would show it. |

```sh
cd app
npm run validate                                   # all cases, shared default 4 × 4 = 16 samples per pixel
npm run validate -- --only io-nh-lorri-2007        # some cases
npm run validate -- --ss 2                         # explicit 2 × 2 override (the references are pixel-area averages)
npm run validate -- --reality strict               # measured and derived data only
npm run validate -- --hdr f16                      # the rgba16float fallback targets
npm run validate -- --strict                       # exit 1 for a failed ROI/ratio or a case not rendered (default: report and continue)
npm run validate -- --gpu hardware                 # on the machine's GPU instead of SwiftShader
```

`report.md`'s header and `report.json` (`options.ss`, `gpu`, and `ss`/`hdrFormat` per case) record the sampling, adapter and HDR targets of the actual run. The CLI, `npm run validate`, and the browser runner share `DEFAULT_VALIDATION_SS` in `src/validation/sampling.mjs`: provisionally 4 samples per axis (16 per pixel). One pixel-centre sample changes verdicts and undersamples small disks. The grid evaluates points at `(x + (dx + ½)/ss, y + (dy + ½)/ss)` in the reference pixel footprint and box-averages them; the shader's derivative-based limb coverage also becomes finer.

To measure the coarsest converged grid on stable code, cases and built data:

```sh
cd app && node scripts/validate-sampling.mjs
```

This uses `local-server.mjs` on a free port and `--gpu hardware`, runs the whole validation sequentially at 1, 2, 3, 4 and 6 samples per axis, and writes `shots/validation/sampling-convergence.json` and `.md`.

“Not rendered” means the case produced no usable measurement: its required sampled frame exceeded the device's `maxTextureDimension2D`, a WebGPU error or device loss occurred during that case (including readback), rendering timed out, or all body regions expecting light contained only zeros/non-finite pixels. Every ROI and ratio in that case carries the reason and has no pass/fail verdict. Its sky upper limits cannot pass. A single dark body/ring ROI still tests the model when other expected-light regions rendered. The headline counts all ROI and ratio rows as pass / fail / not rendered; intentional “not compared” rows are listed separately. `--strict` exits nonzero for any case not rendered or any failed ROI/ratio. Ordinary runs retain invalid cases and continue so a sweep can show every level. A timeout makes later cases not rendered too, since the page may still be rendering the timed-out case.

The page exposes device limits and checks dimensions before allocating the frame; the CLI checks them too. WebGPU validation, internal and out-of-memory error scopes wrap each case through its readbacks; uncaptured GPU errors, console errors and device loss are attributed per case. Invalid cases have no HDR/display measurement image, and stale images for those cases are removed.

The convergence files contain every ROI and ratio in X/Y/Z/S, the valid 4→6 relative changes and every verdict. Each level also prints the largest absolute relative difference, across all rows/channels, to the finest valid level **per case**, plus the largest across valid cases. Invalid levels show “not rendered” and contribute neither convergence values nor “verdict depends on sampling” changes. The default justification is calculated from that sweep; if a case has no valid level finer than the default, the text states that limit. It retains the runs under `sampling/<ss>/` and promotes the shared default's run and images to `shots/validation/` only if every default-level case rendered. Inspect changes at every grid in every channel and verdict; a stable tally alone does not establish convergence. The default stays provisional until this evidence supports the coarsest grid.

`cd pipeline && .venv/bin/python -m pipeline.validation report` includes the convergence table automatically when its JSON file is present. It refuses runs with errors but pass/fail rows (including old reports with only unattributed run-level errors), refuses runs without recorded sampling, and refuses a convergence file that does not contain the reported run. Rerun the sweep or remove the stale file before reporting a separate run. The generated report's header reads sampling from that run.

Case rebuilds are locked to consumed code, table/product values, raw bytes and the numerical environment. The landing gate `cd pipeline && uv run pytest -q tests/test_validation_reproducibility.py -k committed_case_lock_is_current` checks all eleven locks without raw images. `uv run python -m pipeline.validation verify` rebuilds without changing committed cases; `uv run python -m pipeline.validation renew-locks` renews only locks after every case reproduces scientific JSON, reference and preview bytes exactly. Changed inputs can be inspected with `build --output DIR --unlocked`; they cannot overwrite committed cases through that option.

From a script, the page exposes `window.__validation.run(case, { ss, reality })`. For experiments with a changed scene, it also exposes `window.__validation.debug`, which is `{ renderer, data }`.
