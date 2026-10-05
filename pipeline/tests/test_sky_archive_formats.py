"""Binary sky retrieval preserves values/nulls and rejects transport or row-limit truncation."""
import hashlib
from unittest.mock import patch
import numpy as np
from astropy.table import Table, MaskedColumn
from pipeline import stars_gaia as sg
from pipeline.stages import sky


def test_csv_and_fits_sums_have_identical_values_and_nulls(tmp_path):
    table = Table({"hpx": [0, 1, 2], "cbin": MaskedColumn([-16.0, 2.0, 3.0], mask=[False, True, False]),
                   "n": [1, 88, 100], "fg": [7.68692898066237e-9, 3.5944795571916094e-6, 0.1234567890123456]})
    csv, fits = tmp_path / "sums.csv", tmp_path / "sums.fits"
    table.write(csv, format="ascii.csv")
    table.write(fits, format="fits")
    a, b = sky._load_archive_sums(csv), sky._load_archive_sums(fits)
    for key in a:
        np.testing.assert_array_equal(a[key], b[key])
    assert np.isnan(b["cbin"][1])


def test_fits_validation_rejects_incomplete_and_maxrec_boundary(tmp_path):
    path = tmp_path / "rows.fits"
    Table({"hpx": [1, 2, 3], "fg": [0.1, 0.2, 0.3]}).write(path, format="fits")
    assert sg._fits_table_ok(path, max_rows=4)
    assert not sg._fits_table_ok(path, max_rows=3)
    with path.open("r+b") as file:
        file.truncate(5770)
    assert not sg._fits_table_ok(path, max_rows=4)


def test_binary_sums_do_not_issue_extra_count_query(monkeypatch, tmp_path):
    monkeypatch.setenv("PIPELINE_GAIA_SUMS_FITS", "1")
    monkeypatch.setattr(sg, "RAW", tmp_path)
    with patch.object(sg, "tap_query_fits", return_value="binary") as binary, \
         patch.object(sg, "tap_query") as csv:
        assert sg._sums_query("hpx", "table", "condition", "sums", "name", "count") == "binary"
    csv.assert_not_called()
    assert binary.call_args.kwargs["max_rows"] == sg.TAP_MAXREC


def test_existing_verified_csv_is_reused(monkeypatch, tmp_path):
    monkeypatch.setenv("PIPELINE_GAIA_SUMS_FITS", "1")
    monkeypatch.setattr(sg, "RAW", tmp_path)
    query = "SELECT hpx FROM table WHERE condition"
    name = "name_" + hashlib.sha256(query.encode()).hexdigest()[:10] + ".csv.rows"
    (tmp_path / "sums").mkdir()
    (tmp_path / "sums" / name).write_text("3")
    with patch.object(sg, "tap_query_fits") as binary, patch.object(sg, "tap_query", return_value="cached"):
        assert sg._sums_query("hpx", "table", "condition", "sums", "name", "count") == "cached"
    binary.assert_not_called()


def test_existing_full_table_fits_avoids_repeating_lite_query(monkeypatch, tmp_path):
    monkeypatch.setenv("PIPELINE_GAIA_SUMS_FITS", "1")
    monkeypatch.setattr(sg, "RAW", tmp_path)
    table = f"{sg.REL.schema}.gaia_source"
    query = f"SELECT hpx FROM {table} WHERE condition"
    name = "name_" + hashlib.sha256(query.encode()).hexdigest()[:10] + ".fits"
    (tmp_path / "sums").mkdir()
    Table({"hpx": [1, 2, 3]}).write(tmp_path / "sums" / name, format="fits")
    with patch.object(sg, "tap_query_fits", return_value="cached") as binary:
        assert sg._sums_query("hpx", table, "condition", "sums", "name", "count") == "cached"
    assert binary.call_args.args[1] == table
