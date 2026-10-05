"""An unavailable cited transcription must be explicit without masking missing numerical inputs."""
import pytest
import requests

from pipeline.photometry import common
from pipeline.photometry.atmo_earth import BODHAINE
from pipeline.photometry.atmo_sources import HANSEN_HOVENIER
from pipeline.photometry.common import Download
from pipeline.photometry.moons import DECOLIBUS_PAPER, KARKOSCHKA_1994_TEXT, VERBISCER
from pipeline.photometry.phase import BUIE
from pipeline.photometry.rolo import ROLO


@pytest.mark.parametrize("document", [ROLO, BUIE, VERBISCER, DECOLIBUS_PAPER, BODHAINE, HANSEN_HOVENIER],
                         ids=lambda document: document.id)
def test_absent_pinned_document_offline_matches_refused_download(document, monkeypatch, tmp_path):
    monkeypatch.setattr(common, "RAW", tmp_path)
    monkeypatch.setattr(common, "_FAILED", {})
    monkeypatch.delenv("PIPELINE_OFFLINE", raising=False)

    def refused(*args, **kwargs):
        raise requests.HTTPError("publisher bot check")

    monkeypatch.setattr(common, "fetch", refused)
    expected = document.source().to_json()
    assert expected["sha256"] == document.sha256
    assert expected["retrieved"] == document.retrieved
    assert "Not re-downloaded in this build" in expected["notes"]

    monkeypatch.setattr(common, "_FAILED", {})  # offline must work without a prior failed download
    monkeypatch.setenv("PIPELINE_OFFLINE", "1")

    def unexpected_download(*args, **kwargs):
        pytest.fail("offline pinned document attempted a download")

    monkeypatch.setattr(common, "fetch", unexpected_download)
    assert document.source().to_json() == expected


def test_absent_transcribed_document_offline_matches_refused_download(monkeypatch, tmp_path):
    monkeypatch.setattr(common, "RAW", tmp_path)
    monkeypatch.setattr(common, "_FAILED", {})
    monkeypatch.delenv("PIPELINE_OFFLINE", raising=False)

    def refused(*args, **kwargs):
        raise requests.HTTPError("archive unavailable")

    monkeypatch.setattr(common, "fetch", refused)
    expected = KARKOSCHKA_1994_TEXT.source().to_json()
    assert expected["retrieved"] == ""
    assert "sha256" not in expected
    assert "Document unavailable" in expected["notes"]

    monkeypatch.setattr(common, "_FAILED", {})
    monkeypatch.setenv("PIPELINE_OFFLINE", "1")

    def unexpected_download(*args, **kwargs):
        pytest.fail("offline transcribed document attempted a download")

    monkeypatch.setattr(common, "fetch", unexpected_download)
    assert KARKOSCHKA_1994_TEXT.source().to_json() == expected


@pytest.mark.parametrize("method", ["fetch", "source"])
def test_absent_unpinned_input_offline_reaches_download_guard(method, monkeypatch, tmp_path):
    monkeypatch.setattr(common, "RAW", tmp_path)
    monkeypatch.setattr(common, "_FAILED", {})
    monkeypatch.setenv("PIPELINE_OFFLINE", "1")
    data = Download("input", "https://example.com/data", "test", "data", "Required data", "Citation")

    def guarded_download(*args, **kwargs):
        raise pytest.skip.Exception("offline download guard")

    monkeypatch.setattr(common, "fetch", guarded_download)
    with pytest.raises(pytest.skip.Exception, match="offline download guard"):
        getattr(data, method)()


def test_cached_pinned_document_offline_is_still_available(monkeypatch, tmp_path):
    from dataclasses import replace

    monkeypatch.setattr(common, "RAW", tmp_path)
    monkeypatch.setenv("PIPELINE_OFFLINE", "1")
    path = tmp_path / ROLO.subdir / ROLO.name
    path.parent.mkdir()
    path.write_bytes(b"%PDF-test fixture")
    document = replace(ROLO, sha256=common.file_sha256(path))

    def unexpected_download(*args, **kwargs):
        pytest.fail("cached pinned document attempted a download")

    monkeypatch.setattr(common, "fetch", unexpected_download)
    assert document.fetch() == path


def test_cached_transcribed_document_offline_keeps_retrieval(monkeypatch, tmp_path):
    monkeypatch.setattr(common, "RAW", tmp_path)
    monkeypatch.setattr(common, "_FAILED", {})
    monkeypatch.setenv("PIPELINE_OFFLINE", "1")
    document = KARKOSCHKA_1994_TEXT
    path = tmp_path / document.subdir / document.name
    path.parent.mkdir()
    path.write_text("Archived document fixture", encoding="utf-8")
    retrieval = {"url": document.url, "retrieved": "2026-10-04", "sha256": common.file_sha256(path)}

    def cached_download(*args, **kwargs):
        return path

    monkeypatch.setattr(common, "fetch", cached_download)
    monkeypatch.setattr(common, "record", lambda fetched: retrieval)
    source = document.source()
    assert source.retrieved == retrieval["retrieved"]
    assert source.sha256 == retrieval["sha256"]
    assert source.notes == document.notes


def test_unavailable_transcribed_paper_does_not_claim_retrieval(monkeypatch):
    def unavailable(self):
        raise RuntimeError("archive unavailable")
    monkeypatch.setattr(Download, "fetch", unavailable)
    source = KARKOSCHKA_1994_TEXT.source()
    assert source.sha256 is None
    assert source.retrieved == ""
    assert "Document unavailable" in source.notes
    assert "existing transcription" in source.notes


def test_required_numerical_source_remains_required(monkeypatch):
    def unavailable(self):
        raise RuntimeError("archive unavailable")
    monkeypatch.setattr(Download, "fetch", unavailable)
    data = Download("input", "https://example.com/data", "test", "data", "Required data", "Citation")
    with pytest.raises(RuntimeError, match="archive unavailable"):
        data.source()
