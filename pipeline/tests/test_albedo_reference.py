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
    for dependency in stage.DEPENDS:
        products = {'input.json': {'stage': dependency, 'sha256': 'changed'}}
        assert build.fingerprint('albedo_reference', stage.DEPENDS, {}, (0,1), products)['inputs'] != base['inputs']
    assert config.stage_params({}, 'albedo_reference') == {}


def test_missing_node_fails_even_with_cached_tables(monkeypatch):
    stage = importlib.import_module('pipeline.stages.albedo_reference')
    monkeypatch.setattr(stage.shutil, 'which', lambda _: None)
    with pytest.raises(RuntimeError, match='albedo_reference requires Node.js'):
        from pipeline.schema import BuildContext
        stage.run(BuildContext(0, 1))


def test_missing_app_esbuild_fails_clearly(tmp_path):
    stage = importlib.import_module('pipeline.stages.albedo_reference')
    (tmp_path / 'app').mkdir()
    (tmp_path / 'app/package.json').write_text('{}')
    with pytest.raises(RuntimeError, match="app's esbuild"):
        stage.check_toolchain(tmp_path)


def test_build_record_names_the_table_hash(tmp_path, monkeypatch):
    import json
    from pipeline import output
    from pipeline.schema import BuildContext
    stage = importlib.import_module('pipeline.stages.albedo_reference')
    monkeypatch.setattr(stage, 'OUT', tmp_path)
    monkeypatch.setattr(output, 'OUT', tmp_path)
    monkeypatch.setattr(stage, 'check_toolchain', lambda: None)
    table = {'sourceCodeSha256': 'test-code', 'relativeTolerance': 1e-5,
             'radiiKm': [2,2,1], 'view': {'kind': 'latitude', 'latitudeDeg': 0}, 'cells': []}
    monkeypatch.setattr(stage, 'reference_table', lambda *args: table)
    monkeypatch.setattr(stage, 'hapke_table', lambda *args: None)
    (tmp_path/'photometry.json').write_text(json.dumps({'599': {
        'albedoMeasurementView': {'label':'derived','sources':['test-view']},
        'spatialModel': {'label':'estimated','sources':['test-law']}}}))
    ctx = BuildContext(0, 1)
    stage.run(ctx)
    record = json.loads((tmp_path/'verification/albedo-reference.json').read_text())
    assert record['products'] == {'albedo-reference.json': ctx.products['albedo-reference.json']['sha256']}
    product = json.loads((tmp_path/'albedo-reference.json').read_text())
    assert product['599']['label'] == 'estimated'
    assert record['bodies']['599']['view'] == table['view']


def test_hapke_product_keeps_law_provenance_and_records_the_table_hash(tmp_path, monkeypatch):
    import json
    from pipeline import output
    from pipeline.schema import BuildContext
    stage = importlib.import_module('pipeline.stages.albedo_reference')
    monkeypatch.setattr(stage, 'OUT', tmp_path)
    monkeypatch.setattr(output, 'OUT', tmp_path)
    monkeypatch.setattr(stage, 'check_toolchain', lambda: None)
    table = {'sourceCodeSha256': 'test-code', 'spatialCodeSha256':'test-spatial',
             'relativeTolerance':1e-5, 'interpolationTolerance':1e-7, 'cells':[]}
    monkeypatch.setattr(stage, 'reference_table', lambda *args: None)
    monkeypatch.setattr(stage, 'hapke_table', lambda *args: table)
    (tmp_path/'photometry.json').write_text(json.dumps({'501': {
        'spatialModel': {'label':'estimated','sources':['test-law']}}}))
    ctx = BuildContext(0, 1)
    stage.run(ctx)
    record = json.loads((tmp_path/'verification/hapke-phase.json').read_text())
    product = json.loads((tmp_path/'hapke-phase.json').read_text())
    assert record['products'] == {'hapke-phase.json':ctx.products['hapke-phase.json']['sha256']}
    assert product['501']['label'] == 'estimated'
    assert product['501']['sources'] == ['test-law']
    assert record['bodies']['501']['spatialCodeSha256'] == 'test-spatial'


def test_non_hapke_fit_has_no_phase_table():
    stage = importlib.import_module('pipeline.stages.albedo_reference')
    assert stage.hapke_table({'spatialModel': {'value': {'kind':'lambert'}}}) is None
    assert stage.hapke_table({}) is None
