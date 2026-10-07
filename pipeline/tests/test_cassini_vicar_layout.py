"""Cassini calibrated VICAR layout, independent of detached ^IMAGE pointers."""

import re

import numpy as np
import pytest

from pipeline.paths import RAW
from pipeline.validation import readers
from pipeline.validation.cases import SATURN


def _image(tmp_path, *, nlb=1, nbb=0, changes=None, header_record=1):
    expected = np.array([[.1, .2, .25], [.3, .4, .45], [.5, .6, .65]], dtype="<f4")
    stride = nbb + expected.shape[1] * 4
    label_size = stride * 32
    system = dict(LBLSIZE=label_size, FORMAT="'REAL'", TYPE="'IMAGE'", EOL=0, RECSIZE=stride,
                  ORG="'BSQ'", NL=3, NS=3, NB=1, NBB=nbb, NLB=nlb, REALFMT="'RIEEE'")
    system.update(changes or {})
    header = " ".join(f"{k}={v}" for k, v in system.items()).encode().ljust(label_size, b"\0")
    img = tmp_path / "image.img"
    records = b"".join(b"\xff" * nbb + row.tobytes() for row in expected)
    img.write_bytes(b"\0" * ((header_record - 1) * stride) + header + b"\0" * (nlb * stride) + records)
    lbl = tmp_path / "image.lbl"
    # As in the archive, ^IMAGE is the record after the ASCII label, which may be a binary header.
    lbl.write_text(f'''RECORD_BYTES = {stride}
^IMAGE_HEADER = ("image.img",{header_record})
^IMAGE = ("image.img",{header_record + label_size // stride})
DESCRIPTION = "UNITS = 'I/F'"
IMAGE_MID_TIME = 2016-116T00:00:00.000
EXPOSURE_DURATION = 25
OBJECT = IMAGE_HEADER
HEADER_TYPE = VICAR2
BYTES = {label_size}
END_OBJECT = IMAGE_HEADER
OBJECT = IMAGE
LINES = 3
LINE_SAMPLES = 3
SAMPLE_TYPE = PC_REAL
SAMPLE_BITS = 32
END_OBJECT = IMAGE
''')
    return img, lbl, expected


@pytest.mark.parametrize("nlb,nbb", [(0, 0), (1, 0), (0, 4), (1, 4)])
def test_cassini_reads_pixels_after_binary_headers_and_prefixes(tmp_path, nlb, nbb):
    img, lbl, expected = _image(tmp_path, nlb=nlb, nbb=nbb)
    np.testing.assert_array_equal(readers.cassini_calib(img, lbl).iof, expected)


def test_cassini_uses_image_header_pointer(tmp_path):
    img, lbl, expected = _image(tmp_path, header_record=2)
    np.testing.assert_array_equal(readers.cassini_calib(img, lbl).iof, expected)


def test_cassini_does_not_discard_valid_pixels_in_sparse_first_row(tmp_path):
    img, lbl, expected = _image(tmp_path, nlb=0)
    expected[0, :2] = 0
    img.write_bytes(img.read_bytes()[:-expected.nbytes] + expected.tobytes())
    actual = readers.cassini_calib(img, lbl).iof
    assert np.isnan(actual[0, 0])
    assert actual[0, 2] == expected[0, 2]


@pytest.mark.parametrize("changes,reason", [
    ({"EOL": 1}, "EOL"),
    ({"NL": 4}, "dimensions"),
    ({"NS": 4}, "dimensions"),
    ({"NB": 2}, "single-band"),
    ({"ORG": "'BIP'"}, "BSQ"),
    ({"FORMAT": "'DOUB'"}, "REAL"),
    ({"REALFMT": "'IEEE'"}, "RIEEE"),
    ({"RECSIZE": 4}, "record"),
    ({"NLB": -1}, "binary"),
])
def test_cassini_refuses_unsupported_or_inconsistent_layout(tmp_path, changes, reason):
    img, lbl, _ = _image(tmp_path, changes=changes)
    with pytest.raises(ValueError, match=reason):
        readers.cassini_calib(img, lbl)


def test_cassini_refuses_truncated_pixel_records(tmp_path):
    img, lbl, _ = _image(tmp_path)
    img.write_bytes(img.read_bytes()[:-4])
    with pytest.raises(ValueError, match="truncated"):
        readers.cassini_calib(img, lbl)


@pytest.mark.parametrize("image", SATURN.images, ids=lambda im: im.product)
@pytest.mark.skip_group("missing-input")
def test_cassini_real_image_has_real_first_and_last_rows(image):
    img = RAW / "validation" / SATURN.id / image.data_url.rsplit("/", 1)[-1]
    lbl = img.with_suffix(".LBL")
    if not img.exists() or not lbl.exists():
        pytest.skip(f"calibrated Saturn image or detached label absent: {img}, {lbl}")
    lab = readers.pds3_label(lbl.read_text())
    # Independent byte reading of the actual archive's system label and boundary records.
    with img.open("rb") as stream:
        start = stream.read(64)
        size = int(re.search(rb"LBLSIZE\s*=\s*(\d+)", start)[1])
        stream.seek(0)
        header = stream.read(size)
        def integer(key):
            return int(re.search(rb"\b" + key.encode() + rb"\s*=\s*(\d+)", header)[1])
        lines, samples = integer("NL"), integer("NS")
        stride, prefix = integer("RECSIZE"), integer("NBB")
        first = size + integer("NLB") * stride + prefix
        boundaries = []
        for row in (0, lines - 1):
            stream.seek(first + row * stride)
            boundaries.append(np.frombuffer(stream.read(samples * 4), dtype="<f4"))
    actual = readers.cassini_calib(img, lbl).iof
    assert actual.shape == (int(lab["IMAGE.LINES"]), int(lab["IMAGE.LINE_SAMPLES"])) == (lines, samples)
    for row, expected in zip((actual[0], actual[-1]), boundaries):
        assert np.isfinite(expected).all() and np.any(expected != 0)
        np.testing.assert_array_equal(row, expected)
