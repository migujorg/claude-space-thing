"""Validation set: camera/ray-casting geometry, pointing fit, photometric closure, readers, and the committed cases."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from pipeline.paths import REPO
from pipeline.validation import geometry as g
from pipeline.validation import photometry as vp
from pipeline.validation import readers, register
from pipeline.validation.himawari import dir_to_grid, grid_to_dir

CASES = sorted((REPO / "validation" / "cases").glob("*/case.json"))


def _target(dist=1.0e6, radii=(6000.0, 6000.0, 5500.0), sun=(0.0, 0.0, 1.0), pole=(0.0, 1.0, 0.0)):
    """A body on the −Z axis of ICRF (observer at the origin) with the given pole; by default the Sun is behind
    the observer."""
    z = np.array(pole) / np.linalg.norm(pole)
    x = np.array([1.0, 0.0, 0.0])
    orient = np.column_stack([x, np.cross(z, x), z])                  # body-fixed -> ICRF, right-handed
    return g.Target(999, "test", np.array([0.0, 0.0, -dist]), orient, np.array(sun) * 1.5e8, np.array(radii))


def test_camera_puts_target_at_requested_pixel_and_pole_up():
    t = _target()
    for cx, cy, roll in ((32.0, 32.0, 0.0), (10.3, 50.7, 0.0), (40.0, 12.0, 37.0)):
        cam = g.camera_for(t, 64, 64, 1e-3, cx, cy, roll)
        px, py = cam.project(t.pos)
        assert abs(px - cx) < 1e-9 and abs(py - cy) < 1e-9
        assert abs(np.linalg.det(cam.M) - 1) < 1e-12 and np.allclose(cam.M.T @ cam.M, np.eye(3), atol=1e-12)
    cam = g.camera_for(t, 64, 64, 1e-3, 32.0, 32.0, 0.0)
    north = t.pos + t.pole * 6000.0
    assert cam.project(north)[1] < 32.0                  # the pole is above the centre (y down)


def test_cast_disk_size_and_angles():
    t = _target(radii=(6000.0, 6000.0, 6000.0))
    ang = 6000.0 / 1.0e6
    cam = g.camera_for(t, 80, 80, ang / 30.0, 40.0, 40.0, 0.0)      # disk radius 30 px
    res = g.cast(cam, [t], sub=2)
    on = (res["cls"] == g.LIT) | (res["cls"] == g.DARK)
    area_px = on.sum() / 4.0
    assert abs(area_px - math.pi * 30.0 ** 2) / (math.pi * 30.0 ** 2) < 0.01
    c = res["emi"][78:82, 78:82]
    assert np.nanmax(c) < 3.0                          # disk centre seen face-on (±1.5 px of 30)
    # Sun behind the observer: incidence = emission, phase ~ 0, everything lit
    assert np.nanmax(np.abs(res["inc"] - res["emi"])) < 0.5      # Sun 150 × farther than the observer
    assert (res["cls"][on] == g.LIT).all()


def test_ring_shadow_and_classes():
    t = _target(radii=(6000.0, 6000.0, 6000.0), sun=(0.0, 0.6, 0.8), pole=(0.0, 0.8, 0.6))
    t.rings = g.RingModel(np.array([7000.0, 7001.0, 12000.0, 12001.0]), np.array([0.0, 1.0, 1.0, 0.0]))
    cam = g.camera_for(t, 120, 120, 13000.0 / 1.0e6 / 55.0, 60.0, 60.0, 0.0)
    res = g.cast(cam, [t], sub=1)
    assert (res["cls"] == g.RING_LIT).sum() > 50
    assert np.nanmin(res["ring_r"]) >= 6999.0 and np.nanmax(res["ring_r"]) <= 12002.0


def test_fit_recovers_pose():
    t = _target(radii=(6000.0, 6000.0, 5000.0), sun=(0.5, 0.0, 0.8660254))
    W = H = 48
    pitch = 6000.0 / 1.0e6 / 12.0
    truth = (20.7, 27.3, 23.0)
    cam = g.camera_for(t, W, H, pitch, *truth)
    d, r = register.model_components(g.cast(cam, [t], sub=4), 4)
    rng = np.random.default_rng(1)
    obs = 0.4 * d + 0.002 + rng.normal(0, 0.002, d.shape)
    ft = register.fit_pointing(obs, [t], 0, pitch, flips=(False,))
    assert abs(ft.cx - truth[0]) < 0.15 and abs(ft.cy - truth[1]) < 0.15
    assert abs(((ft.roll_deg - truth[2] + 180) % 360) - 180) < 2.0


def test_xyzs_grey_closure():
    """I/F = 1 in every band of a grey scene must give exactly the XYZS of sunlight / (π d²)."""
    from pipeline import cie
    from pipeline.photometry import solar
    bands = [vp.BandValue(k, 1.0, {"calibration": 0.1, "noise": 0.0, "registration": 0.0})
             for k in ("cassini.wac.BL1", "cassini.wac.GRN", "cassini.wac.RED")]
    x = vp.xyzs_radiance(bands, vp.FLAT, 9.5)
    ref = cie.xyzs(solar.spectrum().grid) / (math.pi * 9.5 ** 2)
    assert np.allclose(x["value"], ref, rtol=1e-9)
    assert np.allclose(x["budget"]["calibration"], 0.1 * ref, rtol=1e-9)    # fully correlated → scales all
    assert max(x["budget"]["spectralModel"]) < 1e-9 * max(ref)             # flat ρ: no interpolation spread
    one = vp.xyzs_radiance(bands[1:2], vp.FLAT, 1.0)
    assert np.allclose(one["value"], cie.xyzs(solar.spectrum().grid) / math.pi, rtol=1e-9)


def test_band_radiance_definition():
    for k in ("cassini.wac.GRN", "voyager.nac.Green", "lorri.Pan"):
        assert math.isclose(vp.band_radiance(k, 1.0, 2.0) * math.pi * 4.0, vp.band_solar_irradiance(k),
                            rel_tol=1e-12)


def test_pds3_label_multiline_values():
    txt = ('PDS_VERSION_ID = PDS3\nRECORD_BYTES = 4096\nDESCRIPTION = "\nCalibrated:\n  UNITS = \'I/F\'\n'
           '  RADIOMETRIC = \'x\'\n"\nIMAGE_MID_TIME = 2016-116T05:55:23.254\nOBJECT = IMAGE\n  LINES = 1024\n'
           'END_OBJECT = IMAGE\nEND\n')
    lab = readers.pds3_label(txt)
    assert "UNITS = 'I/F'" in lab["DESCRIPTION"]
    assert "UNITS" not in lab                          # lines inside the quoted value are not keys
    assert lab["IMAGE.LINES"] == "1024" and lab["IMAGE_MID_TIME"] == "2016-116T05:55:23.254"


def test_himawari_grid_mapping_round_trip():
    class Seg:
        coff, loff, cfac, lfac = 5500.5, 5500.5, 40932549.0, 40932549.0
    col = np.array([1.0, 2750.0, 5500.5, 8000.25, 11000.0])
    lin = np.array([5501.0, 6000.0, 5500.5, 6600.0, 5800.0])
    c2, l2 = dir_to_grid(Seg, grid_to_dir(Seg, col, lin))
    assert np.allclose(c2, col, atol=1e-8) and np.allclose(l2, lin, atol=1e-8)
    # nadir looks at the Earth's centre, east is +column, south is +line
    d = grid_to_dir(Seg, np.array([5500.5, 5600.5, 5500.5]), np.array([5500.5, 5500.5, 5600.5]))
    assert np.allclose(d[0], [-1, 0, 0]) and d[1][1] > 0 and d[2][2] < 0


def test_companion_signal_finds_the_right_parity():
    from pipeline.validation import checks
    t = _target()
    cam = g.camera_for(t, 200, 200, 1e-4, 100.0, 100.0, 30.0)
    comp = cam.rays(np.array([150.5]), np.array([80.5]))[0] * 1.2e6       # a moon at pixel (150, 80)
    img = np.zeros((200, 200))
    img[78:83, 148:153] = 1.0
    s_direct = checks.companion_signal(img, cam, comp, flipped=False)
    s_mirror = checks.companion_signal(img, cam, comp, flipped=True)     # would look at column 49
    assert s_direct[0] == pytest.approx(25.0) and abs(s_mirror[0]) < 1e-9
    assert s_direct[1:] == pytest.approx((150.0, 80.0))


# ---------------------------------------------------------------------------------------------- committed cases


@pytest.mark.skipif(not CASES, reason="no validation cases built")
def test_report_run_line_names_the_adapter_and_machine():
    """§7's run line says what rendered the run when the runner recorded it (scripts/validate.mjs `gpu`, `host`)."""
    from pipeline.validation import report

    run = {"generatedAt": "2026-10-05T01:45:00.000Z", "git": "abc1234", "dataGeneratedAt": "2026-10-05T00:03:04+00:00",
           "options": {"ss": 1, "reality": "best"}, "cases": []}
    line = report.run_section(run, "").split("\n")[2]
    # a run from before the option: no adapter in the report, the line as it always was
    assert "1 × 1 samples per pixel: `cd app && npm run validate` (" in line and "rendered by" not in line
    host = {"cpu": "A CPU", "threads": 32}
    soft = {**run, "host": host, "gpu": {"mode": "swiftshader", "adapter": {"vendor": "google", "architecture": "swiftshader"}}}
    assert ("1 × 1 samples per pixel, rendered by SwiftShader (software WebGPU), adapter `google swiftshader`, on A CPU "
            "(32 threads): `cd app && npm run validate` (") in report.run_section(soft, "")
    hard = {**run, "host": host, "gpu": {"mode": "hardware", "adapter": {"vendor": "nvidia", "architecture": "blackwell"}}}
    assert ("rendered by the machine's GPU, adapter `nvidia blackwell`, on A CPU (32 threads): "
            "`cd app && npm run validate -- --gpu hardware` (") in report.run_section(hard, "")
    assert report.rendered_by({**run, "gpu": {"mode": "swiftshader", "adapter": None}}) == \
        ", rendered by SwiftShader (software WebGPU), adapter `unnamed adapter`"


@pytest.mark.parametrize("path", CASES, ids=[p.parent.name for p in CASES])
def test_case_file(path: Path):
    c = json.loads(path.read_text(encoding="utf-8"))
    assert c["schema"] == "validation-case-v1" and c["id"] == path.parent.name
    cam = c["view"]["camera"]
    W, H = cam["width"], cam["height"]
    M = np.array(cam["orient"]).reshape(3, 3)
    assert np.allclose(M.T @ M, np.eye(3), atol=1e-9) and abs(np.linalg.det(M) - 1) < 1e-9
    assert math.isclose(cam["pixelPitchRad"], 2 * math.tan(cam["fovY"] / 2) / H, rel_tol=1e-9)
    ref = c["reference"]
    nb, h, w = ref["shape"]
    assert (h, w) == (H, W) and nb == len(ref["bands"])
    assert (path.parent / ref["file"]).stat().st_size == nb * h * w * 4
    for b in c["view"]["bodies"]:
        orient = np.array(b["orient"]).reshape(3, 3)
        assert np.allclose(orient.T @ orient, np.eye(3), atol=1e-9)
    # the reference image's fitted target centre is where the view projects the target
    im = c["observation"]["images"][c["observation"]["referenceImage"]]
    if im.get("fit"):
        cm = g.Camera(M, W, H, cam["pixelPitchRad"])
        px, py = cm.project(np.array(c["view"]["bodies"][0]["pos"]))
        assert abs(px - im["fit"]["targetCentrePx"][0]) < 2e-3 and abs(py - im["fit"]["targetCentrePx"][1]) < 2e-3
    assert c["rois"], "no ROI selected"
    for r in c["rois"]:
        x0, y0, x1, y1 = r["rect"]
        assert 0 <= x0 < x1 <= W and 0 <= y0 < y1 <= H
        e = r["expected"]
        if e["type"] == "value":
            assert all(v > 0 for v in e["XYZS"]) and all(s > 0 for s in e["sigma"])
            assert np.allclose(e["tolerance"], 2 * np.array(e["sigma"]), rtol=1e-6)
            assert e["label"] in ("derived", "estimated")
        elif e["type"] == "upper-limit":
            assert all(v >= 0 for v in e["upperLimitXYZS"])
    ids = {s["id"] for s in c["sources"]}
    assert "naif-pck00011" in ids and "tsis1-hsrs-v2" in ids
