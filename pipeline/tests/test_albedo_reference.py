"""The fixed integral is a downstream product with explicit numerical code inputs."""
import importlib

import pytest
from pipeline import build, config


def test_reference_stage_is_downstream_and_fingerprints_the_bridge():
    stage = importlib.import_module('pipeline.stages.albedo_reference')
    assert stage.DEPENDS == ('light', 'surfaces')
    assert config.STAGES.index('albedo_reference') > config.STAGES.index('surfaces')
    assert set(stage.CODE_INPUTS) == {'app/src/render/spatial.ts', 'app/src/render/surface.ts',
                                    'pipeline/src/pipeline/stages/albedo_reference.mjs'}
    assert not hasattr(importlib.import_module('pipeline.stages.light'), 'fingerprint_inputs')
    from unittest.mock import patch
    base = build.fingerprint('albedo_reference', stage.DEPENDS, {}, (0, 1), {})
    from pathlib import Path
    original = Path.read_bytes
    for rel in stage.CODE_INPUTS:
        def changed(path, rel=rel):
            return original(path) + (b'\n// fingerprint probe' if path.as_posix().endswith(rel) else b'')
        with patch.object(Path, 'read_bytes', changed):
            assert build.fingerprint('albedo_reference', stage.DEPENDS, {}, (0, 1), {})['code'] != base['code']
    assert config.stage_params({}, 'albedo_reference') == {}


def test_missing_node_fails_even_with_cached_tables(monkeypatch):
    stage = importlib.import_module('pipeline.stages.albedo_reference')
    monkeypatch.setattr(stage.shutil, 'which', lambda _: None)
    with pytest.raises(RuntimeError, match='albedo_reference requires Node.js'):
        stage.check_toolchain()


def test_missing_app_esbuild_fails_clearly(tmp_path):
    stage = importlib.import_module('pipeline.stages.albedo_reference')
    (tmp_path / 'app').mkdir()
    (tmp_path / 'app/package.json').write_text('{}')
    with pytest.raises(RuntimeError, match="app's esbuild"):
        stage.check_toolchain(tmp_path)
