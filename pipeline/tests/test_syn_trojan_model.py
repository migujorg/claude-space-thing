"""Publication audit: retain supplied inputs, never reconstruct missing draw parameters."""
import numpy as np

from pipeline import syn_sources as ss
from pipeline.stages import synthetic as syn


def test_trojan_background_final_fit_and_nominal_support():
    t = ss.trojan_model()
    assert t['activation'] == 'inactive-missing-inputs'
    assert t['source']['sha256'] == '06f6b55c6edc1ca40c0f4a7ba2c508c576e3ea0404bfba97e53c4ff258186814'
    assert t['domain']['HFit'] == [7, 15]
    assert t['domain']['L5UnreliableAboveH'] == 14
    assert t['domain']['selectionGridH'] == [7, 17]
    assert t['domain']['L4Extension']['HMax'] == 15.5
    assert t['domain']['L4Extension']['adopted'] is False
    assert t['background']['orbitalParameterOrder'] == ['sA', 'alpha1', 'alpha2', 'sB', 'beta1', 'beta2', 'sC', 'gamma']
    assert t['background']['L4']['orbitalMedian'] == [0.0533, 1.274, 1.008, 0.0191, 1.156, 1.144, 0.0507, 0.941]
    assert t['background']['L5']['orbitalMedian'] == [0.3352, 0.644, 3.012, 0.0307, 1.106, 1.140, 0.0443, 0.929]
    assert t['background']['L4']['orbitalSigma'] == [0.0105, 0.091, 0.063, 0.0028, 0.077, 0.061, 0.0031, 0.030]
    assert t['background']['L5']['orbitalSigma'] == [0.0178, 0.046, 0.247, 0.0041, 0.086, 0.088, 0.0036, 0.038]


def test_trojan_cumulative_means_do_not_select_an_unpublished_spline():
    b = ss.trojan_model()['background']
    assert b['knotsH'] == [7, 8.5, 10, 12, 13, 14, 15]
    assert b['L4']['meanSlopes'] == [1.236, 0.656, 0.429, 0.497, 0.447, 0.388]
    assert b['L5']['meanSlopes'] == [1.404, 0.638, 0.431, 0.468, 0.473, 0.344]
    assert b['L4']['slopeSigma'] == [0.448, 0.094, 0.021, 0.014, 0.008, 0.055]
    assert b['L5']['slopeSigma'] == [0.386, 0.090, 0.025, 0.016, 0.010, 0.009]
    assert b['L4']['normalization'] == {'H': 14.5, 'value': 3951, 'sigma': 44, 'label': 'measured', 'scope': 'background only'}
    assert b['L5']['normalization']['value'] == 2664
    assert b['L5']['normalization']['sigma'] == 39
    for cloud in ['L4', 'L5']:
        # Only full-segment ratios are implied by mean cumulative slopes. Hr is inside
        # a segment: assigning a count to either endpoint from Hr would invent interpolation.
        log_ratios = np.diff(b['knotsH']) * b[cloud]['meanSlopes']
        relative_counts = 10 ** np.r_[0, np.cumsum(log_ratios)]
        assert np.isclose(np.diff(relative_counts).sum(), relative_counts[-1] - 1)
    assert b['splineEndConditions'] == {'value': None, 'label': 'unknown'}


def test_trojan_family_orbital_templates_are_given_but_complete_H_fits_are_not():
    t = ss.trojan_model()
    f = t['families']
    assert [v['cloud'] for v in f.values()].count('L4') == 5
    assert [v['cloud'] for v in f.values()].count('L5') == 3
    assert f['Eurybates']['orbitalCoefficients'] == [0.129, 0.004, 3.5, 0.049, 0.009, 2.6, 1.553, 0.04, 1.1, 1.75]
    assert f['2001 UV209']['orbitalCoefficients'] == [0.415, 0.007, 2.5, 0.041, 0.006, 3, 1.5, 0.01, 0.1, 3.5]
    assert f['Thronium']['orbitalCoefficients'][6:] == [None] * 4
    assert f['Thronium']['CBoxcar'] == [1.5, 1.53]  # Table 1 footnote, not missing template coefficients
    assert f['Eurybates']['normalization']['value'] == 385
    assert f['Deiphobus']['normalization']['value'] == 210
    assert [v['hcmMembers'] for v in f.values()] == [875, 235, 118, 69, 86, 88, 233, 46]
    for name, v in f.items():
        assert v['fitRangeH'] == {'value': None, 'label': 'unknown'}
        assert v['knotsH'] is None and v['meanSlopes'] is None
        if name not in ['Eurybates', 'Deiphobus']:
            assert v['normalization']['value'] is None
            assert v['normalization']['label'] == 'unknown'


def test_trojan_draw_requires_stability_mask_real_densities_and_epoch_frame():
    t = ss.trojan_model()
    assert t['stability']['mask'] == {'value': None, 'label': 'unknown'}
    assert t['stability']['years'] == 100_000_000
    assert t['stability']['cloneOrbitsPerCell'] == 28
    assert t['familySignedPowerConvention']['value'] is None
    assert t['familySignedPowerConvention']['label'] == 'unknown'
    assert not float(t['families']['Eurybates']['orbitalCoefficients'][2]).is_integer()
    m = t['osculatingMapping']
    assert m['equations'] == [1, 2, 3, 4, 19, 20, 21, 22]
    assert m['polarScale']['value'] == 0.2783
    assert m['paperEpochMjd'] == 60000
    assert m['referenceEquinox'] == {'value': None, 'label': 'unknown'}
    assert m['implemented'] is False
    assert t['catalogue']['modelParameters'] is False


def test_inactive_resonant_models_are_explained_by_product_without_changing_draw():
    # _order attaches disclosure only; it cannot change draw/cell/prefix fields.
    marker = object()
    res = {'populations': {p: {'limit': {}, 'extra': {}, 'objects': marker, 'cells': marker, 'prefix': p}
                           for p in ['hilda', 'trojan', 'mainbelt']}}
    syn._order(res)
    for pop, year, missing in [
        ('hilda', '2025', ['family orbital coefficients', 'magnitude coefficients', 'spline end conditions', 'real-valued']),
        ('trojan', '2024', ['stability mask', 'family magnitude', 'spline end conditions', 'real-valued']),
    ]:
        r = res['populations'][pop]
        method = r['extra']['method']
        assert f'Vokrouhlický et al. ({year})' in method
        assert 'published bias-corrected model' in method and 'not used' in method
        assert 'https://arxiv.org/' in method
        for phrase in missing:
            assert phrase in method
        assert r['objects'] is marker and r['cells'] is marker and r['prefix'] == pop
        table = ss.hilda_model() if pop == 'hilda' else ss.trojan_model()
        assert table['source']['id'] in syn._pop_sources(pop)
    assert 'Vokrouhlický' not in res['populations']['mainbelt']['extra']['method']
