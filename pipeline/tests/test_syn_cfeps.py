"""CFEPS published characterization and orbit-specific residuals; analytic fixtures stay here."""
import copy
import math

import numpy as np
import pytest

from pipeline import syn_sources as ss, syn_outer as so


def test_pinned_published_records():
    survey = ss.read_cfeps()
    assert len(survey) == 45
    f = survey[0]
    assert f['epochJd'] == 2452722.96
    assert f['fill'] == .80
    assert f['ra'] == pytest.approx(190.5166666667)
    assert f['vertices'][0] == [-2.56342553, -1.19534495]
    h = next(p for p in survey if p['block'] == 'L3h')
    assert h['eff']['double_param'] == [.901, 23.865, .799, .244]
    assert h['eff']['track_frac'] == [1., 22.1, -.25]
    assert h['eff']['mag_lim'] == [23.73]
    assert {p['eff']['filter'] for p in survey} == {'g', 'r', 'R'}


def test_published_probability_and_no_field_or_domain():
    f = ss.read_cfeps()[0]
    mag = np.array([22., 22., 26., 22., 22.])
    ra = np.array([f['ra'], f['ra'] + 10, f['ra'], f['ra'], f['ra']])
    dec = np.full(5, f['dec'])
    rate = np.array([3., 3., 3., 30., 3.])
    angle = np.array([20., 20., 20., 20., 120.])
    A, m0, s1, s2 = f['eff']['double_param']
    eta = A / 4 * (1-math.tanh((22-m0)/s1)) * (1-math.tanh((22-m0)/s2))
    prob = so.cfeps_field_probability(f, ra, dec, mag, rate, angle)
    assert prob[0] == pytest.approx(.80 * eta)
    assert np.array_equal(prob[1:], np.zeros(4))


def test_analytic_all_detected_and_stable_candidate_draws():
    p = np.array([0., 1., .4, .9])
    keep = so.cfeps_keep(p, 'fixture', np.array([0, 1, 2, 3]))
    assert keep[0] and not keep[1]
    assert np.array_equal(keep, so.cfeps_keep(p, 'fixture', np.arange(4)))
    assert np.array_equal(keep[2:], so.cfeps_keep(p[2:], 'fixture', np.array([2, 3])))


def test_candidate_orbit_inside_published_field_consumes_probability():
    from pipeline import syn_model as sm
    f = ss.read_cfeps()[0]
    # Analytic circular ICRF orbit aimed at the published pointing; observer at Sun is a test fixture.
    el = {k: np.array([v]) for k, v in dict(a=40., e=.001, i=abs(f['dec']), node=f['ra']+90., peri=0., M=270., H=4.).items()}
    # Test survey rate domain widened analytically; all measured probability parameters retained.
    field = copy.deepcopy(f); field['eff']['rate_cut'] = [0., 20., 0., 180.]
    p, report = so.cfeps_probability(el, 0., [field], lambda jd: (0., np.zeros(3), np.zeros(3)),
                                     1.32712440041e11, 149597870.7, 0., {'g': .423})
    assert 0 < p[0] <= .8
    assert report['candidatesInCharacterizedSpace'] == 1
