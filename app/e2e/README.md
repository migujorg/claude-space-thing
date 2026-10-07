# Scene regression suite

`npm run e2e` renders the canonical views in [`scenes.json`](scenes.json) with the real app and the real data, then compares them with the committed baseline in [`baseline/`](baseline/).

The suite uses one Vite server and one headless Chromium with SwiftShader WebGPU, and renders at most two scenes at a time. SwiftShader is slow: on a 4-vCPU cloud workspace a scene takes about 1–3 minutes and the whole suite about 15 minutes; on the 32-thread workstation a scene takes 7–86 s and the suite 6 minutes. `--gpu hardware` renders on the machine's GPU instead, in about a minute: see [On the GPU](#on-the-gpu---gpu-hardware).

The suite needs the built data in `app/public/data`. It cannot run in CI, which has no data and no WebGPU; CI runs the unit tests, including `tests/e2e-lib.test.ts` for the comparison logic.

## What it writes

All output goes to `app/shots/e2e/`, which git ignores.

| File | Contents |
|---|---|
| `<id>.png` | Screenshot of the page, with the UI. For people. |
| `<id>.thumb.png` | 64×36 thumbnail of the rendered image only, without UI overlays. Box-averaged in linear light. |
| `report.json` | For each scene: renderer stats, a trimmed `debugState()`, the 16×9 lightness grid, console errors and warnings, the WebGPU adapter and HDR target format it rendered with, and the comparison. For the run: `gpu`, the mode asked for and the adapter. |
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
npm run e2e -- --base http://127.0.0.1:5173   # use a running dev server
npm run e2e -- --gpu hardware                 # on the machine's GPU instead of SwiftShader (see below)
```

## The scripts' own server

Without `--base`, `e2e.mjs`, `validate.mjs`, `shot.mjs`, `sb-gpu.mjs`, `sky-shots.mjs` and `corona-shots.mjs` start their own Vite server through `scripts/local-server.mjs`: on `127.0.0.1`, at a free port the operating system assigns, and Vite must take exactly that port. They never use 5173. (Asking Vite for port 0 does not give a free port: Vite then takes its default, 5173, on `localhost`, which is `[::1]` where IPv6 comes first. A script run would sit on `[::1]:5173` beside a dev server on `127.0.0.1:5173`, and a browser that opens `http://localhost:5173` would be served the script's tree.)

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
- **Stars drawn is not one number on the GPU.** In 9 of the 26 scenes the count alternates between two values on consecutive frames: pluto-charon 889 ↔ 1120, 908 ↔ 1101, 965 ↔ 1043 or 994 ↔ 1014 depending on the run (the two-frame mean stays at 1004–1005), jupiter-galileans 179 ↔ 186, and earth-night, uranus, neptune, starfield, starfield-enhanced, comet-lemmon and hyperion-fallback by 2 % or less (starfield-dark-30min, whose adaptation runs in real time, also moves by a few stars). The renderer culls each star against the light of the frame before, which holds the other stars' light. SwiftShader shows the same alternation (pluto-charon 996 ↔ 1014), but its frames take about a second, so a script reads the same frame on almost every run; on the GPU the read lands on either. In seven GPU runs pluto-charon failed the 5 % star tolerance three times (809, 909 and 1101 against 1015), and nothing else failed. A `hardware` run records the values seen over 16 animation frames in `starsDrawnFrames` and prints a note for a scene where they differ.
- **The sky cube** is 512² on a hardware adapter and 256² on a software one (`src/app/sky.ts`), so the sky background is not the same computation on the two.

The committed baseline was accepted on SwiftShader. A baseline accepted with `--gpu` records the mode and the adapter, and comparing a run with a baseline of the other kind prints a note.

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

`npm run validate` compares the renderer with real, calibrated spacecraft and satellite images. It uses the eleven ground-truth cases in [`validation/`](../../validation), from Cassini, Voyager 2, New Horizons, EPOXI and Himawari-9. How they were made, and what their tolerances mean, is in [docs/reports/validation.md](../../docs/reports/validation.md). Like the scene suite, it needs the built data in `app/public/data` and WebGPU: SwiftShader by default, the machine's GPU with `--gpu hardware` ([On the GPU](#on-the-gpu---gpu-hardware)). It is not part of CI.

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
npm run validate                                   # all cases (about 1 minute on the workstation, 4 on a cloud workspace; Himawari is the slowest)
npm run validate -- --only io-nh-lorri-2007        # some cases
npm run validate -- --ss 2                         # 2 × 2 samples per pixel (the references are pixel-area averages)
npm run validate -- --reality strict               # measured and derived data only
npm run validate -- --hdr f16                      # the rgba16float fallback targets
npm run validate -- --strict                       # exit 1 when a region fails (default: only when a case does not render)
npm run validate -- --gpu hardware                 # on the machine's GPU instead of SwiftShader
```

`report.md`'s header and `report.json` (`gpu`, and `hdrFormat` per case) say which adapter and which HDR targets rendered the run.

From a script, the page exposes `window.__validation.run(case, { ss, reality })`. For experiments with a changed scene, it also exposes `window.__validation.debug`, which is `{ renderer, data }`.
