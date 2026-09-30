"""Ground-truth validation set: calibrated spacecraft/satellite images turned into renderer test cases.

Each case (validation/cases/<id>/case.json) gives
  * a view the renderer can reproduce exactly (camera orientation and field of view, image size, and every body's
    camera-relative position, Sun vector, body-fixed→ICRF rotation and radii at the observation epoch), and
  * regions of interest (pixel rectangles in that view) with the radiance the renderer's HDR buffer must hold there:
    absolute XYZS (cd/m² and scotopic cd/m², before the eye model) and, per instrument band, the band radiance and
    I/F, each with a 1σ uncertainty budget and a pass/fail tolerance.

Geometry comes from JPL Horizons (spacecraft → target vectors, reconstructed trajectories) plus the NAIF generic
kernels (orientation, Sun); the image's pointing and roll are fitted to the image itself because the missions' C-kernels
are too large to fetch for a handful of frames (docs/reports/validation.md §2). Run with
`uv run python -m pipeline.validation build`.
"""
