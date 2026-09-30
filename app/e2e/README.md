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

A scene that fails to render always fails. Examples: a `__frameError`, or a timeout waiting for `__frameReady`.

## Running

```sh
cd app
npm run e2e                                   # all scenes, compared with the baseline; exit 1 on a regression
npm run e2e -- --only earth-day,saturn-rings  # some scenes
npm run e2e -- --no-compare                   # render and report only
npm run e2e -- --jobs 1 --timeout 600         # one scene at a time, 10 min per scene
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

   Nothing is accepted if any scene fails to render.
3. Review `git diff app/e2e/baseline`. The stats diff says what changed, for example a pupil diameter or a set of warnings. Commit the baseline together with the change that caused it, and say why in the commit message.

The baseline records the data build it was made with: the manifest's `generatedAt` and sha256. When you compare against a different data build, the report says so, because differences may then come from the data rather than the code.

## Adding a scene

1. Add an entry to `scenes.json` with an `id`, a `title` and `params`. The params are any URL parameters of the app, see `src/app/url.ts`. The `defaults` block pins the time and switches off small bodies.
2. Small bodies are switched off (`smallbodies=0`) in every scene except those about small bodies, so that loading the 1.6 M-object catalogue does not slow every scene down.
3. Run `npm run e2e -- --accept --only <id>` and commit the new baseline files.
