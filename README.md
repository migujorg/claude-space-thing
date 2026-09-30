# Space Thing

A data-backed solar system simulator: what you would actually see if you were magically placed anywhere in the solar system, with every number traceable to a real measurement. Start with [`NORTH_STAR.md`](NORTH_STAR.md); engineering conventions are in [`docs/architecture.md`](docs/architecture.md); progress is in [`docs/milestones.md`](docs/milestones.md).

## Running it

Requirements: Python 3.11+ with [uv](https://docs.astral.sh/uv/), Node 20+, and a Chromium-based browser with WebGPU (Chrome/Edge).

```sh
# 1. Build the data (downloads raw datasets into data/raw/, writes app/public/data/)
cd pipeline && uv run python -m pipeline build && cd ..

# 2. Run the app
cd app && npm install && npm run dev
# open http://localhost:5173
```

A first build downloads roughly 2 GB and takes about an hour, most of it streaming Gaia spectra for the star field; rebuilds reuse `data/raw/` and take minutes. Single stages can be rebuilt with `--only time,ephemeris,bodies,light,stars,…`.

In the app press `?` for keys. Click anything to see its provenance; `X` cycles the reality level (Strict / Best estimate / Complete), `V` toggles naked-eye vs enhanced view, `/` searches.

The time window of the data is centered on the moment of the first build and stored in `data/cache/window.json`, so later partial builds (`--only`) stay on it; run `uv run python -m pipeline build --new-window` to recenter it on "now".

## Testing

```sh
cd app && npm run typecheck && npm test       # unit tests; data-dependent ones skip without built data
cd pipeline && uv run pytest -rs              # PIPELINE_OFFLINE=1: tests never download, missing inputs skip
cd app && npm run e2e                         # rendered-scene regression suite (needs built data), see app/e2e/README.md
```

CI (`.github/workflows/ci.yml`) runs the first two on every push, offline and without data.

## Layout

- `pipeline/` — Python: raw downloads → processed, provenance-tagged data products.
- `app/` — TypeScript + WebGPU browser app.
- `docs/` — architecture, milestones, and per-source notes.
