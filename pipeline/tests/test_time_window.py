"""The build window is persisted on the first build and reused until --new-window (pipeline/__main__.py)."""

import json

from pipeline import __main__ as cli


def test_window_is_persisted_and_reused(tmp_path, monkeypatch):
    wf = tmp_path / "window.json"
    monkeypatch.setattr(cli, "WINDOW_FILE", wf)

    first = cli._window(new=False, days=10.0)
    assert wf.exists()
    stored = json.loads(wf.read_text(encoding="utf-8"))
    assert (stored["startEt"], stored["endEt"]) == first
    assert first[1] - first[0] == 20 * 86400
    assert stored["halfWidthDays"] == 10.0

    # Later builds (e.g. --only) reuse it, even if --window-days is passed without --new-window.
    wf.write_text(json.dumps({**stored, "startEt": 1000, "endEt": 2000}), encoding="utf-8", newline="\n")
    assert cli._window(new=False, days=None) == (1000, 2000)
    assert cli._window(new=False, days=99.0) == (1000, 2000)

    # --new-window recenters on now and replaces the stored window.
    new = cli._window(new=True, days=None)
    assert new != (1000, 2000)
    assert new[1] - new[0] == 2 * cli.DEFAULT_WINDOW_DAYS * 86400
    assert (json.loads(wf.read_text(encoding="utf-8"))["startEt"], json.loads(wf.read_text(encoding="utf-8"))["endEt"]) == new
