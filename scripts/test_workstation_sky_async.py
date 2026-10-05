"""Persistent archive jobs survive interrupted polling without repeat submission."""
import json
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workstation_sky_async as s


def test_job_handle_survives_poll_failure_and_is_reused(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "STATE", tmp_path / "jobs.json")
    monkeypatch.setattr(s, "cached", lambda *args: False)
    session = Mock()
    response = Mock(status_code=303, headers={"Location": s.sg.TAP_URL + "/async/123"})
    session.post.return_value = response
    session.get.side_effect = OSError("connection interrupted")
    monkeypatch.setattr(s.d, "session", lambda: session)
    job = {"name": "test.fits", "query": "SELECT 1", "base": "test", "subdir": "sums"}
    jobs = {job["name"]: job}
    with pytest.raises(OSError):
        s.advance(job, jobs)
    restored = json.loads(s.STATE.read_text())
    assert restored["test.fits"]["url"].endswith("/async/123")
    session.get.side_effect = None
    session.get.return_value = Mock(text="EXECUTING")
    s.advance(restored["test.fits"], restored)
    assert session.post.call_count == 1
    assert restored["test.fits"]["phase"] == "EXECUTING"


def test_complete_job_downloads_and_validates_result(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "cached", lambda *args: False)
    session = Mock()
    session.get.return_value = Mock(text="COMPLETED")
    monkeypatch.setattr(s.d, "session", lambda: session)
    path = tmp_path / "test.fits"
    fetch = Mock(return_value=path)
    monkeypatch.setattr(s.d, "fetch", fetch)
    job = {"name": "test.fits", "query": "SELECT 1", "base": "test", "subdir": "sums",
           "url": s.sg.TAP_URL + "/async/123"}
    s.advance(job, {job["name"]: job})
    assert fetch.call_args.args == (job["url"] + "/results/result", "sums", "test.fits")
    assert callable(fetch.call_args.kwargs["validate"])
    assert path.with_name("test.fits.adql").read_text() == job["query"]
    assert job["phase"] == "SAVED"


def test_explicit_straggler_move_cancels_old_job_and_preserves_cache_identity(monkeypatch, tmp_path):
    monkeypatch.setattr(s, "STATE", tmp_path / "jobs.json")
    monkeypatch.setattr(s, "cached", lambda *args: False)
    session = Mock()
    session.get.return_value = Mock(text="EXECUTING")
    monkeypatch.setattr(s.d, "session", lambda: session)
    query = "SELECT GAIA_HEALPIX_INDEX(8, source_id) AS hpx FROM gaiadr3.gaia_source_lite WHERE source_id > 1"
    job = {"name": "original.fits", "query": query, "base": "test", "subdir": "sums",
           "url": s.sg.TAP_URL + "/async/123", "phase": "EXECUTING"}
    s.share_provider({job["name"]: job}, "aip", all_waiting=True, move_running=True)
    assert job["name"] == "original.fits"
    assert job["logicalQuery"] == query
    assert job["provider"] == "aip" and "url" not in job
    assert "source_id/8796093022208" in job["query"]
    session.post.assert_called_once_with(job["originalJobUrl"] + "/phase", data={"PHASE": "ABORT"}, timeout=30)
