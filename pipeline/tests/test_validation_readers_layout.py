"""Reference-reader layout checks and archive quality flags; fixtures never enter data products."""

import re

import numpy as np
import pytest
from astropy.io import fits
from scipy import ndimage

from pipeline.paths import RAW
from pipeline.validation import geometry, readers
from pipeline.validation.cases import EARTH_MOON, NEPTUNE, URANUS


@pytest.fixture
def no_clock(monkeypatch):
    # Layout tests exercise no ephemeris or time conversion.
    monkeypatch.setattr(geometry, "utc_to_et", lambda _: 0.)
    monkeypatch.setattr(geometry, "et_to_utc", lambda _: "test-mid-time")


def _voyager(tmp_path, *, nlb=0, nbb=0, header_record=1, pointer_delta=0, changes=None):
    pixels = np.arange(1, 13, dtype="<i2").reshape(3, 4)
    stride = nbb + pixels.shape[1] * 2
    size = stride * 48
    system = dict(LBLSIZE=size, FORMAT="'HALF'", TYPE="'IMAGE'", EOL=0, RECSIZE=stride,
                  ORG="'BSQ'", NL=3, NS=4, NB=1, NBB=nbb, NLB=nlb, INTFMT="'LOW'")
    system.update(changes or {})
    text = " ".join(f"{k}={v}" for k, v in system.items())
    # History fields cannot override the system label, even inside quoted values.
    text += " TASK='GEOMA' COMMENT='NLB=99 RECSIZE=1' NLB=99"
    img = tmp_path / "voyager.img"
    records = b"".join(b"\xff" * nbb + row.tobytes() for row in pixels)
    img.write_bytes(b"\0" * ((header_record - 1) * stride) + text.encode().ljust(size, b"\0")
                    + b"\xff" * (nlb * stride) + records)
    rec = header_record + size // stride + nlb + pointer_delta
    lbl = tmp_path / "voyager.lbl"
    lbl.write_text(f'''RECORD_BYTES = {stride}
FILE_RECORDS = {img.stat().st_size // stride}
^VICAR_HEADER = ("voyager.img", {header_record})
^IMAGE = ("voyager.img", {rec})
STOP_TIME = 1989-08-15T05:02:22.00
EXPOSURE_DURATION = 11.52
OBJECT = VICAR_HEADER
HEADER_TYPE = VICAR
BYTES = {size}
END_OBJECT = VICAR_HEADER
OBJECT = IMAGE
LINES = 3
LINE_SAMPLES = 4
SAMPLE_TYPE = LSB_INTEGER
SAMPLE_BITS = 16
SAMPLE_DISPLAY_DIRECTION = RIGHT
LINE_DISPLAY_DIRECTION = DOWN
REFLECTANCE_SCALING_FACTOR = 1e-4
END_OBJECT = IMAGE
''')
    return img, lbl, pixels.astype(float) * 1e-4


@pytest.mark.parametrize("nlb,nbb", [(0, 0), (1, 0), (0, 4), (2, 4)])
def test_voyager_reads_embedded_layout(tmp_path, no_clock, nlb, nbb):
    img, lbl, expected = _voyager(tmp_path, nlb=nlb, nbb=nbb)
    np.testing.assert_array_equal(readers.voyager_geomed(img, lbl).iof, expected)


def test_voyager_uses_vicar_header_pointer(tmp_path, no_clock):
    img, lbl, expected = _voyager(tmp_path, header_record=2)
    np.testing.assert_array_equal(readers.voyager_geomed(img, lbl).iof, expected)


def test_voyager_reports_both_offsets_on_pointer_disagreement(tmp_path, no_clock):
    img, lbl, _ = _voyager(tmp_path, nlb=1, pointer_delta=-1)
    with pytest.raises(ValueError) as e:
        readers.voyager_geomed(img, lbl)
    message = str(e.value)
    assert str(img) in message and "384" in message and "392" in message
    assert "detached" in message and "VICAR" in message


@pytest.mark.parametrize("changes,reason", [
    ({"EOL": 1}, "EOL"), ({"NL": 4}, "dimensions"), ({"NS": 3}, "dimensions"),
    ({"NB": 2}, "single-band"), ({"ORG": "'BIP'"}, "BSQ"),
    ({"TYPE": "'TABLE'"}, "IMAGE"), ({"FORMAT": "'REAL'"}, "HALF"),
    ({"INTFMT": "'HIGH'"}, "LOW"), ({"COMPRESS": "'BASIC'"}, "uncompressed"),
    ({"RECSIZE": 4}, "record"), ({"NLB": -1}, "binary"), ({"NBB": -1}, "binary"),
    ({"LBLSIZE": 383}, "label size"), ({"LBLSIZE": 999999}, "truncated"),
])
def test_voyager_refuses_inconsistent_layout(tmp_path, no_clock, changes, reason):
    img, lbl, _ = _voyager(tmp_path, changes=changes)
    with pytest.raises(ValueError, match=reason):
        readers.voyager_geomed(img, lbl)


@pytest.mark.parametrize("mutation,reason", [
    ("truncate", "truncated"), ("append", "file size"), ("label", "LBLSIZE"),
    ("record", "record"), ("count", "file size"), ("pointer", "pointer"),
])
def test_voyager_refuses_bad_file_or_detached_layout(tmp_path, no_clock, mutation, reason):
    img, lbl, _ = _voyager(tmp_path)
    if mutation == "truncate":
        img.write_bytes(img.read_bytes()[:-2])
    elif mutation == "append":
        img.write_bytes(img.read_bytes() + b"\0" * 8)
    elif mutation == "label":
        img.write_bytes(b"BADSIZE" + img.read_bytes()[7:])
    elif mutation == "record":
        lbl.write_text(lbl.read_text().replace("RECORD_BYTES = 8", "RECORD_BYTES = 4"))
    elif mutation == "count":
        lbl.write_text(lbl.read_text().replace("FILE_RECORDS = 51", "FILE_RECORDS = 50"))
    else:
        lbl.write_text(lbl.read_text().replace('^IMAGE = ("voyager.img", 49)', '^IMAGE = 0'))
    with pytest.raises(ValueError, match=reason):
        readers.voyager_geomed(img, lbl)


def _old_voyager(img, lbl):
    """The c6436dc detached-pointer byte reading and masking, independent of the new layout parser."""
    lab = readers.pds3_label(lbl.read_text())
    offset = (int(re.search(r",\s*(\d+)\s*\)", lab["^IMAGE"])[1]) - 1) * int(lab["RECORD_BYTES"])
    shape = (int(lab["IMAGE.LINES"]), int(lab["IMAGE.LINE_SAMPLES"]))
    raw = np.fromfile(img, dtype="<i2", count=np.prod(shape), offset=offset).reshape(shape)
    a = raw.astype(float) * float(lab["IMAGE.REFLECTANCE_SCALING_FACTOR"])
    labels, _ = ndimage.label(raw == 0)
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    blank = np.isin(labels, edge[edge > 0])
    a[blank | (raw >= 32767) | (raw <= -32768)] = np.nan
    return a


@pytest.mark.parametrize("case,image", [(c, im) for c in (NEPTUNE, URANUS) for im in c.images],
                         ids=[im.product for c in (NEPTUNE, URANUS) for im in c.images])
def test_voyager_real_frames_are_bit_identical(case, image, no_clock):
    img = RAW / "validation" / case.id / image.data_url.rsplit("/", 1)[-1]
    lbl = img.with_suffix(".LBL")
    if not img.exists() or not lbl.exists():
        pytest.skip(f"Voyager raw image or detached label absent: {img}, {lbl}")
    actual, old = readers.voyager_geomed(img, lbl).iof, _old_voyager(img, lbl)
    assert actual.dtype == old.dtype
    assert actual.tobytes() == old.tobytes()  # Includes the NaN mask and payloads.


def _epoxi(tmp_path, flags, *, extension_name="FLAGS", other_first=True):
    image = fits.PrimaryHDU(np.full((2, 4), 0.25, dtype=np.float32))
    image.header.update(MULT2IOF=2., OBSMIDDT="2008-05-29T02:03:47.021", INTTIME=8.5)
    hdus = [image]
    if other_first:
        hdus.append(fits.ImageHDU(np.zeros((2, 4), dtype=np.float32), name="SNR"))
    if flags is not None:
        hdus.append(fits.ImageHDU(flags, name=extension_name))
    path = tmp_path / "epoxi.fit"
    fits.HDUList(hdus).writeto(path)
    return path


@pytest.mark.parametrize("bit", [0, 1, 4, 5, 6, 7])
def test_epoxi_masks_invalid_quality_bits(tmp_path, bit):
    q = np.zeros((2, 4), dtype=np.uint8)
    q[0, 0] = 1 << bit
    path = _epoxi(tmp_path, q)
    a = readers.epoxi_rad(path).iof
    assert np.isnan(a[0, 0])
    np.testing.assert_array_equal(a.flat[1:], np.full(7, .5))


def test_epoxi_retains_reclaimed_status_without_invalid_flags(tmp_path):
    # Summary §1.2: bits 2/3 say modified/reclaimed, not bad/missing/saturated.
    q = np.array([[0, 4, 8, 12], [1 | 8, 2 | 8, 16 | 4, 128 | 8]], dtype=np.uint8)
    a = readers.epoxi_rad(_epoxi(tmp_path, q)).iof
    np.testing.assert_array_equal(a[0], [.5] * 4)
    assert np.isnan(a[1]).all()


@pytest.mark.parametrize("flags,reason", [(None, "FLAGS"), (np.zeros((1, 4), dtype=np.uint8), "shape"),
                                        (np.zeros((2, 4), dtype=np.float32), "byte")])
def test_epoxi_refuses_missing_or_malformed_quality_map(tmp_path, flags, reason):
    with pytest.raises(ValueError, match=reason):
        readers.epoxi_rad(_epoxi(tmp_path, flags))


@pytest.mark.parametrize("image", EARTH_MOON.images, ids=lambda im: im.product)
def test_epoxi_real_frames_mask_only_invalid_flags(image):
    path = RAW / "validation" / EARTH_MOON.id / image.data_url.rsplit("/", 1)[-1]
    if not path.exists():
        pytest.skip(f"EPOXI raw image absent: {path}")
    with fits.open(path) as h:
        old = np.asarray(h[0].data, float) * float(h[0].header["MULT2IOF"])
        old[~np.isfinite(old) | (np.abs(old) > 3)] = np.nan
        invalid = (h["FLAGS"].data & 0xF3) != 0
    actual = readers.epoxi_rad(path).iof
    assert np.isnan(actual[invalid]).all()
    assert actual[~invalid].tobytes() == old[~invalid].tobytes()
