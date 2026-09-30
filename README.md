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

The time window of the data is centered on the moment you run the pipeline; re-run it to move "now".

## Layout

- `pipeline/` — Python: raw downloads → processed, provenance-tagged data products.
- `app/` — TypeScript + WebGPU browser app.
- `docs/` — architecture, milestones, and per-source notes.
