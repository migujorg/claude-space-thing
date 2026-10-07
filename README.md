# Space Thing

A data-backed solar system simulator: what you would actually see if you were magically placed anywhere in the solar system, with every number traceable to a real measurement. Start with [`NORTH_STAR.md`](NORTH_STAR.md); engineering conventions are in [`docs/architecture.md`](docs/architecture.md); progress is in [`docs/milestones.md`](docs/milestones.md).

## Running it

You need [uv](https://docs.astral.sh/uv/getting-started/installation/) (it fetches Python 3.11, the version the pipeline is tested with, if needed), [Node.js](https://nodejs.org) 22 LTS (or 20.19+), a current Chrome or Edge (WebGPU), and the disk space of your [build profile](#build-profiles). Then, from the repository root:

```sh
./run.sh                                                  # Linux, macOS, WSL, Git Bash
powershell -ExecutionPolicy Bypass -File .\run.ps1        # Windows
```

The script checks the machine (`pipeline doctor`), builds the data with the **standard** profile, installs the app's packages and opens the app at http://localhost:5173. The rendering scripts start their own server on `127.0.0.1` at a free port and never use 5173 unless explicitly pointed at the app with `--base` ([why](app/e2e/README.md#the-scripts-own-server)). Pass `minimal` or `full` to choose another profile, e.g. `./run.sh full`. Nothing is committed but code: the first build downloads everything from the data archives and takes hours (table below). It can be interrupted at any time. Run the same command again and it resumes: finished stages are kept and interrupted downloads continue where they stopped. If a stage fails (a host is down, say), the others still build, the app starts with what exists, and the next run retries only what is missing. When everything is up to date, a later run starts the app within a minute.

In the app press `?` for keys. Click anything to see its provenance; `X` cycles the reality level (Strict / Best estimate / Complete), `V` toggles naked-eye vs enhanced view, `/` searches. `E` opens Moments: eclipses, Galilean-moon phenomena, Saturn's ring-plane crossings, oppositions and elongations, and near-Earth-object approaches inside the data window, computed by the app from the loaded ephemerides, each with a "go there" camera and its provenance.

With the full data, the app also draws Earth’s airglow and aurora, Titan’s Huygens-based haze, and the giant planets’ rings. Best estimate and Complete admit the estimated ring components, including Uranus’s current-date constant-width estimates; Strict uses the measured occultation profiles, with unknown reflectance marked as such. Complete adds synthetic Centaurs and irregular moons of Jupiter and Saturn. Sources and remaining gaps are in [`docs/milestones.md`](docs/milestones.md#resumed-work-landed-on-rc-by-2026-10-07).

## Build profiles

The data is built by `cd pipeline && uv run python -m pipeline build --profile <name>` (the run scripts do this). The pipeline has 14 stages. A profile chooses which stages run and at what size, never what a product means. Products it leaves out are simply absent, and the app says so in its Data panel (`M`).

| profile | cold download | kept in data/raw | disk needed | products | cold build | forced rebuild | stages |
|---|---|---|---|---|---|---|---|
| minimal | 2.2 GB | 2.1 GB | 2.6 GB | 0.2 GB | 31 min | 2 min | time, ephemeris, light, bodies, stars |
| standard | 49 GB | 8.4 GB | 20 GB | 3.1 GB | 4.2 h | 82 min | all; surfaces.maxLevel=3, shapes.damit=false |
| full | 51 GB | 8.4 GB | 23 GB | 6.2 GB | 4.3 h | 84 min | all |

- **minimal**: the Sun, planets, all 460 moons, rings, atmospheres and the naked-eye star field. It has no surface maps, shape models, small bodies, deep stars, diffuse sky or nightglow.
- **standard**: everything. Surface maps stop at pyramid level 3 (4096 × 2048 texels; the Moon at 2.7 km per texel), and the DAMIT collection of asteroid lightcurve models is left out.
- **full**: everything at the sources' full resolution.

The star colours come from Gaia's XP spectra. ESA's own archive offers them only as 114 GB of bulk files, so by default the build asks the Gaia TAP service of ARI Heidelberg (a Gaia DPAC partner data centre) for the spectra of just the stars it needs:
- The naked-eye stars take 0.6 GB.
- The 15 M deep-tier stars take 21 GB. These spectra are reduced as they arrive and not kept.

The values are bit-identical to the bulk files' (`docs/reports/stars.md` §8). The XP queries run 4 at a time, at about 6.5 MB/s in all. `--set gaia.xpWorkers=8` roughly doubles that.

On a fast line, a full build can still be quicker from the bulk files: `--set stars.xpSource=bulk` streams all 114 GB once for every star tier. This is the older route, 145 GB and about 3.7 h for full. Times were measured at 20–40 MB/s on 4 cores.

Per stage (`python -m pipeline costs` prints this table; the numbers live in `pipeline/src/pipeline/config.py`, measured or taken from each stage's report in `docs/reports/`). "Forced rebuild" is the time to rebuild a stage with `data/raw` already filled, e.g. after a pipeline update changed it; a stage that nothing changed is skipped.

| stage | cold download | kept in data/raw | peak disk | products | cold build | forced rebuild | notes |
|---|---|---|---|---|---|---|---|
| time | < 1 MB | < 1 MB | < 1 MB | < 1 MB | < 1 min | < 1 min |  |
| ephemeris | 0.2 GB | 0.2 GB | 0.3 GB | 0.1 GB | 4 min | < 1 min | DE442s + range-request excerpts of 20 NAIF satellite kernels |
| light | 1.0 GB | 1.0 GB | 1.0 GB | 2 MB | 7 min | 1 min | 0.8 GB of it is Earth photometry (EPOXI, Himawari-9 full-disk scans) |
| surfaces | 22 GB | 3.0 GB | 15 GB | 4.2 GB | 55 min | 45 min | the Moon's 13 GB of LROC mosaics, Mercury's 4.3 GB and Pluto's 1.3 GB are deleted right after reduction, so a rebuild downloads them again; 1.3 GB of products at surfaces.maxLevel=3 |
| shapes | 2.6 GB | 0.2 GB | 2.5 GB | 0.6 GB | 25 min | 20 min | without DAMIT (shapes.damit=0): 1.2 GB download, 0.43 GB products |
| bodies | 40 MB | 40 MB | 40 MB | 1 MB | < 1 min | < 1 min |  |
| smallbodies | 1.6 GB | 1.6 GB | 2.0 GB | 0.2 GB | 18 min | 3 min | JPL SBDB is queried one request at a time, as JPL asks |
| sbphotometry | 2 MB | 2 MB | 2 MB | < 1 MB | < 1 min | < 1 min |  |
| synthetic | 0.1 GB | 0.1 GB | 0.3 GB | 0.1 GB | 2 min | 2 min | includes the 0.11 GB Centaur-model archive (Zenodo) of Kurlander et al. 2025 |
| comets | 20 MB | 20 MB | 50 MB | 2 MB | 5 min | 5 min | propagates every comet with M1/K1 day by day through the window; a few Horizons queries |
| stars | 0.9 GB | 0.9 GB | 1.0 GB | 24 MB | 20 min | 1 min | XP spectra of the 440 702 selected sources by source_id (207 queries on ARI's Gaia TAP, 0.6 GB); stars.xpSource=bulk streams all 114 GB of ESA's bulk files instead |
| deepstars | 22 GB | 1.1 GB | 3.0 GB | 0.8 GB | 85 min | 4 min | 192 Gaia archive queries (1.0 GB) + XP spectra of 15.3 M sources (3158 queries, 21 GB, reduced on the fly, 0.5 GB cache; ~55 min at 4 queries at a time); fetched again if data/cache is deleted |
| sky | 0.1 GB | 0.1 GB | 0.2 GB | 40 MB | 30 min | 2 min | 96 all-sky aggregation queries on the Gaia archive (10-19 min per 48); 18 MB of corona papers and sunspot-number files |
| nightglow | 0.1 GB | 0.1 GB | 0.1 GB | 6 MB | 4 min | 1 min | PALACE airglow model (2.7 MB), OVATION Prime coefficients (57 MB), OMNI 2 solar wind, IGRF-14, papers; field-line tracing of the magnetic grid takes most of the time |

Useful commands (in `pipeline/`, prefixed with `uv run python -m pipeline`):

- `doctor [--profile P]` checks Python and the compiled packages, Node, free disk, Windows long paths, write access and every data host. It prints what to fix.
- `plan --profile P` shows what `build` would run and why (not built yet, code or parameters changed, inputs changed…).
- `build --profile P [--skip a,b] [--set key=value] [--force]` builds. `--only a,b` runs exactly those stages, whether up to date or not (development). The output is copied to `data/cache/logs/`, and the build ends with a summary of what was built, what was skipped and why.
- Before each stage, `build` compares the disk space the stage may need (its peak in the table, less what is already downloaded or built) with the free space. If the stage may not fit, it does not start it, unless you pass `--force-space`.
- `build --adopt --profile P` records products that already exist (e.g. built before resumable builds, or copied in) as up to date. It runs and downloads nothing. It hashes every product against `manifest.json`, and a JSON file rewritten after its manifest entry (e.g. merged by hand) is accepted and re-registered once it parses and everything it names exists. For each stage it prints adopted, or not adoptable with the reason.
- `params` lists every stage parameter (e.g. `surfaces.maxLevel`, `shapes.damit`, `gaia.xpWorkers`) and its environment-variable alias.

Downloads go to `data/raw/` (sha256-recorded in `data/raw/_downloads.json`), intermediates to `data/cache/` (safe to delete), products to `app/public/data/`. To put downloads on another drive, set `PIPELINE_RAW` and `PIPELINE_CACHE` to absolute paths. The time window of the data is centered on the moment of the first build and stored in `data/cache/window.json`; `build --new-window` recenters it on "now" (every time-dependent stage then rebuilds).

## Testing

```sh
cd app && npm run typecheck && npm test       # unit tests; data-dependent ones skip without built data
cd pipeline && uv run pytest -rs              # PIPELINE_OFFLINE=1: tests never download, missing inputs skip
cd app && npm run e2e                         # rendered-scene regression suite (needs built data), see app/e2e/README.md
```

CI (`.github/workflows/ci.yml`) runs the first two on every push, offline and without data, on Linux and (informational for now) on Windows. On Windows, run pytest with `PYTHONUTF8=1`; the pipeline CLI switches to UTF-8 mode by itself.

### Tests and references

The data are rebuilt on another day, with another time window, another SBDB snapshot and newer Earth orientation kernels, and the tests must not care. So the tests use two kinds of reference and never mix them:

- **Committed references** (`app/tests/fixtures/`, `pipeline/tests/fixtures/`) hold values for stated inputs: orbit solutions with their orbit id, Horizons vectors with their query URL, SPICE values with the kernel files they came from (sha256; fixed kernel files only, so nothing from the Earth orientation kernels, which NAIF reissues). Each has its own epoch and, for small bodies, its own force model, and a test uses it with those, not with the epoch of the data under test. A build never writes them, and rebuilding the data never requires regenerating them.
- **Build records** (`verification/<stage>.json` in the built data, listed in the manifest) are written by a stage in the same run as its products and name their sha256: the states the `smallbodies` stage put in `core.bin` with its integrator's positions and Horizons' through the window, the CNEOS close approaches of this window on the orbit solutions the catalogue holds, and SPICE's own evaluation of the kernels the `bodies` stage copied the orientation products from. A test of "the app reads this product as the pipeline wrote it" compares with the record of the build it runs against.

A comparison that cannot be made is not dropped: it is a skipped test whose name starts with `NOT COMPARED:` and says what and why (a reference epoch outside the built ephemeris, a product copied from another kernel file, a published eclipse outside the window, a build made before its stage wrote a record). The number of skipped tests in the summary of `npm test` on a full build is the number of comparisons that build could not make; `npm test -- --reporter=verbose | grep "NOT COMPARED"` lists them.

Regenerate a committed reference only when what it describes changes (the force model, the integrator, the verification set, the planetary kernel), or when the window has moved so far that most of its epochs are reported as not compared:

```sh
cd pipeline
uv run python -m pipeline.sb_fixtures                 # small bodies; needs the smallbodies stage built
uv run python -m pipeline.ephem_fixtures              # ephemeris, time, rotation, lunar orientation; queries Horizons
uv run python -m pipeline.ephem_fixtures orientation  # only the lunar orientation reference, from data/raw, no network
```

`TEST_DATA_DIR=<built data> npm test` and `TEST_FIXTURE_DIR=<references> npm test` run the app suite against another build or another set of references.

## Layout

- `pipeline/`: Python. Raw downloads become processed, provenance-tagged data products.
- `app/`: the TypeScript + WebGPU browser app.
- `docs/`: architecture, milestones, and per-source notes.
