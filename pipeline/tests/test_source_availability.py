"""An unavailable cited transcription must be explicit without masking missing numerical inputs."""
import pytest

from pipeline.photometry.common import Download
from pipeline.photometry.moons import KARKOSCHKA_1994_TEXT


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
