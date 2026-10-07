"""Published Hilda inputs: transcription, support and missing coefficients before activation."""
import numpy as np

from pipeline import syn_sources as ss


def test_hilda_background_transcription_and_support():
    t = ss.hilda_model()
    assert t['activation'] == 'blocked-count-review'
    assert t['domain']['HFit'] == [7.5, 18.0]
    assert t['domain']['HReliableMax'] == 17.0
    assert t['domain']['aProperAu'] == [3.95, 4.05]
    assert t['domain']['eProper'] == [0.0, 0.32]
    assert t['domain']['sinIProper'] == [0.0, 0.35]
    assert t['background']['aProper']['median'] == [3.95, 3.95, 1.58, 0.044, 3.73]
    assert t['background']['eProper']['median'] == [0.0, 0.12, 1.05, 0.11, 3.87]
    assert t['background']['sinIProper']['median'] == [0.0, 0.0, 1.65, 0.011, 0.79]


def test_hilda_family_counts_are_not_observed_hcm_normalizations():
    t = ss.hilda_model()
    assert t['familyTotalAtH16']['value'] == 1451
    assert t['familyTotalAtH16']['sigma'] == 65
    f = t['families']
    assert f['Schubart']['normalization']['value'] == 738
    assert f['Schubart']['normalization']['sigma'] == 22
    assert [f[k]['hcmMembers'] for k in ['Hilda', 'Schubart', 'Potomac']] == [1066, 1882, 506]
    # The publication does not tabulate all family fits. Unknowns cannot become Gaussians fitted here.
    for k in ['Hilda', 'Potomac']:
        assert f[k]['normalization']['value'] is None
        assert f[k]['normalization']['label'] == 'unknown'
        assert f[k]['magnitudeSlopes'] is None
    for v in f.values():
        assert v['orbitalCoefficients'] is None
    assert t['familyTotalAtH16']['components'] == ['Hilda', 'Schubart', 'Potomac']


def test_hilda_magnitude_knot_accounting_without_invented_interpolation():
    t = ss.hilda_model()
    h = t['background']['magnitude']
    assert h['knotsH'] == [7.5, 9.5, 12.0, 14.5, 16.0, 17.0]
    assert h['meanSlopes'] == [0.47, 0.36, 0.29, 0.37, 0.33]
    # Segment mean slopes set log-cumulative increments. A differential slope law cannot replace them.
    x = np.asarray(h['knotsH']); steps = np.diff(x) * h['meanSlopes']
    log_n = np.r_[0, np.cumsum(steps)]
    log_n += np.log10(h['normalization']['value']) - log_n[4]
    n = 10 ** log_n
    assert np.isclose(n[4], 1605)
    assert np.isclose(n[-1], 1605 * 10 ** 0.33)
    assert np.isclose(np.diff(n).sum(), n[-1] - n[0])
    assert h['interpolation'] is None  # paper has no explicit end conditions; draw remains unactivated
    s = t['families']['Schubart']
    assert s['knotsH'] == [12.0, 14.0, 15.0, 16.0, 17.0]
    assert s['magnitudeSlopes'] == [1.00, 0.62, 0.63, 0.44]


def test_hilda_mapping_requires_resonant_hamiltonian_and_frame():
    t = ss.hilda_model()
    m = t['osculatingMapping']
    assert m['kappa']['value'] == 1.47
    assert m['kappaPrime']['value'] == 1.47
    assert m['referenceFrame'] == 'solar-system invariable'
    assert m['framePoleDeg'] == [1.5773756, 17.47808416]
    assert m['semimajorAxisAndLongitude'] == 'Appendix B.3: uniform polar angle on the averaged Hamiltonian level curve, both longitude branches'
    assert m['implemented'] is False
    assert t['catalogue']['modelParameters'] is False
    assert t['catalogue']['sizeBytes'] == 7978464
    assert t['source']['sha256'] == 'cd6aaf6d785f0840c7089265258ae88a47347dc6849e458006f38d24c0d28ce9'


def test_hilda_eccentricity_density_does_not_invent_a_signed_power_convention():
    t = ss.hilda_model()
    # Eq.4 has no absolute-value bars, yet Table2 beta=3.87 and cBar=0.12.
    # A real density below cBar requires clarification, not an unlabelled mathematical repair.
    assert t['background']['signedPowerConvention'] is None
    assert t['background']['eProper']['median'][1] > t['domain']['eProper'][0]
    assert not float(t['background']['eProper']['median'][-1]).is_integer()
