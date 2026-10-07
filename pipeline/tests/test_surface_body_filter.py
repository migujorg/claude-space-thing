"""Partial surface builds must preserve the products of every skipped body."""

import importlib
import json

import pytest

from pipeline import config, output, surf_pan
from pipeline.schema import BuildContext
from pipeline.stages import surfaces


FAMILIES = [
    ('surf_pan', 'MAPS', 'build_one', 504),
    ('surf_giants', 'PLANETS', 'build_planet', 699),
    ('surf_nh', 'MAPS', 'build_one', 901),
]


@pytest.mark.parametrize('module,collection,worker,selected', FAMILIES)
def test_partial_stage_preserves_skipped_body_products_and_manifest(
        tmp_path, monkeypatch, module, collection, worker, selected):
    mod = importlib.import_module(f'pipeline.{module}')
    bodies = getattr(mod, collection)
    monkeypatch.setattr(output, 'OUT', tmp_path)
    monkeypatch.setattr(surfaces, 'OUT', tmp_path)
    monkeypatch.setattr(surfaces, 'CACHE', tmp_path / 'cache')
    old = BuildContext(0, 1)
    index = {'bodies': {}}

    def write_products(ctx, body, generation):
        header = {'body': body.naif, 'bodyName': body.name, 'layer': 'albedo', 'generation': generation}
        base = f'surfaces/{body.naif}/albedo'
        output.write_json(ctx, base + '.json', header, 'surfaces')
        output.write_bin(ctx, base + '/0/0/0.bin', generation.encode(), 'surfaces')
        output.write_bin(ctx, base + '.sha256', generation.encode(), 'surfaces')
        return header

    for body in bodies:
        write_products(old, body, 'old')
        index['bodies'][str(body.naif)] = {
            'name': body.name, 'layers': {'albedo': f'surfaces/{body.naif}/albedo.json'}}
    output.write_json(old, 'surfaces/index.json', index, 'surfaces')
    output.write_manifest(old)
    before_entries = json.loads((tmp_path / 'manifest.json').read_text())['products']
    before_files = {rel: ((tmp_path / rel).read_bytes(), (tmp_path / rel).stat().st_mtime_ns)
                    for rel in before_entries if rel != 'surfaces/index.json'}
    calls = []

    # Replace the per-body worker: no downloads or heavy reduction, but real product registration/publication.
    def stub(ctx, body):
        calls.append(body.naif)
        return write_products(ctx, body, 'new')

    monkeypatch.setattr(mod, worker, stub)
    ctx = BuildContext(0, 1, params=config.parse_sets([f'surfaces.bodies={selected}']))
    surfaces.run(ctx)
    output.write_manifest(ctx)

    assert calls == [selected]
    after_entries = json.loads((tmp_path / 'manifest.json').read_text())['products']
    assert after_entries.keys() == before_entries.keys()
    for rel, (data, mtime) in before_files.items():
        path = tmp_path / rel
        if rel.startswith(f'surfaces/{selected}/'):
            assert path.read_bytes() != data
            assert after_entries[rel] != before_entries[rel]
        else:
            assert path.read_bytes() == data
            assert path.stat().st_mtime_ns == mtime
            assert after_entries[rel] == before_entries[rel]
    after_index = json.loads((tmp_path / 'surfaces/index.json').read_text())
    assert after_index['bodies'] == index['bodies']


@pytest.mark.parametrize('module,collection,worker,selected', FAMILIES)
@pytest.mark.parametrize('selection', ['', 'subset', 'unrelated'])
def test_multi_body_build_filter(tmp_path, monkeypatch, module, collection, worker, selected, selection):
    mod = importlib.import_module(f'pipeline.{module}')
    ids = [body.naif for body in getattr(mod, collection)]
    requested = '' if selection == '' else (f'{ids[0]}, {ids[-1]}' if selection == 'subset' else '301')
    expected = ids if selection == '' else ([ids[0], ids[-1]] if selection == 'subset' else [])
    monkeypatch.setattr(mod, worker, lambda ctx, body: body.naif)
    ctx = BuildContext(0, 1, params=config.parse_sets([f'surfaces.bodies={requested}']))
    assert mod.build(ctx, tmp_path) == expected


def test_pan_filter_applies_to_explicit_comparison_maps(tmp_path, monkeypatch):
    monkeypatch.setattr(surf_pan, 'build_one', lambda ctx, body: body.naif)
    ctx = BuildContext(0, 1, params=config.parse_sets(['surfaces.bodies=901']))
    assert surf_pan.build(ctx, tmp_path, surf_pan.NH_PAN_MAPS) == [901]
