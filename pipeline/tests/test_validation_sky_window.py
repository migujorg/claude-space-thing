"""Sky ROIs use the reference footprint, never its brightness or renderer output."""

from contextlib import nullcontext

import numpy as np
import pytest

from pipeline.schema import BuildContext
from pipeline.validation import build, geometry as g, photometry as vp, roi


def _scene():
    orient = np.array([[1., 0., 0.], [0., 0., 1.], [0., -1., 0.]])
    target = g.Target(999, "test", np.array([0., 0., -1.e6]), orient,
                      np.array([0., 0., 1.5e8]), np.full(3, 6000.))
    view = g.camera_for(target, 40, 40, 1.e-3, 20., 20., 0.)
    return target, view, g.cast(view, [target], sub=2)


def test_missing_band_rejects_preferred_corner_and_produces_compared_row(monkeypatch):
    target, view, res = _scene()
    spec = roi.RoiSpec("sky-far", "sky-far", size=5, clear=6)
    preferred = roi.select([spec], res, 2)[0].rect
    refs = [np.full((40, 40), 0.01), np.full((40, 40), 0.02)]
    x0, y0, x1, y1 = preferred
    refs[1][y0:y1, x0:x1] = np.nan
    chosen = roi.select([spec], res, 2, refs=refs)[0]
    assert chosen.rect != preferred
    x0, y0, x1, y1 = chosen.rect
    assert all(np.isfinite(a[y0:y1, x0:x1]).all() for a in refs)

    # Exercise the stock measurement call site and expectation construction without downloads.
    monkeypatch.setattr(g, "kernels", nullcontext)
    monkeypatch.setattr(vp, "band_radiance", lambda *args: 1.)
    monkeypatch.setattr(vp, "band_solar_irradiance", lambda *args: 1.)
    monkeypatch.setattr(build.solar, "spectrum", lambda: type("Spectrum", (), {"grid": np.ones(3)})())
    monkeypatch.setattr(build.cie, "xyzs", lambda grid: np.ones(4))
    prepared = build.Prepared(
        id="synthetic-sky", title="test", summary="test", instrument="test", observer_name="test",
        observer_id="test", targets=[target], view=view, refs=refs, bands=["a", "b"],
        img_meta=[{"product": k, "registrationSigmaPx": 0.5} for k in ("a", "b")],
        ctx=BuildContext(0., 0.), calibration_sigma=[0.1, 0.1], calibration_note="test", calibration_sources=[],
        roi_specs=[spec], shape=vp.FLAT, pixel={}, notes=[], reference_image=0, epoch_utc="test", et=0.)
    row = build.measure(prepared, sub=2)["json"]["rois"][0]
    assert row["rect"] == list(chosen.rect)
    assert row["expected"]["type"] == "upper-limit"
    assert row["expected"]["label"] == "derived"


def test_no_complete_window_has_named_outcome():
    _, _, res = _scene()
    refs = [np.zeros((40, 40)), np.zeros((40, 40))]
    refs[1][::2, ::2] = np.nan      # each band has data, but no fully recorded 5×5 window exists
    with pytest.raises(roi.NoSkyWindowError, match="sky-far: no sky window with data in all bands"):
        roi.select([roi.RoiSpec("sky-far", "sky-far")], res, 2, refs=refs)


def test_reference_footprint_does_not_grow_the_geometric_margin():
    _, _, res = _scene()
    spec = roi.RoiSpec("sky-far", "sky-far", margin=2)
    baseline = roi.select([spec], res, 2)[0]
    refs = [np.full((40, 40), np.nan)]
    x0, y0, x1, y1 = baseline.rect
    refs[0][y0:y1, x0:x1] = 0.
    assert roi.select([spec], res, 2, refs=refs)[0].rect == baseline.rect


def test_reference_footprint_does_not_change_surface_selection():
    _, _, res = _scene()
    spec = roi.RoiSpec("disk-centre", "disk-centre", size=3)
    baseline = roi.select([spec], res, 2)[0]
    assert roi.select([spec], res, 2, refs=[np.full((40, 40), np.nan)])[0].rect == baseline.rect


@pytest.mark.parametrize("kind", ["sky-near", "sky-far"])
def test_footprint_keeps_geometry_scores_margins_size_and_tie_order(kind):
    _, _, res = _scene()
    spec = roi.RoiSpec(kind, kind, size=4, clear=6, margin=2)
    refs = [np.zeros((40, 40)), np.zeros((40, 40))]
    baseline = roi.select([spec], res, 2)[0]
    assert roi.select([spec], res, 2, refs=refs)[0].rect == baseline.rect
    # Independently enumerate the original geometric eligibility and mean-distance ordering.
    cls, tgt = g.uniform_class(res["cls"], res["tgt"], 2)
    distance = roi.ndimage.distance_transform_edt(cls == g.SKY)
    target_distance = roi.ndimage.distance_transform_edt(~((tgt == spec.target) | (cls == -1)))
    scores = roi._wmean(target_distance, spec.size) * (-1 if kind == "sky-near" else 1)
    x0, y0, x1, y1 = baseline.rect
    refs[1][y0, x0] = np.inf
    candidates = []
    for y in range(spec.margin, 40 - spec.size - spec.margin + 1):
        for x in range(spec.margin, 40 - spec.size - spec.margin + 1):
            sl = np.s_[y:y+spec.size, x:x+spec.size]
            if (distance[y-spec.margin:y+spec.size+spec.margin,
                         x-spec.margin:x+spec.size+spec.margin] >= spec.clear).all() and all(
                             np.isfinite(a[sl]).all() for a in refs):
                score = scores[y, x]
                candidates.append((score, y, x))
    best = max(c[0] for c in candidates)
    _, y, x = next(c for c in candidates if c[0] == best)
    assert roi.select([spec], res, 2, refs=refs)[0].rect == (x, y, x+spec.size, y+spec.size)
    # Values of valid samples do not affect the chosen window.
    refs[0][:] = -100.
    refs[1][np.isfinite(refs[1])] = 1000.
    assert roi.select([spec], res, 2, refs=refs)[0].rect == (x, y, x+spec.size, y+spec.size)
