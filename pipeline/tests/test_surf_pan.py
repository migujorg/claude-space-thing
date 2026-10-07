"""USGS pixel encodings and honest Galilean hemisphere diagnostics."""
from dataclasses import replace
import json

import numpy as np
import pytest
import tifffile

from pipeline import surf_pan as pan, surf_tiles as st
from pipeline.schema import BuildContext
from pipeline.paths import OUT


@pytest.mark.parametrize('offset,scale', [(-0.0029527571, 0.0059055141), (0.0, 1.0)])
def test_build_decodes_geotiff_pixel_encoding_before_normalizing(tmp_path, monkeypatch, offset, scale):
    # Different terrain DNs expose an ignored additive offset even after disk normalization.
    h, w = st.level_shape(0)
    data = np.full((h, w), 50, np.uint8)
    data[:, w // 2:] = 150
    data[0, 0] = 0  # GDAL no-data must be masked before applying the offset.
    path = tmp_path / 'mosaic.tif'
    radius = 2632345.0
    mpd = radius * np.pi / 180
    xml = (f'<GDALMetadata><Item name="OFFSET" sample="0" role="offset">{offset}</Item>'
           f'<Item name="SCALE" sample="0" role="scale">{scale}</Item></GDALMetadata>')
    tifffile.imwrite(path, data, metadata=None, extratags=[
        (33550, 'd', 3, (360 / w * mpd, 180 / h * mpd, 0), False),
        (33922, 'd', 6, (0, 0, 0, -180 * mpd, 90 * mpd, 0), False),
        (34736, 'd', 6, (0, 0, 0, 0, 0, radius), False),
        (42112, 's', 0, xml, False), (42113, 's', 0, '0', False),
    ])
    monkeypatch.setattr(pan, 'fetch', lambda *args: path)
    monkeypatch.setattr(pan, 'record', lambda p: {'sha256': 'fixture', 'bytes': p.stat().st_size,
                                               'retrieved': '2026-10-07'})
    from pipeline.photometry import albedo
    monkeypatch.setattr(albedo, 'pck_radii', lambda: {503: [radius / 1000] * 3})
    monkeypatch.setattr(pan.sl, 'write_layer', lambda ctx, spec, top, known, level: (spec, top, known))
    spec, top, known = pan.build_one(BuildContext(0, 1), replace(pan.MAPS[2], level=0, feature=None))
    expected = data.astype(np.float64) * scale + offset
    expected[~known] = 0
    expected /= st.disk_mean(expected, known, 0)[0]
    np.testing.assert_allclose(top[..., 1], expected, atol=2e-6)
    assert not known[0, 0] and top[0, 0, 1] == 0
    assert spec.brightness.label == 'estimated'


def test_hemisphere_diagnostic_distinguishes_kernels_and_unknown_error():
    model = {'label': 'estimated', 'sources': ['mayorga-2020'], 'value': {
        'kind': 'rotation-slices-v1', 'relativeAlbedo': [1, 2, 1, 1, 1, 1],
        'sliceEdgesEastLonDeg': [-180, -120, -60, 0, 60, 120, 180],
    }}
    d = pan.leading_trailing_diagnostic(1.5, model)
    assert d['ratio'] == 1.5
    assert d['rotationSlices']['value']['projectedAreaRatio'] == 1.5
    assert d['rotationSlices']['value']['mapOverSlices'] == 1
    # A Lambert disk weights the middle slice more heavily than projected area alone.
    assert d['rotationSlices']['value']['renderedZeroPhaseDiskRatio'] > 1.5
    assert d['comparisonStatus'] == 'unknown' and d['ratioUncertainty'] is None


@pytest.mark.parametrize('naif', [501, 502, 503, 504])
def test_built_galilean_contrast_is_reported_without_inventing_slice_errors(naif):
    path = OUT / 'surfaces' / str(naif) / 'albedo.json'
    if not path.exists():
        pytest.skip(f'surfaces/{naif}/albedo not built')
    h = json.loads(path.read_text())
    a = st.read_level(OUT, naif, 'albedo', h['maxLevel'], 4, 'f16')[..., 1]
    map_ratio = pan.hemisphere_ratio(a, a > 0, h['maxLevel'], 270, 90)
    d = h['diagnostics']['leadingOverTrailing']
    assert d['ratio'] == pytest.approx(map_ratio, abs=1e-4)
    assert d['label'] == 'estimated'
    assert d['comparisonStatus'] == 'unknown' and d['ratioUncertainty'] is None
    p = OUT / 'photometry.json'
    if not p.exists():
        pytest.skip('photometry not built')
    model = json.loads(p.read_text())[str(naif)]['diskReflectanceModel']
    expected = pan.leading_trailing_diagnostic(map_ratio, model)['rotationSlices']['value']
    assert d['rotationSlices']['value']['projectedAreaRatio'] == expected['projectedAreaRatio']
    assert d['rotationSlices']['value']['renderedZeroPhaseDiskRatio'] == expected['renderedZeroPhaseDiskRatio']
