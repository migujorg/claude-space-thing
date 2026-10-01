"""Partly-cloudy optical-thickness statistic read from Pincus et al. (2023) Fig. 7 (pipeline/cloud_pcl.py)."""

import zlib

import numpy as np
import pytest

from pipeline import cloud_pcl as cp
from pipeline.paths import RAW


def _pdf_with_image(img: np.ndarray, predictor: bool) -> bytes:
    h, w, _ = img.shape
    if predictor:  # PNG "None" filter on every row, as a PDF Flate stream with /Predictor 15
        raw = b"".join(b"\x00" + img[y].tobytes() for y in range(h))
        parms = b"/DecodeParms<</Colors 3/Columns %d/BitsPerComponent 8/Predictor 15>>" % w
    else:
        raw, parms = img.tobytes(), b""
    data = zlib.compress(raw)
    other = b"1 0 obj\n<< /Type /Catalog >>\nendobj\n"
    obj = (b"7 0 obj\n<<\n/Type /XObject\n/Subtype /Image\n/Width %d\n/Height %d\n/BitsPerComponent 8\n"
           b"/ColorSpace /DeviceRGB\n/Length %d\n/Filter/FlateDecode\n%s\n>>\nstream\n" % (w, h, len(data), parms))
    return b"%PDF-1.5\n" + other + obj + data + b"\nendstream\nendobj\n"


@pytest.mark.parametrize("predictor", [True, False])
def test_pdf_image_round_trip(predictor):
    rng = np.random.default_rng(3)
    img = rng.integers(0, 256, (5, 7, 3), np.uint8)
    pdf = _pdf_with_image(img, predictor)
    assert np.array_equal(cp.pdf_image(pdf, 7, 5), img)
    with pytest.raises(ValueError, match="no 8x5"):
        cp.pdf_image(pdf, 8, 5)


def test_tau_distribution_moments():
    h = np.zeros((7, 7))
    h[6, 1] = 0.03                                  # everything in [0.3, 1.3)
    d = cp.tau_distribution(h)
    assert d["binProbability"][1] == 1 and d["cloudFraction"] == 0.03
    assert d["meanLnTau"] == pytest.approx(0.5 * (np.log(0.3) + np.log(1.3)), abs=1e-3)
    assert d["sdLnTau"] == pytest.approx((np.log(1.3) - np.log(0.3)) / np.sqrt(12), abs=1e-3)


PDF = RAW / "papers" / cp.PDF_NAME


@pytest.mark.skipif(not PDF.exists(), reason="Pincus et al. 2023 PDF not downloaded")
def test_figure7_reading():
    a = cp.pdf_image(PDF.read_bytes(), *cp.IMAGE_SIZE)
    cells = cp.figure_cells(a)                      # also checks the frames and ticks
    pcl, ice, liq = (np.where(cells[k]["belowFloor"], 0, cells[k]["value"]) for k in ("pclTotal", "pclIce", "pclLiquid"))
    # the low liquid row carries the partly cloudy population and is the same in the total and liquid panels
    np.testing.assert_allclose(pcl[6], liq[6], atol=1e-4)
    assert pcl[6, 1] == pytest.approx(0.040, abs=0.001) and pcl[6, 2] == pytest.approx(0.029, abs=0.001)
    # all phases ≈ ice + liquid where both are read (undetermined phase is small), within the reading resolution
    res = cells["pclTotal"]["resolution"] + cells["pclIce"]["resolution"] + cells["pclLiquid"]["resolution"]
    both = ~cells["pclTotal"]["belowFloor"]
    assert (np.abs(pcl - ice - liq)[both] <= res[both] + cp.FLOOR).all()
    s = cp.statistics(cells)["floorCellsZero"]
    p = s["partlyCloudyAllHeights"]
    assert sum(p["binProbability"]) == pytest.approx(1, abs=1e-3)
    # Pincus et al.: partly cloudy pixels are mostly liquid, low and optically thin (τ ≤ 3.6)
    assert s["partlyCloudyIceShare"] < 0.1 and s["partlyCloudyLowShare"] > 0.85
    assert sum(p["binProbability"][:3]) > 0.8
    # fully cloudy pixels are much thicker
    assert s["fullyCloudyAllHeights"]["meanLnTau"] > p["meanLnTau"] + 1.5
