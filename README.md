# Space Thing

A data-backed solar system simulator: what you would actually see if you were magically placed anywhere in the solar system, with every number traceable to a real measurement. Start with [`NORTH_STAR.md`](NORTH_STAR.md); engineering conventions are in [`docs/architecture.md`](docs/architecture.md); progress is in [`docs/milestones.md`](docs/milestones.md).

## Running it

You need [uv](https://docs.astral.sh/uv/getting-started/installation/) (it fetches Python 3.11, the version the pipeline is tested with, if needed), [Node.js](https://nodejs.org) 22 LTS (or 20.19+), a current Chrome or Edge (WebGPU), and the disk space of your [build profile](#build-profiles). Then, from the repository root:

```sh
./run.sh                                                  # Linux, macOS, WSL, Git Bash
powershell -ExecutionPolicy Bypass -File .\run.ps1        # Windows
```

The script checks the machine (`pipeline doctor`), builds the data with the **standard** profile, installs the app's packages and opens the app at http://localhost:5173. Pass `minimal` or `full` to choose another profile, e.g. `./run.sh full`. Nothing is committed but code: the first build downloads everything from the data archives and takes hours (table below). It can be interrupted at any time. Run the same command again and it resumes: finished stages are kept and interrupted downloads continue where they stopped. If a stage fails (a host is down, say), the others still build, the app starts with what exists, and the next run retries only what is missing. When everything is up to date, a later run starts the app within a minute.

In the app press `?` for keys. Click anything to see its provenance; `X` cycles the reality level (Strict / Best estimate / Complete), `V` toggles naked-eye vs enhanced view, `/` searches.

## Build profiles

The data is built by `cd pipeline && uv run python -m pipeline build --profile <name>` (the run scripts do this). A profile chooses which stages run and at what size, never what a product means. Products it leaves out are simply absent, and the app says so in its Data panel (`M`).

| profile | cold download | kept in data/raw | disk needed | products | cold build | forced rebuild | stages |
|---|---|---|---|---|---|---|---|
| minimal | 117 GB | 2.8 GB | 4.8 GB | 0.2 GB | 61 min | 2 min | time, ephemeris, light, bodies, stars |
| standard | 143 GB | 8.8 GB | 21 GB | 3.1 GB | 3.6 h | 74 min | all; surfaces.maxLevel=3, shapes.damit=false |
| full | 145 GB | 8.8 GB | 24 GB | 6.2 GB | 3.7 h | 76 min | all |

- **minimal**: the Sun, planets, all 459 moons, rings, atmospheres and the naked-eye star field. It has no surface maps, shape models, small bodies, deep stars or diffuse sky.
- **standard**: everything. Surface maps stop at pyramid level 3 (4096 × 2048 texels; the Moon at 2.7 km per texel), and the DAMIT collection of asteroid lightcurve models is left out.
- **full**: everything at the sources' full resolution.

Most of the download is the star field. The colours of the naked-eye stars come from Gaia's XP spectra, and ESA publishes them only as 114 GB of bulk files. Every profile with stars streams all of them once and keeps only what it needs. That is also why minimal is not quick. `./run.sh minimal --skip stars` (PowerShell: `.\run.ps1 minimal -- --skip stars`) builds an app without stars from 1.2 GB in about 12 minutes. The deep star tiers reuse the same pass. Times were measured at 20–40 MB/s on 4 cores; on a faster line and more cores the streaming shortens (`--set gaia.xpWorkers=8`).

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
| synthetic | 30 MB | 30 MB | 0.2 GB | 0.1 GB | 2 min | 1 min |  |
| stars | 116 GB | 1.6 GB | 3.2 GB | 24 MB | 50 min | 1 min | streams all 114 GB of Gaia DR3 XP spectra once (only 1.2 GB kept); with deepstars or sky in the same build it also fills their 1.1 GB XP cache in that pass |
| deepstars | 1.1 GB | 1.1 GB | 3.0 GB | 0.8 GB | 30 min | 3 min | 192 Gaia archive queries; +114 GB / ~75 min of XP streaming if the stars stage did not fill the XP cache (e.g. data/cache deleted) |
| sky | 0.1 GB | 0.1 GB | 0.2 GB | 40 MB | 30 min | 2 min | 96 all-sky aggregation queries on the Gaia archive (10-19 min per 48) |

Useful commands (in `pipeline/`, prefixed with `uv run python -m pipeline`):

- `doctor [--profile P]` checks Python and the compiled packages, Node, free disk, Windows long paths, write access and every data host. It prints what to fix.
- `plan --profile P` shows what `build` would run and why (not built yet, code or parameters changed, inputs changed…).
- `build --profile P [--skip a,b] [--set key=value] [--force]` builds. `--only a,b` runs exactly those stages, whether up to date or not (development). The output is copied to `data/cache/logs/`, and the build ends with a summary of what was built, what was skipped and why.
- `params` lists every stage parameter (e.g. `surfaces.maxLevel`, `shapes.damit`, `gaia.xpWorkers`) and its environment-variable alias.

Downloads go to `data/raw/` (sha256-recorded in `data/raw/_downloads.json`), intermediates to `data/cache/` (safe to delete), products to `app/public/data/`. To put downloads on another drive, set `PIPELINE_RAW` and `PIPELINE_CACHE` to absolute paths. The time window of the data is centered on the moment of the first build and stored in `data/cache/window.json`; `build --new-window` recenters it on "now" (every time-dependent stage then rebuilds).

## Testing

```sh
cd app && npm run typecheck && npm test       # unit tests; data-dependent ones skip without built data
cd pipeline && uv run pytest -rs              # PIPELINE_OFFLINE=1: tests never download, missing inputs skip
cd app && npm run e2e                         # rendered-scene regression suite (needs built data), see app/e2e/README.md
```

CI (`.github/workflows/ci.yml`) runs the first two on every push, offline and without data, on Linux and (informational for now) on Windows. On Windows, run pytest with `PYTHONUTF8=1`; the pipeline CLI switches to UTF-8 mode by itself.

## Layout

- `pipeline/`: Python. Raw downloads become processed, provenance-tagged data products.
- `app/`: the TypeScript + WebGPU browser app.
- `docs/`: architecture, milestones, and per-source notes.
